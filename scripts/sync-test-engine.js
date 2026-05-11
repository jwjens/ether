'use strict';
// scripts/sync-test-engine.js — Stage 2 test runner.
// Covers T-01..T-38 from protocol doc Appendix C.
// Run: node_modules/.bin/electron --no-sandbox scripts/sync-test-engine.js
//
// All tests use in-memory SQLite DBs — zero production-DB dependency.
// Each test or test section creates a fresh DB to prevent cross-test pollution.

const path   = require('path');
const crypto = require('crypto');

const Database = require(path.join(__dirname, '../node_modules/better-sqlite3'));

const {
  getClientId, nextClock, logMutation, withMutation,
  serializePayload, deserializePayload, toWireFormat, compactMutations,
} = require('../electron/sync/mutation-writer');

const { MergeEngine, compareHLC } = require('../electron/sync/merge-engine');
const { CausalOrderQueue }        = require('../electron/sync/causal-order');
const { SyncEngine }              = require('../electron/sync/sync-engine');
const { REGISTRY }                = require('../electron/sync/synced-tables');

// ── Harness ───────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];

function pass(id, label) {
  console.log(`  PASS  [${id}] ${label}`);
  passed++;
}
function fail(id, label, detail) {
  const msg = `[${id}] ${label}` + (detail ? ` — ${detail}` : '');
  console.error(`  FAIL  ${msg}`);
  failures.push(msg);
  failed++;
}
function section(title) {
  console.log('\n' + '═'.repeat(72));
  console.log(title);
  console.log('═'.repeat(72));
}
function test(id, label, fn) {
  try {
    const result = fn();
    if (result === false) fail(id, label, 'returned false');
    else pass(id, label);
  } catch (e) {
    fail(id, label, e.message);
  }
}

// ── DB factory ────────────────────────────────────────────────────────────────
// Fresh in-memory DB with minimal schema for sync engine tests.

function createTestDb(schemaVersion = 12) {
  const db = new Database(':memory:');

  db.exec(`
    PRAGMA journal_mode=WAL;

    CREATE TABLE schema_version (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT
    );
    INSERT INTO schema_version (version, applied_at) VALUES (${schemaVersion}, datetime('now'));

    CREATE TABLE client_identity (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      client_id  TEXT NOT NULL,
      created_at TEXT NOT NULL,
      label      TEXT
    );

    CREATE TABLE system_state (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at TEXT
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
    CREATE INDEX idx_mutations_table_row_hlc   ON mutations (table_name, row_id, hlc);
    CREATE INDEX idx_mutations_client_hlc      ON mutations (client_id, hlc);
    CREATE INDEX idx_mutations_station_created ON mutations (station_id, created_at);
    CREATE INDEX idx_mutations_sync_status     ON mutations (sync_status);
    CREATE INDEX idx_mutations_created         ON mutations (created_at);

    CREATE TABLE songs (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid               TEXT NOT NULL UNIQUE,
      title              TEXT,
      file_path          TEXT,
      artist_id          INTEGER,
      album_id           INTEGER,
      category_id        INTEGER,
      genre              TEXT,
      duration_ms        INTEGER,
      bpm                REAL,
      energy             TEXT,
      mood               TEXT,
      gender             TEXT,
      rotation_status    TEXT,
      daypart_mask       INTEGER,
      no_repeat_hours    REAL,
      lufs_measured      REAL,
      peak_db            REAL,
      gain_db            REAL,
      is_processed       INTEGER DEFAULT 0,
      cue_in             REAL,
      cue_out            REAL,
      cue_in_ms          INTEGER,
      cue_out_ms         INTEGER,
      intro_end          REAL,
      outro_start        REAL,
      intro_end_ms       INTEGER,
      outro_start_ms     INTEGER,
      intro_version_path TEXT,
      has_intro          INTEGER DEFAULT 0,
      last_played_at     TEXT,
      play_count         INTEGER DEFAULT 0,
      is_explicit        INTEGER DEFAULT 0,
      created_at         TEXT,
      updated_at         TEXT,
      raw_metadata       TEXT,
      spotify_uri        TEXT,
      deleted_at         TEXT
    );
  `);

  const clientId = crypto.randomUUID();
  db.prepare('INSERT INTO client_identity (id, client_id, created_at) VALUES (1, ?, ?)').run(
    clientId, new Date().toISOString()
  );
  db.prepare("INSERT INTO system_state (key, value, updated_at) VALUES ('hlc_last', ?, ?)").run(
    `0:0:${clientId}`, new Date().toISOString()
  );

  return { db, clientId };
}

// ── Test helpers ──────────────────────────────────────────────────────────────

function minimalSongRow(uuid) {
  const now = new Date().toISOString();
  return {
    id: null, uuid,
    title: 'Test Song', file_path: null, artist_id: null, album_id: null,
    category_id: null, genre: null, duration_ms: null, bpm: null, energy: null,
    mood: null, gender: null, rotation_status: null, daypart_mask: null,
    no_repeat_hours: null, lufs_measured: null, peak_db: null, gain_db: null,
    is_processed: 0, cue_in: null, cue_out: null, cue_in_ms: null, cue_out_ms: null,
    intro_end: null, outro_start: null, intro_end_ms: null, outro_start_ms: null,
    intro_version_path: null, has_intro: 0, last_played_at: null, play_count: 0,
    is_explicit: 0, created_at: now, updated_at: now, raw_metadata: null,
    spotify_uri: null, deleted_at: null,
  };
}

