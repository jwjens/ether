// scripts/smoke-library-health-worker.js — the library-health sweep no longer blocks the main process (2026-10-12).
//
// docs/health-monitor-jump-and-freeze-2026-10-12.md. Runs under Electron's own Node (its better-sqlite3 build):
//   npx cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/smoke-library-health-worker.js <database copy> [library dir]
// Point it at a COPY of a real database (never the live file). It measures this thread's event-loop lag (a 10 ms timer's
// lateness) while:
//   A · the sweep runs ON this thread, as main did before (createLibraryHealth().computeAll());
//   B · the sweep runs in the worker (electron/library-health-host.js), with main answering a queue-lint call meanwhile.
// PASS = B's worst lag is under one frame (16.7 ms) while A's is the multi-second stall, and B's results match A's.
"use strict";
const path = require("path"), fs = require("fs"), os = require("os");
const DB = process.argv[2];
const LIB = process.argv[3] || null;
if (!DB || !fs.existsSync(DB)) { console.error("usage: … smoke-library-health-worker.js <database copy> [library dir]"); process.exit(2); }
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-worker-"));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  OK  ", m); } else { fail++; console.log("  FAIL", m); } };

function lagMeter() {
  let worst = 0, expected = Date.now() + 10;
  const t = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - expected); expected = now + 10; }, 10);
  return { stop: () => { clearInterval(t); return worst; } };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const Database = require("better-sqlite3");
  // A · on this thread, as main used to.
  const db = new Database(DB, { readonly: true });
  const LH = require("../electron/library-health");
  const inMain = LH.createLibraryHealth({ getDb: () => db, backendUrl: null, licenseKeyFn: () => null, broadcast: () => {},
    musicDirFn: () => LIB, restoreInFlightFn: () => false, userDataDir: TMP });
  let m = lagMeter(); await sleep(50);
  const t0 = Date.now(); const a = inMain.computeAll(); const aMs = Date.now() - t0;
  await sleep(50); const aLag = m.stop();
  console.log(`  ..   A (sweep on main): ${aMs} ms; main's worst event-loop lag ${aLag} ms`);
  const aLint = inMain.lintRows(a.stations[0] && a.stations[0].stationId);

  // B · in the worker.
  const host = require("../electron/library-health-host").createLibraryHealthHost({
    dbPathFn: () => DB, ctxFn: () => ({ musicDir: LIB, restoreInFlight: false, licenseKey: null }), userDataDir: TMP, backendUrl: null,
    broadcast: () => {}, log: (s) => console.log("  ..   " + s), healthEvent: () => {}, inMainFallback: () => { throw new Error("fallback must not be needed"); },
  });
  m = lagMeter();
  host.start();
  let snap = null;
  for (let i = 0; i < 600 && !(snap = host.snapshot()).t; i++) await sleep(50);   // the first sweep, in the worker
  const sid = a.stations[0] && a.stations[0].stationId;
  const lintT0 = Date.now(); const bLint = await host.lintRows(sid); const lintMs = Date.now() - lintT0;
  await sleep(100); const bLag = m.stop();
  console.log(`  ..   B (sweep in the worker): main's worst event-loop lag ${bLag} ms over the whole sweep; queue-lint answered in ${lintMs} ms without blocking`);
  ok(!!snap.t && snap.stations.length === a.stations.length, `B: the worker swept every station (${snap.stations.length}/${a.stations.length}), sweepMs ${snap.sweepMs}`);
  ok(host.stats().inWorker, "B: the worker carries it (no in-main fallback)");
  ok(aLag > 1000, `A reproduces the freeze: main blocked ${aLag} ms by one sweep`);
  ok(bLag < 17, `B: main never blocked longer than one frame (worst ${bLag} ms < 16.7 ms)`);
  ok(JSON.stringify(bLint) === JSON.stringify(aLint), `B: queue-lint answers the same as before (${(bLint || []).length} rows)`);
  const strip = (s) => JSON.stringify(s.stations.map(x => ({ ...x, sweepMs: 0 })));
  ok(snap.stations.map(x => x.stationId).join() === a.stations.map(x => x.stationId).join(), "B: the same stations in the same order as the in-main sweep");
  console.log(`\n${fail ? "FAILED" : "ALL PASS"}  (${pass} passed, ${fail} failed)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
