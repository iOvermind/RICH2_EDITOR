import iconv from 'iconv-lite';
import { Buffer } from 'buffer';
import { decompressGeneralData } from '../utils/compression';

import {
  GRID_COLS, GRID_ROWS, TILE_W, TILE_H, palette,
  PRICE_FIELD_COUNT, PRICE_SEG_COUNT, PRICE_FIELD_SIZE, PRICE_FIELDS,
  LOC_COUNT, LOC_FIELDS, LAND_TILES, MARKER_TILE, MARKER_ID_OFFSET, SPECIAL_KIND_COUNT
} from '../config/constants';
import { replaceGroupInDsk, rebuildDskBufferCore, parsePackPointers } from '../core/parser';
import { Workspace } from '../core/workspace';
import {
  analyzeIntegrity, repairMap, findFreeLandId, nextLandId, findMarkerBase, deleteLocation,
  wireDirectionsFromGrid, recomputeRouting, renumberSegment, type RoutingReport,
  scanSpecials, specialTilesOfKind, placeSpecial, type IntegrityOptions,
  scanSeaRoads, repairSeaRoads, fmtRange, MAX_LOC_ID,
} from '../core/integrity';
import {
  MAPS, CHAR_TABLE_FILE, isSupported as fsSupported, backendKind, hasFolder, pickGameFolder,
  readFile as readGameFile, tryReadFile, writeFile as writeGameFile, patchExe, readSpecialCount, readCaps,
} from '../core/gamefolder';
import { loadGlyphAtlas, atlasReady, canAddChar, addCharsToGameFont } from '../core/gamefont';
import { History } from '../core/history';
import { initTilePicker, updateTilePickerSelection } from '../ui/tilepicker';
import { initDebugTools } from '../tools/debugger';
import { MapRenderer } from '../render/renderer';


// DOM 元素綁定與型別轉換
const canvas = document.getElementById('mapCanvas') as HTMLCanvasElement;
const infoBox = document.getElementById('infoBox') as HTMLDivElement;
const cellInfo = document.getElementById('cellInfo') as HTMLDivElement;

export function getCanvas() { return canvas; }
export 
interface WarningMsg {
  type: string;
  cells: number[];
  msg: string;
}

let priceDataView: DataView | null = null;
let locDataView: DataView | null = null;
let selectedGridX: number = -1, selectedGridY: number = -1;
let loadedPakFileName: string = 'PART1.PAK';
let loadedDskFileName: string = 'SAVE_1.DSK';

// === 繪圖系統 Wrapper ===

export function logMsg(msg: string): void {
  infoBox.innerHTML += `<br>> ${msg}`;
  infoBox.scrollTop = infoBox.scrollHeight;
  // 底部狀態列跟著顯示最新一則（純文字，去掉訊息裡可能夾帶的標籤）
  const bar = document.getElementById('statusMsg');
  if (bar) bar.textContent = `> ${msg.replace(/<[^>]*>/g, '')}`;
}

// 處理 PART?.PAK 封裝資料集

export function bindDOMEvents(workspace: Workspace, renderer: MapRenderer, ctx: CanvasRenderingContext2D) {


// 處理 SAVE_?.DSK 存檔


(window as any)._rawDskBuffer = workspace.rawDskBuffer;

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
  if (segId < workspace.segmentNames.length) return workspace.segmentNames[segId];
  return extraSegNames[segId] || `地段${segId}`;
}

// ==== 遊戲字型的字表 ====
// 這款遊戲自帶字型，**只畫得出字表裡的字**。字表在 `Wor.pak`：一組乾淨的 2-byte Big5
// 陣列，原版 **639 項**（其中漢字 626），**有順序** —— 字形就是照這個順序排的。
//
// 打錯字有兩種完全不同的壞法，實測都對上了：
//
// 1. **Big5 首位元組 < 0xA1 → 位元組錯位，變成 ASCII 亂碼。**
//    字表用到的首位元組只有 0xA1~0xF9，遊戲根本不把 0x81~0xA0（Big5 罕用字／造字區）
//    當成雙位元組的開頭。實例：香港的「鰂魚湧」，「鰂」= `0x91 0x6F` → 0x91 被丟掉、
//    0x6F 當成 ASCII 印出來就是「o」，後面整串跟著錯開 → 畫面上是「o邦邦」。
//    **這種最糟**，它會把後面的排版一起弄歪。
//
// 2. **是正常 Big5（0xA1~0xF9）但不在字表裡 → 顯示成字表的最後一個字。**
//    原版 `table[638]` ＝「邦」。台灣「苗栗縣」→「邦邦縣」、香港「鰂魚湧」→「o邦邦」，
//    兩張圖的落點都是「邦」。
//
// 註：台灣也畫得出 index 638 的「邦」，而台灣自己的文字只用到 index 596 ——
// 可見**整份字形三張圖都載得到**，沒有「每張圖只載自己那一段」這回事。
const HAN = /[一-鿿]/;
const charTable: string[] = [];                       // 全表，有順序
const gameCharset = new Set<string>();                // 表內漢字，查得快
/** 字表用到的 Big5 首位元組下界。低於這個的字會讓遊戲的雙位元組解析錯位。 */
const BIG5_LEAD_MIN = 0xa1;

function hanChars(text: string): Set<string> {
  const s = new Set<string>();
  for (const ch of text) if (HAN.test(ch)) s.add(ch);
  return s;
}

interface BadChar {
  ch: string;
  /** 'desync'＝首位元組太低會錯位（最糟）；'missing'＝正常 Big5 但字表裡沒有。 */
  why: 'desync' | 'missing';
  /** 錯位時實際會被印出來的那個 ASCII 字元。 */
  asAscii?: string;
}

/** 回傳名稱中遊戲畫不出來的字。字表還沒讀到就回傳空陣列（不亂報警）。 */
function unsupportedChars(name: string): BadChar[] {
  if (gameCharset.size === 0) return [];
  const bad: BadChar[] = [];
  for (const ch of name) {
    if (!HAN.test(ch) || bad.some(b => b.ch === ch)) continue;
    const b5 = iconv.encode(ch, 'big5');
    if (b5.length === 2 && b5[0] < BIG5_LEAD_MIN) {
      const lo = b5[1];
      bad.push({ ch, why: 'desync', asAscii: lo >= 0x20 && lo < 0x7f ? String.fromCharCode(lo) : undefined });
      continue;
    }
    if (!gameCharset.has(ch)) bad.push({ ch, why: 'missing' });
  }
  return bad;
}

/**
 * 算出這個名稱在遊戲裡**實際會顯示成什麼**。
 * 規則就是上面那兩條，四個實測案例全中：
 *   深水灣→邦水灣、鰂魚湧→o邦邦、苗栗縣→邦邦縣、銅鑼灣→銅鑼灣（正常）。
 */
function previewInGame(name: string): string {
  if (charTable.length === 0) return name;
  const tail = charTable[charTable.length - 1];
  let out = '';
  for (const ch of name) {
    if (!HAN.test(ch)) { out += ch; continue; }
    const b5 = iconv.encode(ch, 'big5');
    if (b5.length === 2 && b5[0] < BIG5_LEAD_MIN) {
      out += b5[1] >= 0x20 && b5[1] < 0x7f ? String.fromCharCode(b5[1]) : '?';
    } else {
      out += gameCharset.has(ch) ? ch : tail;
    }
  }
  return out;
}

/**
 * 把缺字講成一句人看得懂的話。傳入原名稱就會順便把「遊戲實際顯示的樣子」印出來。
 *
 * 缺字現在分兩種下場：**點陣圖庫畫得出來的會在存檔時自動補進 `Wor.pak`**，
 * 所以那些字不必再嚇使用者；只有「圖庫也沒有」跟「Big5 罕用字」才是真的要換字。
 */
function unsupportedMsg(bad: BadChar[], badName = ''): string {
  if (bad.length === 0) return '';
  const tail = charTable.length ? charTable[charTable.length - 1] : '';
  const desync = bad.filter(b => b.why === 'desync');
  const miss = bad.filter(b => b.why === 'missing').map(b => b.ch);
  const fixable = atlasReady() ? miss.filter(canAddChar) : [];
  const hopeless = miss.filter(ch => !fixable.includes(ch));

  // 自動補得起來的字，遊戲最後會正常顯示，就別再拿「會變成邦」嚇人
  let s = (badName && (desync.length || hopeless.length))
    ? `　👉 遊戲裡會顯示成「${previewInGame(badName)}」。` : '';
  if (desync.length) {
    const shown = desync.map(b => `「${b.ch}」` + (b.asAscii ? `→「${b.asAscii}」` : '')).join('、');
    s += `　❌ ${shown}：這些是 Big5 罕用字（首位元組 < 0xA1），遊戲不認得雙位元組開頭，` +
      `會把低位元組當成英數字印出來，後面整串排版跟著錯開。加進字表也沒用，務必換字。`;
  }
  if (fixable.length) {
    s += `　🆕 「${fixable.join('」「')}」不在遊戲字表裡，<b>存檔時會自動用細明體補進字型</b>（${CHAR_TABLE_FILE}），補完就正常顯示。`;
  }
  if (hopeless.length) {
    s += `　⚠ 「${hopeless.join('」「')}」不在遊戲字表裡` +
      (atlasReady() ? '，點陣圖庫裡也沒有，補不進去' : '') +
      (tail ? `，會顯示成字表最後一個字「${tail}」` : '，會顯示成別的字') +
      `（三張圖都一樣）。`;
  }
  return s;
}

// ==== 地段名稱 ====
// PAK 第 3 組的文字表裡，地段名固定在 line 26~69，每行**剛好 16 字元 = 13 個前導空白 + 3 字名稱**
// （三張原版圖 44 行全部如此）。兩個字的名稱中間插一個全形空白撐滿三格，例如「衰　鬼」「中　環」。
// 寫回時必須照這個排版，否則遊戲畫面會跑掉。
const SEG_NAME_PAD = ' '.repeat(13);
const IDEO_SPACE = '　';

/** 把使用者輸入的名稱正規化成遊戲要的 3 字寬。 */
function normalizeSegName(raw: string): string {
  const n = raw.replace(/[\s　]+/g, '');   // 先去掉所有空白，再依規則重排
  if (n.length === 0) return '';
  if (n.length === 1) return IDEO_SPACE + n + IDEO_SPACE;   // 單字置中
  if (n.length === 2) return n[0] + IDEO_SPACE + n[1];      // 原版慣例：兩字中間撐開
  return n.slice(0, 3);
}

/** 寫入地段名稱（同時更新顯示用的 segmentNames 與要存回 PAK 的 pakTextLines）。 */
function setSegName(segId: number, raw: string): string {
  const name = normalizeSegName(raw);
  if (segId <= 0) return name;
  if (segId < PRICE_SEG_COUNT) {
    while (workspace.segmentNames.length <= segId) workspace.segmentNames.push('');
    workspace.segmentNames[segId] = name;
    workspace.pakTextLines[25 + segId] = SEG_NAME_PAD + name;
  } else {
    extraSegNames[segId] = name;   // 超出原生 44 段的額外地段，PAK 沒有對應行
  }
  return name;
}

/** 更新地段名稱輸入框：沒有地段（segId=0）就清空並停用，避免以為改得動。 */
function showSegName(segId: number): void {
  const el = document.getElementById('segNameDisplay') as HTMLInputElement | null;
  if (!el) return;
  el.value = segId > 0 ? getSegName(segId) : '';
  el.disabled = segId <= 0;
  el.placeholder = segId > 0 ? '地段名稱（3 字寬）' : '此格非土地';
}


