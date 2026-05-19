'use strict';
// scripts/repair-id-null-mutations.js — fix the id:null collision bug.
//
// Problem: withMutation() stores payload_after.id = null for INSERT mutations.
// Backfill creates INSERT mutations with explicit integer ids (1..N).
// On a fresh client, the id:null rows are auto-assigned ids 1..K, then the
// backfill's explicit-id INSERT OR REPLACE clobbers them.
//
// Fix: for each affected row, create an UPDATE mutation with the FULL row data
// including the correct integer id. The merge engine's UPDATE path strips id
// from the SET clause, but the fallback INSERT OR REPLACE (when the row is
// missing in scratch) uses the full payload including id=<correct value>.
//
// DRY-RUN IS THE DEFAULT. Pass --write to commit mutations and push.
//
// Usage:
//   npx electron --no-sandbox scripts/repair-id-null-mutations.js
//   npx electron --no-sandbox scripts/repair-id-null-mutations.js --write

const path   = require('path');
const os     = require('os');
const fs     = require('fs');

const ROOT    = path.join(__dirname, '..');
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const DB_PATH = path.join(appData, 'com.ether.radio', 'openair.db');

const argv   = process.argv.slice(2);
const DRY_RUN = !argv.includes('--write');

function sep(label) {
  console.log('\n' + '═'.repeat(68));
  console.log('  ' + label);
  console.log('═'.repeat(68));
}

// Tables that have backfill mutations with explicit ids AND withMutation
// mutations with id=null — the collision candidates.
const REPAIR_TABLES = [
  { name: 'artists',              scope: 'install', stationIdCol: null },
  { name: 'categories',           scope: 'station', stationIdCol: 'station_id' },
  { name: 'metadata_definitions', scope: 'station', stationIdCol: 'station_id' },
  { name: 'metadata_vocabulary',  scope: 'station', stationIdCol: 'station_id' },
  { name: 'clocks',               scope: 'station', stationIdCol: 'station_id' },
];

