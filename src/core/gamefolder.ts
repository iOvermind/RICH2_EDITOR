// src/core/gamefolder.ts
// 用 File System Access API 直接讀寫遊戲資料夾（rich2/）：
// 依地圖下拉選單載入對應 PART?.PAK + SAVE_?.DSK，並一次性把 DSK/PAK/EXE 寫回。
// 桌面版（Tauri）與瀏覽器版共用；差異封裝在 folder-backend.ts。
import { backend } from './folder-backend';
import { loadExe, buildExe, readCap, writeCap, type ExeImage } from './exe';
import { insertPassThrough, defaultTable, isDefaultTable, readPassTable, type PassAction } from './passthrough';
import { insertPriceIndex, isPriceIndexOff, readPriceIndexSettings, type PriceIndexOptions } from './priceindex';

export interface MapDef {
    name: string;   // 顯示名稱
    pak: string;    // 地圖檔
    dsk: string;    // 初始存檔
}
// 容量那兩個立即數的位置改由 exe.ts 的 MAP_CAPS 管（映像 offset，順序與 MAPS 相同）。
// 這裡不再存檔案 offset：輸出的 Run.exe 是未壓縮版，檔頭大小跟原版不一樣。

// 三張地圖 → 檔案對應（檔名大小寫需與資料夾一致）
export const MAPS: MapDef[] = [
    { name: '台灣', pak: 'Part1.pak', dsk: 'Save_7.dsk' },
    { name: '香港', pak: 'Part2.pak', dsk: 'Save_8.dsk' },
    { name: '大富翁城', pak: 'Part3.pak', dsk: 'Save_9.dsk' },
];

const EXE_NAME = 'Run.exe';
const EXE_BAK = 'Run.exe.bak';
export const MAXLOC_TARGET = 282; // 三張圖 maxLocId 統一開到 282（loc 陣列上限 283）

// 實際怎麼讀寫檔案由 folder-backend 決定：Tauri 裡走 fs 外掛，瀏覽器裡走
// File System Access API。這一層以上的邏輯（備份、解析、patch）兩邊完全共用。
export function isSupported(): boolean { return backend.supported(); }
export function hasFolder(): boolean { return backend.opened(); }
export function folderName(): string { return backend.name(); }
/** 目前是哪一種後端，用來決定要不要提示「請用 Chrome/Edge」 */
export function backendKind(): 'browser' | 'tauri' { return backend.kind; }

/** 讓使用者挑遊戲資料夾。回傳資料夾名稱。 */
export async function pickGameFolder(): Promise<string> {
    return await backend.pick();
}

const ensureReadWrite = () => backend.ensureWritable();

/** 讀取資料夾內某檔為 ArrayBuffer。 */
export async function readFile(name: string): Promise<ArrayBuffer> {
    return await backend.read(name);
}

const fileExists = (name: string) => backend.exists(name);

/**
 * 寫入（覆蓋）資料夾內某檔。
 * 第一次覆蓋前會自動備份成 `<檔名>.bak`（已存在就不再覆蓋，保住最原始那份）。
 * 這件事很重要：DSK/PAK 一旦被編輯器覆寫就回不去了，而遊戲原版檔通常沒有別的來源。
 *
 * `Run.exe.bak` 是**原版**，而且現在是正式的來源檔：每次 patchExe 都從它重建，
 * 所以 patch 不會疊加，也不需要「撤銷」的邏輯。**它不能弄丟。**
 *
 * （舊註解說「遊戲會把硬體偵測結果寫回 Run.exe，所以不能整檔還原」——那是誤判。
 * 實測：`Run.exe.bak` 與 `original/Run.exe` 逐位元組相同；跑過好幾次的執行檔
 * 與重新建置的版本也是 0 bytes 差異。它記錄的症狀「配色跑掉、接著花屏」，
 * 後來查明是別的原因。）
 */
export async function writeFile(
    name: string, data: ArrayBuffer | Uint8Array, onLog?: (m: string) => void,
): Promise<void> {
    if (!backend.opened()) throw new Error('尚未選擇遊戲資料夾');

    const bak = name + '.bak';
    if (!(await fileExists(bak))) {
        try {
            const original = await readFile(name);          // 讀得到才備份（新建檔案就沒有原版）
            await backend.write(bak, new Uint8Array(original));
            if (onLog) onLog(`已備份原始 ${name} → ${bak}`);
        } catch { /* 原檔不存在＝新建，不需要備份 */ }
    }

    await backend.write(name, data instanceof Uint8Array ? data : new Uint8Array(data));
}