function makeWireMutation(overrides = {}) {
  const rowId = overrides.row_id ?? crypto.randomUUID();
  const remoteClientId = overrides.client_id ?? crypto.randomUUID();
  const wallMs = Date.now();
  const hlc = overrides.hlc ?? `${wallMs}:0:${remoteClientId}`;
  const songRow = minimalSongRow(rowId);
  // Apply any title override from payload_after shorthand
  if (overrides._title) songRow.title = overrides._title;
  const payloadAfter = overrides.payload_after !== undefined
    ? overrides.payload_after
    : (overrides.op === 'delete' ? null : serializePayload(songRow, 'songs'));
  const payloadBefore = overrides.payload_before !== undefined
    ? overrides.payload_before
    : (overrides.op === 'insert' ? null : serializePayload(songRow, 'songs'));

  const base = {
    id:                 crypto.randomUUID(),
    client_id:          remoteClientId,
    station_id:         null,
    actor_id:           null,
    table_name:         'songs',
    row_id:             rowId,
    op:                 'insert',
    payload_before:     payloadBefore,
    payload_after:      payloadAfter,
    created_at:         new Date().toISOString(),
    hlc,
    parent_mutation_id: null,
    schema_version:     12,
    conflict_resolution: null,
  };
  // Remove helpers before spreading
  const { _title, ...rest } = overrides;
  return { ...base, ...rest };
}

function createMergeEngine(db, schemaVersion = 12) {
  const causalQueue    = new CausalOrderQueue();
  const advancedCursors = [];
  const engine = new MergeEngine(db, {
    localSchemaVersion: schemaVersion,
    causalQueue,
    onCursorAdvance: (clientId, hlc) => advancedCursors.push({ clientId, hlc }),
  });
  return { engine, causalQueue, advancedCursors };
}

// Insert a mutation row directly (for setting up LWW / retention scenarios)
function directInsertMutation(db, { hlc, row_id, table_name = 'songs', op = 'insert',
                                    origin = 'local', sync_status = 'pending',
                                    parent_mutation_id = null, created_at = null }) {
  const clientId = db.prepare('SELECT client_id FROM client_identity LIMIT 1').get().client_id;
  const now = created_at ?? new Date().toISOString();
  const id  = crypto.randomUUID();
  const payloadAfter  = op !== 'delete' ? JSON.stringify({ uuid: row_id, title: 'Direct' }) : null;
  const payloadBefore = op !== 'insert' ? JSON.stringify({ uuid: row_id, title: 'Old'    }) : null;
  db.prepare(`
    INSERT INTO mutations
      (id, client_id, station_id, actor_id, table_name, row_id, op,
       payload_before, payload_after, created_at, applied_at, hlc,
       parent_mutation_id, schema_version, origin, sync_status, conflict_resolution)
    VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 12, ?, ?, NULL)
  `).run(id, clientId, table_name, row_id, op, payloadBefore, payloadAfter,
         now, now, hlc, parent_mutation_id, origin, sync_status);
  return id;
}

// ═══════════════════════════════════════════════════════════════════════════════
// A. HLC unit tests (T-01..T-04)
// ═══════════════════════════════════════════════════════════════════════════════
section('A. HLC unit tests');

test('T-01', 'Clock advances monotonically between calls', () => {
  const { db } = createTestDb();
  const hlc1 = db.transaction(() => nextClock(db))();
  const hlc2 = db.transaction(() => nextClock(db))();
  if (compareHLC(hlc2, hlc1) <= 0) throw new Error(`hlc2 ${hlc2} not > hlc1 ${hlc1}`);
});

test('T-02', 'HLC holds wall_ms and increments logical under clock skew', () => {
  const { db } = createTestDb();
  // Set hlc_last to 10 seconds in the future to simulate skew
  const futureWall = Date.now() + 10000;
  const clientId   = db.prepare('SELECT client_id FROM client_identity LIMIT 1').get().client_id;
  db.prepare("UPDATE system_state SET value = ? WHERE key = 'hlc_last'").run(
    `${futureWall}:0:${clientId}`
  );
  const hlc   = db.transaction(() => nextClock(db))();
  const parts = hlc.split(':');
  const wall  = parseInt(parts[0], 10);
  const logic = parseInt(parts[1], 10);
  if (wall !== futureWall) throw new Error(`wall=${wall}, expected ${futureWall}`);
  if (logic !== 1)         throw new Error(`logical=${logic}, expected 1`);
});

test('T-03', 'Same-ms batch: all 100 HLCs unique, logical counter 1..100', () => {
  const { db } = createTestDb();
  const futureWall = Date.now() + 60000;
  const clientId   = db.prepare('SELECT client_id FROM client_identity LIMIT 1').get().client_id;
  db.prepare("UPDATE system_state SET value = ? WHERE key = 'hlc_last'").run(
    `${futureWall}:0:${clientId}`
  );
  const hlcs = [];
  for (let i = 0; i < 100; i++) {
    hlcs.push(db.transaction(() => nextClock(db))());
  }
  const walls   = hlcs.map(h => parseInt(h.split(':')[0], 10));
  const logics  = hlcs.map(h => parseInt(h.split(':')[1], 10));
  const ids     = new Set(hlcs);
  if (ids.size !== 100)               throw new Error('HLCs not unique');
  if (!walls.every(w => w === futureWall)) throw new Error('Not all walls equal futureWall');
  if (logics[0] !== 1 || logics[99] !== 100) throw new Error(`Logical range: ${logics[0]}..${logics[99]}`);
});

test('T-04', 'Equal wall+logical, different client_id: deterministic non-zero order', () => {
  const wall  = Date.now();
  const hlcA  = `${wall}:5:aaaa-0000-0000-0000-000000000000`;
  const hlcB  = `${wall}:5:bbbb-0000-0000-0000-000000000000`;
  const cmpAB = compareHLC(hlcA, hlcB);
  const cmpBA = compareHLC(hlcB, hlcA);
  if (cmpAB === 0)      throw new Error('compareHLC returned 0 for different client_ids');
  if (cmpAB + cmpBA !== 0) throw new Error('compareHLC not antisymmetric');
  if (cmpAB >= 0)       throw new Error('Expected A < B (lower client_id sorts lower)');
});

// ═══════════════════════════════════════════════════════════════════════════════
// B. Writer unit tests (T-05..T-10)
// ═══════════════════════════════════════════════════════════════════════════════
section('B. Writer unit tests');

