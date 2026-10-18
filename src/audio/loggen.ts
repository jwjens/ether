// src/audio/loggen.ts
//
// Queue filling engine — reads Smart Scheduler rules and picks
// songs that match the current time slot's BPM and energy requirements.
//
// Enforces ALL active rotation rules:
//   • rotation_status != 'inactive'         (always)
//   • daypart_mask bitmask for current hour  (always)
//   • is_explicit = 0                        (when blockExplicit setting is on)
//   • no_repeat_hours per song               (replaces hardcoded 2h)
//   • artist_separation_min from DB rules    (replaces no enforcement)
//   • genre, BPM, energy from SmartRule      (existing, unchanged)
//
// Falls back to filtered random if no rules match or library isn't analyzed yet.

import { query, execute, queryOne } from "../db/client";
import { getActiveStationIdSync } from "../hooks/useActiveStation";
import { getEngine } from "./engine-registry";

interface SmartRule {
  id: string;
  description: string;
  days: number[];
  startHour: number;
  endHour: number;
  energyLevel: "high" | "medium" | "low" | "mixed";
  bpmMin?: number;
  bpmMax?: number;
  genres?: string[];
  newsAtTop: boolean;
  spotBreaks: boolean;
  idsEveryNSongs: number;
  active: boolean;
}

interface Song {
  id: number;
  title: string;
  artist_name: string;
  file_path: string;
  duration_ms: number;
  bpm: number | null;
  energy: number | null;
  intro_end?: number;
  outro_start?: number;
}

interface SepRules {
  /** seconds — from artist_separation_min DB rule, converted from minutes */
  artist_sep_sec: number;
  /** seconds — from song_separation_min DB rule, converted from minutes */
  song_sep_sec: number;
}

// ── Cursor into generated_schedule — advances as tracks are queued ──
// Tracks the last row id already loaded into the queue so refills
// continue forward rather than re-queuing played songs.
const _schedCursor = new Map<number, number>();  // stationId → last-read gs.id (PER-STATION; a shared global made all stations trample one cursor → cross-station repeats)

export function resetScheduleCursor(stationId?: number) { if (stationId != null) _schedCursor.delete(stationId); else _schedCursor.clear(); }

// ── Hourly daypart log — fires once per clock-hour ────────────
let _lastLoggedHour = -1;
function maybeDaypartLog(hour: number) {
  if (hour === _lastLoggedHour) return;
  _lastLoggedHour = hour;
  console.log(
    `[daypart] Local hour: ${hour}  ` +
    `(bit ${hour} of daypart_mask must be 1 for songs to play this hour)`
  );
}

// ── Get current active rule ────────────────────────────────────

export function getActiveRule(): SmartRule | null {
  try {
    const rules: SmartRule[] = JSON.parse(
      localStorage.getItem("ether_smart_rules") || "[]"
    );
    const now  = new Date();
    const hour = now.getHours();
    const day  = now.getDay();

    return rules.find(r =>
      r.active &&
      r.days.includes(day) &&
      hour >= r.startHour &&
      hour < r.endHour
    ) ?? null;
  } catch {
    return null;
  }
}

// ── Content filter from localStorage ──────────────────────────

// ── Format-clock based song selection ────────────────────────
//
// When the current hour has an active show with a format clock assigned,
// pick songs from that clock's music slots (in order) before falling back
// to SmartRules or random.  All base rotation rules still apply.

interface ClockSlotRow { category_id: number; }

