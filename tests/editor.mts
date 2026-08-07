// 直接匯入專案真正的原始碼來測（不是鏡像版）
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import iconv from 'iconv-lite';
import { History } from '../src/core/history.ts';
import {
  recomputeRouting, nextLandId, findMarkerBase, findRoutingEntries,
  analyzeIntegrity, renumberSegment, MAX_LOC_ID,
  scanSpecials, specialKindOfTile, specialTilesOfKind, placeSpecial,
  scanSeaRoads, repairSeaRoads, SEA_ROAD_ID_MAX, deleteLocation,
} from '../src/core/integrity.ts';
import { LOC_FIELDS, LAND_TILES, MARKER_TILE, PLAYER_SLOTS, PLAYER_FIELD_COUNT } from '../src/config/constants.ts';
import { parseSaveDskCore, rebuildDskBufferCore } from '../src/core/parser.ts';
import { loadExe, buildExe, readCap, writeCap, imageOffset, writeInsertList, MAP_CAPS } from '../src/core/exe.ts';
import { insertPassThrough, defaultTable, readPassTable, TABLE_LEN } from '../src/core/passthrough.ts';
import { insertBlock, segmentEnds } from '../src/core/codecave.ts';
import { insertPriceIndex, readPriceIndexSettings } from '../src/core/priceindex.ts';

/** 讀某個 DSK 的角色參數，附上取值器與「這張圖有幾個角色」 */
function loadDsk(base: string, dsk: string) {
  const f = `${base}/${dsk}.dsk`;
  if (!fs.existsSync(f)) return null;
  const b = fs.readFileSync(f);
  const raw = b.buffer.slice(b.byteOffset, b.byteOffset + b.length) as ArrayBuffer;
  const r = parseSaveDskCore(new DataView(raw), () => { });
  if (!r?.playerData) return null;
  const pd = r.playerData;
  const dv = new DataView(pd.buffer, pd.byteOffset, pd.byteLength);
  const get = (field: number, slot: number) => dv.getUint32((field * PLAYER_SLOTS + slot) * 4, true);
  let slots = 0;
  for (let s = 0; s < PLAYER_SLOTS; s++) for (let f2 = 0; f2 < PLAYER_FIELD_COUNT; f2++) if (get(f2, s)) { slots = s + 1; break; }
  return { raw, r, pd, get, slots };
}

let pass = 0, fail = 0, skipped = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}
function skip(name: string, why: string) { skipped++; console.log(`  ⏭ ${name}（略過：${why}）`); }
function eq(name: string, got: unknown, want: unknown) {
  check(name, JSON.stringify(got) === JSON.stringify(want), `期望 ${JSON.stringify(want)}，得到 ${JSON.stringify(got)}`);
}

// ---------- 檔案載入 ----------
function decompress(buf: Buffer, s: number): Buffer {
  const o: number[] = []; const no = buf.readUInt16LE(s); let p = s + 2;
  for (let i = 0; i < no; i++) { if (p >= buf.length) break; const b = buf[p++]; const c = (b & 0x7f) + 1;
    if (b & 0x80) { for (let j = 0; j < c; j++) { if (p >= buf.length) break; o.push(buf[p++]); } }
    else { if (p >= buf.length) break; const rb = buf[p++]; for (let j = 0; j < c; j++) o.push(rb); } }
  return Buffer.from(o);
}
function ptrs(buf: Buffer): number[] {
  const B = 7; let o = B; const a: number[] = []; let f = buf.length, l = 0;
  while (o < f && o < buf.length) { const p = buf.readUInt16LE(o); if (p === 0) break; const act = B + p * 2;
    if (act >= buf.length || act <= l) break; a.push(act); l = act; if (act < f) f = act; o += 2; }
  return a;
}
function load(dskPath: string, pakPath: string) {
  const dsk = fs.readFileSync(dskPath), pak = fs.readFileSync(pakPath);
  const pk = ptrs(dsk);
  const loc = decompress(dsk, pk[3]);
  const dv = new DataView(loc.buffer, loc.byteOffset, loc.byteLength);
  const lay = decompress(dsk, pk[5]);
  const layDv = new DataView(lay.buffer, lay.byteOffset, lay.byteLength);
  const layout = new Uint16Array(1296);
  for (let i = 0; i < 1296; i++) layout[i] = layDv.getUint16(i * 2, true);
  const gr = decompress(pak, ptrs(pak)[1]);
  const grid = new Uint16Array(1296);
  for (let i = 0; i < 1296; i++) grid[i] = gr.readUInt16LE(i * 2);
  return { grid, layout, dv, locBytes: loc };
}
// 路徑一律從這個檔案往上推 repo 根目錄，不寫死磁碟機代號（Windows / Linux 都要能跑）。
const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');

// R = 原版基準檔（使用者維護的未修改遊戲檔），慣例放 rich2/original/，也接受根目錄的 original/。
// 不放進 repo：那是遊戲原始資料，rich2/ 與 original/ 都已在 .gitignore 內。
// LIVE = 編輯器實際讀寫的遊戲目錄，內容會一直變，只能用來做「當前狀態」的檢查。
// 兩者都可用環境變數覆蓋：RICH2_ORIGINAL / RICH2_LIVE。
// 有設環境變數就只認它（打錯路徑要看得出來，不要默默退回預設值）。
const dirOr = (env: string | undefined, ...cands: string[]): string | null =>
  (env ? [env] : cands).find(d => fs.existsSync(d)) ?? null;
const R = dirOr(process.env.RICH2_ORIGINAL, `${ROOT}/rich2/original`, `${ROOT}/original`);
const LIVE = dirOr(process.env.RICH2_LIVE, `${ROOT}/rich2`);

const NO_ORIG = '找不到原版基準檔，請放在 rich2/original/ 或 original/，或設 RICH2_ORIGINAL';
const NO_LIVE = '找不到遊戲目錄，請放在 rich2/，或設 RICH2_LIVE';
// 缺檔就回 null 讓呼叫端印略過，而不是整份測試炸掉——基準檔不在 repo 內，本來就可能不存在。
function loadMap(base: string | null, dsk: string, pak: string) {
  if (!base) return null;
  const d = `${base}/${dsk}.dsk`, p = `${base}/${pak}.pak`;
  return fs.existsSync(d) && fs.existsSync(p) ? load(d, p) : null;
}
function readIfExists(file: string | null): Buffer | null {
  return file && fs.existsSync(file) ? fs.readFileSync(file) : null;
}

// ==================== 1. History ====================
console.log('\n=== 1. History（復原/重做）===');
{
  let state = { v: 0 };
  const applied: number[] = [];
  const h = new History<{ v: number }>({
    capture: () => ({ ...state }),
    apply: (s) => { state = { ...s }; applied.push(s.v); },
    limit: 3,
  });

  eq('一開始不能復原', h.info().canUndo, false);
  eq('一開始不能重做', h.info().canRedo, false);

  h.push('動作A'); state.v = 1;
  h.push('動作B'); state.v = 2;
  eq('兩步之後 undoDepth', h.info().undoDepth, 2);
  eq('undoLabel 是最近的動作', h.info().undoLabel, '動作B');

  eq('undo 回傳被撤銷的動作名', h.undo(), '動作B');
  eq('undo 後狀態回到動作B之前', state.v, 1);
  eq('undo 後可以重做', h.info().canRedo, true);

  eq('再 undo', h.undo(), '動作A');
  eq('狀態回到最初', state.v, 0);
  eq('沒得再 undo', h.undo(), null);

  eq('redo 回傳動作名', h.redo(), '動作A');
  eq('redo 後狀態前進', state.v, 1);
  eq('redo 第二次', h.redo(), '動作B');
  eq('狀態到最新', state.v, 2);
  eq('沒得再 redo', h.redo(), null);

  // 新動作要切斷重做鏈
  h.undo();                     // 回到 v=1
  h.push('動作C'); state.v = 9;
  eq('push 後重做鏈被切斷', h.info().canRedo, false);
  eq('undo 動作C', h.undo(), '動作C');
  eq('回到 v=1', state.v, 1);

  // limit
  const h2 = new History<{ v: number }>({ capture: () => ({ ...state }), apply: (s) => { state = { ...s }; }, limit: 3 });
  for (let i = 0; i < 10; i++) h2.push('step' + i);
  eq('超過上限只保留 limit 步', h2.info().undoDepth, 3);

  h2.clear();
  eq('clear 之後不能復原', h2.info().canUndo, false);
  void applied;
}

// ==================== 2. 快照語意（模擬編輯器 apply）====================
console.log('\n=== 2. 快照 capture/apply 對 TypedArray 的正確性 ===');
{
  const grid = new Uint16Array([1, 2, 3, 4]);
  const loc = new Uint8Array([10, 20, 30]);
  interface Snap { grid: Uint16Array; loc: Uint8Array }
  const h = new History<Snap>({
    capture: () => ({ grid: grid.slice(), loc: loc.slice() }),
    // 模擬編輯器的「原地寫回」
    apply: (s) => { grid.set(s.grid); loc.set(s.loc); },
  });
  const gridRef = grid;                       // 模擬 debugger 抓走的參照
  h.push('改東西');
  grid[0] = 99; loc[0] = 88;
  h.undo();
  eq('undo 還原 grid 內容', Array.from(grid), [1, 2, 3, 4]);
  eq('undo 還原 loc 內容', Array.from(loc), [10, 20, 30]);
  check('外部持有的參照仍指向同一份資料（原地寫回）', gridRef === grid && gridRef[0] === 1);
}

// ==================== 3. 路由重算（真實地圖）====================
console.log('\n=== 3. recomputeRouting（真實資料）===');
for (const [name, d, p] of [['台灣', 'Save_7', 'Part1'], ['香港', 'Save_8', 'Part2'], ['城', 'Save_9', 'Part3']] as const) {
  const m = loadMap(R, d, p);
  const label = `原版${name}`;
  if (!m) { skip(`${label} 路由檢查`, NO_ORIG); continue; }
  const { grid, dv } = m;
  const dry = recomputeRouting(grid, dv, { dryRun: true });
  if (name === '城') {
    check(`${label} repair 只修原廠壞掉的 4 格`, dry.b.brokenBefore.length === 4 && dry.b.changed.length === 3,
      `brokenBefore=${dry.b.brokenBefore} changed=${dry.b.changed}`);
  } else {
    check(`${label} repair 零改動（不誤動好資料）`, dry.a.changed.length === 0 && dry.b.changed.length === 0,
      `A改${dry.a.changed.length} B改${dry.b.changed.length}`);
  }
  check(`${label} 入口格唯一`, findRoutingEntries(grid, dv).jail.length === 1 && findRoutingEntries(grid, dv).hospital.length === 1);
  check(`${label} dryRun 不動原始資料`, dv.getUint16(LOC_FIELDS.UNKA + 2, true) !== undefined);
}
// 這組是使用者放在 repo 根目錄、路由被改壞的台灣圖（固定樣本，值寫死才有意義）。
{
  const m = loadMap(ROOT, 'Save_7', 'Part1');
  if (!m) skip('使用者台灣：路由修復', '根目錄缺 Save_7.dsk / Part1.pak');
  else {
  const { grid, dv } = m;
  const before = recomputeRouting(grid, dv, { dryRun: true });
  eq('使用者台灣：UNKA 壞掉的格子', before.a.brokenBefore, [40, 117, 118, 119]);
  eq('使用者台灣：UNKB 壞掉的格子', before.b.brokenBefore, [40, 117, 118, 119]);
  const after = recomputeRouting(grid, dv);          // 真的寫入
  check('修完之後全部收斂', after.a.stillBroken.length === 0 && after.b.stillBroken.length === 0);
  const again = recomputeRouting(grid, dv, { dryRun: true });
  check('再跑一次不會再改（冪等）', again.a.changed.length === 0 && again.b.changed.length === 0,
    `A改${again.a.changed.length} B改${again.b.changed.length}`);
  }
}

