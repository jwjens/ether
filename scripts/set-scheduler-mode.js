// Set a station's scheduler_mode. WRITES to the live DB — Ether and the daemon must be fully closed
// (verified before running; the standing rule is that external writes against a live openair.db while
// Ether is open corrupt it).
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/set-scheduler-mode.js "<station name>" <clock|goal>
"use strict";
const path = require("path"); const fs = require("fs");
const Database = require("better-sqlite3");

const name = process.argv[2];
const mode = process.argv[3];
if (!name || !["clock", "goal"].includes(mode)) {
  console.error('usage: set-scheduler-mode.js "<station name>" <clock|goal>');
  process.exit(2);
}

const DB = path.join(process.env.LOCALAPPDATA || "", "Ether", "com.ether.radio", "openair.db");
if (!fs.existsSync(DB)) { console.error("no live db at", DB); process.exit(1); }

const db = new Database(DB, { fileMustExist: true });
try {
  const before = db.prepare("SELECT id, name, scheduler_mode FROM stations WHERE name = ? AND deleted_at IS NULL").all(name);
  if (!before.length) { console.error(`no station named ${JSON.stringify(name)}`); process.exit(1); }
  if (before.length > 1) { console.error(`${before.length} stations named ${JSON.stringify(name)} — refusing to guess`); process.exit(1); }

  const info = db.prepare("UPDATE stations SET scheduler_mode = ? WHERE name = ? AND deleted_at IS NULL").run(mode, name);
  console.log(`UPDATE stations SET scheduler_mode = '${mode}' WHERE name = '${name}';`);
  console.log(`   rows changed: ${info.changes}\n`);

  const rows = db.prepare("SELECT name, scheduler_mode FROM stations WHERE name = ? AND deleted_at IS NULL").all(name);
  console.log("SELECT name, scheduler_mode FROM stations WHERE name = '" + name + "';");
  console.log("   name                     scheduler_mode");
  console.log("   ------------------------ --------------");
  for (const r of rows) console.log(`   ${String(r.name).padEnd(24)} ${r.scheduler_mode}`);

  console.log("\nall stations:");
  for (const r of db.prepare("SELECT id, name, scheduler_mode FROM stations WHERE deleted_at IS NULL ORDER BY id").all()) {
    console.log(`   ${String(r.id).padEnd(3)} ${String(r.name).padEnd(24)} ${r.scheduler_mode ?? "(null)"}`);
  }
} finally { db.close(); }
