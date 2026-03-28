// src-tauri/src/commands/stream_commands.rs
//
// Tauri command handlers for Ether Stream Protocol.
// These replace the stub stream_* commands previously registered in main.rs.
//
// Wire up:
//   1. Add `mod stream_commands;` inside src/commands/mod.rs
//   2. Add `use crate::commands::stream_commands::*;` or re-export
//   3. Register in main.rs invoke_handler:
//        commands::stream_start,
//        commands::stream_stop,
//        commands::stream_status,
//        commands::stream_update_metadata,
//        commands::stream_reconnect,        ← new
//        commands::stream_get_buffer_depth, ← new

use tauri::State;
use crate::stream::{SharedStreamEngine, StreamConfig, StreamState, StreamStatus};

// ── stream_start ─────────────────────────────────────────────
//
// Called from frontend when user clicks "Go Live".
// Accepts either Icecast or RTMP (or both) target.
//
// Example from TypeScript:
//   await invoke("stream_start", {
//     config: {
//       icecast_url: "http://localhost:8000/stream",
//       icecast_password: "hackme",
//       title: "Morning Drive",
//       bitrate_kbps: 128,
//     }
//   });

#[tauri::command]
pub async fn stream_start(
    config: StreamConfig,
    stream: State<'_, SharedStreamEngine>,
) -> Result<StreamState, String> {
    let mut engine = stream.lock().map_err(|e| e.to_string())?;
    engine.start(config)?;
    Ok(engine.get_state())
}

// ── stream_stop ──────────────────────────────────────────────

#[tauri::command]
pub async fn stream_stop(
    stream: State<'_, SharedStreamEngine>,
) -> Result<StreamState, String> {
    let mut engine = stream.lock().map_err(|e| e.to_string())?;
    engine.stop();
    Ok(engine.get_state())
}

// ── stream_status ─────────────────────────────────────────────
// Polled by the Telemetry Heartbeat sidebar every 2 seconds.

#[tauri::command]
pub async fn stream_status(
    stream: State<'_, SharedStreamEngine>,
) -> Result<StreamState, String> {
    let engine = stream.lock().map_err(|e| e.to_string())?;
    Ok(engine.get_state())
}

// ── stream_update_metadata ────────────────────────────────────
// Called whenever a new song starts playing on Deck A.
// Updates ICY metadata so Icecast clients see the song title.
//
// Wire this up in App.tsx:
//   engine.onPlayStart(async (deckId, title, artist) => {
//     if (deckId === "A") {
//       await invoke("stream_update_metadata", { title, artist });
//     }
//   });

#[tauri::command]
pub async fn stream_update_metadata(
    title: String,
    artist: String,
    stream: State<'_, SharedStreamEngine>,
) -> Result<(), String> {
    let mut engine = stream.lock().map_err(|e| e.to_string())?;
    engine.update_metadata(&title, &artist);
    Ok(())
}

// ── stream_reconnect ──────────────────────────────────────────
// Manually triggered reconnect — can also be auto-triggered
// by a network monitor thread watching stream_status().
//
// The ring buffer retransmits all unacked chunks automatically.
// This is the command that makes Ether "pick up as if nothing happened"
// after a connection drop — same as Resi's core value proposition.

#[tauri::command]
pub async fn stream_reconnect(
    stream: State<'_, SharedStreamEngine>,
) -> Result<StreamState, String> {
    let mut engine = stream.lock().map_err(|e| e.to_string())?;
    engine.reconnect()?;
    Ok(engine.get_state())
}

// ── stream_get_buffer_depth ───────────────────────────────────
// Returns how many seconds of audio are currently buffered.
// Used by the Telemetry Heartbeat to show the buffer bar.
// At steady state this should read ~90s.

#[tauri::command]
pub async fn stream_get_buffer_depth(
    stream: State<'_, SharedStreamEngine>,
) -> Result<f64, String> {
    let engine = stream.lock().map_err(|e| e.to_string())?;
    Ok(engine.get_state().buffer_depth_secs)
}
