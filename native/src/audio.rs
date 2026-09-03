use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use ringbuf::{HeapRb, HeapProd, traits::{Producer, Consumer, Observer, Split}};

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
    /// Receiver side — does this deck step back when a source ducks?
    SetDuckable { deck: String, duckable: bool },
    /// DUCKER tuning, per STATION — there is ONE duck envelope per bus, so every one of these is
    /// station-wide by construction, never per channel. Dialled by ear from Preferences.
    SetDuckParams { depth_db: f32, threshold_db: f32, attack_ms: f32, hold_ms: f32, release_ms: f32 },
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
    pub is_playing: Arc<Mutex<bool>>,
    pub levels: SharedLevels,
    pub delay: SharedDelay,
    pub finished: FinishedFlags,
    pub watchdog_active: bool,
    pub watchdog_threshold_sec: f64,
    pub watchdog_triggered_count: u32,
    pub program_bus_port: u16,
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
    /// Live decoder — None when no track is loaded or after a track finishes.
    pub source:   Option<Box<dyn Iterator<Item = f32> + Send>>,
    pub volume:   f32,
    pub paused:   bool,
    /// Set true on Play, false on Stop/finish. Used by the callback to detect
    /// natural end-of-track (source exhausted while active == true).
    pub active:   bool,
    /// Saved for device-failover restore (reopen file, rebuild decoder).
    pub path:     String,
    pub title:    String,
    pub artist:   String,
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
            path:    String::new(),
            title:   String::new(),
            artist:  String::new(),
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
    pub processor:   Arc<Mutex<crate::program_processor::ProgramProcessor>>,

    // ── AUX MONITOR BUS (2026-08-18) — "slot = room, board = air" ────────────────────────────────
    // Decks D/E/F (slots 3/4/5) are AUX decks: automation never touches them, and per Jeff's ruling
    // they must NOT be summed into the local speaker output. They reach the room ONLY through an AUX
    // monitor slot that selects them, at that slot's own level. Air is untouched: they stay in the
    // program bus exactly as before, fully EQ'd and processed.
    //
    // Per-slot ROOM level. 0.0 = not selected by any slot = SILENT IN THE ROOM, which is the ruling.
    // Only indices 3/4/5 are ever non-zero; SetAuxMonitor refuses every other slot.
    pub aux_monitor_gain: [f32; SLOT_COUNT],

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
}

