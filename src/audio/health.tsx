// src/audio/health.tsx — shared, read-only consumer of the main-process "audio:health" feed.
// One source of truth: the MINI (right-panel) and FULL (Tools > Health Monitor) surfaces both use
// this hook + these presentational atoms — neither recomputes health. Display only.

import { useEffect, useState, type CSSProperties } from "react";

export type HealthLevel = "GREEN" | "YELLOW" | "RED" | "GREY";

export interface HealthStation {
  uuid: string; stationId: number | null; name: string;
  level: HealthLevel; reason: string;
  framesPerSec: number; peak: number; activeDecks: number;
  queueDepth: number | null; nextDeckReady: boolean;
  track: string | null; trackLeftSec: number | null;
  streaming: boolean; drainBps: number | null; enginestate: string; levelSince: string;
  jingle?: { state: string; title: string | null; categoryId: number | null; contentClass?: string | null; since: number } | null;   // JINGLES v1/v2
}
export interface HealthEvent { ts: string; stationUuid: string; stationName?: string; level: HealthLevel; prevLevel: HealthLevel; reason: string; metrics?: any; }
export interface HealthSnapshot {
  ts: string;
  mode?: "daemon" | "in-process" | string;   // v4.4.50: playout mode — drives the RED fallback banner
  engine: { pid: number | null; uptimeSec: number | null; restartCount: number; pingMs: number | null };
  stations: HealthStation[];
  recentEvents: HealthEvent[];
}

export const LEVEL_COLOR: Record<HealthLevel, string> = {
  GREEN: "#22c55e", YELLOW: "#f59e0b", RED: "#ef4444", GREY: "#6b7280",
};
const FULL_RATE = 44100;

// Subscribe to the live health feed. Returns the latest snapshot (null until first frame).
export function useAudioHealth(): HealthSnapshot | null {
  const [snap, setSnap] = useState<HealthSnapshot | null>(null);
  useEffect(() => {
    const ether: any = (window as any).ether;
    if (!ether?.on) return;
    let alive = true;
    try { ether.invoke?.("health:snapshot").then((s: HealthSnapshot) => { if (alive && s) setSnap(s); }).catch(() => {}); } catch {}
    const h = ether.on("audio:health", (s: HealthSnapshot) => { if (alive) setSnap(s); });
    return () => { alive = false; try { ether.off("audio:health", h); } catch {} };
  }, []);
  return snap;
}

// Compact rate label, e.g. 231246 -> "231k/s"
export function rateLabel(fps: number): string { return `${Math.round((fps || 0) / 1000)}k/s`; }
export function peakLabel(p: number): string { return `pk ${(p || 0).toFixed(2).replace(/^0/, "")}`; }
export function bpsLabel(b: number | null): string { return b == null ? "" : `${Math.round(b / 1000)} kB/s`; }

// Colored status dot; pulses on YELLOW/RED.
export function HealthDot({ level, size = 9 }: { level: HealthLevel; size?: number }) {
  const pulse = level === "YELLOW" || level === "RED";
  return (
    <span
      style={{
        display: "inline-block", width: size, height: size, borderRadius: "50%",
        background: LEVEL_COLOR[level], flexShrink: 0,
        boxShadow: pulse ? `0 0 0 0 ${LEVEL_COLOR[level]}` : "none",
        animation: pulse ? `ether-health-pulse 1.4s infinite` : "none",
      }}
    />
  );
}

// Thin meter bar (0..1 fraction) — used for frames/s (vs full rate) and peak.
export function MeterBar({ frac, color, width = 60, height = 6 }: { frac: number; color: string; width?: number; height?: number }) {
  const f = Math.max(0, Math.min(1, frac || 0));
  return (
    <span style={{ display: "inline-block", width, height, background: "rgba(255,255,255,0.10)", borderRadius: 3, overflow: "hidden", verticalAlign: "middle" }}>
      <span style={{ display: "block", width: `${f * 100}%`, height: "100%", background: color, transition: "width 0.25s linear" }} />
    </span>
  );
}
export function framesFrac(fps: number): number { return (fps || 0) / FULL_RATE; }

// Inject the pulse keyframes once (module side-effect via a tiny component embedded by consumers).
export function HealthStyles() {
  return (
    <style>{`@keyframes ether-health-pulse {
      0%   { box-shadow: 0 0 0 0 currentColor; opacity: 1; }
      70%  { box-shadow: 0 0 0 6px transparent; opacity: 0.75; }
      100% { box-shadow: 0 0 0 0 transparent; opacity: 1; }
    }`}</style>
  );
}

// v4.4.50: impossible-to-miss RED banner whenever playout is running on the in-process fallback.
export function HealthModeBanner({ mode, compact }: { mode?: string; compact?: boolean }) {
  if (mode !== "in-process") return null;
  return (
    <div style={{
      background: "rgba(239,68,68,0.15)", border: `1px solid ${LEVEL_COLOR.RED}`, color: LEVEL_COLOR.RED,
      padding: compact ? "4px 8px" : "9px 12px", margin: compact ? "2px 0 6px" : "0 0 12px",
      fontSize: compact ? 11 : 13, fontWeight: 800, borderRadius: 2, display: "flex", alignItems: "center", gap: 8,
      animation: "ether-health-pulse 1.6s infinite",
    }}>
      <HealthStyles />
      <HealthDot level="RED" />
      {compact
        ? "IN-PROCESS FALLBACK — metering active station only"
        : "⚠ IN-PROCESS FALLBACK — daemon not attached. All stations are still airing; the Health Monitor meters only the active station. Relaunch to restore daemon telemetry."}
    </div>
  );
}

