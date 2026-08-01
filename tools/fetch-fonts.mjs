#!/usr/bin/env node
/**
 * 把 Material Symbols 圖示字體抓成本機檔案，讓編輯器離線也能正常顯示圖示。
 *
 *   node tools/fetch-fonts.mjs
 *
 * 產出：src/assets/fonts/material-symbols-outlined.woff2 + fonts.css
 * 需要網路，平常不用跑；只有在**介面換了新圖示**時才要重跑。
 *
 * ⚠ 文字字體刻意不自帶。以前有子集化的 Noto Sans / Noto Sans TC（只含介面文案 +
 * 遊戲原版字表那 626 個字，共 660 KB），但缺字會自動補進遊戲字型之後，使用者可以打
 * 任何遊戲畫得出來的字 —— 那是 13,895 個碼位，全部打包單一字重就要 3.8 MB、三個字重
 * 11.4 MB。與其塞一份永遠會缺字的子集，不如直接吃系統字體（堆疊見 src/style.css）。
 *
 * 圖示字體則不能省：少了它，按鈕上會直接顯示 folder_open、undo 這些英文字。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const OUT_DIR = path.join(ROOT, 'src/assets/fonts');
const FILE = 'material-symbols-outlined.woff2';
// 沒帶瀏覽器 UA 的話 Google 會回 ttf 而不是 woff2
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/** 介面用到的圖示：直接掃 index.html，不要另外維護一份清單（會忘記同步） */
async function collectIcons() {
  const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');
  const names = new Set();
  for (const m of html.matchAll(/material-symbols-outlined[^>]*>\s*([a-z0-9_]+)\s*</g)) names.add(m[1]);
  return [...names].sort();
}

const icons = await collectIcons();
if (icons.length === 0) throw new Error('index.html 裡找不到任何圖示名稱');
console.log(`介面用到 ${icons.length} 個圖示：${icons.join(' ')}`);

const url = 'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1'
  + `&icon_names=${icons.join(',')}&display=block`;
const res = await fetch(url, { headers: { 'User-Agent': UA } });
if (!res.ok) throw new Error(`${res.status} ${res.statusText}　${url.slice(0, 120)}…`);
const src = (await res.text()).match(/src:\s*url\(([^)]+)\)/);
if (!src) throw new Error('回應裡沒有 woff2 網址，Google 可能改格式了');

const font = await fetch(src[1], { headers: { 'User-Agent': UA } });
if (!font.ok) throw new Error(`下載字體失敗：${font.status}`);
const bytes = new Uint8Array(await font.arrayBuffer());

await mkdir(OUT_DIR, { recursive: true });
await writeFile(path.join(OUT_DIR, FILE), bytes);
await writeFile(path.join(OUT_DIR, 'fonts.css'), `/* 由 tools/fetch-fonts.mjs 產生，不要手改。 */
/*
 * 這裡**只剩圖示字體**。文字一律用系統字體（字體堆疊見 src/style.css 的 @theme）。
 * 理由與取捨寫在 tools/fetch-fonts.mjs 的檔頭。
 * ⚠ 圖示字體不能拿掉：少了它，按鈕上會直接顯示 folder_open、undo 這些英文字。
 */
@font-face {
  font-family: 'Material Symbols Outlined';
  font-style: normal;
  font-weight: 100 700;
  font-display: block;
  src: url('./${FILE}') format('woff2');
}
`, 'utf8');
console.log(`已寫出 ${FILE}（${(bytes.length / 1024).toFixed(1)} KB）與 fonts.css`);
