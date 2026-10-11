// Every board setter the engine receives is in the daemon log (audiod/board-log.js) — and a drag is not fifty lines.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { makeBoardLog } = require_("./board-log.js");

describe("board log", () => {
  it("logs a setter with station, fader, value and the engine's answer", () => {
    const lines = [];
    const note = makeBoardLog((l) => lines.push(l), { now: () => 0, setTimer: () => {} });
    note({ cmd: "setAuxMonitor", stationId: 2, deck: "S1", gain: 0.74 }, true);
    note({ cmd: "setMuted", stationId: 2, deck: "F", muted: true }, false);
    expect(lines).toEqual(["[board s2] setAuxMonitor S1=0.74 → true", "[board s2] setMuted F=true → false"]);
  });

  it("ignores commands that are not board setters", () => {
    const lines = [];
    const note = makeBoardLog((l) => lines.push(l));
    note({ cmd: "getLevels", stationId: 2 }, {});
    expect(lines).toEqual([]);
  });

  it("a drag logs its first value at once and its LAST value when it settles", () => {
    const lines = []; let t = 0; let pending = null;
    const note = makeBoardLog((l) => lines.push(l), { now: () => t, setTimer: (fn) => { pending = fn; } });
    for (const v of [0.1, 0.2, 0.3, 0.4]) { note({ cmd: "setVolume", stationId: 2, deck: "E", volume: v }, true); t += 50; }
    expect(lines).toEqual(["[board s2] setVolume E=0.1 → true"]);
    t += 1000; pending();
    expect(lines).toEqual(["[board s2] setVolume E=0.1 → true", "[board s2] setVolume E=0.4 → true"]);
  });
});
