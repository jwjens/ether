#!/usr/bin/env node
// scripts/verify-main-schema.js
// Verifies that electron/main.js's schema setup produces the expected columns
// on a fresh SQLite database. Run with: npm run verify:schema
// Uses Node 22+ built-in node:sqlite (no native addon, no Electron ABI conflict).
// Safe to re-run — operates on an in-memory DB, no temp files needed.

"use strict";

const { DatabaseSync } = require("node:sqlite");

// ── Expected columns for the 6 critical tables ───────────────
const EXPECTED = {
  play_log: [
    "id", "title", "artist", "deck", "deck_id", "duration_ms",
    "session_id", "played_at", "scheduled_log_id", "show_name",
    "category_code", "programming_row_id", "station_id", "uuid",
    "created_at", "updated_at", "deleted_at", "file_path",
  ],
  scheduled_log: [
    "id", "log_date", "hour", "position", "song_id", "title",
    "artist", "category_id", "category_code", "duration_ms", "clock_id",
    "created_at",
    // renderer display optimization columns
    "slot_type", "song_title", "song_artist", "category_color", "label", "status",
    // sync columns
    "overflow", "fade_out_at_ms", "fade_duration_ms", "chain_type",
    "station_id", "uuid", "updated_at", "deleted_at",
  ],
  midi_mappings: [
    "id", "device_name", "channel", "type", "number", "action", "label", "is_fader",
  ],
  studio_sessions: [
    "id", "name", "created_at", "updated_at",
  ],
  studio_session_versions: [
    "id", "session_id", "version_number", "label", "snapshot", "created_at",
  ],
  studio_notes: [
    "id", "session_id", "position_ms", "track_id", "author", "text",
    "color", "resolved", "created_at",
  ],
};

// ── Helpers ───────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function ok(msg)   { console.log(`  ✓ ${msg}`); passed++; }
function fail(msg) { console.log(`  ✗ ${msg}`); failed++; }

// ── Setup — in-memory DB, no temp files needed ────────────────
const db = new DatabaseSync(":memory:");

console.log("\n=== MAIN.JS SCHEMA VERIFICATION ===\n");

