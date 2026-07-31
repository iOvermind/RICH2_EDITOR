#!/usr/bin/env node
/**
 * 往 Wor.pak 的字表與字形裡加字。字形直接用 Windows 的細明體(MingLiU)點陣渲染。
 *
 *   node tools/add-chars.mjs 苗 栗          # 加這兩個字
 *   node tools/add-chars.mjs 苗栗宜蘭        # 連在一起也可以
 *   node tools/add-chars.mjs --force 鰂      # 連 Big5 首位元組 < 0xA1 的罕用字也加（做實驗用）
 *   node tools/add-chars.mjs --remove 鰂     # 把加過的字拿掉（原版那 639 個字動不了）
 *   node tools/add-chars.mjs                # 不給參數＝預設的「苗栗」
 *
 * 背景見 docs/runexe-re.md §7、§8：
 *   - g4（第 5 組）＝ 2-byte Big5 字表（原版 639 項）
 *   - g1（第 2 組）＝ 前 1664 bytes 是繪圖用的 run-length 查表，之後每 30 bytes 一個字形
 *   - glyph[i] 對應 table[i]，1:1，Run.exe 裡沒有寫死字數
 *
 * 只重壓被改到的那兩組，其餘四組的壓縮位元組原樣搬過去。
 * 第一次執行會備份成 Wor.pak.bak（只當備份，不當輸入 —— 輸入一律是**現況**，
 * 否則會把編輯器存檔時補進去的字洗掉）。已在表內的字會自動略過，所以重複執行不會疊加。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import iconv from 'iconv-lite';

const PAK = 'rich2/Wor.pak';
const BAK = PAK + '.bak';
const FONT_HEADER = 1664;   // g1 裡 run-length 查表的長度（定長，與字數無關）
const GLYPH = 30;           // 每字 30 bytes = 16 寬 x 15 高
const PTR_BASE = 7;

// 細明體 15px 的墨水範圍是 x 3~16、y 0~13（736 字實測）。
// 這組位移是拿原版 639 個字形去對出來的最佳解：貼進格子後占 cols 1~14、rows 1~14，
// 與遊戲自己的字（cols 0~14、row 0 幾乎全空）對齊得最好。
const FONT_NAME = 'MingLiU';
const FONT_PX = 15;
const DX = 2, DY = -1;

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const REMOVE = args.includes('--remove');
const argChars = [...args.filter(a => !a.startsWith('--')).join('')].filter(c => /\S/.test(c));
const WANT = argChars.length ? argChars : ['苗', '栗'];

// ── 用 .NET GDI+ 把字渲染成點陣 ─────────────────────────────────────────
const PS_SCRIPT = String.raw`
param([string]$InFile, [string]$OutFile, [int]$Size, [string]$FontName)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$chars = [System.IO.File]::ReadAllText($InFile, [System.Text.Encoding]::UTF8).ToCharArray()
$W = 24; $H = 24
$out = New-Object System.Collections.Generic.List[byte]
$font = New-Object System.Drawing.Font($FontName, $Size, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
foreach ($ch in $chars) {
  $bmp = New-Object System.Drawing.Bitmap $W,$H
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::SingleBitPerPixelGridFit
  $g.Clear([System.Drawing.Color]::White)
  [System.Windows.Forms.TextRenderer]::DrawText($g, [string]$ch, $font, (New-Object System.Drawing.Point 0,0), [System.Drawing.Color]::Black, [System.Drawing.Color]::White)
  for ($y=0; $y -lt $H; $y++) {
    for ($bx=0; $bx -lt 3; $bx++) {
      $b = 0
      for ($i=0; $i -lt 8; $i++) { if ($bmp.GetPixel($bx*8+$i, $y).R -lt 128) { $b = $b -bor (1 -shl (7-$i)) } }
      $out.Add([byte]$b)
    }
  }
  $g.Dispose(); $bmp.Dispose()
}
$font.Dispose()
[System.IO.File]::WriteAllBytes($OutFile, $out.ToArray())
`;

/** 回傳每個字的 30-byte 字形（16 寬 x 15 高），用細明體渲染 */
function renderGlyphs(chars) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rich2font-'));
  const inFile = path.join(tmp, 'in.txt');
  const outFile = path.join(tmp, 'out.bin');
  const psFile = path.join(tmp, 'render.ps1');
  fs.writeFileSync(inFile, chars.join(''), 'utf8');
  fs.writeFileSync(psFile, PS_SCRIPT, 'utf8');
  execFileSync('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile,
     '-InFile', inFile, '-OutFile', outFile, '-Size', String(FONT_PX), '-FontName', FONT_NAME],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const bmp = fs.readFileSync(outFile);
  fs.rmSync(tmp, { recursive: true, force: true });

  const H = 24, ROW = 3, W = 24;
  return chars.map((ch, i) => {
    const px = (x, y) => (y < 0 || y >= H || x < 0 || x >= W)
      ? 0 : (bmp[i * H * ROW + y * ROW + (x >> 3)] >> (7 - (x & 7))) & 1;
    const g = Buffer.alloc(GLYPH);
    let ink = 0;
    for (let y = 0; y < 15; y++) for (let x = 0; x < 16; x++) {
      if (px(x + DX, y + DY)) { g[y * 2 + (x >> 3)] |= 1 << (7 - (x & 7)); ink++; }
    }
    if (!ink) throw new Error(`「${ch}」渲染出來是空白 —— 字型 ${FONT_NAME} 可能沒有這個字`);
    // 渲染框比格子大，檢查有沒有被裁掉
    let lost = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (px(x, y) && (x - DX < 0 || x - DX > 15 || y - DY < 0 || y - DY > 14)) lost++;
    }
    if (lost) console.warn(`  ⚠ 「${ch}」有 ${lost} 個像素超出 16x15 被裁掉`);
    return g;
  });
}

