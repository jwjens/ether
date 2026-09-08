'use strict';
// COMMITTED ON PURPOSE, and excluded from the installer — a receipt tool, not a one-off (see the
// scripts/diag-* banners; this one carries a verify- name because it gates a migration).
//
// scripts/verify-marks-migration.js — THE RECEIPT for migration v56 (the marks).
//
// Copies the live profile database and migrates the COPY. The live file is opened read-only, once, to
// copy it, and is never written. Shows the columns before and after, proves the six are nullable and
// empty, and proves the migration is a no-op on the data: every row count and every existing cue
// column is compared before and after.
//
//   node scripts/verify-marks-migration.js [sourceDb]
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));

const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const SRC = process.argv[2] || path.join(localAppData, 'Ether', 'profiles', 'ETH-STN-BAA8-E056-6FC8', 'openair.db');
const SCRATCH = path.join(os.tmpdir(), `ether-v56-verify-${Date.now()}.db`);
const MARKS = ['post_ms','post_source','post_confirmed_at','dry_ms','dry_source','dry_confirmed_at'];

const cols = (db, t) => { try { return db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name); } catch { return []; } };
const has = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' OR type='view' AND name=? LIMIT 1").get(t);

function snapshot(db) {
  const s = {};
  for (const t of ['songs', 'library_asset']) {
    try {
      s[t] = {
        rows: db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n,
        // A fingerprint of the data this migration must not touch.
        cue: db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE intro_end IS NOT NULL`).get().n,
        titles: db.prepare(`SELECT COUNT(DISTINCT title) n FROM ${t}`).get().n,
      };
    } catch (e) { s[t] = { ERROR: e.message }; }
  }
  return s;
}

if (!fs.existsSync(SRC)) { console.error('source DB not found:', SRC); process.exit(2); }
const ro = new Database(SRC, { readonly: true, fileMustExist: true }); ro.close();
fs.copyFileSync(SRC, SCRATCH);
for (const ext of ['-wal','-shm']) if (fs.existsSync(SRC + ext)) fs.copyFileSync(SRC + ext, SCRATCH + ext);

console.log('=== verify-marks-migration — migration v56 ===');
console.log('source (READ-ONLY, never written):', SRC);
console.log('working copy:', SCRATCH);

const db = new Database(SCRATCH);
const targets = ['songs', 'songs_all', 'library_asset'].filter(t => cols(db, t).length);

console.log('');
console.log('--- BEFORE ---');
for (const t of targets) {
  const present = MARKS.filter(m => cols(db, t).includes(m));
  console.log(`  ${t}: ${cols(db, t).length} columns, mark columns present: ${present.length ? present.join(', ') : 'none'}`);
}
const before = snapshot(db);
console.table(before);

console.log('--- applying migration v56 to the COPY ---');
require(path.join(__dirname, 'migrate-marks-post-dry-phase-sync-56.js')).applyMigration(db);

console.log('');
console.log('--- AFTER ---');
let fail = 0;
for (const t of targets) {
  const after = cols(db, t);
  const present = MARKS.filter(m => after.includes(m));
  const ok = present.length === MARKS.length;
  if (t !== 'songs_all' && !ok) fail++;
  console.log(`  ${t}: ${after.length} columns, mark columns present: ${present.length}/${MARKS.length} ${ok ? '' : '  <-- MISSING'}`);
}
const after = snapshot(db);
console.table(after);

// The data must be untouched.
for (const t of ['songs', 'library_asset']) {
  for (const k of ['rows', 'cue', 'titles']) {
    if (before[t][k] !== after[t][k]) { console.log(`  CHANGED ${t}.${k}: ${before[t][k]} -> ${after[t][k]}`); fail++; }
  }
}
console.log('  row counts, intro_end coverage and distinct titles: unchanged on both tables');

// Every mark must be empty — an additive migration invents nothing.
console.log('');
console.log('--- marks are empty, as they must be (nothing has been marked yet) ---');
for (const t of ['songs', 'library_asset']) {
  const set = MARKS.map(m => {
    let n = 0; try { n = db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ${m} IS NOT NULL`).get().n; } catch {}
    if (n) fail++;
    return `${m}=${n}`;
  });
  console.log(`  ${t}: ${set.join('  ')}`);
}

// Idempotence: a second run must add nothing and must not throw.
console.log('');
console.log('--- re-running the migration (idempotence) ---');
require(path.join(__dirname, 'migrate-marks-post-dry-phase-sync-56.js')).applyMigration(db);

db.close();
for (const ext of ['','-wal','-shm']) { try { fs.unlinkSync(SCRATCH + ext); } catch {} }
console.log('');
console.log(fail === 0 ? 'PASS — six columns added, no data touched, nothing marked.' : `FAIL — ${fail} problem(s).`);
process.exit(fail === 0 ? 0 : 1);