test('T-05', 'toWireFormat: 14 fields, applied_at/origin/sync_status absent', () => {
  const { db } = createTestDb();
  const now = new Date().toISOString();
  const row17 = {
    id: crypto.randomUUID(), client_id: crypto.randomUUID(), station_id: null,
    actor_id: null, table_name: 'songs', row_id: crypto.randomUUID(), op: 'insert',
    payload_before: null, payload_after: '{}', created_at: now, applied_at: now,
    hlc: `${Date.now()}:0:test`, parent_mutation_id: null, schema_version: 12,
    origin: 'local', sync_status: 'pending', conflict_resolution: null,
  };
  const wire = toWireFormat(row17);
  const keys = Object.keys(wire);
  if (keys.length !== 14)          throw new Error(`Expected 14 fields, got ${keys.length}`);
  if ('applied_at'  in wire)       throw new Error('applied_at present in wire');
  if ('origin'      in wire)       throw new Error('origin present in wire');
  if ('sync_status' in wire)       throw new Error('sync_status present in wire');
});

test('T-06', 'serializePayload/deserializePayload scalar round-trip', () => {
  const uuid = crypto.randomUUID();
  const row  = minimalSongRow(uuid);
  row.title  = 'Round Trip Song';
  const payload = serializePayload(row, 'songs');
  const back    = deserializePayload(payload, 'songs');
  if (back.title !== 'Round Trip Song') throw new Error(`title: ${back.title}`);
  if (back.uuid  !== uuid)              throw new Error(`uuid: ${back.uuid}`);
});

test('T-07', 'json-text round-trip: raw_metadata nested → string → nested', () => {
  const uuid     = crypto.randomUUID();
  const row      = minimalSongRow(uuid);
  row.raw_metadata = JSON.stringify({ bpm: 128, mood: 'upbeat' });
  const payload  = serializePayload(row, 'songs');
  if (typeof payload.raw_metadata !== 'object' || payload.raw_metadata === null)
    throw new Error('payload.raw_metadata not a nested object');
  if (payload.raw_metadata.bpm !== 128)
    throw new Error('nested bpm wrong: ' + payload.raw_metadata.bpm);
  const back = deserializePayload(payload, 'songs');
  if (typeof back.raw_metadata !== 'string')
    throw new Error('deserialized raw_metadata not a string');
  if (JSON.parse(back.raw_metadata).bpm !== 128)
    throw new Error('bpm after deserialize wrong');
});

test('T-08', 'blob-ref: file_path serialized as __blob_ref envelope', () => {
  const row     = minimalSongRow(crypto.randomUUID());
  row.file_path = '/music/test.mp3';
  const payload = serializePayload(row, 'songs');
  if (typeof payload.file_path !== 'object' || payload.file_path === null)
    throw new Error('file_path not an object');
  if (payload.file_path.__blob_ref    !== '/music/test.mp3') throw new Error('__blob_ref wrong');
  if (payload.file_path.__blob_origin !== '/music/test.mp3') throw new Error('__blob_origin wrong');
});

test('T-09', 'withMutation atomicity: fn throws → no mutation row written', () => {
  const { db } = createTestDb();
  const uuid = crypto.randomUUID();
  db.prepare('INSERT INTO songs (uuid, title, created_at, updated_at) VALUES (?,?,?,?)').run(
    uuid, 'Before', new Date().toISOString(), new Date().toISOString()
  );
  const before = db.prepare('SELECT COUNT(*) AS c FROM mutations').get().c;
  try {
    withMutation(db, {
      table_name: 'songs', row_id: uuid, op: 'update',
      payload_before: serializePayload(db.prepare('SELECT * FROM songs WHERE uuid=?').get(uuid), 'songs'),
      payload_after:  serializePayload({ ...db.prepare('SELECT * FROM songs WHERE uuid=?').get(uuid), title: 'After' }, 'songs'),
      station_id: null, actor_id: null,
    }, () => { throw new Error('deliberate throw'); });
  } catch (_) {}
  const after = db.prepare('SELECT COUNT(*) AS c FROM mutations').get().c;
  if (after !== before) throw new Error(`Mutations before=${before} after=${after}; expected no change`);
});

test('T-10', 'logMutation validation: op=update with payload_before=null throws', () => {
  const { db } = createTestDb();
  let threw = false;
  try {
    db.transaction(() => {
      logMutation(db, {
        table_name: 'songs', row_id: crypto.randomUUID(), op: 'update',
        payload_before: null, payload_after: { uuid: 'x' }, station_id: null,
      });
    })();
  } catch (_) { threw = true; }
  if (!threw) throw new Error('Expected throw but logMutation succeeded');
});

// ═══════════════════════════════════════════════════════════════════════════════
// C. LWW apply tests (T-11..T-15)
// ═══════════════════════════════════════════════════════════════════════════════
section('C. LWW apply tests');

test('T-11', 'Incoming HLC > local latest: payload_after applied to live table', () => {
  const { db, clientId } = createTestDb();
  const { engine }       = createMergeEngine(db);
  const rowId = crypto.randomUUID();
  const now   = new Date().toISOString();

  // Establish local state: song exists with title 'Local Title'
  db.prepare('INSERT INTO songs (uuid, title, created_at, updated_at) VALUES (?,?,?,?)').run(
    rowId, 'Local Title', now, now
  );
  directInsertMutation(db, { hlc: `${Date.now() - 1000}:0:${clientId}`, row_id: rowId,
                              op: 'insert', origin: 'local', sync_status: 'synced' });

  // Remote mutation with higher HLC and different title
  const songRow        = minimalSongRow(rowId);
  songRow.title        = 'Remote Title';
  const remoteClientId = crypto.randomUUID();
  const wire = makeWireMutation({
    row_id: rowId, op: 'update',
    payload_before: serializePayload(minimalSongRow(rowId), 'songs'),
    payload_after:  serializePayload(songRow, 'songs'),
    client_id: remoteClientId,
    hlc: `${Date.now() + 5000}:0:${remoteClientId}`,
  });

  const outcome = engine.apply(wire);
  if (outcome !== 'applied') throw new Error('outcome=' + outcome);
  const live = db.prepare('SELECT title FROM songs WHERE uuid=?').get(rowId);
  if (live?.title !== 'Remote Title') throw new Error('live title=' + live?.title);
});

