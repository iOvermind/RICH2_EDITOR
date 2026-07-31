# Run.exe 逆向工程筆記

追查目標：**哪些特殊地點是「經過就觸發」、哪些要「剛好踩上去」**，以及能否做成可編輯。
（已知現象：銀行經過就會觸發，其他特殊地點要停在上面。）

---

## 1. EXEPACK 解壓（已完成）

`Run.exe` 是 EXEPACK 壓縮的，這一度是靜態分析的最大障礙。現在已可離線解開：

```bash
node tools/unexepack.mjs rich2/original/Run.exe run_unpacked.bin
```

### 檔案結構（實測 `rich2/original/Run.exe`，188382 bytes）

| 項目 | 值 |
|---|---|
| MZ 檔頭 para 數 | 32 → 載入模組起點 **0x200** |
| 檔頭 CS:IP | `2c90:10` → 指向解壓 stub |
| EXEPACK 檔頭位置 | **0x2cb00**（16-byte 版，簽章 `52 42` 'RB' 在 +14） |
| 真正進入點 | CS:IP = `1c6a:55c`，SS:SP = `3235:c00` |
| destLen | 12853 段落 = **205648 bytes** |

### 關鍵：原樣保留區

解壓迴圈跑完 76 個指令後，來源指標與目的指標**收斂在同一位置**（都是 `0x29586`）。
EXEPACK 的設計是：**終止時剩下的低位資料已經在正確位置，原樣不動**。

| 區段 | 檔案 offset | 映像 offset | 對應關係 |
|---|---|---|---|
| **原樣保留區** | `0x200` ~ `0x29786` | `0x0` ~ `0x29586` | **映像 = 檔案 − 0x200（1:1）** |
| 壓縮尾段 | `0x29786` ~ `0x2cb00` | `0x29586` ~ `0x3234f` | 無簡單對應 |

> 這解釋了為什麼直接對原始檔做位元組 patch 會生效——那些 patch 全都落在原樣保留區。
>
> ⚠️ **但壓縮尾段的檔案 offset 不能拿來推算位址**。舊筆記記的「分派器 @0x2a943」就是這個區域的檔案 offset，用它算位址會錯。

### 解壓演算法要點

由尾端往前讀，每個指令：

- `op & 0xFE == 0xB0` → 填充：讀 count(2 byte)、讀 1 byte，重複輸出 count 次
- `op & 0xFE == 0xB2` → 複製：讀 count(2 byte)，複製 count bytes
- `op & 1` → 這是最後一個指令
- **終止後必須把剩餘的來源資料整塊複製到輸出低位**（漏掉這步只會得到 12102 bytes 垃圾）

### 驗證

已知的每張地圖初始化指令，在解壓映像中的位置：

| 指令 | 映像 offset | 檔案 offset |
|---|---|---|
| `MOV word[0x1096], 119`（台灣 maxLoc） | `0x122a6` | `0x124a6` |
| `MOV word[0x1098], 23`（台灣 特殊數） | `0x122ac` | `0x124ac` |
| `MOV word[0x1058], 4`（台灣 玩家數） | `0x122b2` | `0x124b2` |
| `MOV word[0x1096], 140`（香港） | `0x122c0` | `0x124c0` |
| `MOV word[0x1096], 282`（大富翁城） | `0x122da` | `0x124da` |

差值一律 `0x200`，與原樣保留區的對應關係吻合。

---

## 2. ❌ 已推翻的假設：`CS:0x1482` 不是特殊地點分派器

先前（含更早的筆記）認為映像 `0x2dd2c` 附近是特殊地點分派器，因為它有一張
**11 項**跳轉表、上界檢查是 `CMP BX,10`，剛好對應 11 種特殊地點。

完整反組譯後證實**這是誤判**。該函式（映像 `0x2dd04`，標籤 `0xe884`）：

```asm
e884: mov  bx,[bp+6]        ; BX = 功能編號
e889: cmp  bx,0xff          ; 0xFF → 初始化
e88d: je   e8b3
e88f: cmp  cs:[0x1460],0    ; ==0 直接回傳 0
e895: jne  e89f
e897: xor  ax,ax            ; 回傳 0
e89f: cmp  bx,10
e8a2: jbe  e8ac
e8a4: cmp  cs:[0x1460],2    ; 功能 >10 才要求 ==2
e8aa: jne  e897
e8ac: shl  bx,1
e8ae: jmp  cs:[bx+0x1482]
e8b3: call 0xef04           ; 初始化：算出 cs:[0x1460]
e8b6: mov  cs:[0x1460],ax
```

而 `0xef04`（映像 `0x2e384`）的內容是：

