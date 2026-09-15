'use strict';
// scripts/smoke-sweeper-queue-rows.js — every upcoming sweeper is a row, and a row never lies.
//
// Jeff, 2026-09-14: "sweepers should ALWAYS be visible for every upcoming song in the queue, not just
// the one that's armed… The queue should read the placements from generated_schedule."
// And: "A row that promises a sweeper the daemon will refuse is the same lie I'm replacing the badge
// for."
//
// WHAT THIS COVERS. schedule:sweeper-placements lives inside main.js's ipcMain registration and cannot
// be required in isolation, so the two decisions it makes are reproduced here against a real database
// and a real filesystem: which rows come back, and what `playable` and `atSeam` say about each. Those
// are the parts that can be wrong in a way an operator would believe.
//
// It also asserts the wiring the renderer depends on, which is what actually broke last time: the
// channel exists in main, it is exposed on the bridge, and the deck state carries the key the lookup
// is done by.
//
//   node scripts/smoke-sweeper-queue-rows.js

const path = require('path');
const fs   = require('fs');
const os   = require('os');

function resolveFrom(c, what) {
  for (const x of c) { try { return require(x); } catch {} }
  console.error('could not load ' + what); process.exit(2);
}
const HERE = __dirname;
const ROOT = path.join(HERE, '..');
const Database = resolveFrom([
  path.join(ROOT, 'node_modules', 'better-sqlite3'),
  'better-sqlite3',
], 'better-sqlite3');

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures++; console.log(`  FAIL  ${m}`); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ether-qrows-'));
const db = new Database(path.join(dir, 't.db'));

db.exec(`
  CREATE TABLE songs (id INTEGER PRIMARY KEY, uuid TEXT, title TEXT, file_path TEXT,
                      duration_ms INTEGER, content_class TEXT, deleted_at TEXT);
  CREATE TABLE generated_schedule (
    id INTEGER PRIMARY KEY, scheduled_at INTEGER, song_id INTEGER, title TEXT, artist TEXT,
    file_path TEXT, file_key TEXT, duration_s INTEGER, station_id INTEGER,
    state TEXT DEFAULT 'pending', content_class TEXT DEFAULT 'MUSIC',
    lead_in_sec REAL, jingle_category_id INTEGER, deleted_at TEXT, updated_at TEXT);
`);

// A sweeper file that EXISTS, and one that does not.
const realFile = path.join(dir, 'halloween-impact-01.mp3');
fs.writeFileSync(realFile, 'not really audio, but it is on disk');
const goneFile = path.join(dir, 'deleted-sweeper.mp3');

// Sweeper placements carry song_id + file_key and NOT file_path — main.js _placeJingles writes only
// the basename — so the audio resolves through the songs row. The query must COALESCE exactly as
// audiod/loggen.js readJingleForSeam does, or it reports a different answer from the one that airs.
db.prepare(`INSERT INTO songs (id,uuid,title,file_path,duration_ms,content_class) VALUES
  (10,'u-swp-ok','halloween impact 01',?,6000,'SWP'),
  (11,'u-swp-gone','missing sweeper',?,5000,'SWP')`).run(realFile, goneFile);

const insSwp = db.prepare(`INSERT INTO generated_schedule
  (scheduled_at, song_id, title, file_path, duration_s, station_id, content_class, lead_in_sec)
  VALUES (?, ?, ?, NULL, ?, 2, 'SWP', ?)`);
const insRow = db.prepare(`INSERT INTO generated_schedule
  (scheduled_at, song_id, title, file_path, duration_s, station_id, content_class)
  VALUES (?, ?, ?, ?, ?, 2, ?)`);

//  1000 song A                                        (no sweeper)
//  1200 SPOT, 15s -> ends 1215
//  1215 song B  + sweeper, lead 0   <- at a spot seam
//  1400 song C  + sweeper, lead 2   <- ordinary seam
//  1600 song D  + sweeper whose FILE IS MISSING
insRow.run(1000, 1, 'Song A', null, 200, 'MUSIC');
insRow.run(1200, null, 'GC Sponsorship', 'C:\\cat\\gc.wav', 15, 'SPOT');
insRow.run(1215, 2, 'Song B', null, 180, 'MUSIC');
insSwp.run(1215, 10, 'halloween impact 01', 6, 0);
insRow.run(1400, 3, 'Song C', null, 120, 'MUSIC');
insSwp.run(1400, 10, 'halloween impact 01', 6, 2);
insRow.run(1600, 4, 'Song D', null, 120, 'MUSIC');
insSwp.run(1600, 11, 'missing sweeper', 5, 2);
// Another station's sweeper, and a deleted one — neither may appear.
db.prepare(`INSERT INTO generated_schedule (scheduled_at,song_id,title,duration_s,station_id,content_class,lead_in_sec)
            VALUES (1215,10,'other station',6,3,'SWP',2)`).run();
db.prepare(`INSERT INTO generated_schedule (scheduled_at,song_id,title,duration_s,station_id,content_class,lead_in_sec,deleted_at)
            VALUES (1800,10,'retired',6,2,'SWP',2,'2026-09-14')`).run();

