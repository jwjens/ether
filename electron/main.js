// electron/main.js
// Ether Electron main process
// Replaces src-tauri entirely — Chromium rendering, Node.js backend, NAPI audio

// ─── PHASE A INSERT AUDIT — COMPLETE 2026-05-14 ──────────────────────────────
// The original concern: ~40 renderer INSERT callsites might write rows without
// an explicit station_id, breaking multi-station isolation. That concern was
// resolved during Phase F (sync engine work) before any callsite was broken in
// production. INSERT audit confirmed zero broken callsites (commit 08f75da).
//
// Phase A schema migrations (non-synced local tables):
//   eas_tests         station_id added — schema v13 (commit 433e7a0, 2026-05-14)
//   midi_mappings     station_id added — schema v14 (commit bcc9f66, 2026-05-14)
//   ai_voice_segments station_id added — schema v15 (commit 1c0fc88, 2026-05-14)
//
// Gate flag 'multistation_insert_audit_complete' = 'true':
//   Existing installs — flag already present in station_config_kv
//   Fresh installs    — seeded via INSERT OR IGNORE in runMigrations() (this file)
//   Guard location    — stations:create handler ~line 3935
//
// Multi-station station creation is now permitted.
//
// ── Original callsite inventory (audit history — not a live to-do list) ──────
// Table               File                               INSERT location
// categories          src/App.tsx                        ~line 3269
// categories          src/components/CreateShowWizard    ~line 164
// categories          src/components/ImportDialog.tsx    ~line 40
// categories          src/components/LibraryImport.tsx   ~line 387
// categories          src/components/Scheduler.tsx       ~line 295
// play_log            src/db/client.ts                   ~line 128
// play_log            src/audio/showClock.ts             ~line 121
// artists             src/components/ImportDialog.tsx    ~line 110
// artists             src/components/LibraryImport.tsx   ~line 373
// artists             src/components/NexGenImport.tsx    ~line 112
// songs               src/components/ImportDialog.tsx    ~line 116
// songs               src/components/LibraryImport.tsx   ~line 396
// songs               src/components/NexGenImport.tsx    ~line 123
// clock_slots         src/components/GSelectorImport.tsx ~line 234
// clock_slots         src/components/Scheduler.tsx       ~line 773
// clock_slots         src/components/Scheduler.tsx       ~line 788
// clock_slots         src/components/Scheduler.tsx       ~line 805
// scheduled_log       src/components/ProgramLog.tsx      ~line 222
// scheduled_log       src/components/ProgramLog.tsx      ~line 289
// scheduled_log       src/components/ProgramLog.tsx      ~line 297
// scheduled_log       src/components/ProgramLog.tsx      ~line 338
// shows               src/components/CreateShowWizard    ~line 182
// shows               src/components/ProgramLog.tsx      ~line 1473
// shows               src/components/Scheduler.tsx       ~line 116
// clocks              src/components/CreateShowWizard    ~line 146
// clocks              src/components/Scheduler.tsx       ~line 741
// voice_tracks        src/components/BroadcastEditor.tsx ~line 1304
// voice_tracks        src/components/VoiceTracker.tsx    ~line 558
// operators           src/components/OnShiftScreen.tsx   ~line 212
// operator_notes      src/components/OnShiftScreen.tsx   ~line 199
// spots               src/components/Spots.tsx           ~line 48
// spots               src/components/Spots.tsx           ~line 67
// spots               src/components/Spots.tsx           ~line 157
// cart_slots          src/components/CartWall.tsx        ~line 69
// announcements       src/components/Announcements.tsx   ~line 102
// macros              src/components/MacroEngine.tsx     ~line 207
// liner_cards         src/components/ShowPrep.tsx        ~line 274
// prep_notes          src/components/ShowPrep.tsx        ~line 391
// format_clocks       src/components/ClockEditor.tsx     ~line 168
// published_episodes  src/components/PublishEpisode.tsx  ~line 428
// ─────────────────────────────────────────────────────────────────────────────

// ── DIAGNOSTIC — writes to %TEMP%\ether-diag.txt to pinpoint early crash ─────
// Remove after the no-window bug is diagnosed.
(function() {
  try {
    const _fs = require('fs'), _os = require('os'), _p = require('path');
    const _log = (msg) => _fs.appendFileSync(_p.join(_os.tmpdir(), 'ether-diag.txt'),
      new Date().toISOString() + ' ' + msg + '\n');
    _log('POINT-1: main.js started  pid=' + process.pid + '  argv=' + process.argv.slice(1).join(' '));
    process.on('uncaughtException', (e) => _log('UNCAUGHT: ' + e.message + '\n' + (e.stack||'')));
    process.on('unhandledRejection', (r) => _log('UNHANDLED_REJECTION: ' + r));
    global.__etherDiag = _log;
  } catch(e) { /* silently skip if fs not available */ }
})();

// ── Load .env before anything else so process.env is populated for all modules ──
try { require("dotenv").config(); } catch (e) { /* dotenv optional in packaged build */ }

// Suppress dev-mode security warnings (webSecurity/CSP/eval needed for Vite HMR;
// all flags are stripped in the packaged build automatically).
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeImage, safeStorage, powerMonitor } = require("electron");

// ── Sentry (main process) ─────────────────────────────────────
try {
  const Sentry = require("@sentry/electron/main");
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    enabled: app.isPackaged,
    release: "ether@" + app.getVersion(),
    tracesSampleRate: 0.1,
  });
} catch (e) {
  console.log("[SENTRY] Not initialized:", e.message);
}
const path = require("path");
const fs = require("fs");
if (global.__etherDiag) global.__etherDiag('POINT-1b: path/fs loaded OK');
let Database;
try { Database = require("better-sqlite3"); if (global.__etherDiag) global.__etherDiag('POINT-1c: better-sqlite3 loaded OK'); }
catch(e) { if (global.__etherDiag) global.__etherDiag('POINT-1c: better-sqlite3 FAILED: ' + e.message); throw e; }
let SYNCED_TABLES, SYNCED_TABLES_SET;
try {
  ({ SYNCED_TABLES } = require('./sync/synced-tables'));
  SYNCED_TABLES_SET = new Set(SYNCED_TABLES);
  if (global.__etherDiag) global.__etherDiag('POINT-1d: synced-tables loaded OK  count=' + SYNCED_TABLES.length);
} catch(e) { if (global.__etherDiag) global.__etherDiag('POINT-1d: synced-tables FAILED: ' + e.message); throw e; }
console.log(`[db:execute guard] active — ${SYNCED_TABLES.length} synced tables locked from direct writes`);

// ── Startup diagnostics log ────────────────────────────────────
// Written to userData/ether-startup.log so packaged builds can be diagnosed
// without a terminal attached.
let _startupLogPath = null;
function logStartup(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  process.stdout.write(`[STARTUP] ${msg}\n`);
  if (_startupLogPath) {
    try { fs.appendFileSync(_startupLogPath, line); } catch {}
  }
}

// ── App identity ──────────────────────────────────────────────
app.setAppUserModelId("ether");

// ── Fix DPI scaling on Windows ────────────────────────────────
if (process.platform === "win32") {
  app.commandLine.appendSwitch("high-dpi-support", "1");
  app.commandLine.appendSwitch("force-device-scale-factor", "1");
}

// ── Single-instance lock ──────────────────────────────────────
// Without this, every additional Electron instance tries to bind port 3400
// and crashes with EADDRINUSE. The second instance focuses the running window
// and exits; the first instance never sees the conflict.
if (global.__etherDiag) global.__etherDiag('POINT-2: before requestSingleInstanceLock');
if (!app.requestSingleInstanceLock()) {
  if (global.__etherDiag) global.__etherDiag('POINT-2b: lock NOT acquired — exiting (another instance running)');
  app.quit();
  process.exit(0);
}
if (global.__etherDiag) global.__etherDiag('POINT-3: lock acquired OK');
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// ── Environment ───────────────────────────────────────────────
const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;
const VITE_DEV_URL = "http://127.0.0.1:1420";

// ── Load native audio addon ───────────────────────────────────
let audio;
try {
  audio = require("../native/ether-audio.node");
  audio.initAudioEngine();
  console.log("[AUDIO] Native engine initialized");
} catch (e) {
  console.error("[AUDIO] Failed to load native addon:", e.message);
  // Fallback stub so app doesn't crash during development
  audio = {
    initAudioEngine: () => true,
    audioLoad: () => true,
    audioPlay: () => true,
    audioPause: () => true,
    audioStop: () => true,
    audioSetVolume: () => true,
    audioGetState: () => JSON.stringify({ deckA: {}, deckB: {}, deckC: {} }),
    audioGetLevels: () => JSON.stringify({ a: 0, b: 0, c: 0 }),
    getFileDuration: () => 0,
    getLocalIp: () => "localhost",
    analyzeFile: () => -14,
    openUrl: () => true,
    openSoundSettings: () => true,
    watchdogSet: () => true,
  };
}

// ── Database ──────────────────────────────────────────────────
let db;
let cloudBackupTrigger = null; // set when cloud-backup module loads

function getDbPath() {
  // Use same path as Tauri so existing databases are found
  const appData = app.getPath("appData");
  const etherDir = path.join(appData, "com.ether.radio");
  require("fs").mkdirSync(etherDir, { recursive: true });
  return path.join(etherDir, "openair.db");
}

function initDb() {
  const dbPath = getDbPath();
  console.log("[DB] Path:", dbPath);
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  console.log("[DB] Connected:", dbPath);
  runMigrations();
  seedDeckConfigs();
  setTimeout(() => { try { console.log("[DB] Song count:", db.prepare("SELECT COUNT(*) as c FROM songs").get()); } catch(e) { console.log("[DB] Song count error:", e.message); } }, 500);
}

function runMigrationChain(db) {
  const applied = new Set(
    db.prepare("SELECT version FROM schema_version").all().map(r => r.version)
  );
  const MIGRATION_RE = /^migrate-.+-phase-sync-(\d+)\.js$/;
  const scriptsDir = path.join(__dirname, '..', 'scripts');
  const scripts = [];
  for (const f of require('fs').readdirSync(scriptsDir)) {
    const m = MIGRATION_RE.exec(f);
    if (m) scripts.push({ v: parseInt(m[1], 10), file: f });
  }
  scripts.sort((a, b) => a.v - b.v);
  for (const { v, file } of scripts) {
    if (applied.has(v)) continue;
    require(path.join(scriptsDir, file)).applyMigration(db);
  }
}

