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
type TrackCounts = Map<string, Map<number, number>>;

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
  const [fullDay, setFullDay]       = useState(true);
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
      // Cover a wide window so future-generated weeks/months show their counts too.
      const nowTs = Math.floor(Date.now() / 1000);
      const result = await (window as any).ether.invoke("schedule:get", nowTs - 7 * 86_400, nowTs + 120 * 86_400);
      if (!result?.data) return;
      const counts: TrackCounts = new Map();
      for (const row of result.data as { scheduled_at: number }[]) {
        // Key by LOCAL date + LOCAL hour so they line up with the grid (which is local).
        const d = new Date(row.scheduled_at * 1000);
        const dayKey  = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        const hourKey = d.getHours();
        if (!counts.has(dayKey)) counts.set(dayKey, new Map());
        const h = counts.get(dayKey)!;
        h.set(hourKey, (h.get(hourKey) || 0) + 1);
      }
      setTrackCounts(counts);
    } catch {}
  };

  const [generating, setGenerating] = useState(false);
  const [genMsg, setGenMsg]         = useState("");
  const [viewMode, setViewMode]     = useState<"week" | "month">("week");

  // Generate the airing log (generated_schedule) for exactly the WEEK or MONTH being viewed,
  // by regenerating each of its days (per-day clear+rebuild — no full wipe).
  const generate = async (scope: "week" | "month") => {
    if (generating) return;
    setGenerating(true);
    const mon = getMondayOfWeek(weekOffset);
    const mid = new Date(mon.getTime() + 3 * 86_400_000);
    let dates: Date[];
    if (scope === "week") {
      dates = Array.from({ length: 7 }, (_, i) => new Date(mon.getTime() + i * 86_400_000));
      setGenMsg("Generating this week…");
    } else {
      const first = new Date(mid.getFullYear(), mid.getMonth(), 1);
      const nDays = new Date(mid.getFullYear(), mid.getMonth() + 1, 0).getDate();
      dates = Array.from({ length: nDays }, (_, i) => new Date(first.getFullYear(), first.getMonth(), 1 + i));
      setGenMsg("Generating this month…");
    }
    try {
      let count = 0;
      for (const d of dates) {
        const ts = Math.floor(new Date(d).setHours(0, 0, 0, 0) / 1000);
        const res = await (window as any).ether.invoke("schedule:generateDay", ts);
        count += (res?.count || 0);
      }
      setGenMsg(`✓ Generated this ${scope} · ${count} items`);
      setShowTracks(true);
      await loadTrackCounts();
      setTimeout(() => setGenMsg(""), 6000);
    } catch (e: any) {
      setGenMsg("✗ " + String(e?.message || e));
    } finally { setGenerating(false); }
  };

  // ── Day view — click a day to open its date and see the airing log hour-by-hour ──
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);
  const [dayRows, setDayRows]         = useState<{ scheduled_at: number; title: string; artist: string; duration_s: number; category_id: number | null; song_id: number | null }[]>([]);
  const [dayLoading, setDayLoading]   = useState(false);
  const [genDayBusy, setGenDayBusy]   = useState(false);
  const [dayShow, setDayShow]         = useState<{ name: string; startHour: number; endHour: number } | null>(null);
  const loadDayRows = async (d: Date) => {
    setDayLoading(true); setDayRows([]);
    try {
      const start = Math.floor(new Date(d).setHours(0, 0, 0, 0) / 1000), end = start + 86_400;
      const res = await (window as any).ether.invoke("schedule:get", start, end);
      setDayRows(Array.isArray(res?.data) ? res.data : []);
    } catch { /* ignore */ } finally { setDayLoading(false); }
  };
  const openDay = async (date: Date, show?: Show) => {
    const d = new Date(date); d.setHours(0, 0, 0, 0);
    setSelectedDay(d);
    setDayShow(show ? { name: show.name, startHour: show.start_hour, endHour: show.end_hour } : null);
    await loadDayRows(d);
  };
  const generateThisDay = async () => {
    if (!selectedDay || genDayBusy) return;
    setGenDayBusy(true);
    try {
      const ts = Math.floor(new Date(selectedDay).setHours(0, 0, 0, 0) / 1000);
      await (window as any).ether.invoke("schedule:generateDay", ts);
      await loadDayRows(selectedDay);   // keep the current show scope
    } catch { /* ignore */ } finally { setGenDayBusy(false); }
  };

  useEffect(() => {
    load();
    loadTrackCounts();
    const refresh = setInterval(() => { load(); loadTrackCounts(); }, 60_000);
    const tick    = setInterval(() => setNow(new Date()), 30_000);
    return () => { clearInterval(refresh); clearInterval(tick); };
  }, []);

  // ── Day view render ──
  if (selectedDay) {
    const dayStart = Math.floor(new Date(selectedDay).setHours(0, 0, 0, 0) / 1000);
    const byHour = new Map<number, typeof dayRows>();
    for (const r of dayRows) {
      const h = Math.floor((r.scheduled_at - dayStart) / 3600);
      if (h < 0 || h > 23) continue;
      if (!byHour.has(h)) byHour.set(h, []);
      byHour.get(h)!.push(r);
    }
    const dateLabel = selectedDay.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    const isToday = sameDay(selectedDay, new Date());
    // When a show was clicked, scope the hours to that show's range; otherwise the whole day.
    const hours = dayShow
      ? Array.from({ length: Math.max(1, (dayShow.endHour === 0 || dayShow.endHour <= dayShow.startHour ? 24 : dayShow.endHour) - dayShow.startHour) }, (_, i) => (dayShow.startHour + i) % 24)
      : Array.from({ length: 24 }, (_, h) => h);
    const total = dayShow ? hours.reduce((n, h) => n + (byHour.get(h)?.length || 0), 0) : dayRows.length;
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--bg-primary)", color: "var(--text-primary)", fontFamily: "var(--font-ui, 'Inter', sans-serif)" }}>
        {/* Day toolbar */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", borderBottom: "1px solid var(--border-primary)", flexShrink: 0, background: "var(--bg-secondary)" }}>
          <button onClick={() => setSelectedDay(null)} style={navBtn}>← Calendar</button>
          <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: "-0.01em" }}>{dateLabel}{isToday ? " · Today" : ""}</span>
          {dayShow && (
            <span style={{ fontSize: 11, fontWeight: 700, color: "var(--accent-green)", display: "flex", alignItems: "center", gap: 6 }}>
              {dayShow.name} ({fmtHour(dayShow.startHour)}–{fmtHour(dayShow.endHour === 0 ? 24 : dayShow.endHour)})
              <button onClick={() => setDayShow(null)} title="Show the full day" style={{ ...navBtn, height: 20, padding: "0 7px", fontSize: 9 }}>full day</button>
            </span>
          )}
          <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>{total} item{total !== 1 ? "s" : ""}{dayShow ? " in show" : " scheduled"}</span>
          <div style={{ flex: 1 }} />
          <button onClick={generateThisDay} disabled={genDayBusy}
            style={{ ...navBtn, color: "#0a160d", background: "var(--accent-green)", border: "none", fontWeight: 800, opacity: genDayBusy ? 0.5 : 1, cursor: genDayBusy ? "default" : "pointer" }}>
            {genDayBusy ? "Generating…" : "Generate"}
          </button>
        </div>
        {/* Hours */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {dayLoading ? (
            <div style={{ padding: 40, textAlign: "center", color: "var(--text-tertiary)", fontSize: 12 }}>Loading…</div>
          ) : hours.map((h) => {
            const items = byHour.get(h) || [];
            return (
              <div key={h} style={{ display: "flex", borderBottom: "1px solid var(--border-secondary)" }}>
                <div style={{ width: 70, flexShrink: 0, padding: "8px 10px", textAlign: "right" as const, borderRight: "1px solid var(--border-primary)", background: "var(--bg-secondary)", fontSize: 11, fontWeight: 700, color: "var(--text-tertiary)" }}>
                  {fmtHour(h)}
                </div>
                <div style={{ flex: 1, minWidth: 0, padding: "4px 0" }}>
                  {items.length === 0 ? (
                    <div style={{ padding: "8px 12px", fontSize: 10, color: "var(--text-tertiary)", fontStyle: "italic" }}>— empty —</div>
                  ) : items.map((it, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 12px" }}>
                      <span style={{ width: 44, flexShrink: 0, fontFamily: "'DM Mono', monospace", fontSize: 9, color: "var(--text-tertiary)" }}>
                        {new Date(it.scheduled_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: it.song_id ? "var(--text-primary)" : "var(--accent-green)" }}>
                        {it.title}{!it.song_id ? "  ·  voice track" : ""}
                      </span>
                      <span style={{ flexShrink: 0, fontSize: 10, color: "var(--text-tertiary)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.artist}</span>
                      <span style={{ flexShrink: 0, width: 40, textAlign: "right" as const, fontFamily: "'DM Mono', monospace", fontSize: 9, color: "var(--text-tertiary)" }}>
                        {Math.floor((it.duration_s || 0) / 60)}:{String((it.duration_s || 0) % 60).padStart(2, "0")}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ── Render helpers ────────────────────────────────────────────────

  const weekEnd = new Date(monday.getTime() + 6 * 86_400_000);
  const weekLabel =
    monday.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
    " – " +
    weekEnd.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  // Month navigation — the viewed week's "owning" month (its Thursday), with ‹ › to step months.
  const weekMid    = new Date(monday.getTime() + 3 * 86_400_000);
  const monthLabel = weekMid.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  // Month-view cells (Monday-aligned, padded to full weeks)
  const monthCells: (Date | null)[] = [];
  if (viewMode === "month") {
    const y = weekMid.getFullYear(), mo = weekMid.getMonth();
    const lead = (new Date(y, mo, 1).getDay() + 6) % 7;
    const dim = new Date(y, mo + 1, 0).getDate();
    for (let i = 0; i < lead; i++) monthCells.push(null);
    for (let d = 1; d <= dim; d++) monthCells.push(new Date(y, mo, d));
    while (monthCells.length % 7 !== 0) monthCells.push(null);
  }
  const goToDate = (target: Date) => {
    const thisMonday = getMondayOfWeek(0);
    const t = new Date(target); const day = t.getDay();
    t.setDate(t.getDate() + (day === 0 ? -6 : 1 - day)); t.setHours(0, 0, 0, 0);
    setWeekOffset(Math.round((t.getTime() - thisMonday.getTime()) / (7 * 86_400_000)));
  };
  const jumpMonth = (delta: number) => goToDate(new Date(weekMid.getFullYear(), weekMid.getMonth() + delta, 1));

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
        {/* Month navigation — clear ‹ Month Year › */}
        <button onClick={() => jumpMonth(-1)} title="Previous month" style={{ ...navBtn, width: 34, height: 30, padding: 0, fontSize: 26, fontWeight: 800, lineHeight: 1 }}>‹</button>
        <span style={{ fontSize: 16, fontWeight: 800, minWidth: 150, textAlign: "center" as const, letterSpacing: "-0.01em" }}>{monthLabel}</span>
        <button onClick={() => jumpMonth(1)} title="Next month" style={{ ...navBtn, width: 34, height: 30, padding: 0, fontSize: 26, fontWeight: 800, lineHeight: 1 }}>›</button>
        <div style={{ width: 1, height: 18, background: "var(--border-primary)", margin: "0 8px" }} />
        {/* Week navigation */}
        <button onClick={() => setWeekOffset(w => w - 1)} title="Previous week" style={{ ...navBtn, fontSize: 13, fontWeight: 800, height: 30 }}><span style={{ fontSize: 20, verticalAlign: "middle" }}>←</span> Wk</button>
        <button
          onClick={() => setWeekOffset(0)}
          style={{
            ...navBtn, fontSize: 13, fontWeight: 800, height: 30,
            color: weekOffset === 0 ? "var(--accent-green)" : "var(--text-secondary)",
            borderColor: weekOffset === 0 ? "var(--accent-green)" : "var(--border-primary)",
          }}
        >Today</button>
        <button onClick={() => setWeekOffset(w => w + 1)} title="Next week" style={{ ...navBtn, fontSize: 13, fontWeight: 800, height: 30 }}>Wk <span style={{ fontSize: 20, verticalAlign: "middle" }}>→</span></button>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 16, fontWeight: 800, color: "var(--text-primary)", letterSpacing: "-0.01em" }}>{weekLabel}</span>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => setShowTracks(t => !t)}
          style={{
            ...navBtn,
            color: showTracks ? "var(--accent-green)" : "var(--text-secondary)",
            borderColor: showTracks ? "var(--accent-green)" : "var(--border-primary)",
          }}
          title="Show generated schedule track counts per hour"
        >{showTracks ? "Hide Tracks" : "Show Tracks"}</button>
        <div style={{ width: 1, height: 18, background: "var(--border-primary)", margin: "0 6px" }} />
        {genMsg && <span style={{ fontSize: 10, fontWeight: 700, color: genMsg.startsWith("✓") ? "#34d399" : genMsg.startsWith("✗") ? "#ef4444" : "var(--text-secondary)" }}>{genMsg}</span>}
        {/* Week / Month scope toggle */}
        <div style={{ display: "flex", border: "1px solid var(--border-primary)", height: 26 }}>
          {(["week", "month"] as const).map(s => (
            <button key={s} onClick={() => setViewMode(s)} disabled={generating}
              style={{ padding: "0 12px", border: "none", cursor: "pointer", fontSize: 11, fontWeight: 800, textTransform: "capitalize" as const,
                background: viewMode === s ? "var(--accent-green)" : "transparent",
                color: viewMode === s ? "#0a160d" : "var(--text-secondary)" }}>{s}</button>
          ))}
        </div>
        <button disabled={generating} onClick={() => generate(viewMode)} title={`Generate the viewed ${viewMode}`}
          style={{ ...navBtn, color: "#0a160d", background: "var(--accent-green)", border: "none", fontWeight: 800, opacity: generating ? 0.5 : 1, cursor: generating ? "default" : "pointer" }}>
          {generating ? "Generating…" : "Generate"}
        </button>
      </div>

      {/* ── Calendar grid ── */}
      {viewMode === "month" ? (
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden", padding: 12, background: "var(--bg-primary)", display: "flex", flexDirection: "column" as const }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, marginBottom: 4, flexShrink: 0 }}>
            {DAY_LABELS.map(d => <div key={d} style={{ textAlign: "center" as const, fontSize: 12, fontWeight: 800, color: "var(--text-secondary)", letterSpacing: "0.1em" }}>{d}</div>)}
          </div>
          <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gridAutoRows: "1fr", gap: 4 }}>
            {monthCells.map((cell, i) => {
              if (!cell) return <div key={i} style={{ background: "var(--bg-secondary)", opacity: 0.25 }} />;
              const jsDay = cell.getDay();
              const cellShows = shows.filter(s => s.days.includes(String(jsDay)));
              const dk = `${cell.getFullYear()}-${cell.getMonth()}-${cell.getDate()}`;
              const cellCount = showTracks ? Array.from(trackCounts.get(dk)?.values() || []).reduce((a, b) => a + b, 0) : 0;
              const cellToday = sameDay(cell, now);
              return (
                <div key={i} onClick={() => openDay(cell)} style={{ background: "var(--bg-secondary)", border: `1px solid ${cellToday ? "var(--accent-green)" : "var(--border-primary)"}`, padding: 5, cursor: "pointer", display: "flex", flexDirection: "column" as const, gap: 2, overflow: "hidden" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 15, fontWeight: 800, color: cellToday ? "var(--accent-green)" : "var(--text-primary)" }}>{cell.getDate()}</span>
                    {cellCount > 0 && <span style={{ fontSize: 9, fontWeight: 700, color: "#34d399" }}>{cellCount}</span>}
                  </div>
                  {cellShows.map(s => (
                    <div key={s.id} onClick={(e) => { e.stopPropagation(); openDay(cell, s); }} title={s.name}
                      style={{ flex: 1, minHeight: 14, display: "flex", alignItems: "center", fontSize: 9, fontWeight: 700, color: "#fff", background: (s.color || "#3b82f6") + "cc", borderLeft: `2px solid ${s.color || "#3b82f6"}`, padding: "0 5px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, cursor: "pointer" }}>{s.name}</div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
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
              <div key={colIdx} onClick={() => openDay(colDate)} style={{ flex: 1, minWidth: 76, borderLeft: "1px solid var(--border-primary)", position: "relative", cursor: "pointer" }}>

                {/* Day header — click to open the day */}
                <div
                  onClick={() => openDay(colDate)}
                  title={`Open ${colDate.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}`}
                  style={{
                  height: 40, display: "flex", flexDirection: "column",
                  alignItems: "center", justifyContent: "center", gap: 1,
                  borderBottom: "1px solid var(--border-primary)",
                  background: isToday ? "rgb(from var(--accent-green) r g b / 0.07)" : "var(--bg-secondary)",
                  position: "sticky", top: 0, zIndex: 2, cursor: "pointer",
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = "rgb(from var(--accent-green) r g b / 0.14)"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = isToday ? "rgb(from var(--accent-green) r g b / 0.07)" : "var(--bg-secondary)"; }}
                >
                  <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.12em", color: isToday ? "var(--accent-green)" : "var(--text-secondary)" }}>
                    {label}
                  </span>
                  <span style={{ fontSize: 19, fontWeight: 800, color: isToday ? "var(--accent-green)" : "var(--text-primary)", lineHeight: 1, letterSpacing: "-0.01em" }}>
                    {colDate.getDate()}
                  </span>
                </div>

                {/* Hour-row backgrounds */}
                <div style={{ position: "relative", height: totalPx }}>
                  {HOURS.map(h => {
                    const dayKey    = `${colDate.getFullYear()}-${colDate.getMonth()}-${colDate.getDate()}`;
                    const count     = showTracks ? (trackCounts.get(dayKey)?.get(h) ?? 0) : 0;
                    return (
                    <div key={h} style={{
                      height: ROW_H, borderBottom: "1px solid var(--border-secondary)",
                      boxSizing: "border-box", position: "relative",
                      background: isToday
                        ? (h % 2 === 0 ? "rgb(from var(--accent-green) r g b / 0.02)" : "rgb(from var(--accent-green) r g b / 0.01)")
                        : (h % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)"),
                    }}>
                      {count > 0 && (
                        <span style={{
                          position: "absolute", bottom: 2, right: 3,
                          fontSize: 8, fontWeight: 700, lineHeight: 1,
                          color: "#34d399",
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
                    const clampDur = Math.min(topH + durH, VISIBLE_H) - clampTop; // clip BOTH top & bottom
                    const blockH   = Math.max(16, clampDur * ROW_H - 2);
                    const color    = show.color || "#3b82f6";

                    return (
                      <div
                        key={show.id}
                        title={`${show.name}\n${fmtHour(start)} – ${fmtHour(end >= 24 ? 0 : end)}${show.clock_name ? `\nClock: ${show.clock_name}` : ""}`}
                        onClick={(e) => { e.stopPropagation(); openDay(colDate, show); }}
                        style={{
                          position: "absolute",
                          top: clampTop * ROW_H + 1,
                          left: 2, right: 2,
                          height: blockH,
                          background: color + "cc",   // 80% opacity via hex alpha
                          borderLeft: `3px solid ${color}`,
                          cursor: "pointer",
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
      )}
    </div>
  );
}
