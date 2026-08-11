// The as-run affidavit export. The previous header offered eight columns and could only ever fill
// five — Clock has no column in play_log at all, and Show/Category are written null by the daemon.
// These tests pin the shape and, more importantly, what it refuses to assert.
import { describe, it, expect } from "vitest";
import { toCsv } from "../grid/csv";
import { AS_RUN_COLUMNS, fmtDuration, endTime, type AsRunRow } from "./columns";

const row = (o: Partial<AsRunRow> = {}): AsRunRow => ({
  played_at: 1_700_000_000, title: "A Song", artist: "An Artist", deck: "A",
  duration_ms: 210_000, category: "AC", advertiser: null, isci_code: null,
  cart_number: null, content_class: "MUSIC", ...o,
});

describe("as-run CSV shape", () => {
  it("has exactly the affidavit columns, in order", () => {
    expect(toCsv(AS_RUN_COLUMNS, []).split("\n")[0]).toBe(
      "Start Time,End Time,Duration,Date,Title,Artist,Deck,Category,Advertiser,ISCI,Cart Number,Status");
  });

  it("no longer carries Show or Clock", () => {
    const header = toCsv(AS_RUN_COLUMNS, []).split("\n")[0];
    expect(header).not.toContain("Show");
    expect(header).not.toContain("Clock");
  });

  it("emits a header even with no rows — never an empty file", () => {
    expect(toCsv(AS_RUN_COLUMNS, []).split("\n")).toHaveLength(1);
  });
});

describe("timing", () => {
  it("End Time is Start Time plus the duration", () => {
    // 1_700_000_000 + 210s. Compared against the same formatter so the test is timezone-independent.
    const r = row({ duration_ms: 210_000 });
    const expected = new Date((r.played_at + 210) * 1000).toLocaleTimeString("en-US", { hour12: false });
    expect(endTime(r)).toBe(expected);
  });

  it("formats duration as M:SS", () => {
    expect(fmtDuration(210_000)).toBe("3:30");
    expect(fmtDuration(30_000)).toBe("0:30");
    expect(fmtDuration(65_000)).toBe("1:05");
    expect(fmtDuration(3_600_000)).toBe("60:00");
  });

  it("rounds to the nearest second rather than truncating", () => {
    expect(fmtDuration(29_600)).toBe("0:30");
  });

  it("leaves End Time and Duration EMPTY when the length is unknown", () => {
    // Not "0:00", and End must not fall back to the start — either would assert a zero-length
    // airing, which is a false statement in a document whose whole purpose is asserting airings.
    for (const bad of [null, 0, -1]) {
      const r = row({ duration_ms: bad as any });
      expect(fmtDuration(r.duration_ms)).toBe("");
      expect(endTime(r)).toBe("");
    }
    const line = toCsv(AS_RUN_COLUMNS, [row({ duration_ms: null })]).split("\n")[1].split(",");
    expect(line[1]).toBe('""');   // End Time
    expect(line[2]).toBe('""');   // Duration
  });
});

describe("row content", () => {
  it("carries the spot fields joined from spots", () => {
    const line = toCsv(AS_RUN_COLUMNS, [row({
      title: "OV Spot", artist: "Opportunity Village", deck: "A", category: null,
      advertiser: "Opportunity Village", isci_code: "OV1234567", cart_number: "C-12",
      content_class: "SPOT", duration_ms: 30_000,
    })]).split("\n")[1];
    expect(line).toContain('"Opportunity Village"');
    expect(line).toContain('"OV1234567"');
    expect(line).toContain('"C-12"');
    expect(line).toContain('"0:30"');
  });

  it("writes empty, not the string null, for every absent field", () => {
    const cells = toCsv(AS_RUN_COLUMNS, [row({
      artist: null, deck: null, category: null, advertiser: null, isci_code: null, cart_number: null,
    })]).split("\n")[1];
    expect(cells).not.toContain("null");
    expect(cells).not.toContain("undefined");
  });

  it("says Aired on every row, because play_log only records what aired", () => {
    // Scheduled/Missed are states of generated_schedule — a spot that never aired leaves no row
    // here to label. Those belong to the Traffic view, which reads the schedule.
    const line = toCsv(AS_RUN_COLUMNS, [row()]).split("\n")[1].split(",");
    expect(line[line.length - 1]).toBe('"Aired"');
  });

  it("escapes quotes in a title", () => {
    expect(toCsv(AS_RUN_COLUMNS, [row({ title: 'The "Twilight" Zone' })]))
      .toContain('"The ""Twilight"" Zone"');
  });
});
