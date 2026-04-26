# Phase 4 — Schema Implementation v2 (Locked, Corrected Against Real Schema)

**Status:** Architecture locked April 26, 2026. SQL corrected against live `openair.db` schema dump.
**Predecessor:** v1 (`phase-4-schema-implementation.md`) — superseded; contained data-loss bug, wrong PK types, wrong column types, wrong pinned_songs handling.
**Schema source:** Live dump from `C:\Users\jensj\AppData\Roaming\com.ether.radio\openair.db` on April 26, 2026.

---

## Reality check — what the live DB actually looks like

| Aspect | Reality | v1 assumption | Action |
|---|---|---|---|
| PK type | `id INTEGER AUTOINCREMENT` + separate `uuid TEXT` UNIQUE | `id TEXT (UUID)` | Match existing pattern |
| FK references | INTEGER, points at local `id` | TEXT pointing at uuid | Use INTEGER FKs |
| `last_played_at` type | `INTEGER` (unix epoch) | `TEXT` (ISO 8601) | Match — INTEGER |
| `play_count` column name | `play_count` | `play_count` | Match (no rename, ignore "spins_total" memory ghost) |
| `daypart_mask` actual values | `16777215` everywhere (24-bit all-on) | `16777215` | Match |
| Songs with category_id | 355 / 357 | unknown | Migrate 355 |
| Songs with mood populated | 0 | unknown | Greenfield — nothing to migrate |
| Songs with energy populated | 0 | unknown | Greenfield default NULL |
| Songs with last_played_at populated | 0 | unknown | Greenfield default NULL |
| `pinned_songs` row count | 0 | unknown | Empty — sync columns can be added trivially |
| `pinned_songs` schema | Rich: slot_hour, recur_dow, force_play, reason, etc. | Simple `pinned_at` | DO NOT absorb — keep as separate table |
| `pinned_songs` sync columns | None | Some assumed | Add station_id, uuid, created_at, updated_at, deleted_at as part of Phase 4 |
| `play_log.song_id` | Does NOT exist; uses denormalized title/artist text | Assumed exists | Add `programming_row_id` only; don't try to add song_id |
| `system_state` schema | `(key, value, updated_at)` simple K/V | Multi-column rich | Match — use INSERT OR REPLACE for schema_version |
| `schema_version` stored | NOT stored anywhere | Assumed at value 3 | Phase 4 establishes the row; subsequent migrations require it |
| `mutations` table | Exists, 0 rows | Exists with v3 data | OK — empty means no mutation log entries yet, expected pre-Session-B |
| `songs.station_id` | Exists, all = 1 (DEFAULT 1) | Not considered | Flag for cleanup — install-scoped tables should NOT have station_id |
| Stations | 1 active | Assumed 1 | Migration safe |

**Deferred to v5 cleanup migration (NOT Phase 4):**
- Drop `songs.category_id`, `songs.energy`, `songs.mood`, `songs.rotation_status`, `songs.daypart_mask`, `songs.no_repeat_hours`, `songs.last_played_at`, `songs.play_count`. These columns continue to exist through v4 for rollback safety; they become unused.
- Drop `songs.station_id`, `artists.station_id`, `albums.station_id`. Install-scoped tables shouldn't have station_id. Touched only after `executeScopedInsert` is split.

---

## 1. CREATE TABLE statements

### 1a. `station_programming`

