// native/src/offline_render.rs — THE DSP PARITY HARNESS (Stage 2a, docs/dsp-parity-harness.md).
//
// Drives the REAL mixer_callback with no audio device, faster than realtime, and captures the two taps
// docs/dsp-inventory.md §2 names:
//   • MONITOR — dl/dr, the buffer handed to the device, BEFORE the monitor gains and BEFORE resampling.
//   • STREAM  — exactly what the program-bus ring carries to ffmpeg.
//
// THE CALLBACK IS NOT MODIFIED. The monitor tap is read from the device buffer under the three conditions
// that make that buffer bit-identical to dl/dr (harness doc §2):
//   1. device rate == PROGRAM_RATE (44100)  → prog_frames == device_frames, the no-resample branch runs;
//   2. ch == 2                              → data[2f] = dl[f]·mvol, data[2f+1] = dr[f]·mvol;
//   3. monitor_vol == master_monitor_vol == 1.0 → mvol == 1.0 exactly, and x·1.0 == x in IEEE-754.
// Goldens captured through this path are therefore goldens of the code that airs, not of a harness copy.
//
// NOT A PRODUCT SURFACE. No IPC, no UI, no daemon command. Never touches ENGINES, never opens a device,
// never starts a thread — reachable only from `cargo test` and the diagnostic NAPI export
// audio_render_offline (lib.rs), so it can run against the packaged .node.
//
// This file allocates freely. It is not the real-time path; it only calls it.

use std::sync::{Arc, Mutex};
use std::sync::atomic::AtomicBool;
use ringbuf::{HeapRb, traits::{Consumer, Producer, Split}};
use serde::{Deserialize, Serialize};
use crate::audio::{BusState, FinishedFlags, SharedBusState, Scratch, mixer_callback, build_source, PROGRAM_BUS_BUF, AUX_BUS_BUF};
use crate::rt::{deck_feed, Feeder, DECK_RING_SAMPLES};

/// The program-bus rate. The render always runs the device at this rate (condition 1 above).
pub const RATE: u32 = 44_100;
/// Default frames per callback — 10 ms at 44.1 kHz, the block size the existing Rust goldens use
/// (audio.rs:1160). RenderCfg.block_frames overrides it (the ride evaluates per call, so block size is
/// part of what a golden pins).
const BLOCK: usize = 480;
/// Buffers rendered after the deck reports finished, so the limiter's look-ahead delay line
/// (66 samples at 44.1 kHz, program_processor.rs:116) is flushed into the taps. 10 × 480 = 100 ms.
const TAIL_BUFFERS: usize = 10;
/// Refuse to render forever if a decoder never ends (a stream, a corrupt length): 30 minutes of audio.
const MAX_SECONDS: usize = 60 * 30;

/// What the render sets on the bus. Absent JSON fields take THE SHIPPED CHAIN ("Ether v1") — the same
/// numbers BusState::new boots with (audio.rs:693-705) — so `{}` renders exactly an untouched station.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct RenderCfg {
    pub proc_local: bool,
    pub proc_stream: bool,
    /// Off = the stream branch is handed the LOCAL numbers, exactly as the daemon mirrors them while
    /// linked (audiod/engine.js:341-347). On = the stream_* values below take over where present.
    pub proc_split: bool,
    pub target_lufs: f32,
    pub ceiling_dbtp: f32,
    pub release_ms: f32,
    pub ride_rate: f32,
    pub ride_clamp: f32,
    pub stream_target_lufs: Option<f32>,
    pub stream_ceiling_dbtp: Option<f32>,
    pub stream_release_ms: Option<f32>,
    pub stream_ride_rate: Option<f32>,
    pub stream_ride_clamp: Option<f32>,
    /// bus.master_vol — MASTER OUT, the broadcast gain (clamped 0..1 as SetMasterVolume does).
    pub master_vol: f32,
    /// decks[0].gain_db — the per-track loudness trim, applied pre-fader (audio.rs:2362-2365).
    pub gain_db: f32,
    /// Master GEQ band gains in dB. None = flat (the EQ skips its filters entirely, eq.rs:234).
    pub eq_bands: Option<Vec<f32>>,
    // ── S0 (docs/dsp-rt-callback.md §7): the paths the first 37 goldens never exercised ──────────
    /// Device frames per callback. None = 480.
    pub block_frames: Option<usize>,
    /// Device sample rate. None = 44 100 (the monitor tap is then dl/dr exactly). Any other rate runs
    /// the callback's device resampler, and the device-open side effects are mirrored from the live
    /// path (audio.rs:1754-1757): bus.sample_rate AND the air EQ are set to the device rate.
    pub device_rate: Option<u32>,
    /// bus.monitor_vol. None = 1.0. Anything else puts the monitor gain stage into the monitor tap.
    pub monitor_vol: Option<f32>,
    /// A second, AUX deck (slot 3 = D, SlotKind::Source) playing alongside deck A.
    pub aux: Option<AuxCfg>,
    /// SLICE 4 — deliver the processor and GEQ settings as a RACK DOCUMENT (the `rack_master` JSON the daemon
    /// stores), parsed by rack.rs and pushed through the callback's own command queue as a Params block —
    /// after every processor value and both EQs have been scrambled, so only the rack path can restore them.
    /// Never serialized: the goldens' manifest cfg is unchanged by its existence.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub via_rack: bool,
    /// SLICE 5 — give EVERY fader a channel rack that is present but OUT (Filters with HPF+LPF on, a non-flat PEQ,
    /// both slots OUT), through the callback's command queue. The harness must still null: an OUT rack runs
    /// nothing. Never serialized.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub ch_racks_out: bool,
    /// SLICE 5 — a channel rack document for deck A (the measurement renders). Never serialized when absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ch_rack_a: Option<String>,
}

/// The aux deck of a render: its file, whether its duck is armed, and its monitor-slot level (which, as
/// SetAuxMonitor does for a non-rotation slot, sets both aux_monitor_gain and room_gain, audio.rs:1956-1964).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuxCfg {
    /// Input file. The manifest stores a bare file name; callers resolve it against goldens/inputs.
    pub path: String,
    pub duck: bool,
    pub aux_gain: f32,
}

impl Default for RenderCfg {
    fn default() -> Self {
        RenderCfg {
            proc_local: false, proc_stream: false, proc_split: false,
            target_lufs: -14.0, ceiling_dbtp: -1.0, release_ms: 120.0, ride_rate: 1.5, ride_clamp: 12.0,
            stream_target_lufs: None, stream_ceiling_dbtp: None, stream_release_ms: None,
            stream_ride_rate: None, stream_ride_clamp: None,
            master_vol: 1.0, gain_db: 0.0, eq_bands: None,
            block_frames: None, device_rate: None, monitor_vol: None, aux: None, via_rack: false,
            ch_racks_out: false, ch_rack_a: None,
        }
    }
}

/// The taps of one render, interleaved stereo f32.
///   monitor — the device buffer. At a 44.1 kHz device with monitor_vol 1.0 this IS dl/dr (header).
///   stream  — the program-bus ring, 44.1 kHz.
///   aux     — the aux monitor ring (empty unless cfg.aux is set), 44.1 kHz.
pub struct Render {
    pub monitor: Vec<f32>,
    pub stream: Vec<f32>,
    pub aux: Vec<f32>,
    /// SLICE 3 — the ENGINE'S OWN loudness meter over this render (loudness.rs), driven inline after every
    /// buffer exactly as the product's meter thread drains it: LOCAL = the device feed (the monitor tap
    /// here), STREAM = the stream tap, AUX = the aux feed. Published once, at the end.
    pub loud: crate::loudness::LoudnessFrame,
}

/// Build a bus in the state `cfg` describes, through the SAME clamps the live command arms apply
/// (audio.rs:2100-2149), so a cfg cannot reach a state the product cannot.
fn configure(bus: &mut BusState, cfg: &RenderCfg) {
    bus.proc_local  = cfg.proc_local;
    bus.proc_stream = cfg.proc_stream;
    // LOCAL (branch 0) — SetProcessorParams / SetProcessing clamps.
    bus.proc_target_lufs  = cfg.target_lufs.clamp(-30.0, -6.0);
    bus.proc_ceiling_dbtp = cfg.ceiling_dbtp.clamp(-12.0, -0.1);
    bus.proc_release_ms   = cfg.release_ms.clamp(5.0, 2000.0);
    bus.proc_ride_rate    = cfg.ride_rate.clamp(0.1, 12.0);
    bus.proc_ride_clamp   = cfg.ride_clamp.clamp(0.0, 24.0);
    // STREAM (branch 1) — mirrored from LOCAL while linked, exactly as engine.js:341-347 does.
    let pick = |own: Option<f32>, local: f32| if cfg.proc_split { own.unwrap_or(local) } else { local };
    bus.proc_stream_target_lufs  = pick(cfg.stream_target_lufs,  cfg.target_lufs).clamp(-30.0, -6.0);
    bus.proc_stream_ceiling_dbtp = pick(cfg.stream_ceiling_dbtp, cfg.ceiling_dbtp).clamp(-12.0, -0.1);
    bus.proc_stream_release_ms   = pick(cfg.stream_release_ms,   cfg.release_ms).clamp(5.0, 2000.0);
    bus.proc_stream_ride_rate    = pick(cfg.stream_ride_rate,    cfg.ride_rate).clamp(0.1, 12.0);
    bus.proc_stream_ride_clamp   = pick(cfg.stream_ride_clamp,   cfg.ride_clamp).clamp(0.0, 24.0);
    bus.master_vol = cfg.master_vol.clamp(0.0, 1.0);
    // Condition 3: the room gains are unity so the device buffer IS dl/dr. These are BusState::new's
    // own defaults; set explicitly so the invariant is visible here and cannot drift silently.
    bus.monitor_vol = cfg.monitor_vol.unwrap_or(1.0).clamp(0.0, 4.0);   // SetMonitorVolume clamp
    bus.master_monitor_vol = 1.0;
    // Master GEQ, as SetEq applies it (audio.rs:2084-2096): both the air EQ and the room EQ.
    if let Some(ref bands) = cfg.eq_bands {
        if let Ok(mut eq) = bus.eq.lock() { eq.set_bands(bands); }
        if let Ok(mut eqr) = bus.eq_room.lock() { eqr.set_bands(bands); }
    }
}

