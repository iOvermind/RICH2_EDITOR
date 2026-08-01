# Richman 2 Editor (大富翁2 地圖編輯器)

這是一款專為經典老遊戲《大富翁2》量身打造的現代化網頁版地圖與存檔編輯器。
本專案採用 TypeScript 與 Vite 建構，透過最新瀏覽器的 File System Access API 實作了「一鍵掛載遊戲資料夾、直接寫入修改」的流暢生產力工作流。

## ✨ 核心特色 (Features)

- **📁 零摩擦掛載系統 (File System Access)**
  - 徹底捨棄繁瑣的單檔匯入。只要點擊 `Pick Folder` 選取大富翁2的遊戲主目錄，編輯器便會自動深入子資料夾尋找並解析 `MAP/MAP.PAK` 與 `SAVE/RICH2.DSK`。
  - 編輯完成後，點擊 `Save to Game` 即可無縫複寫回原資料夾，存檔即生效。
- **🗺️ 無限縮放地圖預覽 (Map Canvas)**
  - 使用 HTML5 Canvas 實作 864x720 地圖預覽，支援視窗自適應彈性縮放與像素級完美渲染 (`image-rendering: pixelated`)，確保像素藝術絕不模糊。
- **📊 專業級屬性面板 (Inspector)**
  - 現代化三欄式工具佈局：左側地圖預覽 👉 中間 Console Log 👉 右側深度編輯。
  - 全繁體中文傳統標籤介面，可精細編輯 **🧱 圖塊 (Tiles)**、**📍 地點 (Locations)**、**💰 價格 (Prices)** 等資料結構。
- **💾 完美相容 Big5 編碼**
  - 內建 `iconv-lite`，無痛讀寫老遊戲的 Big5 中文字串。

## 📖 參數編輯指南 (Parameter Guide)

在大富翁2中，地圖的運作是透過「邏輯節點 (Location)」構成的**有向圖 (Directed Graph)**，而非單純的視覺網格。了解以下參數將幫助您正確修改地圖：

### 1. 基礎屬性
- **地點編號 (Loc ID)**：地圖上每個可踩踏格子的唯一身分證。
  - `0`：不可踩踏的背景或障礙物。
  - `1 ~ 49`：道路與特殊建築（如：銀行、醫院、商店等）。
  - `50 以上`：一般可購買的土地。
  - **購地標記 (Marker)**：遊戲會以 `Loc ID + 950` 作為該土地的「玩家購地標誌（小房子/地標）」存放位置。
- **圖塊代號 (Tile ID)**：純視覺參數，決定這格在畫面上顯示哪一張圖片（草地、柏油路、房子）。

### 2. 進階屬性
- **特殊編號 (Special ID)**：當 Loc ID ≤ 49 時，此數字決定該格的真實功能（0=公園，其餘對應到遊戲字串表中的銀行、卡片店等名稱）。
- **特殊地點是整組 2×2**：一個特殊地點固定佔四格，四格的圖塊必須是**連號四塊**（左上角 = `40 + 種類×4`，例如卡片 = 52,53,54,55），而且該地點的特殊編號要等於這個種類。
  因此圖塊選擇器把 40~83 抽出來獨立成一排「特殊地點」按鈕：**點一下就是完整的四格**，編號、座標、方向、路由、特殊編號一次配好，不會拼出半個賭場。
  在既有的特殊地點上點另一種，就是換它的種類（圖塊與特殊編號一起換）。
- **海上道路**：只佔一格、沒有地段，**編號緊接在最後一個特殊地點之後**（原版台灣＝特殊 1~23、海路 24~39），上限 50。
  新增特殊地點時整段海路會自動往後挪一格，方向連接一起修正（接到土地/特殊地點的頭尾連接不動）；警告頁的「修復海路」可以隨時重跑一次。
- **地段編號 (Segment ID)**：將相鄰的土地劃分為同一個「地段」（例如：台北市、紐約市）。擁有相同地段編號的土地，會共享同一組**價格表**。
- **方向連接 (Directions)**：大富翁2 的角色移動**不依賴網格相鄰**，而是看這四個參數（`上`、`下`、`左`、`右`）。
  - 填入的數值是「目標地點的 Loc ID」。
  - 走到岔路時，遊戲引擎會讀取這四個方向有哪些 Loc ID 不是 0，藉此彈出方向盤讓玩家選擇。

