// src-tauri/src/controller.rs
//
// Ether Controller Engine
//
// Handles USB MIDI communication with DJ controllers and mixers.
// Supports Pioneer DDJ-1000SRT, Behringer X-TOUCH, RØDECaster Pro II.
//
// Architecture:
//   • Ddj1000SrtMap     — MIDI CC/Note → ControllerEvent mapping
//   • ControllerState   — holds live connection, soft-takeover table, output port
//   • controller_connect — opens MIDI in/out, starts callback loop
//   • controller_send_feedback — sends CC back to move motorized faders
//   • auto_detect_and_connect  — called from main.rs setup on startup

use midir::{MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::Emitter;

// ── Known device fingerprints ─────────────────────────────────
// (substring to match in MIDI port name, profile file id)

const KNOWN_DEVICES: &[(&str, &str)] = &[
    ("DDJ-1000SRT",  "pioneer-ddj-1000srt"),
    ("DDJ-1000",     "pioneer-ddj-1000srt"),
    ("RODECaster",   "rodecaster-pro-2"),
    ("RodeCaster",   "rodecaster-pro-2"),
    ("X-TOUCH",      "behringer-x-touch"),
    ("X TOUCH",      "behringer-x-touch"),
];

// ── Normalized event types ────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControllerEvent {
    Play          { deck: u8 },
    Pause         { deck: u8 },
    Cue           { deck: u8 },
    Stop          { deck: u8 },

    JogScratch    { deck: u8, delta: i32 },
    JogPitch      { deck: u8, delta: i32 },

    Fader         { channel: u8, value: f32 },
    Crossfader    { value: f32 },
    EqHigh        { channel: u8, value: f32 },
    EqMid         { channel: u8, value: f32 },
    EqLow         { channel: u8, value: f32 },
    Trim          { channel: u8, value: f32 },

    FxOn          { unit: u8, channel: u8 },
    FxDepth       { unit: u8, value: f32 },
    FxBeat        { unit: u8, value: u8 },

    BrowseRotate  { delta: i32 },
    BrowseLoad    { deck: u8 },
    BrowseBack    {},

    PadHotCue     { deck: u8, pad: u8, pressed: bool },
    PadLoop       { deck: u8, pad: u8, pressed: bool },
    PadSlicer     { deck: u8, pad: u8, pressed: bool },
    PadSampler    { deck: u8, pad: u8, pressed: bool },

    LoopIn        { deck: u8 },
    LoopOut       { deck: u8 },
    LoopHalve     { deck: u8 },
    LoopDouble    { deck: u8 },
    LoopActive    { deck: u8, active: bool },

    PitchFader    { deck: u8, value: f32 },
    Sync          { deck: u8 },
    KeyLock       { deck: u8, active: bool },
    Tempo         { deck: u8, bpm: f32 },

    Connected     { name: String },
    Disconnected  { name: String },
    Error         { message: String },
}

// ── DDJ-1000SRT MIDI map ──────────────────────────────────────

pub struct Ddj1000SrtMap;

