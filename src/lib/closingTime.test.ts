// THE ONE CLOSING-TIME WRITER (src/lib/closingTime.ts, 2026-10-13): Preferences → Announcements and the Park page's
// Save (ops:set-closing) both run it. It sets byDate[date] only — default and byWeekday untouched (THE HARD RULE) —
// and re-pushes the Park mirror so the phone's announcement times move at once.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setClosingForDates, parseClosingCfg } from "./closingTime";

let stored: string | null;
let pushes: any[];
beforeEach(() => {
  stored = JSON.stringify({ default: "16:30", byWeekday: { "5": "23:00" }, byDate: { "2026-10-12": "21:00" } });
  pushes = [];
  (globalThis as any).window = {
    ether: { stationConfigKv: {
      list: async () => ({ ok: true, rows: [{ key: "closing_time", value: stored, deleted_at: null }] }),
      upsertByKey: async (_sid: number, key: string, value: string) => { if (key === "closing_time") stored = value; },
    } },
    dispatchEvent: (e: any) => { pushes.push(e); return true; },
  };
  (globalThis as any).CustomEvent = class { type: string; detail: any; constructor(t: string, i?: any) { this.type = t; this.detail = i?.detail; } };
});

describe("setClosingForDates", () => {
  it("sets only the given dates; the every-day time and the weekday times are untouched", async () => {
    await setClosingForDates(2, ["2026-10-13"], "21:30");
    const c = parseClosingCfg(stored);
    expect(c.byDate).toEqual({ "2026-10-12": "21:00", "2026-10-13": "21:30" });
    expect(c.default).toBe("16:30");
    expect(c.byWeekday).toEqual({ "5": "23:00" });
  });
  it("re-pushes the Park mirror for that station at once", async () => {
    await setClosingForDates(2, ["2026-10-13"], "21:30");
    expect(pushes.map(e => [e.type, e.detail?.stationId])).toEqual([["ether:ops-push", 2]]);
  });
  it("is the ONLY writer: Preferences and the phone's ops:set-closing both call it (no copy of the merge)", () => {
    const app = readFileSync(join(__dirname, "..", "App.tsx"), "utf8");
    const ann = readFileSync(join(__dirname, "..", "components", "Announcements.tsx"), "utf8");
    const setClosing = app.slice(app.indexOf('case "ops:set-closing"'), app.indexOf('case "ops:set-level"'));
    expect(setClosing).toMatch(/setClosingForDates\(targetId, \[date\], time\)/);
    expect(setClosing).not.toMatch(/byDate/);
    expect(ann).toMatch(/setClosingForDates\(stationId, dates, effectiveClosing\)/);
    expect(ann).not.toMatch(/upsertByKey\(stationId, "closing_time"/);
  });
});
