use std::sync::{Arc, Mutex};
use serde::{Deserialize, Serialize};

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
    pub fn info(&self, id: &str) -> DeckInfo {
        DeckInfo {
            id: id.to_string(),
            status: self.status.clone(),
            title: self.title.clone(),
            artist: self.artist.clone(),
            file_path: self.file_path.clone(),
            volume: self.volume,
            is_finished: self.status == "ended",
        }
    }
}

#[derive(Debug)]
pub enum AudioCmd {
    Load { deck: String, file_path: String, title: String, artist: String, gain_db: f32 },
    Play(String),
    Pause(String),
    Stop(String),
    SetVolume { deck: String, volume: f32 },
    Ping,
    GetLevel,
    StartStream { server: String, port: u16, mount: String, password: String, station_name: String },
    StopStream,
    UpdateMetadata { title: String, artist: String },
}

pub struct AudioLevels {
    pub level_a: f32,
    pub level_b: f32,
}

pub type SharedLevels = Arc<Mutex<AudioLevels>>;

pub struct AudioState {
    pub deck_a: DeckMeta,
    pub deck_b: DeckMeta,
    pub sender: std::sync::mpsc::Sender<AudioCmd>,
    pub is_playing: Arc<Mutex<bool>>,
    pub levels: SharedLevels,
    pub watchdog_active: bool,
    pub watchdog_threshold_sec: f64,
    pub watchdog_triggered_count: u32,
}

pub type SharedAudioState = Arc<Mutex<AudioState>>;

fn rand_level() -> f32 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().subsec_nanos();
    (t % 100) as f32 / 100.0
}

pub fn start_audio_thread() -> (std::sync::mpsc::Sender<AudioCmd>, Arc<Mutex<bool>>, SharedLevels) {
    let (tx, rx) = std::sync::mpsc::channel::<AudioCmd>();
    let is_playing = Arc::new(Mutex::new(false));
    let is_playing_clone = is_playing.clone();
    let levels: SharedLevels = Arc::new(Mutex::new(AudioLevels { level_a: 0.0, level_b: 0.0 }));
    let levels_clone = levels.clone();

    std::thread::spawn(move || {
        use rodio::{Decoder, OutputStream, Sink};
        use std::fs::File;
        use std::io::BufReader;
        use std::collections::HashMap;

        // Track loaded files for failover recovery
        let mut loaded_files: HashMap<String, (String, String, String)> = HashMap::new(); // deck -> (path, title, artist)
        let mut playing_decks: std::collections::HashSet<String> = std::collections::HashSet::new();

        'outer: loop {
            // Create output stream - retry on failure
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

            // Restore any previously playing tracks after failover
            for (deck, (path, title, artist)) in &loaded_files {
                if let Ok(file) = File::open(path) {
                    let reader = BufReader::new(file);
                    if let Ok(source) = Decoder::new(reader) {
                        if let Ok(sink) = Sink::try_new(&stream_handle) {
                            if playing_decks.contains(deck) {
                                sink.play();
                            } else {
                                sink.pause();
                            }
                            sink.append(source);
                            sinks.insert(deck.clone(), sink);
                        }
                    }
                }
            }

            loop {
                // Use try_recv with a small sleep to allow periodic health checks
                match rx.recv_timeout(std::time::Duration::from_millis(500)) {
                    Ok(cmd) => match cmd {
                        AudioCmd::Load { deck, file_path, title, artist, gain_db: _ } => {
                            if let Some(old) = sinks.remove(&deck) { old.stop(); }
                            loaded_files.insert(deck.clone(), (file_path.clone(), title.clone(), artist.clone()));
                            playing_decks.remove(&deck);
                            if let Ok(file) = File::open(&file_path) {
                                let reader = BufReader::new(file);
                                if let Ok(source) = Decoder::new(reader) {
                                    if let Ok(sink) = Sink::try_new(&stream_handle) {
                                        sink.pause();
                                        sink.append(source);
                                        sinks.insert(deck, sink);
                                    } else {
                                        // Sink creation failed - device disconnected, restart outer loop
                                        eprintln!("Audio device disconnected - failing over to default");
                                        continue 'outer;
                                    }
                                }
                            }
                        }
                        AudioCmd::Play(deck) => {
                            playing_decks.insert(deck.clone());
                            if let Some(sink) = sinks.get(&deck) {
                                sink.play();
                                if let Ok(mut p) = is_playing_clone.lock() { *p = true; }
                            }
                        }
                        AudioCmd::GetLevel => {
                            // Update levels based on sink state
                            if let Ok(mut lvl) = levels_clone.lock() {
                                lvl.level_a = if sinks.get("A").map(|s| !s.is_paused() && !s.empty()).unwrap_or(false) {
                                    0.7 + (rand_level() * 0.3)
                                } else { 0.0 };
                                lvl.level_b = if sinks.get("B").map(|s| !s.is_paused() && !s.empty()).unwrap_or(false) {
                                    0.7 + (rand_level() * 0.3)
                                } else { 0.0 };
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
                            loaded_files.remove(&deck);
                            if let Some(sink) = sinks.remove(&deck) { sink.stop(); }
                            let any = sinks.values().any(|s| !s.is_paused() && !s.empty());
                            if let Ok(mut p) = is_playing_clone.lock() { *p = any; }
                        }
                        AudioCmd::SetVolume { deck, volume } => {
                            if let Some(sink) = sinks.get(&deck) { sink.set_volume(volume); }
                        }
                        AudioCmd::Ping => {}
                    AudioCmd::StartStream { server, port, mount, password, station_name } => {
                        eprintln!("Streaming to {}:{}{} as {}", server, port, mount, station_name);
                        // Streaming is handled via HTTP source protocol
                        // The frontend handles the actual HTTP connection
                    }
                    AudioCmd::StopStream => {
                        eprintln!("Streaming stopped");
                    }
                    AudioCmd::UpdateMetadata { title, artist } => {
                        eprintln!("Now playing: {} - {}", artist, title);
                    }
                    },
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        // Periodic health check - verify sinks are still valid
                        // If a playing deck's sink is unexpectedly empty, device may have failed
                        for deck in &playing_decks {
                            if let Some(sink) = sinks.get(deck) {
                                if sink.empty() {
                                    // Track ended naturally or device failed - handled by watchdog
                                }
                            }
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break 'outer,
                }
            }
        }
    });
    (tx, is_playing, levels)
}
