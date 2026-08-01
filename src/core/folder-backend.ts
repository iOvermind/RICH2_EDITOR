// src/core/folder-backend.ts
// 「挑一個資料夾，然後讀寫裡面的檔案」這件事的兩套實作：
//
//   browser —— File System Access API（showDirectoryPicker）。只有 Chromium 系有，
//              而且要跑在 http://（file:// 的 ES module 會被 CORS 擋）。
//   tauri   —— Tauri 的 dialog + fs 外掛。沒有權限提示、也不挑瀏覽器。
//
// 兩者的差別只在「怎麼拿到位元組」，備份、格式解析、patch 那些邏輯完全共用，
// 所以介面刻意壓到最小：挑資料夾、讀、寫、存不存在。
//
// Tauri 的模組一律用動態 import：瀏覽器版打包時會被切成獨立 chunk 且永遠不會載入，
// 也就不必擔心它在沒有 Tauri 的環境裡 import 時就出事。

export interface FolderBackend {
    readonly kind: 'browser' | 'tauri';
    /** 這個執行環境用得了嗎 */
    supported(): boolean;
    /** 讓使用者挑資料夾；回傳顯示用的名稱。取消／失敗就丟例外。 */
    pick(): Promise<string>;
    /** 已經挑好資料夾了嗎 */
    opened(): boolean;
    /** 目前資料夾的顯示名稱 */
    name(): string;
    read(file: string): Promise<ArrayBuffer>;
    write(file: string, data: Uint8Array): Promise<void>;
    exists(file: string): Promise<boolean>;
    /** 確保有寫入權限。FSA 需要跟使用者要；Tauri 挑完就有。 */
    ensureWritable(): Promise<boolean>;
}

// ── 瀏覽器：File System Access API ──────────────────────────────────────
const browserBackend: FolderBackend = (() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let dir: any = null;
    const need = () => { if (!dir) throw new Error('尚未選擇遊戲資料夾'); return dir; };
    return {
        kind: 'browser',
        supported: () => typeof (window as any).showDirectoryPicker === 'function',
        async pick() {
            dir = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
            return dir.name;
        },
        opened: () => !!dir,
        name: () => (dir ? dir.name : ''),
        async read(file) {
            const fh = await need().getFileHandle(file);
            return await (await fh.getFile()).arrayBuffer();
        },
        async write(file, data) {
            const fh = await need().getFileHandle(file, { create: true });
            const w = await fh.createWritable();
            await w.write(data);
            await w.close();
        },
        async exists(file) {
            try { await need().getFileHandle(file); return true; } catch { return false; }
        },
        async ensureWritable() {
            if (!dir) return false;
            const opts = { mode: 'readwrite' as const };
            if ((await dir.queryPermission(opts)) === 'granted') return true;
            return (await dir.requestPermission(opts)) === 'granted';
        },
    };
})();

// ── Tauri：dialog + fs 外掛 ─────────────────────────────────────────────
const tauriBackend: FolderBackend = (() => {
    let root: string | null = null;
    const need = () => { if (!root) throw new Error('尚未選擇遊戲資料夾'); return root; };
    // 路徑分隔字元跟著使用者挑到的那個走，不要寫死 —— macOS/Linux 也要能跑
    const sep = () => (need().includes('\\') ? '\\' : '/');
    const full = (file: string) => need() + sep() + file;

    let fsMod: typeof import('@tauri-apps/plugin-fs') | null = null;
    const fs = async () => (fsMod ??= await import('@tauri-apps/plugin-fs'));

    return {
        kind: 'tauri',
        supported: () => true,
        async pick() {
            const { open } = await import('@tauri-apps/plugin-dialog');
            const picked = await open({ directory: true, multiple: false, title: '選擇大富翁2 的遊戲資料夾' });
            if (typeof picked !== 'string') throw new Error('已取消');
            root = picked;
            return picked.split(/[\\/]/).filter(Boolean).pop() ?? picked;
        },
        opened: () => !!root,
        name: () => (root ? (root.split(/[\\/]/).filter(Boolean).pop() ?? root) : ''),
        async read(file) {
            const bytes = await (await fs()).readFile(full(file));
            // readFile 回傳的 Uint8Array 可能是共用 buffer 的檢視，切一份出來才安全
            return bytes.slice().buffer as ArrayBuffer;
        },
        async write(file, data) {
            await (await fs()).writeFile(full(file), data);
        },
        async exists(file) {
            try { return await (await fs()).exists(full(file)); } catch { return false; }
        },
        ensureWritable: async () => !!root,
    };
})();

/** Tauri v2 會在 window 上掛這個 */
function inTauri(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export const backend: FolderBackend = inTauri() ? tauriBackend : browserBackend;
