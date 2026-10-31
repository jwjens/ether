// Item 20: the EAS Logbook's date-time box round-trips without shifting (it moved by the UTC offset on every save).
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { toLocalInput } from "./localDateTime";

describe("date-time box in local time", () => {
  it("what is shown reads back as the same moment (to the minute), whatever the zone", () => {
    const t = Date.UTC(2026, 9, 31, 16, 45, 0);
    expect(new Date(toLocalInput(t)).getTime()).toBe(t);
    const j = Date.UTC(2026, 0, 15, 3, 7, 0);   // winter, after midnight UTC
    expect(new Date(toLocalInput(j)).getTime()).toBe(j);
  });
  it("the Logbook no longer fills its boxes from UTC", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "components", "EASLogbook.tsx"), "utf8");
    expect(src).not.toMatch(/toISOString\(\)\.slice\(0, 16\)/);
    expect(src.match(/toLocalInput\(/g)?.length).toBe(3);
  });
});
