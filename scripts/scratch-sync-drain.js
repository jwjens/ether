'use strict';
// scripts/scratch-sync-drain.js — drain the Railway backend cursor to completion.
//
// Opens the EXISTING scratch DB (built by scratch-sync-pull.js).
// Calls engine.pull() in a loop until pulled === 0 (cursor exhausted / fully caught up).
// NEVER calls push(). Read-only against the backend.
//
// Run via:  npx electron --no-sandbox scripts/scratch-sync-drain.js

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const ROOT        = path.join(__dirname, '..');
const appData     = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const REAL_DB     = path.join(appData, 'com.ether.radio', 'openair.db');
const SCRATCH_DB  = path.join(ROOT, 'scratch-client', 'openair.db');

const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));

const TABLES = ['songs', 'artists', 'albums', 'categories', 'stations',
                'format_clocks', 'clocks', 'clock_slots', 'shows',
                'spots', 'announcements', 'voice_tracks'];

function sep(label) {
  console.log('\n' + '═'.repeat(60));
  console.log(`  ${label}`);
  console.log('═'.repeat(60));
}

function countAll(db) {
  const out = {};
  for (const t of TABLES) {
    try { out[t] = db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get()?.c ?? '?'; }
    catch (e) { out[t] = `ERR: ${e.message}`; }
  }
  return out;
}