async function main() {
  sep(DRY_RUN ? 'DRY RUN — no writes will occur' : 'WRITE MODE — mutations will be created and pushed');
  console.log('\n  DB path:', DB_PATH);

  if (!fs.existsSync(DB_PATH)) {
    console.error('ERROR: DB not found at', DB_PATH);
    process.exit(1);
  }

  const Database  = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
  const db = new Database(DB_PATH, { readonly: DRY_RUN });
  if (!DRY_RUN) {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF');
  }

  const { logMutation, serializePayload } = require(path.join(ROOT, 'electron', 'sync', 'mutation-writer'));

  // ── Find affected rows: have id=null INSERT mutations ──────────────────────
  sep('Scanning for rows with id=null in payload_after (INSERT mutations)');

  const plan = []; // { tableDef, affectedRows: [{row, currentMutHlc}] }

  for (const tableDef of REPAIR_TABLES) {
    const { name: tableName } = tableDef;

    // Find rows whose INSERT mutation has id=null in payload_after
    const idNullMuts = db.prepare(
      "SELECT row_id, hlc, payload_after FROM mutations WHERE table_name=? AND op='insert'"
    ).all(tableName).filter(m => {
      if (!m.payload_after) return false;
      const pa = JSON.parse(m.payload_after);
      return pa.id === null || pa.id === undefined;
    });

    if (idNullMuts.length === 0) {
      console.log(`  ${tableName}: 0 id=null INSERT mutations → skip`);
      continue;
    }

    // For each, get the current row from real DB
    const affectedRows = [];
    for (const m of idNullMuts) {
      const row = db.prepare(`SELECT * FROM "${tableName}" WHERE uuid = ?`).get(m.row_id);
      if (!row) {
        console.log(`  ${tableName}: uuid=${m.row_id} — no longer in DB, skip`);
        continue;
      }
      if (row.id === null || row.id === undefined) {
        console.log(`  ${tableName}: uuid=${m.row_id} — integer id still null in DB, skip`);
        continue;
      }
      affectedRows.push({ row, existingHlc: m.hlc });
    }

    console.log(`  ${tableName}: ${idNullMuts.length} id=null INSERT mutations, ${affectedRows.length} current rows with valid integer id`);
    if (affectedRows.length > 0) {
      plan.push({ tableDef, affectedRows });
    }
  }

  const totalAffected = plan.reduce((s, p) => s + p.affectedRows.length, 0);
  console.log(`\n  Total rows to repair: ${totalAffected}`);

  if (totalAffected === 0) {
    console.log('\n  Nothing to repair.');
    db.close();
    process.exit(0);
  }

  if (DRY_RUN) {
    sep('DRY RUN — sample of rows to repair');
    for (const { tableDef, affectedRows } of plan) {
      console.log(`\n  ${tableDef.name} (${affectedRows.length} rows):`);
      for (const { row, existingHlc } of affectedRows.slice(0, 5)) {
        const pa = db.prepare(
          "SELECT payload_after FROM mutations WHERE table_name=? AND op='insert' AND row_id=?"
        ).get(tableDef.name, row.uuid);
        const existingId = pa ? JSON.parse(pa.payload_after).id : '?';
        console.log(`    id=${row.id} uuid=${row.uuid} name=${row.name ?? '?'} (existing payload id=${existingId})`);
      }
      if (affectedRows.length > 5) console.log(`    ... and ${affectedRows.length - 5} more`);
    }
    sep('DRY RUN COMPLETE — re-run with --write to apply');
    console.log(`\n  ${totalAffected} UPDATE mutations would be created and pushed.`);
    db.close();
    process.exit(0);
  }

  // ── Write mode: create UPDATE mutations ────────────────────────────────────
  sep('Writing repair UPDATE mutations');

  let totalWritten = 0;
  let totalErrored = 0;

  for (const { tableDef, affectedRows } of plan) {
    const { name: tableName, stationIdCol } = tableDef;
    let written = 0, errored = 0;

    process.stdout.write(`\n  ${tableName}: writing ${affectedRows.length} repair mutation(s)... `);

    const batchWrite = db.transaction((rows) => {
      for (const { row } of rows) {
        let payloadAfter;
        try {
          payloadAfter = serializePayload(row, tableName);
        } catch (e) {
          console.error(`\n    ERROR: serializePayload for ${tableName} uuid=${row.uuid}: ${e.message}`);
          errored++;
          continue;
        }

        // Verify the payload now includes the integer id (serializePayload returns an object)
        if (!payloadAfter.id) {
          console.error(`\n    ERROR: payload still has id=${payloadAfter.id} for ${tableName} uuid=${row.uuid}`);
          errored++;
          continue;
        }

        const stationId = stationIdCol ? (row[stationIdCol] ?? null) : null;

        try {
          logMutation(db, {
            table_name:     tableName,
            row_id:         row.uuid,
            op:             'insert',       // higher-HLC INSERT wins LWW; INSERT OR REPLACE creates row at explicit id
            payload_before: null,
            payload_after:  payloadAfter,   // includes id: <integer>
            station_id:     stationId,
            actor_id:       null,
          });
          written++;
        } catch (e) {
          console.error(`\n    ERROR: logMutation for ${tableName} uuid=${row.uuid}: ${e.message}`);
          errored++;
        }
      }
    });

    try {
      batchWrite(affectedRows);
      console.log(`done. written=${written} errored=${errored}`);
    } catch (e) {
      console.error(`TRANSACTION FAILED: ${e.message}`);
    }

    totalWritten += written;
    totalErrored += errored;
  }

  console.log(`\n  Repair mutations written: ${totalWritten} (errored: ${totalErrored})`);

  // ── Push repair mutations to Railway ──────────────────────────────────────
  sep('Pushing repair mutations to Railway');

  const kv = (key) => db.prepare(
    "SELECT value FROM station_config_kv WHERE key = ? LIMIT 1"
  ).get(key)?.value;

  const syncUrl    = kv('sync_backend_url');
  const stationId  = db.prepare(
    "SELECT DISTINCT station_id FROM mutations WHERE station_id IS NOT NULL AND station_id != 'system' LIMIT 1"
  ).get()?.station_id ?? null;

  console.log(`\n  sync_backend_url: ${syncUrl}`);
  console.log(`  station_id: ${stationId}`);

  if (!syncUrl) {
    console.error('ERROR: sync_backend_url not found. Cannot push.');
    db.close();
    process.exit(1);
  }

  const { HttpTransport } = require(path.join(ROOT, 'electron', 'sync', 'transport-http'));
  const { SyncEngine }    = require(path.join(ROOT, 'electron', 'sync', 'sync-engine'));

  const transport = new HttpTransport(db, { baseUrl: syncUrl });
  const engine    = new SyncEngine(db, transport, { getStationId: () => stationId });

  console.log(`\n  Calling engine.push()...`);
  let pushResult;
  try {
    pushResult = await engine.push();
  } catch (err) {
    console.error('✗ push() threw:', err.message);
    db.close();
    process.exit(1);
  }

  console.log(`  sent=${pushResult.sent}  accepted=${pushResult.accepted}  rejected=${pushResult.rejected}`);

  if (pushResult.accepted === totalWritten) {
    console.log(`\n✓ All ${totalWritten} repair mutations pushed and accepted.`);
  } else {
    console.log(`\n⚠  Accepted ${pushResult.accepted} of ${totalWritten} repair mutations.`);
    if (pushResult.rejected > 0) console.log('  Some were rejected — check server logs.');
  }

  db.close();
}

main().then(() => process.exit(0)).catch(err => {
  console.error('\nFATAL:', err.stack || err.message);
  process.exit(1);
});
