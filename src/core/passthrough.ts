// 「經過就觸發」：讓指定種類的特殊地點在被經過時停下、觸發完整功能、再走完剩下的步數。
//
// 原版只有一條寫死的 `cmp word ptr es:[bx], 1`（1 = 銀行）在映像 0x1A5F，成立就走
// 0x1A68 —— 那是**銀行專屬**的過路處理。真正的分派器是 0x340E，但**在移動途中呼叫它
// 一定花屏而且不等輸入**（抄「踩上去」的完整前置也一樣），它只在移動已結束的狀態下正常。
//
// 所以這裡照抄遊戲自己的手法：把已走步數 [0x1C6] 推到總步數逼停（地點欄位 UNK13 = 1/3
// 的地雷與路障用的就是這招），讓遊戲照常跑落地處理，再把剩下的步數接回去。
//
// 四個掛鉤點，都是把原指令換成一條等長的 near jmp：
//
//   A 0x1A5F  是特殊地點、表值=1、且不是最後一格
//               → 記下剩餘步數 [0x1a6]-[0x1c6]，[0x1c6]=999 逼停
//   C 0x0CFE / 0x1C0F / 0x1D2E  還有步數要走 → 跳過 `lcall 0cc5:7d97`（畫靜止角色圖）
//   B 0x29FF  還有步數要走 → jmp 0x175F（回到完整的移動前置）
//   D 0x17B6  還有步數要走 → 剩餘步數當骰子填進 [0x1a0]，jmp 0x1831 開走
//
// C 有**三個**站點是關鍵：只擋 0x1C0F 一個的話，停下的那一格會留下一個角色殘影。
//
// ⚠ 跳板插在**程式碼段(段 0)尾端的段界 0x0CC50**（段 0 的程式碼到 0x0CC40 的 `ret`
//   為止，之後是補 0）。不要接在映像尾端再把 SS 往上挪——那塊記憶體遊戲在用，
//   實測走一步就死頓。插在段界的代價是後面每個段都往上移，所以重定位項的位址、
//   它存的段值、檔頭的 CS/SS 都要跟著改；換來的是跳板與被改的程式碼同段，全部 near 跳轉。
//
// 詳細筆記見 docs/runexe-re.md §11。
import { writeInsertList, imageOffset, type ExeImage } from './exe';
import { insertBlock, segmentEnds, assertPadded } from './codecave';

const HOOK = {
    /** 原本的 cmp word ptr es:[bx],1 */
    check: 0x1a5f,
    /** 落地處理的匯流點。要在 0x29FA 那個 70 幀等待迴圈**之後**，不然視窗還在螢幕上就跳走 → 花屏 */
    resume: 0x29ff,
    /** 擲骰的第一步 mov [0x19c],2 */
    dice: 0x17b6,
} as const;

/**
 * `lcall 0cc5:7d97` 的三個呼叫點。它不只是畫圖——**同時登記玩家位置**給後續繪圖用，
 * 所以擋的區間不能一視同仁：
 *
 *   wide  = 整個「還有步數要走」的區間都擋（看 PENDING）
 *   窄    = 只在「handler 跑完 → 動畫開始」那一小段擋（看 SUPPRESS）
 *
 * `0x1C0F` 是移動結束抵達時畫的，就是殘影本體，要整段擋。
 * `0x0CFE` 是「從全螢幕場景回到地圖畫面」的重建（狀態面板→畫角色→鏡頭重畫地圖），
 * 特殊地點 handler 執行期間要靠它——擋掉的話賭場回來角色不見、遊樂場錢幣全掉在最左邊。
 * `0x1D2E` 在坐牢／住院路徑，性質同抵達。
 */
const DRAW_SITES = [
    { site: 0x0cfe, draw: 0x0d01, skip: 0x0d06, wide: false },
    { site: 0x1c0f, draw: 0x1c12, skip: 0x1c17, wide: true },
    { site: 0x1d2e, draw: 0x1d31, skip: 0x1d36, wide: true },
];

const RET_SKIP = 0x1ad1;      // 不觸發的匯流點
const RET_BANK = 0x1a68;      // 銀行專屬的過路處理
const PRE_MOVE = 0x175f;      // 移動前置：重畫其他玩家 → 鏡頭 → 擲骰 → 開走
const MOVE_START = 0x1831;    // 發動一次移動：讀 [0x1a0] 當步數
const DICE_NEXT = 0x17bc;
const RESUME_NEXT = 0x2a02;

const SPECIAL_MAX = 0x1098;   // 這張圖的特殊地點數；locId <= 它才是特殊地點
const CUR_LOC = 0x1ae;        // 目前地點編號
const STEP_DONE = 0x1c6;      // 走到第幾格（1 起算）
const STEP_TOTAL = 0x1a6;     // 這一次移動的總步數
const STEP_INPUT = 0x1a0;     // 下一次移動要走幾格