```asm
ef05: mov  bp,0x388         ; ← Adlib/OPL2 標準基底埠
ef0d: mov  ax,0x6004 ; call ; OPL reg04 = 0x60（計時器控制）
ef13: mov  ax,0x8004 ; call ; OPL reg04 = 0x80（IRQ reset）
ef1b: in   al,dx            ; 讀 OPL 狀態
ef20: mov  ax,0xff02 ; call ; OPL reg02 = 0xFF（Timer1）
ef26: mov  ax,0x2104 ; call ; OPL reg04 = 0x21（啟動 Timer1）
ef44: test di,0xe0          ; 檢查狀態位元
```

這是**標準的 Adlib/OPL2 音效卡偵測程序**。結論：

- `CS:[0x1460]` 是**音效卡型別**，不是特殊地點的模式旗標
- `CS:0x1482` 的 11 項表是**音效驅動的功能分派表**
- 「11 項」與「11 種特殊地點」**純屬巧合**
- 同區第二個分派器（`MOV BL,CS:[0x1455]`；`CMP BL,4`；`JMP CS:[BX+0x1478]`，5 項）也在音效驅動範圍內

> **教訓**：只憑「跳轉表項數吻合」就下結論會錯。要追到實際的資料存取（本例是 port I/O）才算數。

---

## 3. 下一步方向

特殊地點的觸發邏輯要重新找，建議**從資料驅動下手**，不要再猜跳轉表：

- [ ] 找引擎讀取地點 SPECIAL 欄位的程式碼。該欄位在 DSK 第 4 組偏移 `0x46C`，
      定址會長成 `基底 + locId*2 + 0x46C` 的形式。
- [ ] 或從「移動迴圈」下手：找逐格前進的迴圈，看它每走一格做了哪些檢查。
- [ ] 動態除錯（DOSBox-X 已在 `./DOSBox-X`）：設中斷點比較 pass 與 land 兩條路徑。
- [ ] `Js3.exe`（中文系統，疑似含字型）**不是 EXEPACK**（無 'RB' 簽章），要另尋脫殼法。
- [ ] 最終仍需在遊戲中實測驗證。

---

## 4. 解 LZEXE 壓縮的執行檔（可重複使用的做法）

專案裡的 `lzexe91e/UNLZEXE5.ZIP` 有 UNLZEXE 0.5 的原始碼與 DOS 執行檔。
那個 zip 是 PKZIP 1.x 的 **implode** 格式，PowerShell 的 `Expand-Archive` 解不開，要用 WinRAR：

```powershell
& "C:\Program Files\WinRAR\WinRAR.exe" x -ibck -y lzexe91e\UNLZEXE5.ZIP lzexe91e\unlzexe5\
```

然後用 DOSBox-X **完全非互動**地跑它：

```powershell
$w = "D:\lzwork"            # 放 UNLZEXE.EXE 跟要解的檔案
$dbx = "D:\dev\rich2_editor\DOSBox-X"
Start-Process -FilePath "$dbx\dosbox-x.exe" -WorkingDirectory $dbx -Wait `
  -ArgumentList '-nomenu -c "MOUNT E D:\lzwork" -c "E:" -c "UNLZEXE JS3.EXE JS3U.EXE" -c "EXIT"'
