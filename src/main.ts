import './style.css';
import iconv from 'iconv-lite';
import { Buffer } from 'buffer';
import { decompressGeneralData } from './utils/compression';
import {
  GRID_COLS, GRID_ROWS, TILE_W, TILE_H, palette,
  PRICE_FIELD_COUNT, PRICE_SEG_COUNT, PRICE_FIELD_SIZE, PRICE_FIELDS,
  LOC_COUNT, LOC_FIELDS
} from './config/constants';
import { parseMapPakCore, replaceGroupInDsk, parseSaveDskCore, rebuildDskBufferCore } from './core/parser';
import { analyzeIntegrity, repairMap, findFreeLandId, wireDirectionsFromGrid } from './core/integrity';
import { MAPS, isSupported as fsSupported, hasFolder, pickGameFolder, readFile as readGameFile, writeFile as writeGameFile, patchExe, readSpecialCount } from './core/gamefolder';
import { initTilePicker, updateTilePickerSelection } from './ui/tilepicker';
import { initDebugTools } from './tools/debugger';
import { drawGrid, renderTilesetDump, renderRealMapEngine } from './render/renderer';

// 新增一個全域變數，用來記住 PAK 解壓出來的完整文字內容
let pakTextLines: string[] = [];

// DOM 元素綁定與型別轉換
const canvas = document.getElementById('mapCanvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
const infoBox = document.getElementById('infoBox') as HTMLDivElement;

// TS 介面定義
interface WarningMsg {
  type: string;
  cells: number[];
  msg: string;
}

let isPaletteLoaded: boolean = true;
let mapTilesData: Uint8Array = new Uint8Array(0);
let mapGrid: Uint16Array = new Uint16Array(GRID_COLS * GRID_ROWS);
let mapLayout: Uint16Array = new Uint16Array(GRID_COLS * GRID_ROWS);
let isSaveLoaded: boolean = false;
let rawPakBuffer: ArrayBuffer | null = null;
let rawDskBuffer: ArrayBuffer | null = null;
let pakGroupPointers: number[] = [];
let dskGroupPointers: number[] = [];
// 新增用來記錄原始檔名的變數
let loadedPakFileName: string = 'PART1.PAK';
let loadedDskFileName: string = 'SAVE_1.DSK';


// 路段名稱
let SEGMENT_NAMES: string[] = [""];
let SPECIAL_NAMES: string[] = ["土地/公園"];

// 價格表欄位定義
let priceData: Uint8Array | null = null;
let priceDataView: DataView | null = null;

let locData: Uint8Array | null = null;
let locDataView: DataView | null = null;

let selectedGridX: number = -1, selectedGridY: number = -1;

// === 繪圖系統 Wrapper ===
function checkAndRenderRealMap(): void {
  renderRealMapEngine(ctx, mapTilesData, mapLayout, isPaletteLoaded, isSaveLoaded, logMsg);
}

drawGrid(ctx);

function logMsg(msg: string): void {
  infoBox.innerHTML += `<br>> ${msg}`;
  infoBox.scrollTop = infoBox.scrollHeight;
}

// 處理 PART?.PAK 封裝資料集
(document.getElementById('mapFile') as HTMLInputElement).addEventListener('change', function (e: Event) {
  const target = e.target as HTMLInputElement;
  if (!target.files || target.files.length === 0) return;
  const file = target.files[0];

  // 新增：記住檔名，並順便更新按鈕文字
  loadedPakFileName = file.name;
  const exportPakBtn = document.getElementById('exportPakBtn');
  if (exportPakBtn) exportPakBtn.textContent = `匯出 ${loadedPakFileName}`;

  const reader = new FileReader();
  reader.onload = function (event: ProgressEvent<FileReader>) {
    // ...底下原本的邏輯不用動...
    if (!event.target || !event.target.result) return;
    rawPakBuffer = (event.target.result as ArrayBuffer).slice(0);
    const buffer = new DataView(event.target.result as ArrayBuffer);
    parseMapPak(buffer); // 注意：這裡如果是改成 parseMapPakCore 的 wrapper 就維持你改好的
  };
  reader.readAsArrayBuffer(file);
});

function parseMapPak(dataView: DataView): void {
  if (!rawPakBuffer) return;

  // 呼叫我們拆出去的純淨解析器，把 logMsg 傳進去給它用
  const result = parseMapPakCore(dataView, rawPakBuffer, logMsg);

  if (!result) return; // 檔頭錯誤或解析失敗直接中斷

  // 將解析出來的資料寫回 main.ts 的全域變數中
  pakGroupPointers = result.pakGroupPointers;
  mapTilesData = result.mapTilesData;
  if (result.mapGrid) {
    for (let i = 0; i < 1296; i++) mapGrid[i] = result.mapGrid[i];
  }
  pakTextLines = result.pakTextLines;
  SPECIAL_NAMES = result.SPECIAL_NAMES;
  SEGMENT_NAMES = result.SEGMENT_NAMES;

  // 渲染地圖判定
  if (isSaveLoaded) {
    checkAndRenderRealMap();
  } else if (isPaletteLoaded) {
    logMsg("存檔還沒載入，先 Dump 圖庫給你看...");
    // 補上 ctx, mapTilesData, 和用來印 Log 的 logMsg
    renderTilesetDump(ctx, mapTilesData, logMsg);
  } else {
    // 補上 ctx
    drawGrid(ctx);
  }
}

// 處理 SAVE_?.DSK 存檔
(document.getElementById('saveFile') as HTMLInputElement).addEventListener('change', function (e: Event) {
  const target = e.target as HTMLInputElement;
  if (!target.files || target.files.length === 0) return;
  const file = target.files[0];

  // 新增：記住檔名，並順便更新按鈕文字
  loadedDskFileName = file.name;
  const exportDskBtn = document.getElementById('exportDskBtn');
  if (exportDskBtn) exportDskBtn.textContent = `匯出 ${loadedDskFileName}`;

  const reader = new FileReader();
  reader.onload = function (event: ProgressEvent<FileReader>) {
    // ...底下原本的邏輯不用動...
    if (!event.target || !event.target.result) return;
    rawDskBuffer = (event.target.result as ArrayBuffer).slice(0);
    const buffer = new DataView(event.target.result as ArrayBuffer);
    parseSaveDsk(buffer);
  };
  reader.readAsArrayBuffer(file);
});

function parseSaveDsk(dataView: DataView): void {
  const result = parseSaveDskCore(dataView, logMsg);
  if (!result) return;

  dskGroupPointers = result.dskGroupPointers;

  if (result.mapLayout) {
    for (let i = 0; i < 1296; i++) mapLayout[i] = result.mapLayout[i];
    isSaveLoaded = true;
  }

  if (result.locData) {
    locData = result.locData;
    locDataView = new DataView(locData.buffer, locData.byteOffset, locData.byteLength);
    (window as any)._locDataView = locDataView;
  }

  if (result.priceData) {
    priceData = result.priceData;
    priceDataView = new DataView(priceData.buffer, priceData.byteOffset, priceData.byteLength);
  }

  // 重新載入 PAK 裡的文字訊息 (因為 PAK 可能先載過了，需要重新觸發)
  if (rawPakBuffer && pakGroupPointers.length >= 3) {
    logMsg("正在重新讀取 PAK 的文字訊息...");
    const pakDV = new DataView(rawPakBuffer);
    const msgData = decompressGeneralData(pakDV, pakGroupPointers[2]);

    if (msgData.length > 0) {
      const text = iconv.decode(Buffer.from(msgData), 'big5');
      pakTextLines = text.split('\r');

      SPECIAL_NAMES = [];
      for (let i = 0; i < 11; i++) {
        const name = pakTextLines[15 + i];
        SPECIAL_NAMES.push(name ? name.trim() : `特殊${i}`);
      }

      SEGMENT_NAMES = [""];
      for (let i = 0; i < 99; i++) {
        const segName = pakTextLines[26 + i];
        if (segName && segName.trim() !== "") {
          SEGMENT_NAMES.push(segName.trim());
        } else {
          break;
        }
      }
      logMsg(`文字訊息更新成功！共 ${SEGMENT_NAMES.length - 1} 個地段。`);
    }
  }

  setTimeout(runValidation, 100);
  checkAndRenderRealMap();
}

(window as any)._rawDskBuffer = rawDskBuffer;

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    const targetBtn = e.currentTarget as HTMLElement;
    const tabId = targetBtn.dataset.tab;
    if (!tabId) return;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    targetBtn.classList.add('active');
    const tabEl = document.getElementById(tabId);
    if (tabEl) tabEl.classList.add('active');
    if (tabId === 'tabWarn') runValidation();
  });
});

