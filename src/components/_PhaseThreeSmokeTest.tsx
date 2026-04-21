/**
 * _PhaseThreeSmokeTest — manual verification component for Phase 3a
 *
 * DO NOT wire into app navigation. Import temporarily into App.tsx to verify,
 * then revert. Delete this file after Phase 3c is complete.
 *
 * To test: add these two lines to App.tsx temporarily, then revert:
 *   import PhaseThreeSmokeTest from "./components/_PhaseThreeSmokeTest";
 *   <PhaseThreeSmokeTest />   ← anywhere in the JSX return
 */

import { useState, useEffect } from "react";
import { useActiveStation } from "../hooks/useActiveStation";
import { queryScoped } from "../db/stationScoped";
import { query } from "../db/client";

export default function PhaseThreeSmokeTest() {
  const { stationId, stationName, isReady } = useActiveStation();
  const [scopedCount, setScopedCount] = useState<number | null>(null);
  const [rawCount,    setRawCount]    = useState<number | null>(null);
  const [queryLog,    setQueryLog]    = useState<string>("");
  const [err,         setErr]         = useState<string | null>(null);

  useEffect(() => {
    if (!isReady) return;
    (async () => {
      try {
        const [scoped, raw] = await Promise.all([
          queryScoped<{ c: number }>("SELECT COUNT(*) as c FROM songs", [], stationId),
          query<{ c: number }>("SELECT COUNT(*) as c FROM songs"),
        ]);
        setScopedCount(scoped[0]?.c ?? 0);
        setRawCount(raw[0]?.c ?? 0);
        setQueryLog(`queryScoped injected: SELECT COUNT(*) as c FROM songs WHERE station_id = ? [${stationId}]`);
      } catch (e: any) {
        setErr(String(e?.message ?? e));
      }
    })();
  }, [isReady, stationId]);

  const countsMatch = scopedCount !== null && rawCount !== null && scopedCount === rawCount;

  const row = (label: string, value: React.ReactNode, color?: string) => (
    <div style={{ display: "flex", gap: 8, marginBottom: 3 }}>
      <span style={{ color: "#94a3b8", minWidth: 120 }}>{label}</span>
      <span style={{ color: color ?? "#e2e8f0", fontWeight: 600 }}>{value}</span>
    </div>
  );

  return (
    <div style={{
      position: "fixed", bottom: 60, right: 20, zIndex: 9999,
      background: "#0f172a", border: "1px solid #334155",
      padding: "14px 16px", minWidth: 380,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 11,
      color: "#e2e8f0", boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
    }}>
      <div style={{ fontWeight: 800, marginBottom: 10, color: "#38bdf8", letterSpacing: "0.08em" }}>
        ▶ PHASE 3A SMOKE TEST
      </div>

      {/* Hook state */}
      {row("stationId",   stationId,   isReady ? "#22c55e" : "#f59e0b")}
      {row("stationName", stationName || "(empty)", isReady ? "#22c55e" : "#f59e0b")}
      {row("isReady",     String(isReady), isReady ? "#22c55e" : "#ef4444")}

      <div style={{ borderTop: "1px solid #1e293b", margin: "10px 0" }} />

      {/* Query counts */}
      {row("scopedCount",  scopedCount ?? "…", "#a78bfa")}
      {row("rawCount",     rawCount    ?? "…", "#a78bfa")}

      {scopedCount !== null && rawCount !== null && (
        <div style={{
          marginTop: 8, padding: "6px 8px",
          background: countsMatch ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
          border: `1px solid ${countsMatch ? "rgba(34,197,94,0.4)" : "rgba(239,68,68,0.4)"}`,
          color: countsMatch ? "#22c55e" : "#f87171",
          fontWeight: 700, fontSize: 10, letterSpacing: "0.04em",
        }}>
          {countsMatch
            ? "✓ COUNTS MATCH — scoping correct for single-station setup"
            : `✗ MISMATCH — scoped=${scopedCount}, raw=${rawCount} — check station_id column data`}
        </div>
      )}

      {queryLog && (
        <div style={{ marginTop: 8, fontSize: 9, color: "#64748b", wordBreak: "break-all" }}>
          {queryLog}
        </div>
      )}

      {err && (
        <div style={{ marginTop: 8, color: "#f87171", fontSize: 10 }}>
          ERROR: {err}
        </div>
      )}
    </div>
  );
}
