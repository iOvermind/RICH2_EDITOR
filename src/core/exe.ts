// Run.exe 的讀寫。編輯器與命令列工具共用這一支。
//
// **所有 offset 一律是「映像 offset」**（載入後記憶體裡的位置），不是檔案 offset。
// 原因：原版 Run.exe 是 EXEPACK 壓縮的，檔頭 0x200；我們輸出的是未壓縮版，檔頭
// 0x2750。檔案 offset 兩邊不一樣，映像 offset 兩邊一樣。而且插跳板還會讓插入點
// 之後的東西整批位移——用映像 offset 才有機會讓這些位移自動生效。
//
// 存檔的順序固定是：
//   loadExe(Run.exe.bak 的內容)  ← 每次都從乾淨的原版重建，patch 不會疊加
//     → applyCaps()              ← 改容量（映像 offset）
//     → insertPassThrough()      ← 插跳板（上一步改過的位元組會自動跟著位移）
//     → buildExe()               ← 產出未壓縮 MZ
//
// 詳細的逆向筆記見 docs/runexe-re.md §11。

export interface Reloc { seg: number; off: number }

export interface ExeImage {
    image: Uint8Array;
    relocs: Reloc[];
    cs: number; ip: number;
    ss: number; sp: number;
    minAlloc: number;
    /** 來源是不是 EXEPACK 壓縮的（只影響訊息，輸出一律未壓縮） */
    wasPacked: boolean;
    /**
     * 插過的程式碼區塊，用**原版座標**記（可以有多塊）。MAP_CAPS 這類
     * 「原版映像 offset」要透過 `imageOffset()` 換算才對得上實際位置——
     * readCap/writeCap 會自己處理，別自己算。
     */
    inserts?: { atOriginal: number; bytes: number }[];
}

const MZ = 0x5a4d;

// 插過跳板的 exe 會在跳板裡留一組簽章＋長度，loadExe 靠它認出來並算出位移，
// 這樣 readCap 這類「原版映像 offset」在已插碼的檔案上也讀得對。
// 跳板的位置從 0x1A5F 那條 near jmp 的目標反推（那是 passthrough.ts 的第一個掛鉤點）。
// 第一塊跳板裡放一張「插入清單」：簽章、塊數，然後每塊 (原版位址, 長度)。
// loadExe 從 0x1A5F 那條 near jmp 的目標找到第一塊，再把清單讀出來，
// 這樣即使插了好幾塊，也能把「原版 offset → 實際位置」的換算還原。
export const CAVE_MAGIC = 0x3252;      // 'R2'
export const CAVE_MARK_OFF = 0x160;    // 清單在第一塊裡的 offset
const CAVE_PROBE_SITE = 0x1a5f;
const rd16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const wr16 = (b: Uint8Array, o: number, v: number) => { b[o] = v & 0xff; b[o + 1] = (v >> 8) & 0xff; };

// ── 讀取 ─────────────────────────────────────────────────────────────

/** 讀一個 MZ 執行檔（EXEPACK 壓縮或未壓縮都吃），取出映像與重定位表。 */
export function loadExe(buf: Uint8Array): ExeImage {
    if (rd16(buf, 0) !== MZ) throw new Error('不是 MZ 執行檔');
    const hdrPara = rd16(buf, 8);
    const cs = rd16(buf, 22);
    const loadStart = hdrPara * 16;

    // EXEPACK 的簽章 'RB' 在它自己的檔頭尾端；檔頭長度 16 或 18
    const hdrAt = loadStart + cs * 16;
    let packHdrLen = -1;
    for (const len of [18, 16]) {
        const at = hdrAt + len - 2;
        if (buf[at] === 0x52 && buf[at + 1] === 0x42) { packHdrLen = len; break; }
    }
    const x = packHdrLen < 0 ? loadPlain(buf) : loadPacked(buf, hdrAt);
    detectCave(x);
    return x;
}

/** 認出跳板：0x1A5F 是 near jmp，目標處放著簽章的話，就把插入清單讀回來。 */
function detectCave(x: ExeImage): void {
    const img = x.image;
    if (img[CAVE_PROBE_SITE] !== 0xe9) return;
    const rel = rd16(img, CAVE_PROBE_SITE + 1);
    const at = (CAVE_PROBE_SITE + 3 + (rel > 0x7fff ? rel - 0x10000 : rel)) & 0xffff;
    const mark = at + CAVE_MARK_OFF;
    if (rd16(img, mark) !== CAVE_MAGIC) return;
    const n = rd16(img, mark + 2);
    if (n < 1 || n > 8) return;
    x.inserts = [];
    for (let i = 0; i < n; i++) {
        x.inserts.push({ atOriginal: rd16(img, mark + 4 + i * 4), bytes: rd16(img, mark + 6 + i * 4) });
    }
}

