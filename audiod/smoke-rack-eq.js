// smoke-rack-eq.js — SLICE 4: the master EQ reaches THE RIGHT station's engine, and is re-applied when an
// engine starts. docs/dsp-rack-framework.md §8. No audio, no device, no DB file.
//
//   node audiod/smoke-rack-eq.js
//
// The daemon's real poll (DaemonEngine._applyProcessingFromKv) runs against a fake station_config_kv that
// answers ONLY for the station_id it is asked about; the engine calls are recorded. Three receipts:
//   1. a band change on station N reaches station N's engine (and nothing reaches station 1);
//   2. a fresh engine (a daemon respawn / app restart) RE-APPLIES the stored bands on its first poll, with
//      processing OFF — the EQ is not gated on the loudness processor;
//   3. the stored rack document wins over the legacy key, and the legacy seed is used when there is none.
// Plus the static half: nothing on the renderer→main EQ path may fall back to station 1 any more.
"use strict";
const fs = require("fs");
const path = require("path");
const { DaemonEngine } = require(path.join(__dirname, "engine.js"));
const A = require(path.join(__dirname, "..", "native", "ether-audio.node"));

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  OK   ${m}`); };
const bad = (m) => { fail++; console.log(`  FAIL ${m}`); };
const check = (cond, m, detail) => cond ? ok(m) : bad(m + (detail ? `\n         ${detail}` : ""));

// ── the engine calls, recorded (the real addon's functions are replaced for this process only) ──────────
const calls = [];
A.audioSetMasterRack = (sid, json) => { calls.push({ fn: "rack", sid, doc: JSON.parse(json) }); return JSON.stringify({ ok: true }); };
A.audioSetProcessing = (sid, local, stream, target) => { calls.push({ fn: "power", sid, local, stream, target }); return true; };
A.audioSetEq = (sid) => { calls.push({ fn: "legacy-eq", sid }); return true; };

// ── a fake station_config_kv: rows per station; the query's station_id parameter picks them ────────────
const kv = { 1: {}, 4: {} };
const db = {
  prepare(sql) {
    return {
      all(stationId) {
        if (!/WHERE station_id=\?/.test(sql)) throw new Error("the rack poll must select by station_id");
        return Object.entries(kv[stationId] || {}).map(([key, value]) => ({ key, value }));
      },
    };
  },
};
const mk = (sid) => { const e = new DaemonEngine(sid, db, () => {}); e._log = () => {}; return e; };
const geqOfCall = (c) => c.doc.sections.pgm.find(s => s.module && s.module.type === "geq");
const BANDS_1 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const BANDS_4 = [3, 2, 0, 0, 0, -2, 0, 0, 1, 0];
const BANDS_4B = [0, 0, 0, 0, 0, 0, 0, 4, 4, 4];
kv[1].eq_master = JSON.stringify(BANDS_1);
kv[4].eq_master = JSON.stringify(BANDS_4);

console.log("\n1 - a band change on station 4 reaches station 4's engine, and only station 4's");
{
  const e4 = mk(4);
  calls.length = 0;
  e4._applyProcessingFromKv(10_000);
  const rack = calls.filter(c => c.fn === "rack");
  check(rack.length === 1 && rack[0].sid === 4, "the first poll delivers the rack to station 4's engine", JSON.stringify(rack.map(c => c.sid)));
  check(JSON.stringify(geqOfCall(rack[0]).module.bands) === JSON.stringify(BANDS_4), "…carrying station 4's stored bands, not station 1's");
  check(!calls.some(c => c.sid === 1), "nothing was sent to station 1");
  kv[4].eq_master = JSON.stringify(BANDS_4B);                // the operator moves a band on station 4
  calls.length = 0;
  e4._applyProcessingFromKv(10_000 + 3_001);
  const r2 = calls.filter(c => c.fn === "rack");
  check(r2.length === 1 && r2[0].sid === 4 && JSON.stringify(geqOfCall(r2[0]).module.bands) === JSON.stringify(BANDS_4B),
        "the band change lands on station 4's engine within one poll (3 s)");
}

console.log("\n2 - an engine that starts (daemon respawn / app restart) re-applies the stored EQ, processing OFF");
{
  // proc_local / proc_stream are unset → processing is OFF. Before slice 4 nothing applied the EQ at start.
  const fresh = mk(4);
  calls.length = 0;
  fresh._applyProcessingFromKv(50_000);
  const rack = calls.filter(c => c.fn === "rack" && c.sid === 4);
  check(rack.length === 1 && JSON.stringify(geqOfCall(rack[0]).module.bands) === JSON.stringify(BANDS_4B),
        "a fresh engine's first poll delivers station 4's stored bands");
  check(calls.some(c => c.fn === "power" && c.sid === 4 && c.local === false && c.stream === false), "…with processing off (the EQ is not gated on the processor)");
  calls.length = 0;
  fresh._applyProcessingFromKv(50_000 + 16_000);
  check(calls.some(c => c.fn === "rack" && c.sid === 4), "a non-flat EQ is re-asserted every 15 s, as the processor always was");
}

console.log("\n3 - the stored rack document wins over the legacy key; with none, the legacy keys seed it");
{
  kv[4].rack_master = JSON.stringify({ v: 1, link: true, sections: {
    pgm: [{ id: "s-geq", module: { type: "geq", bands: BANDS_1 }, in: false }],
    local: [{ id: "s-ride", module: { type: "ride", target: -23, rate: 1.5, clamp: 12 }, in: true },
            { id: "s-lim", module: { type: "limiter", ceiling: -1, release: 120 }, in: true }],
    stream: [] } });
  const e = mk(4);
  calls.length = 0;
  e._applyProcessingFromKv(90_000);
  const r = calls.find(c => c.fn === "rack");
  check(!!r && geqOfCall(r).in === false && r.doc.sections.local[0].module.target === -23, "rack_master is what the engine gets (GEQ OUT, target −23)");
  delete kv[4].rack_master;
  kv[4].proc_target_lufs = "-16";
  const e2 = mk(4);
  calls.length = 0;
  e2._applyProcessingFromKv(95_000);
  const r2 = calls.find(c => c.fn === "rack");
  check(!!r2 && r2.doc.sections.local[0].module.target === -16 && r2.doc.link === true, "no rack_master → seeded from proc_target_lufs (−16), linked");
}

console.log("\n4 - static: nothing on the renderer → main EQ path falls back to station 1");
{
  const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.js"), "utf8");
  const h = main.slice(main.indexOf('ipcMain.handle("audio:setEq"'), main.indexOf('ipcMain.handle("audio:setEq"') + 900);
  check(!/stationId\s*\?\?\s*1/.test(h), "audio:setEq has no `stationId ?? 1` fallback");
  check(/return \{ ok: false, reason: "no station" \}/.test(h), "audio:setEq refuses a call that names no station");
  const mo = fs.readFileSync(path.join(__dirname, "..", "src", "components", "MasterOutput.tsx"), "utf8");
  check(/WHERE station_id = \? AND key = 'eq_master'/.test(mo), "the Master Out EQ reads THIS station's eq_master");
  check(/setEq\("master", bands, stationId\)/.test(mo), "the Master Out EQ sends its station");
}

console.log("\n5 - write-back: a rack write also writes the keys an older daemon / install reads (ruling 3)");
{
  const RackSeed = require(path.join(__dirname, "rack-seed.js"));
  const doc = { v: 1, link: false, sections: {
    pgm: [{ id: "s-geq", module: { type: "geq", bands: BANDS_4 }, in: true }],
    local: [{ id: "s-ride", module: { type: "ride", target: -23, rate: 2, clamp: 9 }, in: true },
            { id: "s-lim", module: { type: "limiter", ceiling: -1.5, release: 200 }, in: true }],
    stream: [{ id: "s-ride", module: { type: "ride", target: -16, rate: 1.5, clamp: 12 }, in: true },
             { id: "s-lim", module: { type: "limiter", ceiling: -2, release: 120 }, in: true }] } };
  const w = Object.fromEntries(RackSeed.legacyWrites(doc));
  check(w.proc_target_lufs === "-23" && w.proc_ride_rate === "2" && w.proc_ride_clamp === "9" && w.proc_ceiling_dbtp === "-1.5" && w.proc_release_ms === "200",
        "the monitor's ride/limiter → proc_target_lufs / proc_ride_* / proc_ceiling_dbtp / proc_release_ms");
  check(w.proc_split === "1" && w.proc_stream_target_lufs === "-16" && w.proc_stream_ceiling_dbtp === "-2", "split → proc_split=1 and the proc_stream_* set");
  check(w.eq_master === JSON.stringify(BANDS_4), "the GEQ's bands → eq_master");
  const seeded = RackSeed.seedMasterRack((k) => w[k]).doc;
  check(JSON.stringify(RackSeed.branchParams(seeded, "local")) === JSON.stringify(RackSeed.branchParams(doc, "local"))
        && JSON.stringify(RackSeed.branchParams(seeded, "stream")) === JSON.stringify(RackSeed.branchParams(doc, "stream")),
        "round trip: the written-back keys seed the same ride/limiter numbers");
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
