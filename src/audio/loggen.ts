import { query, queryOne, execute } from "../db/client";
import { engine } from "./engine";

interface SlotDef {
  id: number; position: number; slot_type: string;
  category_id: number | null; duration_min: number;
}

interface SongCandidate {
  id: number; title: string; file_path: string;
  artist_name: string | null; last_played_at: number | null;
  spins_total: number;
}

// Get the clock assigned to the current day + hour
// Check if a show covers the current hour and has a clock assigned
async function getClockFromShow(): Promise<number | null> {
  const now = new Date();
  const hour = now.getHours();
  const shows = await query<{ id: number; start_hour: number; end_hour: number; clock_id: number | null }>("SELECT * FROM shows WHERE is_active = 1 AND clock_id IS NOT NULL");
  for (const s of shows) {
    if (s.end_hour > s.start_hour) {
      if (hour >= s.start_hour && hour < s.end_hour) return s.clock_id;
    } else {
      // Wraps midnight (e.g. 19-6)
      if (hour >= s.start_hour || hour < s.end_hour) return s.clock_id;
    }
  }
  return null;
}

async function getClockForNow(): Promise<number | null> {
  const now = new Date();
  const day = now.getDay(); // 0=Sun
  const hour = now.getHours();
  // Check shows first, then fall back to grid
  const fromShow = await getClockFromShow();
  if (fromShow) return fromShow;
  const row = await queryOne<{ clock_id: number }>("SELECT clock_id FROM schedule_grid WHERE day_of_week = ? AND hour = ?", [day, hour]);
  return row ? row.clock_id : null;
}

// Get slots for a clock
async function getClockSlots(clockId: number): Promise<SlotDef[]> {
  return query<SlotDef>("SELECT * FROM clock_slots WHERE clock_id = ? ORDER BY position", [clockId]);
}

// Pick the best song from a category (least recently played, fewest spins)
async function pickSong(categoryId: number, avoid: number[]): Promise<SongCandidate | null> {
  const avoidStr = avoid.length > 0 ? " AND s.id NOT IN (" + avoid.join(",") + ")" : "";
  const rows = await query<SongCandidate>(
    "SELECT s.id, s.title, s.file_path, a.name as artist_name, s.last_played_at, s.spins_total " +
    "FROM songs s LEFT JOIN artists a ON a.id = s.artist_id " +
    "WHERE s.category_id = ? AND s.file_path IS NOT NULL AND s.rotation_status = 'active'" + avoidStr + " " +
    "ORDER BY s.last_played_at ASC NULLS FIRST, s.spins_total ASC, RANDOM() LIMIT 1",
    [categoryId]
  );
  return rows.length > 0 ? rows[0] : null;
}

// Pick a random song from any category (fallback)
async function pickAnySong(avoid: number[]): Promise<SongCandidate | null> {
  const avoidStr = avoid.length > 0 ? " AND s.id NOT IN (" + avoid.join(",") + ")" : "";
  const rows = await query<SongCandidate>(
    "SELECT s.id, s.title, s.file_path, a.name as artist_name, s.last_played_at, s.spins_total " +
    "FROM songs s LEFT JOIN artists a ON a.id = s.artist_id " +
    "WHERE s.file_path IS NOT NULL" + avoidStr + " " +
    "ORDER BY RANDOM() LIMIT 1"
  );
  return rows.length > 0 ? rows[0] : null;
}

// Mark a song as played
async function markPlayed(songId: number): Promise<void> {
  await execute("UPDATE songs SET last_played_at = unixepoch(), spins_total = spins_total + 1, updated_at = unixepoch() WHERE id = ?", [songId]);
}

// ============================================================
// MAIN: Generate a log hour from the current clock
// ============================================================

export interface LogItem {
  slotType: string;
  songId: number | null;
  title: string;
  artist: string;
  filePath: string;
  categoryId: number | null;
}

export async function generateLogHour(): Promise<LogItem[]> {
  const clockId = await getClockForNow();
  if (!clockId) {
    console.log("No clock assigned for current hour, falling back to random");
    return generateRandomHour();
  }

  const slots = await getClockSlots(clockId);
  if (slots.length === 0) {
    console.log("Clock has no slots, falling back to random");
    return generateRandomHour();
  }

  const log: LogItem[] = [];
  const usedIds: number[] = [];

  for (const slot of slots) {
    if (slot.slot_type === "music" && slot.category_id) {
      const song = await pickSong(slot.category_id, usedIds);
      if (song) {
        log.push({
          slotType: "music",
          songId: song.id,
          title: song.title,
          artist: song.artist_name || "",
          filePath: song.file_path,
          categoryId: slot.category_id,
        });
        usedIds.push(song.id);
      } else {
        // Category empty, pick from any
        const any = await pickAnySong(usedIds);
        if (any) {
          log.push({ slotType: "music", songId: any.id, title: any.title, artist: any.artist_name || "", filePath: any.file_path, categoryId: null });
          usedIds.push(any.id);
        }
      }
    } else if (slot.slot_type === "spot_break") {
      log.push({ slotType: "spot_break", songId: null, title: "--- BREAK ---", artist: "", filePath: "", categoryId: null });
    } else if (slot.slot_type === "liner" || slot.slot_type === "sweeper" || slot.slot_type === "jingle") {
      log.push({ slotType: slot.slot_type, songId: null, title: "--- " + slot.slot_type.toUpperCase() + " ---", artist: "", filePath: "", categoryId: null });
    }
  }

  return log;
}

// Fallback: random songs when no clock is assigned
async function generateRandomHour(): Promise<LogItem[]> {
  const rows = await query<SongCandidate>(
    "SELECT s.id, s.title, s.file_path, a.name as artist_name, s.last_played_at, s.spins_total " +
    "FROM songs s LEFT JOIN artists a ON a.id = s.artist_id " +
    "WHERE s.file_path IS NOT NULL ORDER BY RANDOM() LIMIT 15"
  );
  return rows.map(s => ({ slotType: "music", songId: s.id, title: s.title, artist: s.artist_name || "", filePath: s.file_path, categoryId: null }));
}

// ============================================================
// Fill the engine queue from a generated log
// ============================================================

export async function fillQueueFromSchedule(): Promise<number> {
  const log = await generateLogHour();
  const musicItems = log.filter(l => l.slotType === "music" && l.filePath);
  engine.addToQueue(musicItems.map(l => ({ filePath: l.filePath, title: l.title, artist: l.artist })));

  // Mark songs as played
  for (const item of musicItems) {
    if (item.songId) await markPlayed(item.songId);
  }

  return musicItems.length;
}

// Auto-refill: called by engine when queue runs dry in continuous mode
export async function refillFromSchedule(): Promise<{ filePath: string; title: string; artist: string }[]> {
  const log = await generateLogHour();
  const musicItems = log.filter(l => l.slotType === "music" && l.filePath);
  for (const item of musicItems) {
    if (item.songId) await markPlayed(item.songId);
  }
  return musicItems.map(l => ({ filePath: l.filePath, title: l.title, artist: l.artist }));
}