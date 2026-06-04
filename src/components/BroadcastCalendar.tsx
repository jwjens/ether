// BroadcastCalendar.tsx — weekly grid view of station shows & dayparts
// Columns: Mon–Sun  |  Rows: hours (5 AM–midnight default, toggle for full 24h)
// Shows are queried from the DB and rendered as colored blocks.
// Clicking a block calls onShowClick(showId) — App.tsx navigates to the Scheduler.

import { useState, useEffect } from "react";
import { queryScoped } from "../db/stationScoped";
import { useActiveStation } from "../hooks/useActiveStation";

// ── Types ──────────────────────────────────────────────────────────────

interface Show {
  id: number;
  name: string;
  start_hour: number;
  end_hour: number;
  days: string;          // e.g. "1234" or "0123456" — JS day nums (0=Sun)
  color: string | null;
  clock_name: string | null;
}

// unix_day (Math.floor(scheduled_at / 86400)) → hour → track count
type TrackCounts = Map<number, Map<number, number>>;

// ── Constants ─────────────────────────────────────────────────────────

const ROW_H = 48;         // px per hour row
const DAY_LABELS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

// Column index 0=Mon…5=Sat, 6=Sun  →  JS day-of-week number
const COL_TO_DAY = [1, 2, 3, 4, 5, 6, 0];

const navBtn: React.CSSProperties = {
  height: 26, padding: "0 10px", fontSize: 10, fontWeight: 700,
  background: "transparent", border: "1px solid var(--border-primary)",
  color: "var(--text-secondary)", cursor: "pointer", borderRadius: 0,
  letterSpacing: "0.04em",
};

// ── Helpers ───────────────────────────────────────────────────────────

function fmtHour(h: number): string {
  const h24 = h % 24;
  if (h24 === 0)  return "12 AM";
  if (h24 === 12) return "12 PM";
  return h24 < 12 ? `${h24} AM` : `${h24 - 12} PM`;
}

