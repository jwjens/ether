// scripts/copy-db-readonly.js — READ-ONLY on the live database. Makes a fresh, consistent copy of the active station
// database (VACUUM INTO from a read-only connection: includes what is still in -wal, never writes the live file), so a
// check can run against the copy while Ether stays on air. Prints the copy's path.
//
// On a computer with Ether installed, in Command Prompt:
//   set ELECTRON_RUN_AS_NODE=1
//   "%LOCALAPPDATA%\Programs\Ether\Ether.exe" copy-db-readonly.js [output path]
// Default output: %TEMP%\openair-copy-<time>.db
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const base = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Ether");
const active = fs.readFileSync(path.join(base, "profiles", "active"), "utf8").trim();
const src = path.join(base, "profiles", active, "openair.db");
const out = process.argv[2] || path.join(os.tmpdir(), `openair-copy-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
if (fs.existsSync(out)) { console.error(`refusing: ${out} already exists`); process.exit(2); }
const db = new DatabaseSync(src, { readOnly: true });
db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
db.close();
console.log(`source ${src}\ncopy   ${out}  (${fs.statSync(out).size} bytes)`);
