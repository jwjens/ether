// src/lib/programLogRows.test.ts — Program Log slice 1 (docs/program-log-one-surface-2026-09-17.md §1)
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  dayWindow, localDateStr, localHour, fmtClock, toEntries, slotTypeOf, hoursToRender, showForHour,
  type ScheduleGetRow,
} from "./programLogRows";

// Node re-reads TZ at runtime (v13+), so the DST cases run in a zone that HAS DST regardless of the box.
const ORIG_TZ = process.env.TZ;
beforeAll(() => { process.env.TZ = "America/Los_Angeles"; });
afterAll(() => { if (ORIG_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIG_TZ; });

function row(p: Partial<ScheduleGetRow> & { id: number; scheduled_at: number }): ScheduleGetRow {
  return {
    uuid: `u${p.id}`, song_id: 1, title: `t${p.id}`, artist: "a", file_key: null, file_path: null,
    duration_s: 180, category_id: null, source: null, state: "pending", content_class: "MUSIC", channel: null,
    played_at: null, ...p,
  };
}

describe("dayWindow — local midnight, the way schedule:generateDay builds it", () => {
  it("is [local midnight, +86400) on an ordinary day", () => {
    const { dayStart, dayEnd } = dayWindow("2026-09-17");
    expect(new Date(dayStart * 1000).getHours()).toBe(0);
    expect(new Date(dayStart * 1000).getDate()).toBe(17);
    expect(dayEnd - dayStart).toBe(86_400);
    // identical to main.js: new Date(ts*1000).setHours(0,0,0,0)
    const dayBase = new Date(dayStart * 1000 + 5 * 3600 * 1000); dayBase.setHours(0, 0, 0, 0);
    expect(Math.floor(dayBase.getTime() / 1000)).toBe(dayStart);
  });
  it("is NOT the UTC date: localDateStr of a late-evening Pacific instant names the local day", () => {
    const d = new Date(2026, 8, 17, 19, 30); // 19:30 PDT = 02:30Z next day
    expect(d.toISOString().slice(0, 10)).toBe("2026-09-18"); // the old todayStr() — tomorrow
    expect(localDateStr(d)).toBe("2026-09-17");
  });
});

describe("hour rows on DST days — getHours(), never (ts − dayStart) / 3600", () => {
  it("spring forward (2026-03-08, 23 local hours): 03:00 files under 3, not under the missing 2", () => {
    const { dayStart, dayEnd } = dayWindow("2026-03-08");
    // the wall clock jumps 01:59:59 → 03:00:00; the window still spans 86 400 s, i.e. through 01:00 next day
    const at0130 = dayStart + 90 * 60;
    const at0300 = dayStart + 2 * 3600; // 2 h after midnight IS 03:00 wall clock
    expect(localHour(at0130)).toBe(1);
    expect(localHour(at0300)).toBe(3);
    expect(Math.floor((at0300 - dayStart) / 3600)).toBe(2); // the arithmetic the code must NOT use
    const entries = toEntries([row({ id: 1, scheduled_at: at0130 }), row({ id: 2, scheduled_at: at0300 })], "2026-03-08", new Map());
    expect(entries.map(e => e.hour)).toEqual([1, 3]);
    // the last row of the window lands past midnight on the 9th: filed by its own wall-clock hour (0)
    expect(localHour(dayEnd - 1)).toBe(0);
    expect(new Date((dayEnd - 1) * 1000).getDate()).toBe(9);
  });
  it("fall back (2026-11-01, 25 local hours): both 01:30s file under hour 1; 23:00 is hour 23, not 24", () => {
    const { dayStart, dayEnd } = dayWindow("2026-11-01");
    const firstOneThirty = dayStart + 90 * 60;            // 01:30 PDT
    const secondOneThirty = dayStart + 90 * 60 + 3600;    // 01:30 PST (the repeated hour)
    const elevenPm = dayStart + 24 * 3600;                // 24 h after midnight = 23:00 PST
    expect(localHour(firstOneThirty)).toBe(1);
    expect(localHour(secondOneThirty)).toBe(1);
    expect(localHour(elevenPm)).toBe(23);
    expect(Math.floor((elevenPm - dayStart) / 3600)).toBe(24); // the wrong answer division gives
    const entries = toEntries([
      row({ id: 3, scheduled_at: elevenPm }), row({ id: 2, scheduled_at: secondOneThirty }), row({ id: 1, scheduled_at: firstOneThirty }),
    ], "2026-11-01", new Map());
    expect(entries.map(e => [e.id, e.hour, e.position])).toEqual([[1, 1, 0], [2, 1, 1], [3, 23, 0]]);
    // The generator's window is a flat 86 400 s (main.js dayEnd = dayStart + 86_400), so on the 25-hour
    // day it ends at 22:59:59 PST: the local 23:00 hour is in the NEXT day's window, as generateDay
    // writes it. The panel shows the window the generator fills — it does not invent a 25th row.
    expect(dayEnd - dayStart).toBe(86_400);
    expect(localHour(dayEnd - 1)).toBe(22);
    expect(elevenPm).toBe(dayEnd); // 23:00 PST is exactly the (excluded) upper bound
  });
});

describe("toEntries — the ScheduledEntry shape the markup renders", () => {
  it("maps title/artist/duration/state/played_at and the category badge; positions restart per hour", () => {
    const { dayStart } = dayWindow("2026-09-17");
    const cats = new Map([[7, { id: 7, code: "A", color: "#123456" }]]);
    const rows = [
      row({ id: 10, scheduled_at: dayStart + 3600 + 10, category_id: 7, state: "played", played_at: dayStart + 3600 + 12, duration_s: 200.4 }),
      row({ id: 11, scheduled_at: dayStart + 3600 + 300, content_class: "SPOT", song_id: null, title: "Spot 1", state: "missed" }),
      row({ id: 12, scheduled_at: dayStart + 7200, state: "playing" }),
    ];
    const e = toEntries(rows, "2026-09-17", cats);
    expect(e[0]).toMatchObject({ hour: 1, position: 0, song_title: "t10", song_artist: "a", duration_ms: 200400, category_code: "A", category_color: "#123456", status: "played", played_at: dayStart + 3612, slot_type: "music", label: null, uuid: "u10", log_date: "2026-09-17" });
    expect(e[1]).toMatchObject({ hour: 1, position: 1, slot_type: "spot_break", label: "Spot 1", status: "missed", category_code: null });
    expect(e[2]).toMatchObject({ hour: 2, position: 0, status: "playing", played_at: null });
  });
  it("an empty day is an empty list, not an error; show hours still render", () => {
    expect(toEntries([], "2026-09-17", new Map())).toEqual([]);
    const shows = [{ start_hour: 0, end_hour: 0 }];
    expect(hoursToRender([], shows)).toHaveLength(24);
    expect(hoursToRender([], [])).toEqual([]);
  });
  it("hoursToRender = show hours ∪ row hours; overnight shows wrap", () => {
    expect(hoursToRender([{ hour: 14 }], [{ start_hour: 22, end_hour: 2 }])).toEqual([0, 1, 14, 22, 23]);
    expect(showForHour([{ start_hour: 22, end_hour: 2, name: "late" }], 1)?.name).toBe("late");
    expect(showForHour([{ start_hour: 22, end_hour: 2, name: "late" }], 3)).toBeUndefined();
  });
  // Fill Week receipt (2026-09-23): a week fill is only useful if the operator can SEE the hours it
  // filled, on a day that is entirely in the future.
  it("no hour is dropped for being after now — hoursToRender takes no clock, so future hours render like any other", () => {
    const allDay = [{ start_hour: 0, end_hour: 0 }];
    // every hour of a day six days out, with rows only in two of them
    expect(hoursToRender([{ hour: 3 }, { hour: 19 }], allDay)).toEqual(Array.from({ length: 24 }, (_, h) => h));
    // and with no rows at all — a freshly-picked future day before Fill Week runs
    expect(hoursToRender([], allDay)).toHaveLength(24);
    // the function's inputs are hours and shows; there is no "now" to compare against
    expect(hoursToRender.length).toBe(2);
  });
  it("KNOWN GAP (reported, deliberately NOT fixed here): an hour with neither a row nor a show does not render at all", () => {
    // A station whose grid covers 06:00-10:00 only: the other 20 hours are invisible in the Program
    // Log, before AND after now. Fill Week cannot fill them either (no clock), so the hole is real —
    // but the panel shows no empty hour to explain why. See the build report.
    const partial = [{ start_hour: 6, end_hour: 10 }];
    expect(hoursToRender([], partial)).toEqual([6, 7, 8, 9]);
    expect(hoursToRender([], partial)).not.toContain(14);
  });
  it("slotTypeOf: content_class is authoritative; song_id is the fallback", () => {
    expect(slotTypeOf({ content_class: "MUSIC", song_id: null })).toBe("music");
    expect(slotTypeOf({ content_class: "SWP", song_id: 5 })).toBe("sweeper");
    expect(slotTypeOf({ content_class: null, song_id: 5 })).toBe("music");
    expect(slotTypeOf({ content_class: null, song_id: null })).toBe("spot_break");
  });
  it("fmtClock is HH:MM:SS local; blank for null", () => {
    const { dayStart } = dayWindow("2026-09-17");
    expect(fmtClock(dayStart + 13 * 3600 + 5 * 60 + 9)).toBe("13:05:09");
    expect(fmtClock(null)).toBe("");
  });
});
