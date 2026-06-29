// Pure routing logic for the remote command bus (Slice 4 — desktop station-scoping safety gate).
//
// The command bus is PER-LICENSE: POST /api/cmd fans a command out over SSE to EVERY desktop on the
// license, and today execCmd acts on whatever station that machine has active — so a control aimed at
// one station lands on all of them (the "knock the wrong station off air" hazard). This module decides,
// purely, WHICH local station a remote command should act on. It is extracted + unit-tested on its own
// (like deriveStationState) so the decision is provable BEFORE it's wired into the live execCmd handler.
//
// No side effects, no imports, no engine/DB/window access — callers pass in the active station id and
// the machine's local station list; this just returns the verdict.

export type CommandTarget =
  | { kind: "active"; stationId: number }   // no station_uuid → act on this machine's active station (legacy/companion)
  | { kind: "target"; stationId: number }   // station_uuid matches a station THIS machine runs → act on it
  | { kind: "ignore" };                      // station_uuid given but not run on this machine → drop the command

export interface LocalStation {
  id: number;
  uuid: string | null | undefined;
}

// Station-scoped commands act on ONE station's engine/decks/queue, so they must be routed by
// station_uuid. Everything NOT in this set (e.g. db:apply, library:addSong, library:syncDownload) is
// LICENSE-scoped — it acts on the whole install and must NEVER be gated by station_uuid.
const STATION_SCOPED: ReadonlySet<string> = new Set([
  "skip", "automation_on", "automation_off", "stop_all", "play", "pause",
  "set_volume", "play_emergency_cart", "mic_on",
  "deck:load", "deck:cue", "deck:crossfade",
  "queue:enqueue", "queue:reorder", "queue:remove", "queue:move", "queue:clear",
]);

/** True if `cmd` acts on a single station (→ route by station_uuid). False for license-scoped commands
 *  (db:apply, library:*, unknown) — those are applied as-is and never gated by station_uuid. */
export function isStationScopedCommand(cmd: string): boolean {
  return STATION_SCOPED.has(cmd);
}

/** Decide which local station a station-scoped command should act on.
 *   - no/blank station_uuid     → { active }   (preserves today's behavior for callers that don't send one)
 *   - uuid matches a local row  → { target }   (the correct station, even if it isn't the active view)
 *   - uuid present but no match  → { ignore }    (this machine doesn't run that station — drop it; THIS is
 *                                                 the fix that stops a per-license command hitting every machine)
 */
export function resolveCommandTarget(
  stationUuid: string | null | undefined,
  activeStationId: number,
  localStations: ReadonlyArray<LocalStation>,
): CommandTarget {
  const uuid = typeof stationUuid === "string" ? stationUuid.trim() : "";
  if (!uuid) return { kind: "active", stationId: activeStationId };
  const match = localStations.find((s) => (s.uuid || "") === uuid);
  return match ? { kind: "target", stationId: match.id } : { kind: "ignore" };
}
