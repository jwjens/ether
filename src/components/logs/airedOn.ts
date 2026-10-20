// logs/airedOn.ts — WHICH COMPUTER AIRED A PLAY (Jeff, 2026-10-20: "The Play Log gets an 'Aired on' column with the
// computer's name, and a filter by computer, so a PD on any computer can see and print exactly what a station aired on
// any computer for any time range … Exports (PDF, CSV, BMI/ASCAP, As-Run) include the column and respect the filter.")
//
// One label and one filter clause, used by the list on screen AND by every export, so they can never disagree.
// play_log.machine_id (v63) says which computer; play_log.machine_name (v68) its name as it was when it aired.

/** The filter value for "plays recorded before the computer was stored" (machine_id NULL, before 2026-10-18). */
export const AIRED_ON_NOT_RECORDED = "__not_recorded__";

export interface AiredOnFields { machine_id?: string | null; machine_name?: string | null }

/** "OVEVENTS" · "computer 041ceb96" (a play from before names were stored) · "Not recorded" (before computers were). */
export function airedOnLabel(r: AiredOnFields): string {
  if (r.machine_name) return r.machine_name;
  if (r.machine_id) return `computer ${String(r.machine_id).slice(0, 8)}`;
  return "Not recorded";
}

/** The computer filter as SQL on play_log (`alias` = its alias, or ""). "" = every computer. */
export function airedOnClause(filter: string, alias = ""): { sql: string; params: unknown[] } {
  const col = alias ? `${alias}.machine_id` : "machine_id";
  if (!filter) return { sql: "", params: [] };
  if (filter === AIRED_ON_NOT_RECORDED) return { sql: ` AND ${col} IS NULL`, params: [] };
  return { sql: ` AND ${col} = ?`, params: [filter] };
}

/** The computers that aired on a station, for the filter: one per machine_id, named by its most recent name. */
export const AIRED_ON_COMPUTERS_SQL =
  `SELECT machine_id, MAX(machine_name) AS machine_name, COUNT(*) AS plays, MAX(played_at) AS last_played_at
     FROM play_log WHERE station_id = ? GROUP BY machine_id ORDER BY MAX(played_at) DESC`;