```sql
CREATE TABLE station_programming (
  -- Identity (matches existing pattern: integer PK, separate UUID for sync)
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid                TEXT NOT NULL,
  
  -- Foreign keys (the unique triple)
  song_id             INTEGER NOT NULL REFERENCES songs(id)      ON DELETE RESTRICT,
  station_id          INTEGER NOT NULL REFERENCES stations(id)   ON DELETE CASCADE,
  category_id         INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  
  -- Programming judgments (copied from songs at migration time)
  energy              REAL,                                -- 0.0 to 1.0; NULL = unset
  daypart_mask        INTEGER NOT NULL DEFAULT 16777215,   -- 24-bit hour bitmask, all hours allowed
  rotation_status     TEXT NOT NULL DEFAULT 'active'
                        CHECK (rotation_status IN ('active', 'inactive', 'hold')),
  no_repeat_hours     INTEGER,                             -- NULL = inherit from category default
  
  -- Programming history
  last_played_at      INTEGER,                             -- unix epoch seconds; NULL = never played on this station
  play_count          INTEGER NOT NULL DEFAULT 0,
  
  -- Editorial
  notes               TEXT,
  added_at            TEXT NOT NULL,                       -- ISO 8601 UTC; when programmer added song to station
  
  -- Sync columns (Principles 1 & 2)
  created_at          TEXT NOT NULL,                       -- ISO 8601 UTC
  updated_at          TEXT NOT NULL,                       -- ISO 8601 UTC
  deleted_at          TEXT,                                -- ISO 8601 UTC; soft delete
  
  UNIQUE (station_id, song_id, category_id)
);

CREATE UNIQUE INDEX idx_station_programming_uuid
  ON station_programming(uuid);

-- Hot path: rotation engine selector
CREATE INDEX idx_station_programming_selector
  ON station_programming (station_id, category_id, rotation_status, last_played_at)
  WHERE deleted_at IS NULL;

-- Reverse lookup: "where is this song programmed across the cluster"
CREATE INDEX idx_station_programming_song
  ON station_programming (song_id)
  WHERE deleted_at IS NULL;
```

**Notes on changes from v1:**
- INTEGER PK + separate UUID (matches songs/categories/stations/play_log/shows convention)
- INTEGER FKs pointing at local `id` columns
- `last_played_at` is INTEGER unix epoch (matches `songs.last_played_at`)
- `pinned_at` REMOVED — pinning kept on separate `pinned_songs` table (see 1d)
- `intro_skip_override_ms` REMOVED (not in original column list, was speculation)

### 1b. `mood_tags` (install-scoped)

```sql
CREATE TABLE mood_tags (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid         TEXT NOT NULL,
  name         TEXT NOT NULL,                -- canonical mood label
  description  TEXT,                         -- for Iris RAG context
  color        TEXT,                         -- optional hex like '#3a8fd6'
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT,
  
  UNIQUE (name)
);

CREATE UNIQUE INDEX idx_mood_tags_uuid
  ON mood_tags(uuid);
```

### 1c. `station_programming_moods` (station-scoped join)

```sql
CREATE TABLE station_programming_moods (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid                    TEXT NOT NULL,
  station_programming_id  INTEGER NOT NULL REFERENCES station_programming(id) ON DELETE CASCADE,
  mood_tag_id             INTEGER NOT NULL REFERENCES mood_tags(id)           ON DELETE RESTRICT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  deleted_at              TEXT,
  
  UNIQUE (station_programming_id, mood_tag_id)
);

CREATE UNIQUE INDEX idx_station_programming_moods_uuid
  ON station_programming_moods(uuid);

CREATE INDEX idx_spm_programming
  ON station_programming_moods (station_programming_id)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_spm_tag
  ON station_programming_moods (mood_tag_id)
  WHERE deleted_at IS NULL;
```

### 1d. `pinned_songs` — bring into sync compliance

`pinned_songs` is currently 0 rows and lacks station_id/uuid/created_at/updated_at/deleted_at. Phase 4 adds them. The rich scheduling shape (slot_hour, recur_dow, etc.) is preserved.

```sql
ALTER TABLE pinned_songs ADD COLUMN station_id INTEGER NOT NULL DEFAULT 1
  REFERENCES stations(id) ON DELETE CASCADE;

ALTER TABLE pinned_songs ADD COLUMN uuid TEXT;
ALTER TABLE pinned_songs ADD COLUMN updated_at TEXT;
ALTER TABLE pinned_songs ADD COLUMN deleted_at TEXT;

-- Backfill any future rows; current rows are 0 so no backfill needed
-- New rows must populate uuid, created_at, updated_at via withMutation when Session B lands

CREATE UNIQUE INDEX idx_pinned_songs_uuid ON pinned_songs(uuid);
CREATE INDEX idx_pinned_songs_station ON pinned_songs(station_id) WHERE deleted_at IS NULL;
```

