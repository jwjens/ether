// THE PARK'S SOUND — who changed it and when (Jeff, 2026-10-13: "Who and when ('Muted from Park page by Ryan, 8:42 PM')
// shows next to that station fader in Ether AND on the Park page"). One record per station, station_config_kv
// `park_sound_last`, written by whoever changed the sound last: the Park page (via the command bus, with the logged-in
// staff member's name) or Ether's own strip. It travels to the Park page in the ops mirror (ccData.ts), so both show the
// same line. The last change from anywhere — an Ether unmute replaces "Muted from Park page by Ryan".

import { formatDb } from "./faderLaw";

export interface ParkSoundLast {
  what: "muted" | "unmuted" | "level";
  level?: number | null;   // linear, for "level"
  by?: string | null;      // the staff member's name (Park page); none from Ether (only Jeff uses Ether)
  via: "park" | "ether";
  at: string;              // ISO time of the change
}

export function parseParkSoundLast(raw: string | null | undefined): ParkSoundLast | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && typeof v.at === "string" && (v.via === "park" || v.via === "ether") ? v : null;
  } catch { return null; }
}

export async function recordParkSound(stationId: number, last: Omit<ParkSoundLast, "at">): Promise<void> {
  const entry: ParkSoundLast = { ...last, at: new Date().toISOString() };
  await (window as any).ether?.stationConfigKv?.upsertByKey?.(stationId, "park_sound_last", JSON.stringify(entry));
}

/** "Muted from Park page by Ryan, 8:42 PM" · "Unmuted in Ether, 8:45 PM" · "Level set to −6.0 dB from Park page by Ryan, 8:40 PM" */
export function parkSoundLine(last: ParkSoundLast | null): string | null {
  if (!last) return null;
  const t = new Date(last.at);
  if (isNaN(t.getTime())) return null;
  const when = t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const verb = last.what === "muted" ? "Muted" : last.what === "unmuted" ? "Unmuted"
    : `Level set to ${formatDb(Number(last.level))}`;
  const where = last.via === "park" ? `from Park page${last.by ? ` by ${last.by}` : ""}` : "in Ether";
  return `${verb} ${where}, ${when}`;
}
