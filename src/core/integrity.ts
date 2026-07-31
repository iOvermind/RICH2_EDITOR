// src/core/integrity.ts
// 地圖結構完整性：偵測 + 修復引擎要求的不變式。
// 純函式，瀏覽器 (main.ts) 與 node 測試共用。
import {
    GRID_COLS, GRID_ROWS, LOC_COUNT, LOC_FIELDS, PRICE_SEG_COUNT, MARKER_ID_OFFSET,
    SPECIAL_TILE_BASE, SPECIAL_KIND_COUNT, SPECIAL_TILE_SPAN,
} from '../config/constants';

// 地點編號絕對上限（LOC_COUNT=283 → 合法 index 0..282）。>950 是 +950 購地標記，不算路徑地點。
export const MAX_LOC_ID = LOC_COUNT - 1;

export interface Dir {
    field: number;   // 此方向的指標欄位
    opp: number;     // 相反方向欄位
    dx: number;
    dy: number;
    code: number;    // 引擎方向代碼：1=左 2=上 3=右 4=下（UNKA/UNKB 用的就是這個）
    name: string;
}

// 四方向（含相反方向與 grid 位移）
export const DIRS: Dir[] = [
    { field: LOC_FIELDS.LEFT, opp: LOC_FIELDS.RIGHT, dx: -1, dy: 0, code: 1, name: '左' },
    { field: LOC_FIELDS.RIGHT, opp: LOC_FIELDS.LEFT, dx: 1, dy: 0, code: 3, name: '右' },
    { field: LOC_FIELDS.UP, opp: LOC_FIELDS.DOWN, dx: 0, dy: -1, code: 2, name: '上' },
    { field: LOC_FIELDS.DOWN, opp: LOC_FIELDS.UP, dx: 0, dy: 1, code: 4, name: '下' },
];

// 注意：大富翁的移動是「有向路徑圖」，允許路口/岔路（多條路匯入同一格），
// 且路徑會跨越 grid 上不相鄰的格子（轉角）。因此「方向指標必須 grid 相鄰」
// 與「反向指標必須對稱」都不是有效不變式（實測會在正常地圖狂噴假警報），故不檢查。
// 只保留在真實資料上零誤報、又能抓到實際損毀的結構檢查。
export type IssueKind =
    | 'coord-mismatch'   // 記錄座標 != grid 左上角
    | 'orphan-record'    // 記錄有資料，但 grid 上沒有任何格子用這個編號
    | 'dangling-ref'     // 某方向指標指向一個不在 grid 上的編號
    | 'dup-coord'        // 兩個 active 地點共用同一 X,Y
    | 'partition'        // 特殊種類掛在道路/土地編號上（或反之）
    | 'land-no-segment'  // 土地編號(≥51)卻沒設地段（買不了、沒價格）
    | 'route-entry'      // UNKA/UNKB=0 的入口格不是剛好一個（0 是入口格專屬標記）
    | 'segment-order'    // 地段內序號(UNK9)不是依 locId 排的 1..N
    | 'dead-end'         // grid 上路徑地點的方向連結數 < 2（玩家會走不動）
    | 'zero-price'       // 土地(seg>0)的地段買價 = 0（引擎可能除以 0）
    | 'special-block'    // 圖塊排成完整的特殊地點 2x2，四格卻不同屬一個 locId
    | 'special-kind'     // 地點的 SPECIAL 欄位與圖塊畫出來的種類不符
    | 'special-tile'     // 特殊圖塊沒排成完整 2x2（半個特殊地點），或佔 4 格卻沒有特殊圖塊
    | 'sea-road';        // 海上道路的編號沒有緊接在特殊地點之後（引擎會把落在界內的當特殊地點）

export interface IntegrityIssue {
    kind: IssueKind;
    locId: number;
    detail: string;
    fix?: () => void;    // 若可安全自動修復，帶一個修復函式
}

// ---- 低階存取 ----
export function getF(dv: DataView, field: number, id: number): number {
    if (id <= 0 || id >= LOC_COUNT) return 0;
    return dv.getUint16(field + id * 2, true);
}
export function setF(dv: DataView, field: number, id: number, val: number): void {
    if (id <= 0 || id >= LOC_COUNT) return;
    dv.setUint16(field + id * 2, val & 0xffff, true);
}
export function isActive(dv: DataView, id: number): boolean {
    if (id <= 0 || id >= LOC_COUNT) return false;
    for (const f of Object.values(LOC_FIELDS)) {
        if (dv.getUint16((f as number) + id * 2, true) !== 0) return true;
    }
    return false;
}

// ---- grid <-> locId ----
// 回傳每個 locId 佔用的 grid cell index 陣列
export function buildCellMap(grid: Uint16Array): Map<number, number[]> {
    const m = new Map<number, number[]>();
    for (let i = 0; i < GRID_COLS * GRID_ROWS; i++) {
        const id = grid[i];
        if (id === 0) continue;
        let a = m.get(id);
        if (!a) { a = []; m.set(id, a); }
        a.push(i);
    }
    return m;
}
// 地點左上角座標（min gx, min gy），對應引擎存的 X/Y
export function topLeft(cells: number[]): { x: number; y: number } {
    const x = Math.min(...cells.map(ci => ci % GRID_COLS));
    const y = Math.min(...cells.map(ci => Math.floor(ci / GRID_COLS)));
    return { x, y };
}

// ============================================================================
// 特殊地點：用圖塊確認身分
// ----------------------------------------------------------------------------
// 判準見 constants.ts 的 SPECIAL_TILE_BASE：一個特殊地點 = 2x2 四格 +「連號四塊」圖塊，
// 左上角 = 40 + 種類*4。舊寫法只數「佔幾格」，那只是必要條件 —— 任何 2x2 的東西都會通過。
// 圖塊對上了才真的認得出身分：它同時給出種類，而且反過來保證這四格屬於同一個 locId。
// ============================================================================

/** 這個圖塊屬於哪個特殊種類（0~10）？不是特殊圖塊回 -1。 */
export function specialKindOfTile(tile: number): number {
    if (tile < SPECIAL_TILE_BASE) return -1;
    const kind = Math.floor((tile - SPECIAL_TILE_BASE) / SPECIAL_TILE_SPAN);
    return kind < SPECIAL_KIND_COUNT ? kind : -1;
}

/** 某特殊種類該用的四塊圖塊，順序為左上、右上、左下、右下。 */
export function specialTilesOfKind(kind: number): number[] {
    const b = SPECIAL_TILE_BASE + kind * SPECIAL_TILE_SPAN;
    return [b, b + 1, b + 2, b + 3];
}

export interface SpecialBlock {
    kind: number;      // 圖塊算出來的特殊種類 0~10
    x: number; y: number;   // 左上角 grid 座標
    cells: number[];   // 四格 grid index：左上、右上、左下、右下
    ids: number[];     // 這四格用到的 locId（去重、由小到大，含 0）
    locId: number;     // 四格一致且非 0 時的編號，否則 -1
}

/** 圖塊排成完整 2x2 連號、但四格不同屬一個 locId 的區塊。 */
export interface SpecialBlockIssue {
    block: SpecialBlock;
    why: string;
    fixId: number;     // 該統一成哪個編號（-1 = 無法判斷，要人工決定）
}

