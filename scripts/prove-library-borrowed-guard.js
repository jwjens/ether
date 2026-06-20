'use strict';
// scripts/prove-library-borrowed-guard.js
//
// Proves the desktop LIBRARY-BORROWED writer guard in electron/sync/mutation-writer.js.
// Exercises the REAL withMutation() against a fully-seeded in-memory better-sqlite3 DB.
//
// Boundary under test: when install_config_kv.library_borrowed is set, LOCAL writes to the
// install-scoped CATALOG (songs/artists/albums) are rejected; STATION-scoped tables
// (categories/station_programming/song_metadata_values) are ALWAYS allowed; and with the flag
// OFF every table writes normally.
//
// Run:  ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/prove-library-borrowed-guard.js

const path = require('path');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const { withMutation, _resetForTest } = require(path.join(__dirname, '..', 'electron', 'sync', 'mutation-writer'));

const CATALOG  = ['songs', 'artists', 'albums'];                                   // install-scoped → frozen when borrowed
const STATION  = ['categories', 'station_programming', 'song_metadata_values'];    // station-scoped → always editable

const db = new Database(':memory:');
_resetForTest();

// ── Seed the machinery withMutation/logMutation require ───────────────────────
db.exec(`
  CREATE TABLE schema_version (version INTEGER);
  INSERT INTO schema_version (version) VALUES (22);

  CREATE TABLE client_identity (client_id TEXT);
  INSERT INTO client_identity (client_id) VALUES ('11111111-1111-1111-1111-111111111111');

  CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
  INSERT INTO system_state (key, value, updated_at)
    VALUES ('hlc_last', '1745000000000:0:11111111-1111-1111-1111-111111111111', '2026-01-01T00:00:00.000Z');

  CREATE TABLE install_config_kv (key TEXT PRIMARY KEY, value TEXT, deleted_at TEXT);

  CREATE TABLE mutations (
    id TEXT PRIMARY KEY, client_id TEXT, station_id TEXT, actor_id TEXT,
    table_name TEXT, row_id TEXT, op TEXT, payload_before TEXT, payload_after TEXT,
    created_at TEXT, applied_at TEXT, hlc TEXT, parent_mutation_id TEXT,
    schema_version INTEGER, origin TEXT, sync_status TEXT, conflict_resolution TEXT
  );
`);
for (const t of [...CATALOG, ...STATION]) db.exec(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY, uuid TEXT, station_id TEXT)`);

function setBorrowed(on) {
  db.prepare(`INSERT INTO install_config_kv (key, value, deleted_at) VALUES ('library_borrowed', ?, NULL)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value, deleted_at=NULL`).run(on ? '1' : '0');
}

let rowSeq = 0;
// Attempt one local insert through the REAL withMutation. Returns {threw, msg, rowWritten, mutationWritten}.
function attemptWrite(table) {
  rowSeq += 1;
  const uuid = `row-${table}-${rowSeq}`;
  const station_id = CATALOG.includes(table) ? null : '1';   // install-scoped catalog uses null station_id
  const before = db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
  const mBefore = db.prepare(`SELECT COUNT(*) n FROM mutations`).get().n;
  let threw = false, msg = '';
  try {
    withMutation(
      db,
      { table_name: table, row_id: uuid, op: 'insert', station_id,
        payload_before: null, payload_after: { id: rowSeq, uuid, station_id } },
      () => db.prepare(`INSERT INTO ${table} (id, uuid, station_id) VALUES (?,?,?)`).run(rowSeq, uuid, station_id)
    );
  } catch (e) { threw = true; msg = e.message; }
  return {
    threw, msg,
    rowWritten:      db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n > before,
    mutationWritten: db.prepare(`SELECT COUNT(*) n FROM mutations`).get().n > mBefore,
  };
}

const checks = [];
const pass = (label, cond, detail) => checks.push({ label, ok: !!cond, detail });

// ── Flag OFF: everything writes normally ──────────────────────────────────────
setBorrowed(false);
for (const t of [...CATALOG, ...STATION]) {
  const r = attemptWrite(t);
  pass(`flag OFF: ${t} write ALLOWED (row + mutation logged)`, !r.threw && r.rowWritten && r.mutationWritten, JSON.stringify(r));
}

// ── Flag ON: catalog frozen, station-scoped still editable ────────────────────
setBorrowed(true);
for (const t of CATALOG) {
  const r = attemptWrite(t);
  pass(`flag ON: ${t} write REJECTED (no row, no mutation)`,
       r.threw && /library borrowed/i.test(r.msg) && !r.rowWritten && !r.mutationWritten, JSON.stringify(r));
}
for (const t of STATION) {
  const r = attemptWrite(t);
  pass(`flag ON: ${t} write STILL ALLOWED (grantee's own station data)`,
       !r.threw && r.rowWritten && r.mutationWritten, JSON.stringify(r));
}

console.log('=== LIBRARY-BORROWED WRITER GUARD ASSERTIONS ===');
let allOk = true;
for (const c of checks) { console.log(`   ${c.ok ? 'PASS' : 'FAIL'}  ${c.label}`); if (!c.ok) { allOk = false; console.log(`         detail: ${c.detail}`); } }
console.log('\n=== RESULT:', allOk ? 'GUARD HOLDS — catalog frozen when borrowed, station data always editable ✅' : 'GUARD VIOLATED ❌', '===');
db.close();
process.exit(allOk ? 0 : 1);