/** 分派器的 case 數。跳轉表在 0x3418，**第一項是 default**，case N 從 0x341A 起算。 */
export const TABLE_LEN = 40;
/** 表值：0=不觸發、1=停下觸發再續走、2=走原本銀行那條過路處理 */
export type PassAction = 0 | 1 | 2;

const ORIGINAL: Record<number, number[]> = {
    [HOOK.check]: [0x26, 0x83, 0x3f, 0x01, 0x74, 0x03, 0xe9, 0x69, 0x00],
    [HOOK.resume]: [0x68, 0xf8, 0x10],                      // push 0x10f8
    [HOOK.dice]: [0xc7, 0x06, 0x9c, 0x01, 0x02, 0x00],      // mov [0x19c],2
    ...Object.fromEntries(DRAW_SITES.map((d) => [d.site, [0x68, 0xf8, 0x10]])),
};

// 跳板裡各段的起點。都寫死成常數，不要用「上一段 - 0x20」那種相對寫法——
// 改任何一段的長度都會靜靜咬到隔壁，而且症狀是編譯期才炸（有斷言擋著算幸運）。
const DICE_HOOK_OFF = 0xa0;   // D 段（擲骰），約 33 bytes
const DRAW_HOOK_OFF = 0xe0;   // C 段三個站點，每個 0x14 → 到 0x11C，剛好接上 PENDING
const PENDING_OFF = 0x120;    // 「還沒走幾步」
// 「現在別畫靜止角色圖」。**不能**直接用 PENDING 當條件——那樣從攔停到續走整段都被擋，
// 包含特殊地點 handler 執行的期間，而 0cc5:7d97 不只是畫圖，它同時登記了玩家位置：
// 擋掉的話賭場回來角色不見、遊樂場的錢幣會全部掉在最左邊（拿不到座標）。
// 所以只在「handler 已經跑完（0x29FF）」到「動畫開始（0x1831）」之間擋。
const SUPPRESS_OFF = 0x122;
const TABLE_OFF = 0x130;
const CAVE_PARAS = 24;        // 384 bytes（TABLE_OFF 0x130 + 40 項 = 0x158，20 段落只有 0x140 會溢位）

/** 原版行為：只有銀行(1)經過會跑它專屬的過路處理。 */
export function defaultTable(): PassAction[] {
    const t = new Array(TABLE_LEN).fill(0) as PassAction[];
    t[1] = 2;
    return t;
}

interface Cave { cave: Uint8Array; resume: number; dice: number; draws: number[] }

