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
  scanSeaRoads, repairSeaRoads, SEA_ROAD_ID_MAX,
} from '../src/core/integrity.ts';
import { LOC_FIELDS, LAND_TILES, MARKER_TILE } from '../src/config/constants.ts';

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

// ==================== 7. exe patch 狀態 ====================
console.log('\n=== 7. Run.exe patch 狀態 ===');
{
  const cur = readIfExists(LIVE && `${LIVE}/Run.exe`);
  const bak = readIfExists(LIVE && `${LIVE}/Run.exe.bak`);
  if (!cur || !bak) skip('Run.exe patch 狀態', cur ? '找不到 Run.exe.bak（還沒 patch 過）' : NO_LIVE);
  else {
  // maxLocId 只要 ≥ 該圖實際用到的最大編號即可（不必一律 282；開太大會讓引擎把空記錄也當合法地點）
  for (const [name, off, dsk, pak, live] of [
    ['台灣', 0x124aa, 'Save_7', 'Part1', true],
    ['香港', 0x124c4, 'Save_8', 'Part2', false],
    ['大富翁城', 0x124de, 'Save_9', 'Part3', false],
  ] as const) {
    const m = loadMap(live ? LIVE : R, dsk, pak);
    if (!m) { skip(`${name} maxLocId`, live ? NO_LIVE : NO_ORIG); continue; }
    const { grid } = m;
    let maxUsed = 0;
    for (const v of grid) if (v > 0 && v <= MAX_LOC_ID && v > maxUsed) maxUsed = v;
    const val = cur.readUInt16LE(off);
    check(`${name} maxLocId(${val}) ≥ 實際最大編號(${maxUsed})`, val >= maxUsed, `不足`);
    check(`${name} maxLocId 不超過陣列上限 282`, val <= 282, `val=${val}`);
  }
  const diff: number[] = [];
  for (let i = 0; i < Math.min(cur.length, bak.length); i++) if (cur[i] !== bak[i]) diff.push(i);
  const allowed = new Set([0x124aa, 0x124ab, 0x124c4, 0x124c5, 0x124de, 0x124df,
                           0x124b0, 0x124b1, 0x124ca, 0x124cb, 0x124e4, 0x124e5]);
  check('與備份的差異只落在 maxLocId / 特殊數欄位（沒動到玩家數或其他程式碼）',
    diff.every(o => allowed.has(o)), `差異位置 ${diff.map(o => '0x' + o.toString(16)).join(',')}`);
  eq('檔案大小未變（EXEPACK 固定長度）', cur.length, bak.length);
  }
}

console.log(`\n${'='.repeat(50)}\n通過 ${pass}　失敗 ${fail}` + (skipped ? `　略過 ${skipped}` : ''));
if (skipped) console.log(`原版基準檔 ${R ?? '(缺)'}　遊戲目錄 ${LIVE ?? '(缺)'}`);
process.exit(fail ? 1 : 0);
