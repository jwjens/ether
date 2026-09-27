// fix 6 + 7 (docs/help-audit-2026-09-27.md): the BMI / ASCAP royalty exports wrote a made-up duration on every row
// ("3:30" / "3.5") and only covered the 200 rows on screen. They must carry each play's real length from play_log and
// every play in the period.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { royaltyCsv, ROYALTY_SQL, fmtMinSec, fmtMinutes } from "./royalty";

const day = new Date(2026, 8, 25).getTime() / 1000;
// A 1,000-play day: every play a different real length (60–359 s), some with no recorded length.
const plays = Array.from({ length: 1000 }, (_, i) => ({
  played_at: day + i * 80, title: `Song ${i}`, artist: i % 7 ? `Artist ${i % 50}` : null,
  duration_ms: i % 97 === 0 ? null : (60 + (i % 300)) * 1000,
}));

describe("royalty exports — real durations, every play (audit 6, 7)", () => {
  it("BMI: 1,000 plays in → 1,000 rows out, each with its own m:ss", () => {
    const csv = royaltyCsv("bmi", plays, "Test FM");
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("Title,Performer,Date Of Use,Time Of Use,Duration");
    expect(lines.length - 1).toBe(1000);
    expect(lines[2]).toContain(`"${fmtMinSec(61000)}"`);          // play 1 is 61 s → 1:01
    expect(lines.filter(l => l.endsWith('"3:30"')).length).toBeLessThan(10);   // no placeholder flood
  });

  it("ASCAP: 1,000 rows, duration in minutes from the real length", () => {
    const csv = royaltyCsv("ascap", plays, "Test FM");
    const lines = csv.trim().split("\n");
    expect(lines.length - 1).toBe(1000);
    expect(lines[2]).toContain(`"${fmtMinutes(61000)}"`);         // 1.02 min
    expect(lines[2]).toContain('"Test FM"');
  });

  it("an unknown length is left blank — never invented", () => {
    const bmi = royaltyCsv("bmi", [{ played_at: day, title: "X", artist: "Y", duration_ms: null }], "S").trim().split("\n")[1];
    expect(bmi.endsWith('""')).toBe(true);
    expect(fmtMinSec(210000)).toBe("3:30");
    expect(fmtMinutes(210000)).toBe("3.50");
  });

  it("the export query covers the whole period: no row cap", () => {
    expect(ROYALTY_SQL).not.toMatch(/LIMIT/i);
    expect(ROYALTY_SQL).toMatch(/duration_ms/);
  });

  it("Logs.tsx builds BMI / ASCAP from that query, not from the 200-row screen list or a fixed duration", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "Logs.tsx"), "utf8");
    expect(src).not.toMatch(/"3:30"|"3\.5"/);
    expect(src).toMatch(/royaltyCsv\(/);
  });
});
