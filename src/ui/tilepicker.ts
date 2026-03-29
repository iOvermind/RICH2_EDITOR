// src/ui/tilePicker.ts

export function initTilePicker(
    mapTilesData: Uint8Array,
    palette: Uint8Array,
    TILE_W: number,
    TILE_H: number,
    onTileSelected: (tileId: number) => void // 這是精華！把點擊後的動作交給外部定義
): void {
    const wrap = document.getElementById('tilePickerWrap') as HTMLDivElement;
    // 防呆：如果已經長出來了，就不要重複塞入
    if (!wrap || wrap.children.length > 0) return;

    const totalTiles = Math.floor(mapTilesData.length / 480);
    for (let t = 0; t < totalTiles; t++) {
        const c = document.createElement('canvas');
        c.width = TILE_W;
        c.height = TILE_H;
        c.className = 'tile-btn';
        c.title = `圖塊 #${t}`;

        const tctx = c.getContext('2d');
        if (!tctx) continue;

        const img = tctx.createImageData(TILE_W, TILE_H);
        const src = t * 480;
        for (let p = 0; p < 480; p++) {
            const ci = mapTilesData[src + p];
            img.data[p * 4] = palette[ci * 3];
            img.data[p * 4 + 1] = palette[ci * 3 + 1];
            img.data[p * 4 + 2] = palette[ci * 3 + 2];
            img.data[p * 4 + 3] = 255;
        }
        tctx.putImageData(img, 0, 0);

        // 綁定點擊事件
        c.addEventListener('click', () => {
            // 1. UI 顯示更新：把大家的紅框拿掉，給被點擊的加上紅框
            document.querySelectorAll('.tile-btn').forEach(b => b.classList.remove('selected'));
            c.classList.add('selected');

            // 2. 呼叫傳進來的 Callback，告訴主程式「他點了這個圖塊！」
            onTileSelected(t);
        });

        wrap.appendChild(c);
    }
}

// 輔助函式：用來自動捲動並加上紅框
export function updateTilePickerSelection(tileId: number): void {
    const wrap = document.getElementById('tilePickerWrap') as HTMLDivElement;
    if (!wrap) return;

    document.querySelectorAll('.tile-btn').forEach((b, i) => {
        if (i === tileId) b.classList.add('selected');
        else b.classList.remove('selected');
    });

    const sel = wrap.children[tileId] as HTMLElement;
    if (sel) sel.scrollIntoView({ block: 'nearest' });
}