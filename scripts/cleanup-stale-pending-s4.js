// Retire the stale `pending` generated_schedule rows station 4 has carried since the day it was created.
//
// WHAT AND WHY. Station 4 was created 2026-07-24 19:31. Its first Generate run (2026-07-24T21:02:42Z)
// wrote rows referencing songs that the on-format read can never select — notably song id 397,
// '"The Munsters" Theme', whose category_id is NULL, so getFormatCategoryIds() drops it. Those rows have
// sat `pending` ever since: never selectable, never airing, but counted forever in the log-reader's
// `missed` backlog (~1300 rows) and present in the auto-fitter's window arithmetic as candidates that
// can never be picked. This marks them `missed` — the same state the reader itself stamps for a row
// whose slot elapsed — so they stop being pending work.
//
// SCOPE IS DELIBERATELY NARROW: station 4 only, state='pending' only, scheduled_at strictly BEFORE the
// cutoff. Nothing else is touched, and the script proves that by counting the out-of-bound rows before
// and after and refusing to report success if they moved.
//
// SAFETY:
//   • The DB path is a REQUIRED argument. There is no default, so this cannot be pointed at the live DB
//     by accident.
//   • Dry-run by default. `--apply` is required to write, and it runs inside a transaction.
//   • NEVER run against the live DB while Ether or the daemon is open (standing rule: an external write
//     to the live openair.db with the app running corrupts it).
//
// Usage:
//   node scripts/cleanup-stale-pending-s4.js <db-path>              # dry run — counts only
//   node scripts/cleanup-stale-pending-s4.js <db-path> --apply      # writes, Ether CLOSED
"use strict";
const { DatabaseSync } = require("node:sqlite");

const dbPath = process.argv[2];
const APPLY = process.argv.includes("--apply");
if (!dbPath || dbPath.startsWith("--")) {
  console.error("usage: node scripts/cleanup-stale-pending-s4.js <db-path> [--apply]");
  process.exit(2);
}

const STATION_ID = 4;
// Cutoff: 2026-07-25 00:00:00 LOCAL. Every stale row is from 2026-07-24; the first legitimate rows for
// this station start after it. Computed from a local Date so it follows the machine's timezone.
const CUTOFF = Math.floor(new Date(2026, 6, 25, 0, 0, 0).getTime() / 1000);
const L = (e) => new Date(e * 1000).toLocaleString("en-US", { hour12: true });

const db = new DatabaseSync(dbPath, { readOnly: !APPLY });
const one = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);

console.log(`db      : ${dbPath}`);
console.log(`mode    : ${APPLY ? "APPLY (writing)" : "DRY RUN (read-only)"}`);
console.log(`station : ${STATION_ID}`);
console.log(`cutoff  : scheduled_at < ${CUTOFF}  (${L(CUTOFF)})\n`);

// JIN/SWP are seam overlays, not deck tracks: the reader already excludes them from selection AND from
// its `missed` backlog count, so retiring them would change nothing and only widen the blast radius.
// Narrowed to the 191 rows that actually are unairable pending work (2026-07-30, Jeff's call).
const IN_BOUND = `station_id = ? AND state = 'pending' AND scheduled_at < ?
                  AND (content_class IS NULL OR content_class NOT IN ('JIN','SWP'))`;
// The out-of-scope guard must be keyed on ROW IDs captured BEFORE the update, not on a state predicate.
// A state-based "NOT (…state='pending'…)" is self-defeating: the rows we change stop being pending, so
// they migrate INTO the out-of-scope set and it looks like something outside the bound moved. (First
// run on the copy tripped exactly that way — 384 rows appeared to "arrive" in the untouched set.)
const targetIds = new Set(
  db.prepare(`SELECT id FROM generated_schedule WHERE ${IN_BOUND}`).all(STATION_ID, CUTOFF).map(r => r.id)
);
/** Fingerprint every row NOT in the target set: id → state. Must be byte-identical before and after. */
const fingerprintOthers = () => {
  const m = [];
  for (const r of db.prepare(`SELECT id, state FROM generated_schedule ORDER BY id`).all())
    if (!targetIds.has(r.id)) m.push(`${r.id}:${r.state}`);
  return m.join(",");
};

const target = one(`SELECT COUNT(*) n, MIN(scheduled_at) a, MAX(scheduled_at) b FROM generated_schedule WHERE ${IN_BOUND}`, STATION_ID, CUTOFF);
console.log("── ROWS THIS WILL TOUCH ──────────────────────────────────────────");
console.log(`  count: ${target.n}`);
if (target.n) console.log(`  span : ${L(target.a)}  →  ${L(target.b)}`);
console.log("\n  by title:");
for (const r of all(`SELECT title, COUNT(*) n FROM generated_schedule WHERE ${IN_BOUND} GROUP BY title ORDER BY n DESC LIMIT 10`, STATION_ID, CUTOFF))
  console.log(`    ${String(r.n).padStart(4)} × ${String(r.title).slice(0, 52)}`);

const beforeStates = all(`SELECT state, COUNT(*) n FROM generated_schedule WHERE station_id = ? GROUP BY state ORDER BY state`, STATION_ID);
// The guard: everything NOT in scope, across the WHOLE table (all stations), fingerprinted by state.
const beforeOthers = fingerprintOthers();   // every row NOT being touched, by id → state

console.log(`\n  s${STATION_ID} states before: ${beforeStates.map(r => `${r.state}=${r.n}`).join(" · ")}`);
console.log(`  rows NOT in scope (ALL stations): ${beforeOthers ? beforeOthers.split(",").length : 0} — fingerprinted by id→state`);

if (!APPLY) {
  console.log("\nDRY RUN — nothing written. Re-run with --apply (Ether CLOSED) to make the change.");
  db.close();
  process.exit(0);
}

if (target.n === 0) { console.log("\nNothing to do."); db.close(); process.exit(0); }

db.exec("BEGIN");
try {
  db.prepare(`UPDATE generated_schedule SET state = 'missed' WHERE ${IN_BOUND}`).run(STATION_ID, CUTOFF);
  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  console.error("\nFAILED — rolled back:", e.message);
  db.close();
  process.exit(1);
}

const afterStates = all(`SELECT state, COUNT(*) n FROM generated_schedule WHERE station_id = ? GROUP BY state ORDER BY state`, STATION_ID);
const afterOthers = fingerprintOthers();
const remaining = one(`SELECT COUNT(*) n FROM generated_schedule WHERE ${IN_BOUND}`, STATION_ID, CUTOFF).n;

console.log("\n── AFTER ─────────────────────────────────────────────────────────");
console.log(`  s${STATION_ID} states after : ${afterStates.map(r => `${r.state}=${r.n}`).join(" · ")}`);
console.log(`  rows NOT in scope (ALL stations): ${afterOthers ? afterOthers.split(",").length : 0}`);
console.log(`  in-scope rows remaining: ${remaining}  (must be 0)`);

const outUnchanged = beforeOthers === afterOthers;
console.log(`\n  every row OUTSIDE the bound byte-identical (id→state): ${outUnchanged ? "YES ✓" : "NO ✗ — SOMETHING OUTSIDE THE BOUND MOVED"}`);
db.close();
process.exit(outUnchanged && remaining === 0 ? 0 : 1);
