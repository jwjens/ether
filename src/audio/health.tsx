// src/audio/health.tsx — shared, read-only consumer of the main-process "audio:health" feed.
// One source of truth: the MINI (right-panel) and FULL (Tools > Health Monitor) surfaces both use
// this hook + these presentational atoms — neither recomputes health. Display only.

import { useEffect, useState, type CSSProperties } from "react";
import { levelColor, type HealthLevel as CanonicalLevel } from "../components/health/healthUtils";
import { StatTile, PanelStack, HealthPanel, PanelMeter } from "../components/health/sectionChrome";
// Same mapping the dashboard meters use, so a peak reads the same in both places.
import { ampToDbfs, dbToPercent } from "../components/health/meterScale";

/** The WIRE format of the `audio:health` feed — the main process emits these uppercase (see the
 *  snapshot builder in electron/audio-health.js). It stays uppercase here because that is what
 *  actually arrives; renaming the type would not change the data.
 *
 *  The CANONICAL level used across every health surface is the lowercase `HealthLevel` in
 *  components/health/healthUtils. `toCanonical` is the one boundary between them, and colour now
 *  comes from that single map — see LEVEL_COLOR below. */
export type HealthLevel = "GREEN" | "YELLOW" | "RED" | "GREY";

/** Wire level → canonical level. Anything unrecognised reads grey, never green: the honesty rule
 *  from the v2 design doc, applied at the point the two vocabularies meet. */
export function toCanonical(l: HealthLevel | string | null | undefined): CanonicalLevel {
  switch (l) {
    case "GREEN": return "green";
    case "YELLOW": return "yellow";
    case "RED": return "red";
    default: return "grey";
  }
}

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

/** ONE status palette for the whole Health Monitor.
 *
 *  This used to be four hardcoded hex values, which meant the live telemetry rows and the new
 *  dashboard cards could show two different greens for the same meaning — and a theme change would
 *  move one and not the other. The colours now resolve through healthUtils.LEVEL_COLOR (design
 *  tokens with literal fallbacks), so there is a single place where "yellow" is decided.
 *  The KEYS stay uppercase so every existing `LEVEL_COLOR.RED` call site keeps working. */
