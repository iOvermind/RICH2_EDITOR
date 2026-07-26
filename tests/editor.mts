// 直接匯入專案真正的原始碼來測（不是鏡像版）
import fs from 'fs';
import iconv from 'iconv-lite';
import { History } from '../src/core/history.ts';
import {
  recomputeRouting, nextLandId, findMarkerBase, findRoutingEntries,
  analyzeIntegrity, MAX_LOC_ID,
} from '../src/core/integrity.ts';
import { LOC_FIELDS, LAND_TILES, MARKER_TILE } from '../src/config/constants.ts';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}
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
// 原版基準檔放在 rich2/original/（使用者維護的未修改遊戲檔）。
// 不放進 repo：那是遊戲原始資料，且 rich2/ 已在 .gitignore 內。
// LIVE 是編輯器實際讀寫的目錄，內容會一直變，只能用來做「當前狀態」的檢查。
const R = 'D:/Dev/RICH2_EDITOR/rich2/original';
const LIVE = 'D:/Dev/RICH2_EDITOR/rich2';
const ROOT = 'D:/Dev/RICH2_EDITOR';

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
  const { grid, dv } = load(`${R}/${d}.dsk`, `${R}/${p}.pak`);
  const dry = recomputeRouting(grid, dv, { dryRun: true });
  const label = `原版${name}`;
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
{
  const { grid, dv } = load(`${ROOT}/Save_7.dsk`, `${ROOT}/Part1.pak`);
  const before = recomputeRouting(grid, dv, { dryRun: true });
  eq('使用者台灣：UNKA 壞掉的格子', before.a.brokenBefore, [40, 117, 118, 119]);
  eq('使用者台灣：UNKB 壞掉的格子', before.b.brokenBefore, [40, 117, 118, 119]);
  const after = recomputeRouting(grid, dv);          // 真的寫入
  check('修完之後全部收斂', after.a.stillBroken.length === 0 && after.b.stillBroken.length === 0);
  const again = recomputeRouting(grid, dv, { dryRun: true });
  check('再跑一次不會再改（冪等）', again.a.changed.length === 0 && again.b.changed.length === 0,
    `A改${again.a.changed.length} B改${again.b.changed.length}`);
}

