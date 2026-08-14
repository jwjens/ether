'use strict';
// scripts/verify-sweep-scenarios.js — the two-scenario test plan, against a COPY.
//   A. real `now`      — only rows whose real 30-day grace has already expired are examined
//   B. now = max(grace_expires_at) + 1 — every row is past grace; the Phase 1 prediction
// Run: ELECTRON_RUN_AS_NODE=1 node_modules\.bin\electron scripts\verify-sweep-scenarios.js <copy.db>

const path = require('path');
const sweep = require(path.join(__dirname, '..', 'electron', 'deletion-sweep.js'));
const dbPath = process.argv[2];
if (!dbPath) { console.error('pass a COPY of the DB'); process.exit(1); }
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const db = new Database(dbPath);
const hr = (t) => console.log('\n' + '='.repeat(78) + '\n' + t + '\n' + '='.repeat(78));

const q = (s, ...a) => db.prepare(s).get(...a);
const realNow = Math.floor(Date.now() / 1000);

hr('Queue state (backfilled by the migration, real deleted_at)');
console.log('rows:', q('SELECT COUNT(*) n FROM deletion_queue').n);
console.log('past grace at real now:', q('SELECT COUNT(*) n FROM deletion_queue WHERE grace_expires_at <= ?', realNow).n);
console.log('within grace          :', q('SELECT COUNT(*) n FROM deletion_queue WHERE grace_expires_at > ?', realNow).n);

hr('SCENARIO A — real now');
const a = sweep.runSweep(db, { machineId: 'scenario-a', now: realNow });
console.log('examined:', a.examined, 'counts:', JSON.stringify(a.counts), 'withinGrace:', a.withinGrace);

// Reset so scenario B evaluates every row from scratch rather than inheriting A's verdicts.
db.prepare("UPDATE deletion_queue SET status='pending', reason=NULL, last_checked_at=NULL").run();

hr('SCENARIO B — now forced past every grace period');
const maxGrace = q('SELECT MAX(grace_expires_at) m FROM deletion_queue').m;
const b = sweep.runSweep(db, { machineId: 'scenario-b', now: maxGrace + 1 });
console.log('examined:', b.examined, 'counts:', JSON.stringify(b.counts), 'withinGrace:', b.withinGrace);

hr('Against the Phase 1 prediction (scenario B)');
const want = { marked: 4, permanent_shared: 2, pending: 26, unverifiable: 0 };
let pass = true;
for (const k of Object.keys(want)) {
  const ok = b.counts[k] === want[k];
  if (!ok) pass = false;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${k} = ${want[k]} — got ${b.counts[k]}`);
}
console.log(`[${b.counts.error === 0 ? 'PASS' : 'FAIL'}] error = 0 — got ${b.counts.error}`);

db.close();
console.log(pass ? '\nScenario B matches the Phase 1 prediction.' : '\nScenario B does NOT match.');
process.exit(pass ? 0 : 1);