impl Ddj1000SrtMap {
    pub fn parse(msg: &[u8]) -> Option<ControllerEvent> {
        if msg.len() < 2 { return None; }
        let status  = msg[0];
        let data1   = msg[1];
        let data2   = if msg.len() > 2 { msg[2] } else { 0 };
        let channel = (status & 0x0F) + 1;
        let kind    = status & 0xF0;
        let deck    = channel;
        let value_f = data2 as f32 / 127.0;

        match (kind, data1) {
            // Transport
            (0x90, 0x0B) => Some(ControllerEvent::Play  { deck }),
            (0x90, 0x0C) => Some(ControllerEvent::Cue   { deck }),
            (0x90, 0x16) => Some(ControllerEvent::Sync  { deck }),

            // Jog wheel (relative)
            (0xB0, 0x22) | (0xB0, 0x23) => {
                let d = if data1 == 0x22 { 1 } else { 2 };
                let delta = if data2 > 64 { data2 as i32 - 128 } else { data2 as i32 };
                Some(ControllerEvent::JogPitch { deck: d, delta })
            },

            // Channel faders  CH1-4 = B0-B3 0x13
            (0xB0, 0x13) | (0xB1, 0x13) | (0xB2, 0x13) | (0xB3, 0x13) =>
                Some(ControllerEvent::Fader { channel, value: value_f }),

            // Crossfader
            (0xB6, 0x1F) => Some(ControllerEvent::Crossfader { value: value_f }),

            // EQ knobs
            (0xB0, 0x07) | (0xB1, 0x07) | (0xB2, 0x07) | (0xB3, 0x07) =>
                Some(ControllerEvent::EqHigh { channel, value: value_f }),
            (0xB0, 0x0B) | (0xB1, 0x0B) | (0xB2, 0x0B) | (0xB3, 0x0B) =>
                Some(ControllerEvent::EqMid  { channel, value: value_f }),
            (0xB0, 0x04) | (0xB1, 0x04) | (0xB2, 0x04) | (0xB3, 0x04) =>
                Some(ControllerEvent::EqLow  { channel, value: value_f }),

            // Trim / gain
            (0xB0, 0x16) | (0xB1, 0x16) | (0xB2, 0x16) | (0xB3, 0x16) =>
                Some(ControllerEvent::Trim { channel, value: value_f }),

            // Browse
            (0xB6, 0x20) => {
                let delta = if data2 > 64 { data2 as i32 - 128 } else { data2 as i32 };
                Some(ControllerEvent::BrowseRotate { delta })
            },
            (0x90, 0x02) | (0x91, 0x02) => Some(ControllerEvent::BrowseLoad { deck }),
            (0x96, 0x2A)                 => Some(ControllerEvent::BrowseBack {}),

            // Performance pads
            (0x97, n) if n < 0x08 =>
                Some(ControllerEvent::PadHotCue { deck: 1, pad: n, pressed: data2 > 0 }),
            (0x97, n) if (0x10..0x18).contains(&n) =>
                Some(ControllerEvent::PadLoop { deck: 1, pad: n - 0x10, pressed: data2 > 0 }),
            (0x98, n) if n < 0x08 =>
                Some(ControllerEvent::PadHotCue { deck: 2, pad: n, pressed: data2 > 0 }),

            // Loop
            (0x90, 0x10) => Some(ControllerEvent::LoopIn     { deck }),
            (0x90, 0x11) => Some(ControllerEvent::LoopOut    { deck }),
            (0x90, 0x12) => Some(ControllerEvent::LoopHalve  { deck }),
            (0x90, 0x13) => Some(ControllerEvent::LoopDouble { deck }),

            // Pitch fader (coarse, 7-bit)
            (0xB0, 0x00) | (0xB1, 0x00) => {
                let pitch = (data2 as f32 - 64.0) / 64.0;
                Some(ControllerEvent::PitchFader { deck, value: pitch })
            },

            // Key lock
            (0x90, 0x1A) | (0x91, 0x1A) =>
                Some(ControllerEvent::KeyLock { deck, active: data2 > 0 }),

            _ => None,
        }
    }

    pub fn led(control: LedControl, on: bool) -> Vec<u8> {
        let v = if on { 0x7F } else { 0x00 };
        match control {
            LedControl::Play(d)         => vec![0x90 + d - 1, 0x0B, v],
            LedControl::Cue(d)          => vec![0x90 + d - 1, 0x0C, v],
            LedControl::Sync(d)         => vec![0x90 + d - 1, 0x16, v],
            LedControl::Loop(d)         => vec![0x90 + d - 1, 0x14, v],
            LedControl::HotCue(d, pad)  => vec![0x97 + d - 1, pad, v],
            LedControl::PadMode(d, m)   => vec![0x97 + d - 1, 0x60 + m, v],
        }
    }
}

pub enum LedControl {
    Play(u8),
    Cue(u8),
    Sync(u8),
    Loop(u8),
    HotCue(u8, u8),
    PadMode(u8, u8),
}

// ── Soft takeover ─────────────────────────────────────────────
// When the user re-engages a physical fader after software values have
// moved, we suppress events until the physical position catches up to
// the software value within TAKEOVER_THRESHOLD. This prevents jumps.

const TAKEOVER_THRESHOLD: f32 = 0.02; // 2%

fn is_continuous(event: &ControllerEvent) -> bool {
    matches!(
        event,
        ControllerEvent::Fader { .. }
        | ControllerEvent::Crossfader { .. }
        | ControllerEvent::EqHigh { .. }
        | ControllerEvent::EqMid { .. }
        | ControllerEvent::EqLow { .. }
        | ControllerEvent::Trim { .. }
        | ControllerEvent::PitchFader { .. }
    )
}

