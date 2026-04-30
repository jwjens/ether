#![deny(clippy::all)]
#![allow(clippy::unused_unit)]

mod audio;
mod audio_engine;
mod audio_routing;
mod lufs;
mod clock;

use napi_derive::napi;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use audio::{AudioCmd, AudioState, SharedAudioState, DeckMeta, start_audio_thread};

// Per-station audio engine map. Keyed by station_id (u32).
// OnceLock holds the Map itself; individual engine Arcs are cloned out on access.
static ENGINES: std::sync::OnceLock<Mutex<HashMap<u32, SharedAudioState>>> =
    std::sync::OnceLock::new();

// Returns the engine for station_id, creating it lazily if it doesn't exist.
// All NAPI functions call this — no panics on first reference to a new station.
fn get_or_create_engine(station_id: u32) -> SharedAudioState {
    let engines = ENGINES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = engines.lock().unwrap();
    if !map.contains_key(&station_id) {
        let (sender, is_playing, levels, finished) = start_audio_thread(station_id);
        let state: SharedAudioState = Arc::new(Mutex::new(AudioState {
            deck_a: DeckMeta::new(),
            deck_b: DeckMeta::new(),
            deck_c: DeckMeta::new(),
            sender,
            is_playing,
            levels,
            finished,
            watchdog_active: false,
            watchdog_threshold_sec: 10.0,
            watchdog_triggered_count: 0,
        }));
        map.insert(station_id, state);
    }
    map.get(&station_id).cloned().unwrap()
}

#[napi]
pub fn init_audio_engine(station_id: Option<u32>) -> bool {
    get_or_create_engine(station_id.unwrap_or(1));
    true
}

#[napi]
pub fn audio_load(deck: String, file_path: String, title: String, artist: String, gain_db: Option<f64>, station_id: Option<u32>) -> bool {
    let engine = get_or_create_engine(station_id.unwrap_or(1));
    let Ok(mut audio) = engine.lock() else { return false };
    let g = gain_db.unwrap_or(0.0) as f32;
    {
        let meta = deck_meta_mut(&mut audio, &deck);
        meta.title = title.clone();
        meta.artist = artist.clone();
        meta.file_path = file_path.clone();
        meta.status = "idle".to_string();
        meta.gain_db = g;
    }
    audio.sender.send(AudioCmd::Load { deck, file_path, title, artist, gain_db: g }).is_ok()
}

#[napi]
pub fn audio_play(deck: String, station_id: Option<u32>) -> bool {
    let engine = get_or_create_engine(station_id.unwrap_or(1));
    let Ok(mut audio) = engine.lock() else { return false };
    audio.finished.clear(&deck);
    deck_meta_mut(&mut audio, &deck).status = "playing".to_string();
    audio.sender.send(AudioCmd::Play(deck)).is_ok()
}

#[napi]
pub fn audio_pause(deck: String, station_id: Option<u32>) -> bool {
    let engine = get_or_create_engine(station_id.unwrap_or(1));
    let Ok(mut audio) = engine.lock() else { return false };
    deck_meta_mut(&mut audio, &deck).status = "paused".to_string();
    audio.sender.send(AudioCmd::Pause(deck)).is_ok()
}

#[napi]
pub fn audio_stop(deck: String, station_id: Option<u32>) -> bool {
    let engine = get_or_create_engine(station_id.unwrap_or(1));
    let Ok(mut audio) = engine.lock() else { return false };
    audio.finished.clear(&deck);
    deck_meta_mut(&mut audio, &deck).status = "idle".to_string();
    audio.sender.send(AudioCmd::Stop(deck)).is_ok()
}

#[napi]
pub fn audio_set_volume(deck: String, volume: f64, station_id: Option<u32>) -> bool {
    let engine = get_or_create_engine(station_id.unwrap_or(1));
    let Ok(mut audio) = engine.lock() else { return false };
    deck_meta_mut(&mut audio, &deck).volume = volume as f32;
    audio.sender.send(AudioCmd::SetVolume { deck, volume: volume as f32 }).is_ok()
}

#[napi]
pub fn audio_get_state(station_id: Option<u32>) -> String {
    let engine = get_or_create_engine(station_id.unwrap_or(1));
    let Ok(mut audio) = engine.lock() else {
        return r#"{"deckA":{},"deckB":{},"deckC":{}}"#.to_string();
    };
    let fin_a = audio.finished.take("A");
    let fin_b = audio.finished.take("B");
    let fin_c = audio.finished.take("C");
    if fin_a { audio.deck_a.status = "ended".to_string(); }
    if fin_b { audio.deck_b.status = "ended".to_string(); }
    if fin_c { audio.deck_c.status = "ended".to_string(); }
    serde_json::json!({
        "deckA": audio.deck_a.info("A", fin_a),
        "deckB": audio.deck_b.info("B", fin_b),
        "deckC": audio.deck_c.info("C", fin_c),
    }).to_string()
}

