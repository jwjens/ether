use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use ringbuf::{HeapRb, HeapProd, HeapCons, traits::{Producer, Consumer, Observer, Split}};
use crate::rt::{Params, RtCmd, AuxCmd, Garbage, MeterFrame, DeckMeter, RtShared, TripleWriter, TripleReader,
                RT_CMD_QUEUE, RT_CMD_PER_BUFFER, RT_GARBAGE_QUEUE, triple, DeckFeed, Feeder, DeckSource,
                deck_feed, deck_worker, DECK_REFILL_BELOW, RtCounters, RtScope, rt_allocs, FtzScope,
                MeterBlock, MeterTap, BUS_PGM, BUS_LOCAL, BUS_STREAM, BUS_MONITOR, BUS_ROOM, BUS_AUX,
                GR_SRC_OWN, GR_SRC_ROOM};
use crate::loudness::{LoudTaps, LoudCons, LoudShared, LoudReader, LoudnessMeters, loud_channels,
                      LOUD_LOCAL, LOUD_STREAM, LOUD_AUX};

// ── Per-station audio-thread liveness (HA health signal) ──────────────────────
// Each station stamps ITS OWN clock on every cpal output callback — there is no
// shared global scalar. A single global stamp masked per-station output death:
// a surviving station kept the one clock fresh while two stations were dead
// (2026-07-10 wedge). The clock is a per-station Arc<AtomicU64>, stamped lock-free
// on the RT audio thread and read by `audioLastCallbackMs(stationId)`. Value =
// epoch ms of THAT station's last output callback; 0 = never fired. Callbacks fire
// continuously while a station's output stream is alive (even idle → silence), so
// this tracks that station's ENGINE-THREAD liveness independent of play state.
// DESIGN-TRUTH §2: "each station is its own sound card."
static STATION_CB_MS: std::sync::OnceLock<Mutex<HashMap<u32, Arc<AtomicU64>>>> =
    std::sync::OnceLock::new();

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Get (creating on first reference) station_id's own callback clock. The returned
/// Arc is cloned into that station's cpal callback and stamped there lock-free; the
/// map lock is touched only here (at station spawn) and in the getter — never in
/// the audio hot path. One slot per station ⇒ no cross-station masking.
fn station_cb_clock(station_id: u32) -> Arc<AtomicU64> {
    let m = STATION_CB_MS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = m.lock().unwrap();
    map.entry(station_id)
        .or_insert_with(|| Arc::new(AtomicU64::new(0)))
        .clone()
}

/// Epoch ms of station_id's most recent output callback (0 if none yet / unknown
/// station). Lock-free atomic read behind a brief, uncontended map lock.
pub fn last_audio_callback_ms(station_id: u32) -> f64 {
    let Some(m) = STATION_CB_MS.get() else { return 0.0 };
    let Ok(map) = m.lock() else { return 0.0 };
    map.get(&station_id)
        .map(|a| a.load(Ordering::Relaxed) as f64)
        .unwrap_or(0.0)
}

// ── Existing public types ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DeckInfo {
    pub id: String,
    pub status: String,
    pub title: String,
    pub artist: String,
    pub file_path: String,
    pub volume: f32,
    pub is_finished: bool,
    /// Console channel cut for this slot — surfaced so the UI can READ the gate it is drawing
    /// instead of asserting it. A control that gates air must be able to show observed state.
    pub muted: bool,
}

pub struct DeckMeta {
    pub title: String,
    pub artist: String,
    pub file_path: String,
    pub volume: f32,
    pub gain_db: f32,
    pub status: String,
    /// Mirrors the mixer slot's channel cut so audio_get_state reports it.
    pub muted: bool,
}

impl DeckMeta {
    pub fn new() -> Self {
        DeckMeta {
            title: String::new(),
            artist: String::new(),
            file_path: String::new(),
            volume: 1.0,
            gain_db: 0.0,
            status: "idle".to_string(),
            muted: false,
        }
    }
    pub fn info(&self, id: &str, is_finished: bool) -> DeckInfo {
        DeckInfo {
            id: id.to_string(),
            status: if is_finished { "ended".to_string() } else { self.status.clone() },
            title: self.title.clone(),
            artist: self.artist.clone(),
            file_path: self.file_path.clone(),
            volume: self.volume,
            is_finished,
            muted: self.muted,
        }
    }
}

/// v4.4.46 mix-telemetry: per-deck snapshot for the daemon's `[mix sN]` heartbeat. Read from
/// BusState.decks under the lock GetLevel already holds — no new state, no hot-path cost.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DeckTel {
    pub id: String,            // "A" | "B" | "C"
    pub source_present: bool,  // deck.source.is_some() — a decoder is loaded
    pub active: bool,          // deck.active — mixer is pulling this deck
    pub paused: bool,          // deck.paused
    /// CHANNEL CUT — does the ENGINE have this slot cut?
    ///
    /// Observed, never inferred, exactly like `duck` below. The board's ON lamp had nothing to read,
    /// so it rendered `srcChannelOn[slot] ?? true` — a CLAIM. A channel nobody had pressed showed ON
    /// while the engine was never told, and audio fired into it went nowhere until the operator
    /// toggled OFF/ON, whose second press was the first setMuted the engine ever heard. With this
    /// field the lamp is a READING of the cut, and that state stops being expressible.
    #[serde(default)]
    pub muted: bool,
    pub volume: f32,           // linear fader (post-gain)
    pub gain_db: f32,          // per-deck trim in dB
    /// SAMPLE CLOCK — per-deck monotonic PROGRAM_RATE frame count (DeckSlot.frames_played).
    /// position = frames_played / 44100. The daemon derives its authoritative positionSec from
    /// this; wall-clock extrapolation is now only the fallback.
    /// docs/sample-accurate-position-design-2026-08-09.md
    #[serde(default)]
    pub frames_played: u64,
    /// DUCKER (slice 3) — does the ENGINE have this slot armed?
    ///
    /// Observed, never inferred. The strip's DUCK ON is what the DATABASE says; this is what the
    /// engine was actually told. A control whose stored state and engine state can silently disagree
    /// is how "the toggle is on and nothing ducks" becomes a diagnosis instead of a glance.
    #[serde(default)]
    pub duck: bool,
    /// POST-FADER PEAK for this slot, 0..1 (1.0 = 0 dBFS) — the same number `level_a/b/c/cart`
    /// carry, but available for EVERY slot. bus.peaks has always been computed for all 7
    /// (`for i in 0..7` at the end of the mixer callback); only A/B/C/CART were ever surfaced, so a
    /// deck D/E/F meter had nothing to read. Additive and #[serde(default)], so an older reader that
    /// does not know this field is unaffected.
    #[serde(default)]
    pub peak: f32,
    /// SLICE 1 S6 — buffers in which this deck's ring ran dry before end of file (0 on a healthy disk).
    #[serde(default)]
    pub underruns: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AudioLevels {
    pub level_a: f32,
    pub level_b: f32,
    pub level_c: f32,
    pub level_cart: f32,
    pub level_master: f32,
    /// ROOM (local speaker) peak — see BusState::room_peak. Distinct from level_master: master is what
    /// AIRS, room is what the operator HEARS. With the aux monitor bus these are no longer the same
    /// signal, which is exactly why this exists.
    #[serde(default)]
    pub level_room: f32,
    /// Frames the AUX output device callback has written. Monotonic; a rising value is the only
    /// honest evidence that the aux bus is reaching a device.
    #[serde(default)]
    pub aux_frames: u64,
    /// Peak of the AUX feed (post fader/cut, post slot level) — what the aux monitor is putting out.
    #[serde(default)]
    pub aux_peak: f32,
    /// AUX processing meters — same four measurements as the station's, same taps, same processor.
    #[serde(default)] pub aux_proc_in_lufs:  f32,
    #[serde(default)] pub aux_proc_out_lufs: f32,
    #[serde(default)] pub aux_proc_gr_db:    f32,
    #[serde(default)] pub aux_proc_ride_db:  f32,
    /// DUCKER (slice 3) — the gain currently applied to this station's programme. 1.0 = not ducking.
    /// Per station, like everything else on this bus: one station ducking says nothing about another.
    #[serde(default)] pub duck_gain: f32,
    // ── v4.4.46 mix telemetry (diagnostic only; all #[serde(default)] so older readers/paths are
    // unaffected). Populated by the live GetLevel handler from BusState, which it already locks. ──
    /// Monotonic count of PROGRAM-RATE frames the mixer callback has consumed. The daemon's
    /// heartbeat logs the DELTA since its last line ("frames consumed since last report").
    #[serde(default)]
    pub frames_total: u64,
    /// Decks currently being mixed (active && !paused && source present) at sample time.
    #[serde(default)]
    pub active_decks: u32,
    /// bus.monitor_vol — the local studio-monitor (device) gain; never the program bus.
    #[serde(default)]
    pub mon_vol: f32,
    // ── Audio Processing v1 meters — observed at the stage taps (all #[serde(default)] so older readers
    // are unaffected). Feeds the dedicated processing-meters event: IN/OUT VU, LUFS in/out/target, GR bar. ──
    #[serde(default)] pub proc_local:  bool,
    #[serde(default)] pub proc_stream: bool,
    #[serde(default)] pub proc_target_lufs: f32,
    // The operator's live processor parameters, echoed back so the panel shows what the ENGINE is
    // running rather than what the UI last sent — the same observed-not-claimed rule as the meters.
    #[serde(default)] pub proc_ceiling_dbtp:   f32,
    #[serde(default)] pub proc_release_ms:     f32,
    #[serde(default)] pub proc_ride_rate:      f32,
    #[serde(default)] pub proc_ride_clamp:     f32,
    #[serde(default)] pub proc_ride_bypass:    bool,
    #[serde(default)] pub proc_limiter_bypass: bool,
    // THE STREAM BRANCH (2026-09-07). Its own meters and its own parameters — see BusState.
    // Every one of these must ALSO be named in the json! block of audio_get_levels in lib.rs, or it
    // dies at the NAPI boundary. audiod/smoke-meter-contract.js fails the build if one is not.
    #[serde(default)] pub proc_stream_in_lufs:  f32,
    #[serde(default)] pub proc_stream_out_lufs: f32,
    #[serde(default)] pub proc_stream_gr_db:    f32,
    #[serde(default)] pub proc_stream_ride_gain_db: f32,
    #[serde(default)] pub proc_stream_in_peak:  f32,
    #[serde(default)] pub proc_stream_out_peak: f32,
    #[serde(default)] pub proc_stream_target_lufs:  f32,
    #[serde(default)] pub proc_stream_ceiling_dbtp: f32,
    #[serde(default)] pub proc_stream_release_ms:   f32,
    #[serde(default)] pub proc_stream_ride_rate:    f32,
    #[serde(default)] pub proc_stream_ride_clamp:   f32,
    #[serde(default)] pub proc_stream_ride_bypass:    bool,
    #[serde(default)] pub proc_stream_limiter_bypass: bool,
    #[serde(default)] pub proc_in_lufs:  f32,
    #[serde(default)] pub proc_out_lufs: f32,
    #[serde(default)] pub proc_gr_db:    f32,
    /// The loudness ride's CURRENT APPLIED GAIN in dB, signed: + = boosting quiet material toward the
    /// target, - = pulling loud material down. This is the number that MOVES and the one the meters
    /// exist to show. proc_gr_db is the LIMITER's reduction, which sits at 0 at steady state by design —
    /// binding a bar to it made the bar look broken (2026-08-01).
    #[serde(default)] pub proc_ride_gain_db: f32,
    #[serde(default)] pub proc_in_peak:  f32,
    #[serde(default)] pub proc_out_peak: f32,
    /// Per-deck A/B/C telemetry snapshot (source/active/paused/volume/gain).
    #[serde(default)]
    pub decks: Vec<DeckTel>,
    /// SLICE 1 S6 — the audio callback's health counters (rt.rs RtCounters), cumulative per station.
    #[serde(default)]
    pub rt: RtLevels,
}

/// SLICE 1 S6 — the callback's counters as they cross the NAPI boundary (every one is named in lib.rs's json!).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RtLevels {
    pub callbacks: u64,
    pub underruns: u64,
    pub underrun_frames: u64,
    pub lock_misses: u64,
    pub overruns: u64,
    pub events_dropped: u64,
    pub buffer_clamped: u64,
    pub garbage_leaked: u64,
    /// OUTPUT LIVENESS — stalls (the output callback stopped; the stream was reopened) and fallbacks to the
    /// system default. Written by the dispatch thread (outwatch.rs).
    #[serde(default)]
    pub stalls: u64,
    #[serde(default)]
    pub stall_fallbacks: u64,
    /// Errors cpal reported on the output stream (each one reopened the output, like a stall).
    #[serde(default)]
    pub device_errors: u64,
    /// Allocations inside the callback — Some in a debug build (the trap), None in the shipped release.
    pub allocs: Option<u64>,
}

pub type SharedLevels = Arc<Mutex<AudioLevels>>;

// ── Broadcast (profanity) delay control ───────────────────────────────────────
// Shared between the NAPI layer and the program-bus drain thread. The delay lives
// on the STREAM path only (drain → ffmpeg → Icecast); the local monitor stays live,
// so the operator hears live and can DUMP before the buffered audio airs.
//   • target_samples > 0  → stream lags live by that many interleaved f32 samples.
//   • dump_flag           → one-shot: flush the buffered (not-yet-aired) audio and
//                           splice straight to live (then target is set to 0 = off).
//   • buffered_samples    → current FIFO fill, published for the UI meter.
pub struct DelayControl {
    pub target_samples:   std::sync::atomic::AtomicUsize,
    pub dump_flag:        AtomicBool,
    pub buffered_samples: std::sync::atomic::AtomicUsize,
}
impl DelayControl {
    pub fn new() -> Self {
        DelayControl {
            target_samples:   std::sync::atomic::AtomicUsize::new(0),
            dump_flag:        AtomicBool::new(false),
            buffered_samples: std::sync::atomic::AtomicUsize::new(0),
        }
    }
}
pub type SharedDelay = Arc<DelayControl>;

#[derive(Clone)]
pub struct FinishedFlags {
    pub a: Arc<AtomicBool>,
    pub b: Arc<AtomicBool>,
    pub c: Arc<AtomicBool>,
    pub d: Arc<AtomicBool>,
    pub e: Arc<AtomicBool>,
    pub f: Arc<AtomicBool>,
    pub cart: Arc<AtomicBool>,
}

impl FinishedFlags {
    pub fn new() -> Self {
        FinishedFlags {
            a: Arc::new(AtomicBool::new(false)),
            b: Arc::new(AtomicBool::new(false)),
            c: Arc::new(AtomicBool::new(false)),
            d: Arc::new(AtomicBool::new(false)),
            e: Arc::new(AtomicBool::new(false)),
            f: Arc::new(AtomicBool::new(false)),
            cart: Arc::new(AtomicBool::new(false)),
        }
    }
    pub fn flag(&self, deck: &str) -> Option<&Arc<AtomicBool>> {
        match deck {
            "A" => Some(&self.a),
            "B" => Some(&self.b),
            "C" => Some(&self.c),
            "D" => Some(&self.d),
            "E" => Some(&self.e),
            "F" => Some(&self.f),
            "CART" => Some(&self.cart),
            _ => None,
        }
    }
    pub fn set(&self, deck: &str) {
        if let Some(f) = self.flag(deck) { f.store(true, Ordering::SeqCst); }
    }
    pub fn take(&self, deck: &str) -> bool {
        if let Some(f) = self.flag(deck) {
            f.compare_exchange(true, false, Ordering::SeqCst, Ordering::SeqCst).is_ok()
        } else { false }
    }
    pub fn clear(&self, deck: &str) {
        if let Some(f) = self.flag(deck) { f.store(false, Ordering::SeqCst); }
    }
}

#[derive(Debug)]
pub enum AudioCmd {
    Load { deck: String, file_path: String, title: String, artist: String, gain_db: f32 },
    Play(String),
    Pause(String),
    Stop(String),
    SetVolume { deck: String, volume: f32 },
    /// Console channel on/off for one slot. muted=true cuts the channel to the program bus
    /// entirely; it survives Load, so a cart fired into a cut channel stays off air. Distinct
    /// from SetVolume (a fader position) and from Pause (a transport state).
    SetMuted { deck: String, muted: bool },
    GetLevel,
    Ping,
    StartStream { server: String, port: u16, mount: String, password: String, station_name: String },
    StopStream,
    UpdateMetadata { title: String, artist: String },
    SwitchDevice(String),
    /// Reopen THIS station's output stream on its current device — per-station recovery
    /// that automates the manual automation toggle, scoped to one card. DESIGN-TRUTH §2.
    ReopenOutput,
    SetEq(Vec<f32>),
    /// Local studio-monitor output gain (0..4). Affects ONLY the speakers tap — the program
    /// bus → Icecast stream is untouched, so muting the monitor never changes what airs.
    SetMonitorVolume(f32),
    /// MASTER OUT gain (broadcast). See Bus::master_vol.
    SetMasterVolume(f32),
    /// MASTER MONITOR gain (the room). Per-station by law; main fans one fader out to all stations.
    SetMasterMonitorVolume(f32),
    /// Audio Processing v1 — per-station program-bus loudness. (process_local, process_stream, target LUFS).
    /// Both bools default OFF; the daemon delivers this like the segue setting (survives respawns).
    SetProcessing { local: bool, stream: bool, target_lufs: f32 },
    /// AUX MONITOR (2026-08-18): set the ROOM level for one aux deck (D/E/F only). 0.0 = not selected
    /// by any slot = silent on the local speakers. Never affects air.
    SetAuxMonitor { deck: String, gain: f32 },
    /// DUCKER (slice 3) — arm or disarm one channel's duck. A preference on the channel; whether it
    /// can duck at all is decided by the slot's KIND, which this cannot override.
    SetDuck { deck: String, enabled: bool },
    /// WHICH BUS a slot joins, set at runtime from deck_configs rather than fixed at construction.
    ///
    /// `kind` was write-once (`default_kind_for` at BusState::new), which is why a sweeper could
    /// only ever be slot 6: its behaviour was welded to its address. Dialling a channel to a sweeper
    /// source now sets this, and every `is_aux` branch answers exactly as it did for slot 6.
    ///
    /// "sweeper" => Sweeper (sums with the music), anything else => Source. Rotation decks A/B/C
    /// are never re-kinded. The STRING is the bus, not the content: what plays on the slot — cart,
    /// sweeper, announcement — is the operator's dropdown, and is a separate question.
    SetSlotKind { deck: String, kind: String },
    /// Receiver side — does this deck step back when a source ducks?
    SetDuckable { deck: String, duckable: bool },
    /// DUCKER tuning, per STATION — there is ONE duck envelope per bus, so every one of these is
    /// station-wide by construction, never per channel. Dialled by ear from Preferences.
    SetDuckParams { depth_db: f32, threshold_db: f32, attack_ms: f32, hold_ms: f32, release_ms: f32 },
    /// PFL on/off for one channel (docs/help-channel-faders.md). Momentary operator state: never persisted.
    SetPfl { deck: String, on: bool },
    /// The programme dim in the local output while any PFL is on, dB (clamped to PFL_DIM_DB_RANGE).
    SetPflDim(f32),
    /// The PFL cue output device on THIS machine; "" = same as the main output.
    SetCueDevice(String),
    /// The program processor's operator-settable NUMBERS. Separate from SetProcessing (the two on/off
    /// toggles and the loudness target) so a station that never sends this is bit-identical to before.
    /// `branch`: 0 = LOCAL (studio monitor), 1 = STREAM. Every parameter is independent per branch;
    /// the daemon mirrors local into stream while the operator has the two linked.
    SetProcessorParams { branch: u8, target_lufs: f32, ceiling_dbtp: f32, release_ms: f32,
                         ride_rate_db_s: f32, ride_clamp_db: f32 },
    /// BYPASS, ON ITS OWN COMMAND — and this separation is the whole point.
    ///
    /// It used to ride SetProcessorParams. The daemon re-asserts the numbers from the KV every ~15s
    /// while processing is on, and had to pass SOMETHING for bypass, so it passed `false` — silently
    /// un-bypassing whatever the operator had engaged, within 15 seconds, every time. Splitting the
    /// command means the re-assert has no way to express bypass and therefore cannot clear it. A
    /// structural guarantee, not a rule someone has to remember. 2026-09-07.
    SetProcessorBypass { branch: u8, ride_bypass: bool, limiter_bypass: bool },
    /// SLICE 4 — the whole master rack, parsed and validated (rack.rs). The live-only bypasses are NOT taken
    /// from it: the ride/limiter IN the engine is running is kept (Jeff's 2026-09-07 ruling).
    SetMasterRack(crate::rack::MasterRack),
    /// SLICE 5 — one fader's channel rack (parsed and clamped in rack.rs); `slot` is the engine slot index.
    SetChannelRack { slot: usize, rack: crate::rack::ChannelRack },
    /// SLICE 7 — a show Take (show.rs): every channel the blade hands over and the master, written into the Params
    /// copy in ONE arm and sent as ONE block, so the whole show lands in the same buffer or none of it does.
    ApplyShow(Box<crate::show::ShowApply>),
    /// SLICE 8 — what the RTA listens to: a channel, the master, or nothing (docs/dsp-channel-rta.md §1).
    SetRta(crate::rta::RtaTarget),
    /// THE MIC (docs/dsp-mic-in-engine.md) — patch an input device onto a source slot. `device` empty =
    /// unpatch; `channel` 0-based; `gain_db` −10…+40 (clamped in micin.rs).
    SetMicInput { slot: usize, device: String, channel: u16, gain_db: f32 },
    /// REMOTE LINK — patch (Some) or unpatch (None) this station's Link input on a source slot (linknet.rs).
    SetLinkInput { slot: usize, slot_name: String, cfg: Option<crate::linknet::RxCfg> },
    /// REMOTE LINK — SEND TO another station (Some) or stop (None).
    SetLinkSend(Option<crate::linknet::SendCfg>),
    /// Choose the output device for the AUX monitor bus. Empty string = none = the aux stream is
    /// closed and the bus is silent.
    SetAuxDevice(String),
}

pub struct AudioState {
    pub deck_a: DeckMeta,
    pub deck_b: DeckMeta,
    pub deck_c: DeckMeta,
    pub deck_d: DeckMeta,
    pub deck_e: DeckMeta,
    pub deck_f: DeckMeta,
    /// Dedicated cart channel — mixer slot 6, never in the assignable deck pool.
    /// Always summed to the program bus so carts fire out of master over the music.
    pub deck_cart: DeckMeta,
    /// The source channels S1–S5 (mixer slots 7–11) — each its OWN reported state. (2026-09-26: they had no
    /// record and fell through to deck B, so a mic fader on S3 moved deck B's fader, and a stop on an S slot
    /// cleared B's file path. docs/source-slot-meta-falls-to-deck-b-2026-09-26.md)
    pub deck_s: [DeckMeta; 5],
    /// Any name that is not a fader: a throwaway record — NEVER a real deck's. deck_meta_mut logs it once.
    pub deck_unknown: DeckMeta,
    pub sender: std::sync::mpsc::Sender<AudioCmd>,
    pub is_playing: Arc<AtomicBool>,
    pub levels: SharedLevels,
    pub delay: SharedDelay,
    pub finished: FinishedFlags,
    pub watchdog_active: bool,
    pub watchdog_threshold_sec: f64,
    pub watchdog_triggered_count: u32,
    pub program_bus_port: u16,
    /// SLICE 2 — the meter bus reader (shared with the station's dispatch thread) and the ack atomic.
    pub meters: MetersHandle,
}

/// TEST-ONLY — a station's AudioState with NO device and no mixer thread (the meter handle from a BusState's
/// handles, as the slice 2/3 tests build it), and the receiving end of its command channel. Lets the NAPI
/// functions be exercised end to end without opening audio hardware.
#[cfg(test)]
pub(crate) fn test_audio_state() -> (AudioState, std::sync::mpsc::Receiver<AudioCmd>) {
    let (tx, rx) = std::sync::mpsc::channel();
    let (prod, _cons) = HeapRb::<f32>::new(PROGRAM_BUS_BUF).split();
    let mut b = BusState::new(crate::eq::new_shared_eq(44100.0), prod, 44100, Arc::new(AtomicBool::new(false)));
    let h = b.handles.take().unwrap();
    let (meters, _loud) = MetersHandle::from_parts(Arc::new(Mutex::new(h.meter_r)), h.shared.clone(), h.loud_cons, h.loud_shared);
    (AudioState {
        deck_a: DeckMeta::new(), deck_b: DeckMeta::new(), deck_c: DeckMeta::new(), deck_d: DeckMeta::new(),
        deck_e: DeckMeta::new(), deck_f: DeckMeta::new(), deck_cart: DeckMeta::new(),
        deck_s: std::array::from_fn(|_| DeckMeta::new()), deck_unknown: DeckMeta::new(),
        sender: tx, is_playing: Arc::new(AtomicBool::new(false)),
        levels: Arc::new(Mutex::new(AudioLevels::default())), delay: Arc::new(DelayControl::new()),
        finished: FinishedFlags::new(), watchdog_active: false, watchdog_threshold_sec: 10.0, watchdog_triggered_count: 0,
        program_bus_port: 0, meters,
    }, rx)
}

/// SLICE 2 — what audio_get_meters needs: the station's ONE meter-frame reader (the same triple buffer
/// GetLevel reads — shared behind a mutex between the two NON-audio threads that read it; the callback never
/// sees this lock) and the atomic that acknowledges a consumed window (docs/dsp-meter-bus.md §1.2, §1.4).
#[derive(Clone)]
pub struct MetersHandle {
    pub(crate) reader: Arc<Mutex<TripleReader<MeterFrame>>>,
    pub(crate) shared: Arc<RtShared>,
    /// SLICE 3 — the station's loudness frame (published by its meter thread) and its reset epochs.
    pub(crate) loud: LoudReader,
    pub(crate) loud_shared: Arc<LoudShared>,
    /// SLICE 8 — the station's RTA frame (published by its meter thread). None where no meter thread runs it.
    pub(crate) rta: Option<crate::rta::RtaReader>,
}
impl MetersHandle {
    /// Read the newest meter window and acknowledge it. Returns the block (raw peaks + Σ² + frame count).
    /// (The product reads through read_all since slice 3; the slice 2 tests read windows through this.)
    #[cfg(test)]
    pub(crate) fn read_and_ack(&self) -> Option<MeterBlock> {
        let f = self.reader.lock().ok()?.read();
        self.shared.meter_ack.store(f.meters.epoch, Ordering::Release);
        Some(f.meters)
    }
    /// SLICE 2 + 3 — the newest meter window (acknowledged, as read_and_ack), the parameters the callback ran
    /// with in the same frame (for the ceiling echo), and the newest loudness frame.
    pub(crate) fn read_all(&self) -> Option<(MeterBlock, Params, crate::loudness::LoudnessFrame)> {
        let f = self.reader.lock().ok()?.read();
        self.shared.meter_ack.store(f.meters.epoch, Ordering::Release);
        let lf = self.loud.lock().ok()?.read();
        Some((f.meters, f.params, lf))
    }
    /// SLICE 3 — Build a station's meter handle from its state's handles, with the loudness meter that feeds
    /// it (the caller runs that meter: a thread in the product, inline in the offline harness).
    pub(crate) fn from_parts(reader: Arc<Mutex<TripleReader<MeterFrame>>>, shared: Arc<RtShared>,
                             loud_cons: LoudCons, loud_shared: Arc<LoudShared>) -> (MetersHandle, LoudnessMeters) {
        let (lm, loud) = LoudnessMeters::new(loud_cons, loud_shared.clone(), PROGRAM_RATE);
        (MetersHandle { reader, shared, loud, loud_shared, rta: None }, lm)
    }
}

pub type SharedAudioState = Arc<Mutex<AudioState>>;

// ── Phase B1: per-deck decoder slot ──────────────────────────────────────────
// Holds the live decoder iterator for one deck, erased to a trait object so
// the type doesn't bleed through the whole file. Owned by BusState which lives
// inside the cpal callback closure. Commands update fields under a Mutex lock
// held only for microseconds (file I/O happens before the lock is acquired).

pub struct DeckSlot {
    /// SLICE 1 — what this slot IS. Set once at construction from default_kind_for(); slice 2 will
    /// let deck_config drive it. Read by the AUX monitor tap and (slice 3) the ducker.
    pub kind:     SlotKind,
    /// Live feed — None when no track is loaded or after a track finishes. S4: a ring filled by this deck's
    /// decode worker; the callback only pops it (rt.rs DeckFeed).
    pub source:   Option<DeckFeed>,
    pub volume:   f32,
    pub paused:   bool,
    /// Set true on Play, false on Stop/finish. Used by the callback to detect
    /// natural end-of-track (source exhausted while active == true).
    pub active:   bool,
    // (S3) path/title/artist moved to the dispatch thread's DeckShadow: the callback never holds a
    // String, so nothing it replaces can free one on the audio thread.
    pub gain_db:  f32,
    /// CHANNEL CUT — a console channel on/off, not a fader position and not a playback state.
    /// While true this slot contributes NOTHING to the program bus, so a jingle or cart that
    /// fires into a cut channel never reaches air. Deliberately SEPARATE from `volume`: `Load`
    /// rewrites `volume` on every fire (see the Load arm), so a mute expressed as volume 0 is
    /// wiped by the next cart and the channel silently re-opens. `muted` is owned by the operator
    /// and is never touched by Load, Play, Stop or a fader move — only by SetMuted.
    pub muted:    bool,
    /// SAMPLE CLOCK — monotonic count of PROGRAM_RATE stereo frames actually pulled from THIS
    /// deck's source. This is the single position authority: position = frames_played / 44100.
    ///
    /// Written ONLY by mixer_callback, under the lock it already holds — no new lock, no atomic,
    /// no allocation on the audio thread (same discipline as bus.frames_consumed below).
    ///
    /// Counted from REAL loop iterations, never `prog_frames`: that value carries a +2 rounding
    /// margin on non-44.1k devices and the pull loop breaks early on source exhaustion, so adding
    /// it would over-count on both paths.
    ///
    /// PER-DECK, not stream-global, because two decks play at different positions during a
    /// crossfade and a shared counter can express neither. Reset on Load, Stop, and device-failover
    /// restore. NOT reset on Pause/Play — resume must continue where it stopped.
    /// docs/sample-accurate-position-design-2026-08-09.md
    pub frames_played: u64,
}

impl DeckSlot {
    pub fn new() -> Self {
        DeckSlot {
            // Overwritten immediately by BusState::new via default_kind_for(i); this default only
            // applies to a DeckSlot built outside the pool.
            kind:    SlotKind::Rotation,
            source:  None,
            volume:  1.0,
            paused:  true,
            active:  false,
            gain_db: 0.0,
            muted:   false,
            frames_played: 0,
        }
    }
}

// ── BusState ──────────────────────────────────────────────────────────────────
// Shared between the cpal callback (audio OS thread) and the command dispatch
// thread. The Mutex is held for the minimum time — decode happens outside.
// Six decks: index 0=A, 1=B, 2=C, 3=D, 4=E, 5=F.

pub struct BusState {
    pub decks:       [DeckSlot; SLOT_COUNT],
    pub eq:          crate::eq::SharedEq,
    pub ring_prod:   HeapProd<f32>,
    pub sample_rate: u32,
    /// REAL post-fader peak per deck (0..1, 1.0 = 0 dBFS) + the program/master peak,
    /// written by mixer_callback each buffer with VU release ballistics; read by GetLevel.
    pub peaks:       [f32; SLOT_COUNT],
    pub master_peak: f32,
    /// Local studio-monitor gain applied to the DEVICE (speaker) output only — never the
    /// program bus. 1.0 = unity; 0.0 = silent speakers while the station keeps broadcasting.
    pub monitor_vol: f32,
    /// MASTER OUT — the broadcast gain. Applied to the program bus BEFORE the VU meter and before the
    /// stream/device split, so it rides what LISTENERS hear and the master VU shows the level actually
    /// going out. monitor_vol above trims only the room and never touches air. 1.0 = unity.
    /// docs/master-monitor-faders-dead-2026-08-06.md
    pub master_vol: f32,
    /// MASTER MONITOR — the operator's ONE room level, held PER STATION.
    ///
    /// The CONTROL is single; the STATE is per-station because DESIGN-TRUTH §2 is law: "each station
    /// acts like its own separate sound card; stations do not know each other exists" — no shared
    /// mutable state below the engine layer. Main fans the one fader out to every station. (A global
    /// static was tried 2026-08-06 and correctly rejected by check-no-global-audio-statics.js.)
    ///
    /// Distinct from monitor_vol: that is the per-station STRIP level owned by StationMonitorMixer
    /// ("how much of this station in the room"); this is the room's overall level. Multiplied together
    /// in the device branch ONLY, so neither can reach air. 1.0 = unity.
    pub master_monitor_vol: f32,
    /// Per-station program-bus stream-client flag (DESIGN-TRUTH §2). Set by THIS
    /// station's drain thread on its Icecast client connect/disconnect; read by THIS
    /// station's mixer callback to gate its own program-bus push. Never shared.
    pub stream_connected: Arc<AtomicBool>,
    /// v4.4.46: monotonic count of PROGRAM-RATE frames the mixer callback has consumed. Written
    /// ONLY by mixer_callback under the lock it already holds (no new lock, no atomic); read by
    /// GetLevel into AudioLevels.frames_total. The daemon heartbeat logs the delta = a live "is the
    /// callback still pulling PCM?" signal, distinct from the VU levels and the cpal-callback stamp.
    pub frames_consumed: u64,
    /// Audio Processing v1 — per-station program-bus loudness. Both toggles default OFF → the branch takes
    /// the CLEAN tap and the processor is never run (bit-identical passthrough). Set by the NAPI command
    /// thread (SetProcessing), read by mixer_callback under the lock it already holds. Processor behind its
    /// own lock (mirrors bus.eq) so it stays off the command path; try_lock in the callback, never blocks.
    pub proc_local:  bool,
    pub proc_stream: bool,
    pub proc_target_lufs: f32,
    /// Operator processor parameters, applied to the processor each buffer alongside the target. Held
    /// here (not in the processor) for the same reason proc_target_lufs is: the callback already holds
    /// this lock, and the processor has its own.
    pub proc_ceiling_dbtp: f32,
    pub proc_release_ms: f32,
    pub proc_ride_rate: f32,
    pub proc_ride_clamp: f32,
    pub proc_ride_bypass: bool,
    pub proc_limiter_bypass: bool,
    /// THE LOCAL (studio monitor) branch's processor. Until the split it was the ONLY one, shared by
    /// both branches — so what Jeff heard and what listeners heard were literally the same samples.
    pub processor:   Arc<crate::rt::RtMutex<crate::program_processor::ProgramProcessor>>,

    // ── THE LOCAL / STREAM SPLIT (2026-09-07) ────────────────────────────────────────────────────
    // A second, fully independent instance for the stream branch: its own ride state, its own limiter
    // state, its own parameters and its own meters. The monitor is what Jeff hears in the room; the
    // stream is what listeners hear through an encoder. They are different problems and now they are
    // different processors.
    //
    // BIT-IDENTICAL WHERE NOTHING IS STORED: these default to the SAME shipped chain as the local set,
    // and the daemon mirrors the local values into them whenever `proc_split` is off. Two instances
    // with identical parameters and identical input produce identical output — asserted by C7 — so a
    // station that has never touched the split hears exactly what it heard before.
    pub proc_stream_target_lufs: f32,
    pub proc_stream_ceiling_dbtp: f32,
    pub proc_stream_release_ms: f32,
    pub proc_stream_ride_rate: f32,
    pub proc_stream_ride_clamp: f32,
    pub proc_stream_ride_bypass: bool,
    pub proc_stream_limiter_bypass: bool,
    pub processor_stream: Arc<crate::rt::RtMutex<crate::program_processor::ProgramProcessor>>,
    /// PER-BRANCH METERS. One set of numbers for two processors would be a meter that lies: with the
    /// split on, the two branches ride to different targets and reduce by different amounts at the same
    /// instant. The legacy proc_* fields keep describing the LOCAL branch, and mirror the stream branch
    /// when only the stream is processing, so every existing reader keeps working unchanged.
    pub proc_stream_in_lufs: f32,
    pub proc_stream_gr_db: f32,
    pub proc_stream_ride_gain_db: f32,
    pub proc_stream_in_peak: f32,
    pub proc_stream_out_peak: f32,

    // ── AUX MONITOR BUS (2026-08-18) — "slot = room, board = air" ────────────────────────────────
    // Decks D/E/F (slots 3/4/5) are AUX decks: automation never touches them, and per Jeff's ruling
    // they must NOT be summed into the local speaker output. They reach the room ONLY through an AUX
    // monitor slot that selects them, at that slot's own level. Air is untouched: they stay in the
    // program bus exactly as before, fully EQ'd and processed.
    //
    // Per-slot ROOM level. 0.0 = not selected by any slot = SILENT IN THE ROOM, which is the ruling.
    // Only indices 3/4/5 are ever non-zero; SetAuxMonitor refuses every other slot.
    pub aux_monitor_gain: [f32; SLOT_COUNT],
    /// PER-SLOT ROOM LEVEL — what the STUDIO hears from this slot, never what airs.
    ///
    /// The room had exactly one level for everything in it (monitor_vol at the device stage), so a
    /// slot summing into the programme could not be turned down in the room without taking it off
    /// air. The operational case that forces this: an interview needs the studio quiet, and a
    /// sweeper channel with no monitor control keeps blasting into the room while everything else
    /// is down (Jeff, 2026-09-03). A monitor exists to control the room INDEPENDENTLY of air.
    ///
    /// DEFAULT 1.0, deliberately, and NOT shared with aux_monitor_gain above. That one starts at 0.0
    /// because for an aux deck "no slot selected = silence" is the safe direction; on the room side
    /// the same default would mute the studio monitors at boot. Rotation decks never receive a value
    /// here and stay pinned at unity, so A/B/C behave exactly as they always have.
    pub room_gain: [f32; SLOT_COUNT],

    // ── THE DUCKER (slice 3, 2026-08-22) ─────────────────────────────────────────────────────────
    // docs/aux-channel-ducker-announcements-design-2026-08-21.md §B.3/§B.3a/§B.6.
    //
    // When a SOURCE channel has audio, the programme ducks UNDER it and rises back when it stops.
    // Nothing is stopped and nothing is started — this is a gain on the music, so the song continues
    // underneath and comes back mid-song, which is the whole behaviour Jeff specified.
    //
    // PER CHANNEL, and only Source slots. A Rotation deck or CART can never trigger a duck: the
    // detector reads the slot's declared KIND (slice 1), so "never carts, never sound effects" is
    // structural rather than a flag someone can get wrong. A sweeper must never duck its own song.
    /// Which slots arm the ducker. Default all-false — opt in per channel, like every processing
    /// toggle on this bus, so an install's audio is unchanged until an operator asks for it.
    pub duck_enabled: [bool; SLOT_COUNT],
    /// THE RECEIVER SIDE (2026-08-25). A ducker is a sidechain: a trigger, and a SET OF CHANNELS it
    /// acts on. This is that set — which decks step back when a source ducks. Chosen per station by
    /// the operator; default all true, which is exactly the behaviour before this existed.
    ///
    /// A SOURCE slot is never ducked regardless of this flag: that is structural, from the slot's
    /// kind. You do not duck the thing doing the ducking.
    pub duck_duckable: [bool; SLOT_COUNT],
    /// Source-sum peak above which the duck engages (linear). ~-45 dBFS.
    pub duck_threshold: f32,
    /// How far the music drops, in dB (negative). -12 dB default.
    pub duck_depth_db: f32,
    /// Duck fast — a late duck is heard as a stumble.
    pub duck_attack_ms: f32,
    /// Stay down between words. THIS is what stops the music fluttering up inside a sentence.
    pub duck_hold_ms: f32,
    /// Come back like a house system returning, not a lurch.
    pub duck_release_ms: f32,
    /// PFL — per slot, and the programme dim in the local output while any is on (Params.pfl / pfl_dim_db).
    pub pfl: [bool; SLOT_COUNT],
    pub pfl_dim_db: f32,
    pub pfl_to_device: bool,
    /// LIVE STATE — the smoothed gain currently applied to the music (1.0 = no duck) and the
    /// milliseconds of hold still owed. Persist across buffers; written only by the callback.
    pub duck_gain: f32,
    pub duck_hold_left_ms: f32,
    /// ROOM PEAK — what is actually reaching the local speakers (post room-chain, pre monitor gains),
    /// 0..1. The air VU has never answered "is anything coming out of the speakers", and with the aux
    /// bus that question now has a different answer from the air meter: a deck can be on air and
    /// silent in the room, or in the room and off air. Built in with the feature rather than bolted
    /// on, and it is what makes "no slot selected = silence in the room" observable instead of a claim.
    pub room_peak: f32,
    /// The room chain's OWN EQ + processor state.
    ///
    /// Why a second instance rather than re-running `eq`/`processor`: the room feed is a DIFFERENT sum
    /// (the aux decks are excluded), and both of these are STATEFUL — biquad histories and a limiter.
    /// Running one instance over two different signals in the same callback corrupts its state. And the
    /// arithmetic shortcut (room = air − aux) is invalid: the ride and the −1 dBTP limiter are
    /// non-linear, so an aux contribution cannot be subtracted back out.
    ///
    /// COST IS ONLY PAID WHEN USED. If no aux deck has a source, the room takes the original path and
    /// is bit-identical to the previous build; these instances are never touched.
    /// Kept in lockstep with the air chain by SetEq / SetProcessing, so the room hears the same EQ and
    /// the same loudness treatment it always did for A/B/C.
    /// Producer end of the AUX monitor ring. `Some` only while an aux output stream is open on a
    /// device the operator picked; `None` = no device = the mixer writes nothing and the aux bus is
    /// silent. This is the single gate that makes "no device chosen = silence" true in the audio path
    /// rather than in a comment.
    pub aux_ring_prod:  Option<HeapProd<f32>>,
    /// PFL cue output ring — Some only while the chosen cue device is OPEN (installed by the monitor-output thread).
    pub cue_ring_prod: Option<HeapProd<f32>>,
    /// REMOTE LINK — the SEND tap (linknet.rs). Some only while this station is sending to another station
    /// (SEND TO); None = no link = the callback does nothing for it (docs/remote-link-design-2026-09-28.md).
    pub link_tap: Option<crate::linknet::LinkTap>,
    /// Frames the AUX output callback has actually written to its device. "The stream opened" is not
    /// evidence that audio is flowing; this is. Surfaced as `aux_frames` in getLevels so the panel —
    /// and any probe — can tell a live aux feed from an open-but-starved one.
    pub aux_out_frames: Arc<AtomicU64>,
    /// The AUX feed's own instance of the EXISTING program processor (the loudness ride + -1 dBTP
    /// limiter already in Preferences). Its own, because the processor is stateful and the air and
    /// room chains are already using theirs on different sums this callback.
    pub processor_aux: Arc<crate::rt::RtMutex<crate::program_processor::ProgramProcessor>>,
    /// The AUX processor's OBSERVED meters — the same four the station's processor reports
    /// (proc_in_lufs / proc_gr_db / proc_ride_gain_db), taken at the same taps on the
    /// same processor type. They exist so the Health Monitor can show deck processing with the same
    /// meters and the same grammar as a station, rather than a parallel readout.
    pub aux_proc_in_lufs:  f32,
    pub aux_proc_gr_db:    f32,
    pub aux_proc_ride_db:  f32,
    /// PEAK OF THE AUX FEED — the level actually being sent to the aux device, after the deck's
    /// fader/cut AND the slot level. Distinct from `decks[].peak` (which is the DECK, regardless of
    /// any slot) and from `room_peak` (the station's speakers). Without this there was no way to ask
    /// "is the aux monitor making sound", and a probe that used the deck peak instead reported a
    /// control as broken when it was working.
    pub aux_peak: f32,
    pub eq_room:        crate::eq::SharedEq,
    pub processor_room: Arc<crate::rt::RtMutex<crate::program_processor::ProgramProcessor>>,
    /// Processing meters written by mixer_callback (observed), read by GetLevel → the daemon meter event.
    pub proc_in_peak:  f32,
    pub proc_out_peak: f32,
    pub proc_in_lufs:  f32,
    pub proc_gr_db:    f32,
    pub proc_ride_gain_db: f32,
    // (SLICE 3) No *_out_lufs fields: the OUT LOUDNESS ESTIMATE (in + ride gain, pre-limiter, never measured)
    // is deleted. OUT is measured on each branch's output by loudness.rs, fed through `loud` below.

    // ── SLICE 1 S3 — the callback's ends of its lock-free channels (rt.rs). ─────────────────────────
    /// Commands from the dispatch thread, applied at the top of each buffer (≤ RT_CMD_PER_BUFFER).
    pub(crate) cmd_cons: HeapCons<RtCmd>,
    /// Attach/detach of the aux monitor ring, from the aux thread.
    pub(crate) aux_cmd_cons: HeapCons<AuxCmd>,
    /// Everything the callback replaces goes here to be freed on the dispatch thread.
    pub(crate) garbage: HeapProd<Garbage>,
    /// S6 — the station's health counters (shared with every Scratch this station opens).
    pub(crate) counters: Arc<RtCounters>,
    /// Meters + telemetry, published at the end of every buffer.
    pub(crate) meter_w: Option<TripleWriter<MeterFrame>>,
    pub(crate) shared: Arc<RtShared>,
    /// The GEQ bands the callback last applied, and the version they came with.
    pub(crate) eq_bands: [f32; 10],
    pub(crate) eq_version_applied: u64,
    /// SLICE 4 — the master rack the callback last adopted (slot order, presence, IN), and whether it has set
    /// the GEQ's bypass on both EQ instances. The processor scalars above stay the callback's working copy,
    /// filled from this rack in apply_params.
    pub(crate) rack: crate::rack::MasterRack,
    pub(crate) eq_bypass_applied: bool,
    /// The dispatch-side ends, created with the state and taken once by start_station_mixer.
    pub(crate) handles: Option<BusHandles>,
    /// SLICE 2 — the meter bus's current read window (docs/dsp-meter-bus.md §1.2). A fixed field: the
    /// callback folds each buffer's taps into it; the reader acknowledges an epoch; the callback then starts
    /// the next window. Published inside every MeterFrame.
    pub(crate) meters_acc: MeterBlock,
    /// SLICE 5 — one channel rack per fader: its DSP state (preallocated; biquads + crossfade) and the rack
    /// params the callback last adopted (by version).
    pub(crate) chdsp: [crate::chdsp::ChannelDsp; SLOT_COUNT],
    pub(crate) ch_rack: [crate::rack::ChannelRackParams; SLOT_COUNT],
    /// SLICE 7 — the level each fader and the master are ACTUALLY at: a 20 ms ramp whenever the adopted level moves
    /// while the channel sounds (ramp.rs). At rest they equal the adopted level and the arithmetic is today's.
    pub(crate) vol_ramp: [crate::ramp::LevelRamp; SLOT_COUNT],
    pub(crate) master_ramp: crate::ramp::LevelRamp,
    /// SLICE 8 — the RTA target this state is running (from Params) and the callback end of its rings (rta.rs).
    pub(crate) rta_target: crate::rta::RtaTarget,
    pub(crate) rta: crate::rta::RtaTaps,
    /// SLICE 3 — the callback end of the loudness rings (loudness.rs). push() is a copy; the BS.1770 state
    /// lives on the station's meter thread. Dropping this stops that thread.
    pub(crate) loud: LoudTaps,
}

/// The non-callback ends of BusState's channels (see BusState::handles).
pub(crate) struct BusHandles {
    pub cmd_prod: HeapProd<RtCmd>,
    pub aux_cmd_prod: HeapProd<AuxCmd>,
    pub garbage_cons: HeapCons<Garbage>,
    pub meter_r: TripleReader<MeterFrame>,
    pub shared: Arc<RtShared>,
    /// SLICE 3 — the meter-thread end of the loudness rings.
    pub loud_cons: LoudCons,
    pub loud_shared: Arc<LoudShared>,
    /// SLICE 8 — the meter-thread end of the RTA rings.
    pub rta_cons: crate::rta::RtaCons,
    pub rta_shared: Arc<crate::rta::RtaShared>,
}

impl BusState {
    pub fn new(eq: crate::eq::SharedEq, ring_prod: HeapProd<f32>, sample_rate: u32, stream_connected: Arc<AtomicBool>) -> Self {
        // S3 — the channels. Created with the state so a state can never exist without them; the
        // dispatch-side ends wait in `handles` until start_station_mixer takes them (tests never do —
        // they drive the state directly, exactly as before).
        let (cmd_prod, cmd_cons) = HeapRb::<RtCmd>::new(RT_CMD_QUEUE).split();
        let (aux_cmd_prod, aux_cmd_cons) = HeapRb::<AuxCmd>::new(16).split();
        let (garbage, garbage_cons) = HeapRb::<Garbage>::new(RT_GARBAGE_QUEUE).split();
        let (loud, loud_cons, loud_shared) = loud_channels();
        let (rta, rta_cons, rta_shared) = crate::rta::rta_channels();
        let shared = RtShared::new();
        let mut b = BusState {
            // SLICE 1 — SLOT_COUNT slots, each stamped with what it IS. Indices 0..6 keep their
            // historic meaning exactly (A/B/C, D/E/F, CART); 7..11 are the new source channels and
            // start inactive, so they contribute nothing until something loads them.
            decks: {
                let mut d: [DeckSlot; SLOT_COUNT] = std::array::from_fn(|_| DeckSlot::new());
                for i in 0..SLOT_COUNT { d[i].kind = default_kind_for(i); }
                d
            },
            eq,
            ring_prod,
            sample_rate,
            peaks:       [0.0; SLOT_COUNT],
            master_peak: 0.0,
            monitor_vol: 1.0,
            master_vol:  1.0,
            master_monitor_vol: 1.0,
            stream_connected,
            frames_consumed: 0,
            proc_local:  false,   // OFF on every station on every install — opt-in per station
            proc_stream: false,
            proc_target_lufs: -14.0,
            // THE SHIPPED CHAIN, and the values "Ether v1" captures. A station that never sends
            // SetProcessorParams runs exactly these, which is what makes the new command additive.
            proc_ceiling_dbtp: -1.0,
            proc_release_ms: 120.0,
            proc_ride_rate: 1.5,
            proc_ride_clamp: 12.0,
            // Bypass defaults FALSE and is never restored from anywhere — a restart always holds the
            // ceiling. This is the structural half of "bypass must not persist".
            proc_ride_bypass: false,
            proc_limiter_bypass: false,
            processor:   Arc::new(crate::rt::RtMutex::new(crate::program_processor::ProgramProcessor::new(sample_rate as f32, -14.0))),
            // The stream branch starts as an exact copy of the shipped chain — same target, same
            // ceiling, same release, same ride. Nothing about a fresh station is different.
            proc_stream_target_lufs: -14.0,
            proc_stream_ceiling_dbtp: -1.0,
            proc_stream_release_ms: 120.0,
            proc_stream_ride_rate: 1.5,
            proc_stream_ride_clamp: 12.0,
            proc_stream_ride_bypass: false,
            proc_stream_limiter_bypass: false,
            processor_stream: Arc::new(crate::rt::RtMutex::new(crate::program_processor::ProgramProcessor::new(sample_rate as f32, -14.0))),
            proc_stream_in_lufs: -70.0,
            proc_stream_gr_db: 0.0, proc_stream_ride_gain_db: 0.0,
            proc_stream_in_peak: 0.0, proc_stream_out_peak: 0.0,
            aux_monitor_gain: [0.0; SLOT_COUNT],   // nothing selected → aux decks silent in the room
            room_gain: [1.0; SLOT_COUNT],          // unity until an operator says otherwise — never silent by default
            // Ducker: OFF everywhere until asked for. Defaults are §B.6's.
            duck_enabled: [false; SLOT_COUNT],
            duck_duckable: [true; SLOT_COUNT],   // every deck ducks until an operator says otherwise
            duck_threshold: 0.0056,   // ~-45 dBFS
            // -22 dB, not -12: Jeff's ears on a live jukebox-over-music test. A short announcement
            // sits fine at -12, but a CONTINUOUS source needs the programme much further down or the
            // two clash. A starting point, not a rebuild — every value here is tunable at runtime
            // from that station's Preferences (SetDuckParams).
            duck_depth_db: -28.0,
            duck_attack_ms: 30.0,
            duck_hold_ms: 700.0,
            duck_release_ms: 500.0,
            pfl: [false; SLOT_COUNT],
            pfl_dim_db: PFL_DIM_DB_DEFAULT,
            pfl_to_device: false,
            duck_gain: 1.0,
            duck_hold_left_ms: 0.0,
            aux_ring_prod: None,          // no aux device open → nowhere to send, by construction
            cue_ring_prod: None,          // no cue device open → the cue goes nowhere (or to the main output — see pfl_to_device)
            link_tap: None,               // not sending (SEND TO off) → the link tap does not exist
            aux_out_frames: Arc::new(AtomicU64::new(0)),
            aux_peak: 0.0,
            processor_aux: Arc::new(crate::rt::RtMutex::new(crate::program_processor::ProgramProcessor::new(sample_rate as f32, -14.0))),
            aux_proc_in_lufs: -70.0,
            aux_proc_gr_db: 0.0,
            aux_proc_ride_db: 0.0,
            room_peak: 0.0,
            eq_room:        crate::eq::new_shared_eq(sample_rate as f32),
            processor_room: Arc::new(crate::rt::RtMutex::new(crate::program_processor::ProgramProcessor::new(sample_rate as f32, -14.0))),
            proc_in_peak: 0.0, proc_out_peak: 0.0,
            proc_in_lufs: -70.0, proc_gr_db: 0.0, proc_ride_gain_db: 0.0,
            cmd_cons,
            aux_cmd_cons,
            garbage,
            counters: RtCounters::new(),
            meter_w: None,
            shared: shared.clone(),
            eq_bands: [0.0; 10],
            eq_version_applied: 0,
            rack: crate::rack::MasterRack::shipped(),
            eq_bypass_applied: false,
            handles: None,
            meters_acc: MeterBlock { epoch: 1, ..MeterBlock::default() },
            chdsp: [crate::chdsp::ChannelDsp::default(); SLOT_COUNT],
            ch_rack: [crate::rack::ChannelRackParams::default(); SLOT_COUNT],
            vol_ramp: [crate::ramp::LevelRamp::default(); SLOT_COUNT],
            master_ramp: crate::ramp::LevelRamp::default(),
            rta_target: crate::rta::RtaTarget::None,
            rta,
            loud,
        };
        // The meter channel starts on THIS state's own first frame, so the first read is the truth.
        let (w, meter_r) = triple(b.meter_frame());
        b.meter_w = Some(w);
        b.handles = Some(BusHandles { cmd_prod, aux_cmd_prod, garbage_cons, meter_r, shared, loud_cons, loud_shared, rta_cons, rta_shared });
        b
    }

    /// The operator block this state is running, as the dispatch thread's starting copy.
    pub(crate) fn params(&self) -> Params {
        Params {
            volume: std::array::from_fn(|i| self.decks[i].volume),
            muted: std::array::from_fn(|i| self.decks[i].muted),
            kind: std::array::from_fn(|i| self.decks[i].kind),
            duck_enabled: self.duck_enabled,
            duck_duckable: self.duck_duckable,
            aux_monitor_gain: self.aux_monitor_gain,
            room_gain: self.room_gain,
            monitor_vol: self.monitor_vol,
            master_vol: self.master_vol,
            master_monitor_vol: self.master_monitor_vol,
            proc_local: self.proc_local,
            proc_stream: self.proc_stream,
            rack: self.rack_from_fields(),
            ch_rack: self.ch_rack,
            duck_threshold: self.duck_threshold,
            duck_depth_db: self.duck_depth_db,
            duck_attack_ms: self.duck_attack_ms,
            duck_hold_ms: self.duck_hold_ms,
            duck_release_ms: self.duck_release_ms,
            pfl: self.pfl,
            pfl_dim_db: self.pfl_dim_db,
            pfl_to_device: self.pfl_to_device,
            rta: self.rta_target,
        }
    }

    /// SLICE 4 — the rack this state is running: its adopted slots, with the working values written in.
    fn rack_from_fields(&self) -> crate::rack::MasterRack {
        use crate::rack::{RideParams, LimiterParams, BRANCH_LOCAL, BRANCH_STREAM};
        let mut r = self.rack;
        r.set_ride(BRANCH_LOCAL, RideParams { target: self.proc_target_lufs, rate: self.proc_ride_rate, clamp: self.proc_ride_clamp });
        r.set_limiter(BRANCH_LOCAL, LimiterParams { ceiling: self.proc_ceiling_dbtp, release: self.proc_release_ms });
        r.set_ride(BRANCH_STREAM, RideParams { target: self.proc_stream_target_lufs, rate: self.proc_stream_ride_rate, clamp: self.proc_stream_ride_clamp });
        r.set_limiter(BRANCH_STREAM, LimiterParams { ceiling: self.proc_stream_ceiling_dbtp, release: self.proc_stream_release_ms });
        r.set_branch_in(BRANCH_LOCAL, !self.proc_ride_bypass, !self.proc_limiter_bypass);
        r.set_branch_in(BRANCH_STREAM, !self.proc_stream_ride_bypass, !self.proc_stream_limiter_bypass);
        if r.geq().0.is_some() { r.set_geq_bands(self.eq_bands); }
        r.eq_version = self.eq_version_applied;
        r
    }

    /// Adopt a parameter block (callback, top of buffer). Plain field copies; the GEQ is re-tuned only when
    /// its bands actually changed, on BOTH instances, as SetEq always did.
    fn apply_params(&mut self, p: &Params) {
        for i in 0..SLOT_COUNT {
            self.decks[i].volume = p.volume[i];
            self.decks[i].muted = p.muted[i];
            self.decks[i].kind = p.kind[i];
        }
        self.duck_enabled = p.duck_enabled;
        self.duck_duckable = p.duck_duckable;
        self.aux_monitor_gain = p.aux_monitor_gain;
        self.room_gain = p.room_gain;
        self.monitor_vol = p.monitor_vol;
        self.master_vol = p.master_vol;
        self.master_monitor_vol = p.master_monitor_vol;
        self.proc_local = p.proc_local;
        self.proc_stream = p.proc_stream;
        // SLICE 4 — the master rack: every module's parameters and IN, from the one block.
        {
            use crate::rack::{BRANCH_LOCAL, BRANCH_STREAM};
            let (rl, ril) = p.rack.ride(BRANCH_LOCAL);
            let (ll, lil) = p.rack.limiter(BRANCH_LOCAL);
            let (rs, ris) = p.rack.ride(BRANCH_STREAM);
            let (ls, lis) = p.rack.limiter(BRANCH_STREAM);
            self.proc_target_lufs = rl.target;
            self.proc_ride_rate = rl.rate;
            self.proc_ride_clamp = rl.clamp;
            self.proc_ceiling_dbtp = ll.ceiling;
            self.proc_release_ms = ll.release;
            self.proc_ride_bypass = !ril;
            self.proc_limiter_bypass = !lil;
            self.proc_stream_target_lufs = rs.target;
            self.proc_stream_ride_rate = rs.rate;
            self.proc_stream_ride_clamp = rs.clamp;
            self.proc_stream_ceiling_dbtp = ls.ceiling;
            self.proc_stream_release_ms = ls.release;
            self.proc_stream_ride_bypass = !ris;
            self.proc_stream_limiter_bypass = !lis;
        }
        self.duck_threshold = p.duck_threshold;
        self.duck_depth_db = p.duck_depth_db;
        self.duck_attack_ms = p.duck_attack_ms;
        self.duck_hold_ms = p.duck_hold_ms;
        self.duck_release_ms = p.duck_release_ms;
        self.pfl = p.pfl;
        self.pfl_dim_db = p.pfl_dim_db;
        self.pfl_to_device = p.pfl_to_device;
        self.rta_target = p.rta;
        // The GEQ slot: bands on a version change (a removed GEQ is flat), exactly as SetEq always applied them.
        let (geq_bands, geq_in) = p.rack.geq();
        let bands = geq_bands.unwrap_or([0.0; 10]);
        if p.rack.eq_version != self.eq_version_applied {
            // Only the callback ever locks these (S3), so try_lock cannot miss; if it ever did, the version
            // is left unapplied and the next buffer tries again rather than dropping the change.
            if let (Ok(mut a), Ok(mut r)) = (self.eq.try_lock(), self.eq_room.try_lock()) {
                r.set_bands(&bands);
                a.set_bands(&bands);
                self.eq_bands = bands;
                self.eq_version_applied = p.rack.eq_version;
            } else {
                RtCounters::bump(&self.counters.lock_misses, 1);
            }
        }
        // …and its IN: an OUT (or removed) GEQ takes the flat passthrough on both instances.
        let byp = geq_bands.is_none() || !geq_in;
        if byp != self.eq_bypass_applied {
            if let (Ok(mut a), Ok(mut r)) = (self.eq.try_lock(), self.eq_room.try_lock()) {
                a.bypass = byp;
                r.bypass = byp;
                self.eq_bypass_applied = byp;
            } else {
                RtCounters::bump(&self.counters.lock_misses, 1);
            }
        }
        self.rack = p.rack;
        // SLICE 5 — a channel's rack is adopted only when its version changes: the DSP then crossfades to the new
        // plan (coefficients were computed on the dispatch thread; nothing here does trigonometry).
        for i in 0..SLOT_COUNT {
            if p.ch_rack[i].version != self.ch_rack[i].version {
                self.chdsp[i].set(p.ch_rack[i].plan);
                self.ch_rack[i] = p.ch_rack[i];
            }
        }
    }

    /// Free `g` OFF the audio thread. If the garbage queue is full it is leaked and counted, never dropped here.
    fn discard(&mut self, g: Garbage) {
        if let Err(g) = self.garbage.try_push(g) {
            std::mem::forget(g);
            RtCounters::bump(&self.counters.garbage_leaked, 1);
        }
    }

    /// Apply queued commands (callback, top of buffer). A block that arrives while a buffer is being
    /// rendered simply waits here for the next one — the buffer in progress always finishes on the block
    /// it started with.
    pub(crate) fn apply_commands(&mut self) {
        let mut n = 0u64;
        while (n as usize) < RT_CMD_PER_BUFFER {
            let Some(c) = self.cmd_cons.try_pop() else { break };
            n += 1;
            match c {
                RtCmd::Params(b) => {
                    self.apply_params(&b);
                    self.discard(Garbage::Params(b));
                }
                RtCmd::Load { slot, src, gain_db, gen } => {
                    let i = slot as usize;
                    let has = src.is_some();
                    let d = &mut self.decks[i];
                    let old = std::mem::replace(&mut d.source, src);
                    d.paused = true;
                    d.active = false;
                    d.gain_db = gain_db;
                    d.frames_played = 0;          // SAMPLE CLOCK — a new track restarts the position.
                    self.shared.src_gen[i].store(if has { gen } else { 0 }, Ordering::Release);
                    if let Some(o) = old { self.discard(Garbage::Source(o)); }
                }
                RtCmd::Play { slot, reload, gen } => {
                    let i = slot as usize;
                    if let Some(r) = reload {
                        let old = self.decks[i].source.replace(r);
                        self.shared.src_gen[i].store(gen, Ordering::Release);
                        if let Some(o) = old { self.discard(Garbage::Source(o)); }
                    }
                    self.decks[i].paused = false;
                    self.decks[i].active = true;
                }
                RtCmd::Pause { slot } => { self.decks[slot as usize].paused = true; }
                RtCmd::LinkTap(t) => {
                    let old = std::mem::replace(&mut self.link_tap, t);
                    if let Some(o) = old { self.discard(Garbage::LinkTap(o)); }
                }
                RtCmd::Stop { slot } => {
                    let i = slot as usize;
                    let d = &mut self.decks[i];
                    let old = d.source.take();
                    d.paused = true;
                    d.active = false;
                    d.frames_played = 0;          // SAMPLE CLOCK — deck emptied, position clears with it.
                    self.shared.src_gen[i].store(0, Ordering::Release);
                    if let Some(o) = old { self.discard(Garbage::Source(o)); }
                }
            }
        }
        // src_gen stores above happen-before this; the dispatch thread reads applied_seq then src_gen.
        if n > 0 { self.shared.applied_seq.fetch_add(n, Ordering::Release); }
        while let Some(a) = self.aux_cmd_cons.try_pop() {
            match a {
                AuxCmd::Attach(p) => { if let Some(o) = self.aux_ring_prod.replace(p) { self.discard(Garbage::AuxProd(o)); } }
                AuxCmd::Detach    => { if let Some(o) = self.aux_ring_prod.take()     { self.discard(Garbage::AuxProd(o)); } }
                AuxCmd::AttachCue(p) => { if let Some(o) = self.cue_ring_prod.replace(p) { self.discard(Garbage::AuxProd(o)); } }
                AuxCmd::DetachCue    => { if let Some(o) = self.cue_ring_prod.take()     { self.discard(Garbage::AuxProd(o)); } }
            }
        }
    }

    /// This buffer's observed state (callback, end of buffer). Copies only — no allocation.
    pub(crate) fn meter_frame(&self) -> MeterFrame {
        MeterFrame {
            params: self.params(),
            peaks: self.peaks,
            master_peak: self.master_peak,
            room_peak: self.room_peak,
            aux_peak: self.aux_peak,
            frames_consumed: self.frames_consumed,
            duck_gain: self.duck_gain,
            aux_proc_in_lufs: self.aux_proc_in_lufs,
            aux_proc_gr_db: self.aux_proc_gr_db, aux_proc_ride_db: self.aux_proc_ride_db,
            proc_in_lufs: self.proc_in_lufs,
            proc_gr_db: self.proc_gr_db, proc_ride_gain_db: self.proc_ride_gain_db,
            proc_in_peak: self.proc_in_peak, proc_out_peak: self.proc_out_peak,
            proc_stream_in_lufs: self.proc_stream_in_lufs,
            proc_stream_gr_db: self.proc_stream_gr_db, proc_stream_ride_gain_db: self.proc_stream_ride_gain_db,
            proc_stream_in_peak: self.proc_stream_in_peak, proc_stream_out_peak: self.proc_stream_out_peak,
            meters: self.meters_acc,
            decks: std::array::from_fn(|i| {
                let d = &self.decks[i];
                DeckMeter { source_present: d.source.is_some(), active: d.active, paused: d.paused,
                            gain_db: d.gain_db, frames_played: d.frames_played }
            }),
        }
    }

    /// Publish this buffer's frame (callback, end of buffer).
    fn publish_meters(&mut self) {
        let f = self.meter_frame();
        if let Some(w) = self.meter_w.as_mut() { *w.slot() = f; w.publish(); }
    }
}

pub type SharedBusState = Arc<crate::rt::RtMutex<BusState>>;

/// Map a deck letter to its BusState index.
pub fn deck_index(deck: &str) -> Option<usize> {
    match deck {
        "A" => Some(0),
        "B" => Some(1),
        "C" => Some(2),
        "D" => Some(3),
        "E" => Some(4),
        "F" => Some(5),
        "CART" => Some(6), // dedicated cart channel — not user-assignable
        // SLICE 1 — the new source channels, addressable so slice 2 can load them.
        "S1" => Some(7),
        "S2" => Some(8),
        "S3" => Some(9),
        "S4" => Some(10),
        "S5" => Some(11),
        _   => None,
    }
}

fn rand_level() -> f32 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().subsec_nanos();
    (t % 1000) as f32 / 1000.0
}

// ── Audio thread ──────────────────────────────────────────────────────────────

pub fn start_audio_thread(station_id: u32, device_name: Option<String>) -> (
    std::sync::mpsc::Sender<AudioCmd>,
    Arc<Mutex<bool>>,
    SharedLevels,
    FinishedFlags,
) {
    let (tx, rx) = std::sync::mpsc::channel::<AudioCmd>();
    let is_playing       = Arc::new(Mutex::new(false));
    let is_playing_clone = is_playing.clone();
    let levels: SharedLevels = Arc::new(Mutex::new(AudioLevels::default()));
    let levels_clone     = levels.clone();
    let finished         = FinishedFlags::new();
    let finished_clone   = finished.clone();

    // ── Audio dispatch thread ─────────────────────────────────────────────────
    std::thread::spawn(move || {
        use rodio::{Decoder, OutputStream, Sink, Source};
        use rodio::source::UniformSourceIterator;
        use std::fs::File;
        use std::io::BufReader;

        let mut playing_decks: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut was_non_empty: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut loaded_files: HashMap<String, (String, String, String)> = HashMap::new();

        let mut current_device_name = device_name;

        'outer: loop {
            let (stream_result, opened_name) = {
                use cpal::traits::{DeviceTrait, HostTrait};
                let default_name = || cpal::default_host()
                    .default_output_device()
                    .and_then(|d| d.name().ok())
                    .unwrap_or_else(|| "default".to_string());
                if let Some(ref name) = current_device_name {
                    let found = cpal::available_hosts().into_iter().find_map(|host_id| {
                        let host = cpal::host_from_id(host_id).ok()?;
                        host.output_devices().ok()?.find(|d| {
                            d.name().ok().as_deref() == Some(name.as_str())
                        })
                    });
                    match found {
                        Some(device) => match OutputStream::try_from_device(&device) {
                            Ok(s)  => (Ok(s), name.clone()),
                            Err(e) => {
                                eprintln!("[RUST] Station {} failed to open '{}': {} — using default", station_id, name, e);
                                (OutputStream::try_default(), default_name())
                            }
                        },
                        None => {
                            eprintln!("[RUST] Station {} device '{}' not found — using default", station_id, name);
                            (OutputStream::try_default(), default_name())
                        }
                    }
                } else {
                    (OutputStream::try_default(), default_name())
                }
            };
            let (_stream, stream_handle) = match stream_result {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[RUST] Audio output failed: {} - retrying in 2s", e);
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    continue 'outer;
                }
            };

            let mut sinks: HashMap<String, Sink> = HashMap::new();
            eprintln!("[RUST] Station {} audio output: {}", station_id, opened_name);

            // Restore previously playing tracks after device failover
            for (deck, (path, _title, _artist)) in &loaded_files {
                if let Ok(file) = File::open(path) {
                    let reader = BufReader::new(file);
                    if let Ok(decoder) = Decoder::new(reader) {
                        let norm = UniformSourceIterator::<_, f32>::new(
                            decoder.convert_samples::<f32>(), 2, 44100,
                        );
                        if let Ok(sink) = Sink::try_new(&stream_handle) {
                            if playing_decks.contains(deck) { sink.play(); } else { sink.pause(); }
                            sink.append(norm);
                            sinks.insert(deck.clone(), sink);
                        }
                    }
                }
            }

            loop {
                match rx.recv_timeout(std::time::Duration::from_millis(50)) {
                    Ok(cmd) => {
                        match cmd {
                            AudioCmd::Load { deck, file_path, title, artist, gain_db } => {
                                if let Some(old) = sinks.remove(&deck) { old.stop(); }
                                loaded_files.insert(deck.clone(), (file_path.clone(), title.clone(), artist.clone()));
                                playing_decks.remove(&deck);
                                was_non_empty.remove(&deck);
                                finished_clone.clear(&deck);
                                if let Ok(file) = File::open(&file_path) {
                                    let reader = BufReader::new(file);
                                    if let Ok(decoder) = Decoder::new(reader) {
                                        let norm = UniformSourceIterator::<_, f32>::new(
                                            decoder.convert_samples::<f32>(), 2, 44100,
                                        );
                                        if let Ok(sink) = Sink::try_new(&stream_handle) {
                                            sink.pause();
                                            if gain_db != 0.0 {
                                                let linear = 10f32.powf(gain_db / 20.0);
                                                sink.set_volume(linear.clamp(0.1, 4.0));
                                            }
                                            sink.append(norm);
                                            sinks.insert(deck, sink);
                                        } else {
                                            eprintln!("Audio device disconnected - failing over");
                                            continue 'outer;
                                        }
                                    }
                                }
                            }
                            AudioCmd::Play(deck) => {
                                finished_clone.clear(&deck);
                                playing_decks.insert(deck.clone());
                                if let Some(sink) = sinks.get(&deck) {
                                    sink.play();
                                    was_non_empty.insert(deck.clone());
                                    if let Ok(mut p) = is_playing_clone.lock() { *p = true; }
                                }
                            }
                            AudioCmd::Pause(deck) => {
                                playing_decks.remove(&deck);
                                if let Some(sink) = sinks.get(&deck) { sink.pause(); }
                                let any = sinks.values().any(|s| !s.is_paused() && !s.empty());
                                if let Ok(mut p) = is_playing_clone.lock() { *p = any; }
                            }
                            AudioCmd::Stop(deck) => {
                                playing_decks.remove(&deck);
                                was_non_empty.remove(&deck);
                                loaded_files.remove(&deck);
                                finished_clone.clear(&deck);
                                if let Some(sink) = sinks.remove(&deck) { sink.stop(); }
                                let any = sinks.values().any(|s| !s.is_paused() && !s.empty());
                                if let Ok(mut p) = is_playing_clone.lock() { *p = any; }
                            }
                            AudioCmd::SetVolume { deck, volume } => {
                                if let Some(sink) = sinks.get(&deck) { sink.set_volume(volume); }
                            }
                            AudioCmd::SetMuted { deck, muted } => {
                                // SUPERSEDED PATH (see the header at start_station_mixer: this function is
                                // replaced and is not called from lib.rs). Kept compiling and behaviourally
                                // honest — cut is cut — but note it has no separate fader store, so un-cut
                                // returns the sink to unity rather than the operator's last fader position.
                                // The live mixer path holds `muted` beside `volume` and has no such caveat.
                                if let Some(sink) = sinks.get(&deck) { sink.set_volume(if muted { 0.0 } else { 1.0 }); }
                            }
                            AudioCmd::GetLevel => {
                                if let Ok(mut lvl) = levels_clone.lock() {
                                    lvl.level_a = if sinks.get("A").map(|s| !s.is_paused() && !s.empty()).unwrap_or(false) { 0.5 + rand_level() * 0.5 } else { 0.0 };
                                    lvl.level_b = if sinks.get("B").map(|s| !s.is_paused() && !s.empty()).unwrap_or(false) { 0.5 + rand_level() * 0.5 } else { 0.0 };
                                    lvl.level_c = if sinks.get("C").map(|s| !s.is_paused() && !s.empty()).unwrap_or(false) { 0.5 + rand_level() * 0.5 } else { 0.0 };
                                }
                            }
                            AudioCmd::Ping => {}
                            // The legacy no-device path has no program bus, so there is no processor to
                            // configure. Named explicitly rather than swept into a catch-all: the
                            // compiler catching this arm is what makes adding a command safe, and a `_ =>`
                            // here would silently swallow the next one.
                            AudioCmd::SetProcessorParams { .. } => {}
                            AudioCmd::SetProcessorBypass { .. } => {}
                            AudioCmd::SetMasterRack(_) => {}
                            AudioCmd::SetChannelRack { .. } => {}
                            AudioCmd::ApplyShow(_) => {}
                            AudioCmd::SetRta(_) => {}
                            AudioCmd::SetMicInput { .. } => {}
                            AudioCmd::SetLinkInput { .. } | AudioCmd::SetLinkSend(_) => {}
                            AudioCmd::StartStream { server, port, mount, station_name, .. } => {
                                eprintln!("Stream: {}:{}{} ({})", server, port, mount, station_name);
                            }
                            AudioCmd::StopStream => { eprintln!("Stream stopped"); }
                            AudioCmd::UpdateMetadata { title, artist } => {
                                eprintln!("Now playing: {} - {}", artist, title);
                            }
                            AudioCmd::SwitchDevice(name) => {
                                eprintln!("[RUST] Station {} switching device to: {}", station_id, name);
                                current_device_name = Some(name);
                                break;
                            }
                            AudioCmd::ReopenOutput => { break; } // legacy path: drop stream → 'outer reopens
                            AudioCmd::SetEq(_) => {}
                            AudioCmd::SetMonitorVolume(_) => {}
                            AudioCmd::SetMasterVolume(_) => {}
                            AudioCmd::SetMasterMonitorVolume(_) => {}
                            AudioCmd::SetProcessing { .. } => {} // no-device context: applied when the stream is live
                            // Same no-device context: with no output stream there is no room to feed,
                            // so the aux monitor level is simply not applicable here. The live mixer
                            // path (below) is the one that owns bus.aux_monitor_gain.
                            AudioCmd::SetAuxMonitor { .. } => {}
                            // Same no-device context: this legacy path has no BusState to re-kind,
                            // and the slot's bus only means anything to the live mixer below.
                            AudioCmd::SetSlotKind { .. } => {}
                            AudioCmd::SetDuck { .. } => {}
                            AudioCmd::SetDuckable { .. } => {}
                            AudioCmd::SetDuckParams { .. } => {}
                            AudioCmd::SetPfl { .. } => {}
                            AudioCmd::SetPflDim(_) => {}
                            AudioCmd::SetCueDevice(_) => {}
                            // Superseded no-device path (see start_station_mixer's header): it owns no
                            // aux stream, so there is nothing here to open or close.
                            AudioCmd::SetAuxDevice(_) => {}
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break 'outer,
                }

                // Detect transition: was_non_empty → now empty = track finished naturally
                let mut just_finished: Vec<String> = Vec::new();
                for deck in playing_decks.iter() {
                    if let Some(sink) = sinks.get(deck) {
                        let non_empty = !sink.empty();
                        if was_non_empty.contains(deck) && !non_empty {
                            just_finished.push(deck.clone());
                            eprintln!("[RUST] Deck {} finished playing", deck);
                        }
                        if non_empty {
                            was_non_empty.insert(deck.clone());
                        }
                    }
                }
                for deck in just_finished {
                    playing_decks.remove(&deck);
                    was_non_empty.remove(&deck);
                    loaded_files.remove(&deck);
                    finished_clone.set(&deck);
                    eprintln!("[RUST] Set finished flag for deck {}", deck);
                }

                let any = sinks.values().any(|s| !s.is_paused() && !s.empty());
                if let Ok(mut p) = is_playing_clone.lock() { *p = any; }
            }
        }
    });

    (tx, is_playing, levels, finished)
}

// ── Phase B1: multi-bus mixer ─────────────────────────────────────────────────
// Replaces start_audio_thread. One cpal output stream per station feeds both:
//   Studio Monitor Bus → hardware device (cpal output)
//   Program Bus        → ring buffer → TCP → ffmpeg → Icecast (hardware-free)
// Called from lib.rs get_or_create_engine after this lands in Step D.

const DECK_LETTERS:   [&str; 6] = ["A", "B", "C", "D", "E", "F"];
/// SLICE 1 (2026-08-21) — the slot pool. Was a bare literal 7 in eight places; it is a
/// COMPILE-TIME SIZE, never a runtime one. Growing it costs one predictable branch per unused slot
/// per buffer (the callback skips inactive slots before touching any state), which is why the
/// console feel is affordable without making the array dynamic. Layout:
///     0,1,2   rotation decks A/B/C
///     3,4,5   legacy aux decks D/E/F   (the jukebox lives here)
///     6       CART                     (jingle/cart overlay)
///     7..11   SOURCE channels          (new — surfaced by the +/- strip in slice 2)
/// Indices 0..6 are UNCHANGED so every existing consumer keeps working.
pub const SLOT_COUNT: usize = 12;
/// PFL (Jeff's ruling 2): the programme dim in the local output while any PFL is on. The station's setting
/// (station_config_kv `pfl_dim_db`, Preferences → Audio) replaces this; it is the value that setting SHOWS until
/// the operator changes it — not a hidden number.
pub const PFL_DIM_DB_DEFAULT: f32 = -12.0;
/// The range the setting may take: 0 dB = no dim, −60 dB = the programme all but gone while listening.
pub const PFL_DIM_DB_RANGE: (f32, f32) = (-60.0, 0.0);
/// Telemetry / finished-flag ids for the new source channels. Deliberately NOT more letters:
/// DECK_LETTERS is len 6 and indexing it out of range is what killed the output thread on
/// 2026-07-15. These are their own namespace.
const SOURCE_IDS: [&str; 5] = ["S1", "S2", "S3", "S4", "S5"];

/// WHAT A SLOT IS, not where it sits.
///
/// This replaces the positional `is_aux = i >= 3 && i <= 5` test. With source channels at 7.. that
/// test would have become `i >= 3 && i <= 5 || i >= 7`, which is arithmetic pretending to be a
/// rule. The ducker's "never carts" contract and the AUX monitor routing both read this instead, so
/// they follow the slot's declared identity and cannot drift when the layout changes again.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SlotKind {
    /// A/B/C — automation's rotation decks.
    Rotation,
    /// SWEEPER — programmed imaging that sums into the programme WITH THE MUSIC.
    ///
    /// It was called `Cart`, and that was wrong twice over: it named an ADDRESS (slot 6) rather than
    /// a behaviour, and it named the wrong content. CARTS ARE NOT SWEEPERS. A cart is a hand-fired
    /// sound-effects rack that punches through on an aux channel; a sweeper is programmed imaging
    /// that bridges a song seam and belongs in the programme with the music. Carts never go on this
    /// bus, so the name is accurate (Jeff, 2026-09-03).
    ///
    /// A slot with this kind is, in every branch of the mixer callback, exactly what slot 6 was:
    ///   • summed into `core` with the rotation decks — one bus, one fader law, one processor;
    ///   • DUCKED with the music, because `core` is what the duck attenuates;
    ///   • never able to ARM the ducker (a sweeper must not duck the song it is sweeping into);
    ///   • no aux monitor tap, and it does not set `aux_present`;
    ///   • therefore heard through the room chain and the station monitor fader, on the main device.
    ///
    /// Assignable since 2026-09-03: a slot the operator dials to a sweeper source reports this, so
    /// the ADDRESS moves and nothing else does.
    Sweeper,
    /// D/E/F and the new 7.. channels — operator sources: jukebox, announcement, hand-fired jingle.
    Source,
}

/// The layout above, expressed once.
pub fn default_kind_for(i: usize) -> SlotKind {
    match i {
        0..=2 => SlotKind::Rotation,
        6     => SlotKind::Sweeper,
        _     => SlotKind::Source,
    }
}

// Finished-flag key for a mixer deck slot. Slots 0–5 are the assignable decks (A–F); slot 6 is the CART
// overlay channel, which is NOT in DECK_LETTERS. This is bounds-safe for any i (returns "CART" for the cart
// slot and anything ≥ DECK_LETTERS.len()), so a CART source exhausting can never index out of bounds — the
// crash that killed the cpal output thread on the maiden jingle fire (2026-07-15).
#[inline]
fn deck_finished_key(i: usize) -> &'static str {
    if i < DECK_LETTERS.len() { DECK_LETTERS[i] }
    else if i == 6 { "CART" }
    // SLICE 1: without this, every slot >= 6 fell through to "CART", so a finished SOURCE channel
    // would have raised the CART finished-flag and stranded the real cart. Bounds-safe as before:
    // anything past the known slots still returns "CART" rather than panicking.
    else if i - 7 < SOURCE_IDS.len() { SOURCE_IDS[i - 7] }
    else { "CART" }
}

#[cfg(test)]
mod deck_finished_key_tests {
    use super::deck_finished_key;
    // Proves the CART-exhaustion out-of-bounds is gone: the mixer has 7 deck slots (0–6, slot 6 = CART),
    // DECK_LETTERS has 6 — so the old `DECK_LETTERS[i]` panicked at i=6 when a CART source exhausted.
    #[test]
    fn cart_slot_is_bounds_safe_and_keyed_cart() {
        assert_eq!(deck_finished_key(0), "A");
        assert_eq!(deck_finished_key(5), "F");
        assert_eq!(deck_finished_key(6), "CART");   // the crash index — now safe
        // SLICE 1 — source channels get their OWN keys; they must never raise CART's flag.
        assert_eq!(deck_finished_key(7), "S1");
        assert_eq!(deck_finished_key(11), "S5");
        assert_eq!(deck_finished_key(99), "CART");  // any out-of-range slot never panics
    }
}
#[cfg(test)]
mod slice1_regression {
    // THE SLICE-1 RECEIPT — growing the slot pool from 7 to 12 must be INAUDIBLE.
    //
    // mixer_callback is a plain function over (data, ch, bus, finished, playing) and contains no
    // clock or RNG, so its output is a pure function of its inputs. That makes a true bit-identical
    // golden possible: run A/B/C/CART through it with NO source channels configured and checksum the
    // raw bits of every output sample. The number below was captured on the 7-slot build BEFORE the
    // pool grew. If growing the pool perturbs the existing path by one ULP, this fails.
    use super::*;

    /// Deterministic stereo source — no external RNG dep, identical on every platform and run.
    struct Det(u64);
    impl Iterator for Det {
        type Item = f32;
        fn next(&mut self) -> Option<f32> {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            Some(((self.0 >> 33) as f32 / (1u64 << 31) as f32) - 1.0)
        }
    }

    /// FNV-1a over the raw bits — compares exact float payloads, not approximate values.
    fn checksum(v: &[f32]) -> u64 {
        let mut h = 1469598103934665603u64;
        for s in v { h ^= s.to_bits() as u64; h = h.wrapping_mul(1099511628211); }
        h
    }

    fn run_abc_cart() -> u64 {
        let rb = HeapRb::<f32>::new(PROGRAM_BUS_BUF);
        let (prod, _cons) = rb.split();
        let eq = crate::eq::new_shared_eq(44100.0);
        let bus = Arc::new(crate::rt::RtMutex::new(BusState::new(eq, prod, 44100, Arc::new(AtomicBool::new(false)))));
        {
            let mut b = bus.lock().unwrap();
            // ONLY the slots that exist today: A, B, C and CART. No source channels configured —
            // which is exactly the state every shipped station is in.
            for (i, seed) in [(0usize, 11u64), (1usize, 22u64), (2usize, 33u64), (6usize, 66u64)] {
                b.decks[i].source = Some(DeckFeed::prefilled(Det(seed), 480 * 2 * 600));
                b.decks[i].active = true;
                b.decks[i].paused = false;   // DeckSlot::new() starts paused; without this the callback skips it
                b.decks[i].volume = 0.8;
            }
        }
        let fin = FinishedFlags::new();
        let playing = Arc::new(AtomicBool::new(true));
        let mut out: Vec<f32> = Vec::new();
        for _ in 0..50 {
            let mut data = vec![0f32; 480 * 2];
            mixer_callback(&mut data, 2, &bus, &fin, &playing, &mut Scratch::new());
            out.extend_from_slice(&data);
        }
        checksum(&out)
    }

    /// THE ROOM PATH — the check IT never had, written BEFORE the room gain split (Jeff's ruling,
    /// 2026-09-03: "write the golden test for the room path BEFORE touching it, not after").
    ///
    /// The slice-1 golden above drives A/B/C/CART with NO aux deck, so `aux_present` is false, the
    /// `room_owned` block is skipped entirely and the device buffer it checksums is the AIR path.
    /// The room chain — core → eq_room → master_vol → processor_room → device × monitor gains — has
    /// never had a golden at all. Splitting core into separate air and room accumulators is a change
    /// to exactly that untested path, so the baseline goes in first, on the CURRENT code, and the
    /// split then has to leave it alone.
    ///
    /// An aux deck is up so `aux_present` is true and the room chain actually runs. Slot 6 carries a
    /// sweeper, which is the slot whose room level is about to become per-slot: if the split changes
    /// what the room hears when every gain is at its default, this fails.
    fn run_room_chain() -> u64 {
        let rb = HeapRb::<f32>::new(PROGRAM_BUS_BUF);
        let (prod, _cons) = rb.split();
        let eq = crate::eq::new_shared_eq(44100.0);
        let bus = Arc::new(crate::rt::RtMutex::new(BusState::new(eq, prod, 44100, Arc::new(AtomicBool::new(false)))));
        {
            let mut b = bus.lock().unwrap();
            // A/B on the programme, slot 6 as the sweeper, and D as an aux deck so the ROOM chain
            // is the one feeding the device rather than the air path.
            for (i, seed) in [(0usize, 11u64), (1usize, 22u64), (6usize, 66u64), (3usize, 44u64)] {
                b.decks[i].source = Some(DeckFeed::prefilled(Det(seed), 480 * 2 * 600));
                b.decks[i].active = true;
                b.decks[i].paused = false;
                b.decks[i].volume = 0.8;
            }
            // The aux deck audibly in the room, so the aux tap is exercised too.
            b.aux_monitor_gain[3] = 0.7;
            // A monitor level that is NOT unity, so the device-stage gains are in the checksum.
            b.monitor_vol = 0.6;
        }
        let fin = FinishedFlags::new();
        let playing = Arc::new(AtomicBool::new(true));
        let mut out: Vec<f32> = Vec::new();
        for _ in 0..8 {
            let mut data = vec![0f32; 480 * 2];
            mixer_callback(&mut data, 2, &bus, &fin, &playing, &mut Scratch::new());
            out.extend_from_slice(&data);
        }
        checksum(&out)
    }

    /// Captured on the pre-split build. The room split must not move it.
    const GOLDEN_ROOM: u64 = 0x650c27d6971a17b3;

    #[test]
    fn room_chain_bit_identical_across_the_room_gain_split() {
        let sum = run_room_chain();
        println!("[room] room-chain checksum = {:#018x}", sum);
        assert_eq!(sum, GOLDEN_ROOM,
            "the ROOM path changed — air is unaffected by a monitor by design, so if this moves while \
             GOLDEN_7_SLOT holds, the room gain split has altered what the studio hears at default gains");
    }

    /// AUX MONITOR PATH — the check this path never had.
    ///
    /// The slice-1 golden below covers A/B/C/CART and the CORE mix only, so it passed while the aux
    /// monitor was audibly distorted: the aux sum was being run through the ride + limiter TWICE
    /// (two process_planar blocks, f76ca2c). Nothing in the suite looked at the aux ring.
    ///
    /// This drives a real aux deck (slot 3 = D) with processing ON, drains the aux ring, and pins the
    /// result. Honest about what it proves: the golden was captured AFTER the duplicate was removed,
    /// so it does not retro-prove the fix — Jeff's ears did that. It stops the double pass, or any
    /// other change to this path, from coming back unnoticed in a later slice.
    fn run_aux_monitor() -> u64 {
        let rb = HeapRb::<f32>::new(PROGRAM_BUS_BUF);
        let (prod, _cons) = rb.split();
        let eq = crate::eq::new_shared_eq(44100.0);
        let bus = Arc::new(crate::rt::RtMutex::new(BusState::new(eq, prod, 44100, Arc::new(AtomicBool::new(false)))));

        let aux_rb = HeapRb::<f32>::new(AUX_BUS_BUF);
        let (aux_prod, mut aux_cons) = aux_rb.split();
        {
            let mut b = bus.lock().unwrap();
            // A rotation deck so the core mix is non-trivial, and deck D as the aux source.
            b.decks[0].source = Some(DeckFeed::prefilled(Det(11), 480 * 2 * 600));
            b.decks[0].active = true;
            b.decks[0].paused = false;
            b.decks[0].volume = 0.8;
            b.decks[3].source = Some(DeckFeed::prefilled(Det(44), 480 * 2 * 600));
            b.decks[3].active = true;
            b.decks[3].paused = false;
            b.decks[3].volume = 0.9;
            b.aux_monitor_gain[3] = 1.0;      // slot D selected into the room at unity
            b.proc_local = true;              // the toggle that gates the aux processor
            b.aux_ring_prod = Some(aux_prod);
        }
        let fin = FinishedFlags::new();
        let playing = Arc::new(AtomicBool::new(true));
        for _ in 0..50 {
            let mut data = vec![0f32; 480 * 2];
            mixer_callback(&mut data, 2, &bus, &fin, &playing, &mut Scratch::new());
        }
        let mut got: Vec<f32> = Vec::new();
        while let Some(v) = aux_cons.try_pop() { got.push(v); }
        assert!(!got.is_empty(), "aux ring produced nothing — the test is not exercising the aux path");
        checksum(&got)
    }

    /// Captured 2026-08-22 on the SINGLE-PASS aux chain, after the duplicate block was removed.
    ///
    /// PROVEN TO DETECT THE DEFECT, not merely to pin the path — the two builds differ:
    ///     two passes (pre-fix, f76ca2c's duplicate present) : 0xc209c866cea3d4ca
    ///     one pass   (after the 2026-08-22 fix)             : 0x769d4d2c7a0689d7
    /// If a second ride/limiter pass over aux_l/aux_r ever returns, this test goes red.
    const GOLDEN_AUX_SINGLE_PASS: u64 = 0x769d4d2c7a0689d7;

    #[test]
    fn aux_monitor_single_pass_regression() {
        let sum = run_aux_monitor();
        println!("[aux] monitor-path checksum = {:#018x}", sum);
        assert_eq!(sum, GOLDEN_AUX_SINGLE_PASS,
            "the aux monitor path changed — if the ride/limiter is running more than once over aux_l/aux_r, that is the 2026-08-22 distortion");
    }

    /// MEASURED 2026-08-22 on real audio, both sides.
    ///
    /// The first attempt at this receipt was worthless and is recorded here so it is not repeated:
    /// DeckSlot::new() starts `paused: true`, and the test set source/active/volume but never
    /// cleared it — so the callback's first guard skipped every deck and the "bit-identical" golden
    /// compared SILENCE to SILENCE. It would have passed against any change whatsoever.
    ///
    /// With the decks actually playing, the same number comes off both builds:
    ///     pre-slice-1  (7 slots, positional is_aux) : 0xfb5c26536f759828
    ///     slice-1      (12 slots, SlotKind flag)    : 0xfb5c26536f759828
    /// So growing the pool and replacing the positional test is transparent to the core mix.
    const GOLDEN_7_SLOT: u64 = 0xfb5c26536f759828;

    #[test]
    fn abc_cart_bit_identical_with_no_source_channels() {
        let sum = run_abc_cart();
        println!("[slice1] A/B/C/CART checksum = {:#018x}", sum);
        assert_eq!(sum, GOLDEN_7_SLOT,
            "A/B/C/CART output changed — growing the slot pool is NOT transparent to existing stations");
    }
}

#[cfg(test)]
mod rt_command_path {
    // SLICE 1 S3 — the harness and the goldens set BusState fields directly, so on their own they never
    // exercise the path the product now uses: parameter BLOCKS and deck COMMANDS through the lock-free queue.
    // These two tests close that gap. docs/dsp-rt-callback.md §7 test 5.
    use super::*;
    use crate::rt::{Params, RtCmd};

    struct Det(u64);
    impl Iterator for Det {
        type Item = f32;
        fn next(&mut self) -> Option<f32> {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            Some(((self.0 >> 33) as f32 / (1u64 << 31) as f32) - 1.0)
        }
    }
    fn checksum(v: &[f32]) -> u64 {
        let mut h = 1469598103934665603u64;
        for s in v { h ^= s.to_bits() as u64; h = h.wrapping_mul(1099511628211); }
        h
    }

    /// The GOLDEN_7_SLOT scenario (A/B/C/CART, PRNG sources, fader 0.8), delivered the way the product
    /// delivers it: Load + Play commands and a parameter block, all through the queue. The callback applies
    /// them at the top of its first buffer, so the rendered bits must equal the directly-built golden.
    #[test]
    fn commands_through_the_queue_reproduce_the_slice1_golden() {
        let rb = HeapRb::<f32>::new(PROGRAM_BUS_BUF);
        let (prod, _cons) = rb.split();
        let mut b = BusState::new(crate::eq::new_shared_eq(44100.0), prod, 44100, Arc::new(AtomicBool::new(false)));
        let mut h = b.handles.take().unwrap();
        let mut p: Params = b.params();
        for (i, seed) in [(0usize, 11u64), (1usize, 22u64), (2usize, 33u64), (6usize, 66u64)] {
            assert!(h.cmd_prod.try_push(RtCmd::Load { slot: i as u8, src: Some(DeckFeed::prefilled(Det(seed), 480 * 2 * 600)), gain_db: 0.0, gen: 1 + i as u64 }).is_ok());
            p.volume[i] = 0.8;
        }
        assert!(h.cmd_prod.try_push(RtCmd::Params(Box::new(p))).is_ok());
        for i in [0usize, 1, 2, 6] { assert!(h.cmd_prod.try_push(RtCmd::Play { slot: i as u8, reload: None, gen: 0 }).is_ok()); }
        let bus = Arc::new(crate::rt::RtMutex::new(b));
        let fin = FinishedFlags::new();
        let playing = Arc::new(AtomicBool::new(true));
        let mut sc = Scratch::new();
        let mut out: Vec<f32> = Vec::new();
        for _ in 0..50 {
            let mut data = vec![0f32; 480 * 2];
            mixer_callback(&mut data, 2, &bus, &fin, &playing, &mut sc);
            out.extend_from_slice(&data);
        }
        let sum = checksum(&out);
        println!("[rt-cmd] A/B/C/CART via commands checksum = {:#018x}", sum);
        assert_eq!(sum, 0xfb5c26536f759828, "the command path renders differently from the directly-built golden");
        // Every command was applied, and the four decks report a source.
        assert_eq!(h.shared.applied_seq.load(Ordering::Acquire), 9);
        for i in [0usize, 1, 2, 6] { assert_ne!(h.shared.src_gen[i].load(Ordering::Acquire), 0); }
        // Garbage came back: the adopted Params box (the Loads replaced None, so no sources).
        let mut g = 0; while h.garbage_cons.try_pop().is_some() { g += 1; }
        assert_eq!(g, 1, "the adopted parameter block was not returned for freeing off-thread");
        // And the meter frame the callback published is readable without the lock.
        let m = h.meter_r.read();
        assert!(m.decks[0].source_present && m.decks[0].active && !m.decks[0].paused);
        assert_eq!(m.params.volume[0], 0.8);
    }

    /// A parameter block that arrives while a buffer is being rendered takes effect on the NEXT buffer,
    /// never partway through one. One thread fires 20 000 channel-cut blocks (alternating cut / open) as fast
    /// as it can; another renders a constant 0.5 source. (The probe was the master fader until slice 7 gave every
    /// fader a 20 ms ramp by design — ramp.rs, proven on its own; the cut is still a hard switch, so it is the probe.) Every rendered buffer must be uniform — all 0.0 or
    /// all 0.5 — and both values must actually occur (so the test is not passing on one static state).
    #[test]
    fn a_param_block_never_changes_mid_buffer() {
        struct Dc;
        impl Iterator for Dc { type Item = f32; fn next(&mut self) -> Option<f32> { Some(0.5) } }
        let rb = HeapRb::<f32>::new(PROGRAM_BUS_BUF);
        let (prod, _cons) = rb.split();
        let mut b = BusState::new(crate::eq::new_shared_eq(44100.0), prod, 44100, Arc::new(AtomicBool::new(false)));
        let h = b.handles.take().unwrap();
        let base = b.params();
        b.decks[0].source = Some(DeckFeed::prefilled(Dc, 480 * 2 * 3000));
        b.decks[0].active = true;
        b.decks[0].paused = false;
        let bus = Arc::new(crate::rt::RtMutex::new(b));
        let mut cmd = h.cmd_prod;
        let mut garbage = h.garbage_cons;
        let stop = Arc::new(AtomicBool::new(false));
        let stop2 = stop.clone();
        // The renderer tells the sender to give up once it has rendered enough; without this, a sender that
        // is still pushing when the render loop ends spins on a full queue for ever (seen: S5 run).
        let done = Arc::new(AtomicBool::new(false));
        let done2 = done.clone();
        let sender = std::thread::spawn(move || {
            let mut sent = 0u32;
            while sent < 20_000 && !done2.load(Ordering::Acquire) {
                let mut p = base;
                p.muted[0] = sent % 2 == 0;
                let mut c = RtCmd::Params(Box::new(p));
                loop {
                    if done2.load(Ordering::Acquire) { break; }
                    match cmd.try_push(c) { Ok(()) => break, Err(back) => { c = back; while garbage.try_pop().is_some() {} std::thread::yield_now(); } }
                }
                // ONE BLOCK IN FLIGHT (slice 4, 2026-09-26): wait until the callback has taken this block before
                // sending the next. Unpaced, the sender pushed all 20 000 blocks within the first few buffers,
                // so nearly every buffer rendered the final block — the liveness half of this test passed with
                // 2 of 1 000 buffers at 0.0 in the slice 3 run and failed with 0 in the first slice 4 run. The
                // property under test (a block never changes mid-buffer) is unchanged; this only guarantees
                // both states are actually exercised.
                while cmd.occupied_len() > 0 && !done2.load(Ordering::Acquire) { while garbage.try_pop().is_some() {} std::thread::yield_now(); }
                sent += 1;
                while garbage.try_pop().is_some() {}
            }
            stop2.store(true, Ordering::Release);
        });
        let fin = FinishedFlags::new();
        let playing = Arc::new(AtomicBool::new(true));
        let mut sc = Scratch::new();
        let (mut zeros, mut halves, mut buffers) = (0u64, 0u64, 0u64);
        let mut data = vec![0f32; 480 * 2];
        while !stop.load(Ordering::Acquire) || buffers < 1000 {
            mixer_callback(&mut data, 2, &bus, &fin, &playing, &mut sc);
            let first = data[0];
            assert!(data.iter().all(|&x| x.to_bits() == first.to_bits()),
                    "buffer {} is not uniform: a parameter block changed mid-buffer", buffers);
            if first == 0.0 { zeros += 1 } else if first == 0.5 { halves += 1 } else { panic!("unexpected level {}", first) }
            buffers += 1;
            if buffers >= 2_900 { break; }   // the prefilled ring holds 3 000 buffers of the DC source
        }
        done.store(true, Ordering::Release);
        sender.join().unwrap();
        println!("[rt-cmd] {} buffers, all uniform: {} with the channel cut, {} open", buffers, zeros, halves);
        assert!(zeros > 0 && halves > 0, "both channel states must have been rendered");
    }
}

#[cfg(test)]
mod rt_underrun {
    // SLICE 1 S4 — an UNDERRUN (ring dry, worker late) must never be mistaken for the track ENDING.
    // Jeff's condition: "an underrun plays silence for that deck and holds position — cannot be mistaken for
    // the track ending (no advance, no play_log row, no state change) — and it is counted and reported."
    use super::*;
    use crate::rt::deck_feed_with_capacity;

    /// Sample n of this source is n × 1e-6 — so continuity after the underrun is checkable sample by sample.
    struct Ramp(u64);
    impl Iterator for Ramp { type Item = f32; fn next(&mut self) -> Option<f32> { self.0 += 1; Some((self.0 - 1) as f32 * 1e-6) } }

    #[test]
    fn underrun_is_silence_counted_and_reported_and_never_an_ending() {
        let rb = HeapRb::<f32>::new(PROGRAM_BUS_BUF);
        let (prod, _cons) = rb.split();
        let mut b = BusState::new(crate::eq::new_shared_eq(44100.0), prod, 44100, Arc::new(AtomicBool::new(false)));
        let h = b.handles.take().unwrap();
        // A ring that holds 480 frames; the "worker" (this test) has delivered only 200 of them.
        let (feed, mut feeder) = deck_feed_with_capacity(Box::new(Ramp(0)), 480 * 2);
        feeder.fill(200 * 2);
        b.decks[0].source = Some(feed);
        b.decks[0].active = true;
        b.decks[0].paused = false;
        b.shared.src_gen[0].store(7, Ordering::Release);
        let bus = Arc::new(crate::rt::RtMutex::new(b));
        let fin = FinishedFlags::new();
        let playing = Arc::new(AtomicBool::new(true));
        let mut sc = Scratch::new();
        let (ev_p, mut ev_c) = HeapRb::<RtEvent>::new(16).split();
        sc.events = Some(ev_p);

        // Buffer 1: 480 frames wanted, 200 available, EOF not set -> UNDERRUN.
        let mut data = vec![0f32; 480 * 2];
        mixer_callback(&mut data, 2, &bus, &fin, &playing, &mut sc);
        {
            let b = bus.lock().unwrap();
            // Counted.
            assert_eq!(sc.counters.underruns[0].load(Ordering::Relaxed), 1, "underrun not counted");
            assert_eq!(sc.counters.underrun_frames[0].load(Ordering::Relaxed), 280, "underrun frames not counted");
            // Position HELD: only the 200 real frames advanced it.
            assert_eq!(b.decks[0].frames_played, 200, "position advanced over silence");
            // NOT an ending: no finished flag, source kept, deck still active, still marked as holding a source.
            assert!(!fin.take("A"), "an underrun raised the finished flag — the daemon would rotate");
            assert!(b.decks[0].source.is_some() && b.decks[0].active && !b.decks[0].paused, "an underrun changed the deck's state");
            assert_ne!(b.shared.src_gen[0].load(Ordering::Acquire), 0, "an underrun cleared the deck's source");
        }
        // The 200 real frames played; the 280 missing frames are silence for this deck.
        for f in 0..200 { assert_eq!(data[2 * f], (2 * f) as f32 * 1e-6); }
        for f in 200..480 { assert_eq!(data[2 * f], 0.0, "frame {} should be silence", f); assert_eq!(data[2 * f + 1], 0.0); }
        // Reported: one Underrun event, and NO DeckFinished.
        let mut evs = Vec::new(); while let Some(e) = ev_c.try_pop() { evs.push(e); }
        assert!(matches!(evs.as_slice(), [RtEvent::Underrun { slot: 0, frames: 280 }]), "events: {:?}", evs);
        // And the published meter frame says the same: source present, active, position 200.
        let mut mr = h.meter_r;
        let m = mr.read();
        assert!(m.decks[0].source_present && m.decks[0].active && m.decks[0].frames_played == 200);

        // The worker catches up -> the NEXT sample plays, no skip, no restart.
        feeder.fill(480 * 2);
        mixer_callback(&mut data, 2, &bus, &fin, &playing, &mut sc);
        assert_eq!(data[0], 400.0 * 1e-6, "playback did not resume at the next sample");
        assert_eq!(bus.lock().unwrap().decks[0].frames_played, 680);
        assert_eq!(sc.counters.underruns[0].load(Ordering::Relaxed), 1, "a full buffer counted as an underrun");
        println!("[underrun] 280 silent frames counted + reported; position held at 200, resumed at sample 400; no finished flag");
    }

    #[test]
    fn eof_is_an_ending_and_is_not_counted_as_an_underrun() {
        let rb = HeapRb::<f32>::new(PROGRAM_BUS_BUF);
        let (prod, _cons) = rb.split();
        let mut b = BusState::new(crate::eq::new_shared_eq(44100.0), prod, 44100, Arc::new(AtomicBool::new(false)));
        // A 300-frame file, fully decoded: EOF set.
        let (feed, mut feeder) = deck_feed_with_capacity(Box::new(Ramp(0).take(600)), 480 * 2);
        assert!(feeder.fill(480 * 2), "worker did not mark EOF");
        b.decks[0].source = Some(feed);
        b.decks[0].active = true;
        b.decks[0].paused = false;
        let bus = Arc::new(crate::rt::RtMutex::new(b));
        let fin = FinishedFlags::new();
        let playing = Arc::new(AtomicBool::new(true));
        let mut sc = Scratch::new();
        let mut data = vec![0f32; 480 * 2];
        mixer_callback(&mut data, 2, &bus, &fin, &playing, &mut sc);
        assert!(fin.take("A"), "a real end of file did not raise the finished flag");
        assert_eq!(sc.counters.underruns[0].load(Ordering::Relaxed), 0, "a real end of file was counted as an underrun");
        let b = bus.lock().unwrap();
        assert_eq!(b.decks[0].frames_played, 300);
        assert!(b.decks[0].source.is_none() && !b.decks[0].active);
    }
}

#[cfg(test)]
mod meter_bus {
    // SLICE 2 — docs/dsp-meter-bus.md §4. Through the real mixer_callback.
    use super::*;

    /// 1 kHz sine at −18.00 dBFS RMS (peak = RMS × √2 → −14.99 dBFS), 44.1 kHz stereo.
    struct Sine { n: u64, amp: f32 }
    impl Iterator for Sine {
        type Item = f32;
        fn next(&mut self) -> Option<f32> {
            let frame = self.n / 2;
            self.n += 1;
            Some(self.amp * (2.0 * std::f64::consts::PI * 1000.0 * frame as f64 / 44100.0).sin() as f32)
        }
    }
    fn sine() -> Sine { Sine { n: 0, amp: (10f64.powf(-18.0 / 20.0) * std::f64::consts::SQRT_2) as f32 } }
    fn db(x: f64) -> f64 { 20.0 * x.log10() }

    /// Render `buffers` 480-frame buffers of the sine on S1 (slot 7) at the given fader / channel state and
    /// return (the S1 pre-fader window, the S1 post-fader engine peak).
    fn run_s1(volume: f32, muted: bool, buffers: usize) -> (MeterTap, u64, f32) {
        let rb = HeapRb::<f32>::new(PROGRAM_BUS_BUF);
        let (prod, _cons) = rb.split();
        let mut b = BusState::new(crate::eq::new_shared_eq(44100.0), prod, 44100, Arc::new(AtomicBool::new(false)));
        let _h = b.handles.take().unwrap();
        b.decks[7].source = Some(DeckFeed::prefilled(sine(), 480 * 2 * (buffers + 2)));
        b.decks[7].active = true;
        b.decks[7].paused = false;
        b.decks[7].volume = volume;
        b.decks[7].muted = muted;
        let bus = Arc::new(crate::rt::RtMutex::new(b));
        let fin = FinishedFlags::new();
        let playing = Arc::new(AtomicBool::new(true));
        let mut sc = Scratch::new();
        let mut data = vec![0f32; 480 * 2];
        for _ in 0..buffers { mixer_callback(&mut data, 2, &bus, &fin, &playing, &mut sc); }
        let b = bus.lock().unwrap();
        (b.meters_acc.ch[7], b.meters_acc.frames, b.peaks[7])
    }

    #[test]
    fn pre_fader_meter_does_not_move_with_the_fader_or_the_channel_switch() {
        let (on_full, n1, post_full) = run_s1(1.0, false, 100);
        let (on_half, n2, post_half) = run_s1(0.5, false, 100);
        let (off,     n3, post_off)  = run_s1(1.0, true,  100);
        assert_eq!((n1, n2, n3), (48_000, 48_000, 48_000));
        // BIT-IDENTICAL pre-fader windows: the fader and the channel switch do not reach this tap.
        for (name, t) in [("fader 0.5", &on_half), ("channel OFF", &off)] {
            assert_eq!(t.peak.map(f32::to_bits), on_full.peak.map(f32::to_bits), "{}: pre-fader PEAK moved", name);
            assert_eq!(t.sumsq.map(f64::to_bits), on_full.sumsq.map(f64::to_bits), "{}: pre-fader RMS moved", name);
        }
        // Calibration — the spec's verification line: −18 RMS / −15 peak (plain RMS, ruling 2).
        let rms = db((on_full.sumsq[0] / n1 as f64).sqrt());
        let pk = db(on_full.peak[0] as f64);
        println!("[meters] S1 pre-fader: RMS {:.3} dBFS, peak {:.3} dBFS — identical at fader 1.0 / 0.5 / channel OFF", rms, pk);
        assert!((rms + 18.0).abs() <= 0.05, "RMS reads {:.3}, want −18.00 ± 0.05", rms);
        assert!((pk + 14.99).abs() <= 0.05, "peak reads {:.3}, want −14.99 ± 0.05", pk);
        // Control: the POST-fader field DOES see the fader (−6.02 dB at 0.5) and the switch (silent) —
        // proving this test can see a fader at all.
        let d = db(post_half as f64) - db(post_full as f64);
        println!("[meters] post-fader control: fader 0.5 moves it {:.2} dB; channel OFF reads {}", d, post_off);
        assert!((d + 6.02).abs() <= 0.02, "post-fader did not drop 6.02 dB at fader 0.5: {:.3}", d);
        assert_eq!(post_off, 0.0, "post-fader should read silence with the channel OFF");
    }

    /// TIMING (slice 2 gate: "timing re-measured"). The whole callback with four decks playing and both
    /// processors on, per 480-frame (10 ms) buffer; and the meter work alone (18 taps × 480 frames).
    #[test]
    fn callback_timing_with_meters() {
        let rb = HeapRb::<f32>::new(PROGRAM_BUS_BUF);
        let (prod, _cons) = rb.split();
        let mut b = BusState::new(crate::eq::new_shared_eq(44100.0), prod, 44100, Arc::new(AtomicBool::new(true)));
        let _h = b.handles.take().unwrap();
        for i in [0usize, 1, 2, 6] {
            b.decks[i].source = Some(DeckFeed::prefilled(sine(), 480 * 2 * 1100));
            b.decks[i].active = true; b.decks[i].paused = false; b.decks[i].volume = 0.5;
        }
        b.proc_local = true; b.proc_stream = true;
        let bus = Arc::new(crate::rt::RtMutex::new(b));
        let fin = FinishedFlags::new();
        let playing = Arc::new(AtomicBool::new(true));
        let mut sc = Scratch::new();
        let mut data = vec![0f32; 480 * 2];
        let mut ns: Vec<u128> = Vec::with_capacity(1000);
        for _ in 0..1000 {
            let t0 = std::time::Instant::now();
            mixer_callback(&mut data, 2, &bus, &fin, &playing, &mut sc);
            ns.push(t0.elapsed().as_nanos());
            // keep the stream ring from filling (it is drained by ffmpeg in the product)
            let _ = &_cons;
        }
        ns.sort();
        let (med, worst) = (ns[ns.len() / 2] as f64 / 1e6, *ns.last().unwrap() as f64 / 1e6);
        // The meter work alone: 18 taps over one 480-frame buffer.
        let l = vec![0.25f32; 480]; let r = vec![0.25f32; 480];
        let mut taps = [MeterTap::default(); 18];
        let mut mt: Vec<u128> = Vec::with_capacity(1000);
        for _ in 0..1000 {
            let t0 = std::time::Instant::now();
            for t in taps.iter_mut() { t.add(std::hint::black_box(&l), std::hint::black_box(&r)); }
            mt.push(t0.elapsed().as_nanos());
        }
        mt.sort();
        println!("[meters-timing] callback (A,B,C,CART playing, LOCAL+STREAM processing): median {:.4} ms, worst {:.3} ms per 10 ms buffer", med, worst);
        println!("[meters-timing] meter work alone (18 taps x 480 frames): median {:.4} ms ({:.2}% of the 10 ms budget)", mt[mt.len()/2] as f64 / 1e6, mt[mt.len()/2] as f64 / 1e6 / 10.0 * 100.0);
        assert!(med < 1.0, "callback median {:.4} ms is over 10% of the buffer budget", med);
    }

    /// SLICE 3 — timing with the loudness taps (docs/dsp-loudness-meter.md §5.3). The callback's only new work
    /// is the ring copy of each branch's output and the GR fold; the BS.1770 state is on the meter thread.
    /// The rings are drained between buffers (outside the timed region), exactly as the meter thread keeps
    /// them from filling in the product — a never-drained ring would turn every push into a cheap drop.
    #[test]
    fn callback_timing_with_loudness() {
        let rb = HeapRb::<f32>::new(PROGRAM_BUS_BUF);
        let (prod, mut stream_cons) = rb.split();
        let mut b = BusState::new(crate::eq::new_shared_eq(44100.0), prod, 44100, Arc::new(AtomicBool::new(true)));
        let h = b.handles.take().unwrap();
        let (_meters, mut loud) = MetersHandle::from_parts(Arc::new(Mutex::new(h.meter_r)), h.shared.clone(), h.loud_cons, h.loud_shared);
        for i in [0usize, 1, 2, 6] {
            b.decks[i].source = Some(DeckFeed::prefilled(sine(), 480 * 2 * 2100));
            b.decks[i].active = true; b.decks[i].paused = false; b.decks[i].volume = 0.5;
        }
        b.proc_local = true; b.proc_stream = true;
        let bus = Arc::new(crate::rt::RtMutex::new(b));
        let fin = FinishedFlags::new();
        let playing = Arc::new(AtomicBool::new(true));
        let mut sc = Scratch::new();
        let mut data = vec![0f32; 480 * 2];
        let mut pop = vec![0f32; PROGRAM_BUS_BUF];
        let mut ns: Vec<u128> = Vec::with_capacity(2000);
        let a0 = crate::rt::tl_rt_allocs();
        for _ in 0..2000 {
            let t0 = std::time::Instant::now();
            mixer_callback(&mut data, 2, &bus, &fin, &playing, &mut sc);
            ns.push(t0.elapsed().as_nanos());
            loud.drain();
            while stream_cons.pop_slice(&mut pop) > 0 {}
        }
        let allocs = crate::rt::tl_rt_allocs() - a0;
        ns.sort();
        let q = |f: f64| ns[((ns.len() - 1) as f64 * f) as usize] as f64 / 1e6;
        // The added work alone: three ring copies of one 480-frame buffer + three GR folds (drained between).
        let (mut taps, cons, shared) = crate::loudness::loud_channels();
        let (mut lm, _r) = LoudnessMeters::new(cons, shared, 44100);
        let l = vec![0.25f32; 480]; let r = vec![0.25f32; 480];
        let mut gr = [crate::rt::GrTap::default(); 3];
        let mut added: Vec<u128> = Vec::with_capacity(2000);
        for i in 0..2000 {
            let t0 = std::time::Instant::now();
            for br in 0..3 { taps.push(br, std::hint::black_box(&l), std::hint::black_box(&r)); }
            for g in gr.iter_mut() { g.fold(std::hint::black_box(0.5), std::hint::black_box(i as f32 * 1e-4), GR_SRC_OWN); }
            added.push(t0.elapsed().as_nanos());
            lm.drain();
        }
        added.sort();
        let aq = |f: f64| added[((added.len() - 1) as f64 * f) as usize] as f64 / 1e6;
        println!("[loud-timing] callback (A,B,C,CART playing, LOCAL+STREAM processing, loudness taps on): median {:.4} ms, p99 {:.4} ms, worst {:.3} ms per 10 ms buffer · {} allocations",
                 q(0.5), q(0.99), q(1.0), allocs);
        println!("[loud-timing] added work alone (3 ring copies x 480 frames + 3 GR folds): median {:.4} ms, p99 {:.4} ms ({:.3}% of the 10 ms budget at the median)",
                 aq(0.5), aq(0.99), aq(0.5) / 10.0 * 100.0);
        assert_eq!(allocs, 0, "the callback allocated with the loudness taps on");
        assert!(q(0.5) < 1.0, "callback median {:.4} ms is over 10% of the buffer budget", q(0.5));
    }

    /// A burst lasting ONE buffer between two reads must appear in the next read — the case a latest-wins
    /// buffer alone would drop. And after the read acknowledges it, the next window starts clean.
    #[test]
    fn a_one_buffer_burst_between_reads_is_not_lost() {
        struct Burst { n: u64 }
        impl Iterator for Burst {
            type Item = f32;
            fn next(&mut self) -> Option<f32> {
                let frame = self.n / 2;
                self.n += 1;
                // buffer 5 (frames 2400..2880) at 0.9; everything else silent
                Some(if (2400..2880).contains(&frame) { 0.9 } else { 0.0 })
            }
        }
        let rb = HeapRb::<f32>::new(PROGRAM_BUS_BUF);
        let (prod, _cons) = rb.split();
        let mut b = BusState::new(crate::eq::new_shared_eq(44100.0), prod, 44100, Arc::new(AtomicBool::new(false)));
        let h = b.handles.take().unwrap();
        let (meters, _loud) = MetersHandle::from_parts(Arc::new(Mutex::new(h.meter_r)), h.shared.clone(), h.loud_cons, h.loud_shared);
        b.decks[0].source = Some(DeckFeed::prefilled(Burst { n: 0 }, 480 * 2 * 40));
        b.decks[0].active = true;
        b.decks[0].paused = false;
        let bus = Arc::new(crate::rt::RtMutex::new(b));
        let fin = FinishedFlags::new();
        let playing = Arc::new(AtomicBool::new(true));
        let mut sc = Scratch::new();
        let mut data = vec![0f32; 480 * 2];
        let mut cb = |k: usize| for _ in 0..k { mixer_callback(&mut data, 2, &bus, &fin, &playing, &mut sc); };
        cb(4);                                          // buffers 0-3: silence
        let w1 = meters.read_and_ack().unwrap();        // read after buffer 3
        cb(3);                                          // buffers 4, 5 (BURST), 6 — no read in between
        let w2 = meters.read_and_ack().unwrap();
        cb(3);                                          // buffers 7-9: silence
        let w3 = meters.read_and_ack().unwrap();
        println!("[meters] windows: e{} peak {:.3} | e{} peak {:.3} (burst) | e{} peak {:.3}",
                 w1.epoch, w1.ch[0].peak[0], w2.epoch, w2.ch[0].peak[0], w3.epoch, w3.ch[0].peak[0]);
        assert_eq!(w1.ch[0].peak[0], 0.0);
        assert_eq!(w2.ch[0].peak[0], 0.9, "the one-buffer burst between reads was lost");
        assert_eq!(w2.frames, 480 * 3, "window 2 should cover exactly the 3 buffers since the previous read");
        assert_eq!(w3.ch[0].peak[0], 0.0, "the acknowledged window did not reset");
        assert!(w1.epoch < w2.epoch && w2.epoch < w3.epoch);
        // PGM (post-fader bus) saw it too, and is marked live.
        assert_eq!(w2.bus[crate::rt::BUS_PGM].peak[0], 0.9);
        assert!(w2.bus_live & (1 << crate::rt::BUS_PGM) != 0 && w2.bus_live & (1 << crate::rt::BUS_MONITOR) != 0);
    }
}

#[cfg(test)]
mod duck_regression {
    // THE DUCKER — proof that it engages, holds, releases, and cannot be triggered by the wrong slot.
    //
    // The slice-1 goldens prove the duck-OFF path is untouched. These prove the duck-ON path does
    // what Jeff specified, so the feature is not shipping on an argument.
    use super::*;

    /// Constant-magnitude source — DC is fine here because the detector is a peak follower.
    struct Tone(f32);
    impl Iterator for Tone {
        type Item = f32;
        fn next(&mut self) -> Option<f32> { Some(self.0) }
    }

    fn bus_with(music: f32, source: f32, duck_on: bool) -> SharedBusState {
        let rb = HeapRb::<f32>::new(PROGRAM_BUS_BUF);
        let (prod, _cons) = rb.split();
        let eq = crate::eq::new_shared_eq(44100.0);
        let bus = Arc::new(crate::rt::RtMutex::new(BusState::new(eq, prod, 44100, Arc::new(AtomicBool::new(false)))));
        {
            let mut b = bus.lock().unwrap();
            b.decks[0].source = Some(DeckFeed::prefilled(Tone(music), 480 * 2 * 600));   // Rotation — the music
            b.decks[0].active = true; b.decks[0].paused = false; b.decks[0].volume = 1.0;
            b.decks[3].source = Some(DeckFeed::prefilled(Tone(source), 480 * 2 * 600));  // Source (D) — the announcement
            b.decks[3].active = true; b.decks[3].paused = false; b.decks[3].volume = 1.0;
            b.duck_enabled[3] = duck_on;
        }
        bus
    }

    fn run(bus: &SharedBusState, buffers: usize) {
        let fin = FinishedFlags::new();
        let playing = Arc::new(AtomicBool::new(true));
        for _ in 0..buffers {
            let mut data = vec![0f32; 480 * 2];
            mixer_callback(&mut data, 2, bus, &fin, &playing, &mut Scratch::new());
        }
    }
    fn set_source(bus: &SharedBusState, level: f32) {
        let mut b = bus.lock().unwrap();
        b.decks[3].source = Some(DeckFeed::prefilled(Tone(level), 480 * 2 * 600));
    }
    fn duck_gain(bus: &SharedBusState) -> f32 { bus.lock().unwrap().duck_gain }

    #[test]
    fn engages_holds_and_releases() {
        let bus = bus_with(0.25, 0.0, true);

        // Silence on the source → the music is untouched.
        run(&bus, 20);
        assert!(duck_gain(&bus) > 0.999, "music ducked with no source audio: g={}", duck_gain(&bus));

        // Announcement starts → the music is pulled down to the configured floor.
        //
        // The floor is DERIVED from the bus's own depth, never hardcoded: depth is an operator
        // setting dialled by ear from Preferences, and it moved from -12 to -22 dB the first time
        // Jeff heard it against a continuous source. A literal here would fail on every tuning
        // change and say "the ducker is broken" when the ducker was doing exactly as told.
        let depth_db = bus.lock().unwrap().duck_depth_db;
        let floor = 10f32.powf(depth_db / 20.0);
        set_source(&bus, 0.5);
        run(&bus, 40);                       // ~400 ms, well past a 30 ms attack
        let ducked = duck_gain(&bus);
        assert!((ducked - floor).abs() < 0.02,
                "did not reach the {} dB floor ({:.4} linear): g={}", depth_db, floor, ducked);

        // Announcement stops. WITHIN the hold the music must NOT start creeping back — this is the
        // parameter that stops it fluttering up between words.
        set_source(&bus, 0.0);
        run(&bus, 20);                       // ~200 ms into a 700 ms hold
        let held = duck_gain(&bus);
        assert!((held - ducked).abs() < 0.01, "music crept up during the hold: {} -> {}", ducked, held);

        // Past the hold + release → it rises back on its own. Nothing restarted it.
        run(&bus, 200);                      // ~2 s
        assert!(duck_gain(&bus) > 0.95, "music never came back: g={}", duck_gain(&bus));
    }

    #[test]
    fn a_source_deck_going_inactive_releases_it_does_not_snap() {
        // THE TRACK-GAP BUG (2026-08-23). duck_armed means "an armed source deck is active, unpaused
        // and holding a source THIS buffer" — and a jukebox drops all three between tracks. The gain
        // used to snap straight back to unity there, throwing the programme to full level with no
        // release, on EVERY track change. Heard as "the music rises while the source is still
        // playing", because from the operator's chair it is.
        let bus = bus_with(0.25, 0.5, true);
        run(&bus, 40);
        let ducked = duck_gain(&bus);
        assert!(ducked < 0.2, "control: should be ducked before the gap, g={}", ducked);

        // The deck goes away entirely — exactly what a track change looks like to the callback.
        { let mut b = bus.lock().unwrap(); b.decks[3].source = None; b.decks[3].active = false; }

        run(&bus, 10);                       // ~100 ms into a 700 ms hold
        let during_gap = duck_gain(&bus);
        assert!((during_gap - ducked).abs() < 0.01,
                "the duck SNAPPED on a track gap instead of holding: {} -> {}", ducked, during_gap);

        // And it still comes home on its own once the hold really has expired.
        run(&bus, 300);
        assert!(duck_gain(&bus) > 0.95, "never released after the source went away: g={}", duck_gain(&bus));
    }

    #[test]
    fn a_channel_with_ducking_off_still_airs_but_never_ducks() {
        let bus = bus_with(0.25, 0.5, false);
        run(&bus, 40);
        assert!(duck_gain(&bus) > 0.999,
                "a channel with its duck toggle OFF pulled the music down: g={}", duck_gain(&bus));
    }

    /// Peak of the DEVICE output over a run — what actually leaves the box.
    fn out_peak(bus: &SharedBusState, buffers: usize) -> f32 {
        let fin = FinishedFlags::new();
        let playing = Arc::new(AtomicBool::new(true));
        let mut pk = 0.0f32;
        for _ in 0..buffers {
            let mut data = vec![0f32; 480 * 2];
            mixer_callback(&mut data, 2, bus, &fin, &playing, &mut Scratch::new());
            for v in &data { pk = pk.max(v.abs()); }
        }
        pk
    }

    #[test]
    fn an_immune_deck_punches_through_the_duck() {
        // THE RECEIVER SIDE. A ducker is a sidechain: a trigger AND a set of channels it acts on.
        // A deck the operator marked immune must keep full level while the rest steps back — the
        // sound-effects-under-a-mic case.
        //
        // DIFFERENTIAL, deliberately: the output passes through EQ and master gain, so rather than
        // model that chain the test runs the SAME material twice, flipping only the flag. If immune
        // did nothing, the two would match.
        let mk = |immune: bool| {
            let bus = bus_with(0.0, 0.5, true);          // source on D, armed
            {
                let mut b = bus.lock().unwrap();
                b.decks[1].source = Some(DeckFeed::prefilled(Tone(0.30), 480 * 2 * 600));   // deck B — the deck under test
                b.decks[1].active = true; b.decks[1].paused = false; b.decks[1].volume = 1.0;
                b.duck_duckable[1] = !immune;
            }
            bus
        };

        // SETTLE FIRST, then measure. out_peak takes a maximum, so measuring across the attack
        // captures the pre-duck level and both cases read the same — which is exactly how this test
        // failed the first time it ran.
        let ducked = mk(false);
        run(&ducked, 60);
        let p_ducked = out_peak(&ducked, 20);
        assert!(duck_gain(&ducked) < 0.2, "control: the duck did not engage, g={}", duck_gain(&ducked));

        let immune = mk(true);
        run(&immune, 60);
        let p_immune = out_peak(&immune, 20);
        assert!(duck_gain(&immune) < 0.2, "control: the duck did not engage, g={}", duck_gain(&immune));

        assert!(p_immune > p_ducked * 1.5,
                "an immune deck did not punch through: immune peak {:.4} vs ducked {:.4}", p_immune, p_ducked);
    }

    #[test]
    fn rotation_and_cart_can_never_duck() {
        // The rule is structural: the detector reads the slot's KIND, so arming a Rotation deck or
        // CART does nothing. A sweeper must never duck the song it is sweeping into.
        let rb = HeapRb::<f32>::new(PROGRAM_BUS_BUF);
        let (prod, _cons) = rb.split();
        let eq = crate::eq::new_shared_eq(44100.0);
        let bus = Arc::new(crate::rt::RtMutex::new(BusState::new(eq, prod, 44100, Arc::new(AtomicBool::new(false)))));
        {
            let mut b = bus.lock().unwrap();
            for i in [0usize, 6usize] {                  // deck A (Rotation) and CART
                b.decks[i].source = Some(DeckFeed::prefilled(Tone(0.7), 480 * 2 * 600));
                b.decks[i].active = true; b.decks[i].paused = false; b.decks[i].volume = 1.0;
                b.duck_enabled[i] = true;                // armed, and still must not duck
            }
            assert_eq!(b.decks[0].kind, SlotKind::Rotation);
            assert_eq!(b.decks[6].kind, SlotKind::Sweeper);
        }
        run(&bus, 40);
        assert!(duck_gain(&bus) > 0.999,
                "a Rotation/CART slot triggered the ducker: g={}", duck_gain(&bus));
    }

    #[test]
    fn the_ride_is_frozen_while_ducked() {
        // §B.3a — the ride must not claw the duck back. Feed the processor a QUIET programme, which
        // is exactly what a duck produces, and prove its corrective gain does not move while held.
        let mut p = crate::program_processor::ProgramProcessor::new(44100.0, -14.0);
        // A 1 kHz SINE, not DC: ebur128 K-weights the signal, so a DC level reads as no loudness at
        // all and the ride would never move — the control assertion below would fail for a reason
        // that has nothing to do with the hold.
        let quiet: Vec<f32> = (0..48_000)
            .flat_map(|n| {
                let v = (2.0 * std::f32::consts::PI * 1000.0 * (n as f32) / 44_100.0).sin() * 0.02;
                [v, v]
            })
            .collect();

        p.set_ride_hold(false);
        let mut free = quiet.clone();
        p.process_block(&mut free);
        let moved = p.ride_gain_db();
        assert!(moved > 0.1, "control: an unheld ride should push a quiet programme UP, got {} dB", moved);

        p.set_ride_hold(true);
        let before = p.ride_gain_db();
        for _ in 0..10 {
            let mut held = quiet.clone();
            p.process_block(&mut held);
        }
        let after = p.ride_gain_db();
        assert_eq!(before.to_bits(), after.to_bits(),
                   "the ride moved while held: {} -> {} dB", before, after);
    }
}

const PROGRAM_RATE:   u32       = 44100;
pub(crate) const PROGRAM_BUS_BUF: usize    = PROGRAM_RATE as usize * 2 * 4; // 4 s at 44100 Hz stereo
/// AUX monitor ring — ~0.5 s of 44100 Hz stereo. Deliberately SHORT: this is a monitor feed and
/// latency matters more than resilience. The writer bounds it further (see AUX_RING_HIGH).
pub(crate) const AUX_BUS_BUF: usize = PROGRAM_RATE as usize;          // 44100 samples = 0.5 s stereo
/// Above this fill the writer drops a frame — the drift bound. Two device clocks run independently,
/// so without this the ring creeps toward full and the monitor drifts seconds behind the room.
const AUX_RING_HIGH: usize = PROGRAM_RATE as usize / 4;    // ~0.125 s stereo

pub fn start_station_mixer(station_id: u32, device_name: Option<String>) -> (
    std::sync::mpsc::Sender<AudioCmd>,
    Arc<AtomicBool>,
    SharedLevels,
    FinishedFlags,
    u16,  // Program Bus TCP port
    SharedDelay,  // broadcast-delay / dump control
    MetersHandle, // SLICE 2 — the meter bus
) {
    use std::net::TcpListener;

    let (tx, rx) = std::sync::mpsc::channel::<AudioCmd>();
    let is_playing       = Arc::new(AtomicBool::new(false));
    let is_playing_clone = is_playing.clone();
    let levels: SharedLevels = Arc::new(Mutex::new(AudioLevels::default()));
    let levels_clone     = levels.clone();
    let finished         = FinishedFlags::new();
    let finished_clone   = finished.clone();
    let delay: SharedDelay = Arc::new(DelayControl::new());
    let delay_drain        = delay.clone();

    // Ring buffer: producer lives in cpal callback, consumer in TCP drain thread.
    let rb = HeapRb::<f32>::new(PROGRAM_BUS_BUF);
    let (ring_prod, ring_cons) = rb.split();

    // Per-station program-bus stream-client flag (DESIGN-TRUTH §2). One Arc, two holders:
    // this station's mixer (via BusState) reads it; this station's drain thread writes it.
    let stream_connected = Arc::new(AtomicBool::new(false));

    // ── AUX MONITOR OUTPUT — its own device, its own stream, its own clock ───────────────────────
    // Empty string = no device chosen = no stream = silence. The operator's choice is the only thing
    // that ever opens this.
    let aux_req: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));

    let shared_eq = crate::eq::new_shared_eq(44100.0);
    let mut bus_init = BusState::new(shared_eq, ring_prod, 44100, stream_connected.clone());
    // S3 — the non-callback ends of the state's channels. The aux thread gets its command producer and
    // the frame counter; the dispatch thread gets everything else (Control). After this, nothing but the
    // callback — and the device-switch path while no callback runs — ever locks the state.
    let handles = bus_init.handles.take().expect("fresh BusState has its handles");
    let aux_frames_ctr_shared = bus_init.aux_out_frames.clone();
    let station_counters = bus_init.counters.clone();
    let meter_reader = Arc::new(Mutex::new(handles.meter_r));
    // SLICE 3 — the station's loudness meter thread: BS.1770 per branch, off the audio thread
    // (docs/dsp-loudness-meter.md §1.4). It exits when this station's state is dropped.
    let (mut meters_handle, loud_meters) = MetersHandle::from_parts(meter_reader.clone(), handles.shared.clone(),
                                                                handles.loud_cons, handles.loud_shared);
    // SLICE 8 — the RTA's analysis rides the same meter thread (docs/dsp-channel-rta.md §2).
    let (rta_an, rta_reader) = crate::rta::RtaAnalyzer::new(handles.rta_cons, handles.rta_shared);
    meters_handle.rta = Some(rta_reader);
    crate::loudness::spawn_meter_thread(station_id, loud_meters, Some(rta_an));
    let mut ctl_init = Control::new(&bus_init, handles.cmd_prod, handles.garbage_cons, meter_reader,
                                handles.shared, aux_frames_ctr_shared.clone(), station_id, station_counters.clone());
    ctl_init.loud = Some(meters_handle.loud.clone());
    let aux_cmd_prod = handles.aux_cmd_prod;
    let bus_state: SharedBusState = Arc::new(crate::rt::RtMutex::new(bus_init));
    let bus_cmd = bus_state.clone(); // device-open / device-switch only (no callback running then)

    // ── TCP listener (Program Bus) ────────────────────────────────────────────
    let listener = TcpListener::bind("127.0.0.1:0")
        .expect("[RUST] Program Bus TCP bind failed");
    let tcp_port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    eprintln!("[RUST] Station {} Program Bus on TCP port {}", station_id, tcp_port);

    std::thread::spawn(move || {
        drain_program_bus(station_id, listener, ring_cons, delay_drain, stream_connected);
    });

    // ── MONITOR OUTPUT THREAD — the AUX monitor AND the PFL cue output ─────────────────────────────────────
    // Each owns its own cpal stream on a device the OPERATOR chose: opened when picked, closed when cleared,
    // reopened when switched, retried slowly while absent — never a fallback to another device. It is the ONLY
    // thing that installs either ring producer into BusState, so "no device chosen = silence" is true in the
    // audio path itself. One thread for both (they share the one AuxCmd queue into the callback — one producer).
    //
    // Its own clock per device: the stream's callback drains what the mixer produced and resamples 44100 -> the
    // device rate with a persistent phase and a sub-audible ratio nudge toward a target fill; on underrun it
    // decays to silence rather than stretching. Two clocks always drift; this bounds the consequence to an
    // occasional tick on a MONITOR feed, and it never touches air.
    {
        let mut aux_tx = aux_cmd_prod;
        // Deliver a command to the callback. The queue holds 16 and these happen when an operator picks a
        // device, so a full queue means the callback is not running; retry briefly, then give up loudly.
        let mut send = move |c: AuxCmd| {
            let mut c = c;
            for _ in 0..200 {
                match aux_tx.try_push(c) { Ok(()) => return, Err(back) => { c = back; std::thread::sleep(std::time::Duration::from_millis(5)); } }
            }
            eprintln!("[RUST] Station {} monitor-output command not delivered (callback not running)", station_id);
        };
        let cue = cue_status(station_id);
        let aux_req_t = aux_req.clone();
        std::thread::spawn(move || {
            // Built HERE: a cpal Stream is not Send, so each output's stream lives and dies on this thread.
            let mut outs = [
                MonOut::new("AUX monitor", "aux", aux_req_t, aux_frames_ctr_shared, None, AuxCmd::Attach, || AuxCmd::Detach),
                MonOut::new("PFL cue", "cue", cue.req.clone(), cue.frames.clone(), Some(cue.clone()), AuxCmd::AttachCue, || AuxCmd::DetachCue),
            ];
            loop {
                for o in outs.iter_mut() { o.service(station_id, &mut send); }
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
        });
    }

    // ── Audio dispatch thread ─────────────────────────────────────────────────
    std::thread::spawn(move || {
        use cpal::traits::{DeviceTrait, StreamTrait};

        let mut current_device = device_name;
        let mut ctl = ctl_init;
        // This station's own liveness clock. S2: the callback advances `cb_seq`; this thread stamps
        // `last_cb` with the wall time whenever it sees the sequence move, at ≤ 50 ms resolution — so
        // audio_last_callback_ms keeps its meaning without a clock call on the audio thread.
        let last_cb = station_cb_clock(station_id);
        let cb_seq = Arc::new(AtomicU64::new(0));
        let mut seen_seq = 0u64;
        // OUTPUT LIVENESS (outwatch.rs; OV dead air on 4.6.51): an OPEN stream whose callback stops for > 1 s is a
        // STALL — logged with the time and the device, counted, and the stream reopened through the device-switch
        // path below (same device, decks restored). A device that keeps stalling → the system default, said aloud.
        let mut watch = crate::outwatch::StallWatch::new(std::time::Instant::now());
        let mut ev_cons: Option<ringbuf::HeapCons<RtEvent>> = None;
        // THE MIC — this station's input streams. Owned by THIS thread (each cpal input Stream is built and
        // dropped here), and it outlives an output-device reopen: the live feed stays in its deck slot.
        let mut mics = crate::micin::MicInputs::new(station_id);
        let mut mic_out: Vec<crate::micin::MicAction> = Vec::new();
        // REMOTE LINK — this station's Link input (which slot) and its sender (while SEND TO is on).
        let mut links = crate::linknet::LinkInputs::new(station_id);
        let mut _link_sender: Option<crate::linknet::Sender> = None;

        'outer: loop {
            // A card that keeps failing is retried with a pause, never in a tight loop.
            let pause = watch.backoff();
            if !pause.is_zero() { std::thread::sleep(pause); }
            // Find and open output device — the CHOSEN one, unless it has stalled or failed FALLBACK_AFTER times in
            // a row: then the system default, and the log says so (a silent station is worse than the wrong card).
            let fallback = watch.use_default_next() && current_device.is_some();
            let want = if fallback { None } else { current_device.clone() };
            let (device, sr, ch) = match open_output_device(station_id, &want) {
                Some(d) => d,
                None => {
                    watch.open_failed();
                    eprintln!("[RUST] {} Station {} output: no device to open ({:?}) — attempt {} failed, retrying",
                              crate::outwatch::iso_now(), station_id, want, watch.consecutive);
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    continue 'outer;
                }
            };
            let dev_name = device.name().unwrap_or_default();
            if fallback {
                RtCounters::bump(&ctl.counters.stall_fallbacks, 1);
                eprintln!("[RUST] {} Station {} output: {:?} stalled or failed {} times in a row — opening the SYSTEM DEFAULT \"{}\" instead",
                          crate::outwatch::iso_now(), station_id, current_device, watch.consecutive, dev_name);
            }

            // Update BusState with actual sample rate
            if let Ok(mut bus) = bus_cmd.lock() {
                bus.sample_rate = sr;
                if let Ok(mut eq) = bus.eq.lock() { eq.set_sample_rate(sr as f32); }
            }

            // Restore any loaded-but-not-yet-active decks after device switch
            restore_decks_after_switch(&bus_cmd, sr, &mut ctl);

            let stream_config = cpal::StreamConfig {
                channels:    ch,
                sample_rate: cpal::SampleRate(sr),
                buffer_size: soak_buffer_size(station_id, &device),
            };

            let bus_cb   = bus_cmd.clone();
            let fin_cb   = finished_clone.clone();
            let play_cb  = is_playing_clone.clone();
            // S2 — the callback no longer reads the wall clock. It bumps this counter (one atomic add);
            // the dispatch loop below sees it advance and stamps THIS station's liveness clock there.
            let cb_seq_cb = cb_seq.clone();
            // S1 — this stream's working buffers, allocated here on the dispatch thread and MOVED into the
            // callback. The audio thread never allocates them; a reopened device gets a fresh set here.
            let mut sc = Scratch::with_counters(station_counters.clone());
            let cb_counters = station_counters.clone();
            // S6 — OVERRUN detection from the timestamps cpal HANDS the callback (no clock call of ours):
            // a gap since the previous callback of more than 1.5 × this buffer's duration is a late callback.
            let mut prev_cb: Option<cpal::StreamInstant> = None;
            // S2 — this device-open's event queue. The previous open's consumer is drained first, so an
            // event from the last moments of the old stream is still logged.
            if let Some(ref mut old) = ev_cons { drain_rt_events(station_id, old); }
            let (ev_p, ev_c) = HeapRb::<RtEvent>::new(RT_EVENT_QUEUE).split();
            sc.events = Some(ev_p);
            ev_cons = Some(ev_c);

            // cpal's ERROR callback (rare; not the audio callback): said with the station, the device and the time,
            // counted, and handed to the dispatch thread, which treats it exactly as a stall (reopen, decks restored).
            let dev_err: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
            let (err_slot, err_dev, err_counters) = (dev_err.clone(), dev_name.clone(), station_counters.clone());
            let stream = device.build_output_stream::<f32, _, _>(
                &stream_config,
                move |data: &mut [f32], info: &cpal::OutputCallbackInfo| {
                    let ts = info.timestamp().callback;
                    if let Some(p) = prev_cb {
                        if let Some(gap) = ts.duration_since(&p) {
                            let frames = (data.len() / ch.max(1) as usize) as u64;
                            let expected_ns = frames * 1_000_000_000 / (sr.max(1) as u64);
                            if gap.as_nanos() as u64 > expected_ns * 3 / 2 { RtCounters::bump(&cb_counters.overruns, 1); }
                        }
                    }
                    prev_cb = Some(ts);
                    RtCounters::bump(&cb_counters.callbacks, 1);
                    mixer_callback(data, ch, &bus_cb, &fin_cb, &play_cb, &mut sc);
                    // Per-station liveness — THIS station's counter only (stamped to wall time off-thread).
                    cb_seq_cb.fetch_add(1, Ordering::Relaxed);
                },
                move |err| {
                    RtCounters::bump(&err_counters.device_errors, 1);
                    eprintln!("[RUST] {} Station {} cpal ERROR on \"{}\": {} — treating it as a stall (reopen)",
                              crate::outwatch::iso_now(), station_id, err_dev, err);
                    if let Ok(mut g) = err_slot.try_lock() { if g.is_none() { *g = Some(err.to_string()); } }
                },
                None,
            );

            let stream = match stream {
                Ok(s) => s,
                Err(e) => {
                    watch.open_failed();
                    eprintln!("[RUST] {} Station {} build_output_stream on \"{}\": {} — retrying", crate::outwatch::iso_now(), station_id, dev_name, e);
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    continue 'outer;
                }
            };
            if let Err(e) = stream.play() {
                watch.open_failed();
                eprintln!("[RUST] {} Station {} stream.play() on \"{}\": {} — retrying", crate::outwatch::iso_now(), station_id, dev_name, e);
                std::thread::sleep(std::time::Duration::from_secs(2));
                continue 'outer;
            }
            watch.stream_opened(std::time::Instant::now(), cb_seq.load(Ordering::Relaxed));

            eprintln!("[RUST] Station {} audio output opened ({}Hz {}ch)",
                station_id, sr, ch);

            // Command loop — holds `stream` alive; dropping it stops the callback
            loop {
                // S2 — the audio thread's work that is not audio: its log lines and its liveness stamp.
                // At the TOP of the loop so no `continue` in a command arm can skip it.
                if let Some(ref mut c) = ev_cons { drain_rt_events(station_id, c); }
                // THE MIC — loss / stall / digital silence, and re-open (every ≤ 50 ms tick).
                mics.tick(std::time::Instant::now(), &mut mic_out);
                apply_mic_actions(&mut ctl, &mut mic_out);
                // S3 — free what the callback let go of, and hand it whatever is waiting.
                ctl.drain_garbage();
                ctl.flush();
                let seq = cb_seq.load(Ordering::Relaxed);
                if seq != seen_seq { seen_seq = seq; last_cb.store(now_ms(), Ordering::Relaxed); }
                // OUTPUT LIVENESS — the callback stopped while the stream is open: log, count, reopen (break →
                // 'outer reopens and restores the decks, exactly as ReopenOutput does).
                let device_error = dev_err.try_lock().ok().and_then(|mut g| g.take());
                if let Some(why) = watch.observe(std::time::Instant::now(), seq, device_error) {
                    RtCounters::bump(&ctl.counters.stalls, 1);
                    let what = match &why {
                        crate::outwatch::Stall::NoCallbacks { ms } => format!("no output callback for {} ms", ms),
                        crate::outwatch::Stall::DeviceError(e) => format!("the device reported an error: {}", e),
                    };
                    eprintln!("[RUST] {} Station {} output STALL on \"{}\": {} ({} callbacks so far, stall #{}) — reopening the output, decks restored",
                              crate::outwatch::iso_now(), station_id, dev_name, what, ctl.counters.callbacks.load(Ordering::Relaxed),
                              ctl.counters.stalls.load(Ordering::Relaxed));
                    break;
                }
                match rx.recv_timeout(std::time::Duration::from_millis(50)) {
                    Ok(cmd) => {
                        match cmd {
                            // ── S3: every arm below edits the dispatch thread's OWN copy of the state (ctl) and
                            // queues a message. None of them touches BusState: the callback owns it, and
                            // applies these at the top of its next buffer (docs/dsp-rt-callback.md §4).
                            AudioCmd::Load { deck, file_path, title, artist, gain_db } => {
                                let Some(idx) = deck_index(&deck) else { continue };
                                if mics.is_live(idx) { mics.refused(idx, "load"); continue; }
                                if links.is_live(idx) { links.refused(idx, "load"); continue; }
                                // Decode setup off the audio thread, as always.
                                let src = build_source(&file_path, sr).map(|d| ctl.feed_for(idx, d));
                                let has = src.is_some();
                                let gen = ctl.next_gen();
                                // THE FADER LEVEL IS THE JOCK'S — a track load must never move it. Only the
                                // track's own trim (gain_db) travels with the load; it is applied PRE-FADER
                                // at the mix, on top of whatever level the operator set.
                                let seq = ctl.enqueue(RtCmd::Load { slot: idx as u8, src, gain_db, gen });
                                let d = &mut ctl.decks[idx];
                                d.path = file_path;
                                d.title = title;
                                d.artist = artist;
                                d.gain_db = gain_db;
                                d.src_expected = has;
                                d.src_msg_seq = seq;
                                finished_clone.clear(&deck);
                            }
                            AudioCmd::Play(deck) => {
                                let Some(idx) = deck_index(&deck) else { continue };
                                if mics.is_live(idx) { mics.refused(idx, "play"); continue; }
                                if links.is_live(idx) { links.refused(idx, "play"); continue; }
                                finished_clone.clear(&deck);
                                // "Does this deck hold a source?" — answered from what the callback has
                                // actually applied (ctl.present), with any not-yet-applied Load/Stop/reload
                                // taken as already done. Same question the locked read used to answer.
                                let present = ctl.present(idx);
                                let path = ctl.decks[idx].path.clone();
                                // source=None AND path empty → fake play would produce silence
                                // with a live level meter; skip entirely.
                                if !present && path.is_empty() {
                                    eprintln!("[RUST] Play deck {}: source=None, path empty — skipping", deck);
                                    continue;
                                }
                                // If source was cleared (e.g. by natural end) but path is known,
                                // reload before playing — file I/O on this thread, never the callback.
                                let reload = if !present {
                                    let Some(d) = build_source(&path, sr) else {
                                        eprintln!("[RUST] Play deck {}: reload failed for {} — skipping", deck, path);
                                        continue;
                                    };
                                    Some(ctl.feed_for(idx, d))
                                } else { None };
                                let reloading = reload.is_some();
                                let gen = ctl.next_gen();
                                let seq = ctl.enqueue(RtCmd::Play { slot: idx as u8, reload, gen });
                                if reloading {
                                    ctl.decks[idx].src_expected = true;
                                    ctl.decks[idx].src_msg_seq = seq;
                                }
                            }
                            AudioCmd::Pause(deck) => {
                                let Some(idx) = deck_index(&deck) else { continue };
                                if mics.is_live(idx) { mics.refused(idx, "pause"); continue; }
                                if links.is_live(idx) { links.refused(idx, "pause"); continue; }
                                ctl.enqueue(RtCmd::Pause { slot: idx as u8 });
                            }
                            AudioCmd::Stop(deck) => {
                                let Some(idx) = deck_index(&deck) else { continue };
                                if mics.is_live(idx) { mics.refused(idx, "stop"); continue; }
                                if links.is_live(idx) { links.refused(idx, "stop"); continue; }
                                finished_clone.clear(&deck);
                                let seq = ctl.enqueue(RtCmd::Stop { slot: idx as u8 });
                                let d = &mut ctl.decks[idx];
                                d.path = String::new();
                                d.src_expected = false;
                                d.src_msg_seq = seq;
                            }
                            AudioCmd::SetVolume { deck, volume } => {
                                let Some(idx) = deck_index(&deck) else { continue };
                                ctl.params.volume[idx] = volume;
                                ctl.params_changed();
                            }
                            AudioCmd::SetMuted { deck, muted } => {
                                let Some(idx) = deck_index(&deck) else { continue };
                                ctl.params.muted[idx] = muted;
                                ctl.params_changed();
                            }
                            AudioCmd::SetAuxDevice(name) => {
                                // Recorded for the aux thread, which owns opening/closing that stream.
                                // Empty = none = it closes the stream and detaches the ring producer.
                                if let Ok(mut r) = aux_req.lock() { *r = name; }
                            }
                            AudioCmd::SetSlotKind { deck, kind } => {
                                let Some(idx) = deck_index(&deck) else { continue };
                                // A/B/C are automation's decks and are never re-kinded: putting a
                                // rotation deck on another bus is not something an operator can
                                // ask for by dialling a dropdown.
                                if ctl.params.kind[idx] != SlotKind::Rotation {
                                    ctl.params.kind[idx] = if kind == "sweeper" { SlotKind::Sweeper } else { SlotKind::Source };
                                    ctl.params_changed();
                                }
                            }
                            AudioCmd::SetDuck { deck, enabled } => {
                                // Accepted for ANY slot and stored as given. The rule that only a
                                // SOURCE slot can actually duck lives in the mixer callback, which
                                // reads the slot's kind — so a caller that arms deck A gets an honest
                                // "stored, and it will never fire" rather than a silent refusal that
                                // the UI would then misreport as enabled.
                                let Some(idx) = deck_index(&deck) else { continue };
                                ctl.params.duck_enabled[idx] = enabled;
                                ctl.params_changed();
                            }
                            AudioCmd::SetDuckable { deck, duckable } => {
                                let Some(idx) = deck_index(&deck) else { continue };
                                ctl.params.duck_duckable[idx] = duckable;
                                ctl.params_changed();
                            }
                            AudioCmd::SetPfl { deck, on } => {
                                let Some(idx) = deck_index(&deck) else { continue };
                                ctl.params.pfl[idx] = on;
                                ctl.params_changed();
                            }
                            AudioCmd::SetCueDevice(name) => {
                                // The monitor-output thread opens / closes the device; the callback learns the MODE
                                // from the Params block: a chosen device takes PFL off the main output entirely.
                                ctl.params.pfl_to_device = !name.is_empty();
                                ctl.params_changed();
                                if let Ok(mut r) = cue_status(station_id).req.lock() { *r = name; }
                            }
                            AudioCmd::SetPflDim(db) => {
                                ctl.params.pfl_dim_db = db.clamp(PFL_DIM_DB_RANGE.0, PFL_DIM_DB_RANGE.1);
                                ctl.params_changed();
                            }
                            AudioCmd::SetDuckParams { depth_db, threshold_db, attack_ms, hold_ms, release_ms } => {
                                // Clamped at the edges only — every value in between is a
                                // legitimate operator choice. 0 dB depth means "armed but not
                                // ducking", and a 0 ms hold means "release the moment the source
                                // stops", both of which someone may genuinely want to hear.
                                crate::show::set_duck_params(&mut ctl.params, crate::show::DuckParams { depth_db, threshold_db, attack_ms, hold_ms, release_ms });
                                ctl.params_changed();
                            }
                            AudioCmd::SetAuxMonitor { deck, gain } => {
                                // AUX DECKS ONLY. A/B/C and CART are board channels and their local
                                // monitoring is unchanged by this feature; refusing them here means no
                                // caller can accidentally route a programme deck through the aux path.
                                let Some(idx) = deck_index(&deck) else { continue };
                                if !(3..=5).contains(&idx) { continue; }
                                crate::show::set_room(&mut ctl.params, idx, gain);
                                // The SAME row drives both, because it is one control: "how loud
                                // is this deck in the room". Which buffer it reaches depends on
                                // the slot's bus — an aux deck through the aux tap, a sweeper
                                // through the room sum — and the operator should not have to know
                                // which. Rotation decks never get here, so they keep unity.
                                // (show::set_room — the one setter a Take also uses.)
                                ctl.params_changed();
                            }
                            AudioCmd::GetLevel => {
                                // REAL levels — the callback's latest published frame (S3: a lock-free
                                // triple buffer; this no longer holds anything the callback needs).
                                let Some(m) = ctl.meter.lock().ok().map(|mut r| r.read()) else { continue };
                                let p = &m.params;
                                // SLICE 3 — OUT is MEASURED (loudness.rs momentary on the branch output). The
                                // legacy fields keep their -70 floor for "no reading" (their readers treat
                                // anything <= -69 as no signal); the meter bus carries the exact values.
                                let lf = ctl.loud.as_ref().and_then(|r| r.lock().ok().map(|mut r| r.read())).unwrap_or_default();
                                let out_m = |b: usize| -> f32 {
                                    let v = lf.b[b].m;
                                    if lf.b[b].fed && v.is_finite() && v > -70.0 { v as f32 } else { -70.0 }
                                };
                                if let Ok(mut lvl) = levels_clone.lock() {
                                    lvl.level_a      = m.peaks[0];
                                    lvl.level_b      = m.peaks[1];
                                    lvl.level_c      = m.peaks[2];
                                    lvl.level_cart   = m.peaks[6];
                                    lvl.level_master = m.master_peak;
                                    lvl.level_room   = m.room_peak;
                                    lvl.aux_frames   = ctl.aux_frames.load(Ordering::Relaxed);
                                    lvl.aux_peak     = m.aux_peak;
                                    lvl.aux_proc_in_lufs  = m.aux_proc_in_lufs;
                                    lvl.aux_proc_out_lufs = out_m(LOUD_AUX);
                                    lvl.aux_proc_gr_db    = m.aux_proc_gr_db;
                                    lvl.aux_proc_ride_db  = m.aux_proc_ride_db;
                                    lvl.duck_gain         = m.duck_gain;
                                    // v4.4.46 mix telemetry.
                                    lvl.frames_total = m.frames_consumed;
                                    lvl.mon_vol      = p.monitor_vol;
                                    // Audio Processing v1 meters (observed at the taps).
                                    lvl.proc_local       = p.proc_local;
                                    lvl.proc_stream      = p.proc_stream;
                                    // SLICE 4 — the echo reads the RACK the callback adopted.
                                    use crate::rack::{BRANCH_LOCAL, BRANCH_STREAM};
                                    let (rl, ril) = p.rack.ride(BRANCH_LOCAL);
                                    let (ll, lil) = p.rack.limiter(BRANCH_LOCAL);
                                    let (rs, ris) = p.rack.ride(BRANCH_STREAM);
                                    let (ls, lis) = p.rack.limiter(BRANCH_STREAM);
                                    lvl.proc_target_lufs = rl.target;
                                    lvl.proc_in_lufs     = m.proc_in_lufs;
                                    // proc_* describes LOCAL, falling back to STREAM when only the stream
                                    // processes — the rule the processor meters have always followed.
                                    lvl.proc_out_lufs    = if !p.proc_local && p.proc_stream { out_m(LOUD_STREAM) } else { out_m(LOUD_LOCAL) };
                                    lvl.proc_gr_db       = m.proc_gr_db;
                                    lvl.proc_ride_gain_db = m.proc_ride_gain_db;
                                    lvl.proc_in_peak     = m.proc_in_peak;
                                    lvl.proc_out_peak    = m.proc_out_peak;
                                    // THE ECHO — the parameters the ENGINE ran this buffer (the block the
                                    // callback adopted), not what this thread last sent.
                                    lvl.proc_ceiling_dbtp   = ll.ceiling;
                                    lvl.proc_release_ms     = ll.release;
                                    lvl.proc_ride_rate      = rl.rate;
                                    lvl.proc_ride_clamp     = rl.clamp;
                                    lvl.proc_ride_bypass    = !ril;
                                    lvl.proc_limiter_bypass = !lil;
                                    lvl.proc_stream_in_lufs      = m.proc_stream_in_lufs;
                                    lvl.proc_stream_out_lufs     = out_m(LOUD_STREAM);
                                    lvl.proc_stream_gr_db        = m.proc_stream_gr_db;
                                    lvl.proc_stream_ride_gain_db = m.proc_stream_ride_gain_db;
                                    lvl.proc_stream_in_peak      = m.proc_stream_in_peak;
                                    lvl.proc_stream_out_peak     = m.proc_stream_out_peak;
                                    lvl.proc_stream_target_lufs  = rs.target;
                                    lvl.proc_stream_ceiling_dbtp = ls.ceiling;
                                    lvl.proc_stream_release_ms   = ls.release;
                                    lvl.proc_stream_ride_rate    = rs.rate;
                                    lvl.proc_stream_ride_clamp   = rs.clamp;
                                    lvl.proc_stream_ride_bypass    = !ris;
                                    lvl.proc_stream_limiter_bypass = !lis;
                                    let mut active = 0u32;
                                    // Explicit literals, never an index into DECK_LETTERS — the 2026-07-15
                                    // panic rule (docs/incident-jingle-cart-panic-2026-07-15.md) still holds.
                                    let mut dt = Vec::with_capacity(SLOT_COUNT);
                                    for (i, id) in [(0usize, "A"), (1, "B"), (2, "C"),
                                                    (3, "D"), (4, "E"), (5, "F"), (6, "CART"),
                                                    (7, "S1"), (8, "S2"), (9, "S3"), (10, "S4"), (11, "S5")] {
                                        let d = &m.decks[i];
                                        // active_decks stays A/B/C ONLY — electron/audio-health.js
                                        // already consumes this number.
                                        if i < 3 && d.active && !d.paused && d.source_present { active += 1; }
                                        dt.push(DeckTel {
                                            id: id.to_string(),
                                            source_present: d.source_present,
                                            active: d.active,
                                            paused: d.paused,
                                            muted: p.muted[i],
                                            volume: p.volume[i],
                                            gain_db: d.gain_db,
                                            frames_played: d.frames_played,
                                            peak: m.peaks[i],
                                            duck: p.duck_enabled[i],
                                            underruns: ctl.counters.underruns[i].load(Ordering::Relaxed),
                                        });
                                    }
                                    lvl.active_decks = active;
                                    lvl.decks = dt;
                                    // S6 — the callback's health counters (cumulative for this station).
                                    let c = &ctl.counters;
                                    let ld = |a: &AtomicU64| a.load(Ordering::Relaxed);
                                    lvl.rt = RtLevels {
                                        callbacks: ld(&c.callbacks),
                                        underruns: c.underruns.iter().map(ld).sum(),
                                        underrun_frames: c.underrun_frames.iter().map(ld).sum(),
                                        lock_misses: ld(&c.lock_misses),
                                        overruns: ld(&c.overruns),
                                        events_dropped: ld(&c.events_dropped),
                                        buffer_clamped: ld(&c.buffer_clamped),
                                        garbage_leaked: ld(&c.garbage_leaked),
                                        stalls: ld(&c.stalls),
                                        stall_fallbacks: ld(&c.stall_fallbacks),
                                        device_errors: ld(&c.device_errors),
                                        allocs: rt_allocs(),
                                    };
                                }
                            }
                            AudioCmd::SwitchDevice(name) => {
                                eprintln!("[RUST] Station {} SwitchDevice → {:?}", station_id, name);
                                current_device = if name.is_empty() { None } else { Some(name) };
                                watch.consecutive = 0;   // the operator chose a device: judge it fresh
                                break; // drop stream → 'outer reopens device
                            }
                            AudioCmd::ReopenOutput => {
                                // Per-station recovery: drop THIS station's stream so 'outer reopens
                                // the SAME device. Touches only this card — siblings unaffected.
                                eprintln!("[RUST] Station {} ReopenOutput — reopening its own output stream", station_id);
                                break;
                            }
                            AudioCmd::SetEq(gains) => {
                                // One control, both EQ instances (air + room) — the callback applies the
                                // new bands to both when it adopts this block, as SetEq always did.
                                // SLICE 4 — the legacy SetEq edits the rack's GEQ slot (one block, one path).
                                let mut b = [0.0f32; 10];
                                for i in 0..10 { let g = gains.get(i).copied().unwrap_or(0.0); b[i] = if g.is_finite() { g } else { 0.0 }; }
                                ctl.params.rack.set_geq_bands(b);
                                ctl.params.rack.eq_version = ctl.params.rack.eq_version.wrapping_add(1);
                                ctl.params_changed();
                            }
                            AudioCmd::SetMonitorVolume(v) => {
                                crate::show::set_monitor(&mut ctl.params, v);
                                ctl.params_changed();
                            }
                            AudioCmd::SetMasterVolume(v) => {
                                // Clamped 0..=1: master is an attenuator on air. >1 would let the operator
                                // push the program bus into clipping ahead of the limiter.
                                crate::show::set_master_fader(&mut ctl.params, v);
                                ctl.params_changed();
                            }
                            AudioCmd::SetMasterMonitorVolume(v) => {
                                ctl.params.master_monitor_vol = v.clamp(0.0, 1.0);
                                ctl.params_changed();
                            }
                            AudioCmd::SetProcessorBypass { branch, ride_bypass, limiter_bypass } => {
                                // SLICE 4 — the live-only bypasses ARE the ride/limiter slots' IN.
                                let br = if branch == 1 { crate::rack::BRANCH_STREAM } else { crate::rack::BRANCH_LOCAL };
                                ctl.params.rack.set_branch_in(br, !ride_bypass, !limiter_bypass);
                                ctl.params_changed();
                            }
                            AudioCmd::SetProcessorParams { branch, target_lufs, ceiling_dbtp, release_ms, ride_rate_db_s, ride_clamp_db } => {
                                // SLICE 4 — the legacy numbers command edits the rack's ride and limiter slots,
                                // through the same edge clamps (rack.rs) it has always applied.
                                let br = if branch == 1 { crate::rack::BRANCH_STREAM } else { crate::rack::BRANCH_LOCAL };
                                let r = &mut ctl.params.rack;
                                r.set_ride(br, crate::rack::clamp_ride(crate::rack::RideParams { target: target_lufs, rate: ride_rate_db_s, clamp: ride_clamp_db }));
                                r.set_limiter(br, crate::rack::clamp_limiter(crate::rack::LimiterParams { ceiling: ceiling_dbtp, release: release_ms }));
                                ctl.params_changed();
                            }
                            AudioCmd::SetProcessing { local, stream, target_lufs } => {
                                let p = &mut ctl.params;
                                p.proc_local  = local;
                                p.proc_stream = stream;
                                let (mut ride, _) = p.rack.ride(crate::rack::BRANCH_LOCAL);
                                ride.target = target_lufs;
                                p.rack.set_ride(crate::rack::BRANCH_LOCAL, crate::rack::clamp_ride(ride));
                                ctl.params_changed();
                            }
                            AudioCmd::SetMicInput { slot, device, channel, gain_db } => {
                                // Opening a device happens HERE (dispatch thread) — never on the audio thread.
                                // Only source slots carry a mic (lib.rs refuses A/B/C/CART before this).
                                // A mic patched onto the Link's slot replaces the Link (one patch per fader).
                                if !device.is_empty() && links.is_live(slot) {
                                    links.set(slot, "", None, &mut mic_out);
                                    apply_mic_actions(&mut ctl, &mut mic_out);
                                }
                                mics.set(slot, device, channel, gain_db, std::time::Instant::now(), &mut mic_out);
                                apply_mic_actions(&mut ctl, &mut mic_out);
                            }
                            AudioCmd::SetLinkInput { slot, slot_name, cfg } => {
                                // The Link replaces a mic on the same slot (one patch per fader).
                                if cfg.is_some() && mics.is_live(slot) {
                                    mics.set(slot, String::new(), 0, 0.0, std::time::Instant::now(), &mut mic_out);
                                    apply_mic_actions(&mut ctl, &mut mic_out);
                                }
                                links.set(slot, &slot_name, cfg, &mut mic_out);
                                apply_mic_actions(&mut ctl, &mut mic_out);
                            }
                            AudioCmd::SetLinkSend(cfg) => {
                                // Stop first (drops the thread; the callback's tap is replaced below).
                                _link_sender = None;
                                match cfg {
                                    None => { ctl.enqueue(RtCmd::LinkTap(None)); }
                                    Some(c) => {
                                        let (tap, cons, tsh) = crate::linknet::tap();
                                        match crate::linknet::start_sender(station_id, c, cons, tsh) {
                                            Ok(s) => { _link_sender = Some(s); ctl.enqueue(RtCmd::LinkTap(Some(tap))); }
                                            Err(e) => {
                                                eprintln!("[LINK] Station {} SEND TO refused: {}", station_id, e);
                                                crate::linknet::refuse_send(station_id, &e);
                                                ctl.enqueue(RtCmd::LinkTap(None));
                                            }
                                        }
                                    }
                                }
                            }
                            AudioCmd::SetChannelRack { slot, rack } => {
                                // SLICE 5 — the coefficients are computed HERE (dispatch thread, f64) and ride the
                                // Params block; the callback adopts them by version and crossfades.
                                if slot < SLOT_COUNT {
                                    crate::show::set_channel_rack(&mut ctl.params, slot, rack, PROGRAM_RATE as f64);
                                    ctl.params_changed();
                                }
                            }
                            AudioCmd::ApplyShow(show) => {
                                // SLICE 7 — the whole Take in ONE block (docs/dsp-show-presets.md §3.4). Which channels
                                // are in it is the blade's live rule; this arm applies exactly what it was given.
                                show.apply(&mut ctl.params, PROGRAM_RATE as f64);
                                ctl.params_changed();
                            }
                            AudioCmd::SetRta(t) => {
                                ctl.params.rta = t;
                                ctl.params_changed();
                            }
                            AudioCmd::SetMasterRack(new_rack) => {
                                // SLICE 4 — the whole master rack (already parsed and clamped in rack.rs). The
                                // live-only bypasses are kept as the engine is running them; the GEQ's
                                // coefficient version moves only if its bands actually changed.
                                crate::show::set_master_rack(&mut ctl.params, new_rack);
                                ctl.params_changed();
                            }
                            AudioCmd::Ping
                            | AudioCmd::StartStream { .. }
                            | AudioCmd::StopStream
                            | AudioCmd::UpdateMetadata { .. } => {}
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break 'outer,
                }
            }
            // stream drops here → cpal callback stops → device released
            watch.stream_closed();
        }
    });

    (tx, is_playing, levels, finished, tcp_port, delay, meters_handle)
}

// ── Helpers called from start_station_mixer ───────────────────────────────────

/// S3 — what the dispatch thread knows about a deck that the callback does not need to hold.
#[derive(Default)]
pub(crate) struct DeckShadow {
    pub path: String,
    pub title: String,
    pub artist: String,
    pub gain_db: f32,
    /// What the last source-changing message (Load / Stop / Play-with-reload) left this deck holding…
    pub src_expected: bool,
    /// …and that message's sequence number. Until the callback has applied it, `src_expected` is the
    /// answer; after, the callback's own src_gen is (it also reflects natural ends).
    pub src_msg_seq: u64,
}

/// S3 — the dispatch thread's end of the station: the authoritative parameter block, the deck shadow,
/// the ordered outbox to the callback, the garbage it frees and the meters it reads. Owned by the
/// dispatch thread alone; nothing here is shared with the callback except through rt.rs channels.
pub(crate) struct Control {
    cmd: HeapProd<RtCmd>,
    /// Ordered overflow for when the ring is full: a command is delayed, never dropped or reordered.
    pending: std::collections::VecDeque<RtCmd>,
    /// Sequence number of the last command enqueued (FIFO ⇒ the callback applied #k iff applied_seq ≥ k).
    seq: u64,
    pub params: Params,
    garbage: HeapCons<Garbage>,
    /// Shared with audio_get_meters (MetersHandle). Only non-audio threads lock it.
    pub meter: Arc<Mutex<TripleReader<MeterFrame>>>,
    shared: Arc<RtShared>,
    pub decks: [DeckShadow; SLOT_COUNT],
    gen: u64,
    pub aux_frames: Arc<AtomicU64>,
    /// S4 — one decode worker per deck slot (Jeff's ruling 2), fed Feeders over its channel.
    workers: Vec<std::sync::mpsc::Sender<Feeder>>,
    /// S6 — the station's callback health counters, read for GetLevel.
    pub counters: Arc<RtCounters>,
    /// SLICE 3 — the station's loudness frame: GetLevel fills the legacy OUT fields from the MEASUREMENT.
    pub loud: Option<LoudReader>,
}
impl Control {
    pub(crate) fn new(bus: &BusState, cmd: HeapProd<RtCmd>, garbage: HeapCons<Garbage>,
                      meter: Arc<Mutex<TripleReader<MeterFrame>>>, shared: Arc<RtShared>, aux_frames: Arc<AtomicU64>,
                      station_id: u32, counters: Arc<RtCounters>) -> Self {
        let workers = (0..SLOT_COUNT).map(|i| {
            let (tx, rx) = std::sync::mpsc::channel::<Feeder>();
            let _ = std::thread::Builder::new()
                .name(format!("ether-decode-s{}-{}", station_id, i))
                .spawn(move || deck_worker(rx));
            tx
        }).collect();
        Control {
            cmd, pending: std::collections::VecDeque::new(), seq: 0, params: bus.params(),
            garbage, meter, shared, decks: std::array::from_fn(|_| DeckShadow::default()), gen: 0, aux_frames,
            workers, counters, loud: None,
        }
    }
    /// Turn a decoder into a deck feed: PREFILL its ring to the refill mark here (1.5 s, on this thread —
    /// so a Play that follows never starts on an empty ring), then hand the decoder to the slot's worker to
    /// keep it topped up. The returned feed goes to the callback in a Load/Play command.
    pub(crate) fn feed_for(&mut self, slot: usize, src: DeckSource) -> DeckFeed {
        let (feed, mut feeder) = deck_feed(src);
        feeder.fill(DECK_REFILL_BELOW);
        if let Some(w) = self.workers.get(slot) { let _ = w.send(feeder); }
        feed
    }
    pub(crate) fn next_gen(&mut self) -> u64 { self.gen = self.gen.wrapping_add(1).max(1); self.gen }
    /// Queue a command; returns its sequence number.
    pub(crate) fn enqueue(&mut self, c: RtCmd) -> u64 {
        self.pending.push_back(c);
        self.seq += 1;
        self.seq
    }
    /// The parameter block changed. Coalesced: if the newest queued command is already a block that has
    /// not left, it is updated in place — order with deck commands is preserved, and a slider drag cannot
    /// fill the ring.
    pub(crate) fn params_changed(&mut self) {
        if let Some(RtCmd::Params(b)) = self.pending.back_mut() { **b = self.params; return; }
        let b = Box::new(self.params);
        self.enqueue(RtCmd::Params(b));
    }
    /// Hand the callback everything that fits, in order.
    pub(crate) fn flush(&mut self) {
        while let Some(c) = self.pending.pop_front() {
            if let Err(c) = self.cmd.try_push(c) { self.pending.push_front(c); break; }
        }
    }
    /// Free what the callback replaced.
    pub(crate) fn drain_garbage(&mut self) {
        while let Some(g) = self.garbage.try_pop() { drop(g); }
    }
    /// Does deck `idx` hold a source? See DeckShadow::src_msg_seq.
    pub(crate) fn present(&self, idx: usize) -> bool {
        let d = &self.decks[idx];
        if d.src_msg_seq > self.shared.applied_seq.load(Ordering::Acquire) { d.src_expected }
        else { self.shared.src_gen[idx].load(Ordering::Acquire) != 0 }
    }
}

/// THE MIC — install a live feed on a slot (one RtCmd: Play with the feed as its reload, so it is loaded and
/// running in the same buffer), or empty the slot when the mic is unpatched. The deck shadow is kept honest
/// (no path: restore_decks_after_switch never touches a live slot).
fn apply_mic_actions(ctl: &mut Control, out: &mut Vec<crate::micin::MicAction>) {
    for a in out.drain(..) {
        match a {
            crate::micin::MicAction::Install(idx, feed) => {
                let gen = ctl.next_gen();
                let seq = ctl.enqueue(RtCmd::Play { slot: idx as u8, reload: Some(feed), gen });
                let d = &mut ctl.decks[idx];
                d.path = String::new();
                d.src_expected = true;
                d.src_msg_seq = seq;
            }
            crate::micin::MicAction::Release(idx) => {
                let seq = ctl.enqueue(RtCmd::Stop { slot: idx as u8 });
                let d = &mut ctl.decks[idx];
                d.path = String::new();
                d.src_expected = false;
                d.src_msg_seq = seq;
            }
        }
    }
}

/// S2 — log what the callback reported. Runs on the dispatch thread, never the audio thread. The text is
/// the callback's old eprintln! verbatim, so log readers (audiod/daemon-log.js, diagnostics) are unaffected.
fn drain_rt_events(station_id: u32, cons: &mut ringbuf::HeapCons<RtEvent>) {
    // Underruns are coalesced per deck per drain (≤ 50 ms), so a stalled disk writes one line per deck per
    // drain, not one per buffer. Every one is still counted exactly in Scratch::underruns (S6 publishes it).
    let mut ur: [(u32, u64); SLOT_COUNT] = [(0, 0); SLOT_COUNT];
    while let Some(ev) = cons.try_pop() {
        match ev {
            RtEvent::DeckFinished { slot } => {
                eprintln!("[RUST] Deck {} finished (source exhausted)", deck_finished_key(slot as usize));
            }
            RtEvent::Underrun { slot, frames } => {
                let e = &mut ur[slot as usize % SLOT_COUNT];
                e.0 += 1;
                e.1 += frames as u64;
            }
        }
    }
    for (i, (n, frames)) in ur.iter().enumerate() {
        if *n > 0 {
            eprintln!("[RUST] Station {} deck {} UNDERRUN: {} buffer(s), {} frames of silence — decode worker late (position held, track NOT ended)",
                      station_id, deck_finished_key(i), n, frames);
        }
    }
}

/// SLICE 1 SOAK — a DEV-ONLY buffer-size override for the real-time soak (Jeff's ruling 5: an env var,
/// not an operator setting; it shapes no sound). Unset — the only state a shipped install is ever in —
/// returns BufferSize::Default exactly as before.
///   ETHER_SOAK_BUFFER_FRAMES=min  → the smallest period the device reports it supports
///   ETHER_SOAK_BUFFER_FRAMES=<n>  → exactly n frames
/// Logged every time it applies, so a soak log states what it actually ran at.
fn soak_buffer_size(station_id: u32, device: &cpal::Device) -> cpal::BufferSize {
    use cpal::traits::DeviceTrait;
    let Ok(v) = std::env::var("ETHER_SOAK_BUFFER_FRAMES") else { return cpal::BufferSize::Default };
    let v = v.trim().to_ascii_lowercase();
    let supported = device.default_output_config().ok().map(|c| c.buffer_size().clone());
    let frames = if v == "min" {
        match supported {
            Some(cpal::SupportedBufferSize::Range { min, .. }) => Some(min),
            _ => None,
        }
    } else { v.parse::<u32>().ok() };
    match frames {
        Some(n) if n > 0 => {
            eprintln!("[RUST] Station {} SOAK: fixed device buffer {} frames (ETHER_SOAK_BUFFER_FRAMES={}; device reports {:?})",
                      station_id, n, v, supported);
            cpal::BufferSize::Fixed(n)
        }
        _ => {
            eprintln!("[RUST] Station {} SOAK: ETHER_SOAK_BUFFER_FRAMES={} not usable (device reports {:?}) — using the default buffer",
                      station_id, v, supported);
            cpal::BufferSize::Default
        }
    }
}

fn open_output_device(
    station_id: u32,
    device_name: &Option<String>,
) -> Option<(cpal::Device, u32, u16)> {
    use cpal::traits::{DeviceTrait, HostTrait};
    let default_dev = || cpal::default_host().default_output_device();
    let device = if let Some(ref name) = device_name {
        let found = cpal::available_hosts().into_iter().find_map(|host_id| {
            let host = cpal::host_from_id(host_id).ok()?;
            host.output_devices().ok()?.find(|d| {
                d.name().ok().as_deref() == Some(name.as_str())
            })
        });
        found.or_else(default_dev)
    } else {
        default_dev()
    }?;

    let cfg = device.default_output_config().ok()?;
    let sr  = cfg.sample_rate().0;
    let ch  = cfg.channels().min(2).max(1);
    eprintln!("[RUST] Station {} device: {} ({}Hz {}ch)",
        station_id, device.name().unwrap_or_default(), sr, ch);
    Some((device, sr, ch))
}

/// Open a SPECIFICALLY NAMED output device. Unlike open_output_device this NEVER falls back to the
/// system default: the aux monitor bus must only ever reach a device the operator chose. "No device
/// picked" has to mean silence, not "whatever was default" — on a broadcast machine the default could
/// be anything, including the very speakers feeding a mic.
// ── PFL CUE OUTPUT — its status, per station (docs/dsp-pfl-2026-09-26.md "PFL output device") ───────────────
// What the operator chose (`req`, "" = same as the main output), where it stands (`state`), and proof of flow
// (`frames`). Read by audio_cue_state and the meters frame; written by the monitor-output thread.
pub(crate) const CUE_SAME_AS_MAIN: u8 = 0;
pub(crate) const CUE_OPENING: u8 = 1;
pub(crate) const CUE_OPEN: u8 = 2;
pub(crate) const CUE_NOT_FOUND: u8 = 3;
pub(crate) const CUE_FAILED: u8 = 4;
pub(crate) struct CueStatus {
    pub req: Arc<Mutex<String>>,
    pub state: std::sync::atomic::AtomicU8,
    pub frames: Arc<AtomicU64>,
    pub rate: std::sync::atomic::AtomicU32,
}
static CUE_STATUS: std::sync::OnceLock<Mutex<HashMap<u32, Arc<CueStatus>>>> = std::sync::OnceLock::new();
pub(crate) fn cue_status(station_id: u32) -> Arc<CueStatus> {
    let m = CUE_STATUS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut g = m.lock().unwrap_or_else(|e| e.into_inner());
    g.entry(station_id).or_insert_with(|| Arc::new(CueStatus {
        req: Arc::new(Mutex::new(String::new())), state: std::sync::atomic::AtomicU8::new(CUE_SAME_AS_MAIN),
        frames: Arc::new(AtomicU64::new(0)), rate: std::sync::atomic::AtomicU32::new(0),
    })).clone()
}
pub(crate) fn cue_state_name(v: u8) -> &'static str {
    match v { CUE_SAME_AS_MAIN => "same_as_main", CUE_OPENING => "opening", CUE_OPEN => "open", CUE_NOT_FOUND => "not_found", _ => "failed" }
}

/// One monitor output on its OWN device — the AUX monitor, or the PFL cue. The device-open path the AUX monitor
/// has always had, generalised so the cue reuses it exactly (open by the chosen name, no fallback, slow retry,
/// consumer-side drift correction, underrun decays to silence).
struct MonOut {
    label: &'static str,
    tag: &'static str,
    req: Arc<Mutex<String>>,
    frames: Arc<AtomicU64>,
    status: Option<Arc<CueStatus>>,
    attach: fn(HeapProd<f32>) -> AuxCmd,
    detach: fn() -> AuxCmd,
    open_name: String,
    stream: Option<cpal::Stream>,
    retry_at: Option<std::time::Instant>,
}
impl MonOut {
    fn new(label: &'static str, tag: &'static str, req: Arc<Mutex<String>>, frames: Arc<AtomicU64>, status: Option<Arc<CueStatus>>,
           attach: fn(HeapProd<f32>) -> AuxCmd, detach: fn() -> AuxCmd) -> MonOut {
        MonOut { label, tag, req, frames, status, attach, detach, open_name: String::new(), stream: None, retry_at: None }
    }
    fn set_state(&self, v: u8) { if let Some(s) = &self.status { s.state.store(v, Ordering::Relaxed); } }
    fn service(&mut self, station_id: u32, send: &mut dyn FnMut(AuxCmd)) {
        use cpal::traits::{DeviceTrait, StreamTrait};
        let want = self.req.lock().map(|r| r.clone()).unwrap_or_default();
        // A REQUESTED-BUT-ABSENT device is a normal state, not an error to hammer: the operator may have picked
        // headphones that are currently unplugged. Retry slowly and log once.
        let retry_due = self.retry_at.map(|t| std::time::Instant::now() >= t).unwrap_or(false);
        if !(want != self.open_name || (retry_due && !want.is_empty() && self.stream.is_none())) { return; }
        // Tear down first, always: clearing the producer stops the mixer writing before the stream that
        // drains it goes away.
        let changed = want != self.open_name;
        send((self.detach)());
        if self.stream.is_some() || (changed && !self.open_name.is_empty()) {
            eprintln!("[RUST] Station {} {} output closed", station_id, self.label);
        }
        self.stream = None;
        self.open_name = want.clone();
        self.retry_at = None;
        if self.open_name.is_empty() {
            self.set_state(CUE_SAME_AS_MAIN);
            if changed { eprintln!("[RUST] Station {} {} output closed (no device selected)", station_id, self.label); }
            return;
        }
        self.set_state(CUE_OPENING);
        let Some((device, sr, ch)) = open_named_output_device(station_id, &self.open_name) else {
            // NO FALLBACK. A named device that is not present stays unopened and the bus stays silent.
            // Substituting a different output for the operator is the unsafe behaviour this path exists to avoid.
            if changed { eprintln!("[RUST] Station {} {} device not found: {:?} — staying silent (will retry)", station_id, self.label, self.open_name); }
            self.set_state(CUE_NOT_FOUND);
            self.retry_at = Some(std::time::Instant::now() + std::time::Duration::from_secs(5));
            return;
        };
        let rb = HeapRb::<f32>::new(AUX_BUS_BUF);
        let (prod, mut cons) = rb.split();
        send((self.attach)(prod));
        let frames_ctr = self.frames.clone();
        let cfg = cpal::StreamConfig { channels: ch, sample_rate: cpal::SampleRate(sr), buffer_size: cpal::BufferSize::Default };
        let mut phase: f64 = 0.0;
        let base_step: f64 = PROGRAM_RATE as f64 / sr as f64;
        let mut cur = (0.0f32, 0.0f32);
        let mut nxt = (0.0f32, 0.0f32);
        let mut primed = false;
        // Target ring fill (stereo samples). The two device clocks never agree exactly, so SOMETHING has to absorb
        // the difference; nudging the resample ratio by a fraction of a percent does it inaudibly.
        let target_fill: f64 = (sr as f64 * 0.04 * 2.0).max(256.0); // ~40 ms
        let tag = self.tag;
        let built = device.build_output_stream::<f32, _, _>(
            &cfg,
            move |data: &mut [f32], _| {
                let _rt = RtScope::enter();   // S6 — trap scope (no-op in release)
                let _ftz = FtzScope::enter(); // S7 — denormals flushed (the underrun decay below generates them)
                let frames = data.len() / ch as usize;
                if !primed {
                    let a = cons.try_pop().and_then(|l| cons.try_pop().map(|r| (l, r)));
                    let b = cons.try_pop().and_then(|l| cons.try_pop().map(|r| (l, r)));
                    match (a, b) {
                        (Some(x), Some(y)) => { cur = x; nxt = y; primed = true; }
                        _ => { data.iter_mut().for_each(|x| *x = 0.0); return; }
                    }
                }
                // DRIFT CORRECTION, not sample dropping: nudge the resample ratio by at most ±0.3% toward the
                // target fill — well under the ~1% where pitch shift becomes audible.
                let fill = cons.occupied_len() as f64;
                let err = (fill - target_fill) / target_fill;
                let step = base_step * (1.0 + err.clamp(-1.0, 1.0) * 0.003);
                for f in 0..frames {
                    while phase >= 1.0 {
                        cur = nxt;
                        nxt = match cons.try_pop() {
                            Some(l) => (l, cons.try_pop().unwrap_or(l)),
                            // UNDERRUN: fade toward silence instead of stepping to zero (a step is a click).
                            None => (cur.0 * 0.5, cur.1 * 0.5),
                        };
                        phase -= 1.0;
                    }
                    let t = phase as f32;
                    let l = cur.0 + (nxt.0 - cur.0) * t;
                    let r = cur.1 + (nxt.1 - cur.1) * t;
                    if ch == 2 { data[f * 2] = l; data[f * 2 + 1] = r; } else { data[f] = (l + r) * 0.5; }
                    phase += step;
                }
                // Proof of flow, not merely of opening.
                frames_ctr.fetch_add(frames as u64, Ordering::Relaxed);
            },
            move |err| eprintln!("[cpal {}] {}", tag, err),
            None,
        );
        match built {
            Ok(st) => {
                if let Err(e) = st.play() {
                    eprintln!("[RUST] Station {} {} stream.play(): {}", station_id, self.label, e);
                    send((self.detach)());
                    self.set_state(CUE_FAILED);
                    self.retry_at = Some(std::time::Instant::now() + std::time::Duration::from_secs(5));
                } else {
                    eprintln!("[RUST] Station {} {} output opened ({}Hz {}ch)", station_id, self.label, sr, ch);
                    if let Some(s) = &self.status { s.rate.store(sr, Ordering::Relaxed); }
                    self.set_state(CUE_OPEN);
                    self.stream = Some(st);
                }
            }
            Err(e) => {
                eprintln!("[RUST] Station {} {} build_output_stream: {}", station_id, self.label, e);
                send((self.detach)());
                self.set_state(CUE_FAILED);
                self.retry_at = Some(std::time::Instant::now() + std::time::Duration::from_secs(5));
            }
        }
    }
}

fn open_named_output_device(station_id: u32, name: &str) -> Option<(cpal::Device, u32, u16)> {
    use cpal::traits::{DeviceTrait, HostTrait};
    let device = cpal::available_hosts().into_iter().find_map(|host_id| {
        let host = cpal::host_from_id(host_id).ok()?;
        host.output_devices().ok()?.find(|d| d.name().ok().as_deref() == Some(name))
    })?;
    let cfg = device.default_output_config().ok()?;
    let sr  = cfg.sample_rate().0;
    let ch  = cfg.channels().min(2).max(1);
    eprintln!("[RUST] Station {} AUX monitor device: {} ({}Hz {}ch)", station_id, name, sr, ch);
    Some((device, sr, ch))
}

pub(crate) fn build_source(
    file_path: &str,
    _sample_rate: u32,
) -> Option<Box<dyn Iterator<Item = f32> + Send>> {
    use rodio::source::UniformSourceIterator;
    use rodio::Source;
    use std::fs::File;
    use std::io::BufReader;
    let file    = File::open(file_path).ok()?;
    let decoder = rodio::Decoder::new(BufReader::new(file)).ok()?;
    // Always resample to PROGRAM_RATE so ring buffer → ffmpeg is always 44100 Hz.
    // The cpal callback resamples to device rate separately for hardware output.
    let norm    = UniformSourceIterator::<_, f32>::new(
        decoder.convert_samples::<f32>(), 2, PROGRAM_RATE,
    );
    Some(Box::new(norm))
}

fn restore_decks_after_switch(bus_cmd: &SharedBusState, sr: u32, ctl: &mut Control) {
    // Re-create decoders for decks that had a path but lost their source
    // when the device was switched (source was consumed up to the switch point
    // and needs to restart). Acceptable limitation: track restarts from beginning.
    // S3: runs with NO callback alive (before the stream is built), so the lock is uncontended; the paths
    // come from the dispatch thread's shadow, since the callback no longer holds strings.
    let paths: Vec<(usize, String)> = ctl.decks.iter().enumerate()
        .filter(|(_, d)| !d.path.is_empty())
        .map(|(i, d)| (i, d.path.clone()))
        .collect();

    for (idx, path) in paths {
        let needed = bus_cmd.lock().map(|b| b.decks[idx].source.is_none() && b.decks[idx].active).unwrap_or(false);
        if !needed { continue; }
        if let Some(d) = build_source(&path, sr) {
            let src = ctl.feed_for(idx, d);
            if let Ok(mut bus) = bus_cmd.lock() {
                // Only replace if the source is gone (e.g. after a device failover mid-track)
                if bus.decks[idx].source.is_none() && bus.decks[idx].active {
                    bus.decks[idx].source = Some(src);
                    // SAMPLE CLOCK — the rebuilt decoder starts at the TOP of the file (see this
                    // function's header: "track restarts from beginning"), so the position must
                    // restart with it. The jump to 0:00 on a card switch is real; show it.
                    bus.decks[idx].frames_played = 0;
                    // The FADER LEVEL survives a device failover untouched — only the jock's hand moves it.
                    let g = ctl.next_gen();
                    bus.shared.src_gen[idx].store(g, Ordering::Release);
                }
            }
        }
    }
}

// No global audio state (DESIGN-TRUTH §2): per-station liveness lives in STATION_CB_MS
// (above); the program-bus stream-client flag is per-station on BusState.stream_connected.

/// SLICE 1 S1 — the largest buffer the callback will process, in PROGRAM_RATE frames. 32 768 frames is
/// 743 ms at 44.1 kHz: more than 70× WASAPI's shared-mode default and above any device period seen in the
/// field. A device asking for more is COUNTED (Scratch::buffer_clamped) and gets silence for that buffer;
/// the lanes are never grown on the audio thread. docs/dsp-rt-callback.md §2.
pub(crate) const MAX_PROG_FRAMES: usize = 32_768;

/// SLICE 1 S2 — what the callback has to SAY, sent instead of printed. The audio thread never writes to
/// stderr (a lock + a syscall); it pushes one of these onto a preallocated lock-free queue, and the
/// station's dispatch thread drains it every ≤ 50 ms and does the logging there — with the same text
/// the callback used to print, so nothing that greps the log changes. docs/dsp-rt-callback.md §3.
#[derive(Clone, Copy, Debug)]
pub(crate) enum RtEvent {
    /// A deck's source ran out naturally (the finished FLAG is still set in the callback, lock-free).
    DeckFinished { slot: u8 },
    /// S4 — a deck's ring ran dry BEFORE end of file: its decode worker is late. That deck played `frames`
    /// frames of silence this buffer; its position did not advance and nothing reported an ending.
    Underrun { slot: u8, frames: u32 },
}
/// Events one device-open's queue holds. A full queue is counted (Scratch::events_dropped), never blocks.
pub(crate) const RT_EVENT_QUEUE: usize = 256;

/// SLICE 1 S1 — every per-buffer working buffer of mixer_callback, allocated ONCE (on the thread that opens
/// the device, or by a test), then only ever sliced and overwritten. This replaces the 16 `vec!` lanes, the
/// EQ-out Vecs, the master-fader / clean-tap / room `collect()`s and the per-branch `clone()`s that the
/// callback used to allocate on every buffer (docs/dsp-inventory.md §6.1). Box<[f32]> rather than Vec so
/// that growing one is not expressible.
pub(crate) struct Scratch {
    mix_l: Box<[f32]>, mix_r: Box<[f32]>,
    room_l: Box<[f32]>, room_r: Box<[f32]>,
    imm_room_l: Box<[f32]>, imm_room_r: Box<[f32]>,
    core_l: Box<[f32]>, core_r: Box<[f32]>,
    aux_l: Box<[f32]>, aux_r: Box<[f32]>,
    src_l: Box<[f32]>, src_r: Box<[f32]>,
    imm_l: Box<[f32]>, imm_r: Box<[f32]>,
    det_l: Box<[f32]>, det_r: Box<[f32]>,
    out_l: Box<[f32]>, out_r: Box<[f32]>,            // post-EQ, post-master (the clean bus)
    loc_l: Box<[f32]>, loc_r: Box<[f32]>,            // LOCAL-branch processed
    str_l: Box<[f32]>, str_r: Box<[f32]>,            // STREAM-branch processed
    room_out_l: Box<[f32]>, room_out_r: Box<[f32]>,  // the room chain's output
    dev_l: Box<[f32]>, dev_r: Box<[f32]>,            // the clamped clean tap to the device
    rack_l: Box<[f32]>, rack_r: Box<[f32]>,          // SLICE 5 — one channel's post-trim frames through its rack
    cue_l: Box<[f32]>, cue_r: Box<[f32]>,            // PFL — the pre-fader, post-rack sum of every PFL'd channel
    pfl_l: Box<[f32]>, pfl_r: Box<[f32]>,            // PFL — the local output while PFL is on (dimmed programme + cue)
    feed: Box<[f32]>,                                // S4 — one deck's interleaved frames popped from its ring
    /// S6 — the station's health counters (underruns, lock misses, overruns, …). Shared with the station's
    /// BusState and every Scratch it opens, so a device reopen does not reset them.
    pub(crate) counters: Arc<RtCounters>,
    /// S2 — producer end of the event queue. None in tests and the offline harness (nobody listening);
    /// the live stream gets Some at device open.
    pub(crate) events: Option<ringbuf::HeapProd<RtEvent>>,
}
impl Scratch {
    pub(crate) fn new() -> Box<Scratch> { Scratch::with_counters(RtCounters::new()) }
    pub(crate) fn with_counters(counters: Arc<RtCounters>) -> Box<Scratch> {
        let lane = || vec![0f32; MAX_PROG_FRAMES].into_boxed_slice();
        Box::new(Scratch {
            mix_l: lane(), mix_r: lane(), room_l: lane(), room_r: lane(),
            imm_room_l: lane(), imm_room_r: lane(), core_l: lane(), core_r: lane(),
            aux_l: lane(), aux_r: lane(), src_l: lane(), src_r: lane(),
            imm_l: lane(), imm_r: lane(), det_l: lane(), det_r: lane(),
            out_l: lane(), out_r: lane(), loc_l: lane(), loc_r: lane(),
            str_l: lane(), str_r: lane(), room_out_l: lane(), room_out_r: lane(),
            dev_l: lane(), dev_r: lane(), rack_l: lane(), rack_r: lane(),
            cue_l: lane(), cue_r: lane(), pfl_l: lane(), pfl_r: lane(),
            feed: vec![0f32; MAX_PROG_FRAMES * 2].into_boxed_slice(),
            counters,
            events: None,
        })
    }
}

pub(crate) fn mixer_callback(
    data:    &mut [f32],
    ch:      u16,
    bus_arc: &SharedBusState,
    fin:     &FinishedFlags,
    playing: &AtomicBool,
    sc:      &mut Scratch,
) {
    // S6 — the allocation trap's scope (a no-op in the shipped release): any allocation or free on this
    // thread until this returns is counted, and the tests assert the count is zero.
    let _rt = RtScope::enter();
    // S7 — flush denormals for this callback, restore the thread's float mode on return (rt.rs FtzScope).
    let _ftz = FtzScope::enter();

    let device_frames = data.len() / ch as usize;
    if device_frames == 0 { return; }

    let mut bus = match bus_arc.try_lock() {
        Ok(b)  => b,
        // S6 — COUNTED. Since S3 only this callback (and device open/switch, while no callback runs) locks
        // the state, so this cannot happen; the counter is how "cannot" is checked rather than assumed.
        Err(_) => { RtCounters::bump(&sc.counters.lock_misses, 1); data.iter_mut().for_each(|s| *s = 0.0); return; }
    };

    // S3 — adopt queued parameter blocks and deck commands BEFORE anything reads them. The whole buffer
    // then runs on this one state; a block that arrives meanwhile waits for the next buffer.
    bus.apply_commands();
    // SLICE 8 — tell the RTA's meter thread which target this buffer serves (a store only when it changes).
    let rta_t = bus.rta_target;
    bus.rta.serve(rta_t);
    let rta_slot = match rta_t { crate::rta::RtaTarget::Channel(s) => Some(s as usize), _ => None };
    // SLICE 2 — the reader has consumed the current meter window: start the next one (one Acquire load).
    if bus.shared.meter_ack.load(Ordering::Acquire) >= bus.meters_acc.epoch {
        let e = bus.meters_acc.epoch + 1;
        bus.meters_acc = MeterBlock { epoch: e, ..MeterBlock::default() };
    }

    let device_sr = bus.sample_rate;
    // How many PROGRAM_RATE (44100 Hz) frames cover this device buffer.
    // +2 is a rounding safety margin so we never under-read.
    let prog_frames = if device_sr == PROGRAM_RATE {
        device_frames
    } else {
        (device_frames as f64 * PROGRAM_RATE as f64 / device_sr as f64).ceil() as usize + 2
    };
    // S1 — the lanes are fixed-size. A buffer larger than they are is refused, counted and silent for
    // this one buffer; it is never serviced by growing a lane on the audio thread.
    if prog_frames > MAX_PROG_FRAMES {
        RtCounters::bump(&sc.counters.buffer_clamped, 1);
        data.iter_mut().for_each(|s| *s = 0.0);
        return;
    }
    let Scratch {
        mix_l, mix_r, room_l, room_r, imm_room_l, imm_room_r, core_l, core_r, aux_l, aux_r,
        src_l, src_r, imm_l, imm_r, det_l, det_r, out_l, out_r, loc_l, loc_r, str_l, str_r,
        room_out_l, room_out_r, dev_l, dev_r, rack_l, rack_r, cue_l, cue_r, pfl_l, pfl_r, feed, counters, events,
    } = sc;
    let counters: &RtCounters = counters;
    // PFL — is any channel's PFL on this buffer? (the block adopted at the top of the buffer). The cue lanes are
    // touched only then, so a buffer with no PFL does no extra work at all.
    let pfl_any = bus.pfl.iter().any(|&b| b);
    if pfl_any { cue_l[..prog_frames].fill(0.0); cue_r[..prog_frames].fill(0.0); }

    let mix_l = &mut mix_l[..prog_frames]; mix_l.fill(0.0);
    let mix_r = &mut mix_r[..prog_frames]; mix_r.fill(0.0);
    // ── ROOM vs AIR (2026-08-18) ─────────────────────────────────────────────────────────────────
    // core_* = every slot EXCEPT the aux decks — the room's programme base.
    // aux_*  = the aux decks a monitor slot has selected, PRE-CUT and PRE-FADER, at the slot level.
    // mix_*  = everything, unchanged — this is what airs.
    // Copied out before the &mut borrow of bus.decks below.
    let aux_gain = bus.aux_monitor_gain;
    let room_gain = bus.room_gain;
    // AIR and ROOM are accumulated separately from here. `core_*` is what airs and is NEVER scaled
    // by a monitor; `room_*` is the same slots at their per-slot room level. mix = core + src is
    // untouched, which is the property that keeps a monitor fader from ever reaching a listener.
    let room_l = &mut room_l[..prog_frames]; room_l.fill(0.0);
    let room_r = &mut room_r[..prog_frames]; room_r.fill(0.0);
    let imm_room_l = &mut imm_room_l[..prog_frames]; imm_room_l.fill(0.0);
    let imm_room_r = &mut imm_room_r[..prog_frames]; imm_room_r.fill(0.0);
    let core_l = &mut core_l[..prog_frames]; core_l.fill(0.0);
    let core_r = &mut core_r[..prog_frames]; core_r.fill(0.0);
    let aux_l  = &mut aux_l[..prog_frames]; aux_l.fill(0.0);
    let aux_r  = &mut aux_r[..prog_frames]; aux_r.fill(0.0);
    // DUCKER (slice 3): the source contribution AT AIR LEVEL, and the part of it that arms the duck.
    //   src_* — every Source slot, post-cut/post-fader. NOT scaled by the monitor gain: aux_* is the
    //           ROOM feed and is a different signal entirely.
    //   det_* — only the Source slots whose duck toggle is on. A channel with ducking off still
    //           airs, it just does not push the music down.
    // core_* is already the music: every slot EXCEPT the Source slots. So core + src == mix by
    // construction, which is what makes the duck-off path provably bit-identical below.
    let duck_enabled = bus.duck_enabled;
    let duck_duckable = bus.duck_duckable;
    let src_l = &mut src_l[..prog_frames]; src_l.fill(0.0);
    let src_r = &mut src_r[..prog_frames]; src_r.fill(0.0);
    // RECEIVER SIDE: the non-source music splits in two. `duckable` is what the duck multiplies;
    // `immune` punches through at full level. core = duckable + immune, rebuilt after the duck, so
    // the room and the air both read one already-correct sum. Excluding at the source rather than
    // adding immune back afterwards: the same cost, and it says what it does.
    let imm_l = &mut imm_l[..prog_frames]; imm_l.fill(0.0);
    let imm_r = &mut imm_r[..prog_frames]; imm_r.fill(0.0);
    let det_l = &mut det_l[..prog_frames]; det_l.fill(0.0);
    let det_r = &mut det_r[..prog_frames]; det_r.fill(0.0);
    let mut duck_armed = false;    // at least one duck-enabled Source slot is actually producing
    let mut aux_present = false;   // an aux deck is producing audio → the room must use core_*
    let mut any_playing = false;
    let mut exhausted   = [false; SLOT_COUNT];
    let mut frame_peaks = [0.0f32; SLOT_COUNT]; // this-buffer post-fader peak per deck
    // SLICE 2 — this buffer's PRE-FADER taps per channel (post-trim, pre-cut). On the stack; folded into
    // bus.meters_acc after the deck loop releases its borrow.
    let mut ch_meter = [MeterTap::default(); SLOT_COUNT];
    // SLICE 5 — this buffer's POST-RACK taps (after the channel's EQ, still pre-fader).
    let mut ch_post = [MeterTap::default(); SLOT_COUNT];
    // SLICE 6 — this buffer's per-channel dynamics taps.
    let mut ch_dyn = [crate::rt::DynTap::default(); SLOT_COUNT];
    // Disjoint borrows of the state for the deck loop: the decks, and the channel racks' DSP.
    let bs: &mut BusState = &mut *bus;

    for (i, deck) in bs.decks.iter_mut().enumerate() {
        // SLICE 7 — the fader ramp follows the adopted level; a channel making no sound snaps (nothing can click).
        bs.vol_ramp[i].follow(deck.volume, deck.active && !deck.paused && deck.source.is_some());
        if !deck.active || deck.paused { continue; }
        let Some(ref mut src) = deck.source else {
            // active=true but source=None is a stuck state — self-heal so GetLevel
            // stops generating fake levels and CPAL stops silently skipping the deck.
            deck.active = false;
            continue;
        };
        any_playing = true;
        // Two independent things, combined here and ONLY here:
        //
        //   CHANNEL CUT (deck.muted) — the door. Cut = no audio passes, exactly as if the fader were
        //     slammed to −inf, WITHOUT moving the fader. It never reads or writes the fader level, so
        //     the jock's level is still parked where they left it when the channel comes back.
        //   TRACK TRIM (deck.gain_db) — the file's own loudness trim, applied PRE-FADER so the fader
        //     rides an already-normalised signal. Clamped on its own (not on the product), so a trim
        //     can never act as a second fader.
        //   FADER LEVEL (deck.volume) — the jock's level. Written only by SetVolume.
        //
        // The source is still advanced below while cut, so a cut track runs out and its finished-flag
        // fires normally — cutting a channel must never strand a deck.
        // TRIM is computed unconditionally now: the aux monitor tap is PRE-CUT, so it still needs the
        // file's loudness trim even while the channel is cut. `vol` is unchanged — muted is still 0.0,
        // open is still volume x trim — so the AIR path is bit-identical.
        let trim = if deck.gain_db != 0.0 {
            10f32.powf(deck.gain_db / 20.0).clamp(0.1, 4.0)
        } else { 1.0 };
        let vol = if deck.muted { 0.0 } else { deck.volume * trim };
        // AUX decks are slots 3/4/5. `mon` is the ROOM level for this deck: the slot's own level,
        // taken PRE-CUT and PRE-FADER so the board's channel switch cannot silence the room —
        // "channel ON/OFF affects the stream, never the room path".
        // SLICE 1 — the rule now reads what the slot IS. Behaviour is unchanged for the shipped
        // layout (3/4/5 are Source, 0/1/2 Rotation, 6 Cart); the new 7.. channels are Source too,
        // and being inactive they reach this line only once something loads them.
        let is_aux = deck.kind == SlotKind::Source;
        // AUX MONITOR TAP — POST-FADER, POST-CUT (Jeff's ruling, 2026-08-18).
        //
        // `mon` is the SLOT level applied on top of `vol`, and `vol` is already 0 when the channel is
        // cut and follows the fader otherwise. So the board's fader and channel switch silence this
        // deck EVERYWHERE, monitor included.
        //
        // WHAT THIS REPLACES, AND WHY: the tap used to be `aux_gain[i] * trim` — independent of both
        // deck.volume and deck.muted. That was a true PFL, and it produced a source with no off
        // switch: fader down and channel off silenced air while the aux monitor kept playing at full
        // level, with nothing on the board able to stop it. The slot decides WHERE a deck is heard
        // locally and at what level; it never resurrects audio the board has killed.
        let mon = if is_aux { aux_gain[i] } else { 0.0 };
        // This slot's ROOM level. Rotation decks are pinned at unity by construction (nothing ever
        // writes room_gain for them), so A/B/C are bit-identical to before the split.
        let rg = room_gain[i];
        if is_aux { aux_present = true; }
        if is_aux && duck_enabled[i] { duck_armed = true; }
        let mut pk = 0.0f32;
        let mut pulled = 0u64;   // frames actually taken from THIS deck's source this buffer
        // S4 — pull this buffer's frames from the deck's RING (never the decoder). Interleaved stereo, always
        // whole frames. A short read is one of exactly two things, decided by the worker's EOF flag, which it
        // sets only after pushing its last sample (Release/Acquire):
        //   · EOF set   → the track ENDED here: drain what is left, then exhausted — the same frame the old
        //                 `src.next() == None` fired on;
        //   · EOF clear → an UNDERRUN: the worker is late. The frames we did not get are silence for THIS deck
        //                 only; they are not counted into its position, nothing ends, and it is counted +
        //                 reported (Scratch::underruns, RtEvent::Underrun). Never silent, never an ending.
        let want = prog_frames * 2;
        let mut got;
        let mut ended = false;
        if let Some(li) = src.live.as_mut() {
            // A LIVE input (the mic — docs/dsp-mic-in-engine.md): the resampling consumer fills every frame
            // (silence it could not supply is counted in its own MicShared counters, not as a file underrun),
            // and it never ends. From here on the slot is every other channel: meter, rack, fader, cut, duck.
            li.pull(&mut feed[..want], prog_frames);
            got = want;
        } else {
            got = src.cons.pop_slice(&mut feed[..want]);
            if got < want && src.eof.load(Ordering::Acquire) {
                got += src.cons.pop_slice(&mut feed[got..want]);
                ended = got < want;
            }
        }
        let take = got / 2;
        // SLICE 2 — PRE-FADER METER: the frames this deck actually supplied, × its trim, BEFORE the cut and
        // the fader. Reads `feed` only; the mix below is untouched. Pre-cut by ruling: a channel that is OFF
        // still shows its source.
        {
            let t = &mut ch_meter[i];
            let (mut pl, mut pr) = (t.peak[0], t.peak[1]);
            let (mut sl, mut sr) = (0.0f64, 0.0f64);
            for f in 0..take {
                let a = feed[2 * f] * trim;
                let b = feed[2 * f + 1] * trim;
                pl = pl.max(a.abs());
                pr = pr.max(b.abs());
                sl += (a as f64) * (a as f64);
                sr += (b as f64) * (b as f64);
            }
            t.peak = [pl, pr];
            t.sumsq[0] += sl;
            t.sumsq[1] += sr;
        }
        // SLICE 5 — THE CHANNEL RACK: post-trim, pre-fader, pre-duck (docs/dsp-channel-rack-eq.md §2).
        // A channel whose rack runs NOTHING (empty, every module OUT, no fade in progress) keeps today's exact
        // arithmetic below — `feed × (volume × trim)` — so every existing golden is bit-identical by construction.
        // Only a channel with a module IN takes `((feed × trim) → EQ) × fader`, which rounds differently: that is
        // the processing the operator asked for.
        let rack_on = bs.chdsp[i].active();
        let fader = if deck.muted { 0.0 } else { deck.volume };
        if rack_on {
            let (rl, rr) = (&mut rack_l[..take], &mut rack_r[..take]);
            for f in 0..take { rl[f] = feed[2 * f] * trim; rr[f] = feed[2 * f + 1] * trim; }
            bs.chdsp[i].process(rl, rr);
            ch_post[i].add(rl, rr);
            // SLICE 6 — this buffer's dynamics (the running chain's GR since the last take)
            let (gg, cg, open) = bs.chdsp[i].take_gr();
            ch_dyn[i].fold(gg, cg, open);
        } else {
            ch_post[i] = ch_meter[i];   // nothing ran: post-rack IS pre-rack
        }
        // PFL — this channel's PRE-FADER, PRE-CUT, POST-RACK signal (the processed sound, Jeff's ruling 3) into the
        // cue sum. It reaches ONLY the local output (below); never mix_*, so never air, stream or PGM.
        if pfl_any && bs.pfl[i] {
            let (cl, cr) = (&mut cue_l[..take], &mut cue_r[..take]);
            if rack_on { for f in 0..take { cl[f] += rack_l[f]; cr[f] += rack_r[f]; } }
            else { for f in 0..take { cl[f] += feed[2 * f] * trim; cr[f] += feed[2 * f + 1] * trim; } }
        }
        // SLICE 8 — THE RTA TAP, only for the ONE channel a rack view is listening to (rta.rs). Both lanes PRE-FADER
        // (Jeff's ruling 5): pre = the same samples the pre-fader meter reads; post = the rack's output (= pre when the
        // rack runs nothing). Read-only: the mix below is untouched.
        if rta_slot == Some(i) {
            let fd = &feed[..2 * take];
            if rack_on {
                let (rl, rr) = (&rack_l[..take], &rack_r[..take]);
                bs.rta.push(take, |f| (fd[2 * f] * trim, fd[2 * f + 1] * trim), |f| (rl[f], rr[f]));
            } else {
                bs.rta.push(take, |f| (fd[2 * f] * trim, fd[2 * f + 1] * trim), |f| (fd[2 * f] * trim, fd[2 * f + 1] * trim));
            }
        }
        // SLICE 7 — while the fader is ramping, its gain moves per frame (cut still wins: 0). At rest this is None and
        // the arithmetic below is exactly today's.
        let ramp = if bs.vol_ramp[i].ramping() { Some(bs.vol_ramp[i]) } else { None };
        for f in 0..take {
            {
                {
                    let (lv, rv) = if let Some(rp) = ramp {
                                       let g = if deck.muted { 0.0 } else { rp.at(f) };
                                       if rack_on { (rack_l[f] * g, rack_r[f] * g) }
                                       else { let gt = g * trim; (feed[2 * f] * gt, feed[2 * f + 1] * gt) }
                                   }
                                   else if rack_on { (rack_l[f] * fader, rack_r[f] * fader) }
                                   else { (feed[2 * f] * vol, feed[2 * f + 1] * vol) };
                    mix_l[f] += lv;                       // AIR — every slot, unchanged
                    mix_r[f] += rv;
                    if !is_aux {                          // programme base — aux decks excluded entirely
                        core_l[f] += lv;                  // AIR: never scaled by a monitor
                        core_r[f] += rv;
                        // ROOM: the same slot at its own room level. Unity for rotation decks, the
                        // operator's monitor row for a sweeper channel.
                        room_l[f] += lv * rg;
                        room_r[f] += rv * rg;
                        // ...and, of each, the part the duck may NOT touch.
                        if !duck_duckable[i] {
                            imm_l[f] += lv; imm_r[f] += rv;
                            imm_room_l[f] += lv * rg; imm_room_r[f] += rv * rg;
                        }
                    }
                    if is_aux {
                        // AIR-level source sum for the ducker (distinct from the room's aux_*).
                        src_l[f] += lv;
                        src_r[f] += rv;
                        if duck_enabled[i] { det_l[f] += lv; det_r[f] += rv; }
                    }
                    if is_aux && mon != 0.0 {             // AUX monitor — POST-fader, POST-cut
                        // lv/rv, NOT l/r: these are the samples after the channel cut and the fader,
                        // so a cut or a closed fader yields zero here as well as on air.
                        aux_l[f] += lv * mon;
                        aux_r[f] += rv * mon;
                    }
                    pulled += 1;
                    let a = lv.abs().max(rv.abs());
                    if a > pk { pk = a; }
                }
            }
        }
        if take < prog_frames {
            if ended {
                exhausted[i] = true;
            } else {
                let missing = (prog_frames - take) as u64;
                RtCounters::bump(&counters.underruns[i], 1);
                RtCounters::bump(&counters.underrun_frames[i], missing);
                if let Some(ev) = events.as_mut() {
                    if ev.try_push(RtEvent::Underrun { slot: i as u8, frames: missing as u32 }).is_err() {
                        RtCounters::bump(&counters.events_dropped, 1);
                    }
                }
            }
        }
        // SAMPLE CLOCK — committed once per buffer (the `src` borrow is dead here), not once per
        // frame: one add instead of ~44,100/sec/deck on the audio thread, same result.
        //
        // A CUT channel (deck.muted) still advances. The source is advanced while cut by design
        // (see the vol block above) so a cut track runs out on schedule — its position must run
        // out with it, or the countdown lies about a track that is genuinely ending.
        deck.frames_played = deck.frames_played.wrapping_add(pulled);
        frame_peaks[i] = pk;
        bs.vol_ramp[i].advance(prog_frames);
    }
    // SLICE 2 — fold this buffer's channel taps into the window.
    bus.meters_acc.frames += prog_frames as u64;
    for i in 0..SLOT_COUNT {
        let (a, t) = (&mut bus.meters_acc.ch[i], &ch_meter[i]);
        a.peak = [a.peak[0].max(t.peak[0]), a.peak[1].max(t.peak[1])];
        a.sumsq[0] += t.sumsq[0];
        a.sumsq[1] += t.sumsq[1];
        let (a, t) = (&mut bus.meters_acc.ch_post[i], &ch_post[i]);
        a.peak = [a.peak[0].max(t.peak[0]), a.peak[1].max(t.peak[1])];
        a.sumsq[0] += t.sumsq[0];
        a.sumsq[1] += t.sumsq[1];
        let (a, t) = (&mut bus.meters_acc.ch_dyn[i], &ch_dyn[i]);
        if t.runs > 0 {
            a.gate_gr = a.gate_gr.max(t.gate_gr);
            a.comp_gr = a.comp_gr.max(t.comp_gr);
            a.gate_open += t.gate_open;
            a.runs += t.runs;
        }
    }

    for (i, done) in exhausted.iter().enumerate() {
        if *done {
            // S3 — the spent decoder is freed on the dispatch thread, not here.
            if let Some(o) = bus.decks[i].source.take() { bus.discard(Garbage::Source(o)); }
            bus.shared.src_gen[i].store(0, Ordering::Release);
            bus.decks[i].active = false;
            // Slot 6 is the CART overlay channel and is NOT in DECK_LETTERS (len 6, A–F). Before this
            // guard, a CART source playing to NATURAL END (first done by the maiden jingle overlay, 2026-07-15)
            // ran `DECK_LETTERS[6]` → index-out-of-bounds panic on the cpal output thread → the thread died →
            // permanent dead air. Handle the CART slot by its own "CART" finished key (the same key
            // lib.rs takes as fin_cart), never index DECK_LETTERS. See docs/incident-jingle-cart-panic-2026-07-15.md.
            let key = deck_finished_key(i);
            fin.set(key);
            // S2 — logged by the dispatch thread, not here (see RtEvent). A full queue is counted.
            if let Some(ev) = events.as_mut() {
                if ev.try_push(RtEvent::DeckFinished { slot: i as u8 }).is_err() {
                    RtCounters::bump(&counters.events_dropped, 1);
                }
            }
        }
    }

    // Apply EQ to the 44100 Hz stereo mix
    // ── THE DUCKER (slice 3) ─────────────────────────────────────────────────────────────────────
    //
    // mix == core + src by construction (the loop adds every slot to mix, non-Source to core, Source
    // to src). So ducking is: rebuild mix as core*g + src. With g == 1.0 that is arithmetically the
    // same sum in the same order, and when no channel arms the ducker the rewrite is SKIPPED
    // ENTIRELY — the accumulated mix is passed through untouched, bit-identical. The golden
    // regression test depends on that skip, not on floating-point luck.
    //
    // WHY HERE:
    //   · BEFORE the EQ — bus.eq is one stateful biquad instance and must see exactly one stream.
    //     Splitting it to give the ride a music-only feed is the trap the aux-monitor design named.
    //   · ON THE MIX PATH, not inside ProgramProcessor — processing defaults OFF, so a duck living
    //     inside the processor would silently do nothing on a default install (§B.4). This runs
    //     whether or not the operator has ever turned processing on.
    //
    // The ride is FROZEN while the duck is down (§B.3a) so it cannot claw the music back up.
    // KEEP RUNNING WHILE STILL DOWN. duck_armed means "an armed source deck is active, unpaused and
    // holding a source THIS buffer" — and a jukebox drops all three between tracks. Snapping the gain
    // back to unity there threw the programme to full level with no release at all, every single
    // track change, which is heard as "the music rises while the source is still playing" (Jeff,
    // 2026-08-23). The gap is short; the HOLD exists precisely to ride through it.
    //
    // So the envelope also runs whenever the gain is still below unity: det_* is all zeros when
    // nothing is armed, so the detector simply reads silence and the normal hold-then-release path
    // takes it home at the operator's release time. Once it is fully back, and only then, the block
    // is skipped again and the mix is bit-identical.
    let duck_running = duck_armed || bus.duck_gain < 0.999;
    let duck_active = if duck_running {
        let fs_ms = PROGRAM_RATE as f32 / 1000.0;          // frames per millisecond
        let depth = 10f32.powf(bus.duck_depth_db / 20.0);  // linear floor
        let thr   = bus.duck_threshold;
        // One-pole coefficients from the millisecond settings. Computed per buffer (a few exp()),
        // never per sample.
        let atk = 1.0 - (-1.0 / (bus.duck_attack_ms.max(1.0) * fs_ms)).exp();
        let rel = 1.0 - (-1.0 / (bus.duck_release_ms.max(1.0) * fs_ms)).exp();
        let hold_ms = bus.duck_hold_ms.max(0.0);
        let ms_per_frame = 1000.0 / PROGRAM_RATE as f32;

        let mut g = bus.duck_gain;
        let mut hold_left = bus.duck_hold_left_ms;

        for f in 0..prog_frames {
            // Detector: peak of the ARMED source sum. Post-fader and post-cut already, so a closed
            // fader or a cut channel simply cannot duck — the board stays the gate.
            let s = det_l[f].abs().max(det_r[f].abs());
            if s > thr {
                // Signal present: pull down toward the floor and re-arm the full hold.
                g += (depth - g) * atk;
                hold_left = hold_ms;
            } else if hold_left > 0.0 {
                // Between words. Stay down — this is what stops the music fluttering up inside a
                // sentence, and it is the single parameter most worth tuning by ear.
                hold_left -= ms_per_frame;
            } else {
                g += (1.0 - g) * rel;
            }
            let gc = g.clamp(depth.min(1.0), 1.0);
            // DUCK THE MUSIC IN PLACE, then sum. Both buses then inherit it from ONE multiply.
            //
            // This is the fix for "the telemetry says -12 dB and the operator hears nothing"
            // (2026-08-23). The duck originally rewrote mix_* only — and mix_* is the AIR feed.
            // The ROOM feed is rebuilt further down from core_* whenever aux_present is true
            // (see room_owned), which is EXACTLY when a source is playing and the duck is engaged.
            // So the stream ducked perfectly and the studio monitor — the only thing the operator
            // was listening to — never did.
            //
            // Ducking core_* in place means the room's own EQ/master chain reads already-ducked
            // music, with no second gain to keep in step and no way for the two buses to disagree.
            // Duck only what the operator marked duckable. core currently holds duckable+immune,
            // so scaling the whole thing and adding back the immune share leaves exactly
            // duckable*gc + immune — one multiply, no third buffer, and immune audio is never
            // attenuated even for a sample.
            core_l[f] = core_l[f] * gc + imm_l[f] * (1.0 - gc);
            core_r[f] = core_r[f] * gc + imm_r[f] * (1.0 - gc);
            // The SAME duck on the room sum. If only one buffer were ducked, the studio and the
            // listener would disagree about whether the music stepped back — which is its own bug.
            room_l[f] = room_l[f] * gc + imm_room_l[f] * (1.0 - gc);
            room_r[f] = room_r[f] * gc + imm_room_r[f] * (1.0 - gc);
            mix_l[f] = core_l[f] + src_l[f];
            mix_r[f] = core_r[f] + src_r[f];
        }

        bus.duck_gain = g;
        bus.duck_hold_left_ms = hold_left;
        // "Ducking right now" for the ride hold and for telemetry. A hair below unity rather than
        // != 1.0, so a gain still trickling back up over the last dB does not read as ducked forever.
        g < 0.999
    } else {
        // Nothing armed AND the release has already finished — the mix is exactly what the loop
        // accumulated, nothing is rewritten, and nothing can drift. The gain is pinned to exactly
        // 1.0 here only because it is already within a thousandth of it; this is not a reset, and
        // there is no path that jumps the programme back to full level.
        bus.duck_gain = 1.0;
        bus.duck_hold_left_ms = 0.0;
        false
    };

    // ── THE AIR BUS IS BUILT UNCLAMPED ───────────────────────────────────────────────────────────
    //
    // These two lines used to be `.clamp(-1.0, 1.0)`, and a hard clamp IS A CLIPPER: the instant the
    // sum passed full scale it squared the waveform off and produced exactly the distortion it was
    // meant to prevent. Worse, it sat UPSTREAM of the processor, so the -1 dBTP limiter never saw the
    // real signal — it inherited an already-clipped one and could not undo it. Operator's receipt
    // (2026-09-03): audible clipping whenever the meter topped out, with the limiter reporting gain
    // reduction at the same moment — it was catching what was left after the clamp had flattened it.
    //
    // This is the treatment the AUX bus already had, and its comment states the rule: "Peak control
    // on this bus belongs to the program processor — the same -1 dBTP limiter the rest of the
    // product uses. One system, one place that controls peaks."
    //
    // The clamp is NOT gone; it MOVED to the clean tap's points of use below. With both processing
    // toggles off there is no limiter in this path at all, so something must still stop over-range
    // samples reaching the device and the encoder — but that is a fallback for an unprocessed
    // station, not a stage the processor has to listen through.
    //
    // (The ROOM chain further down still clamps the same way. Same defect, deliberately left alone
    // here: it is a separate path and a separate decision.)
    let out_l = &mut out_l[..prog_frames];
    let out_r = &mut out_r[..prog_frames];
    if let Ok(mut eq) = bus.eq.try_lock() {
        for f in 0..prog_frames {
            let (l, r) = eq.process_stereo(mix_l[f], mix_r[f]);
            out_l[f] = l;
            out_r[f] = r;
        }
    } else {
        RtCounters::bump(&counters.lock_misses, 1);   // S6 — uncontended by construction; counted if not
        out_l.copy_from_slice(mix_l);
        out_r.copy_from_slice(mix_r);
    }

    // SLICE 8 — the MASTER's RTA tap (the master GEQ view): pre = the programme mix before the GEQ, post = after it,
    // both before the master fader (ruling 5). The analyser that used to run HERE (eq.rs: a ring write per sample and a
    // 2048-point FFT every 1024 samples, in this EQ and the room's) is gone — the RTA runs on the meter thread.
    if rta_t == crate::rta::RtaTarget::Master {
        let (ml, mr, ol, or) = (&mix_l[..prog_frames], &mix_r[..prog_frames], &*out_l, &*out_r);
        bus.rta.push(prog_frames, |f| (ml[f], mr[f]), |f| (ol[f], or[f]));
    }

    // ── MASTER OUT ────────────────────────────────────────────────────────────────────────────────
    // Applied HERE: after the mix + EQ, BEFORE the VU peak below and before the stream/device split.
    //   • the stream (what listeners hear) is taken from out_l/out_r further down → master rides air;
    //   • the master VU is computed from these same samples → the meter shows what went out;
    //   • the device branch multiplies by monitor levels afterwards → the room gets master x monitor,
    //     exactly like a console, and monitor still never touches air.
    // Unity is a no-op multiply, so an untouched station is bit-identical to the previous build.
    let master_vol = bus.master_vol;
    // SLICE 7 — the master fader ramps too (a Take or a restore moves it); a silent programme snaps.
    bus.master_ramp.follow(master_vol, any_playing);
    let mramp = bus.master_ramp;
    bus.master_ramp.advance(prog_frames);
    if mramp.ramping() {
        for (f, s) in out_l.iter_mut().enumerate() { *s = *s * mramp.at(f); }
        for (f, s) in out_r.iter_mut().enumerate() { *s = *s * mramp.at(f); }
    } else if master_vol != 1.0 {
        for s in out_l.iter_mut() { *s = *s * master_vol; }
        for s in out_r.iter_mut() { *s = *s * master_vol; }
    }
    let out_l: &[f32] = out_l;
    let out_r: &[f32] = out_r;
    // SLICE 2 — PGM tap: the clean programme, post-EQ, post-master, pre-processor.
    bus.meters_acc.bus[BUS_PGM].add(out_l, out_r);
    bus.meters_acc.bus_live |= 1 << BUS_PGM;
    // REMOTE LINK — the SEND tap, at the same point (ruling D3: before this station's processing, so the station
    // it feeds processes once). None unless SEND TO is on: then nothing here runs.
    if let Some(ref mut t) = bus.link_tap { t.push(out_l, out_r); }

    // Program/master peak for VU (functional — feeds master_peak below).
    let peak = out_l.iter().chain(out_r.iter())
        .map(|&s| s.abs())
        .fold(0.0f32, f32::max);

    // Publish REAL VU levels — post-fader peak per deck + post-EQ program (master) peak,
    // with VU release ballistics (instant rise, smooth ~50ms fall). Read by GetLevel.
    const VU_RELEASE: f32 = 0.82;
    for i in 0..SLOT_COUNT { bus.peaks[i] = frame_peaks[i].max(bus.peaks[i] * VU_RELEASE); }
    bus.master_peak = peak.max(bus.master_peak * VU_RELEASE);

    // ── Audio Processing v1: per-station program-bus loudness ────────────────────────────────────────────
    // Compute the PROCESSED bus ONCE if EITHER branch wants it; each branch (stream drain / device monitor)
    // taps processed or clean independently below. Both toggles OFF → this whole block is skipped and both
    // taps use the clean out_l/out_r (bit-identical to today). The processor has its OWN lock (mirrors bus.eq):
    // try_lock only, never blocks air; a missed lock falls back to clean. Meters are extracted before the lock
    // drops, then written to the bus fields (no split-borrow of the guard). `peak` is the clean stage-IN VU.
    // THE SPLIT (2026-09-07). Each branch runs its OWN processor, and only if its own toggle is on.
    //
    // Before this, one instance computed one buffer whenever EITHER toggle was on, and both branches
    // tapped it — so the monitor and the stream were literally the same samples and could not be shaped
    // apart. Now the monitor rides to what sounds right in the room and the stream rides to what
    // survives an encoder, independently.
    //
    // COST: a station with both branches on now runs two instances instead of one. Measured through the
    // shipped module (C5): 0.0325 ms -> 0.0629 ms median per 10 ms block, 1.97x, 0.6% of the callback
    // budget. A station with one branch on pays exactly what it paid before.
    //
    // BIT-IDENTICAL WHERE NOTHING IS STORED: the daemon mirrors the local parameters into the stream set
    // while the two are linked (the default), and two instances with identical parameters and identical
    // input produce identical output — C7 asserts it on the sample bits.
    // S1: each branch copies the clean bus into ITS OWN preallocated lane (was: two Vec clones per branch).
    // Returns the meters when the branch processed, None when its lock was missed — in which case the
    // lane holds a copy of the clean bus and is never read, exactly as the old None buffers were never read.
    let run_branch = |proc: &Arc<crate::rt::RtMutex<crate::program_processor::ProgramProcessor>>,
                      target: f32, ceiling: f32, release: f32, rate: f32, clamp: f32,
                      ride_byp: bool, lim_byp: bool, slots: [crate::rack::Slot<crate::rack::BranchModule>; crate::rack::MASTER_SLOTS],
                      pl: &mut [f32], pr: &mut [f32]|
     -> Option<(f32, f32, f32, f32, f32)> {   // (in LUFS, GR last sample, GR buffer max, ride dB, out peak)
        pl.copy_from_slice(out_l);
        pr.copy_from_slice(out_r);
        // try_lock only, never blocks air; a missed lock falls back to the clean tap, as before.
        if let Ok(mut p) = proc.try_lock() {
            p.set_target(target);
            p.set_params(ceiling, release, rate, clamp, ride_byp, lim_byp);
            // §B.3a — freeze the loudness ride while the duck has the music down, so the two features
            // cannot fight. The meter still runs; only the corrective gain is held. Both branches, since
            // the duck applies to the programme both of them carry.
            p.set_ride_hold(duck_active);
            // SLICE 4 — the branch's slots, in slot order (ride → limiter; the limiter is pinned last).
            p.process_slots(&slots, pl, pr);
            let op = pl.iter().chain(pr.iter()).map(|&s| s.abs()).fold(0.0f32, f32::max);
            Some((p.in_lufs(), p.gain_reduction_db(), p.gain_reduction_max_db(), p.ride_gain_db(), op))
        } else { RtCounters::bump(&counters.lock_misses, 1); None }
    };

    let loc_l = &mut loc_l[..prog_frames];
    let loc_r = &mut loc_r[..prog_frames];
    let str_l = &mut str_l[..prog_frames];
    let str_r = &mut str_r[..prog_frames];
    let local_m = if bus.proc_local {
        run_branch(&bus.processor.clone(), bus.proc_target_lufs, bus.proc_ceiling_dbtp,
                   bus.proc_release_ms, bus.proc_ride_rate, bus.proc_ride_clamp,
                   bus.proc_ride_bypass, bus.proc_limiter_bypass, bus.rack.branch[crate::rack::BRANCH_LOCAL], loc_l, loc_r)
    } else { None };

    let stream_m = if bus.proc_stream {
        run_branch(&bus.processor_stream.clone(), bus.proc_stream_target_lufs, bus.proc_stream_ceiling_dbtp,
                   bus.proc_stream_release_ms, bus.proc_stream_ride_rate, bus.proc_stream_ride_clamp,
                   bus.proc_stream_ride_bypass, bus.proc_stream_limiter_bypass, bus.rack.branch[crate::rack::BRANCH_STREAM], str_l, str_r)
    } else { None };
    // SLICE 2 — LOCAL tap: the LOCAL branch's processed output, when that branch ran.
    if local_m.is_some() {
        bus.meters_acc.bus[BUS_LOCAL].add(loc_l, loc_r);
        bus.meters_acc.bus_live |= 1 << BUS_LOCAL;
    }

    // METERS, PER BRANCH. proc_stream_* always describes the stream instance. The legacy proc_* fields
    // describe the LOCAL instance, and fall back to the stream instance when only the stream is
    // processing — so every existing reader (Settings, the Health Monitor) shows the same numbers it
    // showed before the split in every configuration that existed before the split.
    if let Some((il, gr, _, ride, op)) = local_m {
        bus.proc_in_lufs = il; bus.proc_gr_db = gr; bus.proc_ride_gain_db = ride;
        bus.proc_in_peak  = peak.max(bus.proc_in_peak * VU_RELEASE);
        bus.proc_out_peak = op.max(bus.proc_out_peak * VU_RELEASE);
    }
    if let Some((il, gr, gmax, ride, op)) = stream_m {
        bus.proc_stream_in_lufs = il;
        bus.proc_stream_gr_db = gr; bus.proc_stream_ride_gain_db = ride;
        // SLICE 3 — STREAM dynamics for the meter bus: the stream instance is what the stream carries.
        bus.meters_acc.gr[LOUD_STREAM].fold(ride, gmax, GR_SRC_OWN);
        bus.proc_stream_in_peak  = peak.max(bus.proc_stream_in_peak * VU_RELEASE);
        bus.proc_stream_out_peak = op.max(bus.proc_stream_out_peak * VU_RELEASE);
        if local_m.is_none() {
            bus.proc_in_lufs = il; bus.proc_gr_db = gr; bus.proc_ride_gain_db = ride;
            bus.proc_in_peak  = bus.proc_stream_in_peak;
            bus.proc_out_peak = bus.proc_stream_out_peak;
        }
    }

    // v4.4.46 mix telemetry: advance the frames-consumed counter (single u64 add under the lock we
    // already hold — no new lock, no atomic, RT-safe). GetLevel surfaces it; the daemon heartbeat
    // logs the per-interval delta as a live "callback is still pulling PCM" signal.
    bus.frames_consumed = bus.frames_consumed.wrapping_add(prog_frames as u64);

    // Program Bus: write 44100 Hz samples directly — ffmpeg always reads 44100 Hz.
    // Per-station stream-client flag (DESIGN-TRUTH §2) — only THIS station's Icecast
    // client presence gates THIS station's push; never a sibling's.
    // Stream drain taps PROCESSED when "Process stream" is on and the processed buffer exists, else clean.
    // The stream taps the STREAM processor now, not the shared one.
    let use_proc = bus.proc_stream && stream_m.is_some();
    // SLICE 3 — THE STREAM BRANCH'S OUTPUT, built every buffer into its own lane: the processed samples as
    // they are, or the clean bus clamped HERE. PROCESSED audio is already ceiling-controlled by the limiter
    // and passes through untouched; the CLEAN tap has no limiter in front of it, so it is clamped at the
    // point of use, for an unprocessed station only, instead of on the way in where it also clipped the
    // processor's input. Same arithmetic as the per-sample clamp that used to live in the push loop — built
    // once so the loudness meter measures exactly what the encoder gets, connected or not (a rehearsal with
    // no encoder still meters).
    if !use_proc {
        for f in 0..prog_frames { str_l[f] = out_l[f].clamp(-1.0, 1.0); str_r[f] = out_r[f].clamp(-1.0, 1.0); }
    }
    bus.loud.push(LOUD_STREAM, str_l, str_r);
    if bus.stream_connected.load(Ordering::Relaxed) {
        // SLICE 2 — STREAM tap: exactly the samples pushed to the ring below.
        let (mut spl, mut spr, mut ssl, mut ssr) = (bus.meters_acc.bus[BUS_STREAM].peak[0], bus.meters_acc.bus[BUS_STREAM].peak[1], 0.0f64, 0.0f64);
        for f in 0..prog_frames {
            let (l, r) = (str_l[f], str_r[f]);
            let _ = bus.ring_prod.try_push(l);
            let _ = bus.ring_prod.try_push(r);
            spl = spl.max(l.abs()); spr = spr.max(r.abs());
            ssl += (l as f64) * (l as f64); ssr += (r as f64) * (r as f64);
        }
        let t = &mut bus.meters_acc.bus[BUS_STREAM];
        t.peak = [spl, spr];
        t.sumsq[0] += ssl;
        t.sumsq[1] += ssr;
        bus.meters_acc.bus_live |= 1 << BUS_STREAM;
    }

    // Studio Monitor Bus: resample 44100 Hz → device rate if they differ. The monitor gain
    // (local speaker level) is applied HERE only — the program bus above already pushed full
    // level to Icecast, so turning the monitor down never changes what airs.
    // Device (studio-monitor) taps PROCESSED when "Process local output" is on, else clean — this IS the
    // PRE/POST monitor choice (broadcast is the stream branch above, unaffected). monitor_vol applies HERE only.
    //
    // ── AUX MONITOR BUS (2026-08-18): the room is NOT the air feed when aux decks are live ────────
    // Jeff's ruling: decks D/E/F must never sum into the local speaker output; they are heard in the
    // room ONLY through an AUX slot that selects them, at that slot's level. Air keeps them.
    //
    // aux_present == false (every station not using an aux deck) → this whole block is skipped and the
    // room takes the ORIGINAL path below, bit-identical to the previous build. The second chain costs
    // nothing until the feature is in use.
    let rl = &mut room_out_l[..prog_frames];
    let rr = &mut room_out_r[..prog_frames];
    // SLICE 3 — the room processor's dynamics, when it ran: while an aux deck is live the device plays the
    // ROOM chain, so LOCAL's ride/limiter meter must describe this instance, not the LOCAL one.
    let mut room_m: Option<(f32, f32)> = None;   // (ride dB, GR buffer max)
    let room_owned: bool = if aux_present {
        // The room's programme base is core_* (aux decks excluded), run through the room's OWN EQ and
        // master gain so A/B/C local monitoring is unchanged. Separate instances because both stages
        // are stateful and the air chain has already used its own on a different sum this callback.
        if let Ok(mut eqr) = bus.eq_room.try_lock() {
            for f in 0..prog_frames {
                let (l, r) = eqr.process_stereo(room_l[f], room_r[f]);
                rl[f] = l.clamp(-1.0, 1.0);
                rr[f] = r.clamp(-1.0, 1.0);
            }
        } else {
            // Never block the audio thread for EQ — fall back to clean, exactly as the air chain does.
            RtCounters::bump(&counters.lock_misses, 1);
            for f in 0..prog_frames { rl[f] = room_l[f].clamp(-1.0, 1.0); rr[f] = room_r[f].clamp(-1.0, 1.0); }
        }
        if mramp.ramping() {
            for f in 0..prog_frames { let g = mramp.at(f); rl[f] *= g; rr[f] *= g; }
        } else if master_vol != 1.0 {
            for f in 0..prog_frames { rl[f] *= master_vol; rr[f] *= master_vol; }
        }
        // Same PRE/POST monitor choice the operator already has for the room.
        if bus.proc_local {
            let target = bus.proc_target_lufs;
            if let Ok(mut p) = bus.processor_room.try_lock() {
                p.set_target(target);
            // The operator's parameters, applied every buffer beside the target. All three processor
            // instances (program, aux, room) get the same chain — one station, one sound.
            p.set_params(bus.proc_ceiling_dbtp, bus.proc_release_ms, bus.proc_ride_rate,
                         bus.proc_ride_clamp, bus.proc_ride_bypass, bus.proc_limiter_bypass);
                p.process_planar(rl, rr);
                room_m = Some((p.ride_gain_db(), p.gain_reduction_max_db()));
            } else { RtCounters::bump(&counters.lock_misses, 1); }
        }
        // NOTE: the aux sum is NOT added here. It has exactly ONE destination — the device chosen in
        // the AUX MONITORS section — and it reaches it through the aux ring below. An earlier revision
        // mixed it into the room and then bypassed the station monitor fader so it would be audible;
        // that amounted to picking an output on the operator's behalf, which is unsafe on a broadcast
        // machine. Reverted deliberately (Jeff, 2026-08-18): no device chosen = silence.
        //
        // What this chain still does, and must: build the room from the NON-aux slots, so decks D/E/F
        // never sum into the station's local speaker output.
        true
    } else { false };

    // Holds the clamped clean buffers when the device takes that tap, so the borrow below outlives
    // the `if`. None whenever the room chain or the processed buffers are feeding the device.
    let (dl, dr): (&[f32], &[f32]) = if room_owned {
        (&*rl, &*rr)
    } else if bus.proc_local && local_m.is_some() {
        (&*loc_l, &*loc_r)
    } else {
        // Clean tap to the device — no limiter in this path, so the ceiling is enforced here. Built
        // once rather than clamped per sample in the two write loops below, which are the hot ones.
        let cl = &mut dev_l[..prog_frames];
        let cr = &mut dev_r[..prog_frames];
        for f in 0..prog_frames { cl[f] = out_l[f].clamp(-1.0, 1.0); cr[f] = out_r[f].clamp(-1.0, 1.0); }
        (&*cl, &*cr)
    };
    // SLICE 2 — MONITOR tap: the device feed, pre-monitor-gain, pre-resample. ROOM tap: the room chain, when
    // it owns the device feed (an aux deck is live).
    bus.meters_acc.bus[BUS_MONITOR].add(dl, dr);
    bus.meters_acc.bus_live |= 1 << BUS_MONITOR;
    // SLICE 3 — LOCAL loudness: the device feed, before the monitor knobs (Jeff's ruling 6 — the harness's
    // monitor tap). And LOCAL's dynamics from WHICHEVER processor fed it: the room chain while an aux deck
    // is live, else the LOCAL instance; neither when the feed is clean.
    bus.loud.push(LOUD_LOCAL, dl, dr);
    if room_owned {
        if let Some((ride, gmax)) = room_m { bus.meters_acc.gr[LOUD_LOCAL].fold(ride, gmax, GR_SRC_ROOM); }
    } else if let Some((_, _, gmax, ride, _)) = local_m {
        if bus.proc_local { bus.meters_acc.gr[LOUD_LOCAL].fold(ride, gmax, GR_SRC_OWN); }
    }
    if room_owned {
        bus.meters_acc.bus[BUS_ROOM].add(dl, dr);
        bus.meters_acc.bus_live |= 1 << BUS_ROOM;
    }
    // ── (REMOVED 2026-08-22) A SECOND, EARLIER AUX PROCESSING BLOCK STOOD HERE ───────────────────
    // It ran `if bus.proc_local { processor_aux.process_planar(&mut aux_l, &mut aux_r) }` — the same
    // stateful ride + -1 dBTP limiter the block below runs, over the SAME buffer. With processing on
    // and an aux deck playing, the aux sum was ridden and limited TWICE: audible distortion on the
    // monitor feed, and exactly the artefact the clamp-to-limiter change was made to remove.
    //
    // Both blocks arrived together in f76ca2c (2026-08-18) — the lower one REPLACED this one and this
    // one was never deleted. It went unheard for four days because the addon in use had been built
    // 39 minutes BEFORE that commit; the slice-1 rebuild (2026-08-22) was the first binary to contain
    // it, which is how a source-only defect reached Jeff's ears as a "slice 1 regression".
    //
    // The surviving block below is the right one: it is gated on aux_present (so it does not advance
    // the ride's state over silence when no aux deck is up) and it publishes the aux processing
    // meters. Do not reintroduce a second pass here. See aux_monitor_single_pass_regression.

    // ── AUX BUS PROCESSING — the processor from Preferences, not a bespoke clamp ─────────────────
    // The aux bus carries the jukebox to the park's speakers, and that material includes Disney tracks
    // whose spoken dialogue is simply not audible outdoors without the loudness ride. So this is not a
    // safety net, it is part of the product: the same ride + -1 dBTP limiter the operator already
    // configures in Preferences ("Process local output" + target LUFS), applied to the aux sum.
    //
    // It REPLACES a hard clamp(-1.0, 1.0) that was doing peak control here. A hard clamp IS a clipper:
    // the moment the sum passed full scale it produced exactly the distortion it was meant to prevent,
    // and it did nothing at all for quiet dialogue. The limiter was already in the product.
    //
    // Its own instance because the processor is stateful and the air/room chains have already run
    // theirs over different sums this callback. try_lock only — never block the audio thread; a missed
    // lock falls through to the clamp below, which is the same fallback the other chains take.
    if bus.proc_local && aux_present {
        let target = bus.proc_target_lufs;
        // Meters extracted before the guard drops, exactly as the station chain does it — observed at
        // the taps, never claimed.
        let meters = if let Ok(mut p) = bus.processor_aux.try_lock() {
            p.set_target(target);
            // The operator's parameters, applied every buffer beside the target. All three processor
            // instances (program, aux, room) get the same chain — one station, one sound.
            p.set_params(bus.proc_ceiling_dbtp, bus.proc_release_ms, bus.proc_ride_rate,
                         bus.proc_ride_clamp, bus.proc_ride_bypass, bus.proc_limiter_bypass);
            p.process_planar(aux_l, aux_r);
            Some((p.in_lufs(), p.gain_reduction_db(), p.gain_reduction_max_db(), p.ride_gain_db()))
        } else { RtCounters::bump(&counters.lock_misses, 1); None };
        if let Some((il, gr, gmax, ride)) = meters {
            bus.aux_proc_in_lufs = il;
            bus.aux_proc_gr_db = gr;
            bus.aux_proc_ride_db = ride;
            bus.meters_acc.gr[LOUD_AUX].fold(ride, gmax, GR_SRC_OWN);
        }
    }
    // SLICE 2 — AUX tap: the aux monitor feed as it leaves (after its processor when that is on).
    if aux_present {
        bus.meters_acc.bus[BUS_AUX].add(aux_l, aux_r);
        bus.meters_acc.bus_live |= 1 << BUS_AUX;
        // SLICE 3 — AUX OUT is measured too (Jeff's ruling 4), at the same point.
        bus.loud.push(LOUD_AUX, aux_l, aux_r);
    }

    // AUX FEED VU — the peak of what the aux bus is sending, with the same release ballistics as the
    // other meters. Computed whether or not a device is open, so "the slot is feeding but nothing is
    // selected to hear it on" is a distinguishable state.
    {
        let ap = aux_l.iter().chain(aux_r.iter()).map(|&s| s.abs()).fold(0.0f32, f32::max);
        bus.aux_peak = ap.max(bus.aux_peak * VU_RELEASE);
    }

    // ── AUX MONITOR SEND ─────────────────────────────────────────────────────────────────────────
    // The aux sum's ONE destination. Written only when an aux output stream is open, which only
    // happens when the operator picked a device. Interleaved stereo at PROGRAM_RATE; the aux stream's
    // own callback resamples to whatever its device runs at.
    //
    // DRIFT BOUND: the aux device has its own clock, so producer and consumer never agree exactly.
    // Past AUX_RING_HIGH we drop a frame rather than let the ring creep toward full — a monitor that
    // is seconds behind is useless, and a dropped frame on a monitor feed is a tick, not a fault.
    // try_push is used throughout: the audio thread must never block on a full ring.
    {
        if let Some(ref mut prod) = bus.aux_ring_prod {
            for f in 0..prog_frames {
                // NO CLAMP HERE. Peak control on this bus belongs to the program processor above —
                // the same -1 dBTP limiter the rest of the product uses. An earlier revision clamped
                // instead, which is a hard clipper: it produced the very distortion it was meant to
                // prevent on loud material, and did nothing for the quiet dialogue that is the reason
                // this bus is processed at all. One system, one place that controls peaks.
                let l = aux_l[f];
                let r = aux_r[f];
                // NO mid-buffer break. This used to `break` out of the loop once the ring reached its
                // high-water mark, which threw away the REST of the buffer — a hard discontinuity in
                // the waveform every time it fired, i.e. a click, repeating for as long as the two
                // device clocks disagreed. That is the crackle. Rate correction now happens on the
                // CONSUMER side (a sub-audible resample nudge), where it belongs; the producer's only
                // job is to hand over every sample it made.
                let _ = prod.try_push(l);
                let _ = prod.try_push(r);
            }
        }
    }

    // ── PFL OVER MONITOR (Jeff's rulings 1–2, 2026-09-26) ────────────────────────────────────────────
    // While any channel's PFL is on, the station's MAIN LOCAL OUTPUT becomes the programme DIMMED by the station's
    // setting (pfl_dim_db) plus the cue sum — the console "PFL over monitor". Everything above — the MONITOR and
    // LOCAL loudness taps, PGM, the stream, the AUX send — is already done, so none of them ever carries PFL.
    // With no PFL on, this block is skipped and the output is bit-identical to before.
    //
    // PFL OUTPUT DEVICE (a cue device chosen on this machine — pfl_to_device): PFL goes ONLY there, the main output
    // is left exactly as it is. The cue device carries the programme at the dim level plus the cue while any PFL is
    // on (the operator hears context), and silence otherwise (the stream keeps flowing, so its clock stays locked).
    // A chosen device that is not open has no ring: PFL is then silent — never a fallback to the speakers.
    if bus.pfl_to_device {
        let dim = 10f32.powf(bus.pfl_dim_db / 20.0);
        if let Some(ref mut prod) = bus.cue_ring_prod {
            if pfl_any {
                for f in 0..prog_frames {
                    let _ = prod.try_push((dl[f] * dim + cue_l[f]).clamp(-1.0, 1.0));
                    let _ = prod.try_push((dr[f] * dim + cue_r[f]).clamp(-1.0, 1.0));
                }
            } else {
                for _ in 0..prog_frames { let _ = prod.try_push(0.0); let _ = prod.try_push(0.0); }
            }
        }
    }
    let (dl, dr): (&[f32], &[f32]) = if pfl_any && !bus.pfl_to_device {
        let dim = 10f32.powf(bus.pfl_dim_db / 20.0);
        let (pl, pr) = (&mut pfl_l[..prog_frames], &mut pfl_r[..prog_frames]);
        for f in 0..prog_frames {
            pl[f] = (dl[f] * dim + cue_l[f]).clamp(-1.0, 1.0);
            pr[f] = (dr[f] * dim + cue_r[f]).clamp(-1.0, 1.0);
        }
        (&*pl, &*pr)
    } else { (dl, dr) };
    // ROOM VU — the peak of what the speakers are about to get, with the same release ballistics as
    // the air meters. Taken BEFORE the monitor gains so it reads the content, not the knob.
    {
        let rp = dl.iter().chain(dr.iter()).map(|&s| s.abs()).fold(0.0f32, f32::max);
        bus.room_peak = rp.max(bus.room_peak * VU_RELEASE);
    }
    // Room level = this station's strip level x the ONE master monitor level. Both local-only: the
    // stream push above already happened, so neither can change what airs.
    let mvol = bus.monitor_vol * bus.master_monitor_vol;
    if device_sr == PROGRAM_RATE || prog_frames <= 1 {
        for f in 0..device_frames {
            if ch == 2 {
                data[f * 2]     = dl[f] * mvol;
                data[f * 2 + 1] = dr[f] * mvol;
            } else {
                data[f] = (dl[f] + dr[f]) * 0.5 * mvol;
            }
        }
    } else {
        // Linear interpolation: map device_frames output positions into prog_frames input
        let scale = (prog_frames - 1) as f64 / (device_frames - 1).max(1) as f64;
        for f in 0..device_frames {
            let t    = f as f64 * scale;
            let idx  = t as usize;
            let frac = (t - idx as f64) as f32;
            let l0 = dl[idx];
            let l1 = dl.get(idx + 1).copied().unwrap_or(l0);
            let r0 = dr[idx];
            let r1 = dr.get(idx + 1).copied().unwrap_or(r0);
            let l = l0 + (l1 - l0) * frac;
            let r = r0 + (r1 - r0) * frac;
            if ch == 2 {
                data[f * 2]     = l * mvol;
                data[f * 2 + 1] = r * mvol;
            } else {
                data[f] = (l + r) * 0.5 * mvol;
            }
        }
    }

    playing.store(any_playing, Ordering::Relaxed);   // S2 — was a try_lock on a Mutex<bool>
    // S3 — this buffer's meters and telemetry, for GetLevel (lock-free triple buffer).
    bus.publish_meters();

}

fn drain_program_bus(
    station_id: u32,
    listener:   std::net::TcpListener,
    mut cons:   ringbuf::HeapCons<f32>,
    delay:      SharedDelay,
    stream_connected: Arc<AtomicBool>,   // per-station: only this station's client presence
) {
    use std::io::Write;
    use std::collections::VecDeque;


    // 44100 Hz × 2 ch × 4 bytes/sample = 352800 bytes/sec
    const TARGET_BYTES_PER_SEC: f64 = 44100.0 * 2.0 * 4.0;

    loop {
        match listener.accept() {
            Ok((mut stream, addr)) => {
                eprintln!("[RUST] Station {} stream client connected: {}", station_id, addr);
                let _ = stream.set_nodelay(true);
                stream_connected.store(true, Ordering::Relaxed);

                let wall_start = std::time::Instant::now();
                let mut bytes_written: u64 = 0;
                let mut real_bytes_since_log: u64 = 0;
                let mut zero_bytes_since_log: u64 = 0;
                let mut last_log = std::time::Instant::now();

                // Pre-allocate scratch buffers — reused every tick, no heap alloc in hot path.
                // Sized for ~50ms burst headroom (352800 * 0.05 / 4 = 4410 samples).
                let mut sample_buf: Vec<f32> = Vec::with_capacity(8820);
                let mut out_bytes:   Vec<u8>  = Vec::with_capacity(8820 * 4);
                // Broadcast-delay FIFO: live program audio is pushed in; output is taken
                // only once the FIFO exceeds the target delay, so the stream lags live.
                let mut delay_fifo: VecDeque<f32> = VecDeque::with_capacity(PROGRAM_RATE as usize * 2 * 12);
                const DELAY_FIFO_CAP: usize = PROGRAM_RATE as usize * 2 * 15; // 15s hard safety cap
                // Fractional read cursor (in stereo frames) for the rebuild resampler — when
                // below the target delay during quiet, we consume source slightly slower than we
                // emit (linear interp), growing the delay imperceptibly. 0 at steady state.
                let mut resample_pos: f64 = 0.0;

                loop {
                    let target = delay.target_samples.load(Ordering::Relaxed);

                    if target == 0 {
                        // ── DELAY OFF — producer-paced passthrough (single master clock) ─────
                        // The cpal output callback (the audio device clock) feeds the ring; here we
                        // write exactly what the ring delivers, so the stream is paced by the
                        // device — there is no second (wall) clock to drift against and NO
                        // zero-fill. The old path demanded a fixed 352800 B/s by wall clock and
                        // silence-filled any shortfall; under the daemon's scheduling jitter the
                        // ring underran constantly, so those silence inserts became a steady
                        // crackle. ffmpeg's input buffer + Icecast backpressure (write_all blocks)
                        // absorb jitter and pace us to real time. The producer always pushes whole
                        // stereo frames, so `popped` is even and L/R interleave stays aligned.
                        if !delay_fifo.is_empty() { delay_fifo.clear(); }
                        resample_pos = 0.0;
                        delay.dump_flag.swap(false, Ordering::Relaxed); // nothing buffered to dump here
                        delay.buffered_samples.store(0, Ordering::Relaxed);

                        sample_buf.clear();
                        sample_buf.resize(8820, 0.0f32); // up to ~50 ms (2205 stereo frames)
                        let popped = cons.pop_slice(&mut sample_buf);
                        if popped > 0 {
                            out_bytes.clear();
                            for &s in &sample_buf[..popped] { out_bytes.extend_from_slice(&s.to_le_bytes()); }
                            if stream.write_all(&out_bytes).is_err() {
                                stream_connected.store(false, Ordering::Relaxed);
                                break;
                            }
                            let n = out_bytes.len() as u64;
                            bytes_written        += n; // keep the wall clock coherent if delay is armed later
                            real_bytes_since_log += n;
                        }
                    } else {
                        // ── DELAY ARMED — wall-clock-paced rebuild (unchanged) ───────────────
                        let elapsed_secs = wall_start.elapsed().as_secs_f64();
                        let target_bytes = (elapsed_secs * TARGET_BYTES_PER_SEC) as u64;

                        // CRITICAL: align deficit to a whole stereo FRAME (8 bytes = 2 f32).
                        // Windows sleep granularity means elapsed_secs is never exactly N×5ms, so the
                        // raw deficit can be a non-multiple; an unaligned write permanently misaligns
                        // the f32le stream (static). Frame alignment also keeps L/R interleave correct
                        // for the rebuild resampler below.
                        let deficit = {
                            let raw = target_bytes.saturating_sub(bytes_written) as usize;
                            (raw / 8) * 8
                        };

                        if deficit > 0 {
                            let max_samples = deficit / 4;

                            // Pull whatever live program audio is available into the delay FIFO.
                            sample_buf.clear();
                            sample_buf.resize(max_samples, 0.0f32);
                            let popped = cons.pop_slice(&mut sample_buf);

                            // DUMP — discard the buffered (not-yet-aired) audio and splice to live.
                            if delay.dump_flag.swap(false, Ordering::Relaxed) {
                                delay_fifo.clear();
                                resample_pos = 0.0;
                            }
                            for &s in &sample_buf[..popped] { delay_fifo.push_back(s); }
                            while delay_fifo.len() > DELAY_FIFO_CAP { delay_fifo.pop_front(); } // safety

                            let want_frames = max_samples / 2; // deficit is frame-aligned → even

                            // Consume ratio = source frames consumed per emitted frame.
                            //   • at/above target → 1.0 (exact passthrough).
                            //   • below target → rebuild, but ONLY stretch through near-silence
                            //     (consume <1.0) so the delay grows imperceptibly; passthrough on
                            //     audible audio so nothing is pitch-shifted.
                            let ratio: f64 = if delay_fifo.len() >= target {
                                1.0
                            } else {
                                let probe = max_samples.min(delay_fifo.len());
                                let mut peak = 0.0f32;
                                for i in 0..probe { let v = delay_fifo[i].abs(); if v > peak { peak = v; } }
                                if peak < 0.02 { 0.80 } else { 1.0 }
                            };

                            out_bytes.clear();
                            let avail_frames = delay_fifo.len() / 2;
                            for _ in 0..want_frames {
                                let idx = resample_pos.floor() as usize;
                                if idx + 1 >= avail_frames { break; } // underrun → silence-fill remainder
                                let frac = (resample_pos - idx as f64) as f32;
                                let l = delay_fifo[idx * 2]     + (delay_fifo[idx * 2 + 2] - delay_fifo[idx * 2])     * frac;
                                let r = delay_fifo[idx * 2 + 1] + (delay_fifo[idx * 2 + 3] - delay_fifo[idx * 2 + 1]) * frac;
                                out_bytes.extend_from_slice(&l.to_le_bytes());
                                out_bytes.extend_from_slice(&r.to_le_bytes());
                                resample_pos += ratio;
                            }
                            // Pop the whole frames we've fully consumed; carry the fraction.
                            let consume = (resample_pos.floor() as usize).min(delay_fifo.len() / 2);
                            for _ in 0..(consume * 2) { delay_fifo.pop_front(); }
                            resample_pos -= consume as f64;

                            let real_byte_count = out_bytes.len();
                            out_bytes.resize(deficit, 0u8); // zero-fill remainder (rebuild underrun)
                            let zero_byte_count = deficit.saturating_sub(real_byte_count);

                            delay.buffered_samples.store(delay_fifo.len(), Ordering::Relaxed);

                            if stream.write_all(&out_bytes).is_err() {
                                stream_connected.store(false, Ordering::Relaxed);
                                break;
                            }

                            bytes_written += deficit as u64;
                            real_bytes_since_log += real_byte_count as u64;
                            zero_bytes_since_log += zero_byte_count as u64;
                        }
                    }

                    // Log every 5 seconds
                    let log_elapsed = last_log.elapsed().as_secs_f64();
                    if log_elapsed >= 5.0 {
                        let occupancy = cons.occupied_len();
                        let real_rate  = real_bytes_since_log as f64 / log_elapsed;
                        let zero_rate  = zero_bytes_since_log as f64 / log_elapsed;
                        let total_rate = (real_bytes_since_log + zero_bytes_since_log) as f64 / log_elapsed;
                        eprintln!(
                            "[RUST] Station {} drain: real={:.0} B/s  zero={:.0} B/s  total={:.0} B/s  ring_occ={}  (target 352800)",
                            station_id, real_rate, zero_rate, total_rate, occupancy
                        );
                        real_bytes_since_log = 0;
                        zero_bytes_since_log = 0;
                        last_log = std::time::Instant::now();
                    }

                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                stream_connected.store(false, Ordering::Relaxed);
                { let mut discard = [0f32; 1024]; while cons.pop_slice(&mut discard) > 0 {} }
                eprintln!("[RUST] Station {} stream client disconnected", station_id);
            }
            Err(e) => {
                eprintln!("[RUST] Station {} TCP accept error: {}", station_id, e);
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
    }
}

// ── SLICE 6 — channel dynamics through the real mixer callback (docs/dsp-channel-dynamics.md §4) ─────────────
#[cfg(test)]
mod dynamics_through_the_mixer {
    use super::*;
    use crate::rack::{ChannelRack, ChannelRackParams};

    struct Tone { n: u64, freq: f64, amp: f64 }
    impl Iterator for Tone {
        type Item = f32;
        fn next(&mut self) -> Option<f32> { let i = self.n / 2; self.n += 1; Some((self.amp * (2.0 * std::f64::consts::PI * self.freq * i as f64 / 44_100.0).sin()) as f32) }
    }
    /// Deterministic Gaussian noise at a given RMS (dBFS), the same sample on L and R.
    struct Noise { s: u64, rms: f64, cur: f32, half: bool }
    impl Iterator for Noise {
        type Item = f32;
        fn next(&mut self) -> Option<f32> {
            if self.half { self.half = false; return Some(self.cur); }
            let mut u = || { self.s = self.s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); ((self.s >> 11) as f64 + 0.5) / (1u64 << 53) as f64 };
            let (u1, u2) = (u(), u());
            let g = (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos();
            self.cur = (g * self.rms) as f32; self.half = true;
            Some(self.cur)
        }
    }
    struct Out { stream: Vec<f32>, dyn_: crate::rt::DynTap, duck_min_after: f32 }

    /// S1 (slot 7) carries `src`; its rack is `rack_json` (None = no rack). Optionally programme on deck A and S1's
    /// DUCK on. Returns S1's programme (the stream), the last meter window's dynamics tap for S1, and the lowest duck
    /// gain seen after `settle` buffers.
    fn run(buffers: usize, src: impl Iterator<Item = f32> + Send + 'static, rack_json: Option<&str>, programme: bool, duck: bool, settle: usize) -> Out {
        let (prod, mut stream_cons) = HeapRb::<f32>::new(PROGRAM_BUS_BUF).split();
        let mut b = BusState::new(crate::eq::new_shared_eq(44100.0), prod, 44100, Arc::new(AtomicBool::new(true)));
        let h = b.handles.take().unwrap();
        let (meters, _loud) = MetersHandle::from_parts(Arc::new(Mutex::new(h.meter_r)), h.shared.clone(), h.loud_cons, h.loud_shared);
        let cap = 480 * 2 * (buffers + 2);
        if programme {
            b.decks[0].source = Some(DeckFeed::prefilled(Tone { n: 0, freq: 220.0, amp: 0.2 }, cap));
            b.decks[0].active = true; b.decks[0].paused = false; b.decks[0].volume = 1.0;
        }
        b.decks[7].source = Some(DeckFeed::prefilled(src, cap));
        b.decks[7].active = true; b.decks[7].paused = false; b.decks[7].volume = 1.0;
        let mut cur = b.params();
        cur.duck_enabled[7] = duck;
        if let Some(j) = rack_json {
            let r = ChannelRack::from_doc_json(j).unwrap();
            cur.ch_rack[7] = ChannelRackParams { rack: r, plan: r.plan(44_100.0), version: 1 };
        }
        let bus = Arc::new(crate::rt::RtMutex::new(b));
        let (mut cmd, mut garbage) = (h.cmd_prod, h.garbage_cons);
        let _ = cmd.try_push(RtCmd::Params(Box::new(cur)));
        let (fin, playing) = (FinishedFlags::new(), Arc::new(AtomicBool::new(true)));
        let mut sc = Scratch::new();
        let (mut data, mut pop) = (vec![0f32; 960], vec![0f32; 960]);
        let mut o = Out { stream: Vec::new(), dyn_: Default::default(), duck_min_after: 1.0 };
        for k in 0..buffers {
            mixer_callback(&mut data, 2, &bus, &fin, &playing, &mut sc);
            loop { let got = stream_cons.pop_slice(&mut pop); if got == 0 { break; } for f in 0..got / 2 { o.stream.push(pop[2 * f]); } }
            while garbage.try_pop().is_some() {}
            if k >= settle { let g = bus.lock().unwrap().duck_gain; if g < o.duck_min_after { o.duck_min_after = g; } }
            if k == buffers - 2 { let _ = meters.read_and_ack(); }
            if k == buffers - 1 { o.dyn_ = meters.read_and_ack().unwrap().ch_dyn[7]; }
        }
        o
    }
    fn rms_db(x: &[f32]) -> f64 { 20.0 * (x.iter().map(|&v| (v as f64) * (v as f64)).sum::<f64>() / x.len() as f64).sqrt().log10() }
    const COMP: &str = r#"{"v":1,"sections":{"ch":[{"module":{"type":"comp","threshold":-20,"ratio":4,"attack":10,"release":150,"makeup":0,"knee":6},"in":true}]}}"#;
    fn gate(thr: f32) -> String { format!(r#"{{"v":1,"sections":{{"ch":[{{"module":{{"type":"gate","threshold":{thr},"ratio":5,"depth":15,"attack":1,"hold":100,"release":150,"hysteresis":3}},"in":true}}]}}}}"#) }

    #[test]
    fn the_spec_case_minus_10_over_4_to_1_at_minus_20_reads_7_5_db_of_gr() {
        // a 1 kHz sine at −10 dBFS RMS (the RMS detector's level — ruling 1)
        let amp = 10f64.powf(-10.0 / 20.0) * 2f64.sqrt();
        let o = run(300, Tone { n: 0, freq: 1000.0, amp }, Some(COMP), false, false, 0);
        let out = rms_db(&o.stream[o.stream.len() - 22_050..]);
        println!("[dyn-comp] 1 kHz −10 dBFS RMS on S1, 4:1 at −20 dB, knee 6 dB, through the real callback: GR tap {:.3} dB (spec ~7.5; bar 7.50 ± 0.1) · output {:.3} dBFS RMS (want −17.5)",
                 o.dyn_.comp_gr, out);
        assert!((o.dyn_.comp_gr - 7.5).abs() < 0.1, "GR {:.3} dB", o.dyn_.comp_gr);
        assert!((out + 17.5).abs() < 0.1, "output {:.3} dBFS", out);
    }

    #[test]
    fn the_gate_drops_idle_room_noise_by_its_depth_and_leaves_speech_alone() {
        let noise = Noise { s: 7, rms: 10f64.powf(-60.0 / 20.0), cur: 0.0, half: false };
        let dry = run(300, Noise { s: 7, rms: 10f64.powf(-60.0 / 20.0), cur: 0.0, half: false }, None, false, false, 0);
        let o = run(300, noise, Some(&gate(-45.0)), false, false, 0);
        let (n0, n1) = (rms_db(&dry.stream[dry.stream.len() - 44_100..]), rms_db(&o.stream[o.stream.len() - 44_100..]));
        // speech-level tone through the same gate: open, untouched
        let t_amp = 10f64.powf(-20.0 / 20.0) * 2f64.sqrt();
        let td = run(200, Tone { n: 0, freq: 500.0, amp: t_amp }, None, false, false, 0);
        let tg = run(200, Tone { n: 0, freq: 500.0, amp: t_amp }, Some(&gate(-45.0)), false, false, 0);
        let (s0, s1) = (rms_db(&td.stream[td.stream.len() - 22_050..]), rms_db(&tg.stream[tg.stream.len() - 22_050..]));
        println!("[dyn-gate] room noise −60 dBFS RMS on S1, gate −45 / depth 15 / 1:5: {:.2} → {:.2} dBFS (want −75 ± 0.5; GR tap {:.2} dB, open {:.0}%) · speech tone −20 dBFS: {:.3} → {:.3} (Δ {:+.3} dB)",
                 n0, n1, o.dyn_.gate_gr, 100.0 * o.dyn_.gate_open as f32 / o.dyn_.runs.max(1) as f32, s0, s1, s1 - s0);
        assert!((n1 + 75.0).abs() < 0.5, "gated noise {:.2} dBFS", n1);
        assert!((s1 - s0).abs() < 0.1, "the gate touched speech: {:+.3} dB", s1 - s0);
    }

    #[test]
    fn a_gated_mic_does_not_duck_the_music_and_an_ungated_one_does() {
        // S1 = room noise at −52 dBFS RMS (peaks above the ducker's −45 dBFS threshold), DUCK ON, programme on A.
        let mk = || Noise { s: 11, rms: 10f64.powf(-52.0 / 20.0), cur: 0.0, half: false };
        let settle = 300;   // 3.3 s: past the gate's first close and the ducker's hold + release
        let ungated = run(600, mk(), None, true, true, settle);
        let gated = run(600, mk(), Some(&gate(-40.0)), true, true, settle);
        println!("[dyn-duck] mic room noise −52 dBFS RMS, DUCK ON, programme on A — lowest duck gain after {:.1} s: ungated {:.3} (ducks) · gate −40 IN {:.3} (does not)",
                 settle as f64 * 480.0 / 44_100.0, ungated.duck_min_after, gated.duck_min_after);
        assert!(ungated.duck_min_after < 0.5, "the ungated mic did not duck — the test cannot see ducking");
        assert!(gated.duck_min_after > 0.999, "the gated mic's room noise ducked the music");
    }
}

// ── PFL through the real mixer callback (Jeff's PFL rulings, 2026-09-26) ───────────────────────────────────
// Programme on deck A; S1 (a source channel) playing a 1 kHz tone with its channel OFF and its fader at 0.3.
// PFL on S1 → S1 is in the LOCAL output at its pre-fader level, the programme there dimmed by the station's
// setting; the STREAM and the PGM / MONITOR taps are bit-identical to PFL off. Post-rack: S1's rack is heard.
#[cfg(test)]
mod pfl_over_monitor {
    use super::*;
    use crate::rack::{ChannelRack, ChannelRackParams};

    struct Tone { n: u64, freq: f64, amp: f64 }
    impl Iterator for Tone {
        type Item = f32;
        fn next(&mut self) -> Option<f32> {
            let i = self.n / 2; self.n += 1;
            Some((self.amp * (2.0 * std::f64::consts::PI * self.freq * i as f64 / 44_100.0).sin()) as f32)
        }
    }
    struct Out { local: Vec<f32>, stream: Vec<f32>, cue: Vec<f32>, pgm: f64, monitor: f64, allocs: u64 }
    /// The PFL output device: none chosen (same as main), chosen and OPEN (a ring), chosen but MISSING (no ring).
    #[derive(Clone, Copy, PartialEq)] enum Cue { Main, Open, Missing }

    fn run(buffers: usize, pfl: bool, dim_db: f32, peq_db: Option<f32>) -> Out { run_cue(buffers, pfl, dim_db, peq_db, Cue::Main) }
    fn run_cue(buffers: usize, pfl: bool, dim_db: f32, peq_db: Option<f32>, cue: Cue) -> Out {
        let (prod, mut stream_cons) = HeapRb::<f32>::new(PROGRAM_BUS_BUF).split();
        let mut b = BusState::new(crate::eq::new_shared_eq(44100.0), prod, 44100, Arc::new(AtomicBool::new(true)));
        let h = b.handles.take().unwrap();
        let (meters, _loud) = MetersHandle::from_parts(Arc::new(Mutex::new(h.meter_r)), h.shared.clone(), h.loud_cons, h.loud_shared);
        let cap = 480 * 2 * (buffers + 2);
        b.decks[0].source = Some(DeckFeed::prefilled(Tone { n: 0, freq: 220.0, amp: 0.2 }, cap));
        b.decks[0].active = true; b.decks[0].paused = false; b.decks[0].volume = 1.0;
        b.decks[7].source = Some(DeckFeed::prefilled(Tone { n: 0, freq: 1000.0, amp: 0.1 }, cap));
        b.decks[7].active = true; b.decks[7].paused = false;
        // the cue device's ring, as the monitor-output thread installs it when the chosen device OPENS
        let mut cue_cons = None;
        if cue == Cue::Open { let (p, c) = HeapRb::<f32>::new(AUX_BUS_BUF * 16).split(); b.cue_ring_prod = Some(p); cue_cons = Some(c); }
        let mut cur = b.params();
        cur.pfl_to_device = cue != Cue::Main;
        cur.volume[7] = 0.3;        // the fader — PFL is PRE-fader, so it must not matter
        cur.muted[7] = true;        // channel OFF — PFL is PRE-cut, so it must not matter either
        cur.pfl[7] = pfl;
        cur.pfl_dim_db = dim_db;
        if let Some(g) = peq_db {
            let r = ChannelRack::from_doc_json(&format!(r#"{{"v":1,"sections":{{"ch":[{{"module":{{"type":"peq","bands":[
                {{"freq":100,"gain":0,"width":1}},{{"freq":1000,"gain":{g},"width":1}},{{"freq":3000,"gain":0,"width":1}},{{"freq":8000,"gain":0,"width":1}}]}},"in":true}}]}}}}"#)).unwrap();
            cur.ch_rack[7] = ChannelRackParams { rack: r, plan: r.plan(44_100.0), version: 1 };
        }
        let bus = Arc::new(crate::rt::RtMutex::new(b));
        let (mut cmd, mut garbage) = (h.cmd_prod, h.garbage_cons);
        let _ = cmd.try_push(RtCmd::Params(Box::new(cur)));
        let (fin, playing) = (FinishedFlags::new(), Arc::new(AtomicBool::new(true)));
        let mut sc = Scratch::new();
        let (mut data, mut pop) = (vec![0f32; 960], vec![0f32; 960]);
        let mut o = Out { local: Vec::new(), stream: Vec::new(), cue: Vec::new(), pgm: 0.0, monitor: 0.0, allocs: 0 };
        for _ in 0..buffers {
            let a0 = crate::rt::tl_rt_allocs();
            mixer_callback(&mut data, 2, &bus, &fin, &playing, &mut sc);
            o.allocs += crate::rt::tl_rt_allocs() - a0;
            for f in 0..480 { o.local.push(data[2 * f]); }
            loop {
                let got = stream_cons.pop_slice(&mut pop);
                if got == 0 { break; }
                for f in 0..got / 2 { o.stream.push(pop[2 * f]); }
            }
            if let Some(c) = cue_cons.as_mut() {
                loop { let got = c.pop_slice(&mut pop); if got == 0 { break; } for f in 0..got / 2 { o.cue.push(pop[2 * f]); } }
            }
            while garbage.try_pop().is_some() {}
        }
        let w = meters.read_and_ack().unwrap();
        o.pgm = w.bus[crate::rt::BUS_PGM].sumsq[0];
        o.monitor = w.bus[crate::rt::BUS_MONITOR].sumsq[0];
        o
    }
    fn rms_db(x: &[f64]) -> f64 { 20.0 * (x.iter().map(|v| v * v).sum::<f64>() / x.len() as f64).sqrt().log10() }

    #[test]
    fn pfl_puts_the_channel_in_the_local_output_only_pre_fader_pre_cut_and_dims_the_programme() {
        let n = 300;
        let off = run(n, false, -12.0, None);
        let on = run(n, true, -12.0, None);
        let on20 = run(n, true, -20.0, None);
        // S1's pre-fader, pre-cut signal: the tone itself (trim 0 dB, no rack)
        let s1: Vec<f32> = (0..n * 480).map(|i| (0.1 * (2.0 * std::f64::consts::PI * 1000.0 * i as f64 / 44_100.0).sin()) as f32).collect();
        let expect = |dim_db: f32, f: usize| -> f32 { (off.local[f] * 10f32.powf(dim_db / 20.0) + s1[f]).clamp(-1.0, 1.0) };
        let err12 = (0..n * 480).map(|f| (on.local[f] - expect(-12.0, f)).abs()).fold(0f32, f32::max);
        let err20 = (0..n * 480).map(|f| (on20.local[f] - expect(-20.0, f)).abs()).fold(0f32, f32::max);
        let stream_same = off.stream.len() == on.stream.len() && off.stream.iter().zip(&on.stream).all(|(a, b)| a.to_bits() == b.to_bits());
        // the PFL'd component alone, recovered from the local output
        let cue: Vec<f64> = (0..n * 480).map(|f| on.local[f] as f64 - off.local[f] as f64 * 10f64.powf(-12.0 / 20.0)).collect();
        let s1db = rms_db(&s1.iter().map(|&x| x as f64).collect::<Vec<_>>());
        // with PFL OFF, how much of S1 is in the local output (least-squares coefficient; 0 = absent)
        let proj = (0..n * 480).map(|f| off.local[f] as f64 * s1[f] as f64).sum::<f64>() / s1.iter().map(|&x| (x as f64) * (x as f64)).sum::<f64>();
        println!("[pfl] S1 OFF, fader 0.3, PFL on: its component in the LOCAL output {:.3} dBFS RMS (pre-fader level {:.3}) · local = programme × dim + S1 to {:.1e} (−12 dB), {:.1e} (−20 dB) · \
                  PFL off: S1 in local ×{:.1e} (absent) · STREAM bit-identical: {} · PGM tap equal: {} · MONITOR tap equal: {} · {} allocations",
                 rms_db(&cue), s1db, err12, err20, proj, stream_same, off.pgm == on.pgm, off.monitor == on.monitor, on.allocs + on20.allocs);
        assert!(err12 < 1e-6 && err20 < 1e-6, "the local output is not programme × dim + the pre-fader channel");
        assert!((rms_db(&cue) - s1db).abs() < 0.01, "PFL is not at the pre-fader level");
        assert!(proj.abs() < 1e-3, "S1 is in the local output with PFL off");
        assert!(stream_same, "PFL reached the stream");
        assert_eq!(off.pgm, on.pgm, "PFL reached the PGM tap");
        assert_eq!(off.monitor, on.monitor, "PFL reached the MONITOR tap");
        assert_eq!(on.allocs + on20.allocs, 0);
    }

    #[test]
    fn a_cue_device_takes_pfl_off_the_main_output_and_carries_the_dimmed_programme() {
        let n = 300;
        let off = run(n, false, -12.0, None);
        let on = run_cue(n, true, -12.0, None, Cue::Open);
        let idle = run_cue(n, false, -12.0, None, Cue::Open);
        let s1: Vec<f32> = (0..n * 480).map(|i| (0.1 * (2.0 * std::f64::consts::PI * 1000.0 * i as f64 / 44_100.0).sin()) as f32).collect();
        let main_same = off.local.iter().zip(&on.local).all(|(a, b)| a.to_bits() == b.to_bits());
        let dim = 10f32.powf(-12.0 / 20.0);
        let err = (0..n * 480).map(|f| (on.cue[f] - (off.local[f] * dim + s1[f]).clamp(-1.0, 1.0)).abs()).fold(0f32, f32::max);
        let idle_silent = idle.cue.len() == n * 480 && idle.cue.iter().all(|&x| x == 0.0);
        let stream_same = off.stream.iter().zip(&on.stream).all(|(a, b)| a.to_bits() == b.to_bits());
        println!("[pfl-cue] cue device OPEN, PFL on S1: MAIN output bit-identical to PFL off: {} · cue device = programme × dim + S1 to {:.1e} ({} frames) · no PFL: cue device silent ({} frames of 0) · stream bit-identical: {} · {} allocations",
                 main_same, err, on.cue.len(), idle.cue.len(), stream_same, on.allocs + idle.allocs);
        assert!(main_same, "PFL reached the main output with a cue device chosen");
        assert_eq!(on.cue.len(), n * 480);
        assert!(err < 1e-6, "the cue device is not programme × dim + the pre-fader channel");
        assert!(idle_silent, "the cue device carried something with no PFL on");
        assert!(stream_same);
        assert_eq!(on.allocs + idle.allocs, 0);
    }

    #[test]
    fn a_missing_cue_device_leaves_pfl_silent_never_the_speakers() {
        let n = 200;
        let off = run(n, false, -12.0, None);
        let missing = run_cue(n, true, -12.0, None, Cue::Missing);
        let main_same = off.local.iter().zip(&missing.local).all(|(a, b)| a.to_bits() == b.to_bits());
        println!("[pfl-cue] cue device chosen but MISSING, PFL on S1: main output bit-identical to PFL off (no fallback to the speakers): {}", main_same);
        assert!(main_same, "a missing cue device fell back to the main output");
    }

    #[test]
    fn pfl_is_post_rack_the_processed_sound() {
        let n = 300;
        let off = run(n, false, -12.0, Some(6.0));
        let on = run(n, true, -12.0, Some(6.0));
        let tail = 44_100usize;   // the last second, after the rack's fade-in
        let len = n * 480;
        let cue: Vec<f64> = (len - tail..len).map(|f| on.local[f] as f64 - off.local[f] as f64 * 10f64.powf(-12.0 / 20.0)).collect();
        let pre_db = 20.0 * (0.1f64 / 2f64.sqrt()).log10();
        println!("[pfl] S1 with PEQ +6 dB @ 1 kHz, PFL on: cue {:.3} dBFS RMS vs the dry channel {:.3} → {:+.3} dB (the rack is heard)",
                 rms_db(&cue), pre_db, rms_db(&cue) - pre_db);
        assert!((rms_db(&cue) - pre_db - 6.0).abs() < 0.1, "PFL is not post-rack");
    }
}

// ── THE MIC through the real mixer callback (docs/dsp-mic-in-engine.md §6, §7) ───────────────────────────────
// A live feed on S1 (slot 7) from a 48 kHz "device" (a synthetic producer standing in for the cpal input
// callback): the pre-fader meter reads the level that went in; a PEQ +6 dB at 1 kHz on S1's rack reads +6 on
// the programme; two identical runs are bit-identical.
#[cfg(test)]
mod mic_through_the_mixer {
    use super::*;
    use crate::rack::{ChannelRack, ChannelRackParams};

    /// Run `buffers` 480-frame buffers with a 1 kHz −18 dBFS mic on S1 at `gain_db` input gain, optionally a
    /// PEQ `peq_db` at 1 kHz on its rack. Returns (programme output L, the last meter window's S1 RMS dBFS).
    fn run(buffers: usize, gain_db: f32, peq_db: Option<f32>) -> (Vec<f32>, f64, u64) {
        let (prod, mut stream_cons) = HeapRb::<f32>::new(PROGRAM_BUS_BUF).split();
        let mut b = BusState::new(crate::eq::new_shared_eq(44100.0), prod, 44100, Arc::new(AtomicBool::new(true)));
        let h = b.handles.take().unwrap();
        let (meters, _loud) = MetersHandle::from_parts(Arc::new(Mutex::new(h.meter_r)), h.shared.clone(), h.loud_cons, h.loud_shared);
        let sh = Arc::new(crate::micin::MicShared::default());
        sh.gain_bits.store(crate::micin::db_to_lin(gain_db).to_bits(), Ordering::Relaxed);
        let (mut p, c) = crate::micin::mic_ring(48_000);
        b.decks[7].source = Some(DeckFeed::live(Box::new(crate::micin::LiveIn::new(c, 48_000, sh.clone()))));
        b.decks[7].active = true; b.decks[7].paused = false; b.decks[7].volume = 1.0;
        let mut cur = b.params();
        if let Some(g) = peq_db {
            let r = ChannelRack::from_doc_json(&format!(r#"{{"v":1,"sections":{{"ch":[{{"module":{{"type":"peq","bands":[
                {{"freq":100,"gain":0,"width":1}},{{"freq":1000,"gain":{g},"width":1}},{{"freq":3000,"gain":0,"width":1}},{{"freq":8000,"gain":0,"width":1}}]}},"in":true}}]}}}}"#)).unwrap();
            cur.ch_rack[7] = ChannelRackParams { rack: r, plan: r.plan(44_100.0), version: 1 };
        }
        let bus = Arc::new(crate::rt::RtMutex::new(b));
        let (mut cmd, mut garbage) = (h.cmd_prod, h.garbage_cons);
        let _ = cmd.try_push(RtCmd::Params(Box::new(cur)));
        let (fin, playing) = (FinishedFlags::new(), Arc::new(AtomicBool::new(true)));
        let mut sc = Scratch::new();
        let (mut data, mut pop) = (vec![0f32; 960], vec![0f32; 960]);
        let mut g = crate::micin::tests::Gen { rate: 48_000.0, freq: 1000.0, amp: 10f64.powf(-18.0 / 20.0), n: 0 };
        let (mut blk, mut acc, mut out) = (Vec::new(), 0.0f64, Vec::new());
        let mut last = None;
        let mut allocs = 0u64;
        for k in 0..buffers {
            acc += 480.0 * 48_000.0 / 44_100.0;
            let n = acc as usize; acc -= n as f64;
            g.block(&mut blk, n);
            crate::micin::input_block(&blk, 1, 0, &mut p, &sh, |x| x);
            let a0 = crate::rt::tl_rt_allocs();
            mixer_callback(&mut data, 2, &bus, &fin, &playing, &mut sc);
            allocs += crate::rt::tl_rt_allocs() - a0;
            if k == buffers - 2 { let _ = meters.read_and_ack(); }   // open a fresh window for the last buffer
            if k == buffers - 1 { last = meters.read_and_ack(); }
            while garbage.try_pop().is_some() {}
            // THE PROGRAMME = what the stream gets (a source channel is on air and on the AUX monitor, not in
            // the local device's room path — the existing routing, unchanged).
            loop {
                let got = stream_cons.pop_slice(&mut pop);
                if got == 0 { break; }
                for f in 0..got / 2 { out.push(pop[2 * f]); }
            }
        }
        let w = last.unwrap();
        let rms = (w.ch[7].sumsq[0] / w.frames.max(1) as f64).sqrt();
        (out, 20.0 * rms.log10(), allocs)
    }
    fn rms_db(x: &[f32]) -> f64 { 20.0 * (x.iter().map(|&v| (v as f64) * (v as f64)).sum::<f64>() / x.len() as f64).sqrt().log10() }

    #[test]
    fn a_mic_on_s1_meters_right_takes_its_rack_and_is_deterministic() {
        let n = 600;   // 6.5 s
        let (dry, meter_db, allocs) = run(n, 0.0, None);
        let (wet, _, _) = run(n, 0.0, Some(6.0));
        let (boost, meter_boost, _) = run(n, 12.0, None);
        let (dry2, _, _) = run(n, 0.0, None);
        let tail = |x: &Vec<f32>| rms_db(&x[x.len() - 44_100..]);
        let (d, w, bo) = (tail(&dry), tail(&wet), tail(&boost));
        let same = dry.iter().zip(&dry2).all(|(a, b)| a.to_bits() == b.to_bits());
        println!("[mic-mixer] 1 kHz −18 dBFS on S1 (48 k → 44.1 k): pre-fader meter {:.3} dBFS RMS (want −21.010) · programme {:.3} ·                   rack PEQ +6 @ 1 kHz → programme {:+.3} dB · input gain +12 → meter {:+.3} dB, programme {:+.3} dB · two runs bit-identical: {} · {} allocations in the callback",
                 meter_db, d, w - d, meter_boost - meter_db, bo - d, same, allocs);
        assert!((meter_db + 21.010).abs() < 0.05, "the mic's pre-fader meter reads {:.3}", meter_db);
        assert!((w - d - 6.0).abs() < 0.1, "the rack did not apply: {:+.3} dB", w - d);
        assert!((meter_boost - meter_db - 12.0).abs() < 0.05 && (bo - d - 12.0).abs() < 0.05, "input gain is not pre-meter, pre-mix");
        assert!(same, "the live path is not deterministic");
        assert_eq!(allocs, 0);
    }
}

// ── SLICE 5 — the channel racks' cost on the audio thread (docs/dsp-channel-rack-eq.md §1.4, §7) ──────────────
// The callback with 0, 1 and 12 faders playing, their racks IN (Filters: HPF + LPF; PEQ: 4 non-zero bands = the
// full 8 biquads, stereo, f64), steady or CROSSFADING CONTINUOUSLY (a new rack version to every fader every
// buffer, so each fade is followed at once by the held one). Jeff's gate: the 12-channel crossfading worst case
// must stay ≤ 1 ms (p99) per 10 ms buffer — otherwise stop and report.
#[cfg(test)]
mod channel_rack_timing {
    use super::*;
    use crate::rack::{ChannelRack, ChannelRackParams};

    struct Sine(u64);
    impl Iterator for Sine {
        type Item = f32;
        fn next(&mut self) -> Option<f32> { let i = self.0 / 2; self.0 += 1; Some(0.3 * (i as f32 * 0.0712).sin()) }
    }
    fn rack(g: f32) -> ChannelRack {
        ChannelRack::from_doc_json(&format!(r#"{{"v":1,"sections":{{"ch":[
            {{"module":{{"type":"filters","hpf":{{"in":true,"freq":80}},"lpf":{{"in":true,"freq":12000}}}},"in":true}},
            {{"module":{{"type":"peq","bands":[{{"freq":120,"gain":{g},"width":1,"shelf":true}},{{"freq":900,"gain":-3,"width":1}},
              {{"freq":3000,"gain":2,"width":2}},{{"freq":9000,"gain":-2,"width":1,"shelf":true}}]}},"in":true}}]}}}}"#)).unwrap()
    }
    /// SLICE 6 — the WHOLE channel rack, all IN: Filters → Gate → PEQ → Comp (the Voice starting point's shape).
    fn rack_full(g: f32) -> ChannelRack {
        ChannelRack::from_doc_json(&format!(r#"{{"v":1,"sections":{{"ch":[
            {{"module":{{"type":"filters","hpf":{{"in":true,"freq":80}},"lpf":{{"in":true,"freq":12000}}}},"in":true}},
            {{"module":{{"type":"gate","threshold":-45,"ratio":4,"depth":15,"attack":1,"hold":100,"release":150,"hysteresis":3}},"in":true}},
            {{"module":{{"type":"peq","bands":[{{"freq":120,"gain":{g},"width":1,"shelf":true}},{{"freq":900,"gain":-3,"width":1}},
              {{"freq":3000,"gain":2,"width":2}},{{"freq":9000,"gain":-2,"width":1,"shelf":true}}]}},"in":true}},
            {{"module":{{"type":"comp","threshold":-20,"ratio":3,"attack":10,"release":150,"makeup":0,"knee":6}},"in":true}}]}}}}"#)).unwrap()
    }

    /// One measured scenario: the buffer (median, p99, worst), allocations in the callback, and the channel-rack
    /// work ALONE — its wall max and its thread-CPU max per buffer, its wall time inside the slowest buffer, and
    /// the per-channel wall times of the buffer where the rack's wall time peaked.
    struct Row { med: f64, p99: f64, max: f64, allocs: u64, rk_wall_max: f64, rk_cpu_max: f64, rk_in_slowest: f64,
                 worst_calls: Vec<f64>, worst_calls_cpu: f64 }

    /// ms per CPU cycle of this thread (QueryThreadCycleTime), calibrated against wall time on a 200 ms busy loop.
    fn ms_per_cycle() -> f64 {
        let (t0, c0) = (std::time::Instant::now(), crate::chdsp::thread_cycles());
        let mut x = 1.0f64;
        while t0.elapsed().as_millis() < 200 { for _ in 0..1000 { x = (x * 1.000001).sin() + 1.0; } }
        std::hint::black_box(x);
        let cyc = crate::chdsp::thread_cycles().saturating_sub(c0) as f64;
        t0.elapsed().as_secs_f64() * 1000.0 / cyc.max(1.0)
    }

    /// `n_active` faders playing, racks IN on all of them if `racks`; the first `n_fading` get a new rack version
    /// EVERY buffer (so each fade is followed at once by the held one — crossfading continuously).
    fn measure(n_active: usize, racks: bool, n_fading: usize, mics: usize, mpc: f64) -> Row { measure_x(n_active, racks, n_fading, mics, false, mpc) }
    /// `full`: every rack is the whole Filters → Gate → PEQ → Comp chain (SLICE 6).
    fn measure_x(n_active: usize, racks: bool, n_fading: usize, mics: usize, full: bool, mpc: f64) -> Row {
        let rb = HeapRb::<f32>::new(PROGRAM_BUS_BUF);
        let (prod, mut stream_cons) = rb.split();
        let mut b = BusState::new(crate::eq::new_shared_eq(44100.0), prod, 44100, Arc::new(AtomicBool::new(true)));
        let h = b.handles.take().unwrap();
        for i in 0..n_active {
            b.decks[i].source = Some(DeckFeed::prefilled(Sine(0), 480 * 2 * 2100));
            b.decks[i].active = true; b.decks[i].paused = false; b.decks[i].volume = 0.5;
        }
        // THE MIC — `mics` live inputs on S1.. (slots 7..), each a 48 kHz device resampled to 44.1 kHz. Their
        // producers are fed between buffers (the input callback's work is its own thread's, not the mixer's).
        let mut mic_in: Vec<(ringbuf::HeapProd<f32>, std::sync::Arc<crate::micin::MicShared>, crate::micin::tests::Gen, f64)> = Vec::new();
        for m in 0..mics {
            let sh = std::sync::Arc::new(crate::micin::MicShared::default());
            let (p, c) = crate::micin::mic_ring(48_000);
            b.decks[7 + m].source = Some(DeckFeed::live(Box::new(crate::micin::LiveIn::new(c, 48_000, sh.clone()))));
            b.decks[7 + m].active = true; b.decks[7 + m].paused = false; b.decks[7 + m].volume = 0.5;
            mic_in.push((p, sh, crate::micin::tests::Gen { rate: 48_000.0, freq: 300.0 + 100.0 * m as f64, amp: 0.2, n: 0 }, 0.0));
        }
        let mut blk: Vec<f32> = Vec::with_capacity(1024);
        let mut cur = b.params();
        let bus = Arc::new(crate::rt::RtMutex::new(b));
        let (mut cmd, mut garbage) = (h.cmd_prod, h.garbage_cons);
        let fin = FinishedFlags::new();
        let playing = Arc::new(AtomicBool::new(true));
        let mut sc = Scratch::new();
        let mut data = vec![0f32; 480 * 2];
        let mut pop = vec![0f32; PROGRAM_BUS_BUF];
        let (ra, rb2) = if full { (rack_full(3.0), rack_full(-3.0)) } else { (rack(3.0), rack(-3.0)) };
        let (pa, pb) = (ra.plan(44_100.0), rb2.plan(44_100.0));
        let (mut ns, mut rk_w, mut rk_c, mut calls) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        let mut allocs = 0u64;
        for k in 0..2000u64 {
            if racks && (k == 0 || n_fading > 0) {
                for i in (0..n_active).chain(7..7 + mics) {
                    if k == 0 || i < n_fading {
                        let (r, pl) = if k % 2 == 0 { (ra, pa) } else { (rb2, pb) };
                        cur.ch_rack[i] = ChannelRackParams { rack: r, plan: pl, version: k + 1 };
                    }
                }
                let _ = cmd.try_push(RtCmd::Params(Box::new(cur)));
            }
            for (p, sh, g, acc) in mic_in.iter_mut() {
                *acc += 480.0 * 48_000.0 / 44_100.0;
                let n = *acc as usize;
                *acc -= n as f64;
                g.block(&mut blk, n);
                crate::micin::input_block(&blk, 1, 0, p, sh, |x| x);
            }
            let a0 = crate::rt::tl_rt_allocs();
            crate::chdsp::RACK_NS.with(|c| c.set(0));
            crate::chdsp::RACK_CYC.with(|c| c.set(0));
            crate::chdsp::RACK_NCALLS.with(|c| c.set(0));
            let t0 = std::time::Instant::now();
            mixer_callback(&mut data, 2, &bus, &fin, &playing, &mut sc);
            let dt = t0.elapsed().as_nanos() as f64 / 1e6;
            allocs += crate::rt::tl_rt_allocs() - a0;
            if k >= 100 {   // skip the first 100 buffers (warm-up, first fade)
                ns.push(dt);
                rk_w.push(crate::chdsp::RACK_NS.with(|c| c.get()) as f64 / 1e6);
                rk_c.push(crate::chdsp::RACK_CYC.with(|c| c.get()) as f64 * mpc);
                let n = crate::chdsp::RACK_NCALLS.with(|c| c.get()).min(12);
                calls.push(crate::chdsp::RACK_CALLS.with(|a| a.borrow()[..n].iter().map(|&x| x as f64 / 1e6).collect::<Vec<f64>>()));
            }
            while garbage.try_pop().is_some() {}
            while stream_cons.pop_slice(&mut pop) > 0 {}
        }
        let argmax = |v: &Vec<f64>| (0..v.len()).max_by(|&a, &b| v[a].partial_cmp(&v[b]).unwrap()).unwrap_or(0);
        let (slowest, worst_rack) = (argmax(&ns), argmax(&rk_w));
        let mut sorted = ns.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let q = |f: f64| sorted[((sorted.len() - 1) as f64 * f) as usize];
        Row {
            med: q(0.5), p99: q(0.99), max: q(1.0), allocs,
            rk_wall_max: rk_w.iter().cloned().fold(0.0, f64::max),
            rk_cpu_max: rk_c.iter().cloned().fold(0.0, f64::max),
            rk_in_slowest: rk_w.get(slowest).copied().unwrap_or(0.0),
            worst_calls: calls.get(worst_rack).cloned().unwrap_or_default(),
            worst_calls_cpu: rk_c.get(worst_rack).copied().unwrap_or(0.0),
        }
    }

    #[test]
    fn channel_rack_cost_one_and_twelve_channels() {
        let mpc = ms_per_cycle();
        // (name, playing, racks, crossfading, mics, gated)
        let rows = [
            ("12 faders playing, no racks (baseline)", 12, false, 0, 0, false),
            (" 1 fader, rack IN, steady", 1, true, 0, 0, false),
            (" 1 fader, rack IN, crossfading", 1, true, 1, 0, false),
            (" 4 faders, racks IN, steady            (a)", 4, true, 0, 0, true),
            (" 4 faders, racks IN, 1 crossfading     (b)", 4, true, 1, 0, true),
            (" 4 faders + 1 MIC (48 k), racks IN", 4, true, 0, 1, true),
            (" 4 faders + 5 MICS (48 k), racks IN", 4, true, 0, 5, true),
            (" 4 faders + 1 MIC, FULL rack IN (flt+gate+peq+comp)", 4, true, 0, 1, true),
            ("12 faders, FULL rack IN, ALL CROSSFADING (extreme)", 12, true, 12, 0, false),
            ("12 faders, racks IN, steady", 12, true, 0, 0, false),
            ("12 faders, racks IN, ALL CROSSFADING (extreme)", 12, true, 12, 0, false),
        ];
        let mut fails = Vec::new();
        for (name, n, racks, fading, mics, gated) in rows {
            let r = measure_x(n, racks, fading, mics, name.contains("FULL"), mpc);
            let rk = if racks {
                let c = &r.worst_calls;
                let (mx, sum) = (c.iter().cloned().fold(0.0, f64::max), c.iter().sum::<f64>());
                let mut sc = c.clone();
                sc.sort_by(|a, b| a.partial_cmp(b).unwrap());
                format!("\n    rack alone: WALL max {:.3} ms · CPU max {:.3} ms · wall in the slowest buffer {:.3} ms\n    the buffer where rack wall peaked, per channel (wall ms): [{}] — largest {:.3} = {:.0}% of {:.3}; median channel {:.3}; that buffer's rack CPU {:.3} ms",
                        r.rk_wall_max, r.rk_cpu_max, r.rk_in_slowest,
                        c.iter().map(|x| format!("{:.3}", x)).collect::<Vec<_>>().join(" "),
                        mx, if sum > 0.0 { mx / sum * 100.0 } else { 0.0 }, sum, sc.get(sc.len() / 2).copied().unwrap_or(0.0), r.worst_calls_cpu)
            } else { String::new() };
            println!("[ch-rack-timing] {:<48} median {:.4} ms · p99 {:.4} ms · worst {:.3} ms · {} allocations{}", name, r.med, r.p99, r.max, r.allocs, rk);
            assert_eq!(r.allocs, 0, "{}: the callback allocated", name);
            if gated {
                if r.p99 > 1.0 { fails.push(format!("{}: p99 {:.4} ms > 1 ms", name.trim(), r.p99)); }
                if r.rk_cpu_max > 0.5 { fails.push(format!("{}: rack CPU max {:.3} ms > 0.5 ms", name.trim(), r.rk_cpu_max)); }
            }
        }
        println!("[ch-rack-timing] thread CPU = QueryThreadCycleTime × {:.4e} ms/cycle (calibrated on a 200 ms busy loop)", mpc);
        // JEFF'S GATE (ruling 2026-09-26): rows (a) and (b) — what OV runs — p99 ≤ 1 ms AND rack CPU max ≤ 0.5 ms.
        // The 12-all-crossfading row is the recorded extreme, not gated.
        assert!(fails.is_empty(), "GATE: {:?} — stop and report", fails);
    }
}

// ── SLICE 7 — show presets through the real mixer callback (docs/dsp-show-presets.md §5) ─────────────────────
// The engine half of the receipts: a fader step no longer clicks (and its hard twin does); a Take that leaves the
// live deck out leaves it bit-identical; one Take lands in one buffer; a restored show nulls against the same board
// set by hand; nothing allocates.
#[cfg(test)]
mod show_through_the_mixer {
    use super::*;
    use crate::ramp::LevelRamp;
    use crate::show::ShowApply;

    const FS: f64 = 44_100.0;
    struct Tone { n: u64, freq: f64, amp: f64 }
    impl Iterator for Tone {
        type Item = f32;
        fn next(&mut self) -> Option<f32> { let i = self.n / 2; self.n += 1; Some((self.amp * (2.0 * std::f64::consts::PI * self.freq * i as f64 / FS).sin()) as f32) }
    }
    fn tone(freq: f64, amp: f64) -> Tone { Tone { n: 0, freq, amp } }

    struct Rig {
        bus: SharedBusState,
        cmd: HeapProd<RtCmd>,
        garbage: HeapCons<Garbage>,
        stream_cons: HeapCons<f32>,
        meters: MetersHandle,
        fin: FinishedFlags,
        playing: Arc<AtomicBool>,
        sc: Box<Scratch>,
        data: Vec<f32>,
        pop: Vec<f32>,
        stream: Vec<f32>,
        local: Vec<f32>,
        allocs: u64,
    }
    const CAP: usize = 480 * 2 * 700;
    fn rig(setup: impl FnOnce(&mut BusState)) -> Rig {
        let (prod, stream_cons) = HeapRb::<f32>::new(PROGRAM_BUS_BUF).split();
        let mut b = BusState::new(crate::eq::new_shared_eq(44100.0), prod, 44100, Arc::new(AtomicBool::new(true)));
        let h = b.handles.take().unwrap();
        let (meters, _loud) = MetersHandle::from_parts(Arc::new(Mutex::new(h.meter_r)), h.shared.clone(), h.loud_cons, h.loud_shared);
        setup(&mut b);
        Rig { bus: Arc::new(crate::rt::RtMutex::new(b)), cmd: h.cmd_prod, garbage: h.garbage_cons, stream_cons, meters,
              fin: FinishedFlags::new(), playing: Arc::new(AtomicBool::new(true)), sc: Scratch::new(),
              data: vec![0f32; 960], pop: vec![0f32; 960], stream: Vec::new(), local: Vec::new(), allocs: 0 }
    }
    fn play(b: &mut BusState, i: usize, src: impl Iterator<Item = f32> + Send + 'static, paused: bool) {
        b.decks[i].source = Some(DeckFeed::prefilled(src, CAP));
        b.decks[i].active = true; b.decks[i].paused = paused; b.decks[i].volume = 1.0;
    }
    impl Rig {
        fn params(&self) -> Params { self.bus.lock().unwrap().params() }
        fn push(&mut self, p: Params) { assert!(self.cmd.try_push(RtCmd::Params(Box::new(p))).is_ok()); }
        /// One buffer through the real callback; returns that buffer's meter window.
        fn step(&mut self) -> MeterBlock {
            let a0 = crate::rt::tl_rt_allocs();
            mixer_callback(&mut self.data, 2, &self.bus, &self.fin, &self.playing, &mut self.sc);
            self.allocs += crate::rt::tl_rt_allocs() - a0;
            for f in 0..480 { self.local.push(self.data[2 * f]); }
            loop { let got = self.stream_cons.pop_slice(&mut self.pop); if got == 0 { break; } for f in 0..got / 2 { self.stream.push(self.pop[2 * f]); } }
            while self.garbage.try_pop().is_some() {}
            self.meters.read_and_ack().unwrap_or_default()
        }
    }

    fn hp8(x: &[f32]) -> Vec<f64> {
        let q = [0.5098, 0.6013, 0.9000, 2.5629];   // 8th-order Butterworth section Qs (chdsp's click detector)
        let bq: Vec<_> = q.iter().map(|&qq| crate::rack::rbj_pass(8_000.0, qq, FS, true)).collect();
        let mut st = [[0.0f64; 2]; 4];
        x.iter().map(|&v| {
            let mut y = v as f64;
            for (k, b) in bq.iter().enumerate() {
                let o = b.b0 * y + st[k][0];
                st[k][0] = b.b1 * y - b.a1 * o + st[k][1];
                st[k][1] = b.b2 * y - b.a2 * o;
                y = o;
            }
            y
        }).collect()
    }
    fn residual_db(x: &[f32], at: usize) -> f64 {
        let hp = hp8(x);
        20.0 * hp[at - 4410..at + 8820].iter().fold(0.0f64, |m, v| m.max(v.abs())).max(1e-12).log10()
    }

    /// A 1 kHz tone at −12 dBFS on deck A; at buffer 92 (~1.0 s) the fader (or the master) steps 1.0 → 0.25.
    /// `ramp_len` 0 = the twin: a hard step.
    fn level_step(master: bool, ramp_len: Option<u32>, step: bool) -> f64 {
        let mut r = rig(|b| {
            play(b, 0, tone(1000.0, 10f64.powf(-12.0 / 20.0)), false);
            if let Some(n) = ramp_len { if master { b.master_ramp = LevelRamp::with_len(n); } else { b.vol_ramp[0] = LevelRamp::with_len(n); } }
        });
        let at_buf = 92;
        for k in 0..200 {
            if k == at_buf && step {
                let mut p = r.params();
                if master { crate::show::set_master_fader(&mut p, 0.25); } else { p.volume[0] = 0.25; }
                r.push(p);
            }
            r.step();
        }
        residual_db(&r.stream, at_buf * 480)
    }

    #[test]
    fn a_level_step_does_not_click_and_its_hard_twin_does() {
        let floor = level_step(false, None, false);
        let fader = level_step(false, None, true);
        let fader_hard = level_step(false, Some(0), true);
        let master = level_step(true, None, true);
        let master_hard = level_step(true, Some(0), true);
        println!("[level-no-click] 1 kHz −12 dBFS on A, level 1.0 → 0.25 (−12 dB) at a buffer boundary, through the real callback · 8 kHz-HP residual: fader ramped {:.1} dBFS, hard (twin) {:.1} · master ramped {:.1}, hard (twin) {:.1} · floor {:.1} · bar −80",
                 fader, fader_hard, master, master_hard, floor);
        assert!(fader < -80.0 && master < -80.0, "a ramped level step clicked");
        assert!(fader_hard > -80.0 && master_hard > -80.0, "the twin did not click — the test cannot see a click");
    }

    const PEQ_A: &str = r#"{"v":1,"sections":{"ch":[{"module":{"type":"peq","bands":[{"freq":100,"gain":0,"width":1},{"freq":1000,"gain":-4,"width":1},{"freq":3000,"gain":0,"width":1},{"freq":8000,"gain":0,"width":1}]},"in":true}]}}"#;
    const PEQ_220: &str = r#"{"v":1,"sections":{"ch":[{"module":{"type":"peq","bands":[{"freq":100,"gain":0,"width":1},{"freq":220,"gain":6,"width":1},{"freq":3000,"gain":0,"width":1},{"freq":8000,"gain":0,"width":1}]},"in":true}]}}"#;
    const COMP: &str = r#"{"v":1,"sections":{"ch":[{"module":{"type":"comp","threshold":-20,"ratio":4,"attack":10,"release":150,"makeup":3,"knee":6},"in":true}]}}"#;
    const GATE: &str = r#"{"v":1,"sections":{"ch":[{"module":{"type":"gate","threshold":-45,"ratio":4,"depth":15,"attack":1,"hold":100,"release":150,"hysteresis":3},"in":true}]}}"#;

    /// A plays (ON, rack PEQ_A); D plays but is cut (OFF); S1 is idle. The Take at buffer 60 leaves A out (the blade's
    /// live rule) and changes D, S1, the ducker, the monitor — and, when `master_rack`, the master GEQ.
    fn mid_song(take: bool, master_rack: bool) -> (Rig, Vec<(MeterTap, MeterTap)>) {
        let mut r = rig(|b| {
            play(b, 0, tone(220.0, 0.3), false);
            play(b, 3, tone(700.0, 0.2), false);
        });
        let mut p = r.params();
        crate::show::set_channel_rack(&mut p, 0, crate::rack::ChannelRack::from_doc_json(PEQ_A).unwrap(), FS);
        p.muted[3] = true;
        r.push(p);
        let geq = r#","rack":{"v":1,"link":true,"sections":{"pgm":[{"module":{"type":"geq","bands":[0,0,3,0,0,0,0,-2,0,0]},"in":true}],"local":[{"module":{"type":"ride","target":-14,"rate":1.5,"clamp":12},"in":true},{"module":{"type":"limiter","ceiling":-1,"release":120},"in":true}]}}"#;
        let show = format!(r#"{{"slots":{{"D":{{"fader":0.3,"duck":true,"room":0.5,"rack":{COMP}}},"S1":{{"fader":0.7,"duckable":false,"rack":{PEQ_220}}}}},
                              "master":{{"monitor":0.6,"duck":{{"depthDb":-9,"thresholdDb":-40,"attackMs":20,"holdMs":300,"releaseMs":600}}{}}}}}"#,
                           if master_rack { geq } else { "" });
        let show = ShowApply::from_json(&show).unwrap();
        let mut taps = Vec::new();
        for k in 0..200 {
            if k == 60 && take { let mut p = r.params(); show.apply(&mut p, FS); r.push(p); }
            let w = r.step();
            taps.push((w.ch[0], w.ch_post[0]));
        }
        (r, taps)
    }
    fn same_taps(a: &[(MeterTap, MeterTap)], b: &[(MeterTap, MeterTap)]) -> bool {
        a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.0.peak == y.0.peak && x.0.sumsq == y.0.sumsq && x.1.peak == y.1.peak && x.1.sumsq == y.1.sumsq)
    }

    #[test]
    fn a_take_mid_song_leaves_the_live_deck_bit_identical_and_its_pending_lands_when_it_goes_off() {
        let (reference, ref_taps) = mid_song(false, false);
        let (mut took, took_taps) = mid_song(true, false);
        let air_same = reference.stream == took.stream;
        let taps_same = same_taps(&ref_taps, &took_taps);
        // …and with a new master rack in the Take: air changes (the Take landed), A's own taps do not.
        let (geq, geq_taps) = mid_song(true, true);
        let geq_air_differs = geq.stream != reference.stream;
        let geq_taps_same = same_taps(&ref_taps, &geq_taps);
        {
            let b = took.bus.lock().unwrap();
            assert_eq!((b.decks[3].volume, b.decks[7].volume, b.monitor_vol, b.duck_depth_db), (0.3, 0.7, 0.6, -9.0), "the Take did not land");
            assert_eq!(b.decks[0].volume, 1.0, "the live deck's fader moved");
        }
        // A goes OFF (the operator cuts it); the blade then sends A's pending values for A only.
        let mut p = took.params(); p.muted[0] = true; took.push(p);
        took.step();
        let pend = ShowApply::from_json(&format!(r#"{{"slots":{{"A":{{"fader":0.5,"rack":{PEQ_220}}}}}}}"#)).unwrap();
        let mut p = took.params(); pend.apply(&mut p, FS); took.push(p);
        let mut last = MeterBlock::default();
        for _ in 0..60 { last = took.step(); }
        let lift = 10.0 * (last.ch_post[0].sumsq[0] / last.ch[0].sumsq[0]).log10();
        let (vol, cut) = { let b = took.bus.lock().unwrap(); (b.decks[0].volume, b.decks[0].muted) };
        println!("[show-live] Take at buffer 60 leaving A (playing, ON) out · air {} over 200 buffers · A's pre- and post-rack taps {} per buffer · with a new master GEQ in the Take: air {} (the Take landed), A's taps {} · A cut, then its pending sent: fader {} (cut {}), rack post/pre {:+.2} dB at 220 Hz (preset +6)",
                 if air_same { "BIT-IDENTICAL" } else { "DIFFERS" }, if taps_same { "bit-identical" } else { "DIFFER" },
                 if geq_air_differs { "changes" } else { "UNCHANGED" }, if geq_taps_same { "bit-identical" } else { "DIFFER" }, vol, cut, lift);
        assert!(air_same, "a Take that left the live deck out changed the air");
        assert!(taps_same && geq_taps_same, "the live deck's own taps changed");
        assert!(geq_air_differs, "the master GEQ in the Take never landed — the comparison proves nothing");
        assert_eq!(vol, 0.5);
        assert!((lift - 6.0).abs() < 0.2, "A's pending rack is not running: {lift:+.2} dB");
    }

    #[test]
    fn one_take_lands_in_one_buffer_and_allocates_nothing() {
        let mut r = rig(|b| { for i in 0..SLOT_COUNT { play(b, i, tone(200.0 + 50.0 * i as f64, 0.05), false); } });
        for _ in 0..20 { r.step(); }
        const N: [&str; 12] = ["A", "B", "C", "D", "E", "F", "CART", "S1", "S2", "S3", "S4", "S5"];
        let racks = [PEQ_A, COMP, GATE, PEQ_220];
        let slots: Vec<String> = (0..SLOT_COUNT).map(|i| format!(r#""{}":{{"fader":{},"rack":{}}}"#, N[i], 0.3 + 0.05 * i as f32, racks[i % 4])).collect();
        let show = ShowApply::from_json(&format!(r#"{{"slots":{{{}}},"master":{{"fader":0.8,"monitor":0.9,"duck":{{"depthDb":-6,"thresholdDb":-50,"attackMs":10,"holdMs":200,"releaseMs":400}}}}}}"#, slots.join(","))).unwrap();
        let v0: Vec<u64> = { let b = r.bus.lock().unwrap(); (0..SLOT_COUNT).map(|i| b.ch_rack[i].version).collect() };
        let mut p = r.params(); show.apply(&mut p, FS); r.push(p);
        // Queued, not yet adopted: nothing has changed.
        let before = { let b = r.bus.lock().unwrap(); (0..SLOT_COUNT).filter(|&i| b.decks[i].volume != 1.0 || b.ch_rack[i].version != v0[i]).count() + (b.master_vol != 1.0) as usize };
        r.allocs = 0;
        r.step();
        let (vols, racks_moved, master, depth) = {
            let b = r.bus.lock().unwrap();
            ((0..SLOT_COUNT).filter(|&i| (b.decks[i].volume - (0.3 + 0.05 * i as f32)).abs() < 1e-6).count(),
             (0..SLOT_COUNT).filter(|&i| b.ch_rack[i].version != v0[i]).count(), b.master_vol, b.duck_depth_db)
        };
        // 12 ramps + 12 rack crossfades + the master ramp all running, then settled.
        for _ in 0..60 { r.step(); }
        println!("[show-atomic] one Take: 12 faders + 12 racks + master fader + ducker + monitor → 1 Params block · changed before the buffer: {} · after ONE buffer: {}/12 faders, {}/12 racks, master {}, duck depth {} · allocations in the callback over 61 buffers of ramps and crossfades: {}",
                 before, vols, racks_moved, master, depth, r.allocs);
        assert_eq!(before, 0);
        assert_eq!((vols, racks_moved, master, depth), (12, 12, 0.8, -6.0));
        assert_eq!(r.allocs, 0);
    }

    #[test]
    fn a_restored_show_nulls_against_the_same_board_set_by_hand() {
        let setup = |b: &mut BusState| {
            play(b, 0, tone(220.0, 0.3), true);
            play(b, 3, tone(700.0, 0.1), true);
            play(b, 7, tone(1300.0, 0.2), true);
        };
        let go = |r: &mut Rig| { { let mut b = r.bus.lock().unwrap(); for i in [0, 3, 7] { b.decks[i].paused = false; } } for _ in 0..150 { r.step(); } };
        // By hand: one command per buffer, as the operator's drags and clicks arrive — including a fader dragged twice.
        let mut hand = rig(setup);
        let peq = crate::rack::ChannelRack::from_doc_json(PEQ_A).unwrap();
        let comp = crate::rack::ChannelRack::from_doc_json(COMP).unwrap();
        let cmds: Vec<Box<dyn Fn(&mut Params)>> = vec![
            Box::new(|p| p.volume[0] = 0.5),
            Box::new(|p| p.volume[0] = 0.8),
            Box::new(|p| p.volume[3] = 0.6),
            Box::new(move |p| crate::show::set_channel_rack(p, 0, peq, FS)),
            Box::new(move |p| crate::show::set_channel_rack(p, 7, comp, FS)),
            Box::new(|p| p.volume[7] = 0.4),
            Box::new(|p| p.duck_enabled[3] = true),
            Box::new(|p| crate::show::set_master_fader(p, 0.9)),
            Box::new(|p| crate::show::set_duck_params(p, crate::show::DuckParams { depth_db: -9.0, threshold_db: -40.0, attack_ms: 20.0, hold_ms: 300.0, release_ms: 600.0 })),
            Box::new(|p| crate::show::set_monitor(p, 0.7)),
            Box::new(|p| crate::show::set_room(p, 3, 0.5)),
        ];
        for c in cmds.iter() { let mut p = hand.params(); c(&mut p); hand.push(p); hand.step(); }
        go(&mut hand);
        // Cold restart: a fresh engine, the saved show as ONE ApplyShow.
        let mut restored = rig(setup);
        let show = ShowApply::from_json(&format!(r#"{{"slots":{{"A":{{"fader":0.8,"rack":{PEQ_A}}},"D":{{"fader":0.6,"duck":true,"room":0.5}},"S1":{{"fader":0.4,"rack":{COMP}}}}},
            "master":{{"fader":0.9,"monitor":0.7,"duck":{{"depthDb":-9,"thresholdDb":-40,"attackMs":20,"holdMs":300,"releaseMs":600}}}}}}"#)).unwrap();
        let mut p = restored.params(); show.apply(&mut p, FS); restored.push(p); restored.step();
        go(&mut restored);
        let n = hand.stream.len().min(restored.stream.len());
        let tail = |v: &Vec<f32>| v[v.len() - 150 * 480..].to_vec();
        let (hs, rs, hl, rl) = (tail(&hand.stream), tail(&restored.stream), tail(&hand.local), tail(&restored.local));
        let diff = |a: &[f32], b: &[f32]| a.iter().zip(b).filter(|(x, y)| x.to_bits() != y.to_bits()).count();
        let (ds, dl) = (diff(&hs, &rs), diff(&hl, &rl));
        let energy = hs.iter().map(|&v| (v as f64).powi(2)).sum::<f64>();
        println!("[show-restore] board set by hand (11 commands, one per buffer, a fader dragged twice) vs a fresh engine given the saved show as ONE ApplyShow, same input, 150 buffers: stream {} of {} samples differ, local {} of {} · stream energy {:.1} (not silence) · (buffers compared from the stream: {})",
                 ds, hs.len(), dl, hl.len(), energy, n / 480);
        assert!(energy > 1.0, "the null compared silence");
        assert_eq!((ds, dl), (0, 0), "a restored show does not null against the hand-set board");
    }
}

// ── SLICE 8 — THE MASTER EQ STAGE'S COST, BEFORE AND AFTER THE ANALYSER LEAVES THE CALLBACK ─────────────────
// Run on the tree before slice 8 (the eq.rs analyser in the callback: a mono ring write per sample and a 2048-point
// FFT every 1024 samples, in the air EQ AND the room EQ) and after (the analyser gone; the RTA runs on the meter
// thread). Same rows both times, so the difference is the analyser. Recorded, not gated (the existing gates stand).
#[cfg(test)]
mod eq_stage_timing {
    use super::*;

    struct Tone { n: u64, f: f64 }
    impl Iterator for Tone {
        type Item = f32;
        fn next(&mut self) -> Option<f32> { let i = self.n / 2; self.n += 1; Some((0.2 * (2.0 * std::f64::consts::PI * self.f * i as f64 / 44_100.0).sin()) as f32) }
    }
    fn q(v: &mut Vec<u128>, f: f64) -> f64 { v.sort(); v[((v.len() - 1) as f64 * f) as usize] as f64 / 1e6 }

    /// The whole callback with `slots` playing (D in the room when listed). `tap` = the RTA on S1, its analyser
    /// draining OFF the clock (slice 8's own cost; absent in the pre-slice-8 tree).
    fn callback_ms(slots: &[usize], tap: bool) -> (f64, f64, f64, u64) {
        let (prod, mut stream_cons) = HeapRb::<f32>::new(PROGRAM_BUS_BUF).split();
        let mut b = BusState::new(crate::eq::new_shared_eq(44100.0), prod, 44100, Arc::new(AtomicBool::new(true)));
        let h = b.handles.take().unwrap();
        let (_meters, mut loud) = MetersHandle::from_parts(Arc::new(Mutex::new(h.meter_r)), h.shared.clone(), h.loud_cons, h.loud_shared);
        let (mut an, _rr) = crate::rta::RtaAnalyzer::new(h.rta_cons, h.rta_shared);
        if tap { b.rta_target = crate::rta::RtaTarget::Channel(7); }
        for &i in slots {
            b.decks[i].source = Some(DeckFeed::prefilled(Tone { n: 0, f: 220.0 * (i + 1) as f64 }, 480 * 2 * 3200));
            b.decks[i].active = true; b.decks[i].paused = false; b.decks[i].volume = 0.5;
        }
        if slots.contains(&3) { b.aux_monitor_gain[3] = 1.0; }
        let bus = Arc::new(crate::rt::RtMutex::new(b));
        let (fin, playing) = (FinishedFlags::new(), Arc::new(AtomicBool::new(true)));
        let mut sc = Scratch::new();
        let (mut data, mut pop) = (vec![0f32; 960], vec![0f32; PROGRAM_BUS_BUF]);
        let mut ns = Vec::with_capacity(3000);
        let a0 = crate::rt::tl_rt_allocs();
        for _ in 0..3000 {
            let t0 = std::time::Instant::now();
            mixer_callback(&mut data, 2, &bus, &fin, &playing, &mut sc);
            ns.push(t0.elapsed().as_nanos());
            loud.drain();
            an.drain();
            while stream_cons.pop_slice(&mut pop) > 0 {}
        }
        let allocs = crate::rt::tl_rt_allocs() - a0;
        (q(&mut ns, 0.5), q(&mut ns, 0.99), q(&mut ns, 1.0), allocs)
    }

    #[test]
    fn the_master_eq_stage_cost() {
        // The EQ stage alone: one EqChain, 480 stereo frames per call, flat GEQ (the filters are skipped, so what is
        // left is the analyser's work before slice 8 and nothing after). The input is made OFF the clock.
        let mut eq = crate::eq::EqChain::new(44100.0);
        let input: Vec<f32> = (0..480 * 3000).map(|i| (i as f32 * 0.0137).sin() * 0.3).collect();
        let (mut ns, mut acc) = (Vec::with_capacity(3000), 0.0f32);
        for k in 0..3000usize {
            let blk = &input[k * 480..(k + 1) * 480];
            let t0 = std::time::Instant::now();
            for &x in blk { let (l, r) = eq.process_stereo(std::hint::black_box(x), std::hint::black_box(x)); acc += l + r; }
            ns.push(t0.elapsed().as_nanos());
        }
        std::hint::black_box(acc);
        println!("[eq-timing] the master EQ stage alone (one EqChain, 480 frames, flat GEQ): median {:.4} ms · p99 {:.4} ms", q(&mut ns, 0.5), q(&mut ns, 0.99));
        let mut total = 0;
        for (name, slots, tap) in [("A/B/C playing", &[0usize, 1, 2][..], false), ("A/B/C + aux D (room chain + its EQ)", &[0, 1, 2, 3][..], false),
                                   ("A/B/C + S1, no tap", &[0, 1, 2, 7][..], false), ("A/B/C + S1, the RTA tap ON S1", &[0, 1, 2, 7][..], true)] {
            let (m, p, w, a) = callback_ms(slots, tap);
            total += a;
            println!("[eq-timing] callback, {:<40} median {:.4} ms · p99 {:.4} ms · worst {:.3} ms · {} allocations", name, m, p, w, a);
        }
        assert_eq!(total, 0);
    }
}

// ── SLICE 8 — the RTA through the real mixer callback and the real analyser (docs/dsp-channel-rta.md §4) ─────────
#[cfg(test)]
mod rta_through_the_mixer {
    use super::*;
    use crate::rta::{RtaAnalyzer, RtaTarget, RTA_BANDS, RTA_CENTRES, RTA_HOP, RTA_FFT, band_edges, coarse_below_hz};

    const FS: f64 = 44_100.0;
    /// A −18 dBFS (sine peak) log sweep f0→f1 over `secs`, the same sample on L and R.
    struct Sweep { n: u64, f0: f64, f1: f64, secs: f64, amp: f64 }
    impl Iterator for Sweep {
        type Item = f32;
        fn next(&mut self) -> Option<f32> {
            let i = (self.n / 2) as f64 / FS; self.n += 1;
            let k = self.f1 / self.f0;
            let ph = 2.0 * std::f64::consts::PI * self.f0 * self.secs / k.ln() * (k.powf(i / self.secs) - 1.0);
            Some((self.amp * ph.sin()) as f32)
        }
    }
    fn sweep_freq(t: f64, f0: f64, f1: f64, secs: f64) -> f64 { f0 * (f1 / f0).powf(t / secs) }
    /// Deterministic pink noise (Paul Kellett's filter on an LCG), the same sample on L and R.
    struct Pink { s: u64, b: [f64; 7], cur: f32, half: bool }
    fn pink() -> Pink { Pink { s: 99, b: [0.0; 7], cur: 0.0, half: false } }
    impl Iterator for Pink {
        type Item = f32;
        fn next(&mut self) -> Option<f32> {
            if self.half { self.half = false; return Some(self.cur); }
            self.s = self.s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let w = ((self.s >> 11) as f64 / (1u64 << 53) as f64) * 2.0 - 1.0;
            let b = &mut self.b;
            b[0] = 0.99886 * b[0] + w * 0.0555179; b[1] = 0.99332 * b[1] + w * 0.0750759; b[2] = 0.96900 * b[2] + w * 0.1538520;
            b[3] = 0.86650 * b[3] + w * 0.3104856; b[4] = 0.55000 * b[4] + w * 0.5329522; b[5] = -0.7616 * b[5] - w * 0.0168980;
            let p = b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + w * 0.5362;
            b[6] = w * 0.115926;
            self.cur = (p * 0.05) as f32; self.half = true;
            Some(self.cur)
        }
    }

    struct Rig { bus: SharedBusState, cmd: HeapProd<RtCmd>, garbage: HeapCons<Garbage>, stream: HeapCons<f32>, an: RtaAnalyzer,
                 fin: FinishedFlags, playing: Arc<AtomicBool>, sc: Box<Scratch>, data: Vec<f32>, pop: Vec<f32>, allocs: u64 }
    fn rig(setup: impl FnOnce(&mut BusState, &mut Params)) -> Rig {
        let (prod, stream) = HeapRb::<f32>::new(PROGRAM_BUS_BUF).split();
        let mut b = BusState::new(crate::eq::new_shared_eq(44100.0), prod, 44100, Arc::new(AtomicBool::new(true)));
        let h = b.handles.take().unwrap();
        let (an, _r) = RtaAnalyzer::new(h.rta_cons, h.rta_shared);
        let mut p = b.params();
        setup(&mut b, &mut p);
        let mut cmd = h.cmd_prod;
        let _ = cmd.try_push(RtCmd::Params(Box::new(p)));
        Rig { bus: Arc::new(crate::rt::RtMutex::new(b)), cmd, garbage: h.garbage_cons, stream, an, fin: FinishedFlags::new(),
              playing: Arc::new(AtomicBool::new(true)), sc: Scratch::new(), data: vec![0f32; 960], pop: vec![0f32; PROGRAM_BUS_BUF], allocs: 0 }
    }
    impl Rig {
        /// One buffer through the real callback, then the meter thread's drain. Returns the frames analysed.
        fn step(&mut self) -> usize {
            let a0 = crate::rt::tl_rt_allocs();
            mixer_callback(&mut self.data, 2, &self.bus, &self.fin, &self.playing, &mut self.sc);
            self.allocs += crate::rt::tl_rt_allocs() - a0;
            while self.stream.pop_slice(&mut self.pop) > 0 {}
            while self.garbage.try_pop().is_some() {}
            self.an.drain()
        }
    }
    fn play(b: &mut BusState, i: usize, src: impl Iterator<Item = f32> + Send + 'static, frames: usize) {
        b.decks[i].source = Some(DeckFeed::prefilled(src, frames * 2 + 4800));
        b.decks[i].active = true; b.decks[i].paused = false; b.decks[i].volume = 1.0;
    }
    fn is_coarse(b: usize) -> bool { (RTA_CENTRES[b] as f64) < coarse_below_hz() as f64 - 1.0 }

    #[test]
    fn a_minus_18_dbfs_sweep_lands_in_the_right_band_at_minus_18() {
        let (f0, f1, secs) = (20.0, 20_000.0, 60.0);
        let frames = (secs * FS) as usize;
        let amp = 10f64.powf(-18.0 / 20.0);
        let mut r = rig(|b, p| { play(b, 7, Sweep { n: 0, f0, f1, secs, amp }, frames); p.rta = RtaTarget::Channel(7); });
        let (mut best, mut when) = ([f32::MIN; RTA_BANDS], [0usize; RTA_BANDS]);
        let mut analysed = 0usize;
        for _ in 0..frames / 480 {
            if r.step() > 0 {
                analysed += 1;
                for b in 0..RTA_BANDS { if r.an.raw[0][b] > best[b] { best[b] = r.an.raw[0][b]; when[b] = analysed; } }
            }
        }
        let (mut worst_lvl, mut misses) = (0.0f64, Vec::new());
        let mut lines = Vec::new();
        for b in 0..RTA_BANDS {
            // the analysis window of that frame: the last RTA_FFT samples ending at frame `when[b]`'s hop
            let t = ((when[b] * RTA_HOP) as f64 - RTA_FFT as f64 / 2.0) / FS;
            let f = sweep_freq(t, f0, f1, secs);
            let (lo, hi) = band_edges(b);
            let inside = f >= lo * 0.99 && f <= hi * 1.01;
            let dev = best[b] as f64 + 18.0;
            lines.push(format!("{}:{:+.2}{}", RTA_CENTRES[b], best[b], if is_coarse(b) { "c" } else { "" }));
            if !is_coarse(b) {
                if dev.abs() > worst_lvl.abs() { worst_lvl = dev; }
                if !inside { misses.push(format!("{} Hz peaked at {:.0} Hz", RTA_CENTRES[b], f)); }
            }
        }
        println!("[rta-sweep] −18 dBFS log sweep 20 Hz→20 kHz over 60 s on S1, RTA on S1, through the real callback + meter-thread analysis ({} frames): each band's peak (dB; c = coarse, below {} Hz): {}",
                 analysed, coarse_below_hz(), lines.join(" "));
        println!("[rta-sweep] every band ≥ {} Hz: peak −18 {:+.2} dB at worst (bar ±0.5), and it peaked while the sweep was inside it: {}",
                 coarse_below_hz(), worst_lvl, if misses.is_empty() { "all 31 − coarse".to_string() } else { misses.join("; ") });
        assert!(misses.is_empty(), "a band peaked while the sweep was elsewhere: {:?}", misses);
        assert!(worst_lvl.abs() <= 0.5, "a band read {:+.2} dB off −18", worst_lvl);
        assert_eq!(r.allocs, 0);
    }

    /// |H|² of a channel-rack plan at f (its biquad stages — Filters here).
    fn plan_power(spec: &crate::rack::ChainSpec, f: f64) -> f64 {
        let w = 2.0 * std::f64::consts::PI * f / FS;
        let (c1, s1, c2, s2) = (w.cos(), -w.sin(), (2.0 * w).cos(), -(2.0 * w).sin());
        let mut p = 1.0;
        for k in 0..spec.n {
            if spec.kind[k] != crate::rack::KIND_BQ { continue; }
            let q = spec.bq[k];
            let (nr, ni) = (q.b0 + q.b1 * c1 + q.b2 * c2, q.b1 * s1 + q.b2 * s2);
            let (dr, di) = (1.0 + q.a1 * c1 + q.a2 * c2, q.a1 * s1 + q.a2 * s2);
            p *= (nr * nr + ni * ni) / (dr * dr + di * di);
        }
        p
    }
    /// A band's expected level change from a response: pink noise = equal power per log frequency, so the band's power
    /// ratio is the response averaged uniformly in log f across the band.
    fn band_expect(b: usize, mut h2: impl FnMut(f64) -> f64) -> f64 {
        let (lo, hi) = band_edges(b);
        let n = 64;
        let m: f64 = (0..n).map(|i| h2(lo * (hi / lo).powf((i as f64 + 0.5) / n as f64))).sum::<f64>() / n as f64;
        10.0 * m.log10()
    }
    /// Run pink noise with RTA on `target` for `secs`; return the time-averaged (power) post−pre per band, dB.
    fn post_minus_pre(mut r: Rig, secs: f64) -> ([f64; RTA_BANDS], u64) {
        let (mut sp, mut sq) = ([0.0f64; RTA_BANDS], [0.0f64; RTA_BANDS]);
        let settle = 20;
        let mut k = 0;
        for _ in 0..(secs * FS / 480.0) as usize {
            if r.step() > 0 {
                k += 1;
                if k > settle { for b in 0..RTA_BANDS { sp[b] += 10f64.powf(r.an.raw[0][b] as f64 / 10.0); sq[b] += 10f64.powf(r.an.raw[1][b] as f64 / 10.0); } }
            }
        }
        (std::array::from_fn(|b| 10.0 * (sq[b] / sp[b]).log10()), r.allocs)
    }

    #[test]
    fn hpf_100_hz_post_minus_pre_is_the_filters_own_curve() {
        let doc = r#"{"v":1,"sections":{"ch":[{"module":{"type":"filters","hpf":{"in":true,"freq":100},"lpf":{"in":false,"freq":10000}},"in":true}]}}"#;
        let rack = crate::rack::ChannelRack::from_doc_json(doc).unwrap();
        let plan = rack.plan(FS);
        let secs = 40.0;
        let r = rig(|b, p| {
            play(b, 7, pink(), (secs * FS) as usize);
            crate::show::set_channel_rack(p, 7, rack, FS);
            p.rta = RtaTarget::Channel(7);
        });
        let (d, allocs) = post_minus_pre(r, secs);
        let (mut worst, mut worst_hi) = (0.0f64, 0.0f64);
        let mut lines = Vec::new();
        for b in 0..RTA_BANDS {
            let e = band_expect(b, |f| plan_power(&plan, f));
            let err = d[b] - e;
            lines.push(format!("{}:{:+.1}/{:+.1}{}", RTA_CENTRES[b], d[b], e, if is_coarse(b) { "c" } else { "" }));
            if !is_coarse(b) { if err.abs() > worst.abs() { worst = err; } }
            if RTA_CENTRES[b] >= 200.0 && d[b].abs() > worst_hi.abs() { worst_hi = d[b]; }
        }
        println!("[rta-hpf] pink noise on S1, Filters HPF 100 Hz IN, 40 s: post−pre measured/expected (the filter's own curve over each band), dB: {}", lines.join(" "));
        println!("[rta-hpf] bands ≥ {} Hz: worst error {:+.2} dB (bar ±1) · at and above 200 Hz post−pre stays within {:+.2} dB of 0 · {} allocations",
                 coarse_below_hz(), worst, worst_hi, allocs);
        assert!(worst.abs() <= 1.0, "post−pre is {:+.2} dB off the filter's own curve", worst);
        assert!(worst_hi.abs() <= 0.3, "above 200 Hz the HPF should be ~0 dB, read {:+.2}", worst_hi);
        assert_eq!(allocs, 0);
    }

    #[test]
    fn geq_plus_6_at_1_khz_shows_plus_6_on_the_master() {
        let secs = 30.0;
        let mut bands = [0.0f32; 10];
        bands[5] = 6.0;   // 1 kHz
        let r = rig(|b, p| {
            play(b, 0, pink(), (secs * FS) as usize);
            p.rack.set_geq_bands(bands);
            p.rack.eq_version = p.rack.eq_version.wrapping_add(1);
            p.rta = RtaTarget::Master;
        });
        let (d, allocs) = post_minus_pre(r, secs);
        // The GEQ's own response, measured by running its EqChain on steady sines (the engine's filters, no model).
        let mut eq = crate::eq::EqChain::new(44100.0);
        eq.set_bands(&bands);
        let mut gain2 = |f: f64| -> f64 {
            let n = 44_100 / 5;
            let (mut si, mut so) = (0.0f64, 0.0f64);
            for i in 0..n { let x = (2.0 * std::f64::consts::PI * f * i as f64 / FS).sin() as f32 * 0.1; let (y, _) = eq.process_stereo(x, x); if i > n / 2 { si += (x as f64).powi(2); so += (y as f64).powi(2); } }
            so / si
        };
        let b1k = 17;
        let e1k = band_expect(b1k, &mut gain2);
        let lines: Vec<String> = (12..24).map(|b| format!("{}:{:+.2}", RTA_CENTRES[b], d[b])).collect();
        println!("[rta-geq] pink noise on A, master GEQ 1 kHz +6 dB IN, RTA on the MASTER, 30 s: post−pre around it: {} · the 1 kHz band reads {:+.2} dB (the GEQ's own curve over that band: {:+.2}; its peak at 1 kHz: {:+.2}) · {} allocations",
                 lines.join(" "), d[b1k], e1k, 10.0 * gain2(1000.0).log10(), allocs);
        assert!((d[b1k] - e1k).abs() <= 0.5, "the master RTA read {:+.2} at 1 kHz, the GEQ's curve says {:+.2}", d[b1k], e1k);
        assert!((d[b1k] - 6.0).abs() <= 0.5, "GEQ +6 at 1 kHz read {:+.2}", d[b1k]);
        assert_eq!(allocs, 0);
    }

    #[test]
    fn nothing_is_copied_when_nothing_is_subscribed_and_only_the_chosen_channel_when_one_is() {
        // Every fader playing; RTA None.
        let mut r = rig(|b, _p| { for i in 0..SLOT_COUNT { play(b, i, pink(), 480 * 3100); } });
        for _ in 0..3000 { r.step(); }
        let sh = { let b = r.bus.lock().unwrap(); (b.rta.shared.pushed.load(Ordering::Relaxed), b.rta.shared.dropped.load(Ordering::Relaxed)) };
        // S1 chosen but silent; S2 loud: nothing of S2 may reach the rings.
        let mut r2 = rig(|b, p| {
            play(b, 7, std::iter::repeat(0.0f32), 480 * 1100);
            play(b, 8, pink(), 480 * 1100);
            p.rta = RtaTarget::Channel(7);
        });
        for _ in 0..1000 { r2.step(); }
        let loudest = r2.an.raw[0].iter().chain(r2.an.raw[1].iter()).cloned().fold(f32::MIN, f32::max);
        let pushed2 = r2.bus.lock().unwrap().rta.shared.pushed.load(Ordering::Relaxed);
        println!("[rta-idle] 12 faders playing, RTA unsubscribed, 3000 buffers: {} frames pushed, {} dropped, {} allocations · S1 chosen (silent) with S2 playing pink noise: {} frames pushed, loudest band {:.1} dB (the floor is -120)",
                 sh.0, sh.1, r.allocs, pushed2, loudest);
        assert_eq!(sh, (0, 0), "the callback copied audio with nothing subscribed");
        assert!(pushed2 > 0 && loudest <= -119.9, "another channel reached the RTA");
        assert_eq!(r.allocs + r2.allocs, 0);
    }

    #[test]
    fn the_tap_never_allocates_with_every_rack_crossfading() {
        let peq = crate::rack::ChannelRack::from_doc_json(r#"{"v":1,"sections":{"ch":[{"module":{"type":"peq","bands":[{"freq":100,"gain":3,"width":1},{"freq":1000,"gain":-3,"width":1},{"freq":3000,"gain":2,"width":1},{"freq":8000,"gain":0,"width":1}]},"in":true}]}}"#).unwrap();
        let mut r = rig(|b, p| { for i in 0..SLOT_COUNT { play(b, i, pink(), 480 * 700); } p.rta = RtaTarget::Channel(7); });
        for k in 0..600 {
            if k % 20 == 0 {
                let mut p = r.bus.lock().unwrap().params();
                for i in 0..SLOT_COUNT { crate::show::set_channel_rack(&mut p, i, if (k / 20) % 2 == 0 { peq } else { crate::rack::ChannelRack::default() }, FS); }
                p.rta = if (k / 100) % 2 == 0 { RtaTarget::Channel(7) } else { RtaTarget::Master };
                let _ = r.cmd.try_push(RtCmd::Params(Box::new(p)));
            }
            r.step();
        }
        println!("[rta-trap] 12 faders playing, all 12 racks crossfading every 20 buffers, the RTA switching between S1 and the master: {} allocations in the callback over 600 buffers", r.allocs);
        assert_eq!(r.allocs, 0);
    }
}

// ── SLICE 8 — OLD vs NEW spectrum, for the screenshots in docs/dsp-channel-rta.md (run on demand) ────────────────
// The same music (goldens/inputs/music.wav) through the real callback, RTA on the MASTER, a GEQ setting IN. At one
// moment it writes (ETHER_WRITE_RTA_SCREENS = the output path):
//   · NEW — the real meter-thread frame (fine wave + bands, pre and post), as the views get it;
//   · OLD — what the pre-slice-8 analyser showed for the same post-GEQ samples: its update_spectrum, VERBATIM from
//     eq.rs at 2b9f1cf (2048-point FFT every 1024 samples, octave bands, normalised to a running peak, 0…1.2), and
//     the deleted MasterEQRack's peak hold (max(s, p × 0.985) per update).
#[cfg(test)]
mod rta_screens_fixture {
    use super::*;
    use crate::rta::{RtaAnalyzer, RtaTarget};

    /// eq.rs@2b9f1cf's analyser, kept verbatim in its maths (only the struct around it is local).
    struct OldAnalyser { ring: Vec<f32>, pos: usize, since: usize, fft: Arc<dyn rustfft::Fft<f32>>, scratch: Vec<rustfft::num_complex::Complex<f32>>,
                         work: Vec<rustfft::num_complex::Complex<f32>>, window: Vec<f32>, spectrum: [f32; 10], peak: f32, sr: f32 }
    const OLD_FFT: usize = 2048;
    const OLD_INTERVAL: usize = 1024;
    impl OldAnalyser {
        fn new(sr: f32) -> Self {
            let mut p = rustfft::FftPlanner::new();
            let fft = p.plan_fft_forward(OLD_FFT);
            let wl = fft.get_inplace_scratch_len();
            let window = (0..OLD_FFT).map(|n| { let x = n as f32 / (OLD_FFT as f32 - 1.0); 0.5 - 0.5 * (2.0 * std::f32::consts::PI * x).cos() }).collect();
            OldAnalyser { ring: vec![0.0; OLD_FFT], pos: 0, since: 0, fft, scratch: vec![Default::default(); OLD_FFT], work: vec![Default::default(); wl],
                          window, spectrum: [0.0; 10], peak: 0.05, sr }
        }
        /// Returns true when it updated (every 1024 samples).
        fn push(&mut self, mono: f32) -> bool {
            self.ring[self.pos] = mono; self.pos = (self.pos + 1) % OLD_FFT; self.since += 1;
            if self.since >= OLD_INTERVAL { self.since = 0; self.update(); true } else { false }
        }
        fn update(&mut self) {
            use rustfft::num_complex::Complex;
            for i in 0..OLD_FFT { let idx = (self.pos + i) % OLD_FFT; self.scratch[i] = Complex::new(self.ring[idx] * self.window[i], 0.0); }
            self.fft.process_with_scratch(&mut self.scratch, &mut self.work);
            let half = OLD_FFT / 2;
            let bin_hz = self.sr / OLD_FFT as f32;
            let mut mags = [0.0f32; OLD_FFT / 2];
            let mut frame_peak = 0.0f32;
            for i in 0..half { let c = self.scratch[i]; let m = (c.re * c.re + c.im * c.im).sqrt(); mags[i] = m; if m > frame_peak { frame_peak = m; } }
            self.peak = (self.peak * 0.995).max(frame_peak * 0.7).max(0.05);
            for (band_idx, &f0) in crate::eq::EQ_FREQS.iter().enumerate() {
                let low = f0 / std::f32::consts::SQRT_2;
                let high = f0 * std::f32::consts::SQRT_2;
                let bin_lo = ((low / bin_hz) as usize).max(1);
                let bin_hi = ((high / bin_hz) as usize).min(half - 1).max(bin_lo);
                let (mut sum, mut count) = (0.0f32, 0usize);
                for bi in bin_lo..=bin_hi { sum += mags[bi]; count += 1; }
                let avg = if count > 0 { sum / count as f32 } else { 0.0 };
                let norm = (avg / self.peak).clamp(0.0, 4.0);
                let db = 20.0 * (norm + 1e-6).log10();
                let level = ((db + 60.0) / 60.0).clamp(0.0, 1.2);
                let prev = self.spectrum[band_idx];
                let coeff = if level > prev { 0.6 } else { 0.15 };
                self.spectrum[band_idx] = prev + (level - prev) * coeff;
            }
        }
    }

    #[test]
    fn write_the_rta_screens_fixture() {
        let Ok(out) = std::env::var("ETHER_WRITE_RTA_SCREENS") else { return; };
        let wav = crate::offline_render::read_wav_f32(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("goldens").join("inputs").join("music.wav")).unwrap();
        let at_s = 22.0f64;                                // the moment captured
        let frames = ((at_s + 0.5) * 44_100.0) as usize;
        let (prod, mut stream) = HeapRb::<f32>::new(PROGRAM_BUS_BUF).split();
        let mut b = BusState::new(crate::eq::new_shared_eq(44100.0), prod, 44100, Arc::new(AtomicBool::new(true)));
        let h = b.handles.take().unwrap();
        let (mut an, reader) = RtaAnalyzer::new(h.rta_cons, h.rta_shared);
        let src: Vec<f32> = wav[..(frames * 2).min(wav.len())].to_vec();
        b.decks[0].source = Some(DeckFeed::prefilled(src.into_iter(), frames * 2 + 4800));
        b.decks[0].active = true; b.decks[0].paused = false; b.decks[0].volume = 1.0;
        let geq = [0.0f32, 3.0, 0.0, -4.0, 0.0, 6.0, 0.0, 0.0, -3.0, 0.0];   // shown in both views
        let mut p = b.params();
        p.rack.set_geq_bands(geq);
        p.rack.eq_version = p.rack.eq_version.wrapping_add(1);
        p.rta = RtaTarget::Master;
        let mut cmd = h.cmd_prod;
        let _ = cmd.try_push(RtCmd::Params(Box::new(p)));
        let bus = Arc::new(crate::rt::RtMutex::new(b));
        let (fin, playing) = (FinishedFlags::new(), Arc::new(AtomicBool::new(true)));
        let mut sc = Scratch::new();
        let (mut data, mut pop) = (vec![0f32; 960], vec![0f32; PROGRAM_BUS_BUF]);
        // The OLD analyser listens to the same post-GEQ programme: the stream ring carries it (processing off,
        // master at unity), so it hears exactly what the old one did.
        let mut old = OldAnalyser::new(44_100.0);
        let mut old_peak = [0.0f32; 10];
        let mut garbage = h.garbage_cons;
        for _ in 0..(at_s * 44_100.0 / 480.0) as usize {
            mixer_callback(&mut data, 2, &bus, &fin, &playing, &mut sc);
            loop {
                let got = stream.pop_slice(&mut pop);
                if got == 0 { break; }
                for fr in 0..got / 2 {
                    if old.push(0.5 * (pop[2 * fr] + pop[2 * fr + 1])) {
                        for i in 0..10 { old_peak[i] = old.spectrum[i].max(old_peak[i] * 0.985); }
                    }
                }
            }
            while garbage.try_pop().is_some() {}
            an.drain();
        }
        let f = reader.lock().unwrap().read();
        // …and a CHANNEL: the same music on S1 through its rack (HPF 100 Hz + a PEQ), RTA on S1 — pre vs post-rack.
        let ch_doc = r#"{"v":1,"sections":{"ch":[{"id":"f","module":{"type":"filters","hpf":{"in":true,"freq":100},"lpf":{"in":false,"freq":12000}},"in":true},{"id":"q","module":{"type":"peq","bands":[{"freq":250,"gain":-5,"width":1.2},{"freq":2500,"gain":4,"width":1},{"freq":5000,"gain":0,"width":1},{"freq":10000,"gain":3,"width":1,"shelf":true}]},"in":true}]}}"#;
        let cf = {
            let (prod, mut stream) = HeapRb::<f32>::new(PROGRAM_BUS_BUF).split();
            let mut b = BusState::new(crate::eq::new_shared_eq(44100.0), prod, 44100, Arc::new(AtomicBool::new(true)));
            let h = b.handles.take().unwrap();
            let (mut an, reader) = RtaAnalyzer::new(h.rta_cons, h.rta_shared);
            let src: Vec<f32> = wav[..(frames * 2).min(wav.len())].to_vec();
            b.decks[7].source = Some(DeckFeed::prefilled(src.into_iter(), frames * 2 + 4800));
            b.decks[7].active = true; b.decks[7].paused = false; b.decks[7].volume = 1.0;
            let mut p = b.params();
            crate::show::set_channel_rack(&mut p, 7, crate::rack::ChannelRack::from_doc_json(ch_doc).unwrap(), 44_100.0);
            p.rta = RtaTarget::Channel(7);
            let mut cmd = h.cmd_prod;
            let _ = cmd.try_push(RtCmd::Params(Box::new(p)));
            let bus = Arc::new(crate::rt::RtMutex::new(b));
            let mut garbage = h.garbage_cons;
            let mut sc = Scratch::new();
            for _ in 0..(at_s * 44_100.0 / 480.0) as usize {
                mixer_callback(&mut data, 2, &bus, &fin, &playing, &mut sc);
                while stream.pop_slice(&mut pop) > 0 {}
                while garbage.try_pop().is_some() {}
                an.drain();
            }
            let r = reader.lock().unwrap().read(); r
        };
        let j = serde_json::json!({
            "source": "native/goldens/inputs/music.wav", "atSeconds": at_s, "geq": geq, "eqFreqs": crate::eq::EQ_FREQS,
            "old": { "spectrum": old.spectrum, "peaks": old_peak, "note": "eq.rs@2b9f1cf update_spectrum on the post-GEQ programme; MasterEQRack peak hold" },
            "new": { "fed": f.fed, "coarseBelowHz": crate::rta::coarse_below_hz(), "finePre": f.fine_pre.to_vec(), "finePost": f.fine_post.to_vec(),
                     "pre": f.pre.to_vec(), "post": f.post.to_vec(), "fineN": crate::rta::RTA_FINE, "fineLoHz": 20, "fineHiHz": 20000 },
            "channel": { "doc": serde_json::from_str::<serde_json::Value>(ch_doc).unwrap(), "fed": cf.fed, "coarseBelowHz": crate::rta::coarse_below_hz(),
                         "finePre": cf.fine_pre.to_vec(), "finePost": cf.fine_post.to_vec(), "pre": cf.pre.to_vec(), "post": cf.post.to_vec(),
                         "fineN": crate::rta::RTA_FINE, "fineLoHz": 20, "fineHiHz": 20000 },
        });
        std::fs::write(&out, serde_json::to_string_pretty(&j).unwrap()).unwrap();
        println!("[rta-screens] wrote {} (music.wav at {} s, GEQ {:?}; new fed {})", out, at_s, geq, f.fed);
        assert!(f.fed && cf.fed);
    }
}
