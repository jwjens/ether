'use strict';
// scripts/backfill-sync-mutations.js — generate insert mutations for pre-sync rows.
//
// Walks synced tables and, for any row that has NO existing mutation, writes
// a valid insert mutation via logMutation(). Result: sync_status='pending' rows
// that the normal SyncScheduler push cycle picks up automatically.
//
// DRY-RUN IS THE DEFAULT. Pass --write to commit anything to the DB.
//
// Usage:
//   npx electron --no-sandbox scripts/backfill-sync-mutations.js
//   npx electron --no-sandbox scripts/backfill-sync-mutations.js --write
//   npx electron --no-sandbox scripts/backfill-sync-mutations.js --include-play-log --write
//   npx electron --no-sandbox scripts/backfill-sync-mutations.js --db "C:\path\to\openair.db"
//   npx electron --no-sandbox scripts/backfill-sync-mutations.js --tables artists,albums,categories
//
// Tables are processed in FK-dependency order so the receiving causal queue
// never has to hold a row waiting for a parent (install-scoped parents first,
// then station-scoped children in dependency order).
//
// play_log is EXCLUDED by default (historical reporting data; not needed to
// broadcast). Pass --include-play-log to include it.

const path   = require('path');
const os     = require('os');
const fs     = require('fs');

const ROOT    = path.join(__dirname, '..');
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');

// ── CLI argument parsing ───────────────────────────────────────────────────────

const argv = process.argv.slice(2);