**Notes:**
- `pinned_songs.created_at` already exists as `INTEGER DEFAULT (unixepoch())`. Leaving as-is for backward compat. Sync layer treats epoch-int created_at as a known case (already handled by `fix-timestamp-formats.js` precedent).
- `pinned_songs.song_id` (existing INTEGER) continues to FK to `songs(id)`. Pin can reference a song that has no programming row on the station — that's fine; the pin's existence is independent of categorization (the song would be played ad-hoc when its scheduled slot fires).
- `pinned_songs` does NOT FK to `station_programming.id`. Pins are independent of programming context. A pin says "play this song at this slot," not "play this programming-row's song."

### 1e. `play_log.programming_row_id` (Q6)

```sql
ALTER TABLE play_log
  ADD COLUMN programming_row_id INTEGER
  REFERENCES station_programming(id) ON DELETE SET NULL;

CREATE INDEX idx_play_log_programming_row
  ON play_log (programming_row_id)
  WHERE programming_row_id IS NOT NULL;
```

**Semantics:**
- Rotation-engine plays: populate `programming_row_id` with the source row's id
- Ad-hoc plays (tribute scenario): `programming_row_id = NULL`
- Backfilled existing rows (2,853 historical plays): `programming_row_id = NULL` — interpreted retroactively as ad-hoc since we have no way to reconstruct which programming row produced them. Acceptable: rotation history isn't reconstructed, but license reporting still works (uses denormalized title/artist on play_log directly).
- License reporting continues to use the existing denormalized title/artist columns. Phase 4 doesn't change reporting paths.

**`play_log` does NOT get a `song_id` column.** The denormalized text columns are intentional — they survive song deletions, MusicBrainz re-tagging, and other reference-data changes that would otherwise break historical play records. Adding `song_id` is out of scope for Phase 4.

---

## 2. Migration script

`electron/sync/migrations/migrate-phase-4-library.js`:

