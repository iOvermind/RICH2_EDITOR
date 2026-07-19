// src/core/integrity.ts
// 地圖結構完整性：偵測 + 修復引擎要求的不變式。
// 純函式，瀏覽器 (main.ts) 與 node 測試共用。
import { GRID_COLS, GRID_ROWS, LOC_COUNT, LOC_FIELDS, PRICE_SEG_COUNT } from '../config/constants';

// 地點編號絕對上限（LOC_COUNT=283 → 合法 index 0..282）。>950 是 +950 購地標記，不算路徑地點。
export const MAX_LOC_ID = LOC_COUNT - 1;

export interface Dir {
    field: number;   // 此方向的指標欄位
    opp: number;     // 相反方向欄位
    dx: number;
    dy: number;
    name: string;
}

// 四方向（含相反方向與 grid 位移）
export const DIRS: Dir[] = [
    { field: LOC_FIELDS.LEFT, opp: LOC_FIELDS.RIGHT, dx: -1, dy: 0, name: '左' },
    { field: LOC_FIELDS.RIGHT, opp: LOC_FIELDS.LEFT, dx: 1, dy: 0, name: '右' },
    { field: LOC_FIELDS.UP, opp: LOC_FIELDS.DOWN, dx: 0, dy: -1, name: '上' },
    { field: LOC_FIELDS.DOWN, opp: LOC_FIELDS.UP, dx: 0, dy: 1, name: '下' },
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
    | 'dead-end'         // grid 上路徑地點的方向連結數 < 2（玩家會走不動）
    | 'zero-price';      // 土地(seg>0)的地段買價 = 0（引擎可能除以 0）

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

/**
 * 全圖完整性掃描。
 * boundary = 特殊/道路分界編號（= 引擎 [0x1098]，台灣23/香港27/城40）。
 * 只讀不改；每個可安全修復的 issue 會附帶 fix()。
 */
export function analyzeIntegrity(grid: Uint16Array, dv: DataView, boundary: number, priceDv?: DataView | null): IntegrityIssue[] {
    const issues: IntegrityIssue[] = [];
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

    return issues;
}

/** 套用所有可自動修復的 issue，回傳修好的數量。 */
export function repairMap(grid: Uint16Array, dv: DataView, boundary: number): { fixed: number; remaining: IntegrityIssue[] } {
    let fixed = 0;
    // 反覆跑到收斂（修一輪可能揭露/消除其他 issue）
    for (let pass = 0; pass < 4; pass++) {
        const issues = analyzeIntegrity(grid, dv, boundary);
        const fixable = issues.filter(i => i.fix);
        if (fixable.length === 0) break;
        for (const i of fixable) { i.fix!(); fixed++; }
    }
    return { fixed, remaining: analyzeIntegrity(grid, dv, boundary) };
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

/** 在道路/土地分區 (boundary+1..maxLoc) 找一個「記錄空、grid 空、標記槽(+950)也空」的自由編號。找不到回 -1。 */
export function findFreeLandId(grid: Uint16Array, dv: DataView, boundary: number, maxLoc: number = MAX_LOC_ID): number {
    const cm = buildCellMap(grid);
    for (let id = boundary + 1; id <= maxLoc; id++) {
        if (isActive(dv, id)) continue;
        if (cm.has(id)) continue;
        if (cm.has(id + 950)) continue;
        return id;
    }
    return -1;
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
