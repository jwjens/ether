// TODAY'S SEQUENCE, REPLAYED (Jeff, 2026-10-12): "simulate the exact sequence from today's log (engine restores, then the
// window attaches) and prove no station's level changes and no fader needs a nudge."
//
// docs/station-monitor-zeroed-at-attach-2026-10-12.md. The daemon log:
//   20:26:05.828Z [board s2] saved board applied (app connect): 43 setting(s)
//   20:26:06.325Z [engine s2] adopt: deck snapshot re-emitted (A/B/C) + automation state for a (re)attaching renderer
//   20:26:06.334Z [board s2] setMonitorVolume=0 → true          ← the window's attach-time zero
//
// 1. A station board saved as halloVeen's was (station MONITOR 0.68, MASTER, faders, AUX rows, jukebox, CART cut).
// 2. THE ENGINE RESTORES it — the real applier (audiod/board-state.js applyBoard) into an engine model that answers
//    getBoardState in the engine's own shape.
// 3. THE WINDOW ATTACHES — the real renderer engine (AudioEngine) runs its whole attach (detect → attachDaemonEvents →
//    adoptFromDaemon) against a bridge that routes every setter to that engine exactly as main does, recording each one.
// 4. Proven: the window wrote nothing; every live value equals the saved one (nothing needs a nudge); and the
//    continuous watch (electron/board-watch.js) sees no difference. The control case puts the OLD write back and the
//    watch names it within a second.
import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
const B = require_("../../audiod/board-state.js");
const { createBoardWatch } = require_("../../electron/board-watch.js");
const { DatabaseSync } = require_("node:sqlite");

const SID = 2;

