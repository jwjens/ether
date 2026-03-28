// audio_routing.rs
// ─────────────────────────────────────────────────────────────
// Multi-output audio routing for Ether Technologies
//
// Architecture:
//   Each deck (A/B/C) can be assigned to any physical output device.
//   The routing config is stored in SQLite via station_config_kv.
//   At runtime, each deck spawns its own CPAL output stream on its
//   assigned device. Rodio sinks are created per device as needed.
//
// Supported on:
//   Windows  — WASAPI (default) + ASIO (if driver installed)
//   macOS    — CoreAudio
//   Linux    — ALSA / PulseAudio
//
// Usage from Tauri commands:
//   list_audio_output_devices() -> Vec<AudioDevice>
//   set_deck_output(deck, device_name) -> Result
//   get_deck_routing() -> DeckRouting
//   get_active_device_levels() -> Vec<DeviceLevel>

use cpal::traits::{DeviceTrait, HostTrait};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

// ─── Types ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioDevice {
    pub name:        String,
    pub host:        String,   // "WASAPI", "ASIO", "CoreAudio", "ALSA"
    pub is_default:  bool,
    pub channels:    u16,
    pub sample_rate: u32,
    pub is_asio:     bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeckRouting {
    pub deck_a: Option<String>,   // device name, None = default
    pub deck_b: Option<String>,
    pub deck_c: Option<String>,
    pub monitor: Option<String>,  // headphone/cue mix output
    pub master:  Option<String>,  // master/broadcast output
}

impl Default for DeckRouting {
    fn default() -> Self {
        Self {
            deck_a:  None,
            deck_b:  None,
            deck_c:  None,
            monitor: None,
            master:  None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceLevel {
    pub device_name: String,
    pub peak_l: f32,
    pub peak_r: f32,
    pub rms_l:  f32,
    pub rms_r:  f32,
}

// ─── Router ───────────────────────────────────────────────────

pub struct AudioRouter {
    pub routing: Arc<Mutex<DeckRouting>>,
    pub devices: Arc<Mutex<Vec<AudioDevice>>>,
}

impl AudioRouter {
    pub fn new() -> Self {
        Self {
            routing: Arc::new(Mutex::new(DeckRouting::default())),
            devices: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Enumerate all available output devices across all hosts
    pub fn enumerate_devices() -> Vec<AudioDevice> {
        let mut devices = Vec::new();

        // Try all available hosts (WASAPI, ASIO, CoreAudio, ALSA, etc.)
        for host_id in cpal::available_hosts() {
            let host_name = format!("{:?}", host_id);
            let is_asio   = host_name.to_uppercase().contains("ASIO");

            let host = match cpal::host_from_id(host_id) {
                Ok(h)  => h,
                Err(_) => continue,
            };

            let output_devices = match host.output_devices() {
                Ok(d)  => d,
                Err(_) => continue,
            };

            // Get default device name for this host
            let default_name = host.default_output_device()
                .and_then(|d| d.name().ok())
                .unwrap_or_default();

            for device in output_devices {
                let name = match device.name() {
                    Ok(n)  => n,
                    Err(_) => continue,
                };

                // Get supported config for channel/sample rate info
                let (channels, sample_rate) = device
                    .default_output_config()
                    .map(|c| (c.channels(), c.sample_rate().0))
                    .unwrap_or((2, 44100));

                devices.push(AudioDevice {
                    is_default: name == default_name,
                    is_asio,
                    host: host_name.clone(),
                    name,
                    channels,
                    sample_rate,
                });
            }
        }

        // Sort: default first, then ASIO, then WASAPI, then others
        devices.sort_by(|a, b| {
            b.is_default.cmp(&a.is_default)
                .then(b.is_asio.cmp(&a.is_asio))
                .then(a.name.cmp(&b.name))
        });

        devices
    }

    /// Get device by name, searching all hosts
    pub fn find_device(name: &str) -> Option<cpal::Device> {
        for host_id in cpal::available_hosts() {
            let host = match cpal::host_from_id(host_id) { Ok(h) => h, Err(_) => continue };
            let devices = match host.output_devices() { Ok(d) => d, Err(_) => continue };
            for device in devices {
                if device.name().ok().as_deref() == Some(name) {
                    return Some(device);
                }
            }
        }
        None
    }

    /// Get the default output device
    pub fn default_device() -> Option<cpal::Device> {
        cpal::default_host().default_output_device()
    }
}

// ─── Tauri Commands ───────────────────────────────────────────

/// List all available audio output devices
#[tauri::command]
pub fn list_audio_output_devices() -> Vec<AudioDevice> {
    AudioRouter::enumerate_devices()
}

/// Get current deck routing configuration
#[tauri::command]
pub fn get_deck_routing(
    state: tauri::State<'_, Arc<Mutex<DeckRouting>>>,
) -> DeckRouting {
    state.lock().unwrap().clone()
}

/// Set which output device a deck should use
#[tauri::command]
pub fn set_deck_output(
    state: tauri::State<'_, Arc<Mutex<DeckRouting>>>,
    deck: String,
    device_name: Option<String>,
) -> Result<(), String> {
    let mut routing = state.lock().map_err(|e| e.to_string())?;
    match deck.to_uppercase().as_str() {
        "A"       => routing.deck_a  = device_name,
        "B"       => routing.deck_b  = device_name,
        "C"       => routing.deck_c  = device_name,
        "MONITOR" => routing.monitor = device_name,
        "MASTER"  => routing.master  = device_name,
        _         => return Err(format!("Unknown deck: {}", deck)),
    }
    Ok(())
}

/// Save routing to SQLite (call from Tauri command with DB access)
pub fn routing_to_json(routing: &DeckRouting) -> String {
    serde_json::to_string(routing).unwrap_or_default()
}

pub fn routing_from_json(json: &str) -> DeckRouting {
    serde_json::from_str(json).unwrap_or_default()
}

/// Get the output device for a given deck, falling back to default
pub fn device_for_deck(routing: &DeckRouting, deck: &str) -> Option<cpal::Device> {
    let name = match deck.to_uppercase().as_str() {
        "A" => routing.deck_a.as_deref(),
        "B" => routing.deck_b.as_deref(),
        "C" => routing.deck_c.as_deref(),
        _   => None,
    };

    match name {
        Some(n) => AudioRouter::find_device(n).or_else(|| AudioRouter::default_device()),
        None    => AudioRouter::default_device(),
    }
}