function runMigrations() {
  const schemaVersionExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version'"
  ).get();
  const isFreshInstall = !schemaVersionExists ||
    !db.prepare("SELECT 1 FROM schema_version LIMIT 1").get();

  require('../scripts/schema-v0-baseline')(db);

  // Add any missing columns via ALTER TABLE (safe to re-run)
  const alterSafe = (sql) => { try { db.exec(sql); } catch(e) { /* column already exists */ } };
  alterSafe("ALTER TABLE songs ADD COLUMN is_explicit INTEGER DEFAULT 0");
  alterSafe("ALTER TABLE songs ADD COLUMN raw_metadata TEXT");
  // Fix songs that got the wrong daypart_mask default (127 = only hours 0-6)
  db.exec("UPDATE songs SET daypart_mask = 16777215 WHERE daypart_mask = 127");
  alterSafe("ALTER TABLE songs ADD COLUMN daypart_mask INTEGER DEFAULT 127");
  alterSafe("ALTER TABLE songs ADD COLUMN no_repeat_hours INTEGER DEFAULT 2");
  alterSafe("ALTER TABLE songs ADD COLUMN rotation_status TEXT DEFAULT 'active'");
  alterSafe("ALTER TABLE songs ADD COLUMN intro_version_path TEXT");
  alterSafe("ALTER TABLE songs ADD COLUMN has_intro INTEGER DEFAULT 0");
  alterSafe("ALTER TABLE clocks ADD COLUMN show_id INTEGER");
  alterSafe("ALTER TABLE scheduled_log ADD COLUMN chain_type TEXT DEFAULT 'segue'");
  alterSafe("ALTER TABLE clock_slots ADD COLUMN chain_type TEXT DEFAULT 'segue'");
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
  alterSafe("ALTER TABLE artists ADD COLUMN gender TEXT DEFAULT 'unknown'");

  // Part 1 — deck purpose (controls mode-based visibility)
  alterSafe("ALTER TABLE deck_configs ADD COLUMN purpose TEXT DEFAULT ''");
  // Part 7 — per-operator theme + station logo
  alterSafe("ALTER TABLE operators ADD COLUMN theme TEXT DEFAULT NULL");
  // Part 8 — Spotify URI on songs
  alterSafe("ALTER TABLE songs ADD COLUMN spotify_uri TEXT DEFAULT NULL");
  // Format clock columns missing from early migration (slots → slots_json + daypart)
  alterSafe("ALTER TABLE format_clocks ADD COLUMN daypart TEXT NOT NULL DEFAULT 'Morning Drive'");
  alterSafe("ALTER TABLE format_clocks ADD COLUMN slots_json TEXT NOT NULL DEFAULT '[]'");
  // crash_recovery columns added after initial schema
  alterSafe("ALTER TABLE crash_recovery ADD COLUMN queue_json TEXT DEFAULT '[]'");
  alterSafe("ALTER TABLE crash_recovery ADD COLUMN deck_a_path TEXT");
  alterSafe("ALTER TABLE crash_recovery ADD COLUMN deck_a_title TEXT");
  alterSafe("ALTER TABLE crash_recovery ADD COLUMN deck_a_artist TEXT");
  alterSafe("ALTER TABLE crash_recovery ADD COLUMN deck_a_position INTEGER DEFAULT 0");
  alterSafe("ALTER TABLE crash_recovery ADD COLUMN was_playing INTEGER DEFAULT 0");
  // eas_tests: add station_id for existing installs (fresh installs get it from CREATE TABLE above)
  alterSafe("ALTER TABLE eas_tests ADD COLUMN station_id INTEGER NOT NULL DEFAULT 1");
  // midi_mappings: add station_id for existing installs
  alterSafe("ALTER TABLE midi_mappings ADD COLUMN station_id INTEGER NOT NULL DEFAULT 1");
  // ai_voice_segments: add station_id for existing installs
  alterSafe("ALTER TABLE ai_voice_segments ADD COLUMN station_id INTEGER NOT NULL DEFAULT 1");

  // EQ settings stored in station_config_kv with keys eq_deck_A, eq_deck_B, eq_deck_C, eq_deck_mic, eq_master
  // operators and operator_notes are in schema-v0-baseline.js (moved in Step 6)

  // ── Phase 1: Multi-station schema ────────────────────────────
  // Add Icecast columns to stations table
  alterSafe("ALTER TABLE stations ADD COLUMN icecast_server_url TEXT DEFAULT '127.0.0.1'");
  alterSafe("ALTER TABLE stations ADD COLUMN icecast_mount TEXT DEFAULT '/live'");
  alterSafe("ALTER TABLE stations ADD COLUMN icecast_password TEXT DEFAULT 'hackme'");
  alterSafe("ALTER TABLE stations ADD COLUMN icecast_bitrate INTEGER DEFAULT 128");
  alterSafe("ALTER TABLE stations ADD COLUMN icecast_format TEXT DEFAULT 'mp3'");

  // Ensure station 1 Icecast columns are filled if they were just added and are empty
  {
    const s1 = db.prepare("SELECT * FROM stations WHERE id=1").get();
    if (s1 && !s1.icecast_server_url) {
      const serverKv = db.prepare("SELECT value FROM station_config_kv WHERE key='playout_server'").get();
      const pwKv     = db.prepare("SELECT value FROM station_config_kv WHERE key='icecast_source_password'").get();
      db.prepare(
        "UPDATE stations SET icecast_server_url=?, icecast_mount='/live', icecast_password=? WHERE id=1"
      ).run(serverKv?.value?.trim() || '127.0.0.1', pwKv?.value?.trim() || 'hackme');
    }
  }

  // Phase 3.5 Commit 1: add uuid + timestamp columns to ONLY
  // the synced tables this commit's INSERTs actually touch.
  // The remaining synced tables get the same treatment in
  // a dedicated Commit 2 ("Phase Sync-1: complete sync
  // column rollout"), aligned with the v8 plan's intent.
  const uuidNeededNow = [
    'announcements', 'artists', 'cart_slots', 'categories',
    'clocks', 'liner_cards', 'macros', 'operators',
    'pinned_songs', 'play_log', 'prep_notes', 'scheduled_log',
    'spots',
  ];
  for (const tbl of uuidNeededNow) {
    alterSafe(`ALTER TABLE ${tbl} ADD COLUMN uuid TEXT`);
    alterSafe(`ALTER TABLE ${tbl} ADD COLUMN created_at TEXT`);
    alterSafe(`ALTER TABLE ${tbl} ADD COLUMN updated_at TEXT`);
    alterSafe(`ALTER TABLE ${tbl} ADD COLUMN deleted_at TEXT`);
  }

  // Add station_id to all station-scoped tables (songs excluded — install-scoped, column dropped in v12)
  const stationTables = [
    'artists', 'albums', 'categories', 'separation_rules',
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

  // Recreate station_config_kv with composite PK (station_id, key) — idempotent
  const kvcols = db.prepare("PRAGMA table_info(station_config_kv)").all();
  const kvHasStationId = kvcols.some(c => c.name === 'station_id');
  if (!kvHasStationId) {
    const oldRows = db.prepare("SELECT key, value FROM station_config_kv").all();
    db.exec(`
      ALTER TABLE station_config_kv RENAME TO _station_config_kv_old;
      CREATE TABLE station_config_kv (
        station_id INTEGER NOT NULL DEFAULT 0,
        key TEXT NOT NULL,
        value TEXT,
        PRIMARY KEY (station_id, key)
      );
    `);
    const ins = db.prepare("INSERT OR IGNORE INTO station_config_kv (station_id, key, value) VALUES (?, ?, ?)");
    const migrate = db.transaction(() => {
      for (const row of oldRows) ins.run(0, row.key, row.value);
    });
    migrate();
    db.exec("DROP TABLE _station_config_kv_old");
    console.log("[DB] Migrated station_config_kv to composite PK (station_id, key)");
  }

  // station_config_kv uuid + timestamp columns — must run AFTER the recreation block
  // above, since that block creates a fresh table without these columns.
  alterSafe('ALTER TABLE station_config_kv ADD COLUMN uuid TEXT');
  alterSafe('ALTER TABLE station_config_kv ADD COLUMN created_at TEXT');
  alterSafe('ALTER TABLE station_config_kv ADD COLUMN updated_at TEXT');
  alterSafe('ALTER TABLE station_config_kv ADD COLUMN deleted_at TEXT');

  // Station-scope index for eas_tests (idempotent)
  db.exec("CREATE INDEX IF NOT EXISTS idx_eas_tests_station_id ON eas_tests(station_id)");
  // Station-scope index for midi_mappings (idempotent)
  db.exec("CREATE INDEX IF NOT EXISTS idx_midi_mappings_station_id ON midi_mappings(station_id)");
  // Station-scope index for ai_voice_segments (idempotent)
  db.exec("CREATE INDEX IF NOT EXISTS idx_ai_voice_segments_station_id ON ai_voice_segments(station_id)");

  // FTS index for song search
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS songs_fts USING fts5(title, artist);
    CREATE TRIGGER IF NOT EXISTS trg_songs_fts_insert AFTER INSERT ON songs BEGIN
      INSERT INTO songs_fts(rowid, title, artist) SELECT NEW.id, NEW.title, a.name FROM artists a WHERE a.id = NEW.artist_id;
    END;
  `);
  // Migrate delete trigger to fire on soft-delete (UPDATE deleted_at NULL→non-NULL)
  // rather than hard DELETE, because songsDelete uses UPDATE. The DROP+CREATE is
  // idempotent — safe to run on every startup to pick up the new form.
  db.exec(`
    DROP TRIGGER IF EXISTS trg_songs_fts_delete;
    CREATE TRIGGER trg_songs_fts_delete
      AFTER UPDATE OF deleted_at ON songs
      WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
    BEGIN
      DELETE FROM songs_fts WHERE rowid = OLD.id;
    END;
  `);

  // FTS update trigger: keep search index in sync when title or artist changes.
  // DROP+CREATE is idempotent — safe every boot.
  db.exec(`
    DROP TRIGGER IF EXISTS trg_songs_fts_update;
    CREATE TRIGGER trg_songs_fts_update
      AFTER UPDATE OF title, artist_id ON songs
      WHEN NEW.deleted_at IS NULL
    BEGIN
      DELETE FROM songs_fts WHERE rowid = OLD.id;
      INSERT INTO songs_fts(rowid, title, artist)
        SELECT NEW.id, NEW.title, a.name FROM artists a WHERE a.id = NEW.artist_id;
    END;
  `);

  // Phase 3.5 FTS fix: convert songs_fts from external-content to standalone if needed.
  // External-content mode (content='songs') caused FTS5 to auto-generate
  // SELECT T.title, T.artist FROM songs AS T on DELETE, failing because songs has
  // artist_id not artist — rolling back every songsDelete transaction silently.
  // Idempotent: only rebuilds when the current definition still contains content='songs'.
  {
    const ftsRow = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='songs_fts'"
    ).get();
    if (ftsRow && ftsRow.sql && ftsRow.sql.includes("content='songs'")) {
      console.log("[DB] Migrating songs_fts: external-content → standalone (phase-3.5 fix)");
      db.exec(`
        DROP TABLE IF EXISTS songs_fts;
        CREATE VIRTUAL TABLE songs_fts USING fts5(title, artist);
        INSERT INTO songs_fts(rowid, title, artist)
          SELECT s.id, s.title, COALESCE(a.name, '')
          FROM songs s LEFT JOIN artists a ON a.id = s.artist_id
          WHERE s.deleted_at IS NULL;
      `);
      const { c } = db.prepare("SELECT COUNT(*) as c FROM songs_fts").get();
      console.log("[DB] songs_fts rebuilt as standalone —", c, "rows indexed");
    }
  }

  // Enable all 6 deck slots — Apply Layout was broken in Phase 3b, so existing
  // installs may have D/E/F stuck at disabled. Re-enable them so all 6 show.
  db.exec("UPDATE deck_configs SET enabled=1 WHERE slot IN ('D','E','F')");

  // Seed bare station 1 before chain so migration-6's seeding loop has a station to bind to
  if (isFreshInstall) {
    const stationCount = db.prepare("SELECT COUNT(*) as c FROM stations").get().c;
    if (stationCount === 0) {
      db.prepare("INSERT INTO stations (name) VALUES (?)").run('Station 1');
    }
  }

  runMigrationChain(db);

  if (isFreshInstall) seedFreshInstall();

  console.log("[DB] Schema ready");

  const maxVer = db.prepare("SELECT MAX(version) AS v FROM schema_version").get();
  if (maxVer?.v) {
    db.prepare("INSERT OR REPLACE INTO system_state (key, value, updated_at) VALUES ('schema_version', ?, unixepoch())").run(String(maxVer.v));
  }
}

// ── Fresh-install seeder ──────────────────────────────────────
// Business data only — no schema. All blocks are count-guarded so this is
// safe to call unconditionally (no-ops on existing installs).
// Called from runMigrations(); conditional guard (isFreshInstall) added in Step 6.
function seedFreshInstall() {
  db.exec("INSERT OR IGNORE INTO crash_recovery (id) VALUES (1)");

  const userCount = db.prepare("SELECT COUNT(*) as n FROM users").get();
  if (userCount.n === 0) {
    db.exec(`
      INSERT INTO users (name, role, pin_hash, color) VALUES ('Admin', 'admin', '1234', '#f87171');
      INSERT INTO users (name, role, pin_hash, color) VALUES ('Jock', 'jock', NULL, '#22d3ee');
      INSERT INTO users (name, role, pin_hash, color) VALUES ('Music Director', 'music_director', '1234', '#a78bfa');
    `);
  }

  db.prepare("INSERT OR IGNORE INTO station_config_kv (key, value) VALUES ('multistation_insert_audit_complete', 'true')").run();

  const stationCount = db.prepare("SELECT COUNT(*) as c FROM stations").get();
  if (stationCount.c === 0) {
    const serverKv = db.prepare("SELECT value FROM station_config_kv WHERE key='playout_server'").get();
    const pwKv     = db.prepare("SELECT value FROM station_config_kv WHERE key='icecast_source_password'").get();
    const nameKv   = db.prepare("SELECT value FROM station_config_kv WHERE key='station_name'").get();
    db.prepare(
      "INSERT INTO stations (id, name, callsign, is_active, icecast_server_url, icecast_mount, icecast_password, icecast_bitrate, icecast_format) VALUES (1, ?, '', 1, ?, '/live', ?, 128, 'mp3')"
    ).run(nameKv?.value || 'Station 1', serverKv?.value?.trim() || '127.0.0.1', pwKv?.value?.trim() || 'hackme');
    console.log("[DB] Seeded station 1");
  }

  const ruleCount = db.prepare("SELECT COUNT(*) as c FROM separation_rules").get();
  if (ruleCount.c === 0) {
    const sid = getActiveStationId();
    const insertRule = db.prepare(
      "INSERT INTO separation_rules (station_id, rule_type, scope, value, is_hard, is_active, description) VALUES (?,?,?,?,?,?,?)"
    );
    const seedRules = db.transaction(() => {
      insertRule.run(sid, 'artist_separation_min', 'global', 60,  1, 1, 'Minimum minutes between songs by the same artist');
      insertRule.run(sid, 'song_separation_min',   'global', 180, 1, 1, 'Minimum minutes before a song can repeat');
      insertRule.run(sid, 'title_separation_min',  'global', 120, 1, 1, 'Minimum minutes between songs with the same title');
      insertRule.run(sid, 'max_same_gender',        'global', 3,   0, 1, 'Max consecutive songs of the same gender');
      insertRule.run(sid, 'max_same_category',      'global', 3,   0, 1, 'Max consecutive songs from the same category');
    });
    seedRules();
    console.log("[DB] Seeded default separation rules for station", sid);
  }
}

// ── Active station helper ─────────────────────────────────────
function getActiveStationId() {
  try {
    const row = db.prepare("SELECT id FROM stations WHERE is_active=1 LIMIT 1").get();
    return row?.id ?? 1;
  } catch { return 1; }
}

// ── Deck config seeder ────────────────────────────────────────
// Deck slots A-F are defined HERE, in the database, on every startup.
// Do NOT hardcode deck slot lists in any React component or UI file.
// UI code reads from this table; it never defines which slots exist.
function seedDeckConfigs() {
  const defaults = [
    { slot: "A", type: "music", label: "Deck A", color: "#34d399", enabled: 1 },
    { slot: "B", type: "music", label: "Deck B", color: "#38bdf8", enabled: 1 },
    { slot: "C", type: "music", label: "Deck C", color: "#a78bfa", enabled: 1 },
    { slot: "D", type: "music", label: "Deck D", color: "#f97316", enabled: 0 },
    { slot: "E", type: "music", label: "Deck E", color: "#ef4444", enabled: 0 },
    { slot: "F", type: "guest", label: "Guest 2", color: "#a78bfa", enabled: 0 },
  ];
  const insert = db.prepare(
    "INSERT OR IGNORE INTO deck_configs (slot, type, label, color, enabled) VALUES (?, ?, ?, ?, ?)"
  );
  const seed = db.transaction((decks) => {
    for (const d of decks) insert.run(d.slot, d.type, d.label, d.color, d.enabled);
  });
  seed(defaults);
  // Fix any D/E/F rows incorrectly seeded as enabled=1 by pre-AUX code
  db.prepare("UPDATE deck_configs SET enabled=0 WHERE slot IN ('D','E','F') AND enabled=1").run();
  const { c } = db.prepare("SELECT COUNT(*) as c FROM deck_configs").get();
  console.log(`[DeckGuard] ✓ deck_configs: ${c}/6 slots present — A B C D E F guaranteed in database`);
}

// ── Window ────────────────────────────────────────────────────
let mainWindow;
let splashWindow;
let tray;

const ICON_PNG   = path.join(__dirname, "assets/icon.png");
const TRAY_PNG   = path.join(__dirname, "assets/tray-icon.png");

function createSplash() {
  splashWindow = new BrowserWindow({
    width:         820,
    height:        480,
    frame:         false,
    transparent:   true,
    alwaysOnTop:   true,
    center:        true,
    resizable:      false,
    skipTaskbar:    true,
    roundedCorners: true,
    show:           false,       // hidden until centered
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      webSecurity:      false,   // allow file:// assets (svg, png) in local HTML
    },
  });

  splashWindow.loadFile(path.join(__dirname, "splash.html"));
  splashWindow.once("ready-to-show", () => {
    splashWindow.center();
    splashWindow.show();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: "ether",
    icon: ICON_PNG,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false, // Allow localhost in dev
    },
    show: false,
  });

  // Allow localhost connections
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": ["default-src * 'unsafe-inline' 'unsafe-eval' data: blob:"]
      }
    });
  });

  // Load app with retry for dev server
  if (isDev) {
    const tryLoad = () => {
      const net = require("net");
      const client = new net.Socket();
      client.setTimeout(1000);
      client.connect(1420, "127.0.0.1", () => {
        client.destroy();
        mainWindow.loadURL(VITE_DEV_URL);
        if (!app.isPackaged) {
          mainWindow.webContents.openDevTools();
        }
      });
      client.on("error", () => {
        client.destroy();
        console.log("[ELECTRON] Vite not ready, retrying in 1s...");
        setTimeout(tryLoad, 1000);
      });
      client.on("timeout", () => {
        client.destroy();
        setTimeout(tryLoad, 1000);
      });
    };
    setTimeout(tryLoad, 500);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  // Do NOT show here — startup timing is controlled in app.whenReady()
  // mainWindow stays hidden (show: false) until the splash finishes.

  // If the renderer fails to load, force-show so the user sees something instead of nothing
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    logStartup(`did-fail-load: code=${errorCode} desc=${errorDescription} url=${validatedURL}`);
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.setOpacity(1);
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // Hide instead of close (keeps app in tray)
  mainWindow.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // Grant mic permission automatically — no dialog needed
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === "media" || permission === "microphone" || permission === "audioCapture") {
      callback(true); // Always grant
    } else {
      callback(true);
    }
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(TRAY_PNG).resize({ width: 32, height: 32 });
  tray = new Tray(icon);
  const menu = Menu.buildFromTemplate([
    { label: "Show Ether", click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: "separator" },
    { label: "Quit", click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip("Ether — On Air");
  tray.on("click", () => {
    if (mainWindow.isVisible()) { mainWindow.hide(); }
    else { mainWindow.show(); mainWindow.focus(); }
  });
}

// ── App lifecycle ─────────────────────────────────────────────
function buildMenu() {
  const send = (cmd) => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    if (win) win.webContents.send("menu-action", cmd);
  };
  const popout = (panel) => {
    // Re-use the same handler logic as the IPC "window:popout" handler
    const tag = `popout:${panel}`;
    const existing = BrowserWindow.getAllWindows().find(w => w.getTitle() === tag);
    if (existing) { existing.show(); existing.focus(); return; }
    const { screen } = require("electron");
    const size = POPOUT_SIZES[panel] || { width: 640, height: 520 };
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    const secondary = displays.find(d => d.id !== primary.id);
    const x = secondary ? secondary.workArea.x + 60 : undefined;
    const y = secondary ? secondary.workArea.y + 60 : undefined;
    const win = new BrowserWindow({
      width: size.width, height: size.height,
      minWidth: 320, minHeight: 200, x, y,
      title: tag, frame: false, transparent: false,
      backgroundColor: "#0e0e14", resizable: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true, nodeIntegration: false, webSecurity: false,
      },
    });
    if (isDev) win.loadURL(VITE_DEV_URL + `#popout/${panel}`);
    else win.loadFile(path.join(__dirname, "../dist/index.html"), { hash: `popout/${panel}` });
  };
  const template = [
    { label: "File", submenu: [
      { label: "New Session", accelerator: "CmdOrCtrl+N", click: () => send("file:new-session") },
      { label: "Save Layout", accelerator: "CmdOrCtrl+S", click: () => send("file:save") },
      { type: "separator" },
      { label: "Import Music...", click: () => send("file:import") },
      { label: "Preferences", click: () => send("file:preferences") },
      { type: "separator" },
      { label: "Quit", accelerator: "CmdOrCtrl+Q", click: () => { app.isQuitting = true; app.quit(); } },
    ]},
    { label: "View", submenu: [
      { label: "Play Queue", click: () => send("view:queue") },
      { label: "Deck A", click: () => send("view:deckA") },
      { label: "Deck B", click: () => send("view:deckB") },
      { label: "Deck C", click: () => send("view:deckC") },
      { label: "Mic Deck", click: () => send("view:mic") },
      { type: "separator" },
      { label: "Configure Decks...", click: () => send("view:configure-decks") },
      { label: "Reset to Default", click: () => send("view:reset") },
      { type: "separator" },
      { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => mainWindow?.webContents.reload() },
      { label: "Toggle DevTools", accelerator: "F12", click: () => mainWindow?.webContents.toggleDevTools() },
    ]},
    { label: "Library", submenu: [
      { label: "Song Library", click: () => send("nav:library") },
      { label: "Spots & Promos", click: () => send("nav:spots") },
      { label: "Voice Tracker", click: () => send("nav:voicetrack") },
      { type: "separator" },
      { label: "Import from Folder...", click: () => send("file:import") },
      { label: "Cue Editor", click: () => send("nav:trackedit") },
    ]},
    { label: "Schedule", submenu: [
      { label: "Clocks",           click: () => { send("nav:clocks"); send("nav:scheduler-tab:clocks"); } },
      { label: "Shows & Dayparts", click: () => { send("nav:clocks"); send("nav:scheduler-tab:shows"); } },
      { label: "Categories",       click: () => { send("nav:clocks"); send("nav:scheduler-tab:categories"); } },
      { type: "separator" },
      { label: "Program Log",      click: () => send("nav:programlog") },
      { label: "Play Log",         click: () => send("nav:logs") },
      { label: "Announcements",    click: () => send("nav:announce") },
      { label: "EAS Logbook",     click: () => send("nav:eas") },
    ]},
    { label: "Tools", submenu: [
      { label: "Voice Tracker", click: () => send("nav:voicetrack") },
      { label: "Studio Editor", click: () => send("nav:studio") },
      { label: "Video Studio",  click: () => send("nav:videostudio") },
      { label: "Cue Editor", click: () => send("nav:trackedit") },
      { label: "Clip Editor", click: () => send("nav:clipeditor") },
      { type: "separator" },
      { label: "Import Library...", click: () => send("nav:importlibrary") },
      { type: "separator" },
      { label: "Stream Manager", click: () => send("nav:streaming") },
      { label: "Smart Scheduler", click: () => send("nav:smartschedule") },
      { label: "Listener Analytics", click: () => send("nav:analytics") },
      { label: "Cloud Log Backup",   click: () => send("nav:cloudbackup") },
      { label: "Audio Routing", click: () => send("nav:multioutput") },
      { label: "Station Manager", click: () => send("nav:stationmanager") },
      { type: "separator" },
      { label: "System Health", click: () => send("nav:health") },
      { type: "separator" },
      { label: "Monitors", submenu: [
        { label: "Decks",          click: () => popout("decks") },
        { label: "Video Studio",   click: () => popout("videostudio") },
        { label: "Camera",         click: () => popout("camera") },
        { label: "Queue / Up Next",click: () => popout("upnext") },
        { label: "Station Health", click: () => popout("health") },
        { type: "separator" },
        { label: "Mic",            click: () => popout("mic") },
        { label: "Master Output",  click: () => popout("master") },
        { label: "Phone Desk",     click: () => popout("phone") },
        { label: "Voice Tracker",  click: () => popout("voicetrack") },
      ]},
    ]},
    { label: "Help", submenu: [
      { label: "Keyboard Shortcuts", click: () => send("help:shortcuts") },
      { label: "Documentation", click: () => shell.openExternal("https://github.com/jwjens/ether") },
      { type: "separator" },
      { label: "Check for Updates", click: () => send("help:check-updates") },
      { label: "About Ether", click: () => send("nav:about") },
    ]},
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── VIP invite file detection ─────────────────────────────────
// Checks for ether-invite.json in the exe dir or resources path.
// Runs once after DB is ready. Deletes the file after reading so it never fires twice.
let _inviteUsed = false;
let _invitedBy = "";

function processInviteFile() {
  const searchPaths = [
    path.join(path.dirname(app.getPath("exe")), "ether-invite.json"),
    path.join(process.resourcesPath || "", "ether-invite.json"),
    path.join(app.getAppPath(), "ether-invite.json"),
  ];

  let invitePath = null;
  for (const p of searchPaths) {
    try { if (fs.existsSync(p)) { invitePath = p; break; } } catch {}
  }
  if (!invitePath) return;

  let invite;
  try {
    invite = JSON.parse(fs.readFileSync(invitePath, "utf8"));
  } catch (e) {
    console.error("[Invite] Failed to parse invite file:", e.message);
    return;
  }

  try {
    // Check if first run is already complete
    const inviteStationId = getActiveStationId();
    const existing = db.prepare(
      "SELECT value FROM station_config_kv WHERE station_id = ? AND key = 'first_run_complete' AND deleted_at IS NULL"
    ).get(inviteStationId);
    if (existing && existing.value === "1") {
      console.log("[Invite] First run already complete — skipping invite processing");
      fs.renameSync(invitePath, invitePath + ".used");
      return;
    }

    // Create operator
    const { operatorsEnsureByName } = require('./sync/handlers/operators');
    const { operatorNotesUpsertByOperatorId } = require('./sync/handlers/operator_notes');
    const name = invite.operator_name || "Operator";
    const initials = invite.operator_initials || name.charAt(0);
    const op = operatorsEnsureByName(db, inviteStationId, name, initials);

    if (op && invite.personal_note) {
      operatorNotesUpsertByOperatorId(db, op.id, inviteStationId, invite.personal_note);
    }

    // Set experience mode + mark first run complete + store invite metadata
    const { stationConfigKvUpsertByKey } = require('./sync/handlers/station_config_kv');
    const mode = invite.experience_mode || "standard";
    stationConfigKvUpsertByKey(db, inviteStationId, 'experience_mode', mode);
    stationConfigKvUpsertByKey(db, inviteStationId, 'first_run_complete', '1');
    stationConfigKvUpsertByKey(db, inviteStationId, 'invite_used', '1');
    stationConfigKvUpsertByKey(db, inviteStationId, 'invited_by', invite.invited_by || "Deniro");

    _inviteUsed = true;
    _invitedBy = invite.invited_by || "Deniro";

    console.log(`[Invite] ✓ Processed invite for ${name} (invited by ${_invitedBy})`);

    // Rename so it never runs again
    fs.renameSync(invitePath, invitePath + ".used");
  } catch (e) {
    console.error("[Invite] Error processing invite:", e.message);
  }
}

// Module-level handle so before-quit can clear it
let levelPushId = null;

app.whenReady().then(() => {
  initDb(); // runMigrations() + seedDeckConfigs() run here before window loads
  processInviteFile(); // VIP invite seeding — runs after DB is ready

  // Cloud backup must init AFTER initDb() so db is not undefined
  try {
    const { installCloudBackup, triggerUpload, getR2Config } = require("./cloud-backup.js");
    installCloudBackup(ipcMain, db, { dbPath: getDbPath() });
    cloudBackupTrigger = triggerUpload;
    app._getR2Config = getR2Config;

    // Auto-push R2 credentials to cloud playout server every startup.
    // Runs after a short delay so it doesn't block the app launching.
    setTimeout(async () => {
      try {
        const r2 = getR2Config();
        if (!r2.accessKeyId || !r2.secretAccessKey) {
          console.log('[PLAYOUT] Startup R2 push skipped — credentials not configured');
          return;
        }
        const row = db.prepare("SELECT value FROM station_config_kv WHERE key='playout_server'").get();
        const server = row?.value?.trim() || '44.244.52.207';
        const url = `http://${server}:3500/api/playout/r2config`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accountId:       r2.accountId,
            accessKeyId:     r2.accessKeyId,
            secretAccessKey: r2.secretAccessKey,
            bucket:          r2.bucket,
            endpoint:        r2.endpoint,
          }),
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) console.log(`[PLAYOUT] R2 credentials auto-pushed to ${server} on startup`);
        else        console.warn(`[PLAYOUT] Startup R2 push returned ${res.status} from ${server}`);
      } catch (e) {
        console.warn('[PLAYOUT] Startup R2 push failed (server may be offline):', e.message);
      }
    }, 6000);
  } catch (e) {
    console.warn("[CLOUD-BACKUP] installCloudBackup failed:", e.message);
  }

  // sync IPC handlers — all 30 typed handler sets via aggregator
  // (stations:* excluded from installAll — registered manually below with custom logic)
  console.log('[sync/handlers] ▶ installAll starting (phase-3.5)');
  try {
    const { installAll } = require('./sync/handlers/index');
    installAll(ipcMain, db);
    console.log('[sync/handlers] ✓ installAll complete');
  } catch (e) {
    console.error("[sync/handlers] ✗ install failed:", e.message);
    console.error(e.stack);
  }

  // ── Sync scheduler — Phase F Stage 4 ──────────────────────────
  // Off by default. Users opt in via Settings → System → Multi-Device Sync.
  try {
    const enabledRow = db.prepare(
      "SELECT value FROM station_config_kv WHERE key = 'sync_enabled' LIMIT 1"
    ).get();
    if (enabledRow?.value !== 'true') {
      console.log('[SYNC] disabled (set sync_enabled=true in station_config_kv to activate)');
    } else {
      const { HttpTransport }   = require('./sync/transport-http');
      const { SyncScheduler }   = require('./sync/sync-scheduler');
      const urlRow  = db.prepare("SELECT value FROM station_config_kv WHERE key = 'sync_backend_url' LIMIT 1").get();
      const baseUrl = urlRow?.value || process.env.ETHER_SYNC_URL || '';
      const transport = new HttpTransport(db, { baseUrl });
      const scheduler = new SyncScheduler(db, transport, {
        // Read active station on every pull so mid-session station switches are handled
        // correctly. main.js owns getActiveStationId(); SyncEngine stores only the getter.
        getStationId: () => String(getActiveStationId()),
      });
      scheduler.start();
      app._syncScheduler = scheduler;

      powerMonitor.on('suspend',       () => scheduler.pause());
      powerMonitor.on('lock-screen',   () => scheduler.pause());
      powerMonitor.on('resume',        () => scheduler.resume());
      powerMonitor.on('unlock-screen', () => scheduler.resume());
    }
  } catch (e) {
    console.error('[SYNC] scheduler init failed:', e.message);
    console.error(e.stack);
  }

  if (global.__etherDiag) global.__etherDiag('POINT-4: app.whenReady() fired');
  // Initialize startup log — written to userData so it survives packaged builds with no terminal
  _startupLogPath = path.join(app.getPath('userData'), 'ether-startup.log');
  logStartup('=== SESSION START ===');
  logStartup(`version: ${app.getVersion()}  packaged: ${app.isPackaged}  pid: ${process.pid}`);
  logStartup(`userData: ${app.getPath('userData')}`);

  // Show native splash first; main window stays hidden behind it
  createSplash();
  logStartup('createSplash() done');
  createWindow();
  logStartup('createWindow() done — mainWindow hidden, waiting for ready-to-show');
  createTray();
  buildMenu();

  // ── Startup sequence ─────────────────────────────────────────
  // Splash shows for 10s, then:
  //   1. Splash fades out over 500ms
  //   2. Splash window closes
  //   3. Main window fades in over 500ms
  //   4. Main window focuses (login screen appears naturally inside it)
  //
  // Both conditions must be met before the sequence starts:
  //   • mainWindow has fired ready-to-show (renderer fully painted)
  //   • 10-second splash timer has elapsed
  let mainReady   = false;
  let splashTimer = false;

  function tryShowMain() {
    if (!mainReady || !splashTimer) return;

    // Step 1 — fade out splash over 500ms
    const doFadeIn = () => {
      // Step 2 — close splash
      if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();

      // Step 3 — fade main window in: start at opacity 0, ramp to 1 over 500ms
      mainWindow.setOpacity(0);
      mainWindow.show();

      let opacity = 0;
      const STEPS    = 20;           // 20 steps × 25ms = 500ms
      const STEP_AMT = 1 / STEPS;

      const fadeIn = setInterval(() => {
        opacity = Math.min(1, opacity + STEP_AMT);
        if (!mainWindow.isDestroyed()) mainWindow.setOpacity(opacity);
        if (opacity >= 1) {
          clearInterval(fadeIn);
          mainWindow.focus();        // Step 4 — focus; login appears inside the app
        }
      }, 25);
    };

    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.webContents
        .executeJavaScript(
          'document.body.style.transition="opacity 0.5s ease";' +
          'document.body.style.opacity="0";'
        )
        .then(() => setTimeout(doFadeIn, 500))
        .catch(doFadeIn); // if JS inject fails, proceed anyway
    } else {
      doFadeIn();
    }
  }

  mainWindow.once("ready-to-show", () => {
    logStartup('ready-to-show fired');
    mainReady = true;
    tryShowMain();
  });

  // ready-to-show has a known Electron bug where it doesn't fire for file:// loads
  // (packaged builds). did-finish-load is a reliable fallback — fires when the page
  // navigation completes. Both set mainReady; whichever fires first wins.
  mainWindow.webContents.once("did-finish-load", () => {
    logStartup('did-finish-load fired');
    mainReady = true;
    tryShowMain();
  });

  setTimeout(() => {
    logStartup(`splashTimer elapsed — mainReady=${mainReady}`);
    splashTimer = true;
    tryShowMain();
  }, 10000);

  // Hard fallback — if ready-to-show never fires in a packaged build (renderer crash,
  // preload error, or other packaged-only issue), force-show after 15s so the user
  // is not staring at a blank screen.
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      logStartup('WARN: force-showing main window — ready-to-show did not fire within 15s');
      if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
      mainWindow.setOpacity(1);
      mainWindow.show();
      mainWindow.focus();
    } else {
      logStartup('15s fallback check — window already visible, no action needed');
    }
  }, 15000);

  // Start 30fps real-time audio level push to renderer
  mainWindow.webContents.on("did-finish-load", () => {
    if (levelPushId) clearInterval(levelPushId);
    levelPushId = setInterval(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      try {
        const levels = JSON.parse(audio.audioGetLevels());
        levels.master = Math.max(levels.a || 0, levels.b || 0, levels.c || 0);
        sendToAllWindows("audio:levels", levels);
      } catch {}
    }, 33);
    // Write session header to rotation.log so every capture is clearly delimited
    try {
      const { execSync } = require("child_process");
      let commit = "unknown";
      try { commit = execSync("git rev-parse --short HEAD", { cwd: path.join(__dirname, ".."), timeout: 2000 }).toString().trim(); } catch {}
      const ts = new Date().toISOString();
      const sep = "========================================";
      fs.appendFileSync(_rotationLogPath, `\n${sep}\nSESSION START ${ts}\ncommit: ${commit}\n${sep}\n`);
    } catch {}
  });
});

