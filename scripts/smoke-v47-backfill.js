'use strict';
// scripts/smoke-v47-backfill.js — prove the v47 backfill against REAL announcement rows.
//
// The transformer-chain verifier runs v47 on a fresh-install DB, which has no announcements, so it
// proves the migration applies but NOT that it carries a schedule forward. This builds a throwaway DB
// with announcements in it — including the awkward ones — and asserts every live row became exactly
// one weekday entry with its days/type/time/offset and its last_played_at intact.
//
// THE POINT OF THE MIGRATION IS THAT NOTHING CHANGES. That claim needs a receipt.
//
// Throwaway DB in the OS temp dir. Never touches the live openair.db.
//   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/smoke-v47-backfill.js

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const { applyMigration } = require('./migrate-announcement-schedule-phase-sync-47.js');

const dbPath = path.join(os.tmpdir(), `ether-v47-smoke-${process.pid}.db`);
try { fs.unlinkSync(dbPath); } catch {}
const db = new Database(dbPath);

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? '' : `\n         got:  ${JSON.stringify(got)}\n         want: ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

console.log('=== smoke-v47-backfill ===');
console.log('temp DB:', dbPath);

db.prepare('CREATE TABLE schema_version (version INTEGER PRIMARY KEY)').run();
for (let v = 1; v <= 46; v++) db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(v);

db.prepare(`
  CREATE TABLE announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, file_path TEXT,
    trigger_time TEXT, days TEXT DEFAULT '0123456', duck_music INTEGER DEFAULT 1,
    resume_music INTEGER DEFAULT 1, duck_level REAL DEFAULT 0.2, is_active INTEGER DEFAULT 1,
    last_played_at INTEGER, created_at INTEGER, station_id INTEGER NOT NULL DEFAULT 1,
    uuid TEXT, updated_at TEXT, deleted_at TEXT, trigger_type TEXT DEFAULT 'absolute',
    close_offset_min INTEGER DEFAULT 0
  )`).run();

const ins = db.prepare(
  `INSERT INTO announcements (title, days, trigger_time, trigger_type, close_offset_min,
     last_played_at, station_id, uuid, is_active, deleted_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

// 1 a plain absolute row · 2 a close-offset row · 3 a multi-day row with a fire stamp
// 4 an INACTIVE row (still scheduled — is_active gates at fire time, not in the schedule)
// 5 a SOFT-DELETED row (must NOT be carried forward) · 6 a row with NO uuid (unschedulable, skipped)
ins.run('Absolute',   '0123456', '17:30:00', 'absolute',      0, null,       1, 'u-abs',   1, null);
ins.run('Close-15',   '12345',   null,       'close_offset', 15, null,       1, 'u-close', 1, null);
ins.run('Fri+Sat',    '56',      '20:45:30', 'absolute',      0, 1756000000, 1, 'u-frisat',1, null);
ins.run('Inactive',   '0123456', '08:00:00', 'absolute',      0, null,       1, 'u-inact', 0, null);
ins.run('Deleted',    '0123456', '09:00:00', 'absolute',      0, null,       1, 'u-del',   1, '2026-08-01T00:00:00Z');
ins.run('No uuid',    '0123456', '10:00:00', 'absolute',      0, null,       1, null,      1, null);

applyMigration(db);

const entries = db.prepare('SELECT * FROM announcement_schedule ORDER BY announcement_uuid').all();
const byAnn   = Object.fromEntries(entries.map(e => [e.announcement_uuid, e]));

console.log('\n── counts ──');
// 5 live rows, one of which has no uuid → 4 entries. The soft-deleted row is not carried forward.
check('one entry per live, uuid-bearing announcement', entries.length, 4);
check('soft-deleted announcement carried no entry', !!byAnn['u-del'], false);
check('uuid-less announcement carried no entry', Object.keys(byAnn).length, 4);
check('INACTIVE announcement still got an entry (is_active gates at fire time)', !!byAnn['u-inact'], true);

console.log('\n── the schedule survived verbatim ──');
check('absolute: days',        byAnn['u-abs'].days,             '0123456');
check('absolute: trigger_time',byAnn['u-abs'].trigger_time,     '17:30:00');
check('absolute: type',        byAnn['u-abs'].trigger_type,     'absolute');
check('close-offset: type',    byAnn['u-close'].trigger_type,   'close_offset');
check('close-offset: minutes', byAnn['u-close'].close_offset_min, 15);
check('close-offset: days',    byAnn['u-close'].days,           '12345');
check('Fri+Sat: days set',     byAnn['u-frisat'].days,          '56');
check('Fri+Sat: seconds kept', byAnn['u-frisat'].trigger_time,  '20:45:30');

console.log('\n── the double-fire guard state came across ──');
check('last_played_at carried', byAnn['u-frisat'].last_played_at, 1756000000);
check('null last_played_at stays null', byAnn['u-abs'].last_played_at, null);

console.log('\n── shape ──');
check('every entry is weekday-scoped', [...new Set(entries.map(e => e.scope))], ['weekday']);
check('no entry has a date', entries.every(e => e.date === null), true);
check('every entry has a uuid', entries.every(e => !!e.uuid), true);
check('every entry has a station', entries.every(e => e.station_id === 1), true);

console.log('\n── idempotency ──');
applyMigration(db);
check('re-running v47 creates no duplicates', db.prepare('SELECT COUNT(*) n FROM announcement_schedule').get().n, 4);

console.log('\n──────────────────────────────');
console.log(`  Passed: ${pass}  Failed: ${fail}`);
console.log(`  VERDICT: ${fail === 0 ? 'PASS' : 'FAIL'}`);
console.log('──────────────────────────────');

db.close();
try { fs.unlinkSync(dbPath); } catch {}
process.exit(fail === 0 ? 0 : 1);
