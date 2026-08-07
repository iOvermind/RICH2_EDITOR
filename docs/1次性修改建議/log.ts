// 操作記錄面板。
//
// 等級名稱與配色是 Rich 系列共用的契約（INTERFACE.md §7），不得自行增減等級：
// 少一個等級，同一件事在兩支程式裡就會被寫成不同的字，使用者回報時對不起來。
// 配色在 src/style.css 的 .log-<等級>。

export const LOG_LEVELS = ['INFO', 'WARN', 'ERROR', 'SUCCESS', 'FATAL', 'DONE'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** 上限。超過就砍掉最舊的——長時間編輯會累積上萬則，DOM 節點放著不管會拖慢整個視窗。 */
const MAX_LINES = 500;

let box: HTMLElement | null = null;
let status: HTMLElement | null = null;

/**
 * 綁定面板。在 DOM 就緒後呼叫一次；呼叫前的 log() 只會進 console。
 *
 * @param boxEl    操作記錄的容器（會往裡面 append，並自動捲到底）
 * @param statusEl 底部狀態列，顯示最新一則
 */
export function bindLog(boxEl: HTMLElement, statusEl: HTMLElement | null): void {
  box = boxEl;
  status = statusEl;
}

/** 清空面板。不影響 console。 */
export function clearLog(): void {
  if (box) box.textContent = '';
}

export function log(level: LogLevel, message: string): void {
  // console 一律留一份：面板還沒綁定、或使用者已經按過「清除」時，這是唯一的紀錄。
  console.info(`[rich3_editor] ${level} ${message}`);

  if (!box) return;

  const line = document.createElement('div');
  line.className = 'log-line';

  const tag = document.createElement('span');
  tag.className = `log-level log-${level}`;
  tag.textContent = level;

  const text = document.createElement('span');
  text.textContent = message;

  line.append(tag, text);
  box.append(line);

  while (box.childElementCount > MAX_LINES) box.firstElementChild?.remove();

  box.scrollTop = box.scrollHeight;

  if (status) status.textContent = `> ${message}`;
}