function flag(name)    { return argv.includes(name); }
function argVal(name)  {
  const eq = argv.find(a => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  if (i !== -1 && i + 1 < argv.length && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return null;
}

const DRY_RUN          = !flag('--write');
const INCLUDE_PLAY_LOG = flag('--include-play-log');
const DB_PATH          = argVal('--db') ?? path.join(appData, 'com.ether.radio', 'openair.db');
const tablesFilter     = argVal('--tables')?.split(',').map(s => s.trim()).filter(Boolean) ?? null;

// ── Table definitions — FK-dependency order ────────────────────────────────────
//
// Each entry declares scope and stationIdCol (the column whose value to pass as
// station_id to logMutation). Install-scoped tables have no station_id column;
// they pass null. Station-scoped tables read station_id from the row.

const BACKFILL_TABLES = [
  // Install-scoped — no FK deps on other backfill tables
  { name: 'artists',              scope: 'install', stationIdCol: null },
  { name: 'albums',               scope: 'install', stationIdCol: null },  // FK: artist_id→artists
  { name: 'install_config_kv',    scope: 'install', stationIdCol: null },

  // Station-scoped — depend only on stations (already fully synced)
  { name: 'categories',           scope: 'station', stationIdCol: 'station_id' },
  { name: 'operators',            scope: 'station', stationIdCol: 'station_id' },
  { name: 'separation_rules',     scope: 'station', stationIdCol: 'station_id' },
  { name: 'metadata_definitions', scope: 'station', stationIdCol: 'station_id' },

  // Station-scoped — depends on metadata_definitions
  { name: 'metadata_vocabulary',  scope: 'station', stationIdCol: 'station_id' },

  // Station-scoped — show_id→shows (shows already fully synced)
  { name: 'clocks',               scope: 'station', stationIdCol: 'station_id' },

  // Station-scoped — FK: clock_id→clocks (above), category_id→categories (above)
  { name: 'clock_slots',          scope: 'station', stationIdCol: 'station_id' },

  // Station-scoped — FK: song_id→songs (synced), category_id→categories (above)
  { name: 'station_programming',  scope: 'station', stationIdCol: 'station_id' },
];

// play_log: excluded by default; append when requested
const PLAY_LOG_DEF = { name: 'play_log', scope: 'station', stationIdCol: 'station_id' };

function sep(label) {
  console.log('\n' + '═'.repeat(68));
  console.log('  ' + label);
  console.log('═'.repeat(68));
}

// ── Find gap rows: rows whose uuid is NOT in mutations.row_id for this table ──

function findGapRows(db, tableName) {
  // mutations.row_id stores the uuid of the target row.
  // Rows with null uuid are skipped — backfill-uuids.js should have covered
  // them, but guard anyway.
  return db.prepare(`
    SELECT t.*
    FROM "${tableName}" t
    WHERE t.uuid IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM mutations m
        WHERE m.table_name = ? AND m.row_id = t.uuid
      )
  `).all(tableName);
}

// ── Main ───────────────────────────────────────────────────────────────────────

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error('ERROR: DB not found at', DB_PATH);
    process.exit(1);
  }

  sep(DRY_RUN ? 'DRY RUN — no writes will occur' : 'WRITE MODE — mutations will be created');
  console.log(`\n  DB path       : ${DB_PATH}`);
  console.log(`  play_log      : ${INCLUDE_PLAY_LOG ? 'INCLUDED' : 'excluded (pass --include-play-log to include)'}`);
  if (tablesFilter) console.log(`  --tables      : ${tablesFilter.join(', ')}`);

  const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
  const db = new Database(DB_PATH, { readonly: DRY_RUN });

  if (!DRY_RUN) {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF'); // rows already exist; FK checks on mutations table not needed
  }

  const { logMutation, serializePayload } = require(path.join(ROOT, 'electron', 'sync', 'mutation-writer'));

  // Build active table list
  let tables = [...BACKFILL_TABLES];
  if (INCLUDE_PLAY_LOG) tables.push(PLAY_LOG_DEF);
  if (tablesFilter) tables = tables.filter(t => tablesFilter.includes(t.name));

  sep('Gap analysis — per table');
  console.log('\n  ' +
    'table'.padEnd(26) +
    'scope'.padEnd(10) +
    'gap rows'.padStart(10) +
    '  action'
  );
  console.log('  ' + '─'.repeat(56));

  const plan = [];  // { tableDef, gapRows }

  for (const tableDef of tables) {
    let gapRows;
    try {
      gapRows = findGapRows(db, tableDef.name);
    } catch (e) {
      console.log(`  ⚠ ${tableDef.name.padEnd(25)} ${tableDef.scope.padEnd(10)}  ERR: ${e.message}`);
      continue;
    }

    const action = gapRows.length === 0
      ? 'skip (0 gaps)'
      : (DRY_RUN ? `would generate ${gapRows.length} insert mutations` : `will generate ${gapRows.length} insert mutations`);

    const marker = gapRows.length > 0 ? '⚠' : ' ';
    console.log(`  ${marker} ${tableDef.name.padEnd(25)} ${tableDef.scope.padEnd(10)}${String(gapRows.length).padStart(8)}  ${action}`);

    if (gapRows.length > 0) plan.push({ tableDef, gapRows });
  }

  const totalGap = plan.reduce((s, p) => s + p.gapRows.length, 0);
  console.log('  ' + '─'.repeat(56));
  console.log(`  ${'TOTAL GAP ROWS'.padEnd(35)}${String(totalGap).padStart(8)}`);

  if (totalGap === 0) {
    console.log('\n  Nothing to backfill — all rows already have mutations.');
    if (!DRY_RUN) db.close();
    process.exit(0);
  }

  if (DRY_RUN) {
    sep('DRY RUN COMPLETE — no writes made');
    console.log(`\n  ${totalGap} mutations would be generated across ${plan.length} table(s).`);
    console.log('  Re-run with --write to commit.');
    process.exit(0);
  }

  // ── Write mode: generate mutations per table in FK order ───────────────────

  sep('Writing mutations');

  let totalWritten  = 0;
  let totalSkipped  = 0;
  let totalErrored  = 0;

  for (const { tableDef, gapRows } of plan) {
    const { name: tableName, stationIdCol } = tableDef;
    let written = 0, skipped = 0, errored = 0;

    process.stdout.write(`\n  ${tableName}: writing ${gapRows.length} mutation(s)... `);

    // Write in a single transaction per table for performance.
    // logMutation() is called directly (not via withMutation) per the
    // mutation-writer docs: "Direct use is permitted only for batch
    // operations that manage their own transactions."
    const batchWrite = db.transaction((rows) => {
      for (const row of rows) {
        if (!row.uuid) { skipped++; continue; }

        const stationId = stationIdCol ? (row[stationIdCol] ?? null) : null;

        let payloadAfter;
        try {
          payloadAfter = serializePayload(row, tableName);
        } catch (e) {
          console.error(`\n    WARN: serializePayload failed for ${tableName} uuid=${row.uuid}: ${e.message}`);
          errored++;
          continue;
        }

        try {
          logMutation(db, {
            table_name:     tableName,
            row_id:         row.uuid,
            op:             'insert',
            payload_before: null,
            payload_after:  payloadAfter,
            station_id:     stationId,
            actor_id:       null,
          });
          written++;
        } catch (e) {
          console.error(`\n    ERROR: logMutation failed for ${tableName} uuid=${row.uuid}: ${e.message}`);
          errored++;
        }
      }
    });

    try {
      batchWrite(gapRows);
      console.log(`done. written=${written} skipped=${skipped} errored=${errored}`);
    } catch (e) {
      console.error(`TRANSACTION FAILED: ${e.message}`);
      errored += gapRows.length - written - skipped;
    }

    totalWritten += written;
    totalSkipped += skipped;
    totalErrored += errored;
  }

  // Re-enable FK constraints before closing
  db.pragma('foreign_keys = ON');

  sep('Summary');
  console.log(`\n  Mutations written : ${totalWritten}`);
  console.log(`  Rows skipped      : ${totalSkipped}  (null uuid — backfill-uuids.js not run?)`);
  console.log(`  Errors            : ${totalErrored}`);
  console.log(`\n  sync_status = 'pending' on all written mutations.`);
  console.log('  The SyncScheduler push cycle will push them in the next cycle (~5s).');
  console.log('  Batches of 500 per push tick; ' + totalWritten + ' rows ≈ ' + Math.ceil(totalWritten / 500) + ' tick(s).');

  if (totalErrored > 0) {
    console.log('\n  ⚠  Some rows errored — review output above before pushing.');
  } else {
    console.log('\n  ✓ Backfill complete with 0 errors.');
  }

  db.close();
}

main();
process.exit(0);
