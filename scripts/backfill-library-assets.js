'use strict';
// scripts/backfill-library-assets.js — register every audio row that has no library_asset row.
//
// Supersedes backfill-sweeper-assets.js, which did this for `songs` classed SWP only. Spots turned
// out to have the identical gap two days later, so this one is driven by the REGISTRY's assetType
// and covers every audio-bearing table at once — including the next one, without being rewritten.
//
// WHAT STRANDED THEM. Three panels list their content by INNER JOINing library_asset:
//     SweepersPanel.tsx:113 · Spots.tsx:87 · Announcements
// v50 backfilled library_asset at migration time and nothing maintained it afterwards, except
// announcements.js which mirrored its own. So songsCreate and spotsCreate each produced rows their
// own panel could not list. The audio is in the catalogue and the row exists — only the asset row
// that says WHAT it is was missing. Nothing needs re-importing.
//
// REPORT BEFORE WRITE, ALWAYS. Dry run by default and OPENED READ-ONLY, so a dry run is safe to run
// against a live database with Ether open — looking must never take a write lock. --write opens for
// writing and DOES require Ether fully closed (tray + ether-engine), or the lock will be refused.
//
//   ELECTRON_RUN_AS_NODE=1 electron scripts/backfill-library-assets.js --db <path>
//   ELECTRON_RUN_AS_NODE=1 electron scripts/backfill-library-assets.js --db <path> --write

const path = require('path');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
const DB_PATH = argOf('--db');
const WRITE   = argv.includes('--write');

if (!DB_PATH) { console.error('usage: --db <path to openair.db> [--write]'); process.exit(2); }

// RESOLVE better-sqlite3 AND THE REGISTRY FROM WHEREVER THIS IS RUNNING.
//
// On the dev box this file sits in the repo and ../node_modules is right there. On a CUSTOMER
// machine there is no repo: the script ships inside app.asar, and its native dependency lives
// beside it in app.asar.unpacked (a .node binary cannot be loaded from inside an archive). A script
// that only works where it was written is a script that cannot repair the machine that needs it.
function resolveFrom(candidates, what) {
  for (const c of candidates) {
    try { return require(c); } catch { /* try the next */ }
  }
  console.error(`\n  Could not load ${what}. Tried:\n    ` + candidates.join('\n    '));
  process.exit(2);
}
const HERE = __dirname;
const ASAR_UNPACKED = HERE.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const Database = resolveFrom([
  path.join(HERE, '..', 'node_modules', 'better-sqlite3'),
  path.join(ASAR_UNPACKED, '..', 'node_modules', 'better-sqlite3'),
  'better-sqlite3',
], 'better-sqlite3');
const { REGISTRY } = resolveFrom([
  path.join(HERE, '..', 'electron', 'sync', 'synced-tables'),
], 'the table registry');

// A DRY RUN OPENS READ-ONLY, so it is safe to run while Ether is open. It was opening read-write
// either way, which meant "just look, do not touch" still took a write lock on a live database —
// the one thing this codebase has a standing rule against. Only --write opens for writing, and only
// --write requires Ether to be closed.
const db = new Database(DB_PATH, { fileMustExist: true, readonly: !WRITE });
const all = (s, ...a) => db.prepare(s).all(...a);
const one = (s, ...a) => db.prepare(s).get(...a);
const rule = (t) => console.log(`\n${'─'.repeat(76)}\n${t}\n${'─'.repeat(76)}`);
const tableExists = (t) => !!one("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", t);
const cols = (t) => { try { return all(`PRAGMA table_info(${t})`).map(r => r.name); } catch { return []; } };

rule(`BACKFILL library_asset  —  ${WRITE ? 'WRITE' : 'DRY RUN (read-only, safe while Ether is open)'}`);
console.log(`  database: ${DB_PATH}`);
if (WRITE) console.log('  WRITE MODE — Ether must be fully closed (tray + ether-engine) or this will fail to take the lock.');

if (!tableExists('library_asset')) { console.error('\n  library_asset is missing — stopping.'); process.exit(1); }

// THE TABLES COME FROM THE REGISTRY, not a list typed here. Adding assetType to a new table brings it
// into this backfill automatically, which is the whole point of putting it there.
const AUDIO = Object.entries(REGISTRY)
  .filter(([, e]) => e && e.assetType)
  .map(([table, e]) => ({ table, assetType: e.assetType }));

if (AUDIO.length === 0) { console.error('\n  no table declares assetType in the registry — nothing to do.'); process.exit(1); }
console.log(`  audio-bearing tables (from the registry): ${AUDIO.map(a => `${a.table}→${a.assetType}`).join(', ')}`);

// `songs` types by content_class rather than one flat value: a song row may be MUSIC, a sweeper or a
// spot, and the panels filter on the ASSET type. One mapping, mirroring asset-mirror.js.
const typeForSong = (cls) => ({ SWP: 'SWEEPER', SPOT: 'SPOT' })[String(cls || '').toUpperCase()] || 'SONG';