/// SLICE 4 — the rack document a daemon would store for this render's settings (docs/dsp-rack-framework.md
/// §1.1): the GEQ in PGM, ride → limiter per branch, the stream mirrored while linked.
pub fn rack_doc_json(cfg: &RenderCfg) -> String {
    let pick = |own: Option<f32>, local: f32| if cfg.proc_split { own.unwrap_or(local) } else { local };
    let bands: Vec<f32> = cfg.eq_bands.clone().unwrap_or_else(|| vec![0.0; 10]);
    let branch = |t: f32, rate: f32, clamp: f32, ceil: f32, rel: f32| serde_json::json!([
        { "id": "s-ride", "module": { "type": "ride", "target": t, "rate": rate, "clamp": clamp }, "in": true },
        { "id": "s-lim",  "module": { "type": "limiter", "ceiling": ceil, "release": rel }, "in": true },
    ]);
    serde_json::json!({
        "v": 1, "link": !cfg.proc_split,
        "sections": {
            "pgm": [ { "id": "s-geq", "module": { "type": "geq", "bands": bands }, "in": true } ],
            "local": branch(cfg.target_lufs, cfg.ride_rate, cfg.ride_clamp, cfg.ceiling_dbtp, cfg.release_ms),
            "stream": branch(pick(cfg.stream_target_lufs, cfg.target_lufs), pick(cfg.stream_ride_rate, cfg.ride_rate),
                             pick(cfg.stream_ride_clamp, cfg.ride_clamp), pick(cfg.stream_ceiling_dbtp, cfg.ceiling_dbtp),
                             pick(cfg.stream_release_ms, cfg.release_ms)),
        }
    }).to_string()
}

/// SLICE 5 — the "present but OUT" channel rack every fader gets in the null run: HPF and LPF switched on inside
/// the Filters module, a non-flat PEQ — and both SLOTS OUT. It must run nothing.
pub const CH_RACK_OUT_DOC: &str = r#"{"v":1,"sections":{"ch":[
    {"id":"s-flt","module":{"type":"filters","hpf":{"in":true,"freq":120},"lpf":{"in":true,"freq":9000}},"in":false},
    {"id":"s-peq","module":{"type":"peq","bands":[{"freq":80,"gain":6,"width":1,"shelf":true},{"freq":1000,"gain":-4,"width":1},
      {"freq":3000,"gain":3,"width":2},{"freq":10000,"gain":-6,"width":1,"shelf":true}]},"in":false},
    {"id":"s-gate","module":{"type":"gate","threshold":-45,"ratio":4,"depth":15,"attack":1,"hold":100,"release":150,"hysteresis":3},"in":false},
    {"id":"s-comp","module":{"type":"comp","threshold":-20,"ratio":3,"attack":10,"release":150,"makeup":6,"knee":6},"in":false}]}}"#;

/// Render one file through the live mixer. Deck A, fader at unity, channel ON; optionally an aux deck D.
pub fn render_offline(path: &str, cfg: &RenderCfg) -> Result<Render, String> {
    let block = cfg.block_frames.unwrap_or(BLOCK).max(1);
    let device_rate = cfg.device_rate.unwrap_or(RATE);
    let rb = HeapRb::<f32>::new(PROGRAM_BUS_BUF);
    let (prod, mut cons) = rb.split();   // BOTH halves kept — the existing tests drop the consumer
    let eq = crate::eq::new_shared_eq(RATE as f32);
    // stream_connected = true: the callback pushes the stream tap only while a client is attached (:2703).
    let bus: SharedBusState = Arc::new(Mutex::new(BusState::new(eq, prod, RATE, Arc::new(AtomicBool::new(true)))));
    let mut aux_cons = None;
    // S4 — the decks are fed through the product's own rings (rt.rs). THE SYNCHRONOUS PUMP: before every
    // buffer the harness runs each deck's Feeder::fill inline — the same routine the decode worker thread
    // runs — to capacity, so the ring can never be dry when the callback reads it and the render stays
    // deterministic. The threaded worker has its own tests (rt.rs).
    let mut feeders: Vec<Feeder> = Vec::new();
    {
        let mut b = bus.lock().map_err(|_| "bus lock poisoned".to_string())?;
        // Device open, exactly as the live path does it (audio.rs:1754-1757) — including retuning ONLY the
        // air EQ to the device rate (inventory §6.6). A golden of what airs, defects and all.
        if device_rate != RATE {
            b.sample_rate = device_rate;
            if let Ok(mut eq) = b.eq.lock() { eq.set_sample_rate(device_rate as f32); }
        }
        configure(&mut b, cfg);
        let src = build_source(path, RATE).ok_or_else(|| format!("cannot decode {}", path))?;
        let (feed, feeder) = deck_feed(src);
        feeders.push(feeder);
        let d = &mut b.decks[0];
        d.source  = Some(feed);
        d.active  = true;
        d.paused  = false;   // DeckSlot::new() starts paused — see the warning at audio.rs:1286-1290
        d.volume  = 1.0;
        d.muted   = false;
        d.gain_db = cfg.gain_db;
        if let Some(ref ax) = cfg.aux {
            let asrc = build_source(&ax.path, RATE).ok_or_else(|| format!("cannot decode aux {}", ax.path))?;
            let (afeed, afeeder) = deck_feed(asrc);
            feeders.push(afeeder);
            let d = &mut b.decks[3];
            d.source = Some(afeed);
            d.active = true;
            d.paused = false;
            d.volume = 1.0;
            d.muted  = false;
            b.duck_enabled[3] = ax.duck;
            b.aux_monitor_gain[3] = ax.aux_gain.clamp(0.0, 4.0);
            b.room_gain[3] = ax.aux_gain.clamp(0.0, 4.0);
            let (ap, ac) = HeapRb::<f32>::new(AUX_BUS_BUF).split();
            b.aux_ring_prod = Some(ap);
            aux_cons = Some(ac);
        }
    }

    let fin = FinishedFlags::new();
    let playing = Arc::new(AtomicBool::new(true));
    let mut monitor: Vec<f32> = Vec::new();
    let mut stream: Vec<f32> = Vec::new();
    let mut aux: Vec<f32> = Vec::new();
    let mut data = vec![0f32; block * 2];
    let mut pop = vec![0f32; PROGRAM_BUS_BUF];
    let mut tail_left: Option<usize> = None;
    let max_buffers = device_rate as usize * MAX_SECONDS / block;
    let mut sc = Scratch::new();
    // SLICE 3 — the loudness meter, fed by the callback's own rings and drained after every buffer (the
    // product drains on its meter thread every 20 ms; the order of samples is the same, so is the reading).
    let (mut loud, loud_r) = {
        let mut b = bus.lock().map_err(|_| "bus lock poisoned".to_string())?;
        let mut h = b.handles.take().ok_or("state has no handles")?;
        if cfg.via_rack {
            // SLICE 4 — the rack path. Scramble every value the rack carries (both branches' ride and limiter,
            // the live bypasses, and both EQs back to flat), then deliver the render's settings ONLY as a rack
            // document: parsed by rack.rs, placed in a Params block, and pushed through the callback's command
            // queue — the same block and queue the daemon's rack reaches the callback through.
            let rack = crate::rack::MasterRack::from_doc_json(&rack_doc_json(cfg))?;
            b.proc_target_lufs = -6.0; b.proc_ceiling_dbtp = -12.0; b.proc_release_ms = 5.0; b.proc_ride_rate = 12.0; b.proc_ride_clamp = 0.0;
            b.proc_stream_target_lufs = -6.0; b.proc_stream_ceiling_dbtp = -12.0; b.proc_stream_release_ms = 5.0;
            b.proc_stream_ride_rate = 12.0; b.proc_stream_ride_clamp = 0.0;
            b.proc_ride_bypass = true; b.proc_limiter_bypass = true; b.proc_stream_ride_bypass = true; b.proc_stream_limiter_bypass = true;
            if let Ok(mut eq) = b.eq.lock() { eq.set_bands(&[0.0; 10]); }
            if let Ok(mut eqr) = b.eq_room.lock() { eqr.set_bands(&[0.0; 10]); }
            b.eq_bands = [0.0; 10];
            let mut params = b.params();
            let mut r = rack;
            r.eq_version = b.eq_version_applied.wrapping_add(1);
            params.rack = r;
            h.cmd_prod.try_push(crate::rt::RtCmd::Params(Box::new(params))).map_err(|_| "rack command queue full".to_string())?;
        }
        if cfg.ch_racks_out || cfg.ch_rack_a.is_some() {
            // SLICE 5 — channel racks through the same queue, planned exactly as the dispatch thread plans them.
            let mut params = b.params();
            let fs = RATE as f64;   // the program rate (44 100) — the rate the dispatch thread plans at
            if cfg.ch_racks_out {
                let r = crate::rack::ChannelRack::from_doc_json(CH_RACK_OUT_DOC)?;
                for i in 0..params.ch_rack.len() {
                    params.ch_rack[i] = crate::rack::ChannelRackParams { rack: r, plan: r.plan(fs), version: 1 };
                }
            }
            if let Some(ref d) = cfg.ch_rack_a {
                let r = crate::rack::ChannelRack::from_doc_json(d)?;
                params.ch_rack[0] = crate::rack::ChannelRackParams { rack: r, plan: r.plan(fs), version: 2 };
            }
            h.cmd_prod.try_push(crate::rt::RtCmd::Params(Box::new(params))).map_err(|_| "channel rack command queue full".to_string())?;
        }
        crate::loudness::LoudnessMeters::new(h.loud_cons, h.loud_shared, RATE)
    };

    for _ in 0..max_buffers {
        data.iter_mut().for_each(|s| *s = 0.0);
        for f in feeders.iter_mut() { f.fill(DECK_RING_SAMPLES); }   // the synchronous pump
        mixer_callback(&mut data, 2, &bus, &fin, &playing, &mut sc);
        loud.drain();
        monitor.extend_from_slice(&data);
        // Drain EVERY call so neither ring can fill and drop samples (try_push at :2717, :2879).
        loop {
            let n = cons.pop_slice(&mut pop);
            if n == 0 { break; }
            stream.extend_from_slice(&pop[..n]);
        }
        if let Some(ref mut ac) = aux_cons {
            loop {
                let n = ac.pop_slice(&mut pop);
                if n == 0 { break; }
                aux.extend_from_slice(&pop[..n]);
            }
        }
        // Exactly TAIL_BUFFERS buffers are rendered after the one in which deck A finished.
        match tail_left {
            None => if fin.take("A") { tail_left = Some(TAIL_BUFFERS); },
            Some(t) => { if t <= 1 { break; } tail_left = Some(t - 1); }
        }
    }
    if tail_left.is_none() { return Err(format!("{} did not finish within {} buffers", path, max_buffers)); }
    if monitor.is_empty() { return Err("render produced no samples".into()); }
    // The two taps are the same length only when the device runs at the program rate.
    if device_rate == RATE && monitor.len() != stream.len() {
        return Err(format!("tap length mismatch: monitor {} vs stream {} samples", monitor.len(), stream.len()));
    }
    loud.publish();
    let lf = loud_r.lock().map_err(|_| "loudness reader poisoned".to_string())?.read();
    Ok(Render { monitor, stream, aux, loud: lf })
}

