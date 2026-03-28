// ── HOW TO WIRE stream.rs INTO main.rs ──────────────────────
//
// 1. Copy stream.rs into src-tauri/src/stream.rs
//
// 2. At the top of main.rs, add:
mod stream;

// 3. In your generate_handler! macro, add the four stream commands:
tauri::generate_handler![
    // ... your existing commands ...
    stream::stream_start,
    stream::stream_stop,
    stream::stream_status,
    stream::stream_health,
    stream::stream_update_metadata,
    read_file_bytes,
    scan_audio_folder,
]

// 4. In your audio engine (wherever Rodio writes PCM samples to the output),
//    add this line to feed audio into the stream:
//
//    stream::stream_feed_pcm(&pcm_samples);
//
//    This is typically in the audio callback or the mixer loop where
//    you call sink.write() or similar. It's a no-op when not streaming.

// 5. Also add stream_start_if_configured — called by the ON AIR button
//    when settings are already saved in the DB:

#[tauri::command]
async fn stream_start_if_configured(
    pool: tauri::State<'_, YourDbPool>, // use whatever your DB state type is
) -> Result<(), String> {
    // Load settings from DB — adjust the query/type to match your schema
    // SELECT server, port, mount, password, bitrate, station_name FROM stream_settings WHERE id=1
    // Then call stream_start with those settings
    // If no settings found, return Ok(()) silently — button stays off
    Ok(())
}
