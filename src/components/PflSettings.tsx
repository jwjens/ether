// PflSettings.tsx — Preferences → Audio: how far the programme DIPS in this station's local output while a channel's
// PFL is on (Jeff's PFL ruling 2: the console "PFL over monitor"; the amount is a station setting, never a number
// buried in code). station_config_kv `pfl_dim_db` (a station setting — it syncs with the station like the others);
// applied to the engine at once, and the daemon re-applies the stored value to every fresh engine.
import React, { useEffect, useState } from "react";
import { useActiveStation } from "../hooks/useActiveStation";

/** The value this setting shows until the operator changes it — the same number as the engine's
 *  PFL_DIM_DB_DEFAULT (native/src/audio.rs). */
export const PFL_DIM_DB_DEFAULT = -12;
const RANGE: [number, number] = [-60, 0];

export default function PflSettings() {
  const { stationId } = useActiveStation();
  const [dim, setDim] = useState<number>(PFL_DIM_DB_DEFAULT);
  const [stored, setStored] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (stationId == null) return;
    (async () => {
      try {
        const r = await (window as any).ether?.stationConfigKv?.list(stationId);
        const v = ((r?.rows || []) as { key: string; value: string }[]).find(x => x.key === "pfl_dim_db")?.value;
        const n = v != null && v !== "" ? parseFloat(v) : NaN;
        if (Number.isFinite(n)) { setDim(Math.max(RANGE[0], Math.min(RANGE[1], n))); setStored(true); }
        else { setDim(PFL_DIM_DB_DEFAULT); setStored(false); }
      } catch { /* shows the default */ }
    })();
  }, [stationId]);
  const save = async (v: number) => {
    if (stationId == null) return;
    setErr(null);
    try {
      await (window as any).ether?.audio?.setPflDim?.(stationId, v);
      const w = await (window as any).ether?.stationConfigKv?.upsertByKey?.(stationId, "pfl_dim_db", String(v));
      if (w && w.ok === false) setErr(`not saved: ${w.error || "unknown"}`); else setStored(true);
    } catch (e: any) { setErr(String(e?.message || e)); }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 13, color: "var(--text-tertiary)", lineHeight: 1.5 }}>
        <b>PFL</b> on a channel plays that channel — before its fader and ON, after its channel EQ — in this station's
        <b> local output</b>. While any PFL is on, the programme there dips by this much so you can hear what you're checking.
        Air and the stream are never affected.
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 11, color: "var(--text-tertiary)", width: 120, textTransform: "uppercase", letterSpacing: "0.06em" }}>Programme dip</span>
        <input type="range" min={RANGE[0]} max={RANGE[1]} step={1} value={dim} style={{ flex: 1, height: 36 }}
          onChange={e => setDim(Number(e.target.value))}
          onMouseUp={() => save(dim)} onTouchEnd={() => save(dim)} onKeyUp={() => save(dim)}
          title="0 dB = the programme stays at full level under PFL; −60 dB = almost gone" />
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 14, fontWeight: 800, width: 70, textAlign: "right" }}>{dim} dB</span>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
        {stored ? "Saved for this station." : `Not set for this station — PFL uses ${PFL_DIM_DB_DEFAULT} dB, shown above.`}
        {err && <span style={{ color: "var(--accent-red, #ef4444)" }}> ⚠ {err}</span>}
      </div>
    </div>
  );
}