/**
 * 掃出所有「圖塊排成完整 2x2 連號」的特殊區塊。只認左上角起算的完整四格，
 * 所以半個特殊地點（例如只貼了上面兩格）不會被誤認。
 */
export function findSpecialBlocks(grid: Uint16Array, layout: Uint16Array): SpecialBlock[] {
    const out: SpecialBlock[] = [];
    for (let y = 0; y < GRID_ROWS - 1; y++) {
        for (let x = 0; x < GRID_COLS - 1; x++) {
            const i = y * GRID_COLS + x;
            const t = layout[i];
            const kind = specialKindOfTile(t);
            if (kind < 0 || (t - SPECIAL_TILE_BASE) % SPECIAL_TILE_SPAN !== 0) continue;   // 只從左上角起算
            if (layout[i + 1] !== t + 1) continue;
            if (layout[i + GRID_COLS] !== t + 2) continue;
            if (layout[i + GRID_COLS + 1] !== t + 3) continue;
            const cells = [i, i + 1, i + GRID_COLS, i + GRID_COLS + 1];
            const ids = [...new Set(cells.map(c => grid[c]))].sort((a, b) => a - b);
            out.push({ kind, x, y, cells, ids, locId: ids.length === 1 && ids[0] > 0 ? ids[0] : -1 });
        }
    }
    return out;
}

export interface SpecialScan {
    /** 推算的特殊地點數 [0x1098]＝確認過的最大編號。 */
    count: number;
    /** 圖塊、佔格數、編號三者都對得起來的特殊地點（依編號排序）。 */
    confirmed: SpecialBlock[];
    /** 圖塊是完整 2x2 連號，四格卻不同屬一個有效編號。 */
    unconfirmed: SpecialBlockIssue[];
    /** 編號沒問題，但 SPECIAL 欄位跟圖塊畫的種類不一樣。 */
    kindMismatch: { id: number; field: number; tile: number }[];
    /** 圖塊落在特殊區(40~83)、卻不屬於任何完整 2x2 的格子（半個特殊地點）。 */
    strayCells: number[];
    /** 佔了 2x2 四格、圖塊卻不是連號特殊圖塊的低編號（引擎不見得認得）。 */
    cellsOnly: number[];
}

/**
 * 全圖特殊地點掃描：以圖塊為身分依據，再用佔格數與 SPECIAL 欄位交叉驗證。
 * dv 省略時只驗圖塊與格子，不查 SPECIAL 欄位。
 */
export function scanSpecials(
    grid: Uint16Array, layout: Uint16Array, dv?: DataView | null, boundary = 49,
): SpecialScan {
    const blocks = findSpecialBlocks(grid, layout);
    const cellMap = buildCellMap(grid);
    const confirmed: SpecialBlock[] = [];
    const unconfirmed: SpecialBlockIssue[] = [];
    const kindMismatch: { id: number; field: number; tile: number }[] = [];

    for (const b of blocks) {
        if (b.locId < 0) {
            // 四格不同號。若其中剛好只有一個有效的特殊編號，那就是它 —— 圖塊已經證明
            // 這四格是同一個地點，其餘的 0 或雜號是編輯過程留下的。
            const cands = b.ids.filter(v => v > 0 && v <= boundary);
            unconfirmed.push({
                block: b,
                why: b.ids.every(v => v === 0) ? '四格都還沒有地點編號' : `四格分屬地點 ${b.ids.join('、')}`,
                fixId: cands.length === 1 ? cands[0] : -1,
            });
            continue;
        }
        if (b.locId > boundary) {
            unconfirmed.push({
                block: b, fixId: -1,
                why: `四格都是地點 ${b.locId}，但 ${b.locId} > ${boundary} 不在特殊分區`,
            });
            continue;
        }
        // 同一個編號若還有第五格散在別處，這個區塊就不算數（引擎的特殊地點剛好佔 4 格）
        const cells = cellMap.get(b.locId);
        if (!cells || cells.length !== 4) {
            unconfirmed.push({
                block: b, fixId: -1,
                why: `地點 ${b.locId} 在 grid 上佔 ${cells ? cells.length : 0} 格，特殊地點必須剛好 4 格`,
            });
            continue;
        }
        confirmed.push(b);
        if (dv) {
            const field = getF(dv, LOC_FIELDS.SPECIAL, b.locId);
            if (field !== b.kind) kindMismatch.push({ id: b.locId, field, tile: b.kind });
        }
    }
    confirmed.sort((a, b) => a.locId - b.locId);

    const inBlock = new Set<number>();
    for (const b of blocks) for (const c of b.cells) inBlock.add(c);
    const strayCells: number[] = [];
    for (let i = 0; i < layout.length; i++) {
        if (specialKindOfTile(layout[i]) >= 0 && !inBlock.has(i)) strayCells.push(i);
    }

    const ok = new Set(confirmed.map(b => b.locId));
    const cellsOnly: number[] = [];
    for (const [id, cells] of cellMap) {
        if (id > 0 && id <= boundary && cells.length === 4 && !ok.has(id)) cellsOnly.push(id);
    }
    cellsOnly.sort((a, b) => a - b);

    let count = 0;
    for (const b of confirmed) if (b.locId > count) count = b.locId;
    return { count, confirmed, unconfirmed, kindMismatch, strayCells, cellsOnly };
}

/**
 * 把一個 2x2 特殊區塊的四格統一成同一個 locId，並把受影響的地點座標重新同步。
 * 前提是圖塊已經確認過這四格是同一個特殊地點。
 */
export function unifySpecialBlock(grid: Uint16Array, dv: DataView, block: SpecialBlock, id: number): void {
    const touched = new Set<number>([id]);
    for (const c of block.cells) { if (grid[c] > 0) touched.add(grid[c]); grid[c] = id; }
    const cm = buildCellMap(grid);
    for (const t of touched) {
        const cells = cm.get(t);
        if (!cells || t > MAX_LOC_ID) continue;
        const { x, y } = topLeft(cells);
        setF(dv, LOC_FIELDS.X, t, x);
        setF(dv, LOC_FIELDS.Y, t, y);
    }
}

// ============================================================================
// 海上道路
// ----------------------------------------------------------------------------
// 海上道路跟陸上的一般道路不是同一種東西：它們是海面上的航路，只佔一格、沒有地段、
// 也不是特殊地點，而且**編號緊接在特殊地點之後**（原版台灣＝特殊 1~23、海路 24~39）。
//
// 這個「緊接著」是硬性的：引擎用 [0x1098] 當界，1~N 全部會被當成特殊地點。
// 所以特殊地點一增加，整段海路就得**一起往後挪**，中間不能留空號，也不能只把
// 擋路的那一條搬到別的地方 —— 那會讓編號順序跟原版對不上。
//
// 方向指標不必自己算：renameLocation 會把所有指向舊編號的指標一起改，
// 所以海路之間的連接會跟著位移，而頭尾接到土地/特殊地點的那兩條自然不會被動到。
// ============================================================================

/** 海上道路能用的最大編號。51 以上引擎當成土地，所以海路只能待在 ≤50。 */
export const SEA_ROAD_ID_MAX = 50;

/** 連號的一串編號縮寫成 24~39，不連號就照列。 */
export function fmtRange(ids: number[]): string {
    if (ids.length === 0) return '（無）';
    if (ids.length > 2 && ids.every((v, i) => i === 0 || v === ids[i - 1] + 1)) {
        return `${ids[0]}~${ids[ids.length - 1]}`;
    }
    return ids.join('、');
}

