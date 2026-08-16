"use strict";
/**
 * PROVE THE BASELINE WATERMARK ON A COPY — the incident replayed deliberately.
 *
 * Copies the LIVE database to a sandbox, then on the COPY:
 *   1. records the KEEP counts
 *   2. sets the baseline, wipes the journal (the same transaction the button runs)
 *   3. runs the real gate over the real refill query — twice — and asserts it refills NOTHING
 *   4. asserts a row created AFTER the baseline still self-heals (the watermark silences history,
 *      not self-healing — the property that makes this safe rather than merely quiet)
 *   5. asserts KEEP counts are untouched
 *
 * The live database is opened READ-ONLY, to copy bytes out. It is never written.
 * Run: cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/prove-baseline-watermark.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const P = require("../electron/profile-paths");
const { setBaseline, getBaseline, makeBaselineGate } = require("../electron/sync/baseline");

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log("  PASS  " + m); };
const bad = (m) => { fail++; console.log("  FAIL  " + m); };
const check = (c, m) => (c ? ok(m) : bad(m));
const sep = (t) => { console.log("\n" + "=".repeat(76)); console.log(t); console.log("=".repeat(76)); };

const live = P.dbPath(P.activeKey());
const sandbox = path.join(os.tmpdir(), "ether-baseline-proof");
fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(sandbox, { recursive: true });
const copy = path.join(sandbox, "openair.db");

sep("COPYING THE LIVE DATABASE (live opened read-only, never written)");
console.log("  from:", live);
console.log("  to  :", copy);
// Checkpoint-free byte copy of main + sidecars, so the WAL's committed tail comes along.
for (const sfx of ["", "-wal", "-shm"]) {
  if (fs.existsSync(live + sfx)) fs.copyFileSync(live + sfx, copy + sfx);
}
console.log("  size:", (fs.statSync(copy).size / 1048576).toFixed(1), "MB");

const db = new Database(copy);
db.pragma("journal_mode = WAL");
const n = (sql) => db.prepare(sql).get().n;

// ── 1. KEEP counts, before ──────────────────────────────────────────────────────────────────────
sep("1. KEEP COUNTS (before)");
const KEEP = ["songs", "stations", "clocks", "clock_slots", "categories", "spots", "shows",
              "station_config_kv", "operators", "artists", "generated_schedule", "play_log"];
const before = {};
for (const t of KEEP) { try { before[t] = n(`SELECT COUNT(*) n FROM ${t}`); console.log(`  ${t.padEnd(22)} ${String(before[t]).padStart(9)}`); } catch { before[t] = null; } }
const pendBefore = n("SELECT COUNT(*) n FROM mutations WHERE sync_status='pending'");
const totBefore  = n("SELECT COUNT(*) n FROM mutations");
console.log(`  ${"mutations pending".padEnd(22)} ${String(pendBefore).padStart(9)}`);
console.log(`  ${"mutations total".padEnd(22)} ${String(totBefore).padStart(9)}`);

// ── 2. the button's transaction: baseline FIRST, then wipe ──────────────────────────────────────
sep("2. SET BASELINE + WIPE JOURNAL (one transaction, baseline first)");
let baselineResult;
db.transaction(() => {
  baselineResult = setBaseline(db);
  if (!baselineResult.ok) throw new Error(baselineResult.error);
  db.prepare("DELETE FROM mutations").run();
})();
console.log("  baseline:", baselineResult.baseline, `(source: ${baselineResult.source})`);
check(getBaseline(db) === baselineResult.baseline, "baseline persisted in system_state");
check(n("SELECT COUNT(*) n FROM mutations") === 0, `journal wiped (${totBefore} → 0)`);

// ── 3. replay the incident: the real refill query, gated, TWICE ─────────────────────────────────
sep("3. REPLAY — the real refill walk, run twice, must refill NOTHING");
// The exact predicate from scripts/backfill-sync-mutations.js findGapRows()
const gapRows = (table) => db.prepare(`
  SELECT t.* FROM "${table}" t
  WHERE t.uuid IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM mutations m WHERE m.table_name = ? AND m.row_id = t.uuid)
`).all(table);

const WALK = ["categories", "clocks", "clock_slots", "shows", "operators", "artists", "station_programming"];
for (const run of [1, 2]) {
  const gate = makeBaselineGate(db);
  let gaps = 0, skipped = 0, wouldWrite = 0;
  for (const t of WALK) {
    let rows; try { rows = gapRows(t); } catch { continue; }
    for (const r of rows) { gaps++; if (gate.shouldSkip(r)) skipped++; else wouldWrite++; }
  }
  console.log(`  run ${run}: ${gaps} unjournaled row(s) found · ${skipped} skipped as baseline · ${wouldWrite} would be written`);
  check(wouldWrite === 0, `run ${run}: gate refilled NOTHING (${skipped} skipped with a reason, not silence)`);
}
check(makeBaselineGate(db).active === true, "gate reports itself active (a skip is explainable, not silent)");
console.log("  gate says:", makeBaselineGate(db).describe());

// ── 4. self-healing still works for rows created AFTER the baseline ─────────────────────────────
sep("4. SELF-HEALING PRESERVED — a post-baseline row is still re-journaled");
const gate = makeBaselineGate(db);
const future = { uuid: "proof-row", created_at: new Date(gate.baselineMs + 60_000).toISOString() };
const past   = { uuid: "old-row",   created_at: new Date(gate.baselineMs - 60_000).toISOString() };
check(gate.shouldSkip(past) === true,  "row created BEFORE the baseline → skipped (history silenced)");
check(gate.shouldSkip(future) === false, "row created AFTER the baseline → re-journaled (self-healing intact)");
check(gate.shouldSkip({ uuid: "x", created_at: null }) === false, "row with no timestamp → NOT skipped (never silently dropped)");

// ── 5. no watermark ⇒ behaviour identical to today ──────────────────────────────────────────────
sep("5. NO BASELINE ⇒ BEHAVES EXACTLY AS TODAY (OV pre-update, every customer)");
db.prepare("DELETE FROM system_state WHERE key='baseline_hlc'").run();
const off = makeBaselineGate(db);
check(off.active === false, "gate inactive when no baseline is set");
check(off.shouldSkip(past) === false, "with no baseline, an old row is re-journaled — today's behaviour, unchanged");
setBaseline(db, { at: baselineResult.baseline });   // restore for the final count check

// ── 6. KEEP counts unchanged ────────────────────────────────────────────────────────────────────
sep("6. KEEP COUNTS (after) — the data must be untouched");
let allSame = true;
for (const t of KEEP) {
  if (before[t] == null) continue;
  const after = n(`SELECT COUNT(*) n FROM ${t}`);
  const same = after === before[t];
  if (!same) allSame = false;
  console.log(`  ${t.padEnd(22)} ${String(before[t]).padStart(9)} → ${String(after).padStart(9)}  ${same ? "same" : "*** CHANGED ***"}`);
}
check(allSame, "every KEEP table identical before and after");

db.close();
sep(`${pass} passed, ${fail} failed`);
console.log("sandbox:", sandbox, "(safe to delete)");
console.log("LIVE DATABASE WAS NEVER WRITTEN:", live);
process.exit(fail === 0 ? 0 : 1);
