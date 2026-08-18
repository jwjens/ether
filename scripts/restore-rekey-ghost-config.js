"use strict";
/**
 * RESTORE the per-station config purged by scripts/purge-rekey-ghost-config.js.
 *
 * The re-key incident left this install's real stations as "ghost" ids 5-8 while the live rows became
 * 1-4. The purge pass deleted the 79 station_config_kv rows still sitting under 5-8, but wrote a full
 * JSON snapshot first. This puts them back under the LIVE station ids.
 *
 * THE MAP IS ANCHORED ON IDENTITY, NOT ORDER:
 *   1. station_uuid carried on the snapshot rows themselves -> the live station with that uuid.
 *   2. failing that, the ghost's own `station_name` config value -> the live station of that name.
 *   3. failing both, the ghost is REFUSED. Nothing is guessed.
 * (In the 2026-08-17 snapshot: 5/6/7 resolve by uuid, 8 by name — it carries no station_uuid on any
 * row. That is exactly the case rule 2 exists for.)
 *
 * COLLISIONS — the conservative default, stated rather than buried:
 *   A key that ALREADY EXISTS on the live station is NOT overwritten. It is skipped and reported with
 *   both values so the difference is visible. Rationale: the live value is what the running app has
 *   been using since the incident, and several of these keys are identity (license_key, plan_tier,
 *   first_run_complete). Silently overwriting identity from a pre-incident snapshot is the same class
 *   of damage as the account:switch bug that gutted a profile's identity. Restore what was LOST;
 *   never clobber what is LIVE. Pass --overwrite to force, and read the diff first.
 *
 * Values are restored VERBATIM — including created_at/updated_at as they were stored. The column is
 * declared INTEGER but these rows hold ISO text; that is what was there, so that is what goes back.
 * A faithful restore is not the place to "fix" a type.
 *
 * DRY RUN BY DEFAULT. --write to commit. --db <path> to run against a copy.
 * Run: cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/restore-rekey-ghost-config.js \
 *        [--db X] [--snapshot Y] [--write] [--overwrite] [--json Z]
 */
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const argv = process.argv.slice(2);
const WRITE = argv.includes("--write");
const OVERWRITE = argv.includes("--overwrite");
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const dbArg = arg("--db");
const jsonArg = arg("--json");

const DB_PATH = dbArg || (() => {
  const P = require(path.join(__dirname, "..", "electron", "profile-paths"));
  return P.dbPath(P.activeKey());
})();

// Snapshot: explicit, or the newest rekey-ghost-config-*.json beside the LIVE database (the purge
// writes it next to the db it purged, which is not necessarily --db when running against a copy).
const SNAP_PATH = arg("--snapshot") || (() => {
  const P = require(path.join(__dirname, "..", "electron", "profile-paths"));
  const dir = path.dirname(P.dbPath(P.activeKey()));
  const hits = fs.readdirSync(dir).filter(f => /^rekey-ghost-config-.*\.json$/.test(f)).sort();
  if (!hits.length) { console.error(`No rekey-ghost-config-*.json found in ${dir}`); process.exit(1); }
  return path.join(dir, hits[hits.length - 1]);
})();

const receipt = {
  tool: "restore-rekey-ghost-config", ranAt: new Date().toISOString(),
  mode: WRITE ? "write" : "dry-run", overwrite: OVERWRITE,
  db: DB_PATH, snapshot: SNAP_PATH,
  map: [], toInsert: [], skipped: [], refused: [], counts: {}, applied: false, verify: null, exitCode: null,
};
process.on("exit", (code) => {
  if (!jsonArg) return;
  receipt.exitCode = code;
  try { fs.writeFileSync(jsonArg, JSON.stringify(receipt, null, 2)); }
  catch (e) { try { console.error(`  receipt NOT written: ${e.message}`); } catch (_) {} }
});

