// 在 DOS 執行檔的**段界**插入程式碼區塊。
//
// 為什麼要插在段界：跳板必須跟被改的程式碼**同一個段**，才能用 near jmp 搆到
// （far 跳轉會改變 CS，後續的 near ret 與 CS 相對定址就全錯了）。原版 Run.exe
// 每個段的尾端都有編譯器留的對齊補 0，插在那裡等於把前一個段長長一點。
//
// 代價是插入點之後的所有段都往上移，所以每插一塊都要：
//   1. 重定位項的**位址**往後移
//   2. 重定位項存的**段值**（≥ 插入點的）加上插入的段落數
//   3. 檔頭的 CS / SS（≥ 插入點的）同樣加上去
//
// 插了之後「原版映像 offset」就不等於「實際位置」了，所以 ExeImage 會記下每次插入
// （`inserts`，用**原版座標**記），`imageOffset()` 負責換算。呼叫端一律用原版 offset。
import type { ExeImage, Reloc } from './exe';
import { imageOffset } from './exe';

/**
 * 找出所有段界（段落編號），依序排列。
 * 重定位表裡存的段值就是各段的基底，取出來去重排序即可；每個段界之前都應該是
 * 編譯器的對齊補 0，順便當成「這裡可以安全插入」的檢查。
 */
export function segmentEnds(x: ExeImage): number[] {
    const values = new Set<number>();
    for (const { seg, off } of x.relocs) {
        const a = seg * 16 + off;
        values.add(x.image[a] | (x.image[a + 1] << 8));
    }
    return [...values].filter((v) => v > 0).sort((a, b) => a - b);
}

/** 段界之前必須是補 0，不然那裡有真的資料，插進去會把它推歪。 */
export function assertPadded(x: ExeImage, atPara: number, need = 8): void {
    const end = imageOffset(x, atPara * 16);
    for (let i = end - need; i < end; i++) {
        if (x.image[i] !== 0) {
            throw new Error(`段界 0x${(atPara * 16).toString(16)} 之前不是補 0 的空白，插入不安全`);
        }
    }
}

/**
 * 把 `block` 插進**原版座標** `atPara` 這個段界。就地改寫 `x`。
 * 可以連續呼叫多次；`atPara` 一律用原版座標，位移由這裡處理。
 */
export function insertBlock(x: ExeImage, atPara: number, block: Uint8Array): void {
    if (block.length % 16) throw new Error('插入的區塊必須是段落的整數倍');
    const paras = block.length / 16;
    const at = imageOffset(x, atPara * 16);      // 這一刻的實際插入位置

    const out = new Uint8Array(x.image.length + block.length);
    out.set(x.image.subarray(0, at), 0);
    out.set(block, at);
    out.set(x.image.subarray(at), at + block.length);

    // 1) 重定位項的位址
    const relocs: Reloc[] = x.relocs.map(({ seg, off }) => {
        let linear = seg * 16 + off;
        if (linear >= at) linear += block.length;
        const ns = (linear >> 4) & 0xf000;
        return { seg: ns, off: linear - ns * 16 };
    });
    // 2) 重定位項存的段值。用**現在的**段落編號比較，因為映像已經是位移後的狀態。
    const atPara2 = at / 16;
    for (const { seg, off } of relocs) {
        const a = seg * 16 + off;
        const v = out[a] | (out[a + 1] << 8);
        if (v >= atPara2) { const nv = v + paras; out[a] = nv & 0xff; out[a + 1] = (nv >> 8) & 0xff; }
    }

    x.image = out;
    x.relocs = relocs;
    // 3) 檔頭
    if (x.cs >= atPara2) x.cs += paras;
    if (x.ss >= atPara2) x.ss += paras;

    (x.inserts ??= []).push({ atOriginal: atPara * 16, bytes: block.length });
    x.inserts.sort((a, b) => a.atOriginal - b.atOriginal);
}
