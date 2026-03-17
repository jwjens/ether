const fs = require('fs');

// 1. Add rodio to Cargo.toml
let cargo = fs.readFileSync('src-tauri/Cargo.toml', 'utf8');
if (!cargo.includes('rodio')) {
  cargo = cargo.replace(
    'serde = { version = "1.0", features = ["derive"] }',
    `rodio = { version = "0.19", features = ["mp3", "flac", "wav", "vorbis"] }
serde = { version = "1.0", features = ["derive"] }`
  );
  fs.writeFileSync('src-tauri/Cargo.toml', cargo);
  console.log('Added rodio to Cargo.toml');
}

// 2. Write the Rust audio engine
fs.writeFileSync('src-tauri/src/audio.rs', `
use std::sync::{Arc, Mutex};
use std::time::Duration;
use std::fs::File;
use std::io::BufReader;
use rodio::{Decoder, OutputStream, OutputStreamHandle, Sink};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeckState {
    pub id: String,
    pub status: String,
    pub title: String,
    pub artist: String,
    pub file_path: String,
    pub duration_sec: f64,
    pub position_sec: f64,
    pub volume: f32,
}

impl Default for DeckState {
    fn default() -> Self {
        DeckState {
            id: String::new(),
            status: "idle".to_string(),
            title: String::new(),
            artist: String::new(),
            file_path: String::new(),
            duration_sec: 0.0,
            position_sec: 0.0,
            volume: 1.0,
        }
    }
}

pub struct Deck {
    pub id: String,
    sink: Option<Sink>,
    stream_handle: OutputStreamHandle,
    _stream: OutputStream,
    pub state: DeckState,
    pub loaded_path: Option<String>,
}

impl Deck {
    pub fn new(id: &str) -> Self {
        let (_stream, stream_handle) = OutputStream::try_default().unwrap();
        let mut state = DeckState::default();
        state.id = id.to_string();
        Deck {
            id: id.to_string(),
            sink: None,
            stream_handle,
            _stream,
            state,
            loaded_path: None,
        }
    }

    pub fn load(&mut self, file_path: &str, title: &str, artist: &str) -> Result<(), String> {
        self.stop();
        let file = File::open(file_path).map_err(|e| e.to_string())?;
        let reader = BufReader::new(file);
        let source = Decoder::new(reader).map_err(|e| e.to_string())?;
        
        let sink = Sink::try_new(&self.stream_handle).map_err(|e| e.to_string())?;
        sink.pause();
        sink.append(source);
        
        self.state.file_path = file_path.to_string();
        self.state.title = title.to_string();
        self.state.artist = artist.to_string();
        self.state.status = "idle".to_string();
        self.state.duration_sec = 0.0; // rodio doesn't expose duration easily
        self.loaded_path = Some(file_path.to_string());
        self.sink = Some(sink);
        Ok(())
    }

    pub fn play(&mut self) {
        if let Some(sink) = &self.sink {
            sink.play();
            self.state.status = "playing".to_string();
        }
    }

    pub fn pause(&mut self) {
        if let Some(sink) = &self.sink {
            sink.pause();
            self.state.status = "paused".to_string();
        }
    }

    pub fn stop(&mut self) {
        if let Some(sink) = self.sink.take() {
            sink.stop();
        }
        self.state.status = "idle".to_string();
        self.state.position_sec = 0.0;
        self.loaded_path = None;
    }

    pub fn set_volume(&mut self, vol: f32) {
        self.state.volume = vol;
        if let Some(sink) = &self.sink {
            sink.set_volume(vol);
        }
    }

    pub fn is_finished(&self) -> bool {
        if let Some(sink) = &self.sink {
            sink.empty()
        } else {
            true
        }
    }

    pub fn is_playing(&self) -> bool {
        if let Some(sink) = &self.sink {
            !sink.is_paused() && !sink.empty()
        } else {
            false
        }
    }
}

pub struct AudioState {
    pub deck_a: Deck,
    pub deck_b: Deck,
}

impl AudioState {
    pub fn new() -> Self {
        AudioState {
            deck_a: Deck::new("A"),
            deck_b: Deck::new("B"),
        }
    }
}

pub type SharedAudioState = Arc<Mutex<AudioState>>;
`);
console.log('Wrote src-tauri/src/audio.rs');

