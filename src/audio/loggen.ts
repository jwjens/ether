import { query, queryOne, execute } from "../db/client";
import { engine } from "./engine";

interface SlotDef {
  id: number; position: number; slot_type: string;
  category_id: number | null; duration_min: number;
}

interface SongCandidate {
  id: number; title: string; file_path: string;
  artist_id: number | null; artist_name: string | null;
  category_id: number | null; gender: string;
  last_played_at: number | null; spins_total: number; gain_db: number;
}

interface SepRule {
  rule_type: string; value: number; is_hard: number;
}

interface RecentPlay {
  song_id: number; title: string; artist: string | null;
  artist_id: number | null; category_id: number | null;
  gender: string | null; played_at: number;
}

// ============================================================
// SCORING ENGINE — rates each candidate
// ============================================================

async function getRules(): Promise<SepRule[]> {
  return query<SepRule>("SELECT rule_type, value, is_hard FROM separation_rules WHERE is_active = 1");
}

async function getRecentPlays(minutes: number): Promise<RecentPlay[]> {
  const cutoff = Math.floor(Date.now() / 1000) - (minutes * 60);
  return query<RecentPlay>(
    "SELECT pl.title, pl.artist, s.artist_id, s.category_id, s.gender, pl.played_at, s.id as song_id " +
    "FROM play_log pl LEFT JOIN songs s ON s.title = pl.title " +
    "WHERE pl.played_at > ? ORDER BY pl.played_at DESC", [cutoff]
  );
}

function scoreSong(song: SongCandidate, recent: RecentPlay[], rules: SepRule[], usedInHour: number[]): { score: number; violations: string[] } {
  let score = 1000;
  const violations: string[] = [];
  const nowSec = Math.floor(Date.now() / 1000);

  // Skip if already used this hour
  if (usedInHour.includes(song.id)) return { score: -99999, violations: ["already scheduled this hour"] };

  for (const rule of rules) {
    const penalty = rule.is_hard ? 10000 : 100;

    if (rule.rule_type === "song_separation_min") {
      const lastPlay = recent.find(r => r.song_id === song.id);
      if (lastPlay) {
        const minsSince = (nowSec - lastPlay.played_at) / 60;
        if (minsSince < rule.value) {
          score -= penalty;
          violations.push("song played " + Math.floor(minsSince) + "m ago (min " + rule.value + ")");
        }
      }
    }

    if (rule.rule_type === "artist_separation_min" && song.artist_id) {
      const lastArtist = recent.find(r => r.artist_id === song.artist_id);
      if (lastArtist) {
        const minsSince = (nowSec - lastArtist.played_at) / 60;
        if (minsSince < rule.value) {
          score -= penalty;
          violations.push("artist played " + Math.floor(minsSince) + "m ago (min " + rule.value + ")");
        }
      }
    }

    if (rule.rule_type === "title_separation_min") {
      const lastTitle = recent.find(r => r.title.toLowerCase() === song.title.toLowerCase() && r.song_id !== song.id);
      if (lastTitle) {
        const minsSince = (nowSec - lastTitle.played_at) / 60;
        if (minsSince < rule.value) {
          score -= penalty;
          violations.push("same title played " + Math.floor(minsSince) + "m ago");
        }
      }
    }

    if (rule.rule_type === "max_same_gender" && song.gender && song.gender !== "unknown") {
      let consecutive = 0;
      for (const r of recent) {
        if (r.gender === song.gender) consecutive++;
        else break;
      }
      if (consecutive >= rule.value) {
        score -= penalty;
        violations.push(consecutive + " consecutive " + song.gender + " (max " + rule.value + ")");
      }
    }

    if (rule.rule_type === "max_same_category" && song.category_id) {
      let consecutive = 0;
      for (const r of recent) {
        if (r.category_id === song.category_id) consecutive++;
        else break;
      }
      if (consecutive >= rule.value) {
        score -= penalty;
        violations.push(consecutive + " consecutive from same category (max " + rule.value + ")");
      }
    }
  }

  // Bonus: prefer songs that havent played recently
  if (!song.last_played_at) score += 50;
  else {
    const hoursSince = (nowSec - song.last_played_at) / 3600;
    score += Math.min(hoursSince * 2, 100);
  }

  // Bonus: prefer lower spin counts
  score -= Math.min(song.spins_total * 2, 200);

  return { score, violations };
}

// ============================================================
// PICK BEST SONG — scores all candidates, returns the winner
// ============================================================

async function pickBestSong(categoryId: number, recent: RecentPlay[], rules: SepRule[], usedInHour: number[]): Promise<SongCandidate | null> {
  const candidates = await query<SongCandidate>(
    "SELECT s.id, s.title, s.file_path, s.artist_id, a.name as artist_name, s.category_id, s.gender, s.last_played_at, s.spins_total, s.gain_db " +
    "FROM songs s LEFT JOIN artists a ON a.id = s.artist_id " +
    "WHERE s.category_id = ? AND s.file_path IS NOT NULL AND s.rotation_status = 'active' " +
    "ORDER BY s.last_played_at ASC NULLS FIRST, RANDOM() LIMIT 50",
    [categoryId]
  );

  if (candidates.length === 0) return null;

  let bestSong = candidates[0];
  let bestScore = -99999;

  for (const c of candidates) {
    const { score } = scoreSong(c, recent, rules, usedInHour);
    if (score > bestScore) {
      bestScore = score;
      bestSong = c;
    }
  }

  // If best score is still deeply negative (all hard rules violated),
  // still return the best option — prevents dead air
  return bestSong;
}

