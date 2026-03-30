// clock.rs — Tauri references removed for NAPI/Electron build

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ClockState {
    pub wall_time: String,
    pub secs_to_hard_sync: f64,
    pub log_remaining_secs: f64,
    pub drift_secs: f64,
    pub status: ClockStatus,
    pub message: String,
    pub time_scale: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ClockStatus {
    Green,
    Yellow,
    Red,
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

pub fn secs_to_next_hour() -> f64 {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let secs_into_hour = (secs % 3600) as f64;
    3600.0 - secs_into_hour
}

pub fn format_wall_time() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let h = (secs % 86400) / 3600;
    let m = (secs % 3600) / 60;
    let s = secs % 60;
    format!("{:02}:{:02}:{:02}", h, m, s)
}

pub fn calculate_drift(log_remaining_secs: f64) -> (f64, f64, ClockStatus, String) {
    let to_sync = secs_to_next_hour();
    let drift = log_remaining_secs - to_sync;
    let time_scale = if log_remaining_secs > 5.0 {
        (to_sync / log_remaining_secs).clamp(0.94, 1.06)
    } else { 1.0 };
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

// Plain functions — no tauri::State, no #[tauri::command]
pub fn update_clock(log_remaining_secs: f64, clock: &SharedClockState) -> Result<ClockState, String> {
    let (drift, time_scale, status, message) = calculate_drift(log_remaining_secs);
    let to_sync = secs_to_next_hour();
    let mut state = clock.lock().map_err(|e: std::sync::PoisonError<_>| e.to_string())?;
    state.wall_time = format_wall_time();
    state.secs_to_hard_sync = to_sync;
    state.log_remaining_secs = log_remaining_secs;
    state.drift_secs = drift;
    state.time_scale = time_scale;
    state.status = status;
    state.message = message;
    Ok(state.clone())
}

pub fn get_clock_state(clock: &SharedClockState) -> Result<ClockState, String> {
    let mut state = clock.lock().map_err(|e: std::sync::PoisonError<_>| e.to_string())?;
    state.wall_time = format_wall_time();
    state.secs_to_hard_sync = secs_to_next_hour();
    Ok(state.clone())
}
