#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use tauri_plugin_autostart::ManagerExt;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_dialog::init()) // <--- This must be initialized
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec![])))     // <--- This must be initialized
        .setup(|_app| {
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
