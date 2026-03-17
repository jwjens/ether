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
    pub status: String,
}

impl DeckMeta {
    pub fn new() -> Self {
        DeckMeta {
            title: String::new(),
            artist: String::new(),
            file_path: String::new(),
            volume: 1.0,
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
    Load { deck: String, file_path: String, title: String, artist: String },
    Play(String),
    Pause(String),
    Stop(String),
    SetVolume { deck: String, volume: f32 },
    Ping,
}

pub struct AudioState {
    pub deck_a: DeckMeta,
    pub deck_b: DeckMeta,
    pub sender: std::sync::mpsc::Sender<AudioCmd>,
    pub is_playing: Arc<Mutex<bool>>,
    pub watchdog_active: bool,
    pub watchdog_threshold_sec: f64,
    pub watchdog_triggered_count: u32,
}

pub type SharedAudioState = Arc<Mutex<AudioState>>;

pub fn start_audio_thread() -> (std::sync::mpsc::Sender<AudioCmd>, Arc<Mutex<bool>>) {
    let (tx, rx) = std::sync::mpsc::channel::<AudioCmd>();
    let is_playing = Arc::new(Mutex::new(false));
    let is_playing_clone = is_playing.clone();

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
                        AudioCmd::Load { deck, file_path, title, artist } => {
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
    (tx, is_playing)
}
