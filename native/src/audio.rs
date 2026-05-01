use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::collections::HashMap;
use serde::{Deserialize, Serialize};

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
}

impl FinishedFlags {
    pub fn new() -> Self {
        FinishedFlags {
            a: Arc::new(AtomicBool::new(false)),
            b: Arc::new(AtomicBool::new(false)),
            c: Arc::new(AtomicBool::new(false)),
        }
    }
    pub fn flag(&self, deck: &str) -> Option<&Arc<AtomicBool>> {
        match deck {
            "A" => Some(&self.a),
            "B" => Some(&self.b),
            "C" => Some(&self.c),
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
}

pub struct AudioState {
    pub deck_a: DeckMeta,
    pub deck_b: DeckMeta,
    pub deck_c: DeckMeta,
    pub sender: std::sync::mpsc::Sender<AudioCmd>,
    pub is_playing: Arc<Mutex<bool>>,
    pub levels: SharedLevels,
    pub finished: FinishedFlags,
    pub watchdog_active: bool,
    pub watchdog_threshold_sec: f64,
    pub watchdog_triggered_count: u32,
}

pub type SharedAudioState = Arc<Mutex<AudioState>>;

fn rand_level() -> f32 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().subsec_nanos();
    (t % 1000) as f32 / 1000.0
}

// ── TCP stream output ─────────────────────────────────────────────────────────
// One StationStream per deck per station. Port taken explicitly by caller.
// Port allocation: 9000 + station_id*100 + deck_offset (1-3).
//   Station 1: 9101 (deck A), 9102 (deck B), 9103 (deck C)
//   Station 3: 9301 (deck A), 9302 (deck B), 9303 (deck C)
// Rust listens; ffmpeg connects with: -f f32le -ar 44100 -ac 2 -i tcp://127.0.0.1:{port}

use std::net::{TcpListener, TcpStream};
use std::io::Write;

struct StationStream {
    client: Arc<Mutex<Option<TcpStream>>>,
    port:   u16,
}

impl StationStream {
    fn create(port: u16) -> Self {
        let addr = format!("127.0.0.1:{}", port);
        let client: Arc<Mutex<Option<TcpStream>>> = Arc::new(Mutex::new(None));
        let client_clone = client.clone();

        std::thread::spawn(move || {
            let listener = match TcpListener::bind(&addr) {
                Ok(l)  => { eprintln!("[RUST] Stream listener ready: {}", addr); l }
                Err(e) => { eprintln!("[RUST] Listener bind failed on {}: {}", addr, e); return; }
            };
            for incoming in listener.incoming() {
                match incoming {
                    Ok(stream) => {
                        eprintln!("[RUST] Stream client connected on port {}", port);
                        stream.set_nonblocking(false).ok();
                        stream.set_write_timeout(Some(std::time::Duration::from_millis(50))).ok();
                        if let Ok(mut guard) = client_clone.lock() {
                            *guard = Some(stream);
                        }
                    }
                    Err(e) => eprintln!("[RUST] Accept error on port {}: {}", port, e),
                }
            }
        });

        StationStream { client, port }
    }

    fn write_nonblocking(&self, samples: &[f32]) {
        if samples.is_empty() { return; }
        let bytes = unsafe {
            std::slice::from_raw_parts(samples.as_ptr() as *const u8, samples.len() * 4)
        };
        let Ok(mut guard) = self.client.try_lock() else { return };
        if let Some(stream) = guard.as_mut() {
            if stream.write_all(bytes).is_err() {
                *guard = None;
                eprintln!("[RUST] Stream client disconnected on port {}", self.port);
            }
        }
    }
}

// ── TeeSource ─────────────────────────────────────────────────────────────────
// Wraps a normalized f32 stereo 44100 Hz source (via UniformSourceIterator).
// Accumulates samples and flushes to the deck's TCP socket every flush_at samples —
// in the same audio thread as soundcard playback. No ring buffer, no clock drift.

struct TeeSource<S: rodio::Source<Item = f32>> {
    inner:    S,
    pipe:     Arc<StationStream>,
    buf:      Vec<f32>,
    flush_at: usize,
}

impl<S: rodio::Source<Item = f32>> TeeSource<S> {
    fn new(inner: S, pipe: Arc<StationStream>, flush_at: usize) -> Self {
        TeeSource { inner, pipe, buf: Vec::with_capacity(flush_at), flush_at }
    }
}

impl<S: rodio::Source<Item = f32>> Iterator for TeeSource<S> {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        let s = self.inner.next()?;
        self.buf.push(s);
        if self.buf.len() >= self.flush_at {
            self.pipe.write_nonblocking(&self.buf);
            self.buf.clear();
        }
        Some(s)
    }
}

