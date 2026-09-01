'use strict';
// scripts/smoke-closing-isolation.js — the hard rule, pinned.
//
// Jeff, 2026-08-31, non-negotiable: "Changing a SINGLE day's closing time affects ONLY that day. It
// must NEVER touch the rest of the calendar, a following Sunday, the weekday pattern, or any other
// date. A one-day change is a one-day change, period."
//
// A rule stated in prose is a rule until someone refactors. This is the property test: resolve every
// date in a range, change ONE thing, resolve them all again, and assert exactly the intended dates
// moved. It fails on any writer that assembles a whole document instead of touching one key.
//
// THE SAME FIXTURES RUN ON BOTH SIDES. ether-backend/scripts/smoke-ops-core.js pins the identical
// resolution, because the backend PREVIEWS these times on the operator's phone and the desktop FIRES
// them. If the two drift, Park Ops shows one time and the station plays another.
//
//   node scripts/smoke-closing-isolation.js

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? '' : `\n         got:  ${JSON.stringify(got)}\n         want: ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

// ── the resolver under test, byte-identical to electron/main.js ────────────────────────────────
function resolveClosingCfg(cfg, dateStr, dow) {
  const d = cfg.byDate && cfg.byDate[dateStr];
  if (typeof d === 'string' && d) return d;
  const w = cfg.byWeekday && cfg.byWeekday[String(dow)];
  if (typeof w === 'string' && w) return w;
  return cfg.default || null;
}

const dowOf = (ymd) => new Date(`${ymd}T12:00:00`).getDay();   // midday: no timezone can shift the day

/** Every date in October + November 2026, with what each one resolves to. */
function resolveAll(cfg) {
  const out = {};
  for (const [month, days] of [[10, 31], [11, 30]]) {
    for (let d = 1; d <= days; d++) {
      const ymd = `2026-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      out[ymd] = resolveClosingCfg(cfg, ymd, dowOf(ymd));
    }
  }
  return out;
}

/** Which dates differ between two full resolutions. */
function diff(before, after) {
  return Object.keys(before).filter(k => before[k] !== after[k]).sort();
}

// The writers under test. Each takes a cfg and returns a NEW cfg — the shape the real writers must
// produce. Any of them reaching beyond its own key is what this file exists to catch.
const setDate    = (cfg, date, t) => ({ ...cfg, byDate: { ...cfg.byDate, [date]: t } });
const setWeekday = (cfg, dow, t)  => ({ ...cfg, byWeekday: { ...cfg.byWeekday, [String(dow)]: t } });
const setDefault = (cfg, t)       => ({ ...cfg, default: t });

const BASE = {
  default: '22:00',
  byWeekday: { '0': '18:00', '5': '23:00', '6': '23:00' },   // Sun early; Fri+Sat late
  byDate: { '2026-10-31': '23:30', '2026-11-08': '19:00' },  // Halloween late; one Sunday overridden
};

console.log('=== smoke-closing-isolation ===');

console.log('\n── precedence: byDate > byWeekday > default ──');
check('a dated exception wins',            resolveClosingCfg(BASE, '2026-10-31', dowOf('2026-10-31')), '23:30');
check('otherwise the weekday pattern',     resolveClosingCfg(BASE, '2026-11-01', dowOf('2026-11-01')), '18:00');
check('otherwise the default',             resolveClosingCfg(BASE, '2026-11-04', dowOf('2026-11-04')), '22:00');
check('a dated exception beats its own weekday', resolveClosingCfg(BASE, '2026-11-08', dowOf('2026-11-08')), '19:00');
check('nothing set anywhere is null, never a guess', resolveClosingCfg({ default: null, byWeekday: {}, byDate: {} }, '2026-11-04', 3), null);

console.log('\n── ONE DAY: a date with no rule of its own ──');
{
  const before = resolveAll(BASE);
  const after  = resolveAll(setDate(BASE, '2026-10-15', '20:00'));
  check('exactly one date moves', diff(before, after), ['2026-10-15']);
  check('and it is the one that was set', after['2026-10-15'], '20:00');
  check('the same weekday a week later is untouched', after['2026-10-22'], before['2026-10-22']);
}

console.log('\n── ONE DAY: a date that already had an exception ──');
{
  const before = resolveAll(BASE);
  const after  = resolveAll(setDate(BASE, '2026-10-31', '22:45'));
  check('exactly one date moves', diff(before, after), ['2026-10-31']);
  check('the other exception is untouched', after['2026-11-08'], '19:00');
}

console.log('\n── ONE DAY: a Sunday, whose value came from the weekday pattern ──');
{
  const before = resolveAll(BASE);
  const after  = resolveAll(setDate(BASE, '2026-10-11', '17:00'));   // a Sunday
  check('exactly one date moves', diff(before, after), ['2026-10-11']);
  check('EVERY OTHER SUNDAY IS UNTOUCHED — the rule Jeff named',
    ['2026-10-04', '2026-10-18', '2026-10-25', '2026-11-01', '2026-11-15'].map(d => after[d]),
    ['18:00', '18:00', '18:00', '18:00', '18:00']);
  check('and the weekday pattern itself is unchanged', setDate(BASE, '2026-10-11', '17:00').byWeekday, BASE.byWeekday);
}

console.log('\n── THE PATTERN: changing Sundays moves Sundays, and spares the overridden one ──');
{
  const before = resolveAll(BASE);
  const after  = resolveAll(setWeekday(BASE, 0, '17:30'));
  const moved  = diff(before, after);
  check('every moved date is a Sunday', moved.every(d => dowOf(d) === 0), true);
  check('the Sunday carrying its own byDate did NOT move', moved.includes('2026-11-08'), false);
  check('and that Sunday keeps its own value', after['2026-11-08'], '19:00');
  check('no Friday or Saturday moved', moved.some(d => dowOf(d) === 5 || dowOf(d) === 6), false);
}

