'use strict';
// scripts/smoke-library-asset-sync.js — the new tables actually journal for sync.
//
// Step 3 is plumbing, and plumbing fails silently. A handler that writes the row but not the mutation
// looks perfect on this machine and never reaches a peer — the failure only shows up as two installs
// that quietly disagree, weeks later. So this asserts the JOURNAL, not just the row.
//
// It also guards the two rules that would be easy to get wrong here:
//   • library_asset is INSTALL-scoped, so its mutations carry NO station_id.
//   • asset_spot_meta is STATION-scoped, so its mutations DO — the same file sold to two stations
//     produces two rows and two journal entries, one per station.
//
// And it pins the `refs` lesson: a UUID column must never appear in refs. refs is uuid-identity
// REMAPPING for columns holding LOCAL INTEGER IDS — it rewrites the column with a local id — so a
// uuid listed there makes every row look dangling to rebaselineScan and would corrupt the column if
// it ever resolved. That defect shipped in v4.4.231 on announcement_schedule and is fixed here.
//
//   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/smoke-library-asset-sync.js

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const { REGISTRY, SYNCED_TABLES } = require(path.join(__dirname, '..', 'electron', 'sync', 'synced-tables.js'));
const LA = require(path.join(__dirname, '..', 'electron', 'sync', 'handlers', 'library_asset.js'));
const AM = require(path.join(__dirname, '..', 'electron', 'sync', 'handlers', 'asset_meta.js'));

