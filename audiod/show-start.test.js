// AUTO turns on when a show starts — only where armed, never on the first look (audiod/show-start.js, 2026-10-18).
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
const { decideShowStarts } = createRequire(import.meta.url)("./show-start.js");

const at = (h, m) => Math.floor(new Date(2026, 10, 2, h, m, 0).getTime() / 1000);
const SHOWS = [{ id: 1, name: "Evening", days: "0123456", start_hour: 15, start_minute: 0, end_hour: 21, end_minute: 30 },
               { id: 2, name: "Late", days: "0123456", start_hour: 21, start_minute: 30, end_hour: 22, end_minute: 30 }];
const st = (over = {}) => [{ id: 7, shows: SHOWS, armed: true, started: false, ...over }];

describe("show start → AUTO on", () => {
  it("the first look after start-up only records — even mid-show", () => {
    const seen = new Map();
    expect(decideShowStarts(seen, st(), at(16, 0)).start).toEqual([]);
  });
  it("at 15:00 the Evening show starts: AUTO on", () => {
    const seen = new Map();
    decideShowStarts(seen, st(), at(14, 59));
    expect(decideShowStarts(seen, st(), at(15, 0)).start).toEqual([{ id: 7, show: "Evening" }]);
  });
  it("at 21:30 the Late show starts: AUTO on (if the operator had turned it off)", () => {
    const seen = new Map();
    decideShowStarts(seen, st(), at(21, 29));
    expect(decideShowStarts(seen, st(), at(21, 30)).start).toEqual([{ id: 7, show: "Late" }]);
  });
  it("already in AUTO: nothing to do", () => {
    const seen = new Map();
    decideShowStarts(seen, st({ started: true }), at(14, 59));
    expect(decideShowStarts(seen, st({ started: true }), at(15, 0)).start).toEqual([]);
  });
  it("not armed on this machine (the operator's last press was MANUAL/STOP, or never AUTO here): left alone, and said so", () => {
    const seen = new Map();
    decideShowStarts(seen, st({ armed: false }), at(14, 59));
    const d = decideShowStarts(seen, st({ armed: false }), at(15, 0));
    expect(d.start).toEqual([]);
    expect(d.notArmed).toEqual([{ id: 7, show: "Evening" }]);
  });
  it("inside a show, and when the show ends with nothing after it: no start", () => {
    const seen = new Map();
    decideShowStarts(seen, st(), at(15, 0));
    expect(decideShowStarts(seen, st(), at(16, 0)).start).toEqual([]);
    expect(decideShowStarts(seen, st(), at(22, 30)).start).toEqual([]);
    expect(decideShowStarts(seen, st(), at(23, 0)).start).toEqual([]);
  });
  it("the next day's show starts: AUTO on again", () => {
    const seen = new Map();
    decideShowStarts(seen, st(), at(22, 45));
    expect(decideShowStarts(seen, st(), at(15, 0) + 86400).start).toEqual([{ id: 7, show: "Evening" }]);
  });
});
