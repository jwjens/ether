'use strict';
// scripts/smoke-inbound-asset-mirror.js — a row that ARRIVES by sync gets its library_asset row.
//
// Jeff, 2026-09-14: "Stranded-on-arrival makes sync useless for anything with a panel."
//
// WHY THIS EXISTS AND WHY IT IS NOT IN THE SYNC SUITE. electron/sync/tests run against
// helpers/create-test-db.js, whose schema contains NO library_asset table — so the inbound mirror
// silently no-ops there and all 49 tests pass whether it works or not. A suite that cannot fail on
// the thing you changed is not evidence. This builds a database that HAS the table and drives the
// real merge engine through it.
//
// Runs on a temp file, touches nothing else:
//   ELECTRON_RUN_AS_NODE=1 electron scripts/smoke-inbound-asset-mirror.js

const path = require('path');
const fs   = require('fs');
const os   = require('os');

function resolveFrom(c, what) { for (const x of c) { try { return require(x); } catch {} }
  console.error('could not load ' + what); process.exit(2); }
const HERE = __dirname;
const Database = resolveFrom([
  path.join(HERE, '..', 'node_modules', 'better-sqlite3'),
  path.join(HERE.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'), '..', 'node_modules', 'better-sqlite3'),
  'better-sqlite3',
], 'better-sqlite3');

const { mirrorAssetInbound, mirrorAssetInboundDelete } = require(path.join(HERE, '..', 'electron', 'sync', 'handlers', 'asset-mirror'));

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures++; console.log(`  FAIL  ${m}`); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ether-mirror-'));
const db = new Database(path.join(dir, 't.db'));

// The two tables the mirror cares about, in the shape the real schema has them.
db.exec(`
  CREATE TABLE library_asset (
    uuid TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT, file_path TEXT, file_key TEXT,
    duration_ms INTEGER, created_at TEXT, updated_at TEXT, deleted_at TEXT);
  CREATE TABLE spots (
    id INTEGER PRIMARY KEY, uuid TEXT, title TEXT, file_path TEXT, file_key TEXT,
    length_sec REAL, station_id INTEGER, deleted_at TEXT);
  CREATE TABLE songs (
    id INTEGER PRIMARY KEY, uuid TEXT, title TEXT, file_path TEXT, file_key TEXT,
    duration_ms INTEGER, content_class TEXT, deleted_at TEXT);
  CREATE TABLE mutations (
    id TEXT PRIMARY KEY, table_name TEXT, row_id TEXT, op TEXT, origin TEXT, created_at TEXT);
`);

console.log('\n== a row that ARRIVES by sync is not stranded ==');

// ── a spot arrives ──────────────────────────────────────────────────────────────────────────────
{
  const row = { uuid: 'u-spot-1', title: 'GC Sponsorship', file_path: 'C:\\cat\\gc.wav', length_sec: 15 };
  db.prepare('INSERT INTO spots (uuid,title,file_path,length_sec,station_id) VALUES (?,?,?,?,2)')
    .run(row.uuid, row.title, row.file_path, row.length_sec);
  mirrorAssetInbound(db, 'spots', row);

  const a = db.prepare('SELECT * FROM library_asset WHERE uuid = ?').get('u-spot-1');
  if (a) pass('an inbound spot gets a library_asset row');
  else fail('an inbound spot is STRANDED — the receiving panel will never list it');
  if (a && a.type === 'SPOT') pass(`typed SPOT from the registry`);
  else fail(`typed ${a && a.type} — the Spots panel filters on type`);
  if (a && a.duration_ms === 15000) pass('length_sec 15 became duration_ms 15000');
  else fail(`duration_ms came through as ${a && a.duration_ms}`);
}

// ── THE LOOP GUARD: nothing may be journalled ───────────────────────────────────────────────────
{
  const n = db.prepare('SELECT COUNT(*) n FROM mutations').get().n;
  if (n === 0) pass('NOTHING was journalled — an inbound mutation produced no outbound one');
  else fail(`${n} mutation(s) journalled by the mirror — two machines would echo derived state forever`);
}

// ── a song arrives, typed by its content_class ──────────────────────────────────────────────────
{
  const row = { uuid: 'u-song-1', title: 'monster growl 01', file_path: 'C:\\cat\\growl.wav',
                duration_ms: 3000, content_class: 'SWP' };
  mirrorAssetInbound(db, 'songs', row);
  const a = db.prepare('SELECT type FROM library_asset WHERE uuid = ?').get('u-song-1');
  if (a && a.type === 'SWEEPER') pass('an inbound song classed SWP is mirrored as SWEEPER');
  else fail(`mirrored as ${a && a.type} — the Sweepers panel filters on SWEEPER`);
}

// ── re-arrival is an update, not a duplicate ────────────────────────────────────────────────────
{
  mirrorAssetInbound(db, 'songs', { uuid: 'u-song-1', title: 'renamed', file_path: 'C:\\cat\\growl.wav',
                                    duration_ms: 3000, content_class: 'SWP' });
  const rows = db.prepare('SELECT title FROM library_asset WHERE uuid = ?').all('u-song-1');
  if (rows.length === 1) pass('a second arrival updates rather than duplicating');
  else fail(`${rows.length} asset rows for one uuid`);
  if (rows[0] && rows[0].title === 'renamed') pass('a renamed row carries the new title through');
  else fail('the title did not follow the update');
}

// ── a row with no audio is not an asset ─────────────────────────────────────────────────────────
{
  const before = db.prepare('SELECT COUNT(*) n FROM library_asset').get().n;
  mirrorAssetInbound(db, 'spots', { uuid: 'u-spot-empty', title: 'no file yet', file_path: null });
  const after = db.prepare('SELECT COUNT(*) n FROM library_asset').get().n;
  if (after === before) pass('a row with no file_path is not mirrored — it is not an asset yet');
  else fail('a row with no audio was registered as an asset');
}

// ── a table the registry does not mark stays untouched ──────────────────────────────────────────
{
  const before = db.prepare('SELECT COUNT(*) n FROM library_asset').get().n;
  mirrorAssetInbound(db, 'clock_slots', { uuid: 'u-slot', title: 'x', file_path: 'C:\\cat\\x.wav' });
  const after = db.prepare('SELECT COUNT(*) n FROM library_asset').get().n;
  if (after === before) pass('a non-audio table is a no-op — no caller has to ask whether it applies');
  else fail('a non-audio table was mirrored');
}

// ── a delete tombstones the asset ───────────────────────────────────────────────────────────────
{
  mirrorAssetInboundDelete(db, 'spots', 'u-spot-1', '2026-09-14T00:00:00.000Z');
  const a = db.prepare('SELECT deleted_at FROM library_asset WHERE uuid = ?').get('u-spot-1');
  if (a && a.deleted_at) pass('an inbound delete tombstones the asset — no ghost in the panel');
  else fail('the asset survived a delete — the panel would list something nothing can play');
  const n = db.prepare('SELECT COUNT(*) n FROM mutations').get().n;
  if (n === 0) pass('the delete journalled nothing either');
  else fail(`${n} mutation(s) journalled on delete`);
}

db.close();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

console.log(failures === 0
  ? '\nVERDICT: PASS — arriving rows are mirrored, and nothing derived is ever sent back.\n'
  : `\nVERDICT: FAIL — ${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
