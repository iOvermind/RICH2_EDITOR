// ⚠⚠ 未完成：位元流解得出來但**對不上**，還不能用。⚠⚠
//
// 目前狀況（2026-07-31，留給下次接手）：
//   檔頭欄位都判讀正確 —— Js3.exe 是 LZEXE **0.90**（0x1C 簽章 'LZ09'），
//   info = [ip=0, cs=0, sp=0x400, ss=0xFC8, 壓縮段=0x617, 多配=0x9C2, stub長=0x741]，
//   而且 0x6190(stub 起點) + 0x741(stub 長) = 26833 = 檔案大小，**完全吻合**，
//   所以「壓縮資料 0x20~0x6190、stub 0x6190~EOF」這個切法可以確定是對的。
//
//   但下面這個由前往後的解法只吃掉 429/24944 bytes 就撞到結束標記，
//   而且一開始就出現「複製來源在輸出起點之前」的負位移 —— 代表起點的幾何搞錯了。
//   已排除的可能：
//     - 位元順序 / literal 與 short-match 的位元極性 / 長度兩個位元的順序
//       （16 種組合全試過，沒有一種能吃完輸入且不產生負參考）
//     - 整個反向解（從壓縮區尾端往前讀、輸出往下寫）：也對不上
//   下一步線索：stub 開頭那段是 `push es; push cs; pop ds; mov cx,[0Ch];
//   mov si,cx; dec si; mov di,si; mov bx,ds` —— **si=cx-1 是反向搬移的設定**，
//   代表 LZEXE 會先把壓縮資料整塊往記憶體高處搬，再解壓。所以來源／目的的
//   相對位置跟「檔案裡由前往後讀」不一樣，要照著 stub 的實際搬移量對齊。
//   把 stub 那 1857 bytes 反組譯出來照做，應該就會通。
//
// ---------------------------------------------------------------------------
// LZEXE 解壓器：把 LZEXE 壓縮的執行檔（本專案是中文系統 Js3.exe）還原成
// 未壓縮的記憶體映像，供靜態分析。
//
// 格式參考（公開資料，unlzexe 的做法）：
//   MZ 檔頭 offset 0x1C 的簽章是 'LZ09'(v0.90) 或 'LZ91'(v0.91)。
//   CS:IP 指向解壓 stub，stub 開頭是 8 個 word 的 info：
//     info[0..3] = 真正的 IP / CS / SP / SS
//     info[4]    = 壓縮資料大小（段落）
//     info[5]    = 載入時要多配的大小（段落）
//     info[6]    = 解壓程式本身的長度
//   壓縮資料就在 stub 前面 info[4] 個段落，由前往後解。
//
//   位元流（LSB first，每次補 2 bytes）：
//     1                → literal，直接輸出下一個 byte
//     0 0 b b          → 短距離複製：len = bb + 2、距離 = 0xFF00 | 下一個 byte
//     0 1 <2 bytes>    → 長距離複製：距離 = ((b2 & ~7) << 5) | b1 | ~0x1FFF
//                        len = (b2 & 7) + 2；len==2 時再讀一個 byte：
//                          0 = 結束、1 = 換段（繼續）、其餘 = len+1
//
// ⚠ 只還原「載入映像」，不重建 relocation table —— 靜態分析用不到，
//    而 0.90 與 0.91 的 reloc 格式不同，硬做只會多一個出錯的地方。
import fs from 'fs';

export function unlzexe(buf) {
    if (buf[0] !== 0x4d || buf[1] !== 0x5a) throw new Error('不是 MZ 執行檔');
    const sig = buf.toString('latin1', 0x1c, 0x20);
    if (sig !== 'LZ09' && sig !== 'LZ91') {
        throw new Error(`offset 0x1C 不是 LZEXE 簽章（讀到 ${JSON.stringify(sig)}），可能不是 LZEXE 壓縮`);
    }
    const version = sig === 'LZ09' ? '0.90' : '0.91';

    const hdrPara = buf.readUInt16LE(8);
    const cs = buf.readInt16LE(22);
    const loadStart = hdrPara * 16;
    const stubAt = loadStart + cs * 16;              // 解壓 stub＝info 區的位置
    if (stubAt + 16 > buf.length) throw new Error('stub 位置超出檔案範圍');

    const info = [];
    for (let i = 0; i < 8; i++) info.push(buf.readUInt16LE(stubAt + i * 2));
    const [realIp, realCs, realSp, realSs, packedParas, extraParas, stubLen] = info;

    const packedAt = stubAt - packedParas * 16;      // 壓縮資料在 stub 前面
    if (packedAt < 0) throw new Error('壓縮資料起點算出來是負的，檔頭可能不對');

    // 輸出上限：壓縮段 + 載入時多配的量，再留一點餘裕
    const out = Buffer.alloc((packedParas + extraParas + 0x1000) * 16);
    let op = 0;                                       // 輸出位置
    let ip = packedAt;                                // 讀取位置
    let bits = 0, nbits = 0;

    const byte = () => (ip < buf.length ? buf[ip++] : 0);
    const bit = () => {
        if (nbits === 0) { bits = byte() | (byte() << 8); nbits = 16; }
        const b = bits & 1;
        bits >>= 1; nbits--;
        return b;
    };
    const put = (v) => {
        if (op >= out.length) throw new Error('輸出超過預留大小，格式可能判斷錯誤');
        out[op++] = v;
    };

    for (;;) {
        if (bit()) { put(byte()); continue; }        // literal

        let len, span;
        if (bit() === 0) {                            // 短距離
            len = (bit() << 1) | bit();
            len += 2;
            span = byte() | ~0xff;                    // 0xFFFFFF00 | b → 負的相對距離
        } else {                                      // 長距離
            const b1 = byte(), b2 = byte();
            span = b1 | ((b2 & ~0x07) << 5) | ~0x1fff;
            len = (b2 & 0x07) + 2;
            if (len === 2) {
                const n = byte();
                if (n === 0) break;                   // 結束
                if (n === 1) continue;                // 換段，沒有資料
                len = n + 1;
            }
        }
        for (; len > 0; len--) {
            const src = op + span;                    // span 是負數
            put(src >= 0 ? out[src] : 0);
        }
    }

    return {
        image: out.subarray(0, op), version,
        realCs, realIp, realSs, realSp,
        packedAt, packedParas, extraParas, stubLen, loadStart, stubAt,
    };
}

if (process.argv[2]) {
    const src = process.argv[2], dst = process.argv[3];
    const r = unlzexe(fs.readFileSync(src));
    console.log(`${src}`);
    console.log(`  LZEXE ${r.version}`);
    console.log(`  解壓後映像 ${r.image.length} bytes`);
    console.log(`  真正進入點 CS:IP = ${r.realCs.toString(16)}:${r.realIp.toString(16)}　SS:SP = ${r.realSs.toString(16)}:${r.realSp.toString(16)}`);
    console.log(`  壓縮資料 檔案 0x${r.packedAt.toString(16)}~0x${r.stubAt.toString(16)}（${r.packedParas} 段落），解壓程式 ${r.stubLen} bytes`);
    if (dst) { fs.writeFileSync(dst, r.image); console.log(`  已寫出 → ${dst}`); }
}
