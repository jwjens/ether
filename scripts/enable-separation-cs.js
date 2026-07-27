// enable-separation-cs.js — opt "Christmas In July" into separation enforcement (station_config_kv key
// 'enforce_separation'). WRITES the live DB — RUN ONLY WITH ETHER + THE AUDIO DAEMON FULLY CLOSED.
//
//   node scripts/enable-separation-cs.js        → ENABLE  (value '1')
//   node scripts/enable-separation-cs.js off    → DISABLE (value '0')
//
// Idempotent upsert on PRIMARY KEY (station_id, key). Resolves the station BY NAME (not a hardcoded id).
// This is a LOCAL toggle for testing (it does not push a sync mutation to the dashboard — there's no
// dashboard UI for it yet; the Programming UI is a later slice). Confirms by reading the row back.
'use strict';
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(process.env.LOCALAPPDATA || '', 'Ether', 'com.ether.radio', 'openair.db');
if (!fs.existsSync(dbPath)) { console.error('❌ DB not found at', dbPath); process.exit(1); }

const disable = (process.argv[2] || '').toLowerCase() === 'off';
let db;
try { db = new DatabaseSync(dbPath); } catch (e) { console.error('❌ could not open DB:', e.message); process.exit(1); }
try { db.exec('PRAGMA busy_timeout=3000'); } catch {}

const st = db.prepare("SELECT id, name FROM stations WHERE deleted_at IS NULL AND name LIKE '%Christmas In July%' LIMIT 1").get()
        || db.prepare("SELECT id, name FROM stations WHERE deleted_at IS NULL AND name LIKE '%hristmas%' LIMIT 1").get();
if (!st) { console.error('❌ Station "Christmas In July" not found.'); db.close(); process.exit(1); }

const val = disable ? '0' : '1';
const now = Math.floor(Date.now() / 1000);
try {
  db.prepare(
    `INSERT INTO station_config_kv (station_id, key, value, uuid, created_at, updated_at, deleted_at)
     VALUES (?, 'enforce_separation', ?, ?, ?, ?, NULL)
     ON CONFLICT(station_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, deleted_at=NULL`
  ).run(st.id, val, crypto.randomUUID(), now, now);
} catch (e) {
  console.error('❌ write failed:', e.message);
  console.error('   If this says "database is locked", Ether or the audio daemon is still running — fully quit it and retry.');
  db.close(); process.exit(1);
}

const row = db.prepare("SELECT value, deleted_at FROM station_config_kv WHERE station_id=? AND key='enforce_separation'").get(st.id);
db.close();
console.log(`Station: ${st.name} (id=${st.id})`);
console.log(`enforce_separation = ${row.value}   (deleted_at=${row.deleted_at === null ? 'NULL' : row.deleted_at})`);
console.log(row.value === '1' && row.deleted_at === null
  ? '✅ ENABLED — separation is now ENFORCED for this station. Reopen Ether and RE-GENERATE its days to apply.'
  : '✅ DISABLED — station reverts to today\'s behavior.');
