// Patch Bay inputs (step 2): the board's SOURCE dropdown and the inputs grid read and write the same records, so they
// always agree (Jeff, 2026-10-28: "The fader SOURCE dropdown on the board stays as it is and must agree with the inputs
// grid.").
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  faderInput, stripSourceValue, crosspointOn, planConnect, planDisconnect, applySteps, inputColumns,
  MIC_VALUE_PREFIX, type StationRecords, type InputCol,
} from "./inputPatch";

const SLOTS = ["D", "E", "F", "S1"];
const dev = (device: string, channel: number): InputCol => ({ kind: "device", device, channel });
const LINK: InputCol = { kind: "link" };
const COLS: InputCol[] = [dev("Focusrite", 1), dev("Focusrite", 2), dev("park:1", 1), LINK];

/** What the dropdown shows and what the grid shows, for one fader, from the same records. */
function bothViews(s: StationRecords, slot: string) {
  const kind = s.kinds[slot] || "";
  const mic = s.micPatches[slot];
  const value = stripSourceValue(kind, mic);
  const f = faderInput(slot, { kind, micPatch: mic, linkInputSlot: s.linkInputSlot });
  const on = COLS.filter(c => crosspointOn(f, c));
  return { value, on };
}
/** The agreement: a dropdown on a mic input ⇔ exactly that device's patched channel lit; on Link ⇔ the Link lit when the
 *  feed is on this fader; anything else ⇔ nothing lit. */
function agree(s: StationRecords) {
  for (const slot of SLOTS) {
    const { value, on } = bothViews(s, slot);
    if (value.startsWith(MIC_VALUE_PREFIX)) {
      const m = s.micPatches[slot]!;
      expect(on, `${slot}: ${value}`).toEqual([dev(m.device, m.channel)]);
    } else if (value === "link") {
      expect(on, `${slot}: link`).toEqual(s.linkInputSlot === slot ? [LINK] : []);
    } else {
      expect(on, `${slot}: ${value || "no source"}`).toEqual([]);
    }
  }
  // One Link feed per station: at most one fader lights it.
  expect(SLOTS.filter(sl => bothViews(s, sl).on.includes(LINK)).length).toBeLessThanOrEqual(1);
}

const base = (): StationRecords => ({
  kinds: { D: "mic", E: "link", F: "cart", S1: "" },
  micPatches: { D: { device: "Focusrite", channel: 2, gainDb: 6 } },
  linkInputSlot: "E",
});

describe("Patch Bay inputs: the grid and the board's SOURCE dropdown agree", () => {
  it("on the starting records", () => { agree(base()); });

  it("after every possible click on every crosspoint, twice over", () => {
    let n = 0;
    const walk = (s: StationRecords, depth: number) => {
      agree(s);
      if (depth === 0) return;
      for (const slot of SLOTS) for (const col of COLS) {
        const f = faderInput(slot, { kind: s.kinds[slot] || "", micPatch: s.micPatches[slot], linkInputSlot: s.linkInputSlot });
        const steps = crosspointOn(f, col) ? planDisconnect(slot, col, s) : planConnect(slot, col, s);
        n++;
        walk(applySteps(s, steps), depth - 1);
      }
    };
    walk(base(), 2);
    expect(n).toBeGreaterThan(200);
  });

  it("connecting an input to a fader makes its dropdown say that input", () => {
    const s = applySteps(base(), planConnect("F", dev("Focusrite", 1), base()));
    expect(stripSourceValue(s.kinds.F, s.micPatches.F)).toBe("mic:Focusrite");
    expect(s.micPatches.F).toEqual({ device: "Focusrite", channel: 1, gainDb: 0 });
  });

  it("a new input on a mic fader keeps its gain", () => {
    const s = applySteps(base(), planConnect("D", dev("park:1", 1), base()));
    expect(s.micPatches.D).toEqual({ device: "park:1", channel: 1, gainDb: 6 });
  });

  it("the Link moves: the fader it left says no source, never a Link it no longer has", () => {
    const s = applySteps(base(), planConnect("S1", LINK, base()));
    expect(s.linkInputSlot).toBe("S1");
    expect(stripSourceValue(s.kinds.S1, s.micPatches.S1)).toBe("link");
    expect(stripSourceValue(s.kinds.E, s.micPatches.E)).toBe("");
  });

  it("the Link onto a mic fader unpatches the mic first", () => {
    const steps = planConnect("D", LINK, base());
    expect(steps[0]).toEqual({ op: "mic", slot: "D", patch: null });
    expect(applySteps(base(), steps).micPatches.D).toBeUndefined();
  });

  it("an input onto the Link's fader releases the Link", () => {
    const steps = planConnect("E", dev("Focusrite", 1), base());
    expect(steps[0]).toEqual({ op: "link", slot: null });
    expect(applySteps(base(), steps).linkInputSlot).toBeNull();
  });

  it("engine patches come before the board's kind, so a refused patch never leaves the dropdown wrong", () => {
    for (const slot of SLOTS) for (const col of COLS) {
      const steps = planConnect(slot, col, base());
      const firstKind = steps.findIndex(x => x.op === "kind");
      const lastPatch = steps.map(x => x.op).lastIndexOf(col.kind === "link" ? "link" : "mic");
      expect(lastPatch, `${slot} ← ${JSON.stringify(col)}: no engine patch`).toBeGreaterThanOrEqual(0);
      if (firstKind >= 0) expect(firstKind, `${slot} ← ${JSON.stringify(col)}`).toBeGreaterThan(lastPatch);
    }
  });

  it("disconnecting leaves the fader with no source, as the dropdown's '— no source —' does", () => {
    const s = applySteps(base(), planDisconnect("D", dev("Focusrite", 2), base()));
    expect(stripSourceValue(s.kinds.D, s.micPatches.D)).toBe("");
    expect(s.micPatches.D).toBeUndefined();
  });
});

describe("Patch Bay inputs: columns", () => {
  it("one column per input channel, Park mics included, then the Link", () => {
    const cols = inputColumns([{ name: "Focusrite", channels: 2 }, { name: "park:1", channels: 1, label: "Park Mic 1 (Park page)", park: 1 }], []);
    expect(cols.map(c => c.kind === "link" ? "link" : `${c.device}#${c.channel}`)).toEqual(["Focusrite#1", "Focusrite#2", "park:1#1", "link"]);
  });
  it("a patched device that is not connected stays as a column, marked not present", () => {
    const cols = inputColumns([], [{ device: "USB Mic", channel: 1, gainDb: 0 }]);
    expect(cols[0]).toMatchObject({ device: "USB Mic", channel: 1, present: false });
  });
});

describe("the board's SOURCE dropdown renders from the shared rule", () => {
  it("SourceChannelStrip's <select> value is stripSourceValue", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "components", "SourceChannelStrip.tsx"), "utf8");
    expect(src).toMatch(/value=\{stripSourceValue\(config\.kind \|\| "", patch\)\}/);
  });
});
