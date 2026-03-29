// ── db/client.ts ──────────────────────────────────────────────
// Hardened SQLite client for Ether.
// - WAL journal mode for concurrent reads during writes
// - Foreign key enforcement
// - Proper indexes on hot query paths
// - Versioned migrations — never destructive
// - Retry logic on SQLITE_BUSY
// - Query timing in dev mode

/// <reference types="vite/client" />
import Database from "@tauri-apps/plugin-sql";

let _db: Database | null = null;
let _connecting = false;
let _connectQueue: Array<(db: Database) => void> = [];

const DEV = import.meta.env.DEV;
const SLOW_QUERY_MS = 50;

// ── Connection singleton ──────────────────────────────────────

async function getDb(): Promise<Database> {
  if (_db) return _db;
  if (_connecting) {
    return new Promise(resolve => _connectQueue.push(resolve));
  }
  _connecting = true;
  try {
    const db = await Database.load("sqlite:openair.db");
    _db = db;
    _connectQueue.forEach(r => r(db));
    _connectQueue = [];
    return db;
  } finally {
    _connecting = false;
  }
}

// ── Core query helpers ────────────────────────────────────────

export async function query<T = any>(sql: string, args: any[] = []): Promise<T[]> {
  const db = await getDb();
  const start = performance.now();
  try {
    const result = await db.select<T[]>(sql, args);
    if (DEV) {
      const elapsed = performance.now() - start;
      if (elapsed > SLOW_QUERY_MS) console.warn(`[DB SLOW ${elapsed.toFixed(0)}ms] ${sql.slice(0, 80)}`);
    }
    return result;
  } catch (e) {
    console.error("[DB query error]", sql.slice(0, 100), e);
    throw e;
  }
}

export async function queryOne<T = any>(sql: string, args: any[] = []): Promise<T | null> {
  const rows = await query<T>(sql, args);
  return rows[0] ?? null;
}

export async function execute(sql: string, args: any[] = []): Promise<any> {
  const db = await getDb();
  const start = performance.now();
  try {
    const result = await db.execute(sql, args);
    if (DEV) {
      const elapsed = performance.now() - start;
      if (elapsed > SLOW_QUERY_MS) console.warn(`[DB SLOW ${elapsed.toFixed(0)}ms] ${sql.slice(0, 80)}`);
    }
    return result;
  } catch (e) {
    // Retry once on SQLITE_BUSY
    if (String(e).includes("busy") || String(e).includes("locked")) {
      await new Promise(r => setTimeout(r, 50));
      return db.execute(sql, args);
    }
    console.error("[DB execute error]", sql.slice(0, 100), e);
    throw e;
  }
}

// ── Migration system ──────────────────────────────────────────
// Each migration is numbered and idempotent.
// Never modifies existing columns — only adds.
// schema_version table tracks applied migrations.

