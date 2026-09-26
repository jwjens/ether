import { describe, it, expect } from "vitest";
import {
  SHIPPED, makeRack, BUILT_IN_PRESETS, DEFAULT_PRESET, racksEqual, diffRacks, convertLegacyPresets,
  editModule, setGeqIn, setLink, canMove, moveSlot, canRemove, addableModules, addGeq, removeSlot,
  effectiveSection, findModule, wouldRide, isPinned,
} from "./rackModel";
import type { Slot, AnyModule } from "./rackTypes";

// Slice 4 — docs/dsp-rack-framework.md §3, §4, §6. The rack's rules, pinned.
describe("rackModel", () => {
  it("Ether v1 (shipped) is the default and carries the exact shipped constants (= the −14 streaming target)", () => {
    expect(DEFAULT_PRESET).toBe("Ether v1 (shipped)");
    const d = BUILT_IN_PRESETS[0].doc;
    expect(findModule(d.sections.local as Slot<AnyModule>[], "ride")).toEqual({ type: "ride", target: -14, rate: 1.5, clamp: 12 });
    expect(findModule(d.sections.local as Slot<AnyModule>[], "limiter")).toEqual({ type: "limiter", ceiling: -1.0, release: 120 });
    expect(findModule(d.sections.pgm as Slot<AnyModule>[], "geq")!.bands).toEqual(new Array(10).fill(0));
    expect(d.link).toBe(true);
    expect(SHIPPED).toEqual({ target: -14, rate: 1.5, clamp: 12, ceiling: -1.0, release: 120 });
  });

  it("the built-ins: only target and ceiling come from each standard; no 'Stream −14' (ruling 4)", () => {
    const by = Object.fromEntries(BUILT_IN_PRESETS.map(p => [p.name, p.doc]));
    const tc = (n: string) => { const s = by[n].sections.local as Slot<AnyModule>[]; return [findModule(s, "ride")!.target, findModule(s, "limiter")!.ceiling, findModule(s, "ride")!.rate, findModule(s, "limiter")!.release]; };
    expect(tc("Broadcast −24 (ATSC A/85)")).toEqual([-24, -2.0, 1.5, 120]);
    expect(tc("EBU −23 (R128)")).toEqual([-23, -1.0, 1.5, 120]);
    expect(tc("Stream/Podcast −16")).toEqual([-16, -1.0, 1.5, 120]);
    expect(BUILT_IN_PRESETS.map(p => p.name).some(n => /Stream\s*−14/.test(n))).toBe(false);
    expect(BUILT_IN_PRESETS.every(p => p.builtIn)).toBe(true);
  });

  it("'modified' is derived: slot ids and a linked stream copy don't count, values and IN do", () => {
    const a = makeRack();
    const b = JSON.parse(JSON.stringify(a)); b.sections.local[0].id = "other"; b.sections.stream = [];
    expect(racksEqual(a, b)).toBe(true);
    expect(racksEqual(a, editModule(a, "local", "s-ride", { target: -16 } as any))).toBe(false);
    expect(racksEqual(a, setGeqIn(a, false))).toBe(false);
  });

  it("Arm shows what Take would change, in operator words; an identical preset shows nothing", () => {
    const live = makeRack();
    expect(diffRacks(live, makeRack())).toEqual([]);
    expect(diffRacks(live, makeRack({ target: -23 }))).toEqual(["both: target −14.0 → −23.0 LUFS"]);
    expect(diffRacks(live, makeRack({ target: -24, ceiling: -2 }))).toEqual(["both: target −14.0 → −24.0 LUFS", "both: ceiling −1.0 → −2.0 dBTP"]);
    expect(diffRacks(live, setGeqIn(live, false))).toEqual(["GEQ OUT"]);
  });

  it("old proc_presets become rack presets (five numbers, flat GEQ); malformed input costs nothing", () => {
    const legacy = JSON.stringify([{ name: "Talk", params: { targetLufs: -18, ceilingDbtp: -1.5, releaseMs: 200, rideRate: 2, rideClamp: 9 } }]);
    const [p] = convertLegacyPresets(legacy);
    expect(p.name).toBe("Talk");
    const s = p.doc.sections.local as Slot<AnyModule>[];
    expect(findModule(s, "ride")).toEqual({ type: "ride", target: -18, rate: 2, clamp: 9 });
    expect(findModule(s, "limiter")).toEqual({ type: "limiter", ceiling: -1.5, release: 200 });
    expect(convertLegacyPresets("not json")).toEqual([]);
    expect(convertLegacyPresets(null)).toEqual([]);
  });

  it("editing while linked edits both branches; splitting changes nothing by itself", () => {
    const a = editModule(makeRack(), "stream", "s-ride", { target: -20 } as any);
    expect(findModule(effectiveSection(a, "local"), "ride")!.target).toBe(-20);
    expect(findModule(a.sections.stream as Slot<AnyModule>[], "ride")!.target).toBe(-20);
    const split = setLink(a, false);
    expect(split.link).toBe(false);
    expect(JSON.stringify(split.sections.stream)).toBe(JSON.stringify(split.sections.local));
    const s2 = editModule(split, "stream", "s-ride", { target: -16 } as any);
    expect(findModule(s2.sections.local as Slot<AnyModule>[], "ride")!.target).toBe(-20);
    expect(findModule(s2.sections.stream as Slot<AnyModule>[], "ride")!.target).toBe(-16);
  });

  it("the limiter is pinned last: it never moves, and nothing moves onto or past it", () => {
    const branch = makeRack().sections.local as Slot<AnyModule>[];
    expect(isPinned(branch[1])).toBe(true);
    expect(canMove(branch, 1, 0)).toBe(false);   // the limiter up
    expect(canMove(branch, 0, 1)).toBe(false);   // the ride past the limiter
    // a synthetic rack (slice 5's channel racks are where reorder matters): free slots move among themselves
    const eqA = { id: "a", in: true, module: { type: "geq", bands: [] } } as Slot<AnyModule>;
    const eqB = { id: "b", in: true, module: { type: "geq", bands: [] } } as Slot<AnyModule>;
    const lim = branch[1];
    const s = [eqA, eqB, lim];
    expect(canMove(s, 0, 1)).toBe(true);
    expect(moveSlot(s, 0, 1).map(x => x.id)).toEqual(["b", "a", "s-lim"]);
    expect(canMove(s, 1, 2)).toBe(false);
  });

  it("remove / add: the GEQ can go and come back (one instance); ride and limiter never go; branches and channels offer nothing", () => {
    const d = makeRack();
    const [ride, lim] = d.sections.local as Slot<AnyModule>[];
    expect(canRemove(ride)).toBe(false);
    expect(canRemove(lim)).toBe(false);
    expect(addableModules(d, "pgm")).toEqual([]);
    const noGeq = removeSlot(d, "pgm", "s-geq");
    expect(noGeq.sections.pgm).toEqual([]);
    expect(addableModules(noGeq, "pgm")).toEqual(["geq"]);
    expect(addGeq(noGeq).sections.pgm[0].module).toEqual({ type: "geq", bands: new Array(10).fill(0) });
    expect(addableModules(d, "local")).toEqual([]);
    expect(addableModules(d, "channel")).toEqual([]);
    expect(removeSlot(d, "local", "s-lim")).toEqual(d);
  });

  it("the would-ride projection is target − input, clamped, and absent without a real input", () => {
    const d = makeRack();
    expect(wouldRide(d, "local", -20)).toBe(6);
    expect(wouldRide(d, "local", -40)).toBe(12);
    expect(wouldRide(d, "local", -70)).toBeNull();
    expect(wouldRide(d, "local", null)).toBeNull();
  });
});