function getSegName(segId: number): string {
  if (segId <= 0) return '';
  if (segId < SEGMENT_NAMES.length) return SEGMENT_NAMES[segId];
  return extraSegNames[segId] || `地段${segId}`;
}

function calcSegmentOrder(segId: number, locId: number): number {
  if (!locDataView || segId <= 0 || locId <= 0) return 0;
  let order = 1;
  for (let i = 1; i < LOC_COUNT; i++) {
    if (i === locId) continue;
    if (getLocField(LOC_FIELDS.SEGMENT, i) === segId) order++;
  }
  return order;
}

function inferSegmentSharedField(segId: number, field: number, fallback: number): number {
  if (!locDataView || segId <= 0) return fallback;
  const counter = new Map<number, number>();
  for (let i = 1; i < LOC_COUNT; i++) {
    if (getLocField(LOC_FIELDS.SEGMENT, i) !== segId) continue;
    const v = getLocField(field, i);
    counter.set(v, (counter.get(v) || 0) + 1);
  }
  if (counter.size === 0) return fallback;
  return [...counter.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function detectMarkerDir(baseLocId: number): number {
  const marker = baseLocId + 950;
  let baseIdx = -1;
  let markerIdx = -1;
  for (let i = 0; i < mapGrid.length; i++) {
    if (mapGrid[i] === baseLocId) baseIdx = i;
    if (mapGrid[i] === marker) markerIdx = i;
  }
  if (baseIdx < 0 || markerIdx < 0) return 0;
  const bx = baseIdx % GRID_COLS, by = Math.floor(baseIdx / GRID_COLS);
  const mx = markerIdx % GRID_COLS, my = Math.floor(markerIdx / GRID_COLS);
  if (mx < bx && my === by) return 1;
  if (my < by && mx === bx) return 2;
  if (mx > bx && my === by) return 3;
  if (my > by && mx === bx) return 4;
  return 0;
}

function dirLabel(dir: number): string {
  return dir === 1 ? '左' : dir === 2 ? '上' : dir === 3 ? '右' : dir === 4 ? '下' : '無';
}

function applyFieldToSegment(segId: number, field: number, val: number): void {
  if (!locDataView || segId <= 0) return;
  for (let i = 1; i < LOC_COUNT; i++) {
    if (getLocField(LOC_FIELDS.SEGMENT, i) === segId) setLocField(field, i, val);
  }
}

function applySegmentDerivedFields(locId: number, segId: number): void {
  if (!locDataView || locId <= 0 || segId <= 0) return;
  setLocField(LOC_FIELDS.SEGMENT, locId, segId);
  setLocField(LOC_FIELDS.UNK9, locId, calcSegmentOrder(segId, locId));

  const unkaInput = document.getElementById('editUnkA') as HTMLInputElement | null;
  const unkbInput = document.getElementById('editUnkB') as HTMLInputElement | null;
  const unka = (unkaInput && unkaInput.value !== '') ? (parseInt(unkaInput.value) || 0) : inferSegmentSharedField(segId, LOC_FIELDS.UNKA, 1);
  const unkb = (unkbInput && unkbInput.value !== '') ? (parseInt(unkbInput.value) || 0) : inferSegmentSharedField(segId, LOC_FIELDS.UNKB, 1);
  setLocField(LOC_FIELDS.UNKA, locId, unka);
  setLocField(LOC_FIELDS.UNKB, locId, unkb);

  const dir = detectMarkerDir(locId);
  if (dir > 0) setLocField(LOC_FIELDS.UNK3, locId, dir);
}

function getSpecialName(spId: number): string {
  // 改成 >= 0，把 ID 0 給放行！
  return (spId >= 0 && spId < SPECIAL_NAMES.length) ? SPECIAL_NAMES[spId] : '';
}

(document.getElementById('editSpecial') as HTMLInputElement).addEventListener('change', function (e: Event) {
  if (selectedGridX < 0) return;
  const target = e.target as HTMLInputElement;
  const locId = mapGrid[selectedGridY * GRID_COLS + selectedGridX];
  const spId = parseInt(target.value) || 0;
  (document.getElementById('specialNameDisplay') as HTMLSpanElement).textContent = (locId > 0 && locId <= 50) ? getSpecialName(spId) : '';
  if (locId > 0 && locData) setLocField(LOC_FIELDS.SPECIAL, locId, spId);
});

const extraSegNames: Record<number, string> = {};
const extraPriceData: Record<number, Record<number, number>> = {};

(document.getElementById('addSegBtn') as HTMLButtonElement).addEventListener('click', function () {
  if (!locData) { logMsg('請先載入 DSK！'); return; }

  // 掃描目前被使用的地段編號
  const usedSegs = new Set<number>();
  for (let i = 1; i < LOC_COUNT; i++) {
    const seg = getLocField(LOC_FIELDS.SEGMENT, i);
    if (seg > 0) usedSegs.add(seg);
  }

  // 找第一個空的 slot（1～44 裡沒被用到的）
  let newSegId = -1;
  for (let i = 1; i <= 44; i++) {
    if (!usedSegs.has(i)) { newSegId = i; break; }
  }

  if (newSegId === -1) { logMsg('地段已全滿（1～44 全部使用中）！'); return; }

  const name = prompt(`新地段編號 ${newSegId}，請輸入名稱：`, `地段${newSegId}`);
  if (!name) return;

  // 更新 SEGMENT_NAMES（確保陣列夠長）
  while (SEGMENT_NAMES.length <= newSegId) SEGMENT_NAMES.push('');
  SEGMENT_NAMES[newSegId] = name;

  // 更新 pakTextLines（index = 25 + newSegId）
  pakTextLines[25 + newSegId] = '             ' + name;  // 13個空白
  SEGMENT_NAMES[newSegId] = name;  // UI顯示用，不需要空白

  // 套用到目前選取的格子
  if (selectedGridX >= 0) {
    const locId = mapGrid[selectedGridY * GRID_COLS + selectedGridX];
    (document.getElementById('editSegId') as HTMLInputElement).value = newSegId.toString();
    (document.getElementById('segNameDisplay') as HTMLSpanElement).textContent = name;
    if (locId > 0 && locData) {
      applySegmentDerivedFields(locId, newSegId);
      (document.getElementById('editUnk9') as HTMLInputElement).value = getLocField(LOC_FIELDS.UNK9, locId).toString();
      (document.getElementById('editUnkA') as HTMLInputElement).value = getLocField(LOC_FIELDS.UNKA, locId).toString();
      (document.getElementById('editUnkB') as HTMLInputElement).value = getLocField(LOC_FIELDS.UNKB, locId).toString();
      (document.getElementById('editUnk3') as HTMLSelectElement).value = getLocField(LOC_FIELDS.UNK3, locId).toString();
      const suggest = detectMarkerDir(locId);
      (document.getElementById('unk3Hint') as HTMLSpanElement).textContent = `建議方向：${dirLabel(suggest)} (${suggest})`;
      renderPriceTable(newSegId);
    }
  }
  logMsg(`成功新增地段 ${newSegId}：${name}`);
});

function getPriceField(fieldIdx: number, segId: number): number {
  if (!priceDataView || segId <= 0 || segId >= PRICE_SEG_COUNT) return 0;
  return priceDataView.getUint16(fieldIdx * PRICE_FIELD_SIZE + segId * 2, true);
}

function setPriceField(fieldIdx: number, segId: number, val: number): void {
  if (!priceDataView || segId <= 0 || segId >= PRICE_SEG_COUNT) return;
  console.log(`setPriceField fi=${fieldIdx} seg=${segId} val=${val}`);  // 加這行
  priceDataView.setUint16(fieldIdx * PRICE_FIELD_SIZE + segId * 2, val, true);
}

let currentPriceSeg = 0; // 記住價格頁目前顯示的地段，給「複製價格」按鈕用

// 過路費是逐段手工設定的（沒有固定倍率），所以用「複製現有地段的完整價格結構」比套公式可靠。
// 複製欄位 0~7（土地價/增值價/空地~五層過路費）；欄位 8、9 不動。回傳複製了幾項。
function copySegmentPrices(fromSeg: number, toSeg: number): number {
  if (!priceDataView) return 0;
  if (fromSeg <= 0 || fromSeg >= PRICE_SEG_COUNT || toSeg <= 0 || toSeg >= PRICE_SEG_COUNT || fromSeg === toSeg) return 0;
  let n = 0;
  for (let f = 0; f <= 7; f++) { setPriceField(f, toSeg, getPriceField(f, fromSeg)); n++; }
  return n;
}

function renderPriceTable(segId: number): void {
  currentPriceSeg = segId;
  (document.getElementById('priceSegLabel') as HTMLSpanElement).textContent =
    segId > 0 ? `${segId} - ${getSegName(segId)}` : '無（非土地）';
  const tbody = document.getElementById('priceTbody') as HTMLTableSectionElement;
  tbody.innerHTML = '';
  if (segId <= 0) {
    tbody.innerHTML = '<tr><td colspan="2" class="px-3 py-4 text-center text-on-surface-variant/50 italic">此格非土地</td></tr>';
    return;
  }
  const isExtra = segId >= PRICE_SEG_COUNT;
  PRICE_FIELDS.forEach((label, fi) => {
    // 靠背，這裡直接把欄位 8 和欄位 9 濾掉不顯示
    if (fi === 8 || fi === 9) return;

    let val: number;
    if (isExtra) {
      val = (extraPriceData[segId] && extraPriceData[segId][fi] != null) ? extraPriceData[segId][fi] : 0;
    } else {
      val = priceData ? getPriceField(fi, segId) : 0;
    }
    const tr = document.createElement('tr');

    // --- 這裡修改：加入樣式與對齊 ---
    tr.innerHTML = `
      <td class="px-3 py-2 text-on-surface-variant">${label}</td>
      <td class="px-3 py-2 text-right">
        <input type="number" min="0" max="65535" value="${val}" 
               data-fi="${fi}" data-seg="${segId}" data-extra="${isExtra ? 1 : 0}"
               class="bg-surface-container-lowest border border-outline-variant/30 rounded text-right px-2 py-1 focus:ring-1 focus:ring-primary outline-none">
      </td>
    `;
    tbody.appendChild(tr);
  });

  // 底下的事件監聽維持原樣即可
  tbody.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement;
      const fi = parseInt(target.dataset.fi || '0');
      const seg = parseInt(target.dataset.seg || '0');
      const v = parseInt(target.value) || 0;
      if (target.dataset.extra === '1') {
        if (!extraPriceData[seg]) extraPriceData[seg] = {};
        extraPriceData[seg][fi] = v;
      } else {
        setPriceField(fi, seg, v);
      }
    });
  });
}

