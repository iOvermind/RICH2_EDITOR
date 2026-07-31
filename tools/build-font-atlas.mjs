#!/usr/bin/env node
/**
 * 把 Windows 細明體(MingLiU) 烤成「16 寬 × 15 高、每字 30 bytes」的點陣圖庫，
 * 給編輯器在缺字時直接取用（見 docs/runexe-re.md §7、§8）。
 *
 *   node tools/build-font-atlas.mjs
 *
 * 產出：src/assets/gamefont/mingliu-16x15.bin（未壓縮，419,190 bytes）
 *
 * ⚠ 不要輸出成 .gz：靜態伺服器看到 .gz 副檔名會自動掛 `Content-Encoding: gzip`，
 * 瀏覽器早就解過一次，前端再解一次必炸。傳輸時的壓縮交給 HTTP 層就好；
 * 進版控的體積也一樣（git 物件本來就會 zlib 壓）。
 *
 * 為什麼要離線烤成資產、而不是在瀏覽器裡用 Canvas 畫：
 * Canvas 走 Skia 的輪廓描繪 + 灰階反鋸齒，15px 這種小字二值化後會糊掉；
 * GDI+ 的 SingleBitPerPixelGridFit 走的是細明體內嵌的點陣，跟遊戲原本那套字同源。
 *
 * 索引方式（不需要另外的對照表）：
 *   slot = (lead - 0xA1) * 157 + trailIndex
 *   trailIndex：0x40~0x7E → 0~62、0xA1~0xFE → 63~156
 * 全零的格子 = 這個碼位沒有字。
 *
 * 只有 Windows 跑得起來（要 GDI+ 與細明體）。平常不用重跑。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import iconv from 'iconv-lite';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const OUT = path.join(ROOT, 'src/assets/gamefont/mingliu-16x15.bin');

const LEAD_MIN = 0xa1, LEAD_MAX = 0xf9;
const LEADS = LEAD_MAX - LEAD_MIN + 1;          // 89
const TRAILS = 157;                              // 0x40~0x7E (63) + 0xA1~0xFE (94)
const CELL = 24;                                 // 渲染框
const GLYPH = 30;                                // 16x15 / 8
// 與 tools/add-chars.mjs 相同：拿原版 639 個字形對出來的最佳位移
const FONT_NAME = 'MingLiU', FONT_PX = 15, DX = 2, DY = -1;

const trailOf = (i) => (i < 63 ? 0x40 + i : 0xa1 + (i - 63));

/** 一整列（同一個首位元組的 157 個碼位）畫成一張圖，轉 1bpp 後把原始位元倒出來 */
const PS_SCRIPT = String.raw`
param([string]$OutFile, [int]$Size, [string]$FontName, [int]$Cell, [int]$Cols, [int]$Rows, [string]$TextFile)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$lines = [System.IO.File]::ReadAllLines($TextFile, [System.Text.Encoding]::UTF8)
$font = New-Object System.Drawing.Font($FontName, $Size, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$fs = [System.IO.File]::Create($OutFile)
$W = $Cell * $Cols
foreach ($line in $lines) {
  $bmp = New-Object System.Drawing.Bitmap $W, $Cell
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::SingleBitPerPixelGridFit
  $g.Clear([System.Drawing.Color]::White)
  for ($i = 0; $i -lt $line.Length; $i++) {
    $ch = $line[$i]
    if ([int]$ch -eq 0) { continue }
    [System.Windows.Forms.TextRenderer]::DrawText($g, [string]$ch, $font,
      (New-Object System.Drawing.Point ($i * $Cell), 0),
      [System.Drawing.Color]::Black, [System.Drawing.Color]::White)
  }
  $g.Dispose()
  $rect = New-Object System.Drawing.Rectangle 0, 0, $W, $Cell
  $mono = $bmp.Clone($rect, [System.Drawing.Imaging.PixelFormat]::Format1bppIndexed)
  $data = $mono.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
    [System.Drawing.Imaging.PixelFormat]::Format1bppIndexed)
  $len = [Math]::Abs($data.Stride) * $Cell
  $buf = New-Object byte[] $len
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $buf, 0, $len)
  $mono.UnlockBits($data)
  $fs.Write([BitConverter]::GetBytes([int]$data.Stride), 0, 4)
  $fs.Write($buf, 0, $len)
  $mono.Dispose(); $bmp.Dispose()
}
$fs.Close(); $font.Dispose()
`;

