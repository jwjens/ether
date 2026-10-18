// AlertsHealth.tsx — the Health Monitor's ALERTS list (docs/scheduler-rotation-playout-design.md §6, Phase 1).
//
// Every alert the station raises, newest first, in plain words: the same structured events the health log, the :3400
// stream (Iris) and GET /api/alerts carry — one stream, read here through `health:alerts` and followed live on
// `health:alert`. Never hidden behind a "routine" filter: this list only ever shows things that went wrong on air.
// It only shows. Nothing here acknowledges, fixes or silences anything (detect and report).
import React, { useEffect, useMemo, useState } from "react";

type Alert = {
  v: number; id: string; kind: string; severity: "red" | "yellow"; stationUuid: string | null; at: string; observedAt: string;
  machineId: string | null; row: { id: number | null; uuid: string | null; scheduledAt: number | null; title: string | null } | null;
  song: { title: string | null; artist: string | null; file: string | null } | null;
  rule: { key: string; setting: unknown; measured: unknown; unit: string | null } | null; path: string | null; message: string;
};

// What each kind means, in words an operator reads (and docs/help-health-monitor.md repeats).
const KIND_WORDS: Record<string, string> = {
  "row-aired-twice": "Aired twice",
  "aired-row-changed": "Aired log row changed",
  "not-stamped": "Not recorded",
  "retired-row-aired": "Aired after it was marked missed",
};
const TONE = { red: "var(--accent-red, #ef4444)", yellow: "var(--accent-amber, #f59e0b)" };
const MAX = 200;

export default function AlertsHealth({ id, stationUuid }: { id: string; stationUuid: string | null }) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [allStations, setAllStations] = useState(false);

  useEffect(() => {
    const ether = (window as any).ether;
    let alive = true;
    ether?.invoke?.("health:alerts", { limit: MAX }).then((r: { ok: boolean; alerts?: Alert[]; error?: string }) => {
      if (!alive) return;
      if (r && r.ok) { setAlerts(r.alerts || []); setErr(null); } else setErr((r && r.error) || "could not read the alerts");
    }).catch((e: any) => { if (alive) setErr(e?.message || String(e)); });
    const h = ether?.on?.("health:alert", (a: Alert) => setAlerts(prev => [...prev.filter(x => x.id !== a.id), a].slice(-MAX)));
    return () => { alive = false; if (h) ether?.off?.("health:alert", h); };
  }, []);

  const shown = useMemo(() => alerts.filter(a => allStations || !stationUuid || a.stationUuid === stationUuid).slice().reverse(), [alerts, allStations, stationUuid]);
  const reds = shown.filter(a => a.severity === "red").length;

  return (
    <div id={id} style={{ margin: "16px 0", border: "1px solid var(--border-primary)", background: "var(--bg-secondary)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderBottom: "1px solid var(--border-primary)" }}>
        <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.12em", color: "var(--text-secondary)" }}>
          ALERTS {shown.length > 0 && <span style={{ color: reds ? TONE.red : TONE.yellow }}>· {shown.length}{reds ? ` (${reds} red)` : ""}</span>}
        </div>
        <label style={{ fontSize: 11, color: "var(--text-tertiary)", display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
          <input type="checkbox" checked={allStations} onChange={e => setAllStations(e.target.checked)} /> every station
        </label>
      </div>
      <div style={{ maxHeight: 280, overflowY: "auto" as const, padding: "6px 12px" }}>
        {err && <div style={{ fontSize: 12, color: TONE.red }}>The alerts could not be read: {err}</div>}
        {!err && shown.length === 0 && (
          <div style={{ fontSize: 12, color: "var(--text-tertiary)", padding: "6px 0" }}>
            No alerts. An alert appears here the moment a log row airs a second time, a log row that already aired is changed
            or deleted, or something airs and Ether cannot record it.
          </div>
        )}
        {shown.map(a => (
          <div key={a.id} style={{ display: "flex", gap: 10, alignItems: "baseline", fontSize: 12, padding: "4px 0", borderBottom: "1px dashed var(--border-primary)" }}>
            <span style={{ color: TONE[a.severity] || TONE.yellow, fontWeight: 800 }}>●</span>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "var(--text-tertiary)", minWidth: 120 }}
                  title={`happened ${a.at} · recorded ${a.observedAt}${a.machineId ? " · machine " + a.machineId : ""}${a.path ? " · " + a.path : ""}`}>
              {new Date(a.at).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit", second: "2-digit" })}
            </span>
            <span style={{ fontWeight: 700, minWidth: 150, color: "var(--text-secondary)" }}>{KIND_WORDS[a.kind] || a.kind}</span>
            <span style={{ color: "var(--text-primary)" }}>{a.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
