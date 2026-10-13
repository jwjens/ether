// scripts/smoke-push-pending-index.js — the sync push reads only what it can send (2026-10-12).
//
// docs/perf-pass-round2-2026-10-12.md §1. RECEIPT: on OVEVENTS the stall sense named a ~300 ms main stall every 10 s;
// the push's pending load walked 217,002 never-sendable generated_schedule mutations for 0 rows.
// Point it at a COPY of a real database (it writes: rows inserted inside a transaction that is rolled back, the index):
//   npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/smoke-push-pending-index.js <database copy>
// PASS = with the partial index the push returns EXACTLY the rows the old query returned (sendable rows of several
// tables + station exclusion), in the same order, in a fraction of the time; a stale index (older exclusion list) is
// replaced; the excluded table's rows are never returned.
"use strict";
const fs = require("fs");
const DB = process.argv[2];
if (!DB || !fs.existsSync(DB)) { console.error("usage: … smoke-push-pending-index.js <database copy>"); process.exit(2); }
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  OK  ", m); } else { fail++; console.log("  FAIL", m); } };
const Database = require("better-sqlite3");
const SE = require("../electron/sync/sync-engine");
const db = new Database(DB);
// `useIndex: false` is the engine as it was (no index, and not allowed to make one); true is the engine now.
const fake = (exclude, useIndex) => ({ _db: db, _getPushOnlyStationId: () => null, _getPushExcludeStationIds: () => exclude,
  _hasPushIndex: useIndex ? SE.SyncEngine.prototype._hasPushIndex : () => false });
const load = (exclude, useIndex = true) => { const t = process.hrtime.bigint(); const r = SE.SyncEngine.prototype._loadPendingMutations.call(fake(exclude, useIndex)); return { r, ms: Number(process.hrtime.bigint() - t) / 1e6 }; };
const time = (f) => { f(); const runs = [f(), f()]; return runs.sort((a, b) => a.ms - b.ms)[0]; };

for (const n of db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_mutations_push_pending_%'").all()) db.exec(`DROP INDEX "${n.name}"`);
db.exec("BEGIN");
const ins = db.prepare(`INSERT INTO mutations (id, client_id, station_id, table_name, row_id, op, payload_after, created_at, applied_at, hlc, schema_version, origin, sync_status)
                        VALUES (?, 'smoke', ?, ?, ?, 'update', '{}', '2026-10-12T00:00:00Z', '2026-10-12T00:00:00Z', ?, 62, 'local', 'pending')`);
const tables = ["songs", "categories", "generated_schedule", "clocks"];
for (let i = 0; i < 400; i++) ins.run(`smoke-${i}`, String(1 + (i % 4)), tables[i % 4], `r${i}`, `9999-smoke-${String(1000 - i).padStart(4, "0")}`);
const before = time(() => load(["3"], false));                  // the old query
console.log(`  ..   old query: ${before.ms.toFixed(1)} ms, ${before.r.length} rows`);
db.exec(`CREATE INDEX idx_mutations_push_pending_deadbeef ON mutations(hlc) WHERE sync_status = 'pending'`);   // a stale list's index
const t0 = Date.now(); SE.ensurePushPendingIndex(db); const buildMs = Date.now() - t0;
const names = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_mutations_push_pending_%'").all().map(x => x.name);
ok(names.length === 1 && names[0] === SE.PUSH_PENDING_INDEX, `the stale index is dropped and the current one made (${names.join(", ")}, ${buildMs} ms)`);
const after = time(() => load(["3"]));
console.log(`  ..   with the index: ${after.ms.toFixed(2)} ms, ${after.r.length} rows`);
ok(after.r.length === before.r.length && after.r.every((m, i) => m.id === before.r[i].id), `the same rows in the same order (${after.r.length})`);
ok(after.r.length > 0 && !after.r.some(m => m.table_name === "generated_schedule") && !after.r.some(m => m.station_id === "3"), "no excluded table and no excluded station is ever returned");
const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM mutations INDEXED BY ${SE.PUSH_PENDING_INDEX} WHERE ${SE.PUSH_PENDING_WHERE} ORDER BY hlc`).all().map(x => x.detail).join(" | ");
ok(/idx_mutations_push_pending_/.test(plan) && !/TEMP B-TREE/.test(plan), `the plan reads the partial index in hlc order, no sort (${plan})`);
ok(after.ms < before.ms / 10, `${(before.ms / Math.max(after.ms, 0.01)).toFixed(0)}× faster (${before.ms.toFixed(1)} → ${after.ms.toFixed(2)} ms)`);
db.exec("ROLLBACK");
console.log(`\n${fail ? "FAILED" : "ALL PASS"}  (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