function buildCave(base: number, table: PassAction[]): Cave {
    const c = new Uint8Array(CAVE_PARAS * 16).fill(0x90);
    // 寫入游標包在物件裡：直接用 `let p = 0` 的話 TS 會把它窄化成字面值型別，
    // 下面那些「長度算對了沒」的斷言會被判成恆假而編不過。
    const cur = { p: 0 };
    const emit = (...b: number[]) => { for (const x of b) c[cur.p++] = x; };
    const w = (v: number) => { c[cur.p++] = v & 0xff; c[cur.p++] = (v >> 8) & 0xff; };
    const rel = (target: number) => w((target - (base + cur.p + 2)) & 0xffff);
    const PENDING = base + PENDING_OFF;
    const SUPPRESS = base + SUPPRESS_OFF;

    // ── A：每走一格都會經過這裡，ES:BX 已經指著這格的 SPECIAL 欄位。
    // 先照引擎自己的判準確認「這格是特殊地點」——一般土地的 SPECIAL 也是 0，
    // 光看欄位值分不出公園(0)跟土地(0)。
    // 標成 number：不然 TS 會從上面的斷言把 cur.p 窄化成字面值，下一個斷言就被判成恆假
    const SKIP: number = 0x22, BANK: number = 0x25, STOP: number = 0x28;
    emit(0xa1); w(SPECIAL_MAX);                    // +00 mov ax,[0x1098]
    emit(0x3b, 0x06); w(CUR_LOC);                  // +03 cmp ax,[0x1ae]
    emit(0x7c, SKIP - (cur.p + 2));                    // +07 jl SKIP
    emit(0x26, 0x8b, 0x07);                        // +09 mov ax,es:[bx]
    emit(0x3d); w(TABLE_LEN);                      // +0c cmp ax,40
    emit(0x73, SKIP - (cur.p + 2));                    // +0f jae SKIP
    emit(0x8b, 0xd8);                              // +11 mov bx,ax
    emit(0x2e, 0x8a, 0x9f); w(base + TABLE_OFF);   // +13 mov bl,cs:[bx+TABLE]
    emit(0x80, 0xfb, 0x02);                        // +18 cmp bl,2
    emit(0x74, BANK - (cur.p + 2));                    // +1b je BANK
    emit(0x80, 0xfb, 0x01);                        // +1d cmp bl,1
    emit(0x74, STOP - (cur.p + 2));                    // +20 je STOP
    if (cur.p !== SKIP) throw new Error(`A 段長度算錯：0x${cur.p.toString(16)}`);
    emit(0xe9); rel(RET_SKIP);                     // +22 SKIP: jmp 0x1AD1
    emit(0xe9); rel(RET_BANK);                     // +25 BANK: jmp 0x1A68

    // 最後一格不攔——玩家本來就會停在那裡，交給原本的落地處理
    if (cur.p !== STOP) throw new Error(`出口位置算錯：0x${cur.p.toString(16)}`);
    emit(0xa1); w(STEP_DONE);                      // mov ax,[0x1c6]
    emit(0x3b, 0x06); w(STEP_TOTAL);               // cmp ax,[0x1a6]
    emit(0x7d, (SKIP - (cur.p + 2)) & 0xff);           // jge SKIP
    emit(0x8b, 0x1e); w(STEP_TOTAL);               // mov bx,[0x1a6]
    emit(0x2b, 0xd8);                              // sub bx,ax     還沒走的步數
    emit(0x2e, 0x89, 0x1e); w(PENDING);            // mov cs:[PENDING],bx
    // 逼迴圈結束：把「已走步數」設成總步數，迴圈尾的 inc 之後就 > 總步數。
    // ⚠ 不要學遊戲自己那招塞 999（UNK13=1/3 用的）——[0x1c6] 不是移動迴圈專用的，
    //   0x0BBD0 也在讀它（`[0x1c6]+110` 當訊息 id）。留 999 在那裡，接下來整個落地
    //   處理都會拿到異常值，實測股市的成本顯示與 NPC 可買股數都會錯亂。
    //   設成總步數的話，結束後的值跟正常走完一模一樣。
    emit(0xa1); w(STEP_TOTAL);                     // mov ax,[0x1a6]
    emit(0xa3); w(STEP_DONE);                      // mov [0x1c6],ax
    emit(0xe9); rel(RET_SKIP);                     // jmp 0x1AD1

    // ── B：落地處理跑完會到這裡。還有步數要走就回到完整的移動前置，PENDING 留給 D 用。
    const resume = cur.p;
    emit(0x2e, 0xa1); w(PENDING);                  // mov ax,cs:[PENDING]
    emit(0x0b, 0xc0);                              // or ax,ax
    const jeB = cur.p; emit(0x74, 0);
    emit(0xb8); w(1);                              // mov ax,1
    emit(0x2e, 0xa3); w(SUPPRESS);                 // mov cs:[SUPPRESS],ax   從這裡開始別畫
    emit(0xe9); rel(PRE_MOVE);                     // jmp 0x175F
    c[jeB + 1] = cur.p - (jeB + 2);
    emit(...ORIGINAL[HOOK.resume]);
    emit(0xe9); rel(RESUME_NEXT);
    if (cur.p > (DICE_HOOK_OFF as number)) throw new Error(`B 段壓到 D 段了：0x${cur.p.toString(16)}`);

    // ── D：擲骰。有待走的步數就用它取代骰子。
    cur.p = DICE_HOOK_OFF;
    const dice = cur.p;
    emit(0x2e, 0xa1); w(PENDING);                  // mov ax,cs:[PENDING]
    emit(0x0b, 0xc0);
    const jeD = cur.p; emit(0x74, 0);
    emit(0xa3); w(STEP_INPUT);                     // mov [0x1a0],ax
    emit(0x33, 0xc0);                              // xor ax,ax
    emit(0x2e, 0xa3); w(PENDING);                  // mov cs:[PENDING],ax
    emit(0x2e, 0xa3); w(SUPPRESS);                 // mov cs:[SUPPRESS],ax   動畫要開始了，解除
    emit(0xe9); rel(MOVE_START);                   // jmp 0x1831
    c[jeD + 1] = cur.p - (jeD + 2);
    emit(...ORIGINAL[HOOK.dice]);
    emit(0xe9); rel(DICE_NEXT);
    if (cur.p > (DRAW_HOOK_OFF as number)) throw new Error(`D 段壓到 C 段了：0x${cur.p.toString(16)}`);

    // ── C：三個「畫靜止角色圖」的站點，還要續走的話就都不畫
    const draws: number[] = [];
    DRAW_SITES.forEach((d, i) => {
        cur.p = DRAW_HOOK_OFF + i * 0x14;
        draws.push(cur.p);
        emit(0x2e, 0xa1); w(d.wide ? PENDING : SUPPRESS);
        emit(0x0b, 0xc0);
        const jne = cur.p; emit(0x75, 0);
        emit(...ORIGINAL[d.site]);
        emit(0xe9); rel(d.draw);                   // 照畫
        c[jne + 1] = cur.p - (jne + 2);
        emit(0xe9); rel(d.skip);                   // 跳過
        if (cur.p > (PENDING_OFF as number)) throw new Error(`C 段壓到 PENDING 了：0x${cur.p.toString(16)}`);
    });

    // ⚠ PENDING 一定要清 0：緩衝區是拿 0x90 填的，不清的話 B 段一開機就以為還有 0x9090 步要走
    c[PENDING_OFF] = 0; c[PENDING_OFF + 1] = 0;
    c[SUPPRESS_OFF] = 0; c[SUPPRESS_OFF + 1] = 0;
    for (let i = 0; i < TABLE_LEN; i++) c[TABLE_OFF + i] = table[i] & 0xff;
    if (TABLE_OFF + TABLE_LEN > CAVE_PARAS * 16) throw new Error('表放不進跳板');
    // 插入清單由 insertPassThrough 在插完之後寫進來（要等位移確定）
    return { cave: c, resume, dice, draws };
}