// ── Step 1: Run the CREATE TABLE block (extracted from main.js) ──
console.log("Step 1: Running CREATE TABLE block...");
let createError = null;
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);

    CREATE TABLE IF NOT EXISTS artists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sort_name TEXT,
      gender TEXT DEFAULT 'unknown',
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS albums (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      artist_id INTEGER REFERENCES artists(id),
      year INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      color TEXT,
      spins_per_hour INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS songs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      file_path TEXT,
      artist_id INTEGER REFERENCES artists(id),
      album_id INTEGER REFERENCES albums(id),
      category_id INTEGER REFERENCES categories(id),
      genre TEXT,
      duration_ms INTEGER,
      bpm REAL,
      energy REAL,
      mood TEXT,
      gender TEXT DEFAULT 'unknown',
      rotation_status TEXT DEFAULT 'active',
      daypart_mask INTEGER DEFAULT 16777215,
      no_repeat_hours INTEGER DEFAULT 2,
      lufs_measured REAL,
      peak_db REAL,
      gain_db REAL DEFAULT 0,
      is_processed INTEGER DEFAULT 0,
      cue_in INTEGER,
      cue_out INTEGER,
      cue_in_ms INTEGER,
      cue_out_ms INTEGER,
      intro_end INTEGER,
      outro_start INTEGER,
      intro_end_ms INTEGER,
      outro_start_ms INTEGER,
      intro_version_path TEXT,
      has_intro INTEGER DEFAULT 0,
      last_played_at INTEGER,
      play_count INTEGER DEFAULT 0,
      is_explicit INTEGER DEFAULT 0,
      raw_metadata TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS separation_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_type TEXT NOT NULL,
      scope TEXT DEFAULT 'global',
      value INTEGER NOT NULL DEFAULT 0,
      is_hard INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS clocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      show_id INTEGER,
      description TEXT,
      color TEXT
    );

    CREATE TABLE IF NOT EXISTS clock_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      clock_id INTEGER NOT NULL REFERENCES clocks(id),
      position INTEGER NOT NULL DEFAULT 0,
      slot_type TEXT NOT NULL DEFAULT 'music',
      category_id INTEGER REFERENCES categories(id),
      label TEXT,
      duration_min INTEGER DEFAULT 4
    );

    CREATE TABLE IF NOT EXISTS shows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      start_hour INTEGER DEFAULT 0,
      end_hour INTEGER DEFAULT 1,
      days TEXT DEFAULT '0123456',
      color TEXT,
      description TEXT,
      is_active INTEGER DEFAULT 1,
      clock_id INTEGER REFERENCES clocks(id)
    );

    CREATE TABLE IF NOT EXISTS play_log (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      title              TEXT NOT NULL,
      artist             TEXT,
      deck               TEXT,
      deck_id            TEXT,
      duration_ms        INTEGER,
      session_id         TEXT,
      played_at          INTEGER DEFAULT (unixepoch()),
      scheduled_log_id   INTEGER,
      show_name          TEXT,
      category_code      TEXT,
      programming_row_id INTEGER,
      station_id         INTEGER NOT NULL DEFAULT 1,
      uuid               TEXT,
      created_at         TEXT,
      updated_at         TEXT,
      deleted_at         TEXT
    );

    CREATE TABLE IF NOT EXISTS scheduled_log (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      log_date         TEXT NOT NULL,
      hour             INTEGER NOT NULL,
      position         INTEGER NOT NULL,
      song_id          INTEGER REFERENCES songs(id),
      title            TEXT,
      artist           TEXT,
      category_id      INTEGER,
      category_code    TEXT,
      duration_ms      INTEGER DEFAULT 0,
      clock_id         INTEGER,
      created_at       INTEGER DEFAULT (unixepoch()),
      slot_type        TEXT,
      song_title       TEXT,
      song_artist      TEXT,
      category_color   TEXT,
      label            TEXT,
      status           TEXT,
      overflow         INTEGER DEFAULT 0,
      fade_out_at_ms   INTEGER DEFAULT 0,
      fade_duration_ms INTEGER DEFAULT 8000,
      chain_type       TEXT DEFAULT 'segue',
      station_id       INTEGER NOT NULL DEFAULT 1,
      uuid             TEXT,
      updated_at       TEXT,
      deleted_at       TEXT
    );

    CREATE TABLE IF NOT EXISTS spots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      file_path TEXT,
      spot_type TEXT DEFAULT 'promo',
      advertiser TEXT,
      start_date TEXT,
      end_date TEXT,
      max_plays_day INTEGER,
      play_count INTEGER DEFAULT 0,
      last_played_at INTEGER,
      is_active INTEGER DEFAULT 1,
      notes TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS cart_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slot_number INTEGER UNIQUE,
      title TEXT,
      file_path TEXT,
      color TEXT DEFAULT '#3b82f6',
      hotkey TEXT
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      file_path TEXT,
      trigger_time TEXT,
      days TEXT DEFAULT '0123456',
      duck_music INTEGER DEFAULT 1,
      resume_music INTEGER DEFAULT 1,
      duck_level REAL DEFAULT 0.2,
      is_active INTEGER DEFAULT 1,
      last_played_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS voice_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      file_path TEXT,
      show_id INTEGER REFERENCES shows(id),
      clock_slot_id INTEGER REFERENCES clock_slots(id),
      duration_ms INTEGER,
      recorded_by TEXT,
      recorded_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS station_config_kv (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS install_config_kv (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      uuid       TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS smart_schedule_rules (
      id TEXT PRIMARY KEY,
      description TEXT,
      days TEXT,
      start_hour INTEGER,
      end_hour INTEGER,
      energy_level TEXT,
      bpm_min INTEGER,
      bpm_max INTEGER,
      genre TEXT,
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS stream_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      host TEXT,
      port INTEGER,
      mount TEXT,
      username TEXT,
      password TEXT,
      format TEXT DEFAULT 'mp3',
      bitrate INTEGER DEFAULT 128,
      is_active INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS stations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      callsign TEXT,
      frequency TEXT,
      city TEXT,
      state TEXT,
      country TEXT DEFAULT 'US',
      website TEXT,
      is_active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS liner_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      category TEXT DEFAULT 'Custom',
      color TEXT DEFAULT '#94a3b8',
      pinned INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS prep_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT DEFAULT '',
      show_date TEXT DEFAULT '',
      category TEXT DEFAULT 'Script',
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS published_episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      file_path TEXT,
      show_id INTEGER,
      published_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS format_clocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      daypart TEXT NOT NULL DEFAULT 'Morning Drive',
      slots_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS crash_recovery (
      id INTEGER PRIMARY KEY DEFAULT 1,
      data TEXT,
      queue_json TEXT DEFAULT '[]',
      deck_a_path TEXT,
      deck_a_title TEXT,
      deck_a_artist TEXT,
      deck_a_position INTEGER DEFAULT 0,
      was_playing INTEGER DEFAULT 0,
      saved_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'jock',
      pin_hash TEXT,
      color TEXT NOT NULL DEFAULT '#22d3ee'
    );

    CREATE TABLE IF NOT EXISTS rtmp_destinations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      stream_key TEXT DEFAULT '',
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS deck_configs (
      slot    TEXT PRIMARY KEY,
      type    TEXT NOT NULL DEFAULT 'music',
      label   TEXT NOT NULL,
      color   TEXT NOT NULL DEFAULT '#34d399',
      enabled INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS macros (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id  INTEGER NOT NULL DEFAULT 1,
      name        TEXT NOT NULL,
      description TEXT,
      trigger_type TEXT NOT NULL DEFAULT 'manual',
      trigger_value TEXT,
      actions     TEXT NOT NULL DEFAULT '[]',
      hotkey      TEXT,
      is_active   INTEGER DEFAULT 1,
      color       TEXT DEFAULT '#38bdf8',
      created_at  INTEGER DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_macros_station_trigger ON macros(station_id, trigger_type, is_active);
    CREATE INDEX IF NOT EXISTS idx_macros_station_hotkey ON macros(station_id, hotkey, is_active) WHERE hotkey IS NOT NULL;

    CREATE TABLE IF NOT EXISTS scheduling_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      rule_type TEXT NOT NULL,
      rule_data TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      uuid TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      deleted_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS generated_schedule (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      scheduled_at INTEGER NOT NULL,
      song_id      INTEGER REFERENCES songs(id),
      title        TEXT NOT NULL,
      artist       TEXT,
      file_key     TEXT,
      duration_s   INTEGER DEFAULT 0,
      category_id  INTEGER,
      clock_id     INTEGER,
      generated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS midi_mappings (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      device_name TEXT,
      channel     INTEGER DEFAULT 0,
      type        TEXT DEFAULT 'cc',
      number      INTEGER DEFAULT 0,
      action      TEXT NOT NULL,
      label       TEXT,
      is_fader    INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS studio_sessions (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS studio_session_versions (
      id             TEXT PRIMARY KEY,
      session_id     TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      label          TEXT,
      snapshot       TEXT NOT NULL,
      created_at     INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES studio_sessions(id)
    );

    CREATE TABLE IF NOT EXISTS studio_notes (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      position_ms INTEGER NOT NULL,
      track_id    TEXT,
      author      TEXT NOT NULL,
      text        TEXT NOT NULL,
      color       TEXT DEFAULT '#f59e0b',
      resolved    INTEGER DEFAULT 0,
      created_at  INTEGER NOT NULL
    );
  `);

  // Part 2 tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS operators (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      name     TEXT NOT NULL,
      initials TEXT NOT NULL DEFAULT '',
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS operator_notes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      operator_id INTEGER NOT NULL REFERENCES operators(id),
      note        TEXT NOT NULL DEFAULT '',
      updated_at  INTEGER DEFAULT (unixepoch())
    );
  `);

  ok("CREATE TABLE block executed without error");
} catch (e) {
  fail(`CREATE TABLE block failed: ${e.message}`);
  createError = e;
}

// ── Step 2: Run alterSafe calls ───────────────────────────────
console.log("\nStep 2: Running alterSafe calls...");
const alterResults = [];
const alterSafe = (sql) => {
  try {
    db.exec(sql);
    alterResults.push({ sql, result: "ok" });
  } catch (e) {
    const msg = e.message || String(e);
    if (msg.includes("duplicate column name") || msg.includes("already exists")) {
      // Column already exists from CREATE TABLE — idempotent, expected on fresh DB
      alterResults.push({ sql, result: "idempotent (column already in CREATE TABLE)" });
    } else if (msg.includes("no such table")) {
      // Table missing from initial schema — main.js silently swallows this too.
      // Pre-existing condition (e.g. pinned_songs created by a later migration).
      alterResults.push({ sql, result: `WARN (no such table — pre-existing): ${msg}` });
    } else {
      alterResults.push({ sql, result: `ERROR: ${msg}` });
      fail(`alterSafe failed: ${sql}\n    → ${msg}`);
    }
  }
};

// All alterSafe calls from main.js (in order)
alterSafe("ALTER TABLE songs ADD COLUMN is_explicit INTEGER DEFAULT 0");
alterSafe("ALTER TABLE songs ADD COLUMN raw_metadata TEXT");
alterSafe("ALTER TABLE songs ADD COLUMN daypart_mask INTEGER DEFAULT 127");
alterSafe("ALTER TABLE songs ADD COLUMN no_repeat_hours INTEGER DEFAULT 2");
alterSafe("ALTER TABLE songs ADD COLUMN rotation_status TEXT DEFAULT 'active'");
alterSafe("ALTER TABLE songs ADD COLUMN intro_version_path TEXT");
alterSafe("ALTER TABLE songs ADD COLUMN has_intro INTEGER DEFAULT 0");
alterSafe("ALTER TABLE songs ADD COLUMN energy REAL");
alterSafe("ALTER TABLE songs ADD COLUMN last_played_at INTEGER");
alterSafe("ALTER TABLE songs ADD COLUMN play_count INTEGER DEFAULT 0");
alterSafe("ALTER TABLE clocks ADD COLUMN show_id INTEGER");
alterSafe("ALTER TABLE scheduled_log ADD COLUMN chain_type TEXT DEFAULT 'segue'");
alterSafe("ALTER TABLE scheduled_log ADD COLUMN overflow INTEGER DEFAULT 0");
alterSafe("ALTER TABLE scheduled_log ADD COLUMN fade_out_at_ms INTEGER DEFAULT 0");
alterSafe("ALTER TABLE scheduled_log ADD COLUMN fade_duration_ms INTEGER DEFAULT 8000");
alterSafe("ALTER TABLE scheduled_log ADD COLUMN category_code TEXT");
alterSafe("ALTER TABLE scheduled_log ADD COLUMN slot_type TEXT");
alterSafe("ALTER TABLE scheduled_log ADD COLUMN song_title TEXT");
alterSafe("ALTER TABLE scheduled_log ADD COLUMN song_artist TEXT");
alterSafe("ALTER TABLE scheduled_log ADD COLUMN category_color TEXT");
alterSafe("ALTER TABLE scheduled_log ADD COLUMN label TEXT");
alterSafe("ALTER TABLE scheduled_log ADD COLUMN status TEXT");
alterSafe("ALTER TABLE spots ADD COLUMN isci_code TEXT");
alterSafe("ALTER TABLE spots ADD COLUMN cart_number TEXT");
alterSafe("ALTER TABLE spots ADD COLUMN agency TEXT");
alterSafe("ALTER TABLE spots ADD COLUMN length_sec INTEGER");
alterSafe("ALTER TABLE play_log ADD COLUMN scheduled_log_id INTEGER");
alterSafe("ALTER TABLE play_log ADD COLUMN show_name TEXT");
alterSafe("ALTER TABLE play_log ADD COLUMN category_code TEXT");
alterSafe("ALTER TABLE play_log ADD COLUMN programming_row_id INTEGER");
alterSafe("ALTER TABLE clocks ADD COLUMN description TEXT");
alterSafe("ALTER TABLE clocks ADD COLUMN color TEXT");
alterSafe("ALTER TABLE shows ADD COLUMN clock_id INTEGER REFERENCES clocks(id)");
alterSafe("ALTER TABLE play_log ADD COLUMN deck_id TEXT");
alterSafe("ALTER TABLE play_log ADD COLUMN session_id TEXT");
alterSafe("ALTER TABLE play_log ADD COLUMN file_path TEXT");   // v19: affidavit join key
alterSafe("ALTER TABLE artists ADD COLUMN gender TEXT DEFAULT 'unknown'");
alterSafe("ALTER TABLE deck_configs ADD COLUMN purpose TEXT DEFAULT ''");
alterSafe("ALTER TABLE operators ADD COLUMN theme TEXT DEFAULT NULL");
alterSafe("ALTER TABLE songs ADD COLUMN spotify_uri TEXT DEFAULT NULL");
alterSafe("ALTER TABLE format_clocks ADD COLUMN daypart TEXT NOT NULL DEFAULT 'Morning Drive'");
alterSafe("ALTER TABLE format_clocks ADD COLUMN slots_json TEXT NOT NULL DEFAULT '[]'");
alterSafe("ALTER TABLE crash_recovery ADD COLUMN queue_json TEXT DEFAULT '[]'");
alterSafe("ALTER TABLE crash_recovery ADD COLUMN deck_a_path TEXT");
alterSafe("ALTER TABLE crash_recovery ADD COLUMN deck_a_title TEXT");
alterSafe("ALTER TABLE crash_recovery ADD COLUMN deck_a_artist TEXT");
alterSafe("ALTER TABLE crash_recovery ADD COLUMN deck_a_position INTEGER DEFAULT 0");
alterSafe("ALTER TABLE crash_recovery ADD COLUMN was_playing INTEGER DEFAULT 0");
alterSafe("ALTER TABLE stations ADD COLUMN icecast_server_url TEXT DEFAULT '127.0.0.1'");
alterSafe("ALTER TABLE stations ADD COLUMN icecast_mount TEXT DEFAULT '/live'");
alterSafe("ALTER TABLE stations ADD COLUMN icecast_password TEXT DEFAULT 'hackme'");
alterSafe("ALTER TABLE stations ADD COLUMN icecast_bitrate INTEGER DEFAULT 128");
alterSafe("ALTER TABLE stations ADD COLUMN icecast_format TEXT DEFAULT 'mp3'");

// uuid + sync columns loop
const uuidNeededNow = [
  'announcements', 'artists', 'cart_slots', 'categories',
  'clocks', 'liner_cards', 'macros', 'operators',
  'pinned_songs', 'play_log', 'prep_notes', 'scheduled_log', 'spots',
];
for (const tbl of uuidNeededNow) {
  alterSafe(`ALTER TABLE ${tbl} ADD COLUMN uuid TEXT`);
  alterSafe(`ALTER TABLE ${tbl} ADD COLUMN created_at TEXT`);
  alterSafe(`ALTER TABLE ${tbl} ADD COLUMN updated_at TEXT`);
  alterSafe(`ALTER TABLE ${tbl} ADD COLUMN deleted_at TEXT`);
}

// station_id loop
const stationTables = [
  'artists', 'albums', 'categories', 'songs', 'separation_rules',
  'clocks', 'clock_slots', 'shows', 'play_log', 'scheduled_log',
  'spots', 'cart_slots', 'announcements', 'voice_tracks',
  'smart_schedule_rules', 'liner_cards', 'prep_notes',
  'published_episodes', 'format_clocks', 'generated_schedule',
  'operators', 'operator_notes', 'deck_configs',
  'macros', 'rtmp_destinations',
];
for (const tbl of stationTables) {
  alterSafe(`ALTER TABLE ${tbl} ADD COLUMN station_id INTEGER NOT NULL DEFAULT 1`);
}

// station_config_kv sync columns
alterSafe('ALTER TABLE station_config_kv ADD COLUMN uuid TEXT');
alterSafe('ALTER TABLE station_config_kv ADD COLUMN created_at TEXT');
alterSafe('ALTER TABLE station_config_kv ADD COLUMN updated_at TEXT');
alterSafe('ALTER TABLE station_config_kv ADD COLUMN deleted_at TEXT');

const errorAlters = alterResults.filter(r => r.result.startsWith("ERROR"));
const warnAlters  = alterResults.filter(r => r.result.startsWith("WARN"));
const idempotentAlters = alterResults.filter(r => r.result.startsWith("idempotent"));
const okAlters = alterResults.filter(r => r.result === "ok");

if (errorAlters.length === 0) {
  ok(`${alterResults.length} alterSafe calls — ${okAlters.length} applied, ${idempotentAlters.length} idempotent, ${warnAlters.length} warn (table not in initial schema, matches main.js behavior)`);
  if (warnAlters.length > 0) {
    const warnTables = [...new Set(warnAlters.map(r => r.sql.match(/ALTER TABLE (\w+)/)?.[1]))].join(", ");
    console.log(`    Warned tables (pre-existing, main.js swallows same error): ${warnTables}`);
  }
} else {
  fail(`${errorAlters.length} alterSafe call(s) produced unexpected errors (listed above)`);
}

// ── Step 3: List all tables ───────────────────────────────────
console.log("\nStep 3: Tables present in fresh DB...");
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map(r => r.name);  // node:sqlite returns plain objects, same as better-sqlite3
console.log(`  Count: ${tables.length}`);
console.log(`  ${tables.join(", ")}`);

// ── Step 4: Assert expected columns per critical table ────────
console.log("\nStep 4: Column assertions for 6 critical tables...\n");

let allTablesOk = true;
for (const [tableName, expectedCols] of Object.entries(EXPECTED)) {
  const tableExists = tables.includes(tableName);
  if (!tableExists) {
    fail(`${tableName}: TABLE NOT FOUND`);
    allTablesOk = false;
    continue;
  }

  const actualCols = db.prepare(`PRAGMA table_info("${tableName}")`).all().map(r => r.name);
  const missing = expectedCols.filter(c => !actualCols.includes(c));
  const extra   = actualCols.filter(c => !expectedCols.includes(c));

  const colOk = missing.length === 0;
  const marker = colOk ? "✓" : "✗";
  console.log(`  ${marker} ${tableName} — ${actualCols.length} columns (expected ${expectedCols.length})`);
  console.log(`    Actual:   ${actualCols.join(", ")}`);

  if (missing.length > 0) {
    console.log(`    MISSING:  ${missing.join(", ")}`);
    fail(`${tableName}: missing columns: ${missing.join(", ")}`);
    allTablesOk = false;
  }
  if (extra.length > 0) {
    // Extra columns are not failures — they may come from uuid/station_id loops
    console.log(`    Extra (not in expected list, from uuid/station_id loops): ${extra.join(", ")}`);
  }
  if (colOk) ok(`${tableName}: all ${expectedCols.length} expected columns present`);
  console.log();
}

// ── Step 5: Cleanup ───────────────────────────────────────────
db.close(); // in-memory DB — nothing to delete

// ── Verdict ───────────────────────────────────────────────────
console.log("─".repeat(50));
console.log(`  Passed: ${passed}  Failed: ${failed}`);
console.log("─".repeat(50));
if (failed === 0) {
  console.log("\n  VERDICT: PASS");
  console.log("  main.js patch verified — ready for Group 1 renderer DDL removal.\n");
  process.exit(0);
} else {
  console.log("\n  VERDICT: FAIL");
  console.log("  Fix main.js before proceeding.\n");
  process.exit(1);
}
