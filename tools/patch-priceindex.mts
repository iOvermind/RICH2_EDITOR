// 命令列版的「物價指數」。實作在 src/core/priceindex.ts，這裡只是薄殼。
//
//   node --import ./tests/loader.mjs tools/patch-priceindex.mts <in.exe> <out.exe> [選項]
//
// 選項：
//   --threshold N   門檻，單位**元**。總資產每超過一個門檻，過路費 +1 倍。預設 500000
//   --cap N         指數上限，0 = 無上限。預設 0
//   --no-high-water 不套「只漲不落」，倍率直接反映當下算出來的值（診斷用）
//   --fixed N       指數寫死成 N，完全不算資產（診斷用，把掛鉤點跟計算切開）
//   --like <exe>    沿用另一支 Run.exe 的設定（三張圖的容量 + 經過就觸發的種類表）
//   --solo          不要一起插「經過就觸發」（預設會插，因為那是唯一經過實機驗證的順序）
//
// ⚠ 一定要用 --like 指向遊戲目錄現在那支 Run.exe。編輯器會把三張圖的地點／特殊地點
//   上限寫進執行檔，直接拿原版重建會把這些上限打回原版值——玩家一走到新增的特殊
//   地點就當機。實測踩過：原版第一張圖 special=23，編輯過的是 24。
//
// 診斷慣用法：`--threshold 1000 --no-high-water`
// 此時 指數 = 1 + 總額 ÷ 1000，等於把跳板內部的中間值當成過路費倍率印出來。
// 這個遊戲沒有 debugger，這是目前唯一的觀測手段。
import fs from 'fs';
import { loadExe, buildExe, readCap, writeCap } from '../src/core/exe.ts';
import { insertPassThrough, defaultTable, readPassTable, isDefaultTable, type PassAction } from '../src/core/passthrough.ts';
import { insertPriceIndex, type PriceIndexOptions } from '../src/core/priceindex.ts';

const args = process.argv.slice(2);
const take = (name: string): string | undefined => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
};
const has = (name: string): boolean => {
    const i = args.indexOf(name);
    if (i < 0) return false;
    args.splice(i, 1);
    return true;
};

const thresholdRaw = take('--threshold');
const capRaw = take('--cap');
const fixedRaw = take('--fixed');
const likePath = take('--like');
const noHighWater = has('--no-high-water');
const solo = has('--solo');
const [src, dst] = args;

if (!src || !dst) {
    console.error('用法：patch-priceindex.mts <in.exe> <out.exe> [--threshold 500000] [--cap 0]');
    console.error('      [--no-high-water] [--fixed N] [--solo]');
    process.exit(1);
}

const num = (raw: string | undefined, dflt: number, name: string, max = 0xffff): number => {
    if (raw === undefined) return dflt;
    const v = Number(raw);
    if (!Number.isInteger(v) || v < 0 || v > max) throw new Error(`${name} 要是 0~${max} 的整數：${raw}`);
    return v;
};

const opt: PriceIndexOptions = {
    threshold: num(thresholdRaw, 500000, '--threshold', 0x7fffffff),
    cap: num(capRaw, 0, '--cap'),
    ...(noHighWater ? { noHighWater: true } : {}),
    ...(fixedRaw !== undefined ? { fixedIndex: num(fixedRaw, 1, '--fixed') } : {}),
};

const x = loadExe(new Uint8Array(fs.readFileSync(src)));

// 沿用現行 Run.exe 的設定。順序照 gamefolder.patchExe：先容量、再跳板。
let table = defaultTable();
let capNote = '（沿用 in.exe 現況）';
if (likePath) {
    const ref = loadExe(new Uint8Array(fs.readFileSync(likePath)));
    const caps: string[] = [];
    for (let i = 0; i < 3; i++) {
        const maxLoc = readCap(ref, i, 'maxLoc'), special = readCap(ref, i, 'special');
        writeCap(x, i, 'maxLoc', maxLoc);
        writeCap(x, i, 'special', special);
        caps.push(`${maxLoc}/${special}`);
    }
    capNote = caps.join('  ');
    try { table = readPassTable(ref) as PassAction[]; } catch { /* 參考檔沒跳板就用預設 */ }
}

// 物價指數的跳板插在更後面的段界，順序反了位移會對不上（見 insertPriceIndex 的註解）。
// 預設連「經過就觸發」一起插，是因為測試涵蓋的就是這個順序；--solo 走沒被測過的路。
if (!solo) insertPassThrough(x, table);
insertPriceIndex(x, opt);
const out = buildExe(x);
fs.writeFileSync(dst, out);

console.log(`${src}（${x.wasPacked ? 'EXEPACK 壓縮' : '未壓縮'}）→ ${dst}（未壓縮，${out.length} bytes）`);
if (opt.fixedIndex) {
    console.log(`  指數寫死 = ${opt.fixedIndex}（跳板裡沒有資產計算）`);
} else {
    console.log(`  門檻 ${opt.threshold} 元　上限 ${opt.cap || '無'}　現金＋存款＋股票` +
        `${opt.noHighWater ? '　允許回落' : '　只漲不落'}`);
    if (opt.threshold === 1000) console.log(`  ⚠ 門檻 1000：過路費倍率 = 1 + 總額 ÷ 1000，這是診斷讀數不是可玩設定`);
}
console.log(`  三張圖 maxLoc/special：${capNote}`);
console.log(`  經過就觸發：${isDefaultTable(table) ? '原版預設' : table.map((v, k) => (v ? `${k}→${v}` : null)).filter(Boolean).join(' ')}`);
console.log(`  插了 ${x.inserts?.length ?? 0} 塊跳板`);
