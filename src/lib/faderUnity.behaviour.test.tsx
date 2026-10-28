// DOUBLE-CLICK ANY FADER = 0 dB, UNITY (Jeff, 2026-10-28) — through the real faders: HFader (MASTER, MONITOR, the aux rows,
// the station strips) and the hook every fader is handled by (useFaderControl). ConsoleStrip (decks and source faders) wires
// the same handler on its capture area (checked below), and its old double-click door — type a level — moved to Enter.
import "../modules/proof/miniDom";
import { describe, it, expect, afterEach } from "vitest";
import React, { act, useRef } from "react";
import fs from "fs";
import path from "path";
import { mount, type Mounted } from "../modules/proof/render";
import { fire } from "../modules/proof/miniDom";
import HFader from "../components/HFader";
import { useFaderControl } from "./useFaderControl";
const dbToGain = (db: number) => Math.pow(10, db / 20);

let mounted: Mounted[] = [];
afterEach(async () => { for (const m of mounted) await m.unmount(); mounted = []; });
async function show(el: React.ReactElement) { const m = await mount(el); mounted.push(m); return m; }
const slider = (m: Mounted) => m.container.querySelector('[role="slider"]') as any;

describe("double-click a fader → 0 dB (unity)", () => {
  for (const [label, gain, topDb] of [["MASTER at -20 dB", dbToGain(-20), 0], ["an aux fader at +6 dB", dbToGain(6), 10], ["MONITOR off", 0, 0]] as const) {
    it(`HFader: ${label}`, async () => {
      const changes: number[] = [];
      const m = await show(<HFader gain={gain} topDb={topDb} onChange={g => changes.push(g)} />);
      await act(async () => { fire(slider(m), "dblclick"); });
      expect(changes).toEqual([1]);
    });
  }
  it("a disabled fader does not move", async () => {
    const changes: number[] = [];
    const m = await show(<HFader gain={0.5} topDb={0} disabled onChange={g => changes.push(g)} />);
    await act(async () => { fire(slider(m), "dblclick"); });
    expect(changes).toEqual([]);
  });
  it("a fader whose top is below 0 dB goes to its top", async () => {
    function Fader({ onChange }: { onChange: (g: number) => void }) {
      const track = useRef<HTMLDivElement>(null);
      const c = useFaderControl({ gain: 0.1, topDb: -6, onChange, axis: "y", trackRef: track });
      return <div ref={track} data-f="1" onDoubleClick={c.onDoubleClick} />;
    }
    const changes: number[] = [];
    const m = await show(<Fader onChange={g => changes.push(g)} />);
    await act(async () => { fire(m.container.firstChild, "dblclick"); });
    expect(changes.length).toBe(1);
    expect(changes[0]).toBeCloseTo(dbToGain(-6), 9);
  });
  it("the channel strips (decks, source faders) use the same handler; typing a level moved to Enter", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "components", "ConsoleStrip.tsx"), "utf8");
    expect(src).toMatch(/onDoubleClick=\{fc\.onDoubleClick\}/);
    expect(src).toMatch(/e\.key === "Enter"[^\n]*setTypeReq/);
    expect(src).not.toMatch(/onDoubleClick=\{\(\) => setTypeReq/);
  });
});

describe("every fader on the board wears the one cap", () => {
  it("ConsoleStrip and HFader draw FaderCap; the capture area shows a grab hand", () => {
    const read = (f: string) => fs.readFileSync(path.join(__dirname, "..", "components", f), "utf8");
    expect(read("ConsoleStrip.tsx")).toMatch(/<FaderCap axis="y"/);
    expect(read("ConsoleStrip.tsx")).toMatch(/cursor: dragging \? "grabbing" : "grab"/);
    expect(read("HFader.tsx")).toMatch(/<FaderCap axis="x"/);
    expect(read("HFader.tsx")).toMatch(/c\.dragging \? "grabbing" : "grab"/);
  });
  it("the cap says when it is being moved", async () => {
    const m = await show(<HFader gain={0.5} topDb={0} onChange={() => {}} />);
    expect(m.container.querySelector("[data-fader-cap]")?.getAttribute("data-fader-cap")).toBe("still");
    expect(m.container.querySelector("[data-fader-cap-line]")).toBeTruthy();
  });
});
