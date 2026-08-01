#!/usr/bin/env node
/**
 * 把編輯器打包成可以直接發佈到 GitHub Releases 的壓縮檔。
 *
 *   npm run package
 *
 * 產出：release/Rich2Editor-vX.Y.Z.zip，解開後雙擊 Rich2Editor.bat 就能用。
 *
 * 打包內容：
 *   Rich2Editor.bat   ← 使用者雙擊這個
 *   serve.ps1         ← 本機靜態伺服器 + 開瀏覽器
 *   README.txt
 *   app/              ← vite build 的產物
 *
 * 為什麼要伺服器而不是直接雙擊 HTML：編輯器靠 File System Access API 讀寫遊戲
 * 資料夾，而 Vite 的輸出是 ES module，從 file:// 載入會被 CORS 擋掉。細節寫在
 * packaging/serve.ps1 的檔頭。
 */
import { cp, mkdir, readFile, rm, readdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const DIST = path.join(ROOT, 'dist');
const PACKAGING = path.join(ROOT, 'packaging');
const RELEASE = path.join(ROOT, 'release');

const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const name = `Rich2Editor-v${pkg.version}`;
const stage = path.join(RELEASE, name);

// 直接跑 tsc / vite 的 JS 進入點，不要 spawn npm ——
// Node 25 起不准直接 spawn .cmd（EINVAL），而加 shell:true 又會噴棄用警告。
console.log('型別檢查…');
execFileSync(process.execPath, [path.join(ROOT, 'node_modules/typescript/bin/tsc')], { cwd: ROOT, stdio: 'inherit' });
console.log('建置…');
execFileSync(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: ROOT, stdio: 'inherit' });

console.log('組裝…');
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await cp(DIST, path.join(stage, 'app'), { recursive: true });
for (const f of ['Rich2Editor.bat', 'serve.ps1', 'README.txt']) {
  await cp(path.join(PACKAGING, f), path.join(stage, f));
}

/** 遞迴算出資料夾大小，用來回報打包結果 */
async function dirSize(dir) {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? await dirSize(p) : (await stat(p)).size;
  }
  return total;
}
console.log(`  解開後 ${(await dirSize(stage) / 1024 / 1024).toFixed(2)} MB`);

console.log('壓縮…');
const zip = path.join(RELEASE, `${name}.zip`);
await rm(zip, { force: true });
// 用 Windows 內建的 Compress-Archive，不必多裝套件
execFileSync('powershell.exe', ['-NoProfile', '-Command',
  `Compress-Archive -Path '${stage}' -DestinationPath '${zip}' -CompressionLevel Optimal`],
  { stdio: 'inherit' });

console.log(`\n完成：release/${name}.zip（${((await stat(zip)).size / 1024 / 1024).toFixed(2)} MB）`);
console.log('丟到 GitHub Releases 就可以了。使用者解開後雙擊 Rich2Editor.bat。');