let warnings: WarningMsg[] = [];
function runValidation(): void {
  warnings = [];
  if (!isSaveLoaded || !locData) { renderWarnList(); return; }

  const locUsage: Record<number, number[]> = {};
  for (let i = 0; i < GRID_COLS * GRID_ROWS; i++) {
    const lid = mapGrid[i];
    if (lid === 0) continue;
    if (!locUsage[lid]) locUsage[lid] = [];
    locUsage[lid].push(i);
  }

  for (const [lidStr, cells] of Object.entries(locUsage)) {
    const lid = parseInt(lidStr);
    if (cells.length > 1) {
      const coords = cells.map(ci => `(${ci % GRID_COLS},${Math.floor(ci / GRID_COLS)})`).join(', ');
      warnings.push({ type: 'dup', cells, msg: `地點 ${lid} 重複用於 ${coords}` });
    }
  }

  // 註：原本這裡有一個「方向指標必須等於 grid 鄰格」的檢查，但大富翁的移動是
  // 有向路徑圖（路口/轉角合法地不相鄰），該假設在正常地圖上會狂噴假警報，已移除。
  // 真正可靠的「指向不存在地點」由下方 integrity 的 dangling-ref 負責。

  // === 結構完整性檢查（integrity.ts）：抓引擎會崩的真實損毀 ===
  if (locDataView) {
    const issues = analyzeIntegrity(mapGrid, locDataView, getSpecialBoundary(), priceDataView);
    for (const iss of issues) {
      const cells: number[] = [];
      for (let i = 0; i < mapGrid.length; i++) if (mapGrid[i] === iss.locId) { cells.push(i); break; }
      warnings.push({ type: iss.kind, cells, msg: `【完整性/${iss.kind}】${iss.detail}` });
    }
  }

  const warnTab = document.querySelector('[data-tab="tabWarn"]') as HTMLDivElement;
  if (warnTab) {
    warnTab.textContent = warnings.length > 0 ? `⚠ 警告 (${warnings.length})` : '✅ 無警告';
  }
  renderWarnList();
}

// 土地 vs 特殊/道路的分界：引擎寫死「地點編號 ≤ 49 = 特殊/非土地、≥ 50 = 土地」，
// 三張圖都一樣（不是 per-map，也不是 [0x1098]）。分界值回傳 49（id>49 視為土地）。
const LAND_ID_BOUNDARY = 49;
function getSpecialBoundary(): number {
  return LAND_ID_BOUNDARY;
}

function renderWarnList(): void {
  const list = document.getElementById('warnList') as HTMLDivElement;
  if (warnings.length === 0) { list.innerHTML = '<div style="color:#4ec9b0">✅ 目前無警告</div>'; return; }
  list.innerHTML = '';
  warnings.forEach(w => {
    const div = document.createElement('div');
    div.textContent = w.msg;
    div.addEventListener('click', () => {
      if (w.cells && w.cells.length > 0) {
        const ci = w.cells[0];
        const gx = ci % GRID_COLS, gy = Math.floor(ci / GRID_COLS);
        simulateSelectCell(gx, gy);
      }
    });
    list.appendChild(div);
  });
}

function getLocField(field_offset: number, loc_id: number): number {
  if (!locDataView || loc_id <= 0 || loc_id >= LOC_COUNT) return 0;
  return locDataView.getUint16(field_offset + loc_id * 2, true);
}

