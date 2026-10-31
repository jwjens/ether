'use strict';
// Migration v69 — stream_metadata_targets: Settings → Broadcast → Stream Metadata Outputs (Jeff, 2026-10-30, build B;
// docs/dead-controls-and-four-builds-proposal-2026-10-30.md §B). Every song that starts on a station is sent as
// "Artist - Title" to that station's enabled outputs (Icecast, Shoutcast, TuneIn AIR, a webhook, an RDS encoder on a
// serial port). electron/metadata-dispatcher.js reads and writes this table.
//
// LOCAL TO THIS COMPUTER — NOT SYNCED (not in electron/sync/synced-tables.js): an RDS encoder's serial port and a
// server's admin password belong to the computer that sends. Per station by station_id (a local integer is right for a
// local-only table; nothing leaves this computer).
//
// Additive and idempotent — CREATE TABLE IF NOT EXISTS.
//
//   ELECTRON_RUN_AS_NODE=1 electron.exe scripts/migrate-stream-metadata-targets-phase-sync-69.js <copy.db>

const VERSION = 69;

function applyMigration(db) {
  const already = db.prepare('SELECT 1 FROM schema_version WHERE version = ?').get(VERSION);
  db.transaction(() => {
    db.prepare(`CREATE TABLE IF NOT EXISTS stream_metadata_targets (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id     INTEGER NOT NULL,
      name           TEXT NOT NULL DEFAULT '',
      type           TEXT NOT NULL,
      enabled        INTEGER NOT NULL DEFAULT 1,
      config_json    TEXT NOT NULL DEFAULT '{}',
      last_status    TEXT NOT NULL DEFAULT '',
      last_error     TEXT NOT NULL DEFAULT '',
      last_pushed_at INTEGER NOT NULL DEFAULT 0,
      last_sent      TEXT NOT NULL DEFAULT '',
      push_count     INTEGER NOT NULL DEFAULT 0,
      created_at     INTEGER NOT NULL DEFAULT (unixepoch())
    )`).run();
    // An old copy of the table (listed in the v8/v9 snapshots, from the never-installed first dispatcher) lacks these.
    const cols = new Set(db.prepare('PRAGMA table_info(stream_metadata_targets)').all().map(c => c.name));
    if (!cols.has('station_id')) db.prepare('ALTER TABLE stream_metadata_targets ADD COLUMN station_id INTEGER NOT NULL DEFAULT 0').run();
    if (!cols.has('last_sent')) db.prepare("ALTER TABLE stream_metadata_targets ADD COLUMN last_sent TEXT NOT NULL DEFAULT ''").run();
    db.prepare('CREATE INDEX IF NOT EXISTS idx_stream_metadata_targets_station ON stream_metadata_targets(station_id)').run();
    if (!already) db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(VERSION);
  })();
  console.log('[migrate-v69] stream_metadata_targets ready');
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload) {
    // ADDS NOTHING: the table is local to this computer and never travels.
    return payload;
  },
  applyMigration,
};

if (require.main === module) {
  const path = require('path');
  const os = require('os');
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dbPath = process.argv[2] || path.join(localAppData, 'Ether', 'com.ether.radio', 'openair.db');
  const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
  const db = new Database(dbPath);
  try { applyMigration(db); } finally { db.close(); }
}
