use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use ringbuf::{HeapRb, HeapProd, traits::{Producer, Consumer, Observer, Split}};

// ── Audio-thread liveness (Phase 1 HA health signal) ──────────────────────────
// Stamped on every cpal output callback (any station). A relaxed atomic store —
// lock-free, safe on the real-time audio thread. Read by the napi getter
// `audioLastCallbackMs` for the /health endpoint (and, later, the dead-air
// watchdog). Value = epoch ms of the last output callback; 0 = never fired.
// The cpal stream callbacks fire continuously while the output stream is alive
// (even when idle/paused → silence), so this tracks ENGINE-THREAD liveness,
// independent of play state.
pub static LAST_AUDIO_CALLBACK_MS: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Stamp "now" as the last audio-callback time. Called from the cpal output
/// callback — relaxed store only, no locks/allocations in the hot path.
#[inline]
pub fn note_audio_callback() {
    LAST_AUDIO_CALLBACK_MS.store(now_ms(), Ordering::Relaxed);
}

/// Epoch ms of the most recent output callback (0 if none yet). Lock-free read.
pub fn last_audio_callback_ms() -> f64 {
    LAST_AUDIO_CALLBACK_MS.load(Ordering::Relaxed) as f64
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AudioLevels {
    pub level_a: f32,
    pub level_b: f32,
    pub level_c: f32,
    pub level_cart: f32,
    pub level_master: f32,
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
    SetEq(Vec<f32>),
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
}

impl BusState {
    pub fn new(eq: crate::eq::SharedEq, ring_prod: HeapProd<f32>, sample_rate: u32) -> Self {
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
                            AudioCmd::SetEq(_) => {}
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

    let shared_eq = crate::eq::new_shared_eq(44100.0);
    let bus_state: SharedBusState = Arc::new(Mutex::new(
        BusState::new(shared_eq, ring_prod, 44100)
    ));
    let bus_cmd = bus_state.clone(); // command thread's handle

    // ── TCP listener (Program Bus) ────────────────────────────────────────────
    let listener = TcpListener::bind("127.0.0.1:0")
        .expect("[RUST] Program Bus TCP bind failed");
    let tcp_port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    eprintln!("[RUST] Station {} Program Bus on TCP port {}", station_id, tcp_port);

    std::thread::spawn(move || {
        drain_program_bus(station_id, listener, ring_cons, delay_drain);
    });

    // ── Audio dispatch thread ─────────────────────────────────────────────────
    std::thread::spawn(move || {
        use cpal::traits::{DeviceTrait, StreamTrait};

        let mut current_device = device_name;

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

            let bus_cb  = bus_cmd.clone();
            let fin_cb  = finished_clone.clone();
            let play_cb = is_playing_clone.clone();

            let stream = device.build_output_stream::<f32, _, _>(
                &stream_config,
                move |data: &mut [f32], _| {
                    mixer_callback(data, ch, &bus_cb, &fin_cb, &play_cb);
                    note_audio_callback();
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
                                }
                            }
                            AudioCmd::SwitchDevice(name) => {
                                eprintln!("[RUST] Station {} SwitchDevice → {:?}", station_id, name);
                                current_device = if name.is_empty() { None } else { Some(name) };
                                break; // drop stream → 'outer reopens device
                            }
                            AudioCmd::SetEq(gains) => {
                                if let Ok(bus) = bus_cmd.lock() {
                                    if let Ok(mut eq) = bus.eq.lock() {
                                        eq.set_bands(&gains);
                                    }
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

// ── Temporary rate diagnostics — remove after B1 sign-off ────────────────────
static SAMPLES_PUSHED:           AtomicU64  = AtomicU64::new(0);
static LAST_REPORT_NS:           AtomicU64  = AtomicU64::new(0);
static CB_COUNT:                 AtomicU64  = AtomicU64::new(0);
static CB_REPORT_NS:             AtomicU64  = AtomicU64::new(0);
static LAST_CB_NS:               AtomicU64  = AtomicU64::new(0);
static STREAM_CLIENT_CONNECTED:  AtomicBool = AtomicBool::new(false);

fn mixer_callback(
    data:    &mut [f32],
    ch:      u16,
    bus_arc: &SharedBusState,
    fin:     &FinishedFlags,
    playing: &Arc<Mutex<bool>>,
) {
    // Callback fires/sec counter + stall detector
    let now_cb = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64).unwrap_or(0);
    let count = CB_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    let last_cb = CB_REPORT_NS.load(std::sync::atomic::Ordering::Relaxed);
    if last_cb == 0 {
        CB_REPORT_NS.store(now_cb, std::sync::atomic::Ordering::Relaxed);
    } else if now_cb > last_cb + 1_000_000_000 {
        eprintln!("[RUST] Callback fires/sec: {}  data.len={}  ch={}  (expected ~100 at 10ms/buf)",
            count, data.len(), ch);
        CB_REPORT_NS.store(now_cb, std::sync::atomic::Ordering::Relaxed);
        CB_COUNT.store(0, std::sync::atomic::Ordering::Relaxed);
    }
    // Stall detector: log if gap between callbacks exceeds 30ms (expected ~10ms)
    let last_ts = LAST_CB_NS.swap(now_cb, std::sync::atomic::Ordering::Relaxed);
    if last_ts > 0 {
        let gap_ms = (now_cb.saturating_sub(last_ts)) / 1_000_000;
        if gap_ms > 30 {
            eprintln!("[RUST] cpal callback gap: {}ms (expected ~10ms) — possible thread starvation", gap_ms);
        }
    }

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
            fin.set(DECK_LETTERS[i]);
            eprintln!("[RUST] Deck {} finished (source exhausted)", DECK_LETTERS[i]);
        }
    }

    // Apply EQ to the 44100 Hz stereo mix
    let (out_l, out_r): (Vec<f32>, Vec<f32>) = if let Ok(mut eq) = bus.eq.try_lock() {
        let mut ol = Vec::with_capacity(prog_frames);
        let mut or_ = Vec::with_capacity(prog_frames);
        for f in 0..prog_frames {
            let (l, r) = eq.process_stereo(mix_l[f], mix_r[f]);
            ol.push(l.clamp(-1.0, 1.0));
            or_.push(r.clamp(-1.0, 1.0));
        }
        (ol, or_)
    } else {
        (mix_l.iter().map(|&s| s.clamp(-1.0, 1.0)).collect(),
         mix_r.iter().map(|&s| s.clamp(-1.0, 1.0)).collect())
    };

    // Peak diagnostic — confirm mixer is producing audio, not silence
    static PEAK_REPORT_NS: AtomicU64 = AtomicU64::new(0);
    let peak = out_l.iter().chain(out_r.iter())
        .map(|&s| s.abs())
        .fold(0.0f32, f32::max);
    let now_ns_peak = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64).unwrap_or(0);
    let last_peak = PEAK_REPORT_NS.load(std::sync::atomic::Ordering::Relaxed);
    if now_ns_peak > last_peak + 1_000_000_000 {
        PEAK_REPORT_NS.store(now_ns_peak, std::sync::atomic::Ordering::Relaxed);
        let active_count = bus.decks.iter().filter(|d| d.active && !d.paused).count();
        eprintln!("[RUST] Mixer peak: {:.4}  active_decks={}", peak, active_count);
    }

    // Publish REAL VU levels — post-fader peak per deck + post-EQ program (master) peak,
    // with VU release ballistics (instant rise, smooth ~50ms fall). Read by GetLevel.
    const VU_RELEASE: f32 = 0.82;
    for i in 0..7 { bus.peaks[i] = frame_peaks[i].max(bus.peaks[i] * VU_RELEASE); }
    bus.master_peak = peak.max(bus.master_peak * VU_RELEASE);

    // Program Bus: write 44100 Hz samples directly — ffmpeg always reads 44100 Hz
    if STREAM_CLIENT_CONNECTED.load(Ordering::Relaxed) {
        for f in 0..prog_frames {
            let _ = bus.ring_prod.try_push(out_l[f]);
            let _ = bus.ring_prod.try_push(out_r[f]);
        }
    }

    // Studio Monitor Bus: resample 44100 Hz → device rate if they differ
    if device_sr == PROGRAM_RATE || prog_frames <= 1 {
        for f in 0..device_frames {
            if ch == 2 {
                data[f * 2]     = out_l[f];
                data[f * 2 + 1] = out_r[f];
            } else {
                data[f] = (out_l[f] + out_r[f]) * 0.5;
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
                data[f * 2]     = l;
                data[f * 2 + 1] = r;
            } else {
                data[f] = (l + r) * 0.5;
            }
        }
    }

    if let Ok(mut p) = playing.try_lock() { *p = any_playing; }

    // Rate diagnostic: count samples pushed to ring buffer, log once/sec
    let now_ns = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64).unwrap_or(0);
    let pushed = SAMPLES_PUSHED.fetch_add(
        prog_frames as u64 * 2, std::sync::atomic::Ordering::Relaxed,
    ) + prog_frames as u64 * 2;
    let last = LAST_REPORT_NS.load(std::sync::atomic::Ordering::Relaxed);
    if now_ns > last + 1_000_000_000 {
        LAST_REPORT_NS.store(now_ns, std::sync::atomic::Ordering::Relaxed);
        SAMPLES_PUSHED.store(0, std::sync::atomic::Ordering::Relaxed);
        let occupancy = PROGRAM_BUS_BUF - bus.ring_prod.vacant_len();
        eprintln!("[RUST] Program Bus rate: {} samples/sec  device_sr={}  prog_frames={}  device_frames={}  ring_occ={}/{}  (target 88200 = 44100×2ch)",
            pushed, device_sr, prog_frames, device_frames, occupancy, PROGRAM_BUS_BUF);
    }
}

fn drain_program_bus(
    station_id: u32,
    listener:   std::net::TcpListener,
    mut cons:   ringbuf::HeapCons<f32>,
    delay:      SharedDelay,
) {
    use std::io::Write;
    use std::collections::VecDeque;

    static DRAIN_BYTES_TOTAL:     AtomicU64 = AtomicU64::new(0);
    static DRAIN_ZERO_FILL_BYTES: AtomicU64 = AtomicU64::new(0);

    // 44100 Hz × 2 ch × 4 bytes/sample = 352800 bytes/sec
    const TARGET_BYTES_PER_SEC: f64 = 44100.0 * 2.0 * 4.0;

    loop {
        match listener.accept() {
            Ok((mut stream, addr)) => {
                eprintln!("[RUST] Station {} stream client connected: {}", station_id, addr);
                let _ = stream.set_nodelay(true);
                STREAM_CLIENT_CONNECTED.store(true, Ordering::Relaxed);
                DRAIN_BYTES_TOTAL.store(0, Ordering::Relaxed);
                DRAIN_ZERO_FILL_BYTES.store(0, Ordering::Relaxed);

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

                        let target      = delay.target_samples.load(Ordering::Relaxed);
                        let want_frames = max_samples / 2; // deficit is frame-aligned → even

                        // Consume ratio = source frames consumed per emitted frame.
                        //   • delay off, or at/above target → 1.0 (exact passthrough).
                        //   • below target → rebuild, but ONLY stretch through near-silence
                        //     (consume <1.0) so the delay grows imperceptibly; passthrough on
                        //     audible audio so nothing is pitch-shifted.
                        let ratio: f64 = if target == 0 || delay_fifo.len() >= target {
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
                            STREAM_CLIENT_CONNECTED.store(false, Ordering::Relaxed);
                            break;
                        }

                        bytes_written += deficit as u64;
                        real_bytes_since_log += real_byte_count as u64;
                        zero_bytes_since_log += zero_byte_count as u64;
                        DRAIN_BYTES_TOTAL.fetch_add(deficit as u64, Ordering::Relaxed);
                        DRAIN_ZERO_FILL_BYTES.fetch_add(zero_byte_count as u64, Ordering::Relaxed);
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
                STREAM_CLIENT_CONNECTED.store(false, Ordering::Relaxed);
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
