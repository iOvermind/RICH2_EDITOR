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
// 指數的依據是**現金 + 存款 + 股票市值**，不含地產——地產只佔總資產 1~2%，
// 卻要掃 283 個地點，佔掉跳板 85% 的執行成本，划不來。
// （地產的算法一度實作並驗證過，四家數字與遊戲「財產查詢」完全相同，
//   需要時可從 docs/runexe-re.md §12 復原。）
//
// 金錢區塊 = u32[欄位][6玩家]，base 由 DS:0x11F0 的資源記錄取得：
//     欄位 0      現金
//     欄位 1      存款
//     欄位 19+N   第 N 支股票的持股張數（N = 1~20 → 欄位 20~39）
//     欄位 39+N   第 N 支股票的買入價 × 1000（欄位 40~59，固定比持股欄位大 20）
//   ⚠ 股票總共 20 支，不是 8 支。用兩根樁釘死：同一份快照裡買第 1 支 80 張落在
//     欄位 20、買第 20 支 118 張落在欄位 39，中間 20 格一支一格。
//     舊版寫 8 支只掃到欄位 27，第 9 支以後的持股全被跳過——這就是「股票沒算到」。
//   ⚠ 欄位 39+N 是**各玩家的買入價**，不是現價，跳板沒有用它。證據：同一支股票
//     （欄位 33）玩家 2 存 104982、玩家 3 存 95683，市價不可能有兩個值。
//   現價是另一塊：**float32[20]，資源記錄在 DS:0x1446**（見下方 STOCK_PRICE_REC）。
//   所以股票市值是精確的：Σ_k (Σ_玩家 張數[k]) × 現價[k]，與遊戲股市畫面完全相同。
import { imageOffset, toOriginal, type ExeImage } from './exe';
import { insertBlock, segmentEnds, assertPadded } from './codecave';

const HOOK_SITE = 0x12695;          // mov ax,es:[bx] + cdq，共 4 bytes
const HOOK_NEXT = 0x12699;          // 回去做 32-bit 累加
const ORIGINAL = [0x26, 0x8b, 0x07, 0x99];

const PLAYER_COUNT = 0x1058;        // 這一局有幾個玩家
const MONEY_REC = 0x11f0;           // 金錢區塊的資源記錄（+2 段、+0xA offset）
const FIELD = 24;                   // 一個欄位 = 6 玩家 × 4 bytes
const STOCK_N = 20;                 // 20 支，欄位 20~39（實測釘死，見檔頭）


// 股票現價：float32[20]，資源記錄在 DS:0x1446。2026-08-07 找到。
// 先前找不到是因為一直假設它是定點整數——×1/×10/×100/×1000、各種定點、BCD、
// 整數與小數拆開、stride 2~800 的比值掃描全都零命中，浮點數的位元組樣式跟這些都不像。
// 驗證：三份 dump 的 #1 依序 64.82 / 70.88 / 73.18，與遊戲畫面同步；
// 且 818×#8 = 64152.81 → 64153、382×#6+900×#8 = 109205.09 → 109205，與財產查詢完全相同。
// ⚠ 遊戲的市值是**四捨五入**（FPU 預設的 round-to-nearest 剛好一致），但價格顯示是捨去。
const STOCK_PRICE_REC = 0x1446;

// 跳板掛在「讀過路費」上，AI 估值會在迴圈裡讓它被呼叫幾百次。拿掉地產之後
// 一次只剩 4 個玩家 + 20 檔股票的小迴圈，成本可以忽略，不需要快取或節流。

const CAVE_PARAS = 28;              // 448 bytes。程式碼 289 bytes，變數區在 0x180，餘裕 95。
const VAR = {
    idx: 0x180,
    thr: 0x182,                     // 4 bytes：門檻（元）。u16 裝不下 50 萬這種常用值。
    cap: 0x186,
    tlo: 0x188, thi: 0x18a,         // ⚠ 必須相鄰：fild dword cs:[TLO] 當成一個 32 位元讀
    half: 0x18c,                    // 4 bytes：float 0.5，把 FPU 的四捨五入變成無條件捨去
    tmp2: 0x190,                    // 4 bytes：張數總計（給 fimul m32int，高位永遠 0）
    tmp3: 0x194,                    // 4 bytes：fistp 存回來的市值
    mseg: 0x198, pseg: 0x19a,       // 金錢區塊、股價陣列的段
};

