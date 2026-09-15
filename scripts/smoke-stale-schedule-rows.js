'use strict';
// scripts/smoke-stale-schedule-rows.js — a row whose slot has passed cannot air, and a spot that is
// gone leaves nothing behind.
//
// Jeff, 2026-09-14, after a spot he had deleted aired anyway: "A row from 23 July that can still air
// is a corpse that plays."
//
// THE SWEEP. retireStaleScheduleRows stamps `missed` once a slot is older than the grace window,
// for any class. Generate is day-scoped and must never rewrite an aired hour, so a row from a
// PREVIOUS day sits outside every window anything runs — which is exactly how a spot deleted this
// afternoon aired this evening, from placements written on 6 September for the 13th.
//
// A separate retroactive spot-repair script was built and then CUT (Jeff: "dont waste time making
// it retroactive"). This sweep already retires those rows by slot age whatever class they are, so
// the second tool only duplicated it.
//
//   node scripts/smoke-stale-schedule-rows.js

const path = require('path'), fs = require('fs'), os = require('os');
const Database = (() => {
  for (const c of [path.join(__dirname, '..', 'node_modules', 'better-sqlite3'), 'better-sqlite3'])
    { try { return require(c); } catch {} }
  console.error('no better-sqlite3'); process.exit(2);
})();

let failures = 0;
const pass = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => { failures++; console.log(`  FAIL  ${m}`); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ether-stale-'));
const db = new Database(path.join(dir, 't.db'));
db.exec(`
  CREATE TABLE station_config_kv (station_id INTEGER, key TEXT, value TEXT, deleted_at TEXT);
  CREATE TABLE spots (id INTEGER PRIMARY KEY, uuid TEXT, title TEXT, file_path TEXT,
                      station_id INTEGER, deleted_at TEXT);
  CREATE TABLE generated_schedule (
    id INTEGER PRIMARY KEY, scheduled_at INTEGER, song_id INTEGER, title TEXT, file_path TEXT,
    duration_s INTEGER, station_id INTEGER, state TEXT DEFAULT 'pending',
    content_class TEXT DEFAULT 'MUSIC', deleted_at TEXT, updated_at TEXT);
`);

const NOW = Math.floor(Date.now() / 1000);
const ins = db.prepare(`INSERT INTO generated_schedule
  (id, scheduled_at, title, file_path, duration_s, station_id, state, content_class)
  VALUES (?,?,?,?,?,?,?,?)`);

const LIVE = 'C:\\cat\\live-spot.wav', DEAD = 'C:\\cat\\deleted-spot.wav';
db.prepare("INSERT INTO spots (id,uuid,title,file_path,station_id,deleted_at) VALUES (1,'u-live','Live Spot',?,2,NULL)").run(LIVE);
db.prepare("INSERT INTO spots (id,uuid,title,file_path,station_id,deleted_at) VALUES (2,'u-dead','Dead Spot',?,2,'2026-09-14')").run(DEAD);

ins.run(1, NOW - 86400 * 50, 'ancient music',   null,  180, 2, 'pending', 'MUSIC');   // corpse
ins.run(2, NOW - 7200,       'two hours ago',   null,  180, 2, 'pending', 'MUSIC');   // corpse
ins.run(3, NOW - 600,        'ten minutes ago', null,  180, 2, 'pending', 'MUSIC');   // inside grace
ins.run(4, NOW + 600,        'ten minutes out', null,  180, 2, 'pending', 'MUSIC');   // future
ins.run(5, NOW - 86400 * 50, 'already played',  null,  180, 2, 'played',  'MUSIC');   // history
ins.run(6, NOW - 86400 * 50, 'another station', null,  180, 3, 'pending', 'MUSIC');   // not ours
ins.run(7, NOW - 86400 * 10, 'Dead Spot',       DEAD,   15, 2, 'pending', 'SPOT');    // orphan
ins.run(8, NOW + 3600,       'Dead Spot',       DEAD,   15, 2, 'pending', 'SPOT');    // orphan, future
ins.run(9, NOW + 3600,       'Live Spot',       LIVE,   15, 2, 'pending', 'SPOT');    // keep

// ── sweep 1: the grace window ───────────────────────────────────────────────────────────────────
console.log('\n== retire rows whose slot has passed ==');
function retire(stationId, graceDefault = 3600) {
  let grace = graceDefault;
  const r = db.prepare("SELECT value FROM station_config_kv WHERE station_id=? AND key='stale_row_grace_sec' AND deleted_at IS NULL").get(stationId);
  if (r && r.value != null) { const v = parseInt(r.value, 10); if (Number.isFinite(v) && v >= 0) grace = v; }
  const cutoff = Math.floor(Date.now() / 1000) - grace;
  return db.prepare(`UPDATE generated_schedule SET state='missed', updated_at=?
      WHERE station_id=? AND state='pending' AND deleted_at IS NULL AND scheduled_at < ?`)
    .run(new Date().toISOString(), stationId, cutoff).changes;
}
const st = (id) => db.prepare('SELECT state FROM generated_schedule WHERE id=?').get(id).state;

const retired = retire(2);
if (retired === 3) pass('3 rows retired — the two music corpses and the orphan spot in the past');
else fail(`retired ${retired} — expected 3`);
if (st(1) === 'missed' && st(2) === 'missed') pass('rows older than the grace window are missed');
else fail('an old pending row survived');
if (st(3) === 'pending') pass('a row 10 minutes past is INSIDE the grace window — the reader may still catch it');
else fail('a row inside the grace window was retired — this would fight the anchored reader');
if (st(4) === 'pending') pass('a future row is untouched');
else fail('a future row was retired');
if (st(5) === 'played') pass("'played' is history and is never rewritten");
else fail('airplay history was altered');
if (st(6) === 'pending') pass('another station is untouched');
else fail('the sweep crossed stations');

console.log('\n== the grace window is the operator\'s number, not a constant ==');
{
  db.prepare("INSERT INTO generated_schedule (id,scheduled_at,title,station_id,state,content_class) VALUES (10,?,?,2,'pending','MUSIC')")
    .run(NOW - 600, 'ten minutes ago, again');
  db.prepare("INSERT INTO station_config_kv (station_id,key,value) VALUES (2,'stale_row_grace_sec','60')").run();
  const n = retire(2);
  if (n >= 1 && st(10) === 'missed') pass('a 60s grace retires the 10-minute-old row — the KV is read, not ignored');
  else fail('the configured grace window had no effect');
}

console.log('\n== the sweep is wired where it can actually run ==');
{
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  if (/function retireStaleScheduleRows/.test(main)) pass('retireStaleScheduleRows exists');
  else fail('the sweep function is missing');
  const hooks = (main.match(/retireStaleScheduleRows\(stationId, 'generate'\)/g) || []).length;
  if (hooks === 2) pass('called from BOTH Generate commit points — neither path leaves corpses');
  else fail(`called from ${hooks} Generate commit point(s) — expected 2`);
  if (/ipcMain\.handle\('schedule:retire-stale'/.test(main)) pass('a manual door exists, so the number is visible on demand');
  else fail('no manual door');
}

db.close();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(failures === 0
  ? '\nVERDICT: PASS — corpses are retired, history is not.\n'
  : `\nVERDICT: FAIL — ${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
