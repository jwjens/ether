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
import { pickEnforced, RestMaps, SepWin } from "./separationEnforce";

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

function getContentFilter(): { blockExplicit: boolean } {
  try {
    const stored = localStorage.getItem("ether_content_filter");
    return stored ? JSON.parse(stored) : { blockExplicit: false };
  } catch {
    return { blockExplicit: false };
  }
}

// ── Separation rules from DB ───────────────────────────────────

async function getSepRules(stationId: number): Promise<SepRules> {
  try {
    const rows = await query<{ rule_type: string; value: number }>(
      "SELECT rule_type, value FROM separation_rules WHERE is_active = 1 AND station_id = ?",
      [stationId]
    );
    const artistRow = rows.find(r => r.rule_type === "artist_separation_min");
    const songRow   = rows.find(r => r.rule_type === "song_separation_min");
    return {
      artist_sep_sec: (artistRow?.value ?? 60)  * 60,   // default 60 min
      song_sep_sec:   (songRow?.value   ?? 120) * 60,   // default 120 min
    };
  } catch {
    return { artist_sep_sec: 3600, song_sep_sec: 7200 };
  }
}

// ── Enforce-separation (2026-07-27, slice 3) — renderer twin of the daemon enforced floor ─────────────
// Per-station toggle (station_config_kv key 'enforce_separation'), default OFF. When ON, the live-pick
// fallback below uses the shared enforced picker (separationEnforce.pickEnforced) instead of the
// clock/rule/random ladder. Tier 0 (generated_schedule) is unaffected. Mirrors audiod/loggen.js slice 2.
async function enforceSeparationOn(stationId: number): Promise<boolean> {
  try {
    const rows = await query<{ value: string }>(
      "SELECT value FROM station_config_kv WHERE key='enforce_separation' AND station_id=? AND deleted_at IS NULL",
      [stationId]);
    const v = rows[0]?.value;
    return v === "1" || v === "true";
  } catch { return false; }
}

async function sepWindowsMin(stationId: number): Promise<SepWin> {
  const g = async (rt: string, def: number) => {
    try {
      const r = await query<{ value: number }>(
        "SELECT value FROM separation_rules WHERE station_id=? AND rule_type=? AND is_active=1 LIMIT 1", [stationId, rt]);
      return r[0]?.value ?? def;
    } catch { return def; }
  };
  return { artistSepMin: await g("artist_separation_min", 60), songRepeatMin: await g("song_separation_min", 180), titleSepMin: await g("title_separation_min", 120) };
}

async function buildRestMapsTwin(stationId: number): Promise<Pick<RestMaps, "restByFile" | "restByArtist" | "restByTitle">> {
  const restByFile = new Map<string, number>(), restByArtist = new Map<number, number>(), restByTitle = new Map<string, number>();
  try { for (const r of await query<{ file_path: string; m: number }>("SELECT file_path, MAX(played_at) m FROM play_log WHERE station_id=? AND deleted_at IS NULL AND file_path IS NOT NULL GROUP BY file_path", [stationId])) restByFile.set(r.file_path, r.m || 0); } catch { /* */ }
  try { for (const r of await query<{ aid: number; m: number }>("SELECT s.artist_id aid, MAX(pl.played_at) m FROM play_log pl JOIN songs s ON s.file_path=pl.file_path WHERE pl.station_id=? AND pl.deleted_at IS NULL AND s.artist_id IS NOT NULL GROUP BY s.artist_id", [stationId])) restByArtist.set(r.aid, r.m || 0); } catch { /* */ }
  try { for (const r of await query<{ tk: string; m: number }>("SELECT LOWER(TRIM(title)) tk, MAX(played_at) m FROM play_log WHERE station_id=? AND deleted_at IS NULL AND title IS NOT NULL AND (content_class IS NULL OR content_class = 'MUSIC') GROUP BY LOWER(TRIM(title))", [stationId])) restByTitle.set(r.tk, r.m || 0); } catch { /* */ }
  return { restByFile, restByArtist, restByTitle };
}

