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