/** 讀取某圖目前在 Run.exe 裡的特殊地點數 [0x1098]。 */
export async function readSpecialCount(mapIndex: number): Promise<number> {
    if (!MAPS[mapIndex]) throw new Error('無效地圖');
    return readCap(loadExe(new Uint8Array(await readFile(EXE_NAME))), mapIndex, 'special');
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

export interface MapCaps { name: string; maxLoc: number; special: number }

/** 讀出 Run.exe 目前的「經過就觸發」設定，用來把 UI 反白成現況。 */
export async function readPassSettings(): Promise<PassAction[]> {
    return readPassTable(loadExe(new Uint8Array(await readFile(EXE_NAME))));
}

/** 讀出 Run.exe 目前的物價指數設定；沒插碼就回 null。 */
export async function readPriceIndex(): Promise<{ threshold: number; cap: number; noHighWater: boolean } | null> {
    return readPriceIndexSettings(loadExe(new Uint8Array(await readFile(EXE_NAME))));
}

/** 讀出 Run.exe 目前三張圖的容量設定，用來回報「現在到底是什麼狀態」。 */
export async function readCaps(): Promise<MapCaps[]> {
    const x = loadExe(new Uint8Array(await readFile(EXE_NAME)));
    return MAPS.map((m, i) => ({ name: m.name, maxLoc: readCap(x, i, 'maxLoc'), special: readCap(x, i, 'special') }));
}

/**
 * 取得「乾淨的原版映像」。每次 patch 都從這裡重建，patch 就不會疊加，
 * 也不需要任何撤銷邏輯——編輯器的設定就是唯一真相。
 * `Run.exe.bak` 是原版；還沒有的話先拿現在這份備份起來。
 */
async function pristineExe(logMsg: (m: string) => void): Promise<ExeImage> {
    if (!(await fileExists(EXE_BAK))) {
        const cur = new Uint8Array(await readFile(EXE_NAME));
        await backend.write(EXE_BAK, cur.slice());
        logMsg(`已備份原始 ${EXE_NAME} → ${EXE_BAK}`);
    }
    return loadExe(new Uint8Array(await readFile(EXE_BAK)));
}

export interface PatchExeResult {
    maxLocChanged: number; specialChanged: boolean; specialFrom: number; specialTo: number;
    /** 有沒有真的寫檔（內容跟現況一樣就不寫） */
    wrote: boolean;
    /** 這次輸出的 Run.exe 有沒有含「經過就觸發」的跳板 */
    passThrough: boolean;
    /** 這次輸出的 Run.exe 有沒有含「物價指數」的跳板 */
    priceIndex: boolean;
}

/**
 * 重建 Run.exe。順序是固定的：
 *   原版映像 → 改容量（映像 offset）→ 需要的話插跳板 → 產出未壓縮 MZ
 * 「先容量後跳板」是為了讓容量那幾個位元組跟著插入自動位移；不過 readCap/writeCap
 * 兩邊都認得，順序反了也不會錯。
 *
 * ⚠ 輸出**一律是未壓縮版**（188KB → 216KB）。原版是 EXEPACK 壓縮的，但我們要在
 * 程式碼段插跳板，壓縮版沒有這個餘裕。實測未壓縮版可正常遊玩，遊戲也不會回寫執行檔。
 */
export async function patchExe(
    logMsg: (m: string) => void,
    mapIndex?: number,
    specialCount?: number,
    /** 每張圖要設定的 maxLocId（null＝沿用原版）。不給就一律 282。 */
    maxLocByMap?: (number | null)[],
    /** 「經過就觸發」的種類表；不給就是原版行為（只有銀行的過路處理） */
    passTable?: PassAction[],
    /** 物價指數設定；不給或門檻 0 就不插碼 */
    priceIndexOpt?: PriceIndexOptions | null,
): Promise<PatchExeResult> {
    if (!(await ensureReadWrite())) throw new Error('沒有資料夾寫入權限');
    const x = await pristineExe(logMsg);
    const before = await readCaps();

    let maxLocChanged = 0;
    for (let i = 0; i < MAPS.length; i++) {
        // maxLocId 只要 ≥ 該圖實際用到的最大編號就夠，不需要一律開到 282。
        // 開太大會讓引擎把中間那一大段空記錄也當成合法地點（拍賣等事件可能因此挑到空槽）。
        const want = maxLocByMap ? maxLocByMap[i] : MAXLOC_TARGET;
        if (want == null) continue;
        const target = Math.min(Math.max(want, 1), MAXLOC_TARGET);
        if (readCap(x, i, 'maxLoc') !== target) { writeCap(x, i, 'maxLoc', target); }
        if (target !== before[i].maxLoc) maxLocChanged++;
    }

    let specialChanged = false, specialFrom = 0, specialTo = 0;
    if (mapIndex != null && specialCount != null && MAPS[mapIndex]) {
        specialFrom = before[mapIndex].special;
        specialTo = specialCount & 0xffff;
        writeCap(x, mapIndex, 'special', specialTo);
        specialChanged = specialFrom !== specialTo;
    } else if (mapIndex != null && MAPS[mapIndex]) {
        writeCap(x, mapIndex, 'special', before[mapIndex].special);   // 沿用現況
    }
    // 沒指定的那幾張圖也要沿用現況，不然會被原版值蓋回去
    for (let i = 0; i < MAPS.length; i++) {
        if (i !== mapIndex) writeCap(x, i, 'special', before[i].special);
    }

    const table = passTable ?? defaultTable();
    const passThrough = !isDefaultTable(table);
    if (passThrough) insertPassThrough(x, table);

    // ⚠ 一定要在 insertPassThrough **之後**：兩塊跳板的位移會疊加，順序反了就對不上。
    const priceIndex = !!priceIndexOpt && !isPriceIndexOff(priceIndexOpt);
    if (priceIndex) insertPriceIndex(x, priceIndexOpt!);

    const out = buildExe(x);
    const cur = new Uint8Array(await readFile(EXE_NAME));
    const same = cur.length === out.length && cur.every((v, i) => v === out[i]);
    if (!same) await backend.write(EXE_NAME, out);
    return { maxLocChanged, specialChanged, specialFrom, specialTo, wrote: !same, passThrough, priceIndex };
}
