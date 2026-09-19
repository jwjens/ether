// src/lib/programLogRows.ts
// Program Log ← generated_schedule: the pure part of the read path (slice 1, 2026-09-18).
// docs/program-log-one-surface-2026-09-17.md §1. The window is built the way schedule:generateDay
// builds it (electron/main.js: dayBase.setHours(0,0,0,0); dayEnd = dayStart + 86_400) so the day the
// panel SHOWS is the day Generate FILLS. The hour row is the row's local wall-clock hour — never
// (ts − dayStart) / 3600, which on the two DST days would file an hour under the wrong row.

/** One row of generated_schedule as schedule:get returns it (main.js `schedule:get`). */
export interface ScheduleGetRow {
  id: number; uuid: string; scheduled_at: number; song_id: number | null;
  title: string | null; artist: string | null; file_key: string | null; file_path: string | null;
  duration_s: number | null; category_id: number | null; source: string | null;
  state: string | null; content_class: string | null; channel: string | null;
  played_at: number | null;
}

/** The row shape ProgramLog.tsx renders. The legacy fields (slot_type, label, overflow, …) are kept so
 *  the unchanged markup, CSV / Print / PDF and the hour modal keep compiling; the new fields carry the
 *  airing log's identity and lifecycle. */
export interface ProgramLogEntry {
  id: number; log_date: string; hour: number; position: number;
  slot_type: string; category_id: number | null;
  category_code: string | null; category_color: string | null;
  song_id: number | null; song_title: string | null;
  song_artist: string | null; duration_ms: number;
  label: string | null; status: string;
  overflow: number;
  fade_out_at_ms: number;
  fade_duration_ms: number;
  // generated_schedule identity + lifecycle (slice 1)
  uuid: string; scheduled_at: number; played_at: number | null;
  source: string | null; content_class: string | null;
}

export interface CategoryRef { id: number; code: string | null; color: string | null }

/** `YYYY-MM-DD` of a Date in LOCAL time. (toISOString().slice(0,10) is the UTC date — after 17:00
 *  Pacific it names tomorrow.) */
export function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** [dayStart, dayEnd) in unix seconds for a `YYYY-MM-DD` — local midnight, exactly as generateDay:
 *  `new Date(y, m-1, d)` is local midnight; +86 400 is what the generator writes up to. On a DST day
 *  that window is 23 or 25 wall-clock hours; the panel shows what exists in it. */
export function dayWindow(selectedDate: string): { dayStart: number; dayEnd: number } {
  const [y, m, d] = selectedDate.split("-").map(Number);
  const dayBase = new Date(y, m - 1, d);
  dayBase.setHours(0, 0, 0, 0);
  const dayStart = Math.floor(dayBase.getTime() / 1000);
  return { dayStart, dayEnd: dayStart + 86_400 };
}

/** Local wall-clock hour of a unix-seconds timestamp. */
export function localHour(ts: number): number {
  return new Date(ts * 1000).getHours();
}

/** HH:MM:SS local. */
export function fmtClock(ts: number | null | undefined): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

/** content_class → the legacy slot_type the markup colours on. content_class is authoritative when
 *  present (v29/v31); song_id is the fallback for rows written before it (same rule as the Calendar's
 *  typeOf). */
export function slotTypeOf(r: { content_class?: string | null; song_id: number | null }): string {
  const cc = String(r.content_class || "").toUpperCase();
  if (cc === "MUSIC") return "music";
  if (cc === "SPOT") return "spot_break";
  if (cc === "JIN" || cc === "SWP") return "sweeper";
  if (cc === "CART") return "cart";
  if (cc === "VOICE" || cc === "VT") return "voice";
  return r.song_id ? "music" : "spot_break";
}

/** schedule:get rows → ProgramLog entries, grouped by LOCAL hour, positioned by scheduled_at order
 *  within the hour. Rows outside [dayStart, dayEnd) are not expected (the handler windows them) but
 *  are still filed by their own local hour if present. */
export function toEntries(
  rows: ScheduleGetRow[],
  selectedDate: string,
  cats: Map<number, CategoryRef>,
): ProgramLogEntry[] {
  const sorted = [...rows].sort((a, b) => a.scheduled_at - b.scheduled_at || a.id - b.id);
  const posByHour = new Map<number, number>();
  return sorted.map(r => {
    const hour = localHour(r.scheduled_at);
    const position = posByHour.get(hour) ?? 0;
    posByHour.set(hour, position + 1);
    const cat = r.category_id != null ? cats.get(r.category_id) : undefined;
    const slot_type = slotTypeOf(r);
    return {
      id: r.id, log_date: selectedDate, hour, position,
      slot_type,
      category_id: r.category_id ?? null,
      category_code: cat?.code ?? null,
      category_color: cat?.color ?? null,
      song_id: r.song_id ?? null,
      song_title: r.title ?? null,
      song_artist: r.artist ?? null,
      duration_ms: Math.round((r.duration_s ?? 0) * 1000),
      label: slot_type === "music" ? null : (r.title ?? null),
      status: r.state || "pending",
      overflow: 0, fade_out_at_ms: 0, fade_duration_ms: 0,
      uuid: r.uuid, scheduled_at: r.scheduled_at, played_at: r.played_at ?? null,
      source: r.source ?? null, content_class: r.content_class ?? null,
    };
  });
}

/** The hours a show covers (handles end_hour=0 / end==start = all day, and overnight ranges). */
export function showHours(s: { start_hour: number; end_hour: number }): number[] {
  const out: number[] = [];
  const end = s.end_hour === 0 || s.end_hour === s.start_hour ? 24 : s.end_hour;
  if (end > s.start_hour) {
    for (let h = s.start_hour; h < end; h++) out.push(h % 24);
  } else {
    for (let h = s.start_hour; h < 24; h++) out.push(h);
    for (let h = 0; h < end; h++) out.push(h);
  }
  return out;
}

/** The show active at a given hour (first match in the given order — the caller orders by start_hour). */
export function showForHour<T extends { start_hour: number; end_hour: number }>(shows: T[], hour: number): T | undefined {
  return shows.find(s => {
    if (s.end_hour === 0 || s.end_hour === s.start_hour) return hour >= s.start_hour;
    if (s.end_hour > s.start_hour) return hour >= s.start_hour && hour < s.end_hour;
    return hour >= s.start_hour || hour < s.end_hour; // overnight
  });
}

/** Hours to render: every hour a show covers ∪ every hour that has a row, ascending. */
export function hoursToRender(entries: { hour: number }[], shows: { start_hour: number; end_hour: number }[]): number[] {
  const set = new Set<number>();
  entries.forEach(e => set.add(e.hour));
  shows.forEach(s => showHours(s).forEach(h => set.add(h)));
  return Array.from(set).sort((a, b) => a - b);
}