// Enforced live-pick: fill `count` slots from the clock's music categories (else on-format), each via the
// shared pickEnforced. Returns Song[] in air order (rest-driven — NOT BPM-reordered). Empty ⇒ caller falls
// through to the legacy ladder (never dead air). relaxedCount is logged loud.
async function enforcedFill(count: number, stationId: number): Promise<Song[]> {
  const win = await sepWindowsMin(stationId);
  const rest = await buildRestMapsTwin(stationId);
  const maps: RestMaps = { ...rest, songLastTs: new Map(), artistLastTs: new Map(), titleLastTs: new Map() };
  const used = { usedSongIds: new Set<number>(), usedArtistIds: new Set<number>(), usedTitles: new Set<string>() };
  const showClock = await getActiveShowClock(stationId);
  let cats: number[] = [];
  if (showClock) {
    const rows = await query<{ category_id: number }>("SELECT category_id FROM clock_slots WHERE clock_id=? AND slot_type='music' AND category_id IS NOT NULL AND station_id=? AND deleted_at IS NULL ORDER BY position", [showClock.clockId, stationId]);
    cats = rows.map(r => r.category_id);
  }
  if (!cats.length) cats = await getFormatCategoryIds(stationId, showClock?.clockId);
  if (!cats.length) return [];
  const out: Song[] = []; let cursorTs = Math.floor(Date.now() / 1000); let ci = 0, relaxedCount = 0;
  for (let i = 0; i < count; i++) {
    let picked: any = null, guard = 0;
    while (!picked && guard++ < cats.length) {
      const cat = cats[ci++ % cats.length];
      const cands = await query<Song>("SELECT s.id, s.title, a.name AS artist_name, s.artist_id, s.duration_ms, s.file_path, s.intro_end, s.outro_start, s.no_repeat_hours FROM songs s LEFT JOIN artists a ON a.id=s.artist_id WHERE s.deleted_at IS NULL AND s.category_id=? AND s.file_path IS NOT NULL AND (s.rotation_status IS NULL OR s.rotation_status!='inactive') AND (s.content_class IS NULL OR s.content_class='MUSIC') AND (s.daypart_mask IS NULL OR ((s.daypart_mask>>?)&1)=1)", [cat, new Date(cursorTs * 1000).getHours()]);
      if (!cands.length) continue;
      const r = pickEnforced(cands as any[], cursorTs, maps, win, used, null, 240);
      if (!r) continue;
      picked = r.picked; if (r.relaxed) relaxedCount++;
    }
    if (!picked) break;
    used.usedSongIds.add(picked.id); if (picked.artist_id) used.usedArtistIds.add(picked.artist_id);
    const tk = (picked.title || "").trim().toLowerCase(); if (tk) used.usedTitles.add(tk);
    maps.songLastTs.set(picked.id, cursorTs); if (picked.artist_id) maps.artistLastTs.set(picked.artist_id, cursorTs); if (tk) maps.titleLastTs.set(tk, cursorTs);
    out.push(picked as Song);
    cursorTs += picked.duration_ms ? Math.round(picked.duration_ms / 1000) : 240;
  }
  if (relaxedCount) console.warn(`[loggen] ENFORCED (twin) relaxed ${relaxedCount}/${out.length} — category pool exhausted`);
  return out;
}

// ── Energy level → SQL filter ──────────────────────────────────

function energyFilter(level: "high" | "medium" | "low" | "mixed"): string {
  switch (level) {
    case "high":   return "AND (energy >= 0.55 OR energy IS NULL)";
    case "medium": return "AND (energy BETWEEN 0.25 AND 0.65 OR energy IS NULL)";
    case "low":    return "AND (energy <= 0.35 OR energy IS NULL)";
    case "mixed":  return "";
  }
}

// ── Build base conditions shared by both pickers ──────────────
//
// Every song candidate must pass these before any SmartRule filters:

