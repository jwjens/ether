'use strict';
// scripts/smoke-spot-retraction.js — a deleted or deactivated spot, or voice track, stops airing.
//
// Jeff, 2026-09-14 (OV, on air): "the Opportunity Village spot I deleted is STILL BEING SCHEDULED
// and airing." A deleted spot still airing is an advertiser problem, not a panel problem.
//
// WHAT THIS HAS TO PROVE, and why a passing suite elsewhere proved none of it: Generate does not
// schedule a REFERENCE to a spot, it schedules a FROZEN COPY (generate-core.js:333/:423 — song_id
// NULL, file_path copied in, no spot_id column anywhere). So the delete flag and the thing that
// actually airs are two different rows, and every check below is about the second one.
//
// It also pins the three PRESERVATIONS. Retracting too much is the worse bug: play_log is the
// advertiser's airplay proof, and 'playing' is audio going out of the transmitter right now.
//
// Runs on a temp file, touches nothing else:
//   ELECTRON_RUN_AS_NODE=1 electron scripts/smoke-spot-retraction.js
//   node scripts/smoke-spot-retraction.js

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

const { retractSpotReferences } = require(path.join(HERE, '..', 'electron', 'sync', 'handlers', 'spots'));
const { retractVoiceTrackReferences } = require(path.join(HERE, '..', 'electron', 'sync', 'handlers', 'voice_tracks'));

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures++; console.log(`  FAIL  ${m}`); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ether-spotret-'));
const db = new Database(path.join(dir, 't.db'));

db.exec(`
  CREATE TABLE spots (
    id INTEGER PRIMARY KEY, uuid TEXT, title TEXT, file_path TEXT,
    is_active INTEGER DEFAULT 1, station_id INTEGER, deleted_at TEXT, updated_at TEXT);
  CREATE TABLE voice_tracks (
    id INTEGER PRIMARY KEY, uuid TEXT, title TEXT, file_path TEXT,
    station_id INTEGER, deleted_at TEXT, updated_at TEXT);
  CREATE TABLE generated_schedule (
    id INTEGER PRIMARY KEY, uuid TEXT, scheduled_at INTEGER, song_id INTEGER,
    title TEXT, artist TEXT, file_path TEXT, duration_s INTEGER, station_id INTEGER,
    state TEXT DEFAULT 'pending', content_class TEXT DEFAULT 'MUSIC', source TEXT,
    deleted_at TEXT, updated_at TEXT);
`);

const OV_SPOT = 'C:\\cat\\opportunity-village.wav';
const GC_SPOT = 'C:\\cat\\gc-sponsorship.wav';
const NOW = '2026-09-14T18:00:00.000Z';

const spot = { id: 1, uuid: 'u-ov', title: 'Opportunity Village', file_path: OV_SPOT, station_id: 2 };
db.prepare('INSERT INTO spots (id,uuid,title,file_path,is_active,station_id) VALUES (?,?,?,?,1,?)')
  .run(spot.id, spot.uuid, spot.title, spot.file_path, spot.station_id);

const ins = db.prepare(`INSERT INTO generated_schedule
  (scheduled_at, song_id, title, file_path, station_id, state, content_class)
  VALUES (?, NULL, ?, ?, ?, ?, 'SPOT')`);

// The log as Generate left it: the OV spot placed six times today, in every state.
ins.run(1000, spot.title, OV_SPOT, 2, 'played');    // aired at 09:00 — HISTORY
ins.run(2000, spot.title, OV_SPOT, 2, 'missed');    // skipped at 10:00 — HISTORY
ins.run(3000, spot.title, OV_SPOT, 2, 'playing');   // ON AIR RIGHT NOW
ins.run(4000, spot.title, OV_SPOT, 2, 'pending');   // future
ins.run(5000, spot.title, OV_SPOT, 2, 'pending');   // future
ins.run(6000, spot.title, GC_SPOT, 2, 'pending');   // a DIFFERENT advertiser
ins.run(7000, spot.title, OV_SPOT, 3, 'pending');   // OV file, ANOTHER STATION
// A music row that happens to sit at the same time — must never be touched.
db.prepare(`INSERT INTO generated_schedule (scheduled_at, song_id, title, file_path, station_id, state, content_class)
            VALUES (8000, 42, 'A Song', 'C:\\cat\\song.mp3', 2, 'pending', 'MUSIC')`).run();

const live = (where, ...a) =>
  db.prepare(`SELECT COUNT(*) n FROM generated_schedule WHERE deleted_at IS NULL AND ${where}`).get(...a).n;

console.log('\n== a deleted spot stops airing ==');

const res = retractSpotReferences(db, spot, NOW);

if (res.pendingLog === 2) pass('retracted exactly the 2 pending rows for this spot at this station');
else fail(`retracted ${res.pendingLog} rows — expected 2`);

if (live("file_path = ? AND station_id = 2 AND state = 'pending'", OV_SPOT) === 0)
  pass('no future airing of the deleted spot survives');
