// BroadcastCalendar.tsx — weekly grid view of station shows & dayparts
// Columns: Mon–Sun  |  Rows: hours (5 AM–midnight default, toggle for full 24h)
// Shows are queried from the DB and rendered as colored blocks.
// Clicking a block calls onShowClick(showId) — App.tsx navigates to the Scheduler.

import { useState, useEffect, useRef } from "react";
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
  const [nowPlaying, setNowPlaying] = useState<{ title: string; artist: string; scheduledAt?: number }>({ title: "", artist: "" });
  const [trackCounts, setTrackCounts] = useState<TrackCounts>(new Map());
  const [scheduleByDay, setScheduleByDay] = useState<Map<string, { scheduled_at: number; title: string; artist: string; song_id: number | null }[]>>(new Map());
  const [showTracks, setShowTracks] = useState(false);
  const [viewMode]                  = useState<"week" | "month">("week"); // month removed (unnecessary); week only

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

  // Load the viewed range's schedule once: per-hour counts AND the songs grouped by local day
  // (so the week-view blocks can list their songs). Keyed local so it lines up with the grid.
  const loadTrackCounts = async () => {
    try {
      const mon = getMondayOfWeek(weekOffset);
      let startMs: number, endMs: number;
      if (viewMode === "month") {
        const mid = new Date(mon.getTime() + 3 * 86_400_000);
        startMs = new Date(mid.getFullYear(), mid.getMonth(), 1).getTime() - 7 * 86_400_000;
        endMs   = new Date(mid.getFullYear(), mid.getMonth() + 1, 1).getTime() + 7 * 86_400_000;
      } else {
        startMs = mon.getTime();
        endMs   = mon.getTime() + 7 * 86_400_000;
      }
      const result = await (window as any).ether.invoke("schedule:get", Math.floor(startMs / 1000), Math.floor(endMs / 1000), stationId);
      if (!result?.data) return;
      const counts: TrackCounts = new Map();
      const byDay = new Map<string, { scheduled_at: number; title: string; artist: string; song_id: number | null }[]>();
      for (const row of result.data as { scheduled_at: number; title: string; artist: string; song_id: number | null }[]) {
        const d = new Date(row.scheduled_at * 1000);
        const dayKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        if (!counts.has(dayKey)) counts.set(dayKey, new Map());
        const hm = counts.get(dayKey)!; hm.set(d.getHours(), (hm.get(d.getHours()) || 0) + 1);
        if (!byDay.has(dayKey)) byDay.set(dayKey, []);
        byDay.get(dayKey)!.push(row);
      }
      setTrackCounts(counts);
      setScheduleByDay(byDay);
    } catch {}
  };

  const [generating, setGenerating] = useState(false);
  const [genMsg, setGenMsg]         = useState("");
  // Progress meter + cancel for a week generate (2026-07-27): the per-day loop reports done/total so the
  // user SEES it working instead of a frozen window. Cancel is checked between days.
  const [genProgress, setGenProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const genCancelRef = useRef(false);
  // Generate diagnostics now flow to the movable Scheduler Health panel (Tools) via the
  // "ether:gen-report" event — structured, actionable, non-blocking (no locked modal).

  // Generate the airing log (generated_schedule) for the viewed WEEK, one day at a time (per-day
  // clear+rebuild — no full wipe). Metered: reports done/total between days so the window shows progress
  // instead of appearing frozen, and Cancel stops it cleanly. A manual run is capped at one week (a month
  // is unnecessary; recurring coverage comes from the weekly auto-schedule).
  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const generate = async () => {
    if (generating) return;
    setGenerating(true); genCancelRef.current = false;
    const mon = getMondayOfWeek(weekOffset);
    const dates = Array.from({ length: 7 }, (_, i) => new Date(mon.getTime() + i * 86_400_000));
    setGenProgress({ done: 0, total: dates.length, label: "Starting…" });
    try {
      let count = 0;
      let station = "";
      const days: any[] = [];
      let canceled = false;
      for (let i = 0; i < dates.length; i++) {
        if (genCancelRef.current) { canceled = true; break; }
        const d = dates[i];
        setGenProgress({ done: i, total: dates.length, label: `${DAY_NAMES[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}` });
        // Yield to the event loop so the meter paints before the (blocking) day generate.
        await new Promise(r => setTimeout(r, 0));
        const ts = Math.floor(new Date(d).setHours(0, 0, 0, 0) / 1000);
        const res = await (window as any).ether.invoke("schedule:generateDay", ts);
        count += (res?.count || 0);
        if (res?.station) station = res.station;
        const g = res?.gaps || {};
        const relaxed = res?.relaxed || [];
        if (g.noShow?.length || g.noClock?.length || g.emptyCats?.length || g.emptyClocks?.length || relaxed.length) {
          days.push({ date: res.date, dateTs: res.dateTs, noShow: g.noShow || [], noClock: g.noClock || [], emptyCats: g.emptyCats || [], emptyClocks: g.emptyClocks || [], relaxed });
        }
        setGenProgress({ done: i + 1, total: dates.length, label: `${DAY_NAMES[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}` });
      }
      setShowTracks(true);
      await loadTrackCounts();
      // Resync the live queue to the freshly-generated schedule (from now).
      window.dispatchEvent(new CustomEvent("ether:schedule-regenerated"));
      // Feed the movable Scheduler Health panel with the STRUCTURED diagnostics (named gaps + relaxed).
      window.dispatchEvent(new CustomEvent("ether:gen-report", { detail: { station, count, days } }));
      if (canceled) {
        setGenMsg(`Canceled · ${count} items generated so far`);
        setTimeout(() => setGenMsg(""), 6000);
      } else if (days.length || count === 0) {
        window.dispatchEvent(new Event("ether:open-scheduler-health")); // surface it, don't lock the screen
        setGenMsg(count === 0 ? "Generated nothing — see Scheduler Health (Tools)" : `Generated ${count} · gaps/relaxed → Scheduler Health`);
        setTimeout(() => setGenMsg(""), 9000);
      } else {
        setGenMsg(`✓ Generated this week · ${count} items · clean`);
        setTimeout(() => setGenMsg(""), 6000);
      }
    } catch (e: any) {
      setGenMsg("Generation failed: " + String(e?.message || e));
      setTimeout(() => setGenMsg(""), 9000);
    } finally { setGenerating(false); setGenProgress(null); }
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
      const res = await (window as any).ether.invoke("schedule:get", start, end, stationId);
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
      window.dispatchEvent(new CustomEvent("ether:schedule-regenerated"));
    } catch { /* ignore */ } finally { setGenDayBusy(false); }
  };

  useEffect(() => {
    const tick = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(tick);
  }, []);

  // Shows drive each day-cell's label + color and are per-station, so they MUST follow a station
  // switch — without this they stayed frozen on whichever station was active when the calendar first
  // mounted (the "every day says Magical Forest in green" bug). Songs already reload via the
  // stationId-keyed effect below; this keeps the labels/colors in sync the same way.
  useEffect(() => { load(); }, [stationId]);

  // An open day view is per-station too — reload its hour-by-hour rows when the station changes.
  useEffect(() => { if (selectedDay) loadDayRows(selectedDay); }, [stationId]);

  // Track what the engine is ACTUALLY playing so the day view highlights the real on-air
  // song, not just the clock-scheduled position (broadcast from App as ether:now-playing).
  useEffect(() => {
    const h = (e: any) => setNowPlaying({ title: e.detail?.title || "", artist: e.detail?.artist || "", scheduledAt: typeof e.detail?.scheduledAt === "number" ? e.detail.scheduledAt : undefined });
    window.addEventListener("ether:now-playing", h);
    return () => window.removeEventListener("ether:now-playing", h);
  }, []);

  // Reload the schedule (counts + songs) whenever the viewed range changes, plus a slow refresh.
  useEffect(() => {
    loadTrackCounts();
    const refresh = setInterval(() => loadTrackCounts(), 60_000);
    return () => clearInterval(refresh);
  }, [weekOffset, viewMode, stationId]);   // re-query on station switch (matches the [stationId] reactive pattern)

  // Scheduler Health panel → click a gap → jump the calendar to that day.
  useEffect(() => {
    const h = (e: any) => { const ts = e?.detail?.dateTs; if (ts) openDay(new Date(ts * 1000)); };
    window.addEventListener("ether:calendar-open-day", h);
    return () => window.removeEventListener("ether:calendar-open-day", h);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
    // Current song (today only): prefer the row the ENGINE is actually playing — match by
    // title, choosing the occurrence nearest the wall clock if a song repeats. Falls back to
    // the clock-scheduled position when nothing matches (engine idle / off-schedule track).
    const nowSec = Math.floor(now.getTime() / 1000);
    let currentAt = -1;
    if (isToday) {
      // IRON-CLAD: the engine reports the EXACT generated_schedule row it loaded (its scheduled_at).
      // Highlight that precise row — the same identity the queue plays from. No text, no clock.
      if (typeof nowPlaying.scheduledAt === "number" && dayRows.some(r => r.scheduled_at === nowPlaying.scheduledAt)) {
        currentAt = nowPlaying.scheduledAt;
      } else {
        // Only when the engine hasn't reported an identity yet (idle / just-loaded): clock position.
        for (const r of dayRows) { if (r.scheduled_at <= nowSec) currentAt = r.scheduled_at; else break; }
      }
    }
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
                  ) : items.map((it, i) => {
                    const isNow = isToday && it.scheduled_at === currentAt;
                    const isSpot = !it.song_id;   // a spot (commercial/promo) — no song_id. Gold/amber class color.
                    return (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 12px", background: isNow ? "rgb(from var(--accent-green) r g b / 0.16)" : isSpot ? "rgba(251,191,36,0.08)" : "transparent", borderLeft: `3px solid ${isNow ? "var(--accent-green)" : isSpot ? "#fbbf24" : "transparent"}` }}>
                      <span style={{ width: 44, flexShrink: 0, fontFamily: "'DM Mono', monospace", fontSize: 9, color: isNow ? "var(--accent-green)" : "var(--text-tertiary)" }}>
                        {new Date(it.scheduled_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: isNow ? 800 : 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: isNow ? "var(--accent-green)" : isSpot ? "#fbbf24" : "var(--text-primary)" }}>
                        {isNow ? "▶ " : ""}
                        {isSpot && <span style={{ marginRight: 6, padding: "1px 5px", fontSize: 9, fontWeight: 800, fontFamily: "'DM Mono', monospace", color: "#fbbf24", background: "rgba(251,191,36,0.14)", border: "1px solid rgba(251,191,36,0.45)", letterSpacing: "0.06em" }}>SPOT</span>}
                        {it.title}
                      </span>
                      <span style={{ flexShrink: 0, fontSize: 10, color: "var(--text-tertiary)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.artist}</span>
                      <span style={{ flexShrink: 0, width: 40, textAlign: "right" as const, fontFamily: "'DM Mono', monospace", fontSize: 9, color: "var(--text-tertiary)" }}>
                        {Math.floor((it.duration_s || 0) / 60)}:{String((it.duration_s || 0) % 60).padStart(2, "0")}
                      </span>
                    </div>
                    );
                  })}
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
  const jumpMonth = (delta: number) => goToDate(new Date(weekMid.getFullYear(), weekMid.getMonth() + delta, 15));

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
        {/* Generate meter — "tech-scene" green terminal progress (glowing left→right fill, monospace,
            percentage) so the user plainly SEES it working instead of a frozen window. Cancelable (ABORT). */}
        {generating && genProgress && (() => {
          const pct = Math.round(100 * genProgress.done / Math.max(1, genProgress.total));
          const G = "#2bff88";
          return (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 10px", height: 26,
              background: "#050a06", border: `1px solid ${G}`,
              boxShadow: "0 0 10px rgba(43,255,136,0.35), inset 0 0 8px rgba(43,255,136,0.12)",
              fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}>
              <span style={{ fontSize: 10, fontWeight: 800, color: G, letterSpacing: "0.12em", textShadow: `0 0 6px ${G}` }}>▮ GENERATING</span>
              <div style={{ position: "relative", width: 150, height: 10, background: "#0a1a0e", border: "1px solid rgba(43,255,136,0.4)", overflow: "hidden" }}>
                <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${pct}%`, background: G,
                  boxShadow: `0 0 8px ${G}, 0 0 14px ${G}`, transition: "width 0.25s ease" }} />
                {/* LED-segment overlay for the tech look */}
                <div style={{ position: "absolute", inset: 0, background: "repeating-linear-gradient(90deg, transparent 0 6px, rgba(0,0,0,0.28) 6px 8px)", pointerEvents: "none" }} />
              </div>
              <span style={{ fontSize: 11, fontWeight: 800, color: G, textShadow: `0 0 6px ${G}`, minWidth: 34, textAlign: "right" }}>{pct}%</span>
              <span style={{ fontSize: 9, fontWeight: 700, color: "rgba(43,255,136,0.75)", letterSpacing: "0.06em", whiteSpace: "nowrap" }}>{genProgress.done}/{genProgress.total} · {genProgress.label}</span>
              <button onClick={() => { genCancelRef.current = true; }}
                style={{ background: "transparent", border: "1px solid #ff5555", color: "#ff5555", fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 9, fontWeight: 800, letterSpacing: "0.1em", padding: "2px 8px", cursor: "pointer" }}>ABORT</button>
            </div>
          );
        })()}
        <button disabled={generating} onClick={() => generate()} title="Generate the viewed week (one week at a time)"
          style={{ ...navBtn, color: "#0a160d", background: "var(--accent-green)", border: "none", fontWeight: 800, opacity: generating ? 0.5 : 1, cursor: generating ? "default" : "pointer" }}>
          {generating ? "Generating…" : "Generate week"}
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
              const cellToday = sameDay(cell, now);
              return (
                <div key={i} onClick={() => openDay(cell)} style={{ background: "var(--bg-secondary)", border: `1px solid ${cellToday ? "var(--accent-green)" : "var(--border-primary)"}`, padding: 5, cursor: "pointer", display: "flex", flexDirection: "column" as const, gap: 2, overflow: "hidden" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 15, fontWeight: 800, color: cellToday ? "var(--accent-green)" : "var(--text-primary)" }}>{cell.getDate()}</span>
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
                    const blockSongs = showTracks
                      ? (scheduleByDay.get(`${colDate.getFullYear()}-${colDate.getMonth()}-${colDate.getDate()}`) || [])
                          .filter(r => { const hr = new Date(r.scheduled_at * 1000).getHours(); const e2 = end >= 24 ? 24 : end; return hr >= start && hr < e2; })
                      : [];

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
                        <div style={{ fontSize: 13, fontWeight: 800, color: "#fff", lineHeight: 1.2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", letterSpacing: "0.01em" }}>
                          {show.name}
                        </div>
                        {showTracks && blockSongs.length > 0 && clampDur >= 1 && (
                          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", marginTop: 3 }}>
                            {blockSongs.map((s, i) => (
                              <div key={i} style={{ fontSize: 8, color: "rgba(255,255,255,0.92)", lineHeight: 1.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                <span style={{ opacity: 0.6, fontFamily: "'DM Mono', monospace" }}>{new Date(s.scheduled_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span> {s.title}
                              </div>
                            ))}
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
