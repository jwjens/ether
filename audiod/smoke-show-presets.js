// smoke-show-presets.js — SLICE 7: the BLADE's rules (docs/dsp-show-presets.md §5, "The blade").
// The real ShowBlade and store planner against a RECORDED engine (every audioApplyShow call is kept), plus static
// checks that the daemon and main are wired to them. The audio itself is proven in `npm run test:rust`
// (show_through_the_mixer: a Take leaves the live deck bit-identical, one Take = one buffer, restore nulls).
//
//   node audiod/smoke-show-presets.js
"use strict";
const fs = require("fs");
const path = require("path");
const S = require("./show-presets");

let pass = 0, fail = 0;
const check = (cond, m) => { if (cond) { pass++; console.log(`  OK   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };
const src = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

const UUID = "stn-uuid-1";
/** A recorded engine: deck status per rotation deck, the cut per D/E/F/CART, every show apply kept. */
function rig({ kv = {}, playing = ["A"] } = {}) {
  const calls = [], events = [], logs = [];
  const st = { A: "idle", B: "idle", C: "idle" };
  for (const d of playing) st[d] = "playing";
  const muted = { D: false, E: false, F: false, CART: false };
  const addon = {
    audioApplyShow: (sid, json) => { calls.push(JSON.parse(json)); return JSON.stringify({ ok: true }); },
    audioGetState: () => JSON.stringify({
      deckA: { status: st.A }, deckB: { status: st.B }, deckC: { status: st.C },
      deckD: { muted: muted.D }, deckE: { muted: muted.E }, deckF: { muted: muted.F }, deckCart: { muted: muted.CART },
    }),
  };
  const blade = new S.ShowBlade({ stationId: 1, addon, readKv: (k) => kv[k], emit: (e, p) => events.push({ e, p }), log: (...a) => logs.push(a.join(" ")) });
  return { blade, calls, events, logs, st, muted, kv };
}
const rack = (g) => ({ v: 1, sections: { ch: [{ module: { type: "peq", bands: [{ freq: 100, gain: 0, width: 1 }, { freq: 1000, gain: g, width: 1 }, { freq: 3000, gain: 0, width: 1 }, { freq: 8000, gain: 0, width: 1 }] }, in: true }] } });
function preset(name, extra = {}) {
  return {
    v: 1, name, stationUuid: UUID, savedAt: "2026-09-26T00:00:00Z",
    board: {
      channels: {
        A: { enabled: true, type: "music", fader: 0.6, on: true, duckable: true, rack: rack(3) },
        D: { enabled: true, type: "source", kind: "jukebox", fader: 0.4, on: true, duck: false, duckable: true, roomLevel: 0.5, rack: rack(-2) },
        S1: { enabled: true, type: "source", kind: "mic", fader: 0.9, on: true, duck: true, duckable: true, rack: rack(4) },
      },
      master: { fader: 0.8, monitorLevel: 0.7, duck: { depthDb: -9, thresholdDb: -40, attackMs: 20, holdMs: 300, releaseMs: 600 }, rack: S.flatPreset(UUID).board.master.rack },
      ...extra,
    },
  };
}
const applied = (events) => events.filter(x => x.e === "showapplied").map(x => x.p);

console.log("\nSLICE 7 — the blade: live = ON, pending until OFF, one engine call, the stores after");

// 1 · Take while A plays and S1 (a mic) is ON: A and S1 wait; D goes now with the master, in ONE engine call.
{
  const r = rig({ playing: ["A"] });
  r.blade.noteMuted("D", true);                          // D is OFF on the board
  const res = r.blade.take(preset("Morning"), UUID, ["A", "B", "C", "D", "S1"]);
  check(res.ok && r.calls.length === 1, `Take = ONE engine call (got ${r.calls.length})`);
  const c = r.calls[0] || { slots: {} };
  check(!("A" in c.slots) && !("S1" in c.slots) && "D" in c.slots, `the call leaves A (playing) and S1 (ON, a mic in a pause is still live) out; D (OFF) is in: ${Object.keys(c.slots).join(",")}`);
  check(c.master && c.master.fader === 0.8 && c.master.monitor === 0.7 && c.master.duck.depthDb === -9 && !!c.master.rack, "the master (fader, monitor, ducker, rack) lands with the Take");
  check(JSON.stringify(res.pending.sort()) === JSON.stringify(["A", "S1"]), `pending = A, S1 (got ${res.pending})`);
  const st = r.blade.state();
  check(st.current === "Morning" && st.pending.length === 2 && st.pending.every(p => p.show === "Morning"), "state() reads it back (a UI reload asks the blade, not its own memory)");
  const a0 = applied(r.events);
  check(a0.length === 1 && Object.keys(a0[0].stores.channels).join() === "D" && !!a0[0].stores.master, "the store write asked for covers D + master only — never a channel still waiting");

  // 2 · S1 goes OFF (the operator cuts it): S1's pending is sent for S1 only, once; its stores only then.
  r.blade.noteMuted("S1", true);
  check(r.calls.length === 2 && Object.keys(r.calls[1].slots).join() === "S1" && !r.calls[1].master, "S1 cut → ONE call for S1 alone (no master)");
  const a1 = applied(r.events);
  check(a1.length === 2 && Object.keys(a1[1].stores.channels).join() === "S1" && a1[1].shows.S1 === "Morning", "…and the store write for S1 is asked for only now");
  r.blade.noteMuted("S1", true);
  check(r.calls.length === 2, "a second cut sends nothing (applied once)");
  // A ends (the engine reports it; the station loop ticks): A applies alone.
  r.st.A = "ended";
  r.blade.tick();
  check(r.calls.length === 3 && Object.keys(r.calls[2].slots).join() === "A" && r.calls[2].slots.A.fader === 0.6, "A ends → the tick applies A alone at the preset's level");
  check(r.blade.state().pending.length === 0, "nothing left waiting");
  check(r.calls.every(c => !JSON.stringify(c).includes('"cut"')), "no engine call ever carries a cut (a Take never turns anything ON — and never needs to cut)");
}

// 3 · TAKE NOW forces a waiting channel at once.
{
  const r = rig({ playing: ["A"] });
  r.blade.take(preset("Night"), UUID, ["A", "B", "C"]);
  const n = r.calls.length;
  const f = r.blade.force("A");
  check(f.ok && r.calls.length === n + 1 && Object.keys(r.calls[n].slots).join() === "A", "TAKE NOW applies A immediately, alone");
  check(!r.blade.force("A").ok, "a second TAKE NOW has nothing to apply");
}

// 4 · Survives a daemon respawn: show_pending reloads; a slot no longer live applies at boot; faders restored.
{
  const r = rig({ playing: ["A"] });
  r.blade.noteMuted("D", true);
  r.blade.take(preset("Morning"), UUID, ["A", "B", "C", "D", "S1"]);
  const doc = r.events.filter(x => x.e === "showstate").pop().p.pendingDoc;
  const kv = { show_pending: JSON.stringify(doc), show_current: "Morning", board_levels: JSON.stringify({ A: 0.7, D: 0.4, S1: 0.3, master: 0.9 }) };
  const r2 = rig({ kv, playing: [] });                   // fresh daemon: nothing playing; S1 boots OPEN (ON)
  r2.blade.boot();
  check(r2.calls.length === 2, `boot = the faders restore + the pending that is no longer live (got ${r2.calls.length} calls)`);
  const restore = r2.calls[0] || { slots: {} };
  check(restore.slots.A.fader === 0.7 && restore.slots.S1.fader === 0.3 && restore.master.fader === 0.9 && Object.values(restore.slots).every(s => Object.keys(s).join() === "fader"), "board_levels restored as faders only (ruling 2)");
  check(r2.calls[1] && Object.keys(r2.calls[1].slots).join() === "A", "A (not playing after the restart) takes its pending at boot");
  const st = r2.blade.state();
  check(st.current === "Morning" && st.pending.length === 1 && st.pending[0].slot === "S1", "S1 (ON after the restart) is still waiting, and says for which show");
  r2.blade.boot();
  check(r2.calls.length === 2, "boot runs once per engine");
}

// 5 · A preset never touches a machine-local key.
{
  const kv = {
    audio_output_device: "Speakers (Realtek)", aux_monitor_device: "USB DAC", pfl_cue_device: "Headphones",
    mic_input_S1: JSON.stringify({ device: "Shure MV7", channel: 1, gainDb: 12 }),
    monitor_volume: "0.6", duck_depth_db: "-18", aux_monitor_levels: JSON.stringify({ D: 0.4 }),
    rack_ch_S1: JSON.stringify(rack(5)),
  };
  const deckConfigs = [
    { slot: "A", type: "music", enabled: 1, channel_on: 1, duck: 0, duckable: 1 },
    { slot: "D", type: "source", kind: "jukebox", enabled: 1, channel_on: 0, duck: 0, duckable: 1 },
    { slot: "S1", type: "source", kind: "mic", enabled: 1, channel_on: 1, duck: 1, duckable: 1 },
  ];
  const snap = S.snapshotBoard({ name: "Snap", stationUuid: UUID, deckConfigs, get: (k) => kv[k], levels: { A: 0.8, S1: 0.5, master: 0.95 } });
  const txt = JSON.stringify(snap);
  const leaked = ["audio_output_device", "aux_monitor_device", "pfl_cue_device", "mic_input", "Realtek", "USB DAC", "Headphones", "Shure", "gainDb"].filter(w => txt.includes(w));
  check(leaked.length === 0, `the snapshot carries no device, mic patch or mic gain (found: ${leaked.join(",") || "none"})`);
  check(snap.board.channels.S1.kind === "mic" && snap.board.channels.S1.fader === 0.5 && snap.board.channels.D.roomLevel === 0.4 && snap.board.master.monitorLevel === 0.6 && snap.board.master.duck.depthDb === -18,
        "…while it keeps what IS the show: S1 is a mic at 0.5, D's room level, the monitor, the ducker");
  // A stored preset carrying machine-local values: stripped with a log line; nothing of it reaches the engine or a store.
  const r = rig({ playing: [] });
  const dirty = preset("Dirty");
  dirty.board.channels.S1.mic_input = { device: "Shure MV7" };
  dirty.board.channels.D.device = "USB DAC";
  dirty.board.master.audio_output_device = "Speakers";
  dirty.board.master.procLocal = true;
  dirty.pfl_cue_device = "Headphones";
  const res = r.blade.take(dirty, UUID, ["A", "D", "S1"]);
  check(res.ok && res.stripped.length === 5 && r.logs.some(l => /stripped/.test(l)), `a preset carrying 5 machine-local values is stripped with a log line (${res.stripped.length})`);
  const all = JSON.stringify(r.calls) + JSON.stringify(applied(r.events));
  check(!/Shure|USB DAC|Speakers|Headphones|procLocal|device/.test(all), "none of it reaches the engine or the store request");
  // The planner main executes: every key it would write, over every applied part.
  const writes = applied(r.events).flatMap(a => S.planStoreWrites(a.stores, (k) => kv[k]).kv.map(([k]) => k));
  const deck = applied(r.events).flatMap(a => S.planStoreWrites(a.stores, (k) => kv[k]).deck.map(([, p]) => Object.keys(p))).flat();
  const kvMod = (() => { try { return require("../electron/sync/handlers/station_config_kv"); } catch { return null; } })();
  const isLocal = kvMod ? kvMod.isLocalOnlyKey : S.isMachineLocalKey;
  check(writes.length > 0 && writes.every(k => !isLocal(k)), `every store write is a synced station key, none machine-local (${[...new Set(writes)].join(", ")})`);
  check(!deck.includes("channel_on"), "no deck write touches channel_on (ruling 3)");
  check(kvMod ? kvMod.isLocalOnlyKey("show_pending") && !kvMod.isLocalOnlyKey("show_presets") && !kvMod.isLocalOnlyKey("show_current") && !kvMod.isLocalOnlyKey("board_levels") : false,
        "show_pending is LOCAL_ONLY; show_presets, show_current, board_levels sync (ruling 6)");
}

// 6 · UUID guard.
{
  const r = rig({ playing: [] });
  const p = preset("Theirs"); p.stationUuid = "someone-else";
  const res = r.blade.take(p, UUID, ["A"]);
  check(!res.ok && r.calls.length === 0 && /another station/.test(res.reason), "a preset for another station's UUID is refused, and the engine is never called");
}

// 7 · Flat (ruling 7).
{
  const f = S.flatPreset(UUID);
  const chans = Object.values(f.board.channels);
  check(chans.length === 12 && chans.every(c => c.fader === 1 && c.rack.sections.ch.length === 0), "Flat: 12 faders at unity, every channel rack empty");
  const secs = f.board.master.rack.sections;
  check(secs.local.some(s => s.module.type === "ride") && secs.local.some(s => s.module.type === "limiter") && secs.pgm[0].module.bands.every(b => b === 0),
        "Flat's master is the shipped chain (flat GEQ, ride + limiter kept — never a master without its limiter)");
  check(JSON.stringify(f.board.master.duck) === JSON.stringify(S.DUCK_DEFAULTS), "Flat's ducker is at main's defaults (-22 / -45 / 30 / 700 / 500)");
}

// 8 · The wiring.
{
  const d = src("audiod/ether-audiod.js");
  check(/setMuted:.*noteMuted/.test(d) && /stop:.*noteStopped/.test(d) && /setVolume:.*noteVolume/.test(d) && /setMasterVolume:.*noteMaster/.test(d), "the daemon passes every cut, stop, fader and master move through the blade");
  check(/init:.*b\.boot\(\)/.test(d) && /b\.tick\(\)/.test(d), "the blade boots with the engine and ticks on the station loop (a deck that ends inside the engine goes OFF there)");
  check(/showTake:/.test(d) && /showForce:/.test(d) && /showArm:/.test(d) && /showDisarm:/.test(d) && /showState:/.test(d), "the daemon answers take / force / arm / disarm / state");
  const m = src("electron/main.js");
  check(/planStoreWrites\(m\.stores/.test(m) && /stationConfigKvSetLocal\(getDb\(\), sid, "show_pending"/.test(m) && /"board_levels"/.test(m), "main writes the stores from the one planner, show_pending set-local, board_levels synced");
  check(/preset\.stationUuid !== uuid/.test(m), "main checks the preset's UUID before the blade does");
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
