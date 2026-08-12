// CANONICAL NAME: this feature is "Calendar" everywhere a person looks — the hamburger label, the
// popout menu, the panel key (`calendar`), the help entries and the design docs. The FILE keeps the
// name BroadcastCalendar.tsx deliberately: renaming it would touch 14 files and leave 11 historical
// design docs citing a path that no longer exists, for a change no user can see. Component names are
// allowed to be more specific than menu labels. Ruled 2026-08-11; do not "fix" this.
// BroadcastCalendar.tsx — weekly grid view of station shows & dayparts
// Columns: Mon–Sun  |  Rows: hours (5 AM–midnight default, toggle for full 24h)
// Shows are queried from the DB and rendered as colored blocks.
// Clicking a block calls onShowClick(showId) — App.tsx navigates to the Scheduler.

import { useState, useEffect, useRef } from "react";
import { queryScoped } from "../db/stationScoped";
import { DataGrid } from "./grid/DataGrid";
import type { GridColumn } from "./grid/csv";
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


// Row type → label + a MUTED bar colour. Desaturated on purpose: these sit on every row of a dense
// table, and saturated blocks would turn the log into a colour chart rather than something to read.
// content_class is authoritative when present (v29/v31); the song_id heuristic is the fallback for
// rows written before it, so an old log still classifies rather than showing everything as one type.
function typeOf(r: { content_class?: string | null; channel?: string | null; song_id: number | null }):
  { label: string; color: string } {
  const cc = String(r.content_class || "").toUpperCase();
  if (cc === "JIN") return { label: "Jingle", color: "#6f8fae" };
  if (cc === "SWP") return { label: "Sweeper", color: "#7d8fa8" };
  if (cc === "SPOT") return { label: "Spot", color: "#b39445" };
  if (cc === "CART") return { label: "Cart", color: "#8f7fae" };
  if (cc === "VOICE" || cc === "VT") return { label: "Voice", color: "#a3785f" };
  if (cc === "MUSIC") return { label: "Song", color: "#5f8f75" };
  return r.song_id ? { label: "Song", color: "#5f8f75" } : { label: "Spot", color: "#b39445" };
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
         WHERE s.is_active = 1 AND s.station_id = ? AND s.deleted_at IS NULL
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
  // Progress is NOT held here any more (2026-08-06). It lived in this component, and this component
  // renders the ~1000-row day list — so every one of the 168 hourly ticks in a week generate forced the
  // whole list to re-render. Progress now lives in <GenerateProgressBar/>, mounted at App top-level, so
  // a tick can never touch this list and the bar survives navigating away mid-run.
  // docs/generate-freeze-and-calendar-history-2026-08-06.md
  const genCancelRef = useRef(false);
  // Explain-before-you-wait dialog. A week generate is minutes of work; without this the operator gets a
  // long quiet stretch and concludes it crashed. Dismissible for good once they know.
  const [confirmGen, setConfirmGen] = useState(false);
  // Generate diagnostics now flow to the movable Scheduler Health panel (Tools) via the
  // "ether:gen-report" event — structured, actionable, non-blocking (no locked modal).

  // ── AUTO-GENERATED DAYS (2026-08-11) ────────────────────────────────────────────────────────
  // Days this machine's auto-extender built, so an operator can tell at a glance which schedule they
  // authored and which appeared on its own. Reads `source`, the local-only provenance column
  // (NULL/'machine' = manual, 'auto' = the unattended extender, 'operator' = a jock deck-load).
  // Local-only in sync, so this says "THIS machine generated it" and never a peer's opinion.
  const [autoDays, setAutoDays] = useState<Set<string>>(new Set());
  useEffect(() => {
    let stop = false;
    (async () => {
      if (!stationId) return;
      try {
        const rows = await queryScoped<{ d: string }>(
          "SELECT DISTINCT date(scheduled_at,'unixepoch','localtime') d FROM generated_schedule WHERE station_id = ? AND source = 'auto' AND deleted_at IS NULL",
          [], stationId, { skipScoping: true });
        if (!stop) setAutoDays(new Set((rows || []).map(r => r.d)));
      } catch { /* the marker is informational — never break the calendar for it */ }
    })();
    return () => { stop = true; };
  }, [stationId, weekOffset, viewMode]);
  const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

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
    // No progress subscription here on purpose — <GenerateProgressBar/> owns it (see above).
    try {
      // ONE call for the whole week. Previously this looped seven separate invokes, each of which
      // blocked main's thread end-to-end; main now yields between every hour.
      const tsList = dates.map(d => Math.floor(new Date(d).setHours(0, 0, 0, 0) / 1000));
      const res = await (window as any).ether.invoke("schedule:generateDays", tsList);
      const count = res?.count || 0;
      const station = res?.station || "";
      const g = res?.gaps || {};
      const days: any[] = [];
      if (g.noShow?.length || g.noClock?.length || g.emptyCats?.length || g.emptyClocks?.length) {
        days.push({ date: "This week", dateTs: tsList[0], noShow: g.noShow || [], noClock: g.noClock || [], emptyCats: g.emptyCats || [], emptyClocks: g.emptyClocks || [], relaxed: [] });
      }
      setShowTracks(true);
      await loadTrackCounts();
      window.dispatchEvent(new CustomEvent("ether:schedule-regenerated"));
      window.dispatchEvent(new CustomEvent("ether:gen-report", { detail: { station, count, days } }));
      if (res?.cancelled) {
        // Days already committed are intact; the in-flight day was discarded whole, never half-written.
        setGenMsg(`Canceled · ${res?.daysCommitted || 0} day(s) generated · ${count} items`);
        setTimeout(() => setGenMsg(""), 6000);
      } else if (days.length || count === 0) {
        window.dispatchEvent(new Event("ether:open-scheduler-health"));
        setGenMsg(count === 0 ? "Generated nothing — see Scheduler Health (Tools)" : `Generated ${count} · gaps/relaxed → Scheduler Health`);
        setTimeout(() => setGenMsg(""), 9000);
      } else {
        setGenMsg(`✓ Generated this week · ${count} items · clean`);
        setTimeout(() => setGenMsg(""), 6000);
      }
    } catch (e: any) {
      setGenMsg("Generation failed: " + String(e?.message || e));
      setTimeout(() => setGenMsg(""), 9000);
    } finally {
      setGenerating(false);
    }
  };

  // Gate the week generate behind the explainer unless the operator has turned it off.
  const startWeekGenerate = () => {
    if (generating) return;
    try {
      if (localStorage.getItem("ether_gen_explain_dismissed") === "1") { generate(); return; }
    } catch { /* localStorage unavailable → always explain */ }
    setConfirmGen(true);
  };

  // ── Day view — click a day to open its date and see the airing log hour-by-hour ──
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);
  // MANUAL LOG EDITING (Fix 2): id/uuid/source/state added. Without a stable handle nothing could be
  // addressed for mutation; `source` says who owns the row (and therefore whether Generate may touch
  // it); `state` says whether it has already aired, which makes it a record rather than a plan.
  type DayRow = {
    id: number; uuid: string; scheduled_at: number; title: string; artist: string;
    duration_s: number; category_id: number | null; song_id: number | null;
    source: string | null; state: string | null;
  };
  const [dayRows, setDayRows]         = useState<DayRow[]>([]);
  // Category names for the Category column + its editor. Scoped to the station, like every other
  // per-station read in this file.
  const [cats, setCats] = useState<{ id: number; name: string }[]>([]);
  useEffect(() => {
    (async () => {
      // stationId is passed, not baked into the SQL: categories are per-station (the per-station
      // category migration), and an unscoped read here would offer another station's categories in
      // the editor's dropdown.
      try { setCats(await queryScoped<{ id: number; name: string }>("SELECT id, name FROM categories WHERE deleted_at IS NULL ORDER BY name", [], stationId)); }
      catch { setCats([]); }
    })();
  }, [stationId]);
  const catName = (id: number | null) => (id == null ? "" : (cats.find(c => c.id === id)?.name || `#${id}`));

  // Sorting state, reported up by DataGrid. DRAG IS ONLY LEGAL UNDER A TIME SORT: a broadcast log is
  // time-ordered by definition, so under any other sort "swap these two rows" would swap two
  // arbitrary airtimes with nothing on screen saying so. Hour separators are meaningless then too.
  const [logSort, setLogSort] = useState<{ id: string; desc: boolean }[]>([{ id: "time", desc: false }]);
  const timeOrdered = logSort.length === 1 && logSort[0].id === "time" && !logSort[0].desc;
  // The cell being edited, and its working value.
  const [editCell, setEditCell] = useState<{ uuid: string; field: "title" | "artist" | "category_id" } | null>(null);
  const [editVal, setEditVal] = useState<string>("");

  // Drag state moved INTO DataGrid with the grid conversion — the ghost, the drop line and the
  // no-onDragLeave fix from 4.4.199 now live there, so every grid that opts into rowDrag inherits
  // them instead of each re-deriving the same three lessons.
  const [rowBusy, setRowBusy]         = useState<string | null>(null);
  const [rowWarn, setRowWarn]         = useState<Record<string, string[]>>({});
  const [editErr, setEditErr]         = useState<string | null>(null);
  const [dayLoading, setDayLoading]   = useState(false);
  const [genDayBusy, setGenDayBusy]   = useState(false);
  const [dayShow, setDayShow]         = useState<{ name: string; startHour: number; endHour: number } | null>(null);
  // The scrollable hour list. Held so an edit can put the operator back exactly where they were.
  const dayScrollRef = useRef<HTMLDivElement | null>(null);

  /**
   * @param quiet  re-read WITHOUT blanking the list first.
   *
   * The non-quiet path sets dayRows to [] and flips dayLoading, which swaps the entire hour list for
   * a "Loading…" line. That collapses the scroll container to a single row, the browser clamps
   * scrollTop to 0, and the operator is thrown back to midnight — after every drag, pin and delete.
   * Blanking is right when OPENING a day (the old day's rows are not the new day's) and wrong for a
   * refresh after an edit, where the content is about to be almost identical.
   */
  const loadDayRows = async (d: Date, quiet = false) => {
    if (!quiet) { setDayLoading(true); setDayRows([]); }
    const keepTop = quiet ? (dayScrollRef.current?.scrollTop ?? 0) : 0;
    try {
      const start = Math.floor(new Date(d).setHours(0, 0, 0, 0) / 1000), end = start + 86_400;
      const res = await (window as any).ether.invoke("schedule:get", start, end, stationId);
      setDayRows(Array.isArray(res?.data) ? res.data : []);
      if (quiet && dayScrollRef.current) {
        // Belt and braces: even without the blanking, a row changing height (a warning appearing
        // under an hour) can shift the content. Restore after paint, not during it.
        const el = dayScrollRef.current;
        requestAnimationFrame(() => { if (el) el.scrollTop = keepTop; });
      }
    } catch { /* ignore */ } finally { if (!quiet) setDayLoading(false); }
  };
  const openDay = async (date: Date, show?: Show) => {
    const d = new Date(date); d.setHours(0, 0, 0, 0);
    setSelectedDay(d);
    setDayShow(show ? { name: show.name, startHour: show.start_hour, endHour: show.end_hour } : null);
    await loadDayRows(d);
  };
  // ── Editing operations ────────────────────────────────────────────────────────────────────────
  // Every one of these RE-READS the day afterwards and paints what came back. No optimistic paint:
  // a refused or failed edit must never show as applied for even one frame.
  const afterEdit = async (r: any, warnFor?: string) => {
    if (!r || r.ok === false) { setEditErr((r && r.error) || "the edit did not apply"); return false; }
    setEditErr(null);
    // QUIET re-read: an edit must never move the operator's view. See loadDayRows.
    if (selectedDay) await loadDayRows(selectedDay, true);
    window.dispatchEvent(new CustomEvent("ether:schedule-regenerated"));
    // The warning is asked for AFTER the move has applied — it informs, it never gates (design §3
    // Layer 5). A failed check is silent: it must not look like a rule violation.
    if (warnFor) {
      try {
        const row = (await (window as any).ether.invoke("schedule:get",
          Math.floor(new Date(selectedDay!).setHours(0, 0, 0, 0) / 1000),
          Math.floor(new Date(selectedDay!).setHours(0, 0, 0, 0) / 1000) + 86_400, stationId))?.data
          ?.find((x: any) => x.uuid === warnFor);
        if (row) {
          const c = await (window as any).ether.invoke("schedule:checkRow", stationId, warnFor, row.scheduled_at);
          setRowWarn(prev => ({ ...prev, [warnFor]: (c && c.warnings) || [] }));
        }
      } catch { /* a failed check never blocks or misreports */ }
    }
    return true;
  };
  const moveRow = async (fromUuid: string, toUuid: string) => {
    if (!fromUuid || !toUuid || fromUuid === toUuid) return;
    setRowBusy(fromUuid);
    try { await afterEdit(await (window as any).ether.invoke("schedule:moveRow", fromUuid, toUuid), fromUuid); }
    catch (e: any) { setEditErr(e?.message || String(e)); }
    finally { setRowBusy(null); }
  };
  const setRowSource = async (uuid: string, source: string | null) => {
    setRowBusy(uuid);
    try { await afterEdit(await (window as any).ether.invoke("schedule:setRowSource", uuid, source)); }
    catch (e: any) { setEditErr(e?.message || String(e)); }
    finally { setRowBusy(null); }
  };
  const commitCell = async () => {
    if (!editCell) return;
    const { uuid, field } = editCell;
    const row = dayRows.find(r => r.uuid === uuid);
    setEditCell(null);
    if (!row) return;
    const next = field === "category_id" ? (editVal === "" ? null : Number(editVal)) : editVal;
    const before = field === "category_id" ? row.category_id : (row as any)[field];
    if (String(before ?? "") === String(next ?? "")) return;   // nothing changed — no write, no event
    setRowBusy(uuid);
    try { await afterEdit(await (window as any).ether.invoke("schedule:editRowFields", uuid, { [field]: next })); }
    catch (e: any) { setEditErr(e?.message || String(e)); }
    finally { setRowBusy(null); }
  };

  const deleteRow = async (uuid: string) => {
    setRowBusy(uuid);
    try {
      const ok = await afterEdit(await (window as any).ether.invoke("schedule:deleteRow", uuid));
      if (ok) setRowWarn(prev => { const n = { ...prev }; delete n[uuid]; return n; });
    } catch (e: any) { setEditErr(e?.message || String(e)); }
    finally { setRowBusy(null); }
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
    // When a show is in scope, the grid shows only that show's hours — the same scoping the
    // hour-gutter list did, moved to the row set because a table has no per-hour container.
    const showHours = dayShow ? new Set(hours) : null;
    const visibleRows = showHours
      ? dayRows.filter(r => showHours.has(Math.floor((r.scheduled_at - dayStart) / 3600)))
      : dayRows;

    const cellBtn: React.CSSProperties = {
      background: "transparent", border: "none", padding: "0 3px",
      color: "var(--text-tertiary)", fontSize: 13, lineHeight: 1,
    };
    // An inline editor shared by the three editable cells. Enter commits, Escape abandons, blur
    // commits — the spreadsheet conventions, so nobody has to be told.
    const editorProps = {
      autoFocus: true,
      onBlur: () => { commitCell(); },
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === "Enter") { e.preventDefault(); commitCell(); }
        else if (e.key === "Escape") { e.preventDefault(); setEditCell(null); }
      },
      style: { width: "100%", font: "inherit", color: "var(--text-primary)", background: "var(--bg-primary)",
               border: "1px solid var(--accent-purple, #8868D8)", padding: "2px 4px", borderRadius: 0 } as React.CSSProperties,
    };
    const isAired = (r: DayRow) => r.state === "played" || r.state === "playing";
    // Double-click to edit — but ONLY where editing means something. A row with a song_id plays a
    // FILE; its title/artist label that file. Renaming the label here would change what the log says
    // without changing a note of what airs, leaving an as-run that disagrees with the audio. The main
    // process refuses it too; this just declines to offer it.
    const canEditText = (r: DayRow) => !isAired(r) && r.song_id == null;
    const openEdit = (r: DayRow, field: "title" | "artist" | "category_id") => {
      if (isAired(r)) return;
      if ((field === "title" || field === "artist") && !canEditText(r)) return;
      setEditVal(field === "category_id" ? String(r.category_id ?? "") : String((r as any)[field] ?? ""));
      setEditCell({ uuid: r.uuid, field });
    };
    const editing = (r: DayRow, field: string) => editCell?.uuid === r.uuid && editCell.field === field;

    const logColumns: GridColumn<DayRow>[] = [
      {
        id: "time", header: "Time", width: 86, minWidth: 70, mono: true, sortType: "numeric",
        accessor: (r) => r.scheduled_at,
        cell: (r) => {
          const isNow = isToday && r.scheduled_at === currentAt;
          return (
            <span style={{ color: isNow ? "var(--accent-green)" : "var(--text-secondary)", fontWeight: isNow ? 800 : 500 }}>
              {isNow ? "▶ " : ""}{new Date(r.scheduled_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          );
        },
      },
      {
        id: "type", header: "Type", width: 96, minWidth: 70,
        accessor: (r) => typeOf(r).label,
        cell: (r) => {
          const t = typeOf(r);
          return <span style={{ color: t.color, fontWeight: 700, fontSize: 12 }}>{t.label}</span>;
        },
      },
      {
        id: "title", header: "Title", width: 340, minWidth: 140,
        accessor: (r) => r.title || "",
        cell: (r) => editing(r, "title")
          ? <input {...editorProps} value={editVal} onChange={(e) => setEditVal(e.target.value)} />
          : (
            <span onDoubleClick={() => openEdit(r, "title")}
              title={canEditText(r) ? "Double-click to edit"
                : isAired(r) ? "Already aired — a record, not a plan"
                : "This row plays a song from your Library. Rename it in the Library — editing it here would make the log disagree with what actually airs."}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: canEditText(r) ? "text" : "default", color: "var(--text-primary)" }}>
              {/* Ownership is VISIBLE, not remembered — "Generate won't touch this" must be readable
                  off the row or the operator cannot predict what Regenerate will do. */}
              {r.source && (
                <span title="You placed, pinned or edited this. Generate will not move, replace or remove it."
                  style={{ padding: "1px 5px", fontSize: 9, fontWeight: 800, fontFamily: "'DM Mono', monospace",
                           color: "#8868D8", background: "rgba(136,104,216,0.14)",
                           border: "1px solid rgba(136,104,216,0.5)", letterSpacing: "0.06em" }}>YOURS</span>
              )}
              {r.title}
            </span>
          ),
      },
      {
        id: "artist", header: "Artist", width: 220, minWidth: 100,
        accessor: (r) => r.artist || "",
        cell: (r) => editing(r, "artist")
          ? <input {...editorProps} value={editVal} onChange={(e) => setEditVal(e.target.value)} />
          : <span onDoubleClick={() => openEdit(r, "artist")}
              title={canEditText(r) ? "Double-click to edit" : undefined}
              style={{ cursor: canEditText(r) ? "text" : "default" }}>{r.artist}</span>,
      },
      {
        id: "category", header: "Category", width: 160, minWidth: 90,
        accessor: (r) => catName(r.category_id),
        cell: (r) => editing(r, "category_id")
          ? (
            <select {...editorProps} value={editVal} onChange={(e) => { setEditVal(e.target.value); }}>
              <option value="">—</option>
              {cats.map(c => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
            </select>
          )
          : <span onDoubleClick={() => openEdit(r, "category_id")}
              title={isAired(r) ? "Already aired — a record, not a plan" : "Double-click to change"}
              style={{ cursor: isAired(r) ? "default" : "pointer" }}>{catName(r.category_id)}</span>,
      },
      {
        id: "status", header: "Status", width: 100, minWidth: 70,
        accessor: (r) => r.state || "pending",
        cell: (r) => {
          const s = String(r.state || "pending");
          const col = s === "played" ? "var(--text-tertiary)" : s === "playing" ? "var(--accent-green)"
                    : s === "missed" || s === "skipped" ? "#b3564f" : "var(--text-tertiary)";
          return <span style={{ color: col, fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" as const }}>{s}</span>;
        },
      },
      {
        id: "actions", header: "", width: 64, minWidth: 56, align: "right",
        // A constant accessor: this column carries controls, not data, so sorting by it is a no-op
        // rather than an arbitrary reshuffle.
        accessor: () => "",
        cell: (r) => {
          if (isAired(r)) return null;   // no action is ever valid on a row that already went out
          const busy = rowBusy === r.uuid;
          return (
            <span style={{ display: "inline-flex", gap: 2, justifyContent: "flex-end" }}>
              <button onClick={() => setRowSource(r.uuid, r.source ? null : "operator")} disabled={busy}
                title={r.source ? "Release back to the scheduler — Generate may replace it again"
                                : "Pin here — Generate will leave this row alone"}
                style={{ ...cellBtn, color: r.source ? "#8868D8" : "var(--text-tertiary)", cursor: busy ? "wait" : "pointer" }}>
                {r.source ? "📌" : "📍"}
              </button>
              <button onClick={() => deleteRow(r.uuid)} disabled={busy}
                title="Remove from the log — leaves a gap the next Generate refills"
                style={{ ...cellBtn, cursor: busy ? "wait" : "pointer" }}>✕</button>
            </span>
          );
        },
      },
    ];

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
          {/* The accumulation risk, made visible (design §7): pin enough rows and Generate can no
              longer heal the day. The count says so before it becomes a mystery. */}
          {dayRows.some(r => r.source) && (
            <span title="Generate will not move, replace or remove these. Use 📌 on a row to release it."
              style={{ fontSize: 10, fontWeight: 700, color: "#8868D8", padding: "1px 6px", border: "1px solid rgba(136,104,216,0.5)", background: "rgba(136,104,216,0.12)" }}>
              {dayRows.filter(r => r.source).length} yours — Generate won’t touch
            </span>
          )}
          {editErr && (
            <span style={{ fontSize: 10, fontWeight: 700, color: "#f87171" }}>{editErr}</span>
          )}
          <div style={{ flex: 1 }} />
          <button onClick={generateThisDay} disabled={genDayBusy}
            style={{ ...navBtn, color: "#0a160d", background: "var(--accent-green)", border: "none", fontWeight: 800, opacity: genDayBusy ? 0.5 : 1, cursor: genDayBusy ? "default" : "pointer" }}>
            {genDayBusy ? "Generating…" : "Generate"}
          </button>
        </div>
        {/* ── THE LOG, as a spreadsheet (4.4.200) ────────────────────────────────────────────────
            Built on the SHARED DataGrid, not a 17th hand-rolled table: headers, click-to-sort,
            operator-resizable columns persisted per station, and the required empty state all come
            from docs/schedule-manager-v2-design-2026-08-10.md §4.1 ("one grid, sixteen
            replacements"). zebra / groupBy / rowDrag / density are opt-in props added for this view;
            every existing grid renders byte-identically without them. */}
        <div ref={dayScrollRef} style={{ flex: 1, overflowY: "auto" }}>
          {dayLoading ? (
            <div style={{ padding: 40, textAlign: "center", color: "var(--text-tertiary)", fontSize: 12 }}>Loading…</div>
          ) : (
            <>
              {/* Rule warnings, consolidated above the grid. They used to sit under the hour they
                  belonged to; a sortable table has no stable "under that hour" to sit in, and one
                  place the operator can always find beats several they must hunt for. Amber, never
                  red, and never a block — the DJ made the call. */}
              {visibleRows.some(r => (rowWarn[r.uuid] || []).length > 0) && (
                <div style={{ margin: "8px 12px", padding: "7px 10px", border: "1px solid rgba(251,191,36,0.45)", background: "rgba(251,191,36,0.08)" }}>
                  {visibleRows.flatMap(r => (rowWarn[r.uuid] || []).map((w, k) => (
                    <div key={`${r.uuid}-${k}`} style={{ fontSize: 12, color: "#fbbf24", lineHeight: 1.6 }}>
                      <strong style={{ fontWeight: 800 }}>{r.title}</strong> — {w}
                    </div>
                  )))}
                  <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 3 }}>
                    Your edit was applied. This is a heads-up, not a refusal.
                  </div>
                </div>
              )}

              {/* Sorted by something other than time: say what that costs, in place, rather than
                  letting the operator discover that dragging silently stopped working. */}
              {!timeOrdered && (
                <div style={{ margin: "8px 12px", padding: "7px 10px", border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", fontSize: 12, color: "var(--text-tertiary)", lineHeight: 1.6 }}>
                  Sorted by <strong style={{ color: "var(--text-secondary)" }}>{logSort[0]?.id || "—"}</strong> — hour markers are hidden and
                  drag-to-reorder is off. A log is time-ordered: swapping two rows in this view would
                  swap two unrelated airtimes. Click <strong style={{ color: "var(--text-secondary)" }}>TIME</strong> to sort by time and get dragging back.
                </div>
              )}

              <DataGrid<DayRow>
                columns={logColumns}
                rows={visibleRows}
                getRowId={(r) => r.uuid}
                density="roomy"
                zebra
                persistKey="daylog"
                stationId={stationId}
                initialSort={[{ id: "time", desc: false }]}
                onSortingChange={setLogSort}
                groupBy={timeOrdered ? {
                  key: (r) => Math.floor((r.scheduled_at - dayStart) / 3600),
                  render: (k) => (
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: "0.06em", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                        ⏤ {fmtHour(Number(k))} ⏤
                      </span>
                      <span style={{ flex: 1, borderTop: "1px solid var(--border-primary)" }} />
                    </div>
                  ),
                } : undefined}
                rowDrag={{
                  enabled: timeOrdered,
                  disabledReason: "Sort by Time to reorder rows",
                  canDrag: (r) => !isAired(r),
                  onDrop: (from, to) => moveRow(from, to),
                }}
                rowStyle={(r) => {
                  const isNow = isToday && r.scheduled_at === currentAt;
                  return {
                    // A THIN type bar on the left edge — 3px, muted, not a block fill.
                    borderLeft: `3px solid ${typeOf(r).color}`,
                    ...(isNow ? { background: "rgb(from var(--accent-green) r g b / 0.14)" } : {}),
                    // PLAYED rows dimmed: they are a record, and the eye should go to what is next.
                    ...(isAired(r) ? { opacity: 0.5 } : {}),
                  };
                }}
                empty={<>Nothing scheduled for this {dayShow ? "show" : "day"} yet. Press <strong>Generate</strong> to build it from your clocks.</>}
              />
            </>
          )}
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
        {/* The inline meter was removed 2026-08-06: it lived in this component, so painting it re-rendered
            the day list on every one of the 168 hourly ticks. Progress is now the always-mounted
            bottom-left <GenerateProgressBar/>, which also survives navigating away mid-run. */}
        <button disabled={generating} onClick={startWeekGenerate} title="Generate the viewed week (one week at a time)"
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
                    {/* Built by the unattended extender, not by a person. Quiet by design: this is
                        provenance, not a warning — an auto-generated day is the system working. */}
                    {autoDays.has(dayKey(cell)) && (
                      <span title="Generated automatically by this machine — the log was running low"
                        style={{ fontSize: 8, fontWeight: 800, letterSpacing: "0.08em", padding: "1px 4px", color: "var(--text-tertiary)", border: "1px solid var(--border-primary)" }}>AUTO</span>
                    )}
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

      {/* ── Explain before the wait ────────────────────────────────────────────────────────────────
          A week generate is minutes of real work. Before 4.4.152 it looked like a crash: no dialog, a
          frozen-looking window, no way to stop. This says what is about to happen in plain language,
          and remembers when the operator no longer needs telling. */}
      {confirmGen && (
        <div
          onClick={() => setConfirmGen(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 400,
                   display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ width: 430, maxWidth: "88vw", background: "var(--bg-secondary)",
                     border: "1px solid var(--border-primary)", borderTop: "3px solid var(--accent-green)",
                     boxShadow: "0 18px 50px rgba(0,0,0,0.5)", padding: "18px 20px 16px",
                     fontFamily: "'Inter', system-ui, sans-serif" }}
          >
            <div style={{ fontSize: 15, fontWeight: 800, color: "var(--text-primary)", marginBottom: 10 }}>
              Generate this week?
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.55, color: "var(--text-secondary)", marginBottom: 12 }}>
              Ether builds the log <strong>one day at a time</strong>, picking every song against your clocks
              and separation rules. A full week takes a few minutes.
              <br /><br />
              You can keep working while it runs — a progress bar appears in the bottom-left corner showing
              which day it is on, and you can stop it at any time. Days already finished are kept.
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12,
                            color: "var(--text-tertiary)", marginBottom: 16, cursor: "pointer" }}>
              <input
                type="checkbox"
                onChange={e => { try { localStorage.setItem("ether_gen_explain_dismissed", e.target.checked ? "1" : "0"); } catch { /* ignore */ } }}
              />
              Don't show this again
            </label>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                onClick={() => setConfirmGen(false)}
                style={{ padding: "8px 16px", borderRadius: 0, fontSize: 13, fontWeight: 600,
                         background: "var(--bg-tertiary)", color: "var(--text-secondary)",
                         border: "1px solid var(--border-primary)", cursor: "pointer" }}
              >Cancel</button>
              <button
                onClick={() => { setConfirmGen(false); generate(); }}
                style={{ padding: "8px 22px", borderRadius: 0, fontSize: 13, fontWeight: 800,
                         background: "var(--accent-green)", color: "#0a160d", border: "none", cursor: "pointer" }}
              >OK, generate</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