fn check_soft_takeover(
    takeover: &mut HashMap<(u8, u8), f32>,
    msg: &[u8],
    event: &ControllerEvent,
) -> bool {
    if !is_continuous(event) || msg.len() < 3 {
        return true;
    }
    let key      = (msg[0], msg[1]);
    let physical = msg[2] as f32 / 127.0;

    match takeover.get(&key).copied() {
        None => {
            // First seen — record position and pass through
            takeover.insert(key, physical);
            true
        }
        Some(software) => {
            let caught_up = (physical - software).abs() <= TAKEOVER_THRESHOLD;
            if caught_up {
                takeover.insert(key, physical);
            }
            caught_up
        }
    }
}

// ── Controller state ──────────────────────────────────────────

pub struct ControllerState {
    pub connected:   bool,
    pub device_name: String,
    // Soft-takeover table: (status_byte, data1) → last software value
    pub takeover:    HashMap<(u8, u8), f32>,
    // MIDI connections — must be kept alive or the connection closes
    pub input_conn:  Option<MidiInputConnection<()>>,
    pub output_conn: Option<MidiOutputConnection>,
}

impl Default for ControllerState {
    fn default() -> Self {
        Self {
            connected:   false,
            device_name: String::new(),
            takeover:    HashMap::new(),
            input_conn:  None,
            output_conn: None,
        }
    }
}

pub type SharedControllerState = Arc<Mutex<ControllerState>>;

pub fn new_controller_state() -> SharedControllerState {
    Arc::new(Mutex::new(ControllerState::default()))
}

// ── Internal connect helper ───────────────────────────────────
// Used by both the Tauri command (user-initiated) and auto-detect (startup).

fn connect_device(
    device_name: &str,
    state: &SharedControllerState,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    // ── Input ─────────────────────────────────────────────────
    let midi_in = MidiInput::new("ether-in")
        .map_err(|e| format!("MIDI init: {e}"))?;
    let in_ports = midi_in.ports();
    let in_port  = in_ports
        .iter()
        .find(|p| midi_in.port_name(p).map(|n| n.contains(device_name)).unwrap_or(false))
        .ok_or_else(|| format!("Input port '{device_name}' not found"))?;

    let state_cb  = state.clone();
    let app_cb    = app.clone();

    let conn = midi_in
        .connect(
            in_port,
            "ether-midi-in",
            move |_ts, msg, _| {
                let Some(event) = Ddj1000SrtMap::parse(msg) else { return };
                let pass = {
                    let mut st = match state_cb.lock() {
                        Ok(g)  => g,
                        Err(_) => return,
                    };
                    check_soft_takeover(&mut st.takeover, msg, &event)
                };
                if pass {
                    let _ = app_cb.emit("controller-event", &event);
                }
            },
            (),
        )
        .map_err(|e| format!("MIDI connect: {e}"))?;

    // ── Output (optional — for motorized faders / LED feedback) ──
    let out_conn = (|| -> Option<MidiOutputConnection> {
        let midi_out = MidiOutput::new("ether-out").ok()?;
        let out_ports = midi_out.ports();
        let out_port  = out_ports
            .iter()
            .find(|p| midi_out.port_name(p).map(|n| n.contains(device_name)).unwrap_or(false))?;
        midi_out.connect(out_port, "ether-midi-out").ok()
    })();

    // ── Store ─────────────────────────────────────────────────
    {
        let mut st = state.lock().map_err(|_| "Lock poisoned".to_string())?;
        st.connected   = true;
        st.device_name = device_name.to_string();
        st.input_conn  = Some(conn);
        st.output_conn = out_conn;
        st.takeover.clear();
    }

    println!("[controller] Connected: {device_name}");
    let _ = app.emit("controller-event", &ControllerEvent::Connected {
        name: device_name.to_string(),
    });
    Ok(())
}

// ── Auto-detect on startup ────────────────────────────────────

pub fn auto_detect_and_connect(state: &SharedControllerState, app: &tauri::AppHandle) {
    let names: Vec<String> = match MidiInput::new("ether-scan") {
        Ok(mi) => mi.ports().iter().filter_map(|p| mi.port_name(p).ok()).collect(),
        Err(e) => {
            eprintln!("[controller] MIDI scan failed: {e}");
            return;
        }
    };

    println!("[controller] MIDI ports: {:?}", names);

    for name in &names {
        for (pattern, _profile) in KNOWN_DEVICES {
            if name.to_uppercase().contains(&pattern.to_uppercase()) {
                println!("[controller] Auto-detected known device: {name}");
                if let Err(e) = connect_device(name, state, app) {
                    eprintln!("[controller] Auto-connect failed: {e}");
                }
                return;
            }
        }
    }
}

