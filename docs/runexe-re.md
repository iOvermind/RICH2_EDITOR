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