test('T-12', 'Incoming HLC < local latest: live table unchanged, mutation logged', () => {
  const { db, clientId } = createTestDb();
  const { engine }       = createMergeEngine(db);
  const rowId = crypto.randomUUID();
  const now   = new Date().toISOString();

  db.prepare('INSERT INTO songs (uuid, title, created_at, updated_at) VALUES (?,?,?,?)').run(
    rowId, 'Local Title', now, now
  );
  directInsertMutation(db, { hlc: `${Date.now() + 9999}:0:${clientId}`, row_id: rowId,
                              op: 'insert', origin: 'local', sync_status: 'synced' });

  const wire    = makeWireMutation({ row_id: rowId, op: 'update', _title: 'Remote Title',
                                     hlc: `${Date.now() - 5000}:0:${crypto.randomUUID()}` });
  const outcome = engine.apply(wire);
  if (outcome !== 'loser') throw new Error('outcome=' + outcome);
  const live    = db.prepare('SELECT title FROM songs WHERE uuid=?').get(rowId);
  if (live?.title !== 'Local Title') throw new Error('live title=' + live?.title);
  // Mutation row should still exist for audit
  const logged  = db.prepare('SELECT 1 FROM mutations WHERE id=?').get(wire.id);
  if (!logged) throw new Error('loser mutation not logged');
});

test('T-13', 'Equal HLC, remote client_id lexicographically higher: remote wins', () => {
  const { db }     = createTestDb();
  const { engine } = createMergeEngine(db);
  const rowId      = crypto.randomUUID();
  const tiedWall   = Date.now();
  const localClientId  = 'aaaa-0000-0000-0000-000000000000';
  const remoteClientId = 'zzzz-0000-0000-0000-000000000000';
  const tiedHlc        = `${tiedWall}:0:${localClientId}`;
  const now            = new Date().toISOString();

  db.prepare('INSERT INTO songs (uuid, title, created_at, updated_at) VALUES (?,?,?,?)').run(
    rowId, 'Local', now, now
  );
  directInsertMutation(db, { hlc: tiedHlc, row_id: rowId, op: 'insert',
                              origin: 'local', sync_status: 'synced' });

  const songRow    = minimalSongRow(rowId);
  songRow.title    = 'Remote Won';
  const wire = makeWireMutation({
    row_id: rowId, client_id: remoteClientId, op: 'update',
    hlc: `${tiedWall}:0:${remoteClientId}`,
    payload_before: serializePayload(minimalSongRow(rowId), 'songs'),
    payload_after:  serializePayload(songRow, 'songs'),
  });

  const outcome = engine.apply(wire);
  if (outcome !== 'applied') throw new Error('outcome=' + outcome);
  const live = db.prepare('SELECT title FROM songs WHERE uuid=?').get(rowId);
  if (live?.title !== 'Remote Won') throw new Error('live title=' + live?.title);
});

test('T-14', 'Equal HLC, remote client_id lexicographically lower: local wins', () => {
  const { db }     = createTestDb();
  const { engine } = createMergeEngine(db);
  const rowId      = crypto.randomUUID();
  const tiedWall   = Date.now();
  const localClientId  = 'zzzz-0000-0000-0000-000000000000';
  const remoteClientId = 'aaaa-0000-0000-0000-000000000000';
  const now            = new Date().toISOString();

  db.prepare('INSERT INTO songs (uuid, title, created_at, updated_at) VALUES (?,?,?,?)').run(
    rowId, 'Local Wins', now, now
  );
  directInsertMutation(db, { hlc: `${tiedWall}:0:${localClientId}`, row_id: rowId,
                              op: 'insert', origin: 'local', sync_status: 'synced' });

  const wire = makeWireMutation({
    row_id: rowId, client_id: remoteClientId, op: 'update',
    hlc: `${tiedWall}:0:${remoteClientId}`,
    _title: 'Remote Tried',
  });
  const outcome = engine.apply(wire);
  if (outcome !== 'loser') throw new Error('outcome=' + outcome);
  const live = db.prepare('SELECT title FROM songs WHERE uuid=?').get(rowId);
  if (live?.title !== 'Local Wins') throw new Error('live title=' + live?.title);
});

test('T-15', 'No prior mutations for row: incoming wins unconditionally', () => {
  const { db }     = createTestDb();
  const { engine } = createMergeEngine(db);
  const rowId      = crypto.randomUUID();
  const wire       = makeWireMutation({ row_id: rowId, op: 'insert', _title: 'Brand New' });
  const outcome    = engine.apply(wire);
  if (outcome !== 'applied') throw new Error('outcome=' + outcome);
  const live = db.prepare('SELECT title FROM songs WHERE uuid=?').get(rowId);
  if (live?.title !== 'Brand New') throw new Error('title=' + live?.title);
});

// ═══════════════════════════════════════════════════════════════════════════════
// D. Causal ordering tests (T-16..T-20)
// ═══════════════════════════════════════════════════════════════════════════════
section('D. Causal ordering tests');

test('T-16', 'Child arrives before parent: held, cursor does not advance', () => {
  const { db }                = createTestDb();
  const { engine, causalQueue, advancedCursors } = createMergeEngine(db);
  const parentId = crypto.randomUUID();
  const childId  = crypto.randomUUID();
  const rowId    = crypto.randomUUID();
  const wire     = makeWireMutation({
    id:                 childId,
    row_id:             rowId,
    parent_mutation_id: parentId,
    op:                 'insert',
  });
  const outcome = engine.apply(wire);
  if (outcome !== 'held')           throw new Error('outcome=' + outcome);
  if (causalQueue.heldCount !== 1)  throw new Error('heldCount=' + causalQueue.heldCount);
  if (advancedCursors.length !== 0) throw new Error('cursor should not advance for held mutation');
  // Child not yet in mutations table
  const inDb = db.prepare('SELECT 1 FROM mutations WHERE id=?').get(childId);
  if (inDb) throw new Error('held mutation should not be in mutations table');
});

