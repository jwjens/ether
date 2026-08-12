'use strict';
// electron/smoke-designation-write.js — proves the designation record can actually be WRITTEN.
//
// Run:  cross-env ELECTRON_RUN_AS_NODE=1 electron electron/smoke-designation-write.js
//       (npm run test:designation)
//
// WHY ELECTRON: better-sqlite3 is compiled for Electron's Node ABI. Same reason as
// scripts/run-sync-tests.js — system Node cannot load the binding.
//
// WHY THIS EXISTS AT ALL:
// From 4.4.188 to 4.4.192 `designated_generator` was written by a hand-rolled INSERT in main.js that
// omitted `uuid`. That column is NOT NULL with no default, so the statement threw on EVERY machine,
// on EVERY tick, and the caller's try/catch swallowed it. Zero designation rows existed anywhere and
// the Health Monitor showed a serene "None". Nothing in the type checker, the unit tests, or a code
// read catches that — only a real write against the real schema does.
//
// This is the fourth silent-write defect in this one table (auto_generate_enabled, schedule_layout_v1,
// grid_widths_*, designated_generator). The pattern is always the same: the write is refused or
// throws, nobody reads the verdict, and the UI renders the absent value as a legitimate state.

const Database = require('better-sqlite3');
const path     = require('path');
const os       = require('os');
const fs       = require('fs');

const {
  stationConfigKvUpsertByKey,
  stationConfigKvSetLocal,
  isLocalOnlyKey,
} = require('./sync/handlers/station_config_kv');
const _desig = require('./generation-designation');

let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); return; }
  failures++;
  console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`);
}

// ── A DB with the LIVE schema, not a convenient one ─────────────────────────────────────────────
// station_config_kv is copied verbatim from the shipping install (verified 2026-08-12 against
// %LOCALAPPDATA%\Ether\com.ether.radio\openair.db). The NOT NULL on `uuid` and the PK on
// (station_id, key) are the whole point of this test — a relaxed schema here would pass while the
// product fails.
const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ether-desig-')), 'smoke.db');
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE station_config_kv (
    station_id INTEGER NOT NULL,
    key        TEXT    NOT NULL,
    value      TEXT,
    uuid       TEXT    NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch()),
    deleted_at INTEGER,
    station_uuid TEXT,
    PRIMARY KEY (station_id, key)
  );
  CREATE UNIQUE INDEX idx_station_config_kv_uuid ON station_config_kv(uuid);

  CREATE TABLE client_identity (id INTEGER PRIMARY KEY, client_id TEXT NOT NULL, created_at TEXT, label TEXT);
  CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
  CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT);
  CREATE TABLE mutations (
    id TEXT PRIMARY KEY, client_id TEXT, station_id TEXT, actor_id TEXT,
    table_name TEXT, row_id TEXT, op TEXT,
    payload_before TEXT, payload_after TEXT,
    created_at TEXT, applied_at TEXT, hlc TEXT,
    parent_mutation_id TEXT, schema_version INTEGER,
    origin TEXT, sync_status TEXT, conflict_resolution TEXT
  );

  INSERT INTO client_identity (id, client_id) VALUES (1, '11111111-2222-3333-4444-555555555555');
  INSERT INTO system_state (key, value) VALUES ('hlc_last', '1745000000000:0:11111111-2222-3333-4444-555555555555');
  INSERT INTO schema_version (version) VALUES (30);
`);

const ST = 1;
console.log('\n=== designation write smoke ===\n');

// 1. THE ORIGINAL DEFECT, pinned. If this ever stops throwing the schema changed underneath us and
//    the rest of this test is measuring something else.
console.log('[1] the 4.4.188 hand-rolled INSERT is still impossible against this schema');
let rawErr = null;
try {
  db.prepare(`INSERT INTO station_config_kv (station_id, key, value, created_at, updated_at)
              VALUES (?,?,?,datetime('now'),datetime('now'))
              ON CONFLICT(station_id,key) DO UPDATE SET value=excluded.value`).run(ST, 'raw_probe', 'x');
} catch (e) { rawErr = e.message; }
check('a raw INSERT that omits uuid throws', rawErr !== null, 'it succeeded — schema drifted');
check('and it throws on uuid, NOT on the conflict target',
  !!rawErr && /NOT NULL/i.test(rawErr) && /uuid/i.test(rawErr),
  `actual: ${rawErr}`);

