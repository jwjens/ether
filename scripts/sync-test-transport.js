'use strict';
// scripts/sync-test-transport.js — Stage 3 integration tests.
// Tests the HTTP transport against the live Railway backend.
//
// Run:
//   ETHER_SYNC_URL=https://ether-backend-production.up.railway.app \
//   ETHER_LICENSE_KEY=ETH-PRO-XXXX-XXXX-XXXX \
//   node_modules/.bin/electron --no-sandbox scripts/sync-test-transport.js
//
// All test mutations use a throwaway station_id UUID unique to each run.
// They accumulate on the backend (backend retains forever per §22) but are
// isolated from real station data by the random station_id.

const path   = require('path');
const crypto = require('crypto');

const Database         = require(path.join(__dirname, '../node_modules/better-sqlite3'));
const { HttpTransport }   = require('../electron/sync/transport-http');
const { MergeEngine }     = require('../electron/sync/merge-engine');
const { CausalOrderQueue } = require('../electron/sync/causal-order');
const { serializePayload }  = require('../electron/sync/mutation-writer');

// ── Config ────────────────────────────────────────────────────────────────────

const SYNC_URL = (process.env.ETHER_SYNC_URL || '').replace(/\/$/, '');
const LICENSE  = process.env.ETHER_LICENSE_KEY || '';