const work = [];
rule('WHAT IS THERE');
for (const { table, assetType } of AUDIO) {
  if (!tableExists(table)) { console.log(`  ${table.padEnd(16)} ABSENT on this install`); continue; }
  const c = cols(table);
  if (!c.includes('uuid')) { console.log(`  ${table.padEnd(16)} has no uuid column — cannot be mirrored`); continue; }

  const hasDeleted = c.includes('deleted_at');
  const titleCol   = c.includes('title') ? 'title' : (c.includes('name') ? 'name' : null);
  const lenExpr    = c.includes('duration_ms') ? 'duration_ms'
                   : (c.includes('length_sec') ? 'CAST(length_sec * 1000 AS INTEGER)' : 'NULL');
  const clsExpr    = c.includes('content_class') ? 'content_class' : 'NULL';

  const rows = all(`
    SELECT uuid,
           ${titleCol ? titleCol : "'(untitled)'"} AS title,
           ${c.includes('file_path') ? 'file_path' : 'NULL'} AS file_path,
           ${c.includes('file_key') ? 'file_key' : 'NULL'} AS file_key,
           ${lenExpr} AS duration_ms,
           ${clsExpr} AS content_class
      FROM ${table}
     WHERE uuid IS NOT NULL ${hasDeleted ? 'AND deleted_at IS NULL' : ''}
       AND NOT EXISTS (SELECT 1 FROM library_asset la WHERE la.uuid = ${table}.uuid)`);

  const total = one(`SELECT COUNT(*) n FROM ${table} ${hasDeleted ? 'WHERE deleted_at IS NULL' : ''}`).n;
  console.log(`  ${table.padEnd(16)} ${String(total).padStart(6)} live row(s) · ${String(rows.length).padStart(5)} WITHOUT an asset row`);
  for (const r of rows) work.push({ table, assetType, row: r });
}

if (work.length === 0) {
  rule('NOTHING TO DO — every audio row already has an asset row.');
  db.close(); process.exit(0);
}

rule(`THE STRANDED ROWS, IN FULL (${work.length})`);
for (const w of work) {
  const type = w.table === 'songs' ? typeForSong(w.row.content_class) : w.assetType;
  const base = String(w.row.file_path || '').split(/[\\/]/).pop() || '(no path)';
  console.log(`  ${w.table.padEnd(14)} ${type.padEnd(12)} ${String(w.row.title || '').slice(0, 34).padEnd(34)} ${base.slice(0, 40)}`);
}

if (!WRITE) {
  rule('DRY RUN — nothing was changed');
  console.log('  Re-run with --write to apply. Close Ether completely first, or work on a copy.');
  db.close(); process.exit(0);
}

// ── write ────────────────────────────────────────────────────────────────────────────────────────
// Direct inserts, not the mutation-logging writer: this repairs local bookkeeping every peer can
// derive for itself from rows it already holds. Journalling one mutation per stranded row would push
// a pile of records saying something the receiver can already work out.
rule('WRITING');
const now = new Date().toISOString();
const ins = db.prepare(`
  INSERT INTO library_asset (uuid, type, title, file_path, file_key, duration_ms, created_at, updated_at, deleted_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`);

let made = 0;
const byType = {};
db.transaction(() => {
  for (const w of work) {
    const type = w.table === 'songs' ? typeForSong(w.row.content_class) : w.assetType;
    ins.run(w.row.uuid, type, w.row.title || '(untitled)', w.row.file_path || null,
            w.row.file_key || null, w.row.duration_ms ?? null, now, now);
    made++; byType[type] = (byType[type] || 0) + 1;
  }
})();

console.log(`  library_asset rows created: ${made}`);
for (const [t, n] of Object.entries(byType)) console.log(`    ${t.padEnd(14)} ${n}`);

// Read it back — a write that reports success without confirming the stored value is the defect this
// whole arc has been chasing.
rule('READ BACK');
let left = 0;
for (const { table } of AUDIO) {
  if (!tableExists(table) || !cols(table).includes('uuid')) continue;
  const hasDeleted = cols(table).includes('deleted_at');
  const n = one(`SELECT COUNT(*) n FROM ${table} WHERE uuid IS NOT NULL ${hasDeleted ? 'AND deleted_at IS NULL' : ''}
                   AND NOT EXISTS (SELECT 1 FROM library_asset la WHERE la.uuid = ${table}.uuid)`).n;
  console.log(`  ${table.padEnd(16)} still without an asset row: ${n}`);
  left += n;
}
console.log(left === 0 ? '\n  VERDICT: PASS — every audio row now has an asset row.\n'
                       : `\n  VERDICT: ${left} still stranded — investigate before assuming this worked.\n`);

db.close();
process.exit(left === 0 ? 0 : 1);