#[napi]
pub fn audio_get_levels(station_id: Option<u32>) -> String {
    let levels_arc = {
        let engine = get_or_create_engine(station_id.unwrap_or(1));
        let Ok(audio) = engine.lock() else {
            return r#"{"a":0,"b":0,"c":0}"#.to_string();
        };
        let _ = audio.sender.send(AudioCmd::GetLevel);
        audio.levels.clone()
    };
    let (la, lb, lc): (f32, f32, f32) = match levels_arc.lock() {
        Ok(lvl) => (lvl.level_a, lvl.level_b, lvl.level_c),
        Err(_)  => (0.0, 0.0, 0.0),
    };
    serde_json::json!({ "a": la, "b": lb, "c": lc }).to_string()
}

#[napi]
pub fn watchdog_set(active: bool, threshold_sec: f64, station_id: Option<u32>) -> bool {
    let engine = get_or_create_engine(station_id.unwrap_or(1));
    let Ok(mut audio) = engine.lock() else { return false };
    audio.watchdog_active = active;
    audio.watchdog_threshold_sec = threshold_sec;
    true
}

#[napi]
pub fn get_audio_devices() -> String {
    let devices = audio_engine::get_audio_devices();
    serde_json::to_string(&devices).unwrap_or_default()
}

#[napi]
pub fn build_peak_mipmap(file_path: String) -> String {
    match audio_engine::build_peak_mipmap(file_path) {
        Ok(v) => v.to_string(),
        Err(e) => format!("{{\"error\":\"{}\"}}", e),
    }
}

#[napi]
pub fn get_peaks_for_viewport(file_path: String, start_sec: f64, end_sec: f64, width_px: u32) -> String {
    match audio_engine::get_peaks_for_viewport(file_path, start_sec as f32, end_sec as f32, width_px as usize) {
        Ok(v) => serde_json::to_string(&v).unwrap_or_default(),
        Err(_) => "[]".to_string(),
    }
}

#[napi]
pub fn analyze_song(file_path: String) -> String {
    match audio_engine::analyze_song(file_path) {
        Ok(r) => serde_json::to_string(&r).unwrap_or_default(),
        Err(e) => format!("{{\"error\":\"{}\"}}", e),
    }
}

#[napi]
pub fn measure_song_loudness(file_path: String) -> String {
    match audio_engine::measure_song_loudness(file_path) {
        Ok(r) => serde_json::to_string(&r).unwrap_or_default(),
        Err(e) => format!("{{\"error\":\"{}\"}}", e),
    }
}

#[napi]
pub fn detect_song_bpm(file_path: String) -> String {
    match audio_engine::detect_song_bpm(file_path) {
        Ok(r) => serde_json::to_string(&r).unwrap_or_default(),
        Err(e) => format!("{{\"error\":\"{}\"}}", e),
    }
}

#[napi]
pub fn detect_song_cue_points(file_path: String) -> String {
    match audio_engine::detect_song_cue_points(file_path) {
        Ok(r) => serde_json::to_string(&r).unwrap_or_default(),
        Err(e) => format!("{{\"error\":\"{}\"}}", e),
    }
}

#[napi]
pub fn get_file_duration(file_path: String) -> f64 {
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;
    use std::fs::File;
    let Ok(file) = File::open(&file_path) else { return 0.0 };
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = std::path::Path::new(&file_path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let Ok(probed) = symphonia::default::get_probe().format(
        &hint, mss, &FormatOptions::default(), &MetadataOptions::default()
    ) else { return 0.0 };
    if let Some(track) = probed.format.default_track() {
        let p = &track.codec_params;
        if let (Some(n), Some(sr)) = (p.n_frames, p.sample_rate) {
            return n as f64 / sr as f64;
        }
    }
    0.0
}

#[napi]
pub fn analyze_lufs(file_path: String) -> f64 {
    lufs::analyze_file(&file_path).unwrap_or(-14.0)
}

#[napi]
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

#[napi]
pub fn open_url(url: String) -> bool {
    #[cfg(target_os = "windows")]
    return std::process::Command::new("cmd").args(["/c", "start", "", &url]).spawn().is_ok();
    #[cfg(target_os = "macos")]
    return std::process::Command::new("open").arg(&url).spawn().is_ok();
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    return std::process::Command::new("xdg-open").arg(&url).spawn().is_ok();
}

#[napi]
pub fn open_sound_settings() -> bool {
    #[cfg(target_os = "windows")]
    return std::process::Command::new("ms-settings:sound").spawn()
        .or_else(|_| std::process::Command::new("mmsys.cpl").spawn())
        .is_ok();
    #[cfg(target_os = "macos")]
    return std::process::Command::new("open")
        .arg("/System/Library/PreferencePanes/Sound.prefPane")
        .spawn()
        .is_ok();
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    return std::process::Command::new("pavucontrol").spawn()
        .or_else(|_| std::process::Command::new("gnome-control-center").args(["sound"]).spawn())
        .is_ok();
}

fn deck_meta_mut<'a>(audio: &'a mut AudioState, deck: &str) -> &'a mut DeckMeta {
    match deck {
        "A" => &mut audio.deck_a,
        "C" => &mut audio.deck_c,
        _   => &mut audio.deck_b,
    }
}
