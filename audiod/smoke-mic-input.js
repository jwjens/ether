// smoke-mic-input.js — THE MIC AS AN ENGINE INPUT: the stored patch reaches THE RIGHT station's engine, on the
// right slot, and is re-applied when an engine starts. docs/dsp-mic-in-engine.md §4. No audio, no device, no DB file.
//
//   node audiod/smoke-mic-input.js
//
// The daemon's real poll (DaemonEngine._applyMicInputsFromKv) runs against a fake station_config_kv that answers
// ONLY for the station_id it is asked about; the engine calls are recorded. Plus the static half: the patch is
// machine-local, main stores it only after the engine took it, and it is written only through set-local.
"use strict";
const fs = require("fs");
const path = require("path");
const { DaemonEngine } = require(path.join(__dirname, "engine.js"));
const A = require(path.join(__dirname, "..", "native", "ether-audio.node"));
const MicInput = require(path.join(__dirname, "mic-input.js"));

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  OK   ${m}`); };
const bad = (m) => { fail++; console.log(`  FAIL ${m}`); };
const check = (cond, m, detail) => cond ? ok(m) : bad(m + (detail ? `\n         ${detail}` : ""));

const calls = [];
A.audioSetMicInput = (sid, slot, device, channel, gainDb) => {
  calls.push({ sid, slot, device, channel, gainDb });
  return JSON.stringify(device === "Refuse Me" ? { ok: false, reason: "test refusal" } : { ok: true });
};
// keep the other polls quiet
A.audioSetProcessing = () => true; A.audioSetMasterRack = () => JSON.stringify({ ok: true }); A.audioSetChannelRack = () => JSON.stringify({ ok: true });

const kv = { 1: {}, 4: {} };
const db = {
  prepare(sql) {
    return { all(stationId) {
      if (!/WHERE station_id=\?/.test(sql)) throw new Error("the mic poll must select by station_id");
      return Object.entries(kv[stationId] || {}).map(([key, value]) => ({ key, value }));
    } };
  },
};
const mk = (sid) => { const e = new DaemonEngine(sid, db, () => {}); e._log = () => {}; return e; };
const put = (sid, slot, p) => { kv[sid][MicInput.micKey(slot)] = MicInput.serializeMicInput(p); };

console.log("\n1 - a patch on station 4 reaches station 4's engine, on its slot, and only station 4's");
{
  put(4, "S1", { device: "Shure MV7", channel: 1, gainDb: 12 });
  put(1, "S2", { device: "Other Station Mic", channel: 2, gainDb: 0 });
  const e4 = mk(4);
  calls.length = 0;
  e4._applyMicInputsFromKv(10_000);
  check(calls.length === 1 && calls[0].sid === 4 && calls[0].slot === "S1", "the first poll patches S1 on station 4", JSON.stringify(calls));
  check(calls[0] && calls[0].device === "Shure MV7" && calls[0].channel === 1 && calls[0].gainDb === 12, "…with its device, input 1 and +12 dB");
  check(!calls.some(c => c.sid === 1 || c.device === "Other Station Mic"), "station 1's patch is not sent to station 4");
  calls.length = 0;
  e4._applyMicInputsFromKv(13_001);
  check(calls.length === 0, "nothing changed → nothing re-sent (the engine owns re-opening a lost device)");
  put(4, "S1", { device: "Shure MV7", channel: 1, gainDb: 20 });
  e4._applyMicInputsFromKv(16_002);
  check(calls.length === 1 && calls[0].gainDb === 20, "a gain change lands within one poll");
  calls.length = 0;
  kv[4][MicInput.micKey("S1")] = "";   // unpatched (mic:set stores an empty value)
  e4._applyMicInputsFromKv(19_003);
  check(calls.length === 1 && calls[0].slot === "S1" && calls[0].device === "", "an unpatch sends an empty device (the engine closes it and empties the slot)");
}

console.log("\n2 - a fresh engine (daemon respawn / restart) re-applies the stored patches");
{
  put(4, "E", { device: "Focusrite USB (2- 2i2)", channel: 2, gainDb: 30 });
  calls.length = 0;
  mk(4)._applyMicInputsFromKv(50_000);
  check(calls.length === 1 && calls[0].slot === "E" && calls[0].channel === 2, "the fresh engine patches E (input 2), and does not send the unpatched S1", JSON.stringify(calls));
}

console.log("\n3 - values are clamped and a refused patch is reported, not retried every 3 s");
{
  check(MicInput.parseMicInput(JSON.stringify({ device: "x", channel: 1, gainDb: 99 })).gainDb === 40, "+99 dB is stored as +40 (the ruling's range)");
  check(MicInput.parseMicInput(JSON.stringify({ device: "x", channel: 0, gainDb: -50 })).gainDb === -10, "−50 dB is stored as −10");
  check(MicInput.parseMicInput("not json") === null && MicInput.parseMicInput("") === null, "an unreadable or empty value is 'nothing patched'");
  put(4, "F", { device: "Refuse Me", channel: 1, gainDb: 0 });
  const e = mk(4);
  calls.length = 0;
  e._applyMicInputsFromKv(60_000);
  const n = calls.filter(c => c.slot === "F").length;
  e._applyMicInputsFromKv(63_001);
  check(n === 1 && calls.filter(c => c.slot === "F").length === 1, "the refused F patch was sent once, not every poll");
  check(!MicInput.MIC_SLOTS.includes("A") && !MicInput.MIC_SLOTS.includes("CART"), "A/B/C and CART are never mic slots");
}

console.log("\n4 - static: machine-local, engine first, set-local only");
{
  const kvSrc = fs.readFileSync(path.join(__dirname, "..", "electron", "sync", "handlers", "station_config_kv.js"), "utf8");
  check(/LOCAL_ONLY_PREFIXES = \[[^\]]*'mic_input_'/.test(kvSrc), "mic_input_ is a LOCAL_ONLY prefix (a device name never syncs)");
  check(/LOCAL_ONLY_KEYS = new Set\(\[[^\]]*'audio_output_device'/.test(kvSrc), "audio_output_device is local-only too (decision 6)");
  const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.js"), "utf8");
  const set = /ipcMain\.handle\("mic:set"[\s\S]*?\n\}\);/.exec(main);
  check(!!set && set[0].indexOf("setMicInput") < set[0].indexOf("stationConfigKvSetLocal"), "mic:set delivers to the engine BEFORE it stores");
  check(!!set && !/upsertByKey/.test(set[0]), "mic:set never uses upsertByKey (it would silently skip a local-only key)");
  const nat = fs.readFileSync(path.join(__dirname, "..", "native", "src", "lib.rs"), "utf8");
  check(/fn audio_set_mic_input[\s\S]{0,400}default_kind_for\(idx\) != audio::SlotKind::Source/.test(nat), "the engine refuses a mic on a rotation/sweeper slot");
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
