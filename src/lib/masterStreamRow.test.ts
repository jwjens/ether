// Item 12: Master Out → Station → "Stream" was always "—". It now shows this station's stream as the encoder reports it.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
const mo = fs.readFileSync(path.join(__dirname, "..", "components", "MasterOutput.tsx"), "utf8");
describe("Master Out Stream row", () => {
  it("reads stream-manager:status for the station; no fixed dash", () => {
    expect(mo).not.toMatch(/label="Stream" value="—"/);
    expect(mo).toMatch(/invoke\?\.\("stream-manager:status", stationId\)/);
    expect(mo).toMatch(/live: \["var\(--status-live\)", "ON AIR"\]/);
  });
});
