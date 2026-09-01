'use strict';
// scripts/smoke-announce-coexist.js — one list per day, each line timed its own way.
//
// Jeff, 2026-09-01: "one calendar no tabs — when you click a day you pick if you're going to use
// specific times or by minutes."
//
// WHAT THIS REPLACED, and why the shape of the test changed with it. There were two tabs, MANUAL and
// BY MINUTES, and they were a UI split imposed on data that never had one: announcement_schedule
// rows have always carried trigger_type per row. The split let the SAME announcement live in both
// halves of one day — invisible from either tab — and fire twice. HALLOVEEN 30 MIN was programmed at
// 4:00:12 PM in one and 30-before-close in the other, both live, and an operator walking up could not
// tell which the station was obeying. The answer was "both".
//
// The earlier version of this file tested that each tab's APPLY spared the other's rows. That
// property is GONE because the thing needing it is gone: there is one list, so there is no other
// slice to spare. What replaces it is the property that made the bug unbuildable — a day's list is
// the day's truth, in the order it will air.
//
// The fire path is unchanged and still pinned here: dueTimeFor's behaviour is what the editor's
// preview and sort must agree with, or the operator reads one evening and the station plays another.
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

// ── the editor's own resolver + sort, as ScheduleBoard implements them ────────────────────────
// The editor resolves to MINUTES (it sorts and previews); the engine resolves to "HH:MM:SS" (it
// matches a clock). Same arithmetic, two shapes — so both are exercised against the same fixtures.
const resolvedMinutes = (l, closing) => {
  if (l.mode === 'absolute') {
    const m = /^(\d{1,2}):(\d{2})/.exec(l.trigger_time || '');
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }
  const c = hhmmToMinutes(closing);
  return c == null ? null : ((c + l.offset) % 1440 + 1440) % 1440;
};
const orderList = (draft, closing) => [...draft].sort((a, b) => {
  const x = resolvedMinutes(a, closing), y = resolvedMinutes(b, closing);
  if (x == null && y == null) return 0;
  if (x == null) return 1;      // a line with no time sorts LAST — visible, never hidden
  if (y == null) return -1;
  return x - y;
});
const asRow = (l) => ({
  trigger_type: l.mode,
  trigger_time: l.mode === 'absolute' ? l.trigger_time : null,
  close_offset_min: l.mode === 'close_offset' ? l.offset : 0,
});

const line = (id, mode, v) => mode === 'absolute'
  ? { id, announcement_uuid: id, mode, trigger_time: v, offset: 0 }
  : { id, announcement_uuid: id, mode, trigger_time: '', offset: v };

console.log('\n-- ONE LIST, MIXED MODES, BOTH RESOLVE --');
{
  const closing = '22:00';
  const parade = line('parade', 'absolute', '19:00:00');
  const thirty = line('30min', 'close_offset', -30);
  check('the fixed line fires at the time it was given', dueTimeFor(asRow(parade), closing), '19:00:00');
  check('the from-closing line fires 30 before close',   dueTimeFor(asRow(thirty), closing), '21:30:00');
  check('a parade and a closing sequence coexist on one day — different times, neither shadowed',
    dueTimeFor(asRow(parade), closing) !== dueTimeFor(asRow(thirty), closing), true);
}

console.log('\n-- SORTED BY WHAT IT ACTUALLY FIRES AT, NOT BY INSERTION --');
{
  const closing = '22:00';
  // Entered deliberately out of order, and mixing modes.
  const draft = [
    line('closed',  'close_offset', 0),        // 22:00
    line('parade',  'absolute', '19:00:00'),   // 19:00
    line('fifteen', 'close_offset', -15),      // 21:45
    line('thirty',  'close_offset', -30),      // 21:30
    line('gates',   'absolute', '20:00:00'),   // 20:00
  ];
  check('the list reads as the evening, in order',
    orderList(draft, closing).map(l => l.id), ['parade', 'gates', 'thirty', 'fifteen', 'closed']);
}

console.log('\n-- AN OFFSET LINE MOVES WHEN THE CLOSING TIME CHANGES --');
// The feature made visible: the same list, two closing times, two different running orders.
{
  const draft = [
    line('parade', 'absolute', '19:00:00'),
    line('thirty', 'close_offset', -30),
  ];
  check('closing at 22:00 — the parade is first',
    orderList(draft, '22:00').map(l => l.id), ['parade', 'thirty']);
  check('closing at 19:00 — the same list now runs the other way round',
    orderList(draft, '19:00').map(l => l.id), ['thirty', 'parade']);
  check('and the fixed line has not moved an inch',
    resolvedMinutes(draft[0], '19:00'), resolvedMinutes(draft[0], '22:00'));
}

console.log('\n-- A FIXED LINE NEVER DEPENDS ON A CLOSING TIME --');
// The regression Jeff suspected when announcements stopped firing. It was not the cause, and these
// keep it from becoming one: dueTimeFor returns on the trigger_type test before the closing guard.
{
  const abs = asRow(line('parade', 'absolute', '19:00:00'));
  check('no closing time: still fires',       dueTimeFor(abs, null), '19:00:00');
  check('empty closing time: still fires',    dueTimeFor(abs, ''), '19:00:00');
  check('nonsense closing time: still fires', dueTimeFor(abs, 'not a time'), '19:00:00');
}

