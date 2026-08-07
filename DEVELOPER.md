# Rich2 Editor 開發者文件

> 這份文件給**要修改這個專案的人**。使用說明請看 [README.md](README.md)。
> 文件與發佈規範見 [docs/rules/](docs/rules/)。

---

## 1. 技術棧與系統需求

| 項目 | 版本 | 用途 |
| :--- | :--- | :--- |
| Node.js | **v20.6 以上** | 開發與建置。測試用 `module.register()` 掛 loader hook，低於此版本跑不動 |
| TypeScript | 5.9 | 前端全部邏輯 |
| Vite | 8 | 開發伺服器與打包 |
| Tailwind CSS | 4 | 樣式（建置時產出，不連 CDN） |
| Rust | 1.77 以上 | 桌面版外殼，**只有要建置桌面版才需要** |
| Tauri | 2 | 桌面版框架 |
| MSVC Build Tools | — | 編譯 Rust，需「使用 C++ 的桌面開發」工作負載 |
| WebView2 Runtime | — | **執行**桌面版所需，Windows 10/11 已內建 |

**作業系統限制**：桌面版產物僅供 Windows。瀏覽器版可在任何平台開發。

---

## 2. 環境建置

1. 取得原始碼
   ```bash
   git clone git@github.com:iOvermind/RICH2_EDITOR.git
   ```

2. 安裝相依套件
   ```bash
   npm install --legacy-peer-deps
   ```
   ⚠ **`--legacy-peer-deps` 是必要的**，不是隨手加的：`vite-plugin-node-polyfills` 尚未宣告支援 vite 8，不略過 peer 檢查會直接安裝失敗。

3. 只做前端開發的話，到這裡就夠了。要建置**桌面版**才需要繼續：
   ```powershell
   winget install Rustlang.Rustup
   ```
   再從 Visual Studio Installer 安裝「**使用 C++ 的桌面開發**」工作負載。

4. 準備測試用的遊戲檔案（選用，但沒有的話部分測試會被略過）
   見 §6。**遊戲原始檔不進版控**（見 §9.1）。

---

## 3. 日常開發

**瀏覽器版（最快的迭代方式）**

```bash
npm run dev
```

開 `http://localhost:5173`。有熱更新。

**桌面版**

```bash
npm run app:dev
```

原生視窗 + Vite HMR。第一次會編譯 Rust，要等十幾分鐘。

**除錯**：右下角的操作紀錄是主要的回報管道，每個動作都會說明做了什麼、有沒有失敗。更深入的追蹤在 `src/tools/debugger.ts`。

**檔案存取的兩種後端**：`src/core/folder-backend.ts` 在執行期自動選擇——

| 環境 | 後端 |
| :--- | :--- |
| Tauri 桌面版 | `plugin-fs` + `plugin-dialog`，沒有權限提示 |
| 瀏覽器 | File System Access API，需授權，且只有 Chromium 系瀏覽器有 |

備份、格式解析、`Run.exe` patch 那些邏輯兩邊完全共用。

---

## 4. 目錄結構

```text
RICH2_EDITOR/
├─ index.html
├─ src/
│  ├─ main.ts               程式進入點，只做實例化與依賴綁定
│  ├─ style.css             Tailwind 設定與色票（@theme）
│  ├─ config/constants.ts   共用常數
│  ├─ core/                 資料層：解析、狀態、二進位處理
│  │  ├─ workspace.ts       核心狀態機與資料層
│  │  ├─ parser.ts          PAK / DSK 的 parse 與 serialize
│  │  ├─ folder-backend.ts  檔案存取抽象（Tauri / 瀏覽器）
│  │  ├─ gamefolder.ts      遊戲資料夾的探索與掛載
│  │  ├─ gamefont.ts        遊戲字型與缺字補字
│  │  ├─ exe.ts             Run.exe 的讀寫
│  │  ├─ codecave.ts        Run.exe 的擴充空間配置
│  │  ├─ passthrough.ts     「經過就觸發」的掛鉤
│  │  ├─ priceindex.ts      物價指數
│  │  ├─ history.ts         復原／重做（整編輯器快照）
│  │  └─ integrity.ts       結構檢查與修復
│  ├─ render/renderer.ts    視圖層：Canvas 繪製
│  ├─ ui/                   互動控制層
│  ├─ utils/compression.ts  PAK 的壓縮與解壓
│  └─ assets/               字型與圖示（自帶，不連 CDN）
├─ src-tauri/               桌面版外殼（Rust）
│  ├─ tauri.conf.json       視窗、bundle、版本號
│  ├─ Cargo.toml            Rust 相依與 release profile
│  └─ capabilities/         Tauri 權限宣告（見 §9.2）
├─ tools/                   離線工具（見「資源產生工具」）
├─ tests/                   回歸測試與 loader
├─ packaging/               瀏覽器版的極簡靜態伺服器
├─ docs/
│  ├─ runexe-re.md          Run.exe 逆向筆記
│  └─ rules/                文件與發佈規範
└─ CONTEXT.md               領域詞彙表
```