export interface SeaRoadScan {
    /** 目前在用的海上道路編號（由小到大）。 */
    ids: number[];
    /** 依規則它們該用的編號（緊接在特殊地點之後、連號）。 */
    want: number[];
    /** 特殊地點數 —— 海路要從這個號碼 +1 開始。 */
    specialCount: number;
    /** 編號 ≤50、不是確認過的特殊地點、卻佔了不只一格的東西（不當成海路，也不動它）。 */
    odd: number[];
    ok: boolean;
    error?: string;
}

/**
 * 掃出海上道路：編號 ≤50、不是確認過的特殊地點、而且**只佔一格**的地點。
 * 「只佔一格」這個條件是保險 —— 圖塊沒排好的 2x2 特殊地點會落在這個範圍裡，
 * 但它不是海路，不該被重編號，所以另外列進 odd 讓警告頁去講。
 */
export function scanSeaRoads(
    grid: Uint16Array, layout: Uint16Array, dv: DataView, boundary = 49, startAt?: number,
): SeaRoadScan {
    const sp = scanSpecials(grid, layout, dv, boundary);
    const isSpecial = new Set(sp.confirmed.map(b => b.locId));
    const ids: number[] = [], odd: number[] = [];
    for (const [id, cells] of buildCellMap(grid)) {
        if (id <= 0 || id > SEA_ROAD_ID_MAX || isSpecial.has(id)) continue;
        (cells.length === 1 ? ids : odd).push(id);
    }
    ids.sort((a, b) => a - b);
    odd.sort((a, b) => a - b);

    const from = startAt ?? sp.count + 1;
    const want = ids.map((_, i) => from + i);
    const last = want.length > 0 ? want[want.length - 1] : 0;
    return {
        ids, want, odd, specialCount: sp.count,
        ok: ids.length === want.length && ids.every((v, i) => v === want[i]),
        error: last > SEA_ROAD_ID_MAX
            ? `海上道路有 ${ids.length} 條，從 ${from} 排下去會排到 ${last}，超過上限 ${SEA_ROAD_ID_MAX}`
            : undefined,
    };
}

export interface SeaRoadRepair {
    ok: boolean;
    error?: string;
    moved: { from: number; to: number }[];
}

/**
 * 把海上道路整段重編成「緊接在特殊地點之後的連號」。
 * startAt 可指定起始編號（`placeSpecial` 用它把整段往後推一格，空出新特殊地點要的號碼）。
 *
 * 搬家順序用貪心：每次挑一個目標編號目前是空的來搬。海路是保序位移，
 * 往上挪時最大的那條一定先空得出來、往下挪時最小的那條一定先空得出來，所以不會卡住。
 */
export function repairSeaRoads(
    grid: Uint16Array, layout: Uint16Array, dv: DataView, boundary = 49, startAt?: number,
): SeaRoadRepair {
    const scan = scanSeaRoads(grid, layout, dv, boundary, startAt);
    if (scan.error) return { ok: false, error: scan.error, moved: [] };

    const pending = scan.ids
        .map((from, i) => ({ from, to: scan.want[i] }))
        .filter(m => m.from !== m.to);
    const moved: { from: number; to: number }[] = [];

    let guard = pending.length * 2 + 4;
    while (pending.length > 0 && guard-- > 0) {
        const i = pending.findIndex(m => !locIdInUse(grid, dv, m.to));
        if (i < 0) break;
        const m = pending.splice(i, 1)[0];
        if (!renameLocation(grid, dv, m.from, m.to)) {
            return { ok: false, error: `把海上道路 ${m.from} 改成 ${m.to} 失敗`, moved };
        }
        moved.push(m);
    }
    if (pending.length > 0) {
        return {
            ok: false, moved,
            error: `海上道路 ${pending.map(m => m.from).join('、')} 要換的編號被別的地點佔著，搬不過去`,
        };
    }
    return { ok: true, moved };
}

export interface PlaceSpecialResult {
    ok: boolean;
    /** 'new'＝開了一個新的特殊地點；'kind'＝換既有那個的種類；'none'＝什麼都沒做。 */
    mode: 'new' | 'kind' | 'none';
    error?: string;
    locId?: number;
    /** 換種類時的原種類。 */
    kindFrom?: number;
    /** 為了空出新編號，整段往後挪的海上道路。 */
    seaMoved?: { from: number; to: number }[];
    /** 新地點自動接到的方向。 */
    wired?: { dir: string; tgt: number }[];
}

/** 這個地點編號有沒有被用（grid 上有格子，或記錄非空）。 */
function locIdInUse(grid: Uint16Array, dv: DataView, id: number): boolean {
    return isActive(dv, id) || buildCellMap(grid).has(id);
}

/**
 * 貼一個特殊地點（整組 2x2）。純資料操作，UI 只負責把結果講給使用者聽。
 *
 * anchor 落在既有特殊地點上＝換種類（圖塊與 SPECIAL 欄位一起換，不讓兩邊分家）；
 * 落在空地上＝新增一個，四格圖塊、編號、X/Y、SPECIAL、地段=0、方向都一次配好。
 * UNKA/UNKB 只填非 0 佔位值，正式的路由由呼叫端的 `recomputeRouting(forceIds:[locId])` 算。
 */
