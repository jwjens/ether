// scripts/repair-file-locations.js — THE ONE-TIME REPAIR for rows whose stored location is not on this computer
// (Jeff, 2026-10-26, item 5: "For songs already pointing somewhere else, write a one-time repair, but first run it
// read-only against a copy of the OVEVENTS database and show me what it would change. Do not run the repair until I say so.")
//
// Before item 5, a row whose stored file was missing played a same-named file from the catalogue without a word (the
// resolver's silent fallback). That fallback is gone (electron/catalogue.js): a row plays exactly the location it stores.
// This repair makes those rows say, once and visibly, where their file is:
//
//   kept       — the stored file is on this computer (the catalogue, or a location the user chose): NEVER touched
//   repoint    — not there, and the catalogue holds the SAME file name: the row is pointed at that catalogue file
//   download   — not there, not in the catalogue, but the row has its cloud copy (file_key): left alone — the first play
//                or prefetch downloads it into the catalogue and points the row at it
//   missing    — not there, not in the catalogue, no cloud copy: left alone, listed
//
// Tables: every audio-bearing table (electron/audio-library-index.js AUDIO_TABLES) and the log's PLANNED rows
// (generated_schedule — an aired row is the record of what aired, never rewritten). Deleted rows are skipped.
// Writes are LOCAL-ONLY (no mutation is journalled: a file location is this computer's fact).
//
// Usage (under Electron's Node, for its better-sqlite3):
//   npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/repair-file-locations.js <database> [--catalogue <folder>] [--out <report.json>]
//       → READ-ONLY: opens the database read-only and reports what it would change. Writes nothing.
//   … --apply
//       → refuses while Ether or its audio engine is running; copies the database aside first; then writes.
"use strict";
const fs = require("fs");
const path = require("path");
const { AUDIO_TABLES, tableColumns, libraryPathFor, storedBasename } = require("../electron/audio-library-index");
const { playableFile } = require("../electron/catalogue");