function setLocField(field_offset: number, loc_id: number, val: number): void {
  if (!locDataView || loc_id <= 0 || loc_id >= LOC_COUNT) return;
  locDataView.setUint16(field_offset + loc_id * 2, val, true);
}

function simulateSelectCell(gx: number, gy: number): void {
  openEditPanel(gx, gy);
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  const tabLocBtn = document.querySelector('[data-tab="tabLoc"]') as HTMLDivElement;
  if (tabLocBtn) tabLocBtn.classList.add('active');
  const tabLoc = document.getElementById('tabLoc');
  if (tabLoc) tabLoc.classList.add('active');
}

function openEditPanel(gridX: number, gridY: number): void {
  selectedGridX = gridX;
  selectedGridY = gridY;

  const cellIndex = gridY * GRID_COLS + gridX;
  const locId = mapGrid[cellIndex];
  const tileId = mapLayout[cellIndex];

  // === 替換為以下新增部份 ===
  let typeStr = '非地點';
  if (locId > 950) {
    typeStr = '土地';
  } else if (locId > 50) {
    typeStr = '道路';
  } else if (locId > 0) {
    typeStr = '特殊地點';
  }

  checkAndRenderRealMap();
  ctx.strokeStyle = '#e51400';
  ctx.lineWidth = 2;
  ctx.strokeRect(gridX * TILE_W, gridY * TILE_H, TILE_W, TILE_H);
  ctx.lineWidth = 1;

  const spId = locId > 0 && locData ? getLocField(LOC_FIELDS.SPECIAL, locId) : 0;
  const segId2 = locId > 0 && locData ? getLocField(LOC_FIELDS.SEGMENT, locId) : 0;
  // === 在 main.ts 找到 openEditPanel 內這段並替換 ===
  infoBox.innerHTML = `
  <div class="flex justify-between border-b border-outline-variant/20 pb-1 mb-2">
    <span class="text-on-surface-variant">網格</span>
    <span class="font-bold text-primary">(${gridX}, ${gridY})</span>
  </div>
  <div class="flex justify-between">
    <span class="text-on-surface-variant">地點編號</span>
    <span class="font-bold">${locId}</span>
  </div>
  <div class="flex justify-between">
    <span class="text-on-surface-variant">圖塊代號</span>
    <span class="font-bold">${tileId}</span>
  </div>
  <div class="flex justify-between">
    <span class="text-on-surface-variant">屬性</span>
    <span class="font-bold" style="color:#d16969">${typeStr}</span>
  </div>
  ${(locId > 0 && locId <= 50) ? `
  <div class="flex justify-between text-tertiary">
    <span>名稱</span>
    <span class="font-bold">${getSpecialName(spId)}(${spId})</span>
  </div>` : ''}
  ${segId2 > 0 ? `
  <div class="flex justify-between text-primary">
    <span>地段</span>
    <span class="font-bold">${segId2} ${getSegName(segId2)}</span>
  </div>` : ''}
`;

  (document.getElementById('editPanel') as HTMLDivElement).style.display = 'block';
  (document.getElementById('editTitle') as HTMLHeadingElement).textContent = `編輯 (${gridX}, ${gridY})  地點 ${locId}`;

  // ▲▲▲ 替換成這樣 ▲▲▲
  if (mapTilesData.length > 0) {
    // 初始化選擇器，並把「替換圖塊」的邏輯當作 Callback 傳進去
    initTilePicker(mapTilesData, palette, TILE_W, TILE_H, (selectedTile: number) => {
      if (selectedGridX >= 0) {
        // 更新地圖排版陣列
        mapLayout[selectedGridY * GRID_COLS + selectedGridX] = selectedTile;
        // 重新渲染真正的地圖
        checkAndRenderRealMap();
        // 在地圖上畫紅框提示
        ctx.strokeStyle = '#e51400';
        ctx.lineWidth = 2;
        ctx.strokeRect(selectedGridX * TILE_W, selectedGridY * TILE_H, TILE_W, TILE_H);
        ctx.lineWidth = 1;
      }
    });

    // 自動更新 UI 紅框與捲動位置
    updateTilePickerSelection(tileId);
  }

  // 幹，這裡把你漏掉的 UI 連動更新補上
  (document.getElementById('editLocId') as HTMLInputElement).value = locId.toString();
  if (locId > 0 && locData) {
    const segId = getLocField(LOC_FIELDS.SEGMENT, locId);
    const spId = getLocField(LOC_FIELDS.SPECIAL, locId);
    (document.getElementById('editSegId') as HTMLInputElement).value = segId.toString();
    (document.getElementById('segNameDisplay') as HTMLSpanElement).textContent = getSegName(segId);
    (document.getElementById('editSpecial') as HTMLInputElement).value = spId.toString();
    (document.getElementById('specialNameDisplay') as HTMLSpanElement).textContent = (locId > 0 && locId <= 50) ? getSpecialName(spId) : '';
    (document.getElementById('editUnk9') as HTMLInputElement).value = getLocField(LOC_FIELDS.UNK9, locId).toString();
    (document.getElementById('editUnkA') as HTMLInputElement).value = getLocField(LOC_FIELDS.UNKA, locId).toString();
    (document.getElementById('editUnkB') as HTMLInputElement).value = getLocField(LOC_FIELDS.UNKB, locId).toString();
    const unk3 = getLocField(LOC_FIELDS.UNK3, locId);
    (document.getElementById('editUnk3') as HTMLSelectElement).value = unk3.toString();
    const suggest = detectMarkerDir(locId);
    (document.getElementById('unk3Hint') as HTMLSpanElement).textContent = `建議方向：${dirLabel(suggest)} (${suggest})`;

    // 只處理你新增的不明欄位，避開 3, 9, A, B
    ['UnkD', 'Unk10', 'Unk11', 'Unk12', 'Unk13'].forEach(suffix => {
      const el = document.getElementById(`edit${suffix}`) as HTMLInputElement;
      if (el) {
        const fieldKey = suffix.toUpperCase(); // 轉回大寫 UNKD 去對應 LOC_FIELDS
        el.value = getLocField(LOC_FIELDS[fieldKey as keyof typeof LOC_FIELDS], locId).toString();
      }
    });
    (document.getElementById('editDirLeft') as HTMLInputElement).value = getLocField(LOC_FIELDS.LEFT, locId).toString();
    (document.getElementById('editDirUp') as HTMLInputElement).value = getLocField(LOC_FIELDS.UP, locId).toString();
    (document.getElementById('editDirRight') as HTMLInputElement).value = getLocField(LOC_FIELDS.RIGHT, locId).toString();
    (document.getElementById('editDirDown') as HTMLInputElement).value = getLocField(LOC_FIELDS.DOWN, locId).toString();
    renderPriceTable(segId);
  } else {
    [
      'editSegId', 'editSpecial', 'editUnk9', 'editUnkA', 'editUnkB', 'editUnk3',
      'editDirLeft', 'editDirUp', 'editDirRight', 'editDirDown',
      'editUnkD', 'editUnk10', 'editUnk11', 'editUnk12', 'editUnk13'
    ].forEach(id => {
      const el = document.getElementById(id) as HTMLInputElement;
      if (el) el.value = '0';
    });
    (document.getElementById('segNameDisplay') as HTMLSpanElement).textContent = '';
    (document.getElementById('specialNameDisplay') as HTMLSpanElement).textContent = '';
    (document.getElementById('unk3Hint') as HTMLSpanElement).textContent = '建議方向：-';
    renderPriceTable(0);
  }
  validateDirWarnings(locId, gridX, gridY);
}

