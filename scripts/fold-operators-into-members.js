"use strict";
/**
 * FOLD the dead `operators` roster into the profile's MEMBERS (`users`).
 *
 * `operators` carried a name and initials — no credential, no privileges — and was station-scoped,
 * so one person appeared once per station. `users` is what the PIN screen authenticates against
 * (UserLogin.tsx:60/:72-74). This folds any DISTINCT operator name that is not already a member into
 * `users` with a NULL pin_hash, so the person is visible on the shift screen and must have a PIN set
 * once before they can start a shift.
 *
 * A NULL pin_hash is deliberate. Inventing a PIN would be inventing a credential; leaving it null
 * makes "this person cannot log in yet" a visible fact rather than a silent one.
 *
 * DRY RUN BY DEFAULT. --write to commit. --db <path> to run on a copy.
 */
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const argv = process.argv.slice(2);
const WRITE = argv.includes("--write");
const dbArg = (() => { const i = argv.indexOf("--db"); return i >= 0 ? argv[i + 1] : null; })();
const DB_PATH = dbArg || (() => {
  const P = require(path.join(__dirname, "..", "electron", "profile-paths"));
  return P.dbPath(P.activeKey());
})();

console.log(WRITE ? "WRITE MODE" : "DRY RUN (pass --write to commit)");
console.log("DB:", DB_PATH, `(${(fs.statSync(DB_PATH).size / 1048576).toFixed(1)} MB)`);

const db = new Database(DB_PATH, { readonly: !WRITE });
if (WRITE) db.pragma("busy_timeout = 15000");
const all = (s, ...p) => { try { return db.prepare(s).all(...p); } catch { return []; } };

const ops = all("SELECT id, station_id, name, initials FROM operators ORDER BY id");
const members = all("SELECT id, name, role, pin_hash, station_id FROM users ORDER BY id");

console.log("\nOPERATORS (the dying roster):");
for (const o of ops) console.log(`  id=${o.id} station_id=${o.station_id} ${String(o.name).padEnd(18)} (${o.initials})`);
console.log("\nMEMBERS (users — what the PIN screen authenticates):");
for (const m of members) console.log(`  id=${m.id} ${String(m.name).padEnd(18)} role=${m.role} pin=${m.pin_hash ? "set" : "NONE"}`);

// Case-insensitive name match — "jeff" and "Jeff" are one person, and the roster held both.
const have = new Set(members.map(m => String(m.name).trim().toLowerCase()));
const distinct = [...new Map(ops.map(o => [String(o.name).trim().toLowerCase(), o])).values()];
const toFold = distinct.filter(o => !have.has(String(o.name).trim().toLowerCase()));

console.log("\nFOLD PLAN:");
console.log(`  ${ops.length} operator row(s) -> ${distinct.length} distinct person(s)`);
for (const o of distinct) {
  const dup = have.has(String(o.name).trim().toLowerCase());
  console.log(`    ${String(o.name).padEnd(18)} ${dup ? "already a member — nothing to do" : "WILL BE ADDED as a member (pin_hash NULL)"}`);
}
if (toFold.length === 0) console.log("  nothing to fold — every operator already exists as a member");

if (!WRITE) { console.log("\nDRY RUN — nothing written."); db.close(); process.exit(0); }

if (toFold.length > 0) {
  const stationId = all("SELECT id FROM stations ORDER BY id LIMIT 1")[0]?.id ?? null;
  const ins = db.prepare("INSERT INTO users (name, role, pin_hash, color, station_id) VALUES (?, 'operator', NULL, '#f87171', ?)");
  db.transaction(() => { for (const o of toFold) ins.run(o.name, stationId); })();
  console.log(`\n  folded ${toFold.length} person(s) into users.`);
}

console.log("\nMEMBERS AFTER:");
for (const m of all("SELECT id, name, role, pin_hash FROM users ORDER BY id"))
  console.log(`  id=${m.id} ${String(m.name).padEnd(18)} role=${m.role} pin=${m.pin_hash ? "set" : "NONE — must be set before this person can start a shift"}`);
console.log("\nNOTE: the `operators` table is left in place. It is no longer read by any screen");
console.log("      (OnShiftScreen re-pointed to users). Dropping it belongs in a later migration,");
console.log("      never in the same release that stops reading it.");
db.close();