function fmtUptime(sec: number | null): string {
  if (sec == null) return "—";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}
function fmtLeft(sec: number | null): string {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
function hhmmss(iso: string): string { try { return new Date(iso).toLocaleTimeString(); } catch { return iso; } }

// FULL live Health Monitor — engine section + per-station rows + rolling event feed. Updates each
// second off the same feed as the mini panel. Display only.
export function LiveHealthMonitor() {
  const snap = useAudioHealth();
  const cell: CSSProperties = { fontSize: 12, color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" };
  const hdr: CSSProperties = { fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 8 };
  if (!snap) return <div style={{ padding: "18px 0", fontSize: 12, color: "var(--text-tertiary)" }}>Connecting to live health feed…</div>;
  const engRed = snap.engine.restartCount > 0;
  return (
    <div>
      <HealthStyles />
      <HealthModeBanner mode={snap.mode} />
      {/* Engine */}
      <div style={{ paddingTop: 12, marginBottom: 12 }}>
        <div style={hdr}>Engine</div>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" as const, alignItems: "center" }}>
          <span style={cell}>uptime <b style={{ color: "var(--text-primary)" }}>{fmtUptime(snap.engine.uptimeSec)}</b></span>
          <span style={cell}>pid <b style={{ color: "var(--text-primary)" }}>{snap.engine.pid ?? "—"}</b></span>
          <span style={cell}>restarts <b style={{ color: engRed ? LEVEL_COLOR.RED : "var(--text-primary)" }}>{snap.engine.restartCount}</b>{engRed ? " ⚠ engine restarted" : ""}</span>
          <span style={cell}>event-loop ping <b style={{ color: (snap.engine.pingMs ?? 0) > 500 ? LEVEL_COLOR.YELLOW : "var(--text-primary)" }}>{snap.engine.pingMs != null ? snap.engine.pingMs + "ms" : "—"}</b></span>
        </div>
      </div>
      {/* Per-station live rows */}
      <div style={{ paddingTop: 12, borderTop: "1px solid var(--border-primary)", marginBottom: 12 }}>
        <div style={hdr}>Stations (live)</div>
        {snap.stations.length === 0 && <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>No stations reporting.</div>}
        {snap.stations.map(s => (
          <div key={s.uuid} style={{ display: "grid", gridTemplateColumns: "16px 130px 1fr 1fr 70px 90px", gap: 10, alignItems: "center", padding: "7px 0", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
            <HealthDot level={s.level} />
            <div style={{ overflow: "hidden" }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name || `Station ${s.stationId}`}</div>
              {s.level !== "GREEN" && s.reason && <div style={{ fontSize: 10, color: LEVEL_COLOR[s.level] }}>{s.reason}</div>}
            </div>
            <div>
              <div style={cell}>{rateLabel(s.framesPerSec)} <MeterBar frac={framesFrac(s.framesPerSec)} color={LEVEL_COLOR[s.level]} width={80} /></div>
              <div style={{ ...cell, marginTop: 3 }}>{peakLabel(s.peak)} <MeterBar frac={s.peak} color="#38bdf8" width={80} /></div>
            </div>
            <div style={{ overflow: "hidden" }}>
              <div style={{ fontSize: 12, color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.track || "—"}
                {s.jingle && (
                  <span title={s.jingle.title || "overlay"} style={{
                    marginLeft: 6, padding: "0 5px", borderRadius: 3, fontSize: 9, fontWeight: 800, letterSpacing: "0.08em",
                    color: s.jingle.state === "FIRING" ? "#ffe93b" : "#ffffff",
                    border: `1px solid ${s.jingle.state === "FIRING" ? "#ffe93b" : "#ffffff"}`,
                    background: s.jingle.state === "FIRING" ? "rgba(255,233,59,0.16)" : "rgba(255,255,255,0.12)",
                  }}>{`${s.jingle.contentClass === "SWP" ? "SWP" : "JIN"} ${s.jingle.state === "FIRING" ? "▶" : "◈"}`}</span>
                )}
              </div>
              <div style={cell}>{s.trackLeftSec != null ? `-${fmtLeft(s.trackLeftSec)}` : ""} {s.nextDeckReady ? <span style={{ color: LEVEL_COLOR.GREEN }}>· next ✓</span> : <span style={{ color: "var(--text-tertiary)" }}>· next …</span>}</div>
            </div>
            <div style={cell}>q {s.queueDepth ?? "—"}</div>
            <div style={cell}>{s.streaming ? <span style={{ color: LEVEL_COLOR.GREEN }}>▲ {bpsLabel(s.drainBps) || "on"}</span> : <span style={{ color: "var(--text-tertiary)" }}>stream off</span>}</div>
          </div>
        ))}
      </div>
      {/* Rolling event feed */}
      <div style={{ paddingTop: 12, borderTop: "1px solid var(--border-primary)" }}>
        <div style={hdr}>Live events (last 20 YELLOW/RED transitions, newest first)</div>
        {snap.recentEvents.length === 0 && <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>No warning/critical transitions yet — all healthy.</div>}
        {snap.recentEvents.map((e, i) => (
          <div key={e.ts + i} style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "3px 0", fontSize: 11 }}>
            <span style={{ color: "var(--text-tertiary)", fontVariantNumeric: "tabular-nums" }}>{hhmmss(e.ts)}</span>
            <span style={{ color: LEVEL_COLOR[e.level], fontWeight: 700, minWidth: 52 }}>{e.level}</span>
            <span style={{ color: "var(--text-secondary)", minWidth: 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.stationName || e.stationUuid?.slice(0, 8)}</span>
            <span style={{ color: "var(--text-primary)" }}>{e.reason}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
