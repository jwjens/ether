// src/audio/showClock.ts
//
// Hard top-of-hour show transitions.
//
// At each show's start_hour, executes a hard cut:
//   1. Stop all decks immediately (even mid-song)
//   2. Clear the queue — no runover songs
//   3. Fill from the new show's schedule rules
//   4. Load and play the first new song automatically
//   5. Log the transition to play_log

import { query } from "../db/client";
import { getActiveStationIdSync } from "../hooks/useActiveStation";
import { getEngine } from "./engine-registry";
import { fillQueueFromSchedule, getActiveShowClock } from "./loggen";

interface ShowRow {
  id: number;
  name: string;
  start_hour: number;
  end_hour: number;
  days: string;
  clock_id: number | null;
}

export interface NextTransition {
  showName: string;
  startsAt: Date;
  secondsAway: number;
}

// ── Query helpers ─────────────────────────────────────────────

/** Returns the next upcoming show transition within the next 24 hours, or null. */
export async function getNextTransition(): Promise<NextTransition | null> {
  try {
    const stationId = getActiveStationIdSync();
    const shows = await query<ShowRow>(
      "SELECT id, name, start_hour, end_hour, days FROM shows WHERE is_active = 1 AND station_id = ?",
      [stationId]
    );
    if (shows.length === 0) return null;

    const now = new Date();

    // Walk ahead hour by hour until we find a show boundary
    for (let h = 1; h <= 24; h++) {
      const candidate = new Date(now.getTime() + h * 3_600_000);
      candidate.setMinutes(0, 0, 0); // snap to top of that hour
      const candidateHour = candidate.getHours();
      const candidateDay  = candidate.getDay();

      const show = shows.find(
        s => s.start_hour === candidateHour && s.days.includes(String(candidateDay))
      );
      if (show) {
        const secondsAway = Math.round((candidate.getTime() - now.getTime()) / 1000);
        return { showName: show.name, startsAt: candidate, secondsAway };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ── Transition execution ──────────────────────────────────────

async function executeTransition(showName: string, newHour: number): Promise<void> {
  console.log(`[showClock] ⏰ SHOW TRANSITION → "${showName}" at ${newHour}:00`);

  const engine = getEngine(getActiveStationIdSync());

  // 1. Hard-stop all decks — no fades, no grace period
  engine.getDeck("A")?.stop();
  engine.getDeck("B")?.stop();
  engine.getDeck("C")?.stop();

  // Clear the advancing lock so the engine accepts new commands immediately
  (engine as any).advancing = false;
  (engine as any).endTriggered.clear();

  // 2. Wipe every queued runover song from the outgoing show
  engine.clearQueue();

  // Small yield so the stop commands reach the audio backend before we load
  await new Promise(r => setTimeout(r, 80));

  // 3. Fill from the new hour's schedule rules.
  //    fillQueueFromSchedule calls new Date().getHours() internally, so it
  //    already sees the new show's hour at this point.
  let count = await fillQueueFromSchedule(20);

  // Fallback: if the schedule pickers came up empty, pull rotation-eligible tracks —
  // but stay ON FORMAT. Restrict to the active clock's music categories (e.g. Daytime →
  // Drivetime) so seasonal/off-rotation categories like Christmas never leak in. Only if
  // there's no active clock at all do we widen to "any category used by some clock"
  // (still keeps un-scheduled songs out), and never the whole library.
  if (count === 0) {
    const stationId = getActiveStationIdSync();
    const hour = new Date().getHours();
    const clock = await getActiveShowClock(stationId);
    let cats: number[] = [];
    if (clock) {
      const catRows = await query<{ category_id: number }>(
        `SELECT DISTINCT category_id FROM clock_slots
          WHERE clock_id = ? AND slot_type = 'music' AND category_id IS NOT NULL AND deleted_at IS NULL`,
        [clock.clockId]
      );
      cats = catRows.map(r => r.category_id).filter(c => c != null);
    }
    const catClause = cats.length
      ? `s.category_id IN (${cats.map(() => "?").join(",")})`
      : `s.category_id IN (SELECT DISTINCT category_id FROM clock_slots WHERE category_id IS NOT NULL AND deleted_at IS NULL)`;
    const rows = await query<{ file_path: string; title: string; artist_name: string }>(
      `SELECT s.file_path, s.title, a.name AS artist_name
       FROM songs s LEFT JOIN artists a ON a.id = s.artist_id
       WHERE s.file_path IS NOT NULL AND s.rotation_status != 'inactive'
         AND ((s.daypart_mask >> ?) & 1) = 1
         AND ${catClause}
       ORDER BY RANDOM() LIMIT 20`,
      cats.length ? [hour, ...cats] : [hour]
    );
    engine.addToQueue(rows.map(r => ({
      filePath: r.file_path,
      title:    r.title,
      artist:   r.artist_name || "",
    })));
    count = rows.length;
    console.log(`[showClock] fallback filled ${count} on-format track(s)` + (clock ? ` from clock "${clock.showName}" (${cats.length} cats)` : ` (no active clock — in-rotation cats)`));
  }

  if (count === 0) {
    console.warn(`[showClock] No songs available for "${showName}" — cannot auto-start`);
    return;
  }

  // 4. Load the first song into deck A and start playing immediately.
  //    preloadDeck handles B and C 800 ms later.
  const started = await engine.jumpToNextSong();
  if (!started) {
    console.warn("[showClock] jumpToNextSong returned false — queue may be empty");
    return;
  }

  // 5. Log the transition in the play log so operators can see it
  try {
    const stationId = getActiveStationIdSync();
    await (window as any).ether.playLog.create({
      station_id: stationId,
      title:      `[Show Transition: ${showName}]`,
      artist:     "",
      deck:       "AUTO",
      session_id: `show-${newHour}`,
    });
  } catch { /* non-critical */ }

  console.log(`[showClock] ✓ "${showName}" is live — ${count} songs queued`);
}

// ── Clock watcher ─────────────────────────────────────────────

let _lastHour = -1;

/**
 * Start watching for show transitions. Call once when automation starts.
 * Checks every second. When the hour ticks over to a scheduled show's
 * start_hour, executes the hard cut.
 *
 * Returns a cleanup function — call it to stop watching (e.g. when
 * automation is turned off).
 */
export function watchShowTransitions(
  onTransition?: (showName: string, hour: number) => void
): () => void {
  _lastHour = new Date().getHours();

  const id = setInterval(async () => {
    const now = new Date();
    const h   = now.getHours();
    if (h === _lastHour) return; // same hour — nothing to do
    _lastHour = h;

    try {
      const today = String(now.getDay());
      const stationId = getActiveStationIdSync();
      const shows = await query<ShowRow>(
        "SELECT * FROM shows WHERE is_active = 1 AND start_hour = ? AND station_id = ?",
        [h, stationId]
      );
      const show = shows.find(s => s.days.includes(today));
      if (!show) return; // no show starts at this exact hour

      await executeTransition(show.name, h);
      onTransition?.(show.name, h);
    } catch (e) {
      console.error("[showClock] Transition error:", e);
    }
  }, 1000);

  return () => clearInterval(id);
}