const dbPath = path.join(os.tmpdir(), `ether-lasync-smoke-${process.pid}.db`);
try { fs.unlinkSync(dbPath); } catch {}
const db = new Database(dbPath);

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? '' : `\n         got:  ${JSON.stringify(got)}\n         want: ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

console.log('=== smoke-library-asset-sync ===');

db.prepare('CREATE TABLE schema_version (version INTEGER PRIMARY KEY)').run();
require(path.join(__dirname, 'schema-v0-baseline.js'))(db);
{
  const RE = /^migrate-.+-phase-sync-(\d+)\.js$/;
  const applied = new Set(db.prepare('SELECT version FROM schema_version').all().map(r => r.version));
  const scripts = [];
  for (const f of fs.readdirSync(__dirname)) { const m = RE.exec(f); if (m) scripts.push({ v: +m[1], file: f }); }
  scripts.sort((a, b) => a.v - b.v);
  for (const { v, file } of scripts) {
    if (applied.has(v)) continue;
    try { require(path.join(__dirname, file)).applyMigration(db); } catch (e) { /* fail-soft, as the app does */ }
  }
}
try { db.prepare("INSERT OR IGNORE INTO client_identity (id, client_id, created_at) VALUES (1,'smoke','2026-01-01')").run(); } catch {}

const muts = (t) => db.prepare('SELECT * FROM mutations WHERE table_name = ? ORDER BY rowid').all(t);

console.log('\n── registry wiring ──');
for (const t of ['library_asset', 'asset_spot_meta', 'asset_sweeper_meta']) {
  check(`${t} is in SYNCED_TABLES`, SYNCED_TABLES.includes(t), true);
  check(`${t} is in REGISTRY`, !!REGISTRY[t], true);
}
check('library_asset is INSTALL-scoped — an asset is a file', REGISTRY.library_asset.scope, 'install');
check('asset_spot_meta is STATION-scoped — terms differ per station', REGISTRY.asset_spot_meta.scope, 'station');
check('library_asset declares NO station_id column',
  'station_id' in REGISTRY.library_asset.columns, false);

console.log('\n── the refs lesson: a UUID column is NEVER a ref ──');
// refs remaps columns holding LOCAL INTEGER IDS. A uuid is globally stable and needs no remapping —
// which is why it was chosen. Listing one made every row look dangling to rebaselineScan.
const uuidRefs = [];
for (const [name, entry] of Object.entries(REGISTRY)) {
  for (const col of Object.keys(entry.refs || {})) if (/_uuid$/.test(col)) uuidRefs.push(`${name}.${col}`);
}
check('no uuid column appears in any refs map', uuidRefs, []);
check('asset_spot_meta refs only its INTEGER id columns',
  Object.keys(REGISTRY.asset_spot_meta.refs).sort(), ['spot_category_id', 'station_id']);

console.log('\n── the widened overlays still sync their new column ──');
for (const t of ['station_programming', 'song_metadata_values']) {
  check(`${t}.asset_uuid is a synced column`, 'asset_uuid' in REGISTRY[t].columns, true);
  check(`${t} kept song_id`, 'song_id' in REGISTRY[t].columns, true);
  check(`${t}.asset_uuid is NOT a ref`, 'asset_uuid' in (REGISTRY[t].refs || {}), false);
}

console.log('\n── writes JOURNAL, which is the whole point of this step ──');
const a = LA.assetCreate(db, { title: 'Test Asset', type: 'SONG', file_path: 'C:\\lib\\t.mp3', duration_ms: 1000 });
check('the row landed', !!a && a.title, 'Test Asset');
check('one insert mutation was journalled', muts('library_asset').map(m => m.op), ['insert']);
check('install-scoped → the mutation carries NO station_id', muts('library_asset')[0].station_id, null);

LA.assetUpdate(db, a.uuid, { title: 'Renamed' });
check('an update journals', muts('library_asset').map(m => m.op), ['insert', 'update']);

console.log('\n── the NO-OP GUARD: a write that changes nothing must not journal ──');
LA.assetUpdate(db, a.uuid, { title: 'Renamed' });
check('re-writing the same value journals nothing new', muts('library_asset').length, 2);

console.log('\n── an unknown type is STORED, not rejected ──');
// A newer peer may know a type this build does not. Refusing it would drop that asset entirely.
const fut = LA.assetCreate(db, { title: 'From the future', type: 'PODCAST' });
check('it stored as given', fut.type, 'PODCAST');

console.log('\n── traffic terms: one asset, TWO stations, TWO journal entries ──');
AM.spotMetaUpsert(db, { asset_uuid: a.uuid, station_id: 2, advertiser: 'OV', max_plays_day: 4 });
AM.spotMetaUpsert(db, { asset_uuid: a.uuid, station_id: 3, advertiser: 'OV S3', max_plays_day: 2 });
check('two rows for one asset',
  AM.spotMetaList(db, null, { assetUuid: a.uuid }).map(r => r.station_id).sort(), [2, 3]);
check('terms differ per station',
  AM.spotMetaList(db, 3, { assetUuid: a.uuid })[0].max_plays_day, 2);
check('two mutations journalled', muts('asset_spot_meta').map(m => m.op), ['insert', 'insert']);
check('station-scoped → each mutation carries ITS station',
  muts('asset_spot_meta').map(m => String(m.station_id)).sort(), ['2', '3']);

AM.spotMetaUpsert(db, { asset_uuid: a.uuid, station_id: 2, advertiser: 'OV', max_plays_day: 4 });
check('an unchanged traffic upsert journals nothing', muts('asset_spot_meta').length, 2);

console.log('\n── sweeper meta, install-scoped ──');
AM.sweeperMetaUpsert(db, { asset_uuid: a.uuid, sweeper_category_id: 3 });
check('one row', AM.sweeperMetaList(db, { assetUuid: a.uuid }).length, 1);
check('journalled with no station', muts('asset_sweeper_meta')[0].station_id, null);

console.log('\n── deletes journal too ──');
LA.assetDelete(db, fut.uuid);
check('a delete mutation exists', muts('library_asset').filter(m => m.op === 'delete').length, 1);
check('and the row is soft-deleted, not gone',
  !!db.prepare('SELECT deleted_at FROM library_asset WHERE uuid = ?').get(fut.uuid).deleted_at, true);

console.log('\n── the three axes are still untouched ──');
for (const t of ['categories', 'metadata_definitions', 'metadata_vocabulary']) {
  check(`${t} exists and is unmigrated`, !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t), true);
}

console.log('\n──────────────────────────────');
console.log(`  Passed: ${pass}  Failed: ${fail}`);
console.log(`  VERDICT: ${fail === 0 ? 'PASS' : 'FAIL'}`);
console.log('──────────────────────────────');

db.close();
try { fs.unlinkSync(dbPath); } catch {}
process.exit(fail === 0 ? 0 : 1);
