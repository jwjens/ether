use crate::audio::{AudioCmd, SharedAudioState};
use tauri::State;

#[tauri::command]
pub fn audio_load(deck: String, file_path: String, title: String, artist: String, gain_db: Option<f64>, state: State<SharedAudioState>) -> Result<String, String> {
    let mut audio = state.inner().lock().map_err(|e| e.to_string())?;
    let meta = if deck == "A" { &mut audio.deck_a } else { &mut audio.deck_b };
    meta.title = title.clone(); meta.artist = artist.clone();
    meta.file_path = file_path.clone(); meta.status = "idle".to_string();
    meta.gain_db = gain_db.unwrap_or(0.0) as f32;
    audio.sender.send(AudioCmd::Load { deck, file_path, title, artist, gain_db: gain_db.unwrap_or(0.0) as f32 }).map_err(|e| e.to_string())?;
    Ok("ok".to_string())
}

#[tauri::command]
pub fn audio_play(deck: String, state: State<SharedAudioState>) -> Result<String, String> {
    let mut audio = state.inner().lock().map_err(|e| e.to_string())?;
    let meta = if deck == "A" { &mut audio.deck_a } else { &mut audio.deck_b };
    meta.status = "playing".to_string();
    audio.sender.send(AudioCmd::Play(deck)).map_err(|e| e.to_string())?;
    Ok("ok".to_string())
}

#[tauri::command]
pub fn audio_pause(deck: String, state: State<SharedAudioState>) -> Result<String, String> {
    let mut audio = state.inner().lock().map_err(|e| e.to_string())?;
    let meta = if deck == "A" { &mut audio.deck_a } else { &mut audio.deck_b };
    meta.status = "paused".to_string();
    audio.sender.send(AudioCmd::Pause(deck)).map_err(|e| e.to_string())?;
    Ok("ok".to_string())
}

#[tauri::command]
pub fn audio_stop(deck: String, state: State<SharedAudioState>) -> Result<String, String> {
    let mut audio = state.inner().lock().map_err(|e| e.to_string())?;
    let meta = if deck == "A" { &mut audio.deck_a } else { &mut audio.deck_b };
    meta.status = "idle".to_string();
    audio.sender.send(AudioCmd::Stop(deck)).map_err(|e| e.to_string())?;
    Ok("ok".to_string())
}

#[tauri::command]
pub fn audio_set_volume(deck: String, volume: f32, state: State<SharedAudioState>) -> Result<String, String> {
    let mut audio = state.inner().lock().map_err(|e| e.to_string())?;
    let meta = if deck == "A" { &mut audio.deck_a } else { &mut audio.deck_b };
    meta.volume = volume;
    audio.sender.send(AudioCmd::SetVolume { deck, volume }).map_err(|e| e.to_string())?;
    Ok("ok".to_string())
}

#[tauri::command]
pub fn audio_get_state(state: State<SharedAudioState>) -> Result<serde_json::Value, String> {
    let audio = state.inner().lock().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "deckA": audio.deck_a.info("A"),
        "deckB": audio.deck_b.info("B"),
        "deckC": { "id": "C", "status": "idle", "title": "", "artist": "", "file_path": "", "volume": 1.0, "is_finished": true },
    }))
}

#[tauri::command]
pub fn watchdog_set(active: bool, threshold_sec: f64, state: State<SharedAudioState>) -> Result<String, String> {
    let mut audio = state.inner().lock().map_err(|e| e.to_string())?;
    audio.watchdog_active = active;
    audio.watchdog_threshold_sec = threshold_sec;
    Ok("ok".to_string())
}

#[tauri::command]
pub fn get_local_ip() -> String {
    // Simple approach: try to connect to external and get local IP
    use std::net::UdpSocket;
    if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = socket.local_addr() {
                return addr.ip().to_string();
            }
        }
    }
    "localhost".to_string()
}

#[tauri::command]
pub fn analyze_lufs(file_path: String) -> Result<f64, String> {
    crate::lufs::analyze_file(&file_path)
}

use std::sync::atomic::{AtomicBool, Ordering};
static STREAMING: AtomicBool = AtomicBool::new(false);

#[derive(serde::Deserialize)]
pub struct IcecastConfig {
    pub server: String,
    pub port: u16,
    pub mount: String,
    pub password: String,
    pub bitrate: u32,
    pub station_name: String,
}

