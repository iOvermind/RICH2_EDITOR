// src/core/gamefolder.ts
// 用 File System Access API 直接讀寫遊戲資料夾（rich2/）：
// 依地圖下拉選單載入對應 PART?.PAK + SAVE_?.DSK，並一次性把 DSK/PAK/EXE 寫回。
// 僅支援 Chromium 系瀏覽器（Chrome/Edge）。

export interface MapDef {
    name: string;   // 顯示名稱
    pak: string;    // 地圖檔
    dsk: string;    // 初始存檔
    exeMaxLocOffset: number;  // Run.exe 內該圖 maxLocId [0x1096] 的 immediate offset
    exeSpecialOffset: number; // Run.exe 內該圖 特殊地點數 [0x1098] 的 immediate offset
}

// 三張地圖 → 檔案對應（檔名大小寫需與資料夾一致）
export const MAPS: MapDef[] = [
    { name: '台灣', pak: 'Part1.pak', dsk: 'Save_7.dsk', exeMaxLocOffset: 0x124aa, exeSpecialOffset: 0x124b0 },
    { name: '香港', pak: 'Part2.pak', dsk: 'Save_8.dsk', exeMaxLocOffset: 0x124c4, exeSpecialOffset: 0x124ca },
    { name: '大富翁城', pak: 'Part3.pak', dsk: 'Save_9.dsk', exeMaxLocOffset: 0x124de, exeSpecialOffset: 0x124e4 },
];

const EXE_NAME = 'Run.exe';
const EXE_BAK = 'Run.exe.bak';
export const MAXLOC_TARGET = 282; // 三張圖 maxLocId 統一開到 282（loc 陣列上限 283）

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let dirHandle: any = null;

export function isSupported(): boolean {
    return typeof (window as any).showDirectoryPicker === 'function';
}
export function hasFolder(): boolean { return !!dirHandle; }
export function folderName(): string { return dirHandle ? dirHandle.name : ''; }

/** 讓使用者挑遊戲資料夾。回傳資料夾名稱。 */
export async function pickGameFolder(): Promise<string> {
    dirHandle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
    return dirHandle.name;
}

async function ensureReadWrite(): Promise<boolean> {
    if (!dirHandle) return false;
    const opts = { mode: 'readwrite' as const };
    if ((await dirHandle.queryPermission(opts)) === 'granted') return true;
    return (await dirHandle.requestPermission(opts)) === 'granted';
}

/** 讀取資料夾內某檔為 ArrayBuffer。 */
export async function readFile(name: string): Promise<ArrayBuffer> {
    if (!dirHandle) throw new Error('尚未選擇遊戲資料夾');
    const fh = await dirHandle.getFileHandle(name);
    const f = await fh.getFile();
    return await f.arrayBuffer();
}

async function fileExists(name: string): Promise<boolean> {
    try { await dirHandle.getFileHandle(name); return true; } catch { return false; }
}

/**
 * 寫入（覆蓋）資料夾內某檔。
 * 第一次覆蓋前會自動備份成 `<檔名>.bak`（已存在就不再覆蓋，保住最原始那份）。
 * 這件事很重要：DSK/PAK 一旦被編輯器覆寫就回不去了，而遊戲原版檔通常沒有別的來源。
 */
export async function writeFile(
    name: string, data: ArrayBuffer | Uint8Array, onLog?: (m: string) => void,
): Promise<void> {
    if (!dirHandle) throw new Error('尚未選擇遊戲資料夾');

    const bak = name + '.bak';
    if (!(await fileExists(bak))) {
        try {
            const original = await readFile(name);          // 讀得到才備份（新建檔案就沒有原版）
            const bh = await dirHandle.getFileHandle(bak, { create: true });
            const bw = await bh.createWritable();
            await bw.write(original);
            await bw.close();
            if (onLog) onLog(`已備份原始 ${name} → ${bak}`);
        } catch { /* 原檔不存在＝新建，不需要備份 */ }
    }

    const fh = await dirHandle.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(data);
    await w.close();
}

/** 讀取某圖目前在 Run.exe 裡的特殊地點數 [0x1098]。 */
export async function readSpecialCount(mapIndex: number): Promise<number> {
    const m = MAPS[mapIndex];
    if (!m) throw new Error('無效地圖');
    const raw = new Uint8Array(await readFile(EXE_NAME));
    return new DataView(raw.buffer).getUint16(m.exeSpecialOffset, true);
}