const sep = (t) => { console.log("\n" + "=".repeat(78)); console.log(t); console.log("=".repeat(78)); };
console.log(WRITE ? "WRITE MODE" : "DRY RUN (pass --write to commit)");
console.log("DB:      ", DB_PATH, `(${(fs.statSync(DB_PATH).size / 1048576).toFixed(1)} MB)`);
console.log("SNAPSHOT:", SNAP_PATH);

const snap = JSON.parse(fs.readFileSync(SNAP_PATH, "utf8"));
const snapRows = snap.rows || [];
console.log(`  snapshot taken ${snap.takenAt} — ${snapRows.length} row(s), ghost ids ${JSON.stringify(snap.ghostStationIds)}`);

const db = new Database(DB_PATH, { readonly: !WRITE });
if (WRITE) db.pragma("busy_timeout = 20000");
const q = (s, ...p) => db.prepare(s).all(...p);
const n1 = (s, ...p) => db.prepare(s).get(...p);

// ── 1. live stations ────────────────────────────────────────────────────────────────────────────
sep("1. LIVE STATIONS");
const live = q("SELECT id, uuid, name FROM stations WHERE deleted_at IS NULL ORDER BY id");
for (const s of live) console.log(`  id=${s.id} ${String(s.name).padEnd(22)} uuid=${s.uuid}`);

// ── 2. map each ghost id onto a live id, by identity ────────────────────────────────────────────
sep("2. MAP (ghost id -> live id), anchored on uuid then name");
const ghostIds = [...new Set(snapRows.map(r => Number(r.station_id)))].sort((a, b) => a - b);
const map = new Map();
for (const g of ghostIds) {
  const rows = snapRows.filter(r => Number(r.station_id) === g);
  const uuids = [...new Set(rows.map(r => r.station_uuid).filter(v => v && v !== "None" && v !== "null"))];
  let target = null, how = null;
  for (const u of uuids) { const hit = live.find(s => s.uuid === u); if (hit) { target = hit; how = `station_uuid ${u}`; break; } }
  if (!target) {
    const nameRow = rows.find(r => r.key === "station_name" && r.value);
    if (nameRow) { const hit = live.find(s => String(s.name) === String(nameRow.value)); if (hit) { target = hit; how = `station_name "${nameRow.value}"`; } }
  }
  if (!target) {
    console.log(`  ghost ${g} -> REFUSED (no uuid or name match among live stations)`);
    receipt.refused.push({ ghostId: g, rows: rows.length, reason: "no uuid or name match" });
    continue;
  }
  map.set(g, target.id);
  console.log(`  ghost ${g} -> live ${target.id}   ${target.name}   via ${how}`);
  receipt.map.push({ ghostId: g, liveId: target.id, name: target.name, anchor: how, rows: rows.length });
}
if (receipt.refused.length) { console.error(`\n  ${receipt.refused.length} ghost station(s) unmapped — nothing will be restored for them.`); }
if (!map.size) { console.error("\n  REFUSED: nothing could be mapped."); db.close(); process.exit(1); }

// ── 3. classify every row: insert, or skip because the live station already has that key ─────────
sep("3. PLAN");
const existsStmt = db.prepare("SELECT value FROM station_config_kv WHERE station_id = ? AND key = ?");
for (const r of snapRows) {
  const g = Number(r.station_id);
  if (!map.has(g)) continue;
  const liveId = map.get(g);
  const cur = existsStmt.get(liveId, r.key);
  if (cur === undefined) {
    receipt.toInsert.push({ ghostId: g, liveId, key: r.key, value: r.value });
  } else {
    const identical = String(cur.value) === String(r.value);
    receipt.skipped.push({ ghostId: g, liveId, key: r.key, liveValue: cur.value, snapshotValue: r.value, identical });
  }
}
const byStation = {};
for (const i of receipt.toInsert) { byStation[i.liveId] = (byStation[i.liveId] || 0) + 1; }
console.log(`  to restore: ${receipt.toInsert.length} row(s)` + (Object.keys(byStation).length ? "  (" + Object.entries(byStation).map(([k, v]) => `st${k}:${v}`).join("  ") + ")" : ""));
console.log(`  already present, left alone: ${receipt.skipped.length}` +
            (receipt.skipped.length ? `  (${receipt.skipped.filter(s => s.identical).length} identical, ${receipt.skipped.filter(s => !s.identical).length} DIFFERENT)` : ""));
