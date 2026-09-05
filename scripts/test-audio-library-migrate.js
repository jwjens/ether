#!/usr/bin/env node
/**
 * TEST: bringing rows into the audio library.
 *
 * THE RULE: every audio file lives in the audio library; nothing points outside it. A row that
 * RESOLVES is not automatically a row that COMPLIES — the ten carts on the dev machine played
 * perfectly from Downloads and were exactly the defect.
 *
 * The gates that matter most:
 *   M-2  REPOINT never copies — 8 of 10 carts already had their file in the library, and a
 *        migration that copied anyway would have manufactured 8 duplicates.
 *   M-9  running it twice changes nothing the second time.
 *   M-6  a failed copy leaves the ROW alone. Copy → verify → then write, never the reverse.
 *   M-11 nothing is logged for a peer.
 *
 * Run: npm run test:audio-library
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { planMigration, applyMigration, repointOne, suggestFor } = require('../electron/audio-library-migrate');

let pass = 0; const failures = [];
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  failures.push(`${name}\n      expected: ${e}\n      actual:   ${a}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ether-mig-'));
const LIB = path.join(tmp, 'ether music library');
const DOWNLOADS = path.join(tmp, 'Downloads');
fs.mkdirSync(LIB, { recursive: true });
fs.mkdirSync(DOWNLOADS, { recursive: true });

// The dev machine's actual shape, in miniature.
const inLib      = (n, body = 'x') => { const p = path.join(LIB, n); fs.writeFileSync(p, body); return p; };
const inDownloads = (n, body = 'x') => { const p = path.join(DOWNLOADS, n); fs.writeFileSync(p, body); return p; };

const CART_A_DL = inDownloads('growl.mp3');           // ALSO in the library → REPOINT, no copy
inLib('growl.mp3');
const CART_B_DL = inDownloads('unique.mp3', 'yyyy');  // only in Downloads → COPY
const ALREADY   = inLib('settled.mp3');               // already inside → nothing
const GONE      = path.join(DOWNLOADS, 'vanished.mp3');   // never created

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE cart_slots (id INTEGER PRIMARY KEY, title TEXT, file_path TEXT, deleted_at TEXT);
  CREATE TABLE songs (id INTEGER PRIMARY KEY, title TEXT, file_path TEXT, file_key TEXT, deleted_at TEXT);
  CREATE TABLE mutations (id INTEGER PRIMARY KEY, table_name TEXT);
`);
const ins = db.prepare("INSERT INTO cart_slots (id,title,file_path) VALUES (?,?,?)");
ins.run(1, 'growl', CART_A_DL);
ins.run(2, 'unique', CART_B_DL);
ins.run(3, 'settled', ALREADY);
ins.run(4, 'vanished', GONE);

const plan = planMigration(db, LIB);
const byId = Object.fromEntries(plan.rows.map(r => [r.id, r]));

console.log('\n── the plan ──');
check('  M-1 a file already in the library → REPOINT', byId[1].action, 'REPOINT');
check('  M-1b ...pointing at the library copy', byId[1].to, path.join(LIB, 'growl.mp3'));
check('  M-3 a file only outside → COPY', byId[2].action, 'COPY');
check('  M-4 a row already inside → ALREADY_INSIDE', byId[3].action, 'ALREADY_INSIDE');
check('  M-5 a source that is gone → GONE', byId[4].action, 'GONE');

const before = fs.readdirSync(LIB).length;
const done = applyMigration(db, plan);

console.log('\n── applied ──');
check('  M-2 REPOINT copied NOTHING (no duplicates manufactured)',
  fs.readdirSync(LIB).filter(f => f === 'growl.mp3').length, 1);
check('  the library gained exactly one file (the COPY)', fs.readdirSync(LIB).length, before + 1);
check('  copied count', done.copied, 1);
check('  repointed count (REPOINT + COPY)', done.repointed, 2);
check('  already-inside skipped', done.skipped, 1);

check('  row 1 now points into the library',
  db.prepare('SELECT file_path FROM cart_slots WHERE id=1').get().file_path, path.join(LIB, 'growl.mp3'));
check('  row 2 now points into the library',
  db.prepare('SELECT file_path FROM cart_slots WHERE id=2').get().file_path, path.join(LIB, 'unique.mp3'));
check('  M-7 the GONE row is REPORTED, not blanked',
  db.prepare('SELECT file_path FROM cart_slots WHERE id=4').get().file_path, GONE);
check('  ...and named in failures', done.failed.some(f => f.id === 4), true);

console.log('\n── the gate: nothing is logged for a peer ──');
check('  M-11 mutation log empty', db.prepare('SELECT COUNT(*) n FROM mutations').get().n, 0);

console.log('\n── idempotent ──');
const plan2 = planMigration(db, LIB);
const done2 = applyMigration(db, plan2);
check('  M-9 second run copies nothing', done2.copied, 0);
check('  M-9b second run repoints nothing', done2.repointed, 0);
check('  M-9c library file count unchanged', fs.readdirSync(LIB).length, before + 1);

console.log('\n── collisions ──');
// Same name, DIFFERENT bytes: must disambiguate, never overwrite — another row may point at it.
const CLASH = inDownloads('growl.mp3', 'different-bytes-entirely');
db.prepare("INSERT INTO cart_slots (id,title,file_path) VALUES (5,'clash',?)").run(CLASH);
const plan3 = planMigration(db, LIB);
const row5 = plan3.rows.find(r => r.id === 5);
check('  M-8 a same-name/different-size file is COPIED, not reused', row5.action, 'COPY');
check('  M-8b ...under a disambiguated name', path.basename(row5.to), 'growl (2).mp3');
applyMigration(db, plan3);
check('  M-8c the original library file was NOT overwritten',
  fs.readFileSync(path.join(LIB, 'growl.mp3'), 'utf8'), 'x');

console.log('\n── single-row repoint (CHANGE FILE LOCATION) ──');
const target = path.join(LIB, 'settled.mp3');
check('  M-10 repoints one row', repointOne(db, 'cart_slots', 1, target).ok, true);
check('  ...and only that row',
  db.prepare('SELECT file_path FROM cart_slots WHERE id=2').get().file_path, path.join(LIB, 'unique.mp3'));
check('  refuses a file that is not on this machine',
  repointOne(db, 'cart_slots', 1, path.join(LIB, 'nope.mp3')).error, 'that file is not on this machine');
check('  refuses a table that is not an audio table',
  repointOne(db, 'stations', 1, target).ok, false);
check('  still nothing logged', db.prepare('SELECT COUNT(*) n FROM mutations').get().n, 0);

console.log('\n── the suggestion (CHANGE FILE LOCATION offers the obvious candidate) ──');
check('  M-12 suggests the library copy for a Downloads path',
  suggestFor(LIB, path.join(DOWNLOADS, 'growl.mp3')), path.join(LIB, 'growl.mp3'));
check('  M-12b no suggestion when the library has nothing matching',
  suggestFor(LIB, path.join(DOWNLOADS, 'never-heard-of-it.mp3')), null);

// ── COPY-ON-IMPORT ─────────────────────────────────────────────────────────────────────────────
// The door every audio file now comes through. Order is the whole point: copy -> verify -> only
// then may the caller write a row.
const { importIntoLibrary } = require('../electron/audio-library-migrate');
console.log('\n── copy-on-import ──');

const fresh = inDownloads('brand-new.mp3', 'zzz');
const i1 = importIntoLibrary(LIB, fresh);
check('  I-1 a new file is copied in', i1.action, 'copied');
check('  I-1b ...and the returned path is inside the library', i1.path.startsWith(LIB), true);
check('  I-1c ...and the bytes match', fs.readFileSync(i1.path, 'utf8'), 'zzz');

const i2 = importIntoLibrary(LIB, fresh);
check('  I-2 importing the SAME file again reuses it (no duplicate)', i2.action, 'reused');
check('  I-2b ...same path', i2.path, i1.path);

const i3 = importIntoLibrary(LIB, i1.path);
check('  I-3 importing FROM the library does not duplicate', i3.action, 'already-inside');

const i4 = importIntoLibrary(LIB, path.join(DOWNLOADS, 'no-such-file.mp3'));
check('  I-4 a missing source is refused', i4.ok, false);
check('  I-4b ...with a code the UI can act on', i4.code, 'missing');

const i5 = importIntoLibrary(LIB, null);
check('  I-5 no source is refused', i5.code, 'no_source');
const i6 = importIntoLibrary(null, fresh);
check('  I-6 no library is refused', i6.code, 'no_library');

// Same name, DIFFERENT bytes. The operator has a different cut of a track that happens to share a
// filename with one already in the library. It must be kept, and the existing one must survive —
// another row may already point at it.
fs.writeFileSync(path.join(DOWNLOADS, 'brand-new.mp3'), 'a completely different recording');
const i7 = importIntoLibrary(LIB, path.join(DOWNLOADS, 'brand-new.mp3'));
check('  I-7 same name, different bytes -> copied under a new name', i7.action, 'copied');
check('  I-7b ...disambiguated', path.basename(i7.path), 'brand-new (2).mp3');
check('  I-7c ...the original library file is untouched',
  fs.readFileSync(path.join(LIB, 'brand-new.mp3'), 'utf8'), 'zzz');

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log('\n' + '─'.repeat(70));
if (failures.length) {
  console.log(`FAILED — ${failures.length} of ${pass + failures.length} checks\n`);
  for (const f of failures) console.log('  ✗ ' + f);
  console.log('');
  process.exit(1);
}
console.log(`PASS — all ${pass} checks\n`);