```javascript
/**
 * Phase 4: Library architecture (Direction C).
 *
 * Operations:
 *   - Create station_programming, mood_tags, station_programming_moods tables
 *   - Add programming_row_id column to play_log
 *   - Add station_id/uuid/updated_at/deleted_at to pinned_songs
 *   - Migrate existing songs.category_id values into station_programming rows,
 *     reading actual programming column values from songs (not hardcoded defaults)
 *   - Establish schema_version=4 in system_state (first time the row is written;
 *     prior versions did not record schema_version)
 *
 * payloadTransformer behavior:
 *   - For tables NOT touched by this migration: identity transform.
 *   - For play_log: v3 payloads lack programming_row_id; transformer adds it as null.
 *   - For pinned_songs: v3 payloads lack station_id/uuid/updated_at/deleted_at;
 *     transformer adds station_id=1 (single-station era), generates uuid,
 *     and adds null updated_at/deleted_at.
 *   - For station_programming, mood_tags, station_programming_moods: tables don't
 *     exist in v3; receiving v3 payloads for them indicates schema corruption.
 *
 * [N-70] compliance: NOT identity. Explicit forward-compat for play_log and pinned_songs.
 * [Q-15] compliance: column-default semantics explicit (NOT NULL gets explicit defaults,
 *   nullable gets NULL).
 *
 * NOT logged to mutations table. Schema migrations are local-per-client out-of-band events,
 * not data mutations. Each peer runs its own migration when its schema_version lags.
 */

const crypto = require('crypto');

const MIGRATION_NAME = 'migrate-phase-4-library';
const FROM_VERSION = 3;   // de jure; de facto schema_version is unset on this DB
const TO_VERSION = 4;

function up(db, { logger }) {
  logger.info(`[${MIGRATION_NAME}] starting → schema_version=${TO_VERSION}`);
  
  db.exec('BEGIN');
  try {
    // ── 1. Create new tables ──
    db.exec(CREATE_STATION_PROGRAMMING_SQL);
    db.exec(CREATE_MOOD_TAGS_SQL);
    db.exec(CREATE_STATION_PROGRAMMING_MOODS_SQL);
    
    // ── 2. Add programming_row_id to play_log ──
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
    db.exec(`ALTER TABLE pinned_songs ADD COLUMN station_id INTEGER NOT NULL DEFAULT 1
             REFERENCES stations(id) ON DELETE CASCADE`);
    db.exec(`ALTER TABLE pinned_songs ADD COLUMN uuid TEXT`);
    db.exec(`ALTER TABLE pinned_songs ADD COLUMN updated_at TEXT`);
    db.exec(`ALTER TABLE pinned_songs ADD COLUMN deleted_at TEXT`);
    db.exec(`CREATE UNIQUE INDEX idx_pinned_songs_uuid ON pinned_songs(uuid)`);
    db.exec(`CREATE INDEX idx_pinned_songs_station ON pinned_songs(station_id) WHERE deleted_at IS NULL`);
    // pinned_songs is empty (0 rows); no UUID backfill needed.
    // If any rows existed, we'd run UPDATE pinned_songs SET uuid = lower(hex(randomblob(16)))
    
    // ── 4. Pre-flight assertion: exactly one active station ──
    const stations = db.prepare(`
      SELECT id FROM stations WHERE deleted_at IS NULL
    `).all();
    
    if (stations.length !== 1) {
      throw new Error(
        `[${MIGRATION_NAME}] expects exactly 1 active station; found ${stations.length}. ` +
        `Multi-station starting state requires manual review (which station owns existing songs.category_id?).`
      );
    }
    const stationId = stations[0].id;
    const nowIso = new Date().toISOString();
    
    // ── 5. Migrate songs.category_id → station_programming rows ──
    //   Reads ACTUAL values from songs columns. No hardcoded defaults.
    //   Defaults apply only to columns that don't exist on songs (added_at, etc.)
    const songsToMigrate = db.prepare(`
      SELECT id AS song_id, category_id, energy, daypart_mask,
             rotation_status, no_repeat_hours, last_played_at, play_count
      FROM songs
      WHERE category_id IS NOT NULL
        AND deleted_at IS NULL
    `).all();
    
    logger.info(`[${MIGRATION_NAME}] migrating ${songsToMigrate.length} songs to station_programming`);
    
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
    let skippedCount = 0;
    
    for (const row of songsToMigrate) {
      // Validate rotation_status against CHECK constraint values.
      // Songs has DEFAULT 'active' but no CHECK, so existing data could have anything.
      const rs = row.rotation_status;
      if (rs && !['active', 'inactive', 'hold'].includes(rs)) {
        logger.warn(
          `[${MIGRATION_NAME}] song_id=${row.song_id} has unrecognized rotation_status=` +
          `'${rs}'; coercing to 'active' (review post-migration if this matters)`
        );
      }
      const safeRotationStatus = ['active', 'inactive', 'hold'].includes(rs) ? rs : 'active';
      
      try {
        insertProgramming.run(
          crypto.randomUUID(),
          row.song_id,
          stationId,
          row.category_id,
          row.energy,                                      // NULL passes through
          row.daypart_mask ?? 16777215,                    // default if NULL
          safeRotationStatus,
          row.no_repeat_hours,                             // NULL passes through (means "use category default")
          row.last_played_at,                              // INTEGER epoch, NULL passes through
          row.play_count ?? 0,
          nowIso,                                          // added_at: now (no historical timestamp available)
          nowIso,
          nowIso
        );
        migratedCount++;
      } catch (err) {
        logger.error(
          `[${MIGRATION_NAME}] failed to migrate song_id=${row.song_id}: ${err.message}`
        );
        skippedCount++;
        if (err.message.includes('FOREIGN KEY')) {
          // Likely orphan category_id. Pre-flight should have caught this.
          throw new Error(
            `Aborting migration: song_id=${row.song_id} references invalid category_id=${row.category_id}. ` +
            `Run scripts/phase-4-preflight.js and fix orphans before re-running.`
          );
        }
      }
    }
    
    logger.info(`[${MIGRATION_NAME}] migrated ${migratedCount}, skipped ${skippedCount}`);
    
    // ── 6. Establish schema_version row (first time it's written) ──
    db.prepare(`
      INSERT OR REPLACE INTO system_state (key, value, updated_at)
      VALUES ('schema_version', ?, ?)
    `).run(String(TO_VERSION), nowIso);
    
    db.exec('COMMIT');
    logger.info(`[${MIGRATION_NAME}] complete; schema_version=${TO_VERSION}`);
  } catch (err) {
    db.exec('ROLLBACK');
    logger.error(`[${MIGRATION_NAME}] failed, rolled back: ${err.message}`);
    throw err;
  }
}

function payloadTransformer(table, v3Payload) {
  switch (table) {
    case 'play_log':
      return {
        ...v3Payload,
        programming_row_id: v3Payload.programming_row_id ?? null,
      };
    
    case 'pinned_songs':
      return {
        ...v3Payload,
        station_id: v3Payload.station_id ?? 1,
        uuid: v3Payload.uuid ?? crypto.randomUUID(),
        updated_at: v3Payload.updated_at ?? null,
        deleted_at: v3Payload.deleted_at ?? null,
      };
    
    case 'songs':
      // Programming columns (energy, daypart_mask, rotation_status, no_repeat_hours,
      // last_played_at, play_count, mood, category_id) remain readable on songs through v4.
      // New v4 writes shouldn't populate them; v3 writes still might — pass through.
      return v3Payload;
    
    case 'station_programming':
    case 'mood_tags':
    case 'station_programming_moods':
      throw new Error(
        `[${MIGRATION_NAME}] received pre-v4 payload for v4-only table '${table}'; ` +
        `this should be impossible — table did not exist before v4`
      );
    
    default:
      return v3Payload;
  }
}

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
  );
  CREATE UNIQUE INDEX idx_station_programming_uuid ON station_programming(uuid);
  CREATE INDEX idx_station_programming_selector
    ON station_programming (station_id, category_id, rotation_status, last_played_at)
    WHERE deleted_at IS NULL;
  CREATE INDEX idx_station_programming_song
    ON station_programming (song_id)
    WHERE deleted_at IS NULL;
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
  );
  CREATE UNIQUE INDEX idx_mood_tags_uuid ON mood_tags(uuid);
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
  );
  CREATE UNIQUE INDEX idx_station_programming_moods_uuid ON station_programming_moods(uuid);
  CREATE INDEX idx_spm_programming
    ON station_programming_moods (station_programming_id)
    WHERE deleted_at IS NULL;
  CREATE INDEX idx_spm_tag
    ON station_programming_moods (mood_tag_id)
    WHERE deleted_at IS NULL;
`;

