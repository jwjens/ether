// audio_routing.rs — Tauri references removed for NAPI/Electron build

use cpal::traits::{DeviceTrait, HostTrait};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioDevice {
    pub name:        String,
    pub host:        String,
    pub is_default:  bool,
    pub channels:    u16,
    pub sample_rate: u32,
    pub is_asio:     bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeckRouting {
    pub deck_a:  Option<String>,
    pub deck_b:  Option<String>,
    pub deck_c:  Option<String>,
    pub monitor: Option<String>,
    pub master:  Option<String>,
}

impl Default for DeckRouting {
    fn default() -> Self {
        Self { deck_a: None, deck_b: None, deck_c: None, monitor: None, master: None }
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

    pub fn enumerate_devices() -> Vec<AudioDevice> {
        let mut devices = Vec::new();
        for host_id in cpal::available_hosts() {
            let host_name = format!("{:?}", host_id);
            let is_asio = host_name.to_uppercase().contains("ASIO");
            let host = match cpal::host_from_id(host_id) { Ok(h) => h, Err(_) => continue };
            let output_devices = match host.output_devices() { Ok(d) => d, Err(_) => continue };
            let default_name = host.default_output_device()
                .and_then(|d| d.name().ok()).unwrap_or_default();
            for device in output_devices {
                let name = match device.name() { Ok(n) => n, Err(_) => continue };
                let (channels, sample_rate) = device.default_output_config()
                    .map(|c| (c.channels(), c.sample_rate().0)).unwrap_or((2, 44100));
                devices.push(AudioDevice {
                    is_default: name == default_name,
                    is_asio, host: host_name.clone(), name, channels, sample_rate,
                });
            }
        }
        devices.sort_by(|a, b| {
            b.is_default.cmp(&a.is_default)
                .then(b.is_asio.cmp(&a.is_asio))
                .then(a.name.cmp(&b.name))
        });
        devices
    }

    pub fn find_device(name: &str) -> Option<cpal::Device> {
        for host_id in cpal::available_hosts() {
            let host = match cpal::host_from_id(host_id) { Ok(h) => h, Err(_) => continue };
            let devices = match host.output_devices() { Ok(d) => d, Err(_) => continue };
            for device in devices {
                if device.name().ok().as_deref() == Some(name) { return Some(device); }
            }
        }
        None
    }

    pub fn default_device() -> Option<cpal::Device> {
        cpal::default_host().default_output_device()
    }
}

// Plain functions — no tauri::State, no #[tauri::command]
pub fn list_audio_output_devices() -> Vec<AudioDevice> {
    AudioRouter::enumerate_devices()
}

pub fn get_deck_routing(state: &Arc<Mutex<DeckRouting>>) -> DeckRouting {
    state.lock().unwrap().clone()
}

pub fn set_deck_output(
    state: &Arc<Mutex<DeckRouting>>,
    deck: String,
    device_name: Option<String>,
) -> Result<(), String> {
    let mut routing = state.lock().map_err(|e: std::sync::PoisonError<_>| e.to_string())?;
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

pub fn routing_to_json(routing: &DeckRouting) -> String {
    serde_json::to_string(routing).unwrap_or_default()
}

pub fn routing_from_json(json: &str) -> DeckRouting {
    serde_json::from_str(json).unwrap_or_default()
}

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
