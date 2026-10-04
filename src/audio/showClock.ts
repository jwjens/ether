// src/audio/showClock.ts
//
// Read-only show-transition lookup: when does the next show start? (OnShiftScreen's countdown.)
//
// There is NO hard cut here. This file used to carry a renderer-side top-of-hour show transition
// (stop every deck mid-song, clear the queue, refill, play) behind an hourly watcher that nothing
// had called since playout moved to the daemon. It was removed 2026-10-04 with the daemon's own hard cut
// (Jeff's ruling): a song that crosses the hour plays to its end and the new hour joins after it.

import { query } from "../db/client";
import { getActiveStationIdSync } from "../hooks/useActiveStation";

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
      "SELECT id, name, start_hour, end_hour, days FROM shows WHERE is_active = 1 AND deleted_at IS NULL AND station_id = ?",
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
