// PflCueHealth.tsx — the Health Monitor's view of WHERE PFL GOES on this station (docs/dsp-pfl-2026-09-26.md).
// The engine's own report: same as the main output, or a named cue device that is open / opening / NOT FOUND /
// failed — and proof of flow (frames delivered to it). A chosen device that is missing means PFL is silent: it
// never falls back to the speakers, and this panel is where that is said out loud.
import React, { useEffect, useState } from "react";
import { HealthPanel } from "./sectionChrome";
import { cueWords } from "../PflSettings";
import { openMicPreferences } from "../../hooks/useMicInputs";

export default function PflCueHealth({ id, stationId }: { id: string; stationId: number | null }) {
  const [c, setC] = useState<{ device: string; state: string; rate?: number; frames?: number } | null>(null);
  useEffect(() => {
    if (stationId == null) return;
    let alive = true;
    const poll = async () => { try { const r = await (window as any).ether?.audio?.cueState?.(stationId); if (alive && r) setC(r); } catch { /* keep the last */ } };
    poll();
    const t = setInterval(poll, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [stationId]);
  const w = cueWords(c?.state, c?.device || "");
  return (
    <HealthPanel id={id} title="PFL Output" right={
      <button onClick={openMicPreferences} style={{ fontSize: 11, cursor: "pointer", background: "transparent", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", padding: "2px 8px" }}
              title="Preferences → Audio → PFL">Change…</button>
    }>
      {!c ? (
        <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>Waiting for the engine…</div>
      ) : (
        <div style={{ fontSize: 12, display: "flex", flexWrap: "wrap", gap: "2px 12px", alignItems: "baseline" }}>
          <span style={{ fontWeight: 700, color: w.bad ? "var(--accent-red, #ef4444)" : "var(--accent-green)" }}>● {w.text}</span>
          {c.state === "open" && (
            <span style={{ color: "var(--text-tertiary)", fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}
                  title="frames the cue device has actually played — proof of flow, not merely of opening">
              {c.rate} Hz · {(Number(c.frames || 0) / Math.max(1, Number(c.rate || 1))).toFixed(0)} s delivered
            </span>
          )}
        </div>
      )}
    </HealthPanel>
  );
}