function buildBaseConditions(
  hour: number,
  sep: SepRules,
  blockExplicit: boolean,
  params: any[],
  stationId: number
): string {
  // NEVER PLAY A DELETED SONG. This was missing from every candidate query in all three generators
  // (2026-08-13): two songs deleted on 2026-07-20 still held 63 future slots, and across the library
  // 28 deleted songs held 729 future rows with 438 plays recorded after their own delete timestamps.
  // A soft delete the picker ignores is not a delete.
  let cond = "s.deleted_at IS NULL AND s.file_path IS NOT NULL";

  // Never auto-play songs marked inactive in rotation
  cond += " AND (s.rotation_status IS NULL OR s.rotation_status != 'inactive')";

  // Daypart mask: bit N of daypart_mask must be 1 for the current hour N.
  // Default mask is 16777215 (all 24 bits set = unrestricted).
  cond += " AND ((s.daypart_mask >> ?) & 1) = 1";
  params.push(hour);

  // Explicit content block — controlled by ether_content_filter.blockExplicit
  if (blockExplicit) {
    cond += " AND s.is_explicit = 0";
    console.warn(`[loggen] RULE: explicit content blocked`);
  }

  // Song separation: use each song's own no_repeat_hours, not a hardcoded value.
  // A song that was played fewer than no_repeat_hours*3600 seconds ago is excluded.
  // no_repeat_hours is NULL for un-tuned songs; NULL*3600 = NULL makes the comparison NULL (falsy),
  // which would exclude a just-played song FOREVER once last_played_at is set. Coalesce to a 3h
  // default so this is a rolling separation window, not a permanent ban.
  cond += " AND (s.last_played_at IS NULL OR s.last_played_at < (unixepoch() - COALESCE(s.no_repeat_hours, 3) * 3600))";

  // Artist separation: exclude any artist whose songs were played recently.
  // Uses artist_separation_min from separation_rules DB table (converted to seconds).
  // The subquery finds all artist_ids with a recent spin, then excludes them.
  //
  // NOTE: `songs` is a single SHARED library — it has NO station_id column (stations
  // differentiate via clocks/shows/schedule, which are station-scoped). A prior
  // `s2.station_id = ?` here referenced a column that doesn't exist, so this whole
  // condition threw at runtime — silently collapsing every live-pick path (clock /
  // SmartRule / random) back to generated_schedule. The subquery is correctly NOT
  // station-scoped. (`stationId` is retained in the signature for parity / future use.)
  cond += ` AND (s.artist_id IS NULL OR s.artist_id NOT IN (
    SELECT DISTINCT s2.artist_id FROM songs s2
    WHERE s2.artist_id IS NOT NULL AND s2.last_played_at > (unixepoch() - ?)
  ))`;
  params.push(sep.artist_sep_sec);

  return cond;
}

// ── Pick songs matching current rule ──────────────────────────

