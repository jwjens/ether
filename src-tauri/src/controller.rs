// src-tauri/src/controller.rs
//
// Ether Controller Engine
//
// Handles USB MIDI communication with DJ controllers.
// Currently stubbed for the Pioneer DDJ-1000SRT.
//
// Architecture:
//   • MidiController trait — any controller implements this
//   • Ddj1000Srt — Pioneer DDJ-1000SRT mapping
//   • ControllerEvent — normalized events sent to the frontend
//   • Tauri commands for connect/disconnect/list
//
// To activate:
//   1. Add to Cargo.toml:
//        midir  = "0.9"
//        hidapi = "2.6"   (for jog display)
//   2. Add `mod controller;` to main.rs
//   3. Add controller state to .manage()
//   4. Register commands in invoke_handler
//
// MIDI Mode on DDJ-1000SRT:
//   Hold SHIFT + press the top-left DECK button while powering on.
//   The unit drops out of Serato HID mode into standard MIDI mode.
//   All controls then send standard MIDI CC/Note messages.

// ── Dependencies (uncomment when midir is in Cargo.toml) ──────
// use midir::{MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

// ── Controller event types ────────────────────────────────────
// Normalized events that map hardware controls to Ether actions.
// The frontend receives these via Tauri event emission.

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControllerEvent {
    // ── Transport ───────────────────────────────────────────
    Play          { deck: u8 },
    Pause         { deck: u8 },
    Cue           { deck: u8 },
    Stop          { deck: u8 },

    // ── Jog wheel ───────────────────────────────────────────
    JogScratch    { deck: u8, delta: i32 },   // scratch (platter pressed)
    JogPitch      { deck: u8, delta: i32 },   // pitch bend (platter rim)

    // ── Mixer ────────────────────────────────────────────────
    Fader         { channel: u8, value: f32 }, // 0.0 – 1.0
    Crossfader    { value: f32 },               // 0.0 (A) – 1.0 (B)
    EqHigh        { channel: u8, value: f32 },
    EqMid         { channel: u8, value: f32 },
    EqLow         { channel: u8, value: f32 },
    Trim          { channel: u8, value: f32 },

    // ── FX ──────────────────────────────────────────────────
    FxOn          { unit: u8, channel: u8 },
    FxDepth       { unit: u8, value: f32 },
    FxBeat        { unit: u8, value: u8 },

    // ── Browse ──────────────────────────────────────────────
    BrowseRotate  { delta: i32 },   // library navigation
    BrowseLoad    { deck: u8 },     // load selected track
    BrowseBack    { },

    // ── Performance pads ────────────────────────────────────
    PadHotCue     { deck: u8, pad: u8, pressed: bool },
    PadLoop       { deck: u8, pad: u8, pressed: bool },
    PadSlicer     { deck: u8, pad: u8, pressed: bool },
    PadSampler    { deck: u8, pad: u8, pressed: bool },

    // ── Loop ────────────────────────────────────────────────
    LoopIn        { deck: u8 },
    LoopOut       { deck: u8 },
    LoopHalve     { deck: u8 },
    LoopDouble    { deck: u8 },
    LoopActive    { deck: u8, active: bool },

    // ── Pitch / BPM ─────────────────────────────────────────
    PitchFader    { deck: u8, value: f32 }, // -1.0 to +1.0
    Sync          { deck: u8 },
    KeyLock       { deck: u8, active: bool },
    Tempo         { deck: u8, bpm: f32 },

    // ── System ──────────────────────────────────────────────
    Connected     { name: String },
    Disconnected  { name: String },
    Error         { message: String },
}

// ── DDJ-1000SRT MIDI Map ──────────────────────────────────────
//
// All values from community reverse engineering + Pioneer MIDI
// implementation chart (available at pioneerdj.com/en-us/support).
//
// Format: (status_byte, data1) → ControllerEvent
//
// Status bytes:
//   0x90 = Note On  ch 1   (deck A controls)
//   0x91 = Note On  ch 2   (deck B controls)
//   0x92 = Note On  ch 3   (deck C controls)
//   0x93 = Note On  ch 4   (deck D controls)
//   0xB0 = CC       ch 1
//   0xB1 = CC       ch 2
//   0xB6 = CC       ch 7   (mixer/browse)

pub struct Ddj1000SrtMap;

