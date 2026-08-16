"use strict";
/**
 * EXECUTE the baseline clear against the ACTIVE PROFILE database.
 *
 * Runs the SAME transaction as the sync:clear-pending IPC handler (main.js): set the baseline
 * FIRST, then discard the journal, atomically. Safe to run while the app holds the DB — WAL
 * serialises writers and busy_timeout waits rather than failing.
 *
 * Prints KEEP counts before and after so the "nothing but the backlog moved" claim is evidence.
 * Run: cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/exec-baseline-clear.js
 */
const fs = require("fs");
const Database = require("better-sqlite3");
const P = require("../electron/profile-paths");
const { setBaseline, getBaseline } = require("../electron/sync/baseline");

const active = P.resolveActive();
if (active.pending) { console.error("No active profile."); process.exit(2); }
const dbFile = P.dbPath(active.key);

const sep = (t) => { console.log("\n" + "=".repeat(76)); console.log(t); console.log("=".repeat(76)); };

sep("TARGET");
console.log("  profile :", active.key);
console.log("  DB PATH :", dbFile);
console.log("  size    :", (fs.statSync(dbFile).size / 1048576).toFixed(1), "MB");

const db = new Database(dbFile);
db.pragma("busy_timeout = 15000");   // the app + daemon hold this file; wait, do not fail

const KEEP = ["songs", "stations", "clocks", "clock_slots", "categories", "spots", "shows",
              "station_config_kv", "operators", "artists", "generated_schedule", "play_log"];
const n = (t) => { try { return db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; } catch { return null; } };

sep("BEFORE");
const before = {};
for (const t of KEEP) { before[t] = n(t); console.log(`  ${t.padEnd(22)} ${String(before[t]).padStart(9)}`); }
const pendBefore = db.prepare("SELECT COUNT(*) n FROM mutations WHERE sync_status='pending'").get().n;
const totBefore  = db.prepare("SELECT COUNT(*) n FROM mutations").get().n;
console.log(`  ${"mutations pending".padEnd(22)} ${String(pendBefore).padStart(9)}`);
console.log(`  ${"mutations total".padEnd(22)} ${String(totBefore).padStart(9)}`);
console.log(`  ${"baseline (existing)".padEnd(22)} ${getBaseline(db) ?? "(none)"}`);

sep("EXECUTING — baseline FIRST, then wipe, one transaction");
let result;
try {
  db.transaction(() => {
    result = setBaseline(db);
    if (!result.ok) throw new Error(`baseline not set: ${result.error}`);
    db.prepare("DELETE FROM mutations").run();
  })();
  console.log("  baseline set :", result.baseline, `(source: ${result.source})`);
  console.log("  journal      : DELETED");
} catch (e) {
  console.error("  FAILED:", e.message);
  console.error("  Nothing was committed — the transaction rolled back.");
  db.close();
  process.exit(1);
}

sep("AFTER");
let allSame = true;
for (const t of KEEP) {
  const a = n(t);
  const same = a === before[t];
  if (!same) allSame = false;
  console.log(`  ${t.padEnd(22)} ${String(before[t]).padStart(9)} → ${String(a).padStart(9)}  ${same ? "same" : "*** CHANGED ***"}`);
}
const pendAfter = db.prepare("SELECT COUNT(*) n FROM mutations WHERE sync_status='pending'").get().n;
const totAfter  = db.prepare("SELECT COUNT(*) n FROM mutations").get().n;
console.log(`  ${"mutations pending".padEnd(22)} ${String(pendBefore).padStart(9)} → ${String(pendAfter).padStart(9)}`);
console.log(`  ${"mutations total".padEnd(22)} ${String(totBefore).padStart(9)} → ${String(totAfter).padStart(9)}`);
console.log(`  ${"baseline".padEnd(22)} ${getBaseline(db)}`);

sep(allSame && pendAfter === 0 ? "RESULT: OK — backlog cleared, KEEP data untouched" : "RESULT: CHECK THE ABOVE");
db.close();
process.exit(allSame && pendAfter === 0 ? 0 : 1);
