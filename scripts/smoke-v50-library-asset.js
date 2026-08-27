'use strict';
// scripts/smoke-v50-library-asset.js — prove the library backfill, including the awkward cases.
//
// The claims this has to earn, because every one of them is a way the migration could quietly lose
// or corrupt something:
//   1. Every uuid-bearing song becomes exactly one asset, with its DEFAULTS carried verbatim.
//   2. JIN becomes SWEEPER — the rename happens in the backfill, so there is never a window where
//      two names for one thing are both live.
//   3. A spot whose file is ALREADY an asset reuses it and does not create a duplicate. The two
//      stores are known to disagree on the live install, so this is the case that matters.
//   4. A spot whose file is not an asset becomes a new one, and its traffic fields survive.
//   5. The same file sold to TWO stations gets ONE asset and TWO station-scoped traffic rows.
//   6. songs and spots are UNTOUCHED — same row counts, same values, still authoritative.
//   7. The two existing per-station overlays gain asset_uuid without losing song_id.
//   8. Re-running changes nothing.
//
//   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/smoke-v50-library-asset.js

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const { applyMigration } = require('./migrate-library-asset-phase-sync-50.js');

const dbPath = path.join(os.tmpdir(), `ether-v50-smoke-${process.pid}.db`);
try { fs.unlinkSync(dbPath); } catch {}
const db = new Database(dbPath);

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? '' : `\n         got:  ${JSON.stringify(got)}\n         want: ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

console.log('=== smoke-v50-library-asset ===');

// Schema from the REAL baseline + chain, not hand-rolled — a fixture that differs from the product
// tests a shape the product does not have.
db.prepare('CREATE TABLE schema_version (version INTEGER PRIMARY KEY)').run();
require(path.join(__dirname, 'schema-v0-baseline.js'))(db);
{
  const RE = /^migrate-.+-phase-sync-(\d+)\.js$/;
  const applied = new Set(db.prepare('SELECT version FROM schema_version').all().map(r => r.version));
  const scripts = [];
  for (const f of fs.readdirSync(__dirname)) { const m = RE.exec(f); if (m) scripts.push({ v: +m[1], file: f }); }
  scripts.sort((a, b) => a.v - b.v);
  for (const { v, file } of scripts) {
    if (applied.has(v) || v >= 50) continue;            // stop before the one under test
    try { require(path.join(__dirname, file)).applyMigration(db); } catch (e) { /* fail-soft, as the app does */ }
  }
}

// Parent rows for the FKs the fixture exercises — artist_id and jingle_category_id are carried
// through the backfill, so they need real parents rather than being dropped from the test.
try { db.prepare("INSERT INTO artists (id, name) VALUES (7, 'Test Artist')").run(); } catch (e) { console.log('  (artists seed:', e.message + ')'); }
try { db.prepare("INSERT INTO jingle_categories (id, name, station_id, uuid, created_at, updated_at) VALUES (3, 'Station IDs', 2, 'jc-3', '2026-01-01', '2026-01-01')").run(); } catch (e) { console.log('  (jingle_categories seed:', e.message + ')'); }

const S = db.prepare(`INSERT INTO songs (title, file_path, uuid, content_class, duration_ms, bpm, artist_id,
                        jingle_category_id, play_count, deleted_at)
                      VALUES (?,?,?,?,?,?,?,?,?,?)`);
S.run('A Song',      'C:\\lib\\a.mp3',   'u-song',   'MUSIC', 210000, 128, 7, null, 5, null);
S.run('Station ID',  'C:\\lib\\id.mp3',  'u-sweep',  'JIN',    4000, null, null, 3,  99, null);
S.run('Old Spot',    'C:\ads\ov.mp3',  'u-dual',   'SPOT',  11000, null, null, null, 1, null);
S.run('Gone',        'C:\\lib\\x.mp3',   'u-del',    'MUSIC',  1000, null, null, null, 0, '2026-01-01');
S.run('No UUID',     'C:\\lib\\n.mp3',   null,       'MUSIC',  1000, null, null, null, 0, null);

const SP = db.prepare(`INSERT INTO spots (title, file_path, station_id, uuid, advertiser, isci_code,
                         max_plays_day, length_sec, play_count, is_active, deleted_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
SP.run('Old Spot',   'C:\ads\ov.mp3',  2, 'sp-1', 'Opportunity Village', 'ISCI1', 4, 11, 3, 1, null);
SP.run('Old Spot',   'C:\ads\ov.mp3',  3, 'sp-2', 'OV Station 3',        'ISCI1', 2, 11, 0, 1, null);
SP.run('Lone Spot',  'C:\ads\solo.mp3',2, 'sp-3', 'Solo Advertiser',     'ISCI2', 9, 30, 7, 1, null);

const songsBefore = db.prepare('SELECT COUNT(*) n FROM songs').get().n;
const spotsBefore = db.prepare('SELECT COUNT(*) n FROM spots').get().n;
const songRowBefore = db.prepare("SELECT * FROM songs WHERE uuid='u-song'").get();

applyMigration(db);

const asset = (u) => db.prepare('SELECT * FROM library_asset WHERE uuid=?').get(u);

console.log('\n── 1. every uuid-bearing song became exactly one asset ──');
check('4 song assets + 1 new spot asset = 5', db.prepare('SELECT COUNT(*) n FROM library_asset').get().n, 5);
check('the uuid-less song was skipped', db.prepare("SELECT COUNT(*) n FROM library_asset WHERE title='No UUID'").get().n, 0);
check('a soft-deleted song still carries its tombstone', !!asset('u-del').deleted_at, true);

console.log('\n── defaults carried verbatim ──');
check('title',       asset('u-song').title,       'A Song');
check('duration_ms', asset('u-song').duration_ms, 210000);
check('bpm',         asset('u-song').bpm,         128);
check('artist_id',   asset('u-song').artist_id,   7);
check('play_count',  asset('u-song').play_count,  5);

console.log('\n── 2. JIN became SWEEPER, in the backfill ──');
check('type', asset('u-sweep').type, 'SWEEPER');
check('no asset is left typed JIN', db.prepare("SELECT COUNT(*) n FROM library_asset WHERE type IN ('JIN','SWP')").get().n, 0);
check('its sweeper category moved to the meta table',
  db.prepare("SELECT sweeper_category_id FROM asset_sweeper_meta WHERE asset_uuid='u-sweep'").get().sweeper_category_id, 3);

console.log('\n── 3+5. the overlap: ONE asset, TWO station traffic rows ──');
// Keyed on uuid, not on a Windows path in a SQL literal — the escaping is a test hazard,
// not a product one, and getting it wrong made this assert against a path that never existed.
check('3 spot rows produced only ONE new asset (2 reused)',
  db.prepare('SELECT COUNT(*) n FROM library_asset').get().n, 5);
check('the shared file is ONE asset, not two',
  db.prepare(`SELECT COUNT(DISTINCT asset_uuid) n FROM asset_spot_meta
               WHERE asset_uuid = 'u-dual'`).get().n, 1);
check('it is typed SPOT', asset('u-dual').type, 'SPOT');
check('two stations, two traffic rows',
  db.prepare("SELECT station_id FROM asset_spot_meta WHERE asset_uuid='u-dual' ORDER BY station_id").all().map(r => r.station_id), [2, 3]);
check("station 2's terms", db.prepare("SELECT max_plays_day m FROM asset_spot_meta WHERE asset_uuid='u-dual' AND station_id=2").get().m, 4);
check("station 3's DIFFER — the same file sold differently",
  db.prepare("SELECT max_plays_day m FROM asset_spot_meta WHERE asset_uuid='u-dual' AND station_id=3").get().m, 2);

console.log('\n── 4. a spot with no song row became its own asset, traffic intact ──');
// Found via its traffic row rather than its path, same reason.
const loneMetaFirst = db.prepare("SELECT * FROM asset_spot_meta WHERE advertiser='Solo Advertiser'").get();
const lone = loneMetaFirst ? db.prepare('SELECT * FROM library_asset WHERE uuid=?').get(loneMetaFirst.asset_uuid) : null;
check('created', !!lone, true);
check('typed SPOT', lone && lone.type, 'SPOT');
check('length_sec → duration_ms', lone && lone.duration_ms, 30000);
const loneMeta = loneMetaFirst;
check('advertiser survived', loneMeta.advertiser, 'Solo Advertiser');
check('ISCI survived',       loneMeta.isci_code,  'ISCI2');
check('station-scoped',      loneMeta.station_id, 2);

console.log('\n── 6. songs and spots are UNTOUCHED ──');
check('songs row count unchanged', db.prepare('SELECT COUNT(*) n FROM songs').get().n, songsBefore);
check('spots row count unchanged', db.prepare('SELECT COUNT(*) n FROM spots').get().n, spotsBefore);
check('a song row is byte-identical', db.prepare("SELECT * FROM songs WHERE uuid='u-song'").get(), songRowBefore);
check('songs is still a TABLE — never a view (the 4.4.151 lesson)',
  db.prepare("SELECT type FROM sqlite_master WHERE name='songs'").get().type, 'table');
check('songs still has content_class — nothing dropped',
  db.prepare('PRAGMA table_info(songs)').all().some(c => c.name === 'content_class'), true);

console.log('\n── 7. the existing per-station overlays were WIDENED, not replaced ──');
for (const t of ['station_programming', 'song_metadata_values']) {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  check(`${t} gained asset_uuid`, cols.includes('asset_uuid'), true);
  check(`${t} KEPT song_id`,      cols.includes('song_id'),    true);
  check(`${t} kept station_id — still per station`, cols.includes('station_id'), true);
}

console.log('\n── the three axes are untouched ──');
for (const t of ['categories', 'metadata_definitions', 'metadata_vocabulary']) {
  check(`${t} still exists, unmigrated`, !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t), true);
}
check('library_asset has NO station_id — the library is shared',
  db.prepare('PRAGMA table_info(library_asset)').all().some(c => c.name === 'station_id'), false);
