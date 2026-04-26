// Phase 4 migration: library architecture (Direction C).
// Save to: C:\openair\scripts\migrate-phase-4-library.js
// Run from C:\openair with:  npx electron scripts\migrate-phase-4-library.js
//
// IMPORTANT: Close Ether (the Electron app) before running, to avoid SQLITE_BUSY
// from WAL contention. The migration runs in a transaction; any error rolls back.
//
// What this does:
//   1. Creates station_programming, mood_tags, station_programming_moods tables
//   2. Adds programming_row_id column to play_log
//   3. Adds station_id, uuid, updated_at, deleted_at columns to pinned_songs
//   4. Migrates 355 songs.category_id values into station_programming rows,
//      reading actual energy/daypart_mask/rotation_status/etc values from songs
//   5. Writes schema_version=4 to system_state
//
// Prerequisites verified by the preflight script:
//   - 1 active station
//   - All category_id values resolve to a categories row
//   - All rotation_status values are valid ('active', 'inactive', or 'hold')
//   - pinned_songs is empty (0 rows, no UUID backfill needed)
//
// Architecture lock: docs/phase-4-library-architecture.md (Apr 26, 2026)
// Schema lock: docs/phase-4-schema-implementation-v2.md

const Database = require('better-sqlite3');
const crypto = require('crypto');

const dbPath = 'C:\\Users\\jensj\\AppData\\Roaming\\com.ether.radio\\openair.db';

const log = {
  info: (msg) => console.log(`[migrate-phase-4] ${msg}`),
  warn: (msg) => console.log(`[migrate-phase-4] WARN: ${msg}`),
  error: (msg) => console.error(`[migrate-phase-4] ERROR: ${msg}`),
};

const db = new Database(dbPath);

// Foreign key enforcement — make sure FK violations error out instead of silently passing
db.pragma('foreign_keys = ON');

const CREATE_STATION_PROGRAMMING_SQL = `
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
`;

const CREATE_MOOD_TAGS_SQL = `
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
`;

const CREATE_STATION_PROGRAMMING_MOODS_SQL = `
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
`;