export interface PriceIndexOptions {
    /**
     * 允許指數回落：資產總值變少時指數也跟著降。預設（false）是「只漲不落」——
     * 指數只會停在歷史最高點，這也是這個功能原本的設計意圖（加速收斂）。
     * 診斷時打開它，倍率就會直接反映當下算出來的值。
     */
    noHighWater?: boolean;
    /**
     * 診斷用：直接把指數寫死成這個值，**完全不算資產**（跳板裡不會有 CALC）。
     * 用來把「乘法掛鉤點」跟「資產計算」兩個變因切開——如果寫死版行為正常，
     * 那掛鉤點就是安全的，問題在計算那一段。
     */
    fixedIndex?: number;
    /** 門檻，單位是**元**（32 位元，所以放得下 50 萬這種值）。總資產每超過一個門檻，指數 +1。0 = 關閉 */
    threshold: number;
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
        wv2(VAR.idx, opt.fixedIndex); wv2(VAR.thr, 0); wv2(VAR.thr + 2, 0); wv2(VAR.cap, 0);
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

    // ── 現金與存款：直接讀欄位 0 與 1，逐個玩家累加
    emit(0x33, 0xf6);                               // xor si,si          si = 玩家索引
    const PLOOP = cur.p;
    emit(0x3b, 0x36); w(PLAYER_COUNT);              // cmp si,[0x1058]
    emit(0x7d); rel8fwd(() => PDONE);               // jge PDONE
    emit(0xbf); w(MONEY_REC);                       // mov di,0x11f0
    emit(0x8e, 0x45, 0x02);                         // mov es,[di+2]
    // ⚠ 基底是資源記錄的 **+0**（實測是 0），不是 +0xA。
    //   遊戲的慣用法寫成 `add bx,[si+0xa]`，但那個欄位實測是 65532 = -4，
    //   是給「陣列從 1 起算」用的修正值，不是基底。照抄慣用法會讓整個區塊往前偏 4 bytes，
    //   讀到的全是垃圾——實測總額被算成 1800 萬（正確是 214 萬），指數變成 37。
    emit(0x8b, 0x5d, 0x00);                         // mov bx,[di]        金錢區塊基底
    emit(0x8b, 0xc6);                               // mov ax,si
    emit(0xd1, 0xe0); emit(0xd1, 0xe0);             // shl ax,1 ×2        ax = 玩家 × 4
    emit(0x03, 0xd8);                               // add bx,ax          → 欄位0[玩家]
    emit(0x26, 0x8b, 0x07);                         // mov ax,es:[bx]     現金 lo
    emit(0x26, 0x8b, 0x57, 0x02);                   // mov dx,es:[bx+2]   現金 hi
    const call1 = cur.p; emit(0xe8, 0, 0);          // call ADD32
    emit(0x26, 0x8b, 0x47, FIELD);                  // mov ax,es:[bx+24]  存款 lo
    emit(0x26, 0x8b, 0x57, FIELD + 2);              // mov dx,es:[bx+26]  存款 hi
    const call2 = cur.p; emit(0xe8, 0, 0);          // call ADD32
    emit(0x46);                                     // inc si             下一個玩家
    emit(0xe9); rel16(base + PLOOP);                // jmp PLOOP
    const PDONE = cur.p;

    // ── 股票：Σ_k (Σ_玩家 張數[k]) × 現價[k]。現價是 float32，用 FPU 乘。
    //    每檔只算一次乘法（先把六個玩家槽的張數加起來），順便把段切換降到每檔一次。
    //    fld/fimul/fistp 對 FPU 堆疊是進一出一，不會留下殘留。
    let call3 = -1;
    {
        emit(0xbf); w(MONEY_REC);                   // mov di,0x11f0
        emit(0x8b, 0x45, 0x02);                     // mov ax,[di+2]
        emit(0x2e, 0xa3); w(V('mseg'));             // mov cs:[MSEG],ax
        emit(0x8b, 0x1d);                           // mov bx,[di]        金錢區塊基底
        emit(0xbf); w(STOCK_PRICE_REC);             // mov di,0x1446
        emit(0x8b, 0x45, 0x02);                     // mov ax,[di+2]
        emit(0x2e, 0xa3); w(V('pseg'));             // mov cs:[PSEG],ax
        emit(0x8b, 0x35);                           // mov si,[di]        float 陣列基底
        emit(0x2e, 0xc7, 0x06); w(V('tmp2') + 2); w(0);  // mov word cs:[TMP2+2],0  給 fimul m32int 用
        emit(0x8b, 0xfb);                           // mov di,bx
        emit(0x81, 0xc7); w(20 * FIELD);            // add di,480         欄位20
        emit(0xb9); w(STOCK_N);                     // mov cx,20
        const SLOOP = cur.p;
        emit(0x2e, 0x8e, 0x06); w(V('mseg'));       // mov es,cs:[MSEG]
        emit(0x26, 0x8b, 0x05);                     // mov ax,es:[di]     玩家0 張數（低 16 位就夠）
        for (let p = 1; p < 6; p++) emit(0x26, 0x03, 0x45, p * 4);  // add ax,es:[di+4p]
        emit(0x0b, 0xc0);                           // or ax,ax
        emit(0x74); rel8fwd(() => SNEXT);           // jz SNEXT           全場都沒人持有
        emit(0x2e, 0xa3); w(V('tmp2'));             // mov cs:[TMP2],ax   張數總計
        emit(0x2e, 0x8e, 0x06); w(V('pseg'));       // mov es,cs:[PSEG]
        emit(0x26, 0xd9, 0x04);                     // fld dword es:[si]      現價
        emit(0x2e, 0xda, 0x0e); w(V('tmp2'));       // fimul dword cs:[TMP2]  × 張數
        emit(0x2e, 0xdb, 0x1e); w(V('tmp3'));       // fistp dword cs:[TMP3]  四捨五入存回
        emit(0x9b);                                 // fwait
        emit(0x2e, 0xa1); w(V('tmp3'));             // mov ax,cs:[TMP3]
        emit(0x2e, 0x8b, 0x16); w(V('tmp3') + 2);   // mov dx,cs:[TMP3+2]
        call3 = cur.p; emit(0xe8, 0, 0);            // call ADD32
        var SNEXT = cur.p;                          // eslint-disable-line no-var
        emit(0x83, 0xc7, FIELD);                    // add di,24          下一檔的張數欄位
        emit(0x83, 0xc6, 0x04);                     // add si,4           下一檔的 float
        const backS = SLOOP - (cur.p + 2);
        if (backS < -128) throw new Error(`股票迴圈太長，loop 的 rel8 放不下：${backS}`);
        emit(0xe2, backS & 0xff);                   // loop SLOOP
    }

