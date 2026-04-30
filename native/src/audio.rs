use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::collections::{HashMap, VecDeque};
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

// One AtomicBool per deck — set by audio thread when sink empties, cleared by command handler after reading
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

// ── Named pipe output (Piece 2) ───────────────────────────────────────────────

// Shared ring-buffer types
type DecBuf = Arc<Mutex<VecDeque<f32>>>;
type DecCh  = Arc<AtomicU32>;

// 4 seconds of f32 stereo at 44100 Hz = 352 800 samples per deck
const RING_CAP: usize = 352_800;

// Wraps a decoded f32 Source; copies each sample into a ring buffer as it passes through.
// rodio sees an ordinary Source — behaviour and timing are unaffected.
struct TeeSource<S> {
    inner: S,
    buf:   DecBuf,
    cap:   usize,
}

impl<S: rodio::Source<Item = f32>> TeeSource<S> {
    fn new(inner: S, buf: DecBuf, ch: &DecCh, cap: usize) -> Self {
        // Store channel count so the pipe writer knows the layout
        ch.store(inner.channels() as u32, Ordering::Relaxed);
        TeeSource { inner, buf, cap }
    }
}

impl<S: rodio::Source<Item = f32>> Iterator for TeeSource<S> {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        let s = self.inner.next()?;
        if let Ok(mut q) = self.buf.try_lock() {
            if q.len() >= self.cap {
                // Keep most-recent audio: evict oldest frames to make room
                let keep = self.cap.saturating_sub(1);
                let drop_n = q.len() - keep;
                q.drain(..drop_n);
            }
            q.push_back(s);
        }
        Some(s)
    }
}

impl<S: rodio::Source<Item = f32>> rodio::Source for TeeSource<S> {
    fn current_frame_len(&self) -> Option<usize> { self.inner.current_frame_len() }
    fn channels(&self)     -> u16                { self.inner.channels() }
    fn sample_rate(&self)  -> u32                { self.inner.sample_rate() }
    fn total_duration(&self) -> Option<std::time::Duration> { self.inner.total_duration() }
}

// Drain one deck's ring buffer into `out` (stereo f32le, BATCH samples).
// Sums into out (caller zeroed it); handles mono→stereo duplication.
fn mix_deck_into(buf: &DecBuf, ch: u16, out: &mut [f32]) {
    let Ok(mut q) = buf.try_lock() else { return };
    if q.is_empty() { return; }
    let n = out.len();
    let mut i = 0usize;
    if ch == 1 {
        while i + 1 < n {
            let Some(s) = q.pop_front() else { break };
            out[i]   += s;
            out[i+1] += s;
            i += 2;
        }
    } else {
        while i + 1 < n {
            let (Some(l), Some(r)) = (q.pop_front(), q.pop_front()) else { break };
            out[i]   += l;
            out[i+1] += r;
            i += 2;
        }
    }
}

// ── Named pipe: Windows implementation ───────────────────────────────────────
// Raw extern declarations against kernel32 — avoids windows-sys version issues.

#[cfg(windows)]
mod win32 {
    pub const INVALID_HANDLE_VALUE: isize  = -1isize;
    pub const PIPE_ACCESS_OUTBOUND: u32    = 0x0000_0002;
    pub const PIPE_TYPE_BYTE:       u32    = 0x0000_0000;
    pub const PIPE_NOWAIT:          u32    = 0x0000_0001;

    #[link(name = "kernel32")]
    extern "system" {
        pub fn CreateNamedPipeW(
            lpname:                  *const u16,
            dwopenmode:              u32,
            dwpipemode:              u32,
            nmaxinstances:           u32,
            noutbuffersize:          u32,
            ninbuffersize:           u32,
            ndefaulttimeout:         u32,
            lpsecurityattributes:    *const u8,
        ) -> isize;

        pub fn WriteFile(
            hfile:                   isize,
            lpbuffer:                *const u8,
            nnumberofbytestowrite:   u32,
            lpnumberofbyteswritten:  *mut u32,
            lpoverlapped:            *const u8,
        ) -> i32;

        pub fn CloseHandle(hobject: isize) -> i32;
    }
}

struct StationPipe {
    #[cfg(windows)]
    handle: isize,
    #[cfg(not(windows))]
    _station_id: u32,
}

// HANDLE is an integer; safe to move across threads for non-overlapped single-writer use.
unsafe impl Send for StationPipe {}

impl StationPipe {
    fn create(station_id: u32) -> Self {
        #[cfg(windows)]
        {
            use win32::*;
            let name: Vec<u16> = format!("\\\\.\\pipe\\ether-program-{}", station_id)
                .encode_utf16()
                .chain(std::iter::once(0u16))
                .collect();
            let h = unsafe {
                CreateNamedPipeW(
                    name.as_ptr(),
                    PIPE_ACCESS_OUTBOUND,
                    PIPE_TYPE_BYTE | PIPE_NOWAIT,
                    1,      // max instances
                    65536,  // outbound buffer bytes
                    0,      // inbound buffer (unused — outbound only)
                    0,      // default timeout
                    std::ptr::null(),
                )
            };
            if h == INVALID_HANDLE_VALUE {
                eprintln!("[RUST] Named pipe create failed for station {}", station_id);
            } else {
                eprintln!("[RUST] Named pipe ready: \\\\.\\pipe\\ether-program-{}", station_id);
            }
            StationPipe { handle: h }
        }
        #[cfg(not(windows))]
        {
            eprintln!("[RUST] Named pipe not implemented on this platform (station {})", station_id);
            StationPipe { _station_id: station_id }
        }
    }