function savedHalloveen() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE stations (id INTEGER PRIMARY KEY, deleted_at TEXT);
           CREATE TABLE deck_configs (station_id INTEGER, slot TEXT, type TEXT, kind TEXT, enabled INTEGER, channel_on INTEGER, duck INTEGER, duckable INTEGER, deleted_at TEXT);
           CREATE TABLE station_config_kv (station_id INTEGER, key TEXT, value TEXT, deleted_at TEXT);`);
  db.exec(`INSERT INTO stations (id) VALUES (1), (2), (3), (4), (9);`);
  const dc = db.prepare("INSERT INTO deck_configs VALUES (?, ?, ?, ?, 1, ?, ?, ?, NULL)");
  for (const sid of [1, 2, 3, 4, 9]) {
    for (const r of [["A", "music", "", 1, 0, 1], ["B", "music", "", 1, 0, 1], ["C", "music", "", 1, 0, 1],
                     ["D", "source", "announcement", 1, 1, 1], ["E", "source", "jukebox", 1, 0, 1], ["F", "source", "mic", 1, 1, 0]]) dc.run(sid, ...r);
  }
  const kv = db.prepare("INSERT INTO station_config_kv VALUES (?, ?, ?, NULL)");
  // halloVeen (2) as the 20:26 connect pass read it: station MONITOR 0.68. The others as on this box (0).
  for (const [sid, mon] of [[1, "0"], [2, "0.68"], [3, "0"], [4, "0"], [9, "0"]]) {
    kv.run(sid, "monitor_volume", mon);
    kv.run(sid, "master_monitor_volume", "0.2320675105485232");
    kv.run(sid, "board_levels", JSON.stringify({ A: 0.8, B: 0.8, C: 0.8, D: 0.7, E: 0.4, F: 1, master: 0.9 }));
    kv.run(sid, "aux_monitor_levels", JSON.stringify({ D: 0.82, E: 0.5, F: 0.6 }));
    kv.run(sid, "jukebox_channel_on", sid === 2 ? "1" : "0");
    kv.run(sid, "cart_channel_on", "0");
    kv.run(sid, "segue_overlap_sec", "3");
  }
  return db;
}

/** An engine: the board values it is running, set only through its setters, read back in getBoardState's shape. */
function engineModel() {
  const slots: Record<string, any> = {};
  const p: any = { monitor_vol: 1, master_vol: 1, master_monitor_vol: 0, slots };   // the Rust bus defaults
  const slot = (s: string) => (slots[s] ||= { volume: 1, muted: false, duck: false, duckable: true, aux_monitor_gain: 0, local: "main" });
  const devices: any = { aux: "", cue: "", output: null };
  const sink = {
    setVolume: (s: string, v: number) => { slot(s).volume = v; return true; },
    setMuted: (s: string, m: boolean) => { slot(s).muted = !!m; return true; },
    setDuck: (s: string, on: boolean) => { slot(s).duck = !!on; return true; },
    setDuckable: (s: string, on: boolean) => { slot(s).duckable = !!on; return true; },
    setAuxMonitor: (s: string, g: number) => { slot(s).aux_monitor_gain = g; return true; },
    setLocalOutput: (s: string, aux: boolean) => { slot(s).local = aux ? "aux" : "main"; return true; },
    setMonitorVolume: (v: number) => { p.monitor_vol = v; return true; },
    setMasterVolume: (v: number) => { p.master_vol = v; return true; },
    setMasterMonitorVolume: (v: number) => { p.master_monitor_vol = v; return true; },
    setDuckParams: () => true, setPflDim: () => true, setFaderSmoothing: () => true,
    setAuxDevice: (d: string) => { devices.aux = d; return true; },
    setCueDevice: (d: string) => { devices.cue = d; return true; },
    setOutputDevice: (d: string) => { devices.output = d; return true; },
    getOutputDevice: () => devices.output,
  };
  const live = () => ({ ok: true, control: JSON.parse(JSON.stringify(p)), applied: JSON.parse(JSON.stringify(p)), devices: { ...devices } });
  return { p, sink, live };
}

/** window.ether as main presents it: every setter goes to the station's engine (and is recorded); the rest answers. */
function bridge(engines: Record<number, ReturnType<typeof engineModel>>, writes: string[], rot: string[]) {
  const W = (name: string, fn: (...a: any[]) => any) => (...a: any[]) => { writes.push(`${name}(${JSON.stringify(a)})`); return fn(...a); };
  const audio: any = {
    daemonEnabled: async () => true,
    daemon: async (cmd: string, args: any) => {
      if (/^(set|apply|mute|duck)/i.test(cmd)) { writes.push(`daemon:${cmd}(${JSON.stringify(args)})`); return { ok: true }; }
      if (cmd === "getQueue") return [];
      if (cmd === "deck:snapshot") return { ok: true };
      if (cmd === "getEngineState") return { state: "live", started: false };
      return { ok: true };
    },
    setVolume: W("setVolume", (deck, v, sid) => engines[sid].sink.setVolume(deck, v)),
    setMuted: W("setMuted", (deck, m, sid) => engines[sid].sink.setMuted(deck, m)),
    setMonitorVolume: W("setMonitorVolume", (sid, v) => engines[sid].sink.setMonitorVolume(v)),
    setMasterVolume: W("setMasterVolume", (sid, v) => engines[sid].sink.setMasterVolume(v)),
    setMasterMonitorVolume: W("setMasterMonitorVolume", (v) => Object.values(engines).forEach(e => e.sink.setMasterMonitorVolume(v))),
    setDuckParams: W("setDuckParams", () => true), setDuck: W("setDuck", () => true), setOutputDevice: W("setOutputDevice", () => true),
    setAuxMonitor: W("setAuxMonitor", () => true), setAuxDevice: W("setAuxDevice", () => true), setMicInput: W("setMicInput", () => ({ ok: true })),
    getState: async () => ({}),
  };
  // Every other bridge method (event subscriptions, reads) answers harmlessly; any other SETTER is recorded as a write.
  const audioProxy = new Proxy(audio, {
    get(t, k: string) {
      if (k in t) return t[k];
      if (/^set/.test(k)) return (...a: any[]) => { writes.push(`${k}(${JSON.stringify(a)})`); return true; };
      return () => () => {};
    },
  });
  return { audio: audioProxy, fs: { logRotation: (m: string) => { rot.push(m); } } };
}

const waitFor = async (cond: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error("timed out"); await new Promise(r => setTimeout(r, 20)); }
};

describe("2026-10-12 sequence: the engine restores, then the window attaches", () => {
  let stops: (() => void)[] = [];
  afterEach(() => { stops.forEach(f => { try { f(); } catch {} }); stops = []; delete (globalThis as any).window; });

  it("no station's level changes, no fader needs a nudge, and the watch sees nothing", async () => {
    const db = savedHalloveen();
    const sids = [1, 2, 3, 4, 9];
    const engines: Record<number, ReturnType<typeof engineModel>> = {};
    // 1 · THE ENGINE RESTORES every station (daemon start / app connect).
    for (const sid of sids) {
      engines[sid] = engineModel();
      const r = B.applyBoard(B.readSavedBoard(db, sid), engines[sid].sink);
      expect(r.failed).toEqual([]);
    }
    const before = Object.fromEntries(sids.map(s => [s, JSON.stringify(engines[s].live())]));
    expect(engines[SID].p.monitor_vol).toBe(0.68);                          // halloVeen restored at its saved level
    expect(engines[SID].p.slots.CART.muted).toBe(true);                       // the CART cut, restored by the engine now

    // 2 · THE WINDOW ATTACHES — the real renderer engine, every station, its whole attach path.
    const writes: string[] = [], rot: string[] = [];
    (globalThis as any).window = { ether: bridge(engines, writes, rot) };
    const { AudioEngine } = await import("./engine-rodio");
    for (const sid of sids) {
      const e = new AudioEngine(sid);
      stops.push(() => e.stop());
      e.init();
    }
    await waitFor(() => rot.filter(m => m.includes("ADOPT")).length >= sids.length);
    await new Promise(r => setTimeout(r, 300));   // past the 0.5 s the old zero landed after the adopt began

    // 3 · PROVEN.
    expect(writes).toEqual([]);                                              // the window wrote nothing
    expect(rot.some(m => m.includes("monitor asserted"))).toBe(false);
    for (const sid of sids) {
      expect(JSON.stringify(engines[sid].live())).toBe(before[sid]);         // no station's level changed
      expect(B.compareBoard(B.readSavedBoard(db, sid), engines[sid].live())).toEqual([]);   // every value is the saved one
    }
    const raised: any[] = [];
    const watch = createBoardWatch({
      readSaved: (sid: number) => B.readSavedBoard(db, sid), readLive: async (sid: number) => engines[sid].live(),
      compare: B.compareBoard, onMismatch: (sid: number, d: any[]) => raised.push({ sid, d }), confirmMs: 50,
    });
    stops.push(() => watch.stop());
    for (const sid of sids) watch.touched(sid);
    await new Promise(r => setTimeout(r, 600));
    expect(raised).toEqual([]);
  }, 20000);

  it("CONTROL: the old attach-time zero is named by the watch within a second", async () => {
    const db = savedHalloveen();
    const eng = engineModel();
    B.applyBoard(B.readSavedBoard(db, SID), eng.sink);
    const raised: any[] = [];
    const watch = createBoardWatch({
      readSaved: (sid: number) => B.readSavedBoard(db, sid), readLive: async () => eng.live(),
      compare: B.compareBoard, onMismatch: (sid: number, d: any[]) => raised.push({ sid, d, at: Date.now() }),
    });
    stops.push(() => watch.stop());
    await watch.check(SID);
    const t0 = Date.now();
    eng.sink.setMonitorVolume(0);                 // what the window did at 20:26:06.334Z …
    watch.touched(SID);                           // … through main's _boardSend, which tells the watch
    await waitFor(() => raised.length > 0, 2000);
    expect(raised[0].at - t0).toBeLessThanOrEqual(1000);
    expect(raised[0].d.find((d: any) => d.setting === "monitorVol")).toMatchObject({ saved: 0.68, live: 0, label: "station MONITOR strip" });
  });
});
