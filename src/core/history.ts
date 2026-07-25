// src/core/history.ts
// 復原/重做：快照式（存整份編輯狀態，不是逐筆指令）。
// 選快照而非 command pattern 的理由：編輯器的寫入點散落在十幾個 handler 裡，
// 逐筆記錄一定會漏；而整份狀態才 ~17KB，存 50 步也不到 1MB，直接存最省事也最可靠。
//
// 語意：push() 在「動作發生前」呼叫，存的是動作前的狀態，label 是那個動作的名字。
// 所以 undo() 就是「回到做這個動作之前」。

export interface HistoryInfo {
    canUndo: boolean;
    canRedo: boolean;
    undoLabel: string;   // 下一次 undo 會撤銷掉的動作名稱
    redoLabel: string;
    undoDepth: number;
    redoDepth: number;
}

export interface HistoryConfig<S> {
    capture: () => S;            // 取得目前狀態的深拷貝
    apply: (state: S) => void;   // 把狀態寫回去（並負責刷新畫面）
    limit?: number;              // 最多保留幾步，預設 50
    onChange?: (info: HistoryInfo) => void;
}

export class History<S> {
    private undos: { label: string; state: S }[] = [];
    private redos: { label: string; state: S }[] = [];
    private readonly limit: number;
    private readonly cfg: HistoryConfig<S>;

    constructor(cfg: HistoryConfig<S>) {
        this.cfg = cfg;
        this.limit = cfg.limit ?? 50;
    }

    /** 在改動資料「之前」呼叫，label = 即將發生的動作名稱。 */
    push(label: string): void {
        this.undos.push({ label, state: this.cfg.capture() });
        if (this.undos.length > this.limit) this.undos.shift();
        this.redos = [];                       // 新動作會切斷原本的重做鏈
        this.notify();
    }

    undo(): string | null {
        const e = this.undos.pop();
        if (!e) return null;
        this.redos.push({ label: e.label, state: this.cfg.capture() });
        this.cfg.apply(e.state);
        this.notify();
        return e.label;
    }

    redo(): string | null {
        const e = this.redos.pop();
        if (!e) return null;
        this.undos.push({ label: e.label, state: this.cfg.capture() });
        this.cfg.apply(e.state);
        this.notify();
        return e.label;
    }

    /** 換地圖時呼叫：舊地圖的歷史對新地圖沒有意義，留著只會誤觸。 */
    clear(): void {
        this.undos = [];
        this.redos = [];
        this.notify();
    }

    info(): HistoryInfo {
        return {
            canUndo: this.undos.length > 0,
            canRedo: this.redos.length > 0,
            undoLabel: this.undos.length ? this.undos[this.undos.length - 1].label : '',
            redoLabel: this.redos.length ? this.redos[this.redos.length - 1].label : '',
            undoDepth: this.undos.length,
            redoDepth: this.redos.length,
        };
    }

    private notify(): void {
        if (this.cfg.onChange) this.cfg.onChange(this.info());
    }
}
