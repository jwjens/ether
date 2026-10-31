// Item 3: Voice Tracker → Send to Deck A/B/C dispatched "ether:deck-load", which nothing listens for. It now loads the
// take's file through the one deck load (audio:load), and says so when the deck refuses it.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
const vt = fs.readFileSync(path.join(__dirname, "..", "components", "VoiceTracker.tsx"), "utf8");
describe("Voice Tracker → deck", () => {
  it("uses audio:load with the take's file on the active station", () => {
    expect(vt).toMatch(/ether\.audio\.load\(deck, fp, "\[VT\] " \+ takeTitle\(\), "", 0, stationId\)/);
    expect(vt).not.toMatch(/"ether:deck-load"/);
  });
  it("a refused load is an error, not a discarded take", () => {
    expect(vt).toMatch(/did not load the take/);
  });
});