module.exports = {
  name: MIGRATION_NAME,
  fromVersion: FROM_VERSION,
  toVersion: TO_VERSION,
  up,
  payloadTransformer,
};
```

---

## 3. Pre-flight script (corrected)

`scripts/phase-4-preflight.js`:

```javascript
#!/usr/bin/env node
/**
 * Phase 4 pre-flight report. Read-only.
 * Run via: npx electron scripts/phase-4-preflight.js
 */

const Database = require('better-sqlite3');

const dbPath = 'C:\\Users\\jensj\\AppData\\Roaming\\com.ether.radio\\openair.db';
const db = new Database(dbPath, { readonly: true });

function section(label, fn) {
  console.log(`\n=== ${label} ===`);
  try { fn(); } catch (e) { console.log(`  ERROR: ${e.message}`); }
}

section('current schema_version', () => {
  const v = db.prepare(`SELECT value FROM system_state WHERE key='schema_version'`).get();
  console.log(`  ${v ? v.value : '(not set — first migration to write this row)'}`);
});

section('stations', () => {
  const total = db.prepare(`SELECT COUNT(*) AS n FROM stations`).get().n;
  const active = db.prepare(`SELECT COUNT(*) AS n FROM stations WHERE deleted_at IS NULL`).get().n;
  console.log(`  total=${total}  active=${active}  (migration requires exactly 1)`);
  if (active !== 1) console.log(`  ❌ WILL ABORT: migration expects 1 active station`);
});

section('songs.category_id orphans', () => {
  const orphans = db.prepare(`
    SELECT s.id, s.title, s.category_id
    FROM songs s
    LEFT JOIN categories c ON c.id = s.category_id
    WHERE s.category_id IS NOT NULL
      AND s.deleted_at IS NULL
      AND c.id IS NULL
  `).all();
  
  if (orphans.length === 0) {
    console.log(`  ✓ all category_id values resolve to a categories row`);
  } else {
    console.log(`  ❌ ${orphans.length} songs reference invalid category_id values:`);
    orphans.slice(0, 10).forEach(o =>
      console.log(`     song ${o.id} "${o.title}" → category_id=${o.category_id}`)
    );
    if (orphans.length > 10) console.log(`     ... and ${orphans.length - 10} more`);
    console.log(`  These will FAIL the FK constraint. Fix before migrating.`);
  }
});