/** 把插入清單寫進第一塊跳板（呼叫端要保證那塊有足夠空間）。 */
export function writeInsertList(x: ExeImage, caveAt: number): void {
    const list = x.inserts ?? [];
    const mark = caveAt + CAVE_MARK_OFF;
    wr16(x.image, mark, CAVE_MAGIC);
    wr16(x.image, mark + 2, list.length);
    list.forEach((ins, i) => { wr16(x.image, mark + 4 + i * 4, ins.atOriginal); wr16(x.image, mark + 6 + i * 4, ins.bytes); });
}

/** 已經是未壓縮的普通 MZ：直接取映像與 MZ 重定位表。 */
function loadPlain(buf: Uint8Array): ExeImage {
    const hdrPara = rd16(buf, 8);
    const n = rd16(buf, 6);
    const rp = rd16(buf, 24);
    const relocs: Reloc[] = [];
    for (let i = 0; i < n; i++) {
        relocs.push({ off: rd16(buf, rp + i * 4), seg: rd16(buf, rp + i * 4 + 2) });
    }
    return {
        image: buf.slice(hdrPara * 16),
        relocs,
        cs: rd16(buf, 22), ip: rd16(buf, 20),
        ss: rd16(buf, 14), sp: rd16(buf, 16),
        minAlloc: rd16(buf, 10),
        wasPacked: false,
    };
}

/**
 * EXEPACK 解壓。由尾端往前讀，每個指令：
 *   op & 0xFE == 0xB0 → 填充（讀 count、讀 1 byte 重複輸出）
 *   op & 0xFE == 0xB2 → 複製（讀 count、複製 count bytes）
 *   op & 1            → 這是最後一個指令
 * 終止後**剩餘的來源資料已經在正確位置**，整塊搬到輸出低位即可。
 */
function loadPacked(buf: Uint8Array, hdrAt: number): ExeImage {
    const lastPage = rd16(buf, 2), pages = rd16(buf, 4);
    const minAlloc = rd16(buf, 10);
    const loadStart = rd16(buf, 8) * 16;
    let fileEnd = (pages - 1) * 512 + (lastPage || 512);
    if (fileEnd > buf.length) fileEnd = buf.length;

    const realIp = rd16(buf, hdrAt + 0), realCs = rd16(buf, hdrAt + 2);
    const packSize = rd16(buf, hdrAt + 6);
    const realSp = rd16(buf, hdrAt + 8), realSs = rd16(buf, hdrAt + 10);
    const destLen = rd16(buf, hdrAt + 12);

    const packed = buf.subarray(loadStart, hdrAt);
    const outSize = destLen * 16;
    const out = new Uint8Array(outSize);

    let sp = packed.length;
    while (sp > 0 && packed[sp - 1] === 0xff) sp--;   // 尾端的 0xFF 填補
    let dp = outSize;
    const rb = () => { if (sp <= 0) throw new Error('壓縮資料讀取越界'); return packed[--sp]; };
    const rw = () => { const hi = rb(), lo = rb(); return (hi << 8) | lo; };

    for (let guard = 0; ; guard++) {
        if (guard > 1_000_000) throw new Error('解壓迴圈異常');
        const op = rb(), kind = op & 0xfe, count = rw();
        if (kind === 0xb0) {
            const val = rb();
            if (dp - count < 0) throw new Error('輸出越界(fill)');
            for (let i = 0; i < count; i++) out[--dp] = val;
        } else if (kind === 0xb2) {
            if (dp - count < 0) throw new Error('輸出越界(copy)');
            for (let i = 0; i < count; i++) out[--dp] = rb();
        } else {
            throw new Error(`未知的 EXEPACK 指令 0x${op.toString(16)}`);
        }
        if (op & 1) break;
    }
    out.set(packed.subarray(0, sp), dp - sp);

    // DOS 配給壓縮版的總段落數；未壓縮版要配一樣多，堆疊與堆積才落在同樣的位置
    const packedParas = Math.ceil((fileEnd - loadStart) / 16);
    return {
        image: out,
        relocs: readPackedRelocs(buf, hdrAt, hdrAt + packSize),
        cs: realCs, ip: realIp, ss: realSs, sp: realSp,
        minAlloc: Math.max(packedParas + minAlloc - destLen, 0),
        wasPacked: true,
    };
}

/**
 * EXEPACK 的重定位表壓在解壓 stub 後面：16 個分頁（段的高 4 位元 0x0000…0xF000），
 * 每頁 `[count][offset × count]`。表的起點沒有欄位可查，但「16 頁剛好讀到
 * EXEPACK 區尾端」這個條件足以唯一定出來——實測 Run.exe 只有一個候選位置。
 */
