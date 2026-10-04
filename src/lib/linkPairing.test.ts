// Remote Link pairing, renderer side (2026-10-04).
//  · formatCodeTyping — the receiver types the sender's 8-character code; the box shows XXXX-XXXX as they type.
//  · linkNeedsPatch — a fader whose source is Link is patched in THIS machine's engine, always: the "set to Link but not
//    patched — pick Link again" state Jeff hit (a first pick before the Link settings loaded returned silently, and a
//    kind that arrived by sync from the other computer was never patched here).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { formatCodeTyping, codeComplete, linkNeedsPatch } from "./linkPairing";

describe("formatCodeTyping", () => {
  it("upper-cases, drops what is not in the alphabet, inserts the dash", () => {
    expect(formatCodeTyping("k7qd")).toBe("K7QD");
    expect(formatCodeTyping("k7qd2")).toBe("K7QD-2");
    expect(formatCodeTyping("k7qd 2xmf")).toBe("K7QD-2XMF");
    expect(formatCodeTyping("K7QD-2XMF-EXTRA")).toBe("K7QD-2XMF");
    expect(formatCodeTyping("O0I1L")).toBe("", );   // look-alikes are not in the alphabet
  });
  it("complete only at 8", () => {
    expect(codeComplete("K7QD-2XM")).toBe(false);
    expect(codeComplete("K7QD-2XMF")).toBe(true);
  });
});

describe("linkNeedsPatch", () => {
  const base = { isLink: true, cfgLoaded: true, daemon: true, slot: "S1", inputSlot: null as string | null };
  it("Link fader, settings loaded, nothing patched → patch it", () => {
    expect(linkNeedsPatch(base)).toBe(true);
  });
  it("already patched on this fader → no", () => {
    expect(linkNeedsPatch({ ...base, inputSlot: "S1" })).toBe(false);
  });
  it("the station's Link is on ANOTHER fader → never steal it", () => {
    expect(linkNeedsPatch({ ...base, inputSlot: "D" })).toBe(false);
  });
  it("settings not loaded yet / no engine service / not a Link fader → not yet", () => {
    expect(linkNeedsPatch({ ...base, cfgLoaded: false })).toBe(false);
    expect(linkNeedsPatch({ ...base, daemon: false })).toBe(false);
    expect(linkNeedsPatch({ ...base, isLink: false })).toBe(false);
  });
});

describe("SourceChannelStrip wiring (source contract — the component has no harness here)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "components", "SourceChannelStrip.tsx"), "utf8").replace(/\r\n/g, "\n");
  it("patches through an effect driven by linkNeedsPatch — not only on the dropdown pick", () => {
    expect(src).toMatch(/useEffect\(\(\) => \{[\s\S]{0,400}linkNeedsPatch\(\{[\s\S]{0,400}linkTo\(true\)/);
  });
  it("never returns silently when the settings have not loaded", () => {
    expect(src).not.toMatch(/if \(!link\.cfg\) return;/);
  });
  it("the strip pairs with the picker, and the raw paste is not its first-line control", () => {
    expect(src).toMatch(/<LinkPairPicker/);
    expect(src).not.toMatch(/placeholder="paste the sender's link key"/);
  });
});