impl Ddj1000SrtMap {
    /// Parse a raw MIDI message into a ControllerEvent.
    /// Returns None for messages we don't handle yet.
    pub fn parse(msg: &[u8]) -> Option<ControllerEvent> {
        if msg.len() < 2 { return None; }

        let status = msg[0];
        let data1  = msg[1];
        let data2  = if msg.len() > 2 { msg[2] } else { 0 };

        let channel = (status & 0x0F) + 1;   // 1-indexed
        let kind    = status & 0xF0;          // 0x90 = note, 0xB0 = cc

        // Deck assignment: channels 1/2 = decks 1/2, channels 3/4 = decks 3/4
        let deck = channel;
        let value_f = data2 as f32 / 127.0;

        match (kind, data1) {

            // ── Transport buttons ────────────────────────────
            (0x90, 0x0B) => Some(ControllerEvent::Play  { deck }),
            (0x90, 0x0C) => Some(ControllerEvent::Cue   { deck }),
            (0x90, 0x16) => Some(ControllerEvent::Sync  { deck }),

            // ── Jog wheel ────────────────────────────────────
            // Jog touch (scratch mode on/off)
            (0x90, 0x36) => None,  // jog touch — handled internally
            // Jog turn: CC 0x22 (deck 1), 0x23 (deck 2)
            (0xB0, 0x22) | (0xB0, 0x23) => {
                let d = if data1 == 0x22 { 1 } else { 2 };
                // MIDI relative: 1-63 = forward, 65-127 = backward
                let delta = if data2 > 64 { (data2 as i32) - 128 } else { data2 as i32 };
                Some(ControllerEvent::JogPitch { deck: d, delta })
            },

            // ── Channel faders ───────────────────────────────
            // CH1 fader = B0 13, CH2 = B1 13, CH3 = B2 13, CH4 = B3 13
            (0xB0, 0x13) | (0xB1, 0x13) | (0xB2, 0x13) | (0xB3, 0x13) => {
                Some(ControllerEvent::Fader { channel, value: value_f })
            },

            // ── Crossfader ───────────────────────────────────
            (0xB6, 0x1F) => Some(ControllerEvent::Crossfader { value: value_f }),

            // ── EQ knobs ─────────────────────────────────────
            // High: B0 07, Mid: B0 0B, Low: B0 04 (channel maps to deck)
            (0xB0, 0x07) | (0xB1, 0x07) | (0xB2, 0x07) | (0xB3, 0x07) =>
                Some(ControllerEvent::EqHigh { channel, value: value_f }),
            (0xB0, 0x0B) | (0xB1, 0x0B) | (0xB2, 0x0B) | (0xB3, 0x0B) =>
                Some(ControllerEvent::EqMid  { channel, value: value_f }),
            (0xB0, 0x04) | (0xB1, 0x04) | (0xB2, 0x04) | (0xB3, 0x04) =>
                Some(ControllerEvent::EqLow  { channel, value: value_f }),

            // ── Trim / gain ──────────────────────────────────
            (0xB0, 0x16) | (0xB1, 0x16) | (0xB2, 0x16) | (0xB3, 0x16) =>
                Some(ControllerEvent::Trim { channel, value: value_f }),

            // ── Browse ───────────────────────────────────────
            // Browse rotate: B6 20 (relative)
            (0xB6, 0x20) => {
                let delta = if data2 > 64 { (data2 as i32) - 128 } else { data2 as i32 };
                Some(ControllerEvent::BrowseRotate { delta })
            },
            // Load buttons: deck 1 = 96 02, deck 2 = 97 02
            (0x90, 0x02) | (0x91, 0x02) => Some(ControllerEvent::BrowseLoad { deck }),
            // Back button
            (0x96, 0x2A) => Some(ControllerEvent::BrowseBack {}),

            // ── Performance pads — deck 1 ────────────────────
            // Hot cue mode: pads 0x00-0x07
            // Loop mode:    pads 0x10-0x17
            // Slicer mode:  pads 0x20-0x27
            // Sampler mode: pads 0x30-0x37
            (0x97, n) if n < 0x08 =>
                Some(ControllerEvent::PadHotCue { deck: 1, pad: n, pressed: data2 > 0 }),
            (0x97, n) if n >= 0x10 && n < 0x18 =>
                Some(ControllerEvent::PadLoop { deck: 1, pad: n - 0x10, pressed: data2 > 0 }),
            (0x98, n) if n < 0x08 =>
                Some(ControllerEvent::PadHotCue { deck: 2, pad: n, pressed: data2 > 0 }),

            // ── Loop controls ────────────────────────────────
            (0x90, 0x10) => Some(ControllerEvent::LoopIn     { deck }),
            (0x90, 0x11) => Some(ControllerEvent::LoopOut    { deck }),
            (0x90, 0x12) => Some(ControllerEvent::LoopHalve  { deck }),
            (0x90, 0x13) => Some(ControllerEvent::LoopDouble { deck }),

            // ── Pitch fader ──────────────────────────────────
            // 14-bit pitch fader: MSB on 0x00, LSB on 0x20
            (0xB0, 0x00) | (0xB1, 0x00) => {
                // Convert 0-127 to -1.0 to +1.0 (center = 64 = 0.0)
                let pitch = (data2 as f32 - 64.0) / 64.0;
                Some(ControllerEvent::PitchFader { deck, value: pitch })
            },

            // ── Key lock ─────────────────────────────────────
            (0x90, 0x1A) | (0x91, 0x1A) =>
                Some(ControllerEvent::KeyLock { deck, active: data2 > 0 }),

            _ => None, // Unhandled — log in debug mode
        }
    }

