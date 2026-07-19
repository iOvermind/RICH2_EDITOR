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
const MAXLOC_TARGET = 282; // 三張圖 maxLocId 統一開到 282（loc 陣列上限 283）

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

/** 寫入（覆蓋）資料夾內某檔。 */
export async function writeFile(name: string, data: ArrayBuffer | Uint8Array): Promise<void> {
    if (!dirHandle) throw new Error('尚未選擇遊戲資料夾');
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
): Promise<{ maxLocChanged: number; specialChanged: boolean; specialFrom: number; specialTo: number }> {
    if (!(await ensureReadWrite())) throw new Error('沒有資料夾寫入權限');
    const raw = new Uint8Array(await readFile(EXE_NAME));
    if (!(await fileExists(EXE_BAK))) {
        await writeFile(EXE_BAK, raw.slice());
        logMsg(`已備份原始 ${EXE_NAME} → ${EXE_BAK}`);
    }
    const dv = new DataView(raw.buffer);
    let maxLocChanged = 0;
    for (const m of MAPS) {
        if (dv.getUint16(m.exeMaxLocOffset, true) !== MAXLOC_TARGET) {
            dv.setUint16(m.exeMaxLocOffset, MAXLOC_TARGET, true);
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