const args = process.argv.slice(2);
const DB = args.find(a => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--catalogue" && args[args.indexOf(a) - 1] !== "--out");
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const APPLY = args.includes("--apply");
if (!DB || !fs.existsSync(DB)) { console.error("usage: … repair-file-locations.js <database> [--catalogue <folder>] [--out <report.json>] [--apply]"); process.exit(2); }

let CAT = opt("--catalogue");
if (!CAT) { try { CAT = fs.readFileSync(path.join(path.dirname(DB), "music-dir.txt"), "utf8").trim() || null; } catch { CAT = null; } }
if (!CAT || !fs.existsSync(CAT)) { console.error(`no catalogue folder: pass --catalogue <folder> (got ${CAT || "none"})`); process.exit(2); }
const OUT = opt("--out") || path.join(path.dirname(DB), `file-location-repair-${APPLY ? "applied" : "dry-run"}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

function etherRunning() {
  if (process.platform !== "win32") return false;
  try {
    const out = require("child_process").execFileSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8" });
    return /^"(Ether|ether-engine)\.exe"/im.test(out);
  } catch { return true; }   // cannot tell → treat as running: never write a database Ether may have open
}

const Database = require("better-sqlite3");
if (APPLY && etherRunning()) { console.error("Ether (or its audio engine) is running — close it fully before --apply. Nothing was written."); process.exit(3); }
const db = new Database(DB, { readonly: !APPLY, fileMustExist: true });

let catNames = [];
try { catNames = fs.readdirSync(CAT); } catch {}
const inCatalogue = (storedPath) => {
  const name = storedBasename(storedPath || "");
  if (!name) return null;
  const t = libraryPathFor(CAT, name);
  return t.present ? t.path : null;
};

const plan = [];   // { table, id, title, action, from, to, fileKey }
function consider(table, rows, titleOf) {
  for (const r of rows) {
    const from = r.file_path;
    if (playableFile(from)) { plan.push({ table, id: r.id, action: "kept" }); continue; }
    const to = inCatalogue(from);
    if (to) { plan.push({ table, id: r.id, title: titleOf(r), action: "repoint", from, to }); continue; }
    if (r.file_key) { plan.push({ table, id: r.id, title: titleOf(r), action: "download", from, fileKey: r.file_key }); continue; }
    plan.push({ table, id: r.id, title: titleOf(r), action: "missing", from });
  }
}
for (const { table } of AUDIO_TABLES) {
  const cols = tableColumns(db, table);
  if (!cols.has("file_path") || !cols.has("id")) continue;
  const t = cols.has("title") ? "title" : cols.has("name") ? "name" : "NULL";
  const where = ["file_path IS NOT NULL", "file_path != ''", cols.has("deleted_at") ? "deleted_at IS NULL" : null].filter(Boolean).join(" AND ");
  const fk = cols.has("file_key") ? "file_key" : "NULL AS file_key";
  consider(table, db.prepare(`SELECT id, file_path, ${fk}, ${t} AS _t FROM ${table} WHERE ${where}`).all(), r => r._t);
}
{
  const cols = tableColumns(db, "generated_schedule");
  if (cols.has("file_path")) {
    let notAired = "1";
    try { notAired = require("../electron/log-edit-core").NOT_AIRED_SQL; } catch {}
    if (!cols.has("state")) notAired = "1";
    const rows = db.prepare(`SELECT g.id, g.file_path, s.file_key AS file_key, g.title AS _t FROM generated_schedule g LEFT JOIN songs s ON s.id = g.song_id
                              WHERE g.file_path IS NOT NULL AND g.file_path != '' AND g.deleted_at IS NULL AND ${notAired}`).all();
    consider("generated_schedule (planned)", rows, r => r._t);
  }
}

const count = {};
for (const p of plan) { const k = `${p.table}|${p.action}`; count[k] = (count[k] || 0) + 1; }
const tables = [...new Set(plan.map(p => p.table))];
console.log(`\nFile locations — ${APPLY ? "APPLY" : "READ-ONLY (nothing written)"}`);
console.log(`database:  ${DB}`);
console.log(`catalogue: ${CAT} (${catNames.length} files)\n`);
console.log(`${"table".padEnd(30)}${"kept".padStart(8)}${"repoint".padStart(9)}${"download".padStart(10)}${"missing".padStart(9)}`);
for (const t of tables) console.log(`${t.padEnd(30)}${String(count[`${t}|kept`] || 0).padStart(8)}${String(count[`${t}|repoint`] || 0).padStart(9)}${String(count[`${t}|download`] || 0).padStart(10)}${String(count[`${t}|missing`] || 0).padStart(9)}`);
const tot = (a) => plan.filter(p => p.action === a).length;
console.log(`${"TOTAL".padEnd(30)}${String(tot("kept")).padStart(8)}${String(tot("repoint")).padStart(9)}${String(tot("download")).padStart(10)}${String(tot("missing")).padStart(9)}`);

const changes = plan.filter(p => p.action === "repoint");
let written = 0, backup = null;
async function finish() {
  if (APPLY && changes.length) {
    backup = DB.replace(/\.db$/i, "") + `.before-location-repair-${Date.now()}.db`;
    await db.backup(backup);
    const byTable = new Map();
    db.transaction(() => {
      for (const c of changes) {
        const physical = c.table.startsWith("generated_schedule") ? "generated_schedule" : c.table;
        let st = byTable.get(physical);
        if (!st) { st = db.prepare(`UPDATE ${physical} SET file_path = ? WHERE id = ? AND file_path = ?`); byTable.set(physical, st); }
        written += st.run(c.to, c.id, c.from).changes;
      }
    })();
  }
  const report = { at: new Date().toISOString(), apply: APPLY, database: DB, catalogue: CAT, backup, written,
                   totals: { kept: tot("kept"), repoint: tot("repoint"), download: tot("download"), missing: tot("missing") },
                   byTable: count, rows: plan.filter(p => p.action !== "kept") };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\n${APPLY ? `written: ${written} row(s); backup ${backup || "(none needed)"}` : "nothing was written"}`);
  console.log(`every row that would change, or cannot be resolved, is listed in: ${OUT}`);
  db.close();
}
finish().catch((e) => { console.error(e); process.exit(1); });
