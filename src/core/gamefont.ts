// src/core/gamefont.ts
// 遊戲字型（`Wor.pak`）的讀寫：加字＝同時往「字表」與「字形」各補一筆。
//
// 檔案結構（逆向結果寫在 docs/runexe-re.md §7、§8）：
//   g1（index 1）＝ 前 1664 bytes 是繪圖用的 run-length 查表（定長，與字數無關），
//                   之後每 30 bytes 一個字形（16 寬 × 15 高、1bpp、每列 2 bytes、MSB 在左）
//   g4（index 4）＝ 2-byte Big5 字表（原版 639 項）
//   glyph[i] 就是 table[i]，1:1，中間沒有任何對照層。
//
// **Run.exe 裡沒有寫死字數**（639/1278/19170 都不是立即數），字數是從資料本身推出來的，
// 所以兩組一起加長就會生效 —— 已用「苗」「栗」在遊戲裡實測過。
//
// 新字的點陣來自 `src/assets/gamefont/`：離線用 GDI+ 把細明體(MingLiU)烤成的圖庫，
// 產生器是 `tools/build-font-atlas.mjs`。不在瀏覽器裡用 Canvas 畫，是因為 Canvas 走輪廓
// 描繪 + 灰階反鋸齒，15px 二值化後會糊；GDI+ 走的是細明體內嵌點陣，跟遊戲那套字同源。
import iconv from 'iconv-lite';
import { Buffer } from 'buffer';
import { parsePackPointers, replaceGroupInDsk } from './parser';
import { decompressGeneralData } from '../utils/compression';
import { readFile, writeFile, CHAR_TABLE_FILE } from './gamefolder';
import atlasUrl from '../assets/gamefont/mingliu-16x15.bin?url';

/** 每個字形 30 bytes = 16 寬 × 15 高 */
export const GLYPH_BYTES = 30;
/** g1 前面那張 run-length 查表的長度，字形從這裡開始 */
const FONT_HEADER = 1664;
/** 字表用到的 Big5 首位元組下界。低於這個的字會讓遊戲的雙位元組解析錯位，加了也沒用。 */
export const BIG5_LEAD_MIN = 0xa1;
/** 字形在 PAK 裡的組別 */
const FONT_GROUP = 1;
const TABLE_GROUP = 4;

// ── 點陣圖庫 ────────────────────────────────────────────────────────────
// slot = (lead - 0xA1) * 157 + trailIndex；trail 0x40~0x7E → 0~62、0xA1~0xFE → 63~156
const LEADS = 0xf9 - 0xa1 + 1;   // 89
const TRAILS = 157;
const ATLAS_BYTES = LEADS * TRAILS * GLYPH_BYTES;   // 419190
let atlas: Uint8Array | null = null;

/**
 * 載入點陣圖庫（只會真的載一次）。
 *
 * ⚠ 圖庫**刻意不壓縮**。之前放成 `.bin.gz`，靜態伺服器看到 `.gz` 副檔名會自己掛上
 * `Content-Encoding: gzip`，瀏覽器已經解過一次，前端再 `DecompressionStream('gzip')`
 * 就必然失敗。傳輸時的壓縮交給 HTTP 層處理就好。
 */