function setLocWithCoords(locId: number, _gridX: number, _gridY: number): void {
  if (locId <= 0 || !locData) return;
  // 座標永遠同步成該地點在 grid 上所有格子的「左上角」(min gx, min gy)，
  // 這是引擎存 X/Y 的方式；不再只在 0 時才寫，避免移動地點留下重複/殘留座標。
  let minX = GRID_COLS, minY = GRID_ROWS, found = false;
  for (let i = 0; i < mapGrid.length; i++) {
    if (mapGrid[i] !== locId) continue;
    found = true;
    const gx = i % GRID_COLS, gy = Math.floor(i / GRID_COLS);
    if (gx < minX) minX = gx;
    if (gy < minY) minY = gy;
  }
  if (!found) return;
  if (getLocField(LOC_FIELDS.X, locId) !== minX || getLocField(LOC_FIELDS.Y, locId) !== minY) {
    setLocField(LOC_FIELDS.X, locId, minX);
    setLocField(LOC_FIELDS.Y, locId, minY);
    logMsg(`地點 ${locId} 座標同步為 (${minX}, ${minY})`);
  }
}

(document.getElementById('editLocId') as HTMLInputElement).addEventListener('change', function (e: Event) {
  if (selectedGridX < 0) return;
  const target = e.target as HTMLInputElement;
  const newLocId = parseInt(target.value) || 0;
  mapGrid[selectedGridY * GRID_COLS + selectedGridX] = newLocId;
  setLocWithCoords(newLocId, selectedGridX, selectedGridY);
  (document.getElementById('editTitle') as HTMLHeadingElement).textContent = `編輯 (${selectedGridX}, ${selectedGridY})  地點 ${newLocId}`;
  if (newLocId > 0 && locData) {
    const segId = getLocField(LOC_FIELDS.SEGMENT, newLocId);  // ← locId → newLocId
    const spId = getLocField(LOC_FIELDS.SPECIAL, newLocId);   // ← locId → newLocId
    if (segId > 0) applySegmentDerivedFields(newLocId, segId);
    (document.getElementById('editSegId') as HTMLInputElement).value = segId.toString();
    (document.getElementById('segNameDisplay') as HTMLSpanElement).textContent = getSegName(segId);
    (document.getElementById('editSpecial') as HTMLInputElement).value = spId.toString();
    (document.getElementById('specialNameDisplay') as HTMLSpanElement).textContent = (newLocId > 0 && newLocId <= 50) ? getSpecialName(spId) : '';
    (document.getElementById('editUnk9') as HTMLInputElement).value = getLocField(LOC_FIELDS.UNK9, newLocId).toString();
    (document.getElementById('editUnkA') as HTMLInputElement).value = getLocField(LOC_FIELDS.UNKA, newLocId).toString();
    (document.getElementById('editUnkB') as HTMLInputElement).value = getLocField(LOC_FIELDS.UNKB, newLocId).toString();
    const unk3 = getLocField(LOC_FIELDS.UNK3, newLocId);
    (document.getElementById('editUnk3') as HTMLSelectElement).value = unk3.toString();
    const suggest = detectMarkerDir(newLocId);
    (document.getElementById('unk3Hint') as HTMLSpanElement).textContent = `建議方向：${dirLabel(suggest)} (${suggest})`;
    (document.getElementById('editDirLeft') as HTMLInputElement).value = getLocField(LOC_FIELDS.LEFT, newLocId).toString();   // ← locId → newLocId
    (document.getElementById('editDirUp') as HTMLInputElement).value = getLocField(LOC_FIELDS.UP, newLocId).toString();       // ← locId → newLocId
    (document.getElementById('editDirRight') as HTMLInputElement).value = getLocField(LOC_FIELDS.RIGHT, newLocId).toString(); // ← locId → newLocId
    (document.getElementById('editDirDown') as HTMLInputElement).value = getLocField(LOC_FIELDS.DOWN, newLocId).toString();   // ← locId → newLocId
  } else {
    ['editSegId', 'editSpecial', 'editUnk9', 'editUnkA', 'editUnkB', 'editUnk3', 'editDirLeft', 'editDirUp', 'editDirRight', 'editDirDown'].forEach(id => {
      (document.getElementById(id) as HTMLInputElement).value = '0';
    });
    (document.getElementById('segNameDisplay') as HTMLSpanElement).textContent = '';
    (document.getElementById('specialNameDisplay') as HTMLSpanElement).textContent = '';
    (document.getElementById('unk3Hint') as HTMLSpanElement).textContent = '建議方向：-';
  }

  const segForPrice = newLocId > 0 ? getLocField(LOC_FIELDS.SEGMENT, newLocId) : 0;  // ← locId → newLocId
  renderPriceTable(segForPrice);

  validateDirWarnings(newLocId, selectedGridX, selectedGridY);  // ← locId/gridX/gridY 全換
});

(document.getElementById('editSegId') as HTMLInputElement).addEventListener('change', function (e: Event) {
  if (selectedGridX < 0) return;
  const target = e.target as HTMLInputElement;
  const locId = mapGrid[selectedGridY * GRID_COLS + selectedGridX];
  const segId = parseInt(target.value) || 0;
  (document.getElementById('segNameDisplay') as HTMLSpanElement).textContent = getSegName(segId);
  if (locId > 0) {
    if (segId > 0) {
      applySegmentDerivedFields(locId, segId);
      (document.getElementById('editUnk9') as HTMLInputElement).value = getLocField(LOC_FIELDS.UNK9, locId).toString();
      (document.getElementById('editUnkA') as HTMLInputElement).value = getLocField(LOC_FIELDS.UNKA, locId).toString();
      (document.getElementById('editUnkB') as HTMLInputElement).value = getLocField(LOC_FIELDS.UNKB, locId).toString();
      (document.getElementById('editUnk3') as HTMLSelectElement).value = getLocField(LOC_FIELDS.UNK3, locId).toString();
      const suggest = detectMarkerDir(locId);
      (document.getElementById('unk3Hint') as HTMLSpanElement).textContent = `建議方向：${dirLabel(suggest)} (${suggest})`;
    } else {
      setLocField(LOC_FIELDS.SEGMENT, locId, 0);
    }
    renderPriceTable(segId);
  }
});

(document.getElementById('editUnk9') as HTMLInputElement).addEventListener('change', function (e: Event) {
  if (selectedGridX < 0) return;
  const locId = mapGrid[selectedGridY * GRID_COLS + selectedGridX];
  if (locId > 0) setLocField(LOC_FIELDS.UNK9, locId, parseInt((e.target as HTMLInputElement).value) || 0);
});

(document.getElementById('editUnkA') as HTMLInputElement).addEventListener('change', function (e: Event) {
  if (selectedGridX < 0) return;
  const locId = mapGrid[selectedGridY * GRID_COLS + selectedGridX];
  if (locId > 0) {
    const segId = getLocField(LOC_FIELDS.SEGMENT, locId);
    const v = parseInt((e.target as HTMLInputElement).value) || 0;
    if (segId > 0) applyFieldToSegment(segId, LOC_FIELDS.UNKA, v);
    else setLocField(LOC_FIELDS.UNKA, locId, v);
  }
});

(document.getElementById('editUnkB') as HTMLInputElement).addEventListener('change', function (e: Event) {
  if (selectedGridX < 0) return;
  const locId = mapGrid[selectedGridY * GRID_COLS + selectedGridX];
  if (locId > 0) {
    const segId = getLocField(LOC_FIELDS.SEGMENT, locId);
    const v = parseInt((e.target as HTMLInputElement).value) || 0;
    if (segId > 0) applyFieldToSegment(segId, LOC_FIELDS.UNKB, v);
    else setLocField(LOC_FIELDS.UNKB, locId, v);
  }
});

