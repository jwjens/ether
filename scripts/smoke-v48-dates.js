'use strict';
// scripts/smoke-v48-dates.js — prove v48 converts weekday-scoped entries to real dates.
//
// The chain verifier runs v48 on a fresh DB, which has no weekday entries, so it proves the
// migration applies but NOT that it carries a working schedule across. This builds a throwaway DB
// holding the shape Jeff's live install actually has — five weekday=Wednesday entries — and asserts
// each one lands on a real calendar date with its announcement, its time and its guard state intact.
//
// THE POINT OF THE MIGRATION IS THAT A LIVE SCHEDULE IS NOT STRANDED. That needs a receipt.
//
//   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/smoke-v48-dates.js

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const { applyMigration } = require('./migrate-announcement-dates-phase-sync-48.js');

const dbPath = path.join(os.tmpdir(), `ether-v48-smoke-${process.pid}.db`);
try { fs.unlinkSync(dbPath); } catch {}
const db = new Database(dbPath);

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? '' : `\n         got:  ${JSON.stringify(got)}\n         want: ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

console.log('=== smoke-v48-dates ===');
db.prepare('CREATE TABLE schema_version (version INTEGER PRIMARY KEY)').run();
for (let v = 1; v <= 47; v++) db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(v);

db.prepare(`
  CREATE TABLE announcement_schedule (
    id INTEGER PRIMARY KEY AUTOINCREMENT, station_id INTEGER, uuid TEXT,
    announcement_uuid TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'weekday',
    days TEXT, date TEXT, trigger_type TEXT NOT NULL DEFAULT 'absolute', trigger_time TEXT,
    close_offset_min INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
    last_played_at INTEGER, created_at TEXT, updated_at TEXT, deleted_at TEXT
  )`).run();

const ins = db.prepare(
  `INSERT INTO announcement_schedule (station_id, uuid, announcement_uuid, scope, days, date,
     trigger_type, trigger_time, last_played_at, deleted_at)
   VALUES (2, ?, ?, ?, ?, ?, 'absolute', ?, ?, ?)`);

// The live shape: five Wednesday entries. Plus a Fri+Sat set, an already-dated row, and a
// soft-deleted row — the cases that must each behave differently.
ins.run('e1', 'a-30min',  'weekday', '3',  null,         '10:00:12', 1787763612, null);
ins.run('e2', 'a-15min',  'weekday', '3',  null,         '10:15:00', 1787764500, null);
ins.run('e3', 'a-outro',  'weekday', '3',  null,         '10:28:00', 1787765280, null);
ins.run('e4', 'a-closed', 'weekday', '3',  null,         '10:30:00', 1787765400, null);
ins.run('e5', 'a-intro',  'weekday', '3',  null,         '11:45:00', 1787759101, null);
ins.run('e6', 'a-wknd',   'weekday', '56', null,         '20:00:00', null,       null);
ins.run('e7', 'a-fixed',  'date',    null, '2026-10-31', '21:00:00', null,       null);
ins.run('e8', 'a-gone',   'weekday', '3',  null,         '09:00:00', null,       '2026-08-01T00:00:00Z');

applyMigration(db);

const rows = db.prepare('SELECT * FROM announcement_schedule ORDER BY uuid').all();
const by   = Object.fromEntries(rows.map(r => [r.uuid, r]));

const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
const dowOf  = (d) => new Date(Number(d.slice(0,4)), Number(d.slice(5,7)) - 1, Number(d.slice(8,10))).getDay();
const todayStr = (() => { const n = new Date(); return n.getFullYear() + '-' + String(n.getMonth()+1).padStart(2,'0') + '-' + String(n.getDate()).padStart(2,'0'); })();

console.log('\n── nothing is left weekday-scoped (it could never fire) ──');
check('no live weekday rows remain', rows.filter(r => r.scope === 'weekday' && !r.deleted_at).length, 0);

console.log('\n── the five Wednesday entries became real Wednesday dates ──');
for (const u of ['e1', 'e2', 'e3', 'e4', 'e5']) {
  check(`${u}: has a real date`, isDate(by[u].date), true);
  check(`${u}: that date IS a Wednesday`, dowOf(by[u].date), 3);
  check(`${u}: date is today or later`, by[u].date >= todayStr, true);
}
check('all five landed on the SAME Wednesday', [...new Set(['e1','e2','e3','e4','e5'].map(u => by[u].date))].length, 1);

console.log('\n── times and guard state survived verbatim ──');
check('e1 time', by['e1'].trigger_time, '10:00:12');
check('e5 time', by['e5'].trigger_time, '11:45:00');
check('e1 last_played_at', by['e1'].last_played_at, 1787763612);
check('e6 (Fri+Sat) took the FIRST day, a Friday', dowOf(by['e6'].date), 5);

console.log('\n── rows that must not move ──');
check('already-dated row untouched', by['e7'].date, '2026-10-31');
check('soft-deleted row still deleted', !!by['e8'].deleted_at, true);

console.log('\n── idempotency ──');
applyMigration(db);
const after = db.prepare('SELECT COUNT(*) n FROM announcement_schedule').get().n;
check('re-running v48 creates no rows', after, 8);
check('re-running v48 moves nothing', db.prepare("SELECT date FROM announcement_schedule WHERE uuid='e1'").get().date, by['e1'].date);

console.log('\n──────────────────────────────');
console.log(`  Passed: ${pass}  Failed: ${fail}`);
console.log(`  VERDICT: ${fail === 0 ? 'PASS' : 'FAIL'}`);
console.log('──────────────────────────────');

db.close();
try { fs.unlinkSync(dbPath); } catch {}
process.exit(fail === 0 ? 0 : 1);