export const LEVEL_COLOR: Record<HealthLevel, string> = {
  GREEN: levelColor("green"), YELLOW: levelColor("yellow"), RED: levelColor("red"), GREY: levelColor("grey"),
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

/**
 * Station meter — the SAME row as the dashboard's deck meters: 52px label, a `flex: 1` bar at
 * height 14 on the primary ground, and a 92px monospace readout.
 *
 * The width is the whole point. This was a fixed 110px chip sitting in a grid column, and before
 * that a 60×6 rounded strip on a white wash — either way it read as a progress hairline while the
 * meters six inches above it were full-width instruments. Same component shape, same geometry, so
 * the two halves of the panel are one panel.
 *
 * `scale` matters as much as the size. This bar shows two unrelated quantities:
 *
 *   "linear"  frames/sec against full rate — a genuine 0..1 fraction, correctly drawn linearly.
 *   "audio"   PEAK, which is an AMPLITUDE. Drawn linearly it disagrees with the dashboard meters,
 *             which map amplitude through dB — the same signal would draw two different lengths in
 *             one panel, and the quiet half of the range would be invisible here while being
 *             perfectly legible six inches above. Same mapping, same reading.
 */
export function StationMeter({ label, frac, color, read, scale = "linear" }: {
  label: string; frac: number; color: string; read: string; scale?: "linear" | "audio";
}) {
  const f = Math.max(0, Math.min(1, frac || 0));
  const pct = scale === "audio" ? dbToPercent(ampToDbfs(f)) : f * 100;
  // The -6 dBFS mark belongs only on the dB-scaled meter — on the linear rate bar it would point at
  // nothing.
  return <PanelMeter label={label} pct={pct} color={color} read={read}
                     tickPct={scale === "audio" ? dbToPercent(-6) : undefined} />;
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
  // 13px, not 12: this is a reading on a panel meant to be scanned, in some cases from across a
  // studio. The whole bottom half sat at 9–12px, which is why it read as a developer log next to the
  // dashboard above it.
  const cell: CSSProperties = { fontSize: 13, color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" };
  // `hdr` is gone — all three headings are SectionTitle now, so the panel has one heading style
  // rather than two that drift apart. `cell` stays: the per-station rows still use it.
  if (!snap) return <div style={{ padding: "18px 0", fontSize: 12, color: "var(--text-tertiary)" }}>Connecting to live health feed…</div>;
  const engRed = snap.engine.restartCount > 0;
  return (
    <div>
      <HealthStyles />
      <HealthModeBanner mode={snap.mode} />
      {/* ── Engine ── Four readings as TILES rather than a run-on sentence of "uptime 2m 17s pid
          71184 restarts 0 event-loop ping 2ms". The number leads and its name sits underneath, so
          the row scans as four figures instead of one line of prose.
          Only restarts and ping carry a colour, and only when they mean something — colouring all
          four would make the colour mean nothing. */}
      <PanelStack stack="audio-health">
      <HealthPanel id="engine" title="Engine">
        <div style={{ display: "grid", gap: "var(--s-5, 12px)",
                      gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))" }}>
          <StatTile label="uptime" value={fmtUptime(snap.engine.uptimeSec)} />
          <StatTile label="pid" value={snap.engine.pid ?? "—"} />
          <StatTile label={engRed ? "restarts ⚠" : "restarts"} value={snap.engine.restartCount}
                    tone={engRed ? "red" : undefined} />
          <StatTile label="event-loop ping"
                    value={snap.engine.pingMs != null ? `${snap.engine.pingMs}ms` : "—"}
                    tone={(snap.engine.pingMs ?? 0) > 500 ? "yellow" : undefined} />
        </div>
      </HealthPanel>
      {/* Per-station live rows */}
      <HealthPanel id="stations" title="Stations (live)">
        {snap.stations.length === 0 && <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>No stations reporting.</div>}
        {snap.stations.map(s => (
          <div key={s.uuid} style={{ padding: "var(--s-5, 12px) 0", borderBottom: "1px solid var(--border-primary)" }}>
            {/* Line 1 — who, and how they are. Queue depth and stream state ride the right edge as
                figures rather than as two more grid columns squeezing the meters. */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: "var(--s-4, 8px)" }}>
              <HealthDot level={s.level} size={11} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name || `Station ${s.stationId}`}</div>
                {s.level !== "GREEN" && s.reason && <div style={{ fontSize: 13, color: LEVEL_COLOR[s.level] }}>{s.reason}</div>}
              </div>
              <span style={{ ...cell, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>q {s.queueDepth ?? "—"}</span>
              <span style={{ ...cell, whiteSpace: "nowrap" }}>{s.streaming ? <span style={{ color: LEVEL_COLOR.GREEN }}>▲ {bpsLabel(s.drainBps) || "on"}</span> : <span style={{ color: "var(--text-tertiary)" }}>stream off</span>}</span>
            </div>
            <div style={{ overflow: "hidden" }}>
              <div style={{ fontSize: 13, color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.track || "—"}
                {s.jingle && (
                  <span title={s.jingle.title || "overlay"} style={{
                    marginLeft: 6, padding: "0 5px", borderRadius: 3, fontSize: 11, fontWeight: 800, letterSpacing: "0.08em",
                    color: s.jingle.state === "FIRING" ? "#ffe93b" : "#ffffff",
                    border: `1px solid ${s.jingle.state === "FIRING" ? "#ffe93b" : "#ffffff"}`,
                    background: s.jingle.state === "FIRING" ? "rgba(255,233,59,0.16)" : "rgba(255,255,255,0.12)",
                  }}>{`${s.jingle.contentClass === "SWP" ? "SWP" : "JIN"} ${s.jingle.state === "FIRING" ? "▶" : "◈"}`}</span>
                )}
              </div>
              <div style={cell}>{s.trackLeftSec != null ? `-${fmtLeft(s.trackLeftSec)}` : ""} {s.nextDeckReady ? <span style={{ color: LEVEL_COLOR.GREEN }}>· next ✓</span> : <span style={{ color: "var(--text-tertiary)" }}>· next …</span>}</div>
            </div>
            {/* The meters get the full width of the card, like the deck meters above.
                scale="audio" on peak: it is an AMPLITUDE, so it maps through dB exactly as the
                dashboard meters do — drawn linearly the same signal would show two different
                lengths in one panel, and the quiet half of the range would be invisible here while
                being perfectly legible six inches above. */}
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3, 6px)", marginTop: "var(--s-4, 8px)" }}>
              <StationMeter label="rate" frac={framesFrac(s.framesPerSec)} color={LEVEL_COLOR[s.level]} read={rateLabel(s.framesPerSec)} />
              <StationMeter label="peak" frac={s.peak} color="#38bdf8" read={peakLabel(s.peak)} scale="audio" />
            </div>
          </div>
        ))}
      </HealthPanel>
      {/* Rolling event feed. Distinct from the dashboard's Live Events, which reads the health
          LEDGER; this one is the in-memory feed of level TRANSITIONS from the audio health sense. */}
      <HealthPanel id="transitions" title="Level transitions — last 20, newest first">
        {snap.recentEvents.length === 0 && <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>No warning/critical transitions yet — all healthy.</div>}
        {snap.recentEvents.map((e, i) => (
          <div key={e.ts + i} style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "3px 0", fontSize: 13 }}>
            <span style={{ color: "var(--text-tertiary)", fontVariantNumeric: "tabular-nums" }}>{hhmmss(e.ts)}</span>
            <span style={{ color: LEVEL_COLOR[e.level], fontWeight: 700, minWidth: 52 }}>{e.level}</span>
            <span style={{ color: "var(--text-secondary)", minWidth: 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.stationName || e.stationUuid?.slice(0, 8)}</span>
            <span style={{ color: "var(--text-primary)" }}>{e.reason}</span>
          </div>
        ))}
      </HealthPanel>
      </PanelStack>
    </div>
  );
}
