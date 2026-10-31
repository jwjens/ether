// Item 11: Settings → Audio's analysis section printed "Analyzed [object Object] songs" and promised -14 LUFS
// normalization it doesn't do (playback loudness is the Loudness target in Loudness & faders).
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
const s = fs.readFileSync(path.join(__dirname, "..", "components", "SettingsPanel.tsx"), "utf8");
describe("song analysis says what it does", () => {
  it("reports processed / failed counts, not an object", () => {
    expect(s).not.toMatch(/"Done! Analyzed " \+ count/);
    expect(s).toMatch(/Analyzed \$\{r\.processed\} song/);
  });
  it("no -14 LUFS promise; points at the real loudness target", () => {
    expect(s).not.toMatch(/Target is -14 LUFS/);
    expect(s).toMatch(/It does not change how loud songs play/);
  });
});