export async function getActiveShowClock(stationId: number): Promise<{ clockId: number; showName: string; showColor: string | null } | null> {
  try {
    const hour = new Date().getHours();
    const day  = String(new Date().getDay());

    // Fetch all active shows with clocks and evaluate the hour range in JS
    // (avoids complex SQL for overnight / midnight-ending shows)
    const rows = await query<{
      clock_id: number; name: string;
      start_hour: number; end_hour: number; days: string; color: string | null;
    }>(
      `SELECT clock_id, name, start_hour, end_hour, days, color
       FROM shows WHERE is_active = 1 AND clock_id IS NOT NULL AND deleted_at IS NULL AND station_id = ?
       ORDER BY CASE
         WHEN end_hour = 0 AND start_hour > 0 THEN 24 - start_hour
         WHEN end_hour = 0 OR end_hour = start_hour THEN 24
         WHEN end_hour > start_hour              THEN end_hour - start_hour
         ELSE 24 - start_hour + end_hour
       END ASC`,
      [stationId]
    );

    for (const row of rows) {
      if (!row.days.includes(day)) continue;

      const { start_hour, end_hour } = row;
      let active: boolean;

      if (end_hour === 0 || end_hour === start_hour) {
        // "Until midnight" — active from start_hour through 23
        active = hour >= start_hour;
      } else if (end_hour > start_hour) {
        // Normal daytime show
        active = hour >= start_hour && hour < end_hour;
      } else {
        // Overnight show (e.g. 22–06): active after start OR before end
        active = hour >= start_hour || hour < end_hour;
      }

      if (active) {
        console.log(`[loggen] Active show: "${row.name}" (${start_hour}–${end_hour}) clock=${row.clock_id}`);
        return { clockId: row.clock_id, showName: row.name, showColor: row.color ?? null };
      }
    }

    console.log(`[loggen] No active show with clock found for hour ${hour} day ${day}`);
    return null;
  } catch (e) {
    console.error("[loggen] getActiveShowClock error:", e);
    return null;
  }
}

// ── Read upcoming tracks from generated_schedule ──────────────
//
// Reads the next `count` tracks from the pre-generated schedule,
// starting from now (with a 5-minute back-window so we don't miss
// the current slot if we're slightly late).  Joins songs to get
// the local file_path — entries with no matching local file are skipped.

interface ScheduledTrack {
  title: string;
  artist: string;
  file_path: string | null;
  file_key: string;
  intro_end: number | null;
  outro_start: number | null;
  scheduled_at: number;
  duration_ms?: number | null;
}

interface ScheduledTrackRow extends ScheduledTrack { row_id: number; }

export async function getFormatCategoryIds(stationId: number, clockId?: number): Promise<number[]> {
  try {
    const rows = clockId
      ? await query<{ category_id: number }>(
          `SELECT DISTINCT category_id FROM clock_slots
           WHERE clock_id = ? AND slot_type = 'music' AND category_id IS NOT NULL
             AND deleted_at IS NULL AND station_id = ?`,
          [clockId, stationId])
      : await query<{ category_id: number }>(
          `SELECT DISTINCT cs.category_id FROM clock_slots cs
           WHERE cs.slot_type = 'music' AND cs.category_id IS NOT NULL AND cs.deleted_at IS NULL
             AND cs.station_id = ?
             AND cs.clock_id IN (
               SELECT clock_id FROM shows WHERE is_active = 1 AND clock_id IS NOT NULL AND deleted_at IS NULL AND station_id = ?
             )`,
          [stationId, stationId]);
    return rows.map(r => r.category_id).filter(c => c != null);
  } catch { return []; }
}


async function readGeneratedSchedule(count: number, stationId: number): Promise<ScheduledTrack[]> {
  const nowTs = Math.floor(Date.now() / 1000);
  // Stay ON FORMAT even from a pre-generated log: skip any entry whose song is in an
  // off-rotation category (one no active show's clock uses — e.g. a stale Christmas entry
  // from an old generation). Empty fmt (no clocks) = no filter.
  // GATE is `s.id IS NULL` (no song join → legacy/SPOT snapshot row, allowed), NOT
  // `s.category_id IS NULL`: a song that EXISTS but is ORPHANED (category_id NULL → no
  // category → no station) must NOT pass, or it leaks onto every station's air (the
  // back-to-back "Munsters Theme" orphan leak; munsters-repeat-diagnosis-2026-07-26.md).
  // Mirrors the daemon fix in audiod/loggen.js so the cold-stage in-process fallback
  // window is not a back door for the leak the daemon path already closed.
  const fmt = await getFormatCategoryIds(stationId);
  const catClause = fmt.length ? `AND (s.id IS NULL OR s.category_id IN (${fmt.map(() => "?").join(",")}))` : "";
  const cursor = _schedCursor.get(stationId) ?? 0;
  const params = fmt.length ? [cursor, stationId, nowTs, ...fmt, count] : [cursor, stationId, nowTs, count];
  const rows = await query<ScheduledTrackRow>(
    `SELECT gs.id AS row_id, gs.title, gs.artist, gs.scheduled_at, gs.file_key, gs.content_class,
            COALESCE(gs.file_path, s.file_path) AS file_path, s.intro_end, s.outro_start,
            COALESCE(s.duration_ms, gs.duration_s * 1000) AS duration_ms
     FROM generated_schedule gs
     LEFT JOIN songs s ON s.id = gs.song_id
     WHERE gs.id > ? AND gs.station_id = ?
       AND gs.scheduled_at >= ? - 300
       AND gs.deleted_at IS NULL
       ${catClause}
     ORDER BY gs.scheduled_at
     LIMIT ?`,
    params
  );
  if (rows.length > 0) {
    _schedCursor.set(stationId, rows[rows.length - 1].row_id);
  }
  return rows;
}

