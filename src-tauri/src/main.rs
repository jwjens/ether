#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod commands;
mod audio_engine;
mod audio_routing;
mod lufs;
mod dashboard;
mod clock;

use audio::{AudioState, SharedAudioState, start_audio_thread};
use dashboard::{NowPlayingMeta, SharedNowPlaying};
use std::sync::{Arc, Mutex};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

fn main() {
    let (sender, is_playing, levels, finished) = start_audio_thread();
    let audio_state: SharedAudioState = Arc::new(Mutex::new(AudioState {
        deck_a: audio::DeckMeta::new(),
        deck_b: audio::DeckMeta::new(),
        deck_c: audio::DeckMeta::new(),
        sender,
        is_playing,
        levels: levels.clone(),
        finished,
        watchdog_active: false,
        watchdog_threshold_sec: 10.0,
        watchdog_triggered_count: 0,
    }));

    let watchdog_state = audio_state.clone();
    let now_playing: SharedNowPlaying = Arc::new(Mutex::new(NowPlayingMeta::default()));
    let heartbeat_log = commands::new_heartbeat_log();
    let clock_state   = clock::new_clock_state();

    tauri::Builder::default()
        .manage(audio_state.clone())
        .manage(levels)
        .manage(now_playing.clone())
        .manage(heartbeat_log.clone())
        .manage(clock_state.clone())
        .manage(Arc::new(Mutex::new(audio_routing::DeckRouting::default())))
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
            commands::get_local_ip,
            commands::get_heartbeat,
            commands::stream_start,
            commands::stream_stop,
            commands::stream_status,
            commands::stream_update_metadata,
            commands::backup_db,
            commands::list_backups,
            commands::restore_db,
            commands::update_now_playing,
            commands::open_sound_settings,
            commands::get_levels,
            commands::get_file_duration,
            commands::read_audio_file,
            audio_engine::get_audio_devices,
            audio_engine::build_peak_mipmap,
            audio_engine::get_peaks_for_viewport,
            audio_engine::analyze_song,
            audio_engine::measure_song_loudness,
            audio_engine::detect_song_bpm,
            audio_engine::detect_song_cue_points,
            commands::analyze_lufs,
            commands::open_url,
            clock::update_clock,
            clock::get_clock_state,
            audio_routing::list_audio_output_devices,
            audio_routing::get_deck_routing,
            audio_routing::set_deck_output,
        ])
        .setup(move |app| {
            dashboard::start_dashboard_server(audio_state.clone(), now_playing.clone(), 4242);

            // ── Broadcast Journal Emitter ─────────────────────────────────
            // Every event tells the story of the show.
            // Green  = things going right
            // Yellow = heads-up, pay attention
            // Red    = needs action now
            {
                let hb_log    = heartbeat_log.clone();
                let hb_audio  = audio_state.clone();
                let hb_handle = app.handle().clone();

                std::thread::spawn(move || {
                    use std::time::{SystemTime, UNIX_EPOCH};

                    let mut tick: u64 = 0;

                    // State tracking
                    let mut prev_playing       = false;
                    let mut prev_title         = String::new();
                    let mut prev_artist        = String::new();
                    let mut prev_deck_a_path   = String::new();
                    let mut prev_minute        = 99u64;
                    let mut prev_hour          = 99u64;
                    let mut warned_55          = false;
                    let mut warned_58          = false;
                    let mut warned_queue_low   = false;
                    let mut next_hour_announced = false;
                    let mut last_event_key     = String::new(); // dedup: skip identical consecutive events

                    // Helper: only push if different from last event
                    macro_rules! push_once {
                        ($log:expr, $level:expr, $msg:expr, None) => {{
                            let key = format!("{}:", $msg);
                            if key != last_event_key {
                                commands::push_event($log, $level, $msg, None);
                                last_event_key = key;
                            }
                        }};
                        ($log:expr, $level:expr, $msg:expr, Some($val:expr)) => {{
                            let s: &str = $val; // auto-coerces &String → &str
                            let key = format!("{}:{}", $msg, s);
                            if key != last_event_key {
                                commands::push_event($log, $level, $msg, Some(s));
                                last_event_key = key;
                            }
                        }};
                    }

                    // Hour name helper — returns the radio daypart name for a given hour
                    fn hour_name(h: u64) -> &'static str {
                        match h {
                            5       => "Early Morning",
                            6       => "Morning Drive",
                            7       => "Morning Drive",
                            8       => "Morning Drive",
                            9       => "Mid-Morning",
                            10      => "Mid-Morning",
                            11      => "Late Morning",
                            12      => "Midday",
                            13      => "Afternoon Drive",
                            14      => "Afternoon Drive",
                            15      => "Afternoon Drive",
                            16      => "Evening",
                            17      => "Evening Drive",
                            18      => "Evening Drive",
                            19      => "Night",
                            20      => "Night",
                            21      => "Late Night",
                            22      => "Late Night",
                            23      => "Overnight",
                            0 | 1   => "Overnight",
                            2 | 3   => "Overnight",
                            4       => "Pre-Dawn",
                            _       => "On Air",
                        }
                    }

                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(1));
                        tick += 1;

                        // ── Read engine state ─────────────────────────────
                        let (is_playing, title, artist, deck_a_path, watchdog_active, triggered) = {
                            match hb_audio.lock() {
                                Ok(s) => {
                                    let playing = s.is_playing.lock().map(|p| *p).unwrap_or(false);
                                    (
                                        playing,
                                        s.deck_a.title.clone(),
                                        s.deck_a.artist.clone(),
                                        s.deck_a.file_path.clone(),
                                        s.watchdog_active,
                                        s.watchdog_triggered_count,
                                    )
                                }
                                Err(_) => (false, String::new(), String::new(), String::new(), false, 0),
                            }
                        };

                        // ── Time ─────────────────────────────────────────
                        let secs   = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
                        let hour   = (secs % 86400) / 3600;
                        let minute = (secs % 3600) / 60;
                        let second = secs % 60;
                        let next_hour = (hour + 1) % 24;

                        // ── Song started ──────────────────────────────────
                        if is_playing && !title.is_empty() && title != prev_title {
                            let display = if artist.is_empty() {
                                title.clone()
                            } else {
                                format!("{} · {}", title, artist)
                            };
                            push_once!(&hb_log, "green", "▶ Now Playing", Some(&display));
                            prev_title  = title.clone();
                            prev_artist = artist.clone();
                            warned_queue_low = false;
                        }

                        // ── Song finished ─────────────────────────────────
                        if prev_playing && !is_playing && !prev_title.is_empty() {
                            push_once!(&hb_log, "green", "◼ Played", Some(&prev_title));
                        }
                        prev_playing = is_playing;

                        // ── Deck A loaded (cued, not yet playing) ─────────
                        // Always track the path so it doesn't re-fire after playback stops
                        if deck_a_path != prev_deck_a_path {
                            if !deck_a_path.is_empty() && !is_playing {
                                let fname = deck_a_path
                                    .split(['/', '\\'])
                                    .last()
                                    .unwrap_or("")
                                    .trim_end_matches(".mp3")
                                    .trim_end_matches(".flac")
                                    .trim_end_matches(".wav")
                                    .trim_end_matches(".aac")
                                    .trim_end_matches(".m4a");
                                if !fname.is_empty() {
                                    push_once!(&hb_log, "green", "✓ Deck A Ready", Some(fname));
                                }
                            }
                            // Always update so we don't re-fire when play/stop cycles
                            prev_deck_a_path = deck_a_path.clone();
                        }

                        // ── Hour transition events ────────────────────────

                        // 10 minutes out — announce what's coming next hour
                        if minute == 50 && second == 0 && !next_hour_announced {
                            let next_name = hour_name(next_hour);
                            let msg = format!("{:02}:00 — {}", next_hour, next_name);
                            push_once!(&hb_log, "green", "🕐 Next Hour Coming Up", Some(&msg));
                            next_hour_announced = true;
                        }

                        // 5 minutes out — soft warning
                        if minute == 55 && second == 0 && !warned_55 {
                            let next_name = hour_name(next_hour);
                            let msg = format!("{} in 5 min — check log length", next_name);
                            push_once!(&hb_log, "yellow", "⏱ 5 Min to Hour", Some(&msg));
                            warned_55 = true;
                        }

                        // 2 minutes out — final heads up
                        if minute == 58 && second == 0 && !warned_58 {
                            push_once!(&hb_log, "yellow", "⚡ 2 Min to Hard Sync", Some("Final log check"));
                            warned_58 = true;
                        }

                        // Top of hour — hard sync hit
                        if minute == 0 && second == 0 && prev_minute != 0 {
                            let current_name = hour_name(hour);
                            let time_str = format!("{:02}:00:00 — {} Begins", hour, current_name);
                            push_once!(&hb_log, "green", "◉ Hard Sync Hit", Some(&time_str));
                            // Reset flags for next hour cycle
                            warned_55          = false;
                            warned_58          = false;
                            next_hour_announced = false;
                            warned_queue_low   = false;
                        }

                        // New hour — announce what we're now in
                        if hour != prev_hour && prev_hour != 99 {
                            let current_name = hour_name(hour);
                            let msg = format!("{:02}:00 · Now: {}", hour, current_name);
                            push_once!(&hb_log, "green", "📻 Hour Loaded", Some(&msg));
                        }

                        prev_minute = minute;
                        prev_hour   = hour;

                        // ── Auto-advance / recovery ───────────────────────
                        if triggered > 0 && tick % 30 == 0 {
                            let msg = format!("Recovery #{}", triggered);
                            push_once!(&hb_log, "yellow", "⚡ Auto-Advance Fired", Some(&msg));
                        }

                        if tick % 60 == 0 {
                            push_once!(&hb_log, "green", "· Engine Nominal", None);
                        }

                        if !watchdog_active && !is_playing && tick % 120 == 0 && tick > 10 {
                            push_once!(&hb_log, "yellow", "⚠ Nothing Playing", Some("Dead-air guard off"));
                        }

                        // ── Push to React frontend ────────────────────────
                        if let Ok(v) = hb_log.lock() {
                            let start = v.len().saturating_sub(5);
                            let tail: Vec<commands::HeartbeatEvent> = v[start..].to_vec();
                            let _ = hb_handle.emit("heartbeat", &tail);
                        }
                    }
                });
            }

            // ── Dead-air watchdog ─────────────────────────────────────────
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

            // ── System tray ───────────────────────────────────────────────
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
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => { app.exit(0); }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            if w.is_visible().unwrap_or(false) {
                                let _ = w.hide();
                            } else {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
