use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use ringbuf::{HeapRb, HeapProd, traits::{Producer, Consumer, Split}};

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
}

pub type SharedLevels = Arc<Mutex<AudioLevels>>;

#[derive(Clone)]
pub struct FinishedFlags {
    pub a: Arc<AtomicBool>,
    pub b: Arc<AtomicBool>,
    pub c: Arc<AtomicBool>,
    pub d: Arc<AtomicBool>,
    pub e: Arc<AtomicBool>,
    pub f: Arc<AtomicBool>,
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
    pub sender: std::sync::mpsc::Sender<AudioCmd>,
    pub is_playing: Arc<Mutex<bool>>,
    pub levels: SharedLevels,
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
    pub decks:       [DeckSlot; 6],
    pub eq:          crate::eq::SharedEq,
    pub ring_prod:   HeapProd<f32>,
    pub sample_rate: u32,
}

impl BusState {
    pub fn new(eq: crate::eq::SharedEq, ring_prod: HeapProd<f32>, sample_rate: u32) -> Self {
        BusState {
            decks: [
                DeckSlot::new(), DeckSlot::new(), DeckSlot::new(),
                DeckSlot::new(), DeckSlot::new(), DeckSlot::new(),
            ],
            eq,
            ring_prod,
            sample_rate,
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

const DECK_LETTERS: [&str; 6] = ["A", "B", "C", "D", "E", "F"];
const PROGRAM_BUS_BUF: usize  = 44100 * 2 * 4; // 4 s at 44100 Hz stereo

pub fn start_station_mixer(station_id: u32, device_name: Option<String>) -> (
    std::sync::mpsc::Sender<AudioCmd>,
    Arc<Mutex<bool>>,
    SharedLevels,
    FinishedFlags,
    u16,  // Program Bus TCP port
) {
    use std::net::TcpListener;

    let (tx, rx) = std::sync::mpsc::channel::<AudioCmd>();
    let is_playing       = Arc::new(Mutex::new(false));
    let is_playing_clone = is_playing.clone();
    let levels: SharedLevels = Arc::new(Mutex::new(AudioLevels::default()));
    let levels_clone     = levels.clone();
    let finished         = FinishedFlags::new();
    let finished_clone   = finished.clone();

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
        drain_program_bus(station_id, listener, ring_cons);
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
                                if let (Ok(bus), Ok(mut lvl)) =
                                    (bus_cmd.lock(), levels_clone.lock())
                                {
                                    for i in 0..3 {
                                        let active = bus.decks[i].active && !bus.decks[i].paused;
                                        let v = if active { 0.5 + rand_level() * 0.5 } else { 0.0 };
                                        match i {
                                            0 => lvl.level_a = v,
                                            1 => lvl.level_b = v,
                                            _ => lvl.level_c = v,
                                        }
                                    }
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

    (tx, is_playing, levels, finished, tcp_port)
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
    sample_rate: u32,
) -> Option<Box<dyn Iterator<Item = f32> + Send>> {
    use rodio::source::UniformSourceIterator;
    use rodio::Source;
    use std::fs::File;
    use std::io::BufReader;
    let file    = File::open(file_path).ok()?;
    let decoder = rodio::Decoder::new(BufReader::new(file)).ok()?;
    let norm    = UniformSourceIterator::<_, f32>::new(
        decoder.convert_samples::<f32>(), 2, sample_rate,
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

fn mixer_callback(
    data:    &mut [f32],
    ch:      u16,
    bus_arc: &SharedBusState,
    fin:     &FinishedFlags,
    playing: &Arc<Mutex<bool>>,
) {
    let frames = data.len() / ch as usize;
    let mut bus = match bus_arc.try_lock() {
        Ok(b)  => b,
        Err(_) => { data.iter_mut().for_each(|s| *s = 0.0); return; }
    };

    let mut mix_l = vec![0f32; frames];
    let mut mix_r = vec![0f32; frames];
    let mut any_playing = false;
    let mut exhausted   = [false; 6];

    for (i, deck) in bus.decks.iter_mut().enumerate() {
        if !deck.active || deck.paused { continue; }
        let Some(ref mut src) = deck.source else { continue };
        any_playing = true;
        for f in 0..frames {
            match src.next() {
                Some(l) => {
                    let r = if ch == 2 { src.next().unwrap_or(0.0) } else { l };
                    mix_l[f] += l * deck.volume;
                    mix_r[f] += r * deck.volume;
                }
                None => { exhausted[i] = true; break; }
            }
        }
    }

    // Mark exhausted decks; set finished flags outside the lock would be ideal
    // but we set them here under the existing lock to keep it simple.
    for (i, done) in exhausted.iter().enumerate() {
        if *done {
            bus.decks[i].source = None;
            bus.decks[i].active = false;
            fin.set(DECK_LETTERS[i]);
            eprintln!("[RUST] Deck {} finished (source exhausted)", DECK_LETTERS[i]);
        }
    }

    // Apply EQ to stereo mix
    let (out_l, out_r): (Vec<f32>, Vec<f32>) = if let Ok(mut eq) = bus.eq.try_lock() {
        let mut ol = Vec::with_capacity(frames);
        let mut or_ = Vec::with_capacity(frames);
        for f in 0..frames {
            let (l, r) = eq.process_stereo(mix_l[f], mix_r[f]);
            ol.push(l.clamp(-1.0, 1.0));
            or_.push(r.clamp(-1.0, 1.0));
        }
        (ol, or_)
    } else {
        (mix_l.iter().map(|&s| s.clamp(-1.0, 1.0)).collect(),
         mix_r.iter().map(|&s| s.clamp(-1.0, 1.0)).collect())
    };

    // Write to hardware output (Studio Monitor Bus)
    for f in 0..frames {
        if ch == 2 {
            data[f * 2]     = out_l[f];
            data[f * 2 + 1] = out_r[f];
        } else {
            data[f] = (out_l[f] + out_r[f]) * 0.5;
        }
    }

    // Tap to Program Bus ring buffer — drop newest if full (non-blocking)
    for f in 0..frames {
        let _ = bus.ring_prod.try_push(out_l[f]);
        let _ = bus.ring_prod.try_push(out_r[f]);
    }

    if let Ok(mut p) = playing.try_lock() { *p = any_playing; }
}

fn drain_program_bus(
    station_id: u32,
    listener:   std::net::TcpListener,
    mut cons:   ringbuf::HeapCons<f32>,
) {
    use std::io::Write;
    // Pre-allocated silence for stream-keepalive when buffer drains
    let silence: Vec<u8> = vec![0u8; 256 * 4]; // 256 f32 frames of silence

    loop {
        match listener.accept() {
            Ok((mut stream, addr)) => {
                eprintln!("[RUST] Station {} stream client connected: {}", station_id, addr);
                let mut chunk = vec![0f32; 1024];
                loop {
                    let n = cons.pop_slice(&mut chunk);
                    if n > 0 {
                        // SAFETY: f32 -> [u8; 4] via to_le_bytes; Vec<u8> stays in scope
                        let byte_len = n * 4;
                        let mut bytes = Vec::with_capacity(byte_len);
                        for &s in &chunk[..n] {
                            bytes.extend_from_slice(&s.to_le_bytes());
                        }
                        if stream.write_all(&bytes).is_err() { break; }
                    } else {
                        // Buffer empty — send silence to keep ffmpeg connection alive
                        if stream.write_all(&silence).is_err() { break; }
                        std::thread::sleep(std::time::Duration::from_millis(5));
                    }
                }
                eprintln!("[RUST] Station {} stream client disconnected", station_id);
            }
            Err(e) => {
                eprintln!("[RUST] Station {} TCP accept error: {}", station_id, e);
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
    }
}
