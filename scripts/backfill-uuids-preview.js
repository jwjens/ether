'use strict';
// scripts/backfill-uuids-preview.js — read-only preview of what backfill-uuids.js
// would touch. Shows null-UUID counts for all 27 tables in the script.
// Run via:  npx electron --no-sandbox scripts/backfill-uuids-preview.js

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const ROOT    = path.join(__dirname, '..');
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const DB_PATH = path.join(appData, 'com.ether.radio', 'openair.db');

// Exact table list from backfill-uuids.js (27 tables, same order)
const TABLES = [
  { name: 'albums',               pkCols: ['id'] },
  { name: 'announcements',        pkCols: ['id'] },
  { name: 'artists',              pkCols: ['id'] },
  { name: 'cart_slots',           pkCols: ['id'] },
  { name: 'categories',           pkCols: ['id'] },
  { name: 'clock_slots',          pkCols: ['id'] },
  { name: 'clocks',               pkCols: ['id'] },
  { name: 'deck_configs',         pkCols: ['slot'] },
  { name: 'format_clocks',        pkCols: ['id'] },
  { name: 'generated_schedule',   pkCols: ['id'] },
  { name: 'liner_cards',          pkCols: ['id'] },
  { name: 'macros',               pkCols: ['id'] },
  { name: 'operator_notes',       pkCols: ['id'] },
  { name: 'operators',            pkCols: ['id'] },
  { name: 'play_log',             pkCols: ['id'] },
  { name: 'prep_notes',           pkCols: ['id'] },
  { name: 'published_episodes',   pkCols: ['id'] },
  { name: 'rtmp_destinations',    pkCols: ['id'] },
  { name: 'scheduled_log',        pkCols: ['id'] },
  { name: 'separation_rules',     pkCols: ['id'] },
  { name: 'shows',                pkCols: ['id'] },
  { name: 'smart_schedule_rules', pkCols: ['id'] },
  { name: 'songs',                pkCols: ['id'] },
  { name: 'spots',                pkCols: ['id'] },
  { name: 'station_config_kv',    pkCols: ['station_id', 'key'] },
  { name: 'voice_tracks',         pkCols: ['id'] },
  { name: 'stations',             pkCols: ['id'] },
];

function main() {
  if (!fs.existsSync(DB_PATH)) { console.error('DB not found:', DB_PATH); process.exit(1); }

  const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
  const db = new Database(DB_PATH, { readonly: true });

  console.log('\nbackfill-uuids.js PREVIEW (read-only) — what would be written\n');
  console.log('DB:', DB_PATH);
  console.log('');
  console.log('  ' + 'action'.padEnd(12) + 'table'.padEnd(26) + 'null-UUID rows');
  console.log('  ' + '─'.repeat(52));

  let totalWrites = 0;
  const willWrite = [];

  for (const { name } of TABLES) {
    let nullCount;
    try {
      nullCount = db.prepare(`SELECT COUNT(*) as c FROM "${name}" WHERE uuid IS NULL`).get()?.c ?? 0;
    } catch (e) {
      console.log(`  ERR         ${name.padEnd(26)} ${e.message}`);
      continue;
    }

    if (nullCount > 0) {
      console.log(`  WILL WRITE  ${name.padEnd(26)} ${nullCount}`);
      totalWrites += nullCount;
      willWrite.push({ name, nullCount });
    } else {
      console.log(`  skip        ${name.padEnd(26)} 0`);
    }
  }

  console.log('  ' + '─'.repeat(52));
  console.log(`  ${'TOTAL WRITES'.padEnd(38)} ${totalWrites}`);

  if (willWrite.length === 0) {
    console.log('\n  Nothing to write — all 27 tables already have UUIDs.');
  } else {
    console.log('\n  Tables that would receive UUID UPDATEs:');
    for (const { name, nullCount } of willWrite) {
      console.log(`    • ${name}: ${nullCount} row(s)`);

      // Show the actual rows that would be touched (PK + current uuid=NULL confirmation)
      try {
        const rows = db.prepare(`SELECT * FROM "${name}" WHERE uuid IS NULL LIMIT 30`).all();
        for (const r of rows) {
          // Print a brief identifier — use id if present, else first column
          const id = r.id ?? r.slot ?? r.station_id ?? '?';
          const label = r.name ?? r.title ?? r.key ?? r.log_date ?? '';
          console.log(`        id=${id}  ${label ? 'name/key="' + String(label).slice(0,40) + '"' : ''}`);
        }
      } catch (_) {}
    }
  }

  console.log('\n  Note: backfill-uuids.js has NO dry-run mode. It writes immediately.');
  console.log('  The writes above are the ONLY changes it makes:');
  console.log('  UPDATE "<table>" SET uuid = <new-random-uuid> WHERE <pk> = <value>');
  console.log('  All 27 tables processed in a single atomic transaction (rollback on error).');
  console.log('  It does NOT generate mutations. It does NOT alter schema.');

  db.close();
}

main();
process.exit(0);