section('rotation_status values', () => {
  const stats = db.prepare(`
    SELECT rotation_status, COUNT(*) AS n
    FROM songs
    WHERE category_id IS NOT NULL AND deleted_at IS NULL
    GROUP BY rotation_status
    ORDER BY n DESC
  `).all();
  
  const allowed = new Set(['active', 'inactive', 'hold']);
  let anyUnknown = false;
  stats.forEach(s => {
    const ok = allowed.has(s.rotation_status);
    console.log(`  ${ok ? '✓' : '⚠️ '} ${s.rotation_status === null ? 'NULL' : s.rotation_status}: ${s.n}`);
    if (!ok && s.rotation_status !== null) anyUnknown = true;
  });
  if (anyUnknown) {
    console.log(`  Unknown values will be coerced to 'active' with a warning. Review if material.`);
  }
});

section('songs.category_id distribution', () => {
  const total = db.prepare(`SELECT COUNT(*) AS n FROM songs WHERE deleted_at IS NULL`).get().n;
  const withCat = db.prepare(`SELECT COUNT(*) AS n FROM songs WHERE category_id IS NOT NULL AND deleted_at IS NULL`).get().n;
  const withoutCat = db.prepare(`SELECT COUNT(*) AS n FROM songs WHERE category_id IS NULL AND deleted_at IS NULL`).get().n;
  console.log(`  total active: ${total}`);
  console.log(`  → station_programming rows to create: ${withCat}`);
  console.log(`  → not migrated (category_id IS NULL): ${withoutCat}`);
  if (withoutCat > 0) {
    const samples = db.prepare(`SELECT id, title FROM songs WHERE category_id IS NULL AND deleted_at IS NULL LIMIT 5`).all();
    samples.forEach(s => console.log(`     song ${s.id} "${s.title}"`));
    console.log(`  Confirm these are intentionally uncategorized.`);
  }
});

section('pinned_songs status', () => {
  const n = db.prepare(`SELECT COUNT(*) AS n FROM pinned_songs`).get().n;
  console.log(`  rows: ${n}`);
  console.log(`  Migration adds station_id, uuid, updated_at, deleted_at columns.`);
  if (n > 0) {
    console.log(`  ⚠️  ${n} existing rows will need uuid backfill (currently the migration assumes 0 rows).`);
    console.log(`     Update migration with backfill loop before running.`);
  }
});

section('play_log status', () => {
  const n = db.prepare(`SELECT COUNT(*) AS n FROM play_log`).get().n;
  console.log(`  rows: ${n}  (all will get programming_row_id=NULL on column add)`);
});

section('mutations table', () => {
  const n = db.prepare(`SELECT COUNT(*) AS n FROM mutations`).get().n;
  console.log(`  rows: ${n}  (Phase 4 migration does NOT write to this table)`);
});

section('SUMMARY', () => {
  const willMigrate = db.prepare(`SELECT COUNT(*) AS n FROM songs WHERE category_id IS NOT NULL AND deleted_at IS NULL`).get().n;
  console.log(`  will create ${willMigrate} station_programming rows`);
  console.log(`  will create empty mood_tags table`);
  console.log(`  will create empty station_programming_moods table`);
  console.log(`  will add programming_row_id column to play_log`);
  console.log(`  will add station_id/uuid/updated_at/deleted_at columns to pinned_songs`);
  console.log(`  will write schema_version=4 to system_state (first time)`);
});

