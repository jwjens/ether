// src/components/SelfHealingClock.tsx
//
// The Self-Healing Clock — shows wall time, drift to hard sync,
// and a time-scale recommendation.
//
// Plugs into the Telemetry Pillar and the Live Assist header.
// Every second it sends remaining log duration to the Rust backend
// and gets back drift + status.
//
// Usage:
//   import SelfHealingClock from "./components/SelfHealingClock";
//   <SelfHealingClock logRemainingMs={queueTotalMs} />

import { useEffect, useRef, useState } from "react";
const invoke = <T = any>(cmd: string, args?: any): Promise<T> => (window as any).ether.invoke(cmd, args);

interface ClockState {
  wall_time: string;
  secs_to_hard_sync: number;
  log_remaining_secs: number;
  drift_secs: number;
  status: "green" | "yellow" | "red";
  message: string;
  time_scale: number;
}

interface Props {
  /** Total remaining queue duration in milliseconds */
  logRemainingMs: number;
  /** Show compact mode (just the clock + status dot) */
  compact?: boolean;
}

const STATUS_COLORS = {
  green:  { bg: "rgba(52,211,153,0.1)",  border: "rgba(52,211,153,0.3)",  text: "#34d399", dot: "#34d399" },
  yellow: { bg: "rgba(251,191,36,0.1)",  border: "rgba(251,191,36,0.3)",  text: "#fbbf24", dot: "#fbbf24" },
  red:    { bg: "rgba(239,68,68,0.12)",  border: "rgba(239,68,68,0.4)",   text: "#ef4444", dot: "#ef4444" },
};

export default function SelfHealingClock({ logRemainingMs, compact = false }: Props) {
  const [clock, setClock] = useState<ClockState | null>(null);
  const [localTime, setLocalTime] = useState("");
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Update local display time every second independent of Rust
  useEffect(() => {
    const tick = () => {
      setLocalTime(new Date().toLocaleTimeString([], {
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      }));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // Push log remaining to Rust every second, get drift back
  useEffect(() => {
    const update = async () => {
      try {
        const remaining = logRemainingMs / 1000;
        const state = await invoke<ClockState>("update_clock", {
          logRemainingMs: remaining,
        });
        setClock(state);
      } catch {
        // Rust clock module not loaded yet — show local time only
      }
    };

    update();
    intervalRef.current = setInterval(update, 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [logRemainingMs]);

  const status = clock?.status ?? "green";
  const colors = STATUS_COLORS[status];
  const driftAbs = Math.abs(clock?.drift_secs ?? 0);
  const driftSign = (clock?.drift_secs ?? 0) > 0 ? "+" : "-";
  const toSync = clock?.secs_to_hard_sync ?? 0;
  const syncMins = Math.floor(toSync / 60);
  const syncSecs = Math.floor(toSync % 60);

  if (compact) {
    return (
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        fontFamily: "'DM Mono', monospace",
      }}>
        {/* Status dot */}
        <div style={{
          width: 6, height: 6, borderRadius: "50%",
          background: colors.dot,
          boxShadow: `0 0 6px ${colors.dot}`,
          animation: status !== "green" ? "shc-pulse 1.5s ease-in-out infinite" : "none",
          flexShrink: 0,
        }} />
        {/* Time */}
        <span style={{ fontSize: 12, color: "var(--text-secondary)", letterSpacing: "0.05em" }}>
          {localTime}
        </span>
        {/* Sync countdown */}
        {clock && (
          <span style={{
            fontSize: 9, color: colors.text,
            background: colors.bg, border: `1px solid ${colors.border}`,
            padding: "1px 5px", borderRadius: 0, letterSpacing: "0.04em",
          }}>
            {String(syncMins).padStart(2, "0")}:{String(syncSecs).padStart(2, "0")} to sync
          </span>
        )}
        <style>{`
          @keyframes shc-pulse {
            0%, 100% { opacity: 1; } 50% { opacity: 0.3; }
          }
        `}</style>
      </div>
    );
  }

  // Full display
  const maxDrift = 120; // seconds, for bar scaling
  const driftPct = Math.min(100, (driftAbs / maxDrift) * 100);

  return (
    <div style={{
      background: "var(--bg-panel, rgba(12,12,20,0.95))",
      border: `1px solid ${colors.border}`,
      borderRadius: 0,
      padding: "12px 16px",
      fontFamily: "'DM Mono', monospace",
      transition: "border-color 0.4s",
      minWidth: 220,
    }}>
      {/* Wall clock */}
      <div style={{
        fontSize: 28, fontWeight: 700, letterSpacing: "0.08em",
        color: "rgba(255,255,255,0.9)", lineHeight: 1, marginBottom: 8,
      }}>
        {localTime}
      </div>

      {/* Hard sync countdown */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", letterSpacing: "0.1em", textTransform: "uppercase" }}>
          Hard Sync
        </span>
        <span style={{
          fontSize: 13, fontWeight: 700, color: colors.text,
          letterSpacing: "0.06em",
        }}>
          {String(syncMins).padStart(2, "0")}:{String(syncSecs).padStart(2, "0")}
        </span>
      </div>

      {/* Drift bar */}
      {clock && (
        <>
          <div style={{ marginBottom: 6 }}>
            <div style={{
              height: 4, borderRadius: 0,
              background: "rgba(255,255,255,0.08)",
              overflow: "hidden",
            }}>
              <div style={{
                height: "100%",
                width: `${driftPct}%`,
                background: colors.dot,
                borderRadius: 0,
                transition: "width 0.8s ease, background 0.4s",
              }} />
            </div>
          </div>

          {/* Status message */}
          <div style={{
            fontSize: 9, color: colors.text,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            display: "flex", alignItems: "center", gap: 5,
          }}>
            <div style={{
              width: 4, height: 4, borderRadius: "50%",
              background: colors.dot,
              animation: status !== "green" ? "shc-pulse 1.5s ease-in-out infinite" : "none",
            }} />
            {clock.message}
          </div>

          {/* Time-scale indicator (only when active) */}
          {Math.abs(clock.time_scale - 1.0) > 0.005 && (
            <div style={{
              marginTop: 6,
              padding: "3px 7px",
              background: "rgba(139,92,246,0.1)",
              border: "1px solid rgba(139,92,246,0.25)",
              borderRadius: 0,
              fontSize: 9, color: "#a78bfa",
              letterSpacing: "0.06em",
            }}>
              TIME-SCALE {clock.time_scale > 1 ? "▲" : "▼"} {(clock.time_scale * 100).toFixed(1)}%
            </div>
          )}

          {/* Fill card suggestion */}
          {status !== "green" && clock.drift_secs < -10 && (
            <div style={{
              marginTop: 8,
              padding: "5px 8px",
              background: "rgba(251,191,36,0.07)",
              border: "1px solid rgba(251,191,36,0.2)",
              borderRadius: 0,
              fontSize: 9, color: "#fbbf24",
              cursor: "pointer",
            }}>
              ✦ AI Fill Card suggested ({Math.abs(clock.drift_secs).toFixed(0)}s gap)
            </div>
          )}
        </>
      )}

      <style>{`
        @keyframes shc-pulse {
          0%, 100% { opacity: 1; } 50% { opacity: 0.3; }
        }
      `}</style>
    </div>
  );
}
