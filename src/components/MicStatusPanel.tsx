// MicStatusPanel.tsx — what the canvas "mic" widget and the "mic" pop-out show since the mic became an ENGINE
// input (docs/dsp-mic-in-engine.md §3). They used to render MicDeck: getUserMedia → a browser EQ → the default
// output, never on air. A saved layout that still has one must render something that works — so this is the
// mic's STATUS (each mic channel, its input, the engine's live state) and the door to where it is patched.
import React from "react";
import { useActiveStation } from "../hooks/useActiveStation";
import { useDeckConfig } from "./DeckConfigurator";
import { micStateWords, openMicPreferences, useMicInputs } from "../hooks/useMicInputs";

const TONE: Record<string, string> = { ok: "var(--accent-green)", warn: "var(--accent-amber, #f59e0b)", bad: "var(--accent-red, #ef4444)", off: "var(--text-tertiary)" };

export default function MicStatusPanel() {
  const { stationId } = useActiveStation();
  const { configs } = useDeckConfig();
  const mic = useMicInputs(stationId);
  const chans = configs.filter(c => c.enabled && c.type === "source" && c.kind === "mic");
  return (
    <div style={{ height: "100%", boxSizing: "border-box", padding: 12, display: "flex", flexDirection: "column", gap: 8, background: "var(--bg-secondary)", overflow: "auto" }}>
      <b style={{ fontSize: 12, letterSpacing: "0.12em" }}>MIC</b>
      {chans.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--text-tertiary)", lineHeight: 1.5 }}>
          The mic is a channel on the board: set a source channel's source to <b>Mic</b>, then pick its input in Preferences → Audio.
        </div>
      ) : chans.map(c => {
        const p = mic.patches[c.slot];
        const w = micStateWords(mic.states[c.slot], !!p);
        return (
          <div key={c.slot} style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 2, padding: 6, border: "1px solid var(--border-primary)" }}>
            <span><b>{c.slot}</b> · {p ? `${p.device} · input ${p.channel}` : "no input"}</span>
            <span style={{ color: TONE[w.tone], fontWeight: 700 }}>● {w.text}</span>
          </div>
        );
      })}
      <button onClick={openMicPreferences} style={{ minHeight: 36, cursor: "pointer", background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", fontSize: 12, fontWeight: 700 }}>
        Mic inputs… (Preferences → Audio)
      </button>
    </div>
  );
}
