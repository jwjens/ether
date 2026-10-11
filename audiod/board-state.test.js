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
  kv.run("duck_depth_db", "-18");
  kv.run("jukebox_channel_on", "0");
}
beforeEach(seed);

const recorder = (over = {}) => {
  const calls = [];
  const rec = (name) => (...a) => { calls.push([name, ...a]); return true; };
  const sink = Object.fromEntries(["setVolume", "setMuted", "setDuck", "setDuckable", "setAuxMonitor", "setMonitorVolume", "setMasterVolume",
    "setMasterMonitorVolume", "setDuckParams", "setAuxDevice", "setCueDevice", "setPflDim", "setOutputDevice"].map(n => [n, rec(n)]));
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
    expect(s.duckParams.depthDb).toBe(-18);
    expect(s.duckParams.releaseMs).toBe(500);          // unsaved → main's long-standing default
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
    expect(d).toContainEqual(expect.objectContaining({ setting: "S1.aux", saved: 0.74, live: 0, where: "control", label: "G AUX monitor row" }));
  });
  it("is silent when the engine holds the saved board (bar the slot-kind ruling)", () => {
    const saved = B.readSavedBoard(db, 2);
    const ok = live(b => { for (const p of [b.control, b.applied]) {
      for (const [s, e] of Object.entries(saved.slots)) {
        const l = p.slots[s];
        if (e.volume !== undefined) l.volume = e.volume; if (e.muted !== undefined) l.muted = e.muted;
        if (e.duck !== undefined) l.duck = e.duck; if (e.duckable !== undefined) l.duckable = e.duckable;
        if (e.aux !== undefined) l.aux_monitor_gain = e.aux;
        if (e.kind !== undefined) l.kind = e.kind === "jingle" || e.kind === "sweeper" ? "sweeper" : "source";
      } } });
    expect(B.compareBoard(saved, ok)).toEqual([]);
  });
  it("reports a Sweeper-kind channel the engine runs as Source (never sent — pending Jeff's ruling)", () => {
    const d = B.compareBoard(B.readSavedBoard(db, 2), live());
    expect(d.some(x => x.setting === "E.kind" && x.live === "source")).toBe(true);
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