console.log('\n── THE DEFAULT: moves only days with no date and no weekday rule ──');
{
  const before = resolveAll(BASE);
  const after  = resolveAll(setDefault(BASE, '21:00'));
  const moved  = diff(before, after);
  check('nothing with a weekday rule moved', moved.some(d => [0, 5, 6].includes(dowOf(d))), false);
  check('nothing with a dated exception moved', moved.some(d => d in BASE.byDate), false);
  check('a plain Wednesday did move', after['2026-11-04'], '21:00');
}

console.log('\n── THE WRITE ITSELF: nothing outside the touched key may change ──');
// This is what catches a writer that ships a whole document assembled from a stale copy — the Park
// Ops defect. Resolution can look right while the write silently carries someone else's value back.
{
  const after = setDate(BASE, '2026-10-15', '20:00');
  check('default untouched',   after.default, BASE.default);
  check('byWeekday untouched', after.byWeekday, BASE.byWeekday);
  check('every other byDate untouched',
    Object.fromEntries(Object.entries(after.byDate).filter(([k]) => k !== '2026-10-15')), BASE.byDate);
}
{
  const after = setWeekday(BASE, 0, '17:30');
  check('a weekday write leaves byDate alone', after.byDate, BASE.byDate);
  check('a weekday write leaves default alone', after.default, BASE.default);
  check('and leaves the OTHER weekdays alone',
    Object.fromEntries(Object.entries(after.byWeekday).filter(([k]) => k !== '0')),
    Object.fromEntries(Object.entries(BASE.byWeekday).filter(([k]) => k !== '0')));
}

console.log('\n-- MULTI-DATE APPLY: N dates selected writes exactly N keys --');
// The By minutes board applies a closing time to every SELECTED date in ONE write. This is that
// write's shape: one read-modify-write, one byDate key per selected date, and nothing else in the
// value altered. Applying per date in a loop would re-read a value the same loop had just written,
// which is how a batch ends up racing itself.
{
  const applySelection = (cfg, sel, t) => {
    const bd = { ...cfg.byDate };
    for (const d of sel) bd[d] = t;
    return { ...cfg, byDate: bd };
  };
  const SEL = ['2026-10-02', '2026-10-09', '2026-10-16'];   // three Fridays
  const before = resolveAll(BASE);
  const after  = resolveAll(applySelection(BASE, SEL, '23:45'));
  check('exactly the selected dates move', diff(before, after), SEL);
  check('each selected date got the applied time', SEL.map(d => after[d]), ['23:45', '23:45', '23:45']);
  check('an UNSELECTED Friday is untouched', after['2026-10-23'], before['2026-10-23']);

  const w = applySelection(BASE, SEL, '23:45');
  check('the weekday pattern is untouched', w.byWeekday, BASE.byWeekday);
  check('the default is untouched', w.default, BASE.default);
  check('pre-existing one-off dates are untouched',
    Object.fromEntries(Object.entries(w.byDate).filter(([k]) => !SEL.includes(k))), BASE.byDate);

  // Applying to a date that already carried its own value replaces THAT ONE and no other.
  const over = applySelection(BASE, ['2026-10-31'], '22:00');
  check('overwriting one exception leaves the other alone', over.byDate['2026-11-08'], '19:00');
  check('and moves only that date', diff(resolveAll(BASE), resolveAll(over)), ['2026-10-31']);
}

console.log('\n── offset resolution against whatever that day closes at ──');
// The point of resolve-at-fire: one rule, different times, no rewrites.
const hhmmToMinutes = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '').trim()); if (!m) return null;
  const h = +m[1], mi = +m[2]; return (h > 23 || mi > 59) ? null : h * 60 + mi; };
const minutesToHms = (n) => { const w = ((n % 1440) + 1440) % 1440;
  return `${String(Math.floor(w / 60)).padStart(2, '0')}:${String(w % 60).padStart(2, '0')}:00`; };
function dueTimeFor(row, closingHHMM) {
  if (row.trigger_type !== 'close_offset') return row.trigger_time;
  const base = hhmmToMinutes(closingHHMM);
  if (base == null) return null;
  return minutesToHms(base + (Number(row.close_offset_min) || 0));
}
const minus30 = { trigger_type: 'close_offset', close_offset_min: -30, trigger_time: '09:00:00' };
check('a Sunday 18:00 close fires the -30 rule at 17:30',
  dueTimeFor(minus30, resolveClosingCfg(BASE, '2026-11-01', dowOf('2026-11-01'))), '17:30:00');
check('a Saturday 23:00 close fires the SAME rule at 22:30',
  dueTimeFor(minus30, resolveClosingCfg(BASE, '2026-10-10', dowOf('2026-10-10'))), '22:30:00');
check('Halloween 23:30 fires it at 23:00',
  dueTimeFor(minus30, resolveClosingCfg(BASE, '2026-10-31', dowOf('2026-10-31'))), '23:00:00');
check('NO closing time means NO fire — never the stale absolute time it carries',
  dueTimeFor(minus30, null), null);
check('an absolute row is untouched by any of this',
  dueTimeFor({ trigger_type: 'absolute', trigger_time: '22:00:00' }, '18:00'), '22:00:00');
check('an offset past midnight wraps rather than going negative',
  dueTimeFor({ trigger_type: 'close_offset', close_offset_min: 25 }, '23:50'), '00:15:00');

console.log('\n──────────────────────────────');
console.log(`  Passed: ${pass}  Failed: ${fail}`);
console.log(`  VERDICT: ${fail === 0 ? 'PASS' : 'FAIL'}`);
console.log('──────────────────────────────');
process.exit(fail === 0 ? 0 : 1);
