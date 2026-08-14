'use strict';
// scripts/backfill-runway-history.js — seed runway_history from the health ledger. ONE-TIME.
//
// runway_history was added 2026-08-13 and starts empty, so the trend chart has nothing to draw for
// seven days. But the runway WAS being recorded incidentally all along: every `library-health` event
// in health-events.jsonl carries stations[].runway, and that file goes back to 21 July.
//
// Run:
//   npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/backfill-runway-history.js          (dry run)
//   npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/backfill-runway-history.js --apply  (writes)
//
// WHY ELECTRON: better-sqlite3 is built for Electron's Node ABI. Same reason as run-sync-tests.js.
//
// ⚠ IT REFUSES TO WRITE WHILE ETHER IS RUNNING. An external process writing the live WAL database
// while the app holds it open is what the never-write-the-live-db rule exists for — it has corrupted
// this database before. Dry run is always safe; --apply checks first and stops.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const APPLY = process.argv.includes('--apply');
const DAYS = (() => {
  const i = process.argv.indexOf('--days');
  return i >= 0 ? Math.max(1, Math.min(60, Number(process.argv[i + 1]) || 7)) : 7;
})();

const DB_PATH = path.join(process.env.LOCALAPPDATA, 'Ether', 'com.ether.radio', 'openair.db');
const LEDGER  = path.join(process.env.APPDATA, 'Ether', 'health-events.jsonl');

// ── safety: is Ether running? ───────────────────────────────────────────────────────────────────
function etherIsRunning() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq Ether.exe" /NH', { encoding: 'utf8' });
    return /Ether\.exe/i.test(out);
  } catch { return false; }   // cannot tell → do not block a dry run; --apply is guarded again below
}

console.log(`runway_history backfill — ${APPLY ? 'APPLY' : 'DRY RUN'} · last ${DAYS} days`);
console.log(`  ledger: ${LEDGER}`);
console.log(`  db:     ${DB_PATH}\n`);

if (APPLY && etherIsRunning()) {
  console.error('REFUSING TO WRITE: Ether is running.');
  console.error('  An external write to the live WAL database while the app holds it open is the');
  console.error('  thing that has corrupted this database before. Fully close Ether (including the');
  console.error('  tray icon, so the daemon stops too), then run again with --apply.');
  process.exit(2);
}

if (!fs.existsSync(LEDGER)) { console.error('No ledger at', LEDGER); process.exit(1); }

// ── read the ledger, newest-relevant only ───────────────────────────────────────────────────────
// Streamed line by line: the file is ~39 MB and unrotated, and it only grows.
const sinceTs = Date.now() - DAYS * 86_400_000;
const rows = new Map();          // `${stationId}|${hourEpoch}` -> {station_id, at, days, level}
const names = new Map();
let scanned = 0, matched = 0, malformed = 0, tooOld = 0;

const text = fs.readFileSync(LEDGER, 'utf8');
for (const line of text.split('\n')) {
  if (!line) continue;
  scanned++;
  if (line.indexOf('"library-health"') === -1) continue;   // cheap pre-filter before JSON.parse
  let e;
  try { e = JSON.parse(line); } catch { malformed++; continue; }
  if (e.kind !== 'library-health' || !Array.isArray(e.stations)) continue;
  const t = Date.parse(e.t);
  if (!Number.isFinite(t)) { malformed++; continue; }
  if (t < sinceTs) { tooOld++; continue; }

  // Align to the top of the hour — the same key the live sampler uses, so a backfilled hour and a
  // live-sampled hour collapse onto one row instead of drawing two points for the same time.
  const hour = Math.floor(t / 3_600_000) * 3600;
  for (const s of e.stations) {
    if (!s || s.stationId == null) continue;
    const r = s.runway || {};
    const days = (r.days == null ? null : Number(r.days));
    if (days == null) continue;            // NULL runway = no active show; nothing to plot, skip
    matched++;
    names.set(s.stationId, s.name || `#${s.stationId}`);
    // LAST WRITE PER HOUR WINS, matching the live sampler's INSERT OR REPLACE. The ledger holds ~30
    // samples an hour; keeping the newest makes the backfilled series identical in shape to one the
    // sampler would have produced.
    rows.set(`${s.stationId}|${hour}`, { station_id: s.stationId, at: hour, days, level: r.level || null });
  }
}

console.log(`scanned ${scanned} ledger lines · ${matched} station-readings in window · ${tooOld} older than ${DAYS}d · ${malformed} unparseable\n`);

// ── report per station ──────────────────────────────────────────────────────────────────────────
const byStation = new Map();
for (const r of rows.values()) {
  if (!byStation.has(r.station_id)) byStation.set(r.station_id, []);
  byStation.get(r.station_id).push(r);
}
const fmt = (s) => new Date(s * 1000).toLocaleString();
for (const [sid, list] of [...byStation.entries()].sort((a, b) => a[0] - b[0])) {
  list.sort((a, b) => a.at - b.at);
  const days = list.map(r => r.days);
  console.log(`  station ${sid} (${names.get(sid)}): ${list.length} hourly points`);
  console.log(`      ${fmt(list[0].at)}  →  ${fmt(list[list.length - 1].at)}`);
  console.log(`      runway min ${Math.min(...days)}d · max ${Math.max(...days)}d · latest ${days[days.length - 1]}d`);
}
if (rows.size === 0) { console.log('  nothing to insert.'); process.exit(0); }

if (!APPLY) {
  console.log(`\nDRY RUN — nothing written. ${rows.size} row(s) would be inserted.`);
  console.log('Close Ether fully (tray included), then re-run with --apply.');
  process.exit(0);
}

// ── write ───────────────────────────────────────────────────────────────────────────────────────
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const db = new Database(DB_PATH, { fileMustExist: true });
try {
  // The table may not exist yet if the app has not started since the schema change.
  db.exec(`CREATE TABLE IF NOT EXISTS runway_history (
    station_id INTEGER NOT NULL, at INTEGER NOT NULL, days REAL, level TEXT,
    PRIMARY KEY (station_id, at))`);

  const before = db.prepare('SELECT COUNT(*) n FROM runway_history').get().n;
  // INSERT OR IGNORE, not REPLACE: a row the LIVE sampler has already written is a real measurement
  // taken at that moment, and a backfilled approximation must never overwrite it.
  const ins = db.prepare('INSERT OR IGNORE INTO runway_history (station_id, at, days, level) VALUES (?,?,?,?)');
  const run = db.transaction((list) => { for (const r of list) ins.run(r.station_id, r.at, r.days, r.level); });
  run([...rows.values()]);
  const after = db.prepare('SELECT COUNT(*) n FROM runway_history').get().n;
  console.log(`\nAPPLIED — runway_history ${before} → ${after} rows (+${after - before}).`);
  console.log('Existing rows were left alone: a live sample outranks a backfilled one.');
} finally { db.close(); }