/** 種類名稱，順序＝SPECIAL 值。來源是 PAK 文字表第 15+kind 行（訊息 id 也是 kind+15）。 */
export const KIND_NAMES = ['公園', '銀行', '運氣', '卡片', '新聞', '股市', '法院', '黑市', '賭場', '遊樂場', '稅捐處'];

/**
 * 讀回一份 Run.exe 目前的設定。沒插過跳板（或不是我們產的）就回傳原版行為。
 * 判斷方式：0x1A5F 要是一條 near jmp，而且目標落在跳板內。
 */
export function readPassTable(x: ExeImage): PassAction[] {
    const img = x.image;
    if (img[HOOK.check] !== 0xe9) return defaultTable();
    const rel = img[HOOK.check + 1] | (img[HOOK.check + 2] << 8);
    const cave = (HOOK.check + 3 + (rel > 0x7fff ? rel - 0x10000 : rel)) & 0xffff;
    const table = new Array(TABLE_LEN).fill(0) as PassAction[];
    for (let i = 0; i < TABLE_LEN; i++) {
        const v = img[cave + TABLE_OFF + i];
        table[i] = (v === 1 || v === 2 ? v : 0) as PassAction;
    }
    return table;
}

/** 這份表是不是就是原版行為（是的話就不用插跳板）。 */
export function isDefaultTable(t: PassAction[]): boolean {
    const d = defaultTable();
    return t.length === d.length && t.every((v, i) => v === d[i]);
}

/**
 * 把跳板插進映像。會就地改寫 `x`（image / relocs / cs / ss 都會變）。
 * 一定要在 applyCaps 之後呼叫——容量那幾個位元組在插入點之後，會跟著位移。
 */
export function insertPassThrough(x: ExeImage, table: PassAction[]): void {
    for (const [k, want] of Object.entries(ORIGINAL)) {
        const site = Number(k);
        for (let i = 0; i < want.length; i++) {
            if (x.image[site + i] !== want[i]) {
                throw new Error(`映像 0x${site.toString(16)} 不是原版的位元組——這支工具只認得未改過的 Run.exe`);
            }
        }
    }

    const insertPara = segmentEnds(x)[0];
    assertPadded(x, insertPara);
    const insertAt = insertPara * 16;
    if (insertAt + CAVE_PARAS * 16 > 0x10000) throw new Error('跳板超出段 0 的 64KB，near 位移搆不到');

    const built = buildCave(insertAt, table);
    insertBlock(x, insertPara, built.cave);
    writeInsertList(x, insertAt);

    // 掛鉤點換成 near jmp，多的位元組補 nop。這些位址都在插入點之前，不受位移影響。
    const hook = (site: number, target: number) => {
        const at = imageOffset(x, site);
        x.image[at] = 0xe9;
        const r = (target - (site + 3)) & 0xffff;
        x.image[at + 1] = r & 0xff; x.image[at + 2] = (r >> 8) & 0xff;
        x.image.fill(0x90, at + 3, at + ORIGINAL[site].length);
    };
    hook(HOOK.check, insertAt);
    hook(HOOK.resume, insertAt + built.resume);
    hook(HOOK.dice, insertAt + built.dice);
    DRAW_SITES.forEach((d, i) => hook(d.site, insertAt + built.draws[i]));
}
