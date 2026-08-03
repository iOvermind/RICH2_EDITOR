// 設定地點的 UNK13（欄位 0x13）——遊戲內建的「經過就停在這格」旗標。
//
// 移動迴圈 0x1AE9 / 0x1B3E 兩處會讀這個欄位：
//   1 = 停在這格，然後**把地圖圖塊與這個旗標一起清掉**（一次性，就是路障）
//   3 = 停在這格，不清除（永久）
// 停的方式是把「已走步數」[0x1C6] 設成 999，迴圈尾巴的 `cmp ax,[0x1a6]; jg 離開` 立刻成立。
// 移動結束後遊戲照常跑「踩上去」的處理，所以是在正常狀態下呼叫分派器——
// 不需要動 Run.exe 一個位元組。
//
// 三張原版地圖的 UNK13 全部是 0，這個功能從來沒被用過。
//
// 用法：
//   node --import ./tests/loader.mjs tools/set-stopflag.mts <dsk 檔> <locId> <0|1|3>
//   node --import ./tests/loader.mjs tools/set-stopflag.mts <dsk 檔> --list
import fs from 'fs';
import { parseSaveDskCore, rebuildDskBufferCore } from '../src/core/parser.ts';
import { LOC_FIELDS, LOC_COUNT } from '../src/config/constants.ts';

const [file, arg, valArg] = process.argv.slice(2);
if (!file) {
    console.error('用法：set-stopflag.mts <dsk 檔> <locId> <0|1|3>   或   <dsk 檔> --list');
    process.exit(1);
}

const buf = fs.readFileSync(file);
const raw = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) as ArrayBuffer;
const parsed = parseSaveDskCore(new DataView(raw), () => { });
if (!parsed?.locData) throw new Error(`${file} 讀不出地點資料`);

const loc = parsed.locData;
const dv = new DataView(loc.buffer, loc.byteOffset, loc.byteLength);
const get = (field: number, id: number) => dv.getUint16(field + id * 2, true);
const set = (field: number, id: number, v: number) => dv.setUint16(field + id * 2, v, true);

if (arg === '--list') {
    const rows: string[] = [];
    for (let id = 0; id < LOC_COUNT; id++) {
        const sp = get(LOC_FIELDS.SPECIAL, id);
        const stop = get(LOC_FIELDS.UNK13, id);
        if (sp || stop) rows.push(`  #${id}  SPECIAL=${sp}  UNK13=${stop}`);
    }
    console.log(`${file}：有 SPECIAL 或 UNK13 的地點`);
    console.log(rows.join('\n'));
    process.exit(0);
}

const id = Number(arg);
const val = Number(valArg);
if (!Number.isInteger(id) || id < 0 || id >= LOC_COUNT) throw new Error(`locId 要在 0~${LOC_COUNT - 1}`);
if (![0, 1, 3].includes(val)) throw new Error('值只能是 0（關）、1（一次性，會自己消失）、3（永久）');

const before = get(LOC_FIELDS.UNK13, id);
set(LOC_FIELDS.UNK13, id, val);

const out = rebuildDskBufferCore(raw, parsed.dskGroupPointers, parsed.mapLayout,
    loc, parsed.priceData, parsed.playerData, () => { });
if (!out) throw new Error('重建 DSK 失敗');

const bak = `${file}.stopflag.bak`;
if (!fs.existsSync(bak)) { fs.writeFileSync(bak, buf); console.log(`已備份 → ${bak}`); }
fs.writeFileSync(file, Buffer.from(out));
console.log(`${file}  地點 #${id}  UNK13：${before} → ${val}  （SPECIAL=${get(LOC_FIELDS.SPECIAL, id)}）`);
