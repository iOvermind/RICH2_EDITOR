import { GRID_COLS, GRID_ROWS, TILE_W, TILE_H, palette } from '../config/constants';
import type { Workspace } from '../core/workspace';

export interface RendererConfig {
    ctx: CanvasRenderingContext2D;
    workspace: Workspace;
    onLog?: (msg: string) => void;
}

export class MapRenderer {
    private ctx: CanvasRenderingContext2D;
    private workspace: Workspace;
    private onLog: (msg: string) => void;

    constructor(config: RendererConfig) {
        this.ctx = config.ctx;
        this.workspace = config.workspace;
        this.onLog = config.onLog || (() => {});
    }

    public redraw(): void {
        if (this.workspace.isSaveLoaded) {
            this.drawRealMap();
        } else if (this.workspace.isPaletteLoaded && this.workspace.mapTilesData.length > 0) {
            this.drawTilesetDump();
        } else {
            this.drawGrid();
        }
    }

    private log(msg: string): void {
        this.onLog(msg);
    }

    private drawGrid(): void {
        const width = this.ctx.canvas.width;
        const height = this.ctx.canvas.height;

        this.ctx.strokeStyle = '#333';
        for (let x = 0; x <= width; x += TILE_W) {
            this.ctx.beginPath(); this.ctx.moveTo(x, 0); this.ctx.lineTo(x, height); this.ctx.stroke();
        }
        for (let y = 0; y <= height; y += TILE_H) {
            this.ctx.beginPath(); this.ctx.moveTo(0, y); this.ctx.lineTo(width, y); this.ctx.stroke();
        }
    }

    private drawTilesetDump(): void {
        const mapTilesData = this.workspace.mapTilesData;
        if (!mapTilesData || mapTilesData.length === 0) return;

        this.log("開始將圖塊圖庫 Dump 到畫布上...");
        const width = this.ctx.canvas.width;
        const height = this.ctx.canvas.height;
        const imgData = this.ctx.createImageData(width, height);
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
        this.ctx.putImageData(imgData, 0, 0);
        this.drawGrid();
    }

    private drawRealMap(): void {
        const mapTilesData = this.workspace.mapTilesData;
        const mapLayout = this.workspace.mapLayout;

        if (this.workspace.isPaletteLoaded && mapTilesData.length > 0 && this.workspace.isSaveLoaded) {
            this.log("幹，三神器湊齊了！開始渲染真正的地圖...");

            const width = this.ctx.canvas.width;
            const height = this.ctx.canvas.height;
            const imgData = this.ctx.createImageData(width, height);
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
            this.ctx.putImageData(imgData, 0, 0);
            this.drawGrid();
        } else {
            this.log("還缺檔案喔！PAT、PAK、DSK 三個都要載入才會啟動真地圖模式。");
        }
    }
}