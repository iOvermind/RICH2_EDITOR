# 操作記錄面板規格（Rich 系列共用）

給在 **RICH2_EDITOR** 開工的 agent。這份說明連同 `log.ts`、`style.css` 片段一起看。

---

## 要做什麼

把 `RICH2_EDITOR` 的操作記錄面板改成與 `RICH3_EDITOR` 一致。

**這不是風格偏好，是修正規格違反。** `RICH2_EDITOR/INTERFACE.md` 的「訊息等級」一節已經
寫明六個等級「名稱與配色屬**必須共用**」，但 `src/ui/dom-controller.ts` 的實作沒有等級：

```ts
// 現況：一個等級都沒有，全部同色的「> 訊息」
export function logMsg(msg: string): void {
  infoBox.innerHTML += `<br>> ${msg}`;
  infoBox.scrollTop = infoBox.scrollHeight;
}
```

⚠ 這行還有兩個與外觀無關的缺陷，一併修掉：

1. **`innerHTML +=` 會把訊息當 HTML 解析。** 地段名稱等字串是從遊戲檔讀出來的 Big5 文字，
   只要內容出現 `<`，面板就會壞掉或吃掉後面的文字。
2. **每寫一行都重新解析整份面板**，長時間編輯會愈來愈慢（O(n²)）。

---

## 目標行為

| 項目 | 要求 |
| :--- | :--- |
| 等級 | `INFO` / `WARN` / `ERROR` / `SUCCESS` / `FATAL` / `DONE`，**不得自行增減** |
| 配色 | 一律引用 token，見下表 |
| 寫入方式 | `createElement` + `textContent`，**禁止** `innerHTML` |
| 行數上限 | 500 行，超過就移除最舊的 |
| 狀態列 | 最新一則鏡射到底部狀態列 |
| console | 每一則同時 `console.info`，前綴 `[rich2_editor]` |
| 可選取 | 日誌區是介面中唯一可選取文字的地方，方便使用者複製回報 |
| 清除 | 只清面板，不影響 console |

### 等級配色

| 等級 | Token |
| :--- | :--- |
| `INFO` | `--color-on-surface-variant` |
| `WARN` | `--color-level-warn` |
| `ERROR` / `FATAL` | `--color-error` |
| `SUCCESS` / `DONE` | `--color-tertiary` |

**不得硬寫色值。** 這幾個 token 來自 `docs/rules/tokens.css`（正典在 `DEV_TEMPLATE`）。

---

## 參考實作

`RICH3_EDITOR/src/ui/log.ts`（約 85 行，可直接移植，改掉 console 前綴即可）。
介面是：

```ts
bindLog(boxEl: HTMLElement, statusEl: HTMLElement | null): void
log(level: LogLevel, message: string): void
clearLog(): void
```

搭配的樣式（放進 `src/style.css`）：

```css
.log-line  { display: flex; gap: 6px; }
.log-level { flex: none; font-weight: 700; }

.log-INFO    { color: var(--color-on-surface-variant); }
.log-WARN    { color: var(--color-level-warn); }
.log-ERROR   { color: var(--color-error); }
.log-FATAL   { color: var(--color-error); }
.log-SUCCESS { color: var(--color-tertiary); }
.log-DONE    { color: var(--color-tertiary); }
```

---

## 移植時要注意

- `RICH2_EDITOR` 的呼叫點是 `logMsg(訊息)`，**沒有等級參數**。改成 `log(等級, 訊息)` 之後
  每個呼叫點都要決定等級——不要全部塞 `INFO` 了事，那等於沒改。失敗訊息用 `ERROR`、
  完成用 `DONE`、可疑但不致命用 `WARN`。
- 清除鈕目前是 `infoBox.innerHTML = '已清除。'`，改成呼叫 `clearLog()` 後補一則
  `log('INFO', '已清除操作記錄')`。
- 「格子資訊」是另一個區塊，**不要跟操作記錄混在一起**（RICH2 早期犯過這個錯，
  `dom-controller.ts` 有註解記錄）。

---

## 不要改的部分

版型與畫面結構屬「**各自決定**」（`INTERFACE_RULES.md` §4.1），**禁止**因為這次改動
去動面板位置、寬度或其他區塊的安排。這次只換操作記錄的**內容呈現方式**。

---

## 收工前

1. 更新 `RICH2_EDITOR/INTERFACE.md` 的「訊息等級」一節，補上行為描述（上面那張表）。
2. 在 `CHANGELOG.md` 的 `[Unreleased]` 寫一條 —— 使用者看得到的變化是
   「操作記錄現在會標示訊息等級並依等級上色」。
3. 確認沒有任何地方還在用 `innerHTML` 寫日誌。