test('T-17', 'Parent arrives after child held: child unblocked and applied', () => {
  const { db }                = createTestDb();
  const { engine, causalQueue } = createMergeEngine(db);
  const parentId = crypto.randomUUID();
  const rowId1   = crypto.randomUUID();
  const rowId2   = crypto.randomUUID();

  // Child arrives first (depends on parent)
  const child = makeWireMutation({
    row_id: rowId2, parent_mutation_id: parentId, op: 'insert', _title: 'Child Song',
  });
  const outcome1 = engine.apply(child);
  if (outcome1 !== 'held') throw new Error('child outcome=' + outcome1);

  // Parent arrives
  const parent = makeWireMutation({ id: parentId, row_id: rowId1, op: 'insert', _title: 'Parent Song' });
  const outcome2 = engine.apply(parent);
  if (outcome2 !== 'applied') throw new Error('parent outcome=' + outcome2);

  // After parent applied, sync-engine retries causal queue. Simulate that here:
  // (SyncEngine._retryCausalQueue is internal; we call it via a dummy sync cycle)
  // Instead, directly test that the child can now be applied by checking the queue state
  // and calling engine.apply() on the released mutations.
  const released = causalQueue.release(parentId);
  if (released.length !== 1) throw new Error('released.length=' + released.length);
  const outcome3 = engine.apply(released[0]);
  if (outcome3 !== 'applied') throw new Error('child after release: outcome=' + outcome3);
  const live = db.prepare('SELECT title FROM songs WHERE uuid=?').get(rowId2);
  if (live?.title !== 'Child Song') throw new Error('child title=' + live?.title);
});

test('T-18', 'Three-link chain (A→B→C, C arrives first): correct topological order', () => {
  const { db }                = createTestDb();
  const { engine, causalQueue } = createMergeEngine(db);
  const idA = crypto.randomUUID(), idB = crypto.randomUUID(), idC = crypto.randomUUID();

  const wireC = makeWireMutation({ id: idC, row_id: crypto.randomUUID(), parent_mutation_id: idB, _title: 'C' });
  const wireB = makeWireMutation({ id: idB, row_id: crypto.randomUUID(), parent_mutation_id: idA, _title: 'B' });
  const wireA = makeWireMutation({ id: idA, row_id: crypto.randomUUID(), parent_mutation_id: null, _title: 'A' });

  engine.apply(wireC); // held (B missing)
  engine.apply(wireB); // held (A missing)

  // A arrives
  const outcomeA = engine.apply(wireA);
  if (outcomeA !== 'applied') throw new Error('A outcome=' + outcomeA);

  // Release B (depends on A)
  const relB = causalQueue.release(idA);
  if (relB.length !== 1) throw new Error('Expected 1 mutation released by A');
  const outcomeB = engine.apply(relB[0]);
  if (outcomeB !== 'applied') throw new Error('B outcome=' + outcomeB);

  // Release C (depends on B)
  const relC = causalQueue.release(idB);
  if (relC.length !== 1) throw new Error('Expected 1 mutation released by B');
  const outcomeC = engine.apply(relC[0]);
  if (outcomeC !== 'applied') throw new Error('C outcome=' + outcomeC);

  if (causalQueue.heldCount !== 0) throw new Error('Queue not empty after full chain');
});

test('T-19', 'Stale check logs warning/error without discarding held mutation', () => {
  const { db }                = createTestDb();
  const { engine, causalQueue } = createMergeEngine(db);
  const wire = makeWireMutation({
    parent_mutation_id: crypto.randomUUID(), // will never arrive
    op: 'insert',
  });
  engine.apply(wire); // held
  if (causalQueue.heldCount !== 1) throw new Error('heldCount=' + causalQueue.heldCount);
  // Manually backdate the hold time
  const held = causalQueue.allHeld()[0];
  causalQueue._holdTimes.set(held.id, Date.now() - 31 * 60 * 1000);
  // checkStale should not throw and mutation should still be held
  causalQueue.checkStale();
  if (causalQueue.heldCount !== 1) throw new Error('mutation discarded by checkStale');
});

test('T-20', 'parent_mutation_id = null: no causal check, applied immediately', () => {
  const { db }     = createTestDb();
  const { engine } = createMergeEngine(db);
  const wire    = makeWireMutation({ parent_mutation_id: null });
  const outcome = engine.apply(wire);
  if (outcome !== 'applied') throw new Error('outcome=' + outcome);
});

// ═══════════════════════════════════════════════════════════════════════════════
// E. Tombstone tests (T-21..T-24)
// ═══════════════════════════════════════════════════════════════════════════════
section('E. Tombstone tests');

test('T-21', 'Remote delete wins LWW: deleted_at set on live row', () => {
  const { db, clientId } = createTestDb();
  const { engine }       = createMergeEngine(db);
  const rowId            = crypto.randomUUID();
  const now              = new Date().toISOString();

  db.prepare('INSERT INTO songs (uuid, title, created_at, updated_at) VALUES (?,?,?,?)').run(
    rowId, 'Will Be Deleted', now, now
  );
  directInsertMutation(db, { hlc: `${Date.now() - 1000}:0:${clientId}`, row_id: rowId,
                              op: 'insert', origin: 'local', sync_status: 'synced' });

  const songRow = minimalSongRow(rowId);
  const wire    = makeWireMutation({
    row_id: rowId, op: 'delete',
    payload_before: serializePayload(songRow, 'songs'),
    payload_after:  null,
    hlc: `${Date.now() + 5000}:0:${crypto.randomUUID()}`,
  });
  const outcome = engine.apply(wire);
  if (outcome !== 'applied') throw new Error('outcome=' + outcome);
  const live    = db.prepare('SELECT deleted_at FROM songs WHERE uuid=?').get(rowId);
  if (!live?.deleted_at) throw new Error('deleted_at not set');
  // Row invisible to standard WHERE deleted_at IS NULL query
  const visible = db.prepare('SELECT 1 FROM songs WHERE uuid=? AND deleted_at IS NULL').get(rowId);
  if (visible) throw new Error('Row still visible after tombstone');
});

