// A dead AUX output must be LOUD (2026-10-04, OV). On 10/03 the aux stream lost its device and stayed dead for
// hours: carts metered, reported PLAYING and ducked the music while the room heard nothing, and the Health Monitor
// stayed GREEN. The native levels frame now carries aux_device / aux_state / aux_stalls (native/src/lib.rs);
// the monitor turns "an aux device is chosen but the stream is not open" into a RED with the device named, and
// writes every reopen and every outage to the ledger.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const { createHealthMonitor } = require_("./audio-health.js");

function monitor() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ether-health-aux-"));
  const h = createHealthMonitor({ logDir: dir, stationName: (id) => (id === 2 ? "halloVeen" : ""), uuidOf: (id) => `uuid-${id}` });
  return { h, dir };
}
const ledger = (dir) => {
  const p = path.join(dir, "health-events.jsonl");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
};
// A healthy, playing station, so that only the aux can make it anything other than GREEN.
let frames = 0;
const lv = (aux) => ({ frames_total: (frames += 44100), master: 0.5, active_decks: 1, decks: [], ...aux });
const station = (h) => h.getSnapshot().stations.find(x => x.stationId === 2);

afterEach(() => { vi.useRealTimers(); });

describe("audio-health: the aux output", () => {
  it("chosen and open → no aux fault", () => {
    const { h } = monitor();
    h.noteLevels(2, lv({ aux_device: "Speakers/Headphones (Realtek(R) Audio)", aux_state: "open", aux_open: true, aux_stalls: 0 }));
    const s = station(h);
    expect(s.auxFault).toBeFalsy();
  });

  it("no aux device chosen → not a fault (state 'none')", () => {
    const { h } = monitor();
    h.noteLevels(2, lv({ aux_device: "", aux_state: "none", aux_open: false, aux_stalls: 0 }));
    expect(station(h).auxFault).toBeFalsy();
  });

  it("chosen but not open past the grace period → RED naming the station's device, and a ledger line", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T18:50:00Z"));
    const { h, dir } = monitor();
    const dev = "Speakers/Headphones (Realtek(R) Audio)";
    h.noteLevels(2, lv({ aux_device: dev, aux_state: "not_found", aux_open: false, aux_stalls: 1 }));
    // A reopen in progress is not yet an outage.
    expect(station(h).auxFault).toBeFalsy();
    vi.setSystemTime(new Date("2026-10-03T18:50:08Z"));
    h.noteLevels(2, lv({ aux_device: dev, aux_state: "not_found", aux_open: false, aux_stalls: 1 }));
    const s = station(h);
    expect(s.auxFault).toMatchObject({ device: dev, state: "not_found" });
    h._evaluateNow();
    // The display holds a WORSE level 5 s before surfacing it (no flapping) — hold it.
    vi.setSystemTime(new Date("2026-10-03T18:50:14Z"));
    h.noteLevels(2, lv({ aux_device: dev, aux_state: "not_found", aux_open: false, aux_stalls: 1 }));
    h._evaluateNow();
    const s2 = station(h);
    expect(s2.level).toBe("RED");
    expect(s2.reason).toMatch(/aux output down/i);
    expect(s2.reason).toContain(dev);
    const ev = ledger(dir).find(l => l.type === "aux-down");
    expect(ev).toMatchObject({ type: "aux-down", stationId: 2, stationName: "halloVeen", device: dev, state: "not_found" });
  });

  it("every automatic reopen is written to the ledger (aux_stalls rising)", () => {
    const { h, dir } = monitor();
    const dev = "Speakers";
    h.noteLevels(2, lv({ aux_device: dev, aux_state: "open", aux_open: true, aux_stalls: 0 }));
    h.noteLevels(2, lv({ aux_device: dev, aux_state: "open", aux_open: true, aux_stalls: 1 }));
    const ev = ledger(dir).find(l => l.type === "aux-reopened");
    expect(ev).toMatchObject({ type: "aux-reopened", stationId: 2, device: dev, count: 1 });
  });

  it("recovery clears the fault and is written to the ledger", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T18:50:00Z"));
    const { h, dir } = monitor();
    h.noteLevels(2, lv({ aux_device: "Speakers", aux_state: "failed", aux_open: false, aux_stalls: 1 }));
    vi.setSystemTime(new Date("2026-10-03T18:50:10Z"));
    h.noteLevels(2, lv({ aux_device: "Speakers", aux_state: "failed", aux_open: false, aux_stalls: 1 }));
    expect(station(h).auxFault).toBeTruthy();
    vi.setSystemTime(new Date("2026-10-03T18:50:15Z"));
    h.noteLevels(2, lv({ aux_device: "Speakers", aux_state: "open", aux_open: true, aux_stalls: 1 }));
    expect(station(h).auxFault).toBeFalsy();
    expect(ledger(dir).some(l => l.type === "aux-restored" && l.stationId === 2)).toBe(true);
  });
});