app.on("window-all-closed", () => {
  // Keep running on Windows/Linux (app lives in tray)
  if (process.platform === "darwin") app.quit();
});

app.on("before-quit", () => {
  if (levelPushId) { clearInterval(levelPushId); levelPushId = null; }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else mainWindow.show();
});

app.on("before-quit", () => {
  if (levelPushId) { clearInterval(levelPushId); levelPushId = null; }
  if (app._syncScheduler) { app._syncScheduler.stop(); app._syncScheduler = null; }
  app.isQuitting = true;
});

// ── IPC Handlers ──────────────────────────────────────────────
// These replace all Tauri invoke() calls

// Sync
ipcMain.handle('sync:getStats', () => {
  const scheduler = app._syncScheduler ?? null;
  const enabledRow = db.prepare(
    "SELECT value FROM station_config_kv WHERE key = 'sync_enabled' LIMIT 1"
  ).get();
  const enabled = enabledRow?.value === 'true';
  if (scheduler) {
    return { enabled, running: true, ...scheduler.getStats() };
  }
  return { enabled, running: false, lastSyncAt: null, pushedToday: 0, pulledToday: 0 };
});

// Audio
ipcMain.handle("audio:load", (_, deck, filePath, title, artist, gainDb, stationId) =>
  audio.audioLoad(deck, filePath, title, artist, gainDb ?? 0, stationId));

ipcMain.handle("audio:play", (_, deck, stationId) => audio.audioPlay(deck, stationId));
ipcMain.handle("audio:pause", (_, deck, stationId) => audio.audioPause(deck, stationId));
ipcMain.handle("audio:stop", (_, deck, stationId) => audio.audioStop(deck, stationId));
ipcMain.handle("audio:setVolume", (_, deck, volume, stationId) => audio.audioSetVolume(deck, volume, stationId));
ipcMain.handle("audio:getState", (_, stationId) => JSON.parse(audio.audioGetState(stationId)));
ipcMain.handle("audio:getLevels", (_, stationId) => JSON.parse(audio.audioGetLevels(stationId)));
ipcMain.handle("audio:getFileDuration", (_, filePath) => audio.getFileDuration(filePath));
ipcMain.handle("audio:watchdogSet", (_, active, thresholdSec, stationId) => audio.watchdogSet(active, thresholdSec, stationId));
// EQ — sends 10 band gains (f32[]) to the station's EQ chain in the BusMixer.
ipcMain.handle("audio:setEq", (_, deck, bands, stationId) => {
  try { if (typeof audio.audioSetEq === "function") return audio.audioSetEq(stationId ?? 1, JSON.stringify(bands)); }
  catch(e) { console.warn("[EQ] audioSetEq error:", e.message); }
  return true;
});

ipcMain.handle("audio:listOutputDevices", () => {
  try {
    if (typeof audio.audioListOutputDevices !== "function") return [];
    return JSON.parse(audio.audioListOutputDevices());
  } catch { return []; }
});
ipcMain.handle("audio:setOutputDevice", (_, stationId, deviceName) => {
  try {
    if (typeof audio.audioSetOutputDevice !== "function") return false;
    return audio.audioSetOutputDevice(stationId, deviceName);
  } catch { return false; }
});

// Database
ipcMain.handle("db:query", (_, sql, params) => {
  try {
    const stmt = db.prepare(sql);
    return { data: stmt.all(...(params || [])), error: null };
  } catch (e) {
    return { data: null, error: e.message };
  }
});