---

## 5. 架構與關鍵設計決策

### 模組職責

嚴格的依賴注入與職責分離，四個角色：

| 模組 | 職責 | 依賴 |
| :--- | :--- | :--- |
| `Workspace`（`src/core/workspace.ts`） | 核心狀態機與資料層。維護地圖記憶體、封裝 PAK/DSK 的 parse/serialize 與 Big5 轉換，提供 UI 無關的查詢介面 | 無 |
| `MapRenderer`（`src/render/renderer.ts`） | 視圖層。接收 `Workspace` 的資料在 Canvas 上繪製圖塊、路線箭頭與游標 | `Workspace` |
| `DOMController`（`src/ui/dom-controller.ts`） | 互動控制層。收斂所有網頁事件監聽，做為使用者與核心邏輯的橋樑 | `Workspace`、`MapRenderer` |
| `main.ts` | 膠水層。只負責實例化與依賴綁定 | 以上三者 |

領域詞彙（Land、Marker、Special、SeaRoad、Routing…）的定義在 [CONTEXT.md](CONTEXT.md)，改動相關程式碼前先讀它。

### 關鍵決策

#### 業務邏輯放前端 TypeScript，不放 Rust

- **決定**：解析、編輯、序列化、`Run.exe` patch 全部在前端，`src-tauri` 只是外殼。
- **理由**：同一份邏輯要能同時服務桌面版與瀏覽器版。瀏覽器版不需要安裝任何東西，是這個工具最低的使用門檻。
- **代價**：桌面版必須把檔案系統權限開給前端（見 §9.2）。**這與 Rich Patch Series 的兩支 patcher 刻意相反**——那邊邏輯放 Rust，因為它們沒有瀏覽器版的需求。

#### 復原用整編輯器快照，不用命令模式

- **決定**：`history.ts` 存的是整份編輯器狀態的快照（grid、layout、loc、price、地段名稱），`push()` 在變更**之前**呼叫並標上即將發生的動作名稱。
- **理由**：變更點散落在非常多個 handler 裡，逐一實作命令與反命令維護成本太高；而一份快照只有約 17 KB。
- **代價**：記憶體用量隨步數線性成長。

#### 缺字用離線烤好的點陣圖庫，不用 Canvas 即時繪製

- **決定**：新字的點陣取自 `src/assets/gamefont/`——離線用 GDI+ 把細明體烤成的 16×15 圖庫，涵蓋 13,895 個 Big5 字。
- **理由**：Canvas 走輪廓描繪 + 灰階反鋸齒，15px 二值化會糊；GDI+ 走的是細明體內嵌點陣，跟遊戲那套字同源。
- **代價**：圖庫要另外產生（`tools/build-font-atlas.mjs`，僅限 Windows），且體積進版控。

#### 介面文字用系統字體，不自帶

- **決定**：只自帶 Material Symbols 圖示字體（6.5 KB），文字字體吃系統的。
- **理由**：地段名稱可以用任何遊戲畫得出來的字，那是 13,895 個碼位；自帶子集永遠不夠（單一字重全打包 3.8 MB、三個字重 11.4 MB）。與其塞一份會缺字的子集，不如吃系統字體。
- **代價**：不同機器上的介面字體長相會有差異。

#### `Run.exe` 走未壓縮管線