impl BusState {
    pub fn new(eq: crate::eq::SharedEq, ring_prod: HeapProd<f32>, sample_rate: u32, stream_connected: Arc<AtomicBool>) -> Self {
        BusState {
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
            processor:   Arc::new(Mutex::new(crate::program_processor::ProgramProcessor::new(sample_rate as f32, -14.0))),
            aux_monitor_gain: [0.0; SLOT_COUNT],   // nothing selected → aux decks silent in the room
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
        }
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
    /// CART — the jingle/cart overlay. NEVER duck-eligible (a sweeper must not duck its own song).
    Cart,
    /// D/E/F and the new 7.. channels — operator sources: jukebox, announcement, hand-fired jingle.
    Source,
}

/// The layout above, expressed once.
pub fn default_kind_for(i: usize) -> SlotKind {
    match i {
        0..=2 => SlotKind::Rotation,
        6     => SlotKind::Cart,
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
                b.decks[i].source = Some(Box::new(Det(seed)));
                b.decks[i].active = true;
                b.decks[i].paused = false;   // DeckSlot::new() starts paused; without this the callback skips it
                b.decks[i].volume = 0.8;
            }
        }
        let fin = FinishedFlags::new();
        let playing = Arc::new(Mutex::new(true));
        let mut out: Vec<f32> = Vec::new();
        for _ in 0..50 {
            let mut data = vec![0f32; 480 * 2];
            mixer_callback(&mut data, 2, &bus, &fin, &playing);
            out.extend_from_slice(&data);
        }
        checksum(&out)
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
            b.decks[0].source = Some(Box::new(Det(11)));
            b.decks[0].active = true;
            b.decks[0].paused = false;
            b.decks[0].volume = 0.8;
            b.decks[3].source = Some(Box::new(Det(44)));
            b.decks[3].active = true;
            b.decks[3].paused = false;
            b.decks[3].volume = 0.9;
            b.aux_monitor_gain[3] = 1.0;      // slot D selected into the room at unity
            b.proc_local = true;              // the toggle that gates the aux processor
            b.aux_ring_prod = Some(aux_prod);
        }
        let fin = FinishedFlags::new();
        let playing = Arc::new(Mutex::new(true));
        for _ in 0..50 {
            let mut data = vec![0f32; 480 * 2];
            mixer_callback(&mut data, 2, &bus, &fin, &playing);
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
            b.decks[0].source = Some(Box::new(Tone(music)));   // Rotation — the music
            b.decks[0].active = true; b.decks[0].paused = false; b.decks[0].volume = 1.0;
            b.decks[3].source = Some(Box::new(Tone(source)));  // Source (D) — the announcement
            b.decks[3].active = true; b.decks[3].paused = false; b.decks[3].volume = 1.0;
            b.duck_enabled[3] = duck_on;
        }
        bus
    }

    fn run(bus: &SharedBusState, buffers: usize) {
        let fin = FinishedFlags::new();
        let playing = Arc::new(Mutex::new(true));
        for _ in 0..buffers {
            let mut data = vec![0f32; 480 * 2];
            mixer_callback(&mut data, 2, bus, &fin, &playing);
        }
    }
    fn set_source(bus: &SharedBusState, level: f32) {
        let mut b = bus.lock().unwrap();
        b.decks[3].source = Some(Box::new(Tone(level)));
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
        let playing = Arc::new(Mutex::new(true));
        let mut pk = 0.0f32;
        for _ in 0..buffers {
            let mut data = vec![0f32; 480 * 2];
            mixer_callback(&mut data, 2, bus, &fin, &playing);
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
                b.decks[1].source = Some(Box::new(Tone(0.30)));   // deck B — the deck under test
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
                b.decks[i].source = Some(Box::new(Tone(0.7)));
                b.decks[i].active = true; b.decks[i].paused = false; b.decks[i].volume = 1.0;
                b.duck_enabled[i] = true;                // armed, and still must not duck
            }
            assert_eq!(b.decks[0].kind, SlotKind::Rotation);
            assert_eq!(b.decks[6].kind, SlotKind::Cart);
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
const PROGRAM_BUS_BUF: usize    = PROGRAM_RATE as usize * 2 * 4; // 4 s at 44100 Hz stereo
/// AUX monitor ring — ~0.5 s of 44100 Hz stereo. Deliberately SHORT: this is a monitor feed and
/// latency matters more than resilience. The writer bounds it further (see AUX_RING_HIGH).
const AUX_BUS_BUF: usize = PROGRAM_RATE as usize;          // 44100 samples = 0.5 s stereo
/// Above this fill the writer drops a frame — the drift bound. Two device clocks run independently,
/// so without this the ring creeps toward full and the monitor drifts seconds behind the room.
const AUX_RING_HIGH: usize = PROGRAM_RATE as usize / 4;    // ~0.125 s stereo

pub fn start_station_mixer(station_id: u32, device_name: Option<String>) -> (
    std::sync::mpsc::Sender<AudioCmd>,
    Arc<Mutex<bool>>,
    SharedLevels,
    FinishedFlags,
    u16,  // Program Bus TCP port
    SharedDelay,  // broadcast-delay / dump control
) {
    use std::net::TcpListener;

    let (tx, rx) = std::sync::mpsc::channel::<AudioCmd>();
    let is_playing       = Arc::new(Mutex::new(false));
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
    let bus_state: SharedBusState = Arc::new(Mutex::new(
        BusState::new(shared_eq, ring_prod, 44100, stream_connected.clone())
    ));
    let bus_cmd = bus_state.clone(); // command thread's handle

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
        let bus_aux = bus_state.clone();
        let req_aux = aux_req.clone();
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
                    if let Ok(mut bus) = bus_aux.lock() { bus.aux_ring_prod = None; }
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
                                let frames_ctr = {
                                    let mut g = bus_aux.lock().ok();
                                    let c = g.as_ref().map(|b| b.aux_out_frames.clone());
                                    if let Some(ref mut b) = g { b.aux_ring_prod = Some(prod); }
                                    match c { Some(c) => c, None => Arc::new(AtomicU64::new(0)) }
                                };

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
                                            if let Ok(mut bus) = bus_aux.lock() { bus.aux_ring_prod = None; }
                                            retry_at = Some(std::time::Instant::now() + std::time::Duration::from_secs(5));
                                        } else {
                                            eprintln!("[RUST] Station {} AUX monitor output opened ({}Hz {}ch)", station_id, sr, ch);
                                            _stream = Some(st);
                                        }
                                    }
                                    Err(e) => {
                                        eprintln!("[RUST] Station {} AUX build_output_stream: {}", station_id, e);
                                        if let Ok(mut bus) = bus_aux.lock() { bus.aux_ring_prod = None; }
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
        // This station's own liveness clock — stamped in the cpal callback below.
        let last_cb = station_cb_clock(station_id);

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
            restore_decks_after_switch(&bus_cmd, sr);

            let stream_config = cpal::StreamConfig {
                channels:    ch,
                sample_rate: cpal::SampleRate(sr),
                buffer_size: cpal::BufferSize::Default,
            };

            let bus_cb   = bus_cmd.clone();
            let fin_cb   = finished_clone.clone();
            let play_cb  = is_playing_clone.clone();
            let cb_stamp = last_cb.clone();

            let stream = device.build_output_stream::<f32, _, _>(
                &stream_config,
                move |data: &mut [f32], _| {
                    mixer_callback(data, ch, &bus_cb, &fin_cb, &play_cb);
                    // Per-station liveness — stamps THIS station's clock only.
                    cb_stamp.store(now_ms(), Ordering::Relaxed);
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
                match rx.recv_timeout(std::time::Duration::from_millis(50)) {
                    Ok(cmd) => {
                        match cmd {
                            AudioCmd::Load { deck, file_path, title, artist, gain_db } => {
                                let Some(idx) = deck_index(&deck) else { continue };
                                // Decode outside the lock — file I/O must not block callback
                                let src = build_source(&file_path, sr);
                                if let Ok(mut bus) = bus_cmd.lock() {
                                    let slot = &mut bus.decks[idx];
                                    slot.source   = src;
                                    slot.paused   = true;
                                    slot.active   = false;
                                    slot.path     = file_path;
                                    slot.title    = title;
                                    slot.artist   = artist;
                                    // THE FADER LEVEL IS THE JOCK'S — a track load must never move it.
                                    // This used to write `slot.volume` from gain_db (and slam it to unity
                                    // whenever a track had no trim), so every song load reset the fader the
                                    // operator had parked. A track was resetting the board. Only SetVolume
                                    // — the jock's hand — writes the fader now.
                                    //
                                    // gain_db is the TRACK's own loudness trim and is stored here only; it
                                    // is applied PRE-FADER as a separate multiplier at the mix, on top of
                                    // whatever level the operator set. Two different things, kept apart.
                                    slot.gain_db  = gain_db;
                                    // SAMPLE CLOCK — a new track restarts the position.
                                    slot.frames_played = 0;
                                }
                                finished_clone.clear(&deck);
                            }
                            AudioCmd::Play(deck) => {
                                let Some(idx) = deck_index(&deck) else { continue };
                                finished_clone.clear(&deck);
                                // If source was cleared (e.g. by Stop) but path is known,
                                // reload before playing — file I/O outside the lock.
                                let reload_path = bus_cmd.lock().ok().and_then(|b| {
                                    if b.decks[idx].source.is_none() && !b.decks[idx].path.is_empty() {
                                        Some(b.decks[idx].path.clone())
                                    } else {
                                        None
                                    }
                                });
                                // source=None AND path empty → fake play would produce silence
                                // with a live level meter; skip entirely.
                                let skip = reload_path.is_none()
                                    && bus_cmd.lock().ok()
                                        .map(|b| b.decks[idx].source.is_none())
                                        .unwrap_or(false);
                                if skip {
                                    eprintln!("[RUST] Play deck {}: source=None, path empty — skipping", deck);
                                    continue;
                                }
                                if let Some(ref path) = reload_path {
                                    let src = build_source(path, sr);
                                    if src.is_none() {
                                        eprintln!("[RUST] Play deck {}: reload failed for {} — skipping", deck, path);
                                        continue;
                                    }
                                    if let Ok(mut bus) = bus_cmd.lock() {
                                        bus.decks[idx].source = src;
                                    }
                                }
                                if let Ok(mut bus) = bus_cmd.lock() {
                                    bus.decks[idx].paused = false;
                                    bus.decks[idx].active = true;
                                }
                            }
                            AudioCmd::Pause(deck) => {
                                let Some(idx) = deck_index(&deck) else { continue };
                                if let Ok(mut bus) = bus_cmd.lock() {
                                    bus.decks[idx].paused = true;
                                }
                            }
                            AudioCmd::Stop(deck) => {
                                let Some(idx) = deck_index(&deck) else { continue };
                                finished_clone.clear(&deck);
                                if let Ok(mut bus) = bus_cmd.lock() {
                                    let slot = &mut bus.decks[idx];
                                    slot.source = None;
                                    slot.paused = true;
                                    slot.active = false;
                                    slot.path   = String::new();
                                    // SAMPLE CLOCK — deck emptied, position clears with it.
                                    slot.frames_played = 0;
                                }
                            }
                            AudioCmd::SetVolume { deck, volume } => {
                                let Some(idx) = deck_index(&deck) else { continue };
                                if let Ok(mut bus) = bus_cmd.lock() {
                                    bus.decks[idx].volume = volume;
                                }
                            }
                            AudioCmd::SetMuted { deck, muted } => {
                                let Some(idx) = deck_index(&deck) else { continue };
                                if let Ok(mut bus) = bus_cmd.lock() {
                                    bus.decks[idx].muted = muted;
                                }
                            }
                            AudioCmd::SetAuxDevice(name) => {
                                // Recorded for the aux thread, which owns opening/closing that stream.
                                // Empty = none = it closes the stream and clears the ring producer.
                                if let Ok(mut r) = aux_req.lock() { *r = name; }
                            }
                            AudioCmd::SetDuck { deck, enabled } => {
                                // Accepted for ANY slot and stored as given. The rule that only a
                                // SOURCE slot can actually duck lives in the mixer callback, which
                                // reads deck.kind — so a caller that arms deck A gets an honest
                                // "stored, and it will never fire" rather than a silent refusal that
                                // the UI would then misreport as enabled.
                                let Some(idx) = deck_index(&deck) else { continue };
                                if let Ok(mut bus) = bus_cmd.lock() {
                                    bus.duck_enabled[idx] = enabled;
                                }
                            }
                            AudioCmd::SetDuckable { deck, duckable } => {
                                let Some(idx) = deck_index(&deck) else { continue };
                                if let Ok(mut bus) = bus_cmd.lock() { bus.duck_duckable[idx] = duckable; }
                            }
                            AudioCmd::SetDuckParams { depth_db, threshold_db, attack_ms, hold_ms, release_ms } => {
                                if let Ok(mut bus) = bus_cmd.lock() {
                                    // Clamped at the edges only — every value in between is a
                                    // legitimate operator choice. 0 dB depth means "armed but not
                                    // ducking", and a 0 ms hold means "release the moment the source
                                    // stops", both of which someone may genuinely want to hear.
                                    bus.duck_depth_db  = depth_db.clamp(-60.0, 0.0);
                                    bus.duck_threshold = 10f32.powf(threshold_db.clamp(-90.0, 0.0) / 20.0);
                                    bus.duck_attack_ms = attack_ms.clamp(1.0, 1000.0);
                                    bus.duck_hold_ms   = hold_ms.clamp(0.0, 5000.0);
                                    bus.duck_release_ms= release_ms.clamp(1.0, 5000.0);
                                }
                            }
                            AudioCmd::SetAuxMonitor { deck, gain } => {
                                // AUX DECKS ONLY. A/B/C and CART are board channels and their local
                                // monitoring is unchanged by this feature; refusing them here means no
                                // caller can accidentally route a programme deck through the aux path.
                                let Some(idx) = deck_index(&deck) else { continue };
                                if !(3..=5).contains(&idx) { continue; }
                                if let Ok(mut bus) = bus_cmd.lock() {
                                    bus.aux_monitor_gain[idx] = gain.clamp(0.0, 4.0);
                                }
                            }
                            AudioCmd::GetLevel => {
                                // REAL levels — the mixer callback writes true post-fader peaks
                                // (per deck) + the post-EQ program peak (master) into bus.peaks;
                                // surface them as-is (0..1, 1.0 = 0 dBFS). No more fake bouncing.
                                if let (Ok(bus), Ok(mut lvl)) =
                                    (bus_cmd.lock(), levels_clone.lock())
                                {
                                    lvl.level_a      = bus.peaks[0];
                                    lvl.level_b      = bus.peaks[1];
                                    lvl.level_c      = bus.peaks[2];
                                    lvl.level_cart   = bus.peaks[6];
                                    lvl.level_master = bus.master_peak;
                                    lvl.level_room   = bus.room_peak;
                                    lvl.aux_frames   = bus.aux_out_frames.load(Ordering::Relaxed);
                                    lvl.aux_peak     = bus.aux_peak;
                                    lvl.aux_proc_in_lufs  = bus.aux_proc_in_lufs;
                                    lvl.aux_proc_out_lufs = bus.aux_proc_out_lufs;
                                    lvl.aux_proc_gr_db    = bus.aux_proc_gr_db;
                                    lvl.aux_proc_ride_db  = bus.aux_proc_ride_db;
                                    lvl.duck_gain         = bus.duck_gain;
                                    lvl.spectrum     = bus.spectrum;
                                    // v4.4.46 mix telemetry — snapshot per-deck + counters under the
                                    // SAME lock (no extra lock; diagnostic only). Fed to `[mix sN]`.
                                    lvl.frames_total = bus.frames_consumed;
                                    lvl.mon_vol      = bus.monitor_vol;
                                    // Audio Processing v1 meters (same lock; observed at the taps).
                                    lvl.proc_local       = bus.proc_local;
                                    lvl.proc_stream      = bus.proc_stream;
                                    lvl.proc_target_lufs = bus.proc_target_lufs;
                                    lvl.proc_in_lufs     = bus.proc_in_lufs;
                                    lvl.proc_out_lufs    = bus.proc_out_lufs;
                                    lvl.proc_gr_db       = bus.proc_gr_db;
                                    lvl.proc_ride_gain_db = bus.proc_ride_gain_db;
                                    lvl.proc_in_peak     = bus.proc_in_peak;
                                    lvl.proc_out_peak    = bus.proc_out_peak;
                                    let mut active = 0u32;
                                    // CART (slot 6) is reported HERE so jingles/carts carry a real
                                    // sample position too — without it every cart reads 0:00 forever.
                                    // It is addressed by the explicit "CART" literal: NEVER index
                                    // DECK_LETTERS[6] (len 6, A–F) — that panicked the cpal output
                                    // thread and caused permanent dead air.
                                    // docs/incident-jingle-cart-panic-2026-07-15.md
                                    // D/E/F ADDED 2026-08-18 so the AUX monitor strips have live
                                    // meters and positions. Deck slots 3/4/5 are valid indices into
                                    // `decks: [DeckSlot; 7]`, and — the point of the incident note
                                    // above — they are addressed by EXPLICIT LITERALS in this tuple
                                    // list, exactly like "CART". Nothing here indexes DECK_LETTERS,
                                    // which is what panicked the output thread on 2026-07-15.
                                    // SLICE 1 — the new source channels report too, through the
                                    // SAME generic per-slot vector D/E/F were added to on
                                    // 2026-08-18. Still explicit literals, still nothing indexing
                                    // DECK_LETTERS — the 2026-07-15 panic rule holds.
                                    let mut dt = Vec::with_capacity(SLOT_COUNT);
                                    for (i, id) in [(0usize, "A"), (1, "B"), (2, "C"),
                                                    (3, "D"), (4, "E"), (5, "F"), (6, "CART"),
                                                    (7, "S1"), (8, "S2"), (9, "S3"), (10, "S4"), (11, "S5")] {
                                        let d = &bus.decks[i];
                                        let present = d.source.is_some();
                                        // active_decks stays A/B/C ONLY — electron/audio-health.js
                                        // already consumes this number; adding CART would silently
                                        // change an existing health signal's meaning.
                                        if i < 3 && d.active && !d.paused && present { active += 1; }
                                        dt.push(DeckTel {
                                            id: id.to_string(),
                                            source_present: present,
                                            active: d.active,
                                            paused: d.paused,
                                            muted: d.muted,
                                            volume: d.volume,
                                            gain_db: d.gain_db,
                                            frames_played: d.frames_played,
                                            peak: bus.peaks[i],
                                            duck: bus.duck_enabled[i],
                                        });
                                    }
                                    lvl.active_decks = active;
                                    lvl.decks = dt;
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
                                // Mirror onto the ROOM chain's own EQ. Both instances must carry the
                                // same bands or the room would be tonally different from air whenever
                                // an aux deck is live and the room is running its own chain.
                                if let Ok(bus) = bus_cmd.lock() {
                                    if let Ok(mut eqr) = bus.eq_room.lock() { eqr.set_bands(&gains); }
                                }
                                if let Ok(bus) = bus_cmd.lock() {
                                    if let Ok(mut eq) = bus.eq.lock() {
                                        eq.set_bands(&gains);
                                    }
                                }
                            }
                            AudioCmd::SetMonitorVolume(v) => {
                                if let Ok(mut bus) = bus_cmd.lock() { bus.monitor_vol = v.clamp(0.0, 4.0); }
                            }
                            AudioCmd::SetMasterVolume(v) => {
                                // Clamped 0..=1: master is an attenuator on air. >1 would let the operator
                                // push the program bus into clipping ahead of the limiter.
                                if let Ok(mut bus) = bus_cmd.lock() { bus.master_vol = v.clamp(0.0, 1.0); }
                            }
                            AudioCmd::SetMasterMonitorVolume(v) => {
                                if let Ok(mut bus) = bus_cmd.lock() { bus.master_monitor_vol = v.clamp(0.0, 1.0); }
                            }
                            AudioCmd::SetProcessing { local, stream, target_lufs } => {
                                if let Ok(mut bus) = bus_cmd.lock() {
                                    bus.proc_local  = local;
                                    bus.proc_stream = stream;
                                    bus.proc_target_lufs = target_lufs.clamp(-30.0, -6.0);
                                }
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

    (tx, is_playing, levels, finished, tcp_port, delay)
}

// ── Helpers called from start_station_mixer ───────────────────────────────────

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

fn build_source(
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

fn restore_decks_after_switch(bus_cmd: &SharedBusState, sr: u32) {
    // Re-create decoders for decks that had a path but lost their source
    // when the device was switched (source was consumed up to the switch point
    // and needs to restart). Acceptable limitation: track restarts from beginning.
    let paths: Vec<(usize, String, f32)> = bus_cmd.lock().ok().map(|bus| {
        bus.decks.iter().enumerate()
            .filter(|(_, d)| !d.path.is_empty())
            .map(|(i, d)| (i, d.path.clone(), d.gain_db))
            .collect()
    }).unwrap_or_default();

    for (idx, path, gain_db) in paths {
        if let Some(src) = build_source(&path, sr) {
            if let Ok(mut bus) = bus_cmd.lock() {
                // Only replace if the source is gone (e.g. after a device failover mid-track)
                if bus.decks[idx].source.is_none() && bus.decks[idx].active {
                    bus.decks[idx].source = Some(src);
                    // SAMPLE CLOCK — the rebuilt decoder starts at the TOP of the file (see this
                    // function's header: "track restarts from beginning"), so the position must
                    // restart with it. Carrying the old count forward would report a position the
                    // listener is not hearing, and — because the daemon fires the segue on
                    // remaining = duration - position — would cut the restarted track off almost
                    // immediately. The jump to 0:00 on a card switch is real; show it.
                    bus.decks[idx].frames_played = 0;
                    // The FADER LEVEL survives a device failover untouched — same rule as Load: only the
                    // jock's hand moves it. This used to rebuild volume from gain_db, so a card switch
                    // mid-show silently reset every deck's fader to unity. gain_db still rides pre-fader
                    // at the mix and needs nothing done here; the slot already holds it.
                    let _ = gain_db;
                }
            }
        }
    }
}

// No global audio state (DESIGN-TRUTH §2): per-station liveness lives in STATION_CB_MS
// (above); the program-bus stream-client flag is per-station on BusState.stream_connected.

fn mixer_callback(
    data:    &mut [f32],
    ch:      u16,
    bus_arc: &SharedBusState,
    fin:     &FinishedFlags,
    playing: &Arc<Mutex<bool>>,
) {

    let device_frames = data.len() / ch as usize;
    if device_frames == 0 { return; }

    let mut bus = match bus_arc.try_lock() {
        Ok(b)  => b,
        Err(_) => { data.iter_mut().for_each(|s| *s = 0.0); return; }
    };

    let device_sr = bus.sample_rate;
    // How many PROGRAM_RATE (44100 Hz) frames cover this device buffer.
    // +2 is a rounding safety margin so we never under-read.
    let prog_frames = if device_sr == PROGRAM_RATE {
        device_frames
    } else {
        (device_frames as f64 * PROGRAM_RATE as f64 / device_sr as f64).ceil() as usize + 2
    };

    let mut mix_l = vec![0f32; prog_frames];
    let mut mix_r = vec![0f32; prog_frames];
    // ── ROOM vs AIR (2026-08-18) ─────────────────────────────────────────────────────────────────
    // core_* = every slot EXCEPT the aux decks — the room's programme base.
    // aux_*  = the aux decks a monitor slot has selected, PRE-CUT and PRE-FADER, at the slot level.
    // mix_*  = everything, unchanged — this is what airs.
    // Copied out before the &mut borrow of bus.decks below.
    let aux_gain = bus.aux_monitor_gain;
    let mut core_l = vec![0f32; prog_frames];
    let mut core_r = vec![0f32; prog_frames];
    let mut aux_l  = vec![0f32; prog_frames];
    let mut aux_r  = vec![0f32; prog_frames];
    // DUCKER (slice 3): the source contribution AT AIR LEVEL, and the part of it that arms the duck.
    //   src_* — every Source slot, post-cut/post-fader. NOT scaled by the monitor gain: aux_* is the
    //           ROOM feed and is a different signal entirely.
    //   det_* — only the Source slots whose duck toggle is on. A channel with ducking off still
    //           airs, it just does not push the music down.
    // core_* is already the music: every slot EXCEPT the Source slots. So core + src == mix by
    // construction, which is what makes the duck-off path provably bit-identical below.
    let duck_enabled = bus.duck_enabled;
    let duck_duckable = bus.duck_duckable;
    let mut src_l = vec![0f32; prog_frames];
    let mut src_r = vec![0f32; prog_frames];
    // RECEIVER SIDE: the non-source music splits in two. `duckable` is what the duck multiplies;
    // `immune` punches through at full level. core = duckable + immune, rebuilt after the duck, so
    // the room and the air both read one already-correct sum. Excluding at the source rather than
    // adding immune back afterwards: the same cost, and it says what it does.
    let mut imm_l = vec![0f32; prog_frames];
    let mut imm_r = vec![0f32; prog_frames];
    let mut det_l = vec![0f32; prog_frames];
    let mut det_r = vec![0f32; prog_frames];
    let mut duck_armed = false;    // at least one duck-enabled Source slot is actually producing
    let mut aux_present = false;   // an aux deck is producing audio → the room must use core_*
    let mut any_playing = false;
    let mut exhausted   = [false; SLOT_COUNT];
    let mut frame_peaks = [0.0f32; SLOT_COUNT]; // this-buffer post-fader peak per deck

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
        if is_aux { aux_present = true; }
        if is_aux && duck_enabled[i] { duck_armed = true; }
        let mut pk = 0.0f32;
        let mut pulled = 0u64;   // frames actually taken from THIS deck's source this buffer
        for f in 0..prog_frames {
            // Source is always stereo (UniformSourceIterator built with 2 ch)
            match src.next() {
                Some(l) => {
                    let r = src.next().unwrap_or(0.0);
                    let lv = l * vol;
                    let rv = r * vol;
                    mix_l[f] += lv;                       // AIR — every slot, unchanged
                    mix_r[f] += rv;
                    if !is_aux {                          // ROOM base — aux decks excluded entirely
                        core_l[f] += lv;
                        core_r[f] += rv;
                        // ...and, of that, the part the duck may NOT touch.
                        if !duck_duckable[i] { imm_l[f] += lv; imm_r[f] += rv; }
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
                None => { exhausted[i] = true; break; }
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

    for (i, done) in exhausted.iter().enumerate() {
        if *done {
            bus.decks[i].source = None;
            bus.decks[i].active = false;
            // Slot 6 is the CART overlay channel and is NOT in DECK_LETTERS (len 6, A–F). Before this
            // guard, a CART source playing to NATURAL END (first done by the maiden jingle overlay, 2026-07-15)
            // ran `DECK_LETTERS[6]` → index-out-of-bounds panic on the cpal output thread → the thread died →
            // permanent dead air. Handle the CART slot by its own "CART" finished key (the same key
            // lib.rs takes as fin_cart), never index DECK_LETTERS. See docs/incident-jingle-cart-panic-2026-07-15.md.
            let key = deck_finished_key(i);
            fin.set(key);
            eprintln!("[RUST] Deck {} finished (source exhausted)", key);
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

    let (out_l, out_r): (Vec<f32>, Vec<f32>) = if let Ok(mut eq) = bus.eq.try_lock() {
        let mut ol = Vec::with_capacity(prog_frames);
        let mut or_ = Vec::with_capacity(prog_frames);
        for f in 0..prog_frames {
            let (l, r) = eq.process_stereo(mix_l[f], mix_r[f]);
            ol.push(l.clamp(-1.0, 1.0));
            or_.push(r.clamp(-1.0, 1.0));
        }
        // Snapshot the analyzer spectrum while we hold the lock; published to bus below.
        eq_spectrum = Some(eq.spectrum());
        (ol, or_)
    } else {
        (mix_l.iter().map(|&s| s.clamp(-1.0, 1.0)).collect(),
         mix_r.iter().map(|&s| s.clamp(-1.0, 1.0)).collect())
    };

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
    let (out_l, out_r): (Vec<f32>, Vec<f32>) = if master_vol == 1.0 {
        (out_l, out_r)
    } else {
        (out_l.iter().map(|&s| s * master_vol).collect(),
         out_r.iter().map(|&s| s * master_vol).collect())
    };

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
    let (proc_l, proc_r): (Option<Vec<f32>>, Option<Vec<f32>>) = if bus.proc_local || bus.proc_stream {
        let target = bus.proc_target_lufs;
        let mut pl = out_l.clone();
        let mut pr = out_r.clone();
        let meters = if let Ok(mut p) = bus.processor.try_lock() {
            p.set_target(target);
            // §B.3a — freeze the loudness ride while the duck has the music down, so the two
            // features cannot fight. The meter still runs; only the corrective gain is held.
            p.set_ride_hold(duck_active);
            p.process_planar(&mut pl, &mut pr);
            Some((p.in_lufs(), p.out_lufs(), p.gain_reduction_db(), p.ride_gain_db()))
        } else { None };
        if let Some((il, ol, gr, ride)) = meters {
            let op = pl.iter().chain(pr.iter()).map(|&s| s.abs()).fold(0.0f32, f32::max);
            bus.proc_in_lufs = il; bus.proc_out_lufs = ol; bus.proc_gr_db = gr; bus.proc_ride_gain_db = ride;
            bus.proc_in_peak  = peak.max(bus.proc_in_peak * VU_RELEASE);
            bus.proc_out_peak = op.max(bus.proc_out_peak * VU_RELEASE);
            (Some(pl), Some(pr))
        } else { (None, None) }
    } else { (None, None) };

    // v4.4.46 mix telemetry: advance the frames-consumed counter (single u64 add under the lock we
    // already hold — no new lock, no atomic, RT-safe). GetLevel surfaces it; the daemon heartbeat
    // logs the per-interval delta as a live "callback is still pulling PCM" signal.
    bus.frames_consumed = bus.frames_consumed.wrapping_add(prog_frames as u64);

    // Program Bus: write 44100 Hz samples directly — ffmpeg always reads 44100 Hz.
    // Per-station stream-client flag (DESIGN-TRUTH §2) — only THIS station's Icecast
    // client presence gates THIS station's push; never a sibling's.
    if bus.stream_connected.load(Ordering::Relaxed) {
        // Stream drain taps PROCESSED when "Process stream" is on and the processed buffer exists, else clean.
        let use_proc = bus.proc_stream && proc_l.is_some();
        for f in 0..prog_frames {
            let (l, r) = if use_proc { (proc_l.as_ref().unwrap()[f], proc_r.as_ref().unwrap()[f]) } else { (out_l[f], out_r[f]) };
            let _ = bus.ring_prod.try_push(l);
            let _ = bus.ring_prod.try_push(r);
        }
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
    let room_owned: Option<(Vec<f32>, Vec<f32>)> = if aux_present {
        // The room's programme base is core_* (aux decks excluded), run through the room's OWN EQ and
        // master gain so A/B/C local monitoring is unchanged. Separate instances because both stages
        // are stateful and the air chain has already used its own on a different sum this callback.
        let (mut rl, mut rr): (Vec<f32>, Vec<f32>) = if let Ok(mut eqr) = bus.eq_room.try_lock() {
            let mut a = Vec::with_capacity(prog_frames);
            let mut b = Vec::with_capacity(prog_frames);
            for f in 0..prog_frames {
                let (l, r) = eqr.process_stereo(core_l[f], core_r[f]);
                a.push(l.clamp(-1.0, 1.0));
                b.push(r.clamp(-1.0, 1.0));
            }
            (a, b)
        } else {
            // Never block the audio thread for EQ — fall back to clean, exactly as the air chain does.
            (core_l.iter().map(|&s| s.clamp(-1.0, 1.0)).collect(),
             core_r.iter().map(|&s| s.clamp(-1.0, 1.0)).collect())
        };
        if master_vol != 1.0 {
            for f in 0..prog_frames { rl[f] *= master_vol; rr[f] *= master_vol; }
        }
        // Same PRE/POST monitor choice the operator already has for the room.
        if bus.proc_local {
            let target = bus.proc_target_lufs;
            if let Ok(mut p) = bus.processor_room.try_lock() {
                p.set_target(target);
                p.process_planar(&mut rl, &mut rr);
            }
        }
        // NOTE: the aux sum is NOT added here. It has exactly ONE destination — the device chosen in
        // the AUX MONITORS section — and it reaches it through the aux ring below. An earlier revision
        // mixed it into the room and then bypassed the station monitor fader so it would be audible;
        // that amounted to picking an output on the operator's behalf, which is unsafe on a broadcast
        // machine. Reverted deliberately (Jeff, 2026-08-18): no device chosen = silence.
        //
        // What this chain still does, and must: build the room from the NON-aux slots, so decks D/E/F
        // never sum into the station's local speaker output.
        let _ = &aux_l;   // consumed by the aux ring below, not by the room
        Some((rl, rr))
    } else { None };

    let (dl, dr): (&[f32], &[f32]) = if let Some((ref rl, ref rr)) = room_owned {
        (rl, rr)
    } else if bus.proc_local && proc_l.is_some() {
        (proc_l.as_ref().unwrap(), proc_r.as_ref().unwrap())
    } else { (&out_l, &out_r) };
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
            p.process_planar(&mut aux_l, &mut aux_r);
            Some((p.in_lufs(), p.out_lufs(), p.gain_reduction_db(), p.ride_gain_db()))
        } else { None };
        if let Some((il, ol, gr, ride)) = meters {
            bus.aux_proc_in_lufs = il;
            bus.aux_proc_out_lufs = ol;
            bus.aux_proc_gr_db = gr;
            bus.aux_proc_ride_db = ride;
        }
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

    if let Ok(mut p) = playing.try_lock() { *p = any_playing; }

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