    // ── 算指數
    // 門檻的單位是**元**，所以直接拿 32 位元的總資產除門檻，不再先除 1000。
    // 兩段式除法：先除高位、餘數留在 dx 帶進第二次，這樣不會有除法溢位
    //（第一次 dx=0 故商必 ≤65535；第二次 dx<cx 故商也必 ≤65535）。
    // 門檻的單位是**元**，而 50 萬這種常用值放不進 u16，所以門檻是 32 位元。
    // 32÷32 的整數除法在 16 位元組語裡很囉唆，改用 FPU（股票那段本來就要用它）：
    //   指數 = 1 + floor(總資產 ÷ 門檻)
    // fistp 是四捨五入，先減 0.5 就等於無條件捨去（正數區間內）。
    emit(0x2e, 0xa1); w(V('thr'));                  // mov ax,cs:[THR]
    emit(0x2e, 0x0b, 0x06); w(V('thr') + 2);        // or ax,cs:[THR+2]
    emit(0x74); rel8fwd(() => DONE);                // jz DONE            門檻 0 = 關閉
    emit(0x2e, 0xdb, 0x06); w(V('tlo'));            // fild dword cs:[TLO]    總資產
    emit(0x2e, 0xda, 0x36); w(V('thr'));            // fidiv dword cs:[THR]   ÷ 門檻
    emit(0x2e, 0xd8, 0x26); w(V('half'));           // fsub dword cs:[HALF]   −0.5 → 捨去
    emit(0x2e, 0xdb, 0x1e); w(V('tmp3'));           // fistp dword cs:[TMP3]
    emit(0x9b);                                     // fwait
    emit(0x2e, 0xa1); w(V('tmp3'));                 // mov ax,cs:[TMP3]
    emit(0x2e, 0x8b, 0x16); w(V('tmp3') + 2);       // mov dx,cs:[TMP3+2]
    emit(0x0b, 0xd2);                               // or dx,dx
    emit(0x75); rel8fwd(() => DONE);                // jnz DONE           商超過 16 位元或為負，保守不動
    emit(0x40);                                     // inc ax             指數 = 1 + 商
    emit(0x74); rel8fwd(() => DONE);                // jz DONE            剛好繞回 0，別讓過路費歸零
    emit(0x2e, 0x8b, 0x0e); w(V('cap'));            // mov cx,cs:[CAP]
    emit(0x0b, 0xc9);                               // or cx,cx
    emit(0x74); rel8fwd(() => NOCAP);               // jz NOCAP           上限 0 = 無上限
    emit(0x3b, 0xc1);                               // cmp ax,cx
    emit(0x76); rel8fwd(() => NOCAP);               // jbe NOCAP
    emit(0x8b, 0xc1);                               // mov ax,cx
    const NOCAP = cur.p;
    if (!opt.noHighWater) {
        emit(0x2e, 0x3b, 0x06); w(V('idx'));        // cmp ax,cs:[IDX]
        emit(0x76); rel8fwd(() => DONE);            // jbe DONE           只漲不落
    }
    emit(0x2e, 0xa3); w(V('idx'));                  // mov cs:[IDX],ax
    const DONE = cur.p;
    emit(0x07, 0x5f, 0x5e, 0x5a, 0x59, 0x5b);       // pop es,di,si,dx,cx,bx
    emit(0xc3);                                     // ret