- **決定**：處理 `Run.exe` 時先解開 EXEPACK 壓縮再操作，相關細節見 `docs/runexe-re.md`。
- **理由**：「經過就觸發」與物價指數需要在映像中掛鉤與配置擴充空間（`codecave.ts`），壓縮映像做不到。
- **代價**：`Run.exe` 的處理路徑比其他檔案複雜得多。

---

## 6. 測試

```bash
npm test
```

回歸測試**直接匯入 `src/` 的原始碼**執行——`tests/loader.mjs` 會即時剝掉型別、補上副檔名，不需要先建置。

### 會被略過的測試

部分測試要拿真實遊戲檔當基準。**這些檔案不放進 repo**（遊戲原始資料，已在 `.gitignore` 內）。找不到時測試會標成 `⏭ 略過`，**不算失敗**：

| 用途 | 預設位置 | 環境變數 |
| :--- | :--- | :--- |
| 原版基準檔（未修改的 `Save_?.dsk` / `Part?.pak` / `Run.exe`） | `rich2/original/`，或根目錄 `original/` | `RICH2_ORIGINAL` |
| 遊戲目錄（編輯器實際讀寫的那份，含 `Run.exe.bak`） | `rich2/` | `RICH2_LIVE` |

⚠ 看到大量 `⏭ 略過` 不代表測試通過——那代表**根本沒測到**。要驗證解析與序列化的正確性，必須先備好上表的檔案。

---

## 7. 建置與產物

### 桌面版

```powershell
.\build-app.bat            # 可以直接雙擊
```

會先跑回歸測試（掛了就不浪費那幾分鐘去編 Rust），建完把產物收進 `release/`。

參數（透過 `tools/build-app.ps1`）：

- `-SkipTests` 跳過測試
- `-Clean` 清掉 Rust 快取（清完第一次要重編十幾分鐘）

### 瀏覽器版

```bash
npm run build              # → dist/，可部署到任何靜態網頁伺服器
npm run package            # → release/Rich2Editor-vX.Y.Z.zip（約 0.5 MB）
```

打包後的 zip 解開雙擊 `Rich2Editor.bat` 就能用，**不需要安裝 Node**——裡面是 PowerShell 寫的極簡靜態伺服器（`packaging/serve.ps1`），會挑一個空閒的埠、用 Edge/Chrome 的 `--app=` 模式開一個無網址列的視窗，關掉視窗就自動結束。

**為什麼要伺服器、不能直接雙擊 HTML**：編輯器靠 File System Access API 讀寫遊戲資料夾，而 Vite 的輸出是 ES module——從 `file://` 載入會被 CORS 擋掉。

**為什麼不打包成 exe**：Node 的單一執行檔要 100 MB 上下，而且未簽章的 exe 會被 SmartScreen 擋。PowerShell 是 Windows 內建的，所以整包下載就只有應用程式本身的大小。

除錯時可以只起伺服器不開瀏覽器：

```powershell
powershell -ExecutionPolicy Bypass -File packaging\serve.ps1 -NoBrowser
```

### 產物

| 產物 | 大小 | 用途 |
| :--- | ---: | :--- |
| `release/Rich2Editor-vX.Y.Z-portable.exe` | 3.86 MB | 免安裝，直接執行 |
| `release/Rich2Editor-vX.Y.Z-setup.exe` | 1.65 MB | NSIS 安裝檔，裝到使用者目錄，不需要管理員 |
| `release/Rich2Editor-vX.Y.Z.zip` | 約 0.5 MB | 瀏覽器版，目前**未對外發佈** |

Rust 的 release profile（`src-tauri/Cargo.toml`）刻意為體積調校：`opt-level = "s"`、`lto = true`、`codegen-units = 1`、`panic = "abort"`、`strip = true`。這是要發佈給人下載的桌面工具，體積比編譯時間重要。

產物命名依 [docs/rules/RELEASE_RULES.md](docs/rules/RELEASE_RULES.md) §2.1：只用
`A-Za-z0-9.-_`，因為 GitHub 上傳附件時會把其餘字元換成點。`release/` 不進版控。

### 版本號

**單一來源**：`package.json` 的 `version`

| 位置 | 欄位 | 方式 |
| :--- | :--- | :--- |
| `package.json` | `version` | 手動（單一來源） |
| `src-tauri/tauri.conf.json` | `version` | 手動 |
| `src-tauri/Cargo.toml` | `package.version` | 手動 |
| 產物檔名 | — | 自動（`tools/build-app.ps1` 讀取單一來源） |

