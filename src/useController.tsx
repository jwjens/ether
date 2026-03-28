// src/audio/useController.ts
//
// Ether Controller Hook
//
// Listens for ControllerEvents from the Rust MIDI engine
// and maps them to Ether deck/mixer/library actions.
//
// Usage:
//   import { useController } from "./audio/useController";
//   useController({ engine, onLoadTrack, onBrowse });

import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

// ── Event types (mirrors controller.rs) ──────────────────────

export type ControllerEvent =
  | { type: "play";          deck: number }
  | { type: "pause";         deck: number }
  | { type: "cue";           deck: number }
  | { type: "stop";          deck: number }
  | { type: "jog_scratch";   deck: number; delta: number }
  | { type: "jog_pitch";     deck: number; delta: number }
  | { type: "fader";         channel: number; value: number }
  | { type: "crossfader";    value: number }
  | { type: "eq_high";       channel: number; value: number }
  | { type: "eq_mid";        channel: number; value: number }
  | { type: "eq_low";        channel: number; value: number }
  | { type: "trim";          channel: number; value: number }
  | { type: "browse_rotate"; delta: number }
  | { type: "browse_load";   deck: number }
  | { type: "browse_back" }
  | { type: "pad_hot_cue";   deck: number; pad: number; pressed: boolean }
  | { type: "pad_loop";      deck: number; pad: number; pressed: boolean }
  | { type: "pad_sampler";   deck: number; pad: number; pressed: boolean }
  | { type: "loop_in";       deck: number }
  | { type: "loop_out";      deck: number }
  | { type: "loop_halve";    deck: number }
  | { type: "loop_double";   deck: number }
  | { type: "pitch_fader";   deck: number; value: number }
  | { type: "sync";          deck: number }
  | { type: "key_lock";      deck: number; active: boolean }
  | { type: "connected";     name: string }
  | { type: "disconnected";  name: string }
  | { type: "error";         message: string };

// ── Hook props ────────────────────────────────────────────────

interface UseControllerProps {
  // Deck actions
  onPlay?:        (deck: number) => void;
  onPause?:       (deck: number) => void;
  onCue?:         (deck: number) => void;
  // Mixer
  onFader?:       (channel: number, value: number) => void;
  onCrossfader?:  (value: number) => void;
  onEqHigh?:      (channel: number, value: number) => void;
  onEqMid?:       (channel: number, value: number) => void;
  onEqLow?:       (channel: number, value: number) => void;
  // Browse
  onBrowseRotate?:(delta: number) => void;
  onBrowseLoad?:  (deck: number) => void;
  // Pads
  onHotCue?:      (deck: number, pad: number) => void;
  // Jog
  onJog?:         (deck: number, delta: number) => void;
  // Pitch
  onPitch?:       (deck: number, value: number) => void;
  onSync?:        (deck: number) => void;
  // Raw event handler for anything not covered above
  onEvent?:       (event: ControllerEvent) => void;
}

// ── LED feedback helper ───────────────────────────────────────

export async function setLed(deck: number, control: string, on: boolean) {
  try {
    await invoke("controller_set_led", { deck, control, on });
  } catch {
    // Controller not connected — silent fail
  }
}

// ── useController hook ────────────────────────────────────────

export function useController(props: UseControllerProps) {
  useEffect(() => {
    const unlisten = listen<ControllerEvent>("controller-event", ({ payload: ev }) => {

      // Call raw handler first
      props.onEvent?.(ev);

      // Route to specific handlers
      switch (ev.type) {
        case "play":
          props.onPlay?.(ev.deck);
          setLed(ev.deck, "play", true);
          break;

        case "pause":
          props.onPause?.(ev.deck);
          setLed(ev.deck, "play", false);
          break;

        case "cue":
          props.onCue?.(ev.deck);
          setLed(ev.deck, "cue", true);
          setTimeout(() => setLed(ev.deck, "cue", false), 100);
          break;

        case "fader":
          props.onFader?.(ev.channel, ev.value);
          break;

        case "crossfader":
          props.onCrossfader?.(ev.value);
          break;

        case "eq_high":
          props.onEqHigh?.(ev.channel, ev.value);
          break;

        case "eq_mid":
          props.onEqMid?.(ev.channel, ev.value);
          break;

        case "eq_low":
          props.onEqLow?.(ev.channel, ev.value);
          break;

        case "browse_rotate":
          props.onBrowseRotate?.(ev.delta);
          break;

        case "browse_load":
          props.onBrowseLoad?.(ev.deck);
          break;

        case "jog_pitch":
        case "jog_scratch":
          props.onJog?.(ev.deck, ev.delta);
          break;

        case "pitch_fader":
          props.onPitch?.(ev.deck, ev.value);
          break;

        case "sync":
          props.onSync?.(ev.deck);
          setLed(ev.deck, "sync", true);
          break;

        case "pad_hot_cue":
          if (ev.pressed) props.onHotCue?.(ev.deck, ev.pad);
          break;

        case "connected":
          console.log(`[Controller] Connected: ${ev.name}`);
          break;

        case "error":
          console.error(`[Controller] ${ev.message}`);
          break;
      }
    });

    return () => { unlisten.then(fn => fn()); };
  }, [props]);
}