function detectSyncedWrite(sql) {
  // Strip leading whitespace then leading SQL comments (-- line and /* */ block).
  let s = sql.trimStart();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (s.startsWith('--')) {
      const nl = s.indexOf('\n');
      s = nl === -1 ? '' : s.slice(nl + 1).trimStart();
    } else if (s.startsWith('/*')) {
      const end = s.indexOf('*/');
      s = end === -1 ? '' : s.slice(end + 2).trimStart();
    } else {
      break;
    }
  }

  const insertMatch  = s.match(/^INSERT\s+(?:OR\s+\w+\s+)?INTO\s+([`"]?[\w.]+[`"]?)/i);
  const replaceMatch = s.match(/^REPLACE\s+INTO\s+([`"]?[\w.]+[`"]?)/i);
  const updateMatch  = s.match(/^UPDATE\s+(?:OR\s+\w+\s+)?([`"]?[\w.]+[`"]?)\s+SET/i);
  const deleteMatch  = s.match(/^DELETE\s+FROM\s+([`"]?[\w.]+[`"]?)/i);

  const m = insertMatch || replaceMatch || updateMatch || deleteMatch;
  if (!m) return null;

  const verb = insertMatch ? 'INSERT' : replaceMatch ? 'REPLACE' : updateMatch ? 'UPDATE' : 'DELETE';

  // Strip surrounding quotes and schema prefix (e.g. "songs", `songs`, main.songs → songs)
  let table = m[1];
  if ((table.startsWith('"') && table.endsWith('"')) ||
      (table.startsWith('`') && table.endsWith('`'))) {
    table = table.slice(1, -1);
  }
  if (table.includes('.')) {
    table = table.split('.').pop();
  }

  return { verb, table: table.toLowerCase() };
}

ipcMain.handle("db:execute", (_, sql, params) => {
  try {
    // Synced-table write guard (Phase 3.5). SELECTs bypass detection entirely.
    if (!/^\s*SELECT/i.test(sql)) {
      const detection = detectSyncedWrite(sql);
      if (detection && SYNCED_TABLES_SET.has(detection.table)) {
        const msg = `ERR_SYNCED_TABLE_WRITE: table '${detection.table}' has a typed handler ` +
          `(window.ether.${detection.table}.*); db:execute is locked against direct writes to ` +
          `synced tables. See docs/phase-3.5-status-audit.md for migration guidance.`;
        console.error("[db:execute LOCKED]", detection.verb, detection.table, "— SQL:", sql.slice(0, 120));
        return { data: null, error: msg };
      }
      // No write op parsed — warn and allow (handles PRAGMA, DDL, unusual forms).
      if (!detection) {
        console.warn("[db:execute] could not parse write op from non-SELECT SQL:", sql.slice(0, 120));
      }
    }

    const stmt = db.prepare(sql);
    const result = stmt.run(...(params || []));
    return { data: result, error: null };
  } catch (e) {
    console.error("[DB execute error]", sql.slice(0, 100), e.message);
    return { data: null, error: e.message };
  }
});

// File system
ipcMain.handle("fs:readFile", async (_, filePath) => {
  try {
    const fd = fs.openSync(filePath, "r");
    const size = Math.min(fs.fstatSync(fd).size, 256 * 1024);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 0);
    fs.closeSync(fd);
    return { data: Array.from(buf), error: null };
  } catch (e) {
    return { data: null, error: e.message };
  }
});

ipcMain.handle("fs:readFileTail", async (_, filePath, n) => {
  try {
    const fd = fs.openSync(filePath, "r");
    const totalSize = fs.fstatSync(fd).size;
    const readSize = Math.min(n, totalSize);
    const offset = totalSize - readSize;
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, offset);
    fs.closeSync(fd);
    return { data: Array.from(buf), error: null };
  } catch (e) {
    return { data: null, error: e.message };
  }
});

ipcMain.handle("fs:exists", (_, filePath) => fs.existsSync(filePath));

ipcMain.handle("fs:readDir", (_, dirPath) => {
  try {
    return fs.readdirSync(dirPath).map(name => ({
      name,
      path: path.join(dirPath, name),
      isDir: fs.statSync(path.join(dirPath, name)).isDirectory(),
    }));
  } catch { return []; }
});

// Rotation diagnostic log — renderer sends fire-and-forget, main appends to file
const _rotationLogPath = path.join(__dirname, "..", "tmp-userdata", "rotation.log");
ipcMain.on("log:rotation", (_, msg) => {
  try {
    const ts = new Date().toISOString().replace("T", " ").slice(0, 23);
    fs.appendFileSync(_rotationLogPath, `[${ts}] ${msg}\n`);
  } catch {}
});

// Dialog
ipcMain.handle("dialog:openFile", async (_, options) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile", ...(options?.multiple ? ["multiSelections"] : [])],
    filters: options?.filters || [{ name: "Audio", extensions: ["mp3", "flac", "wav", "aac", "m4a", "ogg"] }],
  });
  return result.canceled ? null : result.filePaths;
});

ipcMain.handle("dialog:openDirectory", async () => {
  console.log("[DIALOG] openDirectory called");
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("dialog:saveFile", async (_, options) => {
  const result = await dialog.showSaveDialog(mainWindow, options || {});
  return result.canceled ? null : result.filePath;
});

// Watermark verification — reads a WAV file and extracts/verifies the Ether LSB watermark
ipcMain.handle("watermark:verify", async (_, { filePath }) => {
  const crypto = require("crypto");
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE")
      return { found: false, valid: false, error: "Not a valid WAV file" };

    // Walk chunks to find 'data'
    let offset = 12, pcmOffset = -1, pcmLen = 0;
    while (offset < buf.length - 8) {
      const id  = buf.toString("ascii", offset, offset + 4);
      const len = buf.readUInt32LE(offset + 4);
      if (id === "data") { pcmOffset = offset + 8; pcmLen = len; break; }
      offset += 8 + len + (len & 1);
    }
    if (pcmOffset < 0) return { found: false, valid: false, error: "No PCM data found" };

    const numSamples = Math.floor(pcmLen / 2);
    if (numSamples < 96) return { found: false, valid: false, error: "Audio too short" };

    // Read i16 samples
    const samples = new Int16Array(numSamples);
    for (let i = 0; i < numSamples; i++)
      samples[i] = buf.readInt16LE(pcmOffset + i * 2);

    // Extract `len` bytes from LSBs, MSB-first per byte (mirrors Rust extract_lsb)
    function extractLsb(off, len) {
      const out = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        let byte = 0;
        for (let bit = 0; bit < 8; bit++)
          byte = (byte << 1) | (samples[off + i * 8 + bit] & 1);
        out[i] = byte;
      }
      return out;
    }

    const MAGIC = Buffer.from("ETHRWM01");
    const magic = Buffer.from(extractLsb(0, 8));
    if (!magic.equals(MAGIC))
      return { found: false, valid: false, error: "No Ether watermark found" };

    const lb = extractLsb(64, 4);
    const payloadLen = lb[0] | (lb[1] << 8) | (lb[2] << 16) | (lb[3] << 24);
    const samplesNeeded = (8 + 4 + payloadLen) * 8;
    if (payloadLen > 8192 || numSamples < samplesNeeded)
      return { found: true, valid: false, error: `Invalid payload length: ${payloadLen}` };

    const payloadBytes = extractLsb(96, payloadLen);
    let payload;
    try { payload = JSON.parse(Buffer.from(payloadBytes).toString("utf8")); }
    catch { return { found: true, valid: false, error: "Watermark JSON parse error" }; }

    const { station_id, timestamp, ether_version, content_hash } = payload;

    // Recompute hash: clear LSBs of the watermarked region, keep rest
    const cleared = Buffer.alloc(numSamples * 2);
    for (let i = 0; i < numSamples; i++) {
      const s = i < samplesNeeded ? (samples[i] & ~1) : samples[i];
      cleared.writeInt16LE(s < -32768 ? -32768 : s > 32767 ? 32767 : s, i * 2);
    }
    const computedHash = crypto.createHash("sha256").update(cleared).digest("hex");
    const valid = computedHash === content_hash;

    return { found: true, valid, stationId: station_id, timestamp, etherVersion: ether_version, contentHash: content_hash, computedHash, error: null };
  } catch (e) {
    return { found: false, valid: false, error: e.message };
  }
});

// System
ipcMain.handle("system:getLocalIp", () => audio.getLocalIp());
ipcMain.handle("system:openUrl", (_, url) => shell.openExternal(url));
ipcMain.handle("system:openSoundSettings", () => audio.openSoundSettings());
ipcMain.handle("system:getAppDataDir", () => app.getPath("userData"));
ipcMain.handle("system:getPlatform", () => process.platform);

// ── User / PIN security ──────────────────────────────────────
const crypto = require("crypto");
ipcMain.handle("user:hash-pin", (_evt, pin) => {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.createHash("sha256").update(salt + pin).digest("hex");
  return salt + ":" + hash;
});
ipcMain.handle("user:verify-pin", (_evt, pin, stored) => {
  if (!stored) return false;
  // Support both legacy plaintext PINs and new salt:hash format
  if (!stored.includes(":")) return pin === stored;
  const [salt, hash] = stored.split(":");
  const attempt = crypto.createHash("sha256").update(salt + pin).digest("hex");
  return attempt === hash;
});

// Backup
ipcMain.handle("db:backup", () => {
  try {
    const dbPath = getDbPath();
    const backupDir = path.join(app.getPath("userData"), "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const timestamp = Math.floor(Date.now() / 1000);
    const backupName = `openair-backup-${timestamp}.db`;
    const backupPath = path.join(backupDir, backupName);
    fs.copyFileSync(dbPath, backupPath);
    // Delete backups older than 7 days
    const cutoff = timestamp - 7 * 24 * 3600;
    fs.readdirSync(backupDir).forEach(name => {
      const match = name.match(/openair-backup-(\d+)\.db/);
      if (match && parseInt(match[1]) < cutoff) {
        fs.unlinkSync(path.join(backupDir, name));
      }
    });
    return { data: backupPath, error: null };
  } catch (e) { return { data: null, error: e.message }; }
});

// Generate a VIP invite file and save it via save dialog
ipcMain.handle("invite:generate", async (_, { name, initials, note, mode, invitedBy }) => {
  try {
    const { filePath } = await dialog.showSaveDialog(mainWindow, {
      title: "Save Invite File",
      defaultPath: "ether-invite.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!filePath) return { ok: false, reason: "cancelled" };
    const payload = {
      operator_name: name,
      operator_initials: initials,
      invited_by: invitedBy || "Deniro",
      personal_note: note,
      experience_mode: mode,
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
    return { ok: true, filePath };
  } catch (e) { return { ok: false, reason: e.message }; }
});

// Reset deck configs to factory defaults and return fresh rows
ipcMain.handle("deck-configs:reset", () => {
  try {
    const { deckConfigsClearAll } = require('./sync/handlers/deck_configs');
    deckConfigsClearAll(db, getActiveStationId());
    seedDeckConfigs();
    return { data: db.prepare("SELECT * FROM deck_configs ORDER BY slot").all(), error: null };
  } catch (e) { return { data: null, error: e.message }; }
});

ipcMain.handle("db:listBackups", () => {
  try {
    const backupDir = path.join(app.getPath("userData"), "backups");
    if (!fs.existsSync(backupDir)) return [];
    return fs.readdirSync(backupDir)
      .filter(n => n.startsWith("openair-backup-"))
      .sort().reverse();
  } catch { return []; }
});

ipcMain.handle("db:restore", (_, backupName) => {
  try {
    const backupPath = path.join(app.getPath("userData"), "backups", backupName);
    const dbPath = getDbPath();
    if (!fs.existsSync(backupPath)) return { error: "Backup not found" };
    // Close DB before restore
    db.close();
    fs.copyFileSync(backupPath, dbPath);
    initDb(); // Reopen
    return { data: "Restored successfully", error: null };
  } catch (e) { return { data: null, error: e.message }; }
});

// ── Legacy Tauri command aliases — called by SettingsPanel ────
ipcMain.handle("get_local_ip", () => audio.getLocalIp());
// These were Tauri commands in the original build. Now aliased here so
// the renderer doesn't need to change its invoke names.
ipcMain.handle("backup_db", async () => {
  try {
    const ts = Math.floor(Date.now() / 1000);
    const backupDir = path.join(app.getPath("userData"), "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const backupName = `openair-backup-${ts}.db`;
    fs.copyFileSync(getDbPath(), path.join(backupDir, backupName));
    // Prune backups older than 7 days
    const cutoff = ts - 7 * 24 * 3600;
    fs.readdirSync(backupDir).forEach(n => {
      const m = n.match(/openair-backup-(\d+)\.db/);
      if (m && parseInt(m[1]) < cutoff) try { fs.unlinkSync(path.join(backupDir, n)); } catch {}
    });
    // Fire R2 upload if configured — non-blocking so local backup always succeeds fast
    if (cloudBackupTrigger) {
      cloudBackupTrigger().then(r => {
        if (r && !r.skipped) console.log("[CLOUD-BACKUP] post-backup_db R2 upload:", r.ok ? "ok" : r.error);
      }).catch(e => console.warn("[CLOUD-BACKUP] post-backup_db R2 upload failed:", e.message));
    }
    return backupName;
  } catch (e) { throw new Error("Backup failed: " + e.message); }
});

ipcMain.handle("list_backups", () => {
  try {
    const backupDir = path.join(app.getPath("userData"), "backups");
    if (!fs.existsSync(backupDir)) return [];
    return fs.readdirSync(backupDir)
      .filter(n => n.startsWith("openair-backup-") && n.endsWith(".db"))
      .sort().reverse();
  } catch { return []; }
});

// SettingsPanel passes { backupName } (object); db:restore takes a bare string.
ipcMain.handle("restore_db", (_, { backupName } = {}) => {
  try {
    if (!backupName) throw new Error("backupName is required");
    const backupPath = path.join(app.getPath("userData"), "backups", backupName);
    if (!fs.existsSync(backupPath)) throw new Error("Backup not found: " + backupName);
    db.close();
    fs.copyFileSync(backupPath, getDbPath());
    initDb();
    return "Restored from " + backupName + ". Restart Ether for all changes to take effect.";
  } catch (e) { throw new Error(e.message); }
});

// ── Clean Filenames ───────────────────────────────────────────
ipcMain.handle("clean_filenames", async (_evt, { folderPath, commit, stringsToRemove }) => {
  try {
    const AUDIO_EXTS = new Set([".mp3", ".flac", ".wav", ".m4a", ".ogg"]);
    const userStrings = Array.isArray(stringsToRemove) && stringsToRemove.length > 0
      ? stringsToRemove
      : ["spotdown_org", "spotdown"];

    function cleanName(base) {
      let n = base;
      // Leading timestamp prefix: digits followed by underscore
      n = n.replace(/^\d+_/, "");
      // User-supplied strings — longest first to avoid partial matches
      const sorted = [...userStrings].sort((a, b) => b.length - a.length);
      for (const s of sorted) {
        const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        n = n.replace(new RegExp("_?" + escaped + "_?", "gi"), "_");
      }
      n = n.replace(/__+/g, "_");
      n = n.replace(/^_+|_+$/g, "");
      return n;
    }

    function walk(dir, results) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full, results); continue; }
        const ext = path.extname(e.name).toLowerCase();
        if (!AUDIO_EXTS.has(ext)) continue;
        const base = path.basename(e.name, ext);
        const cleaned = cleanName(base);
        if (cleaned !== base) results.push({ dir, ext, before: e.name, after: cleaned + ext, fullPath: full });
      }
    }

    if (!folderPath || !fs.existsSync(folderPath)) return { ok: false, error: "Folder not found: " + folderPath };
    const renames = [];
    walk(folderPath, renames);

    if (commit) {
      let done = 0, errors = [];
      for (const r of renames) {
        try {
          fs.renameSync(r.fullPath, path.join(r.dir, r.after));
          done++;
        } catch (e) { errors.push(r.before + ": " + e.message); }
      }
      return { ok: true, renamed: done, renames, errors };
    }

    return { ok: true, renames, errors: [] };
  } catch (e) {
    console.error("[CLEAN-FILENAMES] error:", e.message, e.stack);
    return { ok: false, error: e.message };
  }
});

// Autostart
ipcMain.handle("autostart:enable", () => app.setLoginItemSettings({ openAtLogin: true }));
ipcMain.handle("autostart:disable", () => app.setLoginItemSettings({ openAtLogin: false }));
ipcMain.handle("autostart:isEnabled", () => app.getLoginItemSettings().openAtLogin);

// ── Generic invoke aliases (old Tauri command names) ─────────

ipcMain.handle("watchdog_set", (_, args) => {
  const { active, thresholdSec } = args || {};
  return audio.watchdogSet(active ?? false, thresholdSec ?? 30);
});

// -- Streaming stubs (Icecast client to be implemented) -------
let streamActive = false;
let streamStartTime = 0;

ipcMain.handle("stream_status", () => streamActive);

ipcMain.handle("stream_health", () => ({
  status: streamActive ? "live" : "disconnected",
  uptimeSecs: streamActive ? Math.floor((Date.now() - streamStartTime) / 1000) : 0,
  dropCount: 0,
  bufferSecs: 0,
}));

ipcMain.handle("stream_start", async (_, args) => {
  console.log("[STREAM] Start requested:", args?.config);
  streamActive = true;
  streamStartTime = Date.now();
  return true;
});

ipcMain.handle("stream_update_metadata", (_, args) => {
  console.log("[STREAM] Metadata:", args?.title, "-", args?.artist);
  return true;
});

ipcMain.handle("stream_start_if_configured", async () => {
  try { return audio.streamStart ? audio.streamStart() : true; } catch { return true; }
});

ipcMain.handle("stream_stop", async () => {
  try { return audio.streamStop ? audio.streamStop() : true; } catch { return true; }
});

ipcMain.handle("analyze_lufs", (_, args) => {
  const filePath = args?.filePath ?? args;
  try { return audio.analyzeLufs(filePath); } catch { return -14; }
});

ipcMain.handle("analyze_song", (_, args) => {
  const filePath = args?.filePath ?? args;
  try { return JSON.parse(audio.analyzeSong(filePath)); } catch { return null; }
});

ipcMain.handle("measure_song_loudness", (_, args) => {
  const filePath = args?.filePath ?? args;
  try { return JSON.parse(audio.measureSongLoudness(filePath)); } catch { return null; }
});

ipcMain.handle("detect_song_bpm", (_, args) => {
  const filePath = args?.filePath ?? args;
  try { return JSON.parse(audio.detectSongBpm(filePath)); } catch { return null; }
});

ipcMain.handle("detect_song_cue_points", (_, args) => {
  const filePath = args?.filePath ?? args;
  try { return JSON.parse(audio.detectSongCuePoints(filePath)); } catch { return null; }
});

ipcMain.handle("open_url", (_, args) => {
  const url = args?.url ?? args;
  return shell.openExternal(url);
});

ipcMain.handle("open_desk_window", async () => {
  const existing = BrowserWindow.getAllWindows().find(w => w.getTitle().includes("Producer Desk"));
  if (existing) { existing.show(); existing.focus(); return; }
  const { screen } = require("electron");
  const desk = new BrowserWindow({
    width: 900, height: 620, minWidth: 600, minHeight: 400,
    title: "Ether — Producer Desk",
    x: Math.round(screen.getPrimaryDisplay().workAreaSize.width * 0.55),
    y: 80,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });
  if (isDev) desk.loadURL(VITE_DEV_URL + "#desk");
  else desk.loadFile(path.join(__dirname, "../dist/index.html"), { hash: "desk" });
});

// ── Event relay: ether.emit() in renderer → broadcast to all windows ──
// Relay now-playing-request to main window so it responds with current state
ipcMain.on("now-playing-request", (event) => {
  const sender = event.sender;
  BrowserWindow.getAllWindows().forEach(w => {
    if (w.webContents.id !== sender.id) {
      w.webContents.send("now-playing-request", {});
    }
  });
});

ipcMain.on("now-playing-update", (_, payload) => {
  BrowserWindow.getAllWindows().forEach(w => w.webContents.send("now-playing-update", payload));
});
ipcMain.handle("set_now_playing", (_, args) => {
  BrowserWindow.getAllWindows().forEach(w => w.webContents.send("now-playing-update", args));
  return true;
});

ipcMain.on("desk-send-to-queue", (_, payload) => {
  BrowserWindow.getAllWindows().forEach(w => w.webContents.send("desk-send-to-queue", payload));
});

// ── Relaunch ──────────────────────────────────────────────────
ipcMain.handle("relaunch", () => { app.relaunch(); app.exit(0); });

// ── Multi-monitor pop-out windows — Tony Stark mode ──────────
// Each popped panel gets a frameless BrowserWindow loading #popout/<panel>
const POPOUT_SIZES = {
  "decks":       { width: 1320, height: 460 },  // all visible decks in a row
  "mic":         { width: 400,  height: 300 },
  "master":      { width: 800,  height: 600 },
  "upnext":      { width: 480,  height: 640 },
  "phone":       { width: 720,  height: 520 },
  "voicetrack":  { width: 860,  height: 540 },
  "videostudio": { width: 1024, height: 640 },
  "camera":      { width: 640,  height: 480 },
  "health":      { width: 720,  height: 540 },
};

ipcMain.handle("window:popout", async (_, panel) => {
  const tag = `popout:${panel}`;
  const existing = BrowserWindow.getAllWindows().find(w => w.getTitle() === tag);
  if (existing) { existing.show(); existing.focus(); return; }

  const { screen } = require("electron");
  const size = POPOUT_SIZES[panel] || { width: 640, height: 520 };
  const displays = screen.getAllDisplays();
  const primary  = screen.getPrimaryDisplay();
  const secondary = displays.find(d => d.id !== primary.id);
  // Place on secondary monitor if available, else offset from center
  const x = secondary ? secondary.workArea.x + 60 : undefined;
  const y = secondary ? secondary.workArea.y + 60 : undefined;

  const win = new BrowserWindow({
    width:  size.width,
    height: size.height,
    minWidth:  320,
    minHeight: 200,
    x, y,
    title: tag,
    frame: false,
    transparent: false,
    backgroundColor: "#0e0e14",
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
    },
  });

  if (isDev) win.loadURL(VITE_DEV_URL + `#popout/${panel}`);
  else win.loadFile(path.join(__dirname, "../dist/index.html"), { hash: `popout/${panel}` });
});

// ── Guest Editor pop-out window ───────────────────────────────
ipcMain.handle("window:guesteditor", async () => {
  const title = "Ether — Guest Editor";
  const existing = BrowserWindow.getAllWindows().find(w => w.getTitle() === title);
  if (existing) { existing.show(); existing.focus(); return; }

  const { screen } = require("electron");
  const displays  = screen.getAllDisplays();
  const primary   = screen.getPrimaryDisplay();
  const secondary = displays.find(d => d.id !== primary.id);
  const x = secondary ? secondary.workArea.x + 60 : undefined;
  const y = secondary ? secondary.workArea.y + 60 : undefined;

  const win = new BrowserWindow({
    width: 800, height: 600,
    minWidth: 400, minHeight: 300,
    x, y,
    title,
    frame: false,
    transparent: false,
    backgroundColor: "#0e0e14",
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });

  if (isDev) win.loadURL(VITE_DEV_URL + "#guesteditor");
  else win.loadFile(path.join(__dirname, "../dist/index.html"), { hash: "guesteditor" });
});

// ── Cross-window broadcast relay ─────────────────────────────
// Renderer: ether.emit("ether:broadcast", { channel, data })
// All other windows receive: ether.on(channel, cb)
ipcMain.on("ether:broadcast", (event, { channel, data }) => {
  BrowserWindow.getAllWindows().forEach(win => {
    if (win.webContents.id !== event.sender.id) {
      win.webContents.send(channel, data);
    }
  });
});

ipcMain.handle("open_nowplaying_window", async () => {
  const existing = BrowserWindow.getAllWindows().find(w => w.getTitle().includes("Now Playing"));
  if (existing) { existing.show(); existing.focus(); return; }
  const { screen } = require("electron");
  const np = new BrowserWindow({
    width: 1280, height: 720,
    minWidth: 1280, minHeight: 720,
    title: "Ether - Now Playing",
    resizable: false,
    center: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
    },
  });
  if (isDev) np.loadURL(VITE_DEV_URL + "#nowplaying");
  else np.loadFile(path.join(__dirname, "../dist/index.html"), { hash: "nowplaying" });
});

// ── Auto-updater ──────────────────────────────────────────────
// DISABLED — was offering stale downgrade versions and the notification
// buttons (Dismiss, Later, ×) are non-functional. Re-enable after:
//   1. Release channel fixed to track the correct latest version
//   2. Updater.tsx button handlers verified working
// With autoUpdater=null the IPC handlers below return { available: false }
// so the renderer banner never shows.
let autoUpdater = null;

ipcMain.handle("updater:check", async () => {
  if (!autoUpdater) return { available: false };
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result?.updateInfo) return { available: false };
    const current = app.getVersion();
    const latest = result.updateInfo.version;
    return {
      available: latest !== current,
      version: latest,
      notes: result.updateInfo.releaseNotes ?? null,
      date: result.updateInfo.releaseDate ?? null,
    };
  } catch { return { available: false }; }
});

ipcMain.handle("updater:download", async () => {
  if (!autoUpdater) return;
  autoUpdater.on("download-progress", (progress) => {
    BrowserWindow.getAllWindows().forEach(w => w.webContents.send("updater:progress", progress));
  });
  await autoUpdater.downloadUpdate();
});

ipcMain.handle("updater:install", () => {
  if (!autoUpdater) { app.relaunch(); app.exit(0); return; }
  autoUpdater.quitAndInstall();
});

// ── AI key storage (safeStorage) ─────────────────────────────
function getAiConfigPath() {
  return path.join(app.getPath("userData"), "ai-config.json");
}
function readAiConfig() {
  try { return JSON.parse(fs.readFileSync(getAiConfigPath(), "utf8")); }
  catch { return { provider: "anthropic", keys: {} }; }
}
function writeAiConfig(cfg) {
  fs.writeFileSync(getAiConfigPath(), JSON.stringify(cfg, null, 2));
}
function encryptKey(key) {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(key).toString("base64");
  }
  return Buffer.from(key).toString("base64") + ":plain";
}
function decryptKey(stored) {
  if (!stored) return null;
  if (stored.endsWith(":plain")) {
    return Buffer.from(stored.slice(0, -6), "base64").toString("utf8");
  }
  try { return safeStorage.decryptString(Buffer.from(stored, "base64")); }
  catch { return null; }
}

ipcMain.handle("ai:setKey", (_, { provider, key }) => {
  const cfg = readAiConfig();
  if (!cfg.keys) cfg.keys = {};
  if (key) cfg.keys[provider] = encryptKey(key);
  else delete cfg.keys[provider];
  writeAiConfig(cfg);
  return true;
});

ipcMain.handle("ai:getKeyStatus", () => {
  const cfg = readAiConfig();
  return {
    anthropic: !!(cfg.keys?.anthropic),
    openai:    !!(cfg.keys?.openai),
    google:    !!(cfg.keys?.google),
    weather:   !!(cfg.keys?.weather) || !!(process.env.OPENWEATHERMAP_API_KEY),
  };
});

ipcMain.handle("ai:setProvider", (_, provider) => {
  const cfg = readAiConfig();
  cfg.provider = provider;
  writeAiConfig(cfg);
  return true;
});

ipcMain.handle("ai:getProvider", () => readAiConfig().provider || "anthropic");

// ── AI assistant — multi-provider ─────────────────────────────
// Shared now-playing state updated by the main window
let _nowPlayingContext = { title: null, artist: null };
ipcMain.on("iris:nowplaying", (_, payload) => {
  if (payload && typeof payload === "object") {
    _nowPlayingContext = { title: payload.title || null, artist: payload.artist || null };
  }
});

ipcMain.handle("ai:ask", async (_, messages) => {
  const cfg = readAiConfig();
  const provider = cfg.provider || "anthropic";
  let apiKey = decryptKey(cfg.keys?.[provider]);
  if (!apiKey && provider === "anthropic") apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return "__NO_KEY__";

  // Build station context string for Iris
  const nowPlayingLine = _nowPlayingContext.title
    ? `Station is currently playing: "${_nowPlayingContext.title}" by ${_nowPlayingContext.artist || "Unknown"}.`
    : "No song is currently playing.";

  const system = `You are Iris, the Executive Producer for ether radio. You are professional, sharp, and slightly witty. You have direct knowledge of the station's current state. Use radio terminology. Never break character. Be concise.\n\nCurrent station state: ${nowPlayingLine}`;

  try {
    if (provider === "anthropic") {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          system,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: messages.map(m => ({ role: m.role, content: m.content })),
        }),
      });
      const data = await res.json();
      if (!res.ok) return `API error ${res.status}: ${data.error?.message || JSON.stringify(data)}`;
      return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim() || "No response.";

    } else if (provider === "openai") {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          max_tokens: 1000,
          messages: [{ role: "system", content: system }, ...messages.map(m => ({ role: m.role, content: m.content }))],
        }),
      });
      const data = await res.json();
      if (!res.ok) return `API error ${res.status}: ${data.error?.message || JSON.stringify(data)}`;
      return data.choices?.[0]?.message?.content?.trim() || "No response.";

    } else if (provider === "google") {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
          generationConfig: { maxOutputTokens: 1000 },
        }),
      });
      const data = await res.json();
      if (!res.ok) return `API error ${res.status}: ${data.error?.message || JSON.stringify(data)}`;
      return data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "No response.";
    }
    return "Unknown provider.";
  } catch (e) {
    return `Request failed: ${e.message}`;
  }
});

