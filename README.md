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
- **特殊編號 (Special ID)**：當 Loc ID ≤ 49 時，此數字決定該格的真實功能（0=土地，其餘對應到遊戲字串表中的銀行、卡片店等名稱）。
- **地段編號 (Segment ID)**：將相鄰的土地劃分為同一個「地段」（例如：台北市、紐約市）。擁有相同地段編號的土地，會共享同一組**價格表**。
- **方向連接 (Directions)**：大富翁2 的角色移動**不依賴網格相鄰**，而是看這四個參數（`上`、`下`、`左`、`右`）。
  - 填入的數值是「目標地點的 Loc ID」。
  - 走到岔路時，遊戲引擎會讀取這四個方向有哪些 Loc ID 不是 0，藉此彈出方向盤讓玩家選擇。

### 3. 價格與其他
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

中文字體只含**介面用得到的字 + 遊戲字型字集**（`docs/game-charset.txt`），整包 CJK 有好幾 MB，子集化後約 590 KB。UI 文案有增刪、或換了 Material Symbols 圖示時，重新產生一次：

```bash
node tools/fetch-fonts.mjs
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