export async function loadGlyphAtlas(): Promise<boolean> {
    if (atlas) return true;
    const res = await fetch(atlasUrl);
    if (!res.ok) throw new Error(`取不到 ${atlasUrl}：${res.status} ${res.statusText}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length !== ATLAS_BYTES) {
        throw new Error(`圖庫大小不對：拿到 ${buf.length} bytes，應為 ${ATLAS_BYTES}`);
    }
    atlas = buf;
    return true;
}

export function atlasReady(): boolean { return atlas !== null; }

function slotOf(ch: string): number {
    const b5 = iconv.encode(ch, 'big5');
    if (b5.length !== 2) return -1;
    const lead = b5[0], trail = b5[1];
    if (lead < BIG5_LEAD_MIN || lead > 0xf9) return -1;
    const t = trail >= 0x40 && trail <= 0x7e ? trail - 0x40
        : trail >= 0xa1 && trail <= 0xfe ? 63 + trail - 0xa1 : -1;
    if (t < 0) return -1;
    return ((lead - BIG5_LEAD_MIN) * TRAILS + t) * GLYPH_BYTES;
}

/** 取這個字的 30-byte 字形；圖庫沒載到、或這個碼位沒有字，都回 null。 */
export function glyphFor(ch: string): Uint8Array | null {
    if (!atlas) return null;
    const off = slotOf(ch);
    if (off < 0 || off + GLYPH_BYTES > atlas.length) return null;
    const g = atlas.subarray(off, off + GLYPH_BYTES);
    return g.some(v => v !== 0) ? g : null;   // 全零＝這個碼位沒有字
}

/** 這個字加得進遊戲字型嗎（Big5 首位元組夠高、而且圖庫畫得出來）。 */
export function canAddChar(ch: string): boolean {
    const b5 = iconv.encode(ch, 'big5');
    if (b5.length !== 2 || b5[0] < BIG5_LEAD_MIN) return false;
    return glyphFor(ch) !== null;
}

// ── 讀 / 寫 Wor.pak ─────────────────────────────────────────────────────
export interface GameFont {
    /** 完整字表，有順序；index 就是字形的 index */
    table: string[];
    /** 字形區（不含前面那 1664 bytes 的查表） */
    glyphs: Uint8Array;
    /** g1 的原始解壓內容 */
    rawFont: Uint8Array;
    /** g4 的原始解壓內容 */
    rawTable: Uint8Array;
    bytes: Uint8Array;
    ptrs: number[];
}

/** 從遊戲資料夾讀出字表與字形。結構對不上就回 null（不要硬改一個看不懂的檔）。 */
export async function readGameFont(): Promise<GameFont | null> {
    const buf = await readFile(CHAR_TABLE_FILE);
    const bytes = new Uint8Array(buf);
    const dv = new DataView(buf);
    const ptrs = parsePackPointers(dv);
    if (ptrs.length <= Math.max(FONT_GROUP, TABLE_GROUP)) return null;

    const rawTable = decompressGeneralData(dv, ptrs[TABLE_GROUP]);
    if (rawTable.length < 400 || rawTable.length % 2 !== 0) return null;
    for (let i = 0; i < rawTable.length; i += 2) {
        if (rawTable[i] < 0x81 || rawTable[i] > 0xfe) return null;   // 不是乾淨的 Big5 陣列
    }
    const rawFont = decompressGeneralData(dv, ptrs[FONT_GROUP]);
    const count = rawTable.length / 2;
    if (rawFont.length < FONT_HEADER + count * GLYPH_BYTES) return null;

    const table: string[] = [];
    for (let i = 0; i < count; i++) {
        table.push(iconv.decode(Buffer.from(rawTable.slice(i * 2, i * 2 + 2)), 'big5'));
    }
    return {
        table,
        glyphs: rawFont.subarray(FONT_HEADER, FONT_HEADER + count * GLYPH_BYTES),
        rawFont, rawTable, bytes, ptrs,
    };
}

export interface AddCharsResult {
    /** 真的加進去的字 */
    added: string[];
    /** 圖庫裡沒有字形、加不了的字 */
    noGlyph: string[];
    /** Big5 首位元組 < 0xA1，遊戲根本不認、加了也沒用的字 */
    desync: string[];
    /** 加完之後的完整字表（呼叫端拿去更新快取） */
    table: string[];
}

/**
 * 把缺的字補進 `Wor.pak` 的字表與字形，並寫回遊戲資料夾。
 * 沒有任何字需要加就回傳 `added: []` 且**不會動到檔案**。
 * `writeFile` 第一次覆蓋前會自動備份成 `Wor.pak.bak`。
 */
export async function addCharsToGameFont(
    chars: string[], onLog?: (m: string) => void,
): Promise<AddCharsResult> {
    const font = await readGameFont();
    if (!font) throw new Error(`${CHAR_TABLE_FILE} 的字表／字形結構認不出來，沒有動它`);

    const added: string[] = [], noGlyph: string[] = [], desync: string[] = [];
    const codes: Uint8Array[] = [], glyphs: Uint8Array[] = [];
    const seen = new Set(font.table);
    for (const ch of chars) {
        if (seen.has(ch)) continue;
        const b5 = iconv.encode(ch, 'big5');
        if (b5.length !== 2 || b5[0] < BIG5_LEAD_MIN) { desync.push(ch); continue; }
        const g = glyphFor(ch);
        if (!g) { noGlyph.push(ch); continue; }
        seen.add(ch);
        added.push(ch);
        codes.push(new Uint8Array(b5));
        glyphs.push(g);
    }
    const table = font.table.slice();
    if (added.length === 0) return { added, noGlyph, desync, table };

    // 字表尾端接上新的 Big5 碼
    const newTable = new Uint8Array(font.rawTable.length + added.length * 2);
    newTable.set(font.rawTable, 0);
    codes.forEach((c, i) => newTable.set(c, font.rawTable.length + i * 2));

    // 字形接在最後一個字形之後（g1 尾端可能有幾個 byte 的餘料，要留在後面）
    const cut = FONT_HEADER + font.table.length * GLYPH_BYTES;
    const newFont = new Uint8Array(font.rawFont.length + added.length * GLYPH_BYTES);
    newFont.set(font.rawFont.subarray(0, cut), 0);
    glyphs.forEach((g, i) => newFont.set(g, cut + i * GLYPH_BYTES));
    newFont.set(font.rawFont.subarray(cut), cut + added.length * GLYPH_BYTES);

    // 引擎很可能靠「字表配置尾端那段 0」判斷表到哪裡結束（見 docs §8）。
    // 配置是進位到 16 bytes 的段落，餘裕為 0 時下一個區塊的內容會被當成字。
    const slack = (Math.ceil(newTable.length / 16) * 16) - newTable.length;
    if (slack === 0 && onLog) {
        onLog(`　⚠ 新字表 ${newTable.length} bytes 剛好卡在段落邊界（餘裕 0），` +
            `若遊戲顯示異常，多加或少加一個字就會錯開。`);
    }

    // 先換字形再換字表：replaceGroupInDsk 會把後面每一組的指標一起位移
    let r = replaceGroupInDsk(font.bytes, font.ptrs, FONT_GROUP, newFont);
    r = replaceGroupInDsk(r.bytes, r.ptrs, TABLE_GROUP, newTable);
    await writeFile(CHAR_TABLE_FILE, r.bytes, onLog);

    table.push(...added);
    return { added, noGlyph, desync, table };
}
