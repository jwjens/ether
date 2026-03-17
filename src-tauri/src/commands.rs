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
