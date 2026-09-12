'use strict';
// scripts/backfill-sweeper-assets.js — give the stranded cuts a library_asset row.
//
// Jeff, on OV, 2026-09-12: "Backfill is in scope. Otherwise my existing cuts are stranded and I'd be
// re-cutting for nothing."
//
// WHAT STRANDED THEM. SweepersPanel.tsx:113 lists sweepers with
//     FROM library_asset la JOIN songs s ON s.uuid = la.uuid WHERE la.type = 'SWEEPER'
// and songsCreate (sync/handlers/songs.js:50) creates no library_asset row. v50 backfilled the table
// at migration time and nothing has maintained it since, except announcements.js:84 mirroring its
// own. So every sweeper cut made AFTER v50 has a songs row, audio in the catalogue, content_class
// 'SWP' — and is invisible to the one screen that would let it be assigned to a pool.
//
// They are not lost and nothing needs re-cutting: the audio and the row are both there. They need
// the asset row that says what they are.
//
// REPORT BEFORE WRITE, ALWAYS. Default is a dry run that changes nothing and prints exactly what it
// would do. --write is required to commit, and even then it reports first.
//
//   ELECTRON_RUN_AS_NODE=1 electron scripts/backfill-sweeper-assets.js --db <path>
//   ELECTRON_RUN_AS_NODE=1 electron scripts/backfill-sweeper-assets.js --db <path> --write
//
// NEVER RUN AGAINST A LIVE DATABASE WHILE ETHER IS OPEN. Close Ether fully (tray + ether-engine)
// first, or run it against a copy. This script WRITES.

const path = require('path');

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
const DB_PATH = argOf('--db');
const WRITE   = argv.includes('--write');

if (!DB_PATH) {
  console.error('usage: --db <path to openair.db> [--write]');
  process.exit(2);
}

const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const crypto = require('crypto');

const db = new Database(DB_PATH, { fileMustExist: true });
const all = (sql, ...a) => db.prepare(sql).all(...a);
const one = (sql, ...a) => db.prepare(sql).get(...a);
const rule = (t) => console.log(`\n${'─'.repeat(76)}\n${t}\n${'─'.repeat(76)}`);

function tableExists(t) {
  return !!one("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", t);
}

rule(`BACKFILL sweeper library_asset rows  —  ${WRITE ? 'WRITE' : 'DRY RUN (nothing will change)'}`);
console.log(`  database: ${DB_PATH}`);

for (const t of ['songs', 'library_asset']) {
  if (!tableExists(t)) { console.error(`\n  ${t} is missing from this database — stopping.`); process.exit(1); }
}

// THE STRANDED SET: a live SWP song with no library_asset row of its own uuid.
// Keyed on uuid because that is the identity v50 preserved — asset uuid IS the song uuid, so a song
// without a matching asset row is precisely a song nothing registered.
const stranded = all(`
  SELECT s.id, s.uuid, s.title, s.file_path, s.duration_ms, s.jingle_category_id
    FROM songs s
   WHERE s.content_class = 'SWP'
     AND s.deleted_at IS NULL
     AND s.uuid IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM library_asset la WHERE la.uuid = s.uuid)
   ORDER BY s.id`);

const swpTotal = one("SELECT COUNT(*) n FROM songs WHERE content_class='SWP' AND deleted_at IS NULL").n;
const noUuid   = one("SELECT COUNT(*) n FROM songs WHERE content_class='SWP' AND deleted_at IS NULL AND uuid IS NULL").n;

rule('WHAT IS THERE');
console.log(`  live SWP songs:                 ${swpTotal}`);
console.log(`  already registered as assets:   ${swpTotal - stranded.length - noUuid}`);
console.log(`  STRANDED (no asset row):        ${stranded.length}`);
if (noUuid) {
  console.log(`  without a uuid at all:          ${noUuid}   <-- NOT touched; see the note below`);
}

if (stranded.length) {
  rule('THE STRANDED CUTS, IN FULL');
  for (const r of stranded) {
    const base = String(r.file_path || '').split(/[\\/]/).pop() || '(no path)';
    console.log(`  id=${String(r.id).padStart(5)}  ${String(r.title || '(untitled)').slice(0, 38).padEnd(38)}  ${base}`);
  }
}

