import { describe, it, expect } from "vitest";
const P = require("./output-patch.js");

const kvOf = (o) => (k) => o[k];

describe("output patch: what is saved per computer (Patch Bay, outputs)", () => {
  it("a station that never opened the Patch Bay reads its patch from the old pickers' keys — nothing changes on update", () => {
    const p = P.readPatch(kvOf({ audio_output_device: "Speakers (Realtek)", aux_monitor_device: "Bose", pfl_cue_device: "" }));
    expect(p.source).toBe("legacy");
    expect(p.master).toEqual([{ device: "Speakers (Realtek)", pair: 0 }]);
    expect(p.aux).toEqual([{ device: "Bose", pair: 0 }]);
    expect(p.cue).toEqual([]);
    expect(p.stall_switch).toBeNull();
  });

  it("a saved patch wins over the old keys", () => {
    const saved = JSON.stringify({ master: [{ device: "MOTU", pair: 2 }, { device: "Speakers", pair: 0 }], aux: [], cue: [], stall_switch: false });
    const p = P.readPatch(kvOf({ patch_outputs: saved, audio_output_device: "Speakers" }));
    expect(p.source).toBe("patch");
    expect(p.master).toEqual([{ device: "MOTU", pair: 2 }, { device: "Speakers", pair: 0 }]);
    expect(p.stall_switch).toBe(false);
  });

  it("a damaged saved patch falls back to the old keys, never to nothing", () => {
    const p = P.readPatch(kvOf({ patch_outputs: "{not json", audio_output_device: "Speakers" }));
    expect(p.source).toBe("legacy");
    expect(p.master).toEqual([{ device: "Speakers", pair: 0 }]);
  });

  it("normalise: blanks and duplicates dropped, odd pairs made even, at most 4 per row, stall switch only true/false/null", () => {
    const n = P.normalise({ master: [{ device: "A" }, { device: "A", pair: 0 }, { device: "" }, { device: "B", pair: 3 }, { device: "C" }, { device: "D" }, { device: "E" }],
      aux: "nope", cue: null, stall_switch: "yes" });
    expect(n.ok).toBe(true);
    expect(n.patch.master).toEqual([{ device: "A", pair: 0 }, { device: "B", pair: 2 }, { device: "C", pair: 0 }, { device: "D", pair: 0 }]);
    expect(n.patch.aux).toEqual([]);
    expect(n.patch.stall_switch).toBeNull();
    expect(P.normalise([]).ok).toBe(false);
  });

  it("saving mirrors each row's first device into the old key, and an empty row clears it", () => {
    const w = P.writesFor({ master: [{ device: "MOTU", pair: 2 }, { device: "Speakers", pair: 0 }], aux: [], cue: [{ device: "Phones", pair: 0 }], stall_switch: true });
    const m = Object.fromEntries(w.map(x => [x.key, x.value]));
    expect(JSON.parse(m.patch_outputs).master[1]).toEqual({ device: "Speakers", pair: 0 });
    expect(m.audio_output_device).toBe("MOTU");
    expect(m.aux_monitor_device).toBe("");
    expect(m.pfl_cue_device).toBe("Phones");
  });

  it("the engine JSON is the shape native/src/patch.rs parses", () => {
    const j = JSON.parse(P.engineJson({ master: [{ device: "A", pair: 0 }], aux: [], cue: [], stall_switch: null, source: "patch" }));
    expect(Object.keys(j).sort()).toEqual(["aux", "cue", "master", "stall_switch"]);
    expect(j.stall_switch).toBeNull();
  });
});

describe("output patch on engine connect (audiod/board-state.js applyBoard)", () => {
  const B = require("./board-state.js");
  const sinkLog = () => {
    const calls = [];
    const s = {};
    for (const n of ["setOutputPatch", "setAuxDevice", "setCueDevice", "setOutputDevice"]) s[n] = (...a) => { calls.push([n, ...a]); return true; };
    s.getOutputDevice = () => null;
    return { s, calls };
  };

  it("a patched station is restored by the one patch call, never the three single-device setters", () => {
    const { s, calls } = sinkLog();
    const r = B.applyBoard({ outputPatch: { master: [{ device: "MOTU", pair: 2 }], aux: [], cue: [], stall_switch: null }, auxDevice: "Bose", cueDevice: "", outputDevice: "Speakers" }, s);
    expect(calls.map(c => c[0])).toEqual(["setOutputPatch"]);
    expect(JSON.parse(calls[0][1]).master).toEqual([{ device: "MOTU", pair: 2 }]);
    expect(r.failed).toEqual([]);
  });

  it("a station never patched keeps the old path exactly", () => {
    const { s, calls } = sinkLog();
    B.applyBoard({ auxDevice: "Bose", cueDevice: "", outputDevice: "Speakers" }, s);
    expect(calls.map(c => c[0])).toEqual(["setAuxDevice", "setCueDevice", "setOutputDevice"]);
  });

  it("an engine without the patch call says so (a failure on screen, not silence)", () => {
    const { s } = sinkLog();
    delete s.setOutputPatch;
    const r = B.applyBoard({ outputPatch: { master: [], aux: [], cue: [], stall_switch: null } }, s);
    expect(r.failed.map(f => f.setting)).toEqual(["outputPatch"]);
  });
});