// ── Measurements (for the manifest and the report) ──────────────────────────────────────────────────

/// FNV-1a 64 over the raw f32 bits — the same identity check the existing mixer goldens use
/// (audio.rs:1134-1138). Equal hash ⇔ bit-exact (to the collision odds of a 64-bit hash).
pub fn fnv_bits(v: &[f32]) -> u64 {
    let mut h = 1469598103934665603u64;
    for s in v { h ^= s.to_bits() as u64; h = h.wrapping_mul(1099511628211); }
    h
}
/// FNV-1a 64 over bytes — input-file identity in the manifest.
#[cfg_attr(not(test), allow(dead_code))] // used by the parity tests
pub fn fnv_bytes(v: &[u8]) -> u64 {
    let mut h = 1469598103934665603u64;
    for b in v { h ^= *b as u64; h = h.wrapping_mul(1099511628211); }
    h
}
pub fn sample_peak(v: &[f32]) -> f32 { v.iter().fold(0.0f32, |m, s| m.max(s.abs())) }
#[cfg_attr(not(test), allow(dead_code))] // used by the parity tests
pub fn max_abs_diff(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).fold(0.0f32, |m, (x, y)| m.max((x - y).abs()))
}
pub fn bits_equal(a: &[f32], b: &[f32]) -> bool {
    a.len() == b.len() && a.iter().zip(b.iter()).all(|(x, y)| x.to_bits() == y.to_bits())
}
/// Integrated loudness (BS.1770 gated) and true peak (dBTP) — for a human reading the manifest.
/// None where the measurement is undefined (silence).
pub fn loudness(v: &[f32]) -> (Option<f64>, Option<f64>) {
    let Ok(mut m) = ebur128::EbuR128::new(2, RATE, ebur128::Mode::I | ebur128::Mode::TRUE_PEAK) else { return (None, None) };
    if m.add_frames_f32(v).is_err() { return (None, None); }
    let i = m.loudness_global().ok().filter(|x| x.is_finite());
    let tp = match (m.true_peak(0), m.true_peak(1)) {
        (Ok(a), Ok(b)) => { let p = a.max(b); if p > 0.0 { Some(20.0 * p.log10()) } else { None } }
        _ => None,
    };
    (i, tp)
}

// ── WAV I/O (no crate: the samples go to disk bit-exact) ────────────────────────────────────────────

/// 32-bit IEEE-float stereo WAV (WAVE_FORMAT_IEEE_FLOAT, with the cbSize and fact chunk the spec asks for).
pub fn write_wav_f32(path: &std::path::Path, samples: &[f32]) -> std::io::Result<()> {
    let data_len = (samples.len() * 4) as u32;
    let mut out: Vec<u8> = Vec::with_capacity(58 + samples.len() * 4);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(4 + 26 + 12 + 8 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&18u32.to_le_bytes());
    out.extend_from_slice(&3u16.to_le_bytes());                  // WAVE_FORMAT_IEEE_FLOAT
    out.extend_from_slice(&2u16.to_le_bytes());                  // channels
    out.extend_from_slice(&RATE.to_le_bytes());
    out.extend_from_slice(&(RATE * 2 * 4).to_le_bytes());        // byte rate
    out.extend_from_slice(&8u16.to_le_bytes());                  // block align
    out.extend_from_slice(&32u16.to_le_bytes());                 // bits
    out.extend_from_slice(&0u16.to_le_bytes());                  // cbSize
    out.extend_from_slice(b"fact");
    out.extend_from_slice(&4u32.to_le_bytes());
    out.extend_from_slice(&((samples.len() / 2) as u32).to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples { out.extend_from_slice(&s.to_le_bytes()); }
    std::fs::write(path, out)
}

/// Read back a float WAV written by write_wav_f32 (or any IEEE-float WAV). Bit-exact.
#[cfg_attr(not(test), allow(dead_code))] // used by the parity tests
pub fn read_wav_f32(path: &std::path::Path) -> Result<Vec<f32>, String> {
    let b = std::fs::read(path).map_err(|e| format!("{}: {}", path.display(), e))?;
    if b.len() < 12 || &b[0..4] != b"RIFF" || &b[8..12] != b"WAVE" { return Err(format!("{}: not a WAV", path.display())); }
    let mut o = 12usize;
    let mut is_float = false;
    while o + 8 <= b.len() {
        let id = &b[o..o + 4];
        let len = u32::from_le_bytes([b[o + 4], b[o + 5], b[o + 6], b[o + 7]]) as usize;
        if id == b"fmt " { is_float = u16::from_le_bytes([b[o + 8], b[o + 9]]) == 3; }
        if id == b"data" {
            if !is_float { return Err(format!("{}: not IEEE float", path.display())); }
            let end = (o + 8 + len).min(b.len());
            return Ok(b[o + 8..end].chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect());
        }
        o += 8 + len + (len & 1);
    }
    Err(format!("{}: no data chunk", path.display()))
}

/// 16-bit PCM stereo WAV at 44.1 kHz — the synthetic corpus is written the way a real library holds
/// audio, so it goes through the product's decoder like any file.
#[cfg_attr(not(test), allow(dead_code))] // the synthetic-corpus writer; used by the parity tests
pub fn wav_pcm16_bytes(samples: &[f32]) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out: Vec<u8> = Vec::with_capacity(44 + samples.len() * 2);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&RATE.to_le_bytes());
    out.extend_from_slice(&(RATE * 2 * 2).to_le_bytes());
    out.extend_from_slice(&4u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        let q = (s.clamp(-1.0, 1.0) * 32767.0).round() as i16;
        out.extend_from_slice(&q.to_le_bytes());
    }
    out
}

// ── The NAPI entry point's body (lib.rs audio_render_offline) ───────────────────────────────────────

