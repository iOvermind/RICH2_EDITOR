// EXEPACK 解壓器：把 Run.exe / Js3.exe 還原成未壓縮的記憶體映像，供靜態分析。
// 格式參考（公開資料）：
//   MZ 檔頭的 CS:IP 指向解壓 stub；stub 之前是 EXEPACK 檔頭，結尾簽章 'RB'。
//   壓縮資料在載入模組開頭到 EXEPACK 檔頭之間，解壓由「尾端往前」進行。
//   指令位元組 op：(op&0xFE)==0xB0 → 填充(讀 count、讀 1 byte 重複)；
//                  (op&0xFE)==0xB2 → 複製(讀 count、複製 count bytes)；
//                  op&1 → 最後一個指令。
import fs from 'fs';

export function unexepack(buf) {
    if (buf[0] !== 0x4d || buf[1] !== 0x5a) throw new Error('不是 MZ 執行檔');
    const lastPage = buf.readUInt16LE(2);
    const pages = buf.readUInt16LE(4);
    const hdrPara = buf.readUInt16LE(8);
    const ip = buf.readUInt16LE(20);
    const cs = buf.readUInt16LE(22);

    const loadStart = hdrPara * 16;
    let fileEnd = (pages - 1) * 512 + (lastPage || 512);
    if (fileEnd > buf.length) fileEnd = buf.length;

    const stubStart = loadStart + cs * 16 + ip;      // 解壓 stub 的進入點
    // 簽章 'RB' 落在 EXEPACK 檔頭尾端；檔頭長度 16 或 18
    let hdrLen = -1;
    for (const len of [18, 16]) {
        const sigAt = loadStart + cs * 16 + len - 2;
        if (buf[sigAt] === 0x52 && buf[sigAt + 1] === 0x42) { hdrLen = len; break; }
    }
    if (hdrLen < 0) throw new Error("找不到 EXEPACK 簽章 'RB'（可能不是 EXEPACK 壓縮）");

    const hdrAt = loadStart + cs * 16;
    const realIp = buf.readUInt16LE(hdrAt + 0);
    const realCs = buf.readUInt16LE(hdrAt + 2);
    const exepackSize = buf.readUInt16LE(hdrAt + 6);
    const realSp = buf.readUInt16LE(hdrAt + 8);
    const realSs = buf.readUInt16LE(hdrAt + 10);
    const destLen = buf.readUInt16LE(hdrAt + 12);    // 段落數
    const skipLen = hdrLen === 18 ? buf.readUInt16LE(hdrAt + 14) : 1;

    const packed = buf.subarray(loadStart, hdrAt);   // 壓縮資料
    const outSize = destLen * 16;
    const out = Buffer.alloc(outSize, 0);

    // 由尾端往前解；先跳過尾端的 0xFF 填補
    let sp = packed.length;
    while (sp > 0 && packed[sp - 1] === 0xff) sp--;
    let dp = outSize;

    const rb = () => { if (sp <= 0) throw new Error('壓縮資料讀取越界'); return packed[--sp]; };
    const rw = () => { const hi = rb(), lo = rb(); return (hi << 8) | lo; };

    for (let guard = 0; ; guard++) {
        if (guard > 1_000_000) throw new Error('解壓迴圈異常');
        const op = rb();
        const kind = op & 0xfe;
        const count = rw();
        if (kind === 0xb0) {
            const val = rb();
            if (dp - count < 0) throw new Error('輸出越界(fill)');
            for (let i = 0; i < count; i++) out[--dp] = val;
        } else if (kind === 0xb2) {
            if (dp - count < 0) throw new Error('輸出越界(copy)');
            for (let i = 0; i < count; i++) out[--dp] = rb();
        } else {
            throw new Error(`未知指令 0x${op.toString(16)} @sp=${sp}`);
        }
        if (op & 1) break;
    }

    // 終止指令代表「剩下的資料已經在正確位置」——此時 dp 會等於 sp，
    // 下方那一大段是**原樣保留**的，直接整塊複製過去即可。
    // （這也解釋了為什麼直接對原始檔做位元組 patch 會生效：那段是 1:1 對應的。）
    packed.copy(out, dp - sp, 0, sp);
    const verbatimBase = dp - sp;   // 映像位址 = 檔案位址 - loadStart + verbatimBase（僅限原樣區）

    return {
        image: out, realCs, realIp, realSs, realSp, destLen, skipLen, exepackSize,
        loadStart, hdrAt, compressedBytes: outSize - dp, verbatimBytes: sp, verbatimBase,
    };
}

if (process.argv[2]) {
    const src = process.argv[2], dst = process.argv[3];
    const r = unexepack(fs.readFileSync(src));
    console.log(`${src}`);
    console.log(`  解壓後映像 ${r.image.length} bytes（destLen=${r.destLen} 段落）`);
    console.log(`  真正進入點 CS:IP = ${r.realCs.toString(16)}:${r.realIp.toString(16)}　SS:SP = ${r.realSs.toString(16)}:${r.realSp.toString(16)}`);
    console.log(`  壓縮段展開 ${r.compressedBytes} bytes；原樣保留段 ${r.verbatimBytes} bytes（起點 0x${r.verbatimBase.toString(16)}）`);
    console.log(`  原樣區對應：映像 offset = 檔案 offset - 0x${r.loadStart.toString(16)} + 0x${r.verbatimBase.toString(16)}`);
    if (dst) { fs.writeFileSync(dst, r.image); console.log(`  已寫出 → ${dst}`); }
}
