#!/usr/bin/env node
/**
 * TEST: Re-sync / Relocate must NOT push this machine's absolute paths to peers.
 *
 * THE BUG THIS GATES (OV, 2026-09-04). `applyRelink` wrote songs.file_path through the sync-logged
 * writer. `file_path` is a blob-ref column, and in sync-protocol v0 a blob-ref ships the LITERAL
 * ABSOLUTE PATH — so every Re-sync and every Relocate broadcast `C:\Users\<me>\...` to every peer,
 * from a button an operator presses right after moving their library. 382 rows landed on OV naming
 * a directory it cannot open, and every announcement, sweeper and cart on that machine went silent.
 *
 * The relink now writes the column directly. This asserts that it still relinks, and that it logs
 * nothing.
 *
 * Run: npm run test:relink
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { applyRelink } = require('../electron/library-folders');

let pass = 0; const failures = [];
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  failures.push(`${name}\n      expected: ${e}\n      actual:   ${a}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ether-relink-'));
const FOUND = path.join(tmp, 'Found Song.mp3');
fs.writeFileSync(FOUND, 'x');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE songs (id INTEGER PRIMARY KEY, title TEXT, file_path TEXT, updated_at TEXT);
  CREATE TABLE generated_schedule (id INTEGER PRIMARY KEY, station_id INTEGER, song_id INTEGER,
                                   title TEXT, file_path TEXT, deleted_at TEXT);
  -- Stands in for the real mutation log. If anything in the relink path logs, this fills up.
  CREATE TABLE mutations (id INTEGER PRIMARY KEY, table_name TEXT, row_id TEXT, payload_after TEXT);
`);
db.prepare("INSERT INTO songs (id,title,file_path,updated_at) VALUES (1,'Found Song',?,'2026-01-01')")
  .run('C:\\Users\\someoneelse\\Music\\Found Song.mp3');
db.prepare("INSERT INTO songs (id,title,file_path,updated_at) VALUES (2,'Gone Song',?,'2026-01-01')")
  .run('C:\\Users\\someoneelse\\Music\\Gone Song.mp3');
db.prepare("INSERT INTO generated_schedule (station_id,song_id,title,file_path) VALUES (1,1,'Found Song',?)")
  .run('C:\\Users\\someoneelse\\Music\\Found Song.mp3');
db.prepare("INSERT INTO generated_schedule (station_id,song_id,title,file_path) VALUES (1,2,'Gone Song',?)")
  .run('C:\\Users\\someoneelse\\Music\\Gone Song.mp3');

// A relink result as matchStation would produce it: one found, one missing.
const result = {
  matches: [{ songId: 1, title: 'Found Song', file: FOUND }],
  missing: [{ songId: 2, title: 'Gone Song' }],
};

// deps deliberately carries NO songsUpdateById — main.js no longer passes one. If applyRelink ever
// reaches for a sync-logged writer again, this throws rather than silently leaking.
const deps = {
  get songsUpdateById() {
    throw new Error('applyRelink reached for the SYNC-LOGGED writer — that is the OV defect');
  },
};

const applied = applyRelink(db, 1, result, deps);

console.log('\n── it still relinks ──');
check('  the match is written to songs.file_path',
  db.prepare('SELECT file_path FROM songs WHERE id=1').get().file_path, FOUND);
check('  the match is written to generated_schedule',
  db.prepare('SELECT file_path FROM generated_schedule WHERE song_id=1').get().file_path, FOUND);
check('  the miss is NULLed so the scheduler skips it',
  db.prepare('SELECT file_path FROM generated_schedule WHERE song_id=2').get().file_path, null);
check('  linked count', applied.linked, 1);

console.log('\n── no silent failure ──');
check('  unlinked misses are COUNTED and reported', applied.unlinked, 1);

console.log('\n── THE GATE: nothing is logged for a peer ──');
check('  the mutation log is empty',
  db.prepare('SELECT COUNT(*) n FROM mutations').get().n, 0);
check('  the miss row is untouched in songs (only gs is NULLed)',
  db.prepare('SELECT file_path FROM songs WHERE id=2').get().file_path,
  'C:\\Users\\someoneelse\\Music\\Gone Song.mp3');
check('  updated_at is NOT bumped — a relink is not an edit peers should see',
  db.prepare('SELECT updated_at FROM songs WHERE id=1').get().updated_at, '2026-01-01');

// ── the library ROOT is per-machine and read-through ───────────────────────────────────────────
// music_dir is now in LOCAL_ONLY_KEYS, so it is never broadcast. getFolder prefers the per-machine
// value and falls back to a stale per-station row only when the machine has none — so an install
// that only ever set a per-station folder does not lose its library on upgrade.
const { getFolder } = require('../electron/library-folders');
const LEGACY = 'C:\\legacy\\per-station';
const MACHINE = 'D:\\machine\\audio library';
db.exec("CREATE TABLE station_config_kv (station_id INTEGER, key TEXT, value TEXT, deleted_at TEXT)");
db.prepare("INSERT INTO station_config_kv VALUES (1,'music_dir',?,NULL)").run(LEGACY);

console.log('\n── the library root ──');
check('  per-machine value wins',
  getFolder(db, 1, { getMachineMusicDir: () => MACHINE }), MACHINE);
check('  falls back to the stale per-station row when the machine has none',
  getFolder(db, 1, { getMachineMusicDir: () => null }), LEGACY);
check('  survives a throwing accessor rather than losing the library',
  getFolder(db, 1, { getMachineMusicDir: () => { throw new Error('nope'); } }), LEGACY);
check('  no deps at all still resolves the legacy row',
  getFolder(db, 1, undefined), LEGACY);

const { isLocalOnlyKey } = require('../electron/sync/handlers/station_config_kv');
check('  music_dir is LOCAL-ONLY — the root is never broadcast', isLocalOnlyKey('music_dir'), true);

// ── Re-sync sees EVERY audio table, not just music ─────────────────────────────────────────────
// Re-sync only ever considered `songs` filtered to content_class MUSIC. On OV the announcements,
// sweepers and carts were the things that were silent, and the one tool for "my files moved" could
// not see them.
const { matchStation } = require('../electron/library-folders');
const ANN = path.join(tmp, 'Legal ID.mp3');
fs.writeFileSync(ANN, 'x');
db.exec(`
  CREATE TABLE clock_slots (station_id INTEGER, slot_type TEXT, category_id INTEGER, deleted_at TEXT);
  CREATE TABLE announcements (id INTEGER PRIMARY KEY, title TEXT, file_path TEXT,
                              station_id INTEGER, deleted_at TEXT);
  CREATE TABLE cart_slots (id INTEGER PRIMARY KEY, title TEXT, file_path TEXT,
                           station_id INTEGER, deleted_at TEXT);
`);
db.prepare("INSERT INTO announcements (id,title,file_path,station_id) VALUES (1,'Legal ID',?,1)")
  .run('C:\\Users\\someoneelse\\Music\\Legal ID.mp3');
db.prepare("INSERT INTO cart_slots (id,title,file_path,station_id) VALUES (1,'Cart 1',?,1)")
  .run('C:\\Users\\someoneelse\\Downloads\\never-existed.mp3');

const r2 = matchStation(db, 1, tmp);
console.log('\n── Re-sync covers every audio table ──');
check('  an announcement pointing at a foreign path is FOUND in the library', r2.assets.length, 1);
check('  ...and it is the announcement', r2.assets[0].table, 'announcements');
check('  a cart with no matching file is reported missing, not silently dropped',
  r2.assetsMissing.some(a => a.table === 'cart_slots'), true);

const applied2 = applyRelink(db, 1, r2, deps);
check('  the announcement row is repointed into the library',
  db.prepare('SELECT file_path FROM announcements WHERE id=1').get().file_path, ANN);
check('  relinkedAssets is reported', applied2.relinkedAssets, 1);
check('  assetsMissing is reported', applied2.assetsMissing, 1);
check('  the cart is left alone rather than blanked',
  db.prepare('SELECT file_path FROM cart_slots WHERE id=1').get().file_path,
  'C:\\Users\\someoneelse\\Downloads\\never-existed.mp3');
check('  STILL nothing logged for a peer', db.prepare('SELECT COUNT(*) n FROM mutations').get().n, 0);

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log('\n' + '─'.repeat(70));
if (failures.length) {
  console.log(`FAILED — ${failures.length} of ${pass + failures.length} checks\n`);
  for (const f of failures) console.log('  ✗ ' + f);
  console.log('');
  process.exit(1);
}
console.log(`PASS — all ${pass} checks\n`);