#[tauri::command]
pub fn stream_start(config: IcecastConfig, state: State<SharedAudioState>) -> Result<String, String> {
    if STREAMING.load(Ordering::Relaxed) {
        return Err("Already streaming".to_string());
    }
    STREAMING.store(true, Ordering::Relaxed);
    
    // Notify audio thread to start streaming
    if let Ok(audio) = state.inner().lock() {
        audio.sender.send(crate::audio::AudioCmd::StartStream {
            server: config.server,
            port: config.port,
            mount: config.mount,
            password: config.password,
            station_name: config.station_name,
        }).map_err(|e| e.to_string())?;
    }
    
    Ok("Streaming started".to_string())
}

#[tauri::command]
pub fn stream_stop(state: State<SharedAudioState>) -> Result<String, String> {
    STREAMING.store(false, Ordering::Relaxed);
    if let Ok(audio) = state.inner().lock() {
        audio.sender.send(crate::audio::AudioCmd::StopStream).map_err(|e| e.to_string())?;
    }
    Ok("Streaming stopped".to_string())
}

#[tauri::command]
pub fn stream_status() -> bool {
    STREAMING.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn stream_update_metadata(title: String, artist: String, state: State<SharedAudioState>) -> Result<String, String> {
    if let Ok(audio) = state.inner().lock() {
        audio.sender.send(crate::audio::AudioCmd::UpdateMetadata { title, artist }).map_err(|e| e.to_string())?;
    }
    Ok("ok".to_string())
}

#[tauri::command]
pub fn backup_db(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    // Source DB path
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_path = app_dir.join("openair.db");

    // Backup dir
    let backup_dir = app_dir.join("backups");
    std::fs::create_dir_all(&backup_dir).map_err(|e| e.to_string())?;

    // Create timestamped backup
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let backup_name = format!("openair-backup-{}.db", timestamp);
    let backup_path = backup_dir.join(&backup_name);

    std::fs::copy(&db_path, &backup_path).map_err(|e| e.to_string())?;

    // 7-day rotation: delete backups older than 7 days
    let cutoff = timestamp - (7 * 24 * 3600);
    if let Ok(entries) = std::fs::read_dir(&backup_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("openair-backup-") && name.ends_with(".db") {
                if let Some(ts_str) = name.strip_prefix("openair-backup-").and_then(|s| s.strip_suffix(".db")) {
                    if let Ok(ts) = ts_str.parse::<u64>() {
                        if ts < cutoff {
                            let _ = std::fs::remove_file(entry.path());
                        }
                    }
                }
            }
        }
    }

    Ok(backup_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn list_backups(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    use tauri::Manager;
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let backup_dir = app_dir.join("backups");
    if !backup_dir.exists() { return Ok(vec![]); }

    let mut backups: Vec<String> = std::fs::read_dir(&backup_dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("openair-backup-"))
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    backups.sort_by(|a, b| b.cmp(a)); // newest first
    Ok(backups)
}

#[tauri::command]
pub fn restore_db(backup_name: String, app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let backup_path = app_dir.join("backups").join(&backup_name);
    let db_path = app_dir.join("openair.db");

    if !backup_path.exists() {
        return Err("Backup file not found".to_string());
    }

    // Copy backup over current DB
    std::fs::copy(&backup_path, &db_path).map_err(|e| e.to_string())?;
    Ok("Restored successfully. Please restart Ether.".to_string())
}

#[tauri::command]
pub fn update_now_playing(
    title: String,
    artist: String,
    is_playing: bool,
    tunein_station_id: Option<String>,
    tunein_partner_id: Option<String>,
    tunein_partner_key: Option<String>,
    now_playing: State<crate::dashboard::SharedNowPlaying>,
) -> Result<String, String> {
    // Update shared state for /now-playing.json endpoint
    if let Ok(mut np) = now_playing.inner().lock() {
        np.title = title.clone();
        np.artist = artist.clone();
        np.is_playing = is_playing;
        np.updated_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
    }
    Ok("ok".to_string())
}

#[tauri::command]
pub fn open_sound_settings() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("ms-settings:sound")
            .spawn()
            .or_else(|_| std::process::Command::new("mmsys.cpl").spawn())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_levels(state: State<SharedAudioState>) -> Result<serde_json::Value, String> {
    let mut audio = state.inner().lock().map_err(|e| e.to_string())?;
    // Request level update
    audio.sender.send(crate::audio::AudioCmd::GetLevel).map_err(|e| e.to_string())?;
    // Read current levels
    let (la, lb) = if let Ok(lvl) = audio.levels.lock() {
        (lvl.level_a, lvl.level_b)
    } else { (0.0, 0.0) };
    Ok(serde_json::json!({ "a": la, "b": lb }))
}
