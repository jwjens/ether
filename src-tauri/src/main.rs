#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod commands;

use audio::{AudioState, SharedAudioState, start_audio_thread};
use std::sync::{Arc, Mutex};

fn main() {
    let sender = start_audio_thread();
    let audio_state: SharedAudioState = Arc::new(Mutex::new(AudioState {
        deck_a: audio::DeckMeta::new(),
        deck_b: audio::DeckMeta::new(),
        sender,
    }));

    tauri::Builder::default()
        .manage(audio_state)
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec![])))
        .invoke_handler(tauri::generate_handler![
            commands::audio_load,
            commands::audio_play,
            commands::audio_pause,
            commands::audio_stop,
            commands::audio_set_volume,
            commands::audio_get_state,
        ])
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