async function pickSongsForRule(
  rule: SmartRule,
  count: number,
  sep: SepRules,
  blockExplicit: boolean,
  stationId: number,
  categoryIds?: number[]
): Promise<Song[]> {
  const hour = new Date().getHours();
  const params: any[] = [];

  let conditions = buildBaseConditions(hour, sep, blockExplicit, params, stationId);

  // Stay ON FORMAT: restrict to the rotation category universe (active clock's cats, or
  // the categories of active-show clocks) so a SmartRule top-up can't pull off-rotation
  // categories like Christmas from a dormant seasonal clock.
  if (categoryIds && categoryIds.length) {
    conditions += ` AND s.category_id IN (${categoryIds.map(() => "?").join(",")})`;
    params.push(...categoryIds);
  }

  // Energy filter
  const ef = energyFilter(rule.energyLevel);
  if (ef) conditions += " " + ef;

  // BPM filter
  if (rule.bpmMin) {
    conditions += " AND (s.bpm >= ? OR s.bpm IS NULL)";
    params.push(rule.bpmMin);
  }
  if (rule.bpmMax) {
    conditions += " AND (s.bpm <= ? OR s.bpm IS NULL)";
    params.push(rule.bpmMax);
  }

  // Genre filter — from SmartRule.genres
  if (rule.genres && rule.genres.length > 0) {
    const placeholders = rule.genres.map(() => "?").join(",");
    conditions += ` AND (s.genre IN (${placeholders}) OR s.genre IS NULL)`;
    params.push(...rule.genres);
    console.log(`[loggen] RULE: genre restricted to [${rule.genres.join(", ")}]`);
  }

  params.push(count * 3); // fetch 3× and shuffle for variety

  const sql = `
    SELECT s.id, s.title, a.name as artist_name, s.file_path,
           s.duration_ms, s.bpm, s.energy, s.intro_end, s.outro_start
    FROM songs s
    LEFT JOIN artists a ON a.id = s.artist_id
    WHERE ${conditions}
    ORDER BY RANDOM()
    LIMIT ?
  `;

  const songs = await query<Song>(sql, params);
  const shuffled = songs.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

// ── Fallback: filtered random — same safety rules always apply ─
//
// The fallback path is NOT a free pass. Every base rotation rule
// (inactive, daypart, explicit, separation) still applies here.

async function pickRandom(
  count: number,
  sep: SepRules,
  blockExplicit: boolean,
  stationId: number,
  categoryIds?: number[]
): Promise<Song[]> {
  const hour = new Date().getHours();
  const params: any[] = [];
  let conditions = buildBaseConditions(hour, sep, blockExplicit, params, stationId);
  // Stay ON FORMAT: when given a category set (the active clock's categories, or the
  // in-rotation categories), the last-resort random pull is restricted to them so
  // seasonal / off-rotation categories like Christmas never leak into the queue.
  if (categoryIds && categoryIds.length) {
    conditions += ` AND s.category_id IN (${categoryIds.map(() => "?").join(",")})`;
    params.push(...categoryIds);
  }
  params.push(count);

  return query<Song>(
    `SELECT s.id, s.title, a.name as artist_name, s.file_path,
            s.duration_ms, s.bpm, s.energy, s.intro_end, s.outro_start
     FROM songs s
     LEFT JOIN artists a ON a.id = s.artist_id
     WHERE ${conditions}
     ORDER BY RANDOM() LIMIT ?`,
    params
  );
}

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

// ── On-format category universe ───────────────────────────────
//
// The set of category_ids the auto-filler is allowed to pull from when it falls back
// past the active clock (SmartRule top-up, filtered random, hour-boundary fallback).
//   • With an active clock now → that clock's own music categories.
//   • Otherwise → categories from clocks that an ACTIVE SHOW actually uses. This is the
//     fix for the Christmas leak: a dormant seasonal clock (e.g. a "Christmas" clock with
//     no scheduled show) must NOT contribute its category to the rotation universe — so
//     Christmas only airs when a Christmas show is genuinely scheduled. (The old code used
//     `DISTINCT category_id FROM clock_slots` across ALL clocks, dormant ones included.)
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

async function pickSongsFromClock(
  clockId: number,
  count: number,
  sep: SepRules,
  blockExplicit: boolean,
  stationId: number
): Promise<Song[]> {
  const slots = await query<ClockSlotRow>(
    `SELECT category_id FROM clock_slots
     WHERE clock_id = ? AND slot_type = 'music' AND category_id IS NOT NULL AND station_id = ?
     ORDER BY position`,
    [clockId, stationId]
  );
  if (slots.length === 0) {
    console.warn(`[loggen] Clock ${clockId} has no music slots with categories assigned`);
    return [];
  }
  console.log(`[loggen] Clock ${clockId}: ${slots.length} music slots`);

  const hour = new Date().getHours();
  const songs: Song[] = [];
  const usedIds: number[] = [];

  for (const slot of slots) {
    if (songs.length >= count) break;

    const params: any[] = [];
    let cond = buildBaseConditions(hour, sep, blockExplicit, params, stationId);
    cond += " AND s.category_id = ?";
    params.push(slot.category_id);

    if (usedIds.length > 0) {
      cond += ` AND s.id NOT IN (${usedIds.map(() => "?").join(",")})`;
      params.push(...usedIds);
    }
    params.push(1); // LIMIT

    const rows = await query<Song>(
      `SELECT s.id, s.title, a.name as artist_name, s.file_path,
              s.duration_ms, s.bpm, s.energy, s.intro_end, s.outro_start
       FROM songs s LEFT JOIN artists a ON a.id = s.artist_id
       WHERE ${cond}
       ORDER BY RANDOM() LIMIT ?`,
      params
    );
    if (rows.length > 0) {
      songs.push(rows[0]);
      usedIds.push(rows[0].id);
    }
  }

  return songs;
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

    console.log("[loggen] generated_schedule empty — falling back to live picking");

    // ENFORCE-SEPARATION (slice 3): when ON, use the enforced picker (LRP eligible from play_log, relax
    // only on exhaustion) and SKIP the clock/rule/random ladder + BPM reorder (order is rest-driven).
    // Falls through to the legacy ladder only if enforced picking yields nothing (never dead air).
    if (await enforceSeparationOn(stationId)) {
      const enforced = await enforcedFill(targetCount, stationId);
      if (enforced.length) {
        const items = enforced.map(s => ({ filePath: s.file_path, title: s.title, artist: s.artist_name || "", introEnd: s.intro_end ?? undefined, outroStart: s.outro_start ?? undefined, durationMs: s.duration_ms ?? 0 }));
        engine.addToQueue(items);
        console.log(`[loggen] fillQueue: source=enforced | ${items.length} tracks`);
        return items.length;
      }
    }

    const sep  = await getSepRules(stationId);
    const { blockExplicit } = getContentFilter();
    let songs: Song[] = [];
    let source = "random";

    // ── Priority 2: active show's format clock ────────────────
    const showClock = await getActiveShowClock(stationId);
    if (showClock) {
      songs = await pickSongsFromClock(showClock.clockId, targetCount, sep, blockExplicit, stationId);
      source = `clock "${showClock.showName}"`;
    }

    // On-format category universe for the fallback paths below: the active clock's cats,
    // or (no active clock) the cats of clocks that ACTIVE SHOWS use — never a dormant
    // seasonal clock. Empty = station isn't using clocks → no restriction (legacy behavior).
    const formatCats = await getFormatCategoryIds(stationId, showClock?.clockId);

    // ── Priority 3: localStorage SmartRules ───────────────────
    if (songs.length < targetCount / 2) {
      const rule = getActiveRule();
      if (rule) {
        const ruleSongs = await pickSongsForRule(rule, targetCount - songs.length, sep, blockExplicit, stationId, formatCats);
        songs = [...songs, ...ruleSongs];
        source = showClock ? `${source} + rule "${rule.description}"` : `rule "${rule.description}"`;
      }
    }

    // ── Priority 4: filtered random — but STAY ON FORMAT ──────
    if (songs.length < targetCount / 2) {
      const extra = await pickRandom(targetCount - songs.length, sep, blockExplicit, stationId, formatCats);
      songs = [...songs, ...extra];
      if (songs.length > 0 && source === "random") source = "random (on-format)";
    }
    console.log(`[loggen] on-format categories: [${formatCats.join(", ") || "unrestricted"}] (clock=${showClock?.clockId ?? "none"})`);

    console.log(`[loggen] fillQueue: source=${source} | hour=${hour} | artistSep=${sep.artist_sep_sec / 60}min`);

    if (songs.length === 0) {
      console.warn(
        "[loggen] WARNING: No eligible songs found. Check rotation_status, daypart_mask, and separation rules."
      );
      return 0;
    }

    songs = orderByBpmFlow(songs);

    const items = songs.map(s => ({
      filePath:    s.file_path,
      title:       s.title,
      artist:      s.artist_name || "",
      introEnd:    s.intro_end ?? undefined,
      outroStart:  s.outro_start ?? undefined,
      durationMs:  s.duration_ms ?? 0,
    }));

    engine.addToQueue(items);
    return items.length;
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

// ── BPM flow ordering ─────────────────────────────────────────
//
// Reorders a song list so adjacent tracks are within ±15 BPM.
// Uses a greedy nearest-neighbor approach starting from the first song.
// Songs without BPM data slot in anywhere (treated as compatible).

function orderByBpmFlow(songs: Song[]): Song[] {
  if (songs.length <= 2) return songs;
  const hasBpm = songs.filter(s => s.bpm && s.bpm > 0);
  const noBpm  = songs.filter(s => !s.bpm || s.bpm <= 0);
  if (hasBpm.length <= 1) return songs;

  // Greedy nearest-neighbor by BPM
  const ordered: Song[] = [hasBpm[0]];
  const remaining = new Set(hasBpm.slice(1));

  while (remaining.size > 0) {
    const lastBpm = ordered[ordered.length - 1].bpm!;
    let best: Song | null = null;
    let bestDist = Infinity;
    for (const s of remaining) {
      const dist = Math.abs(s.bpm! - lastBpm);
      if (dist < bestDist) { best = s; bestDist = dist; }
    }
    if (best) { ordered.push(best); remaining.delete(best); }
  }

  // Interleave no-BPM songs evenly throughout the ordered list
  if (noBpm.length > 0) {
    const step = Math.max(1, Math.floor(ordered.length / (noBpm.length + 1)));
    for (let i = 0; i < noBpm.length; i++) {
      const pos = Math.min(ordered.length, (i + 1) * step);
      ordered.splice(pos, 0, noBpm[i]);
    }
  }

  return ordered;
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
