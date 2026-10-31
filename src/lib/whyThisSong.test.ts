// fix 18 (docs/held-items-proposals-2026-09-27.md; Jeff's GO 2026-09-27): per-row pick reasons were recorded on every
// generated row (generated_schedule.pick_reason) and shown nowhere — `rotation:explain` existed and nothing called
// it. Clicking a music row in the Program Log now shows "Why this song" under the title, from that IPC; Rotation
// Analytics links there instead of saying the Program Log does not show them.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { whyThisSongText } from "./whyThisSong";
const { renderReason } = require("../../electron/rotation-analytics.js");

describe("Why this song (audit 18)", () => {
  it("a recorded reason reads as the generator's own sentence", () => {
    const reasonText = renderReason({ m: "clock", cat: 4, pool: 37, veto: { artist_sep: 3, song_repeat: 0 }, relax: [] }, "Gold");
    expect(whyThisSongText({ ok: true, data: { reasonAvailable: true, reasonText } }))
      .toBe("Gold: chosen from a pool of 37 · 3 vetoed by artist sep · all separation rules satisfied");
  });
  it("no reason on the row says why, and never invents one", () => {
    expect(whyThisSongText({ ok: true, data: { reasonAvailable: false, reasonText: null } }))
      .toMatch(/no reason recorded — this row was generated before reasons were kept, or placed by hand/i);
    expect(whyThisSongText({ ok: true, data: null })).toMatch(/row is no longer in the log/i);
    expect(whyThisSongText({ ok: false, error: "db closed" })).toMatch(/couldn't read the reason: db closed/i);
  });
  it("the Program Log asks rotation:explain for the clicked music row and shows it under the title", () => {
    const pl = fs.readFileSync(path.join(__dirname, "..", "components", "ProgramLog.tsx"), "utf8");
    expect(pl).toMatch(/invoke\?\.\("rotation:explain", stationId, entry\.id\)/);
    expect(pl).toMatch(/Why this song/);
  });
  it("Rotation Analytics links to the Program Log instead of saying it shows nothing", () => {
    const ra = fs.readFileSync(path.join(__dirname, "..", "components", "RotationAnalytics.tsx"), "utf8");
    expect(ra).not.toMatch(/the Program Log does not show them yet/);
    expect(ra).toMatch(/ether:open-programlog/);
  });
});

describe("Why this song reads the one pick's marks (Jeff, 2026-10-31)", () => {
  const names: Record<number, string> = { 4: "Gold", 7: "Recurrent" };
  const nameOf = (id: number) => names[id] ?? null;
  it("a normal pick, a SOFT rule relaxed, and a STRICT max-in-a-row move", () => {
    expect(renderReason({ m: "one-pick", cat: 4, slotCat: 4, passing: 33, ties: 1 }, "Gold", nameOf))
      .toBe("Gold: the song that waited longest of 33 that met every rule");
    expect(renderReason({ m: "one-pick", cat: 4, slotCat: 4, passing: 5, ties: 1, soft: { rule: "artist", settingMin: 60, measuredMin: 42 } }, "Gold", nameOf))
      .toMatch(/SOFT rule relaxed: same artist \(42 of 60 min\)/);
    expect(renderReason({ m: "one-pick", cat: 7, slotCat: 4, passing: 9, ties: 1, maxRow: { moved: true, from: 4, to: 7, max: 3, strict: true } }, "Recurrent", nameOf))
      .toMatch(/max 3 in a row \(STRICT\): moved from Gold to Recurrent/);
  });
  it("a STRICT rule broken as the last resort, and a SOFT max-in-a-row broken", () => {
    expect(renderReason({ m: "least-recent", cat: 4, broke: { rule: "song", settingMin: 120, measuredMin: 80 } }, "Gold", nameOf))
      .toBe("Gold: no song met the rules, so the least recently played song went in · STRICT rule broken as the last resort: same song (80 of 120 min)");
    expect(renderReason({ m: "one-pick", cat: 4, slotCat: 4, passing: 30, ties: 1, maxRow: { broken: true, max: 3, strict: false, inRow: 4 } }, "Gold", nameOf))
      .toMatch(/max 3 in a row \(SOFT\) broken — 4 in a row/);
  });
});
