// Retire pending generated_schedule rows that reference an UNCATEGORISED MUSIC song — all stations.
//
// Generalises scripts/cleanup-stale-pending-s4.js, which did station 4 only.
//
// ── READ THIS BEFORE RUNNING. THE OBVIOUS QUERY DESTROYS WORKING CONTENT. ───────────────────────
//
// "Pending rows referencing NULL-category songs" is ~22,000 rows on the live install, and almost all
// of them are CORRECT:
//
//     JIN (jingles)   s2 12,734 · s3 2,440 · s4 14,821 pending    ← category_id NULL BY DESIGN
//     MUSIC, no cat   s2 4 pending                                ← the actual defect
//
// Jingles and spots do not have categories and must not: they are filed by jingle_category_id and
// spot_category_id. Deleting on the NULL-category condition alone would wipe ~30,000 scheduled
// jingles — every piece of imaging in the log. This script is therefore MUSIC-ONLY, and says so in
// its output rather than trusting the reader to remember.
//
// ── WHAT THESE ROWS ARE ────────────────────────────────────────────────────────────────────────
//
// NOT a Generate bug. Verified 2026-08-11 against the live DB: every NULL-category MUSIC row in
// generated_schedule (82 missed + 4 pending + 83 played) carries a category ON THE LOG ROW — the
// Munsters rows were written with category_id 14 and 7, both of which still exist. Generate picked
// a song that WAS categorised; the song was uncategorised afterwards. The rows went stale
// retroactively. So this cleans up after drift; it does not paper over a picker.
//
// ── WHAT IT DOES ───────────────────────────────────────────────────────────────────────────────
//
// Default action is MARK MISSED, not delete:
//   · It is the state the log reader itself stamps for a row whose slot elapsed, so the rows stop
//     being pending work — which is the whole goal.
//   · generated_schedule is a SYNCED table (electron/sync/synced-tables.js). A hard DELETE leaves no
//     tombstone, so a peer install can resurrect every row it just removed.
// `--hard-delete` is available for a true DELETE when that is genuinely wanted.
//
// AIRED HISTORY IS NEVER TOUCHED: state='pending' only. played / playing / missed are left alone.
//
// SAFETY:
//   • The DB path is a REQUIRED argument — this cannot be pointed at the live DB by accident.
//   • Dry-run by default; `--apply` is required to write, inside a transaction.
//   • NEVER run against the live DB while Ether or the daemon is open (standing rule: an external
//     write to the live openair.db with the app running corrupts it).
//
// Usage:
//   node scripts/cleanup-null-category-pending.js <db-path>                    # counts only
//   node scripts/cleanup-null-category-pending.js <db-path> --apply            # mark missed
//   node scripts/cleanup-null-category-pending.js <db-path> --apply --hard-delete
"use strict";
const { DatabaseSync } = require("node:sqlite");

const dbPath = process.argv[2];
const APPLY = process.argv.includes("--apply");
const HARD = process.argv.includes("--hard-delete");
if (!dbPath || dbPath.startsWith("--")) {
  console.error("usage: node scripts/cleanup-null-category-pending.js <db-path> [--apply] [--hard-delete]");
  process.exit(2);
}

// MUSIC only, pending only, not already deleted. Both content_class columns are checked: the one on
// the log row and the one on the song. NULL counts as music (pre-v29 rows).
const MUSIC = `(gs.content_class IS NULL OR gs.content_class = 'MUSIC')
           AND (s.content_class IS NULL OR s.content_class = 'MUSIC')`;
const TARGET = `FROM generated_schedule gs JOIN songs s ON s.id = gs.song_id
   WHERE s.category_id IS NULL AND gs.deleted_at IS NULL AND gs.state = 'pending' AND ${MUSIC}`;

const db = new DatabaseSync(dbPath, { readOnly: !APPLY });
const all = (sql, ...a) => db.prepare(sql).all(...a);
const one = (sql, ...a) => db.prepare(sql).get(...a);

console.log("DB:", dbPath);
console.log("MODE:", APPLY ? (HARD ? "APPLY — HARD DELETE" : "APPLY — mark missed") : "DRY RUN (no writes)");
console.log();

// ── Context first: show what is NOT being touched, so the scope is visible, not assumed ─────────
console.log("Uncategorised songs by class — jingles and spots are CORRECT here:");
for (const r of all(`SELECT COALESCE(content_class,'(null)') cc, COUNT(*) n FROM songs
                      WHERE category_id IS NULL AND deleted_at IS NULL GROUP BY cc ORDER BY n DESC`)) {
  const note = (r.cc === "JIN" || r.cc === "SWP" || r.cc === "SPOT") ? "  ← by design, untouched" : "";
  console.log(`   ${String(r.cc).padEnd(8)} ${String(r.n).padStart(6)}${note}`);
}
console.log();