// ── the handler's two decisions, reproduced ─────────────────────────────────────────────────────
function placements(stationId, a, b) {
  const spotEndsAt = new Set();
  for (const r of db.prepare(
    `SELECT scheduled_at, duration_s FROM generated_schedule
      WHERE station_id = ? AND content_class = 'SPOT' AND deleted_at IS NULL
        AND scheduled_at >= ? AND scheduled_at <= ?`).all(stationId, a - 600, b)) {
    spotEndsAt.add(r.scheduled_at + (r.duration_s || 0));
  }
  const rows = db.prepare(
    `SELECT gs.scheduled_at, gs.title, gs.lead_in_sec,
            COALESCE(gs.file_path, s.file_path) AS file_path,
            COALESCE(s.duration_ms, gs.duration_s * 1000) AS duration_ms
       FROM generated_schedule gs LEFT JOIN songs s ON s.id = gs.song_id
      WHERE gs.station_id = ? AND gs.content_class IN ('JIN','SWP') AND gs.deleted_at IS NULL
        AND gs.scheduled_at >= ? AND gs.scheduled_at <= ?
      ORDER BY gs.scheduled_at ASC`).all(stationId, a, b);
  return rows.map(r => ({
    scheduledAt: r.scheduled_at,
    title: r.title || '',
    durationMs: r.duration_ms || 0,
    leadInSec: r.lead_in_sec != null ? r.lead_in_sec : 2,
    atSeam: spotEndsAt.has(r.scheduled_at),
    playable: !!(r.file_path && fs.existsSync(r.file_path)),
  }));
}

console.log('\n== every upcoming sweeper comes back, not just one ==');
const rows = placements(2, 900, 2000);
const by = Object.fromEntries(rows.map(r => [r.scheduledAt, r]));

if (rows.length === 3) pass('3 placements returned — the list is the LOG, not the one armed seam');
else fail(`${rows.length} placements returned — expected 3 (${rows.map(r => r.scheduledAt).join(',')})`);

if (!by[1000]) pass('a song with no placement gets no row');
else fail('a row appeared for a song that has no sweeper');

if (by[1215] && by[1400] && by[1600]) pass('each placement is keyed on the scheduled_at of the song it introduces');
else fail('a placement is missing or mis-keyed');

console.log('\n== and nothing that belongs to someone else ==');
if (!rows.some(r => r.title === 'other station')) pass('another station\'s placement is excluded');
else fail('another station\'s sweeper leaked in');
if (!rows.some(r => r.title === 'retired')) pass('a deleted placement is excluded');
else fail('a tombstoned sweeper was listed');

console.log('\n== playable is the truth, by the daemon\'s own test ==');
if (by[1400] && by[1400].playable) pass('a sweeper whose audio is on disk is playable');
else fail('a present file was reported unplayable — the row would cry wolf');
if (by[1600] && by[1600].playable === false)
  pass('a sweeper whose FILE IS MISSING is reported unplayable — the row says so instead of promising');
else fail('a missing file was reported playable — this is the lie the row exists to stop');
if (by[1600] && by[1600].durationMs === 5000)
  pass('an unplayable row still carries its details — it is shown struck through, not hidden');
else fail('the unplayable row lost its metadata');

console.log('\n== the file resolves through the SONGS row, as it airs ==');
if (by[1400] && by[1400].durationMs === 6000)
  pass('duration_ms COALESCEd from the songs row (the placement carries only duration_s)');
else fail(`duration came through as ${by[1400] && by[1400].durationMs} — the COALESCE does not match loggen`);

console.log('\n== at seam: derived from the spot, never inferred from lead 0 ==');
if (by[1215] && by[1215].atSeam) pass('the placement after a spot is marked at-seam');
else fail('the spot seam was not detected');
if (by[1400] && !by[1400].atSeam) pass('an ordinary seam is not marked');
else fail('a music seam was wrongly marked at-seam');
{
  // An operator may set LEAD 0 on a whole category — as Jeff did tonight as a stopgap. If at-seam
  // were inferred from lead_in_sec === 0, every row would then claim a clamp that never happened.
  db.prepare(`UPDATE generated_schedule SET lead_in_sec = 0 WHERE content_class = 'SWP'`).run();
  const r2 = placements(2, 900, 2000);
  const seamCount = r2.filter(x => x.atSeam).length;
  if (seamCount === 1) pass('with LEAD 0 set everywhere, still exactly ONE row is at-seam');
  else fail(`${seamCount} rows claim at-seam with a global LEAD 0 — it is being inferred from the lead`);
}

console.log('\n== the wiring the renderer depends on ==');
{
  const main    = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
  const ui      = fs.readFileSync(path.join(ROOT, 'src', 'components', 'UpNext.tsx'), 'utf8');

  if (/ipcMain\.handle\('schedule:sweeper-placements'/.test(main)) pass('main registers schedule:sweeper-placements');
  else fail('the channel has no handler');
  if (/sweeperPlacements:/.test(preload)) pass('the bridge exposes schedule.sweeperPlacements');
  else fail('the method is not on the bridge — the renderer would read undefined');
  if (/scheduledAt: number \| null/.test(ui)) pass('DeckRowState carries scheduledAt — the lookup key');
  else fail('deck rows have no scheduledAt, so no deck can find its placement');
  if (/<SweeperRow p=\{swp\}/.test(ui) && /<SweeperRow p=\{qswp\}/.test(ui))
    pass('the row renders above BOTH the deck rows and the queue items');
  else fail('one of the two surfaces does not render the row');
  if (!/jingleOverlay\.deck === id/.test(ui))
    pass('the old in-row badge is gone — not two indicators for one element');
  else fail('the badge that keyed on the OUTGOING deck is still rendered');
}

db.close();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

console.log(failures === 0
  ? '\nVERDICT: PASS — every upcoming sweeper is a row, and an unplayable one says so.\n'
  : `\nVERDICT: FAIL — ${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
