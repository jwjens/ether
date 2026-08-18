'use strict';
// electron/sync/tests/helpers/create-test-db.js
//
// Factory: creates a fresh in-memory SQLite DB for each sync test.
// Infrastructure tables always created; synced table set is configurable.
//
// Usage:
//   const { createTestDb } = require('./helpers/create-test-db');
//   const { db, clientId } = createTestDb();                  // defaults
//   const { db, clientId } = createTestDb({ schemaVersion: 15, tables: ['albums'] });

const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');

// ── Infrastructure DDL ────────────────────────────────────────────────────────
// Mirrors the real schema; must match what mutation-writer and merge-engine expect.

const INFRASTRUCTURE_DDL = `
  CREATE TABLE schema_version (
    version INTEGER NOT NULL
  );

  CREATE TABLE client_identity (
    id      INTEGER PRIMARY KEY CHECK (id = 1),
    client_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    label TEXT
  );

  CREATE TABLE system_state (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE mutations (
    id                  TEXT PRIMARY KEY,
    client_id           TEXT NOT NULL,
    station_id          TEXT,
    actor_id            TEXT,
    table_name          TEXT NOT NULL,
    row_id              TEXT NOT NULL,
    op                  TEXT NOT NULL CHECK (op IN ('insert','update','delete','checkpoint')),
    payload_before      TEXT,
    payload_after       TEXT,
    created_at          TEXT NOT NULL,
    applied_at          TEXT NOT NULL,
    hlc                 TEXT NOT NULL,
    parent_mutation_id  TEXT,
    schema_version      INTEGER NOT NULL,
    origin              TEXT NOT NULL CHECK (origin IN ('local','remote','system','migration')),
    sync_status         TEXT NOT NULL CHECK (sync_status IN ('pending','syncing','synced','conflicted')),
    conflict_resolution TEXT
  );

  CREATE TABLE quarantine_mutations (
    id                     TEXT PRIMARY KEY,
    raw_json               TEXT NOT NULL,
    foreign_schema_version INTEGER NOT NULL,
    local_schema_version   INTEGER NOT NULL,
    received_at            TEXT NOT NULL,
    drain_status           TEXT NOT NULL DEFAULT 'pending'
                             CHECK (drain_status IN ('pending','drained','failed')),
    retry_count            INTEGER NOT NULL DEFAULT 0,
    retry_after            TEXT
  );
`;

// ── Synced-table DDL map ──────────────────────────────────────────────────────
// Only the tables actually needed across T-01..T-38.
// Columns match REGISTRY exactly so serializePayload / deserializePayload work.

const SYNCED_TABLE_DDL = {
  albums: `
    CREATE TABLE albums (
      id         INTEGER PRIMARY KEY,
      uuid       TEXT NOT NULL UNIQUE,
      title      TEXT NOT NULL DEFAULT '',
      artist_id  INTEGER,
      year       INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT,
      deleted_at TEXT
    );
  `,

  // station_config_kv — needed for T-39/T-40 (the upsert no-op guard). PK is (station_id, key),
  // which is why a bare `WHERE key = ?` read ever hit the wrong row. Mirrors the live schema.
  station_config_kv: `
    CREATE TABLE station_config_kv (
      station_id   INTEGER NOT NULL,
      key          TEXT NOT NULL,
      value        TEXT,
      uuid         TEXT NOT NULL,
      created_at   INTEGER DEFAULT (unixepoch()),
      updated_at   INTEGER DEFAULT (unixepoch()),
      deleted_at   INTEGER,
      station_uuid TEXT,
      PRIMARY KEY (station_id, key)
    );
  `,

  // install_secrets_kv — needed for T-25 (push-filter excludes it)
  install_secrets_kv: `
    CREATE TABLE install_secrets_kv (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      uuid       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
  `,

  // monitor_routing — needed for T-26 (push-filter excludes scope:'local-only')
  // DDL sourced from scripts/migrate-phase-a-v8.js Step 5 (S4).
  monitor_routing: `
    CREATE TABLE monitor_routing (
      output_device_id TEXT PRIMARY KEY,
      station_id       INTEGER,
      uuid             TEXT NOT NULL,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL,
      deleted_at       TEXT
    );
  `,

  // rtmp_destinations — needed for T-27 (stream_key is local-only in REGISTRY)
  rtmp_destinations: `
    CREATE TABLE rtmp_destinations (
      id          INTEGER PRIMARY KEY,
      uuid        TEXT NOT NULL UNIQUE,
      name        TEXT,
      url         TEXT,
      stream_key  TEXT,
      station_id  INTEGER,
      created_at  TEXT,
      updated_at  TEXT,
      deleted_at  TEXT
    );
  `,

  // stations — needed for T-28 (icecast_password, mount_pending_provision local-only)
  stations: `
    CREATE TABLE stations (
      id                       INTEGER PRIMARY KEY,
      uuid                     TEXT NOT NULL UNIQUE,
      name                     TEXT,
      is_active                INTEGER,
      icecast_password         TEXT,
      mount_pending_provision  TEXT,
      station_id               INTEGER,
      created_at               TEXT,
      updated_at               TEXT,
      deleted_at               TEXT
    );
  `,
};

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create and seed an in-memory SQLite database for sync tests.
 *
 * @param {object} [opts]
 * @param {number}   [opts.schemaVersion=16]  Schema version row to seed.
 * @param {string[]} [opts.tables=['albums']]  Synced tables to create.
 * @returns {{ db: import('better-sqlite3').Database, clientId: string }}
 */
function createTestDb({ schemaVersion = 16, tables = ['albums'] } = {}) {
  const db = new Database(':memory:');

  // Infrastructure tables (always)
  db.exec(INFRASTRUCTURE_DDL);

  // schema_version
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(schemaVersion);

  // client_identity — fresh UUID per call so tests are independent
  const clientId = uuidv4();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO client_identity (id, client_id, created_at) VALUES (1, ?, ?)'
  ).run(clientId, now);

  // system_state: hlc_last seed per [N-42]
  db.prepare(
    "INSERT INTO system_state (key, value, updated_at) VALUES ('hlc_last', ?, ?)"
  ).run(`0:0:${clientId}`, now);

  // Requested synced tables
  for (const t of tables) {
    const ddl = SYNCED_TABLE_DDL[t];
    if (!ddl) throw new Error(`create-test-db: no DDL for table "${t}"`);
    db.exec(ddl);
  }

  return { db, clientId };
}

module.exports = { createTestDb };
