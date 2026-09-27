import { describe, it, expect } from "vitest";
import { diffShow, isModified, liveSlots, armPreview, pendingFor, rackKey, type ShowPreset } from "./showPresets";

const rack = (g: number, id = "x") => ({ v: 1, sections: { ch: [{ id, module: { type: "peq", bands: [{ freq: 1000, gain: g, width: 1 }] }, in: true }] } });
const board = (over: Partial<ShowPreset["board"]["channels"]> = {}, master: ShowPreset["board"]["master"] = {}): ShowPreset => ({
  v: 1, name: "live", stationUuid: "u", savedAt: null,
  board: {
    channels: {
      A: { enabled: true, type: "music", fader: 1, duckable: true, rack: rack(0) },
      S1: { enabled: true, type: "source", kind: "mic", fader: 0.5, duck: true, duckable: true, rack: rack(3) },
      ...over,
    },
    master: { fader: 1, monitorLevel: 0.8, duck: { depthDb: -22, thresholdDb: -45, attackMs: 30, holdMs: 700, releaseMs: 500 }, ...master },
  },
});

describe("show presets — the board side (slice 7)", () => {
  it("a show that matches the board is not modified; a moved fader is", () => {
    const live = board();
    expect(isModified(live, board())).toBe(false);
    const moved = board({ S1: { ...live.board.channels.S1, fader: 0.25 } });
    const d = diffShow(moved, live);
    expect(d).toEqual([{ where: "Ch S1", what: "fader", from: "-12.0 dB", to: "-6.0 dB" }]);
  });

  it("racks compare by what runs — a module id is bookkeeping, not sound", () => {
    expect(rackKey(rack(3, "a"))).toBe(rackKey(rack(3, "b")));
    expect(diffShow(board({ A: { enabled: true, fader: 1, rack: rack(0, "other-id") } }), board())).toEqual([]);
    expect(diffShow(board(), board({ A: { enabled: true, fader: 1, rack: rack(6) } }))[0]).toMatchObject({ where: "Ch A", what: "channel rack" });
  });

  it("a field the preset does not name is not compared (Flat names faders and racks, not layout or ducks)", () => {
    const flatish: ShowPreset = { ...board(), board: { channels: { A: { fader: 1 }, S1: { fader: 0.5 } }, master: {} } };
    expect(diffShow(board(), flatish)).toEqual([]);
  });

  it("the ducker and the monitor level are part of the show (ruling 8)", () => {
    const d = diffShow(board(), board({}, { monitorLevel: 0.5, duck: { depthDb: -12, thresholdDb: -45, attackMs: 30, holdMs: 700, releaseMs: 500 } }));
    expect(d.map(c => c.what)).toEqual(["monitor level", "ducker"]);
  });

  it("the live rule the Arm preview uses: A/B/C live while playing, every other channel while ON (ruling 1)", () => {
    const live = liveSlots(["A", "B", "C", "D", "S1"], { A: "playing", B: "idle" }, { D: false, S1: true });
    expect(live).toEqual(["A", "S1"]);
    // a mic that is ON is live even in a pause between words — ON is all it takes
    expect(liveSlots(["S2"], {}, {})).toEqual(["S2"]);
  });

  it("Arm splits what changes now from what waits for a live channel", () => {
    const target = board({ A: { enabled: true, fader: 0.5, rack: rack(0) }, S1: { enabled: true, kind: "mic", fader: 0.9, rack: rack(3) } }, { fader: 0.8 });
    const p = armPreview(diffShow(board(), target), ["S1"]);
    expect(p.waitingSlots).toEqual(["S1"]);
    expect(p.waits.map(c => c.where)).toEqual(["Ch S1"]);
    expect(p.now.map(c => `${c.where} ${c.what}`)).toEqual(["Ch A fader", "Master fader"]);
  });

  it("the strip's PENDING comes from the blade's state, nothing else", () => {
    const st = { current: "Morning", armed: null, pending: [{ slot: "S1", show: "Morning" }], levels: {} };
    expect(pendingFor(st, "S1")).toBe("Morning");
    expect(pendingFor(st, "A")).toBeNull();
  });
});