發佈前依 [docs/rules/VERSION_RULES.md](docs/rules/VERSION_RULES.md) §7 逐項核對。

### 資源產生工具

平常不用跑，改到對應資源時才需要：

```bash
node tools/fetch-fonts.mjs         # 重新產生 Material Symbols 子集（會自動掃 index.html 找出用到哪些圖示）
node tools/add-chars.mjs 苗栗宜蘭   # 離線把指定的字加進 rich2/Wor.pak
node tools/build-font-atlas.mjs    # 重烤 16×15 點陣圖庫（Windows 限定）

# Run.exe 的離線 patch（編輯器裡也做得到，這是給查錯與批次用的）
node --import ./tests/loader.mjs tools/patch-passthrough.mts <in.exe> <out.exe> [--table 3=1,8=1]
node --import ./tests/loader.mjs tools/patch-priceindex.mts <in.exe> <out.exe> --like rich2/Run.exe --threshold 500000
#   ⚠ patch-priceindex 一定要用 --like 指向遊戲目錄現在那支 Run.exe：編輯器把三張圖的
#     地點／特殊地點上限寫在執行檔裡，直接拿原版重建會把上限打回原版值，玩家走到
#     新增的特殊地點就當機。
```

應用程式圖示（棋盤 + 細明體的「富」）以 `npx tauri icon` 切成 `src-tauri/icons/` 的各種尺寸。產生原圖的腳本目前不在庫內。

---

## 8. 分支、commit 與 PR 慣例

- **主分支**：`main`
- **開分支**：從 `main` 開，功能用 `feat/<描述>`、修正用 `fix/<描述>`。
- **commit 訊息**：沿用現有慣例，`feat:` / `fix:` / `docs:` / `ci:` 前綴加繁中摘要。

### 舊實作的保留

目前無。

日後若發生技術棧更替或整體重寫，舊實作**必須**依 `docs/rules/DEVELOPER_RULES.md` §4.3 以分支保留、不得直接刪除。

---

## 9. 安全與敏感資料

### 9.1 機密不進版控

本專案沒有任何金鑰或憑證。需要排除的是**別人的東西**與體積大的產生物：

| 項目 | 排除方式 | 本機該放哪 |
| :--- | :--- | :--- |
| 遊戲原始檔與測試基準 | `.gitignore` 的 `rich2/`、`original/` | 見 §6 的表格 |
| 第三方工具（LZEXE / UNLZEXE） | `.gitignore` 的 `lzexe91e/` | 庫外或該目錄 |
| 本機除錯用的 DOSBox-X | `.gitignore` 的 `DOSBox-X/` | 該目錄 |
| 建置產物 | `.gitignore` 的 `dist`、`release/`、`node_modules` | — |

**遊戲原始檔不進版控**的理由是版權，不是體積——這點請維持。

### 9.2 權限最小化

桌面版的權限宣告在 `src-tauri/capabilities/default.json`：

| 要求的權限 | 為什麼需要 |
| :--- | :--- |
| `dialog:allow-open` | 讓使用者用系統對話框挑選遊戲資料夾 |
| `fs:allow-read-file` / `fs:allow-write-file` / `fs:allow-exists` | 讀寫該資料夾內的 PAK / DSK / EXE |
| `fs:scope` = `**` | 見下方說明 |

⚠ **`fs:scope` 開成 `**` 是刻意的決定，不是疏漏。** 遊戲可能裝在任何位置，而使用者是透過**系統的資料夾對話框自己挑的**——範圍寫死反而會擋掉正常用法。這個取捨的代價是：前端拿到的檔案系統權限很大，因此**前端程式碼的審查標準必須跟著提高**，任何路徑都應該來自使用者的選擇而非拼接。

理由同時寫在 `default.json` 的 `description` 欄位裡，改動前先讀。

### 9.3 依賴來源與鎖檔

- `package-lock.json` 與 `src-tauri/Cargo.lock` **都進版控**。
- 安裝一律用 `npm install --legacy-peer-deps`（原因見 §2）。**`npm ci` 目前不適用**——peer 檢查會擋下 `vite-plugin-node-polyfills`。等它宣告支援 vite 8 之後應改回 `npm ci`。
- 介面不連任何 CDN：Tailwind 由 Vite 在建置時產出，字體與圖示自帶在 `src/assets/`。這是刻意的，換成 CDN 會讓離線環境直接壞掉。

