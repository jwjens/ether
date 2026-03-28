// src/audio/loggen.ts
//
// Queue filling engine — reads Smart Scheduler rules and picks
// songs that match the current time slot's BPM and energy requirements.
//
// Falls back to random if no rules match or library isn't analyzed yet.

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

// ── Energy level → SQL filter ──────────────────────────────────

function energyFilter(level: "high" | "medium" | "low" | "mixed"): string {
  switch (level) {
    case "high":   return "AND (energy >= 0.55 OR energy IS NULL)";
    case "medium": return "AND (energy BETWEEN 0.25 AND 0.65 OR energy IS NULL)";
    case "low":    return "AND (energy <= 0.35 OR energy IS NULL)";
    case "mixed":  return ""; // no filter
  }
}

// ── Pick songs matching current rule ──────────────────────────

async function pickSongsForRule(rule: SmartRule, count: number): Promise<Song[]> {
  let conditions = "s.file_path IS NOT NULL";
  const params: any[] = [];

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

  // Genre filter
  if (rule.genres && rule.genres.length > 0) {
    const placeholders = rule.genres.map(() => "?").join(",");
    conditions += ` AND (s.genre IN (${placeholders}) OR s.genre IS NULL)`;
    params.push(...rule.genres);
  }

  // Avoid recently played (last 2 hours)
  const twoHoursAgo = Math.floor(Date.now() / 1000) - 7200;
  conditions += " AND (s.last_played_at IS NULL OR s.last_played_at < ?)";
  params.push(twoHoursAgo);

  params.push(count * 3); // fetch 3x and pick randomly

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

  // Shuffle and take count
  const shuffled = songs.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

// ── Fallback: pure random ──────────────────────────────────────

async function pickRandom(count: number): Promise<Song[]> {
  return query<Song>(
    `SELECT s.id, s.title, a.name as artist_name, s.file_path,
            s.duration_ms, s.bpm, s.energy, s.intro_end, s.outro_start
     FROM songs s
     LEFT JOIN artists a ON a.id = s.artist_id
     WHERE s.file_path IS NOT NULL
     ORDER BY RANDOM() LIMIT ?`,
    [count]
  );
}

// ── Main export: fill the queue ────────────────────────────────

export async function fillQueueFromSchedule(targetCount = 20): Promise<number> {
  try {
    const rule = getActiveRule();
    let songs: Song[];

    if (rule) {
      songs = await pickSongsForRule(rule, targetCount);

      // If filter was too strict and returned < half, pad with random
      if (songs.length < targetCount / 2) {
        const extra = await pickRandom(targetCount - songs.length);
        songs = [...songs, ...extra];
      }
    } else {
      songs = await pickRandom(targetCount);
    }

    if (songs.length === 0) return 0;

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