// ── Tauri commands ────────────────────────────────────────────

/// List all MIDI input device names currently visible to the OS.
#[tauri::command]
pub fn controller_list_devices() -> Vec<String> {
    match MidiInput::new("ether-scan") {
        Ok(mi) => mi.ports()
            .iter()
            .filter_map(|p| mi.port_name(p).ok())
            .collect(),
        Err(e) => {
            eprintln!("[controller] list failed: {e}");
            vec![]
        }
    }
}

/// Connect to the named MIDI device.
#[tauri::command]
pub fn controller_connect(
    device_name: String,
    state: tauri::State<'_, SharedControllerState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    connect_device(&device_name, state.inner(), &app)?;
    Ok(device_name)
}

/// Disconnect and release MIDI ports.
#[tauri::command]
pub fn controller_disconnect(
    state: tauri::State<'_, SharedControllerState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let name = {
        let mut st = state.inner().lock().map_err(|_| "Lock error".to_string())?;
        let n = st.device_name.clone();
        st.connected   = false;
        st.device_name = String::new();
        st.input_conn  = None;  // drops connection → midir stops calling callback
        st.output_conn = None;
        n
    };
    let _ = app.emit("controller-event", &ControllerEvent::Disconnected { name });
    Ok(())
}

/// Returns { connected, device_name }.
#[tauri::command]
pub fn controller_get_status(
    state: tauri::State<'_, SharedControllerState>,
) -> serde_json::Value {
    match state.inner().lock() {
        Ok(st) => serde_json::json!({
            "connected":   st.connected,
            "deviceName":  st.device_name,
        }),
        Err(_) => serde_json::json!({ "connected": false, "deviceName": "" }),
    }
}

/// Send a CC message to move a motorized channel fader.
/// deck = "A" | "B" | "C" | "D"  (or "1"–"4")
/// value = 0.0–1.0
#[tauri::command]
pub fn controller_send_feedback(
    deck: String,
    value: f32,
    state: tauri::State<'_, SharedControllerState>,
) -> Result<(), String> {
    let mut st = state.inner().lock().map_err(|_| "Lock error".to_string())?;
    let Some(out) = &mut st.output_conn else { return Ok(()); };

    let ch: u8 = match deck.to_uppercase().as_str() {
        "A" | "1" => 0,
        "B" | "2" => 1,
        "C" | "3" => 2,
        "D" | "4" => 3,
        _          => 0,
    };
    let v   = (value.clamp(0.0, 1.0) * 127.0) as u8;
    let msg = [0xB0 + ch, 0x13, v];
    out.send(&msg).map_err(|e| e.to_string())?;

    // Update takeover so the fader doesn't fight the motor on next touch
    st.takeover.insert((0xB0 + ch, 0x13), value.clamp(0.0, 1.0));
    Ok(())
}

/// Set an LED on the controller.
#[tauri::command]
pub fn controller_set_led(
    deck: u8,
    control: String,
    on: bool,
    state: tauri::State<'_, SharedControllerState>,
) -> Result<(), String> {
    let mut st = state.inner().lock().map_err(|_| "Lock error".to_string())?;
    let Some(out) = &mut st.output_conn else { return Ok(()); };

    let led = match control.as_str() {
        "play" => LedControl::Play(deck),
        "cue"  => LedControl::Cue(deck),
        "sync" => LedControl::Sync(deck),
        "loop" => LedControl::Loop(deck),
        _      => return Ok(()),
    };
    out.send(&Ddj1000SrtMap::led(led, on)).map_err(|e| e.to_string())
}

/// Update the soft-takeover table when software moves a fader (e.g. automation).
/// Call this whenever Ether changes a fader value programmatically so the
/// physical controller has to catch up to the new position before taking over.
#[tauri::command]
pub fn controller_update_software_value(
    status: u8,
    data1: u8,
    value: f32,
    state: tauri::State<'_, SharedControllerState>,
) -> Result<(), String> {
    let mut st = state.inner().lock().map_err(|_| "Lock error".to_string())?;
    st.takeover.insert((status, data1), value.clamp(0.0, 1.0));
    Ok(())
}
