// fix 17 (docs/help-audit-2026-09-27.md): the Spots panel's empty state said "Import jingles, promos, PSAs, and
// liners". Jingles/sweepers are imaging and live in the JINGLES push-up (the one imaging home), never in Spots; the
// Spots panel is for commercials and promos. The empty state names what this panel is for.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("the Spots empty state doesn't send imaging here (audit 17)", () => {
  it("no 'Import jingles'; commercials are named", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "components", "Spots.tsx"), "utf8");
    const empty = src.slice(src.indexOf("No spots yet"), src.indexOf("No spots yet") + 400);
    expect(empty).not.toMatch(/jingle/i);
    expect(empty).toMatch(/commercials/);
  });
});
