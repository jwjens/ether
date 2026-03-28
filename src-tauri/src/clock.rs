// src-tauri/src/clock.rs
//
// Self-Healing Clock — the "Radio Math" Gemini described.
//
// Constantly calculates the gap between where the log will end
// and the next Hard Sync marker (top of hour: XX:00:00).
//
// If the log runs SHORT  → yellow warning, suggest AI fill card
// If the log runs LONG   → prepare pitch-neutral time-scaling
// If the log is PERFECT  → green, hard sync confirmed
//
// The frontend polls get_clock_state every second and renders
// the drift bar + status in the Telemetry Pillar and clock display.

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

// ── Types ─────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ClockState {
    /// Current wall-clock time as HH:MM:SS
    pub wall_time: String,
    /// Seconds until next top-of-hour
    pub secs_to_hard_sync: f64,
    /// Remaining log duration in seconds (set by frontend)
    pub log_remaining_secs: f64,
    /// Drift = log_remaining - secs_to_hard_sync
    /// Positive = log runs LONG (need to shrink)
    /// Negative = log runs SHORT (need fill)
    pub drift_secs: f64,
    /// Status level
    pub status: ClockStatus,
    /// Human-readable status message
    pub message: String,
    /// Suggested time-scale ratio (1.0 = no change)
    pub time_scale: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ClockStatus {
    Green,   // Within ±10 seconds — perfect
    Yellow,  // ±10–60 seconds — manageable
    Red,     // >60 seconds drift — intervention needed
}

pub type SharedClockState = Arc<Mutex<ClockState>>;

pub fn new_clock_state() -> SharedClockState {
    Arc::new(Mutex::new(ClockState {
        wall_time: "00:00:00".to_string(),
        secs_to_hard_sync: 0.0,
        log_remaining_secs: 0.0,
        drift_secs: 0.0,
        status: ClockStatus::Green,
        message: "Awaiting log data".to_string(),
        time_scale: 1.0,
    }))
}

// ── Core math ─────────────────────────────────────────────────

/// Calculate seconds until the next top-of-hour from current wall time
pub fn secs_to_next_hour() -> f64 {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let secs_into_hour = (secs % 3600) as f64;
    3600.0 - secs_into_hour
}

/// Format unix seconds as HH:MM:SS in local-ish time (UTC offset ignored for display)
pub fn format_wall_time() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let h = (secs % 86400) / 3600;
    let m = (secs % 3600) / 60;
    let s = secs % 60;
    format!("{:02}:{:02}:{:02}", h, m, s)
}

/// Given remaining log duration, calculate drift and recommended time-scale
pub fn calculate_drift(log_remaining_secs: f64) -> (f64, f64, ClockStatus, String) {
    let to_sync = secs_to_next_hour();
    let drift = log_remaining_secs - to_sync;

    // Time-scale: compress/expand log to hit hard sync exactly.
    // Only apply when log has content and drift is within salvageable range.
    let time_scale = if log_remaining_secs > 5.0 {
        // Scale = target_duration / actual_duration
        // Clamp to ±6% — beyond that it sounds unnatural
        let scale = to_sync / log_remaining_secs;
        scale.clamp(0.94, 1.06)
    } else {
        1.0
    };

    let (status, message) = if drift.abs() <= 10.0 {
        (ClockStatus::Green, format!("Hard Sync ±{:.0}s — nominal", drift.abs()))
    } else if drift < -60.0 {
        (ClockStatus::Red, format!("Log SHORT {:.0}s — fill required", drift.abs()))
    } else if drift > 60.0 {
        (ClockStatus::Red, format!("Log LONG +{:.0}s — time-scaling active", drift))
    } else if drift < 0.0 {
        (ClockStatus::Yellow, format!("Log SHORT {:.0}s — AI fill suggested", drift.abs()))
    } else {
        (ClockStatus::Yellow, format!("Log LONG +{:.0}s — compressing", drift))
    };

    (drift, time_scale, status, message)
}

// ── Tauri commands ─────────────────────────────────────────────

/// Called by frontend every second with remaining log duration.
/// Returns updated clock state including drift + time-scale recommendation.
#[tauri::command]
pub fn update_clock(
    log_remaining_secs: f64,
    clock: tauri::State<'_, SharedClockState>,
) -> Result<ClockState, String> {
    let (drift, time_scale, status, message) = calculate_drift(log_remaining_secs);
    let to_sync = secs_to_next_hour();

    let mut state = clock.inner().lock().map_err(|e| e.to_string())?;
    state.wall_time        = format_wall_time();
    state.secs_to_hard_sync = to_sync;
    state.log_remaining_secs = log_remaining_secs;
    state.drift_secs       = drift;
    state.time_scale       = time_scale;
    state.status           = status;
    state.message          = message;

    Ok(state.clone())
}

/// Get current clock state without updating (for polling)
#[tauri::command]
pub fn get_clock_state(
    clock: tauri::State<'_, SharedClockState>,
) -> Result<ClockState, String> {
    let mut state = clock.inner().lock().map_err(|e| e.to_string())?;
    state.wall_time = format_wall_time();
    state.secs_to_hard_sync = secs_to_next_hour();
    Ok(state.clone())
}