db.close();
console.log('\nIf no ❌ markers above, the migration is safe to run.');
```

---

## 4. Synced-tables registry diff

Conceptual shape — actual existing entries to be merged from current `electron/sync/synced-tables.js`:

```javascript
const SYNCED_TABLES = {
  // ─── INSTALL-SCOPED (shared across stations) ───
  songs:    { scope: 'install', /* existing config */ },
  artists:  { scope: 'install', /* existing config */ },
  albums:   { scope: 'install', /* existing config */ },
  
  mood_tags: {
    scope: 'install',
    columns: {
      id:           { type: 'scalar', sensitive: false },
      uuid:         { type: 'scalar', sensitive: false },
      name:         { type: 'scalar', sensitive: false },
      description:  { type: 'scalar', sensitive: false },
      color:        { type: 'scalar', sensitive: false },
      created_at:   { type: 'scalar', sensitive: false },
      updated_at:   { type: 'scalar', sensitive: false },
      deleted_at:   { type: 'scalar', sensitive: false },
    },
  },
  
  // ─── STATION-SCOPED ───
  station_programming: {
    scope: 'station',
    columns: {
      id:                 { type: 'scalar', sensitive: false },
      uuid:               { type: 'scalar', sensitive: false },
      song_id:            { type: 'scalar', sensitive: false },
      station_id:         { type: 'scalar', sensitive: false },
      category_id:        { type: 'scalar', sensitive: false },
      energy:             { type: 'scalar', sensitive: false },
      daypart_mask:       { type: 'scalar', sensitive: false },
      rotation_status:    { type: 'scalar', sensitive: false },
      no_repeat_hours:    { type: 'scalar', sensitive: false },
      last_played_at:     { type: 'scalar', sensitive: false },
      play_count:         { type: 'scalar', sensitive: false },
      notes:              { type: 'scalar', sensitive: false },
      added_at:           { type: 'scalar', sensitive: false },
      created_at:         { type: 'scalar', sensitive: false },
      updated_at:         { type: 'scalar', sensitive: false },
      deleted_at:         { type: 'scalar', sensitive: false },
    },
  },
  
  station_programming_moods: {
    scope: 'station',
    columns: {
      id:                     { type: 'scalar', sensitive: false },
      uuid:                   { type: 'scalar', sensitive: false },
      station_programming_id: { type: 'scalar', sensitive: false },
      mood_tag_id:            { type: 'scalar', sensitive: false },
      created_at:             { type: 'scalar', sensitive: false },
      updated_at:             { type: 'scalar', sensitive: false },
      deleted_at:             { type: 'scalar', sensitive: false },
    },
  },
  
  pinned_songs: {
    scope: 'station',
    columns: {
      id:           { type: 'scalar', sensitive: false },
      uuid:         { type: 'scalar', sensitive: false },
      station_id:   { type: 'scalar', sensitive: false },
      song_id:      { type: 'scalar', sensitive: false },
      slot_hour:    { type: 'scalar', sensitive: false },
      slot_position:{ type: 'scalar', sensitive: false },
      recur_dow:    { type: 'scalar', sensitive: false },
      play_at_unix: { type: 'scalar', sensitive: false },
      start_unix:   { type: 'scalar', sensitive: false },
      end_unix:     { type: 'scalar', sensitive: false },
      force_play:   { type: 'scalar', sensitive: false },
      pinned_by:    { type: 'scalar', sensitive: false },
      reason:       { type: 'scalar', sensitive: false },
      consumed_at:  { type: 'scalar', sensitive: false },
      created_at:   { type: 'scalar', sensitive: false },
      updated_at:   { type: 'scalar', sensitive: false },
      deleted_at:   { type: 'scalar', sensitive: false },
    },
  },
  
  shows: { scope: 'station', /* existing config — table already has uuid/created_at/updated_at/deleted_at per dump */ },
  
  // ... rest of existing station-scoped entries (categories, format_clocks, clock_slots,
  //     separation_rules, smart_schedule_rules, generated_schedule, scheduled_log,
  //     play_log, voice_tracks, etc.)
  // Plus the missed tables flagged by the Phase 3.5 audit (studio_sessions, studio_notes,
  //     session_versions, ai_voice_segments, ai_voice_templates, mobile_voice_tracks,
  //     stream_metadata_targets, eas_tests, scheduler_reasons, stream_settings) —
  //     those get added when Phase 3.5 resumes.
};
```

---

## 5. Open items / deferred (NOT resolved here)

1. **[N-70] identity payloadTransformer in `migrate-timestamps-phase-sync-2.js`** — still needs a real transformer for v1→v2. Phase 4's transformer correctly handles v3→v4. Fix v2 transformer during Phase 3.5 resumption.

2. **[Q-15] documentation in `docs/sync-protocol-v0.md`** — column-default semantics need formal doc. Phase 4 transformer demonstrates the pattern.

3. **UUID INSERT gap (memory line 14)** — every IPC INSERT path needs `crypto.randomUUID()`. Phase 4's new tables are vulnerable to the same gap. Phase 3.5's typed handlers solve this by architecture.

4. **executeScopedInsert wrapper question** — wrapper currently injects station_id into songs/artists/albums INSERTs, which is wrong under Direction C (those are install-scoped). Phase 4 leaves the wrapper alone; renderer-driven INSERTs still inject station_id=1, and those inserts are silently broken for cluster. Fix during Phase 3.5 resumption — either split into executeInstallInsert/executeStationInsert OR replace with typed handlers (recommend typed handlers).

5. **`multistation_insert_audit_complete` gate at `electron/main.js:3447`** — semantics change because half the audited callsites should NOT inject station_id.

6. **`songs.station_id` column is meaningless under Direction C.** All 357 existing songs have station_id=1 because the wrapper injects it. The column should be DROPPED in v5 cleanup. Same for artists.station_id and albums.station_id (need to verify via dump).

7. **Old `pinned_songs.created_at` is INTEGER unix epoch.** Inconsistent with sync Principle 2's ISO 8601 normalization. Either `fix-timestamp-formats.js` precedent applies (convert), or leave as-is and document the exception. Phase 4 leaves as-is to minimize migration scope; Phase 3.5 resolves.

8. **SmartRules in localStorage (`ether_smart_rules`)** — not in DB, so not synced. Per-device, not per-station. Decision needed before second-client deployment: (a) accept device-local UI config and document, or (b) plan migration to a station-scoped DB table. Defer to Phase 3.5 or a dedicated session.

9. **users/operators table consolidation** — `station_programming.added_by` field deferred until users table resolved. Add in follow-up migration.

10. **shows table is in registry but uses INTEGER created_at?** — schema dump shows `shows.created_at TEXT`. Need to verify it's already populated as ISO 8601 (probably yes since added in sync 2/7).

---

## 6. Commit sequencing

1. `feat(sync): phase 4 schema — station_programming, mood_tags, station_programming_moods, pinned_songs sync columns, play_log.programming_row_id`
2. `feat(sync): synced-tables registry scope column + phase 4 entries`
3. `feat(sync): verify-synced-tables checks scope`
4. `chore(scripts): phase 4 preflight script`

The pre-commit hook (`verify-transformer-chain.js`) should pass on all four since the new transformer is non-identity.

---

## 7. Eyes-on review checklist before running

- [ ] `categories.id` is INTEGER PK — confirmed by dump ✓
- [ ] `stations.id` is INTEGER PK — confirmed by dump ✓
- [ ] `songs.id` is INTEGER PK — confirmed by dump ✓
- [ ] `songs` programming columns (energy, daypart_mask, rotation_status, no_repeat_hours, last_played_at, play_count) all exist with names matching migration SELECT — confirmed by dump ✓
- [ ] `pinned_songs` is empty — confirmed by dump ✓ (so no UUID backfill loop needed; migration aborts if non-zero by your re-check)
- [ ] `system_state` schema is `(key, value, updated_at)` — confirmed by dump ✓
- [ ] No songs have unrecognized `rotation_status` values — preflight will report, migration coerces with warning
- [ ] No orphan `category_id` values — preflight will report
- [ ] `mutations` table is intentionally untouched by this migration — by design (schema migrations are out-of-band)
- [ ] Read-only first: run `scripts/phase-4-preflight.js` BEFORE the migration. Review for ❌ markers. Only proceed if clean.

---

## 8. Sequencing recap

1. Save preflight script. Run it. Review output.
2. If clean: write the migration file at `electron/sync/migrations/migrate-phase-4-library.js`.
3. Test against a backup DB first. (You have plenty of backups in `C:\Users\jensj\AppData\Roaming\Electron\backups\`.)
4. If backup test passes: run against live DB.
5. Verify: re-run preflight; should now show schema_version=4, station_programming row count = previous song-with-category count, pinned_songs has new columns.
6. Commit chain (4 commits per section 6).
7. Phase 3.5 resumption inherits the corrected registry.

Architecture locked. SQL details should now match real reality. Push back on anything that smells wrong; the dump caught the major bugs but more might be hiding.
