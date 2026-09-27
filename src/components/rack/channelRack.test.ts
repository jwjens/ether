import { describe, it, expect } from "vitest";
import {
  emptyChannelRack, channelAddable, addChannelModule, removeChannelSlot, canMoveChannel, moveChannelSlot, setChannelIn,
  editChannelModule, findChannel, channelRackActive, channelRackAudible, CHANNEL_MODULE_TYPES, CHANNEL_SLOTS, rackName,
  flatPeq, resetFilters, clearChannelRack, FILTERS_RESET, BUILT_IN_CHANNEL_PRESETS, channelRacksEqual, VOICE_GATE, VOICE_COMP,
} from "./channelRack";
import type { PeqModule, FilterModule } from "./rackTypes";

// Slice 5 — docs/dsp-channel-rack-eq.md §4. The channel rack's rules, pinned.
describe("channelRack", () => {
  it("starts empty and runs nothing", () => {
    const d = emptyChannelRack();
    expect(d).toEqual({ v: 1, sections: { ch: [] } });
    expect(channelRackActive(d)).toBe(false);
  });

  it("Add offers Filters, Gate, PEQ and Comp only — the ride can never be offered — one of each (slice 6)", () => {
    expect(CHANNEL_MODULE_TYPES).toEqual(["filters", "gate", "peq", "comp"]);
    let d = emptyChannelRack();
    expect(channelAddable(d)).toEqual(["filters", "gate", "peq", "comp"]);
    d = addChannelModule(d, "peq");
    expect(channelAddable(d)).toEqual(["filters", "gate", "comp"]);
    for (const t of ["filters", "gate", "comp"] as const) d = addChannelModule(d, t);
    expect(channelAddable(d)).toEqual([]);
    expect(addChannelModule(d, "peq")).toBe(d);   // a second PEQ is refused (the engine refuses it too)
  });

  it("a newly added module starts OUT: adding changes nothing on air (ruling 5)", () => {
    const d = addChannelModule(emptyChannelRack(), "filters");
    expect(d.sections.ch[0].in).toBe(false);
    expect(channelRackActive(d)).toBe(false);
    expect(channelRackActive(setChannelIn(d, d.sections.ch[0].id, true))).toBe(true);
  });

  it("Filters go in front of the PEQ, and can be dragged after it (nothing is pinned in a channel rack)", () => {
    let d = addChannelModule(addChannelModule(emptyChannelRack(), "peq"), "filters");
    expect(d.sections.ch.map(s => s.module?.type)).toEqual(["filters", "peq"]);
    expect(canMoveChannel(d, 0, 1)).toBe(true);
    d = moveChannelSlot(d, 0, 1);
    expect(d.sections.ch.map(s => s.module?.type)).toEqual(["peq", "filters"]);
    expect(canMoveChannel(d, 0, 2)).toBe(false);
  });

  it("edits are clamped to the engine's ranges; remove empties the slot", () => {
    let d = setChannelIn(addChannelModule(emptyChannelRack(), "peq"), "c-peq", true);
    const q = findChannel(d, "peq")!.module!;
    d = editChannelModule(d, "c-peq", { ...q, bands: [{ ...q.bands[0], gain: 30 }, q.bands[1], q.bands[2], q.bands[3]] });
    expect(findChannel(d, "peq")!.module!.bands[0].gain).toBe(14);
    expect(channelRackAudible(d)).toBe(true);
    d = removeChannelSlot(d, "c-peq");
    expect(d.sections.ch).toEqual([]);
  });

  it("an IN PEQ with every band at 0 dB is active but changes nothing (the lamp says IN, not 'processing')", () => {
    const d = setChannelIn(addChannelModule(emptyChannelRack(), "peq"), "c-peq", true);
    expect(channelRackActive(d)).toBe(true);
    expect(channelRackAudible(d)).toBe(false);
  });

  it("the faders, and the rack names rack:get / rack:set take", () => {
    expect(CHANNEL_SLOTS).toEqual(["A", "B", "C", "D", "E", "F", "CART", "S1", "S2", "S3", "S4", "S5"]);
    expect(rackName("S2")).toBe("ch:S2");
  });

  // SLICE 5b — the resets
  const busy = () => {
    let d = addChannelModule(addChannelModule(emptyChannelRack(), "filters"), "peq");
    d = setChannelIn(setChannelIn(d, "c-filters", true), "c-peq", true);
    const q = findChannel(d, "peq")!.module as PeqModule;
    d = editChannelModule(d, "c-peq", { ...q, bands: [
      { freq: 120, gain: 4, width: 2, shelf: true }, { freq: 900, gain: -3, width: 0.5 },
      { freq: 3000, gain: 2, width: 1.5 }, { freq: 9000, gain: -2, width: 1, shelf: true }] });
    return editChannelModule(d, "c-filters", { type: "filters", hpf: { in: true, freq: 120 }, lpf: { in: true, freq: 9000 } });
  };

  it("FLAT: every PEQ band to 0 dB; frequency, width, shelf and IN kept; the filters untouched", () => {
    const d = busy();
    const f = flatPeq(d);
    const before = findChannel(d, "peq")!, after = findChannel(f, "peq")!;
    expect(after.module!.bands.map(b => b.gain)).toEqual([0, 0, 0, 0]);
    expect(after.module!.bands.map(b => [b.freq, b.width, !!b.shelf])).toEqual(before.module!.bands.map(b => [b.freq, b.width, !!b.shelf]));
    expect(after.in).toBe(true);
    expect(findChannel(f, "filters")).toEqual(findChannel(d, "filters"));
    expect((findChannel(d, "peq")!.module as PeqModule).bands[0].gain).toBe(4);   // the input is not mutated
  });

  it("Filters RESET: HPF and LPF both OUT at the defaults; the module's IN and the PEQ untouched", () => {
    const d = busy();
    const r = resetFilters(d);
    expect(findChannel(r, "filters")!.module).toEqual(FILTERS_RESET);
    expect((FILTERS_RESET as FilterModule).hpf.in || FILTERS_RESET.lpf.in).toBe(false);
    expect(findChannel(r, "filters")!.in).toBe(true);
    expect(findChannel(r, "peq")).toEqual(findChannel(d, "peq"));
    // with the filters reset and the PEQ flat, nothing IN changes the sound
    expect(channelRackAudible(flatPeq(r))).toBe(false);
  });

  it("CLEAR RACK: the empty rack — nothing runs", () => {
    const c = clearChannelRack(busy());
    expect(c).toEqual(emptyChannelRack());
    expect(channelRackActive(c)).toBe(false);
  });

  it("the resets on a rack without that module change nothing", () => {
    const d = addChannelModule(emptyChannelRack(), "peq");
    expect(resetFilters(d)).toEqual(d);
    const f = addChannelModule(emptyChannelRack(), "filters");
    expect(flatPeq(f)).toEqual(f);
  });

  // SLICE 6 — dynamics, presets (docs/dsp-channel-dynamics.md §3; rulings 6, 8, 9)
  it("a new Gate / Comp goes in the spec's order (Filters → Gate → PEQ → Comp), OUT, at the Voice values", () => {
    let d = addChannelModule(addChannelModule(emptyChannelRack(), "comp"), "filters");
    d = addChannelModule(d, "peq");
    d = addChannelModule(d, "gate");
    expect(d.sections.ch.map(s => s.module?.type)).toEqual(["filters", "gate", "peq", "comp"]);
    expect(d.sections.ch.every(s => s.in === false)).toBe(true);
    expect(findChannel(d, "gate")!.module).toEqual(VOICE_GATE);
    expect(findChannel(d, "comp")!.module).toEqual(VOICE_COMP);
  });

  it("Voice: Filters (HPF 80) → Gate −45/15/1:4 → PEQ flat → Comp 3:1 at −20, all IN; Off = the EMPTY rack", () => {
    const voice = BUILT_IN_CHANNEL_PRESETS.find(p => p.name === "Voice")!.doc;
    expect(voice.sections.ch.map(s => [s.module?.type, s.in])).toEqual([["filters", true], ["gate", true], ["peq", true], ["comp", true]]);
    expect(VOICE_GATE).toMatchObject({ threshold: -45, depth: 15, ratio: 4, attack: 1, hold: 100, release: 150, hysteresis: 3 });
    expect(VOICE_COMP).toMatchObject({ threshold: -20, ratio: 3, attack: 10, release: 150, makeup: 0, knee: 6 });
    const off = BUILT_IN_CHANNEL_PRESETS.find(p => p.name === "Off")!.doc;
    expect(off).toEqual(emptyChannelRack());
    expect(channelRackActive(off)).toBe(false);
    expect(channelRacksEqual(off, emptyChannelRack())).toBe(true);
  });

  it("a Gate or Comp that is IN changes the sound (it is level-dependent)", () => {
    const d = setChannelIn(addChannelModule(emptyChannelRack(), "comp"), "c-comp", true);
    expect(channelRackAudible(d)).toBe(true);
  });
});