console.log("Pending rows referencing an uncategorised song, by class — ONLY music is in scope:");
for (const r of all(`SELECT gs.station_id st, COALESCE(s.content_class,'(null)') cc, COUNT(*) n
                       FROM generated_schedule gs JOIN songs s ON s.id = gs.song_id
                      WHERE s.category_id IS NULL AND gs.deleted_at IS NULL AND gs.state='pending'
                      GROUP BY gs.station_id, cc ORDER BY gs.station_id, n DESC`)) {
  const music = r.cc === "MUSIC" || r.cc === "(null)";
  console.log(`   station ${r.st}  ${String(r.cc).padEnd(8)} ${String(r.n).padStart(6)}${music ? "  ← IN SCOPE" : "  (skipped)"}`);
}
console.log();

// ── The target, per station ────────────────────────────────────────────────────────────────────
const perStation = all(`SELECT gs.station_id st, COUNT(*) n, MIN(gs.scheduled_at) first_at, MAX(gs.scheduled_at) last_at ${TARGET} GROUP BY gs.station_id ORDER BY gs.station_id`);
const total = one(`SELECT COUNT(*) n ${TARGET}`).n;
const L = (e) => (e ? new Date(e * 1000).toLocaleString("en-US", { hour12: true }) : "-");

console.log("TARGET — pending + uncategorised + music, per station:");
if (!perStation.length) console.log("   (none)");
for (const r of perStation) console.log(`   station ${r.st}: ${r.n} row(s)   ${L(r.first_at)} → ${L(r.last_at)}`);
console.log(`   TOTAL: ${total}`);
console.log();

console.log("Which songs:");
for (const r of all(`SELECT s.id, s.title, COUNT(*) n ${TARGET} GROUP BY s.id ORDER BY n DESC LIMIT 20`)) {
  console.log(`   [${r.id}] ${r.title} — ${r.n} row(s)`);
}
console.log();

// Aired history, counted before and after so the claim "untouched" is proven, not asserted.
const airedBefore = one(`SELECT COUNT(*) n FROM generated_schedule WHERE state IN ('played','playing','missed') AND deleted_at IS NULL`).n;

if (!APPLY) {
  console.log(`Aired/missed history rows (must not change): ${airedBefore}`);
  console.log("\nDRY RUN — nothing written. Re-run with --apply (Ether CLOSED) to act.");
  db.close();
  process.exit(0);
}

if (total === 0) { console.log("Nothing to do."); db.close(); process.exit(0); }

const now = new Date().toISOString();
db.exec("BEGIN");
try {
  const ids = all(`SELECT gs.id ${TARGET}`).map(r => r.id);
  const chunk = 400;   // stay under SQLite's parameter limit
  let done = 0;
  for (let i = 0; i < ids.length; i += chunk) {
    const part = ids.slice(i, i + chunk);
    const qs = part.map(() => "?").join(",");
    if (HARD) db.prepare(`DELETE FROM generated_schedule WHERE id IN (${qs})`).run(...part);
    else db.prepare(`UPDATE generated_schedule SET state='missed', updated_at=? WHERE id IN (${qs})`).run(now, ...part);
    done += part.length;
  }
  const remaining = one(`SELECT COUNT(*) n ${TARGET}`).n;
  const airedAfter = one(`SELECT COUNT(*) n FROM generated_schedule WHERE state IN ('played','playing','missed') AND deleted_at IS NULL`).n;
  // Marking missed MOVES rows into the aired/missed bucket, so the expected delta is exactly `done`.
  const expectedAired = HARD ? airedBefore : airedBefore + done;

  if (remaining !== 0 || airedAfter !== expectedAired) {
    db.exec("ROLLBACK");
    console.error(`REFUSED: remaining=${remaining} (want 0), aired ${airedBefore}→${airedAfter} (want ${expectedAired}). Rolled back.`);
    process.exit(1);
  }
  db.exec("COMMIT");
  console.log(`${HARD ? "Deleted" : "Marked missed"}: ${done} row(s). Aired history ${airedBefore} → ${airedAfter} (expected ${expectedAired}).`);
} catch (e) {
  db.exec("ROLLBACK");
  console.error("FAILED, rolled back:", e.message);
  process.exit(1);
}
db.close();
