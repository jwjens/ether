import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The ON AIR button's tooltip says "start streaming", not "go on air" (Jeff, 2026-11-02).
describe("ON AIR tooltip", () => {
  it("says Click to start streaming", () => {
    const s = readFileSync(join(__dirname, "..", "components", "GlobalOnAirBadge.tsx"), "utf8");
    expect(s).toMatch(/: "Click to start streaming"/);
    expect(s).not.toMatch(/go on air/i);
  });
});
