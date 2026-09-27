// smoke-pfl.js — PFL for every channel (Jeff's PFL rulings, 2026-09-26; docs/help-channel-faders.md).
// No audio, no device, no DB file.
//
//   node audiod/smoke-pfl.js
//
// 1. The daemon's real poll delivers THIS station's `pfl_dim_db` to THIS station's engine, and re-applies it to
//    a fresh engine; unset → nothing sent (the engine keeps its default, which Preferences shows).
// 2. Static: every engine strip on the board sends PFL to the engine; the lamp follows the engine's echo on the
//    meters frame; the echo is forwarded by the daemon; main has the IPC; the dim is a Preferences setting.
"use strict";
const fs = require("fs");
const path = require("path");
const { DaemonEngine } = require(path.join(__dirname, "engine.js"));
const A = require(path.join(__dirname, "..", "native", "ether-audio.node"));

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  OK   ${m}`); };
const bad = (m) => { fail++; console.log(`  FAIL ${m}`); };
const check = (cond, m, detail) => cond ? ok(m) : bad(m + (detail ? `\n         ${detail}` : ""));

const calls = [];
A.audioSetPflDim = (sid, db) => { calls.push({ sid, db }); return true; };
const kv = { 1: {}, 4: {} };
const db = {
  prepare(sql) {
    return {
      get(stationId) {
        if (!/WHERE station_id=\?/.test(sql)) throw new Error("the PFL dim poll must select by station_id");
        const m = /key='([a-z_]+)'/.exec(sql);
        const v = m ? kv[stationId][m[1]] : undefined;
        return v === undefined ? undefined : { value: v };
      },
      all() { return []; },
    };
  },
};
const mk = (sid) => { const e = new DaemonEngine(sid, db, () => {}); e._log = () => {}; return e; };

console.log("\n1 - the station's PFL dim reaches THIS station's engine, and every fresh engine");
{
  const e4 = mk(4);
  e4._applyPflDimFromKv(10_000);
  check(calls.length === 0, "unset → nothing sent (the engine keeps −12 dB, which Preferences shows)");
  kv[4].pfl_dim_db = "-20"; kv[1].pfl_dim_db = "-3";
  e4._applyPflDimFromKv(13_001);
  check(calls.length === 1 && calls[0].sid === 4 && calls[0].db === -20, "station 4's −20 dB goes to station 4 only", JSON.stringify(calls));
  calls.length = 0;
  e4._applyPflDimFromKv(16_002);
  check(calls.length === 0, "unchanged → not re-sent");
  kv[4].pfl_dim_db = "-99";
  e4._applyPflDimFromKv(19_003);
  check(calls.length === 1 && calls[0].db === -60, "clamped to the setting's range (−60 dB)");
  calls.length = 0;
  mk(4)._applyPflDimFromKv(50_000);
  check(calls.length === 1 && calls[0].sid === 4, "a fresh engine (respawn / restart) gets the stored dim");
}

console.log("\n2 - static: every engine strip sends PFL to the engine, and its lamp is the engine's echo");
{
  const src = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  const fader = src("src/components/FaderSection.tsx");
  check((fader.match(/onPfl=\{pflFor\(slot\)\}/g) || []).length === 3, "FaderSection passes onPfl to the source channels, A/B/C and the lettered strips");
  check(/setPfl\?\.\(stationId, slot, on\)/.test(fader), "…which asks the ENGINE (audio.setPfl with the station)");
  const strip = src("src/components/ConsoleStrip.tsx");
  check(/latestMeters\(stationUuid\)/.test(strip) && /m\.pfl >> slotIndex/.test(strip), "the strip's PFL lamp reads the engine's echo (meters `pfl`)");
  const daemon = src("audiod/ether-audiod.js");
  check(/pfl: mt\.pfl/.test(daemon), "the daemon forwards the echo on the meters event");
  const main = src("electron/main.js");
  check(/ipcMain\.handle\("audio:set-pfl"/.test(main) && /ipcMain\.handle\("audio:set-pfl-dim"/.test(main), "main has audio:set-pfl and audio:set-pfl-dim");
  const prefs = src("src/components/SettingsPanel.tsx");
  check(/<PflSettings \/>/.test(prefs), "the dim is a Preferences → Audio setting");
  const lib = src("native/src/lib.rs");
  check(/"pfl": p\.pfl/.test(lib), "the engine echoes the flags it RAN with (from the published Params)");
  check(fs.readFileSync(path.join(__dirname, "..", "docs", "help-channel-faders.md"), "utf8").includes("## Listening to a channel off air (PFL)"), "help-channel-faders.md has the PFL section");
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