function artOf(g) {
  const L = [];
  for (let y = 0; y < 15; y++) {
    let s = '';
    for (let x = 0; x < 16; x++) s += ((g[y * 2 + (x >> 3)] >> (7 - (x & 7))) & 1) ? '██' : '　';
    L.push(s);
  }
  return L;
}

// ── PAK 壓縮／解壓（與 src/utils/compression.ts 相同）─────────────────────
function decompress(buf, start) {
  const out = [];
  const n = buf.readUInt16LE(start);
  let p = start + 2;
  for (let i = 0; i < n; i++) {
    if (p >= buf.length) break;
    const b = buf[p++];
    const c = (b & 0x7f) + 1;
    if (b & 0x80) { for (let j = 0; j < c && p < buf.length; j++) out.push(buf[p++]); }
    else { const r = buf[p++]; for (let j = 0; j < c; j++) out.push(r); }
  }
  return Buffer.from(out);
}

function compress(input) {
  const out = [];
  let i = 0, chunks = 0;
  while (i < input.length) {
    let rep = 1;
    while (i + rep < input.length && rep < 128 && input[i + rep] === input[i]) rep++;
    if (rep >= 3) { out.push(rep - 1, input[i]); i += rep; chunks++; }
    else {
      let raw = 0;
      while (i + raw < input.length && raw < 128) {
        if (i + raw + 2 < input.length &&
            input[i + raw] === input[i + raw + 1] &&
            input[i + raw] === input[i + raw + 2]) break;
        raw++;
      }
      out.push(0x80 | (raw - 1));
      for (let j = 0; j < raw; j++) out.push(input[i + j]);
      i += raw; chunks++;
    }
  }
  const res = Buffer.alloc(2 + out.length + (out.length % 2));
  res.writeUInt16LE(chunks & 0xffff, 0);
  Buffer.from(out).copy(res, 2);
  return res;
}

// ── 讀檔、切出各組 ──────────────────────────────────────────────────────
const raw = fs.readFileSync(PAK);
if (!fs.existsSync(BAK)) { fs.writeFileSync(BAK, raw); console.log(`已備份 → ${BAK}`); }

const ptrVals = [];
for (let p = PTR_BASE; ; p += 2) { const v = raw.readUInt16LE(p); if (v === 0) break; ptrVals.push(v); }
const offsets = ptrVals.map(v => PTR_BASE + v * 2);
if (offsets[offsets.length - 1] !== raw.length) throw new Error('最後一個指標不等於檔案長度');
const groups = offsets.slice(0, -1).map((o, i) => raw.subarray(o, offsets[i + 1]));

const table = decompress(raw, offsets[4]);
const font = decompress(raw, offsets[1]);
const n = table.length / 2;
const fontCount = Math.floor((font.length - FONT_HEADER) / GLYPH);
if (n !== fontCount) throw new Error(`字數對不上：字表 ${n}、字形 ${fontCount}`);
console.log(`原版：字表 ${n} 字、字形 ${fontCount} 字`);

// ── 原版有哪些字（.bak 就是原版）：那些字動不得，地圖原文正在用 ──────────
function baselineChars() {
  if (!fs.existsSync(BAK)) return null;
  const b = fs.readFileSync(BAK);
  const offs = [];
  for (let p = PTR_BASE; ; p += 2) { const v = b.readUInt16LE(p); if (!v) break; offs.push(PTR_BASE + v * 2); }
  return iconv.decode(decompress(b, offs[4]), 'big5');
}

let newTable, newFont;
const cut = FONT_HEADER + fontCount * GLYPH;
const existing = iconv.decode(Buffer.from(table), 'big5');