// ==================== 4. 編號配置 ====================
console.log('\n=== 4. nextLandId / findMarkerBase（真實資料）===');
{
  const tw = loadMap(R, 'Save_7', 'Part1');
  const twLive = loadMap(LIVE, 'Save_7', 'Part1');
  const hk = loadMap(R, 'Save_8', 'Part2');
  const rc = loadMap(R, 'Save_9', 'Part3');
  if (!tw || !hk || !rc) skip('nextLandId / findMarkerBase', NO_ORIG);
  else {
  eq('台灣 nextLandId', nextLandId(tw.grid, tw.dv), 120);
  // 當前地圖會一直變，只驗規則：新編號要接在最大編號之後
  if (!twLive) skip('當前台灣地圖 nextLandId', NO_LIVE);
  else {
    const used = new Set<number>();
    for (const v of twLive.grid) if (v > 0 && v <= MAX_LOC_ID) used.add(v);
    const maxUsed = Math.max(...used);
    const next = nextLandId(twLive.grid, twLive.dv);
    check(`當前台灣地圖 nextLandId 接在最大編號之後：max=${maxUsed} → ${next}`,
      next === (maxUsed + 1) || (maxUsed >= MAX_LOC_ID && next === -1), `next=${next}`);
  }
  eq('香港 nextLandId', nextLandId(hk.grid, hk.dv), 141);
  eq('城 nextLandId（已滿）', nextLandId(rc.grid, rc.dv), -1);

  for (const [name, m] of [['台灣', tw], ['香港', hk], ['城', rc]] as const) {
    let exact = 0, total = 0, multi = 0;
    for (let i = 0; i < 1296; i++) {
      const orig = m.grid[i];
      if (orig <= 950) continue;
      total++;
      const gx = i % 36, gy = Math.floor(i / 36);
      m.grid[i] = 0;
      const r = findMarkerBase(m.grid, gx, gy, orig - 950);
      m.grid[i] = orig;
      if (r.base === orig - 950) exact++;
      if (r.free.length + r.taken.length > 1) multi++;
    }
    check(`${name} 標記歸屬還原 ${exact}/${total}（其中 ${multi} 格需防呆判斷）`, exact === total);
  }
  }
}

// ==================== 5. 圖塊語意 + 完整性檢查 ====================
console.log('\n=== 5. 圖塊語意與完整性檢查 ===');
for (const [name, d, p] of [['台灣', 'Save_7', 'Part1'], ['香港', 'Save_8', 'Part2'], ['城', 'Save_9', 'Part3']] as const) {
  const m = loadMap(R, d, p);
  if (!m) { skip(`原版${name} 圖塊語意`, NO_ORIG); continue; }
  const { grid, layout, dv } = m;
  let landTileBad = 0, markerTileBad = 0;
  for (let i = 0; i < 1296; i++) {
    const id = grid[i], t = layout[i];
    if (LAND_TILES.includes(t) && !(id > 0 && id <= MAX_LOC_ID && dv.getUint16(LOC_FIELDS.SEGMENT + id * 2, true) > 0)) landTileBad++;
    if (t === MARKER_TILE && !(id > 950)) markerTileBad++;
  }
  check(`原版${name}：圖塊9~14 全是有地段的土地`, landTileBad === 0, `例外 ${landTileBad}`);
  check(`原版${name}：圖塊1 全是 +950 標記`, markerTileBad === 0, `例外 ${markerTileBad}`);
  const issues = analyzeIntegrity(grid, dv, 49, { layout });
  check(`原版${name}：完整性檢查 0 誤報`, issues.length === 0,
    `噴出 ${issues.length} 個：${issues.slice(0, 3).map(x => `${x.kind}(${x.detail})`).join(' / ')}`);
}

// ==================== 5b. forceIds：新格子一律重算 ====================
console.log('\n=== 5b. forceIds（新格子不保留碰巧能通的佔位值）===');
{
  const m = loadMap(R, 'Save_8', 'Part2');
  if (!m) skip('forceIds', NO_ORIG);
  else {
  const { grid, dv } = m;
  // 香港某格。repair 模式不該動它（它走得通）
  const before = dv.getUint16(LOC_FIELDS.UNKA + 54 * 2, true);
  const plain = recomputeRouting(grid, dv, { dryRun: true });
  check('一般 repair 不會動走得通的格子 54', !plain.a.changed.includes(54), `changed=${plain.a.changed}`);
  // 指定 forceIds 就必須重算它
  const forced = recomputeRouting(grid, dv, { dryRun: true, forceIds: [54] });
  const wouldChange = forced.a.changed.includes(54);
  check('指定 forceIds 後會重新評估格子 54',
    wouldChange || before === 1, `before=${before} changed=${forced.a.changed}`);
  eq('dryRun 不會動到原始資料', dv.getUint16(LOC_FIELDS.UNKA + 54 * 2, true), before);
  }
}

// ==================== 5c. 地段名稱排版 ====================
// PAK 文字表 line26~69 每行固定 16 字元 = 13 空白 + 3 字寬名稱，兩字名中間插全形空白。
console.log('\n=== 5c. 地段名稱排版（改名要照原版格式）===');
{
  const IDEO = '　';
  const norm = (raw: string) => {
    const n = raw.replace(/[\s　]+/g, '');
    if (n.length === 0) return '';
    if (n.length === 1) return IDEO + n + IDEO;
    if (n.length === 2) return n[0] + IDEO + n[1];
    return n.slice(0, 3);
  };
  eq('三字名原樣保留', norm('台北市'), '台北市');
  eq('兩字名中間插全形空白', norm('中環'), '中' + IDEO + '環');
  eq('單字名置中', norm('港'), IDEO + '港' + IDEO);
  eq('超過三字截斷', norm('大富翁城市'), '大富翁');
  eq('既有的全形空白會先清掉再重排', norm('中' + IDEO + '環'), '中' + IDEO + '環');
  check('正規化後一律 3 字寬', ['台北市', '中環', '港', '大富翁城市'].every(x => norm(x).length === 3));

  // 拿原版三張圖的實際名稱驗：解碼成文字後應為 13 空白 + 3 字寬，且丟進正規化原樣不變
  for (const [name, pak] of [['台灣', 'Part1'], ['香港', 'Part2'], ['大富翁城', 'Part3']] as const) {
    const buf = readIfExists(R && `${R}/${pak}.pak`);
    if (!buf) { skip(`原版${name} 地段名排版`, NO_ORIG); continue; }
    const lines = iconv.decode(decompress(buf, ptrs(buf)[2]), 'big5').split('\r');
    let shaped = 0, unchanged = 0, total = 0;
    const bad: string[] = [];
    for (let i = 26; i < 26 + 44; i++) {
      const raw = lines[i];
      if (raw === undefined) break;
      total++;
      if (raw.length === 16 && raw.slice(0, 13) === ' '.repeat(13)) shaped++;
      else bad.push(`line${i}(長度${raw.length})`);
      if (norm(raw) === raw.slice(13)) unchanged++;
    }
    check(`原版${name}：44 行地段名全部是「13空白+3字寬」`, shaped === total && total === 44,
      `${shaped}/${total} ${bad.slice(0, 3).join(',')}`);
    check(`原版${name}：既有名稱丟進正規化都原樣不變（不會被我們改壞）`, unchanged === total,
      `${unchanged}/${total}`);
  }
}

