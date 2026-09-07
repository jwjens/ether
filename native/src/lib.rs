// The levels payload is a 45-key json! object. The macro recurses once per key and the default
// recursion limit (128) is not enough; this is a compile-time expansion budget, not a runtime cost.
#![recursion_limit = "512"]
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

/// WHICH BUS a slot joins — set from deck_configs, so a sweeper channel's behaviour follows the
/// channel it is dialled to instead of being welded to slot 6. "sweeper" sums into the programme
/// with the music (ducked with it, cannot arm the duck, no aux tap, heard on the station monitor);
/// anything else is an ordinary aux/source channel. Carts never go on the sweeper bus — a cart is a
/// hand-fired rack on an aux channel, which is a different thing entirely.
#[napi]
pub fn audio_set_slot_kind(station_id: u32, deck: String, kind: String) -> bool {
    let engine = get_or_create_engine(station_id, None);
    let Ok(audio) = engine.lock() else { return false };
    audio.sender.send(AudioCmd::SetSlotKind { deck, kind }).is_ok()
}

/// RECEIVER SIDE — does this deck step back when a source ducks? Per station, per deck, operator's
/// choice. A source slot is never ducked regardless: that is structural, from the slot's kind.
#[napi]
pub fn audio_set_duckable(station_id: u32, deck: String, duckable: bool) -> bool {
    let engine = get_or_create_engine(station_id, None);
    let Ok(audio) = engine.lock() else { return false };
    audio.sender.send(AudioCmd::SetDuckable { deck, duckable }).is_ok()
}