if (!SYNC_URL || !LICENSE) {
  console.log('');
  console.log('  SKIP — ETHER_SYNC_URL and ETHER_LICENSE_KEY not set.');
  console.log('');
  console.log('  Run with:');
  console.log('    ETHER_SYNC_URL=https://ether-backend-production.up.railway.app \\');
  console.log('    ETHER_LICENSE_KEY=ETH-PRO-XXXX-XXXX-XXXX \\');
  console.log('    node_modules/.bin/electron --no-sandbox scripts/sync-test-transport.js');
  console.log('');
  process.exit(0);
}

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
async function test(id, label, fn) {
  try {
    const result = await fn();
    if (result === false) fail(id, label, 'returned false');
    else pass(id, label);
  } catch (e) {
    fail(id, label, e.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function httpRequest(method, path, body, key) {
  if (key === undefined) key = LICENSE;
  const url     = SYNC_URL + path;
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['x-license-key'] = key;
  const res = await fetch(url, {
    method,
    headers,
    body: body !== null && body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

function createTransportDb() {
  const db = new Database(':memory:');
  const clientId = crypto.randomUUID();
  db.exec(`
    CREATE TABLE system_state (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at TEXT
    );
    CREATE TABLE station_config_kv (
      id         INTEGER PRIMARY KEY,
      key        TEXT NOT NULL,
      value      TEXT,
      station_id TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE client_identity (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      client_id  TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE schema_version (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT
    );
    CREATE TABLE mutations (
      id                  TEXT PRIMARY KEY,
      client_id           TEXT NOT NULL,
      station_id          TEXT,
      actor_id            TEXT,
      table_name          TEXT NOT NULL,
      row_id              TEXT NOT NULL,
      op                  TEXT NOT NULL,
      payload_before      TEXT,
      payload_after       TEXT,
      created_at          TEXT NOT NULL,
      applied_at          TEXT NOT NULL,
      hlc                 TEXT NOT NULL,
      parent_mutation_id  TEXT,
      schema_version      INTEGER NOT NULL,
      origin              TEXT NOT NULL,
      sync_status         TEXT NOT NULL,
      conflict_resolution TEXT
    );
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
  db.prepare('INSERT INTO client_identity (id, client_id, created_at) VALUES (1, ?, ?)').run(
    clientId, new Date().toISOString()
  );
  db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (12, ?)').run(new Date().toISOString());
  db.prepare("INSERT INTO system_state (key, value, updated_at) VALUES ('hlc_last', ?, ?)").run(
    `0:0:${clientId}`, new Date().toISOString()
  );
  return { db, clientId };
}

function makeTestMutation(clientId, testStation, overrides) {
  const rowId = (overrides && overrides.row_id) ? overrides.row_id : crypto.randomUUID();
  const wall  = Date.now();
  const base  = {
    id:                  crypto.randomUUID(),
    client_id:           clientId,
    station_id:          testStation,
    actor_id:            null,
    table_name:          'songs',
    row_id:              rowId,
    op:                  'insert',
    payload_before:      null,
    payload_after:       { uuid: rowId, title: 'Test Song ' + rowId.slice(0, 8) },
    created_at:          new Date().toISOString(),
    hlc:                 `${wall}:0:${clientId}`,
    parent_mutation_id:  null,
    schema_version:      12,
    conflict_resolution: null,
  };
  return Object.assign({}, base, overrides || {});
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Unique station_id for this test run — isolates from real data
  const TEST_STATION = crypto.randomUUID();
  console.log('\n[sync-test-transport] Test station_id:', TEST_STATION);
  console.log('[sync-test-transport] Backend:', SYNC_URL);

  // ── A. Auth tests ───────────────────────────────────────────────────────────

  section('A. Auth tests');

  await test('T-A1', 'Missing license key → 401', async () => {
    const r = await httpRequest('GET', '/sync/mutations?client_id=test', null, '');
    if (r.status !== 401) throw new Error('Expected 401, got ' + r.status);
  });

  await test('T-A2', 'Wrong license key → 401 or 403', async () => {
    const r = await httpRequest('GET', '/sync/mutations?client_id=test', null, 'ETH-PRO-XXXX-XXXX-XXXX');
    if (r.status !== 401 && r.status !== 403) throw new Error('Expected 401/403, got ' + r.status);
  });

  await test('T-A3', 'Valid license key → 200 (pull with no prior data for test station)', async () => {
    const clientId = crypto.randomUUID();
    const r = await httpRequest(
      'GET',
      `/sync/mutations?client_id=${clientId}&station_id=${TEST_STATION}&since_seq=0`
    );
    if (!r.ok) throw new Error('Expected 200, got ' + r.status + ' ' + JSON.stringify(r.data));
    if (!Array.isArray(r.data.mutations)) throw new Error('mutations not an array');
    if (r.data.mutations.length !== 0)    throw new Error('Expected 0 mutations for fresh test station');
  });

  // ── B. Push tests ───────────────────────────────────────────────────────────

  section('B. Push tests');

  const CLIENT_A = crypto.randomUUID();
  const PUSH_MUTATIONS = [
    makeTestMutation(CLIENT_A, TEST_STATION),
    makeTestMutation(CLIENT_A, TEST_STATION),
    makeTestMutation(CLIENT_A, TEST_STATION),
    makeTestMutation(CLIENT_A, TEST_STATION),
    makeTestMutation(CLIENT_A, TEST_STATION),
  ];

  await test('T-B1', 'Push 5 mutations → all accepted', async () => {
    const r = await httpRequest('POST', '/sync/mutations', {
      client_id:  CLIENT_A,
      station_id: TEST_STATION,
      batch:      PUSH_MUTATIONS,
    });
    if (!r.ok) throw new Error('Push failed: ' + r.status + ' ' + JSON.stringify(r.data));
    const { accepted, rejected } = r.data;
    if (accepted.length !== 5) throw new Error('accepted=' + accepted.length + ', expected 5');
    if (rejected.length !== 0) throw new Error('rejected=' + rejected.length + ', expected 0');
    const sentIds = new Set(PUSH_MUTATIONS.map(m => m.id));
    for (const id of accepted) {
      if (!sentIds.has(id)) throw new Error('Accepted id not in sent batch: ' + id);
    }
  });

  await test('T-B2', 'Push same 5 mutations again → idempotent (all accepted, one DB copy)', async () => {
    const r = await httpRequest('POST', '/sync/mutations', {
      client_id:  CLIENT_A,
      station_id: TEST_STATION,
      batch:      PUSH_MUTATIONS,
    });
    if (!r.ok) throw new Error('Push failed: ' + r.status);
    const { accepted, rejected } = r.data;
    // ON CONFLICT DO NOTHING: duplicate UUIDs still get listed as accepted
    if (accepted.length !== 5) throw new Error('accepted=' + accepted.length + ', expected 5 (idempotent)');
    if (rejected.length !== 0) throw new Error('rejected=' + rejected.length);

    // Verify pull returns exactly 5, not 10 (one copy per UUID)
    const CLIENT_VERIFY = crypto.randomUUID();
    const pullR = await httpRequest(
      'GET',
      `/sync/mutations?client_id=${CLIENT_VERIFY}&station_id=${TEST_STATION}&since_seq=0`
    );
    if (!pullR.ok) throw new Error('Verify pull failed: ' + pullR.status);
    const sentIds = new Set(PUSH_MUTATIONS.map(m => m.id));
    const ourMuts = pullR.data.mutations.filter(m => sentIds.has(m.id));
    if (ourMuts.length !== 5) throw new Error('Expected 5 unique stored mutations, got ' + ourMuts.length);
  });

  await test('T-B3', 'Push install_secrets_kv mutation → rejected by backend (defense-in-depth)', async () => {
    const secretMutation = makeTestMutation(CLIENT_A, TEST_STATION, {
      table_name:    'install_secrets_kv',
      op:            'insert',
      payload_after: { uuid: crypto.randomUUID(), key: 'license_key', value: 'SHOULD_NOT_STORE' },
    });
    const r = await httpRequest('POST', '/sync/mutations', {
      client_id:  CLIENT_A,
      station_id: TEST_STATION,
      batch:      [secretMutation],
    });
    if (!r.ok) throw new Error('Push failed: ' + r.status);
    const { accepted, rejected } = r.data;
    if (accepted.includes(secretMutation.id))
      throw new Error('install_secrets_kv was accepted — backend defense-in-depth failed');
    if (!rejected.some(rej => rej.id === secretMutation.id))
      throw new Error('install_secrets_kv not in rejected list');
  });

  await test('T-B4', 'Push empty batch → ok, 0 accepted, 0 rejected', async () => {
    const r = await httpRequest('POST', '/sync/mutations', {
      client_id:  CLIENT_A,
      station_id: TEST_STATION,
      batch:      [],
    });
    if (!r.ok) throw new Error('Push failed: ' + r.status);
    if (r.data.accepted.length !== 0) throw new Error('Expected 0 accepted');
    if (r.data.rejected.length !== 0) throw new Error('Expected 0 rejected');
  });

  // ── C. Pull tests ───────────────────────────────────────────────────────────

  section('C. Pull tests');

  const CLIENT_B = crypto.randomUUID();

  await test('T-C1', "Client B pulls → receives Client A's 5 mutations", async () => {
    const r = await httpRequest(
      'GET',
      `/sync/mutations?client_id=${CLIENT_B}&station_id=${TEST_STATION}&since_seq=0`
    );
    if (!r.ok) throw new Error('Pull failed: ' + r.status);
    const { mutations, server_seq } = r.data;
    if (!Array.isArray(mutations)) throw new Error('mutations not an array');
    const sentIds = new Set(PUSH_MUTATIONS.map(m => m.id));
    const received = mutations.filter(m => sentIds.has(m.id));
    if (received.length !== 5)
      throw new Error(`Expected 5 of Client A's mutations, got ${received.length} (total pulled: ${mutations.length})`);
    if (typeof server_seq !== 'number')
      throw new Error('server_seq not a number: ' + JSON.stringify(server_seq));
  });

  await test('T-C2', "Client A does not receive its own mutations", async () => {
    const r = await httpRequest(
      'GET',
      `/sync/mutations?client_id=${CLIENT_A}&station_id=${TEST_STATION}&since_seq=0`
    );
    if (!r.ok) throw new Error('Pull failed: ' + r.status);
    const own = r.data.mutations.filter(m => m.client_id === CLIENT_A);
    if (own.length > 0) throw new Error(`Own mutations in pull response: ${own.length}`);
  });

  await test('T-C3', 'Incremental pull: since_seq advances past already-seen mutations', async () => {
    // Pull to get current server_seq for this test station
    const r1 = await httpRequest(
      'GET',
      `/sync/mutations?client_id=${CLIENT_B}&station_id=${TEST_STATION}&since_seq=0`
    );
    if (!r1.ok) throw new Error('First pull failed: ' + r1.status);
    const seqAfterFirst = r1.data.server_seq;

    // Push one more mutation from Client A
    const newMut = makeTestMutation(CLIENT_A, TEST_STATION);
    const pushR = await httpRequest('POST', '/sync/mutations', {
      client_id: CLIENT_A, station_id: TEST_STATION, batch: [newMut],
    });
    if (!pushR.ok) throw new Error('Push failed: ' + pushR.status);

    // Incremental pull should return exactly the new mutation (and nothing before)
    const r2 = await httpRequest(
      'GET',
      `/sync/mutations?client_id=${CLIENT_B}&station_id=${TEST_STATION}&since_seq=${seqAfterFirst}`
    );
    if (!r2.ok) throw new Error('Incremental pull failed: ' + r2.status);
    const newOnes = r2.data.mutations.filter(m => m.id === newMut.id);
    if (newOnes.length !== 1)
      throw new Error(`Expected 1 new mutation, got ${r2.data.mutations.length} total`);
  });

  // ── D. Two-client round-trip via HttpTransport + MergeEngine ───────────────

  section('D. Two-client round-trip via HttpTransport + MergeEngine');

  await test('T-D1', 'Full round-trip: A pushes via transport, B pulls and applies via merge-engine', async () => {
    const { db: dbA, clientId: cidA } = createTransportDb();
    const { db: dbB, clientId: cidB } = createTransportDb();

    const transportA = new HttpTransport(dbA, { baseUrl: SYNC_URL, licenseKey: LICENSE });
    const transportB = new HttpTransport(dbB, { baseUrl: SYNC_URL, licenseKey: LICENSE });

    const songUuid = crypto.randomUUID();
    const now      = new Date().toISOString();
    const wall     = Date.now();

    const songRow = {
      id: null, uuid: songUuid, title: 'Round Trip Song', file_path: null,
      artist_id: null, album_id: null, category_id: null, genre: null,
      duration_ms: null, bpm: null, energy: null, mood: null, gender: null,
      rotation_status: null, daypart_mask: null, no_repeat_hours: null,
      lufs_measured: null, peak_db: null, gain_db: null,
      is_processed: 0, cue_in: null, cue_out: null, cue_in_ms: null, cue_out_ms: null,
      intro_end: null, outro_start: null, intro_end_ms: null, outro_start_ms: null,
      intro_version_path: null, has_intro: 0, last_played_at: null, play_count: 0,
      is_explicit: 0, created_at: now, updated_at: now,
      raw_metadata: null, spotify_uri: null, deleted_at: null,
    };

    const wireMut = {
      id:                  crypto.randomUUID(),
      client_id:           cidA,
      station_id:          TEST_STATION,
      actor_id:            null,
      table_name:          'songs',
      row_id:              songUuid,
      op:                  'insert',
      payload_before:      null,
      payload_after:       serializePayload(songRow, 'songs'),
      created_at:          now,
      hlc:                 `${wall}:0:${cidA}`,
      parent_mutation_id:  null,
      schema_version:      12,
      conflict_resolution: null,
    };

    // A pushes via HttpTransport
    const pushResult = await transportA.push({
      client_id:  cidA,
      station_id: TEST_STATION,
      batch:      [wireMut],
    });
    if (!pushResult.accepted.includes(wireMut.id))
      throw new Error('Transport push: mutation not accepted — ' + JSON.stringify(pushResult));

    // B pulls via HttpTransport
    const pullResult = await transportB.pull({
      client_id:  cidB,
      station_id: TEST_STATION,
      cursor:     {},
    });
    if (!Array.isArray(pullResult.mutations))
      throw new Error('Transport pull: mutations not an array');

    const received = pullResult.mutations.find(m => m.id === wireMut.id);
    if (!received) throw new Error(
      'Pushed mutation not found in B pull result ' +
      '(pulled ' + pullResult.mutations.length + ' total)'
    );

    // Apply to B's DB via MergeEngine
    const causalQueue = new CausalOrderQueue();
    const engine = new MergeEngine(dbB, {
      localSchemaVersion: 12,
      causalQueue,
      onCursorAdvance: () => {},
    });

    const outcome = engine.apply(received);
    if (outcome !== 'applied' && outcome !== 'loser')
      throw new Error('Merge engine outcome: ' + outcome + ' (expected applied or loser)');

    // Verify song is in B's live table
    const live = dbB.prepare('SELECT title FROM songs WHERE uuid = ?').get(songUuid);
    if (!live) throw new Error('Song not in B songs table after apply');
    if (live.title !== 'Round Trip Song') throw new Error('title=' + live.title);

    // Verify server_seq was persisted in B's DB
    const seqRow = dbB.prepare("SELECT value FROM system_state WHERE key = 'sync_server_seq'").get();
    if (!seqRow || parseInt(seqRow.value, 10) <= 0)
      throw new Error('server_seq not persisted in B DB: ' + JSON.stringify(seqRow));
  });

  // ── E. Retention ────────────────────────────────────────────────────────────

  section('E. Retention');

  await test('T-E1', 'Backend retains mutations indefinitely — mutation present after push', async () => {
    const cid  = crypto.randomUUID();
    const mut  = makeTestMutation(cid, TEST_STATION);
    const push = await httpRequest('POST', '/sync/mutations', {
      client_id: cid, station_id: TEST_STATION, batch: [mut],
    });
    if (!push.ok) throw new Error('Push failed: ' + push.status);
    if (!push.data.accepted.includes(mut.id)) throw new Error('Not accepted by server');

    // Different client pulls — must find the mutation
    const puller = crypto.randomUUID();
    const pull   = await httpRequest(
      'GET',
      `/sync/mutations?client_id=${puller}&station_id=${TEST_STATION}&since_seq=0`
    );
    if (!pull.ok) throw new Error('Pull failed: ' + pull.status);
    const found = pull.data.mutations.find(m => m.id === mut.id);
    if (!found)
      throw new Error('Mutation not found in pull (backend must retain forever per §22 [N-119])');
  });

  // ── Final report ─────────────────────────────────────────────────────────────

  console.log('\n' + '═'.repeat(72));
  console.log(`sync-test-transport results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.error('  ✗ ' + f);
  }
  console.log('═'.repeat(72));
  console.log('\n[sync-test-transport] Test station_id (accumulates on backend, safe to ignore):', TEST_STATION);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('[sync-test-transport] Unexpected error:', e.message);
  process.exit(1);
});
