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

import { query, execute } from "../db/client";
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

// ── Main export: fill the queue ────────────────────────────────

export async function fillQueueFromSchedule(targetCount = 20): Promise<number> {
  try {
    const rule = getActiveRule();
    const sep  = await getSepRules();
    const { blockExplicit } = getContentFilter();

    console.log(
      `[loggen] fillQueue: rule="${rule?.description ?? "none"}" | ` +
      `blockExplicit=${blockExplicit} | ` +
      `artistSep=${sep.artist_sep_sec / 60}min | ` +
      `songSep=${sep.song_sep_sec / 60}min | ` +
      `hour=${new Date().getHours()}`
    );

    let songs: Song[];

    if (rule) {
      songs = await pickSongsForRule(rule, targetCount, sep, blockExplicit);

      // If filters returned fewer than half the target, pad with filtered random.
      // Filtered random still obeys all base rules — it just drops the SmartRule
      // energy/BPM/genre constraints.
      if (songs.length < targetCount / 2) {
        console.warn(
          `[loggen] Rule "${rule.description}" returned ${songs.length}/${targetCount} ` +
          `eligible songs — padding with filtered random (all rotation rules still apply)`
        );
        const extra = await pickRandom(targetCount - songs.length, sep, blockExplicit);
        songs = [...songs, ...extra];
      }
    } else {
      songs = await pickRandom(targetCount, sep, blockExplicit);
    }

    if (songs.length === 0) {
      console.warn(
        "[loggen] WARNING: No eligible songs found after applying all rotation rules. " +
        "Check that songs are not all marked inactive, that daypart masks allow the " +
        "current hour, and that separation rules are not too strict."
      );
      return 0;
    }

    console.log(`[loggen] Queuing ${songs.length} songs: ${songs.map(s => `"${s.title}"`).join(", ")}`);

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

// ── Queue status info for the UI ──────────────────────────────

export function getScheduleStatus(): { rule: SmartRule | null; description: string } {
  const rule = getActiveRule();
  if (!rule) return { rule: null, description: "Random" };
  return {
    rule,
    description: rule.description,
  };
}