export function placeSpecial(
    grid: Uint16Array, layout: Uint16Array, dv: DataView, anchor: number, kind: number, boundary = 49,
): PlaceSpecialResult {
    if (kind < 0 || kind >= SPECIAL_KIND_COUNT) {
        return { ok: false, mode: 'none', error: `特殊種類 ${kind} 不存在（只有 0~${SPECIAL_KIND_COUNT - 1}）` };
    }
    if (anchor < 0 || anchor >= GRID_COLS * GRID_ROWS) {
        return { ok: false, mode: 'none', error: '沒有選到格子' };
    }
    const tiles = specialTilesOfKind(kind);
    const sc = scanSpecials(grid, layout, dv, boundary);

    // (A) 點在既有特殊地點上 → 換種類
    const cur = sc.confirmed.find(b => b.cells.includes(anchor));
    if (cur) {
        if (cur.kind === kind) {
            return { ok: false, mode: 'none', locId: cur.locId, error: `地點 ${cur.locId} 已經是這個種類了` };
        }
        cur.cells.forEach((ci, i) => { layout[ci] = tiles[i]; });
        setF(dv, LOC_FIELDS.SPECIAL, cur.locId, kind);
        return { ok: true, mode: 'kind', locId: cur.locId, kindFrom: cur.kind };
    }

    // (B) 空地上開一個新的，以 anchor 為左上角
    const gx = anchor % GRID_COLS, gy = Math.floor(anchor / GRID_COLS);
    if (gx > GRID_COLS - 2 || gy > GRID_ROWS - 2) {
        return { ok: false, mode: 'none', error: '特殊地點要 2x2，這格已經貼到右緣或下緣了，請往左上挪一格' };
    }
    const cells = [anchor, anchor + 1, anchor + GRID_COLS, anchor + GRID_COLS + 1];
    const inWay = [...new Set(cells.map(ci => grid[ci]).filter(v => v > 0))].sort((a, b) => a - b);
    if (inWay.length > 0) {
        return {
            ok: false, mode: 'none',
            error: `這 2x2 已經被地點 ${inWay.join('、')} 佔著；特殊地點要獨佔四格，請先把它們的編號清成 0，或換個位置`,
        };
    }

    // 引擎用 [0x1098] 當界，1~N 全部會被當成特殊地點，所以新的一定要接在最後一個之後。
    const newId = sc.count + 1;
    if (newId > boundary) {
        return { ok: false, mode: 'none', error: `特殊地點編號已經用到上限 ${boundary}，加不下去了` };
    }

    // 新編號通常正被海上道路的第一條佔著（海路緊接在特殊地點之後）。
    // 把**整段海路往後挪一格**空出來 —— 不是把擋路的那條搬去別的空號，
    // 那樣編號順序就跟原版對不上了。
    let seaMoved: { from: number; to: number }[] | undefined;
    if (locIdInUse(grid, dv, newId)) {
        const rep = repairSeaRoads(grid, layout, dv, boundary, newId + 1);
        if (!rep.ok) {
            return { ok: false, mode: 'none', error: `編號 ${newId} 要空出來給新的特殊地點，但海上道路挪不動：${rep.error}` };
        }
        seaMoved = rep.moved;
        if (locIdInUse(grid, dv, newId)) {
            return { ok: false, mode: 'none', error: `編號 ${newId} 被既有地點佔著，而且它不是海上道路，沒辦法自動讓位` };
        }
    }

    cells.forEach((ci, i) => { grid[ci] = newId; layout[ci] = tiles[i]; });
    setF(dv, LOC_FIELDS.X, newId, gx);
    setF(dv, LOC_FIELDS.Y, newId, gy);
    setF(dv, LOC_FIELDS.SPECIAL, newId, kind);
    setF(dv, LOC_FIELDS.SEGMENT, newId, 0);   // 特殊地點沒有地段，也沒有價格
    setF(dv, LOC_FIELDS.UNK9, newId, 0);
    setF(dv, LOC_FIELDS.UNK3, newId, 0);
    setF(dv, LOC_FIELDS.OWNER, newId, 0);
    setF(dv, LOC_FIELDS.RESERVE, newId, 0);
    setF(dv, LOC_FIELDS.HOUSE, newId, 0);
    // UNKA/UNKB 先填非 0 佔位——0 會被當成監獄/醫院入口格，重算才不會誤判
    setF(dv, LOC_FIELDS.UNKA, newId, 1);
    setF(dv, LOC_FIELDS.UNKB, newId, 1);

    const wired = wireDirectionsFromGrid(grid, dv, newId);
    return { ok: true, mode: 'new', locId: newId, seaMoved, wired };
}

export interface IntegrityOptions {
    priceDv?: DataView | null;
    /** DSK 的圖塊層。給了才會做特殊地點的圖塊確認。 */
    layout?: Uint16Array | null;
    /** 種類編號 → 名稱（來自 PAK 文字，例如 3→「卡片」）。純粹讓訊息好讀。 */
    specialName?: (kind: number) => string;
}

/**
 * 全圖完整性掃描。
 * boundary = 特殊/道路分界編號（= 引擎 [0x1098]，台灣23/香港27/城40）。
 * 只讀不改；每個可安全修復的 issue 會附帶 fix()。
 */