for (const s of receipt.skipped.filter(s => !s.identical)) {
  console.log(`    st${s.liveId} ${s.key}`);
  console.log(`        live     = ${String(s.liveValue).slice(0, 70)}`);
  console.log(`        snapshot = ${String(s.snapshotValue).slice(0, 70)}`);
}
if (OVERWRITE) console.log("\n  --overwrite: the DIFFERENT rows above WILL be replaced with the snapshot values.");

receipt.counts = {
  snapshotRows: snapRows.length, mapped: receipt.map.length, refusedGhosts: receipt.refused.length,
  toInsert: receipt.toInsert.length, skipped: receipt.skipped.length,
  skippedIdentical: receipt.skipped.filter(s => s.identical).length,
  skippedDifferent: receipt.skipped.filter(s => !s.identical).length,
  kvBefore: n1("SELECT COUNT(*) n FROM station_config_kv").n,
};
console.log(`\n  station_config_kv rows before: ${receipt.counts.kvBefore}`);

if (!WRITE) { console.log("\nDRY RUN — nothing written. Re-run with --write."); db.close(); process.exit(0); }

// ── 4. apply, in ONE transaction ────────────────────────────────────────────────────────────────
sep("4. APPLYING (single transaction)");
const ins = db.prepare(`INSERT INTO station_config_kv (station_id, key, value, uuid, created_at, updated_at, deleted_at, station_uuid)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const upd = db.prepare("UPDATE station_config_kv SET value = ?, updated_at = ? WHERE station_id = ? AND key = ?");
const nul = (v) => (v === undefined || v === null || v === "None" || v === "null" ? null : v);
let inserted = 0, overwritten = 0;
db.transaction(() => {
  for (const i of receipt.toInsert) {
    const r = snapRows.find(x => Number(x.station_id) === i.ghostId && x.key === i.key);
    ins.run(i.liveId, i.key, nul(r.value), nul(r.uuid) || require("crypto").randomUUID(),
            nul(r.created_at), nul(r.updated_at), nul(r.deleted_at), nul(r.station_uuid));
    inserted++;
  }
  if (OVERWRITE) {
    for (const s of receipt.skipped.filter(x => !x.identical)) {
      upd.run(nul(s.snapshotValue), Math.floor(Date.now() / 1000), s.liveId, s.key);
      overwritten++;
    }
  }
})();
receipt.applied = true;
console.log(`  applied — ${inserted} row(s) restored${OVERWRITE ? `, ${overwritten} overwritten` : ""}.`);

// ── 5. verify ───────────────────────────────────────────────────────────────────────────────────
sep("5. VERIFY");
const after = n1("SELECT COUNT(*) n FROM station_config_kv").n;
const perStation = q("SELECT s.id, s.name, (SELECT COUNT(*) FROM station_config_kv k WHERE k.station_id = s.id) n FROM stations s WHERE s.deleted_at IS NULL ORDER BY s.id");
for (const r of perStation) console.log(`  st${r.id} ${String(r.name).padEnd(22)} ${r.n} config row(s)`);
const stillGhost = n1(`SELECT COUNT(*) n FROM station_config_kv WHERE station_id NOT IN (SELECT id FROM stations)`).n;
console.log(`\n  total ${receipt.counts.kvBefore} -> ${after}   (expected +${inserted})`);
console.log(`  rows under a non-existent station: ${stillGhost}`);
receipt.verify = { kvAfter: after, inserted, overwritten, rowsUnderMissingStation: stillGhost,
                   perStation: perStation.map(r => ({ id: r.id, name: r.name, rows: r.n })) };
const ok = after === receipt.counts.kvBefore + inserted && stillGhost === 0;
console.log(ok ? "  VERIFY OK" : "  VERIFY FAILED");
db.close();
process.exit(ok ? 0 : 1);