// ── Controller settings panel ─────────────────────────────────
// Simple connect/disconnect UI — drop into Settings panel

import React, { useState, useEffect as useEff } from "react";

export function ControllerPanel() {
  const [devices, setDevices]       = useState<string[]>([]);
  const [selected, setSelected]     = useState("");
  const [connected, setConnected]   = useState(false);
  const [status, setStatus]         = useState("Not connected");

  useEff(() => {
    invoke<string[]>("controller_list_devices")
      .then(d => { setDevices(d); if (d.length > 0) setSelected(d[0]); })
      .catch(() => setDevices([]));
  }, []);

  const connect = async () => {
    try {
      await invoke("controller_connect", { deviceName: selected });
      setConnected(true);
      setStatus(`Connected: ${selected}`);
    } catch (e) {
      setStatus(`Error: ${e}`);
    }
  };

  const disconnect = async () => {
    await invoke("controller_disconnect");
    setConnected(false);
    setStatus("Disconnected");
  };

  return (
    <div style={{
      padding: "16px", borderRadius: 10,
      background: "var(--bg-secondary)",
      border: "1px solid var(--border-primary)",
      fontFamily: "'Inter', system-ui, sans-serif",
    }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", marginBottom: 12 }}>
        DJ Controller
      </div>

      {/* Status */}
      <div style={{
        display: "flex", alignItems: "center", gap: 7, marginBottom: 12,
        fontSize: 10, color: connected ? "#34d399" : "var(--text-tertiary)",
      }}>
        <div style={{
          width: 7, height: 7, borderRadius: "50%",
          background: connected ? "#34d399" : "rgba(255,255,255,0.2)",
        }} />
        {status}
      </div>

      {/* Device picker */}
      <select
        value={selected}
        onChange={e => setSelected(e.target.value)}
        disabled={connected}
        style={{
          width: "100%", fontSize: 11,
          background: "var(--bg-tertiary)", color: "var(--text-primary)",
          border: "1px solid var(--border-primary)", borderRadius: 6,
          padding: "5px 8px", marginBottom: 10, outline: "none",
          opacity: connected ? 0.5 : 1,
        }}
      >
        {devices.length === 0 && <option>No MIDI devices found</option>}
        {devices.map(d => <option key={d} value={d}>{d}</option>)}
      </select>

      {/* Note */}
      <div style={{ fontSize: 9, color: "var(--text-tertiary)", marginBottom: 10, lineHeight: 1.5 }}>
        DDJ-1000SRT: hold SHIFT + DECK button while powering on to enable MIDI mode.
      </div>

      {/* Connect button */}
      <button
        onClick={connected ? disconnect : connect}
        disabled={devices.length === 0}
        style={{
          width: "100%", padding: "7px", borderRadius: 7,
          fontSize: 11, fontWeight: 700, cursor: "pointer",
          background: connected ? "rgba(239,68,68,0.12)" : "rgba(52,211,153,0.12)",
          color: connected ? "#ef4444" : "#34d399",
          border: `1px solid ${connected ? "rgba(239,68,68,0.3)" : "rgba(52,211,153,0.3)"}`,
        }}
      >
        {connected ? "Disconnect" : "Connect Controller"}
      </button>

      {/* Roadmap note */}
      <div style={{
        marginTop: 12, padding: "8px 10px", borderRadius: 7,
        background: "rgba(167,139,250,0.07)", border: "1px solid rgba(167,139,250,0.2)",
        fontSize: 9, color: "rgba(167,139,250,0.7)", lineHeight: 1.5,
      }}>
        ✦ Roadmap: full DDJ-1000SRT mapping including jog wheels, performance pads, and on-jog display.
        Add <code style={{ fontFamily: "monospace" }}>midir = "0.9"</code> to Cargo.toml to activate.
      </div>
    </div>
  );
}