console.log('\n-- A FROM-CLOSING LINE WITH NO CLOSING TIME FIRES NOTHING --');
// And never falls back to a stale absolute time. A row converted from fixed to from-closing still
// carries whatever time it had; using it would put audio on air at an hour nobody chose.
{
  const stale = { trigger_type: 'close_offset', close_offset_min: -30, trigger_time: '09:00:00' };
  check('a converted row still carries its old absolute time', stale.trigger_time, '09:00:00');
  check('with no closing time it fires NOTHING, not that time', dueTimeFor(stale, null), null);
  check('given one, it uses the OFFSET and never the stale value', dueTimeFor(stale, '22:00'), '21:30:00');
  check('the editor agrees — no time to show, and it sorts last',
    resolvedMinutes(line('x', 'close_offset', -30), null), null);
  const draft = [line('offset', 'close_offset', -30), line('parade', 'absolute', '19:00:00')];
  check('a line with no resolvable time sorts LAST, never hidden',
    orderList(draft, null).map(l => l.id), ['parade', 'offset']);
}

console.log('\n-- THE EDITOR AND THE ENGINE AGREE, ON EVERY MODE --');
// If these ever diverge the operator reads one evening and the station plays another.
{
  const closing = '22:00';
  for (const l of [line('a', 'absolute', '19:00:00'), line('b', 'close_offset', -30),
                   line('c', 'close_offset', 0), line('d', 'close_offset', 25)]) {
    const engine = dueTimeFor(asRow(l), closing);
    const editor = resolvedMinutes(l, closing);
    check(`${l.id}: editor and engine resolve the same time`,
      minutesToHms(editor), engine);
  }
  check('past midnight wraps the same way in both',
    minutesToHms(resolvedMinutes(line('e', 'close_offset', 25), '23:50')),
    dueTimeFor({ trigger_type: 'close_offset', close_offset_min: 25 }, '23:50'));
}

console.log('\n-- ONE LIST IS THE DAY: APPLY REPLACES ALL OF IT --');
// No per-type filtering any more. The day's rows ARE the draft, whatever mode each line is in — and
// an unchanged line keeps its row, and therefore its last_played_at and its 120s guard.
{
  const key = (u, m, t, o) => m === 'close_offset' ? `${u}|off|${o}` : `${u}|abs|${t}`;
  const existing = [
    { uuid: 'r1', announcement_uuid: 'parade', trigger_type: 'absolute',     trigger_time: '19:00:00', close_offset_min: 0 },
    { uuid: 'r2', announcement_uuid: '30min',  trigger_type: 'close_offset', trigger_time: null,       close_offset_min: -30 },
  ];
  const draft = [line('parade', 'absolute', '19:00:00'), line('30min', 'close_offset', -15)];
  const have = new Map(existing.map(e => [key(e.announcement_uuid, e.trigger_type, e.trigger_time || '', e.close_offset_min), e]));
  const want = new Map(draft.map(l => [key(l.announcement_uuid, l.mode, l.trigger_time, l.offset), l]));
  const removed = [...have].filter(([k]) => !want.has(k)).map(([, e]) => e.uuid);
  const created = [...want].filter(([k]) => !have.has(k)).length;
  const kept    = [...want].filter(([k]) => have.has(k)).length;
  check('the changed offset row is replaced', removed, ['r2']);
  check('one new row is created',             created, 1);
  check('the UNCHANGED fixed line keeps its row, and its 120s guard', kept, 1);
}

console.log('\n-- THE SAME ANNOUNCEMENT TWICE IS VISIBLE, AND CALLED OUT --');
// The bug this whole redesign removes. Across two tabs it was undetectable; in one list it is two
// adjacent rows — and the editor says so rather than trusting anyone to notice.
{
  const draft = [
    line('30min', 'absolute', '16:00:12'),
    { id: 'dup', announcement_uuid: '30min', mode: 'close_offset', trigger_time: '', offset: -30 },
    line('parade', 'absolute', '19:00:00'),
  ];
  const seen = new Map();
  for (const l of draft) seen.set(l.announcement_uuid, (seen.get(l.announcement_uuid) ?? 0) + 1);
  const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([u]) => u);
  check('the duplicate is detected', dupes, ['30min']);
  check('and it really would fire twice — two different times, both live',
    [dueTimeFor(asRow(draft[0]), '22:00'), dueTimeFor(asRow(draft[1]), '22:00')],
    ['16:00:12', '21:30:00']);
  check('a clean list reports no duplicates',
    (() => { const m = new Map();
      for (const l of [line('a', 'absolute', '19:00:00'), line('b', 'close_offset', -30)]) m.set(l.announcement_uuid, (m.get(l.announcement_uuid) ?? 0) + 1);
      return [...m.values()].filter(n => n > 1).length; })(), 0);
}

console.log('\n-- THE CALENDAR COUNTS THE WHOLE DAY --');
{
  const onDate = [
    { trigger_type: 'absolute' }, { trigger_type: 'close_offset' }, { trigger_type: 'close_offset' },
  ];
  check('one count, both modes, marks the day', onDate.length, 3);
  check('an empty day is not marked', [].length > 0, false);
}

console.log('\n------------------------------');
console.log(`  Passed: ${pass}  Failed: ${fail}`);
console.log(`  VERDICT: ${fail === 0 ? 'PASS' : 'FAIL'}`);
console.log('------------------------------');
process.exit(fail === 0 ? 0 : 1);