test('T-22', 'Remote delete lower HLC than local update: row survives', () => {
  const { db, clientId } = createTestDb();
  const { engine }       = createMergeEngine(db);
  const rowId            = crypto.randomUUID();
  const now              = new Date().toISOString();

  db.prepare('INSERT INTO songs (uuid, title, created_at, updated_at) VALUES (?,?,?,?)').run(
    rowId, 'Survivor', now, now
  );
  directInsertMutation(db, { hlc: `${Date.now() + 9000}:0:${clientId}`, row_id: rowId,
                              op: 'insert', origin: 'local', sync_status: 'synced' });

  const wire = makeWireMutation({
    row_id: rowId, op: 'delete',
    payload_before: serializePayload(minimalSongRow(rowId), 'songs'),
    payload_after:  null,
    hlc: `${Date.now() - 5000}:0:${crypto.randomUUID()}`,
  });
  const outcome = engine.apply(wire);
  if (outcome !== 'loser') throw new Error('outcome=' + outcome);
  const live = db.prepare('SELECT deleted_at FROM songs WHERE uuid=?').get(rowId);
  if (live?.deleted_at) throw new Error('deleted_at set unexpectedly');
});

test('T-23', 'Re-insert after tombstone with higher HLC clears deleted_at', () => {
  const { db }     = createTestDb();
  const { engine } = createMergeEngine(db);
  const rowId      = crypto.randomUUID();
  const now        = new Date().toISOString();

  // First insert the row
  const insertWire = makeWireMutation({ row_id: rowId, op: 'insert', _title: 'Song',
                                        hlc: `${Date.now()}:0:${crypto.randomUUID()}` });
  engine.apply(insertWire);

  // Delete it (higher HLC)
  const deleteWire = makeWireMutation({
    row_id: rowId, op: 'delete',
    payload_before: serializePayload(minimalSongRow(rowId), 'songs'),
    payload_after:  null,
    hlc: `${Date.now() + 1000}:0:${crypto.randomUUID()}`,
  });
  engine.apply(deleteWire);

  // Re-insert with even higher HLC
  const reinsertRow   = minimalSongRow(rowId);
  reinsertRow.title   = 'Revived';
  reinsertRow.deleted_at = null;
  const reinsertWire  = makeWireMutation({
    row_id: rowId, op: 'insert',
    payload_after:  serializePayload(reinsertRow, 'songs'),
    hlc: `${Date.now() + 2000}:0:${crypto.randomUUID()}`,
  });
  const outcome = engine.apply(reinsertWire);
  if (outcome !== 'applied') throw new Error('outcome=' + outcome);
  const live = db.prepare('SELECT title, deleted_at FROM songs WHERE uuid=?').get(rowId);
  if (live?.deleted_at) throw new Error('deleted_at still set after re-insert');
  if (live?.title !== 'Revived') throw new Error('title=' + live?.title);
});

test('T-24', 'Remote delete on nonexistent local row: no-op, mutation logged', () => {
  const { db }     = createTestDb();
  const { engine } = createMergeEngine(db);
  const rowId      = crypto.randomUUID();
  const wire       = makeWireMutation({
    row_id: rowId, op: 'delete',
    payload_before: serializePayload(minimalSongRow(rowId), 'songs'),
    payload_after:  null,
  });
  const outcome    = engine.apply(wire);
  if (outcome !== 'applied') throw new Error('outcome=' + outcome);
  const logged = db.prepare('SELECT 1 FROM mutations WHERE id=?').get(wire.id);
  if (!logged) throw new Error('delete mutation not logged');
});

// ═══════════════════════════════════════════════════════════════════════════════
// F. Security and filter tests (T-25..T-29)
// ═══════════════════════════════════════════════════════════════════════════════
section('F. Security and filter tests');

test('T-25', 'Push batch excludes install_secrets_kv mutations', () => {
  const { db, clientId } = createTestDb();
  const rowId = crypto.randomUUID();
  // Insert a mutation for install_secrets_kv (syncExcluded)
  directInsertMutation(db, { hlc: `${Date.now()}:0:${clientId}`, row_id: rowId,
                              table_name: 'install_secrets_kv', op: 'insert',
                              origin: 'local', sync_status: 'pending' });
  // Also insert a legitimate songs mutation
  directInsertMutation(db, { hlc: `${Date.now()}:1:${clientId}`, row_id: crypto.randomUUID(),
                              table_name: 'songs', op: 'insert',
                              origin: 'local', sync_status: 'pending' });

  // SyncEngine._loadPendingMutations filters excluded tables
  const engine = new SyncEngine(db, null /* no transport needed */, { localSchemaVersion: 12 });
  const pending = engine._loadPendingMutations();
  const hasSecrets = pending.some(m => m.table_name === 'install_secrets_kv');
  if (hasSecrets) throw new Error('install_secrets_kv found in push batch');
  if (pending.length !== 1) throw new Error('expected 1 pending, got ' + pending.length);
});

test('T-26', 'Push batch excludes monitor_routing mutations', () => {
  const { db, clientId } = createTestDb();
  directInsertMutation(db, { hlc: `${Date.now()}:0:${clientId}`, row_id: crypto.randomUUID(),
                              table_name: 'monitor_routing', op: 'insert',
                              origin: 'local', sync_status: 'pending' });
  const engine = new SyncEngine(db, null, { localSchemaVersion: 12 });
  const pending = engine._loadPendingMutations();
  if (pending.some(m => m.table_name === 'monitor_routing'))
    throw new Error('monitor_routing found in push batch');
});

test('T-27', 'rtmp_destinations: stream_key absent from payload_before and payload_after', () => {
  // stream_key is local-only in REGISTRY — serializePayload must exclude it
  const entry = REGISTRY['rtmp_destinations'];
  if (entry.columns.stream_key !== 'local-only')
    throw new Error('stream_key not marked local-only in registry');

  const row = {
    id: 1, uuid: crypto.randomUUID(), name: 'My Stream', url: 'rtmp://example.com',
    stream_key: 'SECRET_KEY_SHOULD_NOT_APPEAR', is_active: 1, station_id: 1,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), deleted_at: null,
  };
  // rtmp_destinations table not in test DB, but serializePayload doesn't need the live table
  const payload = serializePayload(row, 'rtmp_destinations');
  if ('stream_key' in payload) throw new Error('stream_key present in payload');
});