// 2. The sanctioned writer, which is what the fix uses.
console.log('\n[2] stationConfigKvUpsertByKey writes designated_generator');
const rec1 = _desig.nextRecord({ record: null, now: 1000, machineId: 'machine-A', machineName: 'BOOTH-1', generated: true });
stationConfigKvUpsertByKey(db, ST, _desig.KEY, rec1);
const row1 = db.prepare('SELECT * FROM station_config_kv WHERE station_id=? AND key=?').get(ST, _desig.KEY);
check('the row exists', !!row1, 'no row — this is the shipped bug');
check('uuid is populated', !!(row1 && row1.uuid));
check('the record round-trips', !!(row1 && _desig.parseRecord(row1.value)?.machine_id === 'machine-A'));

// 3. Second tick UPDATES in place — a designation that duplicated per tick would be its own defect.
console.log('\n[3] a second tick stamps the same row rather than adding another');
const rec2 = _desig.nextRecord({ record: _desig.parseRecord(row1.value), now: 2000, machineId: 'machine-A', machineName: 'BOOTH-1', generated: false });
stationConfigKvUpsertByKey(db, ST, _desig.KEY, rec2);
const all = db.prepare('SELECT * FROM station_config_kv WHERE station_id=? AND key=?').all(ST, _desig.KEY);
check('exactly one row', all.length === 1, `found ${all.length}`);
const after = _desig.parseRecord(all[0].value);
check('last_checked advanced', after?.last_checked === 2000);
check('designated_at is preserved across the stamp', after?.designated_at === 1000);
check('last_generated is NOT clobbered by a non-generating tick', after?.last_generated === 1000);

// 4. It must SYNC. Designation exists to tell two machines apart; a local-only record cannot.
console.log('\n[4] the designation record syncs, and the kill switch does not');
check('designated_generator is not a local-only key', isLocalOnlyKey(_desig.KEY) === false);
const desigMuts = db.prepare("SELECT * FROM mutations WHERE table_name='station_config_kv'").all()
  .filter(m => { try { return JSON.parse(m.payload_after || m.payload_before || '{}').key === _desig.KEY; } catch { return false; } });
check('writing it logged a mutation (so it can sync)', desigMuts.length === 2, `logged ${desigMuts.length}, expected insert+update`);

// 5. THE TRAP. kill_designation IS local-only, and upsertByKey SILENTLY SKIPS local-only keys —
//    it returns {ok:true}. Routing the kill switch through the same writer as the designation record
//    would have turned an emergency bypass into a no-op that reports success.
console.log('\n[5] kill_designation goes through setLocal, never upsertByKey');
check('kill_designation is a local-only key', isLocalOnlyKey('kill_designation') === true);
const skipped = stationConfigKvUpsertByKey(db, ST, 'kill_designation', '1');
check('upsertByKey REFUSES it (and would have silently done nothing)', !!(skipped && skipped.skippedLocalOnly));
check('...leaving no row behind', !db.prepare("SELECT 1 FROM station_config_kv WHERE station_id=? AND key='kill_designation'").get(ST));
stationConfigKvSetLocal(db, ST, 'kill_designation', '1');
const killRow = db.prepare("SELECT * FROM station_config_kv WHERE station_id=? AND key='kill_designation'").get(ST);
check('setLocal writes it', !!(killRow && killRow.value === '1'));
check('setLocal populated uuid too', !!(killRow && killRow.uuid));
const killMuts = db.prepare("SELECT * FROM mutations").all()
  .filter(m => { try { return JSON.parse(m.payload_after || '{}').key === 'kill_designation'; } catch { return false; } });
check('and logged NO mutation — a synced kill switch would disable ownership everywhere', killMuts.length === 0);

db.close();
try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch {}

console.log(`\n=== ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`} ===\n`);
process.exit(failures === 0 ? 0 : 1);