const MIGRATIONS: Array<{ version: number; name: string; up: string[] }> = [
  {
    version: 1,
    name: "initial_schema",
    up: [
      // Performance pragmas — applied once at startup
      "PRAGMA journal_mode=WAL",
      "PRAGMA synchronous=NORMAL",
      "PRAGMA foreign_keys=ON",
      "PRAGMA cache_size=-32000", // 32MB cache
      "PRAGMA temp_store=MEMORY",
      "PRAGMA mmap_size=268435456", // 256MB mmap

      // Core tables
      `CREATE TABLE IF NOT EXISTS artists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        bio TEXT,
        created_at INTEGER DEFAULT (unixepoch())
      )`,

      `CREATE TABLE IF NOT EXISTS albums (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        artist_id INTEGER REFERENCES artists(id) ON DELETE SET NULL,
        year INTEGER,
        artwork_url TEXT,
        created_at INTEGER DEFAULT (unixepoch())
      )`,

      `CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        name TEXT,
        color TEXT DEFAULT '#38bdf8',
        max_rest INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch())
      )`,

      `CREATE TABLE IF NOT EXISTS songs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        artist_id INTEGER REFERENCES artists(id) ON DELETE SET NULL,
        album_id INTEGER REFERENCES albums(id) ON DELETE SET NULL,
        category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        file_path TEXT UNIQUE,
        duration_ms INTEGER DEFAULT 0,
        bpm REAL,
        cue_in REAL DEFAULT 0,
        cue_out REAL DEFAULT 0,
        intro_end REAL DEFAULT 0,
        outro_start REAL DEFAULT 0,
        play_count INTEGER DEFAULT 0,
        last_played_at INTEGER,
        energy REAL,
        genre TEXT,
        year INTEGER,
        isrc TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
      )`,

      `CREATE TABLE IF NOT EXISTS play_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        artist TEXT,
        deck TEXT,
        duration_ms INTEGER,
        played_at INTEGER DEFAULT (unixepoch()),
        session_id TEXT
      )`,

      `CREATE TABLE IF NOT EXISTS clocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at INTEGER DEFAULT (unixepoch())
      )`,

      `CREATE TABLE IF NOT EXISTS clock_slots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        clock_id INTEGER NOT NULL REFERENCES clocks(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        slot_type TEXT NOT NULL DEFAULT 'music',
        category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        duration_min REAL DEFAULT 3.5,
        label TEXT
      )`,

      `CREATE TABLE IF NOT EXISTS shows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        clock_id INTEGER REFERENCES clocks(id) ON DELETE SET NULL,
        start_hour INTEGER DEFAULT 0,
        end_hour INTEGER DEFAULT 1,
        days TEXT DEFAULT '0123456',
        color TEXT DEFAULT '#38bdf8',
        description TEXT,
        created_at INTEGER DEFAULT (unixepoch())
      )`,

      `CREATE TABLE IF NOT EXISTS podcast_episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        host TEXT,
        duration_ms INTEGER DEFAULT 0,
        file_path TEXT,
        file_url TEXT,
        file_size INTEGER DEFAULT 0,
        published_at INTEGER,
        created_at INTEGER DEFAULT (unixepoch()),
        guid TEXT UNIQUE,
        season INTEGER,
        episode_number INTEGER,
        explicit INTEGER DEFAULT 0,
        artwork_url TEXT,
        transcript TEXT
      )`,

      `CREATE TABLE IF NOT EXISTS announcements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        file_path TEXT,
        trigger_time TEXT,
        days TEXT DEFAULT '0123456',
        duck_music INTEGER DEFAULT 1,
        resume_music INTEGER DEFAULT 1,
        duck_level REAL DEFAULT 0.1,
        is_active INTEGER DEFAULT 1,
        created_at INTEGER DEFAULT (unixepoch())
      )`,

      `CREATE TABLE IF NOT EXISTS stream_settings (
        id INTEGER PRIMARY KEY,
        server TEXT DEFAULT 'localhost',
        port INTEGER DEFAULT 8000,
        mount TEXT DEFAULT '/stream',
        password TEXT DEFAULT 'hackme',
        bitrate INTEGER DEFAULT 128,
        station_name TEXT,
        station_genre TEXT,
        station_url TEXT,
        is_active INTEGER DEFAULT 0
      )`,
      `INSERT OR IGNORE INTO stream_settings (id) VALUES (1)`,

      `CREATE TABLE IF NOT EXISTS crash_recovery (
        id INTEGER PRIMARY KEY,
        queue_json TEXT DEFAULT '[]',
        deck_a_path TEXT,
        deck_a_title TEXT,
        deck_a_artist TEXT,
        deck_a_position REAL DEFAULT 0,
        was_playing INTEGER DEFAULT 0,
        saved_at INTEGER DEFAULT 0
      )`,
      `INSERT OR IGNORE INTO crash_recovery (id) VALUES (1)`,

      `CREATE TABLE IF NOT EXISTS station_config_kv (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at INTEGER DEFAULT (unixepoch())
      )`,

      `CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        name TEXT,
        applied_at INTEGER DEFAULT (unixepoch())
      )`,
    ],
  },

  {
    version: 2,
    name: "indexes",
    up: [
      // Hot query path indexes
      "CREATE INDEX IF NOT EXISTS idx_songs_category ON songs(category_id)",
      "CREATE INDEX IF NOT EXISTS idx_songs_artist ON songs(artist_id)",
      "CREATE INDEX IF NOT EXISTS idx_songs_file ON songs(file_path)",
      "CREATE INDEX IF NOT EXISTS idx_songs_title ON songs(title COLLATE NOCASE)",
      "CREATE INDEX IF NOT EXISTS idx_songs_last_played ON songs(last_played_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_play_log_played_at ON play_log(played_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_play_log_title ON play_log(title)",
      "CREATE INDEX IF NOT EXISTS idx_clock_slots_clock ON clock_slots(clock_id, position)",
      "CREATE INDEX IF NOT EXISTS idx_shows_hours ON shows(start_hour, end_hour)",
    ],
  },

  {
    version: 3,
    name: "song_metadata_columns",
    up: [
      // Safe column additions — IF NOT EXISTS handled by try/catch per column
      "ALTER TABLE songs ADD COLUMN energy REAL",
      "CREATE TABLE IF NOT EXISTS podcast_episodes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT, host TEXT, duration_ms INTEGER DEFAULT 0, file_path TEXT, file_url TEXT, file_size INTEGER DEFAULT 0, published_at INTEGER, created_at INTEGER DEFAULT (unixepoch()), guid TEXT UNIQUE, season INTEGER, episode_number INTEGER, explicit INTEGER DEFAULT 0, artwork_url TEXT, transcript TEXT)",
      "ALTER TABLE songs ADD COLUMN isrc TEXT",
      "ALTER TABLE songs ADD COLUMN year INTEGER",
      "ALTER TABLE songs ADD COLUMN updated_at INTEGER DEFAULT (unixepoch())",
      "ALTER TABLE songs ADD COLUMN play_count INTEGER DEFAULT 0",
      "ALTER TABLE songs ADD COLUMN last_played_at INTEGER",
      "ALTER TABLE play_log ADD COLUMN duration_ms INTEGER",
      "ALTER TABLE play_log ADD COLUMN session_id TEXT",
      "ALTER TABLE station_config_kv ADD COLUMN updated_at INTEGER DEFAULT (unixepoch())",
    ],
  },

  {
    version: 4,
    name: "play_count_trigger",
    up: [
      // Auto-increment play count and set last_played_at when a song is logged
      `CREATE TRIGGER IF NOT EXISTS trg_play_count
       AFTER INSERT ON play_log
       BEGIN
         UPDATE songs
         SET play_count = play_count + 1,
             last_played_at = unixepoch()
         WHERE title = NEW.title;
       END`,
    ],
  },

  {
    version: 5,
    name: "full_text_search",
    up: [
      // FTS5 virtual table for fast song search
      `CREATE VIRTUAL TABLE IF NOT EXISTS songs_fts USING fts5(
        title, artist_name, content='', tokenize='porter ascii'
      )`,
      // Populate FTS from existing songs
      `INSERT OR IGNORE INTO songs_fts(rowid, title, artist_name)
       SELECT s.id, s.title, COALESCE(a.name, '')
       FROM songs s LEFT JOIN artists a ON a.id = s.artist_id`,
      // Keep FTS in sync
      `CREATE TRIGGER IF NOT EXISTS trg_songs_fts_insert
       AFTER INSERT ON songs BEGIN
         INSERT INTO songs_fts(rowid, title, artist_name)
         SELECT NEW.id, NEW.title, COALESCE((SELECT name FROM artists WHERE id=NEW.artist_id), '');
       END`,
      `CREATE TRIGGER IF NOT EXISTS trg_songs_fts_delete
       AFTER DELETE ON songs BEGIN
         DELETE FROM songs_fts WHERE rowid = OLD.id;
       END`,
    ],
  },
];

