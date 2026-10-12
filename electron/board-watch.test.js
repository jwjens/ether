// The continuous board watch (electron/board-watch.js) — Jeff, 2026-10-12: "compare saved vs live engine values on every
// change the engine reports (and a periodic check), and raise the red board-state-mismatch-error within a second of any
// divergence, naming the setting."
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
const { createBoardWatch, overlayLevels } = require_("./board-watch.js");
const B = require_("../audiod/board-state.js");

// A saved board and an engine that answers getBoardState in the engine's own shape.
const SAVED = { stationId: 2, names: { D: "D" }, slots: { D: { volume: 0.5, muted: false } }, monitorVol: 0.68, masterVol: 0.9, masterMonitorVol: 0.31 };
function engine() {
  const p = { slots: { D: { volume: 0.5, muted: false } }, monitor_vol: 0.68, master_vol: 0.9, master_monitor_vol: 0.31 };
  return { p, live: () => ({ ok: true, control: JSON.parse(JSON.stringify(p)), applied: JSON.parse(JSON.stringify(p)) }) };
}
function watch(e, extra = {}) {
  const raised = [], matched = [];
  const w = createBoardWatch({
    stations: () => [2], readSaved: () => JSON.parse(JSON.stringify(SAVED)), readLive: async () => e.live(),
    compare: B.compareBoard, onMismatch: (sid, d) => raised.push({ sid, d, at: Date.now() }), onMatch: (sid) => matched.push(sid), ...extra,
  });
  return { w, raised, matched };
}

describe("board watch", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  it("a divergence nobody announced is raised within a second, naming the setting", async () => {
    const e = engine(); const { w, raised } = watch(e);
    w.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(raised).toEqual([]);
    const t0 = Date.now();
    e.p.monitor_vol = 0;                     // 2026-10-12: the window zeroed the station MONITOR after the restore
    await vi.advanceTimersByTimeAsync(1000);
    expect(raised.length).toBe(1);
    expect(raised[0].at - t0).toBeLessThanOrEqual(1000);
    expect(raised[0].d.map(d => d.setting)).toContain("monitorVol");
    expect(raised[0].d[0].label).toBe("station MONITOR strip");
    w.stop();
  });

  it("a poke after a change raises it in about confirmMs, not on the next beat", async () => {
    const e = engine(); const { w, raised } = watch(e, { periodMs: 60000 });
    await w.check(2);
    const t0 = Date.now();
    e.p.master_vol = 0.2;
    w.poke(2);
    await vi.advanceTimersByTimeAsync(400);
    expect(raised.length).toBe(1);
    expect(raised[0].at - t0).toBeLessThanOrEqual(400);
    expect(raised[0].d.map(d => d.setting)).toContain("masterVol");
  });

  it("an operator's change that is saved a moment later is NOT an error", async () => {
    const e = engine(); let saved = JSON.parse(JSON.stringify(SAVED));
    const { w, raised } = watch(e, { readSaved: () => JSON.parse(JSON.stringify(saved)) });
    w.start();
    await vi.advanceTimersByTimeAsync(600);
    e.p.monitor_vol = 0.2; w.poke(2);        // the strip sends…
    await vi.advanceTimersByTimeAsync(50);
    saved = { ...saved, monitorVol: 0.2 };    // …then saves
    await vi.advanceTimersByTimeAsync(2000);
    expect(raised).toEqual([]);
    w.stop();
  });

  it("a fader drag main has not written yet counts as saved (board_levels overlay)", async () => {
    const e = engine(); let pending = null;
    const { w, raised } = watch(e, { overlay: (sid, s) => overlayLevels(s, pending) });
    w.start();
    e.p.slots.D.volume = 0.9; pending = { D: 0.9, master: 0.9 };
    await vi.advanceTimersByTimeAsync(2000);
    expect(raised).toEqual([]);
    w.stop();
  });

  it("said once per distinct difference; a match says so once", async () => {
    const e = engine(); const { w, raised, matched } = watch(e);
    await w.check(2);                       // first match is reported (clears anything the connect pass raised)
    expect(matched).toEqual([2]);
    w.start();
    e.p.monitor_vol = 0;
    await vi.advanceTimersByTimeAsync(3000);
    expect(raised.length).toBe(1);
    e.p.master_vol = 0.1;                    // a second difference → a new event naming both
    await vi.advanceTimersByTimeAsync(1000);
    expect(raised.length).toBe(2);
    expect(raised[1].d.map(d => d.setting).sort()).toEqual(["masterVol", "masterVol", "monitorVol", "monitorVol"]);
    e.p.monitor_vol = 0.68; e.p.master_vol = 0.9;
    await vi.advanceTimersByTimeAsync(1000);
    expect(matched).toEqual([2, 2]);
    w.stop();
  });

  it("an engine that cannot answer is not a mismatch", async () => {
    const { w, raised } = watch({ live: () => ({ ok: false, reason: "not connected" }) });
    w.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(raised).toEqual([]);
    w.stop();
  });

  it("paused while the connect pass re-applies the board", async () => {
    const e = engine(); const { w, raised } = watch(e);
    w.start(); w.pause();
    e.p.monitor_vol = 0;
    await vi.advanceTimersByTimeAsync(3000);
    expect(raised).toEqual([]);
    w.resume();
    await vi.advanceTimersByTimeAsync(1000);
    expect(raised.length).toBe(1);
    w.stop();
  });
});
