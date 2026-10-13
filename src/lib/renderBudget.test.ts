// RENDER BUDGET (docs/perf-pass-round2-2026-10-12.md §3). The React sense on OVEVENTS named what re-rendered too much per
// event; these pin the fixes. The runtime receipt is the sense itself (/health perf.renderers[].componentSelfMs).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { selectBoard, sameBoard } from "../audio/deckStore";

const src = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");
const deck = (o: any) => ({ id: "A", status: "playing", title: "t", artist: "a", positionSec: 1, durationSec: 200, volume: 0.8, ...o });

describe("the board's deck selector (FaderSectionLive)", () => {
  it("a position tick is NOT a change for the board", () => {
    const a = selectBoard({ A: deck({ positionSec: 10 }) as any, B: null, C: null, queueLen: 3 });
    const b = selectBoard({ A: deck({ positionSec: 11 }) as any, B: null, C: null, queueLen: 4 });
    expect(sameBoard(a, b)).toBe(true);
  });
  it("status and volume ARE changes", () => {
    const a = selectBoard({ A: deck({}) as any, B: null, C: null, queueLen: 3 });
    expect(sameBoard(a, selectBoard({ A: deck({ status: "paused" }) as any, B: null, C: null, queueLen: 3 }))).toBe(false);
    expect(sameBoard(a, selectBoard({ A: deck({ volume: 0.5 }) as any, B: null, C: null, queueLen: 3 }))).toBe(false);
    expect(sameBoard(a, selectBoard({ A: null, B: null, C: null, queueLen: 3 }))).toBe(false);
  });
  it("the board reads only status and volume", () => {
    const fs = src("components/FaderSection.tsx");
    const fields = new Set([...fs.matchAll(/\b(?:deck|dk|deckA|deckB|deckC)\?\.(\w+)/g)].map(m => m[1]));
    expect([...fields].sort()).toEqual(["status", "volume"]);
  });
});

describe("no meter-rate or tick-rate re-render of whole panels", () => {
  it("Master Out keeps the master level in a ref, not in state (it re-rendered all of Master Out ~30×/s)", () => {
    const mo = src("components/MasterOutput.tsx");
    expect(mo).not.toMatch(/useState[^;\n]*\(0\);[^\n]*\n?[^\n]*masterLevel|\[masterLevel, setMasterLevel\]/);
    expect(mo).toMatch(/masterLevelRef\.current = v;/);
    expect(mo).toMatch(/<LiveConsole levelRef=\{masterLevelRef\} \/>/);
  });
  it("LivePanel does not subscribe to deck ticks; the board reads its own (status + volume)", () => {
    const app = src("App.tsx");
    const lp = app.slice(app.indexOf("function LivePanel("), app.indexOf("function MultiChoicePillCell("));
    expect(lp).not.toMatch(/useDecks\(/);
    expect(lp).toMatch(/<FaderSectionLive/);
  });
  it("the Decks pop-out no longer polls the engine every 250 ms", () => {
    const pr = src("components/PopoutRenderer.tsx");
    const pf = pr.slice(pr.indexOf("function PopoutFaders("), pr.indexOf("function PopoutLibrary("));
    expect(pf).not.toMatch(/setInterval/);
    expect(pf).toMatch(/<FaderSectionLive/);
  });
  it("Up Next's countdown state lives in DeckRows, not in the component that renders the animated list", () => {
    const un = src("components/UpNext.tsx");
    const main = un.slice(0, un.indexOf("function DeckRows("));
    expect(main).not.toMatch(/setDeckStates/);
    expect(un.slice(un.indexOf("function DeckRows("))).toMatch(/setInterval\(pull, 1000\)/);
  });
});
