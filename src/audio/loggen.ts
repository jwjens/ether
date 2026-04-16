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
import { engine } from "./engine-rodio";

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

async function getSepRules(): Promise<SepRules> {
  try {
    const rows = await query<{ rule_type: string; value: number }>(
      "SELECT rule_type, value FROM separation_rules WHERE is_active = 1"
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
  params: any[]
): string {
  let cond = "s.file_path IS NOT NULL";

  // Never auto-play songs marked inactive in rotation
  cond += " AND s.rotation_status != 'inactive'";

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
  cond += " AND (s.last_played_at IS NULL OR s.last_played_at < (unixepoch() - s.no_repeat_hours * 3600))";

  // Artist separation: exclude any artist whose songs were played recently.
  // Uses artist_separation_min from separation_rules DB table (converted to seconds).
  // The subquery finds all artist_ids with a recent spin, then excludes them.
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
  blockExplicit: boolean
): Promise<Song[]> {
  const hour = new Date().getHours();
  const params: any[] = [];

  let conditions = buildBaseConditions(hour, sep, blockExplicit, params);

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
  blockExplicit: boolean
): Promise<Song[]> {
  const hour = new Date().getHours();
  const params: any[] = [];
  const conditions = buildBaseConditions(hour, sep, blockExplicit, params);
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

async function getActiveShowClock(): Promise<{ clockId: number; showName: string } | null> {
  try {
    const hour = new Date().getHours();
    const day  = String(new Date().getDay());

    // Fetch all active shows with clocks and evaluate the hour range in JS
    // (avoids complex SQL for overnight / midnight-ending shows)
    const rows = await query<{
      clock_id: number; name: string;
      start_hour: number; end_hour: number; days: string;
    }>(
      `SELECT clock_id, name, start_hour, end_hour, days
       FROM shows WHERE is_active = 1 AND clock_id IS NOT NULL`
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
        return { clockId: row.clock_id, showName: row.name };
      }
    }

    console.log(`[loggen] No active show with clock found for hour ${hour} day ${day}`);
    return null;
  } catch (e) {
    console.error("[loggen] getActiveShowClock error:", e);
    return null;
  }
}

async function pickSongsFromClock(
  clockId: number,
  count: number,
  sep: SepRules,
  blockExplicit: boolean
): Promise<Song[]> {
  const slots = await query<ClockSlotRow>(
    `SELECT category_id FROM clock_slots
     WHERE clock_id = ? AND slot_type = 'music' AND category_id IS NOT NULL
     ORDER BY position`,
    [clockId]
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
    let cond = buildBaseConditions(hour, sep, blockExplicit, params);
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

// ── Main export: fill the queue ────────────────────────────────

export async function fillQueueFromSchedule(targetCount = 20): Promise<number> {
  try {
    const sep  = await getSepRules();
    const { blockExplicit } = getContentFilter();
    const hour = new Date().getHours();
    maybeDaypartLog(hour);

    let songs: Song[] = [];
    let source = "random";

    // ── Priority 1: active show's format clock ────────────────
    const showClock = await getActiveShowClock();
    if (showClock) {
      songs = await pickSongsFromClock(showClock.clockId, targetCount, sep, blockExplicit);
      source = `clock "${showClock.showName}"`;
    }

    // ── Priority 2: localStorage SmartRules ───────────────────
    if (songs.length < targetCount / 2) {
      const rule = getActiveRule();
      if (rule) {
        const ruleSongs = await pickSongsForRule(rule, targetCount - songs.length, sep, blockExplicit);
        songs = [...songs, ...ruleSongs];
        source = showClock ? `${source} + rule "${rule.description}"` : `rule "${rule.description}"`;
      }
    }

    // ── Priority 3: filtered random ───────────────────────────
    if (songs.length < targetCount / 2) {
      const extra = await pickRandom(targetCount - songs.length, sep, blockExplicit);
      songs = [...songs, ...extra];
      if (songs.length > 0 && source === "random") source = "random (no show/rules matched)";
    }

    console.log(
      `[loggen] fillQueue: source=${source} | ` +
      `hour=${hour} | blockExplicit=${blockExplicit} | ` +
      `artistSep=${sep.artist_sep_sec / 60}min`
    );

    if (songs.length === 0) {
      console.warn(
        "[loggen] WARNING: No eligible songs found after applying all rotation rules. " +
        "Check that songs are not all marked inactive, that daypart masks allow the " +
        "current hour, and that separation rules are not too strict."
      );
      return 0;
    }

    // ── BPM/energy flow ordering (GSelector-style) ─────────────
    // Reorder the selected songs so adjacent tracks transition smoothly.
    // Each next song should be within ±15 BPM of the previous one when possible.
    // Songs without BPM data are placed anywhere (no penalty).
    songs = orderByBpmFlow(songs);

    console.log(`[loggen] Queuing ${songs.length} songs: ${songs.map(s => `"${s.title}" (${s.bpm ? Math.round(s.bpm) + 'bpm' : '?'})`).join(", ")}`);

    const items = songs.map(s => ({
      filePath:    s.file_path,
      title:       s.title,
      artist:      s.artist_name || "",
      introEnd:    s.intro_end ?? undefined,
      outroStart:  s.outro_start ?? undefined,
    }));

    engine.addToQueue(items);
    return items.length;
  } catch (e) {
    console.error("[loggen] fillQueueFromSchedule failed:", e);
    return 0;
  }
}

export async function refillFromSchedule(): Promise<void> {
  const queueLen = engine.getQueue().length;
  if (queueLen < 5) {
    await fillQueueFromSchedule(20 - queueLen);
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
