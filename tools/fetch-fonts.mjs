#!/usr/bin/env node
/**
 * 把原本從 Google Fonts CDN 載的字體抓成本機檔案，讓編輯器離線也能正常顯示。
 *
 *   node tools/fetch-fonts.mjs
 *
 * 產出：src/assets/fonts/*.woff2 + fonts.css（style.css 會 @import 它）。
 * 需要網路，平常不用跑；只有在「UI 新增了原本沒出現過的字」或「換圖示」時才要重跑。
 *
 * ⚠ 這個子集**不涵蓋使用者可能打進去的所有字**。缺字會在存檔時自動補進遊戲字型
 * （見 src/core/gamefont.ts），所以地段名稱可以用任何遊戲畫得出來的字 —— 那是 13,895
 * 個碼位，全打包進來單一字重 3.8 MB、三個字重 11.4 MB。不值得，因此子集維持現狀，
 * 超出的字交給 src/style.css 裡明確指定的系統 CJK 字體後備。
 *
 * 中日韓字體整包有好幾 MB，這裡只抓實際會用到的字：
 *   - 介面自己的字（index.html + src/**\/*.ts 裡的中文，含註解，抓寬一點不怕漏）
 *   - 遊戲字型支援的字集（docs/game-charset.txt）——地段名稱那類由遊戲檔帶進來的字
 * Google 的 text= 參數有長度上限，所以分批請求，每批回應都自帶精確的 unicode-range，
 * 瀏覽器會依字自動挑對應的檔案。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const OUT_DIR = path.join(ROOT, 'src/assets/fonts');
// 沒帶瀏覽器 UA 的話 Google 會回 ttf 而不是 woff2
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const CHUNK = 450;   // 每批字數；再多 URL 會超過長度上限，Google 會默默改回整包分段模式

/** 介面 + 遊戲字集裡出現過的中文字（含全形標點） */
async function collectChars() {
  const files = [path.join(ROOT, 'index.html')];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) files.push(p);
    }
  })(path.join(ROOT, 'src'));
  files.push(path.join(ROOT, 'docs/game-charset.txt'));

  const cjk = /[　-〿㐀-䶿一-鿿＀-￯]/gu;
  const set = new Set();
  for (const f of files) {
    for (const ch of (await readFile(f, 'utf8')).match(cjk) ?? []) set.add(ch);
  }
  return [...set].sort();
}

async function fetchCss(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}　${url.slice(0, 120)}…`);
  return res.text();
}

/** 把 CSS 拆成 @font-face 區塊；標準回應每塊前面會有 /* latin *\/ 這種註解 */
function parseFaces(css) {
  const out = [];
  const re = /(?:\/\*\s*([^*]+?)\s*\*\/\s*)?@font-face\s*\{([\s\S]*?)\}/g;
  for (const m of css.matchAll(re)) {
    const body = m[2];
    const pick = (re2) => (body.match(re2) ?? [])[1];
    out.push({
      label: m[1] ?? null,
      family: pick(/font-family:\s*'([^']+)'/),
      weight: pick(/font-weight:\s*([^;]+);/)?.trim(),
      url: pick(/url\(([^)]+)\)/),
      range: pick(/unicode-range:\s*([^;]+);/)?.replace(/\s+/g, ' ').trim(),
    });
  }
  return out;
}

async function download(url, file) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`下載失敗 ${res.status}：${file}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(path.join(OUT_DIR, file), buf);
  return buf.length;
}

const faces = [];   // 最後要寫進 fonts.css 的內容
let total = 0;

async function job(name, url, { keep = null, file }) {
  const css = await fetchCss(url);
  let i = 0;
  for (const f of parseFaces(css)) {
    if (!f.url) continue;
    if (keep && !keep.includes(f.label)) continue;
    const out = file(f, i++);
    const bytes = await download(f.url, out);
    total += bytes;
    faces.push({ ...f, out });
    console.log(`  ${out.padEnd(38)} ${(bytes / 1024).toFixed(1).padStart(7)} KB`);
  }
  console.log(`${name} ✓`);
}

const chars = await collectChars();
await mkdir(OUT_DIR, { recursive: true });
console.log(`介面 + 遊戲字集共 ${chars.length} 個中文字，分 ${Math.ceil(chars.length / CHUNK)} 批抓\n`);

// 1. 中文：只抓用得到的字，分批
for (const weight of [400, 500, 700]) {
  for (let i = 0; i * CHUNK < chars.length; i++) {
    const text = chars.slice(i * CHUNK, (i + 1) * CHUNK).join('');
    await job(`Noto Sans TC ${weight} 第 ${i + 1} 批`,
      `https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@${weight}` +
      `&text=${encodeURIComponent(text)}&display=swap`,
      { file: () => `noto-sans-tc-${weight}-${i + 1}.woff2` });
  }
}

// 2. 西文與等寬：只要 latin 分段。latin-ext（東歐/越南字母）每個 50KB 以上，這個介面用不到
for (const weight of [400, 500, 700]) {
  await job(`Noto Sans ${weight}`,
    `https://fonts.googleapis.com/css2?family=Noto+Sans:wght@${weight}&display=swap`,
    { keep: ['latin'], file: (f) => `noto-sans-${f.label}-${weight}.woff2` });
}
await job('JetBrains Mono 400',
  'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400&display=swap',
  { keep: ['latin'], file: (f) => `jetbrains-mono-${f.label}-400.woff2` });

// 3. 圖示：只要 UI 真的用到的那幾個，整包有好幾 MB
const ICONS = ['add', 'add_home', 'auto_fix_high', 'folder_open', 'grid_view', 'healing',
  'redo', 'route', 'save', 'sync', 'terminal', 'undo', 'waves'];
await job(`Material Symbols（${ICONS.length} 個圖示）`,
  'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1' +
  `&icon_names=${ICONS.join(',')}&display=block`,
  { file: () => 'material-symbols-outlined.woff2' });

const css = [
  '/* 由 tools/fetch-fonts.mjs 產生，不要手改。 */',
  '/* 中文只含介面與遊戲字集用得到的字；缺字時瀏覽器會退回系統字體。 */',
  '',
  ...faces.map(f => [
    '@font-face {',
    `  font-family: '${f.family}';`,
    '  font-style: normal;',
    `  font-weight: ${f.weight};`,
    `  font-display: ${f.family.startsWith('Material') ? 'block' : 'swap'};`,
    `  src: url('./${f.out}') format('woff2');`,
    ...(f.range ? [`  unicode-range: ${f.range};`] : []),
    '}',
  ].join('\n')),
  '',
].join('\n');
await writeFile(path.join(OUT_DIR, 'fonts.css'), css);

console.log(`\n共 ${faces.length} 個檔案、${(total / 1024).toFixed(0)} KB → src/assets/fonts/`);