export function readPackedRelocs(buf: Uint8Array, hdrAt: number, end: number): Reloc[] {
    const hits: number[] = [];
    for (let s = hdrAt + 16; s < end - 32; s++) {
        let p = s, ok = true;
        for (let g = 0; g < 16 && ok; g++) {
            if (p + 2 > end) { ok = false; break; }
            const c = rd16(buf, p); p += 2;
            if (p + c * 2 > end) { ok = false; break; }
            p += c * 2;
        }
        if (ok && p === end) hits.push(s);
    }
    if (hits.length !== 1) throw new Error(`EXEPACK 重定位表定位失敗（候選 ${hits.length} 個）`);

    let p = hits[0];
    const relocs: Reloc[] = [];
    for (let g = 0; g < 16; g++) {
        const c = rd16(buf, p); p += 2;
        for (let i = 0; i < c; i++) { relocs.push({ seg: g << 12, off: rd16(buf, p) }); p += 2; }
    }
    return relocs;
}

// ── 輸出 ─────────────────────────────────────────────────────────────

/**
 * 用映像與重定位表組出一個未壓縮的普通 MZ 執行檔。
 *
 * ⚠ 會把「DOS 配額之內、映像之外」那塊（堆疊與堆積的起頭）也**寫進檔案並填 0**，
 * 然後把 minalloc 設成 0。原因是實測出來的：
 *   壓縮版的解壓 stub 會先把自己搬到配額頂端才解壓，所以那塊留著它的殘骸——
 *   內容雖然是垃圾，但每次都一樣。未壓縮版沒有 stub，那塊就是 DOS 留下的
 *   前一支程式的殘骸，每次都不同。遊戲顯然有讀到那裡：實測 NPC 在股市會買一張
 *   又馬上全賣、在銀行會把錢存成負數，而且**不是每次都發生**。填 0 之後就正常了。
 * 配額總量與壓縮版完全相同，只是改由檔案內容決定而不是靠 minalloc。
 */
export function buildExe(x: ExeImage): Uint8Array {
    const HDR = 0x1c;
    const hdrPara = Math.ceil((HDR + x.relocs.length * 4) / 16);
    const hdrBytes = hdrPara * 16;
    const bodyParas = Math.ceil(x.image.length / 16) + x.minAlloc;
    const bodyBytes = bodyParas * 16;
    const total = hdrBytes + bodyBytes;
    const out = new Uint8Array(total);

    out[0] = 0x4d; out[1] = 0x5a;                   // 'MZ'
    wr16(out, 2, total % 512);                      // 最後一頁用掉幾 bytes（0 = 整頁）
    wr16(out, 4, Math.ceil(total / 512));
    wr16(out, 6, x.relocs.length);
    wr16(out, 8, hdrPara);
    wr16(out, 10, 0);                               // 配額已經全部寫進檔案了
    wr16(out, 12, 0xffff);                          // maxalloc
    wr16(out, 14, x.ss); wr16(out, 16, x.sp);
    wr16(out, 18, 0);                               // checksum，DOS 不檢查
    wr16(out, 20, x.ip); wr16(out, 22, x.cs);
    wr16(out, 24, HDR);                             // 重定位表位置
    wr16(out, 26, 0);                               // overlay

    let p = HDR;
    for (const r of x.relocs) { wr16(out, p, r.off); wr16(out, p + 2, r.seg); p += 4; }
    out.set(x.image, hdrBytes);
    return out;
}

// ── 每張圖的容量（映像 offset）────────────────────────────────────────
// 對應的指令：MOV word[0x1096], maxLoc / MOV word[0x1098], 特殊數。
// 這裡記的是**立即數**的位置，不是指令開頭。

export interface MapCapOffsets { maxLoc: number; special: number }
export const MAP_CAPS: MapCapOffsets[] = [
    { maxLoc: 0x122aa, special: 0x122b0 },   // 台灣
    { maxLoc: 0x122c4, special: 0x122ca },   // 香港
    { maxLoc: 0x122de, special: 0x122e4 },   // 大富翁城
];

/** 把「原版映像 offset」換算成這份映像的實際位置（插過的區塊會讓它往後位移）。 */
export function imageOffset(x: ExeImage, original: number): number {
    let o = original;
    for (const ins of x.inserts ?? []) if (original >= ins.atOriginal) o += ins.bytes;
    return o;
}

/**
 * `imageOffset` 的反向：把「這份映像的實際位置」換算回原版座標。
 * segmentEnds 之類的東西是從**現況**讀出來的，要餵回 insertBlock（吃原版座標）就得先換回來。
 */
export function toOriginal(x: ExeImage, current: number): number {
    let acc = 0;
    for (const ins of x.inserts ?? []) {
        if (current >= ins.atOriginal + acc + ins.bytes) acc += ins.bytes;
    }
    return current - acc;
}

export function readCap(x: ExeImage, mapIdx: number, which: keyof MapCapOffsets): number {
    return rd16(x.image, imageOffset(x, MAP_CAPS[mapIdx][which]));
}

export function writeCap(x: ExeImage, mapIdx: number, which: keyof MapCapOffsets, v: number): void {
    wr16(x.image, imageOffset(x, MAP_CAPS[mapIdx][which]), v);
}
