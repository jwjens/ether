#!/usr/bin/env node
/**
 * TEST: the audio-library resolver tier, on BOTH sides.
 *
 * Jeff, 2026-09-04: "Fixing one without the other gets me announcements on decks while nothing airs,
 * or the reverse." So this asserts the shared resolution order, and — the part that actually broke —
 * that resolving RETURNS A CORRECTED PATH rather than only answering a yes/no question.
 *
 * The OV condition: a row arrives naming C:\Users\someoneelse\..., the bytes are in THIS machine's
 * audio library under the right name, and the station must air it.
 *
 * Run: npm run test:resolver
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildIndex, findInIndex } = require('../electron/audio-library-index');

let pass = 0; const failures = [];
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  failures.push(`${name}\n      expected: ${e}\n      actual:   ${a}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ether-res-'));
const LIB = path.join(tmp, 'ether music library');
fs.mkdirSync(LIB, { recursive: true });

const HERE = path.join(LIB, 'Wolves.mp3');
fs.writeFileSync(HERE, 'x');
fs.writeFileSync(path.join(LIB, 'She Wolf_spotdown.org.mp3'), 'x');

// The exact shape that silenced OV.
const FOREIGN = 'C:\\Users\\someoneelse\\Music\\ether music library\\Wolves.mp3';
const FOREIGN_TOLERANT = 'C:\\Users\\someoneelse\\Music\\ether music library\\She Wolf.mp3';
const FOREIGN_ABSENT = 'C:\\Users\\someoneelse\\Music\\ether music library\\Never Had It.mp3';

const index = buildIndex(LIB);

console.log('\n── the shared resolution order ──');
check('  R-1 a foreign path whose basename is in the library resolves',
  findInIndex(index, FOREIGN), HERE);
check('  R-2 ...and resolves to a path INSIDE the library, not the foreign one',
  findInIndex(index, FOREIGN) !== FOREIGN, true);
check('  R-3 the tolerant key still applies (strips _spotdown.org)',
  findInIndex(index, FOREIGN_TOLERANT), path.join(LIB, 'She Wolf_spotdown.org.mp3'));
check('  R-4 a file genuinely absent resolves to nothing',
  findInIndex(index, FOREIGN_ABSENT), null);
check('  R-5 no path resolves to nothing', findInIndex(index, null), null);

// ── the property that was actually broken ─────────────────────────────────────────────────────
// `_fileOk` answered a BOOLEAN. A row could pass the gate and then be loaded from the path that
// does not exist, because nothing rewrote it. Both sides must hand back the corrected path.
console.log('\n── it returns a PATH, not a verdict ──');
const resolved = findInIndex(index, FOREIGN);
check('  R-6 the resolved path exists on this machine', fs.existsSync(resolved), true);
check('  R-7 the foreign path does NOT exist (the point of the exercise)', fs.existsSync(FOREIGN), false);

// ── both sides read the same module ───────────────────────────────────────────────────────────
console.log('\n── one implementation, both processes ──');
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
const daemonSrc = fs.readFileSync(path.join(__dirname, '..', 'audiod', 'engine.js'), 'utf8');
check('  R-8 main.js resolveLocalAudioPath consults the library index',
  /_libIndexCached\(\)/.test(mainSrc) && /findInIndex/.test(mainSrc), true);
check('  R-9 the daemon consults the same module',
  /audio-library-index/.test(daemonSrc) && /_resolveLocal/.test(daemonSrc), true);
check('  R-10 the daemon REWRITES filePath rather than only filtering',
  /filePath: rp/.test(daemonSrc) || /filePath: r \}/.test(daemonSrc), true);
check('  R-11 main tries the library BEFORE R2',
  mainSrc.indexOf('library tier failed') < mainSrc.indexOf('attempting R2 fallback'), true);

// ── the leak that rode with this ──────────────────────────────────────────────────────────────
console.log('\n── the download no longer broadcasts paths ──');
check('  R-12 the R2 download writes file_path with a direct UPDATE, not the sync writer',
  /UPDATE songs SET file_path = \? WHERE id = \?/.test(mainSrc), true);
// Assert the PROPERTY, not a comment. The first version of this check matched on comment text and
// broke the moment the block was rewritten — while the property it guarded was still true. A test
// that fails for the wrong reason teaches you to ignore it.
const dlStart = mainSrc.indexOf("ipcMain.handle('library:sync-r2:download'");
const dlEnd = mainSrc.indexOf("ipcMain.handle('library:sync-r2:download:cancel'", dlStart);
// Comments are stripped first: the handler carries a comment explaining what it USED to do, and
// matching against prose would fail on a description of the very defect that was removed.
const dlBody = mainSrc
  .slice(dlStart, dlEnd > dlStart ? dlEnd : dlStart + 6000)
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
// THE GATE THAT MATTERS, and the one that ships: no sync-logged writer anywhere in the bulk
// download, so a restore cannot broadcast this machine's paths to its peers.
check('  R-13 the bulk download contains NO sync-logged writer at all',
  dlStart > 0 && !/songsUpdateById/.test(dlBody), true);
check('  R-13b ...and its path write is a direct, local-only UPDATE',
  /UPDATE songs SET file_path = \? WHERE id = \?/.test(dlBody), true);

// NOTE (2026-09-05): an earlier version of R-13b asserted the download no longer enumerates `songs`
// at all. That was true of the FOLDER-DRIVEN download, which is HELD — it is only correct once the
// catalogue folder is one Ether owns, and today it is the operator's shared music folder. The
// download is songs-driven again for this release; the leak fix above is what stays. Re-assert the
// stronger property when the dedicated-folder move ships
// (docs/dedicated-catalogue-folder-plan-2026-09-04.md).

// ── packaging: the daemon must be able to require it ──────────────────────────────────────────
console.log('\n── packaging ──');
const eb = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'electron-builder.json'), 'utf8'));
check('  R-14 audio-library-index.js is asarUnpacked (the daemon runs unpacked and requires it)',
  (eb.asarUnpack || []).includes('electron/audio-library-index.js'), true);

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log('\n' + '─'.repeat(70));
if (failures.length) {
  console.log(`FAILED — ${failures.length} of ${pass + failures.length} checks\n`);
  for (const f of failures) console.log('  ✗ ' + f);
  console.log('');
  process.exit(1);
}
console.log(`PASS — all ${pass} checks\n`);
