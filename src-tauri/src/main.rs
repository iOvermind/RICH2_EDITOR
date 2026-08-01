// Rich2 Editor 的 Tauri 外殼。
//
// 這裡刻意什麼商業邏輯都不做 —— 編輯器全部在前端（TypeScript），Rust 這邊只負責
// 開視窗、掛上檔案與對話框外掛。前端會依執行環境自動選後端：在 Tauri 裡走
// plugin-fs，在瀏覽器裡走 File System Access API（見 src/core/folder-backend.ts）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .run(tauri::generate_context!())
        .expect("Tauri 啟動失敗");
}