// The dead column, reported because it is the ONLY surviving record of what pool the operator
// originally chose. Nothing reads it (sweeper-pool.js:56 uses sweeper_pool_member whenever the join
// table exists), so this is the last chance to carry that intent forward rather than lose it.
const withPool = stranded.filter(r => r.jingle_category_id != null);
if (withPool.length && tableExists('jingle_categories')) {
  rule('POOL INTENT RECORDED IN THE DEAD COLUMN');
  console.log('  songs.jingle_category_id has no readers left — but it still remembers which pool was');
  console.log('  chosen when each cut was committed. These memberships would be recreated:\n');
  for (const r of withPool) {
    const p = one('SELECT name, station_id FROM jingle_categories WHERE id = ?', r.jingle_category_id);
    console.log(`    "${String(r.title || '').slice(0, 34)}" -> pool "${p?.name ?? '(missing pool ' + r.jingle_category_id + ')'}"`
                + (p ? ` (station ${p.station_id})` : ''));
  }
  console.log('\n  A pool row that no longer exists is REPORTED and SKIPPED, never invented.');
}

if (!WRITE) {
  rule('DRY RUN — nothing was changed');
  console.log('  Re-run with --write to apply. Close Ether completely first, or work on a copy.');
  db.close();
  process.exit(0);
}

// ── write ────────────────────────────────────────────────────────────────────────────────────────
// Direct inserts, NOT the mutation-logging writer, and deliberately: this is a repair of local
// bookkeeping that every peer can derive for itself from rows it already has. Journalling one
// mutation per stranded cut would push a pile of records saying something the receiver can work out.
rule('WRITING');
const now = new Date().toISOString();
const hasMember = tableExists('sweeper_pool_member');

const insAsset = db.prepare(`
  INSERT INTO library_asset (uuid, type, title, file_path, duration_ms, created_at, updated_at, deleted_at)
  VALUES (?, 'SWEEPER', ?, ?, ?, ?, ?, NULL)`);

let assets = 0, members = 0, skipped = 0;

const run = db.transaction(() => {
  for (const r of stranded) {
    insAsset.run(r.uuid, r.title || '(untitled)', r.file_path || null, r.duration_ms ?? null, now, now);
    assets++;

    if (hasMember && r.jingle_category_id != null) {
      const p = one('SELECT id, station_id FROM jingle_categories WHERE id = ?', r.jingle_category_id);
      if (!p) { skipped++; continue; }                       // pool gone: reported above, never invented
      const already = one(
        'SELECT 1 FROM sweeper_pool_member WHERE pool_id = ? AND asset_uuid = ? AND deleted_at IS NULL',
        p.id, r.uuid);
      if (already) continue;
      db.prepare(`
        INSERT INTO sweeper_pool_member (uuid, pool_id, asset_uuid, station_id, created_at, updated_at, deleted_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL)`).run(crypto.randomUUID(), p.id, r.uuid, p.station_id, now, now);
      members++;
    }
  }
});
run();

console.log(`  library_asset rows created:     ${assets}`);
console.log(`  pool memberships recreated:     ${members}`);
if (skipped) console.log(`  memberships skipped (pool gone):${skipped}`);

// Read it back. A write that reports success without confirming the stored value is the defect this
// whole session has been chasing.
rule('READ BACK');
const left = one(`
  SELECT COUNT(*) n FROM songs s
   WHERE s.content_class='SWP' AND s.deleted_at IS NULL AND s.uuid IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM library_asset la WHERE la.uuid = s.uuid)`).n;
console.log(`  SWP songs still without an asset row: ${left}`);
if (noUuid) {
  console.log(`\n  ${noUuid} SWP song(s) have NO uuid and were not touched. They cannot be given an asset`);
  console.log('  identity without inventing one, and inventing identity is how two machines end up');
  console.log('  disagreeing about the same cut. Report them rather than guessing.');
}
console.log(left === 0 ? '\n  VERDICT: PASS — every stranded cut now has an asset row.\n'
                       : `\n  VERDICT: ${left} still stranded — investigate before assuming this worked.\n`);

db.close();
process.exit(left === 0 ? 0 : 1);