impl<S: rodio::Source<Item = f32>> Drop for TeeSource<S> {
    fn drop(&mut self) {
        // Flush partial buffer when track ends mid-frame
        if !self.buf.is_empty() {
            self.pipe.write_nonblocking(&self.buf);
            self.buf.clear();
        }
    }
}

impl<S: rodio::Source<Item = f32>> rodio::Source for TeeSource<S> {
    fn current_frame_len(&self) -> Option<usize> { self.inner.current_frame_len() }
    fn channels(&self)     -> u16                { self.inner.channels() }
    fn sample_rate(&self)  -> u32                { self.inner.sample_rate() }
    fn total_duration(&self) -> Option<std::time::Duration> { self.inner.total_duration() }
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

    // One TCP listener per deck. Port = 9000 + station_id*100 + deck_offset(1-3).
    let stream_a = Arc::new(StationStream::create((9000 + station_id * 100 + 1) as u16));
    let stream_b = Arc::new(StationStream::create((9000 + station_id * 100 + 2) as u16));
    let stream_c = Arc::new(StationStream::create((9000 + station_id * 100 + 3) as u16));

    // ── Audio dispatch thread ─────────────────────────────────────────────────
    std::thread::spawn(move || {
        use rodio::{Decoder, OutputStream, Sink, Source};
        use rodio::source::UniformSourceIterator;
        use std::fs::File;
        use std::io::BufReader;

        let mut playing_decks: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut was_non_empty: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut loaded_files: HashMap<String, (String, String, String)> = HashMap::new();

        // 882 stereo f32 samples = 10 ms at 44100 Hz stereo (per-deck TCP flush granularity)
        const FLUSH_AT: usize = 882;
        let mut current_device_name = device_name;

        let pick_stream = |deck: &str| -> Arc<StationStream> {
            match deck {
                "A" => stream_a.clone(),
                "C" => stream_c.clone(),
                _   => stream_b.clone(),
            }
        };

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
                let stream = pick_stream(deck);
                if let Ok(file) = File::open(path) {
                    let reader = BufReader::new(file);
                    if let Ok(decoder) = Decoder::new(reader) {
                        let norm = UniformSourceIterator::<_, f32>::new(
                            decoder.convert_samples::<f32>(), 2, 44100,
                        );
                        let source = TeeSource::new(norm, stream, FLUSH_AT);
                        if let Ok(sink) = Sink::try_new(&stream_handle) {
                            if playing_decks.contains(deck) { sink.play(); } else { sink.pause(); }
                            sink.append(source);
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
                                let stream = pick_stream(&deck);
                                if let Ok(file) = File::open(&file_path) {
                                    let reader = BufReader::new(file);
                                    if let Ok(decoder) = Decoder::new(reader) {
                                        let norm = UniformSourceIterator::<_, f32>::new(
                                            decoder.convert_samples::<f32>(), 2, 44100,
                                        );
                                        let source = TeeSource::new(norm, stream, FLUSH_AT);
                                        if let Ok(sink) = Sink::try_new(&stream_handle) {
                                            sink.pause();
                                            if gain_db != 0.0 {
                                                let linear = 10f32.powf(gain_db / 20.0);
                                                sink.set_volume(linear.clamp(0.1, 4.0));
                                            }
                                            sink.append(source);
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