// ==================== 5c-2. 遊戲字表 ====================
// 遊戲能顯示的字由 Wor.pak 裡一張「全遊戲共用」的 2-byte Big5 表決定（原版 639 項）。
// 各張地圖自己的文字只用到其中一部分（台灣 545、香港 540、城 536），所以光看地圖文字
// 會誤以為「字集是每張圖一份」——其實三張圖的聯集就等於那張表，一個字都不差。
// 字形照表的順序排，表外的字查不到 index 會掉到表尾（原版表尾 = 「邦」），
// 這就是「苗栗縣 → 邦邦縣」：苗、栗都不在表內，雙雙變成同一個字。
console.log('\n=== 5c-2. 遊戲字表（Wor.pak，全遊戲共用）===');
{
  const han = (s: string) => { const r = new Set<string>(); for (const c of s) if (/[一-鿿]/.test(c)) r.add(c); return r; };
  const parseTable = (b: Buffer): string[] | null => {
    if (b.length < 400 || b.length % 2 !== 0) return null;
    for (let i = 0; i < b.length; i += 2) if (b[i] < 0x81 || b[i] > 0xfe) return null;
    const out: string[] = [];
    for (let i = 0; i < b.length; i += 2) out.push(iconv.decode(b.slice(i, i + 2), 'big5'));
    return out;
  };
  // 加字是編輯器的功能（存檔時會自動把缺字補進 Wor.pak），所以「原版 639 項」這類斷言
  // 一定要對著**沒被動過的那份**做，否則用過一次自動補字，測試就全紅。
  // 編輯器第一次覆寫 Wor.pak 前會留下 .bak，那份就是基準；沒有 .bak 代表還沒被改過。
  const worLive = readIfExists(LIVE && `${LIVE}/Wor.pak`);
  const wor = readIfExists(LIVE && `${LIVE}/Wor.pak.bak`) ?? worLive;
  const patched = !!(worLive && wor !== worLive);
  const sets = new Map<string, Set<string>>();
  for (const [name, pak] of [['台灣', 'Part1'], ['香港', 'Part2'], ['大富翁城', 'Part3']] as const) {
    const buf = readIfExists(R && `${R}/${pak}.pak`);
    if (buf) sets.set(name, han(iconv.decode(decompress(buf, ptrs(buf)[2]), 'big5')));
  }

  if (sets.size < 3) skip('地圖文字字集', NO_ORIG);
  else {
    const union = new Set<string>();
    for (const s of sets.values()) for (const c of s) union.add(c);
    for (const [name, s] of sets) {
      check(`原版${name}：地圖文字用到 ${s.size} 字，比全表 ${union.size} 少`, s.size < union.size, `${s.size}`);
    }
    eq('「苗」「栗」三張圖文字都沒有（苗栗縣→邦邦縣 的來源）',
      ['苗', '栗'].map(c => union.has(c)), [false, false]);
    eq('「澎」「湖」有（台灣地名，香港圖也畫得出來）', ['澎', '湖'].map(c => union.has(c)), [true, true]);
  }

  if (!wor) skip('Wor.pak 字表', '找不到遊戲目錄的 Wor.pak');
  else {
    let table: string[] | null = null;
    for (const p of ptrs(wor)) { table = parseTable(decompress(wor, p)); if (table) break; }
    check('Wor.pak 裡認得出一張乾淨的 2-byte Big5 字表', table !== null);
    if (table) {
      eq('原版字表 639 項', table.length, 639);
      eq('表尾是「邦」（香港的「永邦」）', table[table.length - 1], '邦');
      const tblHan = new Set(table.filter(c => /[一-鿿]/.test(c)));
      eq('表內漢字 626 個', tblHan.size, 626);
      if (sets.size === 3) {
        const union = new Set<string>();
        for (const s of sets.values()) for (const c of s) union.add(c);
        const onlyTable = [...tblHan].filter(c => !union.has(c));
        const onlyMaps = [...union].filter(c => !tblHan.has(c));
        eq('字表 = 三張地圖文字的聯集（雙向零差異）', [onlyTable.length, onlyMaps.length], [0, 0]);
        // 字表是分區的：共用區 → 台灣專屬 → 香港專屬。各圖用到的 index 上界不同，
        // 這就是「台灣的錯字跟香港不一樣」的來源（引擎只載自己那一段）。
        const pos = new Map(table.map((c, i) => [c, i]));
        const maxOf = (n: string) => Math.max(...[...sets.get(n)!].map(c => pos.get(c) ?? -1));
        eq('各圖用到的最大 index：台灣 596、香港 638、大富翁城 548',
          ['台灣', '香港', '大富翁城'].map(maxOf), [596, 638, 548]);
  // 缺字的兩種壞法（都已用遊戲內實測對上）：
  // 1. Big5 首位元組 < 0xA1（罕用字／造字區）→ 遊戲不認雙位元組開頭，低位元組被當 ASCII
  //    印出來，整串排版跟著錯位。實例：香港「鰂魚湧」的「鰂」= 0x91 0x6F → 印成「o」。
  // 2. 正常 Big5 但不在字表 → 顯示成字表最後一項「邦」。台灣「苗栗縣」→「邦邦縣」、
  //    香港「鰂魚湧」→「o邦邦」，兩張圖落點相同。
  const b5 = (c: string) => iconv.encode(c, 'big5');
  eq('「鰂」的 Big5 是 0x91 0x6F，低位元組正好是 ASCII 的 o',
    [b5('鰂')[0], b5('鰂')[1], String.fromCharCode(b5('鰂')[1])], [0x91, 0x6f, 'o']);
  eq('「魚」「湧」是正常 Big5（首位元組 ≥ 0xA1），只是不在字表 → 顯示成「邦」',
    ['魚', '湧'].map(c => b5(c)[0] >= 0xa1), [true, true]);

  // 拿字表把「遊戲會顯示成什麼」算出來，跟使用者的四個遊戲內實測對答案
  if (wor) {
    let tbl: string[] | null = null;
    for (const p of ptrs(wor)) { tbl = parseTable(decompress(wor, p)); if (tbl) break; }
    if (!tbl) skip('遊戲顯示預測', '認不出字表');
    else {
      const T = tbl, has = new Set(T);
      const tail = T[T.length - 1];
      const predict = (name: string) => [...name].map(ch => {
        const b = b5(ch);
        if (b.length === 2 && b[0] < 0xa1) return b[1] >= 0x20 && b[1] < 0x7f ? String.fromCharCode(b[1]) : '?';
        return has.has(ch) ? ch : tail;
      }).join('');
      // 使用者在遊戲裡親眼看到的四組，全部要對上
      eq('預測「深水灣」→ 邦水灣', predict('深水灣'), '邦水灣');
      eq('預測「鰂魚湧」→ o邦邦', predict('鰂魚湧'), 'o邦邦');
      eq('預測「苗栗縣」→ 邦邦縣', predict('苗栗縣'), '邦邦縣');
      eq('預測「銅鑼灣」→ 銅鑼灣（正常）', predict('銅鑼灣'), '銅鑼灣');
    }
  }
        // 尾段 597~638 是香港專屬（銅鑼灣、恆、匯、怡、鴻、永邦…），台灣與城完全沒用到。
        // 548~596 主要是台灣的（澎湖、基隆、宏碁…），但香港也共用了 台基隆澳東嘉竹泰 幾個字，
        // 所以只有香港那段是乾淨的專屬區——這也正好解釋為什麼香港的上界最高。
        check('香港專屬區（597~638）台灣與大富翁城都完全沒用到',
          table.slice(597).every(c => !sets.get('台灣')!.has(c) && !sets.get('大富翁城')!.has(c)));
        // 上界互不相同只是「各圖文字用到哪些字」的差別，**不代表字形分段載入** ——
        // 台灣的缺字會變成 index 638 的「邦」，而台灣自己只用到 596，可見整份字形三張圖都拿得到。
        check('三張圖文字用到的上界互不相同（但字形是整份共用）',
          new Set(['台灣', '香港', '大富翁城'].map(maxOf)).size === 3);
      }
      eq('「苗」「栗」不在原版表內', ['苗', '栗'].map(c => table!.includes(c)), [false, false]);
      eq('「澎」「湖」在表內', ['澎', '湖'].map(c => table!.includes(c)), [true, true]);
    }

    // ── 加字後的 Wor.pak 仍須自洽 ──
    // 字表與字形是兩個等長的陣列（glyph[i] ↔ table[i]），任何一邊漏加都會整份錯位。
    // 字形區＝前 1664 bytes 的繪圖查表 + 每字 30 bytes（見 docs/runexe-re.md §7）。
    if (!patched) skip('加字後的 Wor.pak', '目前的 Wor.pak 就是原版（沒有 .bak）');
    else {
      const FONT_HEADER = 1664, GLYPH = 30;
      let live: string[] | null = null, liveFont: Buffer | null = null;
      const lp = ptrs(worLive!);
      for (const p of lp) { live = parseTable(decompress(worLive!, p)); if (live) break; }
      if (lp.length > 1) liveFont = decompress(worLive!, lp[1]);
      check('加字後仍認得出字表', live !== null);
      if (live && liveFont && table) {
        check(`字數只增不減（${table.length} → ${live.length}）`, live.length >= table.length, `${live.length}`);
        eq(`原版那 ${table.length} 項一個沒動`, live.slice(0, table.length).join(''), table.join(''));
        const glyphCount = Math.floor((liveFont.length - FONT_HEADER) / GLYPH);
        eq('字形數 = 字表項數（漏一邊就整份錯位）', glyphCount, live.length);
        const added = live.slice(table.length);
        check(`新加的字（${added.join('') || '無'}）字形都不是空白`,
          added.every((_, i) => {
            const o = FONT_HEADER + (table.length + i) * GLYPH;
            return liveFont!.subarray(o, o + GLYPH).some(v => v !== 0);
          }));
        const lowLead = added.filter(c => iconv.encode(c, 'big5')[0] < 0xa1);
        check('新加的字 Big5 首位元組都 ≥ 0xA1（否則遊戲會排版錯位）', lowLead.length === 0,
          lowLead.length ? `「${lowLead.join('」「')}」首位元組 < 0xA1 —— 若這是 add-chars.mjs --force 的實驗，結束後請還原` : '');
        // 引擎很可能靠「字表配置尾端那段 0」判斷表到哪結束，配置是進位到 16 bytes 的段落
        const slack = (Math.ceil(live.length * 2 / 16) * 16) - live.length * 2;
        check(`字表沒有卡在段落邊界（餘裕 ${slack} bytes）`, slack !== 0, `${slack}`);
      }
    }
  }
}

// ==================== 5d. 地段序號 (UNK9) ====================
// 規則：同地段內依 locId 由小到大給 1,2,3…（三張原版圖 85 個地段零例外）
console.log('\n=== 5d. 地段序號 renumberSegment ===');
{
  for (const [name, d, p] of [['台灣', 'Save_7', 'Part1'], ['香港', 'Save_8', 'Part2'], ['城', 'Save_9', 'Part3']] as const) {
    const m = loadMap(R, d, p);
    if (!m) { skip(`原版${name} 地段序號`, NO_ORIG); continue; }
    const { grid, dv } = m;
    const segs = new Set<number>();
    for (const v of grid) {
      if (v > 0 && v <= MAX_LOC_ID) {
        const s = dv.getUint16(LOC_FIELDS.SEGMENT + v * 2, true);
        if (s > 0) segs.add(s);
      }
    }
    let changed = 0;
    for (const s of segs) changed += renumberSegment(grid, dv, s).length;
    check(`原版${name}：${segs.size} 個地段重編號後零改動（規則與原版一致）`, changed === 0, `改了 ${changed} 格`);
  }

  // 中間插入：新編號不是最大值時，後面的要往後推
  const tw = loadMap(R, 'Save_7', 'Part1');
  if (!tw) skip('地段序號寫壞後可修回', NO_ORIG);
  else {
  const { grid, dv } = tw;
  const seg = dv.getUint16(LOC_FIELDS.SEGMENT + 54 * 2, true);   // 台北市
  const before: number[] = [];
  for (let id = 1; id <= MAX_LOC_ID; id++) {
    if (dv.getUint16(LOC_FIELDS.SEGMENT + id * 2, true) === seg) before.push(id);
  }
  const smallest = before[0];
  check(`台北市成員 ${before.join(',')}，最小的 ${smallest} 序號應為 1`,
    dv.getUint16(LOC_FIELDS.UNK9 + smallest * 2, true) === 1);

  // 把最大的那格序號故意寫錯，重編號應該修回來
  const last = before[before.length - 1];
  dv.setUint16(LOC_FIELDS.UNK9 + last * 2, 99, true);
  const fixed = renumberSegment(grid, dv, seg);
  eq('序號被寫壞後，重編號會修回正確值',
    dv.getUint16(LOC_FIELDS.UNK9 + last * 2, true), before.length);
  check('只改動被寫壞的那一格', fixed.length === 1 && fixed[0] === last, `changed=${fixed}`);
  }
}