let _rtmpProcess      = null;
let _recordStream     = null;

// ── RTMP destinations ─────────────────────────────────────────
ipcMain.handle("studio:rtmp:list", () => {
  try {
    return db.prepare("SELECT * FROM rtmp_destinations WHERE is_active = 1 ORDER BY name").all();
  } catch { return []; }
});

ipcMain.handle("studio:rtmp:save", (_, { id, name, url, key }) => {
  const { rtmpDestinationsCreate, rtmpDestinationsUpdateById } = require('./sync/handlers/rtmp_destinations');
  if (id) {
    rtmpDestinationsUpdateById(db, id, { name, url, stream_key: key || "" });
    return { id };
  } else {
    const row = rtmpDestinationsCreate(db, { station_id: getActiveStationId(), name, url, stream_key: key || "", is_active: 1 });
    return { id: row.id };
  }
});

ipcMain.handle("studio:rtmp:delete", (_, id) => {
  const { rtmpDestinationsUpdateById } = require('./sync/handlers/rtmp_destinations');
  rtmpDestinationsUpdateById(db, id, { is_active: 0 });
  return { ok: true };
});

// ── VoxPro / FFmpeg ───────────────────────────────────────────
let ffmpegBin = null;
try {
  ffmpegBin = require("ffmpeg-static");
  // When bundled in asar, the binary lives in app.asar.unpacked
  if (ffmpegBin && ffmpegBin.includes("app.asar") && !ffmpegBin.includes("unpacked")) {
    ffmpegBin = ffmpegBin.replace("app.asar", "app.asar.unpacked");
  }
  console.log("[FFMPEG] Binary:", ffmpegBin);
} catch (e) {
  console.warn("[FFMPEG] ffmpeg-static not available:", e.message);
}

// ── AI Voice Studio (TTS generation + segment library) ──────────────────────
try {
  const { installAIVoice } = require("./ai-voice.js");
  installAIVoice(ipcMain, db, { userDataPath: app.getPath("userData") });
} catch (e) {
  console.warn("[AI-VOICE] installAIVoice failed:", e.message);
}

// ── Video engine (renderer composites; we run ffmpeg for RTMP/MP4) ─────────
try {
  const { installVideoEngine } = require("./video-engine.js");
  installVideoEngine(ipcMain, { ffmpegBin });
} catch (e) {
  console.warn("[video] installVideoEngine failed:", e.message);
}

// ── GPIO engine (broadcast hardware I/O) ────────────────────────────────
try {
  const { installGpioEngine } = require("./gpio-engine.js");
  installGpioEngine(ipcMain, db, {
    onGpiEvent: (actionType, actionValue, info) => {
      console.log(`[GPIO] action: ${actionType} = ${actionValue}`, info);
      // Forward GPI events to the renderer for macro/command dispatch
      if (mainWindow) {
        mainWindow.webContents.send("gpio:event", { actionType, actionValue, ...info });
      }
    },
  });
} catch (e) {
  console.warn("[GPIO] installGpioEngine failed:", e.message);
}

// ── Site Replication (multi-station sync) ────────────────────────
try {
  const { installSiteReplication } = require("./site-replication.js");
  installSiteReplication(ipcMain, db);
} catch (e) {
  console.warn("[REPL] installSiteReplication failed:", e.message);
}

// (Cloud backup installed in app.whenReady() after initDb())

// desktopCapturer source enumeration — needed by renderer to populate the
// screen/window picker. (renderer can't import desktopCapturer directly in
// modern Electron; it's main-only.)
ipcMain.handle("video:list-sources", async (_, kinds = ["screen", "window"]) => {
  try {
    const { desktopCapturer } = require("electron");
    const sources = await desktopCapturer.getSources({
      types: kinds,
      thumbnailSize: { width: 160, height: 90 },
      fetchWindowIcons: false,
    });
    return sources.map(s => ({
      id: s.id,                         // pass to setDesktopSource → handler picks this in callback
      name: s.name,
      kind: s.id.startsWith("screen:") ? "screen" : "window",
      thumbnailDataUrl: s.thumbnail ? s.thumbnail.toDataURL() : "",
    }));
  } catch (e) {
    console.error("[video] list-sources failed:", e);
    return [];
  }
});

// Modern Electron (>=22) replaces the legacy `chromeMediaSource: "desktop"`
// constraint with `navigator.mediaDevices.getDisplayMedia()` plus a main-side
// handler. The renderer pre-stores the picked source id below; the handler
// reads it and returns that source to the requesting page.
let pendingDesktopSourceId = null;
ipcMain.handle("video:set-desktop-source", (_, sourceId) => {
  pendingDesktopSourceId = sourceId || null;
  return true;
});

app.whenReady().then(() => {
  try {
    const { session, desktopCapturer } = require("electron");
    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ["screen", "window"],
          thumbnailSize: { width: 0, height: 0 },
        });
        const picked = pendingDesktopSourceId
          ? sources.find(s => s.id === pendingDesktopSourceId)
          : sources[0];
        pendingDesktopSourceId = null;
        if (!picked) { callback({ video: null }); return; }
        // Phase 4 audio: return system loopback when the renderer requested
        // audio: true. Windows-only — on macOS/Linux we omit the audio key.
        const wantsAudio = !!(request && request.audio);
        const isWin = process.platform === "win32";
        if (wantsAudio && isWin) {
          callback({ video: picked, audio: "loopback" });
        } else {
          callback({ video: picked });
        }
      } catch (e) {
        console.error("[video] display media handler error:", e);
        callback({ video: null });
      }
    }, { useSystemPicker: false });
    console.log("[video] setDisplayMediaRequestHandler installed");
  } catch (e) {
    console.warn("[video] failed to install display media handler:", e.message);
  }
});

function runFFmpeg(args) {
  const { execFile } = require("child_process");
  return new Promise((resolve, reject) => {
    if (!ffmpegBin) return reject(new Error("FFmpeg not bundled"));
    execFile(ffmpegBin, args, { maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(true);
    });
  });
}

// Write raw binary (Uint8Array / Buffer) to disk — used by VoxPro to persist recorded audio
ipcMain.handle("voxpro:writeAudio", (_, { data, filePath }) => {
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(data));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Encode a WAV/WebM/OGG source file to MP3 or WAV via FFmpeg
ipcMain.handle("ffmpeg:bounce-audio", async (_, { inputPath, outputPath, format }) => {
  const args = format === "mp3"
    ? ["-y", "-i", inputPath, "-codec:a", "libmp3lame", "-q:a", "2", outputPath]
    : ["-y", "-i", inputPath, "-codec:a", "pcm_s16le", outputPath];
  await runFFmpeg(args);
  return outputPath;
});

// Mix voice + music bed with per-track gain and music fade in/out
ipcMain.handle("ffmpeg:mix-audio", async (_, { voicePath, musicPath, voiceGain, musicGain, fadeDuration, outputPath }) => {
  const vg = Number(voiceGain) || 1;
  const mg = Number(musicGain) || 0.3;
  const fd = Number(fadeDuration) || 2;
  // Get voice duration for fade-out timing
  const { execFile } = require("child_process");
  let duration = 30;
  try {
    const probe = await new Promise((res) => {
      execFile(ffmpegBin, ["-i", voicePath], { maxBuffer: 1024 * 1024 }, (_, __, stderr) => {
        const m = stderr && stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        res(m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : 30);
      });
    });
    duration = Number(probe) || 30;
  } catch {}
  const fadeOutStart = Math.max(0, duration - fd);
  const filter = [
    `[1:a]volume=${mg},afade=t=in:st=0:d=${fd},afade=t=out:st=${fadeOutStart}:d=${fd}[music]`,
    `[0:a]volume=${vg}[voice]`,
    `[voice][music]amix=inputs=2:duration=first:dropout_transition=2[out]`,
  ].join(";");
  await runFFmpeg(["-y", "-i", voicePath, "-i", musicPath, "-filter_complex", filter, "-map", "[out]", "-codec:a", "libmp3lame", "-q:a", "2", outputPath]);
  return outputPath;
});

// Mux audio + video into MP4
ipcMain.handle("ffmpeg:bounce-video", async (_, { audioPath, videoPath, outputPath }) => {
  await runFFmpeg(["-y", "-i", videoPath, "-i", audioPath, "-c:v", "copy", "-c:a", "aac", "-shortest", outputPath]);
  return outputPath;
});

// Export: open save dialog and copy the rendered file there
ipcMain.handle("ffmpeg:export", async (_, { sourcePath, defaultName, filters }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(app.getPath("downloads"), defaultName || "voxpro-export"),
    filters: filters || [{ name: "Audio Files", extensions: ["mp3"] }],
  });
  if (result.canceled || !result.filePath) return null;
  fs.copyFileSync(sourcePath, result.filePath);
  return result.filePath;
});

// Return the VoxPro auto-save directory path
ipcMain.handle("voxpro:getSaveDir", () => {
  const dir = path.join(app.getPath("userData"), "voxpro");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
});

// Return a temp directory path for intermediate files
ipcMain.handle("voxpro:getTempDir", () => {
  const dir = path.join(app.getPath("temp"), "ether-voxpro");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
});

