// 物價指數：所有玩家的總資產每超過一個門檻，過路費就多一倍（等差、只漲不落）。
//
// 引擎讀過路費**全映像只有一處**：`0x12695`，在段 0xCC5 裡：
//
//   1267E: add ax, 2              ; 價格欄位序號 = 房屋級數 + 2（空地=2…五層=7）
//   12681: imul word [0x11d4]     ; × 價格表 stride
//   1268C: mov si, 0x11c2         ; 價格表
//   12695: mov ax, es:[bx]        ; ← 過路費（表裡是 u16）
//   12698: cdq                    ; 符號延伸成 DX:AX
//   12699: add ax,[bp-0x18]       ; 32-bit 累加
//   1269C: adc dx,[bp-0x16]
//
// 收租、AI 估值、財產查詢全都共用這一處，所以只要在這裡乘上指數，各處就會一致。
// 而且 `cdq` 跟 `imul r/m16` 都是把結果放進 DX:AX，語意直接接得上——後面的
// 32-bit `add/adc` 一個字都不用改，這是這個掛鉤點最漂亮的地方。
//
// 跳板插在段 0xCC5 的尾端（原版座標 0x1C6A0），跟掛鉤點同段，全部 near 跳轉。
//
// 總資產的算式（拿執行中的記憶體驗證過，見 docs/runexe-re.md）：
//   金錢區塊 = u32[欄位][6玩家]，base 由 DS:0x11F0 的資源記錄取得
//     欄位 0      現金
//     欄位 1      存款
//     欄位 20+N   第 N 支股票的持股張數（N = 1~8）
//     欄位 40+N   第 N 支股票的股價 × 1000
//   股票市值 ≈ 張數 × (股價×1000 ÷ 1000)　← 先除再乘，誤差 <1%，門檻判斷夠用
import { imageOffset, toOriginal, type ExeImage } from './exe';
import { insertBlock, segmentEnds, assertPadded } from './codecave';

const HOOK_SITE = 0x12695;          // mov ax,es:[bx] + cdq，共 4 bytes
const HOOK_NEXT = 0x12699;          // 回去做 32-bit 累加
const ORIGINAL = [0x26, 0x8b, 0x07, 0x99];

const PLAYER_COUNT = 0x1058;        // 這一局有幾個玩家
const MONEY_REC = 0x11f0;           // 金錢區塊的資源記錄（+2 段、+0xA offset）
const FIELD = 24;                   // 一個欄位 = 6 玩家 × 4 bytes
const STOCK_N = 8;

const CAVE_PARAS = 16;              // 256 bytes（變數區在 0xE0，12 段落只有 0xC0 會被靜靜截斷）
const VAR = { idx: 0xe0, thr: 0xe2, cap: 0xe4, tlo: 0xe6, thi: 0xe8 };

export interface PriceIndexOptions {
    /**
     * 診斷用：直接把指數寫死成這個值，**完全不算資產**（跳板裡不會有 CALC）。
     * 用來把「乘法掛鉤點」跟「資產計算」兩個變因切開——如果寫死版行為正常，
     * 那掛鉤點就是安全的，問題在計算那一段。
     */
    fixedIndex?: number;
    /** 門檻，單位是「千元」。總資產每超過一個門檻，指數 +1。0 = 關閉這個功能 */
    thresholdK: number;
    /** 指數上限，0 = 無上限 */
    cap: number;
}

/**
 * @param caveAt   跳板在**映像**裡的實際位置（算 near 位移用）
 * @param segBase  跳板所在那個段的**映像**基底（算 cs:[變數] 的段內 offset 用）
 * @param nextAt   掛鉤點下一條指令的實際位置（跳回去用）
 *
 * ⚠ 映像 offset ≠ 段內 offset。第一塊跳板在段 0 所以兩者剛好相等，這塊在段 0xCC5，
 *   相差一個段基底——`cs:[...]` 這種絕對定址一定要用段內 offset，不然會讀到別的地方。
 *   相對跳轉不受影響（差值在兩種座標下相同）。
 */