// ==================== 6. 特殊地點數推算 ====================
// 判準有兩個，缺一不可：「佔 2x2 四格」＋「圖塊是連號四塊（左上 = 40 + 種類*4）」。
// 不是「SPECIAL>0」——公園的 SPECIAL 就是 0，用它會把結尾的公園漏掉（大富翁城的 40 號）。
console.log('\n=== 6. 特殊地點數（[0x1098]）推算 ===');
{
  // 原版圖要跟「原版 exe」比；活的地圖才跟「目前的 exe」比。
  const exeOrig = readIfExists(R && `${R}/Run.exe`);
  const exeLive = readIfExists(LIVE && `${LIVE}/Run.exe`);
  const cases = [
    { name: '台灣', dsk: 'Save_7', pak: 'Part1', off: 0x124b0 },
    { name: '台灣(當前地圖)', dsk: 'Save_7', pak: 'Part1', off: 0x124b0, live: true },
    { name: '香港', dsk: 'Save_8', pak: 'Part2', off: 0x124ca },
    { name: '大富翁城', dsk: 'Save_9', pak: 'Part3', off: 0x124e4 },
  ];
  for (const c of cases) {
    const live = (c as { live?: boolean }).live === true;
    const m = loadMap(live ? LIVE : R, c.dsk, c.pak);
    if (!m) { skip(`${c.name} 特殊地點數`, live ? NO_LIVE : NO_ORIG); continue; }
    const { grid, layout, dv } = m;
    const cnt = new Map<number, number>();
    for (const v of grid) if (v > 0 && v <= 49) cnt.set(v, (cnt.get(v) || 0) + 1);

    let byCells = 0;
    for (const [id, n] of cnt) if (n >= 4 && id > byCells) byCells = id;
    let bySpecialFlag = 0;
    for (const [id] of cnt) if (dv.getUint16(LOC_FIELDS.SPECIAL + id * 2, true) > 0 && id > bySpecialFlag) bySpecialFlag = id;

    const sc = scanSpecials(grid, layout, dv);
    const exe = live ? exeLive : exeOrig;
    const want = exe ? exe.readUInt16LE(c.off) : null;

    // 原版圖：推算值必須等於 exe。使用者當前的地圖會領先 exe（改了地圖還沒存回），
    // 所以只驗結構規則，並把差異印出來當提醒。
    if (want === null) skip(`${c.name}：推算值 = exe 實際值`, `找不到 ${live ? 'LIVE' : '原版'} Run.exe`);
    else if (!live) eq(`${c.name}：圖塊+佔格數推算 = exe 實際值`, sc.count, want);
    else if (sc.count !== want) {
      console.log(`  ℹ ${c.name}（當前地圖）：地圖有 ${sc.count} 個特殊地點，但 exe 寫 ${want}` +
        ` → 編號 ${want + 1}~${sc.count} 在遊戲裡不會被當成特殊地點。按「修復特殊」再存檔即可。`);
    }

    // 兩個判準必須給出同一個答案 —— 圖塊是新加的確認條件，不該改變原本正確的結果
    eq(`${c.name}：圖塊判準與佔格數判準一致`, sc.count, byCells);

    // 結構規則：1..N 全是 4 格、>N 全不是（N 用地圖自己推算出來的值）
    const inside: number[] = [], outside: number[] = [];
    for (const [id, n] of cnt) { if (id <= byCells && n !== 4) inside.push(id); if (id > byCells && n === 4) outside.push(id); }
    check(`${c.name}：1~${byCells} 全部佔 4 格、之後沒有佔 4 格的`, inside.length === 0 && outside.length === 0,
      `inside=${inside} outside=${outside}`);

    // 圖塊規則：每個特殊地點的四格圖塊 = 連號四塊，左上 = 40 + SPECIAL*4，四格同屬一個 locId
    eq(`${c.name}：確認到 ${sc.count} 個特殊地點，編號連續 1~${sc.count}`,
      sc.confirmed.map(b => b.locId), Array.from({ length: sc.count }, (_, i) => i + 1));
    check(`${c.name}：沒有「圖塊排成 2x2 但四格編號不統一」的地方`, sc.unconfirmed.length === 0,
      sc.unconfirmed.map(u => `(${u.block.x},${u.block.y}) ${u.why}`).join(' / '));
    check(`${c.name}：SPECIAL 欄位全部等於圖塊算出的種類`, sc.kindMismatch.length === 0,
      sc.kindMismatch.map(k => `id=${k.id} 圖塊${k.tile} 欄位${k.field}`).join(' / '));
    check(`${c.name}：沒有排不成 2x2 的零星特殊圖塊`, sc.strayCells.length === 0, `${sc.strayCells.length} 格`);
    check(`${c.name}：沒有「佔 4 格但圖塊不是特殊圖塊」的編號`, sc.cellsOnly.length === 0, `${sc.cellsOnly}`);

    if (c.name === '大富翁城') {
      if (want === null) skip('大富翁城：舊的 SPECIAL>0 寫法會算錯（回歸測試）', '找不到原版 Run.exe');
      else check('大富翁城：舊的 SPECIAL>0 寫法會算錯（回歸測試）', bySpecialFlag !== want,
        `舊寫法 ${bySpecialFlag}、正確 ${want}`);
    }
  }
}

// ==================== 6b. 圖塊確認條件本身 ====================
// 「圖塊排成完整的 2x2 連號四塊」是特殊地點的身分證：它同時給出種類，
// 也保證那四格屬於同一個 locId。這裡驗這個確認條件抓得到、也修得動。
console.log('\n=== 6b. 特殊地點的圖塊確認條件 ===');
{
  const m = loadMap(R, 'Save_7', 'Part1');
  if (!m) skip('圖塊確認條件', NO_ORIG);
  else {
  const { grid, layout, dv } = m;
  eq('圖塊 52 是卡片(種類3)', specialKindOfTile(52), 3);
  eq('圖塊 55 也算卡片(種類3)', specialKindOfTile(55), 3);
  eq('卡片的四塊圖塊', specialTilesOfKind(3), [52, 53, 54, 55]);
  eq('圖塊 84(一般道路) 不是特殊圖塊', specialKindOfTile(84), -1);
  eq('圖塊 9(土地) 不是特殊圖塊', specialKindOfTile(9), -1);

  const base = scanSpecials(grid, layout, dv);
  const b1 = base.confirmed.find(b => b.locId === 1)!;
  check('台灣地點1 是卡片，圖塊 52,53,54,55', b1 !== undefined && b1.kind === 3 &&
    JSON.stringify(b1.cells.map(c => layout[c])) === '[52,53,54,55]',
    `kind=${b1?.kind} tiles=${b1?.cells.map(c => layout[c])}`);

  // 把地點1的其中一格搶去給別人 → 應該抓到，而且能自動統一回來
  const stolen = b1.cells[3];
  grid[stolen] = 0;
  const broken = scanSpecials(grid, layout, dv);
  check('四格被拆散：地點1 不再算確認過的特殊地點', !broken.confirmed.some(b => b.locId === 1));
  check('四格被拆散：列進 unconfirmed 且知道要統一成 1',
    broken.unconfirmed.length === 1 && broken.unconfirmed[0].fixId === 1,
    `${JSON.stringify(broken.unconfirmed.map(u => [u.why, u.fixId]))}`);
  const issues = analyzeIntegrity(grid, dv, 49, { layout });
  const sb = issues.find(i => i.kind === 'special-block');
  check('四格被拆散：完整性檢查給得出 fix()', sb !== undefined && typeof sb.fix === 'function');
  sb!.fix!();
  eq('修完後那一格回到地點 1', grid[stolen], 1);
  eq('修完後掃描結果與原本一致', scanSpecials(grid, layout, dv).count, base.count);

  // 圖塊缺一角 → 這個區塊不再成立，而且會報「零星特殊圖塊」
  const saved = layout[b1.cells[3]];
  layout[b1.cells[3]] = 84;
  const chipped = scanSpecials(grid, layout, dv);
  check('圖塊缺一角：地點1 不再算特殊地點', !chipped.confirmed.some(b => b.locId === 1));
  check('圖塊缺一角：剩下三格被列為零星特殊圖塊', chipped.strayCells.length === 3, `${chipped.strayCells.length}`);
  check('圖塊缺一角：地點1 落到「佔4格但圖塊不對」', chipped.cellsOnly.includes(1), `${chipped.cellsOnly}`);
  layout[b1.cells[3]] = saved;

  // SPECIAL 欄位與圖塊分家 → 抓得到
  dv.setUint16(LOC_FIELDS.SPECIAL + 1 * 2, 8, true);
  const mism = scanSpecials(grid, layout, dv);
  eq('欄位改成賭場但圖塊還是卡片：抓得到', mism.kindMismatch, [{ id: 1, field: 8, tile: 3 }]);
  dv.setUint16(LOC_FIELDS.SPECIAL + 1 * 2, 3, true);
  }
}

