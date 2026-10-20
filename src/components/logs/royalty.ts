// The BMI / ASCAP royalty exports (docs/help-logs.md; audit items 6, 7 in docs/help-audit-2026-09-27.md).
//
// Every play in the selected period — its own query, never the 200-row list on screen — with each play's REAL length
// from play_log.duration_ms. A play whose length was not recorded gets an empty duration: a royalty report must not
// carry a number nobody measured (it used to write "3:30" / "3.5" on every row).

import { airedOnLabel, airedOnClause } from "./airedOn";

export interface RoyaltyRow { played_at: number; title: string; artist: string | null; duration_ms: number | null; machine_id?: string | null; machine_name?: string | null }

/** The whole period, oldest-first order kept as the screen's (newest first). No LIMIT.
 *  ANNOUNCEMENTS ARE LEFT OUT (Jeff, 2026-10-13: "Leave announcements out of the BMI/ASCAP export"). A park's
 *  announcement is venue operations, not a performance of a musical work; it is in play_log (content_class 'ANN',
 *  electron/main.js fireAnnouncement) for the as-run log and the printable log, which keep it. COALESCE keeps every row
 *  with no class (songs logged before v29, carts, jingles) exactly as before. */
export const royaltySql = (computerClause = "") =>
  `SELECT played_at, title, artist, duration_ms, machine_id, machine_name FROM play_log
    WHERE station_id = ? AND played_at >= ? AND played_at <= ?
      AND COALESCE(content_class, '') <> 'ANN'${computerClause}
    ORDER BY played_at DESC`;
export const ROYALTY_SQL = royaltySql();

/** Every play in the period, all columns — the printable (PDF) log. No LIMIT (audit 7: it printed the 200 on screen). */
export const periodPlaysSql = (computerClause = "") =>
  `SELECT * FROM play_log
    WHERE station_id = ? AND played_at >= ? AND played_at <= ?${computerClause}
    ORDER BY played_at DESC`;
export const PERIOD_PLAYS_SQL = periodPlaysSql();
/** The period's params plus the computer filter's (logs/airedOn.ts), in query order. */
export function periodQuery(make: (clause: string) => string, stationId: number, from: number, to: number, computer: string) {
  const c = airedOnClause(computer);
  return { sql: make(c.sql), params: [stationId, from, to, ...c.params] };
}

/** m:ss (BMI). */
export function fmtMinSec(ms: number | null): string {
  if (ms == null || !(ms > 0)) return "";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
/** Minutes, two decimals (ASCAP "Duration (min)"). */
export function fmtMinutes(ms: number | null): string {
  if (ms == null || !(ms > 0)) return "";
  return (ms / 60000).toFixed(2);
}

const q = (v: unknown) => '"' + String(v ?? "").replace(/"/g, '""') + '"';

export function royaltyCsv(format: "bmi" | "ascap", rows: RoyaltyRow[], stationName: string): string {
  if (format === "bmi") {
    // "Aired On" last (2026-10-20): which computer aired each play — the column every Play Log export carries.
    const header = "Title,Performer,Date Of Use,Time Of Use,Duration,Aired On";
    return header + "\n" + rows.map(e => {
      const d = new Date(e.played_at * 1000);
      return [e.title, e.artist || "Unknown", d.toLocaleDateString("en-US"), d.toLocaleTimeString("en-US", { hour12: false }), fmtMinSec(e.duration_ms), airedOnLabel(e)].map(q).join(",");
    }).join("\n");
  }
  const header = "Title,Artist,Date,Start Time,Duration (min),Source,Aired On";
  return header + "\n" + rows.map(e => {
    const d = new Date(e.played_at * 1000);
    return [e.title, e.artist || "Unknown", (d.getMonth() + 1) + "/" + d.getDate() + "/" + d.getFullYear(), d.toLocaleTimeString("en-US", { hour12: false }), fmtMinutes(e.duration_ms), stationName, airedOnLabel(e)].map(q).join(",");
  }).join("\n");
}
