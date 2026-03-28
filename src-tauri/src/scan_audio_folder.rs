// Add to src-tauri/src/main.rs alongside read_file_bytes

#[tauri::command]
fn scan_audio_folder(path: String) -> Result<Vec<String>, String> {
    use std::ffi::OsStr;
    let extensions = ["mp3","flac","wav","aac","m4a","ogg","opus","aiff"];
    let mut files = Vec::new();

    fn walk(dir: &std::path::Path, exts: &[&str], out: &mut Vec<String>) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, exts, out);
                } else if let Some(ext) = path.extension().and_then(OsStr::to_str) {
                    if exts.iter().any(|e| e.eq_ignore_ascii_case(ext)) {
                        if let Some(s) = path.to_str() {
                            out.push(s.to_string());
                        }
                    }
                }
            }
        }
    }

    walk(std::path::Path::new(&path), &extensions, &mut files);
    Ok(files)
}

// Register both in generate_handler:
// tauri::generate_handler![..., read_file_bytes, scan_audio_folder]
