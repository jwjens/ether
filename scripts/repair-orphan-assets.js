'use strict';
// scripts/repair-orphan-assets.js — retire library_asset rows whose source row is gone.
//
// Jeff, 2026-09-14: "The dry-run repair for orphans already in both databases. Numbers before it
// writes."
//
// WHAT AN ORPHAN IS AND HOW IT GOT THERE. library_asset mirrors songs / spots / announcements. Until
// 2026-09-14 nothing un-mirrored on a local delete — mirrorAssetDelete existed and had zero callers
// — so every row deleted through a panel left its asset row alive for ever. The Spots panel INNER
// JOINs the mirror and stops showing the row; the Library LEFT JOINs it and keeps showing it. That
// is "the old spot I'm trying to delete is visible in the library but not in the spots window".
//
// The code hole is closed (mutation-writer.js _unmirrorOnDelete, structurally for every table), but
// closing it does not retire rows already stranded — on EITHER machine. This does.
//
// WHY IT DOES NOT NEED TO RUN ON BOTH MACHINES. library_asset is a synced table and assetDelete
// journals a real delete mutation, so the tombstones replicate. Run it once, on the machine you
// trust most, and let sync carry it. Running it on both is harmless (the second finds nothing).
//
// DRY RUN BY DEFAULT. Nothing is written without --write, and the dry run opens the database
// READ-ONLY so it takes no write lock and is safe with Ether open and on air.
//
//   node scripts/repair-orphan-assets.js "<openair.db>"              # dry run, numbers only
//   node scripts/repair-orphan-assets.js "<openair.db>" --write      # apply
//
// CLOSE ETHER BEFORE --write. Never write the live database while the app holds it open.

const path = require('path');

function resolveDb() {
  const tries = [
    path.join(__dirname, '..', 'node_modules', 'better-sqlite3'),
    path.join(__dirname.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'), '..', 'node_modules', 'better-sqlite3'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'node_modules', 'better-sqlite3'),
    'better-sqlite3',
  ];
  for (const t of tries) { try { return require(t); } catch {} }
  console.error('could not load better-sqlite3 from any of:\n  ' + tries.join('\n  '));
  process.exit(2);
}

const DBPATH = process.argv[2];
const WRITE  = process.argv.includes('--write');
if (!DBPATH) { console.error('usage: repair-orphan-assets.js <openair.db> [--write]'); process.exit(2); }

const Database = resolveDb();
const db = new Database(DBPATH, { readonly: !WRITE, fileMustExist: true });

// The registry is the list of tables that own assets — not a hand-kept copy of it.
let OWNERS;
try {
  const { audioBearingTables } = require(path.join(__dirname, '..', 'electron', 'sync', 'handlers', 'asset-mirror'));
  OWNERS = audioBearingTables();
} catch (e) {
  console.error('could not read the table registry: ' + e.message);
  process.exit(2);
}

const has = (t) => { try { db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get(); return true; } catch { return false; } };
const present = OWNERS.filter(o => has(o.table));

console.log('\n' + '='.repeat(78));
console.log(`ORPHANED LIBRARY ASSETS   db=${DBPATH}`);
console.log(`mode: ${WRITE ? '*** WRITE ***' : 'DRY RUN (database opened read-only)'}`);
console.log('='.repeat(78));

console.log('\nowning tables, from the registry:');
for (const o of OWNERS)
  console.log(`  ${o.table.padEnd(16)} type=${String(o.assetType).padEnd(12)}${has(o.table) ? '' : '  (absent on this schema — skipped)'}`);

// An asset is an orphan when NO owning table holds a live row with its uuid.
const notExists = present.map(o =>
  `NOT EXISTS (SELECT 1 FROM ${o.table} t WHERE t.uuid = la.uuid AND t.deleted_at IS NULL)`).join('\n       AND ');

const ORPHAN_SQL = `
  FROM library_asset la
 WHERE la.deleted_at IS NULL
   AND ${notExists}`;

const total = db.prepare(`SELECT COUNT(*) n FROM library_asset WHERE deleted_at IS NULL`).get().n;
const orphans = db.prepare(`SELECT la.uuid, la.type, la.title, la.file_path ${ORPHAN_SQL} ORDER BY la.type, la.title`).all();

console.log(`\nlive library_asset rows : ${total}`);
console.log(`orphaned                : ${orphans.length}`);

if (!orphans.length) {
  console.log('\nNothing to repair.\n');
  db.close();
  process.exit(0);
}

const byType = new Map();
for (const o of orphans) byType.set(o.type, (byType.get(o.type) || 0) + 1);
console.log('\nby type:');
for (const [t, c] of [...byType].sort()) console.log(`  ${String(t).padEnd(14)} ${c}`);

// THE FILE STILL ON DISK IS THE ONE THING WORTH PAUSING OVER: retiring the asset row does not delete
// audio, but it does mean nothing in the app points at that file any more.
const fs = require('fs');
let onDisk = 0;
for (const o of orphans) { try { if (o.file_path && fs.existsSync(o.file_path)) onDisk++; } catch {} }
console.log(`\nof those, files still present on disk: ${onDisk}` +
            (onDisk ? '  (the audio is NOT deleted — only the library entry is retired)' : ''));

console.log('\nthe rows:');
const show = orphans.slice(0, 40);
for (const o of show) {
  const base = o.file_path ? String(o.file_path).split(/[\\/]/).pop() : '(no file)';
  console.log(`  ${String(o.type).padEnd(12)} ${String(o.title || '(untitled)').slice(0, 44).padEnd(46)} ${base}`);
}
if (orphans.length > show.length) console.log(`  ... and ${orphans.length - show.length} more`);

if (!WRITE) {
  console.log('\n' + '-'.repeat(78));
  console.log(`DRY RUN — nothing was written. ${orphans.length} row(s) would be tombstoned.`);
  console.log('To apply: close Ether completely, then re-run with --write');
  console.log('-'.repeat(78) + '\n');
  db.close();
  process.exit(0);
}

// ── write ───────────────────────────────────────────────────────────────────────────────────────
// Through assetDelete, NOT a raw UPDATE: it journals the delete mutation, which is what carries the
// tombstone to the other machine. A raw UPDATE would fix this database and leave the peer stranded.
const { assetDelete } = require(path.join(__dirname, '..', 'electron', 'sync', 'handlers', 'library_asset'));

let done = 0; const failed = [];
for (const o of orphans) {
  try { assetDelete(db, o.uuid); done++; }
  catch (e) { failed.push(`${o.title}: ${e.message}`); }
}

const left = db.prepare(`SELECT COUNT(*) n ${ORPHAN_SQL}`).get().n;

console.log('\n' + '-'.repeat(78));
console.log(`WROTE: ${done} asset row(s) tombstoned, ${failed.length} failed.`);
for (const f of failed.slice(0, 10)) console.log('  FAILED  ' + f);
console.log(`orphans remaining: ${left}`);
console.log('Each tombstone was journalled, so the other machine picks them up on the next sync.');
console.log('-'.repeat(78) + '\n');

db.close();
process.exit(failed.length ? 1 : 0);