async function pickAnySong(recent: RecentPlay[], rules: SepRule[], usedInHour: number[]): Promise<SongCandidate | null> {
  const candidates = await query<SongCandidate>(
    "SELECT s.id, s.title, s.file_path, s.artist_id, a.name as artist_name, s.category_id, s.gender, s.last_played_at, s.spins_total " +
    "FROM songs s LEFT JOIN artists a ON a.id = s.artist_id " +
    "WHERE s.file_path IS NOT NULL AND s.rotation_status = 'active' " +
    "ORDER BY RANDOM() LIMIT 30"
  );
  if (candidates.length === 0) return null;
  let best = candidates[0];
  let bestScore = -99999;
  for (const c of candidates) {
    const { score } = scoreSong(c, recent, rules, usedInHour);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

// ============================================================
// CLOCK LOOKUP
// ============================================================

async function getClockFromShow(): Promise<number | null> {
  const now = new Date();
  const hour = now.getHours();
  const shows = await query<{ id: number; start_hour: number; end_hour: number; clock_id: number | null }>("SELECT * FROM shows WHERE is_active = 1 AND clock_id IS NOT NULL");
  for (const s of shows) {
    if (s.end_hour > s.start_hour) {
      if (hour >= s.start_hour && hour < s.end_hour) return s.clock_id;
    } else {
      if (hour >= s.start_hour || hour < s.end_hour) return s.clock_id;
    }
  }
  return null;
}

async function getClockForNow(): Promise<number | null> {
  const fromShow = await getClockFromShow();
  if (fromShow) return fromShow;
  const now = new Date();
  const row = await queryOne<{ clock_id: number }>("SELECT clock_id FROM schedule_grid WHERE day_of_week = ? AND hour = ?", [now.getDay(), now.getHours()]);
  return row ? row.clock_id : null;
}

async function getClockSlots(clockId: number): Promise<SlotDef[]> {
  return query<SlotDef>("SELECT * FROM clock_slots WHERE clock_id = ? ORDER BY position", [clockId]);
}

async function markPlayed(songId: number): Promise<void> {
  await execute("UPDATE songs SET last_played_at = unixepoch(), spins_total = spins_total + 1, updated_at = unixepoch() WHERE id = ?", [songId]);
}

// ============================================================
// GENERATE LOG HOUR
// ============================================================

export interface LogItem {
  slotType: string; songId: number | null;
  title: string; artist: string; filePath: string;
  categoryId: number | null; violations: string[];
}

export async function generateLogHour(): Promise<LogItem[]> {
  const clockId = await getClockForNow();
  const rules = await getRules();
  const recent = await getRecentPlays(240);

  if (!clockId) {
    console.log("No clock assigned, falling back to scored random");
    return generateScoredRandom(rules, recent);
  }

  const slots = await getClockSlots(clockId);
  if (slots.length === 0) return generateScoredRandom(rules, recent);

  const log: LogItem[] = [];
  const usedIds: number[] = [];

  for (const slot of slots) {
    if (slot.slot_type === "music" && slot.category_id) {
      const song = await pickBestSong(slot.category_id, recent, rules, usedIds);
      if (song) {
        const { violations } = scoreSong(song, recent, rules, usedIds);
        log.push({ slotType: "music", songId: song.id, title: song.title, artist: song.artist_name || "", filePath: song.file_path, categoryId: slot.category_id, violations });
        usedIds.push(song.id);
        // Add to recent for subsequent scoring this hour
        recent.unshift({ song_id: song.id, title: song.title, artist: song.artist_name || null, artist_id: song.artist_id, category_id: song.category_id, gender: song.gender, played_at: Math.floor(Date.now() / 1000) });
      } else {
        const any = await pickAnySong(recent, rules, usedIds);
        if (any) {
          log.push({ slotType: "music", songId: any.id, title: any.title, artist: any.artist_name || "", filePath: any.file_path, categoryId: null, violations: ["category empty, fallback"] });
          usedIds.push(any.id);
        }
      }
    } else if (slot.slot_type !== "music") {
      log.push({ slotType: slot.slot_type, songId: null, title: "--- " + slot.slot_type.toUpperCase() + " ---", artist: "", filePath: "", categoryId: null, violations: [] });
    }
  }

  return log;
}

async function generateScoredRandom(rules: SepRule[], recent: RecentPlay[]): Promise<LogItem[]> {
  const log: LogItem[] = [];
  const usedIds: number[] = [];
  for (let i = 0; i < 15; i++) {
    const song = await pickAnySong(recent, rules, usedIds);
    if (song) {
      const { violations } = scoreSong(song, recent, rules, usedIds);
      log.push({ slotType: "music", songId: song.id, title: song.title, artist: song.artist_name || "", filePath: song.file_path, categoryId: song.category_id, violations });
      usedIds.push(song.id);
      recent.unshift({ song_id: song.id, title: song.title, artist: song.artist_name || null, artist_id: song.artist_id, category_id: song.category_id, gender: song.gender, played_at: Math.floor(Date.now() / 1000) });
    }
  }
  return log;
}

// ============================================================
// PUBLIC API
// ============================================================

export async function fillQueueFromSchedule(): Promise<number> {
  const log = await generateLogHour();
  const musicItems = log.filter(l => l.slotType === "music" && l.filePath);
  engine.addToQueue(musicItems.map(l => ({ filePath: l.filePath, title: l.title, artist: l.artist })));
  for (const item of musicItems) {
    if (item.songId) await markPlayed(item.songId);
  }
  return musicItems.length;
}

export async function refillFromSchedule(): Promise<{ filePath: string; title: string; artist: string }[]> {
  const log = await generateLogHour();
  const musicItems = log.filter(l => l.slotType === "music" && l.filePath);
  for (const item of musicItems) {
    if (item.songId) await markPlayed(item.songId);
  }
  return musicItems.map(l => ({ filePath: l.filePath, title: l.title, artist: l.artist }));
}