function detectMarkerDir(baseLocId: number): number {
  const marker = baseLocId + 950;
  let baseIdx = -1;
  let markerIdx = -1;
  for (let i = 0; i < workspace.mapGrid.length; i++) {
    if (workspace.mapGrid[i] === baseLocId) baseIdx = i;
    if (workspace.mapGrid[i] === marker) markerIdx = i;
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

function applySegmentDerivedFields(locId: number, segId: number): void {
  if (!locDataView || locId <= 0 || segId <= 0) return;
  setLocField(LOC_FIELDS.SEGMENT, locId, segId);
  // 地段序號要**整段重編**，不能只算自己這一格：新地點的編號若不是該地段最大的，
  // 它應該插在中間、後面的都要往後推。（原版 85/85 個地段都是依 locId 排的 1..N）
  renumberSegment(workspace.mapGrid, locDataView, segId);

  // 這裡只管地段相關的欄位。UNKA/UNKB 是路由表，改地段不會動到四方向指標、
  // 路徑圖沒變，所以路由也不該在這裡重算 —— 那是「建立格子」時的責任。
  const dir = detectMarkerDir(locId);
  if (dir > 0) setLocField(LOC_FIELDS.UNK3, locId, dir);
}

function getSpecialName(spId: number): string {
  // 改成 >= 0，把 ID 0 給放行！
  return (spId >= 0 && spId < workspace.specialNames.length) ? workspace.specialNames[spId] : '';
}

// 改地段名稱：直接改目前這格所屬地段的名字（會影響同地段的所有土地）
bindLiveField('segNameDisplay', '改地段名稱', (raw) => {
  if (selectedGridX < 0) return;
  const locId = workspace.mapGrid[selectedGridY * GRID_COLS + selectedGridX];
  const segId = locId > 0 ? getLocField(LOC_FIELDS.SEGMENT, locId) : 0;
  if (segId <= 0) return;
  const applied = setSegName(segId, raw);
  const el = document.getElementById('segNameDisplay') as HTMLInputElement | null;
  if (el && el.value !== applied) el.value = applied;   // 顯示正規化後的結果
  const bad = unsupportedChars(applied);
  // PAK 的文字表只有 44 行（line 26~69），編號 ≥45 的地段沒有對應行、名字寫不回去。
  // 以前是默默不寫，畫面上看起來像成功了 —— 這種假成功比報錯還糟。
  const noLine = segId >= PRICE_SEG_COUNT;
  logMsg(`地段 ${segId} 名稱改為「${applied}」` +
    (noLine ? `　❌ <b>但這個名字進不了遊戲</b>：PAK 的文字表只有 ${PRICE_SEG_COUNT - 1} 行，編號 ≥${PRICE_SEG_COUNT} 的地段沒有位置可寫，只有編輯器自己看得到。`
            : '（存檔時寫回 PAK）。') +
    unsupportedMsg(bad, applied));
  renderPriceTable(segId);
});

bindLiveField('editSpecial', '改特殊種類', (raw) => {
  if (selectedGridX < 0) return;
  const locId = workspace.mapGrid[selectedGridY * GRID_COLS + selectedGridX];
  const spId = parseInt(raw) || 0;
  (document.getElementById('specialNameDisplay') as HTMLSpanElement).textContent = (locId > 0 && locId <= 50) ? getSpecialName(spId) : '';
  if (locId > 0 && workspace.locData) setLocField(LOC_FIELDS.SPECIAL, locId, spId);
  repaintSpecialTiles(locId, spId);
});

/**
 * 換了特殊種類，圖塊要跟著換 —— 玩家看到的是圖塊，實際觸發的是 SPECIAL 欄位，
 * 兩邊分家的話畫面上是賭場、踩下去卻進法院。只動「圖塊已確認是完整 2x2」的地點，
 * 圖塊本來就沒排好的交給警告頁，不在這裡亂改畫面。
 */
function repaintSpecialTiles(locId: number, kind: number): void {
  if (locId <= 0 || locId > getSpecialBoundary()) return;
  if (kind < 0 || kind >= SPECIAL_KIND_COUNT) return;
  const block = specials().confirmed.find(b => b.locId === locId);
  if (!block || block.kind === kind) return;
  const tiles = specialTilesOfKind(kind);
  block.cells.forEach((ci, i) => { workspace.mapLayout[ci] = tiles[i]; });
  renderer.redraw();
  drawSelection();
  logMsg(`　圖塊已跟著換成 ${tiles[0]}~${tiles[3]}（${getSpecialName(kind) || `種類${kind}`}）。`);
}

const extraSegNames: Record<number, string> = {};
const extraPriceData: Record<number, Record<number, number>> = {};

(document.getElementById('addSegBtn') as HTMLButtonElement).addEventListener('click', function () {
  flushAllEdits();
  if (!workspace.locData) { logMsg('請先載入 DSK！'); return; }

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
  mark('新增地段');

  setSegName(newSegId, name);

  // 套用到目前選取的格子
  if (selectedGridX >= 0) {
    const locId = workspace.mapGrid[selectedGridY * GRID_COLS + selectedGridX];
    (document.getElementById('editSegId') as HTMLInputElement).value = newSegId.toString();
    showSegName(newSegId);
    if (locId > 0 && workspace.locData) {
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
  PRICE_FIELDS.forEach((label: string, fi: number) => {
    // 靠背，這裡直接把欄位 8 和欄位 9 濾掉不顯示
    if (fi === 8 || fi === 9) return;

    let val: number;
    if (isExtra) {
      val = (extraPriceData[segId] && extraPriceData[segId][fi] != null) ? extraPriceData[segId][fi] : 0;
    } else {
      val = workspace.priceData ? getPriceField(fi, segId) : 0;
    }
    const tr = document.createElement('tr');

    // --- 這裡修改：加入樣式與對齊 ---
    tr.innerHTML = `
      <td class="px-3 py-2 text-on-surface-variant">${label}</td>
      <td class="px-3 py-2 text-right">
        <input type="number" min="0" max="65535" value="${val}" 
               data-fi="${fi}" data-seg="${segId}" data-extra="${isExtra ? 1 : 0}"
               class="bg-surface-container-lowest border border-outline-variant/30 rounded-sm text-right px-2 py-1 focus:ring-1 focus:ring-primary outline-hidden">
      </td>
    `;
    tbody.appendChild(tr);
  });

  // 價格欄位一樣「邊改邊存」，不必按 Enter
  tbody.querySelectorAll('input').forEach(inp => {
    const applyValue = (target: HTMLInputElement) => {
      const fi = parseInt(target.dataset.fi || '0');
      const seg = parseInt(target.dataset.seg || '0');
      const v = parseInt(target.value) || 0;
      if (target.dataset.extra === '1') {
        if (!extraPriceData[seg]) extraPriceData[seg] = {};
        extraPriceData[seg][fi] = v;
      } else {
        setPriceField(fi, seg, v);
      }
    };
    const key = `price:${inp.dataset.seg}:${inp.dataset.fi}`;
    inp.addEventListener('input', () => scheduleEdit(key, '改價格', () => applyValue(inp)));
    inp.addEventListener('change', () => { scheduleEdit(key, '改價格', () => applyValue(inp)); flushEdit(key); });
  });
}

// ================= 復原 / 重做 =================
interface EditorSnapshot {
  grid: Uint16Array;
  layout: Uint16Array;
  loc: Uint8Array | null;
  price: Uint8Array | null;
  segmentNames: string[];
  pakTextLines: string[];
  extraSegNames: Record<number, string>;
  extraPriceData: Record<number, Record<number, number>>;
}

const history = new History<EditorSnapshot>({
  capture: () => ({
    grid: workspace.mapGrid.slice(),
    layout: workspace.mapLayout.slice(),
    loc: workspace.locData ? workspace.locData.slice() : null,
    price: workspace.priceData ? workspace.priceData.slice() : null,
    segmentNames: workspace.segmentNames.slice(),
    pakTextLines: workspace.pakTextLines.slice(),
    extraSegNames: { ...extraSegNames },
    extraPriceData: JSON.parse(JSON.stringify(extraPriceData)),
  }),
  apply: (s) => {
    // grid / layout 一定要「原地寫回」：debugger 和其他模組是在初始化時就抓走參照的，
    // 換成新陣列它們會繼續讀到舊的那份。
    workspace.mapGrid.set(s.grid);
    workspace.mapLayout.set(s.layout);

    if (s.loc) {
      if (workspace.locData && workspace.locData.length === s.loc.length) workspace.locData.set(s.loc);
      else workspace.locData = s.loc.slice();
    } else workspace.locData = null;

    if (s.price) {
      if (workspace.priceData && workspace.priceData.length === s.price.length) workspace.priceData.set(s.price);
      else workspace.priceData = s.price.slice();
    } else workspace.priceData = null;

    workspace.segmentNames = s.segmentNames.slice();
    workspace.pakTextLines = s.pakTextLines.slice();
    for (const k of Object.keys(extraSegNames)) delete extraSegNames[Number(k)];
    Object.assign(extraSegNames, s.extraSegNames);
    for (const k of Object.keys(extraPriceData)) delete extraPriceData[Number(k)];
    Object.assign(extraPriceData, JSON.parse(JSON.stringify(s.extraPriceData)));

    syncDataViews();          // locData 可能被換掉了，DataView 要重接
    renderer.redraw();
    if (selectedGridX >= 0) openEditPanel(selectedGridX, selectedGridY);
    runValidation();
  },
  onChange: (info) => {
    const u = document.getElementById('undoBtn') as HTMLButtonElement | null;
    const r = document.getElementById('redoBtn') as HTMLButtonElement | null;
    if (u) { u.disabled = !info.canUndo; u.title = info.canUndo ? `復原：${info.undoLabel}（Ctrl+Z，還有 ${info.undoDepth} 步）` : '沒有可復原的動作'; }
    if (r) { r.disabled = !info.canRedo; r.title = info.canRedo ? `重做：${info.redoLabel}（Ctrl+Y，還有 ${info.redoDepth} 步）` : '沒有可重做的動作'; }
  },
});

/** 在動作發生「之前」呼叫，記下當時狀態。label 是那個動作的名字。 */
function mark(label: string): void {
  if (workspace.isSaveLoaded) history.push(label);
}

// ==== 欄位即時儲存（不必按 Enter）====
// number input 的 'change' 只在按 Enter 或失焦時才觸發，所以改聽 'input'。
// 但 'input' 每打一個字就觸發，直接套用會寫進中間值 —— 想輸入 120 會先寫 1 再寫 12。
// 對 editLocId 這種會連動「其他地點座標」的欄位那是實質破壞（會把地點 1、12 的 X/Y 改掉）。
// 所以延遲一小段再套用：打字停下來就自動存，一次輸入也只產生一步復原。
// 失焦或按 Enter（change 事件）則立刻套用，不等延遲。
interface PendingEdit { label: string; apply: () => void }
const pendingEdits = new Map<string, PendingEdit>();
const editTimers = new Map<string, number>();
const EDIT_DELAY_MS = 300;

function flushEdit(key: string): void {
  const t = editTimers.get(key);
  if (t !== undefined) { clearTimeout(t); editTimers.delete(key); }
  const p = pendingEdits.get(key);
  if (!p) return;
  pendingEdits.delete(key);
  mark(p.label);          // 快照要在套用前拍，才是「這次修改之前」的狀態
  p.apply();
}
/** 把所有還在等待的欄位修改立刻寫入。存檔、復原、按功能鍵之前都要先呼叫。 */
function flushAllEdits(): void { for (const key of [...pendingEdits.keys()]) flushEdit(key); }

function scheduleEdit(key: string, label: string, apply: () => void): void {
  pendingEdits.set(key, { label, apply });
  const t = editTimers.get(key);
  if (t !== undefined) clearTimeout(t);
  editTimers.set(key, window.setTimeout(() => flushEdit(key), EDIT_DELAY_MS));
}

/** 綁定一個「邊改邊存」的欄位。 */
function bindLiveField(id: string, label: string, apply: (raw: string) => void): void {
  const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
  if (!el) return;
  el.addEventListener('input', () => { const v = el.value; scheduleEdit(id, label, () => apply(v)); });
  el.addEventListener('change', () => { const v = el.value; scheduleEdit(id, label, () => apply(v)); flushEdit(id); });
}

function doUndo(): void {
  flushAllEdits();
  const label = history.undo();
  logMsg(label ? `↶ 已復原：${label}` : '沒有可復原的動作。');
}
function doRedo(): void {
  flushAllEdits();
  const label = history.redo();
  logMsg(label ? `↷ 已重做：${label}` : '沒有可重做的動作。');
}

let warnings: WarningMsg[] = [];
// Run.exe [0x1098] 目前寫的特殊地點數（載入地圖時讀進來，存檔後更新）。
// null＝還沒讀到 exe（沒選資料夾或沒有 exe），這時不做比對。
let exeSpecialCount: number | null = null;
function runValidation(): void {
  warnings = [];
  if (!workspace.isSaveLoaded || !workspace.locData) { renderWarnList(); return; }

  const locUsage: Record<number, number[]> = {};
  for (let i = 0; i < GRID_COLS * GRID_ROWS; i++) {
    const lid = workspace.mapGrid[i];
    if (lid === 0) continue;
    if (!locUsage[lid]) locUsage[lid] = [];
    locUsage[lid].push(i);
  }

  // 一格一個編號是常態，但**特殊地點本來就佔 2x2 四格**——把確認過的特殊地點排除掉，
  // 否則每張圖光是特殊地點就會噴出幾十筆假的「重複用於」，把真正的警告淹掉。
  const okMulti = new Set(
    workspace.locData ? specials().confirmed.map(b => b.locId) : [],
  );
  for (const [lidStr, cells] of Object.entries(locUsage)) {
    const lid = parseInt(lidStr);
    if (cells.length > 1 && !okMulti.has(lid)) {
      const coords = cells.map(ci => `(${ci % GRID_COLS},${Math.floor(ci / GRID_COLS)})`).join(', ');
      warnings.push({ type: 'dup', cells, msg: `地點 ${lid} 重複用於 ${coords}（只有特殊地點可以佔 2x2 四格）` });
    }
  }

  // 註：原本這裡有一個「方向指標必須等於 grid 鄰格」的檢查，但大富翁的移動是
  // 有向路徑圖（路口/轉角合法地不相鄰），該假設在正常地圖上會狂噴假警報，已移除。
  // 真正可靠的「指向不存在地點」由下方 integrity 的 dangling-ref 負責。

  // === 結構完整性檢查（integrity.ts）：抓引擎會崩的真實損毀 ===
  if (locDataView) {
    const issues = analyzeIntegrity(workspace.mapGrid, locDataView, getSpecialBoundary(), integrityOpts());
    for (const iss of issues) {
      const cells: number[] = [];
      for (let i = 0; i < workspace.mapGrid.length; i++) if (workspace.mapGrid[i] === iss.locId) { cells.push(i); break; }
      warnings.push({ type: iss.kind, cells, msg: `【完整性/${iss.kind}】${iss.detail}` });
    }
  }

  // === 編號 ≥45 的地段：名稱與價格都沒有地方存 ===
  // PAK 文字表只有 44 行、價格表也只有 44 組，超出的地段在遊戲裡沒有名字也沒有價格。
  if (workspace.locData) {
    const extra = new Map<number, number[]>();   // segId → 用到它的地點
    for (let id = 1; id < LOC_COUNT; id++) {
      const seg = getLocField(LOC_FIELDS.SEGMENT, id);
      if (seg >= PRICE_SEG_COUNT) {
        if (!extra.has(seg)) extra.set(seg, []);
        extra.get(seg)!.push(id);
      }
    }
    for (const [seg, ids] of [...extra].sort((a, b) => a[0] - b[0])) {
      const cells: number[] = [];
      for (let i = 0; i < workspace.mapGrid.length; i++) if (workspace.mapGrid[i] === ids[0]) { cells.push(i); break; }
      warnings.push({
        type: 'seg-overflow', cells,
        msg: `【地段/超出】地段 ${seg} 超過 PAK 的上限 ${PRICE_SEG_COUNT - 1} —— 名稱與價格都沒有地方存，` +
          `遊戲裡這些地（${ids.slice(0, 8).join('、')}${ids.length > 8 ? `…共 ${ids.length} 塊` : ''}）會沒有名字也買不了。` +
          `　請把它們併進 1~${PRICE_SEG_COUNT - 1} 的地段。`,
      });
    }
  }

  // === exe 的特殊地點數 [0x1098] 與地圖現況對不上 ===
  // 這個值寫在 Run.exe 裡、不在地圖檔裡，改完地圖不會自己跟著變，所以在這裡提醒。
  if (exeSpecialCount != null) {
    const sc = specials();
    const n = sc.count;
    if (n !== exeSpecialCount) {
      const scInp = document.getElementById('specialCountInput') as HTMLInputElement | null;
      const pending = scInp && scInp.value !== '' ? parseInt(scInp.value) : null;
      const detail = n > exeSpecialCount
        ? `編號 ${exeSpecialCount + 1}~${n}（${listSpecials(sc, exeSpecialCount + 1, n)}）在遊戲裡不會被當成特殊地點`
        : `編號 ${n + 1}~${exeSpecialCount} 會被引擎當成特殊地點，但圖塊確認不了它們是特殊地點，玩家踩上去可能當機`;
      warnings.push({
        type: 'special-count', cells: [],
        msg: `【exe/特殊數】Run.exe 寫 ${exeSpecialCount}，地圖實際是 ${n} → ${detail}。` +
          (pending === n ? '　欄位已填好，按「儲存到遊戲」即生效。' : `　按「修復特殊」填入 ${n} 再存檔。`),
      });
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

/** 把 lo~hi 之間確認過的特殊地點列成「24=黑市」這種好讀的樣子。 */
function listSpecials(sc: ReturnType<typeof specials>, lo: number, hi: number): string {
  return sc.confirmed
    .filter(b => b.locId >= lo && b.locId <= hi)
    .map(b => `${b.locId}=${getSpecialName(b.kind) || `種類${b.kind}`}`)
    .join('、') || '無';
}

/** 完整性檢查要用的可選輸入：價格表、圖塊層（特殊地點的確認條件）、種類名稱。 */
function integrityOpts(): IntegrityOptions {
  return {
    priceDv: priceDataView,
    layout: workspace.mapLayout,
    specialName: (k: number) => getSpecialName(k) || `種類 ${k}`,
  };
}

function renderWarnList(): void {
  const statusWarn = document.getElementById('statusWarn');
  if (statusWarn) {
    statusWarn.textContent = warnings.length > 0 ? `⚠ ${warnings.length}` : '✅ 0';
    statusWarn.className = warnings.length > 0 ? 'text-error' : 'text-tertiary';
  }
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
  const locId = workspace.mapGrid[cellIndex];
  const tileId = workspace.mapLayout[cellIndex];

  // === 替換為以下新增部份 ===
  let typeStr = '非地點';
  if (locId > 950) {
    typeStr = '土地';
  } else if (locId > 50) {
    typeStr = '道路';
  } else if (locId > 0) {
    typeStr = '特殊地點';
  }

  renderer.redraw();
  drawSelection();                    // redraw 會蓋掉選取範圍，補回來
  ctx.strokeStyle = '#e51400';
  ctx.lineWidth = 2;
  ctx.strokeRect(gridX * TILE_W, gridY * TILE_H, TILE_W, TILE_H);
  ctx.lineWidth = 1;

  const spId = locId > 0 && workspace.locData ? getLocField(LOC_FIELDS.SPECIAL, locId) : 0;
  const segId2 = locId > 0 && workspace.locData ? getLocField(LOC_FIELDS.SEGMENT, locId) : 0;
  // 寫進專屬的「格子資訊」區塊。以前這裡寫的是 infoBox，等於每點一格就把整份
  // 操作記錄清空——拖曳貼圖的摘要才剛印出來就被自己洗掉，看起來像功能沒作用。
  cellInfo.innerHTML = `
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
  if (workspace.mapTilesData.length > 0) {
    // 初始化選擇器，並把「替換圖塊」的邏輯當作 Callback 傳進去
    // 點圖塊 = 把它套用到「目前選取的所有格子」（拖曳選了幾格就套幾格）
    initTilePicker(workspace.mapTilesData, palette, TILE_W, TILE_H, {
      onTile: applyTileToSelection,
      onSpecial: applySpecialToSelection,
      specialName: (k: number) => getSpecialName(k) || `種類${k}`,
    });

    // 自動更新 UI 紅框與捲動位置
    updateTilePickerSelection(tileId);
  }

  // 幹，這裡把你漏掉的 UI 連動更新補上
  (document.getElementById('editLocId') as HTMLInputElement).value = locId.toString();
  if (locId > 0 && workspace.locData) {
    const segId = getLocField(LOC_FIELDS.SEGMENT, locId);
    const spId = getLocField(LOC_FIELDS.SPECIAL, locId);
    (document.getElementById('editSegId') as HTMLInputElement).value = segId.toString();
    showSegName(segId);
    (document.getElementById('editSpecial') as HTMLInputElement).value = spId.toString();
    (document.getElementById('specialNameDisplay') as HTMLSpanElement).textContent = (locId > 0 && locId <= 50) ? getSpecialName(spId) : '';
    (document.getElementById('editUnk9') as HTMLInputElement).value = getLocField(LOC_FIELDS.UNK9, locId).toString();
    (document.getElementById('editUnkA') as HTMLInputElement).value = getLocField(LOC_FIELDS.UNKA, locId).toString();
    (document.getElementById('editUnkB') as HTMLInputElement).value = getLocField(LOC_FIELDS.UNKB, locId).toString();
    const unk3 = getLocField(LOC_FIELDS.UNK3, locId);
    (document.getElementById('editUnk3') as HTMLSelectElement).value = unk3.toString();
    const suggest = detectMarkerDir(locId);
    (document.getElementById('unk3Hint') as HTMLSpanElement).textContent = `建議方向：${dirLabel(suggest)} (${suggest})`;

    (document.getElementById('editDirLeft') as HTMLInputElement).value = getLocField(LOC_FIELDS.LEFT, locId).toString();
    (document.getElementById('editDirUp') as HTMLInputElement).value = getLocField(LOC_FIELDS.UP, locId).toString();
    (document.getElementById('editDirRight') as HTMLInputElement).value = getLocField(LOC_FIELDS.RIGHT, locId).toString();
    (document.getElementById('editDirDown') as HTMLInputElement).value = getLocField(LOC_FIELDS.DOWN, locId).toString();
    renderPriceTable(segId);
  } else {
    [
      'editSegId', 'editSpecial', 'editUnk9', 'editUnkA', 'editUnkB', 'editUnk3',
      'editDirLeft', 'editDirUp', 'editDirRight', 'editDirDown'
    ].forEach(id => {
      const el = document.getElementById(id) as HTMLInputElement;
      if (el) el.value = '0';
    });
    showSegName(0);
    (document.getElementById('specialNameDisplay') as HTMLSpanElement).textContent = '';
    (document.getElementById('unk3Hint') as HTMLSpanElement).textContent = '建議方向：-';
    renderPriceTable(0);
  }
  validateDirWarnings(locId, gridX, gridY);
}

function setLocWithCoords(locId: number, _gridX: number, _gridY: number): void {
  if (locId <= 0 || !workspace.locData) return;
  // 座標永遠同步成該地點在 grid 上所有格子的「左上角」(min gx, min gy)，
  // 這是引擎存 X/Y 的方式；不再只在 0 時才寫，避免移動地點留下重複/殘留座標。
  let minX = GRID_COLS, minY = GRID_ROWS, found = false;
  for (let i = 0; i < workspace.mapGrid.length; i++) {
    if (workspace.mapGrid[i] !== locId) continue;
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

// 最後一次自動配號的土地。土地是一塊一塊加的，所以放購地標記時優先配給它。
let lastAddedLandId = -1;

/**
 * 依貼上的圖塊語意自動配 locId（圖塊語意見 constants.ts，三張原版圖實測）：
 *  - 圖塊 9~14（土地）：這格還沒編號就配一個新的（接在目前最大編號之後），
 *    同步座標、依相鄰格接方向、順手把 UNKA/UNKB 路由算好當預填值。
 *  - 圖塊 1（購地標記）：配「相鄰土地的 locId + 950」。若該格同時貼著多塊地，
 *    跳過 +950 已被別格佔走的，優先給剛新增的那塊。
 */
interface AssignResult {
  land?: number;     // 新配出的土地編號
  marker?: number;   // 新配出的購地標記編號
  deleted?: number;  // 被刪掉的地點編號（貼上沒有地點語意的圖塊）
  skipped?: number;  // 這格本來就有編號，只換了圖塊沒重配（不是錯誤，但多格模式要講）
  segId?: number;    // 被刪掉的那個地點原本的地段，收尾時要重編序號
  error?: string;    // 沒配成的原因
  /** 圖塊沒換成（呼叫端要把 mapLayout 還原），例如編號用完 */
  revert?: boolean;
}

/** 還剩幾個可用的土地編號（51~282 之間全空的號碼）。 */
function freeLandIdCount(): number {
  if (!locDataView) return 0;
  let n = 0;
  const used = new Set<number>();
  for (const v of workspace.mapGrid) if (v > 0) used.add(v);
  for (let id = 51; id <= 282; id++) {
    if (used.has(id) || used.has(id + MARKER_ID_OFFSET)) continue;
    let active = false;
    for (const f of Object.values(LOC_FIELDS)) if (getLocField(f as number, id) !== 0) { active = true; break; }
    if (!active) n++;
  }
  return n;
}

function autoAssignByTile(
  tile: number, gx: number, gy: number,
  opts: { quiet?: boolean; deferRouting?: boolean } = {},
): AssignResult {
  const say = (m: string) => { if (!opts.quiet) logMsg(m); };
  if (!locDataView) { say('⚠ 尚未載入 DSK，圖塊換了但沒配地點編號。'); return { error: '未載入 DSK' }; }
  const ci = gy * GRID_COLS + gx;
  const cur = workspace.mapGrid[ci];

  if (LAND_TILES.includes(tile)) {
    if (cur > MARKER_ID_OFFSET) {
      const e = `目前是購地標記 ${cur}，要放土地請先清掉它`;
      say(`⚠ (${gx},${gy}) ${e}。`); return { error: e, revert: true };
    }
    if (cur > 0) { say(`(${gx},${gy}) 已經是地點 ${cur}，只換圖塊、不重配編號。`); return { skipped: cur }; }

    const id = nextLandId(workspace.mapGrid, locDataView, getSpecialBoundary());
    if (id < 0) {
      const e = `沒有可用的土地編號了（51~${MAX_LOC_ID} 全被佔用）`;
      say(`❌ ${e}　—— 圖塊沒有換，請先刪掉用不到的地點。`); return { error: e, revert: true };
    }

    workspace.mapGrid[ci] = id;
    setLocWithCoords(id, gx, gy);
    // UNKA/UNKB 先填非 0 佔位——0 會被當成監獄/醫院入口格，重算才不會誤判
    if (getLocField(LOC_FIELDS.UNKA, id) === 0) setLocField(LOC_FIELDS.UNKA, id, 1);
    if (getLocField(LOC_FIELDS.UNKB, id) === 0) setLocField(LOC_FIELDS.UNKB, id, 1);

    const wired = wireDirectionsFromGrid(workspace.mapGrid, locDataView, id);
    lastAddedLandId = id;
    say(`🏠 (${gx},${gy}) 配到土地編號 ${id}；自動接方向：${wired.map(w => w.dir + '→' + w.tgt).join('、') || '（四周沒有路徑格，要手動接方向）'}`);

    if (!opts.deferRouting) {
      const rep = recomputeRouting(workspace.mapGrid, locDataView, { boundary: getSpecialBoundary(), forceIds: [id] });
      if (rep.ok) {
        say(`　路由已算出：UNKA(往監獄)=${getLocField(LOC_FIELDS.UNKA, id)}、UNKB(往醫院)=${getLocField(LOC_FIELDS.UNKB, id)}` +
          (rep.a.stillBroken.length + rep.b.stillBroken.length > 0 ? '　⚠ 仍有格子路由不通，方向可能還沒接好' : ''));
      }
      say('　接著請設地段與價格（下方「地段」欄），並在旁邊放一格圖塊 1 當購地標記。');
      runValidation();
    }
    return { land: id };
  }

  if (tile === MARKER_TILE) {
    const r = findMarkerBase(workspace.mapGrid, gx, gy, lastAddedLandId);
    if (r.base < 0) {
      const e = r.taken.length > 0
        ? `旁邊的土地 ${r.taken.join('、')} 都已經有自己的購地標記了`
        : '四周找不到土地（編號 ≥51），請先在旁邊放圖塊 9~14';
      say(`❌ (${gx},${gy}) ${e}。`); return { error: e, revert: true };
    }
    const markerId = r.base + MARKER_ID_OFFSET;
    workspace.mapGrid[ci] = markerId;
    const others = r.free.filter(x => x !== r.base);
    say(`🏷 (${gx},${gy}) 配到購地標記 ${markerId}（屬於土地 ${r.base}）` +
      (r.taken.length ? `；已跳過標記名花有主的 ${r.taken.join('、')}` : '') +
      (others.length ? `；另可改配給 ${others.join('、')}` : ''));

    // 標記一放好，土地的 UNK3（建築在走道格的哪一側）就能推出來
    const dir = detectMarkerDir(r.base);
    if (dir > 0) {
      setLocField(LOC_FIELDS.UNK3, r.base, dir);
      say(`　土地 ${r.base} 的 UNK3(建築方向) 自動設為 ${dirLabel(dir)}(${dir})。`);
    }
    if (!opts.deferRouting) runValidation();
    return { marker: markerId };
  }

  // 剩下的圖塊都沒有地點語意（風景、水面、裝飾…）—— 貼上去就等於**把這格的地點刪掉**。
  // 刪除與新增走同一個入口：貼有語意的圖塊＝建立，貼沒語意的＝刪除，不必另外做 UI。
  if (cur > 0) {
    const target = cur > MARKER_ID_OFFSET ? cur - MARKER_ID_OFFSET : cur;
    // 貼在購地標記格上：只清那一格，別把整塊土地連坐刪掉
    if (cur > MARKER_ID_OFFSET) {
      workspace.mapGrid[ci] = 0;
      say(`🗑 (${gx},${gy}) 清掉土地 ${target} 的購地標記。`);
      if (!opts.deferRouting) runValidation();
      return { deleted: cur };
    }
    const rep = deleteLocation(workspace.mapGrid, locDataView, cur);
    if (!rep) { const e = `地點 ${cur} 刪不掉`; say(`⚠ (${gx},${gy}) ${e}。`); return { error: e }; }
    if (lastAddedLandId === cur) lastAddedLandId = -1;
    say(`🗑 (${gx},${gy}) 已刪除地點 ${cur}：清掉 ${rep.cells.length} 格` +
      (rep.markerId ? `（含購地標記 ${rep.markerId}）` : '') +
      `、記錄整筆歸 0` +
      (rep.clearedRefs.length ? `、清掉 ${rep.clearedRefs.length} 個指向它的方向指標（${rep.clearedRefs.slice(0, 6).map(r => `${r.id}的${r.dir}`).join('、')}${rep.clearedRefs.length > 6 ? '…' : ''}）` : '') +
      '。');
    if (!opts.deferRouting) {
      if (rep.segId > 0) renumberSegment(workspace.mapGrid, locDataView, rep.segId);
      recomputeRouting(workspace.mapGrid, locDataView, { boundary: getSpecialBoundary() });
      runValidation();
    }
    return { deleted: cur, segId: rep.segId };
  }
  return {};
}

// 改地點編號：會連動 grid、座標同步、以及一整排欄位顯示。
// 特別需要延遲套用 —— 逐字套用會先寫進 1、12 這種中間值，把地點 1 和 12 的 X/Y 座標弄壞。
bindLiveField('editLocId', '改地點編號', (raw) => {
  if (selectedGridX < 0) return;
  const newLocId = parseInt(raw) || 0;
  const ci = selectedGridY * GRID_COLS + selectedGridX;
  const oldLocId = workspace.mapGrid[ci];      // 這格原本屬於誰
  workspace.mapGrid[ci] = newLocId;
  setLocWithCoords(newLocId, selectedGridX, selectedGridY);
  // 舊主人也要重算座標：把某格清空(改成0)或讓給別人時，原本那個地點的左上角
  // 可能就變了。少了這步，搬家後的地點會留著舊座標（警告頁的 coord-mismatch 就是這樣來的）。
  if (oldLocId > 0 && oldLocId !== newLocId) setLocWithCoords(oldLocId, selectedGridX, selectedGridY);
  (document.getElementById('editTitle') as HTMLHeadingElement).textContent = `編輯 (${selectedGridX}, ${selectedGridY})  地點 ${newLocId}`;
  if (newLocId > 0 && workspace.locData) {
    const segId = getLocField(LOC_FIELDS.SEGMENT, newLocId);  // ← locId → newLocId
    const spId = getLocField(LOC_FIELDS.SPECIAL, newLocId);   // ← locId → newLocId
    if (segId > 0) applySegmentDerivedFields(newLocId, segId);
    (document.getElementById('editSegId') as HTMLInputElement).value = segId.toString();
    showSegName(segId);
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
    showSegName(0);
    (document.getElementById('specialNameDisplay') as HTMLSpanElement).textContent = '';
    (document.getElementById('unk3Hint') as HTMLSpanElement).textContent = '建議方向：-';
  }

  const segForPrice = newLocId > 0 ? getLocField(LOC_FIELDS.SEGMENT, newLocId) : 0;  // ← locId → newLocId
  renderPriceTable(segForPrice);

  validateDirWarnings(newLocId, selectedGridX, selectedGridY);  // ← locId/gridX/gridY 全換
});

bindLiveField('editSegId', '改地段', (raw) => {
  if (selectedGridX < 0) return;
  const locId = workspace.mapGrid[selectedGridY * GRID_COLS + selectedGridX];
  const segId = parseInt(raw) || 0;
  showSegName(segId);
  if (locId > 0) {
    const oldSeg = getLocField(LOC_FIELDS.SEGMENT, locId);   // 離開的那個地段也要重編號
    if (segId > 0) {
      applySegmentDerivedFields(locId, segId);
      if (oldSeg > 0 && oldSeg !== segId && locDataView) renumberSegment(workspace.mapGrid, locDataView, oldSeg);
      (document.getElementById('editUnk9') as HTMLInputElement).value = getLocField(LOC_FIELDS.UNK9, locId).toString();
      (document.getElementById('editUnkA') as HTMLInputElement).value = getLocField(LOC_FIELDS.UNKA, locId).toString();
      (document.getElementById('editUnkB') as HTMLInputElement).value = getLocField(LOC_FIELDS.UNKB, locId).toString();
      (document.getElementById('editUnk3') as HTMLSelectElement).value = getLocField(LOC_FIELDS.UNK3, locId).toString();
      const suggest = detectMarkerDir(locId);
      (document.getElementById('unk3Hint') as HTMLSpanElement).textContent = `建議方向：${dirLabel(suggest)} (${suggest})`;
    } else {
      // 清掉地段：序號也要歸零，並把原地段剩下的成員重新編號補上空缺
      setLocField(LOC_FIELDS.SEGMENT, locId, 0);
      setLocField(LOC_FIELDS.UNK9, locId, 0);
      if (oldSeg > 0 && locDataView) renumberSegment(workspace.mapGrid, locDataView, oldSeg);
      (document.getElementById('editUnk9') as HTMLInputElement).value = '0';
    }
    renderPriceTable(segId);
  }
});

/** 直接把值寫進目前選取那格的某個欄位。 */
function bindLocField(id: string, label: string, field: number, after?: (locId: number) => void): void {
  bindLiveField(id, label, (raw) => {
    if (selectedGridX < 0) return;
    const locId = workspace.mapGrid[selectedGridY * GRID_COLS + selectedGridX];
    if (locId <= 0) return;
    setLocField(field, locId, parseInt(raw) || 0);
    if (after) after(locId);
  });
}

bindLocField('editUnk9', '改地段序號', LOC_FIELDS.UNK9);
// UNKA/UNKB 是「每一格各自往監獄/醫院的下一步方向」，不是地段共用屬性 ——
// 舊版會把值套用到整個地段的所有格子，那會直接把路由表寫爛，已改成只改當前這一格。
bindLocField('editUnkA', '改往監獄方向', LOC_FIELDS.UNKA);
bindLocField('editUnkB', '改往醫院方向', LOC_FIELDS.UNKB);
bindLocField('editUnk3', '改建築方向', LOC_FIELDS.UNK3);

for (const [id, field] of [
  ['editDirLeft', LOC_FIELDS.LEFT], ['editDirUp', LOC_FIELDS.UP],
  ['editDirRight', LOC_FIELDS.RIGHT], ['editDirDown', LOC_FIELDS.DOWN],
] as const) {
  bindLocField(id, '改路徑方向', field, (locId) => validateDirWarnings(locId, selectedGridX, selectedGridY));
}

function validateDirWarnings(locId: number, _gx: number, _gy: number): void {
  const msgs: string[] = [];
  const warnMsgEl = document.getElementById('dirWarnMsg') as HTMLDivElement;
  if (locId <= 0 || !workspace.locData) { warnMsgEl.textContent = ''; return; }
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
    for (let i = 0; i < workspace.mapGrid.length; i++) { if (workspace.mapGrid[i] === target) { onGrid = true; break; } }
    if (!onGrid) msgs.push(`⚠ 往${d.label}→${target}，但 ${target} 不在地圖上（幽靈地點）`);
  });
  warnMsgEl.textContent = msgs.join('　');
}

/**
 * 滑鼠座標 → 格子座標。
 * 畫布 CSS 是 `width:100%; height:100%; object-fit: contain`，內容會等比縮放並置中，
 * 元素框和實際畫面內容不一樣大（左右或上下留白）。直接拿 getBoundingClientRect() 換算
 * 會左半邊偏右、右半邊偏左，所以這裡要自己算出 contain 之後的內容矩形。
 * 點在留白區回傳 null。
 */
function mouseToGrid(e: MouseEvent): { gx: number; gy: number } | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
  const dispW = canvas.width * scale, dispH = canvas.height * scale;
  const originX = rect.left + (rect.width - dispW) / 2;   // contain 會置中，留白左右各半
  const originY = rect.top + (rect.height - dispH) / 2;
  const x = (e.clientX - originX) / scale;
  const y = (e.clientY - originY) / scale;
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return null;
  const gx = Math.floor(x / TILE_W), gy = Math.floor(y / TILE_H);
  if (gx < 0 || gx >= GRID_COLS || gy < 0 || gy >= GRID_ROWS) return null;
  return { gx, gy };
}

// ================= 拖曳選取格子 =================
// 點一下 ＝ 選取該格並開啟編輯面板。壓著左鍵划過去 ＝ 一次選取經過的每一格。
// 選好之後再點圖塊，就把那個圖塊套用到「全部選取的格子」。
// 也就是「先選範圍、再決定貼什麼」，跟原本「點格子→點圖塊」的操作一致。
const selection = new Set<number>();                  // 已選取的格子（grid index）
let dragging = false;
let dragStart: { gx: number; gy: number } | null = null;
let dragLast: { gx: number; gy: number } | null = null;

function updateSelectionLabel(): void {
  const el = document.getElementById('selectionLabel');
  if (!el) return;
  if (selection.size === 0) { el.textContent = '尚未選取'; el.className = 'font-bold text-on-surface-variant/50'; }
  else { el.textContent = `${selection.size} 格`; el.className = 'font-bold text-primary'; }
}

/** 把選取範圍畫到畫布上。每次 redraw 之後都要補畫，因為 redraw 會蓋掉。 */
function drawSelection(): void {
  if (selection.size === 0) return;
  ctx.save();
  ctx.fillStyle = 'rgba(229, 20, 0, 0.25)';
  ctx.strokeStyle = '#e51400';
  ctx.lineWidth = 2;
  for (const ci of selection) {
    const gx = ci % GRID_COLS, gy = Math.floor(ci / GRID_COLS);
    ctx.fillRect(gx * TILE_W, gy * TILE_H, TILE_W, TILE_H);
    ctx.strokeRect(gx * TILE_W + 1, gy * TILE_H + 1, TILE_W - 2, TILE_H - 2);
  }
  ctx.restore();
}
function redrawWithSelection(): void {
  renderer.redraw();
  drawSelection();
}

/** 兩點之間補齊（Bresenham）：滑鼠移太快時才不會跳格漏選。 */
function selectLine(a: { gx: number; gy: number }, b: { gx: number; gy: number }): void {
  let x0 = a.gx, y0 = a.gy;
  const x1 = b.gx, y1 = b.gy;
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    selection.add(y0 * GRID_COLS + x0);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

canvas.addEventListener('mousedown', function (e: MouseEvent) {
  if (e.button !== 0) return;
  const p = mouseToGrid(e);
  if (!p) return;
  dragging = true;
  dragStart = p;
  dragLast = p;
  selection.clear();                                  // 每次重新拖曳都是全新的選取
  selection.add(p.gy * GRID_COLS + p.gx);
  updateSelectionLabel();
  e.preventDefault();
});

canvas.addEventListener('mousemove', function (e: MouseEvent) {
  if (!dragging || !dragLast) return;
  const p = mouseToGrid(e);
  if (!p) return;
  if (p.gx === dragLast.gx && p.gy === dragLast.gy) return;
  selectLine(dragLast, p);
  dragLast = p;
  updateSelectionLabel();
  redrawWithSelection();
});

// 綁在 window 上：滑鼠移出畫布才放開也要正常收尾
window.addEventListener('mouseup', function () {
  if (!dragging) return;
  dragging = false;
  const start = dragStart;
  dragStart = null; dragLast = null;
  if (selection.size > 1) logMsg(`已選取 ${selection.size} 格 —— 到「圖塊」頁點一個圖塊就會一次套用到全部。`);
  if (start) openEditPanel(start.gx, start.gy);       // 編輯面板顯示起點那格
  updateSelectionLabel();
  drawSelection();
});

/**
 * 把圖塊套用到目前選取的所有格子（含自動配 locId）。
 * 多格時逐格不輸出訊息、路由只重算一次，最後給一份摘要。
 */
function applyTileToSelection(tile: number): void {
  const cells = selection.size > 0
    ? [...selection]
    : (selectedGridX >= 0 ? [selectedGridY * GRID_COLS + selectedGridX] : []);
  if (cells.length === 0) { logMsg('請先在地圖上點選（或拖曳選取）要套用的格子。'); return; }

  const multi = cells.length > 1;
  mark(multi ? `貼圖塊 ${tile} 到 ${cells.length} 格` : `貼圖塊 ${tile}`);

  const lands: number[] = [], markers: number[] = [], errors: string[] = [];
  const deleted: number[] = [], skipped: number[] = [], dirtySegs = new Set<number>();
  let reverted = 0;
  for (const ci of cells) {
    const gx = ci % GRID_COLS, gy = Math.floor(ci / GRID_COLS);
    const prevTile = workspace.mapLayout[ci];
    workspace.mapLayout[ci] = tile;
    const r = autoAssignByTile(tile, gx, gy, { quiet: multi, deferRouting: true });
    // 配不到編號就把圖塊還原 —— 留下一塊「看起來是土地、其實沒有編號」的格子，
    // 畫面上跟成功完全一樣，這正是最容易被當成靜默失敗的地方。
    if (r.revert) { workspace.mapLayout[ci] = prevTile; reverted++; }
    if (r.land != null) lands.push(r.land);
    if (r.marker != null) markers.push(r.marker);
    if (r.deleted != null) deleted.push(r.deleted);
    if (r.skipped != null) skipped.push(r.skipped);
    if (r.segId) dirtySegs.add(r.segId);
    if (r.error) errors.push(`(${gx},${gy}) ${r.error}`);
  }

  if (multi) {
    let msg = `🖌 圖塊 ${tile} 已套用到 ${cells.length - reverted} 格`;
    if (lands.length) msg += `；新增土地 ${lands.length} 塊（${lands.join('、')}）`;
    if (markers.length) msg += `；新增購地標記 ${markers.length} 個`;
    if (deleted.length) msg += `；🗑 刪除地點 ${deleted.length} 個（${deleted.slice(0, 12).join('、')}${deleted.length > 12 ? '…' : ''}）`;
    if (skipped.length) msg += `；${skipped.length} 格本來就有編號，只換圖塊`;
    if (reverted) msg += `；⚠ ${reverted} 格沒換成、圖塊已還原`;
    logMsg(msg);
    if (errors.length) {
      logMsg(`　⚠ 有 ${errors.length} 格沒配到編號：`);
      errors.slice(0, 8).forEach(m => logMsg('　　' + m));
      if (errors.length > 8) logMsg(`　　…還有 ${errors.length - 8} 格`);
    }
  }

  // 刪除的收尾：所有格子都處理完才做一次，中途做會被還沒刪完的狀態干擾
  if (deleted.length && locDataView) {
    for (const seg of dirtySegs) if (seg > 0) renumberSegment(workspace.mapGrid, locDataView, seg);
    const rep = recomputeRouting(workspace.mapGrid, locDataView, { boundary: getSpecialBoundary() });
    logMsg(`　刪除收尾：重編 ${dirtySegs.size} 個地段的序號(UNK9)` +
      (rep.ok ? `、路由重算（UNKA 修正 ${rep.a.changed.length} 格、UNKB 修正 ${rep.b.changed.length} 格）` : '') +
      `；剩餘可用編號 ${freeLandIdCount()} 個。`);
  }

  if (lands.length && locDataView) {
    // forceIds：新格子一律用算出來的值，不留碰巧能通的佔位值
    const rep = recomputeRouting(workspace.mapGrid, locDataView, { boundary: getSpecialBoundary(), forceIds: lands });
    if (rep.ok) {
      logMsg(`　路由已重算：UNKA 修正 ${rep.a.changed.length} 格、UNKB 修正 ${rep.b.changed.length} 格` +
        (rep.a.stillBroken.length + rep.b.stillBroken.length > 0 ? '　⚠ 仍有格子路由不通，方向可能沒接好' : ''));
    }
    logMsg(`　⚠ 新土地還沒設地段（買不了、沒價格），請逐一設定；剩餘可用編號 ${freeLandIdCount()} 個。`);
  }

  redrawWithSelection();
  if (selectedGridX >= 0) openEditPanel(selectedGridX, selectedGridY);
  drawSelection();
  runValidation();
}

// ============================================================================
// 特殊地點：整組 2x2 一次貼
// ----------------------------------------------------------------------------
// 特殊地點的四塊圖塊是連號的（左上 = 40 + 種類*4），拆開來讓人一塊一塊貼，
// 只會貼出半個賭場、或左上角是卡片右下角是法院這種認不出來的東西。
// 所以圖塊選擇器把 40~83 抽走，改成一個種類一顆按鈕，點下去就是完整的四格 ——
// 而且順手把地點記錄整套建好：編號、X/Y、SPECIAL、方向、路由、exe 的特殊數。
// ============================================================================

/** 要把 2x2 貼在哪：拖曳剛好圈出一塊 2x2 就用它，否則以點選的那格當左上角。 */
function specialAnchor(): number {
  if (selection.size === 4) {
    const cs = [...selection].sort((a, b) => a - b);
    const x = cs[0] % GRID_COLS;
    if (x < GRID_COLS - 1 && cs[1] === cs[0] + 1 && cs[2] === cs[0] + GRID_COLS && cs[3] === cs[0] + GRID_COLS + 1) {
      return cs[0];
    }
  }
  return selectedGridY * GRID_COLS + selectedGridX;
}

/** 貼完特殊地點的收尾：重畫、（新增時）同步 exe 特殊數欄位、重跑驗證。 */
function afterSpecialEdit(added: boolean): void {
  if (added) {
    const n = autoSpecialCount();
    const inp = document.getElementById('specialCountInput') as HTMLInputElement | null;
    if (inp && inp.value !== n.toString()) {
      inp.value = n.toString();
      logMsg(`　特殊地點數欄位更新成 ${n}，按「儲存到遊戲」會寫進 Run.exe 的 [0x1098]。`);
    }
  }
  redrawWithSelection();
  if (selectedGridX >= 0) openEditPanel(selectedGridX, selectedGridY);
  drawSelection();
  runValidation();
}

/**
 * 貼一個特殊地點（整組 2x2）。
 * 點在既有特殊地點上＝換種類；點在空地上＝新增一個，並把整套記錄建好。
 */
function applySpecialToSelection(kind: number): void {
  if (!workspace.isSaveLoaded || !locDataView) { logMsg('請先載入地圖再貼特殊地點。'); return; }
  if (selectedGridX < 0) { logMsg('請先在地圖上點一格 —— 特殊地點會以那格為左上角貼下去。'); return; }

  const name = getSpecialName(kind) || `種類${kind}`;
  const tiles = specialTilesOfKind(kind);
  const anchor = specialAnchor();
  const boundary = getSpecialBoundary();

  // 先在副本上試一次，確定做得成再 mark() —— 否則失敗也會在復原堆疊留下空白一筆
  const dry = placeSpecial(
    workspace.mapGrid.slice(), workspace.mapLayout.slice(),
    new DataView(locDataView.buffer.slice(0) as ArrayBuffer, locDataView.byteOffset, locDataView.byteLength),
    anchor, kind, boundary,
  );
  if (!dry.ok) { logMsg(`❌ ${dry.error}。`); return; }

  mark(dry.mode === 'kind' ? `地點 ${dry.locId} 改成${name}` : `新增特殊地點（${name}）`);
  const r = placeSpecial(workspace.mapGrid, workspace.mapLayout, locDataView, anchor, kind, boundary);
  if (!r.ok) { logMsg(`❌ ${r.error}。`); doUndo(); return; }

  if (r.mode === 'kind') {
    const was = getSpecialName(r.kindFrom!) || `種類${r.kindFrom}`;
    logMsg(`🏛 地點 ${r.locId}：${was} → ${name}（圖塊換成 ${tiles[0]}~${tiles[3]}，SPECIAL 欄位同步改成 ${kind}）。`);
    afterSpecialEdit(false);
    return;
  }

  const gx = anchor % GRID_COLS, gy = Math.floor(anchor / GRID_COLS);
  if (r.seaMoved && r.seaMoved.length > 0) {
    const m = r.seaMoved.slice().sort((a, b) => a.from - b.from);
    logMsg(`　海上道路整段往後挪一格空出編號：${fmtRange(m.map(x => x.from))} → ${fmtRange(m.map(x => x.to))}` +
      `（共 ${m.length} 條；grid 格子、記錄、指向它們的方向指標一起改，接到土地/特殊地點的頭尾連接不動）。`);
  }
  logMsg(`🏛 (${gx},${gy}) 新增特殊地點 ${r.locId}「${name}」：圖塊 ${tiles[0]}~${tiles[3]}、佔 2x2 四格、` +
    `座標 (${gx},${gy})、SPECIAL=${kind}、地段=0。`);
  logMsg(`　自動接方向：${(r.wired ?? []).map(w => w.dir + '→' + w.tgt).join('、') || '（四周沒有路徑格，要自己接方向，否則玩家走不進來）'}`);

  const rep = recomputeRouting(workspace.mapGrid, locDataView, { boundary, forceIds: [r.locId!] });
  if (rep.ok) {
    logMsg(`　路由已算出：UNKA(往監獄)=${getLocField(LOC_FIELDS.UNKA, r.locId!)}、UNKB(往醫院)=${getLocField(LOC_FIELDS.UNKB, r.locId!)}` +
      (rep.a.stillBroken.length + rep.b.stillBroken.length > 0 ? '　⚠ 仍有格子路由不通，方向可能還沒接好' : ''));
  } else {
    logMsg(`　⚠ 路由沒算成：${rep.error}`);
  }

  afterSpecialEdit(true);
}

function rebuildDskBuffer(): ArrayBuffer | null {
  if (!workspace.rawDskBuffer) return null;

  // 處理額外增加的地段價格資料
  let finalPriceData = workspace.priceData;
  if (workspace.priceData && Object.keys(extraPriceData).length > 0) {
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
    workspace.priceData = newPriceArr;
    priceDataView = newPriceDV;
  }

  return rebuildDskBufferCore(workspace.rawDskBuffer, workspace.dskGroupPointers, workspace.mapLayout, workspace.locData, finalPriceData, logMsg);
}

// === 新增：重建 PAK 檔案的函式 ===
function rebuildPakBuffer(): ArrayBuffer | null {
  if (!workspace.rawPakBuffer || workspace.pakGroupPointers.length < 2) {
    logMsg("靠北，PAK 還沒載入！");
    return null;
  }

  let curBytes = new Uint8Array(workspace.rawPakBuffer);
  let curPtrs = workspace.pakGroupPointers.slice();

  // 1. 打包地圖邏輯座標 (第 2 組，陣列 index 1)
  const gridBytes = new Uint8Array(1296 * 2);
  const gridDv = new DataView(gridBytes.buffer);
  for (let i = 0; i < 1296; i++) {
    gridDv.setUint16(i * 2, workspace.mapGrid[i], true);
  }

  // 直接借用 replaceGroupInDsk，因為 PAK 和 DSK 的封裝結構一模一樣
  // (如果你把這函式搬到 parser.ts 了，記得確認上面有 import 進來)
  const r1 = replaceGroupInDsk(curBytes, curPtrs, 1, gridBytes);
  curBytes = r1.bytes;
  curPtrs = r1.ptrs;
  logMsg("PAK 地圖座標已重新壓縮。");

  // 2. 打包文字訊息 (第 3 組，陣列 index 2) - 這樣你新增的地段名稱才會存檔！
  if (curPtrs.length >= 3 && workspace.pakTextLines.length > 0) {
    // DOS 遊戲通常使用 \r 斷行
    const textContent = workspace.pakTextLines.join('\r');
    const textBytes = new Uint8Array(iconv.encode(textContent, 'big5'));
    const r2 = replaceGroupInDsk(curBytes, curPtrs, 2, textBytes);
    curBytes = r2.bytes;
    curPtrs = r2.ptrs;
    logMsg("PAK 文字訊息已重新壓縮。");
  }

  logMsg(`PAK 重建完成，新大小: ${curBytes.length} bytes (原: ${workspace.rawPakBuffer.byteLength} bytes)`);
  return curBytes.buffer;
}

// 註：UI 改版後已無「匯出 DSK / 匯出 PAK」按鈕，改用「儲存到遊戲」直接寫回資料夾。
// 對應的 downloadBuffer / exportDskBtn / exportPakBtn 三段死碼已移除
// （其中 exportDskBtn 未加 null 防護，曾害得它之後的所有事件綁定全部失效）。

(document.getElementById('syncMarkerBtn') as HTMLButtonElement).addEventListener('click', function () {
  flushAllEdits();
  const syncFn = (window as any).syncMarkerTilesFromOwnership;
  if (typeof syncFn !== 'function') {
    logMsg("同步函式尚未就緒（請稍後再試）");
    return;
  }
  mark('同步購地標記圖塊');
  syncFn(1, 2);
  logMsg("已依 OWNER/HOUSE 自動同步 loc+950 的購地標記圖塊。");
});

// 「修復地圖」：自動修可安全修的（座標同步、清除孤兒記錄），其餘列在警告頁
const repairMapBtn = document.getElementById('repairMapBtn');
if (repairMapBtn) {
  repairMapBtn.addEventListener('click', function () {
    flushAllEdits();
    if (!locDataView) { logMsg('請先載入 DSK 才能修復！'); return; }
    mark('修復地圖');
    const { fixed, remaining } = repairMap(workspace.mapGrid, locDataView, getSpecialBoundary(), integrityOpts());
    logMsg(`🔧 修復完成：自動修正 ${fixed} 項；剩餘 ${remaining.length} 項需人工判斷（見警告頁）。`);
    renderer.redraw();
    runValidation();
  });
}

/** 把海上道路現況講成一句話，載入地圖與按「修復海路」都用它。 */
function seaRoadSummary(): string {
  const s = scanSeaRoads(workspace.mapGrid, workspace.mapLayout, locDataView!, getSpecialBoundary());
  if (s.ids.length === 0) return '這張圖沒有海上道路。';
  return `海上道路 ${s.ids.length} 條：編號 ${fmtRange(s.ids)}（特殊地點 ${s.specialCount} 個，海路應接在其後＝${fmtRange(s.want)}）` +
    (s.ok ? '　✅ 位置正確。' : '　⚠ 對不上，按「修復海路」整段重編。');
}

// 「修復海路」：海上道路的編號必須緊接在特殊地點之後、連號排下去。
// 引擎用 [0x1098] 當界，1~N 全被當成特殊地點，所以特殊地點一增加，整段海路就得往後挪，
// 中間不能留空號。方向連接由 renameLocation 連帶修正（指向舊編號的指標一起改），
// 接到土地/特殊地點的頭尾連接因為對方沒改號，自然不會被動到。
const repairSeaBtn = document.getElementById('repairSeaBtn');
if (repairSeaBtn) {
  repairSeaBtn.addEventListener('click', function () {
    flushAllEdits();
    if (!locDataView) { logMsg('請先載入地圖才能修復海路！'); return; }
    const before = scanSeaRoads(workspace.mapGrid, workspace.mapLayout, locDataView, getSpecialBoundary());
    if (before.ids.length === 0) { logMsg('這張圖沒有海上道路，不用修。'); return; }
    if (before.ok) { logMsg(`🌊 ${seaRoadSummary()}　不用動。`); return; }

    mark('修復海路');
    const r = repairSeaRoads(workspace.mapGrid, workspace.mapLayout, locDataView, getSpecialBoundary());
    if (!r.ok) {
      logMsg(`❌ 修復海路失敗：${r.error}`);
      if (r.moved.length > 0) { doUndo(); logMsg('　已復原，地圖沒有被改到一半。'); }
      return;
    }
    const m = r.moved.slice().sort((a, b) => a.from - b.from);
    logMsg(`🌊 海上道路整段重編：${fmtRange(m.map(x => x.from))} → ${fmtRange(m.map(x => x.to))}（共改 ${m.length} 條）。`);
    logMsg(`　方向連接一起修正了：指向這些海路的指標全部跟著改號；接到土地/特殊地點的頭尾連接沒有被動到。`);
    for (const x of m.slice(0, 6)) {
      const dirs = ([
        [LOC_FIELDS.LEFT, '左'], [LOC_FIELDS.UP, '上'],
        [LOC_FIELDS.RIGHT, '右'], [LOC_FIELDS.DOWN, '下'],
      ] as const).map(([f, n]) => {
        const t = getLocField(f, x.to);
        return t ? `${n}→${t}` : '';
      }).filter(Boolean).join('、');
      logMsg(`　　${x.from} → ${x.to}　(${getLocField(LOC_FIELDS.X, x.to)},${getLocField(LOC_FIELDS.Y, x.to)})　${dirs}`);
    }
    if (m.length > 6) logMsg(`　　…還有 ${m.length - 6} 條`);
    renderer.redraw();
    drawSelection();
    runValidation();
  });
}

// 「重算路由」：修正 UNKA(往監獄)/UNKB(往醫院)。
// 這兩欄是警車/救護車/出獄出院的位移表；新增土地沒設好會讓整條路線斷掉、玩家亂跑。
// 真正的不變式是「沿著它走一定到得了入口格」，不是「一定要最短路」——原版本來就有很多
// 刻意不走最短路但收斂正常的格子，所以預設只修真正斷掉的（repair），不動其他。
function fmtIds(ids: number[], max = 20): string {
  return ids.slice(0, max).join(', ') + (ids.length > max ? ` …(共${ids.length})` : '');
}

function logRoutingReport(rep: RoutingReport, prefix: string): void {
  logMsg(`${prefix}模式=${rep.mode === 'repair' ? '只修斷掉的' : '全面最短路重寫'}，監獄入口格=${rep.jailEntry}，醫院入口格=${rep.hospitalEntry}，共 ${rep.total} 格。`);
  for (const [label, r] of [['UNKA(往監獄)', rep.a], ['UNKB(往醫院)', rep.b]] as const) {
    logMsg(`　${label}：原本斷掉 ${r.brokenBefore.length} 格 → 改寫 ${r.changed.length} 格${r.changed.length ? `（${fmtIds(r.changed)}）` : ''}`);
    if (r.stillBroken.length > 0) logMsg(`　　❌ 仍然斷掉 ${r.stillBroken.length} 格：${fmtIds(r.stillBroken)}（多半是方向指標沒接好，請先修路徑）`);
    if (r.unreachable.length > 0) logMsg(`　　⚠ 路徑圖上根本連不到入口 ${r.unreachable.length} 格：${fmtIds(r.unreachable)}`);
  }
  if (rep.ambiguousJail.length > 0) logMsg(`　⚠ 有多格 UNKA=0（${rep.ambiguousJail.join(', ')}），已採用 ${rep.jailEntry} 當監獄入口。`);
  if (rep.ambiguousHospital.length > 0) logMsg(`　⚠ 有多格 UNKB=0（${rep.ambiguousHospital.join(', ')}），已採用 ${rep.hospitalEntry} 當醫院入口。`);
}

const recomputeRouteBtn = document.getElementById('recomputeRouteBtn');
if (recomputeRouteBtn) {
  recomputeRouteBtn.addEventListener('click', function (ev: MouseEvent) {
    flushAllEdits();
    if (!locDataView) { logMsg('請先載入 DSK 才能重算路由！'); return; }
    const boundary = getSpecialBoundary();
    const mode = ev.shiftKey ? 'rebuild' : 'repair';   // 按住 Shift＝全面最短路重寫
    const pre = recomputeRouting(workspace.mapGrid, locDataView, { boundary, mode, dryRun: true });
    if (!pre.ok) { logMsg(`❌ 路由檢查失敗：${pre.error}`); return; }

    const broken = pre.a.brokenBefore.length + pre.b.brokenBefore.length;
    const willChange = pre.a.changed.length + pre.b.changed.length;
    const nonShortest = pre.a.nonShortest.length + pre.b.nonShortest.length;

    if (willChange === 0) {
      logMsg(`🧭 路由檢查：${pre.total} 格全部收斂，無需修改。` +
        (nonShortest > 0 ? `（其中 ${nonShortest} 格不走最短路，但都到得了，跟原版一樣，不動。）` : ''));
      return;
    }

    const ok = confirm(
      (mode === 'rebuild' ? '【全面最短路重寫】\n\n' : '【修復路由】\n\n') +
      `監獄入口格：${pre.jailEntry}　醫院入口格：${pre.hospitalEntry}　共 ${pre.total} 格\n\n` +
      `目前有 ${broken} 格路由是斷的（警車/救護車走到這裡會亂跑）。\n` +
      `本次將改寫 ${willChange} 格：UNKA ${pre.a.changed.length} 格、UNKB ${pre.b.changed.length} 格。\n\n` +
      (mode === 'repair'
        ? `另有 ${nonShortest} 格不走最短路但能正常到達（原版就是這樣寫的），保留不動。\n` +
          `若真的要全部改成最短路，按住 Shift 再點一次本按鈕。\n\n`
        : `⚠ 這會把原版刻意繞路但正常的格子也改掉，行為會偏離原版。\n\n`) +
      `只改記憶體、尚未寫檔，不滿意可重新載入地圖還原。要套用嗎？`
    );
    if (!ok) return;

    mark(mode === 'repair' ? '修復路由' : '重寫路由(最短路)');
    const rep = recomputeRouting(workspace.mapGrid, locDataView, { boundary, mode });
    logRoutingReport(rep, '🧭 路由處理完成：');
    runValidation();
  });
}

// 「複製價格」：把另一個地段的完整價格結構(土地價/增值/各級過路費)複製到目前地段
const autoFillPriceBtn = document.getElementById('autoFillPriceBtn');
if (autoFillPriceBtn) {
  autoFillPriceBtn.addEventListener('click', function () {
    flushAllEdits();
    if (!priceDataView) { logMsg('請先載入 DSK！'); return; }
    if (currentPriceSeg <= 0) { logMsg('請先選一個土地格（要有地段）。'); return; }
    const src = prompt(`要把哪個地段的價格複製到地段 ${currentPriceSeg}？（輸入來源地段編號 1~44）`, '');
    if (src === null) return;
    const from = parseInt(src) || 0;
    mark('複製價格');
    const n = copySegmentPrices(from, currentPriceSeg);
    if (n > 0) { logMsg(`已把地段 ${from} 的價格複製到地段 ${currentPriceSeg}（${n} 欄）。`); renderPriceTable(currentPriceSeg); }
    else logMsg('複製失敗：來源/目標地段無效或相同。');
  });
}

// 「新增土地」：把選取的格子做成一塊完整、可運作的買賣土地
const addLandBtn = document.getElementById('addLandBtn');
if (addLandBtn) {
  addLandBtn.addEventListener('click', function () {
    flushAllEdits();
    if (!workspace.locData || !locDataView) { logMsg('請先載入 DSK！'); return; }
    if (selectedGridX < 0) { logMsg('請先在地圖上點選要放土地的格子。'); return; }
    // 先記快照：底下有好幾個 prompt，使用者中途按取消時 grid 可能已經被改過，
    // 有這一步就能靠「復原」清乾淨。
    mark('新增土地');
    const ci = selectedGridY * GRID_COLS + selectedGridX;
    const boundary = getSpecialBoundary();

    // 決定土地編號：此格若已是道路/土地(路徑編號)就沿用（把道路轉成土地，方向沿用）；否則配一個自由編號
    const cur = workspace.mapGrid[ci];
    let base: number;
    if (cur > boundary && cur <= 282) {
      base = cur;
    } else {
      base = findFreeLandId(workspace.mapGrid, locDataView, boundary);
      if (base < 0) { logMsg('沒有可用的土地編號了（道路/土地區已滿，或需先 patch Run.exe 開放 maxLocId）。'); return; }
      workspace.mapGrid[ci] = base;
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
      if (nm) setSegName(seg, nm);
    }
    if (seg < 1 || seg >= PRICE_SEG_COUNT) { logMsg(`地段 ${seg} 超出範圍 (1~44)。`); return; }

    // 基本欄位
    setLocField(LOC_FIELDS.SPECIAL, base, 0);
    setLocField(LOC_FIELDS.OWNER, base, 0);
    setLocField(LOC_FIELDS.HOUSE, base, 0);
    setLocField(LOC_FIELDS.RESERVE, base, 0);
    // 路由先填非 0 佔位（0 是監獄/醫院入口格的專屬標記，留著會被誤判成第二個入口），
    // 底下的 recomputeRouting(forceIds) 會換成算出來的真值。
    if (getLocField(LOC_FIELDS.UNKA, base) === 0) setLocField(LOC_FIELDS.UNKA, base, 1);
    if (getLocField(LOC_FIELDS.UNKB, base) === 0) setLocField(LOC_FIELDS.UNKB, base, 1);

    // 先放購地標記到相鄰空格（讓 applySegmentDerivedFields 的方向判斷讀得到）
    const markerId = base + 950;
    if (!workspace.mapGrid.some((v: number) => v === markerId)) {
      let placed = false;
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
        const nx = selectedGridX + dx, ny = selectedGridY + dy;
        if (nx < 0 || nx >= GRID_COLS || ny < 0 || ny >= GRID_ROWS) continue;
        const nci = ny * GRID_COLS + nx;
        if (workspace.mapGrid[nci] === 0) { workspace.mapGrid[nci] = markerId; workspace.mapLayout[nci] = 1; placed = true; break; }
      }
      if (!placed) logMsg(`（找不到相鄰空格放購地標記 ${markerId}，可稍後手動放置）`);
    }

    // 地段衍生欄位 + 座標 + 方向
    applySegmentDerivedFields(base, seg);
    setLocWithCoords(base, selectedGridX, selectedGridY);
    const wired = wireDirectionsFromGrid(workspace.mapGrid, locDataView, base);
    logMsg(`土地 ${base}（地段 ${seg}）已建立；自動接方向：${wired.map((w: any) => w.dir + '→' + w.tgt).join('、') || '（無相鄰路徑，請手動接方向）'}`);

    // 確保地段有土地買價
    if (priceDataView && getPriceField(0, seg) === 0) {
      const pStr = prompt(`地段 ${seg} 尚無土地買價，請輸入土地價格：`, '600');
      const p = parseInt(pStr || '0') || 0;
      if (p > 0) setPriceField(0, seg, p);
    }

    // 路由重算：新土地的 UNKA/UNKB 必須指向監獄/醫院，否則警車/救護車經過它會亂走
    const rep = recomputeRouting(workspace.mapGrid, locDataView, { boundary, forceIds: [base] });
    if (rep.ok) logRoutingReport(rep, '🧭 已重算路由：');
    else logMsg(`⚠ 路由重算略過：${rep.error}`);

    renderer.redraw();
    openEditPanel(selectedGridX, selectedGridY);
    runValidation();
    logMsg('✅ 新增土地完成。若「警告」頁出現死胡同/幽靈指標，代表方向還沒接好，請補齊後再按一次「重算路由」。');
  });
}

// ============ 遊戲資料夾工作流（File System Access API）============
// 選遊戲資料夾 → 用下拉選單選地圖 → 一次性把 DSK/PAK/EXE 寫回資料夾
/**
 * 把 workspace 解析出來的位元組接成 DataView。
 * ⚠️ UI 改版把解析搬進 Workspace 時漏掉了這一步，導致 locDataView 永遠是 null ——
 * 地點編輯、完整性檢查、新增土地、修復路由全部靜默失效。每次載入 DSK 都必須呼叫。
 */
function syncDataViews(): void {
  const loc = workspace.locData;
  locDataView = loc ? new DataView(loc.buffer, loc.byteOffset, loc.byteLength) : null;
  const pr = workspace.priceData;
  priceDataView = pr ? new DataView(pr.buffer, pr.byteOffset, pr.byteLength) : null;
  (window as any)._locDataView = locDataView;
}

function applyPakBuffer(buf: ArrayBuffer, fileName: string): void {
  workspace.rawPakBuffer = buf.slice(0);
  loadedPakFileName = fileName;
  workspace.loadPak(buf);

  // 換地圖 = 換圖塊集，tilePicker 有「已經長出來就不重建」的防呆，這裡得先清空才會依新 PAK 重建
  const wrap = document.getElementById('tilePickerWrap');
  if (wrap) wrap.innerHTML = '';
}

function applyDskBuffer(buf: ArrayBuffer, fileName: string): void {
  workspace.rawDskBuffer = buf.slice(0);
  loadedDskFileName = fileName;
  workspace.loadDsk(buf);
  syncDataViews();
}

/** 載入新地圖後把畫面整個刷新：重畫、清掉舊選取、重跑驗證。 */
function refreshAfterLoad(): void {
  selectedGridX = -1;
  selectedGridY = -1;
  selection.clear();
  updateSelectionLabel();
  // 這兩份是「超出原生 45 段的額外地段」暫存，換地圖後必須清掉，否則會污染新地圖
  for (const k of Object.keys(extraSegNames)) delete extraSegNames[Number(k)];
  for (const k of Object.keys(extraPriceData)) delete extraPriceData[Number(k)];
  renderer.redraw();
  renderPriceTable(0);
  runValidation();
}
let currentMapIndex = 0;

/** 目前這張圖的特殊地點掃描結果（圖塊 + 佔格數 + SPECIAL 欄位交叉確認）。 */
function specials() {
  return scanSpecials(workspace.mapGrid, workspace.mapLayout, locDataView, getSpecialBoundary());
}

/**
 * 推算「特殊地點數」[0x1098]＝確認過的特殊地點裡最大的編號。
 *
 * 確認條件有兩個，缺一不可：
 *  1. **佔 2x2 四格**（一般道路含海上道路只佔一格）
 *  2. **圖塊是連號四塊**，左上角 = 40 + 種類*4（例如卡片 = 52,53,54,55）
 *
 * 只用 (1) 的話，任何 2x2 的東西都會被當成特殊地點；加上 (2) 才真的認得出身分，
 * 而且圖塊本身就證明了那四格屬於同一個 locId。三張原版圖 90 個特殊地點零例外。
 *
 * ⚠ 不能用「SPECIAL>0」判斷：公園的 SPECIAL 就是 0（台灣 6/13、香港 2/20、城 1/40 號），
 * 結尾若是公園會被漏掉。大富翁城的 40 號正是這種情況，舊寫法會算成 39，
 * 寫回 exe 就把 40 號踢出特殊區了。
 */
function autoSpecialCount(): number {
  return specials().count;
}

/** 把特殊數設成 n 是否安全？回傳 1..n 之間「確認不了是特殊地點」的編號（設下去會讓引擎誤判、踩上去當機）。 */
function badSpecialIds(n: number): number[] {
  const ok = new Set(specials().confirmed.map(b => b.locId));
  const bad: number[] = [];
  for (let id = 1; id <= n; id++) if (!ok.has(id)) bad.push(id);
  return bad;
}
/**
 * 掃過資料夾裡所有含文字的 PAK，蒐集遊戲字型支援的字集。
 * 只需在選好資料夾後做一次。
 */
/**
 * 算出每張圖「實際用到的最大地點編號」，當作要寫進 exe 的 maxLocId。
 * 目前這張圖用記憶體裡的 grid（可能剛編輯過還沒存），其他張圖從資料夾的 PAK 讀。
 * 讀不到的圖回 null＝不要動它的設定。
 */
async function computeMaxLocByMap(): Promise<(number | null)[]> {
  const out: (number | null)[] = [];
  for (let i = 0; i < MAPS.length; i++) {
    if (i === currentMapIndex && workspace.isSaveLoaded) {
      let max = 0;
      for (const v of workspace.mapGrid) if (v > 0 && v <= 282 && v > max) max = v;
      out.push(max > 0 ? max : null);
      continue;
    }
    const buf = await tryReadFile(MAPS[i].pak);
    if (!buf) { out.push(null); continue; }
    try {
      const dvv = new DataView(buf);
      const bytes = decompressGeneralData(dvv, parsePackPointers(dvv)[1]);
      const gv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let max = 0;
      for (let c = 0; c < 1296; c++) { const v = gv.getUint16(c * 2, true); if (v > 0 && v <= 282 && v > max) max = v; }
      out.push(max > 0 ? max : null);
    } catch { out.push(null); }
  }
  return out;
}

/**
 * 「字表」＝一整段連續的 2-byte Big5 碼，沒有任何雜訊。用這個形狀去認，
 * 就不必寫死是第幾組，換版本也不會抓錯（圖像資料一定過不了首位元組的檢查）。
 */
function parseCharTable(bytes: Uint8Array): string[] | null {
  if (bytes.length < 400 || bytes.length % 2 !== 0) return null;
  for (let i = 0; i < bytes.length; i += 2) {
    const hi = bytes[i];
    if (hi < 0x81 || hi > 0xfe) return null;      // 不是 Big5 首位元組 → 這組不是字表
  }
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += 2) {
    out.push(iconv.decode(Buffer.from(bytes.slice(i, i + 2)), 'big5'));
  }
  return out;
}

/** 把讀到／補完的字表灌回快取。缺字警告與「遊戲會顯示成什麼」都吃這兩份資料。 */
function setCharTable(tbl: string[]): void {
  charTable.length = 0;
  charTable.push(...tbl);
  gameCharset.clear();
  for (const ch of tbl) if (HAN.test(ch)) gameCharset.add(ch);
}

async function buildGameCharset(): Promise<void> {
  // 點陣圖庫決定「缺字補不補得起來」，跟資料夾無關，先載起來（失敗也不擋編輯）
  if (!atlasReady()) {
    try {
      await loadGlyphAtlas();
      logMsg('已載入細明體點陣圖庫，缺字可在存檔時自動補進遊戲字型。');
    } catch (err) {
      logMsg(`⚠ 點陣圖庫載入失敗（${(err as Error).message}），缺字只能提醒、無法自動補。`);
    }
  }
  if (gameCharset.size > 0) return;

  // 1) 首選：Wor.pak 裡那張全遊戲共用的字表。這是權威來源 —— 它決定了遊戲畫得出哪些字，
  //    順序也決定了字形的 index（表尾那個字就是所有查不到的字會變成的樣子）。
  const wor = await tryReadFile(CHAR_TABLE_FILE);
  if (wor) {
    try {
      const dvv = new DataView(wor);
      for (const p of parsePackPointers(dvv)) {
        const tbl = parseCharTable(decompressGeneralData(dvv, p));
        if (!tbl) continue;
        charTable.push(...tbl);
        for (const ch of tbl) if (HAN.test(ch)) gameCharset.add(ch);
        logMsg(`已讀取遊戲字表（${CHAR_TABLE_FILE}）：${tbl.length} 項、漢字 ${gameCharset.size} 個，字形照這個順序排，三張圖共用同一份。`);
        logMsg(`　表外的字會顯示成表尾的「${tbl[tbl.length - 1]}」；Big5 罕用字（首位元組 < 0xA1）更糟，會讓整串排版錯位。`);
        return;
      }
    } catch { /* 認不出來就往下走備援 */ }
  }

  // 2) 備援：沒有 Wor.pak 時，退回「三張圖原版文字出現過的字」。實測這個聯集跟上面那張表
  //    完全相同，所以是安全的替代品，只是拿不到表尾那個字。
  //    ⚠ 只讀真正的文字群組（地圖 PAK 的第 3 組）。把圖像等二進位資料當 Big5 解會產生
  //    大量假的漢字，字集被灌水就失去把關意義。
  for (const m of MAPS) {
    const buf = await tryReadFile(m.pak);
    if (!buf) continue;
    try {
      const dvv = new DataView(buf);
      const ptrs = parsePackPointers(dvv);
      if (ptrs.length < 3) continue;
      const bytes = decompressGeneralData(dvv, ptrs[2]);
      for (const ch of hanChars(iconv.decode(Buffer.from(bytes), 'big5'))) gameCharset.add(ch);
    } catch { /* 這個檔沒有文字群組，略過 */ }
  }
  if (gameCharset.size > 0) {
    logMsg(`找不到 ${CHAR_TABLE_FILE}，改用三張圖原版文字推出的字集：${gameCharset.size} 個漢字。`);
  }
}

/**
 * 存檔時自動補字：掃過**真的會寫進 PAK 的那份文字**，把遊戲畫不出來的字
 * 加進 `Wor.pak` 的字表與字形。
 *
 * 為什麼綁在存檔而不是打字當下：打一個字就寫一次磁碟太粗暴，而且名稱還在改的中途，
 * 會把半成品的字一起塞進字表。存檔是文字定案、本來就要落地的時間點。
 *
 * 只看 `pakTextLines`（PAK 第 3 組）——超出原生 44 段的額外地段沒有對應行、進不了遊戲，
 * 幫它們補字沒有意義。
 */
async function autoPatchGameFont(): Promise<void> {
  // 圖庫平常在選資料夾時就載好了，但那條路不是唯一入口（重整後沒重選資料夾就會沒載到）。
  // 這裡補載一次，免得整個功能默默不動、使用者還以為沒生效。
  if (!atlasReady()) {
    try { await loadGlyphAtlas(); } catch (err) {
      logMsg(`　字型：點陣圖庫載入失敗（${(err as Error).message}），這次不補字。`);
      return;
    }
  }
  if (charTable.length === 0) {
    logMsg(`　字型：讀不到 ${CHAR_TABLE_FILE} 的字表，這次不補字。`);
    return;
  }

  const need = new Set<string>(), desync = new Set<string>(), noGlyph = new Set<string>();
  for (const line of workspace.pakTextLines) {
    for (const b of unsupportedChars(line)) {
      if (b.why === 'desync') desync.add(b.ch);
      else if (canAddChar(b.ch)) need.add(b.ch);
      else noGlyph.add(b.ch);
    }
  }

  // 不管有沒有事做都要回報一句 —— 「沒有輸出」跟「沒有生效」在畫面上長得一樣，
  // 使用者無從判斷，這正是上一版最大的問題。
  if (need.size === 0) {
    logMsg(`　字型：地圖文字沒有需要補的字（目前字表 ${charTable.length} 字）。`);
  } else {
    const before = charTable.length;
    const r = await addCharsToGameFont([...need], logMsg);
    setCharTable(r.table);
    logMsg(`🆕 ${CHAR_TABLE_FILE}：已補上「${r.added.join('」「')}」共 ${r.added.length} 個字` +
      `（字表 ${before} → ${r.table.length}，字形用細明體點陣）。`);
    for (const ch of r.noGlyph) noGlyph.add(ch);
  }

  // 補不了的兩種，每次存檔都講一次 —— 它們會讓遊戲畫面出錯，不該被忽略
  if (desync.size) {
    const shown = [...desync].map(ch => {
      const b5 = iconv.encode(ch, 'big5');
      return `「${ch}」(${b5[0].toString(16)} ${b5[1].toString(16)})`;
    }).join('、');
    logMsg(`　❌ 字型：${shown} 是 Big5 罕用字，首位元組 < 0xA1 —— 遊戲不把它當雙位元組開頭，` +
      `會把低位元組當英數字印出來、後面整串排版跟著錯開。<b>這種字加進字表也沒用</b>，只能換字。`);
  }
  if (noGlyph.size) {
    logMsg(`　⚠ 字型：「${[...noGlyph].join('」「')}」細明體點陣圖庫裡沒有，補不進去，會顯示成字表最後一個字。`);
  }
}

async function loadMapFromFolder(idx: number): Promise<void> {
  const m = MAPS[idx]; if (!m) return;
  currentMapIndex = idx;
  try {
    applyPakBuffer(await readGameFile(m.pak), m.pak);
    applyDskBuffer(await readGameFile(m.dsk), m.dsk);
    refreshAfterLoad();   // ← 少了這步，資料進了記憶體但畫面不會更新，看起來就像「載不進來」
    history.clear();      // 舊地圖的復原記錄對新地圖沒意義
    const statusMap = document.getElementById('statusMap');
    if (statusMap) statusMap.textContent = m.name;
    logMsg(`已從遊戲資料夾載入【${m.name}】：${m.pak} + ${m.dsk}` +
      `（圖塊 ${workspace.mapTilesData.length / 480} 個、地段 ${workspace.segmentNames.length - 1} 個、${locDataView ? '地點資料已就緒' : '⚠ 地點資料讀取失敗'}）`);
    // 「還能不能加地點」是硬上限（引擎的 loc 陣列只有 283 格），一載入就先講，
    // 別讓人貼了半天圖塊才發現配不到編號 —— 大富翁城原版就是 0 個可用。
    if (locDataView) {
      const free = freeLandIdCount();
      logMsg(free > 0
        ? `　可用地點編號還有 ${free} 個（51~${MAX_LOC_ID}）。`
        : `　⚠ 可用地點編號 0 個 —— 51~${MAX_LOC_ID} 已全被佔用，這張圖<b>加不了新地點</b>，` +
          `要新增請先貼一個沒有地點語意的圖塊把用不到的地點刪掉。`);
    }
    // 讀 exe 目前的特殊地點數，顯示到欄位
    try {
      const sc = await readSpecialCount(idx);
      const inp = document.getElementById('specialCountInput') as HTMLInputElement | null;
      if (inp) inp.value = sc.toString();
      exeSpecialCount = sc;
      logMsg(`目前【${m.name}】特殊地點數 [0x1098] = ${sc}（自動推算最大特殊編號 = ${autoSpecialCount()}）`);
    } catch { exeSpecialCount = null; /* 沒有 exe 也沒關係，只是不做比對 */ }
    // 海上道路：編號緊接在特殊地點之後，跟陸上道路不是同一種東西，載入時先報現況
    if (locDataView) logMsg(`🌊 ${seaRoadSummary()}`);
    runValidation();   // exe 值進來了，重跑一次才會出現「特殊數對不上」的警告
  } catch (err) {
    logMsg(`載入【${m.name}】失敗：${(err as Error).message}`);
  }
}
async function saveToGame(): Promise<void> {
  flushAllEdits();   // 剛打完還沒過延遲的欄位，先寫進去再存檔
  if (!hasFolder()) { logMsg('請先「選擇遊戲資料夾」。'); return; }
  if (!workspace.isSaveLoaded) { logMsg('尚未載入地圖，無法存回。'); return; }
  try {
    const syncFn = (window as any).syncMarkerTilesFromOwnership;
    // 這一步會改 mapLayout（依 OWNER/HOUSE 換購地標記圖塊），所以也要能復原
    if (typeof syncFn === 'function') { mark('儲存前同步購地標記'); syncFn(1, 2); }
    if (locDataView) {
      const issues = analyzeIntegrity(workspace.mapGrid, locDataView, getSpecialBoundary(), integrityOpts());
      if (issues.length) logMsg(`⚠ 偵測到 ${issues.length} 個結構問題（見警告頁），仍照你的意思寫回。`);
    }
    // 缺字先補進遊戲字型，再寫地圖 —— 補失敗就別寫出「遊戲畫不出來的名字」
    try {
      await autoPatchGameFont();
    } catch (err) {
      logMsg(`⚠ 自動補字失敗（${(err as Error).message}），${CHAR_TABLE_FILE} 未更動，地圖照常寫回。`);
    }

    const dskBuf = rebuildDskBuffer();
    const pakBuf = rebuildPakBuffer();
    if (dskBuf) await writeGameFile(loadedDskFileName, dskBuf, logMsg);
    if (pakBuf) await writeGameFile(loadedPakFileName, pakBuf, logMsg);
    // 特殊地點數：讀欄位（空白＝不動 exe 的 [0x1098]）
    const scInp = document.getElementById('specialCountInput') as HTMLInputElement | null;
    const sc = scInp && scInp.value !== '' ? (parseInt(scInp.value) || 0) : undefined;

    // 寫回 exe 前先擋一次：1~sc 之間若混進確認不了的格子（海上道路那種），
    // 引擎會把它們當特殊地點處理，玩家踩上去會當機。
    if (sc != null && sc > 0) {
      const bad = badSpecialIds(sc);
      if (bad.length > 0) {
        const ok = confirm(
          `特殊地點數要寫入 ${sc}，但編號 ${bad.join('、')} 確認不了是特殊地點\n` +
          `（特殊地點要同時滿足：佔 2x2 四格 + 圖塊是連號四塊，例如卡片 = 52,53,54,55；\n` +
          `　一般道路只佔 1 格、圖塊 84）。\n\n` +
          `引擎會把 1~${sc} 全部當成特殊地點，玩家踩到這些格子可能當機。\n\n` +
          `仍要寫入嗎？`
        );
        if (!ok) { logMsg('已取消存檔（特殊地點數未通過檢查）。'); return; }
      }
    }

    const maxLocByMap = await computeMaxLocByMap();
    const r = await patchExe(logMsg, currentMapIndex, sc, maxLocByMap);
    logMsg(`✅ 已一次性寫回：${loadedDskFileName}、${loadedPakFileName}、Run.exe`);
    if (r.maxLocChanged > 0) {
      logMsg(`　Run.exe：${r.maxLocChanged} 張圖的地點上限已對齊各圖實際用到的最大編號` +
        `（${MAPS.map((m, i) => `${m.name}=${maxLocByMap[i] ?? '不動'}`).join('、')}）。`);
    }
    if (r.specialChanged) logMsg(`　Run.exe：${MAPS[currentMapIndex].name} 特殊地點數 ${r.specialFrom} → ${r.specialTo}。`);

    // 直接回報 exe 現況，避免「更動 0 張圖」被誤讀成「沒有做 patch」
    const caps = await readCaps();
    // exe 已經寫過了，比對基準要跟著更新，警告才會消失
    if (caps[currentMapIndex]) { exeSpecialCount = caps[currentMapIndex].special; runValidation(); }
    logMsg('　Run.exe 目前設定：' + caps.map((c, i) => {
      const need = maxLocByMap[i];
      const ok = need == null || c.maxLoc >= need;
      return `${c.name} 地點上限=${c.maxLoc}${ok ? '✓' : `✗(需≥${need})`} 特殊數=${c.special}`;
    }).join('｜'));
  } catch (err) {
    logMsg(`存回失敗：${(err as Error).message}`);
  }
}

const pickFolderBtn = document.getElementById('pickFolderBtn');
if (pickFolderBtn) {
  if (!fsSupported()) {
    (pickFolderBtn as HTMLButtonElement).disabled = true;
    pickFolderBtn.textContent = '瀏覽器不支援資料夾存取';
    logMsg('此瀏覽器不支援 File System Access API（只有 Chromium 系有）。請改用 Chrome/Edge，或下載桌面版。');
  } else {
    if (backendKind() === 'tauri') logMsg('桌面版：直接讀寫遊戲資料夾，不需要瀏覽器授權。');
    pickFolderBtn.addEventListener('click', async () => {
      try {
        const name = await pickGameFolder();
        const st = document.getElementById('folderStatus'); if (st) st.textContent = `資料夾：${name}`;
        logMsg(`已選擇遊戲資料夾：${name}`);
        await buildGameCharset();
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

// 「修復特殊」：把特殊數欄位設成自動推算值（最大特殊種類編號）
const specialAutoBtn = document.getElementById('specialAutoBtn');
if (specialAutoBtn) {
  specialAutoBtn.addEventListener('click', () => {
    if (!workspace.isSaveLoaded) { logMsg('尚未載入地圖。'); return; }
    const sc = specials();
    const n = sc.count;
    const inp = document.getElementById('specialCountInput') as HTMLInputElement | null;
    if (inp) inp.value = n.toString();
    const bad = badSpecialIds(n);
    logMsg(`自動推算特殊地點數 = ${n}：確認到 ${sc.confirmed.length} 個特殊地點` +
      `（同時滿足「佔 2x2 四格」與「圖塊是連號四塊」，例如卡片 = 52,53,54,55）。存檔時會寫入 [0x1098]。`);
    logMsg(`　${listSpecials(sc, 1, n)}`);
    if (bad.length) logMsg(`　⚠ 編號 ${bad.join('、')} 確認不了是特殊地點，請先看警告頁。`);
    if (sc.unconfirmed.length) logMsg(`　⚠ 有 ${sc.unconfirmed.length} 處圖塊排成完整 2x2 但四格編號沒統一，見警告頁（「修復地圖」可修其中能判斷的）。`);
    runValidation();   // 欄位填好了，警告要跟著改口（改成「存檔即生效」）
  });
}

// ==== 復原/重做：按鈕 + 快捷鍵 ====
const clearLogBtn = document.getElementById('clearLogBtn');
if (clearLogBtn) clearLogBtn.addEventListener('click', () => { infoBox.innerHTML = '已清除。'; });

const undoBtn = document.getElementById('undoBtn');
if (undoBtn) undoBtn.addEventListener('click', doUndo);
const redoBtn = document.getElementById('redoBtn');
if (redoBtn) redoBtn.addEventListener('click', doRedo);

window.addEventListener('keydown', (e: KeyboardEvent) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
  else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); doRedo(); }
});

// 初始化除錯與分析工具
initDebugTools({
  mapGrid: workspace.mapGrid,
  mapLayout: workspace.mapLayout,
  getLocDataView: () => locDataView,
  getPriceDataView: () => priceDataView,
  getLocField,
  setLocField,
  checkAndRenderRealMap: () => renderer.redraw()
});

}
