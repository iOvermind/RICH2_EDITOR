// src/ui/tilePicker.ts
import { SPECIAL_TILE_BASE, SPECIAL_KIND_COUNT, SPECIAL_TILE_SPAN } from '../config/constants';

export interface TilePickerHooks {
    /** 點一般圖塊：套用到目前選取的格子。 */
    onTile: (tileId: number) => void;
    /** 點特殊地點：一次貼滿 2x2 四格。 */
    onSpecial: (kind: number) => void;
    /** 種類編號 → 名稱（來自 PAK 文字）。 */
    specialName: (kind: number) => string;
}

/** 把某個圖塊畫到 canvas 的 (dx,dy)。 */
function drawTile(
    ctx: CanvasRenderingContext2D, tiles: Uint8Array, palette: Uint8Array,
    w: number, h: number, tileId: number, dx: number, dy: number,
): void {
    const src = tileId * 480;
    if (src + 480 > tiles.length) return;
    const img = ctx.createImageData(w, h);
    for (let p = 0; p < 480; p++) {
        const ci = tiles[src + p];
        img.data[p * 4] = palette[ci * 3];
        img.data[p * 4 + 1] = palette[ci * 3 + 1];
        img.data[p * 4 + 2] = palette[ci * 3 + 2];
        img.data[p * 4 + 3] = 255;
    }
    ctx.putImageData(img, dx, dy);
}

/**
 * 建出兩個選擇器：
 *  - 特殊地點：11 種各畫成一塊 2x2 預覽，點一下就是完整的四格，不必自己拼四個圖塊。
 *  - 一般圖塊：**扣掉 40~83**（那些是特殊地點的零件，混在裡面只會手殘貼錯半個）。
 */
export function initTilePicker(
    mapTilesData: Uint8Array,
    palette: Uint8Array,
    TILE_W: number,
    TILE_H: number,
    hooks: TilePickerHooks,
): void {
    const wrap = document.getElementById('tilePickerWrap') as HTMLDivElement | null;
    // 防呆：如果已經長出來了，就不要重複塞入
    if (!wrap || wrap.children.length > 0) return;

    const specialWrap = document.getElementById('specialPickerWrap') as HTMLDivElement | null;
    const totalTiles = Math.floor(mapTilesData.length / 480);

    // ---- 特殊地點：每種一塊 2x2 預覽 ----
    if (specialWrap) {
        specialWrap.innerHTML = '';
        for (let kind = 0; kind < SPECIAL_KIND_COUNT; kind++) {
            const base = SPECIAL_TILE_BASE + kind * SPECIAL_TILE_SPAN;
            if (base + 3 >= totalTiles) continue;   // 這張圖沒有這種圖塊

            const box = document.createElement('button');
            box.type = 'button';
            box.className = 'special-btn';
            box.dataset.kind = kind.toString();
            box.title = `${hooks.specialName(kind)}：圖塊 ${base}~${base + 3}，點一下貼滿 2x2 四格`;

            const c = document.createElement('canvas');
            c.width = TILE_W * 2;
            c.height = TILE_H * 2;
            const cctx = c.getContext('2d');
            if (cctx) {
                drawTile(cctx, mapTilesData, palette, TILE_W, TILE_H, base, 0, 0);
                drawTile(cctx, mapTilesData, palette, TILE_W, TILE_H, base + 1, TILE_W, 0);
                drawTile(cctx, mapTilesData, palette, TILE_W, TILE_H, base + 2, 0, TILE_H);
                drawTile(cctx, mapTilesData, palette, TILE_W, TILE_H, base + 3, TILE_W, TILE_H);
            }
            c.className = 'tile-art';
            box.appendChild(c);

            const cap = document.createElement('span');
            cap.className = 'special-btn-cap';
            cap.textContent = hooks.specialName(kind).replace(/\s+/g, '');
            box.appendChild(cap);

            box.addEventListener('click', () => hooks.onSpecial(kind));
            specialWrap.appendChild(box);
        }
    }

    // ---- 一般圖塊（不含特殊地點的零件）----
    for (let t = 0; t < totalTiles; t++) {
        if (t >= SPECIAL_TILE_BASE && t < SPECIAL_TILE_BASE + SPECIAL_KIND_COUNT * SPECIAL_TILE_SPAN) continue;

        const c = document.createElement('canvas');
        c.width = TILE_W;
        c.height = TILE_H;
        c.className = 'tile-btn tile-art';
        c.dataset.tile = t.toString();      // 位置 ≠ 圖塊編號了，用 data 屬性對應
        c.title = `圖塊 #${t}`;

        const tctx = c.getContext('2d');
        if (!tctx) continue;
        drawTile(tctx, mapTilesData, palette, TILE_W, TILE_H, t, 0, 0);

        c.addEventListener('click', () => {
            document.querySelectorAll('.tile-btn').forEach(b => b.classList.remove('selected'));
            c.classList.add('selected');
            hooks.onTile(t);
        });

        wrap.appendChild(c);
    }
}

/** 依目前這格的圖塊，把對應的選擇器加紅框並捲到看得見的位置。 */
export function updateTilePickerSelection(tileId: number): void {
    document.querySelectorAll('.tile-btn, .special-btn').forEach(b => b.classList.remove('selected'));

    const kind = tileId >= SPECIAL_TILE_BASE && tileId < SPECIAL_TILE_BASE + SPECIAL_KIND_COUNT * SPECIAL_TILE_SPAN
        ? Math.floor((tileId - SPECIAL_TILE_BASE) / SPECIAL_TILE_SPAN)
        : -1;
    const sel = kind >= 0
        ? document.querySelector(`.special-btn[data-kind="${kind}"]`)
        : document.querySelector(`.tile-btn[data-tile="${tileId}"]`);
    if (!sel) return;
    sel.classList.add('selected');
    (sel as HTMLElement).scrollIntoView({ block: 'nearest' });
}

/**
 * 讓選擇器裡的圖案跟**地圖上一格的實際顯示大小**一樣大。
 *
 * 地圖 canvas 是固定的 864x720，靠 CSS 的 `object-fit: contain` 撐滿左邊區域，
 * 所以一格在螢幕上到底幾像素要看視窗多大 —— 用 getBoundingClientRect 反推那個比例，
 * 再把同樣的比例套到選擇器的 canvas 上（backing store 維持原生解析度，只放大 CSS 尺寸，
 * 配合 image-rendering: pixelated 才不會糊掉）。
 *
 * 視窗大小一變就要重算，所以 dom-controller 綁了 resize。
 */
export function syncTilePickerScale(mapCanvas: HTMLCanvasElement, tileW: number, tileH: number): void {
    const rect = mapCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    // object-fit: contain → 兩軸取小的那個比例
    const scale = Math.min(rect.width / mapCanvas.width, rect.height / mapCanvas.height);
    if (!isFinite(scale) || scale <= 0) return;
    for (const el of document.querySelectorAll<HTMLCanvasElement>('.tile-art')) {
        // 特殊地點那顆是 2x2，用它自己的 canvas 寬度換算，不要寫死
        const cells = el.width / tileW;
        el.style.width = `${tileW * cells * scale}px`;
        el.style.height = `${tileH * (el.height / tileH) * scale}px`;
    }
}