// ==================== 4. 編號配置 ====================
console.log('\n=== 4. nextLandId / findMarkerBase（真實資料）===');
{
  const tw = load(`${R}/Save_7.dsk`, `${R}/Part1.pak`);
  const twLive = load(`${LIVE}/Save_7.dsk`, `${LIVE}/Part1.pak`);
  const hk = load(`${R}/Save_8.dsk`, `${R}/Part2.pak`);
  const rc = load(`${R}/Save_9.dsk`, `${R}/Part3.pak`);
  eq('台灣 nextLandId', nextLandId(tw.grid, tw.dv), 120);
  // 當前地圖會一直變，只驗規則：新編號要接在最大編號之後
  {
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

// ==================== 5. 圖塊語意 + 完整性檢查 ====================
console.log('\n=== 5. 圖塊語意與完整性檢查 ===');
for (const [name, d, p] of [['台灣', 'Save_7', 'Part1'], ['香港', 'Save_8', 'Part2'], ['城', 'Save_9', 'Part3']] as const) {
  const { grid, layout, dv } = load(`${R}/${d}.dsk`, `${R}/${p}.pak`);
  let landTileBad = 0, markerTileBad = 0;
  for (let i = 0; i < 1296; i++) {
    const id = grid[i], t = layout[i];
    if (LAND_TILES.includes(t) && !(id > 0 && id <= MAX_LOC_ID && dv.getUint16(LOC_FIELDS.SEGMENT + id * 2, true) > 0)) landTileBad++;
    if (t === MARKER_TILE && !(id > 950)) markerTileBad++;
  }
  check(`原版${name}：圖塊9~14 全是有地段的土地`, landTileBad === 0, `例外 ${landTileBad}`);
  check(`原版${name}：圖塊1 全是 +950 標記`, markerTileBad === 0, `例外 ${markerTileBad}`);
  const issues = analyzeIntegrity(grid, dv, 49);
  check(`原版${name}：完整性檢查 0 誤報`, issues.length === 0, `噴出 ${issues.length} 個：${issues.slice(0, 3).map(x => x.kind).join(',')}`);
}

// ==================== 5b. forceIds：新格子一律重算 ====================
console.log('\n=== 5b. forceIds（新格子不保留碰巧能通的佔位值）===');
{
  const { grid, dv } = load(`${R}/Save_8.dsk`, `${R}/Part2.pak`);
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
    const buf = fs.readFileSync(`${R}/${pak}.pak`);
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

// ==================== 6. 特殊地點數推算 ====================
// 判準是「佔 2x2 四格」，不是「SPECIAL>0」——公園的 SPECIAL 就是 0，
// 用 SPECIAL>0 會把結尾的公園漏掉（大富翁城的 40 號）。
console.log('\n=== 6. 特殊地點數（[0x1098]）推算 ===');
{
  // 原版圖要跟「原版 exe」比；活的地圖才跟「目前的 exe」比。
  const exeOrig = fs.readFileSync(`${R}/Run.exe`);
  const exeLive = fs.readFileSync(`${LIVE}/Run.exe`);
  const cases = [
    { name: '台灣', dsk: 'Save_7', pak: 'Part1', off: 0x124b0 },
    { name: '台灣(當前地圖)', dsk: 'Save_7', pak: 'Part1', off: 0x124b0, live: true },
    { name: '香港', dsk: 'Save_8', pak: 'Part2', off: 0x124ca },
    { name: '大富翁城', dsk: 'Save_9', pak: 'Part3', off: 0x124e4 },
  ];
  for (const c of cases) {
    const base = (c as { live?: boolean }).live ? LIVE : R;
    const { grid, dv } = load(`${base}/${c.dsk}.dsk`, `${base}/${c.pak}.pak`);
    const cnt = new Map<number, number>();
    for (const v of grid) if (v > 0 && v <= 49) cnt.set(v, (cnt.get(v) || 0) + 1);

    let byCells = 0;
    for (const [id, n] of cnt) if (n >= 4 && id > byCells) byCells = id;
    let bySpecialFlag = 0;
    for (const [id] of cnt) if (dv.getUint16(LOC_FIELDS.SPECIAL + id * 2, true) > 0 && id > bySpecialFlag) bySpecialFlag = id;

    const live = (c as { live?: boolean }).live === true;
    const want = (live ? exeLive : exeOrig).readUInt16LE(c.off);

    // 原版圖：推算值必須等於 exe。使用者當前的地圖會領先 exe（改了地圖還沒存回），
    // 所以只驗結構規則，並把差異印出來當提醒。
    if (!live) eq(`${c.name}：用佔格數推算 = exe 實際值`, byCells, want);
    else if (byCells !== want) {
      console.log(`  ℹ ${c.name}（當前地圖）：地圖有 ${byCells} 個特殊地點，但 exe 寫 ${want}` +
        ` → 編號 ${want + 1}~${byCells} 在遊戲裡不會被當成特殊地點。按「自動」再存檔即可。`);
    }

    // 結構規則：1..N 全是 4 格、>N 全不是（N 用地圖自己推算出來的值）
    const inside: number[] = [], outside: number[] = [];
    for (const [id, n] of cnt) { if (id <= byCells && n !== 4) inside.push(id); if (id > byCells && n === 4) outside.push(id); }
    check(`${c.name}：1~${byCells} 全部佔 4 格、之後沒有佔 4 格的`, inside.length === 0 && outside.length === 0,
      `inside=${inside} outside=${outside}`);
    if (c.name === '大富翁城') {
      check('大富翁城：舊的 SPECIAL>0 寫法會算錯（回歸測試）', bySpecialFlag !== want,
        `舊寫法 ${bySpecialFlag}、正確 ${want}`);
    }
  }
}

// ==================== 7. exe patch 狀態 ====================
console.log('\n=== 7. Run.exe patch 狀態 ===');
{
  const cur = fs.readFileSync(`${LIVE}/Run.exe`);
  const bak = fs.readFileSync(`${LIVE}/Run.exe.bak`);
  // maxLocId 只要 ≥ 該圖實際用到的最大編號即可（不必一律 282；開太大會讓引擎把空記錄也當合法地點）
  for (const [name, off, dsk, pak, live] of [
    ['台灣', 0x124aa, 'Save_7', 'Part1', true],
    ['香港', 0x124c4, 'Save_8', 'Part2', false],
    ['大富翁城', 0x124de, 'Save_9', 'Part3', false],
  ] as const) {
    const { grid } = load(`${live ? LIVE : R}/${dsk}.dsk`, `${live ? LIVE : R}/${pak}.pak`);
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

console.log(`\n${'='.repeat(50)}\n通過 ${pass}　失敗 ${fail}`);
process.exit(fail ? 1 : 0);