function buildCave(caveAt: number, segBase: number, nextAt: number, opt: PriceIndexOptions): Uint8Array {
    const base = caveAt;
    const c = new Uint8Array(CAVE_PARAS * 16).fill(0x90);
    const cur = { p: 0 };
    const emit = (...b: number[]) => { for (const x of b) c[cur.p++] = x; };
    const w = (v: number) => { c[cur.p++] = v & 0xff; c[cur.p++] = (v >> 8) & 0xff; };
    const rel16 = (t: number) => w((t - (base + cur.p + 2)) & 0xffff);
    const V = (k: keyof typeof VAR) => base + VAR[k] - segBase;   // 段內 offset
    const fix: { at: number; to: () => number }[] = [];
    const rel8fwd = (label: () => number) => { const at = cur.p; emit(0); fix.push({ at, to: label }); };

    // ── 進入點：0x12695 跳進來，ES:BX 指著價格表的過路費
    emit(0x26, 0x8b, 0x07);                         // mov ax, es:[bx]
    let callCalc = -1;
    if (!opt.fixedIndex) {
        emit(0x50);                                 // push ax      保住過路費
        callCalc = cur.p; emit(0xe8, 0, 0);         // call CALC
        emit(0x58);                                 // pop ax
    }
    emit(0x2e, 0xf7, 0x2e); w(V('idx'));            // imul word cs:[IDX]   → DX:AX
    emit(0xe9); rel16(nextAt);                      // jmp 回 0x12699（實際位置）
    if (opt.fixedIndex) {
        const c2 = c.slice(0, cur.p);
        const out = new Uint8Array(CAVE_PARAS * 16).fill(0x90);
        out.set(c2, 0);
        const wv2 = (off: number, v: number) => { out[off] = v & 0xff; out[off + 1] = (v >> 8) & 0xff; };
        wv2(VAR.idx, opt.fixedIndex); wv2(VAR.thr, 0); wv2(VAR.cap, 0);
        wv2(VAR.tlo, 0); wv2(VAR.thi, 0);
        return out;
    }

    // ── CALC：算總資產 → 指數 → 更新最高水位。只保證不動 BP/SP。
    const CALC = cur.p;
    c[callCalc + 1] = (CALC - (callCalc + 3)) & 0xff;
    c[callCalc + 2] = ((CALC - (callCalc + 3)) >> 8) & 0xff;
    emit(0x53, 0x51, 0x52, 0x56, 0x57, 0x06);       // push bx,cx,dx,si,di,es
    emit(0x33, 0xc0);                               // xor ax,ax
    emit(0x2e, 0xa3); w(V('tlo'));                  // mov cs:[TLO],ax
    emit(0x2e, 0xa3); w(V('thi'));                  // mov cs:[THI],ax
    emit(0x33, 0xf6);                               // xor si,si          si = 玩家索引

    const PLOOP = cur.p;
    emit(0x3b, 0x36); w(PLAYER_COUNT);              // cmp si,[0x1058]
    emit(0x7d); rel8fwd(() => PDONE);               // jge PDONE
    emit(0xbf); w(MONEY_REC);                       // mov di,0x11f0
    emit(0x8e, 0x45, 0x02);                         // mov es,[di+2]
    // ⚠ 基底是資源記錄的 **+0**（實測是 0），不是 +0xA。
    //   遊戲的慣用法寫成 `add bx,[si+0xa]`，但那個欄位實測是 65532 = -4，
    //   是給「陣列從 1 起算」用的修正值，不是基底。照抄慣用法會讓整個區塊往前偏 4 bytes，
    //   讀到的全是垃圾——實測總資產被算成 1800 萬（正確是 214 萬），指數變成 37。
    emit(0x8b, 0x5d, 0x00);                         // mov bx,[di]       金錢區塊基底
    emit(0x8b, 0xc6);                               // mov ax,si
    emit(0xd1, 0xe0); emit(0xd1, 0xe0);             // shl ax,1 ×2        ax = 玩家 × 4
    emit(0x03, 0xd8);                               // add bx,ax          → 欄位0[玩家]
    emit(0x26, 0x8b, 0x07);                         // mov ax,es:[bx]     現金 lo
    emit(0x26, 0x8b, 0x57, 0x02);                   // mov dx,es:[bx+2]   現金 hi
    const call1 = cur.p; emit(0xe8, 0, 0);          // call ADD32
    emit(0x26, 0x8b, 0x47, FIELD);                  // mov ax,es:[bx+24]  存款 lo
    emit(0x26, 0x8b, 0x57, FIELD + 2);              // mov dx,es:[bx+26]  存款 hi
    const call2 = cur.p; emit(0xe8, 0, 0);          // call ADD32

    // 股票：欄位 21~28 是張數，欄位 41~48 是股價×1000（相隔 20 欄 = 480 bytes）
    emit(0xbf); w(21 * FIELD);                      // mov di,504
    emit(0xb9); w(STOCK_N);                         // mov cx,8
    const SLOOP = cur.p;
    emit(0x26, 0x8b, 0x01);                         // mov ax,es:[bx+di]  張數（低 16 位就夠）
    emit(0x0b, 0xc0);                               // or ax,ax
    emit(0x74); rel8fwd(() => SNEXT);               // jz SNEXT           沒持股
    emit(0x56);                                     // push si
    emit(0x8b, 0xf0);                               // mov si,ax          si = 張數
    emit(0x26, 0x8b, 0x81); w(20 * FIELD);          // mov ax,es:[bx+di+480]  股價×1000 lo
    emit(0x26, 0x8b, 0x91); w(20 * FIELD + 2);      // mov dx,es:[bx+di+482]  hi
    emit(0x81, 0xfa); w(1000);                      // cmp dx,1000
    emit(0x73); rel8fwd(() => SPOP);                // jae SPOP           商會溢位 → 當 0
    emit(0x51);                                     // push cx
    emit(0xb9); w(1000);                            // mov cx,1000
    emit(0xf7, 0xf1);                               // div cx             ax = 股價
    emit(0x59);                                     // pop cx
    emit(0xf7, 0xe6);                               // mul si             dx:ax = 股價 × 張數
    emit(0x5e);                                     // pop si
    const call3 = cur.p; emit(0xe8, 0, 0);          // call ADD32
    emit(0xeb); rel8fwd(() => SNEXT);               // jmp SNEXT
    const SPOP = cur.p;
    emit(0x5e);                                     // pop si
    const SNEXT = cur.p;
    emit(0x83, 0xc7, FIELD);                        // add di,24          下一支股票
    emit(0xe2, (SLOOP - (cur.p + 2)) & 0xff);       // loop SLOOP
    emit(0x46);                                     // inc si             下一個玩家
    emit(0xe9); rel16(base + PLOOP);                // jmp PLOOP

    // ── 算指數
    const PDONE = cur.p;
    emit(0x2e, 0xa1); w(V('thi'));                  // mov ax,cs:[THI]
    emit(0x33, 0xd2);                               // xor dx,dx
    emit(0xb9); w(1000);                            // mov cx,1000
    emit(0xf7, 0xf1);                               // div cx             高位商 → ax
    emit(0x8b, 0xd8);                               // mov bx,ax
    emit(0x2e, 0xa1); w(V('tlo'));                  // mov ax,cs:[TLO]
    emit(0xf7, 0xf1);                               // div cx             ax = 總資產(千元)
    emit(0x0b, 0xdb);                               // or bx,bx
    emit(0x75); rel8fwd(() => DONE);                // jnz DONE           太大就不動（保守）
    emit(0x2e, 0x8b, 0x0e); w(V('thr'));            // mov cx,cs:[THR]
    emit(0x0b, 0xc9);                               // or cx,cx
    emit(0x74); rel8fwd(() => DONE);                // jz DONE            門檻 0 = 關閉
    emit(0x33, 0xd2);                               // xor dx,dx
    emit(0xf7, 0xf1);                               // div cx
    emit(0x40);                                     // inc ax             指數 = 1 + 商
    emit(0x2e, 0x8b, 0x0e); w(V('cap'));            // mov cx,cs:[CAP]
    emit(0x0b, 0xc9);                               // or cx,cx
    emit(0x74); rel8fwd(() => NOCAP);               // jz NOCAP           上限 0 = 無上限
    emit(0x3b, 0xc1);                               // cmp ax,cx
    emit(0x76); rel8fwd(() => NOCAP);               // jbe NOCAP
    emit(0x8b, 0xc1);                               // mov ax,cx
    const NOCAP = cur.p;
    emit(0x2e, 0x3b, 0x06); w(V('idx'));            // cmp ax,cs:[IDX]
    emit(0x76); rel8fwd(() => DONE);                // jbe DONE           只漲不落
    emit(0x2e, 0xa3); w(V('idx'));                  // mov cs:[IDX],ax
    const DONE = cur.p;
    emit(0x07, 0x5f, 0x5e, 0x5a, 0x59, 0x5b);       // pop es,di,si,dx,cx,bx
    emit(0xc3);                                     // ret

    // ── ADD32：total += DX:AX
    const ADD32 = cur.p;
    for (const at of [call1, call2, call3]) {
        const r = (ADD32 - (at + 3)) & 0xffff;
        c[at + 1] = r & 0xff; c[at + 2] = (r >> 8) & 0xff;
    }
    emit(0x2e, 0x01, 0x06); w(V('tlo'));            // add cs:[TLO],ax
    emit(0x2e, 0x11, 0x16); w(V('thi'));            // adc cs:[THI],dx
    emit(0xc3);                                     // ret

    if (cur.p > VAR.idx) throw new Error(`跳板程式碼壓到變數了：0x${cur.p.toString(16)}`);
    if (VAR.thi + 2 > CAVE_PARAS * 16) throw new Error('變數區放不進跳板');
    for (const f of fix) {
        const d = f.to() - (f.at + 1);
        if (d < -128 || d > 127) throw new Error(`rel8 超出範圍：${d}`);
        c[f.at] = d & 0xff;
    }
    const wv = (off: number, v: number) => { c[off] = v & 0xff; c[off + 1] = (v >> 8) & 0xff; };
    wv(VAR.idx, 1);                                 // 指數起始 = 1（還沒算之前不改變過路費）
    wv(VAR.thr, opt.thresholdK);
    wv(VAR.cap, opt.cap);
    wv(VAR.tlo, 0); wv(VAR.thi, 0);
    return c;
}

