'use strict';
// scripts/audit-station-refs.js — READ-ONLY audit. Loads the real REGISTRY and reports, for every
// station-scoped table, which reference (_id) columns are covered by UUID-identity refs and which
// would STILL silently diverge across machines (no refs declared). Changes nothing.
//
// Run:  node scripts/audit-station-refs.js

const { REGISTRY } = require('../electron/sync/synced-tables');

// Best-guess mapping from an FK column name to the table it references. Only used to annotate the
// gap; the authoritative fact is "this _id column is not station_id and not in refs".
const GUESS = {
  clock_id: 'clocks', clock_slot_id: 'clock_slots', category_id: 'categories', show_id: 'shows',
  artist_id: 'artists', album_id: 'albums', song_id: 'songs', macro_id: 'macros', cart_id: 'cart_slots',
  format_clock_id: 'format_clocks', liner_card_id: 'liner_cards', voice_track_id: 'voice_tracks',
  definition_id: 'metadata_definitions', vocabulary_id: 'metadata_vocabulary', episode_id: 'published_episodes',
  parent_id: '(self?)', operator_id: 'operators',
};
const isSynced = (t) => !!REGISTRY[t];
const scopeOf  = (t) => REGISTRY[t]?.scope ?? '(not synced)';

const stationTables = Object.values(REGISTRY).filter(e => e.scope === 'station').map(e => e.tableName).sort();

let tablesWithGaps = 0, totalGapCols = 0;
const gapReport = [];

console.log(`=== station-scoped synced tables: ${stationTables.length} ===\n`);

for (const t of stationTables) {
  const entry = REGISTRY[t];
  const refs  = entry.refs || {};                          // declared UUID-identity refs
  const cols  = Object.keys(entry.columns);
  // candidate reference columns: anything ending in _id except the row's own pk 'id'
  const idCols = cols.filter(c => /_id$/.test(c) && c !== 'id');

  const covered = [], gaps = [];
  for (const c of idCols) {
    if (c === 'station_id') { covered.push(`${c} → stations (universal default)`); continue; }
    if (refs[c])            { covered.push(`${c} → ${refs[c]} (refs declared)`); continue; }
    const guess = GUESS[c] || '(?)';
    const note  = guess !== '(?)' ? `${guess} [${scopeOf(guess)}]` : 'UNKNOWN';
    gaps.push(`${c} → ${note}`);
  }

  if (gaps.length) { tablesWithGaps++; totalGapCols += gaps.length; }
  gapReport.push({ t, idCols, covered, gaps });
}

// ── per-table detail ──
for (const r of gapReport) {
  const flag = r.gaps.length ? 'GAP ' : 'ok  ';
  console.log(`${flag}${r.t}`);
  for (const c of r.covered) console.log(`        covered: ${c}`);
  for (const c of r.gaps)    console.log(`        >>> GAP: ${c}`);
  if (r.idCols.length === 0) console.log(`        (no reference columns — only station_id scoping applies, covered by default)`);
  console.log('');
}

// ── summary ──
console.log('=== SUMMARY ===');
console.log(`  station-scoped tables: ${stationTables.length}`);
console.log(`  tables fully covered (station_id default + any refs): ${stationTables.length - tablesWithGaps}`);
console.log(`  tables WITH an undeclared parent-FK gap: ${tablesWithGaps}  (${totalGapCols} columns)`);
console.log('');
console.log('  Tables with gaps and their gap columns:');
for (const r of gapReport) if (r.gaps.length) console.log(`    ${r.t.padEnd(26)} ${r.gaps.join(', ')}`);