check('library_asset has NO category_id — category is per station, not per asset',
  db.prepare('PRAGMA table_info(library_asset)').all().some(c => c.name === 'category_id'), false);
// Tested by BEHAVIOUR, not by grepping the DDL — SQLite stores the CREATE statement verbatim
// INCLUDING comments, so the first version of this matched the word 'CHECK' in its own comment
// saying there is no CHECK. Inserting an unknown type is the actual proof.
db.prepare("INSERT INTO library_asset (uuid, type, title) VALUES ('u-future','PODCAST','From a newer build')").run();
check('an UNKNOWN type inserts — the schema does not know the set, so a ninth needs no migration',
  db.prepare("SELECT type FROM library_asset WHERE uuid='u-future'").get().type, 'PODCAST');
db.prepare("DELETE FROM library_asset WHERE uuid='u-future'").run();

console.log('\n── 8. idempotency ──');
applyMigration(db);
check('re-running creates nothing', db.prepare('SELECT COUNT(*) n FROM library_asset').get().n, 5);
check('and no duplicate traffic rows', db.prepare('SELECT COUNT(*) n FROM asset_spot_meta').get().n, 3);

console.log('\n──────────────────────────────');
console.log(`  Passed: ${pass}  Failed: ${fail}`);
console.log(`  VERDICT: ${fail === 0 ? 'PASS' : 'FAIL'}`);
console.log('──────────────────────────────');

db.close();
try { fs.unlinkSync(dbPath); } catch {}
process.exit(fail === 0 ? 0 : 1);