export function analyzeIntegrity(grid: Uint16Array, dv: DataView, boundary: number, opts: IntegrityOptions = {}): IntegrityIssue[] {
    const issues: IntegrityIssue[] = [];
    const priceDv = opts.priceDv;
    const kindName = opts.specialName ?? ((k: number) => `種類 ${k}`);
    const cellMap = buildCellMap(grid);
    const onGrid = (id: number) => cellMap.has(id);

    // active 但不在 grid（排除 +950 購地標記，它們不進 loc 陣列）
    for (let id = 1; id < LOC_COUNT; id++) {
        if (!isActive(dv, id)) continue;
        if (onGrid(id)) continue;
        if (id > 950) continue;
        issues.push({
            kind: 'orphan-record', locId: id,
            detail: `地點 ${id} 有資料但 grid 上找不到任何格子（孤兒記錄）`,
            fix: () => { for (const f of Object.values(LOC_FIELDS)) setF(dv, f as number, id, 0); },
        });
    }

    // 重複座標
    const coordOwner = new Map<string, number>();
    for (const [id, cells] of cellMap) {
        if (id > 950) continue;
        const { x, y } = topLeft(cells);
        const key = x + ',' + y;
        const prev = coordOwner.get(key);
        if (prev !== undefined) {
            issues.push({ kind: 'dup-coord', locId: id, detail: `地點 ${id} 與地點 ${prev} 共用座標 (${x},${y})` });
        } else coordOwner.set(key, id);
    }

    for (const [id, cells] of cellMap) {
        if (id > 950) continue;
        const { x, y } = topLeft(cells);

        // 座標不符
        const rx = getF(dv, LOC_FIELDS.X, id), ry = getF(dv, LOC_FIELDS.Y, id);
        if (rx !== x || ry !== y) {
            issues.push({
                kind: 'coord-mismatch', locId: id,
                detail: `地點 ${id} 記錄座標 (${rx},${ry}) 與 grid 左上角 (${x},${y}) 不符`,
                fix: () => { setF(dv, LOC_FIELDS.X, id, x); setF(dv, LOC_FIELDS.Y, id, y); },
            });
        }

        // 分區檢查（特殊 = 編號 1..boundary 含界；道路/土地 = boundary+1..）
        const sp = getF(dv, LOC_FIELDS.SPECIAL, id);
        const seg = getF(dv, LOC_FIELDS.SEGMENT, id);
        if (id > boundary && sp > 0) {
            issues.push({
                kind: 'partition', locId: id,
                detail: `地點 ${id} > 分界 ${boundary} 卻設了特殊種類 ${sp}；引擎會把它當道路/土地，踩上去會出錯`,
            });
        }
        if (id <= boundary && seg > 0) {
            issues.push({
                kind: 'partition', locId: id,
                detail: `地點 ${id} ≤ 分界 ${boundary}（特殊區）卻設了地段 ${seg}`,
            });
        }

        // 土地編號一定要有地段：實測三張原版圖「編號 ≥51 ⟺ 有地段」零例外。
        // 貼了土地圖塊、配到編號卻沒選地段，遊戲裡會變成買不了、也沒有價格的死格。
        if (id >= LAND_ID_START && seg === 0) {
            issues.push({
                kind: 'land-no-segment', locId: id,
                detail: `土地 ${id} 還沒設定地段 → 買不了也沒有價格，請在編輯面板的「地段」欄選一個`,
            });
        }

        // 懸空指標：某方向指到一個不在 grid 上的編號（會讓移動引擎走進幽靈地點）
        let dirCount = 0;
        for (const d of DIRS) {
            const tgt = getF(dv, d.field, id);
            if (tgt === 0) continue;
            dirCount++;
            if (!onGrid(tgt)) {
                issues.push({ kind: 'dangling-ref', locId: id, detail: `地點 ${id} 往${d.name}→${tgt}，但 ${tgt} 不在 grid 上（幽靈地點）` });
            }
        }

        // 死胡同：路徑地點(≤282)的方向連結 < 2，玩家會走不進/走不出而卡住
        if (id <= MAX_LOC_ID && dirCount < 2) {
            issues.push({ kind: 'dead-end', locId: id, detail: `地點 ${id} 只有 ${dirCount} 個方向連結（需 ≥2），玩家會卡住` });
        }

        // 土地買價為 0：可能造成引擎除以 0
        if (priceDv && seg > 0 && seg < PRICE_SEG_COUNT) {
            const basePrice = priceDv.getUint16(seg * 2, true); // 欄位0=土地價格，offset 0
            if (basePrice === 0) {
                issues.push({ kind: 'zero-price', locId: id, detail: `地點 ${id} 的地段 ${seg} 土地買價為 0` });
            }
        }
    }

    // 地段序號：同地段的地點，依 locId 由小到大應該是 1,2,3…（三張原版圖 85/85 皆如此）。
    // 號碼錯亂或重複會讓遊戲裡的地段顯示出問題。
    {
        const bySeg = new Map<number, number[]>();
        for (const [id] of cellMap) {
            if (id <= 0 || id > MAX_LOC_ID) continue;
            const seg = getF(dv, LOC_FIELDS.SEGMENT, id);
            if (seg <= 0) continue;
            let a = bySeg.get(seg); if (!a) { a = []; bySeg.set(seg, a); }
            a.push(id);
        }
        for (const [seg, members] of bySeg) {
            members.sort((a, b) => a - b);
            const wrong = members.filter((id, i) => getF(dv, LOC_FIELDS.UNK9, id) !== i + 1);
            if (wrong.length === 0) continue;
            const got = members.map(id => getF(dv, LOC_FIELDS.UNK9, id)).join(',');
            issues.push({
                kind: 'segment-order', locId: wrong[0],
                detail: `地段 ${seg} 的序號應為 1~${members.length}（依地點編號 ${members.join(',')} 排序），實際是 ${got}`,
                fix: () => { renumberSegment(grid, dv, seg); },
            });
        }
    }

    // 路由入口格：全圖應該剛好各有一個 UNKA=0（監獄入口）與 UNKB=0（醫院入口），
    // 三張原版圖皆如此。多出來的幾乎都是「手動配了新編號但沒設路由」的格子 ——
    // 那格會被誤認成入口，警車/救護車的接力鏈走到它就結束了。
    for (const [field, name, what] of [
        [LOC_FIELDS.UNKA, 'UNKA', '監獄'],
        [LOC_FIELDS.UNKB, 'UNKB', '醫院'],
    ] as const) {
        const zeros: number[] = [];
        for (const [id] of cellMap) {
            if (id <= 0 || id > MAX_LOC_ID) continue;
            if (getF(dv, field, id) === 0) zeros.push(id);
        }
        zeros.sort((a, b) => a - b);
        if (zeros.length === 0) {
            issues.push({
                kind: 'route-entry', locId: 0,
                detail: `找不到往${what}的入口格（沒有任何地點的 ${name}=0），警車/救護車路由無法運作`,
            });
        } else if (zeros.length > 1) {
            const keep = zeros.find(id => id <= boundary) ?? zeros[0];
            for (const id of zeros) {
                if (id === keep) continue;
                issues.push({
                    kind: 'route-entry', locId: id,
                    detail: `地點 ${id} 的 ${name}=0，但全圖只該有一個往${what}的入口格（${keep}）；` +
                        `這格的路由沒設定，警車/救護車走到這裡會斷掉。按「修復路由」可自動補上`,
                });
            }
        }
    }

    // 特殊地點：圖塊排成完整 2x2 連號，就代表這四格是同一個特殊地點。
    // 以它為準去對編號、佔格數與 SPECIAL 欄位，比舊的「數格子」判準準得多。
    if (opts.layout) {
        const sc = scanSpecials(grid, opts.layout, dv, boundary);
        for (const u of sc.unconfirmed) {
            const b = u.block;
            const tiles = specialTilesOfKind(b.kind);
            const head = `(${b.x},${b.y}) 的圖塊 ${tiles[0]}~${tiles[3]} 是完整的 2x2「${kindName(b.kind)}」，四格應該同屬一個地點編號`;
            issues.push({
                kind: 'special-block',
                locId: u.fixId > 0 ? u.fixId : 0,
                detail: u.fixId > 0
                    ? `${head}，但${u.why} → 可自動統一成 ${u.fixId}`
                    : `${head}，但${u.why} → 請手動決定要用哪個編號`,
                fix: u.fixId > 0 ? () => { unifySpecialBlock(grid, dv, b, u.fixId); } : undefined,
            });
        }
        for (const k of sc.kindMismatch) {
            issues.push({
                kind: 'special-kind', locId: k.id,
                detail: `地點 ${k.id} 的圖塊畫的是「${kindName(k.tile)}」(${k.tile})，SPECIAL 欄位卻是「${kindName(k.field)}」(${k.field})；` +
                    `玩家看到的是圖塊、實際觸發的是欄位，兩邊要一致`,
            });
        }
        if (sc.strayCells.length > 0) {
            const at = sc.strayCells.slice(0, 8).map(i => `(${i % GRID_COLS},${Math.floor(i / GRID_COLS)})`).join('、');
            issues.push({
                kind: 'special-tile', locId: 0,
                detail: `有 ${sc.strayCells.length} 格用了特殊地點的圖塊，卻沒排成完整的 2x2 連號四格：${at}` +
                    (sc.strayCells.length > 8 ? ' …' : '') + '　（半個特殊地點，畫面會缺角）',
            });
        }
        for (const id of sc.cellsOnly) {
            issues.push({
                kind: 'special-tile', locId: id,
                detail: `地點 ${id} 佔了 2x2 四格，但圖塊不是任何一種特殊地點的連號四塊 → 確認不了它是哪種特殊地點`,
            });
        }

        // 海上道路必須緊接在特殊地點之後、連號排下去
        const sea = scanSeaRoads(grid, opts.layout, dv, boundary);
        if (sea.error) {
            issues.push({ kind: 'sea-road', locId: sea.ids[0] ?? 0, detail: sea.error });
        } else if (!sea.ok && sea.ids.length > 0) {
            const wrong = sea.ids.filter((v, i) => v !== sea.want[i]);
            issues.push({
                kind: 'sea-road', locId: wrong[0] ?? sea.ids[0],
                detail: `海上道路目前是 ${fmtRange(sea.ids)}，但特殊地點有 ${sea.specialCount} 個，` +
                    `海路應該是 ${fmtRange(sea.want)}（緊接在特殊地點之後、連號）。` +
                    `落在 1~${sea.specialCount} 之內的會被引擎當成特殊地點，玩家踩上去可能當機。按「修復海路」整段重編`,
                fix: () => { repairSeaRoads(grid, opts.layout!, dv, boundary); },
            });
        }
        for (const id of sea.odd) {
            issues.push({
                kind: 'sea-road', locId: id,
                detail: `地點 ${id} 的編號在海上道路的範圍（≤${SEA_ROAD_ID_MAX}），卻佔了不只一格 —— ` +
                    `它不是海路（海路只佔一格），「修復海路」不會動它，請先確認它是什麼`,
            });
        }
    }

    return issues;
}

