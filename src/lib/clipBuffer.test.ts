// Show+ ⏮ CLIP (dead-controls item 5): after 30 s the window pruned the recording's first chunk — the WebM header — so
// every later clip had no header and would not play. The header is kept and always written first.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pruneClipWindow, clipParts } from "./clipBuffer";

describe("Show+ clip buffer", () => {
  it("a clip saved long after the start still begins with the header", () => {
    const chunks = Array.from({ length: 120 }, (_, i) => ({ data: `c${i}`, ts: i * 1000 }));
    const win = pruneClipWindow(chunks, 119_000, 30);
    expect(win[0].data).toBe("c89");
    expect(clipParts("HEADER", win)[0]).toBe("HEADER");
    expect(clipParts("HEADER", win).length).toBe(win.length + 1);
  });
  it("Show+ keeps the first chunk apart and never prunes it", () => {
    const s = readFileSync(join(__dirname, "..", "components", "ShowPlus.tsx"), "utf8");
    expect(s).toMatch(/if \(!headerRef\.current\) \{ headerRef\.current = data; return; \}/);
    expect(s).toMatch(/clipParts\(headerRef\.current, chunksRef\.current\)/);
  });
});
