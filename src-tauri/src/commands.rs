use crate::audio::{AudioCmd, SharedAudioState};
use tauri::State;

fn deck_meta_mut<'a>(audio: &'a mut crate::audio::AudioState, deck: &str) -> &'a mut crate::audio::DeckMeta {
    match deck {
        "A" => &mut audio.deck_a,
        "C" => &mut audio.deck_c,
        _   => &mut audio.deck_b,
    }
}

#[tauri::command]
pub fn audio_load(deck: String, file_path: String, title: String, artist: String, gain_db: Option<f64>, state: State<SharedAudioState>) -> Result<String, String> {
    let mut audio = state.inner().lock().map_err(|e| e.to_string())?;
    let meta = deck_meta_mut(&mut audio, &deck);
    meta.title = title.clone();
    meta.artist = artist.clone();
    meta.file_path = file_path.clone();
    meta.status = "idle".to_string();
    meta.gain_db = gain_db.unwrap_or(0.0) as f32;
    audio.sender.send(AudioCmd::Load { deck, file_path, title, artist, gain_db: gain_db.unwrap_or(0.0) as f32 }).map_err(|e| e.to_string())?;
    Ok("ok".to_string())
}

#[tauri::command]
pub fn audio_play(deck: String, state: State<SharedAudioState>) -> Result<String, String> {
    let mut audio = state.inner().lock().map_err(|e| e.to_string())?;
    // Clear finished flag when explicitly played
    audio.finished.clear(&deck);
    let meta = deck_meta_mut(&mut audio, &deck);
    meta.status = "playing".to_string();
    audio.sender.send(AudioCmd::Play(deck)).map_err(|e| e.to_string())?;
    Ok("ok".to_string())
}

#[tauri::command]
pub fn audio_pause(deck: String, state: State<SharedAudioState>) -> Result<String, String> {
    let mut audio = state.inner().lock().map_err(|e| e.to_string())?;
    let meta = deck_meta_mut(&mut audio, &deck);
    meta.status = "paused".to_string();
    audio.sender.send(AudioCmd::Pause(deck)).map_err(|e| e.to_string())?;
    Ok("ok".to_string())
}

#[tauri::command]
pub fn audio_stop(deck: String, state: State<SharedAudioState>) -> Result<String, String> {
    let mut audio = state.inner().lock().map_err(|e| e.to_string())?;
    audio.finished.clear(&deck);
    let meta = deck_meta_mut(&mut audio, &deck);
    meta.status = "idle".to_string();
    audio.sender.send(AudioCmd::Stop(deck)).map_err(|e| e.to_string())?;
    Ok("ok".to_string())
}

#[tauri::command]
pub fn audio_set_volume(deck: String, volume: f32, state: State<SharedAudioState>) -> Result<String, String> {
    let mut audio = state.inner().lock().map_err(|e| e.to_string())?;
    let meta = deck_meta_mut(&mut audio, &deck);
    meta.volume = volume;
    audio.sender.send(AudioCmd::SetVolume { deck, volume }).map_err(|e| e.to_string())?;
    Ok("ok".to_string())
}