// ── RTMP stream via ffmpeg ────────────────────────────────────
ipcMain.handle("studio:rtmp:start", (_, { url, key }) => {
  if (_rtmpProcess) return { ok: false, error: "Already streaming" };
  if (!key || !key.trim()) {
    return { ok: false, error: "Stream key required. Get it from your platform's live streaming settings (e.g. youtube.com/livestreaming)." };
  }
  const target = `${url}/${key.trim()}`;
  try {
    const { spawn } = require("child_process");
    _rtmpStreamStatus.statusState   = 'connecting';
    _rtmpStreamStatus.errorMsg      = null;
    _rtmpStreamStatus.speed         = null;
    _rtmpStreamStatus.bitrate       = null;
    _rtmpStreamStatus.startTime     = null;
    _rtmpStreamStatus.speedHistory  = [];
    _rtmpStreamStatus.destLabel     = _labelFromRtmpUrl(url);
    _emitDestStatus('rtmp:video', _rtmpStreamStatus);
    _emitGlobal();

    _rtmpProcess = spawn("ffmpeg", [
      "-re", "-f", "webm", "-i", "pipe:0",
      "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
      "-c:a", "aac", "-ar", "44100", "-b:a", "128k",
      "-f", "flv", target,
    ], { stdio: ["pipe", "ignore", "pipe"] });

    _rtmpProcess.stderr.on("data", (d) => {
      const text = d.toString();
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        console.log("[STUDIO/ffmpeg]", trimmed.slice(0, 120));
        const parsed = _parseStreamLine(trimmed);
        if (parsed.errorMsg) {
          _rtmpStreamStatus.errorMsg = parsed.errorMsg;
          if (_rtmpStreamStatus.statusState === 'connecting') {
            _rtmpStreamStatus.statusState = 'error';
            _emitDestStatus('rtmp:video', _rtmpStreamStatus);
            _emitGlobal();
          }
        } else if (parsed.isLive && _rtmpStreamStatus.statusState === 'connecting') {
          _rtmpStreamStatus.statusState = 'live';
          _rtmpStreamStatus.startTime   = Date.now();
          _rtmpStreamStatus.errorMsg    = null;
          _emitDestStatus('rtmp:video', _rtmpStreamStatus);
          _emitGlobal();
        } else if (parsed.isProgress && _rtmpStreamStatus.statusState === 'live') {
          if (parsed.speed   !== null) { _rtmpStreamStatus.speed = parsed.speed; _rtmpStreamStatus.speedHistory = [..._rtmpStreamStatus.speedHistory.slice(-119), parsed.speed]; }
          if (parsed.bitrate !== null) _rtmpStreamStatus.bitrate = parsed.bitrate;
          _emitDestStatus('rtmp:video', _rtmpStreamStatus);
        }
      }
    });
    _rtmpProcess.on("error", (e) => {
      console.error("[STUDIO] ffmpeg error:", e.message);
      _rtmpProcess                  = null;
      _rtmpStreamStatus.statusState = 'error';
      _rtmpStreamStatus.errorMsg    = e.message;
      _emitDestStatus('rtmp:video', _rtmpStreamStatus);
      _emitGlobal();
      mainWindow?.webContents.send("studio:rtmp:stopped", { error: e.message });
    });
    _rtmpProcess.on("exit", (code) => {
      console.log("[STUDIO] ffmpeg exit:", code);
      _rtmpProcess                  = null;
      _rtmpStreamStatus.statusState = 'idle';
      _rtmpStreamStatus.speed       = null;
      _rtmpStreamStatus.bitrate     = null;
      _emitDestStatus('rtmp:video', _rtmpStreamStatus);
      _emitGlobal();
      mainWindow?.webContents.send("studio:rtmp:stopped", { code });
    });
    return { ok: true };
  } catch (e) {
    _rtmpStreamStatus.statusState = 'idle';
    _emitDestStatus('rtmp:video', _rtmpStreamStatus);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("studio:rtmp:chunk", (_, chunk) => {
  if (!_rtmpProcess) return;
  try { _rtmpProcess.stdin.write(Buffer.from(chunk)); } catch {}
});

ipcMain.handle("studio:rtmp:stop", () => {
  if (_rtmpProcess) {
    try { _rtmpProcess.stdin.end(); } catch {}
    _rtmpProcess = null;
  }
  _rtmpStreamStatus.statusState = 'idle';
  _rtmpStreamStatus.speed       = null;
  _rtmpStreamStatus.bitrate     = null;
  _emitDestStatus('rtmp:video', _rtmpStreamStatus);
  _emitGlobal();
  return { ok: true };
});

// ── Local recording via MediaRecorder chunks ──────────────────
ipcMain.handle("studio:record:start", (_, filePath) => {
  try {
    _recordStream = fs.createWriteStream(filePath, { flags: "w" });
    _recordStream.on("error", (e) => console.error("[STUDIO] Record write error:", e.message));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle("studio:record:chunk", (_, chunk) => {
  if (!_recordStream) return;
  try { _recordStream.write(Buffer.from(chunk)); } catch {}
});

ipcMain.handle("studio:record:stop", () => {
  if (_recordStream) { _recordStream.end(); _recordStream = null; }
  return { ok: true };
});

ipcMain.handle("studio:record:saveClip", async (_, { path: filePath, data }) => {
  try {
    fs.writeFileSync(filePath, Buffer.from(data));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Weather — OpenWeatherMap (Las Vegas) ──────────────────────
ipcMain.handle("weather:getLasVegas", async () => {
  const cfg = readAiConfig();
  const apiKey = decryptKey(cfg.keys?.weather) || process.env.OPENWEATHERMAP_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=Las+Vegas,US&appid=${apiKey}&units=imperial`);
    const data = await res.json();
    if (!res.ok) return null;
    return {
      temp:        Math.round(data.main.temp),
      feels_like:  Math.round(data.main.feels_like),
      description: data.weather?.[0]?.description || "",
      humidity:    data.main.humidity,
      wind_speed:  Math.round(data.wind?.speed || 0),
    };
  } catch { return null; }
});

// ── Iris bridge ───────────────────────────────────────────────
// Lets the Iris voice assistant control OpenAir via IPC or HTTP.

let irisConnected = false;
let irisLastSeen  = 0;

function sendToAllWindows(channel, payload) {
  BrowserWindow.getAllWindows().forEach(w => {
    try {
      if (!w.isDestroyed() && w.webContents && !w.webContents.isDestroyed()) {
        w.webContents.send(channel, payload);
      }
    } catch (e) {
      // Window or render frame was disposed mid-send — skip silently
    }
  });
}

function routeIrisCommand(cmd) {
  const { action, payload = {} } = cmd;
  switch (action) {
    case 'play':
      audio.audioPlay('A');
      sendToAllWindows('iris:command-received', { action, label: 'Playing deck A' });
      return { ok: true };

    case 'stop':
      audio.audioStop('A');
      sendToAllWindows('iris:command-received', { action, label: 'Stopped deck A' });
      return { ok: true };

    case 'next': {
      // Pause current deck — the auto-advance engine in the renderer handles loading next
      audio.audioPause('A');
      sendToAllWindows('iris:command-received', { action, label: 'Skip requested' });
      sendToAllWindows('iris:next-track', {});
      return { ok: true };
    }

    case 'getStatus': {
      let state = {};
      try { state = JSON.parse(audio.audioGetState()); } catch {}
      const deck = state.deckA ?? {};
      return {
        ok:     true,
        status: deck.status ?? 'unknown',
        title:  deck.title  ?? null,
        artist: deck.artist ?? null,
        queueLength: null   // renderer-side queue; not accessible from main
      };
    }

    default:
      return { ok: false, error: `Unknown action: ${action}` };
  }
}

// IPC: Iris electron app (same machine, future use)
ipcMain.handle('iris:command', (_, cmd) => routeIrisCommand(cmd));

// ── Browser Remote HTML (self-contained, no external deps) ──────
const REMOTE_HTML = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ether Remote</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Inter,system-ui,sans-serif;background:#0d0d0f;color:#e8e8f0;min-height:100vh;display:flex;flex-direction:column}
.header{padding:16px 20px;background:#111116;border-bottom:1px solid #1a1a22;display:flex;align-items:center;gap:12px}
.header h1{font-size:18px;font-weight:800;letter-spacing:-.03em}
.header .dot{width:8px;height:8px;border-radius:50%;background:#333}
.header .dot.live{background:#22c55e;box-shadow:0 0 8px #22c55e}
.np{padding:24px 20px;text-align:center;border-bottom:1px solid #1a1a22}
.np .title{font-size:22px;font-weight:700;margin-bottom:4px}
.np .artist{font-size:14px;color:#8878c0}
.np .status{font-size:11px;color:#6060a0;margin-top:8px;text-transform:uppercase;letter-spacing:.1em}
.controls{display:flex;justify-content:center;gap:12px;padding:24px 20px}
.btn{width:64px;height:64px;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;transition:all .15s}
.btn.play{background:#22c55e;color:#000}.btn.play:active{background:#16a34a}
.btn.stop{background:#ef4444;color:#fff}.btn.stop:active{background:#dc2626}
.btn.skip{background:#141420;color:#8878c0;border:1px solid #1e1e2e}.btn.skip:active{background:#1e1e2e}
.btn.pause{background:#fbbf24;color:#000}.btn.pause:active{background:#f59e0b}
.decks{padding:16px 20px;display:flex;flex-direction:column;gap:8px}
.deck{padding:12px 16px;background:#111116;border:1px solid #1a1a22;display:flex;align-items:center;gap:12px}
.deck .id{width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:#000}
.deck .info{flex:1;min-width:0}
.deck .info .t{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.deck .info .a{font-size:11px;color:#6060a0}
.deck .st{font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:2px 8px}
.log{padding:16px 20px;flex:1;overflow-y:auto}
.log h3{font-size:11px;font-weight:700;color:#6060a0;letter-spacing:.12em;text-transform:uppercase;margin-bottom:8px}
.log .entry{padding:6px 0;border-bottom:1px solid #111116;display:flex;gap:8px;font-size:12px}
.log .entry .time{color:#6060a0;font-family:'DM Mono',monospace;font-size:10px;flex-shrink:0;width:60px}
.refresh{text-align:center;padding:12px;font-size:10px;color:#6060a0}
</style></head>
<body>
<div class="header">
  <div class="dot" id="dot"></div>
  <h1>Ether Remote</h1>
  <span style="margin-left:auto;font-size:10px;color:#6060a0" id="conn">Connecting...</span>
</div>
<div class="np">
  <div class="title" id="title">—</div>
  <div class="artist" id="artist">Loading...</div>
  <div class="status" id="npstatus">—</div>
</div>
<div class="controls">
  <button class="btn play" onclick="api('transport/play')">&#9654;</button>
  <button class="btn pause" onclick="api('transport/pause')">&#10074;&#10074;</button>
  <button class="btn stop" onclick="api('transport/stop')">&#9632;</button>
  <button class="btn skip" onclick="api('transport/skip')">&#9197;</button>
</div>
<div class="decks" id="decks"></div>
<div class="log"><h3>Recent Plays</h3><div id="loglist"></div></div>
<div class="refresh" id="refresh"></div>
<script>
const BASE=location.origin;
async function api(path,method='POST'){try{const r=await fetch(BASE+'/api/'+path,{method});return await r.json()}catch{return{ok:false}}}
async function poll(){
  try{
    const s=await(await fetch(BASE+'/api/status')).json();
    const d=s.deckA||{};
    document.getElementById('title').textContent=d.title||'No Track';
    document.getElementById('artist').textContent=d.artist||'—';
    document.getElementById('npstatus').textContent=d.status||'stopped';
    document.getElementById('dot').className='dot'+(d.status==='playing'?' live':'');
    document.getElementById('conn').textContent='Connected';
    // Decks
    let html='';
    for(const[k,color] of [['deckA','#38bdf8'],['deckB','#34d399'],['deckC','#a78bfa']]){
      const dk=s[k]||{};
      const st=dk.status||'empty';
      const stColor=st==='playing'?'#22c55e':st==='paused'?'#fbbf24':'#333';
      html+='<div class="deck"><div class="id" style="background:'+color+'">'+k.slice(-1)+'</div><div class="info"><div class="t">'+(dk.title||'—')+'</div><div class="a">'+(dk.artist||'')+'</div></div><div class="st" style="color:'+stColor+'">'+st+'</div></div>';
    }
    document.getElementById('decks').innerHTML=html;
    // Log
    const log=await(await fetch(BASE+'/api/log')).json();
    let lhtml='';
    for(const e of (log.entries||[]).slice(0,15)){
      const t=new Date(e.played_at*1000);
      lhtml+='<div class="entry"><span class="time">'+t.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+'</span><span>'+e.title+'</span></div>';
    }
    document.getElementById('loglist').innerHTML=lhtml;
    document.getElementById('refresh').textContent='Last updated: '+new Date().toLocaleTimeString();
  }catch(e){document.getElementById('conn').textContent='Disconnected';document.getElementById('dot').className='dot'}
}
poll();setInterval(poll,2000);
</script></body></html>`;

// HTTP: REST API on port 3400 — serves Iris commands + public API
// Accessible by external systems for automation, traffic integration, and monitoring.
const irisHttpServer = require('http').createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

  const url = req.url?.split("?")[0] || "/";
  const qs = Object.fromEntries(new URL("http://x" + (req.url || "/")).searchParams);

  // ── Browser Remote Control (Zetta2GO equivalent) ──
  if (req.method === 'GET' && (url === '/remote' || url === '/remote/')) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(REMOTE_HTML);
    return;
  }

  // ── Iris legacy ──
  if (req.method === 'GET' && url === '/ping') {
    irisConnected = true; irisLastSeen = Date.now();
    sendToAllWindows('iris:connected', true);
    res.end(JSON.stringify({ ok: true, pong: true })); return;
  }
  if (req.method === 'POST' && url === '/') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try { const cmd = JSON.parse(body); irisConnected = true; irisLastSeen = Date.now(); res.end(JSON.stringify(routeIrisCommand(cmd))); }
      catch (e) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: e.message })); }
    }); return;
  }

  // ── REST API ──────────────────────────────────────────────────
  // GET  /api/status          — full station status (decks, queue, on-air)
  // GET  /api/now-playing     — current track metadata
  // POST /api/transport/:action  — play/pause/stop/skip (deck=A default, ?deck=B)
  // GET  /api/queue           — current queue
  // GET  /api/log             — recent play log (last 50)
  // POST /api/macro/:id/run   — execute a macro by id
  // GET  /api/macros          — list all macros
  // GET  /api/gpio/status     — GPIO connection status

  if (req.method === 'GET' && url === '/api/status') {
    let state = {};
    try { state = JSON.parse(audio.audioGetState()); } catch {}
    res.end(JSON.stringify({ ok: true, ...state, timestamp: Date.now() })); return;
  }

  if (req.method === 'GET' && url === '/api/now-playing') {
    let state = {};
    try { state = JSON.parse(audio.audioGetState()); } catch {}
    const deck = state.deckA || {};
    res.end(JSON.stringify({
      ok: true, title: deck.title || null, artist: deck.artist || null,
      status: deck.status || "stopped", positionSec: deck.positionSec || 0,
      durationSec: deck.durationSec || 0,
    })); return;
  }

  if (req.method === 'POST' && url.startsWith('/api/transport/')) {
    const action = url.replace('/api/transport/', '');
    const deck = qs.deck || 'A';
    try {
      if (action === 'play')  audio.audioPlay(deck);
      else if (action === 'pause') audio.audioPause(deck);
      else if (action === 'stop')  audio.audioStop(deck);
      else if (action === 'skip')  { audio.audioPause('A'); sendToAllWindows('iris:next-track', {}); }
      else { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: `Unknown action: ${action}` })); return; }
      sendToAllWindows('iris:command-received', { action, label: `${action} deck ${deck}` });
      res.end(JSON.stringify({ ok: true, action, deck }));
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  if (req.method === 'GET' && url === '/api/log') {
    try {
      const rows = db.prepare("SELECT * FROM play_log ORDER BY played_at DESC LIMIT 50").all();
      res.end(JSON.stringify({ ok: true, entries: rows }));
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  if (req.method === 'GET' && url === '/api/macros') {
    try {
      const rows = db.prepare("SELECT id, name, description, trigger_type, hotkey, is_active FROM macros ORDER BY name").all();
      res.end(JSON.stringify({ ok: true, macros: rows }));
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  if (req.method === 'POST' && url.startsWith('/api/macro/') && url.endsWith('/run')) {
    const macroId = parseInt(url.replace('/api/macro/', '').replace('/run', ''));
    try {
      const row = db.prepare("SELECT * FROM macros WHERE id = ?").get(macroId);
      if (!row) { res.statusCode = 404; res.end(JSON.stringify({ ok: false, error: "Macro not found" })); return; }
      // Send to renderer for execution (macros run in the renderer context)
      sendToAllWindows('macro:execute', { id: macroId, name: row.name });
      res.end(JSON.stringify({ ok: true, macro: row.name, status: "dispatched" }));
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  if (req.method === 'GET' && url === '/api/gpio/status') {
    try {
      const devices = db.prepare("SELECT id, name, protocol, host, port, is_active FROM gpio_devices").all();
      res.end(JSON.stringify({ ok: true, devices }));
    } catch (e) { res.end(JSON.stringify({ ok: true, devices: [] })); }
    return;
  }

  // Site replication — serve changes to peers
  if (req.method === 'GET' && url === '/api/repl/changes') {
    try {
      const tableName = qs.table || "songs";
      const since = parseInt(qs.since) || 0;
      // Use the repl:get-changes IPC to get data
      const siteIdRow = db.prepare("SELECT value FROM replication_config WHERE key = 'site_id'").get();
      const SYNC_TABLES = ["songs","shows","clocks","spots","macros","categories","separation_rules","smart_schedule_rules"];
      if (!SYNC_TABLES.includes(tableName)) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: "Unknown table" })); return; }
      const rows = db.prepare(`SELECT * FROM ${tableName} LIMIT 500`).all();
      res.end(JSON.stringify({ ok: true, siteId: siteIdRow?.value, table: tableName, rows, count: rows.length }));
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  if (req.method === 'GET' && url === '/api/repl/site-id') {
    try {
      const row = db.prepare("SELECT value FROM replication_config WHERE key = 'site_id'").get();
      res.end(JSON.stringify({ ok: true, siteId: row?.value }));
    } catch { res.end(JSON.stringify({ ok: true, siteId: null })); }
    return;
  }

  // POST /api/captions/iris — Iris app sends its spoken text here so it
  // appears in the captions overlay even before Whisper could transcribe it.
  if (req.method === 'POST' && req.url === '/api/captions/iris') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const { text } = JSON.parse(body);
        if (text) {
          whisperEngine.addIrisLine(text);
          // whisperEngine already emits 'line' which is relayed to renderer below
        }
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ ok: false, error: 'Not found. Endpoints: /api/status, /api/now-playing, /api/transport/:action, /api/log, /api/macros, /api/macro/:id/run, /api/gpio/status, /api/repl/changes, /api/repl/site-id, /api/captions/iris' }));
});

irisHttpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('[API] Port 3400 already in use — REST API disabled. Is another Ether instance running?');
  } else {
    console.error('[API] HTTP server error:', err.message);
  }
});
irisHttpServer.listen(3400, '0.0.0.0', () => {
  console.log('[API] REST server listening on http://0.0.0.0:3400');
});

// Mark Iris disconnected if no ping for 30 seconds
setInterval(() => {
  if (irisConnected && Date.now() - irisLastSeen > 30000) {
    irisConnected = false;
    sendToAllWindows('iris:connected', false);
  }
}, 5000);

// ── Part 8 — Spotify Library Integration ─────────────────────
// Credentials stored via safeStorage (same helper as AI keys).
// Spotify token cached in memory; refreshed automatically.

let _spotifyToken = null;
let _spotifyTokenExpiry = 0;

function getSpotifyConfig() {
  const cfg = readAiConfig();
  return {
    clientId:     decryptKey(cfg.keys?.spotify_client_id)  || null,
    clientSecret: decryptKey(cfg.keys?.spotify_client_secret) || null,
  };
}

async function getSpotifyToken() {
  if (_spotifyToken && Date.now() < _spotifyTokenExpiry) return _spotifyToken;
  const { clientId, clientSecret } = getSpotifyConfig();
  if (!clientId || !clientSecret) return null;
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) return null;
  const data = await res.json();
  _spotifyToken = data.access_token || null;
  _spotifyTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000 - 60000;
  return _spotifyToken;
}

ipcMain.handle("spotify:setCredentials", (_, { clientId, clientSecret }) => {
  const cfg = readAiConfig();
  if (!cfg.keys) cfg.keys = {};
  if (clientId)     cfg.keys.spotify_client_id     = encryptKey(clientId);
  if (clientSecret) cfg.keys.spotify_client_secret = encryptKey(clientSecret);
  writeAiConfig(cfg);
  _spotifyToken = null; // force token refresh
  return true;
});

ipcMain.handle("spotify:getCredentialStatus", () => {
  const { clientId, clientSecret } = getSpotifyConfig();
  return { hasClientId: !!clientId, hasClientSecret: !!clientSecret };
});

