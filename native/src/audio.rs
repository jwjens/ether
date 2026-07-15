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
}

pub struct DeckMeta {
    pub title: String,
    pub artist: String,
    pub file_path: String,
    pub volume: f32,
    pub gain_db: f32,
    pub status: String,
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
    pub volume: f32,           // linear fader (post-gain)
    pub gain_db: f32,          // per-deck trim in dB
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AudioLevels {
    pub level_a: f32,
    pub level_b: f32,
    pub level_c: f32,
    pub level_cart: f32,
    pub level_master: f32,
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
}

impl DeckSlot {
    pub fn new() -> Self {
        DeckSlot {
            source:  None,
            volume:  1.0,
            paused:  true,
            active:  false,
            path:    String::new(),
            title:   String::new(),
            artist:  String::new(),
            gain_db: 0.0,
        }
    }
}

// ── BusState ──────────────────────────────────────────────────────────────────
// Shared between the cpal callback (audio OS thread) and the command dispatch
// thread. The Mutex is held for the minimum time — decode happens outside.
// Six decks: index 0=A, 1=B, 2=C, 3=D, 4=E, 5=F.

pub struct BusState {
    pub decks:       [DeckSlot; 7],
    pub eq:          crate::eq::SharedEq,
    pub ring_prod:   HeapProd<f32>,
    pub sample_rate: u32,
    /// REAL post-fader peak per deck (0..1, 1.0 = 0 dBFS) + the program/master peak,
    /// written by mixer_callback each buffer with VU release ballistics; read by GetLevel.
    pub peaks:       [f32; 7],
    pub master_peak: f32,
    /// 10-band post-EQ master spectrum snapshot, written by mixer_callback from the
    /// EQ analyzer each buffer; read by GetLevel into AudioLevels.spectrum.
    pub spectrum:    [f32; 10],
    /// Local studio-monitor gain applied to the DEVICE (speaker) output only — never the
    /// program bus. 1.0 = unity; 0.0 = silent speakers while the station keeps broadcasting.
    pub monitor_vol: f32,
    /// Per-station program-bus stream-client flag (DESIGN-TRUTH §2). Set by THIS
    /// station's drain thread on its Icecast client connect/disconnect; read by THIS
    /// station's mixer callback to gate its own program-bus push. Never shared.
    pub stream_connected: Arc<AtomicBool>,
    /// v4.4.46: monotonic count of PROGRAM-RATE frames the mixer callback has consumed. Written
    /// ONLY by mixer_callback under the lock it already holds (no new lock, no atomic); read by
    /// GetLevel into AudioLevels.frames_total. The daemon heartbeat logs the delta = a live "is the
    /// callback still pulling PCM?" signal, distinct from the VU levels and the cpal-callback stamp.
    pub frames_consumed: u64,
}

impl BusState {
    pub fn new(eq: crate::eq::SharedEq, ring_prod: HeapProd<f32>, sample_rate: u32, stream_connected: Arc<AtomicBool>) -> Self {
        BusState {
            decks: [
                DeckSlot::new(), DeckSlot::new(), DeckSlot::new(),
                DeckSlot::new(), DeckSlot::new(), DeckSlot::new(),
                DeckSlot::new(), // slot 6 = dedicated cart channel ("CART")
            ],
            eq,
            ring_prod,
            sample_rate,
            peaks:       [0.0; 7],
            master_peak: 0.0,
            spectrum:    [0.0; 10],
            monitor_vol: 1.0,
            stream_connected,
            frames_consumed: 0,
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

// Finished-flag key for a mixer deck slot. Slots 0–5 are the assignable decks (A–F); slot 6 is the CART
// overlay channel, which is NOT in DECK_LETTERS. This is bounds-safe for any i (returns "CART" for the cart
// slot and anything ≥ DECK_LETTERS.len()), so a CART source exhausting can never index out of bounds — the
// crash that killed the cpal output thread on the maiden jingle fire (2026-07-15).
#[inline]
fn deck_finished_key(i: usize) -> &'static str {
    if i < DECK_LETTERS.len() { DECK_LETTERS[i] } else { "CART" }
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
        assert_eq!(deck_finished_key(99), "CART");  // any out-of-range slot never panics
    }
}
const PROGRAM_RATE:   u32       = 44100;
const PROGRAM_BUS_BUF: usize    = PROGRAM_RATE as usize * 2 * 4; // 4 s at 44100 Hz stereo

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
                                    slot.gain_db  = gain_db;
                                    slot.volume   = if gain_db != 0.0 {
                                        10f32.powf(gain_db / 20.0).clamp(0.1, 4.0)
                                    } else { 1.0 };
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
                                }
                            }
                            AudioCmd::SetVolume { deck, volume } => {
                                let Some(idx) = deck_index(&deck) else { continue };
                                if let Ok(mut bus) = bus_cmd.lock() {
                                    bus.decks[idx].volume = volume;
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
                                    lvl.spectrum     = bus.spectrum;
                                    // v4.4.46 mix telemetry — snapshot per-deck + counters under the
                                    // SAME lock (no extra lock; diagnostic only). Fed to `[mix sN]`.
                                    lvl.frames_total = bus.frames_consumed;
                                    lvl.mon_vol      = bus.monitor_vol;
                                    let mut active = 0u32;
                                    let mut dt = Vec::with_capacity(3);
                                    for (i, id) in [(0usize, "A"), (1, "B"), (2, "C")] {
                                        let d = &bus.decks[i];
                                        let present = d.source.is_some();
                                        if d.active && !d.paused && present { active += 1; }
                                        dt.push(DeckTel {
                                            id: id.to_string(),
                                            source_present: present,
                                            active: d.active,
                                            paused: d.paused,
                                            volume: d.volume,
                                            gain_db: d.gain_db,
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
                                if let Ok(bus) = bus_cmd.lock() {
                                    if let Ok(mut eq) = bus.eq.lock() {
                                        eq.set_bands(&gains);
                                    }
                                }
                            }
                            AudioCmd::SetMonitorVolume(v) => {
                                if let Ok(mut bus) = bus_cmd.lock() { bus.monitor_vol = v.clamp(0.0, 4.0); }
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
                    bus.decks[idx].volume = if gain_db != 0.0 {
                        10f32.powf(gain_db / 20.0).clamp(0.1, 4.0)
                    } else { 1.0 };
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
    let mut any_playing = false;
    let mut exhausted   = [false; 7];
    let mut frame_peaks = [0.0f32; 7]; // this-buffer post-fader peak per deck

    for (i, deck) in bus.decks.iter_mut().enumerate() {
        if !deck.active || deck.paused { continue; }
        let Some(ref mut src) = deck.source else {
            // active=true but source=None is a stuck state — self-heal so GetLevel
            // stops generating fake levels and CPAL stops silently skipping the deck.
            deck.active = false;
            continue;
        };
        any_playing = true;
        let vol = deck.volume;
        let mut pk = 0.0f32;
        for f in 0..prog_frames {
            // Source is always stereo (UniformSourceIterator built with 2 ch)
            match src.next() {
                Some(l) => {
                    let r = src.next().unwrap_or(0.0);
                    let lv = l * vol;
                    let rv = r * vol;
                    mix_l[f] += lv;
                    mix_r[f] += rv;
                    let a = lv.abs().max(rv.abs());
                    if a > pk { pk = a; }
                }
                None => { exhausted[i] = true; break; }
            }
        }
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

    // Program/master peak for VU (functional — feeds master_peak below).
    let peak = out_l.iter().chain(out_r.iter())
        .map(|&s| s.abs())
        .fold(0.0f32, f32::max);

    // Publish REAL VU levels — post-fader peak per deck + post-EQ program (master) peak,
    // with VU release ballistics (instant rise, smooth ~50ms fall). Read by GetLevel.
    const VU_RELEASE: f32 = 0.82;
    for i in 0..7 { bus.peaks[i] = frame_peaks[i].max(bus.peaks[i] * VU_RELEASE); }
    bus.master_peak = peak.max(bus.master_peak * VU_RELEASE);

    // v4.4.46 mix telemetry: advance the frames-consumed counter (single u64 add under the lock we
    // already hold — no new lock, no atomic, RT-safe). GetLevel surfaces it; the daemon heartbeat
    // logs the per-interval delta as a live "callback is still pulling PCM" signal.
    bus.frames_consumed = bus.frames_consumed.wrapping_add(prog_frames as u64);

    // Program Bus: write 44100 Hz samples directly — ffmpeg always reads 44100 Hz.
    // Per-station stream-client flag (DESIGN-TRUTH §2) — only THIS station's Icecast
    // client presence gates THIS station's push; never a sibling's.
    if bus.stream_connected.load(Ordering::Relaxed) {
        for f in 0..prog_frames {
            let _ = bus.ring_prod.try_push(out_l[f]);
            let _ = bus.ring_prod.try_push(out_r[f]);
        }
    }

    // Studio Monitor Bus: resample 44100 Hz → device rate if they differ. The monitor gain
    // (local speaker level) is applied HERE only — the program bus above already pushed full
    // level to Icecast, so turning the monitor down never changes what airs.
    let mvol = bus.monitor_vol;
    if device_sr == PROGRAM_RATE || prog_frames <= 1 {
        for f in 0..device_frames {
            if ch == 2 {
                data[f * 2]     = out_l[f] * mvol;
                data[f * 2 + 1] = out_r[f] * mvol;
            } else {
                data[f] = (out_l[f] + out_r[f]) * 0.5 * mvol;
            }
        }
    } else {
        // Linear interpolation: map device_frames output positions into prog_frames input
        let scale = (prog_frames - 1) as f64 / (device_frames - 1).max(1) as f64;
        for f in 0..device_frames {
            let t    = f as f64 * scale;
            let idx  = t as usize;
            let frac = (t - idx as f64) as f32;
            let l0 = out_l[idx];
            let l1 = out_l.get(idx + 1).copied().unwrap_or(l0);
            let r0 = out_r[idx];
            let r1 = out_r.get(idx + 1).copied().unwrap_or(r0);
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
