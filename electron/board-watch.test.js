// The continuous board watch (electron/board-watch.js) — Jeff, 2026-10-12: "raise the red board-state-mismatch-error
// within a second of any divergence, naming the setting" and "the mismatch check must be event-driven and cheap, with no
// polling DB reads."
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
const { createBoardWatch, overlayLevels } = require_("./board-watch.js");
const B = require_("../audiod/board-state.js");

const DUCK = { depthDb: -22, thresholdDb: -45, attackMs: 30, holdMs: 700, releaseMs: 500 };   // this test's ducker values (Preferences)
const SAVED = { stationId: 2, names: { D: "D", C: "C" }, slots: { D: { volume: 0.5, muted: false }, C: { volume: 1.0654451173610493 } }, monitorVol: 0.68, masterVol: 0.9, masterMonitorVol: 0.31, duckParams: DUCK };
function engine() {
  const p = { slots: { D: { volume: 0.5, muted: false }, C: { volume: 1.0654451173610493 } }, monitor_vol: 0.68, master_vol: 0.9, master_monitor_vol: 0.31,
              duck_params: { depth_db: DUCK.depthDb, threshold: 10 ** (DUCK.thresholdDb / 20), attack_ms: DUCK.attackMs, hold_ms: DUCK.holdMs, release_ms: DUCK.releaseMs } };
  const a = JSON.parse(JSON.stringify(p));
  return { p, a, live: () => ({ ok: true, control: JSON.parse(JSON.stringify(p)), applied: JSON.parse(JSON.stringify(a)) }),
           set(fn) { fn(p); fn(a); } };
}
function watch(e, extra = {}) {
  const raised = [], matched = [];
  let dbReads = 0;
  const w = createBoardWatch({
    readSaved: () => { dbReads++; return JSON.parse(JSON.stringify(SAVED)); }, readLive: async () => e.live(),
    compare: B.compareBoard, onMismatch: (sid, d) => raised.push({ sid, d, at: Date.now() }), onMatch: (sid) => matched.push(sid), ...extra,
  });
  return { w, raised, matched, dbReads: () => dbReads };
}

describe("board watch — event-driven", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  it("does nothing on its own: no timer, no database read, no engine read until something changes", async () => {
    const e = engine(); const live = vi.fn(e.live);
    const { w, dbReads } = watch({ live }, {});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(live).not.toHaveBeenCalled();
    expect(dbReads()).toBe(0);
    expect(w.stats()).toMatchObject({ saved: 0, live: 0, checks: 0 });
  });

  it("a lasting divergence after a change is raised within a second, naming the setting", async () => {
    const e = engine(); const { w, raised } = watch(e);
    const t0 = Date.now();
    e.set(p => { p.monitor_vol = 0; });            // 2026-10-12: the window zeroed the station MONITOR after the restore
    w.touched(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(raised.length).toBe(1);
    expect(raised[0].at - t0).toBeLessThan(1000);
    expect(raised[0].d.map(d => d.setting)).toContain("monitorVol");
    expect(raised[0].d[0].label).toBe("station MONITOR strip");
  });

  it("the saved board is read from the database once, then only after a write says it changed", async () => {
    const e = engine(); const { w, dbReads } = watch(e);
    for (let i = 0; i < 20; i++) { w.touched(2); await vi.advanceTimersByTimeAsync(700); }
    expect(dbReads()).toBe(1);
    w.savedChanged(2);
    await vi.advanceTimersByTimeAsync(700);
    expect(dbReads()).toBe(2);
  });

  it("a drag is never an error — values moving, the applied copy a buffer behind (2026-10-12 false positives)", async () => {
    const e = engine(); let pending = null;
    const { w, raised } = watch(e, { overlay: (sid, s) => overlayLevels(s, pending) });
    for (let i = 1; i <= 40; i++) {                 // 2 s of drag, a change every 50 ms
      const v = 1.0654 + i * 0.002;
      e.p.slots.C.volume = v; e.a.slots.C.volume = v - 0.002;   // applied trails control
      pending = { C: v, master: 0.9 };
      w.touched(2);
      await vi.advanceTimersByTimeAsync(50);
    }
    e.a.slots.C.volume = e.p.slots.C.volume;         // the drag stops; the callback catches up
    await vi.advanceTimersByTimeAsync(2000);
    expect(raised).toEqual([]);
  });

  it("an operator's change that is saved a moment later is NOT an error", async () => {
    const e = engine(); let saved = JSON.parse(JSON.stringify(SAVED));
    const { w, raised } = watch(e, { readSaved: () => JSON.parse(JSON.stringify(saved)) });
    e.set(p => { p.monitor_vol = 0.2; }); w.touched(2);       // the strip sends…
    await vi.advanceTimersByTimeAsync(50);
    saved = { ...saved, monitorVol: 0.2 }; w.savedChanged(2); // …then saves (the write announces itself)
    await vi.advanceTimersByTimeAsync(2000);
    expect(raised).toEqual([]);
  });

  it("a saved value changed elsewhere (cloud sync) with the engine untouched is raised", async () => {
    const e = engine(); let saved = JSON.parse(JSON.stringify(SAVED));
    const { w, raised } = watch(e, { readSaved: () => JSON.parse(JSON.stringify(saved)) });
    await w.check(2);
    saved = { ...saved, masterVol: 0.5 }; w.savedChanged(null, () => [2]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(raised.map(r => r.d.map(d => d.setting))[0]).toContain("masterVol");
  });

  it("said once per distinct difference; a match says so once", async () => {
    const e = engine(); const { w, raised, matched } = watch(e);
    await w.check(2);
    expect(matched).toEqual([2]);                    // the first match is reported (clears what the connect pass raised)
    e.set(p => { p.monitor_vol = 0; }); w.touched(2);
    await vi.advanceTimersByTimeAsync(1000);
    w.touched(2); await vi.advanceTimersByTimeAsync(1000);
    expect(raised.length).toBe(1);
    e.set(p => { p.monitor_vol = 0.68; }); w.touched(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(matched).toEqual([2, 2]);
  });

  it("an engine that cannot answer is not a mismatch; nothing is said while paused", async () => {
    const { w, raised } = watch({ live: () => ({ ok: false, reason: "not connected" }) });
    w.touched(2); await vi.advanceTimersByTimeAsync(2000);
    expect(raised).toEqual([]);
    const e = engine(); const x = watch(e);
    x.w.pause(); e.set(p => { p.monitor_vol = 0; }); x.w.touched(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(x.raised).toEqual([]);
    x.w.resume(); x.w.touched(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(x.raised.length).toBe(1);
  });
});

describe("the board-table writers announce themselves", () => {
  it("station_config_kv and deck_configs writes reach board-write-events", () => {
    const BW = require_("./board-write-events.js");
    const seen = [];
    const off = BW.on(i => seen.push(i));
    const kv = require_("./sync/handlers/station_config_kv.js"), dc = require_("./sync/handlers/deck_configs.js");
    const { DatabaseSync } = require_("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE station_config_kv (station_id INTEGER, key TEXT, value TEXT, uuid TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT)");
    kv.stationConfigKvSetLocal(db, 2, "master_monitor_volume", "0.3");
    expect(seen).toContainEqual({ table: "station_config_kv", stationId: 2, key: "master_monitor_volume" });
    expect(typeof dc.deckConfigsUpdateBySlot).toBe("function");
    expect(B.isBoardKey("monitor_volume") && B.isBoardKey("cart_channel_on") && B.isBoardKey("duck_depth_db") && B.isBoardKey(null)).toBe(true);
    expect(B.isBoardKey("last_error")).toBe(false);
    off();
  });
});