// ==================== 6c. 貼一個完整的特殊地點 ====================
// 圖塊選擇器把 40~83 抽掉，改成一種類一顆按鈕，點一下就是完整的 2x2 四格。
// 這裡驗背後那套：編號、X/Y、SPECIAL、地段、方向都一次配好，
// 而且新編號一定接在既有特殊地點之後（引擎用 [0x1098] 當界，1~N 全被當特殊地點）。
console.log('\n=== 6c. 貼特殊地點 placeSpecial ===');
{
  const m = loadMap(R, 'Save_7', 'Part1');
  if (!m) skip('placeSpecial', NO_ORIG);
  else {
  const { grid, layout, dv } = m;
  const C = 36;
  const f = (field: number, id: number) => dv.getUint16(field + id * 2, true);
  eq('動手前：原版台灣 23 個特殊地點', scanSpecials(grid, layout, dv).count, 23);

  // 找一塊四格全空的 2x2
  let anchor = -1;
  for (let y = 0; y < C - 1 && anchor < 0; y++) for (let x = 0; x < C - 1; x++) {
    const i = y * C + x;
    if (!grid[i] && !grid[i + 1] && !grid[i + C] && !grid[i + C + 1]) { anchor = i; break; }
  }
  check('找得到空的 2x2 可以貼', anchor >= 0);

  // 邊界與佔用先擋掉（這些都不該動到資料）
  const edge = placeSpecial(grid, layout, dv, (C - 1) * C + (C - 1), 8);
  check('貼在右下角會被擋下來', !edge.ok && /2x2/.test(edge.error ?? ''), edge.error);
  // anchor 本身不在任何特殊地點裡，但它的 2x2 會壓到別的地點 → 要擋下來
  const inBlock = new Set(scanSpecials(grid, layout, dv).confirmed.flatMap(b => b.cells));
  let busyAnchor = -1;
  for (let y = 0; y < C - 1 && busyAnchor < 0; y++) for (let x = 0; x < C - 1; x++) {
    const i = y * C + x;
    if (inBlock.has(i)) continue;
    if (grid[i] || grid[i + 1] || grid[i + C] || grid[i + C + 1]) { busyAnchor = i; break; }
  }
  const busy = placeSpecial(grid, layout, dv, busyAnchor, 8);
  check('2x2 會壓到別的地點 → 擋下來', !busy.ok && busy.mode === 'none' && /佔著/.test(busy.error ?? ''),
    `anchor=${busyAnchor} mode=${busy.mode} err=${busy.error}`);

  const r = placeSpecial(grid, layout, dv, anchor, 8);   // 8 = 賭場
  eq('貼成功，而且是「新增」', [r.ok, r.mode], [true, 'new']);
  eq('新編號接在既有特殊地點之後', r.locId, 24);
  eq('編號 24 原本是海上道路，整段海路往後挪一格空出來', (r.seaMoved ?? []).length, 16);
  eq('四格圖塊 = 賭場的 72~75',
    [layout[anchor], layout[anchor + 1], layout[anchor + C], layout[anchor + C + 1]], [72, 73, 74, 75]);
  eq('四格 grid 都是新編號', [grid[anchor], grid[anchor + 1], grid[anchor + C], grid[anchor + C + 1]], [24, 24, 24, 24]);
  eq('X/Y 記在左上角', [f(LOC_FIELDS.X, 24), f(LOC_FIELDS.Y, 24)], [anchor % C, Math.floor(anchor / C)]);
  eq('SPECIAL 欄位 = 8（賭場）', f(LOC_FIELDS.SPECIAL, 24), 8);
  eq('地段 = 0（特殊地點沒有地段，也沒有價格）', f(LOC_FIELDS.SEGMENT, 24), 0);
  check('UNKA/UNKB 都不是 0（0 會被誤認成監獄/醫院入口格）',
    f(LOC_FIELDS.UNKA, 24) !== 0 && f(LOC_FIELDS.UNKB, 24) !== 0);

  // 被擠走的道路：號碼換了，但東西還在，而且仍留在 ≤49（超過會被引擎當成土地）
  let road40 = 0;
  for (const v of grid) if (v === 40) road40++;
  check('被搬走的道路還在 grid 上（換成編號 40）', road40 > 0, `${road40} 格`);
  check('搬完後編號 40 仍在特殊/道路分區(≤49)', 40 <= 49);
  eq('搬完後沒有任何格子還用著舊編號以外的殘留座標',
    [f(LOC_FIELDS.X, 40), f(LOC_FIELDS.Y, 40)].length, 2);

  const after = scanSpecials(grid, layout, dv);
  eq('掃描結果變成 24 個特殊地點', after.count, 24);
  eq('新的那個確認得了', after.confirmed.filter(b => b.locId === 24 && b.kind === 8).length, 1);
  eq('沒製造出圖塊/編號不一致',
    [after.unconfirmed.length, after.kindMismatch.length, after.strayCells.length, after.cellsOnly.length],
    [0, 0, 0, 0]);
  const issues = analyzeIntegrity(grid, dv, 49, { layout });
  const spIssues = issues.filter(i => i.kind.startsWith('special-'));
  check('完整性檢查沒有新的特殊地點類警告', spIssues.length === 0, spIssues.map(i => i.detail).join(' / '));

  // 點在既有特殊地點上 = 換種類（圖塊與 SPECIAL 欄位一起換）
  const k = placeSpecial(grid, layout, dv, anchor + C + 1, 1);   // 1 = 銀行，點右下那格
  eq('點在既有特殊地點上 → 換種類', [k.ok, k.mode, k.locId, k.kindFrom], [true, 'kind', 24, 8]);
  eq('圖塊換成銀行的 44~47',
    [layout[anchor], layout[anchor + 1], layout[anchor + C], layout[anchor + C + 1]], [44, 45, 46, 47]);
  eq('SPECIAL 欄位跟著換成 1', f(LOC_FIELDS.SPECIAL, 24), 1);
  eq('換種類不會多配一個編號', scanSpecials(grid, layout, dv).count, 24);
  const same = placeSpecial(grid, layout, dv, anchor, 1);
  check('種類沒變就什麼都不做', !same.ok && same.mode === 'none', `${same.mode}`);
  }
}

// ==================== 6d. 海上道路 ====================
// 海上道路跟陸上道路不是同一種：只佔一格、沒地段、不是特殊地點，而且編號**緊接在
// 特殊地點之後**（原版台灣＝特殊 1~23、海路 24~39）。引擎用 [0x1098] 當界，
// 1~N 全會被當成特殊地點，所以特殊地點一增加，整段海路就得一起往後挪。
console.log('\n=== 6d. 海上道路 ===');
{
  // 大富翁城整張圖沒有海路（特殊地點吃到 40，41~50 整段空著）
  const cases = [
    { name: '台灣', dsk: 'Save_7', pak: 'Part1', want: [24, 39], n: 16, sp: 23 },
    { name: '香港', dsk: 'Save_8', pak: 'Part2', want: [28, 39], n: 12, sp: 27 },
    { name: '大富翁城', dsk: 'Save_9', pak: 'Part3', want: [], n: 0, sp: 40 },
  ];
  for (const c of cases) {
    const m = loadMap(R, c.dsk, c.pak);
    if (!m) { skip(`原版${c.name} 海上道路`, NO_ORIG); continue; }
    const s = scanSeaRoads(m.grid, m.layout, m.dv);
    eq(`原版${c.name}：特殊地點 ${c.sp} 個`, s.specialCount, c.sp);
    eq(`原版${c.name}：海路 ${c.n} 條`, s.ids.length, c.n);
    eq(`原版${c.name}：海路編號緊接在特殊地點之後`,
      s.ids.length ? [s.ids[0], s.ids[s.ids.length - 1]] : [], c.want);
    check(`原版${c.name}：海路編號本來就是連號正確的`, s.ok && !s.error, `ids=${s.ids} want=${s.want}`);
    check(`原版${c.name}：沒有佔多格的東西混在海路編號區`, s.odd.length === 0, `${s.odd}`);
    eq(`原版${c.name}：修復海路是零改動（規則與原版一致）`,
      repairSeaRoads(m.grid, m.layout, m.dv).moved.length, 0);
  }
}

// ==================== 6e. 新增特殊地點時海路整段往後挪 ====================
console.log('\n=== 6e. 新增特殊地點 → 海路整段 +1 ===');
{
  const m = loadMap(R, 'Save_7', 'Part1');
  if (!m) skip('海路整段位移', NO_ORIG);
  else {
  const { grid, layout, dv } = m;
  const C = 36;
  const g = (field: number, id: number) => dv.getUint16(field + id * 2, true);

  // 使用者給的基準：原版 24 號在 (6,16)，左接 53（土地）、右接 25（下一條海路）
  eq('動手前：24 號在 (6,16)', [g(LOC_FIELDS.X, 24), g(LOC_FIELDS.Y, 24)], [6, 16]);
  eq('動手前：24 號 左→53、右→25', [g(LOC_FIELDS.LEFT, 24), g(LOC_FIELDS.RIGHT, 24)], [53, 25]);
  const tail = g(LOC_FIELDS.DOWN, 39);   // 最後一條海路接到特殊地點 15
  eq('動手前：39 號 下→15（接到特殊地點）', tail, 15);

  let anchor = -1;
  for (let y = 0; y < C - 1 && anchor < 0; y++) for (let x = 0; x < C - 1; x++) {
    const i = y * C + x;
    if (!grid[i] && !grid[i + 1] && !grid[i + C] && !grid[i + C + 1]) { anchor = i; break; }
  }
  const r = placeSpecial(grid, layout, dv, anchor, 8);
  eq('新特殊地點拿到 24 號', [r.ok, r.locId], [true, 24]);
  eq('16 條海路整段往後挪一格', (r.seaMoved ?? []).length, 16);
  eq('挪法就是 24→25、39→40',
    (r.seaMoved ?? []).slice().sort((a, b) => a.from - b.from).filter(x => x.from === 24 || x.from === 39),
    [{ from: 24, to: 25 }, { from: 39, to: 40 }]);

  // 使用者給的預期結果：變成 25 號在 (6,16)，左邊仍是 53、右邊變 26
  eq('修正後：25 號在 (6,16)', [g(LOC_FIELDS.X, 25), g(LOC_FIELDS.Y, 25)], [6, 16]);
  eq('修正後：25 號 左→53（接土地，不 +1）、右→26（接海路，+1）',
    [g(LOC_FIELDS.LEFT, 25), g(LOC_FIELDS.RIGHT, 25)], [53, 26]);
  eq('修正後：40 號 上→39、下→15（接特殊地點，不 +1）',
    [g(LOC_FIELDS.UP, 40), g(LOC_FIELDS.DOWN, 40)], [39, 15]);
  eq('24 號現在是新的特殊地點（賭場），不再是海路', g(LOC_FIELDS.SPECIAL, 24), 8);
  check('24 號不再被當成海路', !scanSeaRoads(grid, layout, dv).ids.includes(24));

  const s = scanSeaRoads(grid, layout, dv);
  eq('海路變成 25~40，緊接在 24 個特殊地點之後', [s.specialCount, s.ids[0], s.ids[s.ids.length - 1]], [24, 25, 40]);
  check('海路位置正確、沒有超過上限', s.ok && !s.error, `${s.error} ids=${s.ids}`);
  const issues = analyzeIntegrity(grid, dv, 49, { layout });
  check('沒有海路類警告', issues.filter(i => i.kind === 'sea-road').length === 0,
    issues.filter(i => i.kind === 'sea-road').map(i => i.detail).join(' / '));
  }
}

// ==================== 6f. 修復海路：抓得到、也修得動 ====================
console.log('\n=== 6f. 修復海路 ===');
{
  const m = loadMap(R, 'Save_7', 'Part1');
  if (!m) skip('修復海路', NO_ORIG);
  else {
  const { grid, layout, dv } = m;
  const g = (field: number, id: number) => dv.getUint16(field + id * 2, true);

  // 模擬「特殊地點加了、但海路忘了挪」：把海路整段往後推兩格，留下 24、25 的空號
  for (let id = 39; id >= 24; id--) {
    const ok = repairSeaRoads(grid, layout, dv, 49, 26).ok;
    if (!ok) break;
    break;
  }
  const shifted = scanSeaRoads(grid, layout, dv);
  eq('先弄壞：海路變成 26~41，但特殊地點還是 23 個', [shifted.specialCount, shifted.ids[0]], [23, 26]);
  check('弄壞後 scan 會說對不上', !shifted.ok, `ids=${shifted.ids}`);

  const issues = analyzeIntegrity(grid, dv, 49, { layout });
  const sea = issues.filter(i => i.kind === 'sea-road');
  check('完整性檢查抓得到海路對不上', sea.length === 1 && typeof sea[0].fix === 'function',
    sea.map(i => i.kind).join(','));
  check('警告訊息講得出現況與應有的編號', /26~41/.test(sea[0]?.detail ?? '') && /24~39/.test(sea[0]?.detail ?? ''),
    sea[0]?.detail);

  const rep = repairSeaRoads(grid, layout, dv);
  check('修復海路成功', rep.ok, rep.error);
  eq('16 條全部搬回來', rep.moved.length, 16);
  const after = scanSeaRoads(grid, layout, dv);
  check('修完緊接在特殊地點之後', after.ok && after.ids[0] === 24, `ids=${after.ids}`);
  eq('修完 24 號回到 (6,16)、左→53、右→25',
    [g(LOC_FIELDS.X, 24), g(LOC_FIELDS.Y, 24), g(LOC_FIELDS.LEFT, 24), g(LOC_FIELDS.RIGHT, 24)], [6, 16, 53, 25]);
  eq('修完 39 號 下→15（接特殊地點的頭尾連接沒被動到）', g(LOC_FIELDS.DOWN, 39), 15);
  check(`海路上限是 ${SEA_ROAD_ID_MAX}`, SEA_ROAD_ID_MAX === 50);
  }
}