/** Returns midnight (00:00) of the Monday of the week `offset` weeks from now. */
function getMondayOfWeek(offset: number): Date {
  const now = new Date();
  const day = now.getDay(); // 0=Sun
  const daysToMonday = day === 0 ? -6 : 1 - day;
  const m = new Date(now);
  m.setDate(now.getDate() + daysToMonday + offset * 7);
  m.setHours(0, 0, 0, 0);
  return m;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

// ── Component ─────────────────────────────────────────────────────────

interface BroadcastCalendarProps {
  /** Called when a show block is clicked — navigate to the show editor */
  onShowClick?: (showId: number) => void;
}

export default function BroadcastCalendar({ onShowClick }: BroadcastCalendarProps) {
  const { stationId } = useActiveStation();
  const [shows, setShows]           = useState<Show[]>([]);
  const [weekOffset, setWeekOffset] = useState(0);
  const [fullDay, setFullDay]       = useState(false);
  const [now, setNow]               = useState(new Date());
  const [trackCounts, setTrackCounts] = useState<TrackCounts>(new Map());
  const [showTracks, setShowTracks] = useState(false);

  const MIN_HOUR    = fullDay ? 0 : 5;
  const MAX_HOUR    = 24;
  const VISIBLE_H   = MAX_HOUR - MIN_HOUR;
  const HOURS       = Array.from({ length: VISIBLE_H }, (_, i) => i + MIN_HOUR);
  const monday      = getMondayOfWeek(weekOffset);
  const totalPx     = VISIBLE_H * ROW_H;

  // Current-time indicator: px from top of visible area (negative = above fold)
  const nowLinePx = (now.getHours() + now.getMinutes() / 60 - MIN_HOUR) * ROW_H;

  const load = async () => {
    try {
      // station_id scoping: manual JOIN — shows.station_id filters scope; clocks joined by FK
      const rows = await queryScoped<Show>(
        `SELECT s.id, s.name, s.start_hour, s.end_hour, s.days, s.color,
                c.name AS clock_name
         FROM shows s
         LEFT JOIN clocks c ON c.id = s.clock_id
         WHERE s.is_active = 1 AND s.station_id = ?
         ORDER BY s.start_hour`,
        [stationId], stationId, { skipScoping: true }
      );
      setShows(rows);
    } catch { /* ignore — DB may not be ready yet on first render */ }
  };

  const loadTrackCounts = async () => {
    try {
      const nowTs = Math.floor(Date.now() / 1000);
      const result = await (window as any).ether.invoke("schedule:get", nowTs - 86_400, nowTs + 14 * 86_400);
      if (!result?.data) return;
      const counts: TrackCounts = new Map();
      for (const row of result.data as { scheduled_at: number }[]) {
        const dayKey  = Math.floor(row.scheduled_at / 86_400);
        const hourKey = Math.floor((row.scheduled_at % 86_400) / 3_600);
        if (!counts.has(dayKey)) counts.set(dayKey, new Map());
        const h = counts.get(dayKey)!;
        h.set(hourKey, (h.get(hourKey) || 0) + 1);
      }
      setTrackCounts(counts);
    } catch {}
  };

  useEffect(() => {
    load();
    loadTrackCounts();
    const refresh = setInterval(() => { load(); loadTrackCounts(); }, 60_000);
    const tick    = setInterval(() => setNow(new Date()), 30_000);
    return () => { clearInterval(refresh); clearInterval(tick); };
  }, []);

  // ── Render helpers ────────────────────────────────────────────────

  const weekEnd = new Date(monday.getTime() + 6 * 86_400_000);
  const weekLabel =
    monday.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
    " – " +
    weekEnd.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  return (
    <div style={{
      height: "100%", display: "flex", flexDirection: "column",
      background: "var(--bg-primary)", color: "var(--text-primary)",
      fontFamily: "var(--font-ui, 'Inter', sans-serif)",
    }}>

      {/* ── Toolbar ── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 6, padding: "8px 14px",
        borderBottom: "1px solid var(--border-primary)", flexShrink: 0,
        background: "var(--bg-secondary)",
      }}>
        <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: "-0.01em", marginRight: 4 }}>
          Broadcast Calendar
        </span>
        <button onClick={() => setWeekOffset(w => w - 1)} style={navBtn}>← Prev</button>
        <button
          onClick={() => setWeekOffset(0)}
          style={{
            ...navBtn,
            color: weekOffset === 0 ? "var(--accent-cyan)" : "var(--text-secondary)",
            borderColor: weekOffset === 0 ? "var(--accent-cyan)" : "var(--border-primary)",
          }}
        >This Week</button>
        <button onClick={() => setWeekOffset(w => w + 1)} style={navBtn}>Next →</button>
        <span style={{ fontSize: 10, color: "var(--text-tertiary)", marginLeft: 2 }}>{weekLabel}</span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>{shows.length} show{shows.length !== 1 ? "s" : ""}</span>
        <button
          onClick={() => setShowTracks(t => !t)}
          style={{
            ...navBtn,
            color: showTracks ? "var(--accent-cyan)" : "var(--text-secondary)",
            borderColor: showTracks ? "var(--accent-cyan)" : "var(--border-primary)",
          }}
          title="Show generated schedule track counts per hour"
        >{showTracks ? "Hide Tracks" : "Show Tracks"}</button>
        <button
          onClick={() => setFullDay(f => !f)}
          style={{
            ...navBtn,
            color: fullDay ? "var(--accent-cyan)" : "var(--text-secondary)",
            borderColor: fullDay ? "var(--accent-cyan)" : "var(--border-primary)",
          }}
        >{fullDay ? "Daytime (5 AM–Midnight)" : "Full 24h"}</button>
        <button onClick={() => { load(); loadTrackCounts(); }} style={navBtn} title="Refresh">↻</button>
      </div>

      {/* ── Calendar grid ── */}
      <div style={{ flex: 1, overflowY: "auto", overflowX: "auto" }}>
        <div style={{ display: "flex", minWidth: 620 }}>

          {/* Hour-label column */}
          <div style={{ width: 50, flexShrink: 0, position: "sticky", left: 0, zIndex: 3, background: "var(--bg-primary)" }}>
            {/* Spacer aligns with day-header row */}
            <div style={{ height: 40, borderBottom: "1px solid var(--border-primary)", borderRight: "1px solid var(--border-primary)", background: "var(--bg-secondary)" }} />
            {HOURS.map(h => (
              <div key={h} style={{
                height: ROW_H, borderBottom: "1px solid var(--border-secondary)",
                borderRight: "1px solid var(--border-primary)",
                display: "flex", alignItems: "flex-start", justifyContent: "flex-end",
                paddingRight: 6, paddingTop: 3, boxSizing: "border-box",
              }}>
                <span style={{ fontSize: 9, fontWeight: 600, color: "var(--text-tertiary)", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>
                  {fmtHour(h)}
                </span>
              </div>
            ))}
          </div>

          {/* Day columns */}
          {DAY_LABELS.map((label, colIdx) => {
            const colDate  = new Date(monday.getTime() + colIdx * 86_400_000);
            const isToday  = sameDay(colDate, now);
            const jsDay    = COL_TO_DAY[colIdx];
            const colShows = shows.filter(s => s.days.includes(String(jsDay)));

            return (
              <div key={colIdx} style={{ flex: 1, minWidth: 76, borderLeft: "1px solid var(--border-primary)", position: "relative" }}>

                {/* Day header */}
                <div style={{
                  height: 40, display: "flex", flexDirection: "column",
                  alignItems: "center", justifyContent: "center", gap: 1,
                  borderBottom: "1px solid var(--border-primary)",
                  background: isToday ? "rgba(136,104,216,0.07)" : "var(--bg-secondary)",
                  position: "sticky", top: 0, zIndex: 2,
                }}>
                  <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: "0.1em", color: isToday ? "var(--accent-cyan)" : "var(--text-tertiary)" }}>
                    {label}
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: isToday ? "var(--accent-cyan)" : "var(--text-secondary)", lineHeight: 1 }}>
                    {colDate.getDate()}
                  </span>
                </div>

                {/* Hour-row backgrounds */}
                <div style={{ position: "relative", height: totalPx }}>
                  {HOURS.map(h => {
                    const dayKey    = Math.floor(colDate.getTime() / 86_400_000);
                    const count     = showTracks ? (trackCounts.get(dayKey)?.get(h) ?? 0) : 0;
                    return (
                    <div key={h} style={{
                      height: ROW_H, borderBottom: "1px solid var(--border-secondary)",
                      boxSizing: "border-box", position: "relative",
                      background: isToday
                        ? (h % 2 === 0 ? "rgba(136,104,216,0.02)" : "rgba(136,104,216,0.01)")
                        : (h % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)"),
                    }}>
                      {count > 0 && (
                        <span style={{
                          position: "absolute", bottom: 2, right: 3,
                          fontSize: 8, fontWeight: 700, lineHeight: 1,
                          color: "rgba(139,92,246,0.8)",
                          pointerEvents: "none",
                        }}>{count}</span>
                      )}
                    </div>
                    );
                  })}

                  {/* Show blocks */}
                  {colShows.map(show => {
                    const start = show.start_hour;
                    // end_hour=0 means midnight; handle overnight
                    const end = show.end_hour === 0
                      ? 24
                      : show.end_hour <= show.start_hour
                        ? show.end_hour + 24
                        : show.end_hour;
                    const durH   = end - start;
                    const topH   = start - MIN_HOUR;

                    // Skip if entirely outside visible range
                    if (topH + durH <= 0 || topH >= VISIBLE_H) return null;

                    const clampTop = Math.max(0, topH);
                    const clampDur = Math.min(durH, VISIBLE_H - clampTop);
                    const blockH   = Math.max(16, clampDur * ROW_H - 2);
                    const color    = show.color || "#3b82f6";

                    return (
                      <div
                        key={show.id}
                        title={`${show.name}\n${fmtHour(start)} – ${fmtHour(end >= 24 ? 0 : end)}${show.clock_name ? `\nClock: ${show.clock_name}` : ""}`}
                        onClick={() => onShowClick?.(show.id)}
                        style={{
                          position: "absolute",
                          top: clampTop * ROW_H + 1,
                          left: 2, right: 2,
                          height: blockH,
                          background: color + "cc",   // 80% opacity via hex alpha
                          borderLeft: `3px solid ${color}`,
                          cursor: onShowClick ? "pointer" : "default",
                          overflow: "hidden",
                          padding: "3px 5px",
                          boxSizing: "border-box",
                          display: "flex",
                          flexDirection: "column",
                          justifyContent: "flex-start",
                          gap: 1,
                          transition: "filter 0.1s",
                        }}
                        onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.filter = "brightness(1.25)"; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.filter = ""; }}
                      >
                        <div style={{ fontSize: 9, fontWeight: 800, color: "#fff", lineHeight: 1.3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", letterSpacing: "0.02em" }}>
                          {show.name}
                        </div>
                        {clampDur >= 1.5 && (
                          <div style={{ fontSize: 8, color: "rgba(255,255,255,0.75)", lineHeight: 1.2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {fmtHour(start)}–{fmtHour(end >= 24 ? 0 : end)}
                            {show.clock_name ? ` · ${show.clock_name}` : ""}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* Current-time indicator — only on today's column */}
                  {isToday && nowLinePx >= 0 && nowLinePx <= totalPx && (
                    <div style={{
                      position: "absolute", top: nowLinePx, left: 0, right: 0,
                      height: 2, background: "#ef4444", zIndex: 10, pointerEvents: "none",
                    }}>
                      <div style={{
                        position: "absolute", left: -1, top: -3,
                        width: 8, height: 8, borderRadius: "50%", background: "#ef4444",
                      }} />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