/** 這份設定等於「不啟用」嗎（門檻 0 就不用插碼）。 */
export function isPriceIndexOff(opt: PriceIndexOptions): boolean {
    return !opt.thresholdK && !opt.fixedIndex;
}

/**
 * 插入物價指數的跳板。要在 insertPassThrough **之後**呼叫——它插在更後面的段界，
 * 兩塊的位移會疊加，順序反了 imageOffset 的記錄就對不上。
 */
export function insertPriceIndex(x: ExeImage, opt: PriceIndexOptions): void {
    const at = imageOffset(x, HOOK_SITE);
    for (let i = 0; i < ORIGINAL.length; i++) {
        if (x.image[at + i] !== ORIGINAL[i]) {
            throw new Error(`映像 0x${HOOK_SITE.toString(16)} 不是原版的 mov/cdq——認不得這份 Run.exe`);
        }
    }
    // 段 0xCC5 的尾端。segmentEnds 讀的是**現況**（第一塊跳板已經把它往上推了），
    // 所以要換算回原版座標才能餵給 insertBlock。
    const paraOriginal = toOriginal(x, segmentEnds(x)[1] * 16) / 16;
    assertPadded(x, paraOriginal);
    const caveAt = imageOffset(x, paraOriginal * 16);     // 跳板實際會落在哪
    const segBase = segmentEnds(x)[0] * 16;               // 段 0xCC5 的現行基底
    insertBlock(x, paraOriginal, buildCave(caveAt, segBase, imageOffset(x, HOOK_NEXT), opt));

    // 掛鉤點在插入點之前，所以它的位置不受這次插入影響；但可能已經被第一塊位移過。
    x.image[at] = 0xe9;
    const r = (caveAt - (at + 3)) & 0xffff;
    x.image[at + 1] = r & 0xff; x.image[at + 2] = (r >> 8) & 0xff;
    x.image[at + 3] = 0x90;
}
