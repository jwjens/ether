'use strict';
// scripts/smoke-ops-api.js — Park Ops, stage 1.
//
// docs/operator-closing-screen-and-source-routing-2026-08-31.md
//
// What this pins, in the order the risk actually runs:
//   • the ENGINE IS UNTOUCHED — offsets are display-only, and the row still carries the absolute
//     time the engine will fire. This is the property that makes stage 1 zero broadcast risk, so it
//     is asserted rather than assumed.
//   • closing-time resolution is date → weekday → default
//   • offset arithmetic, including across midnight
//   • the token gates the WRITE and not the read
//   • station scoping — one station's closing time is not another's
//   • sanity rails FLAG and never remove a row
//
//   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/smoke-ops-api.js

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const { _test } = require(path.join(__dirname, '..', 'electron', 'ops-api.js'));
const { parseClosing, resolveClosing, hhmmToMin, minToHms, railsFor, buildState, ensureToken, KEY_CLOSING } = _test;

const dbPath = path.join(os.tmpdir(), `ether-ops-smoke-${process.pid}.db`);
try { fs.unlinkSync(dbPath); } catch {}
const db = new Database(dbPath);

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? '' : `\n         got:  ${JSON.stringify(got)}\n         want: ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

console.log('=== smoke-ops-api ===');

db.prepare('CREATE TABLE schema_version (version INTEGER PRIMARY KEY)').run();
require(path.join(__dirname, 'schema-v0-baseline.js'))(db);
{
  const RE = /^migrate-.+-phase-sync-(\d+)\.js$/;
  const applied = new Set(db.prepare('SELECT version FROM schema_version').all().map(r => r.version));
  const scripts = [];
  for (const f of fs.readdirSync(__dirname)) { const m = RE.exec(f); if (m) scripts.push({ v: +m[1], file: f }); }
  scripts.sort((a, b) => a.v - b.v);
  for (const { v, file } of scripts) {
    if (applied.has(v)) continue;
    try { require(path.join(__dirname, file)).applyMigration(db); } catch { /* fail-soft, as the app does */ }
  }
}
try { db.prepare("INSERT OR IGNORE INTO client_identity (id, client_id, created_at) VALUES (1,'smoke','2026-01-01')").run(); } catch {}
for (const [id, name] of [[2, 'halloVeen'], [3, 'Magical Forest']]) {
  try { db.prepare("INSERT OR IGNORE INTO stations (id, name, uuid, created_at, updated_at) VALUES (?,?,?,?,?)")
          .run(id, name, 'st-' + id, '2026-01-01', '2026-01-01'); } catch {}
}

console.log('\n── closing-time resolution: date → weekday → default ──');
const cfg = parseClosing(JSON.stringify({ default: '22:00', byWeekday: { '5': '23:00' }, byDate: { '2026-10-31': '23:30' } }));
check('a specific date wins',            resolveClosing(cfg, '2026-10-31', 6), '23:30');
check('otherwise the weekday wins',      resolveClosing(cfg, '2026-11-06', 5), '23:00');
check('otherwise the default',           resolveClosing(cfg, '2026-11-04', 3), '22:00');
check('nothing configured → null, not a guess', resolveClosing(parseClosing(null), '2026-11-04', 3), null);
check('garbage in the KV value degrades to empty, never throws', parseClosing('{not json').default, null);

console.log('\n── offset arithmetic ──');
check('15 minutes before a 22:00 close', minToHms(hhmmToMin('22:00') - 15), '21:45:00');
check('15 minutes after',                minToHms(hhmmToMin('22:00') + 15), '22:15:00');
check('after a 23:50 close wraps past midnight', minToHms(hhmmToMin('23:50') + 25), '00:15:00');
check('a bad time is null, not NaN',     hhmmToMin('99:99'), null);

console.log('\n── THE ENGINE IS UNTOUCHED — offsets are display-only ──');
// An absolute row and an offset row, on the same date. The offset row must come back with a DERIVED
// time and preview:true; the absolute row must come back with exactly what the engine will fire.
const today = new Date();
const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
const mkAnn = (uuid, title, station, duck) => db.prepare(
  `INSERT INTO announcements (title, file_path, trigger_time, days, duck_music, is_active, created_at, station_id, uuid, updated_at)
   VALUES (?,?,?,?,?,1,?,?,?,?)`).run(title, 'C:\\a.mp3', '21:00:00', '', duck, '2026-01-01', station, uuid, '2026-01-01');
const mkSched = (uuid, annUuid, station, time, type, off) => db.prepare(
  `INSERT INTO announcement_schedule (station_id, uuid, announcement_uuid, scope, date, trigger_type, trigger_time, close_offset_min, sort_order, created_at, updated_at)
   VALUES (?,?,?,'date',?,?,?,?,?,?,?)`).run(station, uuid, annUuid, dateStr, type, time, off, 0, '2026-01-01', '2026-01-01');

mkAnn('a-abs', 'PARK IS CLOSED', 2, 1);
mkAnn('a-off', '15 MINUTES TO CLOSE', 2, 1);
mkAnn('a-nod', 'NO DUCK ONE', 2, 0);
mkSched('s-abs', 'a-abs', 2, '22:00:00', 'absolute', 0);
mkSched('s-off', 'a-off', 2, '09:00:00', 'before_close', -15);   // stored time is deliberately WRONG
mkSched('s-nod', 'a-nod', 2, '22:05:00', 'absolute', 0);

const kv = (station, key, value) => db.prepare(
  'INSERT INTO station_config_kv (station_id, key, value, uuid, created_at, updated_at) VALUES (?,?,?,?,?,?)'
).run(station, key, value, 'kv-' + station + '-' + key, '2026-01-01', '2026-01-01');
kv(2, KEY_CLOSING, JSON.stringify({ default: '22:00' }));

const fakeAudio = { audioGetState: () => JSON.stringify({ deckA: { status: 'playing', title: 'Time Warp', artist: 'Little Nell', position_sec: 138, duration_sec: 199 } }) };
const st = buildState(db, fakeAudio, 2, true);

const abs = st.queue.find(q => q.uuid === 's-abs');
const off = st.queue.find(q => q.uuid === 's-off');
check('the absolute row keeps the time the engine will fire', abs.dueTime, '22:00:00');
check('the absolute row is not a preview', abs.preview, false);
check('the offset row is DERIVED from closing time', off.dueTime, '21:45:00');
check('and is flagged as a preview', off.preview, true);
check('the offset is reported so the page can say it in words', off.offsetMin, -15);
check('the whole response declares itself preview-only', st.previewOnly, true);

console.log('\n── plain language comes from the row, never assumed ──');
check('a ducking row says so',     st.queue.find(q => q.uuid === 's-abs').ducks, true);
check('a non-ducking row does not', st.queue.find(q => q.uuid === 's-nod').ducks, false);

console.log('\n── now playing ──');
check('title from the playing deck', st.now.title, 'Time Warp');
check('position carried',            st.now.positionSec, 138);
check('an engine that will not answer is "nothing playing", not a crash',
  buildState(db, { audioGetState: () => { throw new Error('engine down'); } }, 2, true).now.onAir, false);

console.log('\n── sanity rails FLAG, and never remove a row ──');
kv(3, KEY_CLOSING, JSON.stringify({ default: '22:00' }));
mkAnn('a-early', 'PARK IS CLOSED', 3, 1);
mkSched('s-early', 'a-early', 3, '09:00:00', 'absolute', 0);   // 13 hours before close
const st3 = buildState(db, fakeAudio, 3, true);
check('the row is still listed', st3.queue.length, 1);
check('and it is flagged', st3.queue[0].rails.length > 0, true);
console.log(`         rail: "${st3.queue[0].rails[0]?.text}"`);

console.log('\n── station scoping ──');
check('halloVeen sees its 3 rows',   buildState(db, fakeAudio, 2, true).queue.length, 3);
check('Magical Forest sees only its own', st3.queue.map(q => q.uuid), ['s-early']);
check('and its own closing time',    st3.closing.effective, '22:00');

console.log('\n── the token gates the WRITE, not the read ──');
const tok = ensureToken(db, 2);
check('a token is minted on first use', typeof tok === 'string' && tok.length >= 16, true);
check('it is stable on the next call',  ensureToken(db, 2), tok);
check('each station gets its own',      ensureToken(db, 3) !== tok, true);
check('the read works without a token — canEdit is simply false', buildState(db, fakeAudio, 2, false).canEdit, false);
check('and true with one',                                        buildState(db, fakeAudio, 2, true).canEdit, true);

console.log('\n── nothing here touches the engine or the schedule ──');
check('announcement_schedule rows unchanged', db.prepare('SELECT COUNT(*) n FROM announcement_schedule').get().n, 4);
check('trigger_time of the offset row is STILL what it was — nothing rewrote it',
  db.prepare("SELECT trigger_time t FROM announcement_schedule WHERE uuid='s-off'").get().t, '09:00:00');

console.log('\n──────────────────────────────');
console.log(`  Passed: ${pass}  Failed: ${fail}`);
console.log(`  VERDICT: ${fail === 0 ? 'PASS' : 'FAIL'}`);
console.log('──────────────────────────────');

db.close();
try { fs.unlinkSync(dbPath); } catch {}
process.exit(fail === 0 ? 0 : 1);