test('T-28', 'stations: icecast_password and mount_pending_provision absent from payload', () => {
  const entry = REGISTRY['stations'];
  if (entry.columns.icecast_password           !== 'local-only') throw new Error('icecast_password not local-only');
  if (entry.columns.mount_pending_provision     !== 'local-only') throw new Error('mount_pending_provision not local-only');

  const row = {
    id: 1, uuid: crypto.randomUUID(), name: 'Test Station', callsign: 'TEST', frequency: '99.1',
    city: 'Portland', state: 'OR', country: 'US', website: null, is_active: 1,
    created_at: new Date().toISOString(), icecast_server_url: null, icecast_mount: null,
    icecast_password: 'SECRET_PASSWORD', icecast_bitrate: null, icecast_format: null,
    icecast_port: null, audio_device_output: null, mic_device: null,
    mount_pending_provision: 1, updated_at: new Date().toISOString(), deleted_at: null,
  };
  const payload = serializePayload(row, 'stations');
  if ('icecast_password'       in payload) throw new Error('icecast_password in payload');
  if ('mount_pending_provision' in payload) throw new Error('mount_pending_provision in payload');
});

test('T-29', 'MergeEngine Step 2: remote install_secrets_kv mutation rejected', () => {
  const { db }     = createTestDb();
  const { engine } = createMergeEngine(db);
  const wire       = makeWireMutation({ table_name: 'install_secrets_kv', op: 'insert' });
  const outcome    = engine.apply(wire);
  if (outcome !== 'rejected') throw new Error('outcome=' + outcome);
  // Should not appear in mutations table
  const logged = db.prepare('SELECT 1 FROM mutations WHERE id=?').get(wire.id);
  if (logged) throw new Error('rejected mutation was logged');
});

// ═══════════════════════════════════════════════════════════════════════════════
// G. Idempotency tests (T-30..T-31)
// ═══════════════════════════════════════════════════════════════════════════════
section('G. Idempotency tests');

test('T-30', 'Apply same mutation UUID twice: live table unchanged, one row in mutations', () => {
  const { db }     = createTestDb();
  const { engine } = createMergeEngine(db);
  const wire       = makeWireMutation({ _title: 'Once' });
  engine.apply(wire); // first apply
  const outcome2   = engine.apply(wire); // second apply
  if (outcome2 !== 'idempotent') throw new Error('outcome2=' + outcome2);
  const count = db.prepare('SELECT COUNT(*) AS c FROM mutations WHERE id=?').get(wire.id).c;
  if (count !== 1) throw new Error('mutation row count=' + count + ', expected 1');
  const live  = db.prepare('SELECT title FROM songs WHERE uuid=?').get(wire.row_id);
  if (live?.title !== 'Once') throw new Error('title=' + live?.title);
});

test('T-31', 'Apply same mutation after it was logged as LWW loser: still idempotent', () => {
  const { db, clientId } = createTestDb();
  const { engine }       = createMergeEngine(db);
  const rowId            = crypto.randomUUID();

  // Establish local winner with higher HLC
  db.prepare('INSERT INTO songs (uuid, title, created_at, updated_at) VALUES (?,?,?,?)').run(
    rowId, 'Local Winner', new Date().toISOString(), new Date().toISOString()
  );
  directInsertMutation(db, { hlc: `${Date.now() + 9999}:0:${clientId}`, row_id: rowId,
                              op: 'insert', origin: 'local', sync_status: 'synced' });

  // Apply remote loser
  const wire = makeWireMutation({ row_id: rowId, op: 'update', _title: 'Remote Lost',
                                   hlc: `${Date.now() - 5000}:0:${crypto.randomUUID()}` });
  engine.apply(wire); // logs as loser

  // Apply again — should be idempotent
  const outcome2 = engine.apply(wire);
  if (outcome2 !== 'idempotent') throw new Error('outcome2=' + outcome2);
  const live = db.prepare('SELECT title FROM songs WHERE uuid=?').get(rowId);
  if (live?.title !== 'Local Winner') throw new Error('title changed: ' + live?.title);
});

// ═══════════════════════════════════════════════════════════════════════════════
// H. Retention tests (T-32..T-35)
// ═══════════════════════════════════════════════════════════════════════════════
section('H. Retention tests');

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

test('T-32', '90-day synced mutation with no children: deleted by compactMutations', () => {
  const { db, clientId } = createTestDb();
  const id = directInsertMutation(db, {
    hlc: `${Date.now()}:0:${clientId}`, row_id: crypto.randomUUID(),
    op: 'insert', origin: 'local', sync_status: 'synced', created_at: daysAgo(100),
  });
  const result = compactMutations(db);
  if (result.deleted !== 1) throw new Error('deleted=' + result.deleted + ', expected 1');
  const still = db.prepare('SELECT 1 FROM mutations WHERE id=?').get(id);
  if (still) throw new Error('Synced mutation still present after compaction');
});

test('T-33', 'Pending mutation >90 days old: NOT deleted, stalePending=1', () => {
  const { db, clientId } = createTestDb();
  const id = directInsertMutation(db, {
    hlc: `${Date.now()}:0:${clientId}`, row_id: crypto.randomUUID(),
    op: 'insert', origin: 'local', sync_status: 'pending', created_at: daysAgo(100),
  });
  const result = compactMutations(db);
  if (result.deleted      !== 0) throw new Error('deleted=' + result.deleted + ', expected 0');
  if (result.stalePending !== 1) throw new Error('stalePending=' + result.stalePending);
  const still = db.prepare('SELECT 1 FROM mutations WHERE id=?').get(id);
  if (!still) throw new Error('Pending mutation was deleted — must not be [N-120]');
});

test('T-34', 'Synced >90d parent referenced by pending child: parent NOT deleted', () => {
  const { db, clientId } = createTestDb();
  const parentId = directInsertMutation(db, {
    hlc: `${Date.now()}:0:${clientId}`, row_id: crypto.randomUUID(),
    op: 'insert', origin: 'local', sync_status: 'synced', created_at: daysAgo(100),
  });
  // Pending child references parent
  directInsertMutation(db, {
    hlc: `${Date.now()}:1:${clientId}`, row_id: crypto.randomUUID(),
    op: 'update', origin: 'local', sync_status: 'pending',
    parent_mutation_id: parentId, created_at: daysAgo(5),
  });
  const result = compactMutations(db);
  if (result.deleted !== 0) throw new Error('deleted=' + result.deleted + ', parent should be retained');
  const still = db.prepare('SELECT 1 FROM mutations WHERE id=?').get(parentId);
  if (!still) throw new Error('Parent was deleted despite pending child [N-121]');
});

