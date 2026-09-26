// MicInputsHealth.tsx — the Health Monitor's view of THE MIC AS AN ENGINE INPUT (docs/dsp-mic-in-engine.md §4;
// "build the sense, not the scaffold"). Every patched mic on this station, as the ENGINE reports it: the device,
// the state in words (live / not connected / lost / pure digital silence …), and every counter — dropouts,
// losses, re-opens, overruns, stale flushes — plus the ring and the clock drift the engine is absorbing.
// Nothing here is claimed: a mic the engine has not reported says "waiting for the engine".
import React from "react";
import { HealthPanel } from "./sectionChrome";
import { micStateWords, openMicPreferences, useMicInputs } from "../../hooks/useMicInputs";

const TONE: Record<string, string> = { ok: "var(--accent-green)", warn: "var(--accent-amber, #f59e0b)", bad: "var(--accent-red, #ef4444)", off: "var(--text-tertiary)" };

export default function MicInputsHealth({ id, stationId }: { id: string; stationId: number | null }) {
  const mic = useMicInputs(stationId);
  const slots = Array.from(new Set([...Object.keys(mic.patches), ...Object.keys(mic.states)])).sort();
  return (
    <HealthPanel id={id} title="Mic Inputs" right={
      <button onClick={openMicPreferences} style={{ fontSize: 11, cursor: "pointer", background: "transparent", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", padding: "2px 8px" }}
              title="Patch inputs, input numbers and gain: Preferences → Audio → Mic Inputs">Patch…</button>
    }>
      {slots.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>No mic is patched on this station on this computer.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {slots.map(slot => {
            const p = mic.patches[slot];
            const s = mic.states[slot];
            const w = micStateWords(s, !!p);
            return (
              <div key={slot} style={{ fontSize: 12, display: "flex", flexWrap: "wrap", gap: "2px 12px", alignItems: "baseline" }}>
                <b style={{ minWidth: 28 }}>{slot}</b>
                <span style={{ minWidth: 200 }}>{p ? `${p.device} · input ${p.channel} · ${p.gainDb >= 0 ? "+" : ""}${p.gainDb} dB` : "—"}</span>
                <span style={{ color: TONE[w.tone], fontWeight: 700 }}>● {w.text}</span>
                {s && (
                  <span style={{ color: "var(--text-tertiary)", fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}
                        title="dropouts = times the input ran dry (the channel went silent, the programme kept playing) · lost = device disappeared · re-opened = came back · overruns = input blocks dropped because the engine was not reading · stale = old audio discarded so the mic is never late">
                    {s.rate ? `${s.rate} Hz · ` : ""}buf {s.fillMs.toFixed(0)}/{s.targetMs.toFixed(0)} ms · clock {s.driftPpm >= 0 ? "+" : ""}{s.driftPpm.toFixed(0)} ppm ·
                    {" "}dropouts {s.underruns} · lost {s.losses} · re-opened {s.reopens} · overruns {s.overruns} · stale {s.staleFlushes}
                    {s.zeroSec >= 1 ? ` · digital zero ${s.zeroSec.toFixed(0)} s` : ""}
                  </span>
                )}
                {s && s.reason && <span style={{ color: "var(--text-tertiary)", width: "100%", paddingLeft: 40 }}>{s.reason}</span>}
              </div>
            );
          })}
        </div>
      )}
    </HealthPanel>
  );
}
