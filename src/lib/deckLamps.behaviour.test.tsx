// Only one deck lamp is ever lit on the collapsed A/B/C strip (Jeff, 2026-10-28: "Check whether two deck lamps can light at
// once during the A/B/C switch in the app itself, not just in the capture. Only one deck plays at a time, so only one lamp
// may be lit."). Rendered through the real lamps, driven by the board's own hook (useShownDeck, as FaderSection uses it),
// across a whole rotation with crossfades — and the DOM is checked after EVERY mutation, not only at the end.
// It also caught a real defect: the strip did not turn to a deck when it started, only when the old one stopped.
import "../modules/proof/miniDom";
import { describe, it, expect, afterEach } from "vitest";
import React, { act, useState } from "react";
import { mount, type Mounted } from "../modules/proof/render";
import DeckLamps from "../components/DeckLamps";
import { type DeckId } from "./deckView";
import { useShownDeck } from "../hooks/useShownDeck";

type St = Record<DeckId, string | undefined>;
let setStatus: (s: St) => void = () => {};
function Board() {   // the board's own hook (FaderSection: useShownDeck) and lamps
  const [status, set] = useState<St>({ A: "idle", B: "idle", C: "idle" });
  setStatus = set;
  const shown = useShownDeck(status.A, status.B, status.C);
  return <div><DeckLamps shown={shown} /></div>;
}

let m: Mounted | null = null;
afterEach(async () => { await m?.unmount(); m = null; });

describe("the collapsed strip's A B C lamps", () => {
  it("exactly one is lit after every DOM change through A → (A+B crossfade) → B → (B+C) → C → (C+A) → A", async () => {
    m = await mount(<Board />);
    const lit = () => Array.from(m!.container.querySelectorAll("[data-decks-lamp]")).filter((e: any) => e.getAttribute("data-lit") === "1").map((e: any) => e.getAttribute("data-decks-lamp"));
    const seen: string[][] = [];
    const MO = (globalThis as any).MutationObserver;
    const mo = MO ? new MO(() => seen.push(lit())) : null;
    mo?.observe(m.container, { subtree: true, attributes: true, childList: true });
    const steps: [St, DeckId][] = [
      [{ A: "playing", B: "idle", C: "idle" }, "A"],
      [{ A: "playing", B: "playing", C: "idle" }, "B"],     // B starts while A fades out
      [{ A: "idle", B: "playing", C: "idle" }, "B"],
      [{ A: "idle", B: "playing", C: "playing" }, "C"],
      [{ A: "idle", B: "idle", C: "playing" }, "C"],
      [{ A: "playing", B: "idle", C: "playing" }, "A"],
      [{ A: "playing", B: "idle", C: "idle" }, "A"],
    ];
    for (const [st, want] of steps) {
      await act(async () => { setStatus(st); });
      expect(lit(), JSON.stringify(st)).toEqual([want]);
    }
    mo?.disconnect();
    for (const s of seen) expect(s.length, `a DOM state with ${s.join("+") || "no"} lamps lit`).toBe(1);
  });
});