/** 套用所有可自動修復的 issue，回傳修好的數量。 */
export function repairMap(
    grid: Uint16Array, dv: DataView, boundary: number, opts: IntegrityOptions = {},
): { fixed: number; remaining: IntegrityIssue[] } {
    let fixed = 0;
    // 反覆跑到收斂（修一輪可能揭露/消除其他 issue）
    for (let pass = 0; pass < 4; pass++) {
        const issues = analyzeIntegrity(grid, dv, boundary, opts);
        const fixable = issues.filter(i => i.fix);
        if (fixable.length === 0) break;
        for (const i of fixable) { i.fix!(); fixed++; }
    }
    return { fixed, remaining: analyzeIntegrity(grid, dv, boundary, opts) };
}

/**
 * 正確地把整個地點從 oldId 重編號成 newId：
 * grid 格子、記錄、所有指向它的方向指標一起搬，清掉舊記錄，重算座標。
 * 這是「移動/改編號」該有的原子操作（取代目前只改單格的做法）。
 */
export function renameLocation(grid: Uint16Array, dv: DataView, oldId: number, newId: number): boolean {
    if (oldId <= 0 || newId <= 0 || oldId === newId) return false;
    if (isActive(dv, newId) || buildCellMap(grid).has(newId)) return false; // 目標必須是空的

    // 1) grid 格子
    for (let i = 0; i < grid.length; i++) if (grid[i] === oldId) grid[i] = newId;
    // 2) 複製記錄
    for (const f of Object.values(LOC_FIELDS)) setF(dv, f as number, newId, getF(dv, f as number, oldId));
    // 3) 所有指向 oldId 的方向指標改指 newId
    for (let id = 1; id < LOC_COUNT; id++) {
        for (const d of DIRS) if (getF(dv, d.field, id) === oldId) setF(dv, d.field, id, newId);
    }
    // 4) 清掉舊記錄
    for (const f of Object.values(LOC_FIELDS)) setF(dv, f as number, oldId, 0);
    // 5) 座標同步
    const cells = buildCellMap(grid).get(newId);
    if (cells) { const { x, y } = topLeft(cells); setF(dv, LOC_FIELDS.X, newId, x); setF(dv, LOC_FIELDS.Y, newId, y); }
    return true;
}

export interface DeleteReport {
    locId: number;
    /** 被清成 0 的 grid 格 index（含 +950 購地標記格） */
    cells: number[];
    /** 一併清掉的購地標記編號（土地才有） */
    markerId: number;
    /** 被清掉的方向指標：誰的哪個方向本來指著它 */
    clearedRefs: { id: number; dir: string }[];
    /** 它原本所屬的地段（呼叫端拿去 renumberSegment；0＝沒有地段） */
    segId: number;
}

/**
 * 把一個地點整個刪掉：grid 格、購地標記格、記錄、以及**所有指向它的方向指標**。
 *
 * 少了最後一步就會留下 dangling ref —— 引擎照著方向走會跳到一筆全 0 的記錄，
 * 那正是 analyzeIntegrity 的 `dangling-ref` 在抓的東西。單純把 grid 格改成 0
 * （編輯器原本唯一的「刪除」方式）只清掉了畫面，資料全部留在原地。
 *
 * 不負責重編地段序號與重算路由 —— 那兩件事要在所有刪除都做完之後再一次做，
 * 否則每刪一格就重算一次，中間狀態還會互相干擾。回傳的 `segId` 就是給呼叫端收尾用的。
 */
export function deleteLocation(grid: Uint16Array, dv: DataView, locId: number): DeleteReport | null {
    if (locId <= 0 || locId >= LOC_COUNT) return null;
    const rep: DeleteReport = {
        locId, cells: [], markerId: 0, clearedRefs: [],
        segId: getF(dv, LOC_FIELDS.SEGMENT, locId),
    };

    // 1) grid：本體的格子（特殊地點是 2x2，所以可能不只一格）
    for (let i = 0; i < grid.length; i++) if (grid[i] === locId) { grid[i] = 0; rep.cells.push(i); }

    // 2) grid：它的購地標記格（土地才有；標記編號不進 loc 記錄，只存在 grid 裡）
    const markerId = locId + MARKER_ID_OFFSET;
    for (let i = 0; i < grid.length; i++) if (grid[i] === markerId) {
        grid[i] = 0; rep.cells.push(i); rep.markerId = markerId;
    }

    // 3) 別人指向它的方向指標
    for (let id = 1; id < LOC_COUNT; id++) {
        if (id === locId) continue;
        for (const d of DIRS) {
            if (getF(dv, d.field, id) === locId) {
                setF(dv, d.field, id, 0);
                rep.clearedRefs.push({ id, dir: d.name });
            }
        }
    }

    // 4) 記錄整筆歸 0（含未使用的保留欄位，不留半筆殘值）
    for (const f of Object.values(LOC_FIELDS)) setF(dv, f as number, locId, 0);

    return rep;
}

// 原版三張圖的土地一律從 51 起編，40~50 這段整段刻意不用（台灣/香港缺 40-50、城缺 41-50）。
// 為免踩到引擎可能對 50 以下另有處理的地雷，配號一律從 51 開始。
export const LAND_ID_START = 51;

/** 某編號是否完全沒被用（記錄空、grid 空、標記槽 +950 也空）。 */
function isFreeLandId(cm: Map<number, number[]>, dv: DataView, id: number): boolean {
    return !isActive(dv, id) && !cm.has(id) && !cm.has(id + MARKER_ID_OFFSET);
}

/** 在道路/土地分區 (51..maxLoc) 找一個自由編號（由小到大補空號）。找不到回 -1。 */
export function findFreeLandId(grid: Uint16Array, dv: DataView, boundary: number, maxLoc: number = MAX_LOC_ID): number {
    const cm = buildCellMap(grid);
    for (let id = Math.max(boundary + 1, LAND_ID_START); id <= maxLoc; id++) {
        if (isFreeLandId(cm, dv, id)) return id;
    }
    return -1;
}

/**
 * 下一個土地編號：從「目前最大編號 + 1」開始配，接續在既有編號之後。
 * 配到上限才回頭撿中間的空號（findFreeLandId）。找不到回 -1。
 */
export function nextLandId(grid: Uint16Array, dv: DataView, boundary: number = 49, maxLoc: number = MAX_LOC_ID): number {
    const cm = buildCellMap(grid);
    let max = 0;
    for (const [id] of cm) if (id > 0 && id <= maxLoc && id > max) max = id;
    for (let id = 1; id <= maxLoc; id++) if (isActive(dv, id) && id > max) max = id;
    for (let id = Math.max(max + 1, LAND_ID_START); id <= maxLoc; id++) {
        if (isFreeLandId(cm, dv, id)) return id;
    }
    return findFreeLandId(grid, dv, boundary, maxLoc);
}

/**
 * 重新編排某地段所有地點的「地段序號」(UNK9)：**依 locId 由小到大給 1,2,3…**
 * 三張原版圖共 85 個地段全部遵守這個規則，零例外。
 * 回傳被改動的地點編號。
 *
 * 註：不能用「數一數同地段有幾個再 +1」——那等於永遠給最後一號，
 * 新增的編號若不是最大的就會給錯，重設既有成員還會撞號。
 */