// 3. Write Tauri commands
fs.writeFileSync('src-tauri/src/commands.rs', `
use crate::audio::SharedAudioState;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Serialize, Deserialize, Clone)]
pub struct DeckStateResponse {
    pub id: String,
    pub status: String,
    pub title: String,
    pub artist: String,
    pub file_path: String,
    pub duration_sec: f64,
    pub position_sec: f64,
    pub volume: f32,
}

#[tauri::command]
pub async fn audio_load(
    deck: String,
    file_path: String,
    title: String,
    artist: String,
    state: State<'_, SharedAudioState>,
) -> Result<String, String> {
    let mut audio = state.lock().map_err(|e| e.to_string())?;
    let d = if deck == "A" { &mut audio.deck_a } else { &mut audio.deck_b };
    d.load(&file_path, &title, &artist)?;
    Ok("ok".to_string())
}

#[tauri::command]
pub async fn audio_play(deck: String, state: State<'_, SharedAudioState>) -> Result<String, String> {
    let mut audio = state.lock().map_err(|e| e.to_string())?;
    let d = if deck == "A" { &mut audio.deck_a } else { &mut audio.deck_b };
    d.play();
    Ok("ok".to_string())
}

#[tauri::command]
pub async fn audio_pause(deck: String, state: State<'_, SharedAudioState>) -> Result<String, String> {
    let mut audio = state.lock().map_err(|e| e.to_string())?;
    let d = if deck == "A" { &mut audio.deck_a } else { &mut audio.deck_b };
    d.pause();
    Ok("ok".to_string())
}

#[tauri::command]
pub async fn audio_stop(deck: String, state: State<'_, SharedAudioState>) -> Result<String, String> {
    let mut audio = state.lock().map_err(|e| e.to_string())?;
    let d = if deck == "A" { &mut audio.deck_a } else { &mut audio.deck_b };
    d.stop();
    Ok("ok".to_string())
}

#[tauri::command]
pub async fn audio_set_volume(deck: String, volume: f32, state: State<'_, SharedAudioState>) -> Result<String, String> {
    let mut audio = state.lock().map_err(|e| e.to_string())?;
    let d = if deck == "A" { &mut audio.deck_a } else { &mut audio.deck_b };
    d.set_volume(volume);
    Ok("ok".to_string())
}

#[tauri::command]
pub async fn audio_get_state(state: State<'_, SharedAudioState>) -> Result<serde_json::Value, String> {
    let audio = state.lock().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "deckA": {
            "id": "A",
            "status": if audio.deck_a.is_playing() { "playing" } else { &audio.deck_a.state.status },
            "title": audio.deck_a.state.title,
            "artist": audio.deck_a.state.artist,
            "filePath": audio.deck_a.state.file_path,
            "volume": audio.deck_a.state.volume,
            "isFinished": audio.deck_a.is_finished(),
        },
        "deckB": {
            "id": "B",
            "status": if audio.deck_b.is_playing() { "playing" } else { &audio.deck_b.state.status },
            "title": audio.deck_b.state.title,
            "artist": audio.deck_b.state.artist,
            "filePath": audio.deck_b.state.file_path,
            "volume": audio.deck_b.state.volume,
            "isFinished": audio.deck_b.is_finished(),
        }
    }))
}
`);
console.log('Wrote src-tauri/src/commands.rs');

// 4. Update main.rs to wire everything up
fs.writeFileSync('src-tauri/src/main.rs', `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod commands;

use audio::{AudioState, SharedAudioState};
use std::sync::{Arc, Mutex};

fn main() {
    let audio_state: SharedAudioState = Arc::new(Mutex::new(AudioState::new()));

    tauri::Builder::default()
        .manage(audio_state)
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec![])))
        .invoke_handler(tauri::generate_handler![
            commands::audio_load,
            commands::audio_play,
            commands::audio_pause,
            commands::audio_stop,
            commands::audio_set_volume,
            commands::audio_get_state,
        ])
        .setup(|_app| {
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
`);
console.log('Wrote src-tauri/src/main.rs');
console.log('Done - run: npm run tauri:dev');