    // Non-blocking write — PIPE_NOWAIT returns immediately when no reader is connected.
    fn write_nonblocking(&self, samples: &[f32]) {
        if samples.is_empty() { return; }
        #[cfg(windows)]
        {
            use win32::*;
            if self.handle == INVALID_HANDLE_VALUE { return; }
            let mut written: u32 = 0;
            unsafe {
                WriteFile(
                    self.handle,
                    samples.as_ptr() as *const u8,
                    (samples.len() * 4) as u32,
                    &mut written,
                    std::ptr::null(),
                );
                // Return value intentionally ignored — error means no reader connected
            }
        }
    }
}

impl Drop for StationPipe {
    fn drop(&mut self) {
        #[cfg(windows)]
        {
            use win32::*;
            if self.handle != INVALID_HANDLE_VALUE {
                unsafe { CloseHandle(self.handle); }
            }
        }
    }
}

// ── Audio thread ──────────────────────────────────────────────────────────────

pub fn start_audio_thread(station_id: u32) -> (
    std::sync::mpsc::Sender<AudioCmd>,
    Arc<Mutex<bool>>,
    SharedLevels,
    FinishedFlags,
) {
    let (tx, rx) = std::sync::mpsc::channel::<AudioCmd>();
    let is_playing  = Arc::new(Mutex::new(false));
    let is_playing_clone = is_playing.clone();
    let levels: SharedLevels = Arc::new(Mutex::new(AudioLevels::default()));
    let levels_clone = levels.clone();
    let finished = FinishedFlags::new();
    let finished_clone = finished.clone();

    // Per-deck ring buffers and channel-count atomics for the pipe output path
    let buf_a: DecBuf = Arc::new(Mutex::new(VecDeque::with_capacity(RING_CAP)));
    let buf_b: DecBuf = Arc::new(Mutex::new(VecDeque::with_capacity(RING_CAP)));
    let buf_c: DecBuf = Arc::new(Mutex::new(VecDeque::with_capacity(RING_CAP)));
    let ch_a:  DecCh  = Arc::new(AtomicU32::new(2));
    let ch_b:  DecCh  = Arc::new(AtomicU32::new(2));
    let ch_c:  DecCh  = Arc::new(AtomicU32::new(2));

    // ── Pipe writer thread ────────────────────────────────────────────────────
    // Opens the named pipe at startup and keeps it live indefinitely.
    // Drains all three deck ring buffers every 10 ms, software-mixes, writes.
    // PIPE_NOWAIT: writes discard silently when no ffmpeg reader is connected.
    {
        let (pa, pb, pc) = (buf_a.clone(), buf_b.clone(), buf_c.clone());
        let (ca, cb, cc) = (ch_a.clone(), ch_b.clone(), ch_c.clone());
        std::thread::spawn(move || {
            let pipe = StationPipe::create(station_id);
            // 44 100 Hz × 2 ch × 10 ms = 882 samples per batch
            const BATCH: usize = 882;
            loop {
                std::thread::sleep(std::time::Duration::from_millis(10));
                let mut out = [0.0f32; BATCH];
                mix_deck_into(&pa, ca.load(Ordering::Relaxed) as u16, &mut out);
                mix_deck_into(&pb, cb.load(Ordering::Relaxed) as u16, &mut out);
                mix_deck_into(&pc, cc.load(Ordering::Relaxed) as u16, &mut out);
                for s in &mut out { *s = s.clamp(-1.0, 1.0); }
                pipe.write_nonblocking(&out);
            }
        });
    }

    // ── Audio dispatch thread ─────────────────────────────────────────────────
    std::thread::spawn(move || {
        use rodio::{Decoder, OutputStream, Sink, Source};
        use std::fs::File;
        use std::io::BufReader;

        let mut playing_decks: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut was_non_empty: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut loaded_files: HashMap<String, (String, String, String)> = HashMap::new();

        // Returns (buf_clone, ch_clone) for a given deck letter
        let pick = |deck: &str| -> (DecBuf, DecCh) {
            match deck {
                "A" => (buf_a.clone(), ch_a.clone()),
                "C" => (buf_c.clone(), ch_c.clone()),
                _   => (buf_b.clone(), ch_b.clone()),
            }
        };

        'outer: loop {
            let stream_result = OutputStream::try_default();
            let (_stream, stream_handle) = match stream_result {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("Audio output failed: {} - retrying in 2s", e);
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    continue 'outer;
                }
            };

            let mut sinks: HashMap<String, Sink> = HashMap::new();
            eprintln!("Audio output device ready");

            // Restore previously playing tracks after device failover
            for (deck, (path, _title, _artist)) in &loaded_files {
                let (buf, ch) = pick(deck);
                if let Ok(file) = File::open(path) {
                    let reader = BufReader::new(file);
                    if let Ok(decoder) = Decoder::new(reader) {
                        let source = TeeSource::new(decoder.convert_samples::<f32>(), buf, &ch, RING_CAP);
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
                                let (buf, ch) = pick(&deck);
                                // Discard stale samples so new track starts clean on the pipe
                                if let Ok(mut q) = buf.try_lock() { q.clear(); }
                                if let Ok(file) = File::open(&file_path) {
                                    let reader = BufReader::new(file);
                                    if let Ok(decoder) = Decoder::new(reader) {
                                        let source = TeeSource::new(decoder.convert_samples::<f32>(), buf, &ch, RING_CAP);
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
                                let (buf, _ch) = pick(&deck);
                                if let Ok(mut q) = buf.try_lock() { q.clear(); }
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
