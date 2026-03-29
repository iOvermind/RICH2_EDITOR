// src/render/renderer.ts
import { GRID_COLS, GRID_ROWS, TILE_W, TILE_H, palette } from '../config/constants';

// 1. 畫網格線
export function drawGrid(ctx: CanvasRenderingContext2D): void {
    const width = ctx.canvas.width;
    const height = ctx.canvas.height;

    ctx.strokeStyle = '#333';
    for (let x = 0; x <= width; x += TILE_W) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
    for (let y = 0; y <= height; y += TILE_H) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }
}

// 2. 畫圖庫 Dump
export function renderTilesetDump(
    ctx: CanvasRenderingContext2D,
    mapTilesData: Uint8Array,
    logMsg: (msg: string) => void
): void {
    if (!mapTilesData || mapTilesData.length === 0) return;

    logMsg("開始將圖塊圖庫 Dump 到畫布上...");
    const width = ctx.canvas.width;
    const height = ctx.canvas.height;
    const imgData = ctx.createImageData(width, height);
    const totalTiles = Math.floor(mapTilesData.length / 480);

    for (let gy = 0; gy < GRID_ROWS; gy++) {
        for (let gx = 0; gx < GRID_COLS; gx++) {
            const tileIndex = gy * GRID_COLS + gx;
            if (tileIndex >= totalTiles) break;

            const srcOffset = tileIndex * 480;
            for (let ty = 0; ty < TILE_H; ty++) {
                for (let tx = 0; tx < TILE_W; tx++) {
                    const colorIndex = mapTilesData[srcOffset + ty * TILE_W + tx];
                    const pxX = gx * TILE_W + tx;
                    const pxY = gy * TILE_H + ty;
                    const destOffset = (pxY * width + pxX) * 4;

                    imgData.data[destOffset] = palette[colorIndex * 3];
                    imgData.data[destOffset + 1] = palette[colorIndex * 3 + 1];
                    imgData.data[destOffset + 2] = palette[colorIndex * 3 + 2];
                    imgData.data[destOffset + 3] = 255;
                }
            }
        }
    }
    ctx.putImageData(imgData, 0, 0);
    drawGrid(ctx);
}

// 3. 畫真正的地圖
export function renderRealMapEngine(
    ctx: CanvasRenderingContext2D,
    mapTilesData: Uint8Array,
    mapLayout: Uint16Array,
    isPaletteLoaded: boolean,
    isSaveLoaded: boolean,
    logMsg: (msg: string) => void
): void {
    if (isPaletteLoaded && mapTilesData.length > 0 && isSaveLoaded) {
        logMsg("幹，三神器湊齊了！開始渲染真正的地圖...");

        const width = ctx.canvas.width;
        const height = ctx.canvas.height;
        const imgData = ctx.createImageData(width, height);
        const totalTiles = Math.floor(mapTilesData.length / 480);

        for (let gy = 0; gy < GRID_ROWS; gy++) {
            for (let gx = 0; gx < GRID_COLS; gx++) {
                const cellIndex = gy * GRID_COLS + gx;
                const tileIndex = mapLayout[cellIndex];

                if (tileIndex >= totalTiles) continue;

                const srcOffset = tileIndex * 480;
                for (let ty = 0; ty < TILE_H; ty++) {
                    for (let tx = 0; tx < TILE_W; tx++) {
                        const colorIndex = mapTilesData[srcOffset + ty * TILE_W + tx];
                        const pxX = gx * TILE_W + tx;
                        const pxY = gy * TILE_H + ty;
                        const destOffset = (pxY * width + pxX) * 4;

                        imgData.data[destOffset] = palette[colorIndex * 3];
                        imgData.data[destOffset + 1] = palette[colorIndex * 3 + 1];
                        imgData.data[destOffset + 2] = palette[colorIndex * 3 + 2];
                        imgData.data[destOffset + 3] = 255;
                    }
                }
            }
        }
        ctx.putImageData(imgData, 0, 0);
        drawGrid(ctx);
    } else {
        logMsg("還缺檔案喔！PAT、PAK、DSK 三個都要載入才會啟動真地圖模式。");
    }
}