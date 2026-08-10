// Bench for the ROTATION GOALS ADVISOR (Phase 1, 2026-08-10).
//   node scripts/smoke-goal-advisor.js      (exit 0 = pass)
//
// Exercises the REAL goalCheck from electron/library-health.js against a synthetic in-memory DB.
// No Electron, no station, no sweep, no live database.
//
// WHY A BENCH AND NOT A LIVE CHECK: the mismatch branch cannot be reached on real data — every
// category on all four live stations has spins_per_hour 0 or NULL (measured, scripts/diag-goal-values.js).
// The only way to prove "under by 2" / "over by 1" is correct is to construct the case.
//
// Design: docs/goal-driven-scheduler-redesign-2026-08-10.md §4 Phase 1
"use strict";
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { createLibraryHealth } = require(path.join(__dirname, "..", "electron", "library-health.js"));

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}` + (ok ? "" : `\n        got=${JSON.stringify(got)}\n       want=${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
}

/** Minimal schema — only the columns goalCheck touches. */
function rig() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE stations   (id INTEGER PRIMARY KEY, name TEXT, deleted_at TEXT);
    CREATE TABLE clocks     (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE shows      (id INTEGER PRIMARY KEY, station_id INTEGER, clock_id INTEGER, is_active INTEGER, deleted_at TEXT);
    CREATE TABLE categories (id INTEGER PRIMARY KEY, station_id INTEGER, code TEXT, name TEXT, spins_per_hour INTEGER, priority INTEGER, deleted_at TEXT);
    CREATE TABLE clock_slots(id INTEGER PRIMARY KEY, clock_id INTEGER, station_id INTEGER, slot_type TEXT, category_id INTEGER, deleted_at TEXT);
    INSERT INTO stations VALUES (1,'Test',NULL);
    INSERT INTO clocks   VALUES (1,'Morning Drive'), (2,'Talk Hour');
    INSERT INTO shows    VALUES (1,1,1,1,NULL), (2,1,2,1,NULL);
  `);
  return db;
}
const cat  = (db, id, code, name, spins, pri) =>
  db.prepare("INSERT INTO categories VALUES (?,?,?,?,?,?,NULL)").run(id, 1, code, name, spins, pri);
const slot = (db, clockId, catId, n, type = "music") => {
  for (let i = 0; i < n; i++) db.prepare("INSERT INTO clock_slots (clock_id,station_id,slot_type,category_id,deleted_at) VALUES (?,?,?,?,NULL)").run(clockId, 1, type, catId);
};
const lh = createLibraryHealth({ getDb: () => null, userDataDir: __dirname });
const run = (db) => lh.goalCheck(db, 1);

// ── 1. UNDER by 2 — the brief's headline example ────────────────────────────────────────────────
{
  const db = rig();
  cat(db, 10, "GO", "Gold", 4, 0);
  slot(db, 1, 10, 2);                       // target 4, has 2
  const r = run(db);
  const row = r.mismatches[0].rows[0];
  check("1a under-by-2 detected", [row.category, row.target, row.slots, row.delta], ["Gold", 4, 2, -2]);
  check("1b declared count",      r.declared, 1);
  db.close();
}

// ── 2. OVER by 1 ────────────────────────────────────────────────────────────────────────────────
{
  const db = rig();
  cat(db, 11, "PW", "Power", 3, 0);
  slot(db, 1, 11, 4);                       // target 3, has 4
  const row = run(db).mismatches[0].rows[0];
  check("2a over-by-1 detected", [row.category, row.target, row.slots, row.delta], ["Power", 3, 4, 1]);
}

// ── 3. EXACT match is silent — no mismatch invented ─────────────────────────────────────────────
{
  const db = rig();
  cat(db, 12, "AC", "Current", 5, 0);
  slot(db, 1, 12, 5);
  const r = run(db);
  check("3a exact match reports nothing", r.mismatches.length, 0);
  check("3b but goals are still declared", r.declared, 1);
}

// ── 4. HONESTY (requirement 6): no target → never reported, at any slot count ───────────────────
{
  const db = rig();
  cat(db, 13, "NG", "NoGoalZero", 0, 0);      // 0 = no goal
  cat(db, 14, "NN", "NoGoalNull", null, null);// NULL = no goal
  slot(db, 1, 13, 7);
  slot(db, 1, 14, 3);
  const r = run(db);
  check("4a target-less categories never appear as mismatches", r.mismatches.length, 0);
  check("4b reported as 'none declared'", r.declared, 0);
  check("4c falls back to composition", r.composition.length, 1);
  check("4d composition is observed fact, not a goal claim",
        r.composition[0].top.map(t => [t.category, t.slots, t.pct]),
        [["NoGoalZero", 7, 70], ["NoGoalNull", 3, 30]]);
}

// ── 5. A goal category ABSENT from a music clock is a real mismatch, flagged distinctly ─────────
{
  const db = rig();
  cat(db, 15, "GO", "Gold", 4, 0);
  cat(db, 16, "PW", "Power", 2, 0);
  slot(db, 1, 16, 2);                        // Power satisfied; Gold absent entirely
  const rows = run(db).mismatches[0].rows;
  check("5a absent goal category reported", [rows[0].category, rows[0].slots, rows[0].delta, rows[0].unused], ["Gold", 0, -4, true]);
  check("5b satisfied category not reported", rows.length, 1);
}

// ── 6. A talk clock (no music slots) is skipped — true but useless is noise ─────────────────────
{
  const db = rig();
  cat(db, 17, "GO", "Gold", 4, 0);
  slot(db, 1, 17, 4);                        // Morning Drive matches
  slot(db, 2, null, 6, "talk");              // Talk Hour has no music slots
  const r = run(db);
  check("6a talk clock produces no mismatch", r.mismatches.length, 0);
}

// ── 7. Priority breaks a tie between equal misses ───────────────────────────────────────────────
{
  const db = rig();
  cat(db, 18, "LO", "LowPri",  3, 1);
  cat(db, 19, "HI", "HighPri", 3, 9);
  slot(db, 1, 18, 1);                        // both under by 2
  slot(db, 1, 19, 1);
  const rows = run(db).mismatches[0].rows;
  check("7a higher priority ranked first on an equal miss", rows[0].category, "HighPri");
}

// ── 8. Soft-deleted slots are ignored — clock law's v4.4.76 lesson must not regress here ────────
{
  const db = rig();
  cat(db, 20, "GO", "Gold", 4, 0);
  slot(db, 1, 20, 4);
  db.prepare("UPDATE clock_slots SET deleted_at='2026-01-01' WHERE id IN (SELECT id FROM clock_slots LIMIT 2)").run();
  const rows = run(db).mismatches[0].rows;
  check("8a deleted slots not counted", [rows[0].slots, rows[0].delta], [2, -2]);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