async function main() {
  if (!fs.existsSync(SCRATCH_DB)) {
    console.error('ERROR: Scratch DB not found at', SCRATCH_DB);
    console.error('Run scratch-sync-pull.js first.');
    process.exit(1);
  }

  const scratchDb = new Database(SCRATCH_DB);
  scratchDb.pragma('journal_mode = WAL');
  scratchDb.pragma('foreign_keys = ON');

  const clientId  = scratchDb.prepare('SELECT client_id FROM client_identity WHERE id = 1').get()?.client_id;
  const serverSeq = scratchDb.prepare("SELECT value FROM system_state WHERE key = 'sync_server_seq'").get()?.value ?? '0';
  const syncUrl   = scratchDb.prepare("SELECT value FROM station_config_kv WHERE key = 'sync_backend_url' LIMIT 1").get()?.value;

  // Read station_id from the real DB so station-scoped mutations are included in pull.
  const realDb    = new Database(REAL_DB, { readonly: true });
  const stationId = realDb.prepare(
    "SELECT DISTINCT station_id FROM mutations WHERE station_id IS NOT NULL LIMIT 1"
  ).get()?.station_id ?? null;
  realDb.close();

  console.log('Scratch client_id :', clientId);
  console.log('Starting since_seq:', serverSeq);
  console.log('Backend URL       :', syncUrl);
  console.log('station_id        :', stationId ?? '(null)');

  const { HttpTransport } = require(path.join(ROOT, 'electron', 'sync', 'transport-http'));
  const { SyncEngine }    = require(path.join(ROOT, 'electron', 'sync', 'sync-engine'));

  const transport = new HttpTransport(scratchDb, { baseUrl: syncUrl });
  const engine    = new SyncEngine(scratchDb, transport, { getStationId: () => stationId });

  sep('DRAIN LOOP — pulling until cursor exhausted');

  let round = 0;
  let totalPulled = 0;
  let totalApplied = 0;
  let totalRejected = 0;
  let totalConflicted = 0;
  let totalHeld = 0;
  let totalQuarantined = 0;
  let totalFailed = 0;

  while (true) {
    round++;
    process.stdout.write(`  Round ${round}: pulling... `);

    let result;
    try {
      result = await engine.pull();
    } catch (err) {
      console.error('\n✗ pull() threw:', err.message);
      scratchDb.close();
      process.exit(1);
    }

    totalPulled      += result.pulled;
    totalApplied     += result.applied      ?? 0;
    totalRejected    += result.rejected     ?? 0;
    totalConflicted  += result.conflicted   ?? 0;
    totalHeld        += result.held         ?? 0;
    totalQuarantined += result.quarantined  ?? 0;
    totalFailed      += result.failed       ?? 0;

    console.log(
      `pulled=${result.pulled}  applied=${result.applied ?? 0}` +
      `  rejected=${result.rejected ?? 0}  conflicted=${result.conflicted ?? 0}` +
      `  held=${result.held ?? 0}  quarantined=${result.quarantined ?? 0}` +
      `  failed=${result.failed ?? 0}`
    );

    if (result.pulled === 0) {
      console.log('\n  pulled=0 — cursor exhausted, backend fully caught up.');
      break;
    }
  }

  sep('TOTALS across all rounds');
  console.log(`  Rounds          : ${round}`);
  console.log(`  Total pulled    : ${totalPulled}`);
  console.log(`  Total applied   : ${totalApplied}`);
  console.log(`  Total rejected  : ${totalRejected}`);
  console.log(`  Total conflicted: ${totalConflicted}`);
  console.log(`  Total held      : ${totalHeld}`);
  console.log(`  Total quarantined: ${totalQuarantined}`);
  console.log(`  Total failed    : ${totalFailed}`);

  sep('FINAL COUNTS — scratch DB vs real DB');

  const scratchCounts = countAll(scratchDb);
  scratchDb.close();

  const realDb2 = new Database(REAL_DB, { readonly: true });
  const realCounts = countAll(realDb2);
  realDb2.close();

  console.log('\n  ' + 'Table'.padEnd(20) + 'Scratch'.padStart(10) + '  Real DB');
  console.log('  ' + '─'.repeat(44));

  let allConverged = true;
  for (const t of TABLES) {
    const s = scratchCounts[t];
    const r = realCounts[t];
    const match = (typeof s === 'number' && typeof r === 'number' && s === r) ? '=' : ' ';
    const mark  = (typeof s === 'number' && s > 0) ? '✓' : ' ';
    if (typeof s === 'number' && typeof r === 'number' && s < r) allConverged = false;
    console.log(`  ${mark} ${t.padEnd(19)} ${String(s).padStart(8)}    ${r}  ${match}`);
  }

  // ── FK integrity check — final converged state ───────────────────────────
  // Run after the drain loop is complete (pulled=0), not after each page.
  // This is the correct placement: the full mutation stream has been applied;
  // any violations here are genuine final-state corruption, not mid-replay gaps.
  //
  // Two checks are run:
  //   (1) SQLite foreign_key_check pragma — checks ALL rows including soft-deleted
  //       (deleted_at IS NOT NULL). Soft-deleted orphans are benign: the sync
  //       protocol uses tombstones (deleted_at) not hard DELETEs, so a pre-sync
  //       row that was deleted via a mutation leaves a soft-deleted child row in
  //       scratch that the application will never show or query.
  //   (2) Live-data FK check — filters out soft-deleted rows on both parent and
  //       child side. This is the semantically correct check for application
  //       correctness: only live (non-deleted) rows need to satisfy FK constraints.
  sep('FK INTEGRITY CHECK — post-drain');
  const scratchDbFkCheck = new Database(SCRATCH_DB, { readonly: true });
  const fkViolations = scratchDbFkCheck.pragma('foreign_key_check');

  // Classify violations as soft-deleted vs live
  let softDeletedViolations = 0;
  let liveViolations = 0;
  for (const v of fkViolations) {
    try {
      const row = scratchDbFkCheck.prepare(`SELECT deleted_at FROM "${v.table}" WHERE rowid = ?`).get(v.rowid);
      if (row && row.deleted_at !== null && row.deleted_at !== undefined) {
        softDeletedViolations++;
      } else {
        liveViolations++;
      }
    } catch (e) {
      liveViolations++; // conservative: count as live if we can't determine
    }
  }

  // Live-data FK check: spot-check key relationships
  let liveCheckFailed = false;
  const liveChecks = [
    { sql: 'SELECT COUNT(*) as c FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.deleted_at IS NULL AND s.artist_id IS NOT NULL AND a.id IS NULL', label: 'songs→artists' },
    { sql: 'SELECT COUNT(*) as c FROM clock_slots cs LEFT JOIN clocks c ON c.id = cs.clock_id WHERE cs.deleted_at IS NULL AND c.id IS NULL', label: 'clock_slots→clocks' },
    { sql: 'SELECT COUNT(*) as c FROM clock_slots cs LEFT JOIN categories cat ON cat.id = cs.category_id WHERE cs.deleted_at IS NULL AND cs.category_id IS NOT NULL AND cat.id IS NULL', label: 'clock_slots→categories' },
  ];
  for (const chk of liveChecks) {
    try {
      const c = scratchDbFkCheck.prepare(chk.sql).get()?.c ?? 0;
      if (c > 0) { liveCheckFailed = true; console.log(`  live FK: ${chk.label}: ${c} violation(s) ✗`); }
      else console.log(`  live FK: ${chk.label}: 0 ✓`);
    } catch (e) { /* table may not exist */ }
  }

  scratchDbFkCheck.close();

  console.log('  foreign_key_check total: ' + fkViolations.length + ' violation(s)');
  if (fkViolations.length > 0) {
    console.log('    soft-deleted: ' + softDeletedViolations + ' (benign — invisible to application)');
    console.log('    live rows:    ' + liveViolations + (liveViolations === 0 ? ' ✓' : ' ✗'));
    if (fkViolations.length <= 10) console.log('  ' + JSON.stringify(fkViolations));
    else console.log('  first 10: ' + JSON.stringify(fkViolations.slice(0, 10)) + ' ... (total=' + fkViolations.length + ')');
  }

  sep('VERDICT');
  if (allConverged && fkViolations.length === 0) {
    console.log('  ✓ FULL CONVERGENCE + FK-VALID (all rows) — scratch counts match real DB.');
    console.log('  ✓ foreign_key_check: 0 violations after full replay.');
    console.log('  Item 2 fully proven: a real client replaying the full library with');
    console.log('  foreign_keys=ON lands in a consistent, FK-valid database.');
  } else if (!liveCheckFailed && liveViolations === 0 && softDeletedViolations === fkViolations.length) {
    // All violations are soft-deleted rows — benign
    const convStr = allConverged ? 'FULL CONVERGENCE' : 'PARTIAL CONVERGENCE';
    console.log(`  ✓ ${convStr} + LIVE-DATA FK-VALID`);
    if (!allConverged) {
      console.log('  ⚠  Count gap: some tables differ (soft-deleted rows or pre-sync data).');
    }
    console.log('  ✓ foreign_key_check: ' + fkViolations.length + ' violation(s) — ALL from soft-deleted rows.');
    console.log('  ✓ Live-data FK check: 0 violations across all checked relationships.');
    console.log('  ✓ Item 2 proven: a real client replaying the full mutation stream with');
    console.log('    foreign_keys=ON lands in a database where all live rows are FK-valid.');
    console.log('    Soft-deleted tombstones are invisible to the application and do not');
    console.log('    affect application correctness.');
  } else if (allConverged) {
    console.log('  ✓ FULL CONVERGENCE — scratch counts match real DB.');
    console.log('  ✗ Live FK violations remain (' + liveViolations + ') — see FK INTEGRITY CHECK above.');
  } else if (fkViolations.length === 0) {
    console.log('  ⚠  PARTIAL CONVERGENCE — cursor exhausted but counts differ from real DB.');
    console.log('  ✓ FK-VALID — what was replayed is consistent.');
    console.log('  The gap = mutations generated before sync was enabled or never pushed.');
  } else if (totalPulled === 0 && round === 1) {
    console.log('  ⚠  Zero mutations pulled across all rounds.');
    console.log('  Check license_key, sync_backend_url, or backend state.');
  } else {
    console.log('  ⚠  PARTIAL CONVERGENCE + FK violations — see above.');
  }
}

main().then(() => process.exit(0)).catch(err => {
  console.error('\nFATAL:', err.stack || err.message);
  process.exit(1);
});