else fail('a pending row for the deleted spot is STILL LIVE — it will air');

console.log('\n== and never edits its past ==');

if (live("file_path = ? AND state = 'played'", OV_SPOT) === 1)
  pass("'played' preserved — the advertiser's airplay proof is untouched");
else fail("a 'played' row was retracted — airplay history destroyed");

if (live("file_path = ? AND state = 'missed'", OV_SPOT) === 1)
  pass("'missed' preserved — the record of what did not air stands");
else fail("a 'missed' row was retracted");

if (live("file_path = ? AND state = 'playing'", OV_SPOT) === 1)
  pass("'playing' preserved — audio on air right now is never yanked");
else fail("the ON-AIR row was retracted — audio pulled from under the operator");

console.log('\n== and touches nothing else ==');

if (live("file_path = ?", GC_SPOT) === 1) pass("another advertiser's spot is untouched");
else fail("a different advertiser's spot was retracted");

if (live("file_path = ? AND station_id = 3", OV_SPOT) === 1)
  pass('the same file at ANOTHER STATION is untouched — retraction is station-scoped');
else fail('another station lost its airing — stations must not retract each other');

if (live("content_class = 'MUSIC'") === 1) pass('music rows are untouched');
else fail('a music row was retracted');

console.log('\n== edge cases that must not throw ==');

{
  const r = retractSpotReferences(db, { title: 'no file', station_id: 2, file_path: null }, NOW);
  if (r.pendingLog === 0) pass('a spot with no file_path retracts nothing and does not throw');
  else fail('a spot with no path retracted something');
}
{
  const r = retractSpotReferences(db, null, NOW);
  if (r && r.pendingLog === 0) pass('a null spot is a no-op, not a crash inside a delete');
  else fail('a null spot was not handled');
}
{
  // Second call on the same spot: already retracted, so nothing left to do.
  const r = retractSpotReferences(db, spot, NOW);
  if (r.pendingLog === 0) pass('re-running is idempotent — no double retraction');
  else fail(`a second run retracted ${r.pendingLog} more rows`);
}

console.log('\n== a deleted VOICE TRACK stops airing too ==');

// THE TRAP THIS SECTION EXISTS FOR. schedule:insertVoiceTrack (main.js:8624) does not set
// content_class, and the column DEFAULTS TO 'MUSIC' -- so a placed take sits in the log labelled
// MUSIC, indistinguishable from a song except that its song_id is NULL and it carries its own
// file_path. On OV's real database, 2026-09-14: 37 MUSIC rows with song_id NULL. A retraction
// filtering on content_class would match nothing at all while looking perfectly correct.
{
  const VT = 'C:\\takes\\vt-0900.wav';
  const track = { id: 1, uuid: 'u-vt', title: '[VT] morning break', file_path: VT, station_id: 2 };
  db.prepare('INSERT INTO voice_tracks (id,uuid,title,file_path,station_id) VALUES (?,?,?,?,?)')
    .run(track.id, track.uuid, track.title, track.file_path, track.station_id);

  // Placed exactly as insertVoiceTrack does it: song_id NULL, file_path set, content_class DEFAULTED.
  const insVt = db.prepare(`INSERT INTO generated_schedule
    (scheduled_at, song_id, title, file_path, station_id, state) VALUES (?, NULL, ?, ?, ?, ?)`);
  insVt.run(9000, track.title, VT, 2, 'played');
  insVt.run(9100, track.title, VT, 2, 'playing');
  insVt.run(9200, track.title, VT, 2, 'pending');
  insVt.run(9300, track.title, VT, 3, 'pending');   // another station

  const labelled = db.prepare('SELECT content_class FROM generated_schedule WHERE scheduled_at = 9200').get();
  if (labelled.content_class === 'MUSIC')
    pass("a placed take really is labelled MUSIC — the trap is reproduced, not assumed");
  else fail(`the fixture labelled it ${labelled.content_class} — this test would prove nothing`);

  const r = retractVoiceTrackReferences(db, track, NOW);
  if (r.pendingLog === 1) pass('retracted exactly the 1 pending take at this station');
  else fail(`retracted ${r.pendingLog} rows — expected 1`);

  if (live("file_path = ? AND state = 'played'", VT) === 1) pass("the take's aired history survives");
  else fail('a played voice-track row was retracted');
  if (live("file_path = ? AND state = 'playing'", VT) === 1) pass('the take on air right now is not yanked');
  else fail('the ON-AIR take was retracted');
  if (live("file_path = ? AND station_id = 3", VT) === 1) pass('another station is untouched');
  else fail('another station lost its take');

  // The whole point of matching on song_id IS NULL rather than content_class.
  if (live("song_id = 42") === 1) pass('a real MUSIC row sharing the class label is untouched');
  else fail('a song row was retracted — song_id IS NULL is not doing its job');
}

db.close();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

console.log(failures === 0
  ? '\nVERDICT: PASS — deleted spots and voice tracks stop airing, and their history survives.\n'
  : `\nVERDICT: FAIL — ${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
