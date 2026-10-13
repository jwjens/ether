// The saved board, applied by the one applier (audiod/board-state.js) — docs/board-state-on-connect-diagnosis-2026-10-11.md.
// A real SQLite database (in memory, the daemon's own driver) holding station 2's board as OVEVENTS had it.
import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const B = require_("./board-state.js");
const { DatabaseSync } = require_("node:sqlite");

let db;
function seed() {
  db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE stations (id INTEGER PRIMARY KEY, deleted_at TEXT);
           CREATE TABLE deck_configs (station_id INTEGER, slot TEXT, type TEXT, kind TEXT, enabled INTEGER, channel_on INTEGER, duck INTEGER, duckable INTEGER, deleted_at TEXT);
           CREATE TABLE station_config_kv (station_id INTEGER, key TEXT, value TEXT, deleted_at TEXT);`);
  db.exec(`INSERT INTO stations (id) VALUES (2); INSERT INTO stations (id, deleted_at) VALUES (5, '2026-01-01');`);
  const dc = db.prepare("INSERT INTO deck_configs VALUES (2, ?, ?, ?, ?, ?, ?, ?, NULL)");
  for (const r of [["A", "music", "", 1, 1, 0, 1], ["B", "music", "", 1, 1, 0, 1], ["C", "music", "", 1, 1, 0, 1],
                   ["D", "source", "announcement", 1, 1, 1, 1], ["E", "source", "jingle", 1, 1, 1, 1], ["F", "source", "link", 1, 0, 0, 1],
                   ["S1", "source", "cart", 1, 1, 1, 1], ["S2", "source", "mic", 0, 1, 0, 1], ["S3", "source", "jukebox", 1, 1, 0, 1]]) dc.run(...r);
  const kv = db.prepare("INSERT INTO station_config_kv VALUES (2, ?, ?, NULL)");
  kv.run("aux_monitor_levels", JSON.stringify({ D: 0.82, E: 0.83, S1: 0.74, F: 0.56, S2: 1 }));
  kv.run("board_levels", JSON.stringify({ E: 0.15270909928001813, B: 0.0013, D: 1, C: 0, master: 0.9 }));
  kv.run("monitor_volume", "0.73");
  kv.run("master_monitor_volume", "0.4641");
  kv.run("aux_monitor_device", "Speakers (2- Realtek(R) Audio)");
  kv.run("audio_output_device", "Speakers (2- Realtek(R) Audio)");
  kv.run("duck_depth_db", "-18");                   // the ducker, all five values in Preferences (the only source, 2026-10-13)
  kv.run("duck_threshold_db", "-40");
  kv.run("duck_attack_ms", "12");
  kv.run("duck_hold_ms", "900");
  kv.run("duck_release_ms", "650");
  kv.run("jukebox_channel_on", "0");
}
beforeEach(seed);

const recorder = (over = {}) => {
  const calls = [];
  const rec = (name) => (...a) => { calls.push([name, ...a]); return true; };
  const sink = Object.fromEntries(["setVolume", "setMuted", "setDuck", "setDuckable", "setAuxMonitor", "setMonitorVolume", "setMasterVolume",
    "setMasterMonitorVolume", "setDuckParams", "setAuxDevice", "setCueDevice", "setPflDim", "setOutputDevice", "setLocalOutput", "setFaderSmoothing"].map(n => [n, rec(n)]));
  return { calls, sink: { ...sink, getOutputDevice: () => null, ...over } };
};

describe("readSavedBoard", () => {
  it("reads every saved value for the station, inventing nothing", () => {
    const s = B.readSavedBoard(db, 2);
    expect(s.slots.S1.aux).toBeCloseTo(0.74);
    expect(s.slots.E.aux).toBeCloseTo(0.83);
    expect(s.slots.E.volume).toBeCloseTo(0.1527, 3);
    expect(s.slots.A.volume).toBeUndefined();          // never saved → absent (the engine default stands)
    expect(s.slots.F.muted).toBe(true);                // channel_on 0
    expect(s.slots.S1.muted).toBe(false);
    expect(s.slots.S3.muted).toBe(true);               // the jukebox keeps its own cut (jukebox_channel_on 0)
    expect(s.slots.S2).toBeUndefined();                // disabled channel
    expect(s.monitorVol).toBeCloseTo(0.73);
    expect(s.masterMonitorVol).toBeCloseTo(0.4641);
    expect(s.masterVol).toBeCloseTo(0.9);
    expect(s.duckParams).toEqual({ depthDb: -18, thresholdDb: -40, attackMs: 12, holdMs: 900, releaseMs: 650 });   // exactly Preferences
  });

  it("migrates the legacy positional room-level array exactly", () => {
    db.prepare("UPDATE station_config_kv SET value=? WHERE key='aux_monitor_levels'").run(JSON.stringify([0.5, 0.25]));
    db.prepare("INSERT INTO station_config_kv VALUES (2, 'aux_monitor_slots', ?, NULL)").run(JSON.stringify(["S1", "D"]));
    const s = B.readSavedBoard(db, 2);
    expect(s.slots.S1.aux).toBe(0.5);
    expect(s.slots.D.aux).toBe(0.25);
    expect(s.slots.E.aux).toBe(0);
  });

  it("lists only stations that exist", () => {
    expect(B.listStations(db)).toEqual([2]);
  });
});

describe("applyBoard", () => {
  it("sends every saved value — AUX rows, faders, cuts, MONITOR — and never the slot kind", () => {
    const { calls, sink } = recorder();
    const r = B.applyBoard(B.readSavedBoard(db, 2), sink);
    expect(r.failed).toEqual([]);
    expect(calls).toContainEqual(["setAuxMonitor", "S1", 0.74]);
    expect(calls).toContainEqual(["setAuxMonitor", "E", 0.83]);
    expect(calls.find(c => c[0] === "setVolume" && c[1] === "E")[2]).toBeCloseTo(0.1527, 3);
    expect(calls).toContainEqual(["setMuted", "F", true]);
    expect(calls).toContainEqual(["setMonitorVolume", 0.73]);
    expect(calls).toContainEqual(["setMasterMonitorVolume", 0.4641]);
    expect(calls).toContainEqual(["setAuxDevice", "Speakers (2- Realtek(R) Audio)"]);
    expect(calls.some(c => c[0] === "setSlotKind")).toBe(false);
  });

  it("switches the output device only when the engine is not already on it (a reopen is a gap on air)", () => {
    const same = recorder({ getOutputDevice: () => "Speakers (2- Realtek(R) Audio)" });
    B.applyBoard(B.readSavedBoard(db, 2), same.sink);
    expect(same.calls.some(c => c[0] === "setOutputDevice")).toBe(false);
    const other = recorder({ getOutputDevice: () => null });
    B.applyBoard(B.readSavedBoard(db, 2), other.sink);
    expect(other.calls).toContainEqual(["setOutputDevice", "Speakers (2- Realtek(R) Audio)"]);
  });

  it("reports every refusal and throw — nothing swallowed", () => {
    const { sink } = recorder({ setAuxMonitor: () => false, setMuted: () => { throw new Error("engine gone"); } });
    const r = B.applyBoard(B.readSavedBoard(db, 2), sink);
    expect(r.failed.some(f => f.setting === "S1.aux" && /refused/.test(f.reason))).toBe(true);
    expect(r.failed.some(f => f.setting === "F.muted" && /engine gone/.test(f.reason))).toBe(true);
  });

  it("fallback mode: the native addon gets each setter with its own argument order", () => {
    const calls = [];
    const A = new Proxy({}, { get: (_, k) => (k === "audioGetBoardState" ? () => JSON.stringify({ ok: true, devices: { output: null } }) : (...a) => { calls.push([k, ...a]); return true; }), has: () => true });
    const r = B.applySavedBoardState(db, A, 2);
    expect(r.failed).toEqual([]);
    expect(calls).toContainEqual(["audioSetAuxMonitor", 2, "S1", 0.74]);   // (station, deck, gain)
    expect(calls.find(c => c[0] === "audioSetVolume" && c[1] === "E").slice(2)).toEqual([0.15270909928001813, 2]);   // (deck, vol, station)
    expect(calls).toContainEqual(["audioSetMuted", "F", true, 2]);
    expect(calls).toContainEqual(["audioSetMasterMonitorVolume", 2, 0.4641]);
  });
});

describe("routing: faders are generic, and the update moves nothing", () => {
  const routingOf = (d) => Object.fromEntries(Object.entries(B.readSavedBoard(d, 2).slots).map(([s, e]) => [s, [e.local, e.duck, e.duckable]]));
  it("before migration every fader reads as the engine has always run it", () => {
    const r = routingOf(db);
    expect(r.A).toEqual(["main", false, true]);   // a music fader: main output, never ducks, ducked
    expect(r.D).toEqual(["aux", true, false]);    // a source fader: AUX, ducks per its toggle, never ducked
    expect(r.F).toEqual(["aux", false, false]);
  });
  it("the migration writes exactly that into each fader's own settings — and reads back identically", () => {
    const before = routingOf(db);
    const writes = B.routingMigration(db, 2);
    // source rows stored duckable=1 that never acted → 0; nothing else needed
    expect(writes.filter(w => w.table === "deck_configs").map(w => [w.slot, w.patch])).toEqual(
      [["D", { duckable: 0 }], ["E", { duckable: 0 }], ["F", { duckable: 0 }], ["S1", { duckable: 0 }], ["S2", { duckable: 0 }], ["S3", { duckable: 0 }]]);   // S2 disabled — migrated too, so re-enabling it moves nothing
    for (const w of writes) {
      if (w.table === "deck_configs") for (const [k, v] of Object.entries(w.patch)) db.prepare(`UPDATE deck_configs SET ${k} = ? WHERE station_id = 2 AND slot = ?`).run(v, w.slot);
      else db.prepare("INSERT INTO station_config_kv VALUES (2, ?, ?, NULL)").run(w.key, w.value);
    }
    expect(routingOf(db)).toEqual(before);        // NOTHING moves at the update
    expect(B.routingMigration(db, 2)).toEqual([]); // once
  });
  it("after migration a fader's settings are its own — a music fader can be put on AUX and made to duck", () => {
    for (const w of B.routingMigration(db, 2)) {
      if (w.table === "deck_configs") for (const [k, v] of Object.entries(w.patch)) db.prepare(`UPDATE deck_configs SET ${k} = ? WHERE station_id = 2 AND slot = ?`).run(v, w.slot);
      else db.prepare("INSERT INTO station_config_kv VALUES (2, ?, ?, NULL)").run(w.key, w.value);
    }
    db.prepare("UPDATE station_config_kv SET value = ? WHERE station_id = 2 AND key = 'fader_local'").run(JSON.stringify({ A: "aux" }));
    db.prepare("UPDATE deck_configs SET duck = 1 WHERE station_id = 2 AND slot = 'A'").run();
    expect(routingOf(db).A).toEqual(["aux", true, true]);
  });
  it("sends local output and smoothing for every fader", () => {
    const { calls, sink } = recorder();
    B.applyBoard(B.readSavedBoard(db, 2), sink);
    expect(calls).toContainEqual(["setLocalOutput", "A", false]);
    expect(calls).toContainEqual(["setLocalOutput", "D", true]);
    expect(calls).toContainEqual(["setFaderSmoothing", 20]);
    expect(B.readSavedBoard(db, 2).loudnessTargetLufs).toBe(-16);
  });
});

describe("master MONITOR: silent until known (Jeff, 2026-10-11)", () => {
  it("unknown anywhere → 0 (silent), sent FIRST, before any other setting", () => {
    db.prepare("DELETE FROM station_config_kv WHERE key = 'master_monitor_volume'").run();
    const saved = B.readSavedBoard(db, 2);
    expect(saved.masterMonitorKnown).toBe(false);
    expect(saved.masterMonitorVol).toBe(0);
    const { calls, sink } = recorder();
    B.applyBoard(saved, sink);
    expect(calls[0]).toEqual(["setMasterMonitorVolume", 0]);
  });
  it("known on another station → that level (MONITOR is one level for the machine)", () => {
    db.prepare("DELETE FROM station_config_kv WHERE key = 'master_monitor_volume'").run();
    db.prepare("INSERT INTO station_config_kv VALUES (7, 'master_monitor_volume', '0.4641', NULL)").run();
    const saved = B.readSavedBoard(db, 2);
    expect(saved.masterMonitorKnown).toBe(true);
    expect(saved.masterMonitorVol).toBeCloseTo(0.4641, 9);
  });
  it("known on this station → applied first", () => {
    const { calls, sink } = recorder();
    B.applyBoard(B.readSavedBoard(db, 2), sink);
    expect(calls[0]).toEqual(["setMasterMonitorVolume", 0.4641]);
  });
});

describe("fader group tops (Jeff, 2026-10-11)", () => {
  it("defaults: channel +10, AUX rows +10, MASTER 0, MONITOR 0", () => {
    expect(B.readSavedBoard(db, 2).faderTopDb).toEqual({ channel: 10, aux: 10, master: 0, monitor: 0 });
  });
  it("a restored level is held at its group's top — and never raised", () => {
    db.prepare("UPDATE station_config_kv SET value = ? WHERE station_id = 2 AND key = 'board_levels'").run(JSON.stringify({ E: 2.0, master: 1.0 }));
    db.prepare("INSERT INTO station_config_kv VALUES (2, 'fader_top_db_channel', '3', NULL)").run();
    const s = B.readSavedBoard(db, 2);
    expect(s.slots.E.volume).toBeCloseTo(Math.pow(10, 3 / 20), 9);   // 2.0 (+6 dB) held at the +3 dB top
    expect(s.masterVol).toBeCloseTo(1, 12);                          // MASTER 0 dB at a 0 dB top: unchanged
    expect(s.slots.D.aux).toBeCloseTo(0.82, 9);                      // under its top: untouched
    expect(B.groupTopGain(db, 2, "channel")).toBeCloseTo(Math.pow(10, 3 / 20), 9);
    expect(B.groupTopGain(db, 2, "master")).toBeCloseTo(1, 12);
  });
});

describe("compareBoard", () => {
  const live = (mut) => {
    const slot = { volume: 1, muted: false, kind: "source", duck: true, duckable: true, aux_monitor_gain: 0, room_gain: 1, pfl: false };
    const p = { slots: Object.fromEntries(B.SLOTS.map(s => [s, { ...slot }])), monitor_vol: 0.73, master_vol: 0.9, master_monitor_vol: 0.4641 };
    const b = { ok: true, control: p, applied: JSON.parse(JSON.stringify(p)), devices: { output: "x", aux: "Speakers (2- Realtek(R) Audio)", cue: "" } };
    if (mut) mut(b);
    return b;
  };
  it("names the 2026-10-11 failure: S1's room row saved 0.74, live 0", () => {
    const d = B.compareBoard(B.readSavedBoard(db, 2), live());
    expect(d).toContainEqual(expect.objectContaining({ setting: "S1.aux", saved: 0.74, live: 0, where: "control", label: "G local row" }));
  });
  it("is silent when the engine holds the saved board", () => {
    const saved = B.readSavedBoard(db, 2);
    const ok = live(b => { for (const p of [b.control, b.applied]) {
      for (const [s, e] of Object.entries(saved.slots)) {
        const l = p.slots[s];
        if (e.volume !== undefined) l.volume = e.volume; if (e.muted !== undefined) l.muted = e.muted;
        if (e.duck !== undefined) l.duck = e.duck; if (e.duckable !== undefined) l.duckable = e.duckable;
        if (e.aux !== undefined) l.aux_monitor_gain = e.aux;
      }
      const d = saved.duckParams;
      b.control.duck_params = { depth_db: d.depthDb, threshold: 10 ** (d.thresholdDb / 20), attack_ms: d.attackMs, hold_ms: d.holdMs, release_ms: d.releaseMs };
    } });
    expect(B.compareBoard(saved, ok)).toEqual([]);
  });
  it("never reads, sends or flags a fader TYPE (Jeff: faders are generic shells)", () => {
    const saved = B.readSavedBoard(db, 2);
    expect(Object.values(saved.slots).some(e => "kind" in e)).toBe(false);
    const d = B.compareBoard(saved, live());
    expect(d.some(x => /kind/.test(x.setting))).toBe(false);
  });
  it("names faders as the board does — never an engine slot id", () => {
    expect(B.boardNames(["A", "B", "C", "D", "E", "F", "S1", "S2", "S3"]).S1).toBe("G");
    expect(B.boardNames(["A", "B", "C", "D", "E", "F", "S1", "S2", "S3"]).S5).toBe("K");
    expect(B.labelOf("masterMonitorVol")).toBe("MONITOR");
  });
  it("an engine that cannot answer is a mismatch, not a match", () => {
    expect(B.compareBoard(B.readSavedBoard(db, 2), { ok: false, reason: "no answer" })[0].setting).toBe("board");
  });
});

describe("the CART cut is part of the saved board (2026-10-12)", () => {
  beforeEach(seed);
  it("absent → not restored (the engine's own default stands)", () => {
    expect(B.readSavedBoard(db, 2).slots.CART).toBeUndefined();
  });
  it("cart_channel_on 0 → CART restored OFF; 1 → ON; applied through the engine's setter", () => {
    db.prepare("INSERT INTO station_config_kv VALUES (2, 'cart_channel_on', '0', NULL)").run();
    const s = B.readSavedBoard(db, 2);
    expect(s.slots.CART).toEqual({ muted: true });
    const calls = [];
    B.applyBoard(s, { setMuted: (slot, m) => { calls.push([slot, m]); return true; } });
    expect(calls).toContainEqual(["CART", true]);
    db.prepare("UPDATE station_config_kv SET value = '1' WHERE key = 'cart_channel_on'").run();
    expect(B.readSavedBoard(db, 2).slots.CART).toEqual({ muted: false });
  });
  it("a CART row of its own on the board wins (its ON lamp is the newer truth)", () => {
    db.prepare("INSERT INTO station_config_kv VALUES (2, 'cart_channel_on', '0', NULL)").run();
    db.prepare("INSERT INTO deck_configs VALUES (2, 'CART', 'source', '', 1, 1, 0, 1, NULL)").run();
    expect(B.readSavedBoard(db, 2).slots.CART.muted).toBe(false);
  });
  it("compared like any other cut", () => {
    db.prepare("INSERT INTO station_config_kv VALUES (2, 'cart_channel_on', '0', NULL)").run();
    const saved = B.readSavedBoard(db, 2);
    const d = B.compareBoard(saved, { ok: true, control: { slots: { CART: { muted: false } } } });
    expect(d.filter(x => x.setting.startsWith("CART")).map(x => [x.setting, x.label])).toEqual([["CART.muted", "CART ON/OFF"]]);
  });
});
