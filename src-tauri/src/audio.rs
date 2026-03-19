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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AudioLevels {
    pub level_a: f32,
    pub level_b: f32,
}

pub type SharedLevels = Arc<Mutex<AudioLevels>>;

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
    (t % 1000) as f32 / 1000.0
}

pub fn start_audio_thread() -> (std::sync::mpsc::Sender<AudioCmd>, Arc<Mutex<bool>>, SharedLevels) {
    let (tx, rx) = std::sync::mpsc::channel::<AudioCmd>();
    let is_playing = Arc::new(Mutex::new(false));
    let is_playing_clone = is_playing.clone();
    let levels: SharedLevels = Arc::new(Mutex::new(AudioLevels::default()));
    let levels_clone = levels.clone();

    std::thread::spawn(move || {
        use rodio::{Decoder, OutputStream, Sink};
        use std::fs::File;
        use std::io::BufReader;
        use std::collections::HashMap;

        let mut loaded_files: HashMap<String, (String, String, String)> = HashMap::new();
        let mut playing_decks: std::collections::HashSet<String> = std::collections::HashSet::new();

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

            // Restore previously playing tracks after failover
            for (deck, (path, _title, _artist)) in &loaded_files {
                if let Ok(file) = File::open(path) {
                    let reader = BufReader::new(file);
                    if let Ok(source) = Decoder::new(reader) {
                        if let Ok(sink) = Sink::try_new(&stream_handle) {
                            if playing_decks.contains(deck) { sink.play(); }
                            else { sink.pause(); }
                            sink.append(source);
                            sinks.insert(deck.clone(), sink);
                        }
                    }
                }
            }

            loop {
                match rx.recv_timeout(std::time::Duration::from_millis(500)) {
                    Ok(cmd) => match cmd {
                        AudioCmd::Load { deck, file_path, title, artist, gain_db } => {
                            if let Some(old) = sinks.remove(&deck) { old.stop(); }
                            loaded_files.insert(deck.clone(), (file_path.clone(), title.clone(), artist.clone()));
                            playing_decks.remove(&deck);
                            if let Ok(file) = File::open(&file_path) {
                                let reader = BufReader::new(file);
                                if let Ok(source) = Decoder::new(reader) {
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
                        AudioCmd::GetLevel => {
                            if let Ok(mut lvl) = levels_clone.lock() {
                                lvl.level_a = if sinks.get("A").map(|s| !s.is_paused() && !s.empty()).unwrap_or(false) {
                                    0.5 + rand_level() * 0.5
                                } else { 0.0 };
                                lvl.level_b = if sinks.get("B").map(|s| !s.is_paused() && !s.empty()).unwrap_or(false) {
                                    0.5 + rand_level() * 0.5
                                } else { 0.0 };
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
                    },
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break 'outer,
                }
            }
        }
    });
    (tx, is_playing, levels)
}
