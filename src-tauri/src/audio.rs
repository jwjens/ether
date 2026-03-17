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

#[derive(Default)]
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

pub struct AudioState {
    pub deck_a: DeckMeta,
    pub deck_b: DeckMeta,
    pub sender: std::sync::mpsc::Sender<AudioCmd>,
}

#[derive(Debug)]
pub enum AudioCmd {
    Load { deck: String, file_path: String, title: String, artist: String },
    Play(String),
    Pause(String),
    Stop(String),
    SetVolume { deck: String, volume: f32 },
}

pub type SharedAudioState = Arc<Mutex<AudioState>>;

pub fn start_audio_thread() -> std::sync::mpsc::Sender<AudioCmd> {
    let (tx, rx) = std::sync::mpsc::channel::<AudioCmd>();
    std::thread::spawn(move || {
        use rodio::{Decoder, OutputStream, Sink};
        use std::fs::File;
        use std::io::BufReader;
        use std::collections::HashMap;

        let (_stream, stream_handle) = OutputStream::try_default().expect("audio output");
        let mut sinks: HashMap<String, Sink> = HashMap::new();

        loop {
            match rx.recv() {
                Ok(cmd) => match cmd {
                    AudioCmd::Load { deck, file_path, title: _, artist: _ } => {
                        if let Some(old) = sinks.remove(&deck) { old.stop(); }
                        match File::open(&file_path) {
                            Ok(file) => {
                                let reader = BufReader::new(file);
                                match Decoder::new(reader) {
                                    Ok(source) => {
                                        match Sink::try_new(&stream_handle) {
                                            Ok(sink) => {
                                                sink.pause();
                                                sink.append(source);
                                                sinks.insert(deck, sink);
                                            }
                                            Err(e) => eprintln!("Sink error: {}", e),
                                        }
                                    }
                                    Err(e) => eprintln!("Decode error: {}", e),
                                }
                            }
                            Err(e) => eprintln!("File error: {}", e),
                        }
                    }
                    AudioCmd::Play(deck) => {
                        if let Some(sink) = sinks.get(&deck) { sink.play(); }
                    }
                    AudioCmd::Pause(deck) => {
                        if let Some(sink) = sinks.get(&deck) { sink.pause(); }
                    }
                    AudioCmd::Stop(deck) => {
                        if let Some(sink) = sinks.remove(&deck) { sink.stop(); }
                    }
                    AudioCmd::SetVolume { deck, volume } => {
                        if let Some(sink) = sinks.get(&deck) { sink.set_volume(volume); }
                    }
                },
                Err(_) => break,
            }
        }
    });
    tx
}