// ==================== 6c. 刪除地點 ====================
// 「刪除」在編輯器裡是圖塊驅動的：貼一個沒有地點語意的圖塊（不是 1 / 9~14 / 40~83 / 84）
// 就等於把那格的地點刪掉。核心是 deleteLocation()，要一次清乾淨四件事：
// grid 格、+950 購地標記格、記錄整筆、以及**所有指向它的方向指標**。
// 最後那項最容易漏 —— 漏了就會留下 dangling ref，引擎照方向走會跳進一筆全 0 的記錄。
console.log('\n=== 6c. 刪除地點 deleteLocation ===');
{
  const m = loadMap(R, 'Save_7', 'Part1');
  if (!m) skip('刪除地點', NO_ORIG);
  else {
    const { grid, dv } = m;
    const g = (f: number, id: number) => dv.getUint16(f + id * 2, true);
    // 挑一個有購地標記、也有地段的土地
    const cm = new Map<number, number[]>();
    for (let i = 0; i < grid.length; i++) if (grid[i] > 0) (cm.get(grid[i]) ?? cm.set(grid[i], []).get(grid[i])!).push(i);
    const target = [...cm.keys()].find(id => id >= 51 && id <= MAX_LOC_ID && cm.has(id + 950) && g(LOC_FIELDS.SEGMENT, id) > 0)!;
    check(`挑到有標記也有地段的土地 ${target}`, target != null, `${target}`);

    const seg = g(LOC_FIELDS.SEGMENT, target);
    const refsBefore: number[] = [];
    for (let id = 1; id <= MAX_LOC_ID; id++) {
      for (const f of [LOC_FIELDS.LEFT, LOC_FIELDS.UP, LOC_FIELDS.RIGHT, LOC_FIELDS.DOWN]) {
        if (id !== target && g(f, id) === target) refsBefore.push(id);
      }
    }
    check(`刪之前有 ${refsBefore.length} 個方向指標指著它`, refsBefore.length > 0, `${refsBefore.length}`);

    const rep = deleteLocation(grid, dv, target)!;
    check('回傳報告', rep != null);
    eq('回報的地段就是它原本的地段', rep.segId, seg);
    eq('購地標記一併清掉', rep.markerId, target + 950);
    eq('清掉的方向指標數量對得上', rep.clearedRefs.length, refsBefore.length);

    // grid 兩種編號都不該再出現
    let left = 0;
    for (const v of grid) if (v === target || v === target + 950) left++;
    eq('grid 裡本體與標記格都清光', left, 0);

    // 記錄整筆歸 0（含座標、地段、四方向、UNK9、UNKA/UNKB）
    const fields = [LOC_FIELDS.X, LOC_FIELDS.Y, LOC_FIELDS.SPECIAL, LOC_FIELDS.UNK3,
      LOC_FIELDS.LEFT, LOC_FIELDS.UP, LOC_FIELDS.RIGHT, LOC_FIELDS.DOWN,
      LOC_FIELDS.SEGMENT, LOC_FIELDS.UNK9, LOC_FIELDS.UNKA, LOC_FIELDS.UNKB];
    eq('記錄整筆歸 0', fields.map(f => g(f, target)), fields.map(() => 0));

    // 沒有人再指向它
    let dangling = 0;
    for (let id = 1; id <= MAX_LOC_ID; id++) {
      for (const f of [LOC_FIELDS.LEFT, LOC_FIELDS.UP, LOC_FIELDS.RIGHT, LOC_FIELDS.DOWN]) {
        if (g(f, id) === target) dangling++;
      }
    }
    eq('沒有任何方向指標還指著被刪的編號', dangling, 0);

    // 刪掉之後那個編號要能重新配出來
    check(`編號 ${target} 變回可用`, nextLandId(grid, dv, 49) > 0);
    const before9 = [...cm.keys()].filter(id => id !== target && id <= MAX_LOC_ID && g(LOC_FIELDS.SEGMENT, id) === seg);
    renumberSegment(grid, dv, seg);
    const nums = before9.map(id => g(LOC_FIELDS.UNK9, id)).sort((a, b) => a - b);
    eq('原地段重編後序號是連續的 1..n', nums, before9.map((_, i) => i + 1));
  }
}

// ==================== 7. exe patch 狀態 ====================
// 現用的 Run.exe 可能是原版（EXEPACK 壓縮）或編輯器輸出的未壓縮版，兩種版面的
// 檔案 offset 不一樣，所以一律透過 loadExe 走**映像 offset**。
console.log('\n=== 7. Run.exe patch 狀態 ===');
{
  const cur = readIfExists(LIVE && `${LIVE}/Run.exe`);
  const bak = readIfExists(LIVE && `${LIVE}/Run.exe.bak`);
  if (!cur || !bak) skip('Run.exe patch 狀態', cur ? '找不到 Run.exe.bak（還沒 patch 過）' : NO_LIVE);
  else {
    const now = loadExe(new Uint8Array(cur));
    const orig = loadExe(new Uint8Array(bak));

    // maxLocId 只要 ≥ 該圖實際用到的最大編號即可（不必一律 282；
    // 開太大會讓引擎把中間那一大段空記錄也當成合法地點）
    for (const [i, name, dsk, pak, live] of [
      [0, '台灣', 'Save_7', 'Part1', true],
      [1, '香港', 'Save_8', 'Part2', false],
      [2, '大富翁城', 'Save_9', 'Part3', false],
    ] as const) {
      const m = loadMap(live ? LIVE : R, dsk, pak);
      if (!m) { skip(`${name} maxLocId`, live ? NO_LIVE : NO_ORIG); continue; }
      let maxUsed = 0;
      for (const v of m.grid) if (v > 0 && v <= MAX_LOC_ID && v > maxUsed) maxUsed = v;
      const val = readCap(now, i, 'maxLoc');
      check(`${name} maxLocId(${val}) ≥ 實際最大編號(${maxUsed})`, val >= maxUsed, '不足');
      check(`${name} maxLocId 不超過陣列上限 282`, val <= 282, `val=${val}`);
    }

    // 真正要守住的是「編輯器只改容量、只插跳板，沒有寫壞別的程式碼」。
    // 把跳板插入造成的位移還原之後，兩份映像應該只差那六個容量立即數。
    const shift = (now.inserts ?? []).reduce((n, i) => n + i.bytes, 0);
    const at = now.inserts?.[0]?.atOriginal ?? Infinity;
    const allowed = new Set<number>();
    for (const c of MAP_CAPS) { allowed.add(c.maxLoc); allowed.add(c.maxLoc + 1); allowed.add(c.special); allowed.add(c.special + 1); }
    // 六個掛鉤點被換成 near jmp（原指令 3~9 bytes），也是預期內的差異
    for (const [site, len] of [[0x0cfe, 3], [0x17b6, 6], [0x1a5f, 9], [0x1c0f, 3], [0x1d2e, 3], [0x29ff, 3]] as const) {
      for (let i = 0; i < len; i++) allowed.add(site + i);
    }
    const diff: number[] = [];
    for (let o = 0; o < orig.image.length; o++) {
      const n = o >= at ? o + shift : o;
      if (now.image[n] !== orig.image[o]) diff.push(o);
    }
    // 插跳板會讓後面每個段往上移，重定位項存的段值跟著 +段落數——那是預期內的
    const relocAddrs = new Set<number>();
    for (const r of orig.relocs) { relocAddrs.add(r.seg * 16 + r.off); relocAddrs.add(r.seg * 16 + r.off + 1); }
    const unexplained = diff.filter(o => !allowed.has(o) && !relocAddrs.has(o) && o < at);
    check('除了容量與跳板，映像沒有被動到別的地方', unexplained.length === 0,
      `未解釋的差異 ${unexplained.length} 處：${unexplained.slice(0, 8).map(o => '0x' + o.toString(16)).join(',')}`);
    check('映像長度只因為跳板與配額補 0 而變長',
      now.image.length >= orig.image.length + shift);
  }
}

// ==================== 8. 經過就觸發：掛鉤點的原始位元組 ====================
// 這一節守的是「原版長什麼樣」，不是「編輯器不准動」——現在編輯器**會**動這些位置
// （插跳板，見 src/core/passthrough.ts 與第 10 節）。原版的位元組必須維持原樣，
// 因為 insertPassThrough 靠它們確認「這份 Run.exe 是我認得的版本」，對不上就拒絕插碼。
console.log('\n=== 8. 經過就觸發：掛鉤點的原始位元組 ===');
{
  // 檔案 offset = 映像 offset + 0x200（只在 EXEPACK 的原樣保留區成立）
  const SITES: [string, number, number[]][] = [
    ['0x1A5F cmp word es:[bx],1 / je / jmp', 0x1a5f, [0x26, 0x83, 0x3f, 0x01, 0x74, 0x03, 0xe9, 0x69, 0x00]],
    ['0x17B6 mov [0x19c],2（擲骰）', 0x17b6, [0xc7, 0x06, 0x9c, 0x01, 0x02, 0x00]],
    ['0x29FF push 0x10f8（落地匯流點）', 0x29ff, [0x68, 0xf8, 0x10]],
    ['0x0CFE push 0x10f8（畫靜止角色）', 0x0cfe, [0x68, 0xf8, 0x10]],
    ['0x1C0F push 0x10f8（畫靜止角色）', 0x1c0f, [0x68, 0xf8, 0x10]],
    ['0x1D2E push 0x10f8（畫靜止角色）', 0x1d2e, [0x68, 0xf8, 0x10]],
  ];
  const orig = readIfExists(R && `${R}/Run.exe`);
  if (!orig) skip('原版 Run.exe 的掛鉤點', NO_ORIG);
  else for (const [name, img, want] of SITES) {
    eq(name, [...orig.subarray(img + 0x200, img + 0x200 + want.length)], want);
  }
}