export function renumberSegment(grid: Uint16Array, dv: DataView, segId: number): number[] {
    if (segId <= 0) return [];
    const members: number[] = [];
    for (const [id] of buildCellMap(grid)) {
        if (id <= 0 || id > MAX_LOC_ID) continue;
        if (getF(dv, LOC_FIELDS.SEGMENT, id) === segId) members.push(id);
    }
    members.sort((a, b) => a - b);
    const changed: number[] = [];
    members.forEach((id, i) => {
        if (getF(dv, LOC_FIELDS.UNK9, id) !== i + 1) {
            setF(dv, LOC_FIELDS.UNK9, id, i + 1);
            changed.push(id);
        }
    });
    return changed;
}

export interface MarkerBaseResult {
    base: number;        // 該用哪個土地的編號當 base（-1 = 找不到）
    free: number[];      // 相鄰、且 +950 槽還空著的土地
    taken: number[];     // 相鄰、但 +950 已經被別的格子佔走的土地
    self: number;        // 這格目前已經是某個 base 的標記（-1 = 否）
}

/**
 * 幫一格「購地標記」找它該屬於哪塊土地。
 * 規則：掃四鄰的土地格(編號 ≥51)，排除 +950 槽已被別的格子佔走的，
 * 剩下的優先取 preferred（剛新增的那塊），否則取編號最大的（新增的地編號一定最大）。
 */
export function findMarkerBase(
    grid: Uint16Array, gx: number, gy: number, preferred: number = -1, maxLoc: number = MAX_LOC_ID,
): MarkerBaseResult {
    const cm = buildCellMap(grid);
    const here = gy * GRID_COLS + gx;
    const free: number[] = [], taken: number[] = [];
    let self = -1;

    for (const d of DIRS) {
        const nx = gx + d.dx, ny = gy + d.dy;
        if (nx < 0 || nx >= GRID_COLS || ny < 0 || ny >= GRID_ROWS) continue;
        const id = grid[ny * GRID_COLS + nx];
        if (id < LAND_ID_START || id > maxLoc) continue;      // 只有土地分區的編號能當 base
        if (free.includes(id) || taken.includes(id)) continue;

        const cells = cm.get(id + MARKER_ID_OFFSET);
        if (!cells) { free.push(id); continue; }
        // 標記已存在：若就是這一格，代表本來就配好了，不算被佔走
        if (cells.length === 1 && cells[0] === here) { self = id; free.push(id); }
        else taken.push(id);
    }

    let base = -1;
    if (self >= 0) base = self;
    else if (free.length > 0) base = free.includes(preferred) ? preferred : Math.max(...free);
    return { base, free, taken, self };
}

// ============================================================================
// UNKA / UNKB 路由重算
// ----------------------------------------------------------------------------
// UNKA = 該格「往監獄走的下一步方向」，UNKB = 「往醫院走的下一步方向」（代碼 1左2上3右4下）。
// 警車載去監獄、救護車載去醫院、出獄/出院的位移都走這兩張表。全圖唯一 UNKA=0 的格子
// 就是監獄入口格、唯一 UNKB=0 的就是醫院入口格（監獄/醫院本身是 exe 寫死的位置，
// 地圖上只是底圖，不是特殊種類）。
//
// 新增土地若這兩欄沒指對，警車/救護車經過它就會亂走 —— 這是「特殊移動 bug」的根因。
// 修法：以入口格為起點做反向 BFS，算出每格往入口的最短路第一步。
// ============================================================================

/** 路由起點候選。正常地圖各只會有一個。 */
export function findRoutingEntries(grid: Uint16Array, dv: DataView): { jail: number[]; hospital: number[] } {
    const jail: number[] = [], hospital: number[] = [];
    for (const [id] of buildCellMap(grid)) {
        if (id <= 0 || id > MAX_LOC_ID) continue;   // >950 的購地標記不參與路由
        if (getF(dv, LOC_FIELDS.UNKA, id) === 0) jail.push(id);
        if (getF(dv, LOC_FIELDS.UNKB, id) === 0) hospital.push(id);
    }
    jail.sort((a, b) => a - b);
    hospital.sort((a, b) => a - b);
    return { jail, hospital };
}

/**
 * 從候選中挑真正的入口格：入口格一定在特殊分區（編號 ≤ boundary，如台灣監獄入口 id13、醫院 id20），
 * 新增土地誤觸的 0 值編號都 > boundary，所以優先取特殊分區內最小的編號。
 */
function pickEntry(cands: number[], boundary: number): number {
    if (cands.length === 0) return -1;
    const inSpecial = cands.filter(id => id <= boundary);
    return (inSpecial.length > 0 ? inSpecial : cands)[0];
}

/** 反向 BFS：算出每格「往 entry 走的下一步方向代碼」與到 entry 的步數。 */
function routeToward(grid: Uint16Array, dv: DataView, entry: number): { dir: Map<number, number>; dist: Map<number, number> } {
    const nodes: number[] = [];
    for (const [id] of buildCellMap(grid)) if (id > 0 && id <= MAX_LOC_ID) nodes.push(id);
    const onGrid = new Set(nodes);

    // 反向鄰接表：rev[T] = [{from, code}]，代表 from 往 code 方向會走到 T
    const rev = new Map<number, { from: number; code: number }[]>();
    for (const id of nodes) {
        for (const d of DIRS) {
            const t = getF(dv, d.field, id);
            if (t === 0 || !onGrid.has(t)) continue;   // 懸空指標略過（由 dangling-ref 檢查負責）
            let a = rev.get(t); if (!a) { a = []; rev.set(t, a); }
            a.push({ from: id, code: d.code });
        }
    }

    const dist = new Map<number, number>(), dir = new Map<number, number>();
    if (!onGrid.has(entry)) return { dir, dist };
    dist.set(entry, 0); dir.set(entry, 0);
    const q = [entry];
    for (let qi = 0; qi < q.length; qi++) {
        const cur = q[qi], dcur = dist.get(cur)!;
        for (const e of rev.get(cur) || []) {
            if (dist.has(e.from)) continue;
            dist.set(e.from, dcur + 1);
            dir.set(e.from, e.code);
            q.push(e.from);
        }
    }
    return { dir, dist };
}

const DIR_BY_CODE = new Map<number, Dir>(DIRS.map(d => [d.code, d]));

/**
 * 沿著 field 指定的方向一步步走，回傳到 entry 的步數；-1 = 繞圈或斷線（不收斂）。
 * 這是 UNKA/UNKB 真正的不變式：**走得到**才是對的，不一定要最短。
 * （實測原版就有不少格子刻意不走最短路，但都收斂；反之新增土地沒設好就會斷在那格。）
 */
function walkTo(dv: DataView, field: number, start: number, entry: number, onGrid: Set<number>, limit: number): number {
    let cur = start;
    const seen = new Set<number>();
    for (let step = 0; step <= limit; step++) {
        if (cur === entry) return step;
        if (seen.has(cur)) return -1;
        seen.add(cur);
        const d = DIR_BY_CODE.get(getF(dv, field, cur));
        if (!d) return -1;                              // 方向碼無效（非 1~4）
        const nxt = getF(dv, d.field, cur);
        if (!nxt || !onGrid.has(nxt)) return -1;        // 那個方向根本沒路
        cur = nxt;
    }
    return -1;
}

export type RouteMode =
    | 'repair'    // 只改「目前走不到入口」的格子（預設，最貼近原版）
    | 'rebuild';  // 全部改寫成最短路（會偏離原版寫法，通常不需要）