if (REMOVE) {
  // ── 拿掉字 ────────────────────────────────────────────────────────────
  const base = baselineChars();
  const drop = new Set(), miss = [], locked = [];
  for (const ch of WANT) {
    const i = existing.indexOf(ch);
    if (i < 0) { miss.push(ch); continue; }
    if (base && base.includes(ch)) { locked.push(ch); continue; }
    drop.add(i);
  }
  if (miss.length) console.log(`不在表內，略過：${miss.join('、')}`);
  if (locked.length) throw new Error(`「${locked.join('」「')}」是原版就有的字，地圖原文正在用，不能拿掉`);
  if (!drop.size) { console.log('沒有要拿掉的字，結束。'); process.exit(0); }

  const keep = [...Array(n).keys()].filter(i => !drop.has(i));
  console.log(`拿掉 ${drop.size} 個字：${[...drop].map(i => existing[i]).join('')}（字表 ${n} → ${keep.length}）`);
  newTable = Buffer.concat(keep.map(i => table.subarray(i * 2, i * 2 + 2)));
  newFont = Buffer.concat([
    font.subarray(0, FONT_HEADER),
    ...keep.map(i => font.subarray(FONT_HEADER + i * GLYPH, FONT_HEADER + (i + 1) * GLYPH)),
    font.subarray(cut),                       // 尾端的餘料原樣留著
  ]);
} else {
  // ── 加字 ──────────────────────────────────────────────────────────────
  const add = [], skip = [];
  for (const ch of WANT) {
    const code = iconv.encode(ch, 'big5');
    if (code.length !== 2) throw new Error(`「${ch}」不是 2-byte Big5`);
    if (code[0] < 0xa1) {
      // 遊戲實測顯示這種字會排版錯位（「鰂」→「o」），加進字表照理沒用。
      // --force 是拿來驗證這個前提的：真的加下去，看遊戲畫不畫得出來。
      if (!FORCE) throw new Error(`「${ch}」的 Big5 首位元組 0x${code[0].toString(16)} < 0xA1，遊戲會排版錯位（要實驗請加 --force）`);
      console.log(`  ⚠ 「${ch}」首位元組 0x${code[0].toString(16)} < 0xA1，--force 照加，結果請進遊戲確認`);
    }
    if (existing.includes(ch) || add.some(a => a.ch === ch)) { skip.push(ch); continue; }
    add.push({ ch, code });
  }
  if (skip.length) console.log(`已在表內／重複，略過：${skip.join('、')}`);
  if (!add.length) { console.log('沒有要加的字，結束。'); process.exit(0); }

  console.log(`用 ${FONT_NAME} ${FONT_PX}px 渲染 ${add.length} 個字…`);
  const glyphs = renderGlyphs(add.map(a => a.ch));
  add.forEach((a, i) => {
    console.log(`\n  「${a.ch}」 Big5 ${a.code[0].toString(16)} ${a.code[1].toString(16)} → index ${n + i}`);
    console.log(artOf(glyphs[i]).map(r => '  ' + r).join('\n'));
  });

  newTable = Buffer.concat([table, ...add.map(a => a.code)]);
  newFont = Buffer.concat([font.subarray(0, cut), ...glyphs, font.subarray(cut)]);
}

const slack = (Math.ceil(newTable.length / 16) * 16) - newTable.length;
console.log(`\n新字表 ${newTable.length} bytes（${newTable.length / 2} 字），段落餘裕 ${slack} bytes` +
  (slack === 0 ? '　⚠ 剛好卡在段落邊界，若遊戲異常請多加／少加一個字' : ''));

const newGroups = groups.slice();
newGroups[4] = compress(newTable);
newGroups[1] = compress(newFont);
for (const [i, g] of newGroups.entries()) {
  const want = i === 4 ? newTable : i === 1 ? newFont : decompress(raw, offsets[i]);
  if (!decompress(g, 0).equals(want)) throw new Error(`第 ${i} 組壓縮後解不回原樣`);
}

const dataStart = offsets[0];
const newOffsets = [dataStart];
for (const g of newGroups) newOffsets.push(newOffsets[newOffsets.length - 1] + g.length);
for (const o of newOffsets) if ((o - PTR_BASE) % 2 !== 0) throw new Error(`群組起點 0x${o.toString(16)} 無法用指標表示`);

const total = newOffsets[newOffsets.length - 1];
const out = Buffer.alloc(total);
raw.copy(out, 0, 0, dataStart);
out.fill(0, PTR_BASE, dataStart);
newOffsets.forEach((o, i) => out.writeUInt16LE((o - PTR_BASE) / 2, PTR_BASE + i * 2));
out.writeUInt16LE(total - PTR_BASE, 5);      // 檔頭 offset 5 = 檔案長度 - 7
newGroups.forEach((g, i) => g.copy(out, newOffsets[i]));

fs.writeFileSync(PAK, out);
console.log(`已寫出 ${PAK}：${raw.length} → ${total} bytes，共 ${newTable.length / 2} 字`);
console.log(`還原：copy /Y ${BAK.replace(/\//g, '\\')} ${PAK.replace(/\//g, '\\')}`);