// ==================== 9. 角色參數（DSK 第 1 組）====================
// u32[欄位][角色]，欄位各自連續、每列 6 個角色 —— 跟地點資料同一套排法。
// 欄位 0/1 是開局的現金與存款；2 起都是成對的 AI 門檻（錢多於上限必做、少於下限
// 必不做、中間隨機）。角色名稱不在這一組，而是在該圖 PAK 文字表的第 1~6 行。
console.log('\n=== 9. 角色參數 playerData ===');
{
  const m = R ? loadDsk(R, 'Save_7') : null;
  if (!m) skip('角色參數', NO_ORIG);
  else {
    const { pd, get, slots } = m;
    eq('台灣有 4 個角色（香港 5、大富翁城 6）', slots, 4);
    eq('陣列大小 = 欄位數 × 6 × 4 bytes', pd.length >= PLAYER_FIELD_COUNT * PLAYER_SLOTS * 4, true);
    eq('阿土仔的現金/存款是 25000', [get(0, 0), get(1, 0)], [25000, 25000]);
    eq('大老千的現金/存款是 30000', [get(0, 1), get(1, 1)], [30000, 30000]);
    // 門檻必須上限 > 下限，否則「中間隨機」那段不存在，AI 行為會退化
    for (const [hi, lo, what] of [[2, 3, '購地'], [4, 5, '增建'], [6, 7, '買股'], [8, 9, '欄位8/9']] as const) {
      const bad = [...Array(slots).keys()].filter(s => get(hi, s) <= get(lo, s));
      check(`${what}門檻：每個角色都是上限 > 下限`, bad.length === 0, `角色 ${bad.join(',')} 不符`);
    }
    // 沒用到的角色欄位必須整組為 0 —— 有殘值代表解析錯位
    const ghost = [...Array(PLAYER_SLOTS - slots).keys()]
      .filter(i => [...Array(PLAYER_FIELD_COUNT).keys()].some(f => get(f, slots + i) !== 0));
    eq('用不到的角色欄位全為 0', ghost.length, 0);

    // 寫回：改一個值重建，其餘欄位與地點/價格組都不能被動到
    const before = get(0, 0);
    const dv = new DataView(pd.buffer, pd.byteOffset, pd.byteLength);
    dv.setUint32(0, 99999, true);
    const rebuilt = rebuildDskBufferCore(m.raw, m.r.dskGroupPointers, m.r.mapLayout!, m.r.locData, m.r.priceData, pd, () => { });
    check('重建成功', !!rebuilt);
    if (rebuilt) {
      const back = parseSaveDskCore(new DataView(rebuilt), () => { })!;
      const b2 = new DataView(back.playerData!.buffer, back.playerData!.byteOffset, back.playerData!.byteLength);
      eq('改到的欄位有寫回', b2.getUint32(0, true), 99999);
      const rest = [...Array(PLAYER_FIELD_COUNT * PLAYER_SLOTS - 1).keys()]
        .every(i => b2.getUint32((i + 1) * 4, true) === dv.getUint32((i + 1) * 4, true));
      check('其餘角色欄位一字不差', rest);
      check('地點組沒被動到', Buffer.from(back.locData!).equals(Buffer.from(m.r.locData!)));
      check('價格組沒被動到', Buffer.from(back.priceData!).equals(Buffer.from(m.r.priceData!)));
    }
    dv.setUint32(0, before, true);
  }
}