interface RouteApplyResult {
    changed: number[];       // 實際被改寫的格子
    unreachable: number[];   // 路徑圖上根本連不到入口（路沒接好，本函式修不了）
    stillBroken: number[];   // 改完仍不收斂
    brokenBefore: number[];  // 動手前就不收斂的格子
    nonShortest: number[];   // 收斂但不是最短路（原版風格，repair 模式不動它）
}

function applyRoute(
    dv: DataView, field: number, nodes: number[], entry: number,
    r: { dir: Map<number, number>; dist: Map<number, number> },
    mode: RouteMode, force: Set<number>,
): RouteApplyResult {
    const onGrid = new Set(nodes);
    const limit = nodes.length + 2;
    const res: RouteApplyResult = { changed: [], unreachable: [], stillBroken: [], brokenBefore: [], nonShortest: [] };

    for (const id of nodes) {
        if (!r.dist.has(id)) res.unreachable.push(id);
        if (walkTo(dv, field, id, entry, onGrid, limit) < 0) res.brokenBefore.push(id);
        else {
            const dist = r.dist.get(id);
            const cd = DIR_BY_CODE.get(getF(dv, field, id));
            if (dist !== undefined && dist > 0 && cd) {
                const nxt = r.dist.get(getF(dv, cd.field, id));
                if (nxt === undefined || nxt !== dist - 1) res.nonShortest.push(id);
            }
        }
    }

    // 由近到遠處理：修好靠近入口的格子，往往連下游一整串都跟著救回來
    const order = nodes.filter(id => r.dist.has(id)).sort((a, b) => r.dist.get(a)! - r.dist.get(b)!);
    for (const id of order) {
        const want = r.dir.get(id)!;
        const cur = getF(dv, field, id);
        if (mode === 'repair') {
            // force 裡的是「剛建立的新格子」：它沒有原作者的設計意圖要保留，
            // 就算目前的佔位值碰巧走得通，也要換成真正算出來的最短路。
            if (!force.has(id) && walkTo(dv, field, id, entry, onGrid, limit) >= 0) continue;
        } else {
            const dist = r.dist.get(id)!;
            const cd = DIR_BY_CODE.get(cur);
            if (cd && dist > 0) {                                            // 現值已是最短路 → 保留原版選擇
                const nxt = r.dist.get(getF(dv, cd.field, id));
                if (nxt !== undefined && nxt === dist - 1) continue;
            }
        }
        if (cur !== want) { setF(dv, field, id, want); res.changed.push(id); }
    }

    for (const id of nodes) if (walkTo(dv, field, id, entry, onGrid, limit) < 0) res.stillBroken.push(id);
    return res;
}

export interface RoutingReport {
    ok: boolean;
    error?: string;
    mode: RouteMode;
    jailEntry: number;
    hospitalEntry: number;
    ambiguousJail: number[];      // 不只一個 UNKA=0 候選時列出（已自動挑一個）
    ambiguousHospital: number[];
    total: number;                // 參與路由的格子數
    a: RouteApplyResult;          // UNKA（往監獄）
    b: RouteApplyResult;          // UNKB（往醫院）
}

const EMPTY_APPLY: RouteApplyResult = { changed: [], unreachable: [], stillBroken: [], brokenBefore: [], nonShortest: [] };

/**
 * 掃描全圖並修正 UNKA/UNKB。只動編號 1..282 且在 grid 上的路徑地點（特殊地點也有這兩欄）；
 * +950 購地標記不在 loc 陣列內，天然排除。
 * mode='repair'（預設）只改走不到入口的格子；'rebuild' 才全面改成最短路。
 * dryRun=true 只回報不寫入。
 */
export function recomputeRouting(
    grid: Uint16Array,
    dv: DataView,
    opts: {
        jailEntry?: number; hospitalEntry?: number; boundary?: number;
        dryRun?: boolean; mode?: RouteMode;
        /** 這些地點一律重算（給剛建立的新格子用，不保留碰巧能通的佔位值）。 */
        forceIds?: number[];
    } = {},
): RoutingReport {
    const boundary = opts.boundary ?? 49;
    const mode: RouteMode = opts.mode ?? 'repair';
    const force = new Set(opts.forceIds ?? []);
    const ents = findRoutingEntries(grid, dv);
    const jailEntry = opts.jailEntry ?? pickEntry(ents.jail, boundary);
    const hospEntry = opts.hospitalEntry ?? pickEntry(ents.hospital, boundary);

    const nodes: number[] = [];
    for (const [id] of buildCellMap(grid)) if (id > 0 && id <= MAX_LOC_ID) nodes.push(id);
    nodes.sort((a, b) => a - b);

    const base: RoutingReport = {
        ok: false, mode, jailEntry, hospitalEntry: hospEntry,
        ambiguousJail: ents.jail.length > 1 ? ents.jail : [],
        ambiguousHospital: ents.hospital.length > 1 ? ents.hospital : [],
        total: nodes.length, a: EMPTY_APPLY, b: EMPTY_APPLY,
    };
    if (jailEntry < 0) return { ...base, error: '找不到監獄入口格（沒有任何格子的 UNKA=0）' };
    if (hospEntry < 0) return { ...base, error: '找不到醫院入口格（沒有任何格子的 UNKB=0）' };

    const ra = routeToward(grid, dv, jailEntry);
    const rb = routeToward(grid, dv, hospEntry);

    // dryRun 在副本上跑，原始資料一個位元組都不動
    const target = opts.dryRun
        ? new DataView(dv.buffer.slice(0) as ArrayBuffer, dv.byteOffset, dv.byteLength)
        : dv;

    return {
        ...base, ok: true,
        a: applyRoute(target, LOC_FIELDS.UNKA, nodes, jailEntry, ra, mode, force),
        b: applyRoute(target, LOC_FIELDS.UNKB, nodes, hospEntry, rb, mode, force),
    };
}

/**
 * 依 grid 相鄰格，把 baseId 尚未設定(=0)的方向指標接到相鄰的路徑地點，並補上對方的反向（僅在對方該方向為空時，絕不覆蓋既有連結）。
 * 回傳實際接了哪些方向。純加法、安全，不會破壞既有路徑。
 */
export function wireDirectionsFromGrid(grid: Uint16Array, dv: DataView, baseId: number): { dir: string; tgt: number }[] {
    const wired: { dir: string; tgt: number }[] = [];
    const cells = buildCellMap(grid).get(baseId);
    if (!cells) return wired;
    for (const d of DIRS) {
        if (getF(dv, d.field, baseId) !== 0) continue; // 已有連結就不動
        let nbr = 0;
        for (const ci of cells) {
            const gx = ci % GRID_COLS, gy = Math.floor(ci / GRID_COLS);
            const nx = gx + d.dx, ny = gy + d.dy;
            if (nx < 0 || nx >= GRID_COLS || ny < 0 || ny >= GRID_ROWS) continue;
            const cand = grid[ny * GRID_COLS + nx];
            if (cand > 0 && cand <= MAX_LOC_ID && cand !== baseId) { nbr = cand; break; }
        }
        if (nbr === 0) continue;
        setF(dv, d.field, baseId, nbr);
        if (getF(dv, d.opp, nbr) === 0) setF(dv, d.opp, nbr, baseId);
        wired.push({ dir: d.name, tgt: nbr });
    }
    return wired;
}