// ── 準備每個首位元組要畫的 157 個字（畫不出來的填 \0）──────────────────
const lines = [];
let codepoints = 0;
for (let lead = LEAD_MIN; lead <= LEAD_MAX; lead++) {
  let line = '';
  for (let t = 0; t < TRAILS; t++) {
    const ch = iconv.decode(Buffer.from([lead, trailOf(t)]), 'big5');
    const ok = ch.length === 1 && ch !== '�' && ch.charCodeAt(0) > 0x7f;
    line += ok ? ch : '\0';
    if (ok) codepoints++;
  }
  lines.push(line);
}
console.log(`Big5 首位元組 0xA1~0xF9：${codepoints} 個可解碼的碼位`);

// ── 渲染 ────────────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rich2atlas-'));
const txtFile = path.join(tmp, 'rows.txt');
const binFile = path.join(tmp, 'rows.bin');
const psFile = path.join(tmp, 'atlas.ps1');
fs.writeFileSync(txtFile, lines.join('\n'), 'utf8');
fs.writeFileSync(psFile, PS_SCRIPT, 'utf8');
console.log(`用 ${FONT_NAME} ${FONT_PX}px 渲染 ${LEADS} 列 × ${TRAILS} 字…`);
execFileSync('powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile,
   '-OutFile', binFile, '-Size', String(FONT_PX), '-FontName', FONT_NAME,
   '-Cell', String(CELL), '-Cols', String(TRAILS), '-Rows', String(LEADS), '-TextFile', txtFile],
  { stdio: ['ignore', 'inherit', 'inherit'] });

// ── 打包成 slot 陣列 ────────────────────────────────────────────────────
const raw = fs.readFileSync(binFile);
const atlas = Buffer.alloc(LEADS * TRAILS * GLYPH);
let p = 0, filled = 0, clipped = [];
for (let li = 0; li < LEADS; li++) {
  const stride = raw.readInt32LE(p); p += 4;
  const rowBytes = raw.subarray(p, p + stride * CELL); p += stride * CELL;
  // 1bpp：位元 1 = 白（調色盤 index 1），所以「有墨水」是位元為 0
  const px = (x, y) => (x < 0 || y < 0 || y >= CELL) ? 0
    : (((rowBytes[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1) ? 0 : 1);
  for (let t = 0; t < TRAILS; t++) {
    const x0 = t * CELL;
    const slot = (li * TRAILS + t) * GLYPH;
    let ink = 0, lost = 0;
    for (let y = 0; y < 15; y++) for (let x = 0; x < 16; x++) {
      if (px(x0 + x + DX, y + DY)) { atlas[slot + y * 2 + (x >> 3)] |= 1 << (7 - (x & 7)); ink++; }
    }
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      if (px(x0 + x, y) && (x - DX < 0 || x - DX > 15 || y - DY < 0 || y - DY > 14)) lost++;
    }
    if (ink) filled++;
    if (lost) clipped.push(iconv.decode(Buffer.from([LEAD_MIN + li, trailOf(t)]), 'big5'));
  }
}
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`畫得出來的字：${filled} / ${codepoints}`);
if (clipped.length) console.log(`⚠ 有 ${clipped.length} 個字超出 16x15 被裁掉：${clipped.slice(0, 40).join('')}${clipped.length > 40 ? '…' : ''}`);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, atlas);
console.log(`已寫出 ${path.relative(ROOT, OUT)}：${atlas.length} bytes（${LEADS} × ${TRAILS} 格 × ${GLYPH}）`);