ipcMain.handle("spotify:getRecommendations", async (_, { seeds, valence, energy, speechiness, limit }) => {
  try {
    const token = await getSpotifyToken();
    if (!token) return { ok: false, error: "No Spotify credentials — add Client ID and Secret in Settings > AI & Integrations" };

    const params = new URLSearchParams({
      limit: String(Math.min(limit || 100, 100)), // Spotify max per call is 100
      seed_genres: (seeds || ["pop"]).slice(0, 5).join(","), // Spotify max 5 seeds
      target_valence:    String(valence    ?? 0.7),
      min_valence:       String(Math.max(0, (valence ?? 0.7) - 0.2)),
      target_energy:     String(energy     ?? 0.7),
      min_energy:        String(Math.max(0, (energy  ?? 0.7) - 0.2)),
      max_speechiness:   String(speechiness ?? 0.05),
      target_popularity: "60",
    });

    const res = await fetch(`https://api.spotify.com/v1/recommendations?${params}`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { ok: false, error: err.error?.message || `Spotify API error ${res.status}` };
    }
    const data = await res.json();
    const tracks = (data.tracks || [])
      .filter(t => !t.explicit) // server-side explicit filter
      .map(t => ({
        title:       t.name,
        artist:      t.artists?.map(a => a.name).join(", ") || "Unknown",
        album:       t.album?.name || "",
        durationMs:  t.duration_ms,
        spotifyUri:  t.uri,
        spotifyId:   t.id,
        explicit:    t.explicit,
        previewUrl:  t.preview_url || null,
        imageUrl:    t.album?.images?.[2]?.url || t.album?.images?.[0]?.url || null,
        valence:     null, // available in audio features, not recommendations response
        energy:      null,
        speechiness: null,
      }));
    return { ok: true, tracks };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Musixmatch lyric scan — fetches lyrics then checks for red-flag terms
const LYRIC_FLAG_CATEGORIES = {
  violence:    ["kill", "murder", "shoot", "gun", "knife", "blood", "dead", "death", "violent", "stab", "assault", "rape", "bomb", "terrorist", "weapon", "slaughter"],
  sexual:      ["sex", "naked", "pussy", "dick", "cock", "fuck", "bitch", "ass", "booty", "twerk", "strip", "lust", "orgasm", "explicit", "erotic", "horny"],
  hate_speech: ["nigger", "nigga", "faggot", "spic", "kike", "slut", "whore", "retard", "cunt"],
  political:   ["trump", "biden", "democrat", "republican", "maga", "antifa", "blm", "protest", "revolution"],
};

ipcMain.handle("musixmatch:setKey", (_, { key }) => {
  const cfg = readAiConfig();
  if (!cfg.keys) cfg.keys = {};
  cfg.keys.musixmatch = encryptKey(key);
  writeAiConfig(cfg);
  return true;
});

ipcMain.handle("musixmatch:getKeyStatus", () => {
  const cfg = readAiConfig();
  return { hasKey: !!(cfg.keys?.musixmatch) };
});

ipcMain.handle("musixmatch:scanLyrics", async (_, { title, artist }) => {
  try {
    const cfg = readAiConfig();
    const apiKey = decryptKey(cfg.keys?.musixmatch);
    if (!apiKey) return { ok: false, error: "No Musixmatch API key — add it in Settings > AI & Integrations" };

    const searchUrl = `https://api.musixmatch.com/ws/1.1/matcher.lyrics.get?format=json&q_track=${encodeURIComponent(title)}&q_artist=${encodeURIComponent(artist)}&apikey=${apiKey}`;
    const res = await fetch(searchUrl);
    const data = await res.json();

    const statusCode = data?.message?.header?.status_code;
    if (statusCode !== 200) {
      // 404 = lyrics not found — treat as clean (no lyrics = can't scan)
      return { ok: true, found: false, flagged: false, matches: [] };
    }

    const lyrics = (data?.message?.body?.lyrics?.lyrics_body || "").toLowerCase();
    if (!lyrics) return { ok: true, found: false, flagged: false, matches: [] };

    const matches = [];
    for (const [category, terms] of Object.entries(LYRIC_FLAG_CATEGORIES)) {
      for (const term of terms) {
        if (lyrics.includes(term)) {
          matches.push({ category, term });
        }
      }
    }
    return { ok: true, found: true, flagged: matches.length > 0, matches };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Discogs metadata lookup ───────────────────────────────────

let _discogsLastCall = 0;

function getDiscogsConfig() {
  const cfg = readAiConfig();
  const key    = cfg.keys?.discogs_consumer_key    ? decryptKey(cfg.keys.discogs_consumer_key)    : null;
  const secret = cfg.keys?.discogs_consumer_secret ? decryptKey(cfg.keys.discogs_consumer_secret) : null;
  return { key, secret };
}

ipcMain.handle("discogs:setCredentials", (_, { consumerKey, consumerSecret }) => {
  const cfg = readAiConfig();
  if (!cfg.keys) cfg.keys = {};
  if (consumerKey)    cfg.keys.discogs_consumer_key    = encryptKey(consumerKey);
  if (consumerSecret) cfg.keys.discogs_consumer_secret = encryptKey(consumerSecret);
  writeAiConfig(cfg);
  return true;
});

ipcMain.handle("discogs:getCredentialStatus", () => {
  const { key, secret } = getDiscogsConfig();
  return { hasKey: !!key, hasSecret: !!secret };
});

ipcMain.handle("discogs:search", async (_, { title, artist }) => {
  try {
    const { key, secret } = getDiscogsConfig();
    if (!key) return { ok: false, error: "No Discogs credentials — add them in Settings > Integrations" };

    // Rate limit: 1 req/sec
    const now = Date.now();
    const wait = 1000 - (now - _discogsLastCall);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _discogsLastCall = Date.now();

    const q = [title, artist].filter(Boolean).join(" ");
    const url = `https://api.discogs.com/database/search?type=release&q=${encodeURIComponent(q)}&per_page=5&key=${encodeURIComponent(key)}&secret=${encodeURIComponent(secret)}`;
    const res = await fetch(url, { headers: { "User-Agent": "EtherRadio/1.0 +https://ether.fm" } });
    if (!res.ok) return { ok: false, error: `Discogs returned ${res.status}` };
    const data = await res.json();

    const results = (data.results || []).slice(0, 5).map(r => ({
      id:        r.id,
      title:     r.title || "",
      artist:    Array.isArray(r.artists) ? r.artists.map(a => a.name).join(", ") : (r.title || "").split(" - ")[0] || "",
      album:     r.title || "",
      year:      r.year ? parseInt(r.year, 10) : null,
      genre:     (r.genre || r.style || []).slice(0, 1)[0] || null,
      thumb:     r.thumb || r.cover_image || null,
      format:    (r.format || []).join(", ") || null,
      label:     (r.label || []).join(", ") || null,
      catno:     r.catno || null,
    }));

    return { ok: true, results };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle("discogs:updateTrack", (_, { id, title, artist, album, year, genre, bpm }) => {
  try {
    const { artistsFindOrCreateByName } = require('./sync/handlers/artists');
    const { albumsFindOrCreate } = require('./sync/handlers/albums');
    const { songsUpdateById } = require('./sync/handlers/songs');

    // Upsert artist
    const artistRow = artist ? artistsFindOrCreateByName(db, artist) : null;
    const artistId = artistRow?.id ?? null;

    // Upsert album + year
    let albumId = null;
    if (album) {
      const albumRow = albumsFindOrCreate(db, { title: album, artistId, year: year ?? null });
      albumId = albumRow?.id ?? null;
    }

    const patch = {};
    if (title    !== undefined) patch.title     = title;
    if (artistId !== undefined) patch.artist_id = artistId;
    if (albumId  !== undefined) patch.album_id  = albumId;
    if (genre    !== undefined) patch.genre     = genre;
    if (bpm      !== undefined) patch.bpm       = bpm;
    if (Object.keys(patch).length === 0) return { ok: true };
    songsUpdateById(db, id, patch);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Write a Spotify-imported track to the songs table
ipcMain.handle("library:writeTrack", (_, { title, artist, album, durationMs, spotifyUri }) => {
  try {
    const { artistsFindOrCreateByName } = require('./sync/handlers/artists');
    const { albumsFindOrCreate } = require('./sync/handlers/albums');
    const { songsCreate } = require('./sync/handlers/songs');

    // Upsert artist
    const artistRow = artistsFindOrCreateByName(db, artist || "Unknown");
    const artistId = artistRow?.id || null;

    // Upsert album
    let albumId = null;
    if (album && artistId) {
      const albumRow = albumsFindOrCreate(db, { title: album, artistId });
      albumId = albumRow?.id || null;
    }

    // Insert song — no file_path (stream-only via Spotify URI)
    const existing = db.prepare("SELECT id FROM songs WHERE title = ? AND artist_id = ?").get(title, artistId);
    if (existing) return { ok: true, id: existing.id, skipped: true };

    const row = songsCreate(db, {
      title, artist_id: artistId, album_id: albumId,
      duration_ms: durationMs || 0, is_explicit: 0,
      spotify_uri: spotifyUri || null, rotation_status: 'active', daypart_mask: 16777215,
    });
    return { ok: true, id: row.id, skipped: false };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Theme export / import (.ethertheme files) ─────────────────

ipcMain.handle("theme:export", async (_, { presetId, vars, font }) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Export Theme",
      defaultPath: `ether-theme-${presetId || "custom"}.ethertheme`,
      filters: [{ name: "Ether Theme", extensions: ["ethertheme"] }],
    });
    if (result.canceled || !result.filePath) return { ok: false };
    const payload = { presetId, vars, font: font || null, version: 1 };
    fs.writeFileSync(result.filePath, JSON.stringify(payload, null, 2), "utf8");
    return { ok: true, filePath: result.filePath };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle("theme:import", async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Import Theme",
      properties: ["openFile"],
      filters: [{ name: "Ether Theme", extensions: ["ethertheme", "json"] }],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false };
    const raw = fs.readFileSync(result.filePaths[0], "utf8");
    const data = JSON.parse(raw);
    return { ok: true, data };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Station logo (base64 stored in station_config_kv) ─────────

ipcMain.handle("station:uploadLogo", async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Choose Station Logo",
      properties: ["openFile"],
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "svg", "webp"] }],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false };
    const filePath = result.filePaths[0];
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase().slice(1);
    const mime = ext === "svg" ? "image/svg+xml" : ext === "webp" ? "image/webp" : ext === "png" ? "image/png" : "image/jpeg";
    const b64 = `data:${mime};base64,${buf.toString("base64")}`;
    return { ok: true, dataUrl: b64 };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Captions / Live Transcription (Whisper) ───────────────────
//
// Architecture:
//   1. Renderer opens a WASAPI loopback tap via getUserMedia with
//      chromeMediaSource:'desktop' and a ScriptProcessorNode.
//   2. Float32 16 kHz mono PCM chunks arrive via captions:audio-chunk IPC.
//   3. whisper-engine.js accumulates 5-second windows and runs inference.
//   4. Each result is emitted back to the renderer as captions:line.
//   5. Iris spoken text is injected directly via addIrisLine() so it
//      appears instantly without waiting for Whisper to hear it.

const whisperEngine = require('./whisper-engine');

// Relay transcription lines to all renderer windows
whisperEngine.on('line', (line) => {
  sendToAllWindows('captions:line', line);
});

whisperEngine.on('status', (status) => {
  sendToAllWindows('captions:status', status);
});

// Start / stop loopback capture
ipcMain.handle('captions:start', async () => {
  whisperEngine.start();
  return { ok: true };
});

ipcMain.handle('captions:stop', async () => {
  whisperEngine.stop();
  return { ok: true };
});

// PCM Float32 chunks from renderer ScriptProcessorNode (16 kHz mono)
ipcMain.on('captions:audio-chunk', (_evt, float32Array) => {
  whisperEngine.feedSamples(float32Array);
});

// Direct Iris injection — also callable from renderer (e.g. if Iris speaks
// via the local TTS fallback path)
ipcMain.handle('captions:iris-line', (_evt, text) => {
  whisperEngine.addIrisLine(text);
  return { ok: true };
});

// Return the full rolling 60-second transcript on demand
ipcMain.handle('captions:get-transcript', () => {
  return whisperEngine.getTranscript();
});

// Provide a desktopCapturer source ID to the renderer so getUserMedia
// can open WASAPI loopback without showing the OS picker dialog.
ipcMain.handle('captions:get-loopback-source', async () => {
  const { desktopCapturer } = require('electron');
  const sources = await desktopCapturer.getSources({ types: ['screen'] });
  // Return the first screen source — its ID is used to route audio loopback
  return sources[0]?.id || null;
});

// ── R2 track cache — download a file from R2 to a local temp dir ─────────────
// Used by the deck queue so local playback and cloud playback share the same
// R2 source. Once cached the file is reused without re-downloading.

const R2_CACHE_DIR = path.join(app.getPath('userData'), 'r2-cache');
fs.mkdirSync(R2_CACHE_DIR, { recursive: true });

ipcMain.handle('r2:fetch-track', async (_, fileKey) => {
  if (!fileKey) return { ok: false, error: 'No file_key' };

  const getR2Config = app._getR2Config;
  if (!getR2Config) return { ok: false, error: 'R2 module not loaded' };
  const r2 = getR2Config();
  if (!r2.accessKeyId || !r2.secretAccessKey) return { ok: false, error: 'R2 not configured' };

  const safeName  = path.basename(fileKey).replace(/[^a-zA-Z0-9._-]/g, '_');
  const cachePath = path.join(R2_CACHE_DIR, safeName);

  if (fs.existsSync(cachePath)) return { ok: true, filePath: cachePath };

  try {
    const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const https = require('https');
    const http  = require('http');

    const s3  = new S3Client({
      region: 'auto',
      endpoint: r2.resolvedEndpoint || r2.endpoint || `https://${r2.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey },
    });
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: r2.bucket || 'ether-audio', Key: fileKey }), { expiresIn: 300 });

    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(cachePath);
      const get  = url.startsWith('https') ? https : http;
      get.get(url, res => {
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', err => { fs.unlink(cachePath, () => {}); reject(err); });
    });

    console.log(`[r2:fetch-track] cached ${safeName} (${(fs.statSync(cachePath).size / 1e6).toFixed(1)} MB)`);
    return { ok: true, filePath: cachePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Playout server config ─────────────────────────────────────────────────────
ipcMain.handle('playout:get-server', () => {
  try {
    const row = db.prepare("SELECT value FROM station_config_kv WHERE key='playout_server'").get();
    return row?.value?.trim() || '44.244.52.207';
  } catch { return '44.244.52.207'; }
});

ipcMain.handle('playout:set-server', (_, ip) => {
  try {
    const trimmed = String(ip).trim();
    const { stationConfigKvUpsertByKey } = require('./sync/handlers/station_config_kv');
    stationConfigKvUpsertByKey(db, getActiveStationId(), 'playout_server', trimmed);
    // Keep stations table in sync so stream:go-live reads the updated value
    const { stationsUpdateById } = require('./sync/handlers/stations');
    stationsUpdateById(db, getActiveStationId(), { icecast_server_url: trimmed });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Real-time cloud playout sync ──────────────────────────────────────────────
// Fired by the renderer whenever a deck starts playing a new track.
// POSTs to the cloud playout server so it mirrors the live deck in real time.

let _playoutLastPing = 0;  // epoch ms of last successful play POST

// ── Schedule Generator ────────────────────────────────────────────────────────
// Reads shows → clocks → clock_slots, picks songs per rotation rules, and
// writes a full week of timestamped entries to generated_schedule.
ipcMain.handle('schedule:generate', (_, days = 7) => {
  try {
    // Load separation rules (fall back to safe defaults)
    let artistSepMin = 60;
    let songRepeatMin = 180;
    try {
      const ar = db.prepare("SELECT value FROM separation_rules WHERE rule_type='artist_separation_min' AND is_active=1 LIMIT 1").get();
      if (ar) artistSepMin = ar.value;
      const sr = db.prepare("SELECT value FROM separation_rules WHERE rule_type='song_separation_min' AND is_active=1 LIMIT 1").get();
      if (sr) songRepeatMin = sr.value;
    } catch {}

    const { generatedScheduleClearAll, generatedScheduleBulkCreate } = require('./sync/handlers/generated_schedule');
    const activeStationId = getActiveStationId();

    // Wipe previous run
    generatedScheduleClearAll(db, activeStationId);

    // Prepared statements (compiled once, reused in the loop)
    const stmtShows = db.prepare(
      `SELECT id, start_hour, end_hour, clock_id
       FROM shows
       WHERE instr(days, ?) > 0 AND is_active = 1 AND station_id = ?
       ORDER BY CASE
         WHEN end_hour = 0 AND start_hour > 0 THEN 24 - start_hour
         WHEN end_hour = 0 OR end_hour = start_hour THEN 24
         WHEN end_hour > start_hour              THEN end_hour - start_hour
         ELSE 24 - start_hour + end_hour
       END ASC`
    );
    const stmtSlots = db.prepare(
      `SELECT cs.position, cs.slot_type, cs.category_id, cs.duration_min
       FROM clock_slots cs
       WHERE cs.clock_id = ? ORDER BY cs.position`
    );
    const stmtCandidates = db.prepare(
      `SELECT s.id, s.title, a.name AS artist_name, s.artist_id,
              s.duration_ms, s.last_played_at, s.file_path
       FROM songs s LEFT JOIN artists a ON a.id = s.artist_id
       WHERE s.category_id = ?
         AND (s.rotation_status IS NULL OR s.rotation_status != 'inactive')
         AND ((s.daypart_mask >> ?) & 1) = 1
       ORDER BY COALESCE(s.last_played_at, 0) ASC`
    );
    const generatedRows = [];

    // Per-generation tracking maps (survive across hours/days)
    const songLastTs   = new Map(); // songId   → unix ts last queued this run
    const artistLastTs = new Map(); // artistId → unix ts last queued this run

    const now = new Date();
    now.setMinutes(0, 0, 0);

    for (let d = 0; d < days; d++) {
      for (let h = 0; h < 24; h++) {
        const slotDate = new Date(now.getTime() + d * 86_400_000);
        slotDate.setHours(h, 0, 0, 0);
        const jsDay      = slotDate.getDay(); // 0=Sun
        const hourStartTs = Math.floor(slotDate.getTime() / 1000);

        // Find the show active at this hour on this weekday
        const shows = stmtShows.all(String(jsDay), activeStationId);
        const show  = shows.find(s => {
          if (s.end_hour === 0 || s.end_hour === s.start_hour) return h >= s.start_hour;
          if (s.end_hour > s.start_hour) return h >= s.start_hour && h < s.end_hour;
          return h >= s.start_hour || h < s.end_hour; // overnight
        });
        if (!show || !show.clock_id) continue;

        const slots = stmtSlots.all(show.clock_id);
        if (!slots.length) continue;

        // Per-hour sets to avoid same song or artist within a single hour
        const usedSongIds   = new Set();
        const usedArtistIds = new Set();

        let currentTs = hourStartTs;

        for (const slot of slots) {
          const slotDurationS = (slot.duration_min || 4) * 60;

          if (slot.slot_type !== 'music' || !slot.category_id) {
            currentTs += slotDurationS;
            continue;
          }

          const candidates = stmtCandidates.all(slot.category_id, h);

          let picked = null;
          let softFallback = null;

          for (const song of candidates) {
            if (usedSongIds.has(song.id)) continue;

            // Song repeat check — use generation-run timestamp if available, else DB value
            const lastSongTs  = songLastTs.get(song.id) ?? (song.last_played_at || 0);
            const songAgeSec  = currentTs - lastSongTs;
            if (songAgeSec < songRepeatMin * 60) continue;

            // Artist separation — strict within the hour, soft across hours
            const lastArtistTs = song.artist_id ? (artistLastTs.get(song.artist_id) || 0) : 0;
            const artistAgeSec = currentTs - lastArtistTs;
            const artistBlocked = usedArtistIds.has(song.artist_id)
              || (song.artist_id && artistAgeSec < artistSepMin * 60);

            if (!artistBlocked) { picked = song; break; }
            if (!softFallback)    softFallback = song; // same artist, but song repeat ok
          }

          // Soft fallback: violates artist sep but passes song repeat
          if (!picked) picked = softFallback;
          // Last resort: any unused song
          if (!picked) picked = candidates.find(s => !usedSongIds.has(s.id)) ?? candidates[0] ?? null;

          if (picked) {
            usedSongIds.add(picked.id);
            if (picked.artist_id) usedArtistIds.add(picked.artist_id);
            songLastTs.set(picked.id, currentTs);
            if (picked.artist_id) artistLastTs.set(picked.artist_id, currentTs);

            const durationS = picked.duration_ms
              ? Math.round(picked.duration_ms / 1000)
              : slotDurationS;

            generatedRows.push({
              scheduled_at: currentTs, song_id: picked.id,
              title: picked.title, artist: picked.artist_name || '',
              file_key: picked.file_path ? path.basename(picked.file_path) : '',
              duration_s: durationS, category_id: slot.category_id, clock_id: show.clock_id,
            });
            currentTs += durationS;
          } else {
            currentTs += slotDurationS;
          }
        }
      }
    }

    generatedScheduleBulkCreate(db, activeStationId, generatedRows);
    console.log(`[schedule:generate] Generated ${generatedRows.length} tracks over ${days} days`);
    return { ok: true, count: generatedRows.length };
  } catch (e) {
    console.error('[schedule:generate]', e.message);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('schedule:get', (_, fromTs, toTs) => {
  try {
    const rows = db.prepare(
      `SELECT id, scheduled_at, song_id, title, artist, file_key, duration_s, category_id
       FROM generated_schedule
       WHERE scheduled_at >= ? AND scheduled_at < ?
       ORDER BY scheduled_at`
    ).all(fromTs ?? 0, toTs ?? 9999999999);
    return { data: rows, error: null };
  } catch (e) {
    return { data: null, error: e.message };
  }
});

// ── Library → R2 sync ─────────────────────────────────────────────────────────
// Uploads every local song file to R2. Runs async; progress sent via IPC push.
// Cancel by calling library:sync-r2:cancel before the job finishes.

// ── Live stream to Icecast ────────────────────────────────────────────────────
// ffmpeg reads raw f32le stereo PCM from the Program Bus TCP socket exposed by
// the native BusMixer, encodes to MP3, and pushes to Icecast.
// No hardware capture device required — the mix is tapped inside the engine.

// Map<stationId, { armed, proc, url, failureCount, firstFailureTime, statusState, speed, bitrate, startTime, speedHistory, errorMsg, destLabel, ticker }>
const _stationStreams = new Map();

// ── Stream status helpers ─────────────────────────────────────────────────────

function _parseStreamLine(line) {
  const speedM   = line.match(/speed=\s*([\d.]+)x/);
  const bitrateM = line.match(/bitrate=\s*([\d.]+)kbits\/s/);
  return {
    speed:      speedM   ? parseFloat(speedM[1])   : null,
    bitrate:    bitrateM ? parseFloat(bitrateM[1]) : null,
    isProgress: !!(speedM || bitrateM),
    isLive:     /frame=\s*[1-9]\d*\s/.test(line) || /size=\s*[1-9]\d*kB/i.test(line),
    errorMsg:   /Connection refused/i.test(line)    ? 'Connection refused'
              : /401|Unauthorized/i.test(line)       ? 'Auth failed (401)'
              : /403|Forbidden/i.test(line)           ? 'Forbidden (403)'
              : /Connection timed out/i.test(line)    ? 'Connection timed out'
              : /Failed to connect/i.test(line)       ? 'Failed to connect'
              : null,
  };
}

function _labelFromRtmpUrl(url) {
  if (!url) return 'RTMP';
  if (/a\.rtmp\.youtube\.com/i.test(url))      return 'YouTube';
  if (/live\.twitch\.tv/i.test(url))            return 'Twitch';
  if (/live-api.*\.facebook\.com/i.test(url))   return 'Facebook';
  try { return new URL(url.replace(/^rtmp:\/\//i, 'https://')).hostname; } catch { return 'RTMP'; }
}

function _emitDestStatus(destId, statusObj) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const uptimeSec = statusObj.startTime ? Math.floor((Date.now() - statusObj.startTime) / 1000) : null;
  mainWindow.webContents.send('stream:status:dest', {
    destId,
    label:        statusObj.destLabel || destId,
    state:        statusObj.statusState,
    speed:        statusObj.speed,
    bitrate:      statusObj.bitrate,
    uptimeSec,
    errorMsg:     statusObj.errorMsg,
    speedHistory: [...statusObj.speedHistory],
  });
}

function _emitGlobal() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  let liveCount = 0;
  for (const [, st] of _stationStreams.entries()) {
    if (st.statusState === 'live') liveCount++;
  }
  if (_rtmpStreamStatus.statusState === 'live') liveCount++;
  mainWindow.webContents.send('stream:status:global', { anyLive: liveCount > 0, liveCount });
}

// Per-process RTMP status (video studio pipeline; lives alongside _rtmpProcess)
const _rtmpStreamStatus = {
  statusState: 'idle', speed: null, bitrate: null,
  startTime: null, speedHistory: [], errorMsg: null,
  destLabel: 'RTMP', ticker: null,
};

function _getStreamState(stationId) {
  if (!_stationStreams.has(stationId)) {
    _stationStreams.set(stationId, {
      armed: false,
      proc: null,
      url: '',
      failureCount: 0,
      firstFailureTime: 0,
      statusState: 'idle',
      speed: null,
      bitrate: null,
      startTime: null,
      speedHistory: [],
      errorMsg: null,
      destLabel: '',
      ticker: null,
    });
  }
  return _stationStreams.get(stationId);
}

function _streamKillCurrent(stationId) {
  const state = _getStreamState(stationId);
  if (state.proc) {
    try { state.proc.kill('SIGTERM'); } catch {}
    state.proc = null;
  }
}

function _spawnStream(stationId, args, label) {
  _streamKillCurrent(stationId);
  const state = _getStreamState(stationId);
  const { spawn } = require('child_process');
  const bin = ffmpegBin || 'ffmpeg';
  console.log(`[stream/${stationId}] spawning ffmpeg: ${bin}`);
  console.log(`[stream/${stationId}] args: ${args.join(' ')}`);

  state.statusState = 'connecting';
  state.errorMsg    = null;
  state.speed       = null;
  state.bitrate     = null;
  _emitDestStatus(`icecast:${stationId}`, state);
  _emitGlobal();

  state.proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  state.proc.stderr.on('data', d => {
    const text = d.toString();
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      console.log(`[stream/${stationId}/ffmpeg] ${trimmed.slice(0, 120)}`);
      const parsed = _parseStreamLine(trimmed);
      if (parsed.errorMsg) {
        state.errorMsg = parsed.errorMsg;
        if (state.statusState === 'connecting') {
          // Error during connect phase is likely fatal — we haven't published yet.
          state.statusState = 'error';
          _emitDestStatus(`icecast:${stationId}`, state);
          _emitGlobal();
        }
        // While live, stash the message but don't change state.
        // The close handler is authoritative; sub-request errors leave the stream flowing.
      } else if (parsed.isLive && state.statusState === 'connecting') {
        state.statusState = 'live';
        state.startTime   = Date.now();
        state.errorMsg    = null;
        _emitDestStatus(`icecast:${stationId}`, state);
        _emitGlobal();
      } else if (parsed.isProgress && state.statusState === 'live') {
        if (parsed.speed   !== null) { state.speed = parsed.speed; state.speedHistory = [...state.speedHistory.slice(-119), parsed.speed]; }
        if (parsed.bitrate !== null) state.bitrate = parsed.bitrate;
        _emitDestStatus(`icecast:${stationId}`, state);
      }
    }
  });
  state.proc.on('error', e => {
    console.error(`[stream/${stationId}] spawn error: ${e.message}`);
    state.proc        = null;
    state.statusState = 'error';
    state.errorMsg    = e.message;
    _emitDestStatus(`icecast:${stationId}`, state);
    _emitGlobal();
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('stream:status', { stationId, live: false, error: e.message });
  });
  state.proc.on('close', code => {
    console.log(`[stream/${stationId}] ffmpeg closed (code ${code}) — ${label}`);
    state.proc = null;
    if (!state.armed) {
      state.statusState = 'idle';
      state.speed       = null;
      state.bitrate     = null;
      _emitDestStatus(`icecast:${stationId}`, state);
      _emitGlobal();
      return;
    }

    const now = Date.now();
    if (now - state.firstFailureTime > 10000) {
      state.failureCount    = 0;
      state.firstFailureTime = now;
    }
    if (state.failureCount === 0) state.firstFailureTime = now;
    state.failureCount++;

    if (state.failureCount >= 3) {
      console.error(`[stream/${stationId}] ffmpeg failed ${state.failureCount}x in 10s — giving up`);
      state.armed        = false;
      state.failureCount = 0;
      state.statusState  = 'error';
      state.errorMsg     = 'Streaming failed after repeated ffmpeg restarts. Check Icecast server URL and credentials.';
      _emitDestStatus(`icecast:${stationId}`, state);
      _emitGlobal();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('stream:status', { stationId, live: false, error: state.errorMsg });
      }
      return;
    }

    state.statusState = 'connecting';
    _emitDestStatus(`icecast:${stationId}`, state);
    console.log(`[stream/${stationId}] ffmpeg exited, respawning in 500ms (attempt ${state.failureCount}/3)`);
    setTimeout(() => {
      if (state.armed) _spawnStream(stationId, args, label);
    }, 500);
  });
  console.log(`[stream/${stationId}] → ${label}`);
}

ipcMain.handle('stream:go-live', async (_, args = {}) => {
  try {
    const stationId = args.stationId ?? getActiveStationId();
    const station   = db.prepare("SELECT * FROM stations WHERE id=?").get(stationId);
    if (!station) return { ok: false, error: `station ${stationId} not found` };

    const port   = audio.audioGetProgramBusPort(stationId);
    if (!port) return { ok: false, error: 'Audio engine not ready — no Program Bus port available.' };

    const server = station.icecast_server_url?.trim() || '44.244.52.207';
    const pw     = station.icecast_password?.trim()   || 'hackme';
    const mount  = station.icecast_mount?.trim()      || '/live';
    const state  = _getStreamState(stationId);
    state.url       = `icecast://source:${pw}@${server}:8000${mount}`;
    state.destLabel = `Icecast @ ${server}${mount}`;
    state.armed     = true;

    // Sample rate is negotiated by the native engine with the output device.
    // Default 44100 is safe; the engine always resamples to match before writing.
    const sampleRate = 44100;

    _spawnStream(stationId, [
      '-f', 'f32le', '-ar', String(sampleRate), '-ac', '2',
      '-i', `tcp://127.0.0.1:${port}`,
      '-c:a', 'libmp3lame', '-b:a', '128k',
      '-f', 'mp3',
      '-content_type', 'audio/mpeg',
      state.url,
    ], `programbus:${port}→${mount}`);

    console.log(`[stream/${stationId}] ffmpeg started (programbus:${port}) → ${state.url}`);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('stream:status', { stationId, live: true, server, mount });
    }
    return { ok: true, server, mount, stationId };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('stream:stop-live', (_, args = {}) => {
  const stationId = args.stationId ?? getActiveStationId();
  const state     = _getStreamState(stationId);
  state.armed = false;
  state.failureCount = 0;
  _streamKillCurrent(stationId);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('stream:status', { stationId, live: false });
  }
  return { ok: true, stationId };
});

ipcMain.handle('stream:get-status', (_, args = {}) => {
  if (args?.stationId != null) {
    const state = _getStreamState(args.stationId);
    return { stationId: args.stationId, live: state.armed };
  }
  const all = [];
  for (const [stationId, state] of _stationStreams.entries()) {
    all.push({ stationId, live: state.armed });
  }
  return { stations: all };
});

ipcMain.handle('stream:get-all-status', () => {
  const dests = [];
  for (const [stationId, st] of _stationStreams.entries()) {
    const uptimeSec = st.startTime ? Math.floor((Date.now() - st.startTime) / 1000) : null;
    dests.push({
      destId:       `icecast:${stationId}`,
      label:        st.destLabel || `Icecast (${stationId})`,
      state:        st.statusState,
      speed:        st.speed,
      bitrate:      st.bitrate,
      uptimeSec,
      errorMsg:     st.errorMsg,
      speedHistory: [...st.speedHistory],
    });
  }
  const rtmpUptime = _rtmpStreamStatus.startTime ? Math.floor((Date.now() - _rtmpStreamStatus.startTime) / 1000) : null;
  dests.push({
    destId:       'rtmp:video',
    label:        _rtmpStreamStatus.destLabel || 'RTMP',
    state:        _rtmpStreamStatus.statusState,
    speed:        _rtmpStreamStatus.speed,
    bitrate:      _rtmpStreamStatus.bitrate,
    uptimeSec:    rtmpUptime,
    errorMsg:     _rtmpStreamStatus.errorMsg,
    speedHistory: [..._rtmpStreamStatus.speedHistory],
  });
  const liveCount = dests.filter(d => d.state === 'live').length;
  return { dests, anyLive: liveCount > 0, liveCount };
});

// ── Stations CRUD ─────────────────────────────────────────────
ipcMain.handle('stations:list', () =>
  db.prepare("SELECT * FROM stations ORDER BY id").all()
);

ipcMain.handle('stations:get-active', () =>
  db.prepare("SELECT * FROM stations WHERE is_active=1 LIMIT 1").get() ?? null
);

ipcMain.handle('stations:switch', (_, id) => {
  try {
    const { stationsUpdateById } = require('./sync/handlers/stations');
    const others = db.prepare("SELECT id FROM stations WHERE deleted_at IS NULL AND id != ?").all(id);
    for (const s of others) stationsUpdateById(db, s.id, { is_active: 0 });
    stationsUpdateById(db, id, { is_active: 1 });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('stations:create', (_, data) => {
  // Safety gate: block second-station creation until Phase 3 INSERT audit is complete.
  // 40 renderer callsites still rely on DEFAULT station_id=1 — see checklist at top of file.
  // To unlock: INSERT OR REPLACE INTO station_config_kv (key,value) VALUES ('multistation_insert_audit_complete','true')
  const existingCount = db.prepare("SELECT COUNT(*) as c FROM stations").get().c;
  if (existingCount >= 1) {
    const auditRow = db.prepare("SELECT value FROM station_config_kv WHERE key='multistation_insert_audit_complete'").get();
    if (auditRow?.value !== 'true') {
      return {
        ok: false,
        error: "Cannot create additional stations: renderer INSERT audit incomplete. " +
          "40 callsites still rely on DEFAULT station_id=1 (see checklist at top of electron/main.js). " +
          "Set multistation_insert_audit_complete=true in station_config_kv after Phase 3 audit to enable.",
      };
    }
  }
  try {
    const { stationsCreate } = require('./sync/handlers/stations');
    const row = stationsCreate(db, {
      name: data.name || 'New Station', callsign: data.callsign || '',
      frequency: data.frequency || '', city: data.city || '',
      state: data.state || '', country: data.country || 'US', website: data.website || '',
      icecast_server_url: data.icecast_server_url || '127.0.0.1',
      icecast_mount: data.icecast_mount || '/live',
      icecast_password: data.icecast_password || 'hackme',
      icecast_bitrate: data.icecast_bitrate || 128, icecast_format: data.icecast_format || 'mp3',
      is_active: 0,
    });
    return { ok: true, id: row.id };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('stations:update', (_, id, data) => {
  const allowed = [
    'name','callsign','frequency','city','state','country','website','is_active',
    'icecast_server_url','icecast_mount','icecast_password','icecast_bitrate','icecast_format',
  ];
  const patch = {};
  for (const k of allowed) { if (k in data) patch[k] = data[k]; }
  if (Object.keys(patch).length === 0) return { ok: false, error: 'no valid fields' };
  try {
    const { stationsUpdateById } = require('./sync/handlers/stations');
    stationsUpdateById(db, id, patch);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('stations:delete', (_, id) => {
  try {
    const { stationsDeleteById } = require('./sync/handlers/stations');
    stationsDeleteById(db, id);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

let _libSyncAbort = false;

ipcMain.handle('library:sync-r2:start', async () => {
  const getR2Config = app._getR2Config;
  if (!getR2Config) return { ok: false, error: 'Cloud Backup module not loaded' };

  const r2 = getR2Config();
  if (!r2.resolvedEndpoint || !r2.accessKeyId || !r2.secretAccessKey) {
    return { ok: false, error: 'R2 not configured — set up Cloud Backup credentials first' };
  }

  const songs = db.prepare(
    `SELECT id, file_path FROM songs
     WHERE file_path IS NOT NULL AND file_path != ''`
  ).all();

  if (!songs.length) return { ok: false, error: 'No local song files found in the library' };

  _libSyncAbort = false;

  // Fire-and-forget — returns immediately so the renderer isn't blocked
  (async () => {
    const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
    const s3 = new S3Client({
      region: 'auto',
      endpoint: r2.resolvedEndpoint,
      credentials: { accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey },
    });

    const CONCURRENCY = 3;
    let done = 0;
    let errors = 0;

    function contentType(fp) {
      const ext = path.extname(fp).toLowerCase();
      return ({ '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav',
                '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg' })[ext]
        || 'application/octet-stream';
    }

    async function uploadOne(song) {
      if (_libSyncAbort) return;
      const key = path.basename(song.file_path);
      try {
        const data = require('fs').readFileSync(song.file_path);
        await s3.send(new PutObjectCommand({
          Bucket: r2.bucket,
          Key:    key,
          Body:   data,
          ContentType: contentType(song.file_path),
        }));
      } catch (e) {
        errors++;
        console.warn(`[library:sync-r2] SKIP ${key}: ${e.message}`);
      }
      done++;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('library:sync-r2:progress', {
          done, total: songs.length, errors, current: key,
        });
      }
    }

    // Upload in batches of CONCURRENCY
    for (let i = 0; i < songs.length; i += CONCURRENCY) {
      if (_libSyncAbort) break;
      await Promise.all(songs.slice(i, i + CONCURRENCY).map(uploadOne));
    }

    const aborted = _libSyncAbort;
    _libSyncAbort = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('library:sync-r2:done', {
        done, total: songs.length, errors, aborted,
      });
    }
    console.log(`[library:sync-r2] ${aborted ? 'Cancelled' : 'Done'} — ${done}/${songs.length} uploaded, ${errors} errors`);
  })().catch(e => {
    console.error('[library:sync-r2] fatal:', e.message);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('library:sync-r2:done', { done: 0, total: songs.length, errors: 1, aborted: false });
    }
  });

  return { ok: true, total: songs.length };
});

ipcMain.handle('library:sync-r2:cancel', () => {
  _libSyncAbort = true;
  return { ok: true };
});