(document.getElementById('editUnk3') as HTMLSelectElement).addEventListener('change', function (e: Event) {
  if (selectedGridX < 0) return;
  const locId = mapGrid[selectedGridY * GRID_COLS + selectedGridX];
  if (locId > 0) {
    const v = parseInt((e.target as HTMLSelectElement).value) || 0;
    setLocField(LOC_FIELDS.UNK3, locId, v);
  }
});

function dirInputHandler(fieldConst: number) {
  return function (e: Event) {
    if (selectedGridX < 0) return;
    const target = e.target as HTMLInputElement;
    const locId = mapGrid[selectedGridY * GRID_COLS + selectedGridX];
    if (locId > 0) { setLocField(fieldConst, locId, parseInt(target.value) || 0); }
    validateDirWarnings(locId, selectedGridX, selectedGridY);
  };
}
(document.getElementById('editDirLeft') as HTMLInputElement).addEventListener('change', dirInputHandler(LOC_FIELDS.LEFT));
(document.getElementById('editDirUp') as HTMLInputElement).addEventListener('change', dirInputHandler(LOC_FIELDS.UP));
(document.getElementById('editDirRight') as HTMLInputElement).addEventListener('change', dirInputHandler(LOC_FIELDS.RIGHT));
(document.getElementById('editDirDown') as HTMLInputElement).addEventListener('change', dirInputHandler(LOC_FIELDS.DOWN));

function validateDirWarnings(locId: number, _gx: number, _gy: number): void {
  const msgs: string[] = [];
  const warnMsgEl = document.getElementById('dirWarnMsg') as HTMLDivElement;
  if (locId <= 0 || !locData) { warnMsgEl.textContent = ''; return; }
  // 只提示「指向的地點不在地圖上」(幽靈地點)——這才是會害引擎走進未定義地點的真問題。
  // 不再檢查方向指標是否等於 grid 鄰格（路口/轉角合法地不相鄰，那是假警報）。
  const dirs = [
    { label: '左', field: LOC_FIELDS.LEFT },
    { label: '右', field: LOC_FIELDS.RIGHT },
    { label: '上', field: LOC_FIELDS.UP },
    { label: '下', field: LOC_FIELDS.DOWN },
  ];
  dirs.forEach(d => {
    const target = getLocField(d.field, locId);
    if (target === 0) return;
    let onGrid = false;
    for (let i = 0; i < mapGrid.length; i++) { if (mapGrid[i] === target) { onGrid = true; break; } }
    if (!onGrid) msgs.push(`⚠ 往${d.label}→${target}，但 ${target} 不在地圖上（幽靈地點）`);
  });
  warnMsgEl.textContent = msgs.join('　');
}

canvas.addEventListener('mousedown', function (e: MouseEvent) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = (e.clientX - rect.left) * scaleX;
  const y = (e.clientY - rect.top) * scaleY;

  const gridX = Math.floor(x / TILE_W);
  const gridY = Math.floor(y / TILE_H);
  if (gridX < 0 || gridX >= GRID_COLS || gridY < 0 || gridY >= GRID_ROWS) return;

  openEditPanel(gridX, gridY);
});

function rebuildDskBuffer(): ArrayBuffer | null {
  if (!rawDskBuffer) return null;

  // 處理額外增加的地段價格資料
  let finalPriceData = priceData;
  if (priceData && Object.keys(extraPriceData).length > 0) {
    let maxSeg = PRICE_SEG_COUNT - 1;
    Object.keys(extraPriceData).forEach(k => { if (parseInt(k) > maxSeg) maxSeg = parseInt(k); });
    const newSegCount = maxSeg + 1;
    const newFieldSize = newSegCount * 2;
    const newPriceArr = new Uint8Array(PRICE_FIELD_COUNT * newSegCount * 2);
    const newPriceDV = new DataView(newPriceArr.buffer);

    for (let fi = 0; fi < PRICE_FIELD_COUNT; fi++) {
      for (let si = 0; si < PRICE_SEG_COUNT; si++) {
        if (priceDataView) {
          newPriceDV.setUint16(fi * newFieldSize + si * 2, priceDataView.getUint16(fi * PRICE_FIELD_SIZE + si * 2, true), true);
        }
      }
    }
    Object.entries(extraPriceData).forEach(([segStr, fields]) => {
      const si = parseInt(segStr);
      Object.entries(fields).forEach(([fiStr, v]) => {
        newPriceDV.setUint16(parseInt(fiStr) * newFieldSize + si * 2, v, true);
      });
    });
    finalPriceData = newPriceArr;
    priceData = newPriceArr;
    priceDataView = newPriceDV;
  }

  return rebuildDskBufferCore(rawDskBuffer, dskGroupPointers, mapLayout, locData, finalPriceData, logMsg);
}

