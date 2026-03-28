// src/components/TelemetryPillar.tsx
//
// The Heartbeat — a thin right-side telemetry column showing live
// Rust engine health events. Goes red if the pulse stops for 2+ seconds.
//
// Usage in App.tsx (inside the LivePanel area):
//   import TelemetryPillar from "./components/TelemetryPillar";
//   // Add alongside your deck layout:
//   <TelemetryPillar />

import { useEffect, useRef, useState, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

// ── Types ─────────────────────────────────────────────────────

interface HeartbeatEvent {
  timestamp: string;
  level: "green" | "yellow" | "red";
  message: string;
  value: string | null;
}

// ── Color tokens ──────────────────────────────────────────────

const LEVEL_COLOR = {
  green:  { text: "rgba(52,211,153,0.85)",  dot: "#34d399", glow: "rgba(52,211,153,0.2)"  },
  yellow: { text: "rgba(251,191,36,0.85)",  dot: "#fbbf24", glow: "rgba(251,191,36,0.2)"  },
  red:    { text: "rgba(239,68,68,0.95)",   dot: "#ef4444", glow: "rgba(239,68,68,0.35)"  },
};

// ── TelemetryPillar ───────────────────────────────────────────

interface Props {
  /** Width of the pillar in pixels. Default 160. */
  width?: number;
  /** Max events to show. Default 80. */
  maxEvents?: number;
  /** Whether to show the pillar (controlled by parent). Default true. */
  visible?: boolean;
}

export default function TelemetryPillar({
  width = 160,
  maxEvents = 80,
  visible = true,
}: Props) {
  const [events, setEvents]           = useState<HeartbeatEvent[]>([]);
  const [alive, setAlive]             = useState(true);
  const [lastPulse, setLastPulse]     = useState(Date.now());
  const [collapsed, setCollapsed]     = useState(false);
  const scrollRef                     = useRef<HTMLDivElement>(null);
  const deadTimerRef                  = useRef<ReturnType<typeof setInterval> | null>(null);
  const unlistenRef                   = useRef<(() => void) | null>(null);

  // ── Append events, keep last maxEvents ───────────────────────

  const appendEvents = useCallback((incoming: HeartbeatEvent[]) => {
    setLastPulse(Date.now());
    setAlive(true);
    setEvents(prev => {
      const merged = [...prev, ...incoming];
      return merged.length > maxEvents
        ? merged.slice(merged.length - maxEvents)
        : merged;
    });
  }, [maxEvents]);

  // ── Dead-pulse detector ───────────────────────────────────────
  // If no heartbeat received for 2 seconds, pillar goes red.

  useEffect(() => {
    deadTimerRef.current = setInterval(() => {
      const gap = Date.now() - lastPulse;
      setAlive(gap < 2000);
    }, 500);
    return () => {
      if (deadTimerRef.current) clearInterval(deadTimerRef.current);
    };
  }, [lastPulse]);

  // ── Tauri event listener ─────────────────────────────────────

  useEffect(() => {
    let active = true;

    // Load initial events on mount
    invoke<HeartbeatEvent[]>("get_heartbeat", { n: maxEvents })
      .then(initial => { if (active && initial.length) appendEvents(initial); })
      .catch(() => {});

    // Listen for push events from Rust heartbeat thread
    listen<HeartbeatEvent[]>("heartbeat", event => {
      if (active) appendEvents(event.payload);
    }).then(unlisten => {
      unlistenRef.current = unlisten;
    }).catch(() => {});

    return () => {
      active = false;
      unlistenRef.current?.();
    };
  }, [appendEvents, maxEvents]);

  // ── Auto-scroll to bottom ─────────────────────────────────────

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events]);

  if (!visible) return null;

  const isAlive = alive;
  const borderColor = isAlive ? "rgba(255,255,255,0.06)" : "rgba(239,68,68,0.4)";
  const headerColor = isAlive ? "rgba(255,255,255,0.25)" : "#ef4444";

  return (
    <div style={{
      width: collapsed ? 28 : width,
      minWidth: collapsed ? 28 : width,
      height: "100%",
      display: "flex",
      flexDirection: "column",
      borderLeft: `1px solid ${borderColor}`,
      background: collapsed
        ? "rgba(8,8,14,0.6)"
        : "rgba(8,8,14,0.92)",
      transition: "width 0.2s ease, border-color 0.4s, background 0.4s",
      flexShrink: 0,
      overflow: "hidden",
      position: "relative",
    }}>

      {/* ── Header bar ── */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: collapsed ? "center" : "space-between",
        padding: collapsed ? "8px 0" : "6px 8px",
        borderBottom: `1px solid ${borderColor}`,
        flexShrink: 0,
        gap: 6,
        cursor: "pointer",
        transition: "border-color 0.4s",
      }}
        onClick={() => setCollapsed(c => !c)}
        title={collapsed ? "Expand telemetry" : "Collapse telemetry"}
      >
        {/* Pulse dot */}
        <div style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: isAlive ? "#34d399" : "#ef4444",
          flexShrink: 0,
          boxShadow: isAlive
            ? "0 0 6px rgba(52,211,153,0.8)"
            : "0 0 8px rgba(239,68,68,0.9)",
          animation: isAlive ? "hb-pulse 2s ease-in-out infinite" : "none",
        }} />

        {!collapsed && (
          <>
            <span style={{
              fontSize: 8,
              fontWeight: 800,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: headerColor,
              fontFamily: "'DM Mono', 'Courier New', monospace",
              flex: 1,
              transition: "color 0.4s",
            }}>
              {isAlive ? "Heartbeat" : "NO SIGNAL"}
            </span>
            <span style={{
              fontSize: 8,
              color: "rgba(255,255,255,0.2)",
              cursor: "pointer",
            }}>
              {collapsed ? "▶" : "◀"}
            </span>
          </>
        )}
      </div>

      {/* ── Event log ── */}
      {!collapsed && (
        <div
          ref={scrollRef}
          style={{
            flex: 1,
            overflowY: "auto",
            overflowX: "hidden",
            padding: "4px 0",
            display: "flex",
            flexDirection: "column",
            gap: 0,
          }}
        >
          {events.length === 0 && (
            <div style={{
              padding: "12px 8px",
              fontSize: 9,
              color: "rgba(255,255,255,0.15)",
              fontFamily: "'DM Mono', monospace",
              textAlign: "center",
            }}>
              Waiting for engine…
            </div>
          )}

          {events.map((ev, i) => {
            const colors = LEVEL_COLOR[ev.level] ?? LEVEL_COLOR.green;
            return (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 5,
                  padding: "2px 8px",
                  borderLeft: `2px solid transparent`,
                  transition: "background 0.1s",
                }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.03)";
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLElement).style.background = "transparent";
                }}
              >
                {/* Level dot */}
                <div style={{
                  width: 4,
                  height: 4,
                  borderRadius: "50%",
                  background: colors.dot,
                  flexShrink: 0,
                  marginTop: 3,
                  boxShadow: i === events.length - 1 ? `0 0 5px ${colors.glow}` : "none",
                }} />

                {/* Content */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 8,
                    color: "rgba(255,255,255,0.18)",
                    fontFamily: "'DM Mono', monospace",
                    marginBottom: 1,
                  }}>
                    {ev.timestamp}
                  </div>
                  <div style={{
                    fontSize: 9,
                    color: colors.text,
                    fontFamily: "'DM Mono', monospace",
                    lineHeight: 1.3,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}>
                    {ev.message}
                    {ev.value && (
                      <span style={{ color: "rgba(255,255,255,0.3)", marginLeft: 4 }}>
                        {ev.value}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {/* Dead air warning */}
          {!isAlive && (
            <div style={{
              margin: "6px 8px",
              padding: "6px 8px",
              background: "rgba(239,68,68,0.1)",
              border: "1px solid rgba(239,68,68,0.3)",
              borderRadius: 6,
              fontSize: 9,
              color: "#ef4444",
              fontFamily: "'DM Mono', monospace",
              fontWeight: 700,
              letterSpacing: "0.06em",
              animation: "hb-flash 1s ease-in-out infinite",
            }}>
              ⚠ ENGINE SILENT
            </div>
          )}
        </div>
      )}

      {/* ── Collapsed mini-log ── */}
      {collapsed && (
        <div style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "flex-end",
          paddingBottom: 8,
          gap: 3,
        }}>
          {events.slice(-12).map((ev, i) => {
            const colors = LEVEL_COLOR[ev.level] ?? LEVEL_COLOR.green;
            return (
              <div key={i} style={{
                width: 4,
                height: 4,
                borderRadius: "50%",
                background: colors.dot,
                opacity: 0.3 + (i / 12) * 0.7,
              }} />
            );
          })}
        </div>
      )}

      <style>{`
        @keyframes hb-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(0.8); }
        }
        @keyframes hb-flash {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}