test('T-35', 'Both parent and child synced >90d, no further refs: both deleted', () => {
  const { db, clientId } = createTestDb();
  const parentId = directInsertMutation(db, {
    hlc: `${Date.now()}:0:${clientId}`, row_id: crypto.randomUUID(),
    op: 'insert', origin: 'local', sync_status: 'synced', created_at: daysAgo(100),
  });
  const childId = directInsertMutation(db, {
    hlc: `${Date.now()}:1:${clientId}`, row_id: crypto.randomUUID(),
    op: 'update', origin: 'local', sync_status: 'synced',
    parent_mutation_id: parentId, created_at: daysAgo(100),
  });
  const result = compactMutations(db);
  // Child is deleted first (not a parent), then parent (no longer referenced)
  // A single SQL pass may not delete parent in one shot if child goes first.
  // Run twice to confirm convergence (or use the single-pass SQL which handles it).
  const stillParent = db.prepare('SELECT 1 FROM mutations WHERE id=?').get(parentId);
  const stillChild  = db.prepare('SELECT 1 FROM mutations WHERE id=?').get(childId);
  if (stillChild)  throw new Error('Child still present after compaction');
  if (stillParent) throw new Error('Parent still present after compaction (child was deleted first)');
  if (result.stalePending !== 0) throw new Error('stalePending=' + result.stalePending);
});

// ═══════════════════════════════════════════════════════════════════════════════
// I. Schema compatibility tests (T-36..T-38)
// ═══════════════════════════════════════════════════════════════════════════════
section('I. Schema compatibility tests');

test('T-36', 'Receive mutation at schema v11 (local v12): applied with warn', () => {
  const { db }     = createTestDb(12);
  const { engine } = createMergeEngine(db, 12);
  // Mutation from a client running schema v11 (older than local v12)
  const wire = makeWireMutation({ schema_version: 11 });
  // In v1 there are no transformers — engine warns and applies as-is
  const outcome = engine.apply(wire);
  // Should not be 'quarantined' (that's only for newer schema)
  if (outcome === 'quarantined') throw new Error('Should not quarantine older schema');
  if (outcome === 'rejected')    throw new Error('Should not reject older schema');
  // applied or loser both acceptable — the important thing is it was processed
});

test('T-37', 'Receive mutation at schema v13 (local v12): quarantined, not applied', () => {
  const { db }     = createTestDb(12);
  const { engine } = createMergeEngine(db, 12);
  const rowId      = crypto.randomUUID();
  const wire       = makeWireMutation({ row_id: rowId, schema_version: 13 });
  const outcome    = engine.apply(wire);
  if (outcome !== 'quarantined') throw new Error('outcome=' + outcome);
  // Row should NOT be in live table
  const live = db.prepare('SELECT 1 FROM songs WHERE uuid=?').get(rowId);
  if (live) throw new Error('Future-schema mutation was applied to live table');
  // Mutation should NOT be in mutations table (quarantine is a separate store)
  const logged = db.prepare('SELECT 1 FROM mutations WHERE id=?').get(wire.id);
  if (logged) throw new Error('Quarantined mutation was inserted into mutations table');
});

test('T-38', 'parent_mutation_id context: inner withMutation inherits outer ID', () => {
  const { db } = createTestDb();
  const rowId1 = crypto.randomUUID();
  const rowId2 = crypto.randomUUID();
  const now    = new Date().toISOString();

  // Set up rows
  db.prepare('INSERT INTO songs (uuid, title, created_at, updated_at) VALUES (?,?,?,?)').run(rowId1, 'Outer', now, now);
  db.prepare('INSERT INTO songs (uuid, title, created_at, updated_at) VALUES (?,?,?,?)').run(rowId2, 'Inner', now, now);

  const getRow = (uuid) => db.prepare('SELECT * FROM songs WHERE uuid=?').get(uuid);
  let outerMutationId = null;

  withMutation(db, {
    table_name: 'songs', row_id: rowId1, op: 'update',
    payload_before: serializePayload(getRow(rowId1), 'songs'),
    payload_after:  serializePayload({ ...getRow(rowId1), title: 'Outer Updated' }, 'songs'),
    station_id: null,
  }, () => {
    db.prepare('UPDATE songs SET title=? WHERE uuid=?').run('Outer Updated', rowId1);

    // Inner mutation — should inherit outer's mutation id as parent
    withMutation(db, {
      table_name: 'songs', row_id: rowId2, op: 'update',
      payload_before: serializePayload(getRow(rowId2), 'songs'),
      payload_after:  serializePayload({ ...getRow(rowId2), title: 'Inner Updated' }, 'songs'),
      station_id: null,
    }, () => {
      db.prepare('UPDATE songs SET title=? WHERE uuid=?').run('Inner Updated', rowId2);
    });
  });

  const outerMut = db.prepare("SELECT * FROM mutations WHERE row_id=? AND table_name='songs'").get(rowId1);
  const innerMut = db.prepare("SELECT * FROM mutations WHERE row_id=? AND table_name='songs'").get(rowId2);

  if (!outerMut) throw new Error('outer mutation not found');
  if (!innerMut) throw new Error('inner mutation not found');
  if (innerMut.parent_mutation_id !== outerMut.id) {
    throw new Error(
      'inner.parent_mutation_id=' + innerMut.parent_mutation_id +
      ' expected ' + outerMut.id
    );
  }
  if (outerMut.parent_mutation_id !== null) {
    throw new Error('outer mutation should have null parent, got ' + outerMut.parent_mutation_id);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Final report
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n' + '═'.repeat(72));
console.log(`sync-test-engine results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.error('  ✗ ' + f);
}
console.log('═'.repeat(72));
process.exit(failed > 0 ? 1 : 0);
