#![deny(clippy::all)]
#![allow(clippy::unused_unit)]

mod audio;
mod audio_engine;
mod audio_routing;
pub mod eq;
mod lufs;
mod clock;
mod program_processor;   // Audio Processing v1 — per-station program-bus loudness (bench-gated before ship)

use napi_derive::napi;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use audio::{AudioCmd, AudioState, SharedAudioState, DeckMeta, start_station_mixer};

// Per-station audio engine map. Keyed by station_id (u32).
// OnceLock holds the Map itself; individual engine Arcs are cloned out on access.
static ENGINES: std::sync::OnceLock<Mutex<HashMap<u32, SharedAudioState>>> =
    std::sync::OnceLock::new();

// Returns the engine for station_id, creating it lazily if it doesn't exist.
// All NAPI functions call this — no panics on first reference to a new station.
fn get_or_create_engine(station_id: u32, device_name: Option<String>) -> SharedAudioState {
    let engines = ENGINES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = engines.lock().unwrap();
    if !map.contains_key(&station_id) {
        let (sender, is_playing, levels, finished, program_bus_port, delay) =
            start_station_mixer(station_id, device_name);
        let state: SharedAudioState = Arc::new(Mutex::new(AudioState {
            deck_a: DeckMeta::new(),
            deck_b: DeckMeta::new(),
            deck_c: DeckMeta::new(),
            deck_d: DeckMeta::new(),
            deck_e: DeckMeta::new(),
            deck_f: DeckMeta::new(),
            deck_cart: DeckMeta::new(),
            sender,
            is_playing,
            levels,
            delay,
            finished,
            watchdog_active: false,
            watchdog_threshold_sec: 10.0,
            watchdog_triggered_count: 0,
            program_bus_port,
        }));
        map.insert(station_id, state);
    }
    map.get(&station_id).cloned().unwrap()
}

#[napi]
pub fn init_audio_engine(station_id: Option<u32>) -> bool {
    get_or_create_engine(station_id.unwrap_or(1), None);
    true
}

