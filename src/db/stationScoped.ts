/**
 * stationScoped — station-aware query helpers for renderer components
 *
 * Wraps the base query/execute helpers from db/client.ts and automatically
 * injects station_id scoping so callsite code doesn't repeat it.
 *
 * Quick reference:
 *   queryScoped<Song>("SELECT * FROM songs WHERE rotation_status=?", ["active"], stationId)
 *   executeScopedInsert("INSERT INTO play_log (title, artist) VALUES (?,?)", [t, a], stationId)
 *
 * Limitations (use skipScoping:true for these):
 *   - UNION queries — cannot reliably determine which SELECT to scope
 *   - INSERT ... SELECT forms — multi-row or subquery inserts
 *   - Queries that already carry station_id in a complex subquery context
 */

import { query, execute } from "./client";

// ─── Public types ─────────────────────────────────────────────

export interface ScopingOptions {
  /**
   * Set true for intentional cross-station queries: admin reports, migrations,
   * diagnostics, or any query that must aggregate across all stations.
   * Should be rare — nearly all operational queries are station-scoped.
   */
  skipScoping?: boolean;
}

// ─── Module-level warning deduplication ───────────────────────

const _warned = new Set<string>();

function warnOnce(sql: string, reason: string): void {
  const key = sql.slice(0, 200);
  if (_warned.has(key)) return;
  _warned.add(key);
  console.warn(`[stationScoped] ${reason}: ${sql.slice(0, 80)}`);
}

// Word-boundary match — won't false-positive on workstation_id, station_id_fk, etc.
const STATION_ID_RE = /\bstation_id\b/i;
const UNION_RE      = /\bUNION\b/i;

// ─── SELECT scoping ───────────────────────────────────────────

/**
 * Wraps query() with automatic station_id scoping.
 *
 * Injects WHERE station_id = ? (or AND station_id = ? into an existing WHERE).
 * The station_id param is spliced into the correct position in the params array
 * based on how many ? placeholders appear before the injection point.
 *
 * Pass-through cases (with one-time console.warn):
 *   - SQL already contains \bstation_id\b — caller is responsible
 *   - SQL contains UNION — cannot auto-scope reliably
 */
export async function queryScoped<T = any>(
  sql: string,
  params: any[] = [],
  stationId: number,
  opts?: ScopingOptions
): Promise<T[]> {
  if (opts?.skipScoping) return query<T>(sql, params);

  if (STATION_ID_RE.test(sql)) {
    warnOnce(sql, "SQL already contains station_id, passing through unchanged");
    return query<T>(sql, params);
  }

  if (UNION_RE.test(sql)) {
    warnOnce(sql, "UNION query not auto-scoped — use skipScoping:true or scope manually");
    return query<T>(sql, params);
  }

  const { rewritten, stationParamIndex } = injectWhereStationId(sql);
  const merged = [...params];
  merged.splice(stationParamIndex, 0, stationId);
  return query<T>(rewritten, merged);
}

/**
 * Wraps execute() for INSERT statements with automatic station_id column injection.
 *
 * Rewrites INSERT INTO t (col1, col2) VALUES (?,?) into
 *          INSERT INTO t (station_id, col1, col2) VALUES (?,?,?)
 * and prepends stationId to the values array.
 *
 * Only handles the standard single-row INSERT INTO ... VALUES (...) form.
 * Use skipScoping:true for INSERT ... SELECT or OR REPLACE forms that already
 * carry station_id.
 */
export async function executeScopedInsert(
  sql: string,
  values: any[] = [],
  stationId: number,
  opts?: ScopingOptions
): Promise<any> {
  if (opts?.skipScoping) return execute(sql, values);

  if (STATION_ID_RE.test(sql)) {
    warnOnce(sql, "SQL already contains station_id, passing through unchanged");
    return execute(sql, values);
  }

  const rewritten = injectInsertStationId(sql);
  if (rewritten === null) {
    console.warn(`[stationScoped] executeScopedInsert: could not parse INSERT, falling through: ${sql.slice(0, 80)}`);
    return execute(sql, values);
  }
  return execute(rewritten, [crypto.randomUUID(), stationId, ...values]);
}

// ─── SQL rewriters (intentionally simple — no full SQL parser) ─

interface WhereInjectionResult {
  rewritten: string;
  /** Index in the final merged params array where stationId must be inserted */
  stationParamIndex: number;
}

function injectWhereStationId(sql: string): WhereInjectionResult {
  const whereMatch = /\bWHERE\b/i.exec(sql);

  if (whereMatch) {
    const idx = whereMatch.index;
    // Count ? placeholders before the WHERE keyword to find splice position
    const paramsBeforeWhere = (sql.slice(0, idx).match(/\?/g) ?? []).length;
    const rewritten =
      sql.slice(0, idx).trimEnd() +
      " WHERE station_id = ? AND " +
      sql.slice(idx + whereMatch[0].length).trimStart();
    return { rewritten, stationParamIndex: paramsBeforeWhere };
  }

  // No WHERE — insert before ORDER BY / GROUP BY / HAVING / LIMIT if present
  const terminatorMatch = /\b(ORDER\s+BY|GROUP\s+BY|HAVING|LIMIT)\b/i.exec(sql);
  if (terminatorMatch) {
    const idx = terminatorMatch.index;
    const paramsBeforeTerminator = (sql.slice(0, idx).match(/\?/g) ?? []).length;
    const rewritten =
      sql.slice(0, idx).trimEnd() +
      " WHERE station_id = ? " +
      sql.slice(idx);
    return { rewritten, stationParamIndex: paramsBeforeTerminator };
  }

  // Append to end of query
  const totalParams = (sql.match(/\?/g) ?? []).length;
  return {
    rewritten: sql.trimEnd() + " WHERE station_id = ?",
    stationParamIndex: totalParams,
  };
}

function injectInsertStationId(sql: string): string | null {
  // Matches: INSERT [OR IGNORE/REPLACE/etc] INTO table_name (col1, col2) VALUES (?, ?)
  // Flags: i = case-insensitive, s = dot matches newline
  const m = /^(\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+\w+\s*\()([^)]+)(\)\s*VALUES\s*\()([^)]+)(\).*)$/is.exec(sql);
  if (!m) return null;
  const [, pre, cols, mid, vals, post] = m;
  return `${pre}uuid, station_id, ${cols.trimStart()}${mid}?, ?, ${vals.trimStart()}${post}`;
}
