// scripts/export-song-categories.js — READ-ONLY export of every song's category, by stable id, for comparing two
// computers (docs/ovevents-categories-and-users-sync-2026-10-20.md §3). Opens the database read-only; writes one JSON
// file and nothing else. Safe while Ether is running.
//
// Runs on a PACKAGED install (no C:\openair needed), using Ether's own executable as Node and its bundled SQLite:
//   $env:ELECTRON_RUN_AS_NODE = "1"
//   & "$env:LOCALAPPDATA\Programs\Ether\Ether.exe" export-song-categories.js [out.json] [path\to\openair.db]
// Defaults: the active profile's database; out = Desktop\song-categories-<computer>-<time>.json
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");

function loadSqlite() {
  const tries = [
    path.join(path.dirname(process.execPath), "resources", "app.asar.unpacked", "node_modules", "better-sqlite3"),
    path.join(__dirname, "..", "node_modules", "better-sqlite3"),
    "better-sqlite3",
  ];
  for (const t of tries) { try { return require(t); } catch {} }
  throw new Error("better-sqlite3 not found — run this with Ether.exe and ELECTRON_RUN_AS_NODE=1");
}
function activeDb() {
  const root = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Ether");
  const pointer = path.join(root, "profiles", "active");
  const key = fs.existsSync(pointer) ? fs.readFileSync(pointer, "utf8").trim() : "";
  const p = key ? path.join(root, "profiles", key, "openair.db") : "";
  if (!p || !fs.existsSync(p)) throw new Error(`no active profile database (pointer: ${pointer} → "${key}")`);
  return p;
}

const Database = loadSqlite();
const dbPath = process.argv[3] || activeDb();
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = process.argv[2] || path.join(os.homedir(), "Desktop", `song-categories-${os.hostname()}-${stamp}.json`);
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const me = (() => { try { return db.prepare("SELECT client_id FROM client_identity LIMIT 1").get()?.client_id || null; } catch { return null; } })();
const songs = db.prepare(`
  SELECT s.uuid, s.title, s.duration_ms, s.file_path, s.file_key, s.deleted_at,
         c.uuid AS category_uuid, c.name AS category_name, c.deleted_at AS category_deleted_at,
         st.uuid AS station_uuid, st.name AS station_name
    FROM songs s
    LEFT JOIN categories c ON c.id = s.category_id
    LEFT JOIN stations st ON st.id = c.station_id
   ORDER BY s.title`).all();
const categories = db.prepare(`
  SELECT c.uuid, c.name, c.deleted_at, st.uuid AS station_uuid, st.name AS station_name
    FROM categories c LEFT JOIN stations st ON st.id = c.station_id ORDER BY st.name, c.name`).all();
const doc = { exportedAt: new Date().toISOString(), computer: os.hostname(), clientId: me, database: dbPath,
              counts: { songs: songs.length, categories: categories.length }, categories, songs };
db.close();
fs.writeFileSync(out, JSON.stringify(doc, null, 1));
console.log(`exported ${songs.length} songs and ${categories.length} categories from ${os.hostname()} → ${out}`);
