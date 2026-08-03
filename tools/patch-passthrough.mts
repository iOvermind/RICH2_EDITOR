// 命令列版的「經過就觸發」。實作在 src/core/exe.ts 與 src/core/passthrough.ts，
// 這裡只是薄殼——兩份實作各自漂移是很難debug的那種問題。
//
//   node --import ./tests/loader.mjs tools/patch-passthrough.mts <in.exe> <out.exe> [--table 3=1,8=1]
//
// --table 的鍵是 SPECIAL 值（0公園 1銀行 2運氣 3卡片 4新聞 5股市 6法院 7黑市
// 8賭場 9遊樂場 10稅捐處），值：
//   0 = 不觸發
//   1 = 停下來觸發完整功能，再走完剩下的步數
//   2 = 走原本銀行那條過路處理
// 底線永遠是原版行為（銀行=2），--table 只在上面疊加；要關掉銀行得明寫 1=0。
import fs from 'fs';
import { loadExe, buildExe } from '../src/core/exe.ts';
import { insertPassThrough, defaultTable, TABLE_LEN, type PassAction } from '../src/core/passthrough.ts';

const KINDS = ['公園', '銀行', '運氣', '卡片', '新聞', '股市', '法院', '黑市', '賭場', '遊樂場', '稅捐處'];
const ACTION = { 1: '停下觸發再續走', 2: '銀行過路' } as const;

const args = process.argv.slice(2);
const flag = args.indexOf('--table');
const spec = flag >= 0 ? args[flag + 1] : undefined;
const [src, dst] = args.filter((_, i) => flag < 0 || (i !== flag && i !== flag + 1));
if (!src || !dst) {
    console.error('用法：patch-passthrough.mts <in.exe> <out.exe> [--table 3=1,8=1]');
    process.exit(1);
}

const table = defaultTable();
for (const part of (spec ?? '').split(',').filter(Boolean)) {
    const [k, v] = part.split('=').map((t) => Number(t.trim()));
    if (!Number.isInteger(k) || k < 0 || k >= TABLE_LEN) throw new Error(`SPECIAL 值要在 0~${TABLE_LEN - 1}：${part}`);
    if (![0, 1, 2].includes(v)) throw new Error(`行為只能是 0/1/2：${part}`);
    table[k] = v as PassAction;
}

const x = loadExe(new Uint8Array(fs.readFileSync(src)));
insertPassThrough(x, table);
const out = buildExe(x);
fs.writeFileSync(dst, out);

const desc = table.map((v, k) => (v ? `${KINDS[k] ?? k}→${ACTION[v as 1 | 2]}` : null)).filter(Boolean);
console.log(`${src}（${x.wasPacked ? 'EXEPACK 壓縮' : '未壓縮'}）→ ${dst}（未壓縮，${out.length} bytes）`);
console.log(`  經過觸發：${desc.length ? desc.join('、') : '全部關閉'}`);