function downloadBuffer(buffer: ArrayBuffer, filename: string): void {
  const blob = new Blob([buffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

(document.getElementById('exportDskBtn') as HTMLButtonElement).addEventListener('click', function () {
  if (!isSaveLoaded) { logMsg("還沒載入 DSK！"); return; }
  const syncFn = (window as any).syncMarkerTilesFromOwnership;
  if (typeof syncFn === 'function') {
    const touched = syncFn(1, 2);
    logMsg(`匯出前自動同步購地標記圖塊：${touched} 格。`);
  }
  // 匯出前結構完整性掃描：有問題就警告（不擋，讓你自行決定）
  if (locDataView) {
    const issues = analyzeIntegrity(mapGrid, locDataView, getSpecialBoundary(), priceDataView);
    if (issues.length) {
      logMsg(`⚠ 偵測到 ${issues.length} 個結構問題（詳見「警告」頁），遊戲可能出錯：`);
      issues.slice(0, 8).forEach(i => logMsg(`　・${i.detail}`));
    } else {
      logMsg('✅ 結構完整性檢查通過。');
    }
  }
  const buf = rebuildDskBuffer();
  if (buf) {
    // 把這裡寫死的字串換成變數！
    downloadBuffer(buf, loadedDskFileName);
    logMsg(`${loadedDskFileName} 匯出完成！`);
  }
});

// === 新增：重建 PAK 檔案的函式 ===
function rebuildPakBuffer(): ArrayBuffer | null {
  if (!rawPakBuffer || pakGroupPointers.length < 2) {
    logMsg("靠北，PAK 還沒載入！");
    return null;
  }

  let curBytes = new Uint8Array(rawPakBuffer);
  let curPtrs = pakGroupPointers.slice();

  // 1. 打包地圖邏輯座標 (第 2 組，陣列 index 1)
  const gridBytes = new Uint8Array(1296 * 2);
  const gridDv = new DataView(gridBytes.buffer);
  for (let i = 0; i < 1296; i++) {
    gridDv.setUint16(i * 2, mapGrid[i], true);
  }

  // 直接借用 replaceGroupInDsk，因為 PAK 和 DSK 的封裝結構一模一樣
  // (如果你把這函式搬到 parser.ts 了，記得確認上面有 import 進來)
  const r1 = replaceGroupInDsk(curBytes, curPtrs, 1, gridBytes);
  curBytes = r1.bytes;
  curPtrs = r1.ptrs;
  logMsg("PAK 地圖座標已重新壓縮。");

  // 2. 打包文字訊息 (第 3 組，陣列 index 2) - 這樣你新增的地段名稱才會存檔！
  if (curPtrs.length >= 3 && pakTextLines.length > 0) {
    // DOS 遊戲通常使用 \r 斷行
    const textContent = pakTextLines.join('\r');
    const textBytes = new Uint8Array(iconv.encode(textContent, 'big5'));
    const r2 = replaceGroupInDsk(curBytes, curPtrs, 2, textBytes);
    curBytes = r2.bytes;
    curPtrs = r2.ptrs;
    logMsg("PAK 文字訊息已重新壓縮。");
  }

  logMsg(`PAK 重建完成，新大小: ${curBytes.length} bytes (原: ${rawPakBuffer.byteLength} bytes)`);
  return curBytes.buffer;
}

// === 新增：綁定匯出 PAK 按鈕的點擊事件 ===
const exportPakBtn = document.getElementById('exportPakBtn') as HTMLButtonElement;
if (exportPakBtn) {
  exportPakBtn.addEventListener('click', function () {
    if (!rawPakBuffer) {
      logMsg("還沒載入 PAK！不能空手套白狼啊！");
      return;
    }
    const buf = rebuildPakBuffer();
    if (buf) {
      // 這裡會吃你前面設好的 loadedPakFileName 動態檔名
      downloadBuffer(buf, loadedPakFileName);
      logMsg(`幹得好！${loadedPakFileName} 匯出完成！`);
    }
  });
}

(document.getElementById('syncMarkerBtn') as HTMLButtonElement).addEventListener('click', function () {
  const syncFn = (window as any).syncMarkerTilesFromOwnership;
  if (typeof syncFn !== 'function') {
    logMsg("同步函式尚未就緒（請稍後再試）");
    return;
  }
  syncFn(1, 2);
  logMsg("已依 OWNER/HOUSE 自動同步 loc+950 的購地標記圖塊。");
});

// 「修復地圖」：自動修可安全修的（座標同步、清除孤兒記錄），其餘列在警告頁
const repairMapBtn = document.getElementById('repairMapBtn');
if (repairMapBtn) {
  repairMapBtn.addEventListener('click', function () {
    if (!locDataView) { logMsg('請先載入 DSK 才能修復！'); return; }
    const { fixed, remaining } = repairMap(mapGrid, locDataView, getSpecialBoundary());
    logMsg(`🔧 修復完成：自動修正 ${fixed} 項；剩餘 ${remaining.length} 項需人工判斷（見警告頁）。`);
    checkAndRenderRealMap();
    runValidation();
  });
}

// 「複製價格」：把另一個地段的完整價格結構(土地價/增值/各級過路費)複製到目前地段
const autoFillPriceBtn = document.getElementById('autoFillPriceBtn');
if (autoFillPriceBtn) {
  autoFillPriceBtn.addEventListener('click', function () {
    if (!priceDataView) { logMsg('請先載入 DSK！'); return; }
    if (currentPriceSeg <= 0) { logMsg('請先選一個土地格（要有地段）。'); return; }
    const src = prompt(`要把哪個地段的價格複製到地段 ${currentPriceSeg}？（輸入來源地段編號 1~44）`, '');
    if (src === null) return;
    const from = parseInt(src) || 0;
    const n = copySegmentPrices(from, currentPriceSeg);
    if (n > 0) { logMsg(`已把地段 ${from} 的價格複製到地段 ${currentPriceSeg}（${n} 欄）。`); renderPriceTable(currentPriceSeg); }
    else logMsg('複製失敗：來源/目標地段無效或相同。');
  });
}

// 「新增土地」：把選取的格子做成一塊完整、可運作的買賣土地
const addLandBtn = document.getElementById('addLandBtn');
if (addLandBtn) {
  addLandBtn.addEventListener('click', function () {
    if (!locData || !locDataView) { logMsg('請先載入 DSK！'); return; }
    if (selectedGridX < 0) { logMsg('請先在地圖上點選要放土地的格子。'); return; }
    const ci = selectedGridY * GRID_COLS + selectedGridX;
    const boundary = getSpecialBoundary();

    // 決定土地編號：此格若已是道路/土地(路徑編號)就沿用（把道路轉成土地，方向沿用）；否則配一個自由編號
    const cur = mapGrid[ci];
    let base: number;
    if (cur > boundary && cur <= 282) {
      base = cur;
    } else {
      base = findFreeLandId(mapGrid, locDataView, boundary);
      if (base < 0) { logMsg('沒有可用的土地編號了（道路/土地區已滿，或需先 patch Run.exe 開放 maxLocId）。'); return; }
      mapGrid[ci] = base;
    }

    // 選地段（留空＝自動新增下一個空地段）
    const segStr = prompt('土地要屬於哪個地段編號？(1~44；留空＝自動新增下一個)', '');
    if (segStr === null) return;
    let seg = parseInt(segStr || '0');
    if (!seg) {
      const used = new Set<number>();
      for (let i = 1; i < LOC_COUNT; i++) { const s = getLocField(LOC_FIELDS.SEGMENT, i); if (s > 0) used.add(s); }
      seg = -1;
      for (let s = 1; s < PRICE_SEG_COUNT; s++) { if (!used.has(s)) { seg = s; break; } }
      if (seg < 0) { logMsg('地段已滿（1~44）。'); return; }
      const nm = prompt(`新地段 ${seg} 的名稱：`, `地段${seg}`);
      if (nm) { while (SEGMENT_NAMES.length <= seg) SEGMENT_NAMES.push(''); SEGMENT_NAMES[seg] = nm; pakTextLines[25 + seg] = '             ' + nm; }
    }
    if (seg < 1 || seg >= PRICE_SEG_COUNT) { logMsg(`地段 ${seg} 超出範圍 (1~44)。`); return; }

    // 基本欄位
    setLocField(LOC_FIELDS.SPECIAL, base, 0);
    setLocField(LOC_FIELDS.OWNER, base, 0);
    setLocField(LOC_FIELDS.HOUSE, base, 0);
    setLocField(LOC_FIELDS.RESERVE, base, 0);

    // 先放購地標記到相鄰空格（讓 applySegmentDerivedFields 的方向判斷讀得到）
    const markerId = base + 950;
    if (!mapGrid.some(v => v === markerId)) {
      let placed = false;
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
        const nx = selectedGridX + dx, ny = selectedGridY + dy;
        if (nx < 0 || nx >= GRID_COLS || ny < 0 || ny >= GRID_ROWS) continue;
        const nci = ny * GRID_COLS + nx;
        if (mapGrid[nci] === 0) { mapGrid[nci] = markerId; mapLayout[nci] = 1; placed = true; break; }
      }
      if (!placed) logMsg(`（找不到相鄰空格放購地標記 ${markerId}，可稍後手動放置）`);
    }

    // 地段衍生欄位 + 座標 + 方向
    applySegmentDerivedFields(base, seg);
    setLocWithCoords(base, selectedGridX, selectedGridY);
    const wired = wireDirectionsFromGrid(mapGrid, locDataView, base);
    logMsg(`土地 ${base}（地段 ${seg}）已建立；自動接方向：${wired.map(w => w.dir + '→' + w.tgt).join('、') || '（無相鄰路徑，請手動接方向）'}`);

    // 確保地段有土地買價
    if (priceDataView && getPriceField(0, seg) === 0) {
      const pStr = prompt(`地段 ${seg} 尚無土地買價，請輸入土地價格：`, '600');
      const p = parseInt(pStr || '0') || 0;
      if (p > 0) setPriceField(0, seg, p);
    }

    checkAndRenderRealMap();
    openEditPanel(selectedGridX, selectedGridY);
    runValidation();
    logMsg('✅ 新增土地完成。若「警告」頁出現死胡同/幽靈指標，代表方向還沒接好，請補齊。');
  });
}

// ============ 遊戲資料夾工作流（File System Access API）============
// 選遊戲資料夾 → 用下拉選單選地圖 → 一次性把 DSK/PAK/EXE 寫回資料夾
function applyPakBuffer(buf: ArrayBuffer, fileName: string): void {
  rawPakBuffer = buf.slice(0);
  loadedPakFileName = fileName;
  const b = document.getElementById('exportPakBtn'); if (b) b.textContent = `匯出 ${fileName}`;
  parseMapPak(new DataView(buf));
}
function applyDskBuffer(buf: ArrayBuffer, fileName: string): void {
  rawDskBuffer = buf.slice(0);
  loadedDskFileName = fileName;
  const b = document.getElementById('exportDskBtn'); if (b) b.textContent = `匯出 ${fileName}`;
  parseSaveDsk(new DataView(buf));
}
let currentMapIndex = 0;
// 自動推算「特殊地點數」= grid 上有設特殊種類(SPECIAL>0)的格子中，最大的地點編號(≤49)
function autoSpecialCount(): number {
  let maxSp = 0;
  for (let i = 0; i < mapGrid.length; i++) {
    const id = mapGrid[i];
    if (id <= 0 || id > 49) continue;
    if (locDataView && getLocField(LOC_FIELDS.SPECIAL, id) > 0 && id > maxSp) maxSp = id;
  }
  return maxSp;
}
async function loadMapFromFolder(idx: number): Promise<void> {
  const m = MAPS[idx]; if (!m) return;
  currentMapIndex = idx;
  try {
    applyPakBuffer(await readGameFile(m.pak), m.pak);
    applyDskBuffer(await readGameFile(m.dsk), m.dsk);
    logMsg(`已從遊戲資料夾載入【${m.name}】：${m.pak} + ${m.dsk}`);
    // 讀 exe 目前的特殊地點數，顯示到欄位
    try {
      const sc = await readSpecialCount(idx);
      const inp = document.getElementById('specialCountInput') as HTMLInputElement | null;
      if (inp) inp.value = sc.toString();
      logMsg(`目前【${m.name}】特殊地點數 [0x1098] = ${sc}（自動推算最大特殊編號 = ${autoSpecialCount()}）`);
    } catch { /* 沒有 exe 也沒關係 */ }
  } catch (err) {
    logMsg(`載入【${m.name}】失敗：${(err as Error).message}`);
  }
}
async function saveToGame(): Promise<void> {
  if (!hasFolder()) { logMsg('請先「選擇遊戲資料夾」。'); return; }
  if (!isSaveLoaded) { logMsg('尚未載入地圖，無法存回。'); return; }
  try {
    const syncFn = (window as any).syncMarkerTilesFromOwnership;
    if (typeof syncFn === 'function') syncFn(1, 2);
    if (locDataView) {
      const issues = analyzeIntegrity(mapGrid, locDataView, getSpecialBoundary(), priceDataView);
      if (issues.length) logMsg(`⚠ 偵測到 ${issues.length} 個結構問題（見警告頁），仍照你的意思寫回。`);
    }
    const dskBuf = rebuildDskBuffer();
    const pakBuf = rebuildPakBuffer();
    if (dskBuf) await writeGameFile(loadedDskFileName, dskBuf);
    if (pakBuf) await writeGameFile(loadedPakFileName, pakBuf);
    // 特殊地點數：讀欄位（空白＝不動 exe 的 [0x1098]）
    const scInp = document.getElementById('specialCountInput') as HTMLInputElement | null;
    const sc = scInp && scInp.value !== '' ? (parseInt(scInp.value) || 0) : undefined;
    const r = await patchExe(logMsg, currentMapIndex, sc);
    let msg = `✅ 已一次性寫回：${loadedDskFileName}、${loadedPakFileName}、Run.exe（maxLoc 更動 ${r.maxLocChanged} 圖`;
    if (r.specialChanged) msg += `；${MAPS[currentMapIndex].name} 特殊數 ${r.specialFrom}→${r.specialTo}`;
    logMsg(msg + '）。');
    if (sc != null && sc > r.specialFrom) {
      logMsg(`⚠ 特殊數已調高到 ${sc}：請確認編號 1~${sc} 全是真正的特殊地點（含公園），別夾到海上道路，否則踩上去會當機。`);
    }
  } catch (err) {
    logMsg(`存回失敗：${(err as Error).message}`);
  }
}

const pickFolderBtn = document.getElementById('pickFolderBtn');
if (pickFolderBtn) {
  if (!fsSupported()) {
    (pickFolderBtn as HTMLButtonElement).disabled = true;
    pickFolderBtn.textContent = '瀏覽器不支援資料夾存取';
    logMsg('此瀏覽器不支援 File System Access API，請用 Chrome/Edge，或改用手動 LOAD/匯出。');
  } else {
    pickFolderBtn.addEventListener('click', async () => {
      try {
        const name = await pickGameFolder();
        const st = document.getElementById('folderStatus'); if (st) st.textContent = `資料夾：${name}`;
        logMsg(`已選擇遊戲資料夾：${name}`);
        const sel = document.getElementById('mapSelect') as HTMLSelectElement;
        await loadMapFromFolder(parseInt(sel.value) || 0);
      } catch (err) { logMsg(`選擇資料夾已取消或失敗：${(err as Error).message}`); }
    });
  }
}
const mapSelectEl = document.getElementById('mapSelect');
if (mapSelectEl) {
  mapSelectEl.addEventListener('change', async (e) => {
    if (!hasFolder()) { logMsg('請先「選擇遊戲資料夾」。'); return; }
    await loadMapFromFolder(parseInt((e.target as HTMLSelectElement).value) || 0);
  });
}
const saveToGameBtn = document.getElementById('saveToGameBtn');
if (saveToGameBtn) saveToGameBtn.addEventListener('click', () => { saveToGame(); });

// 「自動」：把特殊數欄位設成自動推算值（最大特殊種類編號）
const specialAutoBtn = document.getElementById('specialAutoBtn');
if (specialAutoBtn) {
  specialAutoBtn.addEventListener('click', () => {
    if (!isSaveLoaded) { logMsg('尚未載入地圖。'); return; }
    const n = autoSpecialCount();
    const inp = document.getElementById('specialCountInput') as HTMLInputElement | null;
    if (inp) inp.value = n.toString();
    logMsg(`自動推算特殊地點數 = ${n}（最大有特殊種類的編號）。存檔時會寫入 [0x1098]。`);
  });
}

// 初始化除錯與分析工具
initDebugTools({
  mapGrid,
  mapLayout,
  getLocDataView: () => locDataView,
  getPriceDataView: () => priceDataView,
  getLocField,
  setLocField,
  checkAndRenderRealMap
});

// 自動綁定所有 UNK 欄位的儲存邏輯
['UnkD', 'Unk10', 'Unk11', 'Unk12', 'Unk13'].forEach(suffix => {
  const el = document.getElementById(`edit${suffix}`);
  if (el) {
    el.addEventListener('change', (e) => {
      if (selectedGridX < 0) return;
      const locId = mapGrid[selectedGridY * GRID_COLS + selectedGridX];
      if (locId > 0) {
        const val = parseInt((e.target as HTMLInputElement).value) || 0;
        const fieldKey = suffix.toUpperCase();
        setLocField(LOC_FIELDS[fieldKey as keyof typeof LOC_FIELDS], locId, val);
      }
    });
  }
});