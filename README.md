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
- Node.js (建議 v18 以上)

### 快速開始
1. 安裝相依依賴：
   ```bash
   npm install
   ```
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