### 3. 改名字會遇到的缺字問題
遊戲自帶字型，**只畫得出它字表裡的字**。那張表在 `Wor.pak` 裡：一組連續的 2-byte Big5 陣列，原版 **639 項、其中漢字 626 個**，
**三張地圖共用同一張**（實測它跟三張圖文字的聯集完全相同，一個字都不差 —— 所以在香港打「澎」「湖」這種台灣地名是正常的）。

字形照這張表的順序排，表外的字查不到 index 就會掉到**表尾**。原版表尾正好是「邦」，
於是「苗栗縣」變成「邦邦縣」——「苗」「栗」都不在表內，雙雙掉到同一格，只有「縣」是對的。

編輯器改地段名稱時會直接拿這張表比對，缺字會即時警告並告訴你它會變成哪個字。

#### 缺字會自動補進遊戲字型

字形就在 `Wor.pak` 裡（第 2 組，每字 30 bytes = 16 寬 × 15 高），而且 **`Run.exe` 沒有寫死字數** ——
639 / 1278 / 19170 在整個解壓映像裡都不是立即數，字數是從資料本身推出來的。
所以只要**字表與字形一起加長**就會生效（已在遊戲裡實測）。

因此：**按「儲存到遊戲」時，會把地圖文字裡缺的字自動補進 `Wor.pak`**，不必手動處理。
新字的點陣取自 `src/assets/gamefont/`——離線用 GDI+ 把**細明體**烤成的 16×15 圖庫，涵蓋 13,895 個 Big5 字。
（不在瀏覽器用 Canvas 畫：Canvas 走輪廓描繪 + 灰階反鋸齒，15px 二值化會糊；GDI+ 走的是細明體內嵌點陣，跟遊戲那套字同源。）

第一次覆寫前會備份成 `Wor.pak.bak`。兩種情況補不了，編輯器會明講、要你換字：

- **Big5 首位元組 < 0xA1 的罕用字**（例如香港的「鰂」= `0x91 0x6F`）：遊戲根本不把它當雙位元組開頭，
  低位元組會被當 ASCII 印出來（「鰂」→「o」），後面整串排版跟著錯開。加進字表也沒用。
- 圖庫裡也沒有那個碼位的字。

要離線加字或重烤圖庫：

```bash
node tools/add-chars.mjs 苗栗宜蘭      # 直接改 rich2/Wor.pak
node tools/build-font-atlas.mjs        # 重烤點陣圖庫（Windows 限定，平常不用跑）
```

### 4. 價格與其他
- **價格表 (Prices)**：針對特定的「地段 (Segment)」，可修改土地空地價、1~5 級房屋過路費等。修改地段 1 的價格，所有套用 Segment ID = 1 的土地都會同步生效。
- **未知參數 (UNK 3, 9, A, B...)**：目前尚未完全解析的二進位欄位，部分可能與存檔中的地段順序或標記物朝向有關。若不確定，建議維持原值或參考相鄰格子的設定。

## 🛠️ 技術架構 (Architecture)

為了保持程式碼的整潔與可維護性，專案採用了嚴格的「依賴注入 (Dependency Injection)」與職責分離模式：

1. **`Workspace`** (`src/core/workspace.ts`)
   - **核心狀態機與資料層**。負責維護地圖記憶體、封裝二進位 (`PAK`/`DSK`) 的 Parse / Serialize 邏輯以及 Big5 轉換。
2. **`MapRenderer`** (`src/render/renderer.ts`)
   - **視圖層**。接收 `Workspace` 資料，負責在 Canvas 上高效率繪製圖塊、路線箭頭與互動游標，並將繪圖邏輯從業務邏輯中完全抽離。
3. **`DOMController`** (`src/ui/dom-controller.ts`)
   - **互動控制層**。集中收斂所有的網頁事件監聽（滑鼠懸停、按鈕點擊、表單更新），做為使用者與核心邏輯溝通的橋樑。
4. **`main.ts`**
   - **程式進入點**。僅扮演膠水層，負責將上述三大模組進行實例化並建立依賴綁定。

## 🚀 本地開發 (Local Development)

### 系統需求
- Node.js **v20.6 以上**（測試用 `module.register()` 掛 loader hook）

### 快速開始
1. 安裝相依依賴：
   ```bash
   npm install --legacy-peer-deps
   ```
   （`vite-plugin-node-polyfills` 尚未宣告支援 vite 8，需要略過 peer 檢查。）
2. 啟動熱刷新開發伺服器：
   ```bash
   npm run dev
   ```
3. 在瀏覽器中開啟 `http://localhost:5173`。

