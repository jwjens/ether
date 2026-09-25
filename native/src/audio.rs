use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use ringbuf::{HeapRb, HeapProd, HeapCons, traits::{Producer, Consumer, Observer, Split}};
use crate::rt::{Params, RtCmd, AuxCmd, Garbage, MeterFrame, DeckMeter, RtShared, TripleWriter, TripleReader,
                RT_CMD_QUEUE, RT_CMD_PER_BUFFER, RT_GARBAGE_QUEUE, triple, DeckFeed, Feeder, DeckSource,
                deck_feed, deck_worker, DECK_REFILL_BELOW, RtCounters, RtScope, rt_allocs, FtzScope,
                MeterBlock, MeterTap, BUS_PGM, BUS_LOCAL, BUS_STREAM, BUS_MONITOR, BUS_ROOM, BUS_AUX};

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
    /// 10-band post-EQ master spectrum (0..~1 normalized magnitude), computed by the
    /// master EQ analyzer and surfaced for the Master EQ rack's live FFT display.
    #[serde(default)]
    pub spectrum: [f32; 10],
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

/// SLICE 2 — what audio_get_meters needs: the station's ONE meter-frame reader (the same triple buffer
/// GetLevel reads — shared behind a mutex between the two NON-audio threads that read it; the callback never
/// sees this lock) and the atomic that acknowledges a consumed window (docs/dsp-meter-bus.md §1.2, §1.4).
#[derive(Clone)]
pub struct MetersHandle {
    pub(crate) reader: Arc<Mutex<TripleReader<MeterFrame>>>,
    pub(crate) shared: Arc<RtShared>,
}
impl MetersHandle {
    /// Read the newest meter window and acknowledge it. Returns the block (raw peaks + Σ² + frame count).
    pub(crate) fn read_and_ack(&self) -> Option<MeterBlock> {
        let f = self.reader.lock().ok()?.read();
        self.shared.meter_ack.store(f.meters.epoch, Ordering::Release);
        Some(f.meters)
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
    /// 10-band post-EQ master spectrum snapshot, written by mixer_callback from the
    /// EQ analyzer each buffer; read by GetLevel into AudioLevels.spectrum.
    pub spectrum:    [f32; 10],
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
    pub processor:   Arc<Mutex<crate::program_processor::ProgramProcessor>>,

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
    pub processor_stream: Arc<Mutex<crate::program_processor::ProgramProcessor>>,
    /// PER-BRANCH METERS. One set of numbers for two processors would be a meter that lies: with the
    /// split on, the two branches ride to different targets and reduce by different amounts at the same
    /// instant. The legacy proc_* fields keep describing the LOCAL branch, and mirror the stream branch
    /// when only the stream is processing, so every existing reader keeps working unchanged.
    pub proc_stream_in_lufs: f32,
    pub proc_stream_out_lufs: f32,
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
    /// Frames the AUX output callback has actually written to its device. "The stream opened" is not
    /// evidence that audio is flowing; this is. Surfaced as `aux_frames` in getLevels so the panel —
    /// and any probe — can tell a live aux feed from an open-but-starved one.
    pub aux_out_frames: Arc<AtomicU64>,
    /// The AUX feed's own instance of the EXISTING program processor (the loudness ride + -1 dBTP
    /// limiter already in Preferences). Its own, because the processor is stateful and the air and
    /// room chains are already using theirs on different sums this callback.
    pub processor_aux: Arc<Mutex<crate::program_processor::ProgramProcessor>>,
    /// The AUX processor's OBSERVED meters — the same four the station's processor reports
    /// (proc_in_lufs / proc_out_lufs / proc_gr_db / proc_ride_gain_db), taken at the same taps on the
    /// same processor type. They exist so the Health Monitor can show deck processing with the same
    /// meters and the same grammar as a station, rather than a parallel readout.
    pub aux_proc_in_lufs:  f32,
    pub aux_proc_out_lufs: f32,
    pub aux_proc_gr_db:    f32,
    pub aux_proc_ride_db:  f32,
    /// PEAK OF THE AUX FEED — the level actually being sent to the aux device, after the deck's
    /// fader/cut AND the slot level. Distinct from `decks[].peak` (which is the DECK, regardless of
    /// any slot) and from `room_peak` (the station's speakers). Without this there was no way to ask
    /// "is the aux monitor making sound", and a probe that used the deck peak instead reported a
    /// control as broken when it was working.
    pub aux_peak: f32,
    pub eq_room:        crate::eq::SharedEq,
    pub processor_room: Arc<Mutex<crate::program_processor::ProgramProcessor>>,
    /// Processing meters written by mixer_callback (observed), read by GetLevel → the daemon meter event.
    pub proc_in_peak:  f32,
    pub proc_out_peak: f32,
    pub proc_in_lufs:  f32,
    pub proc_out_lufs: f32,
    pub proc_gr_db:    f32,
    pub proc_ride_gain_db: f32,

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
    /// The dispatch-side ends, created with the state and taken once by start_station_mixer.
    pub(crate) handles: Option<BusHandles>,
    /// SLICE 2 — the meter bus's current read window (docs/dsp-meter-bus.md §1.2). A fixed field: the
    /// callback folds each buffer's taps into it; the reader acknowledges an epoch; the callback then starts
    /// the next window. Published inside every MeterFrame.
    pub(crate) meters_acc: MeterBlock,
}

/// The non-callback ends of BusState's channels (see BusState::handles).
pub(crate) struct BusHandles {
    pub cmd_prod: HeapProd<RtCmd>,
    pub aux_cmd_prod: HeapProd<AuxCmd>,
    pub garbage_cons: HeapCons<Garbage>,
    pub meter_r: TripleReader<MeterFrame>,
    pub shared: Arc<RtShared>,
}

impl BusState {
    pub fn new(eq: crate::eq::SharedEq, ring_prod: HeapProd<f32>, sample_rate: u32, stream_connected: Arc<AtomicBool>) -> Self {
        // S3 — the channels. Created with the state so a state can never exist without them; the
        // dispatch-side ends wait in `handles` until start_station_mixer takes them (tests never do —
        // they drive the state directly, exactly as before).
        let (cmd_prod, cmd_cons) = HeapRb::<RtCmd>::new(RT_CMD_QUEUE).split();
        let (aux_cmd_prod, aux_cmd_cons) = HeapRb::<AuxCmd>::new(16).split();
        let (garbage, garbage_cons) = HeapRb::<Garbage>::new(RT_GARBAGE_QUEUE).split();
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
            spectrum:    [0.0; 10],
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
            processor:   Arc::new(Mutex::new(crate::program_processor::ProgramProcessor::new(sample_rate as f32, -14.0))),
            // The stream branch starts as an exact copy of the shipped chain — same target, same
            // ceiling, same release, same ride. Nothing about a fresh station is different.
            proc_stream_target_lufs: -14.0,
            proc_stream_ceiling_dbtp: -1.0,
            proc_stream_release_ms: 120.0,
            proc_stream_ride_rate: 1.5,
            proc_stream_ride_clamp: 12.0,
            proc_stream_ride_bypass: false,
            proc_stream_limiter_bypass: false,
            processor_stream: Arc::new(Mutex::new(crate::program_processor::ProgramProcessor::new(sample_rate as f32, -14.0))),
            proc_stream_in_lufs: -70.0, proc_stream_out_lufs: -70.0,
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
            duck_gain: 1.0,
            duck_hold_left_ms: 0.0,
            aux_ring_prod: None,          // no aux device open → nowhere to send, by construction
            aux_out_frames: Arc::new(AtomicU64::new(0)),
            aux_peak: 0.0,
            processor_aux: Arc::new(Mutex::new(crate::program_processor::ProgramProcessor::new(sample_rate as f32, -14.0))),
            aux_proc_in_lufs: -70.0,
            aux_proc_out_lufs: -70.0,
            aux_proc_gr_db: 0.0,
            aux_proc_ride_db: 0.0,
            room_peak: 0.0,
            eq_room:        crate::eq::new_shared_eq(sample_rate as f32),
            processor_room: Arc::new(Mutex::new(crate::program_processor::ProgramProcessor::new(sample_rate as f32, -14.0))),
            proc_in_peak: 0.0, proc_out_peak: 0.0,
            proc_in_lufs: -70.0, proc_out_lufs: -70.0, proc_gr_db: 0.0, proc_ride_gain_db: 0.0,
            cmd_cons,
            aux_cmd_cons,
            garbage,
            counters: RtCounters::new(),
            meter_w: None,
            shared: shared.clone(),
            eq_bands: [0.0; 10],
            eq_version_applied: 0,
            handles: None,
            meters_acc: MeterBlock { epoch: 1, ..MeterBlock::default() },
        };
        // The meter channel starts on THIS state's own first frame, so the first read is the truth.
        let (w, meter_r) = triple(b.meter_frame());
        b.meter_w = Some(w);
        b.handles = Some(BusHandles { cmd_prod, aux_cmd_prod, garbage_cons, meter_r, shared });
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
            proc_target_lufs: self.proc_target_lufs,
            proc_ceiling_dbtp: self.proc_ceiling_dbtp,
            proc_release_ms: self.proc_release_ms,
            proc_ride_rate: self.proc_ride_rate,
            proc_ride_clamp: self.proc_ride_clamp,
            proc_ride_bypass: self.proc_ride_bypass,
            proc_limiter_bypass: self.proc_limiter_bypass,
            proc_stream_target_lufs: self.proc_stream_target_lufs,
            proc_stream_ceiling_dbtp: self.proc_stream_ceiling_dbtp,
            proc_stream_release_ms: self.proc_stream_release_ms,
            proc_stream_ride_rate: self.proc_stream_ride_rate,
            proc_stream_ride_clamp: self.proc_stream_ride_clamp,
            proc_stream_ride_bypass: self.proc_stream_ride_bypass,
            proc_stream_limiter_bypass: self.proc_stream_limiter_bypass,
            duck_threshold: self.duck_threshold,
            duck_depth_db: self.duck_depth_db,
            duck_attack_ms: self.duck_attack_ms,
            duck_hold_ms: self.duck_hold_ms,
            duck_release_ms: self.duck_release_ms,
            eq_bands: self.eq_bands,
            eq_version: self.eq_version_applied,
        }
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
        self.proc_target_lufs = p.proc_target_lufs;
        self.proc_ceiling_dbtp = p.proc_ceiling_dbtp;
        self.proc_release_ms = p.proc_release_ms;
        self.proc_ride_rate = p.proc_ride_rate;
        self.proc_ride_clamp = p.proc_ride_clamp;
        self.proc_ride_bypass = p.proc_ride_bypass;
        self.proc_limiter_bypass = p.proc_limiter_bypass;
        self.proc_stream_target_lufs = p.proc_stream_target_lufs;
        self.proc_stream_ceiling_dbtp = p.proc_stream_ceiling_dbtp;
        self.proc_stream_release_ms = p.proc_stream_release_ms;
        self.proc_stream_ride_rate = p.proc_stream_ride_rate;
        self.proc_stream_ride_clamp = p.proc_stream_ride_clamp;
        self.proc_stream_ride_bypass = p.proc_stream_ride_bypass;
        self.proc_stream_limiter_bypass = p.proc_stream_limiter_bypass;
        self.duck_threshold = p.duck_threshold;
        self.duck_depth_db = p.duck_depth_db;
        self.duck_attack_ms = p.duck_attack_ms;
        self.duck_hold_ms = p.duck_hold_ms;
        self.duck_release_ms = p.duck_release_ms;
        if p.eq_version != self.eq_version_applied {
            // Only the callback ever locks these (S3), so try_lock cannot miss; if it ever did, the version
            // is left unapplied and the next buffer tries again rather than dropping the change.
            if let (Ok(mut a), Ok(mut r)) = (self.eq.try_lock(), self.eq_room.try_lock()) {
                r.set_bands(&p.eq_bands);
                a.set_bands(&p.eq_bands);
                self.eq_bands = p.eq_bands;
                self.eq_version_applied = p.eq_version;
            } else {
                RtCounters::bump(&self.counters.lock_misses, 1);
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
            spectrum: self.spectrum,
            frames_consumed: self.frames_consumed,
            duck_gain: self.duck_gain,
            aux_proc_in_lufs: self.aux_proc_in_lufs, aux_proc_out_lufs: self.aux_proc_out_lufs,
            aux_proc_gr_db: self.aux_proc_gr_db, aux_proc_ride_db: self.aux_proc_ride_db,
            proc_in_lufs: self.proc_in_lufs, proc_out_lufs: self.proc_out_lufs,
            proc_gr_db: self.proc_gr_db, proc_ride_gain_db: self.proc_ride_gain_db,
            proc_in_peak: self.proc_in_peak, proc_out_peak: self.proc_out_peak,
            proc_stream_in_lufs: self.proc_stream_in_lufs, proc_stream_out_lufs: self.proc_stream_out_lufs,
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

pub type SharedBusState = Arc<Mutex<BusState>>;

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
        let bus = Arc::new(Mutex::new(BusState::new(eq, prod, 44100, Arc::new(AtomicBool::new(false)))));
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
        let bus = Arc::new(Mutex::new(BusState::new(eq, prod, 44100, Arc::new(AtomicBool::new(false)))));
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
        let bus = Arc::new(Mutex::new(BusState::new(eq, prod, 44100, Arc::new(AtomicBool::new(false)))));

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
        let bus = Arc::new(Mutex::new(b));
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
    /// never partway through one. One thread fires 20 000 master-fader blocks (alternating 0.0 / 1.0) as fast
    /// as it can; another renders a constant 0.5 source. Every rendered buffer must be uniform — all 0.0 or
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
        let bus = Arc::new(Mutex::new(b));
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
                p.master_vol = if sent % 2 == 0 { 0.0 } else { 1.0 };
                let mut c = RtCmd::Params(Box::new(p));
                loop {
                    if done2.load(Ordering::Acquire) { break; }
                    match cmd.try_push(c) { Ok(()) => break, Err(back) => { c = back; while garbage.try_pop().is_some() {} std::thread::yield_now(); } }
                }
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
        println!("[rt-cmd] {} buffers, all uniform: {} at master 0.0, {} at master 1.0", buffers, zeros, halves);
        assert!(zeros > 0 && halves > 0, "both fader states must have been rendered");
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
        let bus = Arc::new(Mutex::new(b));
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
        let bus = Arc::new(Mutex::new(b));
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
        let bus = Arc::new(Mutex::new(b));
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
        let bus = Arc::new(Mutex::new(b));
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
        let meters = MetersHandle { reader: Arc::new(Mutex::new(h.meter_r)), shared: h.shared.clone() };
        b.decks[0].source = Some(DeckFeed::prefilled(Burst { n: 0 }, 480 * 2 * 40));
        b.decks[0].active = true;
        b.decks[0].paused = false;
        let bus = Arc::new(Mutex::new(b));
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
        let bus = Arc::new(Mutex::new(BusState::new(eq, prod, 44100, Arc::new(AtomicBool::new(false)))));
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
        let bus = Arc::new(Mutex::new(BusState::new(eq, prod, 44100, Arc::new(AtomicBool::new(false)))));
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
    let meters_handle = MetersHandle { reader: meter_reader.clone(), shared: handles.shared.clone() };
    let ctl_init = Control::new(&bus_init, handles.cmd_prod, handles.garbage_cons, meter_reader,
                                handles.shared, aux_frames_ctr_shared.clone(), station_id, station_counters.clone());
    let aux_cmd_prod = handles.aux_cmd_prod;
    let bus_state: SharedBusState = Arc::new(Mutex::new(bus_init));
    let bus_cmd = bus_state.clone(); // device-open / device-switch only (no callback running then)

    // ── TCP listener (Program Bus) ────────────────────────────────────────────
    let listener = TcpListener::bind("127.0.0.1:0")
        .expect("[RUST] Program Bus TCP bind failed");
    let tcp_port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    eprintln!("[RUST] Station {} Program Bus on TCP port {}", station_id, tcp_port);

    std::thread::spawn(move || {
        drain_program_bus(station_id, listener, ring_cons, delay_drain, stream_connected);
    });

    // ── AUX MONITOR OUTPUT THREAD ────────────────────────────────────────────────────────────────
    // Owns the second cpal stream: opens it when the operator picks a device, closes it when they
    // clear the choice, reopens it when they switch. It is the ONLY thing that installs the ring
    // producer into BusState, so "no device chosen = silence" is true in the audio path itself and
    // not merely in a comment.
    //
    // Its own clock: the aux device runs independently of the station device. The callback drains
    // what the mixer produced and resamples 44100 -> the aux rate with a persistent phase; on
    // underrun it writes silence rather than stretching, and the writer bounds the ring so latency
    // cannot creep. Two clocks always drift; this bounds the consequence to an occasional tick on a
    // MONITOR feed, and it never touches air.
    {
        let req_aux = aux_req.clone();
        let mut aux_tx = aux_cmd_prod;
        let aux_frames = aux_frames_ctr_shared;
        // Deliver an aux command to the callback. The queue holds 16 and these happen when an operator
        // picks a device, so a full queue means the callback is not running; retry briefly, then give up
        // loudly (the next device change or retry sends it again).
        let mut send_aux = move |c: AuxCmd| {
            let mut c = c;
            for _ in 0..200 {
                match aux_tx.try_push(c) { Ok(()) => return, Err(back) => { c = back; std::thread::sleep(std::time::Duration::from_millis(5)); } }
            }
            eprintln!("[RUST] Station {} AUX command not delivered (callback not running)", station_id);
        };
        std::thread::spawn(move || {
            use cpal::traits::{DeviceTrait, StreamTrait};
            let mut open_name = String::new();
            let mut _stream: Option<cpal::Stream> = None;
            // A REQUESTED-BUT-ABSENT device is a normal state, not an error to hammer: the operator may
            // have picked headphones that are currently unplugged. Retry slowly and log once, instead
            // of re-attempting every poll (which logged 4x/second) or giving up forever (which would
            // never notice the device coming back).
            let mut retry_at: Option<std::time::Instant> = None;
            loop {
                let want = req_aux.lock().map(|r| r.clone()).unwrap_or_default();
                let retry_due = retry_at.map(|t| std::time::Instant::now() >= t).unwrap_or(false);
                if want != open_name || (retry_due && !want.is_empty() && _stream.is_none()) {
                    // Tear down first, always: clearing the producer stops the mixer writing before
                    // the stream that drains it goes away.
                    let changed = want != open_name;
                    send_aux(AuxCmd::Detach);
                    if _stream.is_some() || (changed && !open_name.is_empty()) {
                        eprintln!("[RUST] Station {} AUX monitor output closed", station_id);
                    }
                    _stream = None;
                    open_name = want.clone();
                    retry_at = None;

                    if !open_name.is_empty() {
                        match open_named_output_device(station_id, &open_name) {
                            Some((device, sr, ch)) => {
                                let rb = HeapRb::<f32>::new(AUX_BUS_BUF);
                                let (prod, mut cons) = rb.split();
                                send_aux(AuxCmd::Attach(prod));
                                let frames_ctr = aux_frames.clone();

                                let cfg = cpal::StreamConfig {
                                    channels: ch,
                                    sample_rate: cpal::SampleRate(sr),
                                    buffer_size: cpal::BufferSize::Default,
                                };
                                let mut phase: f64 = 0.0;
                                let base_step: f64 = PROGRAM_RATE as f64 / sr as f64;
                                let mut cur = (0.0f32, 0.0f32);
                                let mut nxt = (0.0f32, 0.0f32);
                                let mut primed = false;
                                // Target ring fill (stereo samples). The two device clocks never agree
                                // exactly, so SOMETHING has to absorb the difference. Dropping samples
                                // does it audibly; nudging the resample ratio by a fraction of a
                                // percent does it inaudibly, which is how a monitor bus should behave.
                                let target_fill: f64 = (sr as f64 * 0.04 * 2.0).max(256.0); // ~40 ms

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
                                        // DRIFT CORRECTION, not sample dropping. Nudge the resample
                                        // ratio by at most ±0.3% toward the target fill — well under
                                        // the ~1% where pitch shift becomes audible, and it removes
                                        // the need to throw samples away at all.
                                        let fill = cons.occupied_len() as f64;
                                        let err = (fill - target_fill) / target_fill;          // -1..+n
                                        let step = base_step * (1.0 + err.clamp(-1.0, 1.0) * 0.003);
                                        for f in 0..frames {
                                            while phase >= 1.0 {
                                                cur = nxt;
                                                nxt = match cons.try_pop() {
                                                    Some(l) => (l, cons.try_pop().unwrap_or(l)),
                                                    None => {
                                                        // UNDERRUN: fade toward silence instead of
                                                        // stepping to zero. A hard jump to 0 mid-wave
                                                        // is itself a click — the very artifact this
                                                        // path is supposed to avoid. Never repeats a
                                                        // tail: it decays and stays there.
                                                        (cur.0 * 0.5, cur.1 * 0.5)
                                                    }
                                                };
                                                phase -= 1.0;
                                            }
                                            let t = phase as f32;
                                            let l = cur.0 + (nxt.0 - cur.0) * t;
                                            let r = cur.1 + (nxt.1 - cur.1) * t;
                                            if ch == 2 { data[f * 2] = l; data[f * 2 + 1] = r; }
                                            else { data[f] = (l + r) * 0.5; }
                                            phase += step;
                                        }
                                        // Proof of flow, not merely of opening.
                                        frames_ctr.fetch_add(frames as u64, Ordering::Relaxed);
                                    },
                                    |err| eprintln!("[cpal aux] {}", err),
                                    None,
                                );
                                match built {
                                    Ok(st) => {
                                        if let Err(e) = st.play() {
                                            eprintln!("[RUST] Station {} AUX stream.play(): {}", station_id, e);
                                            send_aux(AuxCmd::Detach);
                                            retry_at = Some(std::time::Instant::now() + std::time::Duration::from_secs(5));
                                        } else {
                                            eprintln!("[RUST] Station {} AUX monitor output opened ({}Hz {}ch)", station_id, sr, ch);
                                            _stream = Some(st);
                                        }
                                    }
                                    Err(e) => {
                                        eprintln!("[RUST] Station {} AUX build_output_stream: {}", station_id, e);
                                        send_aux(AuxCmd::Detach);
                                        retry_at = Some(std::time::Instant::now() + std::time::Duration::from_secs(5));
                                    }
                                }
                            }
                            None => {
                                // NO FALLBACK. A named device that is not present stays unopened and
                                // the bus stays silent. Substituting a different output for the
                                // operator is the unsafe behaviour this whole path exists to avoid.
                                // Logged ONCE per change; the slow retry below is silent until it
                                // succeeds, so an unplugged headphone does not fill the log.
                                if changed {
                                    eprintln!("[RUST] Station {} AUX monitor device not found: {:?} — staying silent (will retry)", station_id, open_name);
                                }
                                retry_at = Some(std::time::Instant::now() + std::time::Duration::from_secs(5));
                            }
                        }
                    } else {
                        eprintln!("[RUST] Station {} AUX monitor output closed (no device selected)", station_id);
                    }
                }
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
        let mut ev_cons: Option<ringbuf::HeapCons<RtEvent>> = None;

        'outer: loop {
            // Find and open output device
            let (device, sr, ch) = match open_output_device(station_id, &current_device) {
                Some(d) => d,
                None => {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    continue 'outer;
                }
            };

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
                |err| eprintln!("[cpal] {}", err),
                None,
            );

            let stream = match stream {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[RUST] Station {} build_output_stream: {} — retrying", station_id, e);
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    continue 'outer;
                }
            };
            if let Err(e) = stream.play() {
                eprintln!("[RUST] Station {} stream.play(): {} — retrying", station_id, e);
                std::thread::sleep(std::time::Duration::from_secs(2));
                continue 'outer;
            }

            eprintln!("[RUST] Station {} audio output opened ({}Hz {}ch)",
                station_id, sr, ch);

            // Command loop — holds `stream` alive; dropping it stops the callback
            loop {
                // S2 — the audio thread's work that is not audio: its log lines and its liveness stamp.
                // At the TOP of the loop so no `continue` in a command arm can skip it.
                if let Some(ref mut c) = ev_cons { drain_rt_events(station_id, c); }
                // S3 — free what the callback let go of, and hand it whatever is waiting.
                ctl.drain_garbage();
                ctl.flush();
                let seq = cb_seq.load(Ordering::Relaxed);
                if seq != seen_seq { seen_seq = seq; last_cb.store(now_ms(), Ordering::Relaxed); }
                match rx.recv_timeout(std::time::Duration::from_millis(50)) {
                    Ok(cmd) => {
                        match cmd {
                            // ── S3: every arm below edits the dispatch thread's OWN copy of the state (ctl) and
                            // queues a message. None of them touches BusState: the callback owns it, and
                            // applies these at the top of its next buffer (docs/dsp-rt-callback.md §4).
                            AudioCmd::Load { deck, file_path, title, artist, gain_db } => {
                                let Some(idx) = deck_index(&deck) else { continue };
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
                                ctl.enqueue(RtCmd::Pause { slot: idx as u8 });
                            }
                            AudioCmd::Stop(deck) => {
                                let Some(idx) = deck_index(&deck) else { continue };
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
                            AudioCmd::SetDuckParams { depth_db, threshold_db, attack_ms, hold_ms, release_ms } => {
                                // Clamped at the edges only — every value in between is a
                                // legitimate operator choice. 0 dB depth means "armed but not
                                // ducking", and a 0 ms hold means "release the moment the source
                                // stops", both of which someone may genuinely want to hear.
                                let p = &mut ctl.params;
                                p.duck_depth_db   = depth_db.clamp(-60.0, 0.0);
                                p.duck_threshold  = 10f32.powf(threshold_db.clamp(-90.0, 0.0) / 20.0);
                                p.duck_attack_ms  = attack_ms.clamp(1.0, 1000.0);
                                p.duck_hold_ms    = hold_ms.clamp(0.0, 5000.0);
                                p.duck_release_ms = release_ms.clamp(1.0, 5000.0);
                                ctl.params_changed();
                            }
                            AudioCmd::SetAuxMonitor { deck, gain } => {
                                // AUX DECKS ONLY. A/B/C and CART are board channels and their local
                                // monitoring is unchanged by this feature; refusing them here means no
                                // caller can accidentally route a programme deck through the aux path.
                                let Some(idx) = deck_index(&deck) else { continue };
                                if !(3..=5).contains(&idx) { continue; }
                                ctl.params.aux_monitor_gain[idx] = gain.clamp(0.0, 4.0);
                                // The SAME row drives both, because it is one control: "how loud
                                // is this deck in the room". Which buffer it reaches depends on
                                // the slot's bus — an aux deck through the aux tap, a sweeper
                                // through the room sum — and the operator should not have to know
                                // which. Rotation decks never get here, so they keep unity.
                                if ctl.params.kind[idx] != SlotKind::Rotation {
                                    ctl.params.room_gain[idx] = gain.clamp(0.0, 4.0);
                                }
                                ctl.params_changed();
                            }
                            AudioCmd::GetLevel => {
                                // REAL levels — the callback's latest published frame (S3: a lock-free
                                // triple buffer; this no longer holds anything the callback needs).
                                let Some(m) = ctl.meter.lock().ok().map(|mut r| r.read()) else { continue };
                                let p = &m.params;
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
                                    lvl.aux_proc_out_lufs = m.aux_proc_out_lufs;
                                    lvl.aux_proc_gr_db    = m.aux_proc_gr_db;
                                    lvl.aux_proc_ride_db  = m.aux_proc_ride_db;
                                    lvl.duck_gain         = m.duck_gain;
                                    lvl.spectrum     = m.spectrum;
                                    // v4.4.46 mix telemetry.
                                    lvl.frames_total = m.frames_consumed;
                                    lvl.mon_vol      = p.monitor_vol;
                                    // Audio Processing v1 meters (observed at the taps).
                                    lvl.proc_local       = p.proc_local;
                                    lvl.proc_stream      = p.proc_stream;
                                    lvl.proc_target_lufs = p.proc_target_lufs;
                                    lvl.proc_in_lufs     = m.proc_in_lufs;
                                    lvl.proc_out_lufs    = m.proc_out_lufs;
                                    lvl.proc_gr_db       = m.proc_gr_db;
                                    lvl.proc_ride_gain_db = m.proc_ride_gain_db;
                                    lvl.proc_in_peak     = m.proc_in_peak;
                                    lvl.proc_out_peak    = m.proc_out_peak;
                                    // THE ECHO — the parameters the ENGINE ran this buffer (the block the
                                    // callback adopted), not what this thread last sent.
                                    lvl.proc_ceiling_dbtp   = p.proc_ceiling_dbtp;
                                    lvl.proc_release_ms     = p.proc_release_ms;
                                    lvl.proc_ride_rate      = p.proc_ride_rate;
                                    lvl.proc_ride_clamp     = p.proc_ride_clamp;
                                    lvl.proc_ride_bypass    = p.proc_ride_bypass;
                                    lvl.proc_limiter_bypass = p.proc_limiter_bypass;
                                    lvl.proc_stream_in_lufs      = m.proc_stream_in_lufs;
                                    lvl.proc_stream_out_lufs     = m.proc_stream_out_lufs;
                                    lvl.proc_stream_gr_db        = m.proc_stream_gr_db;
                                    lvl.proc_stream_ride_gain_db = m.proc_stream_ride_gain_db;
                                    lvl.proc_stream_in_peak      = m.proc_stream_in_peak;
                                    lvl.proc_stream_out_peak     = m.proc_stream_out_peak;
                                    lvl.proc_stream_target_lufs  = p.proc_stream_target_lufs;
                                    lvl.proc_stream_ceiling_dbtp = p.proc_stream_ceiling_dbtp;
                                    lvl.proc_stream_release_ms   = p.proc_stream_release_ms;
                                    lvl.proc_stream_ride_rate    = p.proc_stream_ride_rate;
                                    lvl.proc_stream_ride_clamp   = p.proc_stream_ride_clamp;
                                    lvl.proc_stream_ride_bypass    = p.proc_stream_ride_bypass;
                                    lvl.proc_stream_limiter_bypass = p.proc_stream_limiter_bypass;
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
                                        allocs: rt_allocs(),
                                    };
                                }
                            }
                            AudioCmd::SwitchDevice(name) => {
                                eprintln!("[RUST] Station {} SwitchDevice → {:?}", station_id, name);
                                current_device = if name.is_empty() { None } else { Some(name) };
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
                                for i in 0..10 { ctl.params.eq_bands[i] = gains.get(i).copied().unwrap_or(0.0); }
                                ctl.params.eq_version = ctl.params.eq_version.wrapping_add(1);
                                ctl.params_changed();
                            }
                            AudioCmd::SetMonitorVolume(v) => {
                                ctl.params.monitor_vol = v.clamp(0.0, 4.0);
                                ctl.params_changed();
                            }
                            AudioCmd::SetMasterVolume(v) => {
                                // Clamped 0..=1: master is an attenuator on air. >1 would let the operator
                                // push the program bus into clipping ahead of the limiter.
                                ctl.params.master_vol = v.clamp(0.0, 1.0);
                                ctl.params_changed();
                            }
                            AudioCmd::SetMasterMonitorVolume(v) => {
                                ctl.params.master_monitor_vol = v.clamp(0.0, 1.0);
                                ctl.params_changed();
                            }
                            AudioCmd::SetProcessorBypass { branch, ride_bypass, limiter_bypass } => {
                                let p = &mut ctl.params;
                                if branch == 1 {
                                    p.proc_stream_ride_bypass    = ride_bypass;
                                    p.proc_stream_limiter_bypass = limiter_bypass;
                                } else {
                                    p.proc_ride_bypass    = ride_bypass;
                                    p.proc_limiter_bypass = limiter_bypass;
                                }
                                ctl.params_changed();
                            }
                            AudioCmd::SetProcessorParams { branch, target_lufs, ceiling_dbtp, release_ms, ride_rate_db_s, ride_clamp_db } => {
                                let p = &mut ctl.params;
                                if branch == 1 {
                                    // Same edge clamps as the local branch — every value between is a
                                    // legitimate operator choice.
                                    p.proc_stream_target_lufs  = target_lufs.clamp(-30.0, -6.0);
                                    p.proc_stream_ceiling_dbtp = ceiling_dbtp.clamp(-12.0, -0.1);
                                    p.proc_stream_release_ms   = release_ms.clamp(5.0, 2000.0);
                                    p.proc_stream_ride_rate    = ride_rate_db_s.clamp(0.1, 12.0);
                                    p.proc_stream_ride_clamp   = ride_clamp_db.clamp(0.0, 24.0);
                                } else {
                                    p.proc_target_lufs = target_lufs.clamp(-30.0, -6.0);
                                    // The ceiling is never allowed to reach 0 dBTP — above about -0.3 the
                                    // stream's encoder produces inter-sample overs that clip on the
                                    // listener's decoder.
                                    p.proc_ceiling_dbtp   = ceiling_dbtp.clamp(-12.0, -0.1);
                                    p.proc_release_ms     = release_ms.clamp(5.0, 2000.0);
                                    p.proc_ride_rate      = ride_rate_db_s.clamp(0.1, 12.0);
                                    p.proc_ride_clamp     = ride_clamp_db.clamp(0.0, 24.0);
                                }
                                ctl.params_changed();
                            }
                            AudioCmd::SetProcessing { local, stream, target_lufs } => {
                                let p = &mut ctl.params;
                                p.proc_local  = local;
                                p.proc_stream = stream;
                                p.proc_target_lufs = target_lufs.clamp(-30.0, -6.0);
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
            workers, counters,
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
            dev_l: lane(), dev_r: lane(),
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
        room_out_l, room_out_r, dev_l, dev_r, feed, counters, events,
    } = sc;
    let counters: &RtCounters = counters;

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

    for (i, deck) in bus.decks.iter_mut().enumerate() {
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
        let mut got = src.cons.pop_slice(&mut feed[..want]);
        let mut ended = false;
        if got < want && src.eof.load(Ordering::Acquire) {
            got += src.cons.pop_slice(&mut feed[got..want]);
            ended = got < want;
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
        for f in 0..take {
            {
                {
                    let l = feed[2 * f];
                    let r = feed[2 * f + 1];
                    let lv = l * vol;
                    let rv = r * vol;
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
    }
    // SLICE 2 — fold this buffer's channel taps into the window.
    bus.meters_acc.frames += prog_frames as u64;
    for i in 0..SLOT_COUNT {
        let (a, t) = (&mut bus.meters_acc.ch[i], &ch_meter[i]);
        a.peak = [a.peak[0].max(t.peak[0]), a.peak[1].max(t.peak[1])];
        a.sumsq[0] += t.sumsq[0];
        a.sumsq[1] += t.sumsq[1];
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
    let mut eq_spectrum: Option<[f32; 10]> = None;
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
        // Snapshot the analyzer spectrum while we hold the lock; published to bus below.
        eq_spectrum = Some(eq.spectrum());
    } else {
        RtCounters::bump(&counters.lock_misses, 1);   // S6 — uncontended by construction; counted if not
        out_l.copy_from_slice(mix_l);
        out_r.copy_from_slice(mix_r);
    }

    // Publish the EQ analyzer spectrum (lock already released) for GetLevel → AudioLevels.
    if let Some(spec) = eq_spectrum { bus.spectrum = spec; }

    // ── MASTER OUT ────────────────────────────────────────────────────────────────────────────────
    // Applied HERE: after the mix + EQ, BEFORE the VU peak below and before the stream/device split.
    //   • the stream (what listeners hear) is taken from out_l/out_r further down → master rides air;
    //   • the master VU is computed from these same samples → the meter shows what went out;
    //   • the device branch multiplies by monitor levels afterwards → the room gets master x monitor,
    //     exactly like a console, and monitor still never touches air.
    // Unity is a no-op multiply, so an untouched station is bit-identical to the previous build.
    let master_vol = bus.master_vol;
    if master_vol != 1.0 {
        for s in out_l.iter_mut() { *s = *s * master_vol; }
        for s in out_r.iter_mut() { *s = *s * master_vol; }
    }
    let out_l: &[f32] = out_l;
    let out_r: &[f32] = out_r;
    // SLICE 2 — PGM tap: the clean programme, post-EQ, post-master, pre-processor.
    bus.meters_acc.bus[BUS_PGM].add(out_l, out_r);
    bus.meters_acc.bus_live |= 1 << BUS_PGM;

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
    let run_branch = |proc: &Arc<Mutex<crate::program_processor::ProgramProcessor>>,
                      target: f32, ceiling: f32, release: f32, rate: f32, clamp: f32,
                      ride_byp: bool, lim_byp: bool, pl: &mut [f32], pr: &mut [f32]|
     -> Option<(f32, f32, f32, f32, f32)> {
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
            p.process_planar(pl, pr);
            let op = pl.iter().chain(pr.iter()).map(|&s| s.abs()).fold(0.0f32, f32::max);
            Some((p.in_lufs(), p.out_lufs(), p.gain_reduction_db(), p.ride_gain_db(), op))
        } else { RtCounters::bump(&counters.lock_misses, 1); None }
    };

    let loc_l = &mut loc_l[..prog_frames];
    let loc_r = &mut loc_r[..prog_frames];
    let str_l = &mut str_l[..prog_frames];
    let str_r = &mut str_r[..prog_frames];
    let local_m = if bus.proc_local {
        run_branch(&bus.processor.clone(), bus.proc_target_lufs, bus.proc_ceiling_dbtp,
                   bus.proc_release_ms, bus.proc_ride_rate, bus.proc_ride_clamp,
                   bus.proc_ride_bypass, bus.proc_limiter_bypass, loc_l, loc_r)
    } else { None };

    let stream_m = if bus.proc_stream {
        run_branch(&bus.processor_stream.clone(), bus.proc_stream_target_lufs, bus.proc_stream_ceiling_dbtp,
                   bus.proc_stream_release_ms, bus.proc_stream_ride_rate, bus.proc_stream_ride_clamp,
                   bus.proc_stream_ride_bypass, bus.proc_stream_limiter_bypass, str_l, str_r)
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
    if let Some((il, ol, gr, ride, op)) = local_m {
        bus.proc_in_lufs = il; bus.proc_out_lufs = ol; bus.proc_gr_db = gr; bus.proc_ride_gain_db = ride;
        bus.proc_in_peak  = peak.max(bus.proc_in_peak * VU_RELEASE);
        bus.proc_out_peak = op.max(bus.proc_out_peak * VU_RELEASE);
    }
    if let Some((il, ol, gr, ride, op)) = stream_m {
        bus.proc_stream_in_lufs = il; bus.proc_stream_out_lufs = ol;
        bus.proc_stream_gr_db = gr; bus.proc_stream_ride_gain_db = ride;
        bus.proc_stream_in_peak  = peak.max(bus.proc_stream_in_peak * VU_RELEASE);
        bus.proc_stream_out_peak = op.max(bus.proc_stream_out_peak * VU_RELEASE);
        if local_m.is_none() {
            bus.proc_in_lufs = il; bus.proc_out_lufs = ol; bus.proc_gr_db = gr; bus.proc_ride_gain_db = ride;
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
    if bus.stream_connected.load(Ordering::Relaxed) {
        // Stream drain taps PROCESSED when "Process stream" is on and the processed buffer exists, else clean.
        // The stream taps the STREAM processor now, not the shared one.
        let use_proc = bus.proc_stream && stream_m.is_some();
        // SLICE 2 — STREAM tap: exactly the samples pushed to the ring below.
        let (mut spl, mut spr, mut ssl, mut ssr) = (bus.meters_acc.bus[BUS_STREAM].peak[0], bus.meters_acc.bus[BUS_STREAM].peak[1], 0.0f64, 0.0f64);
        for f in 0..prog_frames {
            // PROCESSED audio is already ceiling-controlled by the -1 dBTP limiter and passes through
            // untouched. The CLEAN tap has no limiter in front of it, so it is clamped HERE — at the
            // point of use, for an unprocessed station only, instead of on the way in where it also
            // clipped the processor's input.
            let (l, r) = if use_proc {
                (str_l[f], str_r[f])
            } else {
                (out_l[f].clamp(-1.0, 1.0), out_r[f].clamp(-1.0, 1.0))
            };
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
        if master_vol != 1.0 {
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
            Some((p.in_lufs(), p.out_lufs(), p.gain_reduction_db(), p.ride_gain_db()))
        } else { RtCounters::bump(&counters.lock_misses, 1); None };
        if let Some((il, ol, gr, ride)) = meters {
            bus.aux_proc_in_lufs = il;
            bus.aux_proc_out_lufs = ol;
            bus.aux_proc_gr_db = gr;
            bus.aux_proc_ride_db = ride;
        }
    }
    // SLICE 2 — AUX tap: the aux monitor feed as it leaves (after its processor when that is on).
    if aux_present {
        bus.meters_acc.bus[BUS_AUX].add(aux_l, aux_r);
        bus.meters_acc.bus_live |= 1 << BUS_AUX;
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