/** 遊戲資料夾裡所有含文字的檔案（用來蒐集字型支援的字集）。 */
/**
 * 遊戲字表所在的檔案：`Wor.pak` 裡有一組乾淨的 2-byte Big5 陣列（原版 639 項），
 * 那就是全遊戲畫得出來的所有字，三張地圖共用同一張。
 */
export const CHAR_TABLE_FILE = 'Wor.pak';

/** 讀取資料夾內某檔；讀不到回 null（檔案不存在時不要讓整個流程掛掉）。 */
export async function tryReadFile(name: string): Promise<ArrayBuffer | null> {
    try { return await readFile(name); } catch { return null; }
}

// ── 「經過就觸發」的特殊地點種類 ────────────────────────────────────────
//
// 逆向結果見 docs/runexe-re.md §10。移動途中每經過一格，引擎會讀該地點的 SPECIAL
// 欄位，原版寫死「等於 1（銀行）才觸發」，其餘種類都要剛好停在上面。
// 那段判斷在解壓映像 0x1A5F、檔案 **0x1C5F**，共 9 個位元組：
//
//   26 83 3F 01   cmp word ptr es:[bx], 1     ← 01 就是銀行
//   74 03         je   0x1A68                 ← 觸發
//   E9 69 00      jmp  0x1AD1                 ← 不觸發
//
// 改成「範圍判斷」剛好也是 9 個位元組，不必另外找空間、也不用 386 指令：
//
//   26 8B 07      mov ax, es:[bx]             ; ax = 種類（值 0~10，AH 必為 0）
//   2C <LOW>      sub al, LOW
//   3C <SPAN>     cmp al, SPAN                ; SPAN = HIGH - LOW
//   77 69         ja  0x1AD1                  ; 不在範圍 → 不觸發（rel8 = 105，塞得下）
//   1A68:         （直接落下 ＝ 觸發）
//
// 低於 LOW 的種類做 `sub al` 會借位變成大數，一樣被 `ja` 濾掉，所以只用兩條比較
// 就表達得出一個閉區間。AX 在 0x1A68 立刻被 `mov ax,0xb` 覆蓋，clobber 是安全的。
//
// ⚠ 只做得到**連續區間**，不是任意組合 —— 9 個位元組放不下位元遮罩，而初始化資料
// 落在 EXEPACK 的壓縮尾段、沒辦法直接 patch。種類編號依序是
// 0=公園 1=銀行 2=運氣 3=卡片 4=新聞 5=股市 6=法院 7=黑市 8=賭場 9=遊樂場 10=稅捐處。
const PASS_OFFSET = 0x1c5f;
const PASS_ORIG = [0x26, 0x83, 0x3f, 0x01, 0x74, 0x03, 0xe9, 0x69, 0x00];
const PASS_PATCHED = [0x26, 0x8b, 0x07, 0x2c, 0x00, 0x3c, 0x00, 0x77, 0x69];
const PASS_LOW_AT = 4, PASS_SPAN_AT = 6;

export interface PassThrough {
    /** 會「經過就觸發」的種類區間（含兩端） */
    low: number;
    high: number;
    /** true＝已經是區間版；false＝還是原版那條 cmp==1 */
    patched: boolean;
}

const sameBytes = (raw: Uint8Array, at: number, want: number[], skip: number[] = []) =>
    want.every((v, i) => skip.includes(i) || raw[at + i] === v);

/**
 * 讀出目前「經過就觸發」的種類區間。認不出那 9 個位元組就回 null
 * —— 可能是別的版本或被其他工具改過，這種時候寧可不動它。
 */
export async function readPassThrough(): Promise<PassThrough | null> {
    const raw = new Uint8Array(await readFile(EXE_NAME));
    if (sameBytes(raw, PASS_OFFSET, PASS_ORIG)) return { low: 1, high: 1, patched: false };
    if (sameBytes(raw, PASS_OFFSET, PASS_PATCHED, [PASS_LOW_AT, PASS_SPAN_AT])) {
        const low = raw[PASS_OFFSET + PASS_LOW_AT];
        return { low, high: low + raw[PASS_OFFSET + PASS_SPAN_AT], patched: true };
    }
    return null;
}

/**
 * 設定「經過就觸發」的種類區間。`low > high` 代表停用（區間為空）。
 * 寫回原版行為（1~1）時會還原成原本那條 `cmp ==1`，讓檔案回到跟原版一模一樣。
 */