### 建置與發布
```bash
npm run build
```
打包後的靜態檔案會輸出於 `dist/` 目錄，可直接部署至任何支援靜態網頁的伺服器 (如 GitHub Pages, Vercel, Netlify)。

### 樣式與字體（完全離線）

介面不連任何 CDN：Tailwind 由 Vite 在建置時產出（色票與字體設定寫在 `src/style.css` 的 `@theme`），字體與圖示自帶在 `src/assets/fonts/`。

**文字用系統字體，不自帶。** 缺字會自動補進遊戲字型，所以地段名稱可以用任何遊戲畫得出來的字 —— 那是 13,895 個碼位，自帶子集永遠不夠用（全部打包單一字重 3.8 MB、三個字重 11.4 MB）。與其塞一份會缺字的子集，不如直接吃系統字體，任何機器上都不會有缺字。字體堆疊在 `src/style.css` 的 `@theme`。

自帶的只剩 **Material Symbols 圖示字體（6.5 KB）**——少了它按鈕會顯示 `folder_open`、`undo` 這些英文字。介面換了新圖示時重新產生一次（會自動掃 `index.html` 找出用到哪些圖示）：

```bash
node tools/fetch-fonts.mjs
```

### 桌面版（Tauri）

```bash
npm run app:dev        # 開發：原生視窗 + Vite HMR
npm run app:build      # → src-tauri/target/release/bundle/nsis/*-setup.exe
```

產出 **3.8 MB 執行檔 / 1.6 MB 安裝檔**。原生視窗、自己的圖示、不需要瀏覽器也不會跳黑視窗。

建置需要 **Rust + MSVC Build Tools**（`winget install Rustlang.Rustup` 與 VS Build Tools 的「使用 C++ 的桌面開發」）。執行只需要 WebView2 Runtime，Windows 10/11 內建。

檔案存取抽在 `src/core/folder-backend.ts`，執行期自動選：

| 環境 | 後端 |
|---|---|
| Tauri 桌面版 | `plugin-fs` + `plugin-dialog`，沒有權限提示 |
| 瀏覽器 | File System Access API，要授權、且只有 Chromium 系有 |

備份、格式解析、exe patch 那些邏輯兩邊完全共用。

圖示由 `tools/make-icon.ps1` 產生（棋盤 + 細明體的「富」），再用 `npx tauri icon` 切各尺寸。

### 瀏覽器版打包（不需要 Rust）

```bash
npm run package        # → release/Rich2Editor-vX.Y.Z.zip（約 0.5 MB）
```

解開後雙擊 `Rich2Editor.bat` 就能用，**不需要安裝 Node**。裡面是一個 PowerShell 寫的極簡靜態伺服器（`packaging/serve.ps1`），會挑一個空閒的埠、用 Edge/Chrome 的 `--app=` 模式開一個無網址列的視窗，關掉視窗就自動結束。

**為什麼要伺服器、不能直接雙擊 HTML**：編輯器靠 File System Access API 讀寫遊戲資料夾，而 Vite 的輸出是 ES module —— 從 `file://` 載入會被 CORS 擋掉。

**為什麼不打包成 exe**：Node 的單一執行檔要 100 MB 上下，而且未簽章的 exe 會被 SmartScreen 擋。PowerShell 是 Windows 內建的，所以整包下載就只有應用程式本身的大小。

⚠ `serve.ps1` 必須是 **UTF-8 with BOM**：Windows PowerShell 5.1 讀 `.ps1` 預設用系統 ANSI 碼頁，沒有 BOM 的話裡面的中文會把字串拆壞、直接變成語法錯誤。

除錯時可以只起伺服器不開瀏覽器：

```powershell
powershell -ExecutionPolicy Bypass -File packaging\serve.ps1 -NoBrowser
```

### 測試
```bash
npm test
```
回歸測試直接匯入 `src/` 的原始碼跑（`tests/loader.mjs` 會即時剝掉型別、補上副檔名，不需要先建置）。

部分測試要拿真實遊戲檔當基準，這些檔案**不放進 repo**（遊戲原始資料，已在 `.gitignore` 內）。找不到就會標成 `⏭ 略過`，不算失敗：

| 用途 | 預設位置 | 環境變數 |
|---|---|---|
| 原版基準檔（未修改的 `Save_?.dsk` / `Part?.pak` / `Run.exe`） | `rich2/original/`，或根目錄 `original/` | `RICH2_ORIGINAL` |
| 遊戲目錄（編輯器實際讀寫的那份，含 `Run.exe.bak`） | `rich2/` | `RICH2_LIVE` |