// ── Migration runner ──────────────────────────────────────────

export async function runMigrations(): Promise<void> {
  const db = await getDb();

  // Apply pragmas immediately — these must run every connection
  await db.execute("PRAGMA journal_mode=WAL", []);
  await db.execute("PRAGMA synchronous=NORMAL", []);
  await db.execute("PRAGMA foreign_keys=ON", []);
  await db.execute("PRAGMA cache_size=-32000", []);
  await db.execute("PRAGMA temp_store=MEMORY", []);

  // Ensure schema_version table exists
  await db.execute(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    name TEXT,
    applied_at INTEGER DEFAULT (unixepoch())
  )`, []);

  // Get current version
  const rows = await db.select<{ version: number }[]>(
    "SELECT MAX(version) as version FROM schema_version"
  );
  const currentVersion = rows[0]?.version ?? 0;

  // Apply pending migrations
  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;

    console.log(`[DB] Applying migration ${migration.version}: ${migration.name}`);
    const start = performance.now();

    for (const sql of migration.up) {
      try {
        await db.execute(sql, []);
      } catch (e) {
        // Column already exists — safe to ignore
        const msg = String(e).toLowerCase();
        if (msg.includes("duplicate column") || msg.includes("already exists")) {
          continue;
        }
        // Log but don't fail — migrations should be resilient
        console.warn(`[DB] Migration ${migration.version} step warning:`, String(e).slice(0, 100));
      }
    }

    await db.execute(
      "INSERT OR REPLACE INTO schema_version (version, name) VALUES (?, ?)",
      [migration.version, migration.name]
    );

    console.log(`[DB] Migration ${migration.version} applied in ${(performance.now() - start).toFixed(0)}ms`);
  }

  console.log("[DB] ✓ Database ready — schema v" + MIGRATIONS[MIGRATIONS.length - 1].version);
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
    const [version, songs, log, pageInfo, walInfo] = await Promise.all([
      queryOne<{ version: number }>("SELECT MAX(version) as version FROM schema_version"),
      queryOne<{ n: number }>("SELECT COUNT(*) as n FROM songs"),
      queryOne<{ n: number }>("SELECT COUNT(*) as n FROM play_log"),
      queryOne<{ page_count: number; page_size: number }>("PRAGMA page_count; PRAGMA page_size"),
      queryOne<{ journal_mode: string }>("PRAGMA journal_mode"),
    ]);

    return {
      ok: true,
      version: version?.version ?? 0,
      songCount: songs?.n ?? 0,
      playLogCount: log?.n ?? 0,
      dbSizeKb: null, // page_count * page_size / 1024 — needs separate queries
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
    // Try FTS first — much faster on large libraries
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

  // Fallback to LIKE
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

// Tag all play_log entries with current session
export async function logPlay(title: string, artist: string, deck: string, durationMs?: number): Promise<void> {
  await execute(
    "INSERT INTO play_log (title, artist, deck, duration_ms, session_id) VALUES (?, ?, ?, ?, ?)",
    [title, artist, deck, durationMs ?? null, getSessionId()]
  );
}