export async function writePassThrough(
    low: number, high: number, logMsg: (m: string) => void,
): Promise<boolean> {
    if (!(await ensureReadWrite())) throw new Error('沒有資料夾寫入權限');
    const cur = await readPassThrough();
    if (!cur) throw new Error(`${EXE_NAME} 的「經過觸發」判斷認不出來（可能是別的版本），沒有動它`);
    if (cur.low === low && cur.high === high) return false;

    const raw = new Uint8Array(await readFile(EXE_NAME));
    if (!(await fileExists(EXE_BAK))) {
        await writeFile(EXE_BAK, raw.slice());
        logMsg(`已備份原始 ${EXE_NAME} → ${EXE_BAK}`);
    }
    const bytes = (low === 1 && high === 1)
        ? PASS_ORIG                                  // 回到原版就寫回原本那條，檔案完全還原
        : PASS_PATCHED.map((v, i) =>
            i === PASS_LOW_AT ? (low & 0xff)
                : i === PASS_SPAN_AT ? (Math.max(high - low, 0) & 0xff) : v);
    raw.set(bytes, PASS_OFFSET);
    await writeFile(EXE_NAME, raw);
    return true;
}

export interface MapCaps { name: string; maxLoc: number; special: number }

/** 讀出 Run.exe 目前三張圖的容量設定，用來回報「現在到底是什麼狀態」。 */
export async function readCaps(): Promise<MapCaps[]> {
    const raw = new Uint8Array(await readFile(EXE_NAME));
    const dv = new DataView(raw.buffer);
    return MAPS.map(m => ({
        name: m.name,
        maxLoc: dv.getUint16(m.exeMaxLocOffset, true),
        special: dv.getUint16(m.exeSpecialOffset, true),
    }));
}

/**
 * Patch Run.exe：
 *  - 三張圖 maxLocId [0x1096] 統一設 282（RC 已是，等於只動台灣/香港）
 *  - 若給了 specialCount，順便把「當前地圖」的特殊地點數 [0x1098] 設為該值
 * 不碰玩家數 [0x1058]。首次會備份 Run.exe.bak。
 * 回傳 { maxLocChanged: 更動幾張圖的 maxLoc, specialChanged: 特殊數是否有變, specialFrom, specialTo }。
 */
export async function patchExe(
    logMsg: (m: string) => void,
    mapIndex?: number,
    specialCount?: number,
    /** 每張圖要設定的 maxLocId（null＝不動那張圖）。不給就沿用舊行為（一律 282）。 */
    maxLocByMap?: (number | null)[],
): Promise<{ maxLocChanged: number; specialChanged: boolean; specialFrom: number; specialTo: number }> {
    if (!(await ensureReadWrite())) throw new Error('沒有資料夾寫入權限');
    const raw = new Uint8Array(await readFile(EXE_NAME));
    if (!(await fileExists(EXE_BAK))) {
        await writeFile(EXE_BAK, raw.slice());
        logMsg(`已備份原始 ${EXE_NAME} → ${EXE_BAK}`);
    }
    const dv = new DataView(raw.buffer);
    let maxLocChanged = 0;
    for (let i = 0; i < MAPS.length; i++) {
        const m = MAPS[i];
        // maxLocId 只要 ≥ 該圖實際用到的最大編號就夠，不需要一律開到 282。
        // 開太大會讓引擎把中間那一大段空記錄也當成合法地點（拍賣等事件可能因此挑到空槽）。
        const want = maxLocByMap ? maxLocByMap[i] : MAXLOC_TARGET;
        if (want == null) continue;
        const target = Math.min(Math.max(want, 1), MAXLOC_TARGET);
        if (dv.getUint16(m.exeMaxLocOffset, true) !== target) {
            dv.setUint16(m.exeMaxLocOffset, target, true);
            maxLocChanged++;
        }
    }
    let specialChanged = false, specialFrom = 0, specialTo = 0;
    if (mapIndex != null && specialCount != null && MAPS[mapIndex]) {
        const off = MAPS[mapIndex].exeSpecialOffset;
        specialFrom = dv.getUint16(off, true);
        specialTo = specialCount;
        if (specialFrom !== specialTo) { dv.setUint16(off, specialTo & 0xffff, true); specialChanged = true; }
    }
    if (maxLocChanged > 0 || specialChanged) await writeFile(EXE_NAME, raw);
    return { maxLocChanged, specialChanged, specialFrom, specialTo };
}
