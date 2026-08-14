'use strict';
// scripts/verify-deletion-sweep.js — proves the sweep against a COPY of the live DB.
//
// Runs under Electron's Node because better-sqlite3 is built for Electron's ABI (vitest cannot load
// it, which is why the other unit tests in this tree are pure).
//
// Two parts:
//   A. UNIT — the play_log epoch trap, asserted with a fake db so it needs no file.
//   B. PREDICTION — migrate a copy, backfill the queue from the real 32 soft-deleted songs, force
//      every grace period to have expired, run the sweep, and compare against the predicted
//      4 marked / 2 permanent_shared / 26 pending / 0 unverifiable.
//
// Never touches the live DB. Pass a copy path as argv[2].
//
// Run: ELECTRON_RUN_AS_NODE=1 node_modules\.bin\electron scripts\verify-deletion-sweep.js <copy.db>

const path = require('path');
const sweep = require(path.join(__dirname, '..', 'electron', 'deletion-sweep.js'));

let pass = true;
const check = (label, ok, detail) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) pass = false;
};
const hr = (t) => console.log('\n' + '='.repeat(78) + '\n' + t + '\n' + '='.repeat(78));

hr('A — the play_log epoch trap (no database needed)');
{
  const fake = (max) => ({ prepare: () => ({ get: () => ({ m: max }) }) });
  const NOW = 1_786_000_000;
  const sec = sweep.playLogCutoff(fake(1_786_721_570), 90, NOW);
  check('seconds detected as seconds', sec.inMs === false, `inMs=${sec.inMs}`);
  check('cutoff is 90 days back, in seconds', sec.cutoff === NOW - 90 * 86400, String(sec.cutoff));
  const ms = sweep.playLogCutoff(fake(1_786_721_570_000), 90, NOW);
  check('milliseconds detected as milliseconds', ms.inMs === true);
  check('cutoff scaled to ms', ms.cutoff === (NOW - 90 * 86400) * 1000, String(ms.cutoff));
  // The trap itself: a TEXT datetime comparison would exclude everything.
  check('a recent play (1h ago) is INSIDE the seconds window', (NOW - 3600) >= sec.cutoff);
  check('an old play (200d ago) is OUTSIDE it', (NOW - 200 * 86400) < sec.cutoff);
}

const dbPath = process.argv[2];
if (!dbPath) {
  console.log('\nNo DB copy given — part A only. Pass a COPY path to run the prediction check.');
  process.exit(pass ? 0 : 1);
}

const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const db = new Database(dbPath);
console.log('\nDB (must be a COPY):', dbPath);

hr('B — migrate the copy, backfill the queue, sweep');
require(path.join(__dirname, 'migrate-deletion-queue-phase-sync-37.js')).applyMigration(db);

// Backfill from the REAL soft-deleted songs — this is what the enqueue hook will do going forward.
db.prepare('DELETE FROM deletion_queue').run();
const deleted = db.prepare(
  "SELECT * FROM songs WHERE deleted_at IS NOT NULL AND file_key IS NOT NULL AND TRIM(file_key) <> ''"
).all();
console.log(`soft-deleted songs with a file_key: ${deleted.length}`);
// deleted_at set 31 days back so every grace period has expired and the sweep examines them all.
const now = Math.floor(Date.now() / 1000);
for (const s of deleted) sweep.enqueueForDeletion(db, s, now - 31 * 86400);
const queued = db.prepare('SELECT COUNT(*) n FROM deletion_queue').get().n;
console.log(`queued: ${queued}`);

const summary = sweep.runSweep(db, { machineId: 'verify-script', now });

hr('C — against the prediction');
const want = { marked: 4, permanent_shared: 2, pending: 26, unverifiable: 0 };
const got = summary.counts;
console.log('predicted:', JSON.stringify(want));
console.log('actual   :', JSON.stringify(got));
for (const k of Object.keys(want)) check(`${k} = ${want[k]}`, got[k] === want[k], `got ${got[k]}`);
check('error = 0', got.error === 0, `got ${got.error}`);
check('every queued row was examined', summary.examined === queued, `${summary.examined} of ${queued}`);
check('mode is report-only', summary.mode === 'report-only');

hr('D — the marked rows (these would be eligible for a future DELETE)');
for (const r of db.prepare("SELECT file_key, reason FROM deletion_queue WHERE status='marked'").all()) {
  console.log(`  ${r.file_key}`);
}
console.log('\npermanent_shared:');
for (const r of db.prepare("SELECT file_key, reason FROM deletion_queue WHERE status='permanent_shared'").all()) {
  console.log(`  ${r.file_key} — ${r.reason}`);
}

db.close();
if (!pass) { console.error('\nFAILED — the sweep does not match the prediction.'); process.exit(1); }
console.log('\nAll checks PASSED — the sweep matches the prediction.');
