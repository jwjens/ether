"use strict";
/**
 * PURGE the station_config_kv rows left behind by the station re-key.
 *
 * Sync's apply path re-keyed this install's stations to the SENDER's integer ids
 * (merge-engine.js INSERT OR REPLACE, guarded only when uuid-identity is on). Child rows kept
 * pointing at the old ids. For station_config_kv specifically that left a set of rows whose
 * station_id matches no row in `stations` — unreachable, because every reader is scoped to the
 * ACTIVE station id since e190a63 (4.4.224, syncFlagForActiveStation).
 *
 * Those unreachable rows are not inert. They are OLDER than the live rows, and the pre-4.4.224
 * readers took `WHERE key = ? LIMIT 1` — lowest rowid — so a ghost `sync_enabled='true'` on a
 * deleted station beat the active station's real value. That is the class of bug this removes the
 * fuel for.
 *
 * SCOPE: station_config_kv ONLY. Every other orphaned child table (generated_schedule, play_log,
 * clocks, categories, shows, clock_slots, separation_rules, station_programming, spots) is left
 * completely alone — those rows are the station's actual programming and history, and they are
 * repaired by re-pointing (scripts/repair-station-rekey.js), never by deletion.
 *
 * NOT JOURNALLED. These rows are local ghosts of a local re-key: their station_id is meaningless on
 * any other machine. A delete mutation would carry that meaningless id to every peer. The rows are
 * removed with direct SQL and no mutation is written.
 *
 * A JSON snapshot of every row is written next to the database BEFORE anything is deleted.
 *
 * DRY RUN BY DEFAULT. --write to commit. --db <path> to run against a copy.
 * Run: cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/purge-rekey-ghost-config.js [--db X] [--write]
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

const sep = (t) => { console.log("\n" + "=".repeat(78)); console.log(t); console.log("=".repeat(78)); };
console.log(WRITE ? "WRITE MODE" : "DRY RUN (pass --write to commit)");
console.log("DB:", DB_PATH, `(${(fs.statSync(DB_PATH).size / 1048576).toFixed(1)} MB)`);

const db = new Database(DB_PATH, { readonly: !WRITE });
if (WRITE) db.pragma("busy_timeout = 20000");
const q = (s, ...p) => db.prepare(s).all(...p);
const n1 = (s, ...p) => db.prepare(s).get(...p);

// ── 1. live stations, and the config rows that point at no station ──────────────────────────────
sep("1. CURRENT STATE");
const stations = q("SELECT id, uuid, name FROM stations ORDER BY id");
for (const s of stations) console.log(`  live station id=${s.id} ${String(s.name).padEnd(22)} uuid=${s.uuid}`);
if (stations.length === 0) { console.error("\n  REFUSED: no stations at all — this is not the re-key case."); db.close(); process.exit(1); }

const ghosts = q(`SELECT DISTINCT station_id FROM station_config_kv
                   WHERE station_id IS NOT NULL
                     AND NOT EXISTS (SELECT 1 FROM stations s WHERE s.id = station_config_kv.station_id)
                   ORDER BY station_id`).map(r => r.station_id);
console.log("\n  ghost station_id values in station_config_kv:", ghosts.join(", ") || "(none)");
if (ghosts.length === 0) { console.log("\n  Nothing to purge."); db.close(); process.exit(0); }

// SAFETY: a ghost id must not be a live station id. Belt-and-braces against a bad NOT EXISTS.
const liveIds = new Set(stations.map(s => s.id));
const collision = ghosts.filter(g => liveIds.has(g));
if (collision.length) { console.error(`\n  REFUSED: ${collision.join(",")} are LIVE station ids.`); db.close(); process.exit(1); }

// ── 2. exactly what would go ────────────────────────────────────────────────────────────────────
sep("2. ROWS TO REMOVE");
const ph = ghosts.map(() => "?").join(",");
const rows = q(`SELECT rowid, station_id, key, value, uuid, created_at, updated_at, deleted_at, station_uuid
                  FROM station_config_kv WHERE station_id IN (${ph}) ORDER BY station_id, key`, ...ghosts);
const byStation = new Map();
for (const r of rows) { if (!byStation.has(r.station_id)) byStation.set(r.station_id, []); byStation.get(r.station_id).push(r); }
for (const [sid, rs] of [...byStation].sort((a, b) => a[0] - b[0])) {
  const name = rs.find(r => r.key === "station_name")?.value || "(no name row)";
  const uuid = rs.find(r => r.station_uuid)?.station_uuid || "(no uuid stamped)";
  console.log(`\n  station_id=${sid}  "${name}"  station_uuid=${uuid}  — ${rs.length} row(s)`);
  for (const r of rs) {
    const v = r.value == null ? "NULL" : String(r.value).replace(/\s+/g, " ").slice(0, 58);
    console.log(`      ${String(r.key).padEnd(30)} ${v}`);
  }
}
console.log(`\n  TOTAL: ${rows.length} row(s) across ${byStation.size} ghost station id(s)`);

// What the live stations still hold, so the operator can see nothing reachable is being touched.
sep("3. LIVE STATION CONFIG (untouched by this script)");
for (const s of stations) {
  const n = n1("SELECT COUNT(*) n FROM station_config_kv WHERE station_id = ?", s.id).n;
  console.log(`  station ${s.id} "${s.name}": ${n} config row(s)`);
}

// ── 4. snapshot, then delete ────────────────────────────────────────────────────────────────────
sep("4. " + (WRITE ? "SNAPSHOT + DELETE" : "WOULD SNAPSHOT + DELETE"));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = path.join(path.dirname(DB_PATH), `rekey-ghost-config-${stamp}.json`);
const snapshot = {
  takenAt: new Date().toISOString(),
  db: DB_PATH,
  liveStations: stations,
  ghostStationIds: ghosts,
  rowCount: rows.length,
  rows,
};

if (!WRITE) {
  console.log(`  would write snapshot: ${outFile}`);
  console.log(`  would DELETE ${rows.length} row(s) from station_config_kv (no mutation journalled)`);
  console.log("\n  DRY RUN — nothing changed. Re-run with --write to commit.");
  db.close();
  process.exit(0);
}

fs.writeFileSync(outFile, JSON.stringify(snapshot, null, 2));
console.log(`  snapshot written: ${outFile} (${(fs.statSync(outFile).size / 1024).toFixed(1)} KB)`);

const before = n1("SELECT COUNT(*) n FROM station_config_kv").n;
const mutBefore = n1("SELECT COUNT(*) n FROM mutations").n;
const del = db.transaction(() => db.prepare(`DELETE FROM station_config_kv WHERE station_id IN (${ph})`).run(...ghosts));
const res = del();
const after = n1("SELECT COUNT(*) n FROM station_config_kv").n;
const mutAfter = n1("SELECT COUNT(*) n FROM mutations").n;

// ── 5. verify ───────────────────────────────────────────────────────────────────────────────────
sep("5. VERIFY");
const remaining = q(`SELECT DISTINCT station_id FROM station_config_kv
                      WHERE station_id IS NOT NULL
                        AND NOT EXISTS (SELECT 1 FROM stations s WHERE s.id = station_config_kv.station_id)`).map(r => r.station_id);
console.log(`  station_config_kv rows: ${before} -> ${after}   (deleted ${res.changes})`);
console.log(`  mutations journalled:   ${mutBefore} -> ${mutAfter}   (must be unchanged)`);
console.log(`  ghost station_ids remaining: ${remaining.join(", ") || "(none)"}`);
for (const s of stations) {
  const n = n1("SELECT COUNT(*) n FROM station_config_kv WHERE station_id = ?", s.id).n;
  console.log(`  station ${s.id} "${s.name}": ${n} config row(s)`);
}
const ok = remaining.length === 0 && res.changes === rows.length && mutAfter === mutBefore;
console.log("\n  " + (ok ? "OK — ghosts 0, live config intact, no mutations written." : "CHECK FAILED — inspect above."));
db.close();
process.exit(ok ? 0 : 1);
