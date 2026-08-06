'use strict';
// Retract the log rows left behind by songs that were deleted BEFORE "a delete is a delete" shipped.
//
// WHAT HAPPENED (proven, docs/deleted-songs-still-air-design-2026-08-06.md):
//   Twelve songs were soft-deleted between 2026-07-06 and 2026-07-20. The delete cascade (shipped
//   2026-07-13) purged their schedule rows correctly — and then Generate RE-CREATED them, because a
//   soft-deleted song was still selectable. 215 of 215 surviving pending rows were created AFTER their
//   song's deleted_at. "Rotten to the Core" was deleted 2026-07-20 and was still scheduled to air on
//   2026-08-06.
//
// The songs→songs_all + view migration stops NEW phantoms. This retracts the ones already in the log.
//
// WHAT THIS DOES: soft-deletes ONLY `state='pending'` rows whose song is soft-deleted. Every airing
// query already filters `gs.deleted_at IS NULL`, so a retracted row cannot be picked.
//
// WHAT THIS DELIBERATELY DOES NOT TOUCH (Jeff's ruling — retract the future, preserve the past):
//   • state='played' / 'missed'  — the record of what actually aired.
//   • state='playing'            — that is audio ON AIR right now.
//   • play_log                   — the advertiser airplay proof.
//
// SAFETY:
//   • Read-only survey by default. Pass --apply to write.
//   • The write is GUARDED: it only ever matches pending + undeleted rows joined to a deleted song,
//     and it re-counts afterwards, failing loudly if anything remains airable.
//   • Run on a COPY first (standing rule). Run on the live DB ONLY with Ether fully closed — the app
//     and daemon hold it open, and an external write to a live SQLite file is how you corrupt it.
//
// Usage:
//   node scripts/retract-deleted-song-phantoms.js <db>            # survey only
//   node scripts/retract-deleted-song-phantoms.js <db> --apply    # write

const path = require('path');
const os = require('os');
const APPLY = process.argv.includes('--apply');
const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const dbPath = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : path.join(localAppData, 'Ether', 'com.ether.radio', 'openair.db');

// node:sqlite so this runs under plain node (no Electron ABI dependency).
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(dbPath);

console.log('=== retract-deleted-song-phantoms.js ===');
console.log('DB:', dbPath);
console.log('MODE:', APPLY ? 'APPLY (writing)' : 'SURVEY ONLY (read-only)');

// Works before OR after the songs→songs_all migration: prefer the physical table when it exists,
// because after the migration `songs` shows only LIVE rows and the tombstones live in songs_all.
const hasSongsAll = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='songs_all'").get();
const SONGS = hasSongsAll ? 'songs_all' : 'songs';
console.log('song table:', SONGS, hasSongsAll ? '(post-migration)' : '(pre-migration)');

const TARGET = `FROM generated_schedule gs JOIN ${SONGS} s ON s.id = gs.song_id
   WHERE s.deleted_at IS NOT NULL AND gs.deleted_at IS NULL AND gs.state = 'pending'`;

const before = db.prepare(`SELECT COUNT(*) c ${TARGET}`).get().c;
console.log(`\n── BEFORE: ${before} airable rows belonging to deleted songs ──`);
for (const r of db.prepare(
  `SELECT s.id, s.title, s.deleted_at, COUNT(*) n,
          MIN(datetime(gs.scheduled_at,'unixepoch')) first_at,
          MAX(datetime(gs.scheduled_at,'unixepoch')) last_at
   ${TARGET} GROUP BY s.id ORDER BY n DESC`).all()) {
  console.log(`  [${r.id}] ${r.title} — deleted ${r.deleted_at} — ${r.n} pending (${r.first_at} → ${r.last_at} UTC)`);
}

// What we are protecting, shown explicitly so the preservation is visible, not assumed.
const preserved = db.prepare(
  `SELECT gs.state, COUNT(*) n FROM generated_schedule gs JOIN ${SONGS} s ON s.id = gs.song_id
    WHERE s.deleted_at IS NOT NULL AND gs.deleted_at IS NULL AND gs.state <> 'pending'
    GROUP BY gs.state`).all();
console.log('\n── PRESERVED (never touched) ──');
for (const r of preserved) console.log(`  ${r.state}: ${r.n} rows`);
let playLogRows = 0;
try {
  playLogRows = db.prepare(
    `SELECT COUNT(*) c FROM play_log pl JOIN ${SONGS} s ON s.file_path = pl.file_path
      WHERE s.deleted_at IS NOT NULL`).get().c;
} catch {}
console.log(`  play_log rows for these songs: ${playLogRows} (airplay proof — untouched)`);

if (!APPLY) {
  console.log('\nSurvey complete. No changes made. Re-run with --apply (Ether CLOSED) to retract.');
  db.close();
  process.exit(0);
}

if (before === 0) {
  console.log('\nNothing to retract — already clean.');
  db.close();
  process.exit(0);
}

// ── Guarded write ────────────────────────────────────────────────────────────
const iso = new Date().toISOString();
const info = db.prepare(
  `UPDATE generated_schedule SET deleted_at = ?, updated_at = ?
    WHERE deleted_at IS NULL AND state = 'pending'
      AND song_id IN (SELECT id FROM ${SONGS} WHERE deleted_at IS NOT NULL)`
).run(iso, iso);

const after = db.prepare(`SELECT COUNT(*) c ${TARGET}`).get().c;
console.log(`\nrows retracted: ${info.changes}`);
console.log(`── AFTER: ${after} airable rows belonging to deleted songs ──`);

// Verify the preservation actually held.
const preservedAfter = db.prepare(
  `SELECT COUNT(*) c FROM generated_schedule gs JOIN ${SONGS} s ON s.id = gs.song_id
    WHERE s.deleted_at IS NOT NULL AND gs.deleted_at IS NULL AND gs.state <> 'pending'`).get().c;
const preservedBefore = preserved.reduce((a, r) => a + r.n, 0);

let pass = true;
const assert = (label, ok) => { console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`); if (!ok) pass = false; };
assert(`every phantom retracted (0 airable remain, was ${before})`, after === 0);
assert(`retracted count matches the survey (${info.changes} === ${before})`, info.changes === before);
assert(`aired history preserved (${preservedAfter} === ${preservedBefore})`, preservedAfter === preservedBefore);

db.close();
if (!pass) { console.error('\nVerification FAILED — inspect before doing anything else.'); process.exit(1); }
console.log('\nDone — these songs can no longer air, and their airplay history is intact.');