function preflightCheck() {
  // Re-verify the assumptions even though preflight already ran.
  // Belt and suspenders.
  const v = db.prepare(`SELECT value FROM system_state WHERE key='schema_version'`).get();
  if (v && v.value === '4') {
    throw new Error(`schema_version is already 4; migration already ran. Aborting.`);
  }

  const stationRows = db.prepare(
    `SELECT COUNT(*) AS n FROM stations WHERE deleted_at IS NULL`
  ).get();
  if (stationRows.n !== 1) {
    throw new Error(
      `Expected exactly 1 active station, found ${stationRows.n}. ` +
      `Multi-station starting state requires manual review.`
    );
  }

  // Check station_programming doesn't already exist (e.g., partial prior run)
  const existing = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='station_programming'`
  ).get();
  if (existing) {
    throw new Error(
      `station_programming table already exists. Did a prior migration run partially? ` +
      `Restore from backup before retrying: openair.db.pre-phase-4.*.bak`
    );
  }

  log.info('preflight checks passed');
}

function up() {
  log.info('starting migration → schema_version=4');

  preflightCheck();

  db.exec('BEGIN');
  try {
    // ── 1. Create new tables ──
    log.info('creating station_programming');
    db.exec(CREATE_STATION_PROGRAMMING_SQL);
    db.exec(`CREATE UNIQUE INDEX idx_station_programming_uuid ON station_programming(uuid)`);
    db.exec(`
      CREATE INDEX idx_station_programming_selector
        ON station_programming (station_id, category_id, rotation_status, last_played_at)
        WHERE deleted_at IS NULL
    `);
    db.exec(`
      CREATE INDEX idx_station_programming_song
        ON station_programming (song_id)
        WHERE deleted_at IS NULL
    `);

    log.info('creating mood_tags');
    db.exec(CREATE_MOOD_TAGS_SQL);
    db.exec(`CREATE UNIQUE INDEX idx_mood_tags_uuid ON mood_tags(uuid)`);

    log.info('creating station_programming_moods');
    db.exec(CREATE_STATION_PROGRAMMING_MOODS_SQL);
    db.exec(`CREATE UNIQUE INDEX idx_station_programming_moods_uuid ON station_programming_moods(uuid)`);
    db.exec(`
      CREATE INDEX idx_spm_programming
        ON station_programming_moods (station_programming_id)
        WHERE deleted_at IS NULL
    `);
    db.exec(`
      CREATE INDEX idx_spm_tag
        ON station_programming_moods (mood_tag_id)
        WHERE deleted_at IS NULL
    `);

    // ── 2. Add programming_row_id to play_log ──
    log.info('adding play_log.programming_row_id');
    db.exec(`
      ALTER TABLE play_log
        ADD COLUMN programming_row_id INTEGER
        REFERENCES station_programming(id) ON DELETE SET NULL
    `);
    db.exec(`
      CREATE INDEX idx_play_log_programming_row
        ON play_log (programming_row_id)
        WHERE programming_row_id IS NOT NULL
    `);

    // ── 3. Bring pinned_songs into sync compliance ──
    log.info('adding sync columns to pinned_songs');
    db.exec(`
      ALTER TABLE pinned_songs ADD COLUMN station_id INTEGER NOT NULL DEFAULT 1
        REFERENCES stations(id) ON DELETE CASCADE
    `);
    db.exec(`ALTER TABLE pinned_songs ADD COLUMN uuid TEXT`);
    db.exec(`ALTER TABLE pinned_songs ADD COLUMN updated_at TEXT`);
    db.exec(`ALTER TABLE pinned_songs ADD COLUMN deleted_at TEXT`);
    db.exec(`CREATE UNIQUE INDEX idx_pinned_songs_uuid ON pinned_songs(uuid)`);
    db.exec(`
      CREATE INDEX idx_pinned_songs_station
        ON pinned_songs(station_id)
        WHERE deleted_at IS NULL
    `);
    // pinned_songs is empty (preflight verified). No backfill.

    // ── 4. Migrate songs.category_id → station_programming rows ──
    const stationRow = db.prepare(
      `SELECT id FROM stations WHERE deleted_at IS NULL LIMIT 1`
    ).get();
    const stationId = stationRow.id;
    const nowIso = new Date().toISOString();

    const songsToMigrate = db.prepare(`
      SELECT id AS song_id, category_id, energy, daypart_mask,
             rotation_status, no_repeat_hours, last_played_at, play_count
      FROM songs
      WHERE category_id IS NOT NULL
        AND deleted_at IS NULL
    `).all();

    log.info(`migrating ${songsToMigrate.length} songs to station_programming`);

    const insertProgramming = db.prepare(`
      INSERT INTO station_programming (
        uuid, song_id, station_id, category_id,
        energy, daypart_mask, rotation_status, no_repeat_hours,
        last_played_at, play_count,
        added_at, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?
      )
    `);

    let migratedCount = 0;
    for (const row of songsToMigrate) {
      const rs = row.rotation_status;
      const safeRotationStatus =
        ['active', 'inactive', 'hold'].includes(rs) ? rs : 'active';
      if (rs && rs !== safeRotationStatus) {
        log.warn(
          `song_id=${row.song_id} had rotation_status='${rs}'; coerced to 'active'`
        );
      }

      insertProgramming.run(
        crypto.randomUUID(),
        row.song_id,
        stationId,
        row.category_id,
        row.energy,
        row.daypart_mask ?? 16777215,
        safeRotationStatus,
        row.no_repeat_hours,
        row.last_played_at,
        row.play_count ?? 0,
        nowIso,
        nowIso,
        nowIso
      );
      migratedCount++;
    }

    log.info(`migrated ${migratedCount} programming rows`);

    // ── 5. Write schema_version row ──
    log.info('writing schema_version=4 to system_state');
    db.prepare(`
      INSERT OR REPLACE INTO system_state (key, value, updated_at)
      VALUES ('schema_version', ?, ?)
    `).run('4', nowIso);

    db.exec('COMMIT');
    log.info('COMMIT successful — migration complete');
  } catch (err) {
    db.exec('ROLLBACK');
    log.error(`rolled back: ${err.message}`);
    throw err;
  }
}

// ── Verification (read-only, post-commit) ──
function verify() {
  console.log('\n=== POST-MIGRATION VERIFICATION ===');

  const sv = db.prepare(`SELECT value FROM system_state WHERE key='schema_version'`).get();
  console.log(`  schema_version: ${sv ? sv.value : '(NOT SET — migration failed)'}`);

  const spCount = db.prepare(`SELECT COUNT(*) AS n FROM station_programming`).get().n;
  console.log(`  station_programming rows: ${spCount}`);

  const mtExists = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='mood_tags'`
  ).get();
  console.log(`  mood_tags table exists: ${mtExists ? 'yes' : 'NO'}`);

  const spmExists = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='station_programming_moods'`
  ).get();
  console.log(`  station_programming_moods table exists: ${spmExists ? 'yes' : 'NO'}`);

  const playLogCols = db.prepare(`PRAGMA table_info(play_log)`).all();
  const hasProgRowId = playLogCols.some(c => c.name === 'programming_row_id');
  console.log(`  play_log.programming_row_id column exists: ${hasProgRowId ? 'yes' : 'NO'}`);

  const pinnedCols = db.prepare(`PRAGMA table_info(pinned_songs)`).all();
  const hasStationId = pinnedCols.some(c => c.name === 'station_id');
  const hasUuid = pinnedCols.some(c => c.name === 'uuid');
  const hasUpdatedAt = pinnedCols.some(c => c.name === 'updated_at');
  const hasDeletedAt = pinnedCols.some(c => c.name === 'deleted_at');
  console.log(`  pinned_songs sync columns: station_id=${hasStationId} uuid=${hasUuid} updated_at=${hasUpdatedAt} deleted_at=${hasDeletedAt}`);

  // Spot-check: pick a few migrated rows and verify they preserved category_id, rotation_status correctly
  const samples = db.prepare(`
    SELECT sp.song_id, sp.category_id, sp.rotation_status, sp.daypart_mask,
           s.title, s.category_id AS source_category_id, s.rotation_status AS source_rotation
    FROM station_programming sp
    JOIN songs s ON s.id = sp.song_id
    LIMIT 3
  `).all();
  console.log(`\n  sample migrated rows:`);
  samples.forEach(r => {
    const ok = r.category_id === r.source_category_id;
    console.log(`    song "${r.title}": category_id=${r.category_id} (source ${r.source_category_id}) ${ok ? 'OK' : 'MISMATCH'}, rotation_status=${r.rotation_status}`);
  });
}

try {
  up();
  verify();
  console.log('\nMigration complete. Next steps:');
  console.log('  1. Update electron/sync/synced-tables.js per docs/phase-4-schema-implementation-v2.md section 4');
  console.log('  2. Update electron/sync/verify-synced-tables.js to check the scope field');
  console.log('  3. Commit the schema migration as a checkpoint');
  console.log('  4. Resume Phase 3.5 with the corrected scope-aware registry');
} catch (err) {
  console.error(`\nMIGRATION FAILED: ${err.message}`);
  console.error('DB has been rolled back. Restore from backup if needed:');
  console.error('  openair.db.pre-phase-4.*.bak');
  process.exit(1);
} finally {
  db.close();
}
