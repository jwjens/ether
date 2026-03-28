// Add this command to your main.rs or commands.rs
// Then register it in tauri::Builder::default().invoke_handler(tauri::generate_handler![..., read_file_bytes])

#[tauri::command]
pub fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| format!("Failed to read file '{}': {}", path, e))
}
