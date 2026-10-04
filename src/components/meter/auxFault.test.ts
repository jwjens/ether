// A strip that reaches the room only through the aux must not read a normal level while the aux is down
// (2026-10-04, OV: "a VU meter that shows level while its output device is dead is itself a defect").
import { describe, it, expect } from "vitest";
import { auxFaultFor } from "./auxFault";
import fs from "node:fs";
import path from "node:path";

const D = 3, E = 4, CART = 6, S1 = 7;
const routed = (1 << D) | (1 << E) | (1 << 5) | (0b11111 << 7);   // D/E/F + S1..S5 — the default Source slots
const frame = (o: Record<string, unknown>) => ({ v: 1, e: 1, n: 1, ch: [], bus: [], live: 0, auxRouted: routed, ...o });

describe("auxFaultFor", () => {
  it("aux-routed slot, aux chosen and not open → a fault naming the device and the state", () => {
    const f = auxFaultFor(frame({ auxState: "not_found", auxDevice: "Speakers/Headphones (Realtek(R) Audio)" }), E);
    expect(f).toMatch(/aux output down/i);
    expect(f).toContain("Realtek");
    expect(f).toContain("not found");
  });
  it("…for every state that is not open (opening, failed)", () => {
    expect(auxFaultFor(frame({ auxState: "failed", auxDevice: "X" }), S1)).toBeTruthy();
    expect(auxFaultFor(frame({ auxState: "opening", auxDevice: "X" }), D)).toBeTruthy();
  });
  it("aux open → no fault", () => {
    expect(auxFaultFor(frame({ auxState: "open", auxDevice: "X" }), E)).toBeNull();
  });
  it("a main-path slot (CART, A) is never darkened by the aux", () => {
    expect(auxFaultFor(frame({ auxState: "not_found", auxDevice: "X" }), CART)).toBeNull();
    expect(auxFaultFor(frame({ auxState: "not_found", auxDevice: "X" }), 0)).toBeNull();
  });
  it("no aux device chosen is the operator's routing, not an outage", () => {
    expect(auxFaultFor(frame({ auxState: "none", auxDevice: "" }), E)).toBeNull();
  });
  it("a frame from an engine without the aux fields (4.6.52) changes nothing", () => {
    const oldFrame = { v: 1, e: 1, n: 1, ch: [], bus: [], live: 0 };
    expect(auxFaultFor(oldFrame, E)).toBeNull();
    expect(auxFaultFor(null, E)).toBeNull();
  });
  it("no slot → no fault", () => {
    expect(auxFaultFor(frame({ auxState: "not_found", auxDevice: "X" }), undefined)).toBeNull();
  });
});

// ConsoleStrip is a React component with no test harness here; pin the wiring as a source contract.
describe("ConsoleStrip wiring (source contract)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "ConsoleStrip.tsx"), "utf8");
  it("reads the aux fault from the meters frame for its own slot", () => {
    expect(src).toMatch(/const ab = auxFaultFor\(m, slotIndex\);/);
  });
  it("an aux fault draws the meter NOT FED — never a normal level", () => {
    expect(src).toMatch(/const meterSource: MeterSource = \(meterNotFed \|\| auxBad\) \? \{ stationUuid: null, ch: -1 \}/);
  });
  it("and names the fault on the strip", () => {
    expect(src).toMatch(/\{auxBad && slotIndex !== undefined && \([\s\S]{0,400}⚠ \{auxBad\}/);
  });
});
