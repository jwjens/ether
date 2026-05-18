// Migration 4 — library architecture (Direction C) per docs/phase-4-library-architecture.md.
// Run with: npx electron scripts/migrate-library-phase-sync-4.js
// IMPORTANT: Stop the Ether dev server before running.
// This migration is ATOMIC — if any step fails, entire migration rolls back.
//
// New tables: station_programming, mood_tags, station_programming_moods
// Schema changes: play_log.programming_row_id; pinned_songs gained sync columns
// Migrates 355 songs.category_id values into station_programming rows.

'use strict';

const path   = require("path");
const os     = require("os");
const fs     = require("fs");
const crypto = require("crypto");
const Database = require('better-sqlite3');

const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const dbPath  = path.join(appData, "com.ether.radio", "openair.db");

const ROTATION_STATUS_VALUES = ['active', 'inactive', 'hold'];

// ── Payload transformer per [N-68]/[N-69] ────────────────────────────────────

function tableExists(db, name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}

function abort(db, msg) {
  console.error(`[migrate-library] ABORT: ${msg}`);
  if (db) { try { db.close(); } catch (_) {} }
  process.exit(1);
}

function applyMigration(db) {
  // No pre-flight check — chain runner guarantees this version has not been applied.
  // NOTE: Step 5 (ALTER TABLE pinned_songs) assumes pinned_songs exists. On a fresh install
  // via the chain runner this will fail if pinned_songs is absent from v0 baseline.
  // Tracked for resolution in Step 6 when the chain runner is tested against a fresh DB.
  const stationRows = db.prepare(`SELECT id FROM stations WHERE deleted_at IS NULL`).all();
  const stationId = stationRows[0]?.id ?? 1;

  let migratedCount = 0;
  let coercedCount = 0;

  const migrate = db.transaction(() => {
    console.log("[migrate-library] Step 1: CREATE TABLE station_programming");
    db.prepare(`
      CREATE TABLE station_programming (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid                TEXT NOT NULL,
        song_id             INTEGER NOT NULL REFERENCES songs(id)      ON DELETE RESTRICT,
        station_id          INTEGER NOT NULL REFERENCES stations(id)   ON DELETE CASCADE,
        category_id         INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
        energy              REAL,
        daypart_mask        INTEGER NOT NULL DEFAULT 16777215,
        rotation_status     TEXT NOT NULL DEFAULT 'active'
                              CHECK (rotation_status IN ('active', 'inactive', 'hold')),
        no_repeat_hours     INTEGER,
        last_played_at      INTEGER,
        play_count          INTEGER NOT NULL DEFAULT 0,
        notes               TEXT,
        added_at            TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        deleted_at          TEXT,
        UNIQUE (station_id, song_id, category_id)
      )
    `).run();
    db.prepare(`CREATE UNIQUE INDEX idx_station_programming_uuid ON station_programming(uuid)`).run();
    db.prepare(`CREATE INDEX idx_station_programming_selector ON station_programming (station_id, category_id, rotation_status, last_played_at) WHERE deleted_at IS NULL`).run();
    db.prepare(`CREATE INDEX idx_station_programming_song ON station_programming (song_id) WHERE deleted_at IS NULL`).run();

    console.log("[migrate-library] Step 2: CREATE TABLE mood_tags");
    db.prepare(`
      CREATE TABLE mood_tags (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid         TEXT NOT NULL,
        name         TEXT NOT NULL,
        description  TEXT,
        color        TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        deleted_at   TEXT,
        UNIQUE (name)
      )
    `).run();
    db.prepare(`CREATE UNIQUE INDEX idx_mood_tags_uuid ON mood_tags(uuid)`).run();

    console.log("[migrate-library] Step 3: CREATE TABLE station_programming_moods");
    db.prepare(`
      CREATE TABLE station_programming_moods (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid                    TEXT NOT NULL,
        station_programming_id  INTEGER NOT NULL REFERENCES station_programming(id) ON DELETE CASCADE,
        mood_tag_id             INTEGER NOT NULL REFERENCES mood_tags(id)           ON DELETE RESTRICT,
        created_at              TEXT NOT NULL,
        updated_at              TEXT NOT NULL,
        deleted_at              TEXT,
        UNIQUE (station_programming_id, mood_tag_id)
      )
    `).run();
    db.prepare(`CREATE UNIQUE INDEX idx_station_programming_moods_uuid ON station_programming_moods(uuid)`).run();
    db.prepare(`CREATE INDEX idx_spm_programming ON station_programming_moods (station_programming_id) WHERE deleted_at IS NULL`).run();
    db.prepare(`CREATE INDEX idx_spm_tag ON station_programming_moods (mood_tag_id) WHERE deleted_at IS NULL`).run();

    console.log("[migrate-library] Step 4: ALTER play_log");
    const plCols = db.prepare('PRAGMA table_info(play_log)').all().map(c => c.name);
    if (!plCols.includes('programming_row_id')) {
      db.prepare(`ALTER TABLE play_log ADD COLUMN programming_row_id INTEGER REFERENCES station_programming(id) ON DELETE SET NULL`).run();
    }
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_play_log_programming_row ON play_log (programming_row_id) WHERE programming_row_id IS NOT NULL`).run();

    console.log("[migrate-library] Step 5: ALTER pinned_songs");
    const psCols = db.prepare('PRAGMA table_info(pinned_songs)').all().map(c => c.name);
    if (!psCols.includes('station_id')) {
      db.prepare(`ALTER TABLE pinned_songs ADD COLUMN station_id INTEGER NOT NULL DEFAULT 1 REFERENCES stations(id) ON DELETE CASCADE`).run();
    }
    if (!psCols.includes('uuid'))       db.prepare(`ALTER TABLE pinned_songs ADD COLUMN uuid TEXT`).run();
    if (!psCols.includes('updated_at')) db.prepare(`ALTER TABLE pinned_songs ADD COLUMN updated_at TEXT`).run();
    if (!psCols.includes('deleted_at')) db.prepare(`ALTER TABLE pinned_songs ADD COLUMN deleted_at TEXT`).run();
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pinned_songs_uuid ON pinned_songs(uuid)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_pinned_songs_station ON pinned_songs(station_id) WHERE deleted_at IS NULL`).run();
    const pinnedCount = db.prepare(`SELECT COUNT(*) AS n FROM pinned_songs`).get().n;
    if (pinnedCount > 0) throw new Error(`pinned_songs has ${pinnedCount} rows; UUID backfill not implemented`);

    console.log("[migrate-library] Step 6: migrate songs.category_id -> station_programming");
    const nowIso = new Date().toISOString();
    const songsToMigrate = db.prepare(`
      SELECT id AS song_id, category_id, energy, daypart_mask,
             rotation_status, no_repeat_hours, last_played_at, play_count
      FROM songs WHERE category_id IS NOT NULL AND deleted_at IS NULL
    `).all();
    const insertProgramming = db.prepare(`
      INSERT INTO station_programming (
        uuid, song_id, station_id, category_id,
        energy, daypart_mask, rotation_status, no_repeat_hours,
        last_played_at, play_count,
        added_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const row of songsToMigrate) {
      const rs = row.rotation_status;
      const safeRotationStatus = ROTATION_STATUS_VALUES.includes(rs) ? rs : 'active';
      if (rs && rs !== safeRotationStatus) coercedCount++;
      insertProgramming.run(
        crypto.randomUUID(), row.song_id, stationId, row.category_id,
        row.energy, row.daypart_mask ?? 16777215, safeRotationStatus, row.no_repeat_hours,
        row.last_played_at, row.play_count ?? 0,
        nowIso, nowIso, nowIso
      );
      migratedCount++;
    }
    console.log(`[migrate-library] Step 6: ${migratedCount} programming rows created`);

    console.log("[migrate-library] Step 7: INSERT schema_version = 4");
    db.prepare("INSERT INTO schema_version (version) VALUES (4)").run();
  });

  migrate();
  console.log("[migrate-library] Transaction committed.");
  if (coercedCount > 0) console.log(`[migrate-library] ${coercedCount} rotation_status values coerced to 'active'.`);
}

module.exports = {
  payloadTransformer: function payloadTransformer(payload, fromVersion) {
    if (!payload || typeof payload !== 'object') return payload;

    if (payload.played_at !== undefined && payload.programming_row_id === undefined) {
      return { ...payload, programming_row_id: null };
    }

    if (payload.slot_hour !== undefined && payload.uuid === undefined) {
      return {
        ...payload,
        station_id: payload.station_id ?? 1,
        uuid: crypto.randomUUID(),
        updated_at: payload.updated_at ?? null,
        deleted_at: payload.deleted_at ?? null,
      };
    }

    return payload;
  },
  applyMigration,
};

if (require.main === module) {
  console.log("[migrate-library] starting");
  console.log("[migrate-library] DB path:", dbPath);

  if (!fs.existsSync(dbPath)) abort(null, "DB not found at " + dbPath);

  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');

  console.log("\n[migrate-library] PRE-FLIGHT");

  const svRows = db.prepare("SELECT version FROM schema_version ORDER BY version").all();
  const svVersions = svRows.map(r => r.version);
  console.log("[migrate-library] schema_version contents:", JSON.stringify(svVersions));

  if (svVersions.includes(4)) {
    console.log("[migrate-library] migration 4 already applied. Exiting cleanly.");
    db.close();
    process.exit(0);
  }
  if (svVersions.length !== 3 || svVersions[0] !== 1 || svVersions[1] !== 2 || svVersions[2] !== 3) {
    abort(db, `expected schema_version [1,2,3], got ${JSON.stringify(svVersions)}`);
  }
  console.log("[migrate-library] schema_version pre-check OK");

  for (const t of ["station_programming", "mood_tags", "station_programming_moods"]) {
    if (tableExists(db, t)) abort(db, `table "${t}" already exists`);
  }
  console.log("[migrate-library] no conflicting tables exist");

  const stationRows = db.prepare(`SELECT id FROM stations WHERE deleted_at IS NULL`).all();
  if (stationRows.length !== 1) abort(db, `expected 1 active station, found ${stationRows.length}`);
  const stationId = stationRows[0].id;
  console.log(`[migrate-library] active station: id=${stationId}`);

  const orphans = db.prepare(`
    SELECT s.id FROM songs s
    LEFT JOIN categories c ON c.id = s.category_id
    WHERE s.category_id IS NOT NULL AND s.deleted_at IS NULL AND c.id IS NULL
  `).all();
  if (orphans.length > 0) abort(db, `${orphans.length} songs have invalid category_id`);
  console.log("[migrate-library] no orphan category_id values");

  console.log("\n[migrate-library] RUNNING MIGRATION");

  const expectedMigratedCount = db.prepare(`SELECT COUNT(*) AS n FROM songs WHERE category_id IS NOT NULL AND deleted_at IS NULL`).get().n;

  try {
    applyMigration(db);
  } catch (err) {
    console.error("[migrate-library] ERROR rolled back:", err.message);
    db.close();
    process.exit(1);
  }

  console.log("\n[migrate-library] VERIFICATION");
  let allOk = true;
  function vpass(m) { console.log(`  OK ${m}`); }
  function vfail(m) { console.error(`  FAIL ${m}`); allOk = false; }

  const svPost = db.prepare("SELECT version FROM schema_version ORDER BY version").all().map(r => r.version);
  if (JSON.stringify(svPost) === JSON.stringify([1,2,3,4])) vpass("schema_version = [1,2,3,4]");
  else vfail(`schema_version = ${JSON.stringify(svPost)}`);

  for (const t of ["station_programming", "mood_tags", "station_programming_moods"]) {
    if (tableExists(db, t)) vpass(`${t} exists`); else vfail(`${t} missing`);
  }
  if (columnExists(db, "play_log", "programming_row_id")) vpass("play_log.programming_row_id"); else vfail("play_log.programming_row_id");
  for (const c of ["station_id", "uuid", "updated_at", "deleted_at"]) {
    if (columnExists(db, "pinned_songs", c)) vpass(`pinned_songs.${c}`); else vfail(`pinned_songs.${c}`);
  }
  const spCount = db.prepare(`SELECT COUNT(*) AS n FROM station_programming`).get().n;
  if (spCount === expectedMigratedCount) vpass(`station_programming has ${spCount} rows`); else vfail(`row count mismatch: expected ${expectedMigratedCount}, got ${spCount}`);

  if (!allOk) {
    db.close();
    process.exit(1);
  }

  console.log(`\n[migrate-library] Migration 4 complete.`);
  db.close();
  process.exit(0);
}
