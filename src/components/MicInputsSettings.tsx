// MicInputsSettings.tsx — Preferences → Audio: THE MIC INPUTS (docs/dsp-mic-in-engine.md §4; the "I/O config
// lives in Preferences" rule). One row per source channel patched to "mic" on the board: the input DEVICE (the
// engine's own list — this machine's), the INPUT number on that device, the INPUT GAIN (−10…+40 dB), and the
// ENGINE's live state for it. Everything here is machine-local: another install picks its own devices.
//
// Talent monitoring (ruling 3): the engine path to the headphones is tens of milliseconds — hear your own voice
// through your interface's hardware DIRECT MONITOR. The engine's PFL is for hearing the processed sound.
import React, { useEffect, useRef, useState } from "react";
import { useActiveStation } from "../hooks/useActiveStation";
import { useDeckConfig } from "./DeckConfigurator";
import { MIC_GAIN_DB, micStateWords, useInputDevices, useMicInputs, type MicPatch } from "../hooks/useMicInputs";

const TONE: Record<string, string> = { ok: "var(--accent-green)", warn: "var(--accent-amber, #f59e0b)", bad: "var(--accent-red, #ef4444)", off: "var(--text-tertiary)" };
const FIELD: React.CSSProperties = {
  minHeight: 36, background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", padding: "0 8px", fontSize: 12,
};

export default function MicInputsSettings() {
  const { stationId } = useActiveStation();
  const { configs } = useDeckConfig();
  const mic = useMicInputs(stationId);
  const { devices, reload } = useInputDevices();
  const [msg, setMsg] = useState<Record<string, string>>({});
  const gainTimer = useRef<Record<string, any>>({});
  const [draftGain, setDraftGain] = useState<Record<string, number>>({});

  // The channels that carry a mic: every enabled source channel patched to "mic", plus any slot that still has a
  // stored patch (so a patch can always be removed, even from a channel that was re-dialled to something else).
  const micChannels = configs.filter(c => c.enabled && c.type === "source" && c.kind === "mic").map(c => ({ slot: c.slot, label: c.label || c.slot }));
  for (const s of Object.keys(mic.patches)) if (!micChannels.some(m => m.slot === s)) micChannels.push({ slot: s, label: `${s} (not a mic channel)` });

  useEffect(() => () => { Object.values(gainTimer.current).forEach(clearTimeout); }, []);

  const apply = async (slot: string, p: MicPatch | null) => {
    setMsg(m => ({ ...m, [slot]: "" }));
    const r = await mic.setPatch(slot, p);
    if (!r.ok) setMsg(m => ({ ...m, [slot]: `⚠ Not applied — ${r.reason}` }));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 13, color: "var(--text-tertiary)", lineHeight: 1.5 }}>
        A mic is a <b>source channel</b> on the board patched to <b>Mic</b>. Here you pick which input on <b>this computer</b> feeds it.
        The mic then goes through the engine like every channel: its meter, its channel EQ, its fader and ON, the ducker — and on air.
        <br />
        <b>Hearing yourself:</b> use your interface's <b>direct monitor</b> (zero delay). The engine's path back to the headphones takes
        tens of milliseconds — fine for checking the processed sound on PFL, too late to talk against.
      </div>
      {micChannels.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic", padding: 8, border: "1px dashed var(--border-primary)" }}>
          No mic channels yet. On the board, set a source channel's source to <b>Mic</b> (or add a channel with + and choose Mic), then pick its input here.
        </div>
      ) : micChannels.map(({ slot, label }) => {
        const p = mic.patches[slot];
        const st = mic.states[slot];
        const w = micStateWords(st, !!p);
        const dev = devices?.find(d => d.name === p?.device);
        const chans = dev?.channels || st?.channels || 2;
        const gain = draftGain[slot] ?? p?.gainDb ?? 0;
        return (
          <div key={slot} style={{ padding: 10, border: "1px solid var(--border-primary)", background: "var(--bg-secondary)", display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <b style={{ fontSize: 13, minWidth: 90 }}>{slot} · {label}</b>
              <span style={{ fontSize: 12, fontWeight: 700, color: TONE[w.tone] }}>● {w.text}</span>
              {st && st.state === "running" && (
                <span style={{ fontSize: 11, color: "var(--text-tertiary)" }} title="The engine's live numbers for this input">
                  {st.rate} Hz · buffer {st.fillMs.toFixed(0)} ms · clock {st.driftPpm >= 0 ? "+" : ""}{st.driftPpm.toFixed(0)} ppm
                  {st.underruns > 0 && ` · ${st.underruns} dropout(s)`}{st.losses > 0 && ` · lost ${st.losses}×`}
                </span>
              )}
              {st && st.reason && st.state !== "running" && <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{st.reason}</span>}
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <select value={p?.device || ""} style={{ ...FIELD, flex: "1 1 260px" }}
                onChange={e => apply(slot, e.target.value ? { device: e.target.value, channel: 1, gainDb: p?.gainDb ?? 0 } : null)}
                title="The input device on THIS computer (never synced to another install)">
                <option value="">— no input —</option>
                {p?.device && !devices?.some(d => d.name === p.device) && <option value={p.device}>{p.device} (not connected)</option>}
                {(devices || []).map(d => <option key={d.name} value={d.name}>{d.name}{d.isDefault ? " (Windows default)" : ""}</option>)}
              </select>
              <select value={p?.channel || 1} disabled={!p} style={{ ...FIELD, width: 110 }}
                onChange={e => p && apply(slot, { ...p, channel: Number(e.target.value) })} title="Which input on the device (an interface's input 1, 2 …)">
                {Array.from({ length: Math.max(1, chans) }, (_, i) => i + 1).map(n => <option key={n} value={n}>Input {n}</option>)}
              </select>
              <button style={{ ...FIELD, cursor: "pointer" }} onClick={reload} title="Re-read this computer's inputs (after plugging one in)">↻ Devices</button>
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", opacity: p ? 1 : 0.5 }}>
              <span style={{ fontSize: 11, color: "var(--text-tertiary)", width: 80, textTransform: "uppercase", letterSpacing: "0.06em" }}>Input gain</span>
              <input type="range" min={MIC_GAIN_DB[0]} max={MIC_GAIN_DB[1]} step={0.5} value={gain} disabled={!p} style={{ flex: 1, height: 36 }}
                onChange={e => {
                  const v = Number(e.target.value);
                  setDraftGain(g => ({ ...g, [slot]: v }));
                  clearTimeout(gainTimer.current[slot]);
                  gainTimer.current[slot] = setTimeout(() => { if (p) apply(slot, { ...p, gainDb: v }); setDraftGain(g => { const n = { ...g }; delete n[slot]; return n; }); }, 150);
                }}
                title="Digital gain before the meter and the channel EQ: −10 to +40 dB. Set the mic's preamp first; use this to trim." />
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 14, fontWeight: 800, width: 72, textAlign: "right" }}>{gain > 0 ? "+" : ""}{gain.toFixed(1)} dB</span>
            </div>
            {msg[slot] && <div style={{ fontSize: 12, color: "var(--accent-red, #ef4444)" }}>{msg[slot]}</div>}
          </div>
        );
      })}
      {devices && devices.length === 0 && <div style={{ fontSize: 12, color: "var(--accent-red, #ef4444)" }}>The audio engine sees no input devices on this computer.</div>}
    </div>
  );
}