    // ── ADD32：total += DX:AX
    const ADD32 = cur.p;
    for (const at of [call1, call2, call3].filter((v) => v >= 0)) {
        const r = (ADD32 - (at + 3)) & 0xffff;
        c[at + 1] = r & 0xff; c[at + 2] = (r >> 8) & 0xff;
    }
    emit(0x2e, 0x01, 0x06); w(V('tlo'));            // add cs:[TLO],ax
    emit(0x2e, 0x11, 0x16); w(V('thi'));            // adc cs:[THI],dx
    emit(0xc3);                                     // ret

    if (cur.p > VAR.idx) throw new Error(`跳板程式碼壓到變數了：0x${cur.p.toString(16)}`);
    if (Math.max(...Object.values(VAR)) + 4 > CAVE_PARAS * 16) throw new Error('變數區放不進跳板');
    for (const f of fix) {
        const d = f.to() - (f.at + 1);
        if (d < -128 || d > 127) throw new Error(`rel8 超出範圍：${d}`);
        c[f.at] = d & 0xff;
    }
    const wv = (off: number, v: number) => { c[off] = v & 0xff; c[off + 1] = (v >> 8) & 0xff; };
    const wv32 = (off: number, v: number) => { wv(off, v & 0xffff); wv(off + 2, (v >>> 16) & 0xffff); };
    wv(VAR.idx, 1);                                 // 指數起始 = 1（還沒算之前不改變過路費）
    wv32(VAR.thr, opt.threshold);
    wv(VAR.cap, opt.cap);
    wv(VAR.tlo, 0); wv(VAR.thi, 0);
    new DataView(c.buffer).setFloat32(VAR.half, 0.5, true);   // FPU 的捨去用常數
    return c;
}

/**
 * 讀回 Run.exe 目前的物價指數設定，用來把 UI 反白成現況。沒插碼就回 null。
 *
 * ⚠ 掛鉤點在段 0xCC5，但 near jmp 的位移是**段內**的，所以要用段內座標推算跳板，
 *   再換回映像座標才能讀變數——跟 readPassTable 不同，那塊在段 0 兩者剛好相等。
 */
export function readPriceIndexSettings(x: ExeImage): { threshold: number; cap: number; noHighWater: boolean } | null {
    // ⚠ 不能用 imageOffset 找掛鉤點：重新載入的映像沒有插入紀錄，imageOffset 是恆等式，
    //   但「經過就觸發」插在段 0 尾端、位置在掛鉤點**之前**，會把它往後推。
    //   改用特徵碼：near jmp + nop，後面接原本那兩條 32-bit 累加。
    const img = x.image;
    const SIG = [0x90, 0x03, 0x46, 0xe8, 0x13, 0x56, 0xea];
    let at = -1;
    for (let i = 0; i + 3 + SIG.length <= img.length; i++) {
        if (img[i] !== 0xe9) continue;
        let ok = true;
        for (let k = 0; k < SIG.length; k++) if (img[i + 3 + k] !== SIG[k]) { ok = false; break; }
        if (ok) { at = i; break; }
    }
    if (at < 0) return null;

    // ⚠ near jmp 的位移是**段內**的，會繞回；當成有號數直接加會算到別的地方去。
    //   先換成段內座標、加完取 16 位元，再換回映像座標。
    const segBase = segmentEnds(x)[0] * 16;
    const rel = img[at + 1] | (img[at + 2] << 8);
    const cave = segBase + ((at + 3 - segBase + rel) & 0xffff);
    if (cave < 0 || cave + VAR.cap + 2 > img.length) return null;
    const rd = (o: number) => img[cave + o] | (img[cave + o + 1] << 8);
    // 「只漲不落」是靠 cmp ax,cs:[IDX] + jbe 實作的；那兩條不在就代表允許回落。
    const HW = [0x2e, 0x3b, 0x06];
    let highWater = false;
    for (let i = cave; i < cave + VAR.idx - HW.length; i++) {
        if (img[i] === HW[0] && img[i + 1] === HW[1] && img[i + 2] === HW[2]) { highWater = true; break; }
    }
    return { threshold: rd(VAR.thr) | (rd(VAR.thr + 2) << 16), cap: rd(VAR.cap), noHighWater: !highWater };
}

/** 這份設定等於「不啟用」嗎（門檻 0 就不用插碼）。 */
export function isPriceIndexOff(opt: PriceIndexOptions): boolean {
    return !opt.threshold && !opt.fixedIndex;
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
