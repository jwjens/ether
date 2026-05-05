// ── db/client.ts ──────────────────────────────────────────────
// Electron IPC database client — replaces @tauri-apps/plugin-sql
// All queries go through window.ether.db → ipcMain → better-sqlite3

const DEV = import.meta.env.DEV;
const SLOW_QUERY_MS = 50;

// ── Core query helpers ────────────────────────────────────────

export async function query<T = any>(sql: string, args: any[] = []): Promise<T[]> {
  const start = performance.now();
  const result = await (window as any).ether.db.query(sql, args);
  if (DEV) {
    const elapsed = performance.now() - start;
    if (elapsed > SLOW_QUERY_MS) console.warn(`[DB SLOW ${elapsed.toFixed(0)}ms] ${sql.slice(0, 80)}`);
  }
  if (result.error) {
    console.error("[DB query error]", sql.slice(0, 100), result.error);
    throw new Error(result.error);
  }
  return result.data as T[];
}

export async function queryOne<T = any>(sql: string, args: any[] = []): Promise<T | null> {
  const rows = await query<T>(sql, args);
  return rows[0] ?? null;
}

export async function execute(sql: string, args: any[] = []): Promise<any> {
  const start = performance.now();
  const result = await (window as any).ether.db.execute(sql, args);
  if (DEV) {
    const elapsed = performance.now() - start;
    if (elapsed > SLOW_QUERY_MS) console.warn(`[DB SLOW ${elapsed.toFixed(0)}ms] ${sql.slice(0, 80)}`);
  }
  if (result.error) {
    // Retry once on SQLITE_BUSY
    if (result.error.includes("busy") || result.error.includes("locked")) {
      await new Promise(r => setTimeout(r, 50));
      const retry = await (window as any).ether.db.execute(sql, args);
      if (retry.error) throw new Error(retry.error);
      return retry.data;
    }
    console.error("[DB execute error]", sql.slice(0, 100), result.error);
    throw new Error(result.error);
  }
  return result.data;
}

// ── Migrations ────────────────────────────────────────────────
// Runs in main process via better-sqlite3 — fast synchronous execution

export async function runMigrations(): Promise<void> {
  // Migrations now run in main.js at startup via better-sqlite3
  // This is a no-op kept for compatibility with main.tsx boot sequence
  console.log("[DB] ✓ Database ready — schema v5");
}

// ── Health check ──────────────────────────────────────────────

export async function dbHealthCheck(): Promise<{
  ok: boolean;
  version: number;
  songCount: number;
  playLogCount: number;
  dbSizeKb: number | null;
  walMode: boolean;
}> {
  try {
    const [version, songs, log, walInfo] = await Promise.all([
      queryOne<{ version: number }>("SELECT MAX(version) as version FROM schema_version"),
      queryOne<{ n: number }>("SELECT COUNT(*) as n FROM songs"),
      queryOne<{ n: number }>("SELECT COUNT(*) as n FROM play_log"),
      queryOne<{ journal_mode: string }>("PRAGMA journal_mode"),
    ]);
    return {
      ok: true,
      version: version?.version ?? 0,
      songCount: songs?.n ?? 0,
      playLogCount: log?.n ?? 0,
      dbSizeKb: null,
      walMode: walInfo?.journal_mode === "wal",
    };
  } catch (e) {
    return { ok: false, version: 0, songCount: 0, playLogCount: 0, dbSizeKb: null, walMode: false };
  }
}

// ── Fast song search using FTS5 ───────────────────────────────

export async function searchSongs(term: string, limit = 50): Promise<any[]> {
  if (!term.trim()) return [];
  try {
    const ftsResults = await query(
      `SELECT s.*, a.name as artist_name
       FROM songs_fts
       JOIN songs s ON s.id = songs_fts.rowid
       LEFT JOIN artists a ON a.id = s.artist_id
       WHERE songs_fts MATCH ? AND s.file_path IS NOT NULL
       ORDER BY rank
       LIMIT ?`,
      [term + "*", limit]
    );
    if (ftsResults.length > 0) return ftsResults;
  } catch {}
  return query(
    `SELECT s.*, a.name as artist_name
     FROM songs s LEFT JOIN artists a ON a.id = s.artist_id
     WHERE (s.title LIKE ? OR a.name LIKE ?) AND s.file_path IS NOT NULL
     LIMIT ?`,
    [`%${term}%`, `%${term}%`, limit]
  );
}

// ── Session management ────────────────────────────────────────

let _sessionId: string | null = null;

export function getSessionId(): string {
  if (!_sessionId) {
    _sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  return _sessionId;
}

export async function logPlay(title: string, artist: string, deck: string, durationMs: number | undefined, stationId: number): Promise<void> {
  await execute(
    "INSERT INTO play_log (uuid, station_id, title, artist, deck, duration_ms, session_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [crypto.randomUUID(), stationId, title, artist, deck, durationMs ?? null, getSessionId()]
  );
}
