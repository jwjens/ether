// commands/library.rs
// Tauri commands for file system operations and audio metadata extraction.
// Called from the React frontend via invoke().

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::command;

// ============================================================
// TYPES returned to the frontend
// ============================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AudioFileMeta {
    pub file_path: String,
    pub file_name: String,
    pub file_format: String,
    pub file_size_bytes: u64,

    // ID3 / Vorbis tags
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub year: Option<u32>,
    pub track_number: Option<u32>,
    pub genre: Option<String>,

    // Duration in milliseconds (from container headers, not ID3)
    pub duration_ms: u64,

    // Error if we couldn't read the file
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ScanResult {
    pub scanned: u32,
    pub found: u32,
    pub errors: u32,
    pub files: Vec<AudioFileMeta>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

// ============================================================
// SUPPORTED FORMATS
// ============================================================

const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "flac", "ogg", "opus", "wav", "aiff", "aif", "m4a", "aac", "wma",
];

fn is_audio_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| AUDIO_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
        .unwrap_or(false)
}

// ============================================================
// SCAN FOLDER
// Recursively walks a directory, returns metadata for all audio files.
// Heavy lifting (ID3 parsing) is done here in Rust so the UI thread
// stays responsive. Frontend shows a progress stream via events.
// ============================================================

#[command]
pub async fn scan_folder(
    app: tauri::AppHandle,
    folder_path: String,
    recursive: bool,
) -> Result<ScanResult, String> {
    let base = PathBuf::from(&folder_path);
    if !base.exists() {
        return Err(format!("Path does not exist: {}", folder_path));
    }

    let mut audio_paths: Vec<PathBuf> = Vec::new();
    collect_audio_files(&base, recursive, &mut audio_paths);

    let total = audio_paths.len() as u32;
    let mut results: Vec<AudioFileMeta> = Vec::new();
    let mut error_count = 0u32;

    for (i, path) in audio_paths.iter().enumerate() {
        // Emit progress event to frontend
        let _ = app.emit("scan_progress", serde_json::json!({
            "current": i + 1,
            "total": total,
            "file": path.file_name().and_then(|n| n.to_str()).unwrap_or("")
        }));

        match read_file_meta(path) {
            Ok(meta) => results.push(meta),
            Err(e) => {
                error_count += 1;
                results.push(AudioFileMeta {
                    file_path: path.to_string_lossy().to_string(),
                    file_name: path.file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_string(),
                    file_format: path.extension()
                        .and_then(|e| e.to_str())
                        .unwrap_or("")
                        .to_lowercase(),
                    file_size_bytes: 0,
                    title: None, artist: None, album: None,
                    album_artist: None, year: None, track_number: None,
                    genre: None, duration_ms: 0,
                    error: Some(e),
                });
            }
        }
    }

    Ok(ScanResult {
        scanned: total,
        found: results.iter().filter(|r| r.error.is_none()).count() as u32,
        errors: error_count,
        files: results,
    })
}

fn collect_audio_files(dir: &Path, recursive: bool, out: &mut Vec<PathBuf>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && recursive {
            collect_audio_files(&path, recursive, out);
        } else if path.is_file() && is_audio_file(&path) {
            out.push(path);
        }
    }
}

fn read_file_meta(path: &Path) -> Result<AudioFileMeta, String> {
    let file_size = std::fs::metadata(path)
        .map(|m| m.len())
        .unwrap_or(0);

    let format = path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let file_name = path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    // Use id3 crate for MP3, metaflac for FLAC, etc.
    // For now: best-effort parsing, fallback to filename
    // In full implementation: match on format and use appropriate parser
    let (title, artist, album, album_artist, year, track_number, genre, duration_ms) =
        parse_tags(path, &format);

    // Fallback: derive title from filename
    let title = title.or_else(|| {
        path.file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string())
    });

    Ok(AudioFileMeta {
        file_path: path.to_string_lossy().to_string(),
        file_name,
        file_format: format,
        file_size_bytes: file_size,
        title,
        artist,
        album,
        album_artist,
        year,
        track_number,
        genre,
        duration_ms,
        error: None,
    })
}

/// Parse audio tags — uses id3 for MP3, lofty for everything else.
/// Returns (title, artist, album, album_artist, year, track, genre, duration_ms)
fn parse_tags(path: &Path, format: &str) -> (
    Option<String>, Option<String>, Option<String>,
    Option<String>, Option<u32>, Option<u32>, Option<String>, u64,
) {
    // lofty supports MP3, FLAC, OGG, OPUS, WAV, AIFF, M4A
    // Add lofty = "0.21" to Cargo.toml
    use lofty::prelude::*;
    use lofty::probe::Probe;

    match Probe::open(path).and_then(|p| p.read()) {
        Ok(tagged_file) => {
            let duration_ms = tagged_file.properties().duration().as_millis() as u64;
            let tag = tagged_file.primary_tag()
                .or_else(|| tagged_file.first_tag());

            let (title, artist, album, album_artist, year, track, genre) = match tag {
                Some(t) => (
                    t.title().map(|s| s.to_string()),
                    t.artist().map(|s| s.to_string()),
                    t.album().map(|s| s.to_string()),
                    t.get_string(&lofty::tag::ItemKey::AlbumArtist).map(|s| s.to_string()),
                    t.year(),
                    t.track(),
                    t.genre().map(|s| s.to_string()),
                ),
                None => (None, None, None, None, None, None, None),
            };

            (title, artist, album, album_artist, year, track, genre, duration_ms)
        }
        Err(_) => (None, None, None, None, None, None, None, 0),
    }
}

// ============================================================
// READ SINGLE FILE METADATA (for manual import / re-scan)
// ============================================================

#[command]
pub async fn read_audio_metadata(file_path: String) -> Result<AudioFileMeta, String> {
    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Err(format!("File not found: {}", file_path));
    }
    read_file_meta(&path).map_err(|e| e)
}

// ============================================================
// OPEN FOLDER DIALOG (native OS picker)
// ============================================================

#[command]
pub async fn open_folder_dialog(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let folder = app.dialog()
        .file()
        .set_title("Select Music Folder")
        .blocking_pick_folder();

    Ok(folder.map(|p| p.to_string()))
}

// ============================================================
// GET AUDIO OUTPUT DEVICES
// ============================================================

#[command]
pub async fn get_audio_devices() -> Result<Vec<AudioDevice>, String> {
    // cpal device enumeration
    // Add cpal = "0.15" to Cargo.toml for full implementation
    // Returning a placeholder for now
    Ok(vec![
        AudioDevice {
            id: "default".to_string(),
            name: "Default System Output".to_string(),
            is_default: true,
        },
    ])
}