/// Render `path` with `cfg_json` and write out_dir/monitor.wav + out_dir/stream.wav (+ aux.wav with an aux deck). Returns a JSON
/// summary: frames, per-tap FNV hash (hex), sample peak, integrated LUFS and true peak, and the cfg used.
pub fn render_to_dir(path: &str, cfg_json: &str, out_dir: &str) -> Result<String, String> {
    let cfg: RenderCfg = if cfg_json.trim().is_empty() { RenderCfg::default() }
        else { serde_json::from_str(cfg_json).map_err(|e| format!("cfg_json: {}", e))? };
    let r = render_offline(path, &cfg)?;
    let dir = std::path::Path::new(out_dir);
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {}", out_dir, e))?;
    write_wav_f32(&dir.join("monitor.wav"), &r.monitor).map_err(|e| e.to_string())?;
    write_wav_f32(&dir.join("stream.wav"), &r.stream).map_err(|e| e.to_string())?;
    let (mi, mtp) = loudness(&r.monitor);
    let (si, stp) = loudness(&r.stream);
    let mut out = serde_json::json!({
        "frames": r.monitor.len() / 2,
        "monitor": { "hash": format!("{:016x}", fnv_bits(&r.monitor)), "peak": sample_peak(&r.monitor), "lufs_i": mi, "tp_dbtp": mtp },
        "stream":  { "hash": format!("{:016x}", fnv_bits(&r.stream)),  "peak": sample_peak(&r.stream),  "lufs_i": si, "tp_dbtp": stp },
        "taps_bit_identical": r.monitor.len() == r.stream.len() && bits_equal(&r.monitor, &r.stream),
        // SLICE 3 — what the ENGINE'S meter read over the same render (branch order local, stream, aux).
        "meter": r.loud.b.iter().map(|b| serde_json::json!({
            "i": if b.i.is_finite() { Some(b.i) } else { None }, "lra": if b.lra.is_finite() { Some(b.lra) } else { None },
            "tp_max": if b.tp_max.is_finite() { Some(b.tp_max) } else { None }, "measured_frames": b.measured_frames,
        })).collect::<Vec<_>>(),
        "cfg": cfg,
    });
    if cfg.aux.is_some() {
        write_wav_f32(&dir.join("aux.wav"), &r.aux).map_err(|e| e.to_string())?;
        let (ai, atp) = loudness(&r.aux);
        out["aux"] = serde_json::json!({ "hash": format!("{:016x}", fnv_bits(&r.aux)), "peak": sample_peak(&r.aux), "lufs_i": ai, "tp_dbtp": atp });
    }
    Ok(out.to_string())
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════
// THE PARITY TESTS. Run:  npm run test:rust   (= cd native && cargo test --release --lib -- --nocapture)
// Capture goldens (only on Jeff's say-so — goldens are the contract every later change is held to):
//   cd native && cargo test --release --lib offline_render::parity::capture_goldens -- --ignored --nocapture
// ══════════════════════════════════════════════════════════════════════════════════════════════════════
#[cfg(test)]
mod parity {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::sync::OnceLock;

    /// The null bar: 1e-6 of full scale == −120 dBFS (spec §4 slice 0, harness doc §0).
    const NULL_BAR: f32 = 1e-6;
    const SYNTH_SECS: f64 = 10.0;

    fn goldens_dir() -> PathBuf { Path::new(env!("CARGO_MANIFEST_DIR")).join("goldens") }
    fn inputs_dir() -> PathBuf { goldens_dir().join("inputs") }

    // ── Corpus ──────────────────────────────────────────────────────────────────────────────────────
    /// Deterministic synthetic signal, interleaved stereo at 44.1 kHz.
    fn synth(name: &str) -> Vec<f32> {
        let n = (RATE as f64 * SYNTH_SECS) as usize;
        let fs = RATE as f64;
        let mut v = Vec::with_capacity(n * 2);
        for i in 0..n {
            let t = i as f64 / fs;
            let s: f64 = match name {
                "silence" => 0.0,
                // 1 kHz at −18 dBFS peak.
                "tone_1k_m18" => 10f64.powf(-18.0 / 20.0) * (2.0 * std::f64::consts::PI * 1000.0 * t).sin(),
                // fs/4 with a 45° phase: every sample lands at ±sin(45°) of the amplitude. Amplitude set so
                // the SAMPLE peak is −1 dBFS; the waveform between samples peaks at +2.0 dBTP.
                "isp_m1" => {
                    let a = 10f64.powf(-1.0 / 20.0) / (std::f64::consts::PI / 4.0).sin();
                    a * (std::f64::consts::PI / 2.0 * i as f64 + std::f64::consts::PI / 4.0).sin()
                }
                // Log sine sweep 20 Hz → 20 kHz at −18 dBFS peak.
                "sweep_20_20k_m18" => {
                    let (f0, f1) = (20.0f64, 20_000.0f64);
                    let k = (f1 / f0).ln();
                    let ph = 2.0 * std::f64::consts::PI * f0 * SYNTH_SECS / k * ((k * t / SYNTH_SECS).exp() - 1.0);
                    10f64.powf(-18.0 / 20.0) * ph.sin()
                }
                _ => panic!("unknown synthetic signal {}", name),
            };
            v.push(s as f32);
            v.push(s as f32);
        }
        v
    }

    /// (signal name, input path). Synthetic inputs are (re)written every run — deterministically — so a
    /// fresh checkout reproduces them; the manifest's input hash catches a machine that writes them differently.
    /// Built ONCE per test process: tests run in parallel, and two threads rewriting an input while a
    /// third decodes it would be a harness race, not a finding.
    fn corpus() -> Vec<(&'static str, PathBuf)> {
        static C: OnceLock<Vec<(&'static str, PathBuf)>> = OnceLock::new();
        C.get_or_init(build_corpus).clone()
    }
    fn build_corpus() -> Vec<(&'static str, PathBuf)> {
        std::fs::create_dir_all(inputs_dir()).unwrap();
        let mut out = vec![
            ("music", inputs_dir().join("music.wav")),
            ("speech", inputs_dir().join("speech.wav")),
        ];
        for name in ["silence", "tone_1k_m18", "isp_m1", "sweep_20_20k_m18"] {
            let p = inputs_dir().join(format!("{}.wav", name));
            let want = wav_pcm16_bytes(&synth(name));
            if std::fs::read(&p).ok().as_deref() != Some(&want[..]) { std::fs::write(&p, &want).unwrap(); }
            out.push((name, p));
        }
        for (name, p) in &out {
            assert!(p.exists(), "corpus input '{}' missing at {} — copy it in (its hash is in manifest.json)", name, p.display());
        }
        out
    }

    // ── Configurations (harness doc §4) ─────────────────────────────────────────────────────────────
    fn configs() -> Vec<(&'static str, RenderCfg)> {
        let v1 = RenderCfg::default();   // "Ether v1" — the shipped chain
        vec![
            ("OFF",    RenderCfg { ..v1.clone() }),
            ("LOCAL",  RenderCfg { proc_local: true, ..v1.clone() }),
            ("STREAM", RenderCfg { proc_stream: true, ..v1.clone() }),
            ("LINKED", RenderCfg { proc_local: true, proc_stream: true, ..v1.clone() }),
            ("SPLIT",  RenderCfg { proc_local: true, proc_stream: true, proc_split: true,
                                   stream_target_lufs: Some(-16.0), stream_ceiling_dbtp: Some(-2.0), ..v1.clone() }),
            // EQ: LINKED + a non-flat master GEQ (+4 dB @ 63 Hz, −3 dB @ 1 kHz, +2 dB @ 8 kHz). Band order
            // is eq.rs EQ_FREQS: 31, 63, 125, 250, 500, 1k, 2k, 4k, 8k, 16k.
            ("EQ",     RenderCfg { proc_local: true, proc_stream: true,
                                   eq_bands: Some(vec![0.0, 4.0, 0.0, 0.0, 0.0, -3.0, 0.0, 0.0, 2.0, 0.0]), ..v1.clone() }),
        ]
    }

    /// Every render in the golden set.
    ///   6 signals × 6 configs, plus music OFF with a −6 dB track trim         — captured at 6bd33e6
    ///   S0 extras (docs/dsp-rt-callback.md §7) — the paths slice 1 touches that the first set never did:
    ///     block sizes 1024 and 441 · a 48 kHz device with monitor gain 0.7 (resampler + mvol) · an aux
    ///     deck (speech on D over music on A) with the duck armed, processing on and off (room + aux + duck).
    fn plan() -> Vec<(String, PathBuf, RenderCfg)> {
        let mut out = Vec::new();
        let corpus = corpus();
        let path_of = |n: &str| corpus.iter().find(|(s, _)| *s == n).unwrap().1.clone();
        for (sig, path) in &corpus {
            for (cname, cfg) in configs() {
                out.push((format!("{}__{}", sig, cname), path.clone(), cfg));
            }
            if *sig == "music" {
                out.push(("music__OFF_TRIM_M6".to_string(), path.clone(), RenderCfg { gain_db: -6.0, ..RenderCfg::default() }));
            }
        }
        let linked = RenderCfg { proc_local: true, proc_stream: true, ..RenderCfg::default() };
        let eq = configs().into_iter().find(|(n, _)| *n == "EQ").unwrap().1;
        let aux = |duck: bool| Some(AuxCfg { path: path_of("speech").to_string_lossy().into_owned(), duck, aux_gain: 1.0 });
        out.push(("music__LINKED_B1024".into(), path_of("music"), RenderCfg { block_frames: Some(1024), ..linked.clone() }));
        out.push(("music__LINKED_B441".into(),  path_of("music"), RenderCfg { block_frames: Some(441), ..linked.clone() }));
        out.push(("music__LINKED_DEV48K_MON07".into(), path_of("music"),
                  RenderCfg { device_rate: Some(48_000), monitor_vol: Some(0.7), ..linked.clone() }));
        out.push(("sweep_20_20k_m18__EQ_DEV48K_MON07".into(), path_of("sweep_20_20k_m18"),
                  RenderCfg { device_rate: Some(48_000), monitor_vol: Some(0.7), ..eq }));
        out.push(("music__AUXDUCK_LINKED".into(), path_of("music"), RenderCfg { aux: aux(true), ..linked.clone() }));
        out.push(("music__AUXDUCK_OFF".into(),    path_of("music"), RenderCfg { aux: aux(true), ..RenderCfg::default() }));
        out
    }

    /// The cfg as the manifest stores it: an aux input is named by file, never by this machine's path.
    fn portable(c: &RenderCfg) -> RenderCfg {
        let mut c = c.clone();
        if let Some(ref mut a) = c.aux {
            a.path = Path::new(&a.path).file_name().unwrap().to_string_lossy().into_owned();
        }
        c
    }

    // ── One shared evaluation per test process: every render once, samples dropped after measuring ───
    #[derive(Clone)]
    struct Eval {
        frames: usize,
        mon_hash: u64, str_hash: u64, aux_hash: Option<u64>,
        mon_peak: f32, str_peak: f32,
        taps_identical: bool,
        taps_max_diff: f32,
        mon_tp: Option<f64>, str_tp: Option<f64>,
        // vs golden WAV, when present: (max abs diff, bit-exact)
        mon_vs_golden: Option<(f32, bool)>,
        str_vs_golden: Option<(f32, bool)>,
        aux_vs_golden: Option<(f32, bool)>,
        /// S6 — allocations the trap saw inside the callback during this render (this thread only).
        rt_allocs: u64,
    }

    fn evaluate(id: &str, path: &Path, cfg: &RenderCfg) -> Eval {
        let a0 = crate::rt::tl_rt_allocs();
        let r = render_offline(path.to_str().unwrap(), cfg).unwrap_or_else(|e| panic!("{}: {}", id, e));
        let rt_allocs = crate::rt::tl_rt_allocs() - a0;
        let vs = |tap: &[f32], which: &str| -> Option<(f32, bool)> {
            let g = goldens_dir().join(format!("{}__{}.wav", id, which));
            if !g.exists() { return None; }
            let gold = read_wav_f32(&g).unwrap();
            if gold.len() != tap.len() { return Some((f32::INFINITY, false)); }
            Some((max_abs_diff(tap, &gold), bits_equal(tap, &gold)))
        };
        let same_len = r.monitor.len() == r.stream.len();
        Eval {
            frames: r.monitor.len() / 2,
            mon_hash: fnv_bits(&r.monitor), str_hash: fnv_bits(&r.stream),
            aux_hash: if cfg.aux.is_some() { Some(fnv_bits(&r.aux)) } else { None },
            mon_peak: sample_peak(&r.monitor), str_peak: sample_peak(&r.stream),
            taps_identical: same_len && bits_equal(&r.monitor, &r.stream),
            taps_max_diff: if same_len { max_abs_diff(&r.monitor, &r.stream) } else { f32::NAN },
            mon_tp: loudness(&r.monitor).1, str_tp: loudness(&r.stream).1,
            mon_vs_golden: vs(&r.monitor, "monitor"),
            str_vs_golden: vs(&r.stream, "stream"),
            aux_vs_golden: if cfg.aux.is_some() { vs(&r.aux, "aux") } else { None },
            rt_allocs,
        }
    }

    fn all() -> &'static Vec<(String, Eval)> {
        static ALL: OnceLock<Vec<(String, Eval)>> = OnceLock::new();
        ALL.get_or_init(|| plan().into_iter().map(|(id, p, c)| { let e = evaluate(&id, &p, &c); (id, e) }).collect())
    }
    fn get(id: &str) -> &'static Eval { &all().iter().find(|(i, _)| i == id).unwrap_or_else(|| panic!("no render {}", id)).1 }

    fn manifest() -> Option<serde_json::Value> {
        let p = goldens_dir().join("manifest.json");
        std::fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok())
    }

    // ── 1 · NULL VS GOLDEN ──────────────────────────────────────────────────────────────────────────
    #[test]
    fn null_vs_golden() {
        let m = manifest().expect("native/goldens/manifest.json missing — capture goldens first (see the header of this module)");
        let renders = m["renders"].as_object().expect("manifest.renders");
        // Inputs must be the bytes the goldens came from.
        for (name, path) in corpus() {
            let want = m["inputs"][name]["fnv"].as_str().unwrap_or_else(|| panic!("manifest has no input {}", name));
            let got = format!("{:016x}", fnv_bytes(&std::fs::read(&path).unwrap()));
            assert_eq!(got, want, "input '{}' is not the file the goldens were captured from", name);
        }
        println!("\n[null] {:<36} {:>9} | {:>12} {:>5} | {:>12} {:>5} | {:>12} {:>5}",
                 "render", "frames", "monitor Δmax", "exact", "stream Δmax", "exact", "aux Δmax", "exact");
        let mut fails = Vec::new();
        let mut not_exact = Vec::new();
        for (id, e) in all() {
            let g = &renders[id.as_str()];
            assert!(!g.is_null(), "manifest has no golden for {}", id);
            // Hash is always checkable; the sample diff needs the (gitignored) golden WAV.
            let hash_ok = |h: u64, tap: &str| format!("{:016x}", h) == g[tap]["hash"].as_str().unwrap_or("");
            let fmt = |v: Option<(f32, bool)>, hash_ok: bool| match v {
                Some((d, exact)) => (format!("{:.3e}", d), if exact { "yes" } else { "no" }.to_string(), d <= NULL_BAR, exact),
                None => ("(no wav)".to_string(), if hash_ok { "yes" } else { "no" }.to_string(), hash_ok, hash_ok),
            };
            let (md, mx, mok, mex) = fmt(e.mon_vs_golden, hash_ok(e.mon_hash, "monitor"));
            let (sd, sx, sok, sex) = fmt(e.str_vs_golden, hash_ok(e.str_hash, "stream"));
            let (ad, ax, aok, aex) = match e.aux_hash {
                Some(h) => fmt(e.aux_vs_golden, hash_ok(h, "aux")),
                None => ("—".to_string(), "—".to_string(), true, true),
            };
            println!("[null] {:<36} {:>9} | {:>12} {:>5} | {:>12} {:>5} | {:>12} {:>5}", id, e.frames, md, mx, sd, sx, ad, ax);
            if e.frames as u64 != g["frames"].as_u64().unwrap() { fails.push(format!("{}: frames {} vs golden {}", id, e.frames, g["frames"])); }
            if !mok { fails.push(format!("{} monitor", id)); }
            if !sok { fails.push(format!("{} stream", id)); }
            if !aok { fails.push(format!("{} aux", id)); }
            for (ok, tap) in [(mex, "monitor"), (sex, "stream"), (aex, "aux")] { if !ok { not_exact.push(format!("{} {}", id, tap)); } }
        }
        println!("[null] taps not bit-exact (within the bar, or failing it): {:?}", not_exact);
        assert!(fails.is_empty(), "NULL FAILED (bar {} = −120 dBFS): {:?}", NULL_BAR, fails);
        // Until Jeff re-baselines after FTZ (slice 1, S7), every tap must be BIT-EXACT, not merely within the bar.
        if std::env::var("ETHER_NULL_ALLOW_INEXACT").ok().as_deref() != Some("1") {
            assert!(not_exact.is_empty(), "taps within the bar but not bit-exact: {:?}", not_exact);
        }
    }

    // ── 1b · SLICE 4 — THE RACK PATH NULLS AGAINST THE EXISTING GOLDENS ─────────────────────────────────
    // Every render in the golden set, with its settings delivered ONLY as a rack document (RenderCfg::via_rack:
    // scrambled first, then parsed by rack.rs and pushed through the callback's command queue). Compared to the
    // manifest hashes captured at 6bd33e6 / cd8862d — NOT re-captured. Allocations inside the callback: 0.
    #[test]
    fn rack_path_nulls_against_existing_goldens() {
        let m = manifest().expect("native/goldens/manifest.json missing");
        let renders = m["renders"].as_object().expect("manifest.renders");
        let (mut exact, mut fails, mut allocs) = (0usize, Vec::new(), 0u64);
        let plan = plan();
        for (id, path, cfg) in &plan {
            let cfg = RenderCfg { via_rack: true, ..cfg.clone() };
            let a0 = crate::rt::tl_rt_allocs();
            let r = render_offline(path.to_str().unwrap(), &cfg).unwrap_or_else(|e| panic!("{}: {}", id, e));
            allocs += crate::rt::tl_rt_allocs() - a0;
            let g = &renders[id.as_str()];
            let h = |v: &[f32]| format!("{:016x}", fnv_bits(v));
            let ok_m = h(&r.monitor) == g["monitor"]["hash"].as_str().unwrap_or("");
            let ok_s = h(&r.stream) == g["stream"]["hash"].as_str().unwrap_or("");
            let ok_a = cfg.aux.is_none() || h(&r.aux) == g["aux"]["hash"].as_str().unwrap_or("");
            println!("[rack-null] {:<36} monitor {} stream {} aux {}", id,
                     if ok_m { "BIT-EXACT" } else { "DIFFERS" }, if ok_s { "BIT-EXACT" } else { "DIFFERS" },
                     if cfg.aux.is_none() { "—" } else if ok_a { "BIT-EXACT" } else { "DIFFERS" });
            if ok_m && ok_s && ok_a { exact += 1 } else { fails.push(id.clone()) }
        }
        println!("[rack-null] {}/{} renders bit-exact through the rack path to the EXISTING goldens · {} allocations inside the callback", exact, plan.len(), allocs);
        assert!(fails.is_empty(), "rack path differs from the goldens: {:?}", fails);
        assert_eq!(allocs, 0, "the callback allocated on the rack path");
    }

    // ── 1c · SLICE 5 — EVERY FADER WITH A RACK PRESENT BUT OUT NULLS AGAINST THE EXISTING GOLDENS ─────────
    #[test]
    fn channel_racks_present_but_out_null_against_existing_goldens() {
        let m = manifest().expect("native/goldens/manifest.json missing");
        let renders = m["renders"].as_object().expect("manifest.renders");
        let (mut exact, mut fails, mut allocs) = (0usize, Vec::new(), 0u64);
        let plan = plan();
        for (id, path, cfg) in &plan {
            let cfg = RenderCfg { ch_racks_out: true, ..cfg.clone() };
            let a0 = crate::rt::tl_rt_allocs();
            let r = render_offline(path.to_str().unwrap(), &cfg).unwrap_or_else(|e| panic!("{}: {}", id, e));
            allocs += crate::rt::tl_rt_allocs() - a0;
            let g = &renders[id.as_str()];
            let h = |v: &[f32]| format!("{:016x}", fnv_bits(v));
            let ok = h(&r.monitor) == g["monitor"]["hash"].as_str().unwrap_or("")
                  && h(&r.stream) == g["stream"]["hash"].as_str().unwrap_or("")
                  && (cfg.aux.is_none() || h(&r.aux) == g["aux"]["hash"].as_str().unwrap_or(""));
            if ok { exact += 1 } else { fails.push(id.clone()) }
        }
        println!("[ch-out-null] {}/{} renders bit-exact with a Filters+Gate+PEQ+Comp rack present but OUT on all 12 faders · {} allocations inside the callback", exact, plan.len(), allocs);
        assert!(fails.is_empty(), "an OUT channel rack changed the audio: {:?}", fails);
        assert_eq!(allocs, 0);
    }

    // ── 2 · LINKED ⇒ monitor == stream, bit-exact (and OFF, and EQ which is LINKED + GEQ) ────────────
    #[test]
    fn linked_off_and_eq_taps_identical() {
        for (id, e) in all() {
            let cfg = id.rsplit("__").next().unwrap();
            if matches!(cfg, "LINKED" | "OFF" | "EQ" | "OFF_TRIM_M6" | "LINKED_B1024" | "LINKED_B441") {
                println!("[linked] {:<32} monitor==stream bit-exact: {}  (max Δ {:.3e})", id, e.taps_identical, e.taps_max_diff);
                assert!(e.taps_identical, "{}: monitor and stream taps differ (max Δ {:e})", id, e.taps_max_diff);
            }
        }
    }

    // ── 3 · SPLIT ⇒ the taps differ (silence exempt: zeros in, zeros out, whatever the params) ────────
    #[test]
    fn split_taps_differ() {
        for (id, e) in all() {
            if !id.ends_with("__SPLIT") { continue; }
            if id.starts_with("silence__") {
                println!("[split] {:<32} (exempt) monitor peak {} stream peak {}", id, e.mon_peak, e.str_peak);
                assert!(e.mon_peak == 0.0 && e.str_peak == 0.0, "{}: silence did not render as exact zeros", id);
                continue;
            }
            println!("[split] {:<32} taps differ: {}  (max Δ {:.3e})", id, !e.taps_identical, e.taps_max_diff);
            assert!(!e.taps_identical, "{}: the split made no difference — the stream params are not reaching the instance", id);
        }
    }

    // ── 4 · DETERMINISTIC: every render, rendered again from scratch, is bit-identical ─────────────────
    #[test]
    fn deterministic_two_runs() {
        for (id, p, c) in plan() {
            let first = get(&id);
            let r = render_offline(p.to_str().unwrap(), &c).unwrap();
            let (mh, sh) = (fnv_bits(&r.monitor), fnv_bits(&r.stream));
            let ah = if c.aux.is_some() { Some(fnv_bits(&r.aux)) } else { None };
            println!("[determinism] {:<36} run1 {:016x}/{:016x}  run2 {:016x}/{:016x}", id, first.mon_hash, first.str_hash, mh, sh);
            assert_eq!((mh, sh, ah), (first.mon_hash, first.str_hash, first.aux_hash), "{}: two runs differ", id);
        }
    }

    // ── 5 · NOT DECORATIVE: the processor is really in the rendered path ─────────────────────────────
    #[test]
    fn processor_is_in_the_rendered_path() {
        // Clean tap passes the intersample peak straight through (sample peak −1 dBFS, true peak ≈ +2 dBTP).
        let off = get("isp_m1__OFF");
        let clean_tp = off.str_tp.expect("tp");
        println!("[decorative] isp OFF    stream true peak {:+.2} dBTP (clean)", clean_tp);
        assert!(clean_tp > 1.0, "the clean tap should carry the +2 dBTP intersample peak; got {:+.2}", clean_tp);
        // LOCAL holds its ceiling on the monitor tap; STREAM on the stream tap. 0.3 dB slack = C6's.
        for (id, tp, ceiling) in [
            ("isp_m1__LOCAL", get("isp_m1__LOCAL").mon_tp, -1.0),
            ("isp_m1__STREAM", get("isp_m1__STREAM").str_tp, -1.0),
            ("isp_m1__SPLIT (stream, ceiling −2)", get("isp_m1__SPLIT").str_tp, -2.0),
        ] {
            let tp = tp.expect("tp");
            println!("[decorative] {:<36} processed true peak {:+.2} dBTP (ceiling {:+.1})", id, tp, ceiling);
            assert!(tp <= ceiling + 0.3, "{}: processed tap true peak {:+.2} dBTP exceeds ceiling {:+.1}", id, tp, ceiling);
        }
    }

    // ── 6 · THE AUX RENDERS REALLY EXERCISE AUX, ROOM AND DUCK ────────────────────────────────────────
    #[test]
    fn aux_renders_exercise_room_aux_and_duck() {
        for id in ["music__AUXDUCK_LINKED", "music__AUXDUCK_OFF"] {
            let e = get(id);
            println!("[aux] {:<28} aux tap present: {}  monitor(room)≠stream(air): {}", id, e.aux_hash.is_some(), !e.taps_identical);
            assert!(e.aux_hash.is_some(), "{}: no aux tap", id);
            // The room excludes the aux deck and the air includes it, so the two taps must differ.
            assert!(!e.taps_identical, "{}: room == air — the room chain did not run", id);
        }
        // The duck pulled the music down: AUXDUCK_OFF's stream (music ducked under speech + speech) is not
        // music__OFF's stream (music alone) — trivially true — and, more to the point, its ROOM (music
        // only, ducked) is quieter than music__OFF's monitor (music only, not ducked) over the speech.
        assert_ne!(get("music__AUXDUCK_OFF").mon_hash, get("music__OFF").mon_hash, "the duck left the room untouched");
    }

    // ── 7 · THE THREADED RING DELIVERS EXACTLY WHAT THE DECODER DID (slice 1 S4) ────────────────────
    // The harness pumps synchronously, so it never exercises the real worker THREAD. This does: a real
    // deck_worker thread decodes music.wav into a 2 s ring, prefilled exactly as Control::feed_for does,
    // while this thread drains it in PRNG-sized chunks (1-9 000 frames) with PRNG pauses. The concatenated
    // samples must be bit-identical to draining build_source directly. 20 runs, different seeds.
    #[test]
    fn threaded_ring_delivers_the_direct_decode() {
        use ringbuf::traits::{Consumer, Observer};
        let music = corpus().into_iter().find(|(n, _)| *n == "music").unwrap().1;
        let direct: Vec<f32> = build_source(music.to_str().unwrap(), RATE).unwrap().collect();
        let mut dry_polls_total = 0u64;
        for run in 0..20u64 {
            let (feed, mut feeder) = crate::rt::deck_feed(build_source(music.to_str().unwrap(), RATE).unwrap());
            let mut feed = feed;
            feeder.fill(crate::rt::DECK_REFILL_BELOW);
            let (tx, rx) = std::sync::mpsc::channel();
            let worker = std::thread::spawn(move || crate::rt::deck_worker(rx));
            tx.send(feeder).unwrap();
            let mut rng = 0x9E3779B97F4A7C15u64 ^ (run + 1);
            let mut next = || { rng ^= rng << 13; rng ^= rng >> 7; rng ^= rng << 17; rng };
            let mut out: Vec<f32> = Vec::with_capacity(direct.len());
            let mut buf = vec![0f32; 9_000 * 2];
            let mut dry_polls = 0u64;
            loop {
                let frames = 1 + (next() % 9_000) as usize;
                let eof = feed.eof.load(std::sync::atomic::Ordering::Acquire);
                let got = feed.cons.pop_slice(&mut buf[..frames * 2]);
                out.extend_from_slice(&buf[..got]);
                if got < frames * 2 {
                    if eof && feed.cons.is_empty() { break; }
                    dry_polls += 1;                        // consumer outran the worker; wait for it
                    std::thread::sleep(std::time::Duration::from_millis(1));
                } else if next() % 4 == 0 {
                    std::thread::sleep(std::time::Duration::from_micros(next() % 3_000));
                }
            }
            drop(feed);          // cancels the worker's feeder (it may already be at EOF)
            drop(tx);
            worker.join().unwrap();
            assert_eq!(out.len(), direct.len(), "run {}: sample count differs", run);
            assert!(bits_equal(&out, &direct), "run {}: the ring delivered different samples than the decoder", run);
            dry_polls_total += dry_polls;
        }
        println!("[ring] 20 threaded runs x {} samples: bit-identical to the direct decode ({} dry polls - this consumer is not paced; realtime underruns are measured in the soak)",
                 direct.len(), dry_polls_total);
    }

    // ── 8 · THE CALLBACK NEVER ALLOCATES (slice 1 S6) ─────────────────────────────────────────────────
    // Every render above ran with the allocation trap armed around every callback. Across all of them —
    // every signal, every config, block sizes 441/480/1024, a 48 kHz device, the aux/room/duck path —
    // the callback must not have allocated or freed once.
    #[test]
    fn the_callback_never_allocates() {
        let mut total = 0u64;
        for (id, e) in all() {
            if e.rt_allocs != 0 { println!("[trap] {:<36} {} allocations inside the callback", id, e.rt_allocs); }
            total += e.rt_allocs;
        }
        println!("[trap] {} renders, {} allocations inside the callback", all().len(), total);
        assert_eq!(total, 0, "the audio callback allocated");
    }

    // ── CAPTURE (explicit only) ─────────────────────────────────────────────────────────────────────
    // ADDITIVE by default: renders already in the manifest are NOT re-rendered or rewritten — their goldens
    // stay pinned to the commit they came from — and each new render records the commit it was captured at.
    // ETHER_GOLDEN_RECAPTURE=1 re-captures EVERYTHING as a new baseline, archiving the old manifest as
    // manifest-<commit>.json first (Jeff's ruling for slice 1 S7).
    #[test]
    #[ignore]
    fn capture_goldens() {
        let git = |args: &[&str]| std::process::Command::new("git").args(args).current_dir(env!("CARGO_MANIFEST_DIR"))
            .output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
        let head = git(&["rev-parse", "HEAD"]);
        let dirty = !git(&["status", "--porcelain", "--", "src"]).is_empty();
        assert!(!dirty, "uncommitted changes in native/src — commit the harness first, then capture, so `commit` names the code the goldens came from");
        let rustc = std::process::Command::new("rustc").arg("--version").output().ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
        let recapture = std::env::var("ETHER_GOLDEN_RECAPTURE").ok().as_deref() == Some("1");

        let old = manifest();
        if recapture {
            if let Some(ref m) = old {
                let c = m["commit"].as_str().unwrap_or("unknown");
                let arch = goldens_dir().join(format!("manifest-{}.json", &c[..c.len().min(7)]));
                std::fs::write(&arch, serde_json::to_string_pretty(m).unwrap()).unwrap();
                println!("[capture] archived the previous manifest as {}", arch.display());
            }
        }
        let keep = if recapture { None } else { old.clone() };

        let mut inputs = serde_json::Map::new();
        for (name, path) in corpus() {
            let bytes = std::fs::read(&path).unwrap();
            inputs.insert(name.to_string(), serde_json::json!({
                "file": path.file_name().unwrap().to_string_lossy(),
                "bytes": bytes.len(),
                "fnv": format!("{:016x}", fnv_bytes(&bytes)),
            }));
        }
        let mut renders = keep.as_ref().and_then(|m| m["renders"].as_object().cloned()).unwrap_or_default();
        for (id, p, c) in plan() {
            if renders.contains_key(&id) { continue; }
            let r = render_offline(p.to_str().unwrap(), &c).unwrap();
            write_wav_f32(&goldens_dir().join(format!("{}__monitor.wav", id)), &r.monitor).unwrap();
            write_wav_f32(&goldens_dir().join(format!("{}__stream.wav", id)), &r.stream).unwrap();
            if c.aux.is_some() { write_wav_f32(&goldens_dir().join(format!("{}__aux.wav", id)), &r.aux).unwrap(); }
            let tap = |v: &[f32]| { let (i, tp) = loudness(v); serde_json::json!({
                "hash": format!("{:016x}", fnv_bits(v)), "peak": sample_peak(v), "lufs_i": i, "tp_dbtp": tp }) };
            println!("[capture] {}", id);
            let mut rec = serde_json::json!({
                "cfg": portable(&c), "frames": r.monitor.len() / 2, "commit": head,
                "monitor": tap(&r.monitor), "stream": tap(&r.stream),
                "taps_bit_identical": r.monitor.len() == r.stream.len() && bits_equal(&r.monitor, &r.stream),
            });
            if c.aux.is_some() { rec["aux"] = tap(&r.aux); }
            renders.insert(id, rec);
        }
        let commit = keep.as_ref().and_then(|m| m["commit"].as_str().map(String::from)).unwrap_or(head.clone());
        let manifest = serde_json::json!({
            "about": "DSP parity harness goldens — docs/dsp-parity-harness.md. Hashes are FNV-1a 64 over raw f32 bits. WAVs are gitignored; regenerate with capture_goldens at each render's `commit` (or the top-level `commit` where a render has none).",
            "chain": "Ether v1 (shipped processor params: -14 LUFS, -1.0 dBTP, 120 ms, 1.5 dB/s, ±12 dB)",
            "commit": commit, "src_dirty_at_capture": false, "rustc": rustc,
            "rate": RATE, "block_frames": BLOCK, "tail_buffers": TAIL_BUFFERS,
            "null_bar": { "max_abs": NULL_BAR, "dbfs": -120 },
            "inputs": inputs, "renders": renders,
        });
        std::fs::write(goldens_dir().join("manifest.json"), serde_json::to_string_pretty(&manifest).unwrap()).unwrap();
    }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════
// SLICE 3 — LOUDNESS THROUGH THE REAL CALLBACK (docs/dsp-loudness-meter.md §5.2). The engine's own meter
// (Render::loud) over signals rendered through mixer_callback: Tech 3341 cases with processing OFF (both
// branches carry the clean signal, so the tolerance applies unchanged), the ffmpeg-referenced −23 LUFS file,
// and with processing ON the identity check — the meter reads the samples that actually left.
//   cd native && cargo test --release --lib offline_render::loudness_path -- --nocapture --test-threads=2
// ══════════════════════════════════════════════════════════════════════════════════════════════════════
#[cfg(test)]
mod loudness_path {
    use super::*;
    use crate::loudness::tests::{tones, tp_sine};
    use crate::loudness::{LOUD_LOCAL, LOUD_STREAM, LOUD_AUX};
    use std::path::{Path, PathBuf};

    fn goldens_dir() -> PathBuf { Path::new(env!("CARGO_MANIFEST_DIR")).join("goldens") }
    fn inputs_dir() -> PathBuf { goldens_dir().join("inputs") }
    fn manifest() -> serde_json::Value {
        let p = goldens_dir().join("manifest-loudness.json");
        serde_json::from_str(&std::fs::read_to_string(&p).unwrap_or_else(|_| panic!("{} missing — run node scripts/make-loudness-corpus.js", p.display()))).unwrap()
    }
    /// A synthesized Tech 3341 signal as a 16-bit stereo WAV (L = R), rewritten only if it differs.
    fn input(name: &str, mono: &[f32]) -> PathBuf {
        let p = inputs_dir().join(format!("{}.wav", name));
        let inter: Vec<f32> = mono.iter().flat_map(|&s| [s, s]).collect();
        let want = wav_pcm16_bytes(&inter);
        if std::fs::read(&p).ok().as_deref() != Some(&want[..]) { std::fs::write(&p, &want).unwrap(); }
        p
    }
    fn ref_m23() -> (PathBuf, f64) {
        let m = manifest();
        let r = &m["ref_m23"];
        let p = inputs_dir().join(r["file"].as_str().unwrap());
        let got = format!("{:016x}", fnv_bytes(&std::fs::read(&p).unwrap_or_else(|_| panic!("{} missing — run node scripts/make-loudness-corpus.js", p.display()))));
        assert_eq!(got, r["fnv"].as_str().unwrap(), "ref_m23.wav is not the file manifest-loudness.json was made from");
        (p, r["ffmpeg_i"].as_f64().unwrap())
    }
    fn render(p: &Path, cfg: &RenderCfg) -> Render { render_offline(p.to_str().unwrap(), cfg).unwrap() }
    fn within(got: f64, want: f64, tol: f64) -> bool { got.is_finite() && (got - want).abs() <= tol }

    #[test]
    fn tech3341_integrated_and_true_peak_through_the_callback() {
        let fs = RATE;
        let off = RenderCfg::default();
        let mut fails = Vec::new();
        for (name, sig, want_i) in [
            ("loud_3341_01", tones(fs, &[(20.0, -23.0)]), -23.0),
            ("loud_3341_03", tones(fs, &[(10.0, -36.0), (60.0, -23.0), (10.0, -36.0)]), -23.0),
            ("loud_3341_05", tones(fs, &[(20.0, -26.0), (20.1, -20.0), (20.0, -26.0)]), -23.0),
        ] {
            let r = render(&input(name, &sig), &off);
            for b in [LOUD_LOCAL, LOUD_STREAM] {
                let i = r.loud.b[b].i;
                let ok = within(i, want_i, 0.1);
                println!("[path] {} OFF  {:6}  I {:8.3} LUFS  want {:.1} ±0.1  {}", name, ["LOCAL", "STREAM", "AUX"][b], i, want_i, if ok { "PASS" } else { "FAIL" });
                if !ok { fails.push(format!("{} branch {}", name, b)); }
            }
        }
        let r = render(&input("loud_3341_15", &tp_sine(fs, 4.0, 0.50, 0.0)), &off);
        for b in [LOUD_LOCAL, LOUD_STREAM] {
            let tp = r.loud.b[b].tp_max;
            let ok = tp.is_finite() && tp <= -6.0 + 0.2 && tp >= -6.0 - 0.4;
            println!("[path] loud_3341_15 OFF  {:6}  TP {:7.3} dBTP  want −6.0 +0.2/−0.4  {}", ["LOCAL", "STREAM", "AUX"][b], tp, if ok { "PASS" } else { "FAIL" });
            if !ok { fails.push(format!("3341 #15 TP branch {}", b)); }
        }
        assert!(fails.is_empty(), "through the callback: {:?}", fails);
    }

    #[test]
    fn the_ffmpeg_referenced_minus_23_file_reads_minus_23() {
        let (p, ff) = ref_m23();
        // The METER alone: the engine's meter (the same LoudnessMeters, fed through its callback end) on the
        // file's own samples at the file's own rate — no decoder, no resampler. This separates "does the meter
        // agree with the independent reference" from "what does the product's path do to the programme".
        let (rate, ch) = crate::loudness::tests::read_wav(&p);
        let mut rg = crate::loudness::tests::rig(rate);
        rg.feed(LOUD_LOCAL, &ch[0], &ch[1], &[480], |_, _| {});
        let direct = rg.last(LOUD_LOCAL).i;
        println!("[ref_m23] meter on the file itself ({} Hz, no decoder/resampler) I {:8.3} LUFS · ffmpeg {:.3} · Δ {:+.3} LU", rate, direct, ff, direct - ff);
        assert!(within(direct, -23.0, 0.1), "the meter read the known −23 LUFS file itself as {:.3}", direct);
        // THROUGH THE PRODUCT: decoded and resampled to the program rate by the deck path, mixed, and measured on
        // each branch's output by the engine's own meter.
        let r = render(&p, &RenderCfg::default());
        for b in [LOUD_LOCAL, LOUD_STREAM] {
            let i = r.loud.b[b].i;
            println!("[ref_m23] {:6} through the callback ({} Hz → 44100 Hz) I {:8.3} LUFS · ffmpeg {:.3} · Δ {:+.3} LU · vs the file itself {:+.3} LU · want −23.0 ±0.1",
                     ["LOCAL", "STREAM", "AUX"][b], rate, i, ff, i - ff, i - direct);
            assert!(within(i, -23.0, 0.1), "the known −23 LUFS file read {:.3} on branch {}", i, b);
        }
    }

    #[test]
    fn processed_branches_meter_what_actually_left() {
        // With processing ON the output is no longer −23 (the ride drives it to target, the limiter holds the
        // ceiling). The check is IDENTITY: the engine's meter reads the same programme as an independent
        // BS.1770 measurement of the tap each branch actually delivered (monitor = dl/dr, stream = the ring).
        let (p, _) = ref_m23();
        for (cname, cfg) in [
            ("LINKED", RenderCfg { proc_local: true, proc_stream: true, ..RenderCfg::default() }),
            ("SPLIT", RenderCfg { proc_local: true, proc_stream: true, proc_split: true,
                                  stream_target_lufs: Some(-16.0), stream_ceiling_dbtp: Some(-2.0), ..RenderCfg::default() }),
        ] {
            let r = render(&p, &cfg);
            for (b, tap) in [(LOUD_LOCAL, &r.monitor), (LOUD_STREAM, &r.stream)] {
                let (ind_i, ind_tp) = loudness(tap);
                let (ind_i, ind_tp) = (ind_i.unwrap(), ind_tp.unwrap());
                let m = &r.loud.b[b];
                println!("[identity] {} {:6}  meter I {:8.3} TPmax {:7.3} · independent I {:8.3} TP {:7.3}",
                         cname, ["LOCAL", "STREAM", "AUX"][b], m.i, m.tp_max, ind_i, ind_tp);
                assert!((m.i - ind_i).abs() < 0.01, "{} branch {}: meter I {} vs tap {}", cname, b, m.i, ind_i);
                assert!((m.tp_max - ind_tp).abs() < 0.01, "{} branch {}: meter TP {} vs tap {}", cname, b, m.tp_max, ind_tp);
            }
        }
    }

    #[test]
    fn aux_out_is_measured_on_the_aux_feed() {
        let (p, _) = ref_m23();
        let speech = inputs_dir().join("speech.wav");
        let cfg = RenderCfg { aux: Some(AuxCfg { path: speech.to_string_lossy().into_owned(), duck: false, aux_gain: 1.0 }), ..RenderCfg::default() };
        let r = render(&p, &cfg);
        let (_, ind_tp) = loudness(&r.aux);
        let a = &r.loud.b[LOUD_AUX];
        println!("[aux] meter fed={} M(last) {:.3} TPmax {:.3} · aux ring TP {:.3} · {} frames measured",
                 a.fed, a.m, a.tp_max, ind_tp.unwrap_or(f64::NAN), a.measured_frames);
        assert!(a.measured_frames > 0, "the aux feed was never measured");
        assert!((a.tp_max - ind_tp.unwrap()).abs() < 0.05, "aux TP {} vs the aux ring {}", a.tp_max, ind_tp.unwrap());
    }
}


// ══════════════════════════════════════════════════════════════════════════════════════════════════════
// SLICE 5 — THE CHANNEL EQ MEASURED THROUGH THE REAL CALLBACK (docs/dsp-channel-rack-eq.md §5): steady sines on
// deck A with a channel rack IN, the level of the monitor tap (dl/dr at unity) compared to the input, against the
// values COMPUTED from the same biquads (and those against the spec's numbers). Plus the spec's own receipt: the
// corpus sweep through an HPF at 100 Hz.
//   cd native && cargo test --release --lib offline_render::channel_eq -- --nocapture --test-threads=2
// ══════════════════════════════════════════════════════════════════════════════════════════════════════
#[cfg(test)]
mod channel_eq {
    use super::*;
    use std::path::{Path, PathBuf};

    const A: f64 = 0.251_188_643;   // −12 dBFS
    fn inputs_dir() -> PathBuf { Path::new(env!("CARGO_MANIFEST_DIR")).join("goldens").join("inputs") }
    /// A 6 s stereo sine (16-bit, f64-synthesized), rewritten only if it differs.
    fn tone(f: f64) -> PathBuf {
        let p = inputs_dir().join(format!("ch_tone_{}.wav", f as u32));
        let n = RATE as usize * 6;
        let mut v = Vec::with_capacity(n * 2);
        for i in 0..n { let x = (A * (2.0 * std::f64::consts::PI * f * i as f64 / RATE as f64).sin()) as f32; v.push(x); v.push(x); }
        let want = wav_pcm16_bytes(&v);
        if std::fs::read(&p).ok().as_deref() != Some(&want[..]) { std::fs::write(&p, &want).unwrap(); }
        p
    }
    /// The level of the last 2 s of the monitor tap relative to the input tone, dB (filters settled, fades done).
    fn level_db(f: f64, rack: &str) -> f64 {
        let r = render_offline(tone(f).to_str().unwrap(), &RenderCfg { ch_rack_a: Some(rack.to_string()), ..RenderCfg::default() }).unwrap();
        let frames = r.monitor.len() / 2;
        let (lo, hi) = (frames - RATE as usize * 2 - TAIL_BUFFERS * BLOCK, frames - TAIL_BUFFERS * BLOCK);
        let rms = (r.monitor[lo * 2..hi * 2].iter().step_by(2).map(|&x| (x as f64) * (x as f64)).sum::<f64>() / (hi - lo) as f64).sqrt();
        20.0 * (rms / (A / 2f64.sqrt())).log10()
    }
    fn doc(module: &str) -> String { format!(r#"{{"v":1,"sections":{{"ch":[{{"module":{},"in":true}}]}}}}"#, module) }

    #[test]
    fn hpf_peq_lpf_measured_against_the_computed_values() {
        let fs = RATE as f64;
        let hpf = doc(r#"{"type":"filters","hpf":{"in":true,"freq":100},"lpf":{"in":false,"freq":20000}}"#);
        let peq = doc(r#"{"type":"peq","bands":[{"freq":100,"gain":0,"width":1},{"freq":1000,"gain":6,"width":1},{"freq":3000,"gain":0,"width":1},{"freq":8000,"gain":0,"width":1}]}"#);
        let lpf = doc(r#"{"type":"filters","hpf":{"in":false,"freq":16.1},"lpf":{"in":true,"freq":2000}}"#);
        let h = crate::rack::butter4(100.0, fs, true);
        let b = crate::rack::rbj_peak(1000.0, 6.0, 1.0, fs);
        let l = crate::rack::butter4(2000.0, fs, false);
        let cases: Vec<(&str, &String, f64, f64, f64)> = vec![
            ("HPF 100 Hz", &hpf, 100.0, h[0].mag_db(100.0, fs) + h[1].mag_db(100.0, fs), 0.1),
            ("HPF 100 Hz", &hpf, 50.0, h[0].mag_db(50.0, fs) + h[1].mag_db(50.0, fs), 0.3),
            ("HPF 100 Hz", &hpf, 25.0, h[0].mag_db(25.0, fs) + h[1].mag_db(25.0, fs), 0.5),
            ("PEQ 1 kHz +6, 1 oct", &peq, 1000.0, b.mag_db(1000.0, fs), 0.1),
            ("PEQ 1 kHz +6, 1 oct", &peq, 100.0, b.mag_db(100.0, fs), 0.1),
            ("PEQ 1 kHz +6, 1 oct", &peq, 10_000.0, b.mag_db(10_000.0, fs), 0.1),
            ("LPF 2 kHz", &lpf, 2000.0, l[0].mag_db(2000.0, fs) + l[1].mag_db(2000.0, fs), 0.1),
            ("LPF 2 kHz", &lpf, 4000.0, l[0].mag_db(4000.0, fs) + l[1].mag_db(4000.0, fs), 0.3),
        ];
        let mut fails = Vec::new();
        for (name, rack, f, want, tol) in cases {
            let got = level_db(f, rack);
            let ok = (got - want).abs() <= tol;
            println!("[ch-eq-callback] {:<22} at {:>6} Hz: measured {:>8.3} dB · computed {:>8.3} dB · tol ±{}  {}", name, f, got, want, tol, if ok { "PASS" } else { "FAIL" });
            if !ok { fails.push(format!("{} at {} Hz", name, f)); }
        }
        assert!(fails.is_empty(), "{:?}", fails);
    }

    #[test]
    fn the_spec_receipt_the_sweep_through_an_hpf_at_100_hz() {
        // The corpus sweep (log 20 Hz → 20 kHz over 10 s, −18 dBFS). Its instantaneous frequency is
        // f(t) = 20·1000^(t/10), so it passes f at t = 10·ln(f/20)/ln(1000). Level = the output/input RMS ratio in a
        // ±25 ms window there — coarser than steady tones, hence ±0.5 dB.
        let sweep = inputs_dir().join("sweep_20_20k_m18.wav");
        let hpf = doc(r#"{"type":"filters","hpf":{"in":true,"freq":100},"lpf":{"in":false,"freq":20000}}"#);
        let r = render_offline(sweep.to_str().unwrap(), &RenderCfg { ch_rack_a: Some(hpf), ..RenderCfg::default() }).unwrap();
        let dry = render_offline(sweep.to_str().unwrap(), &RenderCfg::default()).unwrap();
        let fs = RATE as f64;
        let h = crate::rack::butter4(100.0, fs, true);
        let mut fails = Vec::new();
        for (f, tol) in [(100.0, 0.5), (50.0, 0.5)] {
            let t = 10.0 * (f / 20.0f64).ln() / 1000f64.ln();
            let (lo, hi) = (((t - 0.025) * fs) as usize, ((t + 0.025) * fs) as usize);
            let rms = |v: &[f32]| (v[lo * 2..hi * 2].iter().step_by(2).map(|&x| (x as f64) * (x as f64)).sum::<f64>() / (hi - lo) as f64).sqrt();
            let got = 20.0 * (rms(&r.monitor) / rms(&dry.monitor)).log10();
            let want = h[0].mag_db(f, fs) + h[1].mag_db(f, fs);
            let ok = (got - want).abs() <= tol;
            println!("[ch-eq-sweep] HPF 100 Hz on the corpus sweep at {:>4} Hz (t = {:.3} s): {:>8.3} dB · computed {:>8.3} dB · tol ±{}  {}", f, t, got, want, tol, if ok { "PASS" } else { "FAIL" });
            if !ok { fails.push(f); }
        }
        assert!(fails.is_empty(), "{:?}", fails);
    }
}
