// 把 EXEPACK 壓縮的執行檔還原成未壓縮的普通 MZ，或只倒出映像供靜態分析。
// 實作在 src/core/exe.ts，這裡只是薄殼。
//
//   node --import ./tests/loader.mjs tools/unexepack.mts <in.exe> [out] [--exe]
//     不給 --exe：只寫出映像（給反組譯用）
//     給 --exe  ：寫出可執行的未壓縮 MZ
import fs from 'fs';
import { loadExe, buildExe, MAP_CAPS, readCap } from '../src/core/exe.ts';

const asExe = process.argv.includes('--exe');
const [src, dst] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!src) { console.error('用法：unexepack.mts <in.exe> [out] [--exe]'); process.exit(1); }

const x = loadExe(new Uint8Array(fs.readFileSync(src)));
console.log(src);
console.log(`  來源：${x.wasPacked ? 'EXEPACK 壓縮' : '未壓縮'}　映像 ${x.image.length} bytes　重定位項 ${x.relocs.length}`);
console.log(`  CS:IP = ${x.cs.toString(16)}:${x.ip.toString(16)}　SS:SP = ${x.ss.toString(16)}:${x.sp.toString(16)}　minalloc ${x.minAlloc}`);
console.log('  容量：' + ['台灣', '香港', '大富翁城']
    .map((n, i) => `${n} ${readCap(x, i, 'maxLoc')}/${readCap(x, i, 'special')}`).join('　'));
void MAP_CAPS;
if (dst) {
    const out = asExe ? buildExe(x) : x.image;
    fs.writeFileSync(dst, out);
    console.log(`  已寫出${asExe ? '未壓縮執行檔' : '映像'} ${out.length} bytes → ${dst}`);
}