```

⚠ 兩個踩過的坑：
- **`-c` 的整串指令一定要用引號包成單一參數**。PowerShell 的 `-ArgumentList @("-c","MOUNT E ...")`
  會被拆成好幾個參數，DOSBox 只收到 `-c MOUNT`，其餘當成垃圾參數 —— 結果是靜靜地什麼都不做。
- **`DOSBox-X/dosbox-x.conf` 的 `[autoexec]` 已經把 `rich2` 掛成 C:**，所以要用別的磁碟機代號。

## 5. ❌ 已排除：`Js3.exe` 不是中文系統

先前猜「字型在 Js3.exe 這個精簡中文系統裡」。用上面的做法解開後（LZEXE 0.90，
26833 → 67702 bytes），字串明白顯示它是**搖桿／滑鼠驅動程式**：

```
JOYMOUSE TEST OK / Transfer data to joystick control / _Analog Joystick / joymouse.js3
```

對應遊戲目錄的 `Joymouse.cfg`、`Rich.joy`、`Rich.js3`(78 bytes 設定檔)。
`Rich2.bat` 的 `js3 rich` 只是載入搖桿設定，跟中文顯示無關。
裡面也沒有 Wor.pak 那張 639 字表（搜 `aa fc a4 67 a5 4a` 無）。

**所以字型還是沒找到**，而且嫌疑犯回到 `Run.exe`——它確實會讀 `WOR.PAK`。
但 Run.exe 映像裡沒有 `cmp al,0A1h` 這類明顯的 Big5 首位元組判斷，
下次要找的是非 `cmp` 形式的判斷（`test al,80h` / `or al,al` + `jns`、或 256 項查表）。

## 6. 找字形點陣：直接抓記憶體快照（建議做法）

靜態找了一整輪都沒找到字形（已排除 `Wor.pak` 全部群組、三張地圖 PAK、`Rich?.rix`(AdLib 音樂)、
`Js3.exe`(搖桿驅動)）。`Run.exe` 確實會讀 `WOR.PAK`，但映像裡找不到可靠的參照
——「`mov dx, offset`」那種寫法在這支程式裡對不上，資料段基底也推不準。

**與其繼續猜檔案格式，不如直接抓執行中的記憶體**：遊戲正在畫中文時，字形一定
以未壓縮的形式躺在 RAM 裡。抓一份 640KB 快照回來搜，比逆推檔案格式可靠得多。

### 步驟

1. 用 DOSBox-X 正常啟動遊戲，走到**畫面上有中文的地方**（例如買地時顯示地名）。
2. 按 **Alt+Pause** 叫出 debugger（另一個 console 視窗）。
3. 在 debugger 打：

   ```
   MEMDUMPBIN 0:0 A0000
   ```

   這會把 0~640KB 整塊倒進 DOSBox-X 的 capture 目錄（預設 `DOSBox-X\capture\`），
   檔名類似 `MEMDUMP.BIN`。
4. 按 **F5**（或打 `RUN`）讓遊戲繼續，關掉遊戲。
5. 把那個 `.BIN` 交出來分析。

### 拿到快照之後要找什麼

- **字形點陣**：639 個字 × 32 bytes（16x16 1bpp）≈ 20KB 的連續區塊，特徵是
  「墨水密度 0.15~0.30、每個字的第一列與最後一列幾乎全 0」。
- **那張 639 項的 Big5 表**：搜 `AA FC A4 67 A5 4A`（阿土仔）。表在記憶體裡的位置
  找到後，**字形陣列多半就在附近**，而且兩者的 index 對應關係可以直接對出來。
- 兩者都找到，就能確定「第 N 個字形」對應「表的第 N 項」，
  之後要換字或加字就只是改這兩塊。

> 💡 若想同時確認「缺字為什麼會掉到表尾」，可以在快照前先在遊戲裡放一個缺字的地名，
> 抓快照時那串文字也會在 RAM 裡，可以一併對照。

## 7. 字形找到了（記憶體快照，2026-07-31）

用 §6 的做法抓到 `DOSBox-X/MEMDUMP.BIN`（640KB，遊戲顯示中文時的 0~A0000）。
**字形確實在記憶體裡，而且不在任何資料檔裡** —— 難怪靜態怎麼找都找不到。

### 已確定

| 項目 | 值 |
|---|---|
| 639 項 Big5 字表在記憶體 | `0x57814`、`0x5A590`、`0x5CA60`（三份） |
| 字形區大致範圍 | `0x5D000` ~ `0x62200` |
| **每格 30 bytes** | 400 個連續格子的最後 2 bytes 全為 0（＝最後一列空白），命中率 1.00 |
| 排列 | 16 寬 × 15 高、row-major，每列 2 bytes |

以 `0x5F006` 為基準、stride 30 畫出來是**清楚可辨的中文字形**（見下方「怎麼畫」），
所以幾何形狀（30 bytes/格、16x15）可以確定。

### ⚠ 還沒解決：index → 格子的對應

- 「一」在字表的 index 是 26，但**整個字形區找不到任何一格長得像「一」**
  （只有一列有筆畫、且該列 ≥10 個點的格子，0 個）。
- 用任何起點去對，`glyph[table.indexOf(ch)]` 畫出來都是「真的中文字，但不是那個字」。
- 試過並排除：奇偶列交錯、上下半交錯、以及「8 寬 × 15 高、左右兩半各一格」的拼法
  （後者畫出來比 16 寬更亂）。

所以還缺的只有**格子的排列順序／起點**。可能是分頁存放（例如每 256 格一區）、
或字形區前面有表頭、或 index 不是直接用字表位置而是另有一層對照。

### 怎麼畫（給下次接手）

```js
const b = fs.readFileSync('DOSBox-X/MEMDUMP.BIN');
function art(off){                      // 一格 = 30 bytes = 16寬x15高
  for(let y=0;y<15;y++){
    let s='';
    for(let x=0;x<16;x++){
      const v=b[off+y*2+(x>>3)];
      s += ((v>>(7-(x&7)))&1) ? '██' : '  ';
    }
    console.log(s);
  }
}
art(0x5f006);        // 換 +30 就是下一格
```

> ⚠ `MEMDUMP.BIN` 在 `DOSBox-X/` 底下，而該目錄在 `.gitignore` 內（不進版控）。
> **不要刪掉它** —— 重抓一次要重跑遊戲。