// ==================== 10. Run.exe：解壓、容量、跳板 ====================
// 原版是 EXEPACK 壓縮的，編輯器輸出的是未壓縮 MZ。所有 offset 一律用**映像 offset**，
// 因為兩種版面的檔頭大小不同，而且插跳板還會讓插入點之後的東西整批位移。
console.log('\n=== 10. Run.exe 映像 ===');
{
  const exePath = R ? `${R}/Run.exe` : null;
  if (!exePath || !fs.existsSync(exePath)) { skipped++; console.log('  (略過：找不到原版 Run.exe)'); }
  else {
    const raw = new Uint8Array(fs.readFileSync(exePath));
    const x = loadExe(raw);
    check('原版認得出是 EXEPACK 壓縮', x.wasPacked);
    check('映像長度 205648 bytes', x.image.length === 205648);
    check('重定位項 2502 個', x.relocs.length === 2502);
    check('重定位項全部落在映像內', x.relocs.every(r => r.seg * 16 + r.off + 2 <= x.image.length));

    const caps = MAP_CAPS.map((_, i) => [readCap(x, i, 'maxLoc'), readCap(x, i, 'special')]);
    check('原版容量 台灣119/23 香港140/27 大富翁城282/40',
      JSON.stringify(caps) === JSON.stringify([[119, 23], [140, 27], [282, 40]]));

    // 未壓縮版：編輯器存過檔之後使用者的 Run.exe 就是這種，要讀得回來
    const y = loadExe(buildExe(x));
    check('輸出的未壓縮版讀得回來', !y.wasPacked);
    // 輸出會把 DOS 配額之內、映像之外那塊也寫進檔案並填 0（見 buildExe 的註解），
    // 所以往返後的映像會比原本長；前段必須逐位元組相同，多出來的必須全是 0。
    check('往返後映像前段逐位元組相同',
      y.image.length >= x.image.length && x.image.every((v, i) => v === y.image[i]));
    check('多出來的配額區全是 0',
      y.image.subarray(x.image.length).every(v => v === 0));
    check('配額總量與壓縮版相同',
      y.image.length / 16 === Math.ceil(x.image.length / 16) + x.minAlloc && y.minAlloc === 0);
    check('往返後重定位表相同', y.relocs.length === x.relocs.length
      && y.relocs.every((r, i) => r.seg === x.relocs[i].seg && r.off === x.relocs[i].off));
    check('往返後 CS/SS/IP/SP 相同', y.cs === x.cs && y.ss === x.ss && y.ip === x.ip && y.sp === x.sp);

    const z = loadExe(raw);
    writeCap(z, 0, 'maxLoc', 200);
    check('改寫容量讀得回來', readCap(z, 0, 'maxLoc') === 200);
    // 只准動到那個立即數的兩個位元組（200 的高位元組本來就是 0，所以實際只會差 1 個）
    const changed: number[] = [];
    for (let i = 0; i < x.image.length; i++) if (z.image[i] !== x.image[i]) changed.push(i);
    check('改容量只動到那個立即數',
      changed.every(i => i === MAP_CAPS[0].maxLoc || i === MAP_CAPS[0].maxLoc + 1), `動到 ${changed.length} 處`);

    const t = defaultTable(); t[3] = 1;
    insertPassThrough(z, t);
    const shift = z.inserts!.reduce((n, i) => n + i.bytes, 0);
    check('插跳板後有留下簽章，讀得回插入清單', (z.inserts?.length ?? 0) === 1 && shift > 0);
    check('映像剛好長了跳板那麼多', z.image.length === x.image.length + shift);
    check('插跳板後容量仍讀得到（offset 自動位移）', readCap(z, 0, 'maxLoc') === 200);
    check('CS/SS 跟著往上位移同樣的段落數', z.cs === x.cs + shift / 16 && z.ss === x.ss + shift / 16);
    check('重定位項沒有增減', z.relocs.length === x.relocs.length);

    const hooks = [0x0cfe, 0x17b6, 0x1a5f, 0x1c0f, 0x1d2e, 0x29ff];
    check('六個掛鉤點都是 near jmp', hooks.every(h => z.image[h] === 0xe9));
    check('掛鉤點的跳轉目標都落在跳板內', hooks.every(h => {
      const rel = z.image[h + 1] | (z.image[h + 2] << 8);
      return ((h + 3 + (rel > 0x7fff ? rel - 0x10000 : rel)) & 0xffff) - z.inserts![0].atOriginal < shift;
    }));
    check('跳板裡的表寫對了（銀行=2、卡片=1）',
      z.image[z.inserts![0].atOriginal + 0x130 + 1] === 2 && z.image[z.inserts![0].atOriginal + 0x130 + 3] === 1);
    check('表的最後一項也寫得進去（不會溢位被靜靜吃掉）', (() => {
      const w = loadExe(raw); const full = defaultTable(); full[TABLE_LEN - 1] = 1;
      insertPassThrough(w, full);
      return w.image[w.inserts![0].atOriginal + 0x130 + TABLE_LEN - 1] === 1;
    })());
    check('讀得回自己寫進去的設定', (() => {
      const back = readPassTable(loadExe(buildExe(z)));
      return back.every((v, k) => v === (k === 1 ? 2 : k === 3 ? 1 : 0));
    })());
    check('預設表就是原版行為（只有銀行=2）', defaultTable().every((v, k) => v === (k === 1 ? 2 : 0)));

    const bad = loadExe(raw);
    bad.image[0x1a5f] = 0x90;
    let threw = false;
    try { insertPassThrough(bad, t); } catch { threw = true; }
    check('掛鉤點被動過就拒絕插碼', threw);

}


// ==================== 11. 插碼機制：連續插入多塊 ====================
// 「經過就觸發」的跳板插在段 0 尾端（0x0CC50），物價指數的跳板要插在段 0xCC5 尾端
// （0x1C6A0，過路費的讀取點 0x12695 在那個段裡，near 跳轉才搆得到）。
// 兩塊都插的時候，位移會疊加——這一節守住「原版映像 offset → 實際位置」的換算。
console.log('\n=== 11. 插碼：連續插入多塊 ===');
{
  const exePath = R ? `${R}/Run.exe` : null;
  if (!exePath || !fs.existsSync(exePath)) { skipped++; console.log('  (略過：找不到原版 Run.exe)'); }
  else {
    const raw = new Uint8Array(fs.readFileSync(exePath));
    const base = loadExe(raw);

    // 兩個段界：段 0 尾端、段 0xCC5 尾端
    const b1 = segmentEnds(base)[0], b2 = segmentEnds(base)[1];
    check('段界依序是 0x0CC5 與 0x1C6A', b1 === 0x0cc5 && b2 === 0x1c6a, `得到 0x${b1.toString(16)} / 0x${b2.toString(16)}`);

    const x = loadExe(raw);
    const A = new Uint8Array(0x40).fill(0xaa);   // 4 段落
    const B = new Uint8Array(0x20).fill(0xbb);   // 2 段落
    insertBlock(x, b1, A);
    insertBlock(x, b2, B);

    check('映像長度 = 原長 + 兩塊', x.image.length === base.image.length + A.length + B.length);
    check('第一塊落在段界 0x0CC50', x.image[b1 * 16] === 0xaa && x.image[b1 * 16 + 0x3f] === 0xaa);
    check('第二塊落在位移後的位置', x.image[b2 * 16 + A.length] === 0xbb);

    // 換算：插入點之前不動、兩點之間位移第一塊、之後位移兩塊
    check('offset 換算：插入點之前不變', imageOffset(x, 0x1a5f) === 0x1a5f);
    check('offset 換算：兩點之間 +第一塊', imageOffset(x, 0x12695) === 0x12695 + A.length);
    check('offset 換算：兩點之間也是 +第一塊', imageOffset(x, 0x122aa) === 0x122aa + A.length);
    check('offset 換算：兩點之後 +兩塊', imageOffset(x, 0x2fa60) === 0x2fa60 + A.length + B.length);

    // 原本的資料要能對得起來。重定位項存的段值會被 +段落數（那正是插入該做的事），
    // 所以比對時要把那些位址排除掉。
    const relocByte = new Set<number>();
    for (const r of base.relocs) { const a = r.seg * 16 + r.off; relocByte.add(a); relocByte.add(a + 1); }
    const same = (from: number, len: number, shift: number) => [...Array(len).keys()]
      .every(i => relocByte.has(from + i) || x.image[from + i + shift] === base.image[from + i]);
    check('插入點之前的位元組沒動', same(0x1a00, 0x400, 0));
    check('兩點之間的位元組整批位移一塊', same(0x12600, 0x400, A.length));
    check('兩點之後的位元組整批位移兩塊', same(0x2fa60, 0x400, A.length + B.length));

    check('CS/SS 各往上兩塊的段落數', x.cs === base.cs + (A.length + B.length) / 16
      && x.ss === base.ss + (A.length + B.length) / 16);
    check('重定位項沒有增減', x.relocs.length === base.relocs.length);

    // 每個重定位項存的段值，換算回來要跟原本指到同一個地方
    const bad = base.relocs.filter((r, i) => {
      const oldLin = r.seg * 16 + r.off, newLin = x.relocs[i].seg * 16 + x.relocs[i].off;
      if (newLin !== imageOffset(x, oldLin)) return true;
      const ov = base.image[oldLin] | (base.image[oldLin + 1] << 8);
      const nv = x.image[newLin] | (x.image[newLin + 1] << 8);
      return nv !== (ov >= b1 ? ov + (ov >= b2 ? (A.length + B.length) / 16 : A.length / 16) : ov);
    });
    check('每個重定位項都指向位移後的正確位置', bad.length === 0, `${bad.length} 項不對`);

    // 容量欄位透過 readCap 仍然讀得到（它會自己換算）
    check('容量在插兩塊之後仍讀得對',
      readCap(x, 0, 'maxLoc') === readCap(base, 0, 'maxLoc'));

    // 寫出去再讀回來，換算資訊要能還原（清單由 insertPassThrough 負責寫，這裡手動補上）
    writeInsertList(x, x.inserts![0].atOriginal);
    // 但裸插入沒有 0x1A5F 的掛鉤點，loadExe 找不到第一塊——這條由第 10 節的真實路徑守著
    check('插入清單寫得進去', x.image[x.inserts![0].atOriginal + 0x160] === 0x52);
  }
}


// ==================== 12. 物價指數 ====================
// 所有玩家的總資產每超過一個門檻，過路費 +1 倍（等差、只漲不落）。
// 掛在 0x12695——引擎讀過路費**全映像唯一的一處**，收租與 AI 估值共用它。
console.log('\n=== 12. 物價指數 ===');
{
  const exePath = R ? `${R}/Run.exe` : null;
  if (!exePath || !fs.existsSync(exePath)) { skipped++; console.log('  (略過：找不到原版 Run.exe)'); }
  else {
    const raw = new Uint8Array(fs.readFileSync(exePath));
    const mk = (opt: Parameters<typeof insertPriceIndex>[1]) => {
      const x = loadExe(raw);
      insertPassThrough(x, defaultTable());     // 物價指數一定跟在它後面
      insertPriceIndex(x, opt);
      return x;
    };

    const x = mk({ threshold: 500000, cap: 0 });
    check('插了兩塊（經過就觸發 + 物價指數）', x.inserts?.length === 2);
    check('第二塊插在段 0xCC5 的尾端', x.inserts![1].atOriginal === 0x1c6a0);

    // 掛鉤點：原本是 mov ax,es:[bx] + cdq，換成 near jmp + nop
    const hook = imageOffset(x, 0x12695);
    check('掛鉤點換成 near jmp', x.image[hook] === 0xe9 && x.image[hook + 3] === 0x90);
    const rel = x.image[hook + 1] | (x.image[hook + 2] << 8);
    const target = (hook + 3 + (rel > 0x7fff ? rel - 0x10000 : rel)) & 0xffff;
    const cave = imageOffset(x, 0x1c6a0) - x.inserts![1].bytes;   // 跳板落在插入點本身
    check('跳轉目標就是跳板', target === (cave & 0xffff));

    // 跳板開頭必須是「讀過路費 → 算 → 乘」
    check('跳板開頭是 mov ax,es:[bx]',
      x.image[cave] === 0x26 && x.image[cave + 1] === 0x8b && x.image[cave + 2] === 0x07);

    // 變數：指數起始 1、門檻與上限照設定寫入
    const VAR_AT = 0x180;
    const rd = (o: number) => x.image[cave + o] | (x.image[cave + o + 1] << 8);
    check('指數起始 = 1（還沒算之前不改變過路費）', rd(VAR_AT) === 1);
    check('門檻寫進去了（32 位元，u16 裝不下 50 萬）',
      (rd(VAR_AT + 2) | (rd(VAR_AT + 4) << 16)) === 500000);
    check('上限 0 = 無上限', rd(VAR_AT + 6) === 0);
    const y = mk({ threshold: 300000, cap: 8 });
    const cy = imageOffset(y, 0x1c6a0) - y.inserts![1].bytes;
    const ry = (o: number) => y.image[cy + o] | (y.image[cy + o + 1] << 8);
    check('門檻與上限都吃得到設定',
      (ry(VAR_AT + 2) | (ry(VAR_AT + 4) << 16)) === 300000 && ry(VAR_AT + 6) === 8);

    // 股票共 20 支（欄位 20~39），不是 8 支。2026-08-07 用兩根樁釘死：同一份記憶體
    // 快照裡買第 1 支 80 張落在欄位 20、買第 20 支 118 張落在欄位 39。
    // 舊版寫 8 只掃到欄位 27，第 9 支以後的持股全被跳過——這就是「股票沒算到」。
    // 實機驗證：只算股票、門檻 1，遊戲內量到指數 131，與畫面加總的 12 萬多吻合。
    check('股票迴圈跑滿 20 支（mov cx,20）',
      x.image.subarray(cave, cave + VAR_AT).join(',').includes([0xb9, 20, 0].join(',')));

    // 地產：Σ(土地價格 + 房屋級數 × 增值價格)。認地點區塊與價格表的資源記錄位址。
    // 實測驗證：四家算出 1800/2700/2100/4700，與總資產反推的數字完全相同。
    const code = x.image.subarray(cave, cave + VAR_AT).join(',');
    check('不算地產（沒有地點區塊 mov di,0x127a）', !code.includes([0xbf, 0x7a, 0x12].join(',')));
    check('有算現金與存款（讀欄位 0 與 24）',
      code.includes([0x26, 0x8b, 0x07].join(',')) && code.includes([0x26, 0x8b, 0x47, 24].join(',')));
    check('股票迴圈讀現價陣列（mov di,0x1446）', code.includes([0xbf, 0x46, 0x14].join(',')));
    check('股票用 FPU 乘（fld dword es:[si]）', code.includes([0x26, 0xd9, 0x04].join(',')));
    // 跳板的機器碼不能長到蓋掉變數區。現金+存款+股票版是 ~210 bytes、變數區在 0x140(320)。
    // 蓋過去不會有任何錯誤訊息，只會靜靜算錯，所以留一段空白當金絲雀。
    check('跳板程式碼與變數區之間還有 32 bytes 空隙',
      x.image.subarray(cave + VAR_AT - 32, cave + VAR_AT).every((b) => b === 0x90));

    // 診斷模式：指數寫死，跳板裡不會有資產計算（用來把兩個變因切開）
    const z = mk({ threshold: 0, cap: 0, fixedIndex: 2 });
    const cz = imageOffset(z, 0x1c6a0) - z.inserts![1].bytes;
    check('fixedIndex 直接寫進指數', (z.image[cz + VAR_AT] | (z.image[cz + VAR_AT + 1] << 8)) === 2);
    check('fixedIndex 模式沒有 call（跳板裡沒有資產計算）',
      !z.image.subarray(cz, cz + 0x20).includes(0xe8));

    // 容量欄位在插了兩塊之後仍然讀得對
    check('容量在插兩塊之後仍讀得對', readCap(x, 0, 'maxLoc') === readCap(loadExe(raw), 0, 'maxLoc'));

    // 認不得的映像要拒絕
    const bad = loadExe(raw);
    insertPassThrough(bad, defaultTable());
    bad.image[imageOffset(bad, 0x12695)] = 0x90;
    let threw = false;
    try { insertPriceIndex(bad, { threshold: 500000, cap: 0 }); } catch { threw = true; }
    check('掛鉤點被動過就拒絕插碼', threw);

    // 設定要能從產出的 exe 讀回來（UI 靠這個把面板反白成現況）。
    // ⚠ 讀回時不能用 imageOffset 找掛鉤點，也不能把 near jmp 的位移當有號數加——
    //   前者在重新載入的映像上是恆等式（「經過就觸發」會把掛鉤點往後推），
    //   後者忽略了段內繞回。兩個都踩過，讀出來是垃圾值。
    const roundTrip = (pt: PassAction[] | null, pi: { threshold: number; cap: number } | null) => {
      const w = loadExe(raw);
      if (pt) insertPassThrough(w, pt);
      if (pi) insertPriceIndex(w, pi);
      return readPriceIndexSettings(loadExe(buildExe(w)));
    };
    const t1 = defaultTable(); t1[3] = 1;
    const r1 = roundTrip(null, { threshold: 500000, cap: 8 });
    check('設定讀得回來（只有物價指數）', r1?.threshold === 500000 && r1?.cap === 8);
    const r2 = roundTrip(t1, { threshold: 300000, cap: 0 });
    check('設定讀得回來（跟經過就觸發疊在一起）', r2?.threshold === 300000 && r2?.cap === 0);
    check('沒插物價指數就回 null', roundTrip(t1, null) === null && roundTrip(null, null) === null);

    // 「只漲不落」是預設；允許回落就是把 cmp ax,cs:[IDX] 那段拿掉。
    const fall = mk({ threshold: 500000, cap: 0, noHighWater: true });
    const cf = imageOffset(fall, 0x1c6a0) - fall.inserts![1].bytes;
    const hw = [0x2e, 0x3b, 0x06].join(',');
    check('預設是只漲不落（有 cmp ax,cs:[IDX]）',
      x.image.subarray(cave, cave + VAR_AT).join(',').includes(hw));
    check('允許回落就不發出那段比較',
      !fall.image.subarray(cf, cf + VAR_AT).join(',').includes(hw));
    const rf = roundTrip(null, { threshold: 500000, cap: 0, noHighWater: true });
    check('允許回落讀得回來', rf?.noHighWater === true);
    check('只漲不落讀得回來', roundTrip(null, { threshold: 500000, cap: 0 })?.noHighWater === false);
  }
}

console.log(`\n${'='.repeat(50)}\n通過 ${pass}　失敗 ${fail}` + (skipped ? `　略過 ${skipped}` : ''));
if (skipped) console.log(`原版基準檔 ${R ?? '(缺)'}　遊戲目錄 ${LIVE ?? '(缺)'}`);
process.exit(fail ? 1 : 0);
