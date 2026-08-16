"use strict";
/**
 * Enable UUID-based station identity on the ACTIVE PROFILE.
 *
 * Mirrors ipcMain 'sync:set-uuid-identity' (main.js): writes station_config_kv.sync_uuid_identity
 * and READS IT BACK — a writer that returns success while the row does not change is the defect
 * class this codebase has already paid for twice.
 *
 * The engine reads this flag ONCE at startup (main.js, `const uuidIdentity = ...`), so the stored
 * value and the running engine can differ until the app is restarted. That is reported, not hidden.
 */
const Database = require("better-sqlite3");
const P = require("../electron/profile-paths");

// --off disables it. Needed because a build whose merge-engine still re-keys on apply must NOT run
// with uuid-identity on: every pull that carries a stations row renumbers the local stations and
// orphans their children (4.4.219, fixed in 4.4.220). Off is the safe state until the fixed build
// is installed.
const OFF = process.argv.includes("--off");
const VALUE = OFF ? "false" : "true";

const dbFile = P.dbPath(P.activeKey());
const db = new Database(dbFile);
db.pragma("busy_timeout = 15000");

console.log("DB:", dbFile);
const before = db.prepare("SELECT value v FROM station_config_kv WHERE key='sync_uuid_identity' LIMIT 1").get()?.v ?? "(unset)";
console.log("sync_uuid_identity before:", before);

const now = new Date().toISOString();
const stations = db.prepare("SELECT id FROM stations WHERE deleted_at IS NULL ORDER BY id").all();
const up = db.prepare(`
  INSERT INTO station_config_kv (station_id, key, value, uuid, created_at, updated_at)
  VALUES (?, 'sync_uuid_identity', ?, ?, ?, ?)
  ON CONFLICT(station_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, deleted_at=NULL
`);
const { randomUUID } = require("crypto");
db.transaction(() => { for (const s of stations) up.run(s.id, VALUE, randomUUID(), now, now); })();

const rows = db.prepare("SELECT station_id, value FROM station_config_kv WHERE key='sync_uuid_identity' ORDER BY station_id").all();
console.log("\nread-back per station:");
for (const r of rows) console.log(`  station ${r.station_id}: ${r.value}`);
const allSet = rows.length === stations.length && rows.every(r => r.value === VALUE);
console.log("\nstored:", allSet ? `${VALUE} on every station` : "*** MISMATCH ***");
console.log("RUNNING ENGINE: still using the OLD value until the app is restarted (flag is read once at startup).");
db.close();
process.exit(allSet ? 0 : 1);
