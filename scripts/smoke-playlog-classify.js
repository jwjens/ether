'use strict';
// scripts/smoke-playlog-classify.js — logPlay must classify what aired, and SAY SO.
//
// This exists because the classifier was silently dead for months. `logPlay` derives content_class
// from the library when the caller does not pass one, and its first query carried `AND station_id = ?`
// against `songs` — a column songs lost when it went install-scoped (Phase-4, Direction C). So the
// query threw, the catch that exists to keep logging from breaking playout swallowed it, the spots
// branch was never reached, and EVERY COMMERCIAL EVER AIRED WAS LOGGED AS MUSIC. Measured on the live
// install: 35,826 MUSIC / 14,073 JIN / 7 ANN / ZERO SPOT.
//
// The catch is correct — a logging fault must never reach the audio path — which is exactly why this
// needs a test rather than a reader's attention. A swallowed error has no symptom until someone
// builds a filter and notices the Spots button is empty.
//
//   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/smoke-playlog-classify.js

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const playlog  = require(path.join(__dirname, '..', 'audiod', 'playlog.js'));

const dbPath = path.join(os.tmpdir(), `ether-classify-smoke-${process.pid}.db`);
try { fs.unlinkSync(dbPath); } catch {}
const db = new Database(dbPath);

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? '' : `\n         got:  ${JSON.stringify(got)}\n         want: ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

console.log('=== smoke-playlog-classify ===');

// THE SCHEMA COMES FROM THE REAL BASELINE + THE FULL MIGRATION CHAIN, not a hand-rolled fixture.
// Hand-rolling it meant chasing one missing table at a time (play_count, client_identity,
// system_state...) and, worse, testing against a shape the product does not actually have — which is
// the very class of mistake this smoke exists to catch.
require(path.join(__dirname, 'schema-v0-baseline.js'))(db);
{
  const MIGRATION_RE = /^migrate-.+-phase-sync-(\d+)\.js$/;
  const applied = new Set(db.prepare('SELECT version FROM schema_version').all().map(r => r.version));
  const scripts = [];
  for (const f of fs.readdirSync(__dirname)) {
    const m = MIGRATION_RE.exec(f);
    if (m) scripts.push({ v: parseInt(m[1], 10), file: f });
  }
  scripts.sort((a, b) => a.v - b.v);
  for (const { v, file } of scripts) {
    if (applied.has(v)) continue;
    try { require(path.join(__dirname, file)).applyMigration(db); } catch (e) { /* same fail-soft as the app */ }
  }
}
// The mutation writer stamps every journal row with this machine's client_id.
try { db.prepare("INSERT OR IGNORE INTO client_identity (id, client_id, created_at) VALUES (1, 'smoke-client', '2026-08-26T00:00:00.000Z')").run(); } catch {}

const scls = db.prepare('PRAGMA table_info(songs)').all().map(c => c.name);
console.log('  schema built — songs.station_id present:', scls.includes('station_id'), '(must be false)');

db.prepare("INSERT INTO songs (title, file_path, content_class) VALUES ('A Song','C:\\lib\\song.mp3','MUSIC')").run();
db.prepare("INSERT INTO songs (title, file_path, content_class) VALUES ('An ID','C:\\lib\\jingle.mp3','JIN')").run();
db.prepare("INSERT INTO spots (title, file_path, station_id) VALUES ('OV Spot','C:\\ads\\ov.mp3',2)").run();

const logged = (title) =>
  db.prepare("SELECT content_class FROM play_log WHERE title = ? ORDER BY id DESC LIMIT 1").get(title)?.content_class;

const fire = (o) => { try { playlog.logPlay(db, { stationId: 2, sessionId: 'S', deck: 'A', durationMs: 1000, ...o }); } catch (e) { console.log('  logPlay threw:', e.message); } };

console.log('\n── THE REGRESSION: a spot must log as SPOT ──');
fire({ title: 'OV Spot', filePath: 'C:\\ads\\ov.mp3' });
check('a file in `spots` classifies SPOT', logged('OV Spot'), 'SPOT');

console.log('\n── the library still wins when the file is a song ──');
fire({ title: 'A Song', filePath: 'C:\\lib\\song.mp3' });
check('a MUSIC song classifies MUSIC', logged('A Song'), 'MUSIC');
fire({ title: 'An ID', filePath: 'C:\\lib\\jingle.mp3' });
check('a JIN song classifies JIN from the library', logged('An ID'), 'JIN');

console.log('\n── an explicit hint always wins ──');
fire({ title: 'Announcement', filePath: 'C:\\ann\\close.mp3', contentClass: 'ANN' });
check('caller-supplied ANN is kept', logged('Announcement'), 'ANN');
fire({ title: 'Forced', filePath: 'C:\\ads\\ov.mp3', contentClass: 'JIN' });
check('an explicit class beats the spots lookup', logged('Forced'), 'JIN');

console.log('\n── unknown files, and the station scope that DOES apply ──');
fire({ title: 'Stray', filePath: 'C:\\nowhere\\x.mp3' });
check('a file in neither table falls back to MUSIC', logged('Stray'), 'MUSIC');
fire({ title: 'Other Station', filePath: 'C:\\ads\\ov.mp3', stationId: 99 });
check("another station's play does NOT borrow station 2's spot", logged('Other Station'), 'MUSIC');

console.log('\n── a soft-deleted spot is not a spot ──');
db.prepare("UPDATE spots SET deleted_at = '2026-01-01' WHERE file_path = 'C:\\ads\\ov.mp3'").run();
fire({ title: 'Deleted Spot', filePath: 'C:\\ads\\ov.mp3' });
check('deleted spot classifies MUSIC', logged('Deleted Spot'), 'MUSIC');

console.log('\n── the guard that hid this for months ──');
// The catch must still be there: a broken library table must not stop the row being logged at all.
db.prepare('DROP TABLE songs').run();
fire({ title: 'No Library', filePath: 'C:\\lib\\song.mp3' });
check('a logging fault still never breaks the write — the row lands as MUSIC', logged('No Library'), 'MUSIC');

console.log('\n──────────────────────────────');
console.log(`  Passed: ${pass}  Failed: ${fail}`);
console.log(`  VERDICT: ${fail === 0 ? 'PASS' : 'FAIL'}`);
console.log('──────────────────────────────');

db.close();
try { fs.unlinkSync(dbPath); } catch {}
process.exit(fail === 0 ? 0 : 1);
