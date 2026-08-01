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
 *
 * ⚠ **`Run.exe.bak` 不要拿來整檔還原。** `Run.exe` 裡有三個位元組
 * （`0xBFE`、`0xC49E`、`0xC4A2`）**是遊戲自己寫的**——它偵測完硬體後會把音效／顯示
 * 設定寫回執行檔。`.bak` 是出廠原版，整檔覆蓋等於把那些偵測結果清回預設值，
 * 實測過一次「進遊戲後配色跑掉、接著花屏」，時間點與還原 `Run.exe` 吻合。
 * 要撤銷編輯器的 patch，只改那幾個容量位元組就好（見 MAPS 的 exeMaxLocOffset /
 * exeSpecialOffset），別整檔覆蓋。
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

// ── 「經過就觸發」：查清楚了，但**刻意不做成可編輯** ─────────────────────
//
// 逆向結果見 docs/runexe-re.md §10。移動途中每經過一格，引擎會在解壓映像 `0x1A5F`
// （檔案 `0x1C5F`）判斷 `cmp word ptr es:[bx], 1` —— es:[bx] 是該地點的 SPECIAL 欄位。
//
// ⚠ 但那個 `1` **不是「哪一種特殊地點會在經過時觸發」的開關**。條件成立後走到的
// `0x1A68` 是**銀行專屬的過路處理**（讀玩家欄位 11、比對 `[0x1082]`、顯示訊息 0xE3、
// 再 `call 0x75E4`），不是通用的特殊地點分派器（那個在 `0x340E`，由 `0x29D3` 呼叫）。
//
// 把條件放寬成區間試過了：其他種類會跑進銀行的處理流程，實測**整個遊戲配色跑掉、
// 角色移動出界**。所以這裡不提供任何 patch —— 要做「經過觸發」得從 `0x1A5F` 改成
// 呼叫 `0x340E`（還要先設好 `[0x2EA]`），9 個位元組放不下，需要跳板到空白區。
const PASS_CHECK_OFFSET = 0x1c5f;   // 只留位置備查，編輯器不會寫這裡
void PASS_CHECK_OFFSET;

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
