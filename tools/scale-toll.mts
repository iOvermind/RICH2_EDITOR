// 實驗：把 DSK 價格表裡的**過路費**欄位（2~7，空地／一~五層）整批乘上一個倍數。
//
// 用來驗證「調價格表就能改變實際收的過路費」——如果成立，物價指數就可以照抄
// 新聞調地價那套做法（0x9660 把值寫回價格表欄位 0），不必去攔收租的程式碼。
//
// 引擎讀過路費的地方在段 0xCC5、映像 0x12681 附近：
//   ax = 房屋級數 + 2 → imul [0x11d4](價格表 stride) → + 地段 → 價格表[2+級數][地段]
// 也就是「過路費欄位序號 = 房屋級數 + 2」，跟編輯器「價格」頁的標示一致。
//
//   node --import ./tests/loader.mjs tools/scale-toll.mts <dsk 檔> <倍數>
//   node --import ./tests/loader.mjs tools/scale-toll.mts <dsk 檔> --list
import fs from 'fs';
import { parseSaveDskCore, rebuildDskBufferCore } from '../src/core/parser.ts';
import { PRICE_SEG_COUNT, PRICE_FIELD_SIZE, PRICE_FIELDS } from '../src/config/constants.ts';

const TOLL_FIELDS = [2, 3, 4, 5, 6, 7];   // 空地／一~五層過路費

const [file, arg] = process.argv.slice(2);
if (!file) {
    console.error('用法：scale-toll.mts <dsk 檔> <倍數>   或   <dsk 檔> --list');
    process.exit(1);
}

const buf = fs.readFileSync(file);
const raw = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) as ArrayBuffer;
const parsed = parseSaveDskCore(new DataView(raw), () => { });
if (!parsed?.priceData) throw new Error(`${file} 讀不出價格資料`);

const pd = parsed.priceData;
const dv = new DataView(pd.buffer, pd.byteOffset, pd.byteLength);
const get = (f: number, seg: number) => dv.getUint16(f * PRICE_FIELD_SIZE + seg * 2, true);
const set = (f: number, seg: number, v: number) => dv.setUint16(f * PRICE_FIELD_SIZE + seg * 2, Math.min(v, 0xffff), true);

const dump = (title: string) => {
    console.log(title);
    console.log('  地段 ' + PRICE_FIELDS.slice(0, 8).map((n) => n.padStart(8)).join(''));
    for (const seg of [1, 2, 3, 10, 20]) {
        console.log('  ' + String(seg).padStart(4) + ' ' +
            [0, 1, 2, 3, 4, 5, 6, 7].map((f) => String(get(f, seg)).padStart(8)).join(''));
    }
};

if (arg === '--list' || arg === undefined) { dump(`${file} 目前的價格表`); process.exit(0); }

const factor = Number(arg);
if (!Number.isFinite(factor) || factor <= 0) throw new Error('倍數要是正數');

dump('改之前');
let over = 0;
for (const f of TOLL_FIELDS) {
    for (let seg = 1; seg < PRICE_SEG_COUNT; seg++) {
        const v = Math.round(get(f, seg) * factor);
        if (v > 0xffff) over++;      // u16 欄位，爆掉會被截斷
        set(f, seg, v);
    }
}
dump(`\n改之後（過路費 ×${factor}）`);
if (over) console.log(`\n⚠ 有 ${over} 個欄位超過 65535 被夾住了——u16 存不下`);

const out = rebuildDskBufferCore(raw, parsed.dskGroupPointers, parsed.mapLayout,
    parsed.locData, pd, parsed.playerData, () => { });
if (!out) throw new Error('重建 DSK 失敗');

const bak = `${file}.toll.bak`;
if (!fs.existsSync(bak)) { fs.writeFileSync(bak, buf); console.log(`\n已備份 → ${bak}`); }
fs.writeFileSync(file, Buffer.from(out));
console.log(`已寫回 ${file}`);