// ── Main export: fill the queue ────────────────────────────────
//
// Priority 1: generated_schedule — plays the pre-planned log in order.
// Priority 2: active show clock  — live clock-based picking.
// Priority 3: SmartRules         — localStorage rules.
// Priority 4: filtered random    — last resort.

export async function fillQueueFromSchedule(targetCount = 20, stationIdArg?: number): Promise<number> {
  try {
    // Per-station: default to the active station (legacy callers), but a specific station can be
    // driven directly — this is what lets ALL stations (not just the foreground one) refill in auto.
    const stationId = stationIdArg ?? getActiveStationIdSync();
    const engine = getEngine(stationId);
    // Item 10 Phase 2 Step 2: in daemon-driven mode the daemon self-refills via its own
    // node:sqlite scheduler — the renderer must NOT also fill (would double-source the queue).
    // Single guard here covers every caller (startup, AUTO toggle, refill callback, intervals).
    if ((engine as any).isDaemonDriven) return 0;
    const hour = new Date().getHours();
    maybeDaypartLog(hour);

    // ── Priority 1: generated schedule ───────────────────────
    let scheduled = await readGeneratedSchedule(targetCount, stationId);
    if (scheduled.length === 0 && (_schedCursor.get(stationId) ?? 0) > 0) {
      _schedCursor.set(stationId, 0);
      scheduled = await readGeneratedSchedule(targetCount, stationId);
    }
    if (scheduled.length > 0) {
      // Resolve each track: prefer local file_path, fall back to R2 cache download
      const resolved = await Promise.all(scheduled.map(async s => {
        let filePath = s.file_path || '';
        if (!filePath && s.file_key) {
          try {
            const res = await (window as any).ether.invoke('r2:fetch-track', s.file_key);
            if (res?.ok) filePath = res.filePath;
          } catch {}
        }
        return filePath ? {
          filePath,
          title:      s.title,
          artist:     s.artist || '',
          introEnd:   s.intro_end ?? undefined,
          outroStart: s.outro_start ?? undefined,
          durationMs: s.duration_ms ?? 0,
          scheduledAt: s.scheduled_at,   // generated_schedule row identity — single source for the calendar
          contentClass: (s as any).content_class ?? undefined,   // MUSIC/SPOT — carried so the queue UI can gold-tint spots
        } : null;
      }));
      const items = resolved.filter(Boolean) as { filePath: string; title: string; artist: string; durationMs?: number; scheduledAt?: number; contentClass?: string }[];
      if (items.length > 0) {
        engine.addToQueue(items);
        (engine as any).purgeUnscheduled?.();   // schedule is authoritative — drop any live-picked/restored pollutant
        console.log(`[loggen] fillQueue: source=generated_schedule | ${items.length} tracks`);
        return items.length;
      }
    }

    // THE RENDERER PICKS NOTHING (Phase 2, 2026-10-18: one pick, audiod/scheduler-core.js). Its live-pick ladder
    // (clock / SmartRule / random, and the enforce_separation twin picker) is deleted. In-process playout plays the log;
    // a short hour is filled by the one pick in the daemon. An empty log here is said, never papered over.
    console.warn("[loggen] the log has nothing to play now (in-process path) — the renderer does not pick songs");
    return 0;
  } catch (e) {
    console.error("[loggen] fillQueueFromSchedule failed:", e);
    return 0;
  }
}

export async function refillFromSchedule(stationIdArg?: number): Promise<void> {
  const sid = stationIdArg ?? getActiveStationIdSync();
  const engine = getEngine(sid);
  const queueLen = engine.getQueue().length;
  if (queueLen < 5) {
    await fillQueueFromSchedule(20 - queueLen, sid);
  }
}

// ── Queue status info for the UI ──────────────────────────────

export function getScheduleStatus(): { rule: SmartRule | null; description: string } {
  const rule = getActiveRule();
  if (!rule) return { rule: null, description: "Random" };
  return {
    rule,
    description: rule.description,
  };
}