#[napi]
pub fn audio_load(deck: String, file_path: String, title: String, artist: String, gain_db: Option<f64>, station_id: Option<u32>) -> bool {
    let engine = get_or_create_engine(station_id.unwrap_or(1), None);
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

/// Returns FALSE — without claiming "playing" — when the deck has nothing to play.
///
/// Before 2026-07-31 this set status="playing" unconditionally and returned is_ok() of the send, which
/// is true even when the audio thread then skips the play (`source=None, path empty — skipping`). A
/// hand-pressed play on an empty deck produced dead air while every layer above reported success: the
/// deck meta said playing, the daemon said ok, and the UI drew a playing deck. Silence that claims to be
/// audio is the worst failure this engine can have, so the refusal is now a VALUE the caller can see.
///
/// `file_path` is the honest signal: audio_stop clears it (below) exactly when it drops the sink and the
/// loaded file, so "no file_path" means "no content on this deck" and nothing else.
#[napi]
pub fn audio_play(deck: String, station_id: Option<u32>) -> bool {
    let engine = get_or_create_engine(station_id.unwrap_or(1), None);
    let Ok(mut audio) = engine.lock() else { return false };
    if deck_meta_mut(&mut audio, &deck).file_path.is_empty() {
        eprintln!("[RUST] Play deck {}: REFUSED — no content loaded on this deck", deck);
        return false;   // status is NOT set to "playing": nothing above may claim it is
    }
    audio.finished.clear(&deck);
    deck_meta_mut(&mut audio, &deck).status = "playing".to_string();
    audio.sender.send(AudioCmd::Play(deck)).is_ok()
}

#[napi]
pub fn audio_pause(deck: String, station_id: Option<u32>) -> bool {
    let engine = get_or_create_engine(station_id.unwrap_or(1), None);
    let Ok(mut audio) = engine.lock() else { return false };
    deck_meta_mut(&mut audio, &deck).status = "paused".to_string();
    audio.sender.send(AudioCmd::Pause(deck)).is_ok()
}

#[napi]
pub fn audio_stop(deck: String, station_id: Option<u32>) -> bool {
    let engine = get_or_create_engine(station_id.unwrap_or(1), None);
    let Ok(mut audio) = engine.lock() else { return false };
    audio.finished.clear(&deck);
    {
        // AudioCmd::Stop drops the sink AND loaded_files, so the deck genuinely has no content
        // afterwards. Clear file_path to match (2026-07-31) — it is what audio_play now trusts, and a
        // stale path here would let a play claim success on a deck Rust would silently skip.
        let m = deck_meta_mut(&mut audio, &deck);
        m.status = "idle".to_string();
        m.file_path = String::new();
    }
    audio.sender.send(AudioCmd::Stop(deck)).is_ok()
}

#[napi]
pub fn audio_set_volume(deck: String, volume: f64, station_id: Option<u32>) -> bool {
    let engine = get_or_create_engine(station_id.unwrap_or(1), None);
    let Ok(mut audio) = engine.lock() else { return false };
    deck_meta_mut(&mut audio, &deck).volume = volume as f32;
    audio.sender.send(AudioCmd::SetVolume { deck, volume: volume as f32 }).is_ok()
}

/// CHANNEL ON/OFF for one mixer slot — a console channel cut, like the OFF button on a Wheatstone
/// aux. muted=true means this channel contributes NOTHING to the program bus: a jingle or cart fired
/// into a cut channel never reaches air. It is NOT a fader position and NOT a transport state, and it
/// deliberately survives `Load` — expressing this as volume 0 does not work, because Load rewrites
/// `volume` on every cart fire and would silently re-open the channel.
#[napi]
pub fn audio_set_muted(deck: String, muted: bool, station_id: Option<u32>) -> bool {
    let engine = get_or_create_engine(station_id.unwrap_or(1), None);
    let Ok(mut audio) = engine.lock() else { return false };
    deck_meta_mut(&mut audio, &deck).muted = muted;
    audio.sender.send(AudioCmd::SetMuted { deck, muted }).is_ok()
}

/// DUCKER (slice 3) — arm or disarm one channel's duck.
///
/// When an armed SOURCE channel has audio, the programme ducks under it and rises back when it
/// stops: nothing is stopped and nothing is started, so the song continues underneath and returns
/// mid-song. Only SOURCE slots can duck; the mixer callback reads the slot's kind, so arming a
/// rotation deck or CART stores the preference and never fires — a sweeper must never duck the song
/// it is sweeping into.
#[napi]
pub fn audio_set_duck(station_id: u32, deck: String, enabled: bool) -> bool {
    let engine = get_or_create_engine(station_id, None);
    let Ok(audio) = engine.lock() else { return false };
    audio.sender.send(AudioCmd::SetDuck { deck, enabled }).is_ok()
}

/// Local studio-monitor (speaker) gain for one station — 0.0 = silent speakers, 1.0 = unity.
/// Affects ONLY the local device output; the program bus → Icecast stream is untouched, so an
/// operator can mute/blend what they HEAR without changing what any station BROADCASTS.
#[napi]
pub fn audio_set_monitor_volume(station_id: u32, volume: f64) -> bool {
    let engine = get_or_create_engine(station_id, None);
    let Ok(audio) = engine.lock() else { return false };
    audio.sender.send(AudioCmd::SetMonitorVolume(volume as f32)).is_ok()
}

/// MASTER OUT — the broadcast gain for this station. Rides the program bus pre-meter, so it changes
/// what listeners hear and the master VU follows. Distinct from audio_set_monitor_volume, which trims
/// only the room speakers and never touches air. docs/master-monitor-faders-dead-2026-08-06.md
#[napi]
pub fn audio_set_master_volume(station_id: u32, volume: f64) -> bool {
    let engine = get_or_create_engine(station_id, None);
    let Ok(audio) = engine.lock() else { return false };
    audio.sender.send(AudioCmd::SetMasterVolume(volume as f32)).is_ok()
}

/// MASTER MONITOR — the operator's ONE room level, applied to THIS station's bus. Per-station by law
/// (DESIGN-TRUTH §2); main fans the single fader out across every station. Local-only, never airs.
#[napi]
pub fn audio_set_master_monitor_volume(station_id: u32, volume: f64) -> bool {
    let engine = get_or_create_engine(station_id, None);
    let Ok(audio) = engine.lock() else { return false };
    audio.sender.send(AudioCmd::SetMasterMonitorVolume(volume as f32)).is_ok()
}

// Audio Processing v1 — set this station's program-bus processing (both toggles default OFF; the daemon
// delivers this like the segue setting on connect + respawn). Meters come back via audio_get_level (AudioLevels).
#[napi]
pub fn audio_set_processing(station_id: u32, process_local: bool, process_stream: bool, target_lufs: f64) -> bool {
    let engine = get_or_create_engine(station_id, None);
    let Ok(audio) = engine.lock() else { return false };
    audio.sender.send(AudioCmd::SetProcessing { local: process_local, stream: process_stream, target_lufs: target_lufs as f32 }).is_ok()
}

#[napi]
pub fn audio_get_state(station_id: Option<u32>) -> String {
    let engine = get_or_create_engine(station_id.unwrap_or(1), None);
    let Ok(mut audio) = engine.lock() else {
        return r#"{"deckA":{},"deckB":{},"deckC":{}}"#.to_string();
    };
    let fin_a = audio.finished.take("A");
    let fin_b = audio.finished.take("B");
    let fin_c = audio.finished.take("C");
    let fin_d = audio.finished.take("D");
    let fin_e = audio.finished.take("E");
    let fin_f = audio.finished.take("F");
    let fin_cart = audio.finished.take("CART");
    if fin_a { audio.deck_a.status = "ended".to_string(); }
    if fin_b { audio.deck_b.status = "ended".to_string(); }
    if fin_c { audio.deck_c.status = "ended".to_string(); }
    if fin_d { audio.deck_d.status = "ended".to_string(); }
    if fin_e { audio.deck_e.status = "ended".to_string(); }
    if fin_f { audio.deck_f.status = "ended".to_string(); }
    if fin_cart { audio.deck_cart.status = "ended".to_string(); }
    serde_json::json!({
        "deckA": audio.deck_a.info("A", fin_a),
        "deckB": audio.deck_b.info("B", fin_b),
        "deckC": audio.deck_c.info("C", fin_c),
        "deckD": audio.deck_d.info("D", fin_d),
        "deckE": audio.deck_e.info("E", fin_e),
        "deckF": audio.deck_f.info("F", fin_f),
        "deckCart": audio.deck_cart.info("CART", fin_cart),
    }).to_string()
}

#[napi]
pub fn audio_get_levels(station_id: Option<u32>) -> String {
    let levels_arc = {
        let engine = get_or_create_engine(station_id.unwrap_or(1), None);
        let Ok(audio) = engine.lock() else {
            return r#"{"a":0,"b":0,"c":0}"#.to_string();
        };
        let _ = audio.sender.send(AudioCmd::GetLevel);
        audio.levels.clone()
    };
    // v4.4.46: also surface the mix-telemetry the GetLevel handler now snapshots into AudioLevels
    // (frames_total / active_decks / mon_vol / per-deck), so the daemon's `[mix sN]` heartbeat can
    // read it off the existing getLevels call. Additive JSON fields — existing consumers (renderer
    // VU: a/b/c/master) ignore the extra keys; no behaviour change.
    // ── Audio Processing meters (2026-07-31) ──────────────────────────────────────────────────────
    // These eight fields were computed by the DSP, published to AudioLevels by the audio thread
    // (audio.rs:850-857) — and then DROPPED HERE, because this function hand-builds its JSON from an
    // explicit field list rather than serializing the struct. So `proc_local` never reached JS, the
    // daemon's _emitProcMeters returned at `if (!lv.proc_local …)` on every frame, and the Settings
    // panel read "waiting for audio" forever. The processing itself was running; only its meters were
    // blind. Adding a field to AudioLevels is NOT enough — it has to be named here too.
    let (la, lb, lc, lcart, lmaster, lroom, auxframes, auxpeak, auxin, auxout, auxgr, auxride, frames, active, mon, decks,
         p_local, p_stream, p_target, p_in_lufs, p_out_lufs, p_gr, p_in_peak, p_out_peak, p_ride) = match levels_arc.lock() {
        Ok(lvl) => (lvl.level_a, lvl.level_b, lvl.level_c, lvl.level_cart, lvl.level_master, lvl.level_room, lvl.aux_frames, lvl.aux_peak, lvl.aux_proc_in_lufs, lvl.aux_proc_out_lufs, lvl.aux_proc_gr_db, lvl.aux_proc_ride_db,
                    lvl.frames_total, lvl.active_decks, lvl.mon_vol, lvl.decks.clone(),
                    lvl.proc_local, lvl.proc_stream, lvl.proc_target_lufs,
                    lvl.proc_in_lufs, lvl.proc_out_lufs, lvl.proc_gr_db,
                    lvl.proc_in_peak, lvl.proc_out_peak, lvl.proc_ride_gain_db),
        Err(_)  => (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0u64, 0.0f32, -70.0f32, -70.0f32, 0.0f32, 0.0f32, 0u64, 0u32, 0.0f32, Vec::new(),
                    false, false, -14.0f32, -70.0f32, -70.0f32, 0.0f32, 0.0f32, 0.0f32, 0.0f32),
    };
    serde_json::json!({
        "a": la, "b": lb, "c": lc, "cart": lcart, "master": lmaster, "room": lroom, "aux_frames": auxframes, "aux_peak": auxpeak,
        "aux_proc_in_lufs": auxin, "aux_proc_out_lufs": auxout, "aux_proc_gr_db": auxgr, "aux_proc_ride_db": auxride,
        "frames_total": frames, "active_decks": active, "mon_vol": mon, "decks": decks,
        "proc_local": p_local, "proc_stream": p_stream, "proc_target_lufs": p_target,
        "proc_in_lufs": p_in_lufs, "proc_out_lufs": p_out_lufs, "proc_gr_db": p_gr,
        "proc_in_peak": p_in_peak, "proc_out_peak": p_out_peak, "proc_ride_gain_db": p_ride
    }).to_string()
}

/// 10-band post-EQ master spectrum (0..~1 normalized magnitude), for the Master EQ
/// rack's live FFT display. Mirrors audio_get_levels: nudges the audio thread to
/// refresh AudioLevels (GetLevel also copies the latest bus spectrum) then reads it.
/// Returns a JSON array of 10 floats, e.g. "[0.12,0.34,...]".
#[napi]
pub fn audio_get_spectrum(station_id: Option<u32>) -> String {
    let levels_arc = {
        let engine = get_or_create_engine(station_id.unwrap_or(1), None);
        let Ok(audio) = engine.lock() else {
            return "[0,0,0,0,0,0,0,0,0,0]".to_string();
        };
        let _ = audio.sender.send(AudioCmd::GetLevel);
        audio.levels.clone()
    };
    let spec: [f32; 10] = match levels_arc.lock() {
        Ok(lvl) => lvl.spectrum,
        Err(_)  => [0.0; 10],
    };
    serde_json::to_string(&spec).unwrap_or_else(|_| "[0,0,0,0,0,0,0,0,0,0]".to_string())
}

// ── Broadcast (profanity) delay + dump ────────────────────────────────────────
// Arms/sets the stream delay in seconds (0 = off). The delay lives on the stream path
// only; the local monitor stays live so the operator can DUMP before audio airs.
#[napi]
pub fn audio_set_broadcast_delay(seconds: f64, station_id: Option<u32>) -> bool {
    let engine = get_or_create_engine(station_id.unwrap_or(1), None);
    let Ok(audio) = engine.lock() else { return false };
    let samples = (seconds.max(0.0) * 44100.0 * 2.0) as usize;
    audio.delay.target_samples.store(samples, std::sync::atomic::Ordering::Relaxed);
    true
}

// One-shot DUMP: flush the buffered (not-yet-aired) audio and splice the stream to live.
// The delay stays ARMED — the drain rebuilds the cushion back to target imperceptibly
// (resampling through quiet), so no manual re-arm is needed (Phase 2).
#[napi]
pub fn audio_dump(station_id: Option<u32>) -> bool {
    let engine = get_or_create_engine(station_id.unwrap_or(1), None);
    let Ok(audio) = engine.lock() else { return false };
    audio.delay.dump_flag.store(true, std::sync::atomic::Ordering::Relaxed);
    true
}

#[napi]
pub fn audio_broadcast_delay_state(station_id: Option<u32>) -> String {
    let engine = get_or_create_engine(station_id.unwrap_or(1), None);
    let Ok(audio) = engine.lock() else {
        return r#"{"armed":false,"delaySec":0,"bufferedSec":0,"fillPct":0}"#.to_string();
    };
    use std::sync::atomic::Ordering::Relaxed;
    let target   = audio.delay.target_samples.load(Relaxed);
    let buffered = audio.delay.buffered_samples.load(Relaxed);
    let per_sec  = 44100.0 * 2.0;
    let fill = if target > 0 { (buffered as f64 / target as f64).min(1.0) } else { 0.0 };
    serde_json::json!({
        "armed": target > 0,
        "delaySec": target as f64 / per_sec,
        "bufferedSec": buffered as f64 / per_sec,
        "fillPct": fill,
    }).to_string()
}

// Epoch ms of station_id's most recent audio output callback (that station's
// engine-thread liveness), or 0 if it has never produced a callback / is unknown.
// Per-station: a wedged station reads stale here even while siblings keep airing —
// the single global clock this replaced masked exactly that. stationId defaults to
// 1 for legacy zero-arg callers. f64 (not i64) so it crosses the napi bridge as a
// plain JS number, not a BigInt.
#[napi]
pub fn audio_last_callback_ms(station_id: Option<u32>) -> f64 {
    audio::last_audio_callback_ms(station_id.unwrap_or(1))
}

#[napi]
pub fn watchdog_set(active: bool, threshold_sec: f64, station_id: Option<u32>) -> bool {
    let engine = get_or_create_engine(station_id.unwrap_or(1), None);
    let Ok(mut audio) = engine.lock() else { return false };
    audio.watchdog_active = active;
    audio.watchdog_threshold_sec = threshold_sec;
    true
}

#[napi]
pub fn audio_list_output_devices() -> String {
    use cpal::traits::{HostTrait, DeviceTrait};
    let host = cpal::default_host();
    let mut names: Vec<String> = vec![];
    if let Ok(devices) = host.output_devices() {
        for device in devices {
            if let Ok(name) = device.name() {
                names.push(name);
            }
        }
    }
    serde_json::to_string(&names).unwrap_or_else(|_| "[]".to_string())
}

#[napi]
pub fn audio_set_output_device(station_id: u32, device_name: String) -> bool {
    let engines = ENGINES.get_or_init(|| Mutex::new(HashMap::new()));
    let engine_opt = {
        let map = engines.lock().unwrap();
        map.get(&station_id).cloned()
    };
    if let Some(state) = engine_opt {
        if let Ok(audio) = state.lock() {
            return audio.sender.send(AudioCmd::SwitchDevice(device_name)).is_ok();
        }
    }
    get_or_create_engine(station_id, Some(device_name));
    true
}

// Per-station output recovery (DESIGN-TRUTH §2): reopen ONLY station_id's cpal output
// stream on its current device — automates the manual automation toggle, scoped to one
// card, without touching sibling stations. Returns false if the station has no engine.
#[napi]
pub fn audio_reopen_output(station_id: Option<u32>) -> bool {
    let sid = station_id.unwrap_or(1);
    let Some(engines) = ENGINES.get() else { return false };
    let engine_opt = { engines.lock().ok().and_then(|m| m.get(&sid).cloned()) };
    match engine_opt {
        Some(state) => match state.lock() {
            Ok(audio) => audio.sender.send(AudioCmd::ReopenOutput).is_ok(),
            Err(_) => false,
        },
        None => false,
    }
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

#[napi]
pub fn audio_get_program_bus_port(station_id: u32) -> u32 {
    let engine = get_or_create_engine(station_id, None);
    let Ok(audio) = engine.lock() else { return 0 };
    audio.program_bus_port as u32
}

/// AUX MONITOR OUTPUT DEVICE — where the aux bus is heard. Empty string = NONE = the aux stream is
/// closed and the bus is silent.
///
/// This is a SECOND output stream per station, opened only when an operator picks a device, and it is
/// deliberately the only way aux audio leaves the machine. It never falls back to the system default:
/// substituting an output nobody chose is unsafe on a broadcast machine (the "default" could be the
/// very speakers feeding a mic). A named device that is absent stays unopened and the bus stays quiet.
#[napi]
pub fn audio_set_aux_device(station_id: u32, device_name: String) -> bool {
    let engine = get_or_create_engine(station_id, None);
    let Ok(audio) = engine.lock() else { return false };
    audio.sender.send(AudioCmd::SetAuxDevice(device_name)).is_ok()
}

/// AUX MONITOR LEVEL — the ROOM level for one aux deck (D/E/F), 0.0 = silent locally.
///
/// "Slot = room, board = air" (Jeff, 2026-08-18). The AUX monitor slots are the ONLY way decks D/E/F
/// are heard on the local speakers: they are excluded from the room sum entirely and re-enter it only
/// through this gain, taken PRE-CUT and PRE-FADER so the board's channel switch cannot silence the
/// room. Air is untouched — those decks stay in the programme bus, fully EQ'd and processed.
///
/// Rejected for any deck that is not D/E/F: A/B/C and CART are board channels and their local
/// monitoring is unchanged by this feature.
#[napi]
pub fn audio_set_aux_monitor(station_id: u32, deck: String, gain: f64) -> bool {
    let engine = get_or_create_engine(station_id, None);
    let Ok(audio) = engine.lock() else { return false };
    audio.sender.send(AudioCmd::SetAuxMonitor { deck, gain: gain as f32 }).is_ok()
}

#[napi]
pub fn audio_set_eq(station_id: u32, bands_json: String) -> bool {
    let gains: Vec<f32> = match serde_json::from_str(&bands_json) {
        Ok(b)  => b,
        Err(e) => { eprintln!("[RUST] audio_set_eq parse error: {}", e); return false; }
    };
    let engine = get_or_create_engine(station_id, None);
    let Ok(audio) = engine.lock() else { return false };
    let _ = audio.sender.send(AudioCmd::SetEq(gains));
    true
}

fn deck_meta_mut<'a>(audio: &'a mut AudioState, deck: &str) -> &'a mut DeckMeta {
    match deck {
        "A" => &mut audio.deck_a,
        "C" => &mut audio.deck_c,
        "D" => &mut audio.deck_d,
        "E" => &mut audio.deck_e,
        "F" => &mut audio.deck_f,
        "CART" => &mut audio.deck_cart,
        _   => &mut audio.deck_b,
    }
}