#[tauri::command]
pub fn audio_get_state(state: State<SharedAudioState>) -> Result<serde_json::Value, String> {
    let mut audio = state.inner().lock().map_err(|e| e.to_string())?;

    // Atomically read-and-clear each finished flag
    let fin_a = audio.finished.take("A");
    let fin_b = audio.finished.take("B");
    let fin_c = audio.finished.take("C");

    if fin_a { audio.deck_a.status = "ended".to_string(); }
    if fin_b { audio.deck_b.status = "ended".to_string(); }
    if fin_c { audio.deck_c.status = "ended".to_string(); }

    Ok(serde_json::json!({
        "deckA": audio.deck_a.info("A", fin_a),
        "deckB": audio.deck_b.info("B", fin_b),
        "deckC": audio.deck_c.info("C", fin_c),
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
    if STREAMING.load(Ordering::Relaxed) { return Err("Already streaming".to_string()); }
    STREAMING.store(true, Ordering::Relaxed);
    if let Ok(audio) = state.inner().lock() {
        audio.sender.send(crate::audio::AudioCmd::StartStream {
            server: config.server, port: config.port, mount: config.mount,
            password: config.password, station_name: config.station_name,
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
pub fn stream_status() -> bool { STREAMING.load(Ordering::Relaxed) }

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
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_path = app_dir.join("openair.db");
    let backup_dir = app_dir.join("backups");
    std::fs::create_dir_all(&backup_dir).map_err(|e| e.to_string())?;
    let timestamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    let backup_name = format!("openair-backup-{}.db", timestamp);
    let backup_path = backup_dir.join(&backup_name);
    std::fs::copy(&db_path, &backup_path).map_err(|e| e.to_string())?;
    let cutoff = timestamp - (7 * 24 * 3600);
    if let Ok(entries) = std::fs::read_dir(&backup_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("openair-backup-") && name.ends_with(".db") {
                if let Some(ts_str) = name.strip_prefix("openair-backup-").and_then(|s| s.strip_suffix(".db")) {
                    if let Ok(ts) = ts_str.parse::<u64>() {
                        if ts < cutoff { let _ = std::fs::remove_file(entry.path()); }
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
    let mut backups: Vec<String> = std::fs::read_dir(&backup_dir).map_err(|e| e.to_string())?
        .flatten().filter(|e| e.file_name().to_string_lossy().starts_with("openair-backup-"))
        .map(|e| e.file_name().to_string_lossy().to_string()).collect();
    backups.sort_by(|a, b| b.cmp(a));
    Ok(backups)
}

#[tauri::command]
pub fn restore_db(backup_name: String, app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let backup_path = app_dir.join("backups").join(&backup_name);
    let db_path = app_dir.join("openair.db");
    if !backup_path.exists() { return Err("Backup file not found".to_string()); }
    std::fs::copy(&backup_path, &db_path).map_err(|e| e.to_string())?;
    Ok("Restored successfully. Please restart Ether.".to_string())
}

#[tauri::command]
pub fn update_now_playing(
    title: String, artist: String, is_playing: bool,
    tunein_station_id: Option<String>, tunein_partner_id: Option<String>, tunein_partner_key: Option<String>,
    now_playing: State<crate::dashboard::SharedNowPlaying>,
) -> Result<String, String> {
    if let Ok(mut np) = now_playing.inner().lock() {
        np.title = title.clone(); np.artist = artist.clone();
        np.is_playing = is_playing;
        np.updated_at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    }
    Ok("ok".to_string())
}

#[tauri::command]
pub fn open_sound_settings() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("ms-settings:sound").spawn()
            .or_else(|_| std::process::Command::new("mmsys.cpl").spawn())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_levels(state: State<SharedAudioState>) -> Result<serde_json::Value, String> {
    let audio = state.inner().lock().map_err(|e| e.to_string())?;
    audio.sender.send(crate::audio::AudioCmd::GetLevel).map_err(|e| e.to_string())?;
    let (la, lb, lc) = if let Ok(lvl) = audio.levels.lock() { (lvl.level_a, lvl.level_b, lvl.level_c) } else { (0.0, 0.0, 0.0) };
    Ok(serde_json::json!({ "a": la, "b": lb, "c": lc }))
}

#[tauri::command]
pub fn get_file_duration(file_path: String) -> Result<f64, String> {
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;
    use std::fs::File;
    let file = File::open(&file_path).map_err(|e| e.to_string())?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = std::path::Path::new(&file_path).extension().and_then(|e| e.to_str()) { hint.with_extension(ext); }
    let probed = symphonia::default::get_probe().format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default()).map_err(|e| e.to_string())?;
    let format = probed.format;
    if let Some(track) = format.default_track() {
        let params = &track.codec_params;
        if let (Some(n_frames), Some(sample_rate)) = (params.n_frames, params.sample_rate) {
            return Ok(n_frames as f64 / sample_rate as f64);
        }
        if let Some(dur) = params.time_base.and_then(|tb| params.n_frames.map(|n| (n as f64) * tb.numer as f64 / tb.denom as f64)) {
            return Ok(dur);
        }
    }
    Ok(0.0)
}