### 9.4 破壞性操作的保護

| 操作 | 影響的資料 | 可回復機制 |
| :--- | :--- | :--- |
| 寫回 `Part?.pak`、`Save_?.dsk`、`Wor.pak` | 使用者的遊戲檔案 | 每個檔案**第一次**被覆寫前自動留 `.bak`；已存在則不覆蓋 |
| 寫回 `Run.exe` | 遊戲主程式 | 同上，但 **`.bak` 不可整檔還原**，見下 |

⚠ **`Run.exe.bak` 不能整檔覆蓋回去。** `Run.exe` 裡有三個位元組是**遊戲自己在執行時寫入的**（偵測到的音效與顯示設定），整檔還原會把使用者的設定一起清掉。要撤銷編輯器的修改，只改那幾個容量數值。這件事也寫在 [README.md](README.md) 的常見問題，動到 `Run.exe` 寫回路徑時務必維持。

---

## 10. 已知陷阱

#### 安裝完 rustup 後，已開著的終端機找不到 cargo

- **症狀**：建置桌面版時出現 `cargo not found` 或 `cargo: command not found`，但 rustup 確實裝好了。
- **原因**：rustup 安裝完只更新系統的 PATH，不會影響已經開著的 shell 工作階段。這是這個專案最常見的第一個坑。
- **處置**：重開終端機。`tools/build-app.ps1` 已經會自己去 `~\.cargo\bin` 找，所以用 `build-app.bat` 通常不會遇到。

#### `serve.ps1` 存成無 BOM 的 UTF-8 後直接語法錯誤

- **症狀**：執行 `packaging/serve.ps1` 出現莫名其妙的語法錯誤，訊息指向含中文的那幾行。
- **原因**：Windows PowerShell 5.1 讀 `.ps1` 預設用系統 ANSI 碼頁。沒有 BOM 的話裡面的中文會被拆壞，直接變成語法錯誤。
- **處置**：`packaging/serve.ps1` **必須**存成 **UTF-8 with BOM**。編輯這個檔案後務必確認編碼沒被改掉。
  （注意：這是 `.ps1` 專屬的例外。Markdown 文件依規範一律 UTF-8 **無** BOM。）

#### `npm install` 不加 `--legacy-peer-deps` 直接失敗

- **症狀**：安裝相依套件時出現 peer dependency 衝突，指向 `vite-plugin-node-polyfills` 與 vite 的版本不相容。
- **原因**：該外掛尚未宣告支援 vite 8。
- **處置**：加上 `--legacy-peer-deps`。這也是 `npm ci` 目前不能用的原因（見 §9.3）。

#### 測試全部顯示「略過」卻被當成通過

- **症狀**：`npm test` 跑完沒有失敗，但輸出裡大量 `⏭ 略過`。
- **原因**：需要真實遊戲檔的測試在找不到檔案時會自動略過，這是刻意的設計（那些檔案不能進版控），但很容易被誤讀成「測過了」。
- **處置**：要真正驗證解析與序列化，先依 §6 的表格備好基準檔，或設定 `RICH2_ORIGINAL` / `RICH2_LIVE` 環境變數。

#### 第一次建置桌面版要等十幾分鐘

- **症狀**：`npm run app:dev` 或 `build-app.bat` 長時間沒有輸出。
- **原因**：Rust 相依需要完整編譯，且 release profile 開了 `lto = true` 與 `codegen-units = 1`。
- **處置**：正常現象，等它跑完。**不要**隨手下 `-Clean`——清掉快取後下一次又要重來一遍。

---

## 相關文件

- 使用說明：[README.md](README.md)
- 領域詞彙：[CONTEXT.md](CONTEXT.md)
- `Run.exe` 逆向筆記：[docs/runexe-re.md](docs/runexe-re.md)
- 介面規格：[INTERFACE.md](INTERFACE.md)
- 變更紀錄：[CHANGELOG.md](CHANGELOG.md)
- 文件與發佈規範：[docs/rules/](docs/rules/)
