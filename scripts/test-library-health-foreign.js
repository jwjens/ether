#!/usr/bin/env node
/**
 * TEST: foreign-path classification in library-health.
 *
 * The gate this closes (OV, 2026-09-04): a row carrying ANOTHER MACHINE'S absolute path plus a
 * file_key was reported `resolvable` / `r2Only` / yellow, while the station could not air a single
 * track. H-2 is that regression, written down.
 *
 * Run:  npm run test:library-foreign
 * (needs Electron's ABI for better-sqlite3 — the npm script wraps it in ELECTRON_RUN_AS_NODE.)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { createLibraryHealth } = require('../electron/library-health');

let pass = 0; const failures = [];
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  failures.push(`${name}\n      expected: ${e}\n      actual:   ${a}`);
};

// ── a temp machine: a music dir with two real files, and a DB ──────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ether-lh-'));
const musicDir = path.join(tmp, 'music library');
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(musicDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

const LOCAL_FILE = path.join(musicDir, 'here.mp3');
fs.writeFileSync(LOCAL_FILE, 'x');
fs.writeFileSync(path.join(musicDir, 'moved.mp3'), 'x');   // present by BASENAME only

// A directory that genuinely does not exist on this machine — the OV condition.
const FOREIGN_DIR = path.join(tmp, 'not-my-machine', 'Users', 'someoneelse', 'Music');
const FOREIGN = (n) => path.join(FOREIGN_DIR, n);

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE songs (id INTEGER PRIMARY KEY, title TEXT, file_path TEXT, file_key TEXT,
                      station_id INTEGER, deleted_at TEXT);
  CREATE TABLE cart_slots (id INTEGER PRIMARY KEY, title TEXT, file_path TEXT,
                           station_id INTEGER, deleted_at TEXT);
  CREATE TABLE announcements (id INTEGER PRIMARY KEY, title TEXT, file_path TEXT,
                              station_id INTEGER, deleted_at TEXT);
`);

const lh = createLibraryHealth({
  getDb: () => db,
  musicDirFn: () => musicDir,
  userDataDir: dataDir,
  broadcast: () => {},
  licenseKeyFn: () => null,
  backendUrl: null,
});
const cls = (row, opts) => { lh.resetSweepCaches(); return lh.classifyRow(row, opts); };

// ── H-1..H-4 · the four resolution classes ─────────────────────────────────────────────────────
console.log('\n── resolution classes ──');
check('  H-1 file exists at the stored path → resolves, not foreign',
  cls({ file_path: LOCAL_FILE, file_key: null }), { cls: 'resolves', foreign: false });

check('  H-2 foreign dir + file_key + basename IS in music dir → resolvesElsewhere + foreign',
  cls({ file_path: FOREIGN('moved.mp3'), file_key: 'moved.mp3' }),
  { cls: 'resolvesElsewhere', foreign: true });

check('  H-3 foreign dir + file_key + NO basename match → r2Only + foreign',
  cls({ file_path: FOREIGN('never-seen.mp3'), file_key: 'never-seen.mp3' }),
  { cls: 'r2Only', foreign: true });

check('  H-4 no local file, no file_key → dead',
  cls({ file_path: FOREIGN('gone.mp3'), file_key: null }), { cls: 'dead', foreign: true });

// A file missing from a REAL local folder is a local problem, not a synced-path problem.
check('  H-4b missing file in an EXISTING local dir → dead but NOT foreign',
  cls({ file_path: path.join(musicDir, 'deleted-by-hand.mp3'), file_key: null }),
  { cls: 'dead', foreign: false });

// ── H-5 · the cart_slots carve-out ─────────────────────────────────────────────────────────────
console.log('\n── cart_slots never reports foreign ──');
check('  H-5 cart outside the music dir, file missing → dead, NOT foreign',
  cls({ file_path: FOREIGN('cart.mp3'), file_key: null }, { neverForeign: true }),
  { cls: 'dead', foreign: false });
check('  H-5b a cart whose file EXISTS outside the library still resolves',
  cls({ file_path: LOCAL_FILE }, { neverForeign: true }), { cls: 'resolves', foreign: false });

// ── H-6 · across tables, and the level ─────────────────────────────────────────────────────────
console.log('\n── classifyAll across tables ──');
db.prepare("INSERT INTO songs (title,file_path,file_key,station_id) VALUES (?,?,?,1)")
  .run('local', LOCAL_FILE, null);
db.prepare("INSERT INTO songs (title,file_path,file_key,station_id) VALUES (?,?,?,1)")
  .run('moved', FOREIGN('moved.mp3'), 'moved.mp3');
db.prepare("INSERT INTO songs (title,file_path,file_key,station_id) VALUES (?,?,?,1)")
  .run('cloud', FOREIGN('never-seen.mp3'), 'never-seen.mp3');
db.prepare("INSERT INTO announcements (title,file_path,station_id) VALUES (?,?,1)")
  .run('ann', FOREIGN('ann.mp3'));
db.prepare("INSERT INTO cart_slots (title,file_path,station_id) VALUES (?,?,1)")
  .run('cart', FOREIGN('cart.mp3'));

lh.resetSweepCaches();
const all = lh.classifyAll(db, 1);

check('  songs: 1 resolves',            all.byTable.songs.resolves, 1);
check('  songs: 1 resolvesElsewhere',   all.byTable.songs.resolvesElsewhere, 1);
check('  songs: 1 r2Only',              all.byTable.songs.r2Only, 1);
check('  songs: 2 foreign',             all.byTable.songs.foreign, 2);
check('  announcements: 1 dead (no file_key column ⇒ never r2Only)', all.byTable.announcements.dead, 1);
check('  announcements: 1 foreign',     all.byTable.announcements.foreign, 1);
check('  announcements: canFetch false', all.byTable.announcements.canFetch, false);
check('  cart_slots: 1 dead',           all.byTable.cart_slots.dead, 1);
check('  cart_slots: 0 foreign (carve-out)', all.byTable.cart_slots.foreign, 0);
check('  totals: 3 foreign across tables', all.totals.foreign, 3);

// H-6: the level rule the ruling fixed — foreign is RED, and never blocks.
const level = (dead, foreign, r2, elsewhere) =>
  (dead > 0 || foreign > 0) ? 'red' : (r2 > 0 || elsewhere > 0) ? 'yellow' : 'green';
console.log('\n── level ──');
check('  H-6 foreign > 0 ⇒ red',        level(0, 1, 0, 0), 'red');
check('  H-6b resolvesElsewhere ⇒ yellow (airing on a fallback)', level(0, 0, 0, 1), 'yellow');
check('  H-6c all resolve ⇒ green',     level(0, 0, 0, 0), 'green');

// ── the OV shape, end to end ───────────────────────────────────────────────────────────────────
console.log('\n── the OV regression, in one assertion ──');
const ov = cls({ file_path: FOREIGN('moved.mp3'), file_key: 'moved.mp3' });
check('  OV row is NOT reported as r2Only (it was, and the station was silent)', ov.cls !== 'r2Only', true);
check('  OV row IS reported foreign', ov.foreign, true);

// ── H-8 · the two matchers agree (2026-09-04 reconciliation) ───────────────────────────────────
// Re-sync matches tolerantly (norm: strips "_spotdown.org" and punctuation). The health classifier
// used exact basenames. So a row Re-sync would relink could be reported `dead` here. Both now ask
// the SAME index, and the tolerant key is tried after the exact one.
console.log('\n── the two matchers agree ──');
fs.writeFileSync(path.join(musicDir, 'Wolves_spotdown.org.mp3'), 'x');
lh.resetSweepCaches();
check('  H-8 a tolerant (norm) match counts as resolvesElsewhere, not dead',
  lh.classifyRow({ file_path: FOREIGN('Wolves.mp3'), file_key: null }).cls, 'resolvesElsewhere');
check('  H-8b punctuation/case differences still match',
  lh.classifyRow({ file_path: FOREIGN('wolves .MP3'), file_key: null }).cls, 'resolvesElsewhere');
check('  H-8c a genuinely absent file is still dead',
  lh.classifyRow({ file_path: FOREIGN('not-a-real-track.mp3'), file_key: null }).cls, 'dead');

// ── H-7 · the index is read once, not per row ──────────────────────────────────────────────────
console.log('\n── cost ──');
let reads = 0;
const realReaddir = fs.readdirSync;
fs.readdirSync = function (...a) { reads++; return realReaddir.apply(this, a); };
lh.resetSweepCaches();
for (let i = 0; i < 200; i++) lh.classifyRow({ file_path: FOREIGN(`x${i}.mp3`), file_key: 'k' });
fs.readdirSync = realReaddir;
check('  H-7 200 rows ⇒ the music dir is walked once', reads, 1);

// ── report ──────────────────────────────────────────────────────────────────────────────────────
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log('\n' + '─'.repeat(70));
if (failures.length) {
  console.log(`FAILED — ${failures.length} of ${pass + failures.length} checks\n`);
  for (const f of failures) console.log('  ✗ ' + f);
  console.log('');
  process.exit(1);
}
console.log(`PASS — all ${pass} checks\n`);