    /// Build a MIDI message to light up an LED on the controller.
    /// Returns the raw bytes to send back over MIDI output.
    pub fn led(control: LedControl, on: bool) -> Vec<u8> {
        let value = if on { 0x7F } else { 0x00 };
        match control {
            LedControl::Play(deck)     => vec![0x90 + deck - 1, 0x0B, value],
            LedControl::Cue(deck)      => vec![0x90 + deck - 1, 0x0C, value],
            LedControl::Sync(deck)     => vec![0x90 + deck - 1, 0x16, value],
            LedControl::Loop(deck)     => vec![0x90 + deck - 1, 0x14, value],
            LedControl::HotCue(deck, pad) => vec![0x97 + deck - 1, pad, value],
            LedControl::PadMode(deck, mode) => vec![0x97 + deck - 1, 0x60 + mode, value],
        }
    }
}

/// LED control targets
pub enum LedControl {
    Play(u8),
    Cue(u8),
    Sync(u8),
    Loop(u8),
    HotCue(u8, u8),   // deck, pad index
    PadMode(u8, u8),  // deck, mode (0=hotcue, 1=loop, 2=slicer, 3=sampler)
}

// ── Controller state ──────────────────────────────────────────

#[derive(Debug, Default)]
pub struct ControllerState {
    pub connected:   bool,
    pub device_name: String,
    pub deck_a_bpm:  f32,
    pub deck_b_bpm:  f32,
    pub crossfader:  f32,
}

pub type SharedControllerState = Arc<Mutex<ControllerState>>;

pub fn new_controller_state() -> SharedControllerState {
    Arc::new(Mutex::new(ControllerState::default()))
}

// ── Tauri commands ────────────────────────────────────────────
// These are stubs. Uncomment and implement when midir is added.

/// List available MIDI input devices
#[tauri::command]
pub fn controller_list_devices() -> Vec<String> {
    // TODO: uncomment when midir is in Cargo.toml
    // let midi_in = MidiInput::new("ether-scan").unwrap();
    // (0..midi_in.port_count())
    //     .map(|i| midi_in.port_name(i).unwrap_or_default())
    //     .collect()
    vec![
        "DDJ-1000SRT (stub — add midir to Cargo.toml to activate)".to_string()
    ]
}

/// Connect to a MIDI device by name
#[tauri::command]
pub fn controller_connect(
    _device_name: String,
    _state: tauri::State<'_, SharedControllerState>,
    _app: tauri::AppHandle,
) -> Result<String, String> {
    // TODO: implement with midir
    // 1. Find port matching device_name
    // 2. Open MidiInputConnection with callback
    // 3. In callback: parse message with Ddj1000SrtMap::parse()
    // 4. Emit ControllerEvent to frontend via app.emit("controller-event", &event)
    // 5. Store connection in SharedControllerState
    Err("Controller support coming soon — add midir = \"0.9\" to Cargo.toml".to_string())
}

/// Disconnect current controller
#[tauri::command]
pub fn controller_disconnect(
    state: tauri::State<'_, SharedControllerState>,
) -> Result<(), String> {
    if let Ok(mut s) = state.inner().lock() {
        s.connected   = false;
        s.device_name = String::new();
    }
    Ok(())
}

/// Send LED feedback to controller
#[tauri::command]
pub fn controller_set_led(
    _deck: u8,
    _control: String,
    _on: bool,
) -> Result<(), String> {
    // TODO: send via MidiOutputConnection
    Ok(())
}

// ── Cargo.toml additions needed ──────────────────────────────
//
// [dependencies]
// midir  = "0.9"        # MIDI I/O
// hidapi = "2.6"        # HID for jog wheel display (optional, harder)
//
// Windows: no extra setup needed
// macOS:   CoreMIDI framework linked automatically
// Linux:   sudo apt install libasound2-dev
//
// ── main.rs additions needed ─────────────────────────────────
//
// mod controller;
//
// In fn main():
//   let controller_state = controller::new_controller_state();
//   .manage(controller_state)
//
// In invoke_handler:
//   controller::controller_list_devices,
//   controller::controller_connect,
//   controller::controller_disconnect,
//   controller::controller_set_led,
