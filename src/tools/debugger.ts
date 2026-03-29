// src/tools/debugger.ts
import { GRID_COLS, GRID_ROWS, LOC_COUNT, LOC_FIELDS } from '../config/constants';

export function initDebugTools(context: {
    mapGrid: Uint16Array;
    mapLayout: Uint16Array;
    getLocDataView: () => DataView | null;
    getPriceDataView: () => DataView | null;
    getLocField: (field: number, locId: number) => number;
    setLocField: (field: number, locId: number, val: number) => void;
    checkAndRenderRealMap: () => void;
}) {
    const { mapGrid, mapLayout, getLocDataView, getPriceDataView, getLocField, setLocField, checkAndRenderRealMap } = context;

    // === 1. 土地 ID / 地段 ID / 圖塊 ID 關係分析 ===
    (window as any).analyzeLandTileOffset = function () {
        const locDataView = getLocDataView();
        if (!mapGrid.length || !mapLayout.length) {
            console.warn("還沒載入地圖資料，先匯入 DSK/PAK 再分析。");
            return;
        }
        if (!locDataView) {
            console.warn("還沒載入 locData，無法讀取地段編號。");
            return;
        }

        type Cell = { gx: number; gy: number; tileId: number; };
        const byLoc = new Map<number, Cell[]>();
        for (let gy = 0; gy < GRID_ROWS; gy++) {
            for (let gx = 0; gx < GRID_COLS; gx++) {
                const idx = gy * GRID_COLS + gx;
                const locId = mapGrid[idx];
                if (locId <= 0) continue;
                const tileId = mapLayout[idx];
                if (!byLoc.has(locId)) byLoc.set(locId, []);
                byLoc.get(locId)!.push({ gx, gy, tileId });
            }
        }

        let landCount = 0, pairCount950 = 0, changedTilePairs = 0;
        let ownedCount = 0, ownedAndMarkerChanged = 0;
        const examples: string[] = [];
        const markerTileHist = new Map<number, number>();

        for (let base = 0x33; base <= LOC_COUNT; base++) {
            const segId = getLocField(LOC_FIELDS.SEGMENT, base);
            if (segId <= 0) continue; // 非土地跳過
            landCount++;

            const baseCells = byLoc.get(base) || [];
            const markCells = byLoc.get(base + 950) || [];
            if (markCells.length === 0) continue;
            pairCount950++;

            const baseTileSet = new Set(baseCells.map(c => c.tileId));
            const markTileSet = new Set(markCells.map(c => c.tileId));
            const different = [...markTileSet].some(t => !baseTileSet.has(t));
            if (different) changedTilePairs++;
            markTileSet.forEach((t) => markerTileHist.set(t, (markerTileHist.get(t) || 0) + 1));

            const owner = getLocField(LOC_FIELDS.OWNER, base);
            const house = getLocField(LOC_FIELDS.HOUSE, base);
            const isOwned = owner > 0 || house > 0;
            if (isOwned) {
                ownedCount++;
                if (different) ownedAndMarkerChanged++;
            }

            if (examples.length < 12) {
                const bt = [...baseTileSet].join('/');
                const mt = [...markTileSet].join('/');
                examples.push(`loc ${base} -> ${base + 950} | seg=${segId} owner=${owner} house=${house} | baseTile=[${bt || '-'}] markTile=[${mt || '-'}]`);
            }
        }

        console.log("=== 購地標記分析（你描述的規則）===");
        console.log(`土地總數(依 segId>0)：${landCount}`);
        console.log(`有找到 loc+950 對應格的土地數：${pairCount950}`);
        console.log(`其中「標記格 tile 與原始格 tile 不同」的土地數：${changedTilePairs}`);
        console.log(`已持有土地數(owner>0 或 house>0)：${ownedCount}`);
        console.log(`已持有且標記格 tile 確實不同：${ownedAndMarkerChanged}`);
        const hist = [...markerTileHist.entries()].sort((a, b) => b[1] - a[1]).map(([t, c]) => `tile${t}:${c}`).join(', ');
        console.log(`標記格 tile 分佈：${hist || '-'}`);
    };

    // === 2. 模擬購買連動 ===
    (window as any).simulatePurchaseLink = function (baseLocId: number, ownerId: number = 1, purchasedTileId: number = 2, houseLevel?: number) {
        const locDataView = getLocDataView();
        if (!locDataView || !mapGrid.length || !mapLayout.length) {
            console.warn("請先載入 DSK/PAK。"); return;
        }
        if (baseLocId <= 0 || baseLocId > LOC_COUNT) return;

        const markerLocId = baseLocId + 950;
        const markerIndices: number[] = [];
        for (let i = 0; i < mapGrid.length; i++) {
            if (mapGrid[i] === markerLocId) markerIndices.push(i);
        }

        setLocField(LOC_FIELDS.OWNER, baseLocId, ownerId);
        if (typeof houseLevel === 'number' && houseLevel >= 0) {
            setLocField(LOC_FIELDS.HOUSE, baseLocId, houseLevel);
        }
        markerIndices.forEach(i => { mapLayout[i] = purchasedTileId; });

        checkAndRenderRealMap();
        console.log(`simulatePurchaseLink: 已更新 baseLoc=${baseLocId}`);
    };

    // === 3. 自動同步購地標記 ===
    (window as any).syncMarkerTilesFromOwnership = function (emptyTileId: number = 1, ownedTileId: number = 2): number {
        const locDataView = getLocDataView();
        if (!locDataView || !mapGrid.length || !mapLayout.length) {
            console.warn("請先載入 DSK/PAK。"); return 0;
        }
        let touched = 0;
        for (let base = 0x33; base <= LOC_COUNT; base++) {
            const segId = getLocField(LOC_FIELDS.SEGMENT, base);
            if (segId <= 0) continue;
            const owner = getLocField(LOC_FIELDS.OWNER, base);
            const house = getLocField(LOC_FIELDS.HOUSE, base);
            const targetTile = (owner > 0 || house > 0) ? ownedTileId : emptyTileId;
            const markerLocId = base + 950;
            for (let i = 0; i < mapGrid.length; i++) {
                if (mapGrid[i] !== markerLocId) continue;
                if (mapLayout[i] !== targetTile) {
                    mapLayout[i] = targetTile;
                    touched++;
                }
            }
        }
        checkAndRenderRealMap();
        console.log(`syncMarkerTilesFromOwnership 完成，更新 ${touched} 個標記圖塊。`);
        return touched;
    };

    // === 4. 掃描除以 0 地雷 ===
    (window as any).scanZero = function () {
        const locDataView = getLocDataView();
        const priceDataView = getPriceDataView();
        if (!locDataView) {
            console.error("幹，DSK 存檔還沒載入啦！"); return;
        }

        let warnings: string[] = [];
        console.log("=== 開始掃描大富翁 3 除以 0 地雷 ===");

        for (let id = 1; id <= 124; id++) {
            let x = getLocField(LOC_FIELDS.X, id);
            let y = getLocField(LOC_FIELDS.Y, id);
            let left = getLocField(LOC_FIELDS.LEFT, id);
            let up = getLocField(LOC_FIELDS.UP, id);
            let right = getLocField(LOC_FIELDS.RIGHT, id);
            let down = getLocField(LOC_FIELDS.DOWN, id);
            let segId = getLocField(LOC_FIELDS.SEGMENT, id);

            if (left > 0 && Math.abs(x - getLocField(LOC_FIELDS.X, left)) === 0) warnings.push(`[地點 ${id} -> 左 ${left}] X座標重複！`);
            if (right > 0 && Math.abs(x - getLocField(LOC_FIELDS.X, right)) === 0) warnings.push(`[地點 ${id} -> 右 ${right}] X座標重複！`);
            if (up > 0 && Math.abs(y - getLocField(LOC_FIELDS.Y, up)) === 0) warnings.push(`[地點 ${id} -> 上 ${up}] Y座標重複！`);
            if (down > 0 && Math.abs(y - getLocField(LOC_FIELDS.Y, down)) === 0) warnings.push(`[地點 ${id} -> 下 ${down}] Y座標重複！`);

            let paths = (left > 0 ? 1 : 0) + (up > 0 ? 1 : 0) + (right > 0 ? 1 : 0) + (down > 0 ? 1 : 0);
            if (paths === 1) warnings.push(`[地點 ${id}] 靠背，這是死胡同！`);

            if (segId > 0 && segId < 45 && priceDataView) {
                try {
                    let basePrice = priceDataView.getUint16(segId * 24, true);
                    if (basePrice === 0) warnings.push(`[地點 ${id}] 地段 ${segId} 買價是 0！`);
                } catch (e) { }
            }
        }
        if (warnings.length > 0) console.warn("🚨 抓到地雷：\n" + warnings.join("\n"));
        else console.log("✅ 沒抓到明顯的除以 0 錯誤。");
    };
}