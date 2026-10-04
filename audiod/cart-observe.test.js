// THE CART CONFIRM MUST NOT CALL A DEAD AUX "FIRING" (2026-10-04, OV). On 10/03 every cart/sweeper on an aux-routed
// slot logged "FIRING … via loaded-and-active (NOT signal)" — and some with real deck peak — while the aux output
// that is those slots' ONLY way into the room had been dead for hours. The confirm said aired; the PA heard nothing.
// classifyCartFlow now reads the levels frame's aux_open / aux_device and each deck's aux_routed.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const { classifyCartFlow } = require_("./cart-observe.js");

const deck = (id, o = {}) => ({ id, source_present: true, active: true, paused: false, peak: 0, aux_routed: false, ...o });
const AUX_UP   = { aux_device: "Speakers/Headphones (Realtek(R) Audio)", aux_state: "open",      aux_open: true };
const AUX_DOWN = { aux_device: "Speakers/Headphones (Realtek(R) Audio)", aux_state: "not_found", aux_open: false };

describe("classifyCartFlow", () => {
  it("signal on a main-path slot (CART) is FIRING whatever the aux is doing", () => {
    const r = classifyCartFlow({ ...AUX_DOWN, decks: [deck(6, { peak: 0.5 })] }, ["CART"]);
    expect(r).toMatchObject({ flowing: true, how: "signal" });
    expect(r.fault).toBeFalsy();
  });

  it("aux-routed slot, aux open, signal → FIRING", () => {
    const r = classifyCartFlow({ ...AUX_UP, decks: [deck("E", { aux_routed: true, peak: 0.4 })] }, ["E"]);
    expect(r).toMatchObject({ flowing: true, how: "signal" });
    expect(r.fault).toBeFalsy();
  });

  it("aux-routed slot, aux DOWN, loaded-and-active → FAULT, not flowing (the 10/03 line)", () => {
    const r = classifyCartFlow({ ...AUX_DOWN, decks: [deck("E", { aux_routed: true })] }, ["E"]);
    expect(r.flowing).toBe(false);
    expect(r.fault).toBe(true);
    expect(r.how).toMatch(/aux output down/);
    expect(r.how).toContain("Realtek");
  });

  it("aux-routed slot, aux DOWN, even WITH deck signal → FAULT (the peak is real audio going nowhere)", () => {
    const r = classifyCartFlow({ ...AUX_DOWN, decks: [deck("F", { aux_routed: true, peak: 1.0 })] }, ["F"]);
    expect(r).toMatchObject({ flowing: false, fault: true });
    expect(r.peak).toBe(1.0);
  });

  it("two channels, one of them on the main path → still audible, not a fault", () => {
    const lv = { ...AUX_DOWN, decks: [deck("E", { aux_routed: true, peak: 0.3 }), deck(6, { peak: 0.3 })] };
    const r = classifyCartFlow(lv, ["E", "CART"]);
    expect(r).toMatchObject({ flowing: true });
    expect(r.fault).toBeFalsy();
  });

  it("no aux device chosen at all is the operator's routing, not an outage — unchanged behaviour", () => {
    const r = classifyCartFlow({ aux_device: "", aux_state: "none", aux_open: false, decks: [deck("E", { aux_routed: true })] }, ["E"]);
    expect(r).toMatchObject({ flowing: true, how: "loaded-and-active (NOT signal)" });
    expect(r.fault).toBeFalsy();
  });

  it("a levels frame from an engine without the aux fields (4.6.52 addon) behaves exactly as before", () => {
    const r = classifyCartFlow({ decks: [{ id: "E", source_present: true, active: true, paused: false, peak: 0 }] }, ["E"]);
    expect(r).toMatchObject({ flowing: true, how: "loaded-and-active (NOT signal)" });
    expect(r.fault).toBeFalsy();
  });

  it("nothing loaded → nothing", () => {
    const r = classifyCartFlow({ ...AUX_UP, decks: [deck("E", { active: false, source_present: false })] }, ["E"]);
    expect(r).toMatchObject({ flowing: false, how: "nothing" });
  });
});

describe("engine.js wiring (source contract — engine.js loads the native addon, so it is not imported here)", () => {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const src = fs.readFileSync(path.join(here, "engine.js"), "utf8");
  it("_cartObserve delegates to classifyCartFlow", () => {
    expect(src).toMatch(/_cartObserve\(channels\) \{[\s\S]{0,300}classifyCartFlow\(/);
  });
  it("a FAULT is emitted as FAULT, and checked BEFORE the FIRING branch", () => {
    const i = src.indexOf("const obs = this._cartObserve(j.channels);");
    expect(i).toBeGreaterThan(0);
    const after = src.slice(i, i + 1500);
    expect(after).toMatch(/if \(obs\.fault\)[\s\S]*?this\._emitJingle\("FAULT", j\)/);
    expect(after.indexOf("obs.fault")).toBeLessThan(after.indexOf('this._emitJingle("FIRING", j)'));
  });
});
