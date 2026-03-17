#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod commands;

use audio::{AudioState, SharedAudioState, start_audio_thread};
use std::sync::{Arc, Mutex};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

fn main() {
    let (sender, is_playing) = start_audio_thread();
    let audio_state: SharedAudioState = Arc::new(Mutex::new(AudioState {
        deck_a: audio::DeckMeta::new(),
        deck_b: audio::DeckMeta::new(),
        sender,
        is_playing,
        watchdog_active: false,
        watchdog_threshold_sec: 10.0,
        watchdog_triggered_count: 0,
    }));

    let watchdog_state = audio_state.clone();

    tauri::Builder::default()
        .manage(audio_state)
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .invoke_handler(tauri::generate_handler![
            commands::audio_load,
            commands::audio_play,
            commands::audio_pause,
            commands::audio_stop,
            commands::audio_set_volume,
            commands::audio_get_state,
            commands::watchdog_set,
        ])
        .setup(move |app| {
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut silence_start: Option<std::time::Instant> = None;
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    let (active, threshold, playing) = {
                        match watchdog_state.lock() {
                            Ok(state) => {
                                let playing = state.is_playing.lock().map(|p| *p).unwrap_or(false);
                                (state.watchdog_active, state.watchdog_threshold_sec, playing)
                            }
                            Err(_) => continue,
                        }
                    };

                    if !active { silence_start = None; continue; }

                    if playing {
                        silence_start = None;
                    } else {
                        let start = silence_start.get_or_insert_with(std::time::Instant::now);
                        let silence_sec = start.elapsed().as_secs_f64();
                        if silence_sec >= threshold {
                            let _ = app_handle.emit("dead-air-detected", silence_sec);
                            silence_start = None;
                            if let Ok(mut state) = watchdog_state.lock() {
                                state.watchdog_triggered_count += 1;
                            }
                        }
                    }
                }
            });

            let show = MenuItemBuilder::with_id("show", "Show Ether").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("Ether - On Air")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show(); let _ = w.set_focus();
                        }
                    }
                    "quit" => { app.exit(0); }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            if w.is_visible().unwrap_or(false) { let _ = w.hide(); }
                            else { let _ = w.show(); let _ = w.set_focus(); }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
