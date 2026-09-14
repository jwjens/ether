'use strict';
// scripts/smoke-asset-unmirror.js — the asset mirror dies with its row, structurally.
//
// Jeff, 2026-09-14: "the old spot im trying to delete is visible in the library but not in the spots
// window." mirrorAssetDelete existed, was exported, and had ZERO callers, so every local delete left
// its library_asset row alive for ever — visible in the Library (LEFT JOIN), gone from the Spots
// panel (INNER JOIN), and replicated to both machines because library_asset is itself synced.
//
// WHAT THIS PROVES, and why it is worth a smoke of its own: the un-mirror is wired into
// withMutation, NOT into each handler. The whole claim is "no table has to remember", so the test
// deletes through the real spots handler and through a table the registry does NOT mark, and checks
// that the first un-mirrors and the second is untouched. A per-table test could not tell those apart.
//
// Runs on a temp file, touches nothing else:
//   node scripts/smoke-asset-unmirror.js

const path = require('path');
const fs   = require('fs');
const os   = require('os');

function resolveFrom(c, what) {
  for (const x of c) { try { return require(x); } catch {} }
  console.error('could not load ' + what); process.exit(2);
}
const HERE = __dirname;
const Database = resolveFrom([
  path.join(HERE, '..', 'node_modules', 'better-sqlite3'),
  path.join(HERE.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'), '..', 'node_modules', 'better-sqlite3'),
  'better-sqlite3',
], 'better-sqlite3');

const { spotsCreate, spotsDelete } = require(path.join(HERE, '..', 'electron', 'sync', 'handlers', 'spots'));

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures++; console.log(`  FAIL  ${m}`); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ether-unmirror-'));
const db = new Database(path.join(dir, 't.db'));

// The machinery withMutation needs, plus the two tables that matter.
db.exec(`
  CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT);
  INSERT INTO schema_version (version, applied_at) VALUES (60, '2026-09-14T00:00:00.000Z');
  CREATE TABLE client_identity (client_id TEXT PRIMARY KEY, created_at TEXT);
  INSERT INTO client_identity (client_id, created_at) VALUES ('11111111-1111-4111-8111-111111111111', '2026-09-14T00:00:00.000Z');
  CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
  INSERT INTO system_state (key, value, updated_at) VALUES ('hlc_last', '0:0:11111111-1111-4111-8111-111111111111', '2026-09-14T00:00:00.000Z');
  -- The canonical shape, copied from electron/sync/tests/helpers/create-test-db.js. A trimmed
  -- guess at these columns fails at logMutation, which is a test problem, not a product one.
  CREATE TABLE mutations (
    id TEXT PRIMARY KEY, client_id TEXT NOT NULL, station_id TEXT, actor_id TEXT,
    table_name TEXT NOT NULL, row_id TEXT NOT NULL,
    op TEXT NOT NULL CHECK (op IN ('insert','update','delete','checkpoint')),
    payload_before TEXT, payload_after TEXT,
    created_at TEXT NOT NULL, applied_at TEXT NOT NULL, hlc TEXT NOT NULL,
    parent_mutation_id TEXT, schema_version INTEGER NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('local','remote','system','migration')),
    sync_status TEXT NOT NULL CHECK (sync_status IN ('pending','syncing','synced','conflicted')),
    conflict_resolution TEXT);
  -- library_asset is built from the REGISTRY below, not hand-copied here. Hand-copying the DDL
  -- meant chasing v50, then v56's post_ms, then v57 -- and every miss reads as "the mirror is
  -- broken" when it is only the fixture that is stale. The registry is what the writer actually
  -- writes through, so a fixture derived from it cannot drift from the thing under test.
  CREATE TABLE library_asset (
    id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'SONG',
    created_at TEXT, updated_at TEXT, deleted_at TEXT);
  CREATE UNIQUE INDEX idx_library_asset_uuid ON library_asset(uuid);
  CREATE TABLE spots (
    id INTEGER PRIMARY KEY, uuid TEXT UNIQUE, title TEXT, file_path TEXT, file_key TEXT,
    spot_type TEXT, advertiser TEXT, start_date TEXT, end_date TEXT, max_plays_day INTEGER,
    play_count INTEGER DEFAULT 0, last_played_at INTEGER, is_active INTEGER DEFAULT 1,
    notes TEXT, isci_code TEXT, cart_number TEXT, agency TEXT, length_sec REAL,
    spot_category_id INTEGER, art_image TEXT, station_id INTEGER,
    created_at TEXT, updated_at TEXT, deleted_at TEXT);
  CREATE TABLE generated_schedule (
    id INTEGER PRIMARY KEY, uuid TEXT, scheduled_at INTEGER, song_id INTEGER,
    title TEXT, file_path TEXT, station_id INTEGER, state TEXT DEFAULT 'pending',
    content_class TEXT DEFAULT 'MUSIC', deleted_at TEXT, updated_at TEXT);
`);

// Every column the registry says library_asset has, added if the skeleton above lacks it. TEXT
// affinity is enough: SQLite is dynamically typed and nothing here asserts on storage class.
{
  const { REGISTRY } = require(path.join(HERE, '..', 'electron', 'sync', 'synced-tables'));
  const cols = Object.keys((REGISTRY.library_asset && REGISTRY.library_asset.columns) || {});
  const have = new Set(db.prepare('PRAGMA table_info(library_asset)').all().map(c => c.name));
  let added = 0;
  for (const c of cols) {
    if (have.has(c)) continue;
    db.prepare(`ALTER TABLE library_asset ADD COLUMN ${c}`).run();
    added++;
  }
  console.log(`  (fixture: library_asset built from the registry — ${cols.length} columns, ${added} added)`);
}

const asset = (uuid) => db.prepare('SELECT type, deleted_at FROM library_asset WHERE uuid = ?').get(uuid);

console.log('\n== a created spot is mirrored ==');

const created = spotsCreate(db, {
  station_id: 2, title: 'Opportunity Village', file_path: 'C:\\cat\\ov.wav',
  spot_type: 'promo', length_sec: 30, is_active: 1,
});
{
  const a = asset(created.uuid);
  if (a && a.type === 'SPOT' && !a.deleted_at) pass('creating a spot writes its library_asset row');
  else fail('the create did not mirror — nothing downstream can be tested');
}

console.log('\n== and the mirror dies with it ==');

// One pending airing, so the delete has something to retract as well.
db.prepare(`INSERT INTO generated_schedule (scheduled_at, song_id, title, file_path, station_id, state, content_class)
            VALUES (5000, NULL, 'Opportunity Village', 'C:\\cat\\ov.wav', 2, 'pending', 'SPOT')`).run();

const res = spotsDelete(db, created.uuid, 2);

{
  const row = db.prepare('SELECT deleted_at FROM spots WHERE uuid = ?').get(created.uuid);
  if (row && row.deleted_at) pass('the spots row is tombstoned');
  else fail('the spots row was not tombstoned');
}
{
  const a = asset(created.uuid);
  if (a && a.deleted_at) pass('THE ASSET ROW IS TOMBSTONED TOO — the Library will not keep listing it');
  else fail('the asset row survived the delete — this is the orphan bug, still present');
}
{
  // Structural means: nobody had to remember. spots.js does not import mirrorAssetDelete at all.
  const src = fs.readFileSync(path.join(HERE, '..', 'electron', 'sync', 'handlers', 'spots.js'), 'utf8');
  if (!src.includes('mirrorAssetDelete'))
    pass('spots.js never mentions mirrorAssetDelete — the un-mirror is structural, not remembered');
  else fail('spots.js calls the un-mirror by hand — the next table to be added will forget');
}
{
  if (res && res.retracted && res.retracted.pendingLog === 1)
    pass('and the pending airing was retracted in the same delete');
  else fail(`the delete retracted ${res && res.retracted && res.retracted.pendingLog} airings — expected 1`);
}

console.log('\n== the tombstone travels ==');
{
  const m = db.prepare(`SELECT op FROM mutations WHERE table_name = 'library_asset' AND row_id = ? ORDER BY hlc DESC`).all(created.uuid);
  if (m.length && m[m.length - 1].op === 'delete' || m.some(x => x.op === 'delete'))
    pass('the asset delete was journalled — the other machine will retire it too');
  else fail('the asset delete journalled nothing — the peer keeps its orphan for ever');
}

console.log('\n== a table the registry does not mark is untouched ==');
{
  const before = db.prepare('SELECT COUNT(*) n FROM library_asset').get().n;
  // generated_schedule carries no assetType. Deleting through withMutation must not reach the mirror.
  const { withMutation } = require(path.join(HERE, '..', 'electron', 'sync', 'mutation-writer'));
  db.prepare(`INSERT INTO generated_schedule (uuid, scheduled_at, title, station_id) VALUES ('u-gs', 1, 'x', 2)`).run();
  try {
    withMutation(db, { table_name: 'generated_schedule', row_id: 'u-gs', op: 'delete',
                       payload_before: {}, payload_after: null, station_id: 2, actor_id: null },
      () => { db.prepare(`UPDATE generated_schedule SET deleted_at = '2026-09-14' WHERE uuid = 'u-gs'`).run(); });
  } catch (e) { /* registry may reject the table; the point is only that no asset moved */ }
  const after = db.prepare('SELECT COUNT(*) n FROM library_asset').get().n;
  if (after === before) pass('an unmarked table is a no-op — no caller has to ask whether it applies');
  else fail('deleting from an unmarked table changed library_asset');
}

db.close();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

console.log(failures === 0
  ? '\nVERDICT: PASS — the mirror is created with the row and dies with it, and nobody remembers to do it.\n'
  : `\nVERDICT: FAIL — ${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
