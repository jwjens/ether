'use strict';
// scripts/smoke-v49-drop.js — prove v49 removes date_closing_times cleanly.
//
// Dropping a SYNCED table is a real change, not a tidy-up: the table has a registry entry, a handler
// and an outbound journal, and getting any of that half-removed leaves either a crash or a permanent
// stream of rejected mutations at every peer. So it gets a receipt.
//
//   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/smoke-v49-drop.js

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const { applyMigration } = require('./migrate-drop-date-closing-phase-sync-49.js');

const dbPath = path.join(os.tmpdir(), `ether-v49-smoke-${process.pid}.db`);
try { fs.unlinkSync(dbPath); } catch {}
const db = new Database(dbPath);

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? '' : `\n         got:  ${JSON.stringify(got)}\n         want: ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};
const has = (t) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);

console.log('=== smoke-v49-drop ===');
db.prepare('CREATE TABLE schema_version (version INTEGER PRIMARY KEY)').run();
for (let v = 1; v <= 48; v++) db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(v);

db.prepare(`CREATE TABLE date_closing_times (
  id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, closing_time TEXT,
  station_id INTEGER, uuid TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT)`).run();
db.prepare("INSERT INTO date_closing_times (date, closing_time, station_id, uuid) VALUES ('2026-12-25','18:00:00',2,'u1')").run();
db.prepare("INSERT INTO date_closing_times (date, closing_time, station_id, uuid) VALUES ('2026-12-31','23:00:00',2,'u2')").run();

// The outbound journal, with rows for this table AND for others that must survive untouched.
db.prepare(`CREATE TABLE mutations (id TEXT PRIMARY KEY, table_name TEXT, row_id TEXT)`).run();
const im = db.prepare("INSERT INTO mutations (id, table_name, row_id) VALUES (?, ?, ?)");
im.run('m1', 'date_closing_times', 'u1');
im.run('m2', 'date_closing_times', 'u2');
im.run('m3', 'announcements', 'a1');
im.run('m4', 'announcement_schedule', 's1');
im.run('m5', 'songs', 'g1');

// A neighbouring table that must not be disturbed.
db.prepare('CREATE TABLE announcement_schedule (id INTEGER PRIMARY KEY, date TEXT)').run();
db.prepare("INSERT INTO announcement_schedule (date) VALUES ('2026-10-31')").run();

check('precondition: the table exists', has('date_closing_times'), true);

applyMigration(db);

console.log('\n── the table is gone ──');
check('date_closing_times dropped', has('date_closing_times'), false);
check('v49 recorded', db.prepare('SELECT 1 FROM schema_version WHERE version=49').get() ? true : false, true);

console.log('\n── the orphaned sync journal is gone, and nothing else is ──');
check('no mutations left for the dropped table',
  db.prepare("SELECT COUNT(*) n FROM mutations WHERE table_name='date_closing_times'").get().n, 0);
check('OTHER tables\' mutations untouched',
  db.prepare("SELECT id FROM mutations ORDER BY id").all().map(r => r.id), ['m3', 'm4', 'm5']);

console.log('\n── neighbours untouched ──');
check('announcement_schedule still exists', has('announcement_schedule'), true);
check('announcement_schedule still holds its row',
  db.prepare('SELECT COUNT(*) n FROM announcement_schedule').get().n, 1);

console.log('\n── the registry no longer carries it ──');
const reg = require(path.join(__dirname, '..', 'electron', 'sync', 'synced-tables.js'));
check('absent from SYNCED_TABLES', (reg.SYNCED_TABLES || []).includes('date_closing_times'), false);
check('absent from REGISTRY', !!(reg.REGISTRY || {})['date_closing_times'], false);
check('the handler file is gone',
  fs.existsSync(path.join(__dirname, '..', 'electron', 'sync', 'handlers', 'date_closing_times.js')), false);

console.log('\n── idempotency ──');
applyMigration(db);
check('re-running is a no-op', has('date_closing_times'), false);
check('and does not disturb other mutations',
  db.prepare("SELECT COUNT(*) n FROM mutations").get().n, 3);

console.log('\n──────────────────────────────');
console.log(`  Passed: ${pass}  Failed: ${fail}`);
console.log(`  VERDICT: ${fail === 0 ? 'PASS' : 'FAIL'}`);
console.log('──────────────────────────────');

db.close();
try { fs.unlinkSync(dbPath); } catch {}
process.exit(fail === 0 ? 0 : 1);
