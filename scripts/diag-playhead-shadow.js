'use strict';
// diag-playhead-shadow.js — READ-ONLY burn-in reader for the Log-Reader Flip Phase 1 shadow writer.
// Reports, per station: the current playhead (generated_schedule row marked state='playing'), the
// lifecycle distribution, recent shadow activity, and the ON-LOG RATE — the share of actual airs
// (play_log) that map to a stamped generated_schedule row. A low on-log rate is the decks-vs-calendar
// divergence the flip eliminates (visible in the 2026-07-20 screenshots).
//
// Run (better-sqlite3 is built for Electron, so use Electron's node ABI):
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/diag-playhead-shadow.js [db]
// Read-only: opens the DB with { readonly: true } — safe to run while Ether/the daemon is live.

const path = require('path');
const os = require('os');
const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const dbPath = process.argv[2] || path.join(localAppData, 'Ether', 'com.ether.radio', 'openair.db');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const db = new Database(dbPath, { readonly: true });

const nowSec = Math.floor(Date.now() / 1000);
const fmt = (ts) => ts ? new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19) : '(none)';

console.log('=== Playhead shadow diag ===');
console.log('DB:', dbPath, '\nnow:', fmt(nowSec), '\n');

const stations = db.prepare("SELECT DISTINCT station_id FROM generated_schedule WHERE deleted_at IS NULL ORDER BY station_id").all().map(r => r.station_id);
if (!stations.length) { console.log('No generated_schedule rows.'); db.close(); process.exit(0); }

for (const sid of stations) {
  console.log(`── station ${sid} ──────────────────────────────`);

  // Lifecycle distribution.
  const dist = db.prepare("SELECT state, COUNT(*) c FROM generated_schedule WHERE station_id=? AND deleted_at IS NULL GROUP BY state ORDER BY state").all(sid);
  console.log('  state:', dist.map(d => `${d.state}=${d.c}`).join('  ') || '(none)');

  // The playhead: the row marked 'playing'. Should be exactly ONE (or zero when off-log).
  const playing = db.prepare("SELECT id, title, artist, scheduled_at, played_at FROM generated_schedule WHERE station_id=? AND state='playing' AND deleted_at IS NULL ORDER BY scheduled_at").all(sid);
  if (playing.length === 0) console.log('  playhead: (none — off-log, or not started)');
  else if (playing.length === 1) { const p = playing[0]; console.log(`  playhead: row ${p.id} "${p.title}" sched=${fmt(p.scheduled_at)} played_at=${fmt(p.played_at)}`); }
  else console.log(`  playhead: ⚠ ${playing.length} rows marked 'playing' (expected 1):`, playing.map(p => `${p.id}:${p.title}`).join(', '));

  // Shadow activity: rows the writer stamped with played_at in the last hour.
  const recentStamp = db.prepare("SELECT COUNT(*) c FROM generated_schedule WHERE station_id=? AND played_at IS NOT NULL AND played_at >= ?").get(sid, nowSec - 3600).c;
  console.log(`  shadow-stamped played_at in last hour: ${recentStamp}`);

  // ON-LOG RATE — the divergence measure. For the last 20 actual airs (play_log MUSIC rows), does a
  // generated_schedule row exist for this station with the same file_path and a nearby scheduled_at?
  let logRows = [];
  try {
    logRows = db.prepare(
      `SELECT title, file_path, played_at FROM play_log
        WHERE station_id=? AND deleted_at IS NULL AND (content_class IS NULL OR content_class='MUSIC')
        ORDER BY played_at DESC LIMIT 20`).all(sid);
  } catch { logRows = []; }
  if (!logRows.length) { console.log('  on-log rate: (no recent play_log rows)\n'); continue; }
  let onLog = 0;
  // Resolve the schedule row's file the SAME way the daemon does — COALESCE(gs.file_path, s.file_path)
  // via the songs join. gs.file_path is NULL for song rows (only set for voice tracks), so matching
  // gs.file_path alone would falsely report 0% on-log for ordinary music.
  const match = db.prepare(
    `SELECT 1 FROM generated_schedule gs LEFT JOIN songs s ON s.id = gs.song_id
       WHERE gs.station_id=? AND gs.deleted_at IS NULL
         AND COALESCE(gs.file_path, s.file_path) = ? AND ABS(gs.scheduled_at-?) <= 900 LIMIT 1`);
  for (const lr of logRows) {
    if (lr.file_path && match.get(sid, lr.file_path, lr.played_at || 0)) onLog++;
  }
  const pct = Math.round((onLog / logRows.length) * 100);
  console.log(`  ON-LOG RATE (last ${logRows.length} airs matched a schedule row within 15m): ${onLog}/${logRows.length} = ${pct}%  ${pct >= 80 ? '✓ aligned' : '⚠ DIVERGED (decks/queue off the calendar)'}`);
  const offSample = logRows.filter(lr => !(lr.file_path && match.get(sid, lr.file_path, lr.played_at || 0))).slice(0, 3).map(lr => `"${lr.title}"`);
  if (offSample.length) console.log(`    off-log examples: ${offSample.join(', ')}`);
  console.log('');
}

db.close();
console.log('Read-only diag complete. High on-log rate = decks/queue track the calendar (the flip\'s goal).');