/// DUCKER tuning for ONE station. Threshold arrives in dBFS and is converted to the linear peak the
/// detector compares against; everything else is as the operator sees it. One envelope per station
/// bus, so these are station-wide by construction — which is why they live in that station's
/// Preferences and not on a channel strip.
#[napi]
pub fn audio_set_duck_params(station_id: u32, depth_db: f64, threshold_db: f64,
                             attack_ms: f64, hold_ms: f64, release_ms: f64) -> bool {
    let engine = get_or_create_engine(station_id, None);
    let Ok(audio) = engine.lock() else { return false };
    audio.sender.send(AudioCmd::SetDuckParams {
        depth_db: depth_db as f32, threshold_db: threshold_db as f32,
        attack_ms: attack_ms as f32, hold_ms: hold_ms as f32, release_ms: release_ms as f32,
    }).is_ok()
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

/// The program processor's operator-settable parameters. Separate from audio_set_processing (toggles +
/// target) so an install that never calls this runs the shipped chain unchanged.
///
/// ride_bypass / limiter_bypass are TEST TOOLS: they reach the engine only through this call, are never
/// written to any settings store, and reset to false on construction — so a restart always ends with the
/// ceiling held (Jeff's ruling, 2026-09-07).
#[napi]
#[allow(clippy::too_many_arguments)]
/// `branch`: 0 = LOCAL (studio monitor), 1 = STREAM. Every parameter is independent per branch.
pub fn audio_set_processor_params(station_id: u32, branch: u32, target_lufs: f64, ceiling_dbtp: f64,
                                  release_ms: f64, ride_rate_db_s: f64, ride_clamp_db: f64) -> bool {
    let engine = get_or_create_engine(station_id, None);
    let Ok(audio) = engine.lock() else { return false };
    audio.sender.send(AudioCmd::SetProcessorParams {
        branch: branch as u8,
        target_lufs: target_lufs as f32,
        ceiling_dbtp: ceiling_dbtp as f32,
        release_ms: release_ms as f32,
        ride_rate_db_s: ride_rate_db_s as f32,
        ride_clamp_db: ride_clamp_db as f32,
    }).is_ok()
}

/// Bypass, on its own entry point. The daemon's periodic number re-assert calls the function ABOVE,
/// which has no bypass parameter to get wrong — that is why these are two functions and not one.
#[napi]
pub fn audio_set_processor_bypass(station_id: u32, branch: u32, ride_bypass: bool, limiter_bypass: bool) -> bool {
    let engine = get_or_create_engine(station_id, None);
    let Ok(audio) = engine.lock() else { return false };
    audio.sender.send(AudioCmd::SetProcessorBypass { branch: branch as u8, ride_bypass, limiter_bypass }).is_ok()
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
    // 2026-09-07 — AND IT HAPPENED AGAIN, to the six operator-parameter echo fields. They were added
    // to AudioLevels and assigned by the audio thread, and stopped here: the rack's BYPASS chip read a
    // key this function never emitted, so `!!undefined` fabricated `false` on every frame and the
    // control was dead for two releases. The warning above was already written, from the first time.
    // Anything added to AudioLevels must be destructured here AND named in the json! below.
    let (la, lb, lc, lcart, lmaster, lroom, auxframes, auxpeak, auxin, auxout, auxgr, auxride, frames, active, mon, decks,
         p_local, p_stream, p_target, p_in_lufs, p_out_lufs, p_gr, p_in_peak, p_out_peak, p_ride, duckg,
         p_ceiling, p_release, p_rate, p_clamp, p_ride_byp, p_lim_byp,
         s_in, s_out, s_gr, s_ride, s_inpk, s_outpk,
         s_target, s_ceiling, s_release, s_rate, s_clamp, s_ride_byp, s_lim_byp) = match levels_arc.lock() {
        Ok(lvl) => (lvl.level_a, lvl.level_b, lvl.level_c, lvl.level_cart, lvl.level_master, lvl.level_room, lvl.aux_frames, lvl.aux_peak, lvl.aux_proc_in_lufs, lvl.aux_proc_out_lufs, lvl.aux_proc_gr_db, lvl.aux_proc_ride_db,
                    lvl.frames_total, lvl.active_decks, lvl.mon_vol, lvl.decks.clone(),
                    lvl.proc_local, lvl.proc_stream, lvl.proc_target_lufs,
                    lvl.proc_in_lufs, lvl.proc_out_lufs, lvl.proc_gr_db,
                    lvl.proc_in_peak, lvl.proc_out_peak, lvl.proc_ride_gain_db, lvl.duck_gain,
                    lvl.proc_ceiling_dbtp, lvl.proc_release_ms, lvl.proc_ride_rate, lvl.proc_ride_clamp,
                    lvl.proc_ride_bypass, lvl.proc_limiter_bypass,
                    lvl.proc_stream_in_lufs, lvl.proc_stream_out_lufs, lvl.proc_stream_gr_db,
                    lvl.proc_stream_ride_gain_db, lvl.proc_stream_in_peak, lvl.proc_stream_out_peak,
                    lvl.proc_stream_target_lufs, lvl.proc_stream_ceiling_dbtp, lvl.proc_stream_release_ms,
                    lvl.proc_stream_ride_rate, lvl.proc_stream_ride_clamp,
                    lvl.proc_stream_ride_bypass, lvl.proc_stream_limiter_bypass),
        Err(_)  => (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0u64, 0.0f32, -70.0f32, -70.0f32, 0.0f32, 0.0f32, 0u64, 0u32, 0.0f32, Vec::new(),
                    false, false, -14.0f32, -70.0f32, -70.0f32, 0.0f32, 0.0f32, 0.0f32, 0.0f32, 1.0f32,
                    // A POISONED LOCK MUST NOT REPORT A BYPASS. The numbers fall back to the shipped
                    // chain and both bypasses to false, which is the safe direction: the ceiling is
                    // reported as held, never as off.
                    -1.0f32, 120.0f32, 1.5f32, 12.0f32, false, false,
                    -70.0f32, -70.0f32, 0.0f32, 0.0f32, 0.0f32, 0.0f32,
                    -14.0f32, -1.0f32, 120.0f32, 1.5f32, 12.0f32, false, false),
    };
    serde_json::json!({
        "a": la, "b": lb, "c": lc, "cart": lcart, "master": lmaster, "room": lroom, "aux_frames": auxframes, "aux_peak": auxpeak,
        "aux_proc_in_lufs": auxin, "aux_proc_out_lufs": auxout, "aux_proc_gr_db": auxgr, "aux_proc_ride_db": auxride,
        "frames_total": frames, "active_decks": active, "mon_vol": mon, "decks": decks,
        "proc_local": p_local, "proc_stream": p_stream, "proc_target_lufs": p_target,
        "proc_in_lufs": p_in_lufs, "proc_out_lufs": p_out_lufs, "proc_gr_db": p_gr,
        "proc_in_peak": p_in_peak, "proc_out_peak": p_out_peak, "proc_ride_gain_db": p_ride,
        // DUCKER (slice 3) — the live gain on THIS station's programme. 1.0 = not ducking.
        // Named here deliberately: the comment above this function exists because adding a field to
        // AudioLevels and stopping there is exactly how the proc_* meters were lost once already.
        "duck_gain": duckg,
        // THE OPERATOR-PARAMETER ECHO. What the engine is ACTUALLY running, so no panel has to quote a
        // literal or trust its own last command. audiod/smoke-meter-contract.js now checks THIS list —
        // the wire contract — rather than the struct assignments, which is why the same mistake passed
        // a green test the first time it was made.
        "proc_ceiling_dbtp": p_ceiling, "proc_release_ms": p_release,
        "proc_ride_rate": p_rate, "proc_ride_clamp": p_clamp,
        "proc_ride_bypass": p_ride_byp, "proc_limiter_bypass": p_lim_byp,
        // THE STREAM BRANCH — its own meters and its own parameters. One set of numbers for two
        // processors would be a meter that lies: with the split on they ride to different targets and
        // reduce by different amounts at the same instant.
        "proc_stream_in_lufs": s_in, "proc_stream_out_lufs": s_out, "proc_stream_gr_db": s_gr,
        "proc_stream_ride_gain_db": s_ride, "proc_stream_in_peak": s_inpk, "proc_stream_out_peak": s_outpk,
        "proc_stream_target_lufs": s_target, "proc_stream_ceiling_dbtp": s_ceiling,
        "proc_stream_release_ms": s_release, "proc_stream_ride_rate": s_rate,
        "proc_stream_ride_clamp": s_clamp,
        "proc_stream_ride_bypass": s_ride_byp, "proc_stream_limiter_bypass": s_lim_byp
    }).to_string()
}

/// 10-band post-EQ master spectrum (0..~1 normalized magnitude), for the Master EQ
/// rack's live FFT display. Mirrors audio_get_levels: nudges the audio thread to
/// refresh AudioLevels (GetLevel also copies the latest bus spectrum) then reads it.
/// Returns a JSON array of 10 floats, e.g. "[0.12,0.34,...]".
/// C5, MEASURED ON THE SHIPPED MODULE — one ProgramProcessor instance versus two.
///
/// The bench in program_processor.rs answers this too, but it is a different binary: the cargo test
/// harness, compiled separately from the cdylib this ships. Jeff's condition for the local/stream
/// split was the number "on the BUILT artifact, not the bench", and this is the only way to get it —
/// the same crate, the same release profile, the same code the audio callback runs, reached across the
/// NAPI boundary from the .node that is actually packaged.
///
/// Inert unless called. It allocates and runs for `seconds` of signal, so it must never be invoked
/// from the audio thread or while a station is airing — it is a diagnostic entry point, called by
/// scripts/diag-c5-artifact.js.
///
/// Returns JSON: median/mean/worst ms per 10 ms block for one and two instances, and the ratio.
#[napi]
pub fn audio_bench_processor(seconds: f64, seed: u32) -> String {
    use crate::program_processor::ProgramProcessor;
    const FS: f32 = 48_000.0;

    // Same signal shape as the bench: a deterministic PRNG at 0.8 amplitude, so the number is
    // comparable run to run and machine to machine.
    let n = (FS * seconds as f32) as usize;
    let mut state = seed as u64 | 1;
    let mut sig: Vec<f32> = Vec::with_capacity(n * 2);
    for _ in 0..n {
        state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let s = (((state >> 33) as f32 / (1u64 << 31) as f32) - 1.0) * 0.8;
        sig.push(s); sig.push(s * 0.98);
    }

    let block = 480 * 2;
    let stat = |v: &mut Vec<u128>| {
        v.sort();
        (v[v.len() / 2] as f64 / 1e6, v.iter().sum::<u128>() as f64 / v.len() as f64 / 1e6)
    };

    let mut one = ProgramProcessor::new(FS, -14.0);
    let mut a = sig.clone();
    let (mut worst1, mut all1) = (0u128, Vec::new());
    let mut i = 0;
    while i < a.len() {
        let end = (i + block).min(a.len());
        let t0 = std::time::Instant::now();
        one.process_block(&mut a[i..end]);
        let e = t0.elapsed().as_nanos(); worst1 = worst1.max(e); all1.push(e);
        i = end;
    }

    // Two instances with DIFFERENT targets, which is what a local/stream split actually is.
    let mut p_local  = ProgramProcessor::new(FS, -14.0);
    let mut p_stream = ProgramProcessor::new(FS, -16.0);
    let mut bl = sig.clone();
    let mut bs = sig;
    let (mut worst2, mut all2) = (0u128, Vec::new());
    let mut j = 0;
    while j < bl.len() {
        let end = (j + block).min(bl.len());
        let t0 = std::time::Instant::now();
        p_local.process_block(&mut bl[j..end]);
        p_stream.process_block(&mut bs[j..end]);
        let e = t0.elapsed().as_nanos(); worst2 = worst2.max(e); all2.push(e);
        j = end;
    }

    let (med1, mean1) = stat(&mut all1);
    let (med2, mean2) = stat(&mut all2);
    serde_json::json!({
        "blocks": all1.len(), "block_ms": 10.0, "seconds": seconds,
        "one":  { "median_ms": med1, "mean_ms": mean1, "worst_ms": worst1 as f64 / 1e6 },
        "two":  { "median_ms": med2, "mean_ms": mean2, "worst_ms": worst2 as f64 / 1e6 },
        "ratio_median": med2 / med1,
        "budget_share_one_pct": med1 / 10.0 * 100.0,
        "budget_share_two_pct": med2 / 10.0 * 100.0
    }).to_string()
}

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
