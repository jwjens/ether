'use strict';
// scripts/smoke-announce-coexist.js — a fixed-time and a from-closing announcement on the same day.
//
// Jeff, 2026-09-01: "MANUAL and BY MINUTES coexist on a day (each APPLY only replaces its own type)."
//
// THIS EXISTS BECAUSE BOTH HALVES BROKE ON THE SAME DAY, in different ways:
//
//   1. Manual's APPLY DELETED the offsets. Its diff took every row on the date, and since an offset
//      row has no trigger_time it could never match an absolute draft line — so it fell into
//      `remove`. Programming one tab silently destroyed the other's work.
//   2. NOTHING FIRED AT ALL. `s.skipped_at` was added to the scheduler's hot SELECT the same day the
//      column's migration was written; on a database still at v52 the prepare threw and the tick
//      skipped every station. Absolute rows died alongside offset ones.
//
// Neither was caught by the existing smokes: one tested the pure resolver (which was correct
// throughout) and the other tested closing-time isolation. Both bugs lived in the seams between
// pieces that were individually fine.
//
//   node scripts/smoke-announce-coexist.js

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? '' : `\n         got:  ${JSON.stringify(got)}\n         want: ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

console.log('=== smoke-announce-coexist ===');

// ── the fire path's resolver, byte-identical to electron/main.js ──────────────────────────────
const hmsNormalize = (t) => {
  const p = String(t == null ? '' : t).split(':');
  if (p.length < 2 || p.length > 3) return null;
  const h = Number(p[0]), m = Number(p[1]), s = p.length > 2 ? Number(p[2]) : 0;
  if (![h, m, s].every(n => Number.isInteger(n))) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59 || s < 0 || s > 59) return null;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
};
const hhmmToMinutes = (t) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '').trim());
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  return (h > 23 || mi > 59) ? null : h * 60 + mi;
};
const minutesToHms = (n) => {
  const w = ((n % 1440) + 1440) % 1440;
  return `${String(Math.floor(w / 60)).padStart(2, '0')}:${String(w % 60).padStart(2, '0')}:00`;
};
function dueTimeFor(row, closingHHMM) {
  if (row.trigger_type !== 'close_offset') return hmsNormalize(row.trigger_time);
  const base = hhmmToMinutes(closingHHMM);
  if (base == null) return null;
  return minutesToHms(base + (Number(row.close_offset_min) || 0));
}

// ── the editor diff, as src/lib/scheduleDiff.ts implements it ─────────────────────────────────
function diffSchedule(existing, draft) {
  const pool = existing.slice();
  const keep = [], create = [];
  for (const line of draft) {
    const t = line.trigger_time || '';
    const i = pool.findIndex(e => e != null && e.announcement_uuid === line.announcement_uuid && (e.trigger_time || '') === t);
    if (i >= 0) { keep.push(pool[i]); pool[i] = null; } else create.push(line);
  }
  return { keep, remove: pool.filter(e => e != null), create };
}

const DATE = '2026-10-31';
const day = () => ([
  { uuid: 'abs-1', announcement_uuid: 'a-parade', date: DATE, trigger_type: 'absolute',     trigger_time: '19:00:00', close_offset_min: 0 },
  { uuid: 'off-1', announcement_uuid: 'a-30min',  date: DATE, trigger_type: 'close_offset', trigger_time: null,       close_offset_min: -30 },
]);

console.log('\n-- BOTH TYPES RESOLVE A TIME ON THE SAME DAY --');
{
  const rows = day();
  const closing = '22:00';
  check('the fixed-time row fires at the time it was given', dueTimeFor(rows[0], closing), '19:00:00');
  check('the from-closing row fires 30 minutes before close', dueTimeFor(rows[1], closing), '21:30:00');
  check('they are DIFFERENT times — neither shadows the other',
    dueTimeFor(rows[0], closing) !== dueTimeFor(rows[1], closing), true);
}

console.log('\n-- THE FIXED-TIME ROW DOES NOT DEPEND ON A CLOSING TIME --');
// The regression Jeff suspected. It was not the cause, and this keeps it from ever becoming one:
// dueTimeFor returns on the trigger_type test before the closing-time guard can reach an absolute row.
{
  const abs = day()[0];
  check('no closing time set: it still fires', dueTimeFor(abs, null), '19:00:00');
  check('empty closing time: it still fires',  dueTimeFor(abs, ''), '19:00:00');
  check('nonsense closing time: it still fires', dueTimeFor(abs, 'not a time'), '19:00:00');
  const off = day()[1];
  check('the OFFSET row, by contrast, cannot fire without one', dueTimeFor(off, null), null);
  // A row CONVERTED from fixed-time to from-closing still carries whatever absolute time it had.
  // Falling back to it would put audio on air at an hour nobody chose — the failure the v48 removal
  // note warned about — so the stale value must be ignored, not used. A trigger_time of null cannot
  // demonstrate that, which is why this fixture carries a real one.
  const stale = { trigger_type: 'close_offset', close_offset_min: -30, trigger_time: '09:00:00' };
  check('a converted row still carries its old absolute time', stale.trigger_time, '09:00:00');
  check('and with no closing time it fires NOTHING, not that time', dueTimeFor(stale, null), null);
  check('given a closing time it uses the OFFSET, never the stale value', dueTimeFor(stale, '22:00'), '21:30:00');
}

console.log('\n-- MANUAL APPLY REPLACES ONLY FIXED-TIME ROWS --');
{
  const rows = day();
  const manualWant = [{ announcement_uuid: 'a-parade', trigger_time: '20:00:00' }];   // moved
  // THE FIX: the board filters `existing` to absolute before diffing.
  const existing = rows.filter(e => e.date === DATE && e.trigger_type !== 'close_offset');
  const { remove, create, keep } = diffSchedule(existing, manualWant);
  check('the offset row is not even considered', existing.map(e => e.uuid), ['abs-1']);
  check('the moved fixed-time row is replaced', remove.map(e => e.uuid), ['abs-1']);
  check('and one new fixed-time row is created', create.length, 1);
  check('nothing is kept, since the time changed', keep.length, 0);
  check('THE OFFSET ROW SURVIVES — the bug this file exists for',
    rows.filter(e => e.trigger_type === 'close_offset' && !remove.includes(e)).map(e => e.uuid), ['off-1']);
}

console.log('\n-- and the UNFILTERED diff is what used to destroy it --');
// Kept as a regression witness: this is the exact call the board made before the fix.
{
  const rows = day();
  const { remove } = diffSchedule(rows.filter(e => e.date === DATE), [{ announcement_uuid: 'a-parade', trigger_time: '20:00:00' }]);
  check('the old shape removed the offset row too', remove.map(e => e.uuid).sort(), ['abs-1', 'off-1']);
}

console.log('\n-- BY MINUTES APPLY REPLACES ONLY OFFSET ROWS --');
{
  const rows = day();
  const existing = rows.filter(e => e.date === DATE && e.trigger_type === 'close_offset');
  check('the fixed-time row is not even considered', existing.map(e => e.uuid), ['off-1']);
  // Its diff matches on (announcement_uuid, offset) rather than trigger_time.
  const key = (u, o) => `${u}|${o}`;
  const want = new Map([[key('a-30min', -15), { announcement_uuid: 'a-30min', offset: -15 }]]);
  const have = new Map(existing.map(e => [key(e.announcement_uuid, e.close_offset_min ?? 0), e]));
  const removed = [...have].filter(([k]) => !want.has(k)).map(([, e]) => e.uuid);
  const created = [...want].filter(([k]) => !have.has(k)).length;
  check('the changed offset is replaced', removed, ['off-1']);
  check('and one new offset row is created', created, 1);
  check('THE FIXED-TIME ROW SURVIVES',
    rows.filter(e => e.trigger_type !== 'close_offset' && !removed.includes(e.uuid)).map(e => e.uuid), ['abs-1']);
}

console.log('\n-- AN UNCHANGED LINE KEEPS ITS ROW, AND THEREFORE ITS 120s GUARD --');
// Delete-and-recreate would clear last_played_at and let a row that already fired tonight fire again.
{
  const existing = day().filter(e => e.trigger_type !== 'close_offset');
  const { keep, remove, create } = diffSchedule(existing, [{ announcement_uuid: 'a-parade', trigger_time: '19:00:00' }]);
  check('kept, not recreated', keep.map(e => e.uuid), ['abs-1']);
  check('nothing removed', remove.length, 0);
  check('nothing created', create.length, 0);
}

console.log('\n-- THE CALENDAR COUNTS BOTH TYPES --');
// Any programming marks the date, in BOTH tabs; the split only changes how it is described.
{
  const rows = day();
  const onDate = rows.filter(e => e.date === DATE);
  const nFix = onDate.filter(e => e.trigger_type !== 'close_offset').length;
  const nOff = onDate.length - nFix;
  check('the date is marked at all', onDate.length > 0, true);
  check('one of each is counted separately', [nFix, nOff], [1, 1]);
  check('and the combined total is what marks the day', nFix + nOff, 2);
}

console.log('\n-- THE APPLY CONFIRMATION FIRES ONLY WHEN SOMETHING WOULD BE REPLACED --');
{
  const rows = day();
  const replacingManual = [DATE].filter(d => rows.some(e => e.date === d && e.trigger_type !== 'close_offset')).length;
  const replacingOffset = [DATE].filter(d => rows.some(e => e.date === d && e.trigger_type === 'close_offset')).length;
  check('Manual warns: the date holds a fixed-time row', replacingManual, 1);
  check('By minutes warns: the date holds an offset row', replacingOffset, 1);
  const empty = [];
  check('an empty date warns for neither',
    [ [ '2026-12-25' ].filter(d => empty.some(e => e.date === d)).length ], [0]);
}

console.log('\n------------------------------');
console.log(`  Passed: ${pass}  Failed: ${fail}`);
console.log(`  VERDICT: ${fail === 0 ? 'PASS' : 'FAIL'}`);
console.log('------------------------------');
process.exit(fail === 0 ? 0 : 1);
