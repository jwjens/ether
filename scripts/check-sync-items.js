// scripts/check-sync-items.js — READ-ONLY. What one computer's station database says about songs, categories, artists,
// carts and plays changed since a moment, keyed by UUID, so two computers and the server can be compared line by line.
// Opens the database read-only (node:sqlite, no install needed); writes nothing; safe while Ether runs.
//
// On a computer with Ether installed (no repo needed), in Command Prompt:
//   set ELECTRON_RUN_AS_NODE=1
//   "%LOCALAPPDATA%\Programs\Ether\Ether.exe" check-sync-items.js 2026-10-21T23:00:00Z
// The database is found the way Ether finds it (the active profile); pass a path as the 2nd argument to override.
// docs/sync-check-songs-carts-plays-2026-10-21.md
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const since = process.argv[2];
if (!since || isNaN(Date.parse(since))) { console.error("usage: check-sync-items.js <since ISO time, e.g. 2026-10-21T23:00:00Z> [db path]"); process.exit(2); }
const base = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Ether");
let dbPath = process.argv[3];
if (!dbPath) {
  const active = fs.readFileSync(path.join(base, "profiles", "active"), "utf8").trim();
  dbPath = path.join(base, "profiles", active, "openair.db");
}
const db = new DatabaseSync(dbPath, { readOnly: true });
const one = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);
const s8 = (u) => (u ? String(u).slice(0, 8) : "-");

console.log(`computer ${os.hostname()}  client ${s8(one("SELECT client_id FROM client_identity LIMIT 1")?.client_id)}  schema ${one("SELECT MAX(version) v FROM schema_version").v}`);
console.log(`database ${dbPath}\nsince    ${since}\n`);

const stations = new Map(all("SELECT id, uuid, name FROM stations").map(s => [s.id, s]));
const st = (id) => { const s = stations.get(id); return s ? `${s.name} ${s8(s.uuid)}` : `#${id}`; };

const changes = all(`SELECT table_name, row_id, op, client_id, origin, sync_status, applied_at, created_at FROM mutations
  WHERE table_name IN ('songs','categories','artists','cart_slots') AND created_at >= ? ORDER BY created_at`, since);
console.log(`── changes in this computer's journal since then: ${changes.length}`);
for (const m of changes) console.log(`  ${m.created_at}  ${m.table_name.padEnd(10)} ${m.op.padEnd(6)} ${m.row_id}  from ${s8(m.client_id)}  ${m.origin || ""} ${m.sync_status || ""}${m.applied_at ? " applied" : ""}`);

const ids = (t) => [...new Set(changes.filter(m => m.table_name === t).map(m => m.row_id))];
console.log(`\n── songs as they stand here (by uuid)`);
for (const u of ids("songs")) {
  const s = one("SELECT * FROM songs WHERE uuid = ?", u);
  if (!s) { console.log(`  ${u}  NOT HERE`); continue; }
  const c = s.category_id != null ? one("SELECT uuid, code, name, station_id FROM categories WHERE id = ?", s.category_id) : null;
  const a = s.artist_id != null ? one("SELECT uuid, name FROM artists WHERE id = ?", s.artist_id) : null;
  console.log(`  ${u}  "${s.title}"${s.deleted_at ? " DELETED" : ""}\n     category ${c ? `${c.uuid}  ${c.code || ""} "${c.name}" (${st(c.station_id)})` : `(none, id ${s.category_id})`}\n     artist   ${a ? `${a.uuid}  "${a.name}"` : `(none, id ${s.artist_id})`}\n     updated  ${s.updated_at}`);
}
for (const t of ["categories", "artists"]) {
  if (!ids(t).length) continue;
  console.log(`\n── ${t} as they stand here (by uuid)`);
  for (const u of ids(t)) { const r = one(`SELECT * FROM ${t} WHERE uuid = ?`, u); console.log(`  ${u}  ${r ? `"${r.name}"${r.code ? " " + r.code : ""}${r.deleted_at ? " DELETED" : ""}` : "NOT HERE"}`); }
}
console.log(`\n── carts as they stand here (by uuid)`);
for (const u of ids("cart_slots")) {
  const c = one("SELECT * FROM cart_slots WHERE uuid = ?", u);
  console.log(`  ${u}  ${c ? `slot ${c.slot_number} "${c.title}" (${st(c.station_id)}) file ${c.file_key || path.basename(String(c.file_path || "")) || "-"}${c.deleted_at ? " DELETED" : ""} updated ${c.updated_at}` : "NOT HERE"}`);
}

// Users on this computer (docs/admin-greets-shawna-2026-10-21.md): PIN format only, never the value.
const pinFmt = (h) => (!h ? "(none)" : /^scrypt\$/.test(h) ? "scrypt" : String(h).includes(":") ? "salt:sha256" : "plain");
console.log(`\n── users here (lowest id first; the shift screen used to greet the lowest live id)`);
for (const u of all("SELECT * FROM users ORDER BY id")) console.log(`  id ${u.id}  ${u.uuid || "-"}  "${u.name}"  ${u.role || "-"}  ${st(u.station_id)}  PIN ${pinFmt(u.pin_hash)}${u.deleted_at ? `  DELETED ${u.deleted_at}` : ""}`);

console.log(`\n── plays recorded on this computer since then`);
const machine = one("SELECT client_id FROM client_identity LIMIT 1")?.client_id;
// played_at is epoch seconds. Grouped by the computer that AIRED it (machine_name): rows that arrived from the other
// computer live in the same table.
const iso = (t) => (typeof t === "number" ? new Date(t * 1000).toISOString() : String(t));
const plays = all(`SELECT station_id, COALESCE(machine_name, '(not stamped)') m, COUNT(*) n, MIN(played_at) first, MAX(played_at) last FROM play_log
  WHERE played_at >= ? AND deleted_at IS NULL GROUP BY station_id, m ORDER BY m, station_id`, Math.floor(Date.parse(since) / 1000));
for (const p of plays) console.log(`  aired on ${p.m} · ${st(p.station_id)}: ${p.n} plays, ${iso(p.first)} → ${iso(p.last)}`);
if (!plays.length) console.log("  none");
const pj = all(`SELECT sync_status, COUNT(*) n, MAX(created_at) last FROM mutations WHERE table_name = 'play_log' AND client_id = ? AND created_at >= ? GROUP BY sync_status`, machine, since);
console.log(`  journaled for sync: ${pj.length ? pj.map(r => `${r.sync_status || "(none)"} ${r.n} (latest ${r.last})`).join(", ") : "none"}`);
db.close();
