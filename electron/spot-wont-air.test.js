// "Any spot" breaks never pick a spot the Spots screen marks ⚠ WON'T AIR (inactive, or no category) — Jeff, 2026-10-30.
// electron/generate-core.js SPOT_SELECT / SPOT_SELECT_BY_CATEGORY + _pickSpot, on a real SQLite table.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");
const { _test } = require_("./generate-core");

function db() {
  const d = new DatabaseSync(":memory:");
  d.exec(`CREATE TABLE spots (id INTEGER PRIMARY KEY, station_id INTEGER, title TEXT, advertiser TEXT, file_path TEXT,
    length_sec REAL, last_played_at INTEGER, max_plays_day INTEGER, is_active INTEGER, deleted_at TEXT,
    spot_type TEXT, spot_category_id INTEGER, start_date TEXT, end_date TEXT)`);
  const ins = d.prepare(`INSERT INTO spots (id, station_id, title, file_path, is_active, spot_category_id, spot_type, last_played_at)
                         VALUES (?, 1, ?, ?, ?, ?, ?, ?)`);
  ins.run(1, "no category (WON'T AIR), longest waiting", "a.mp3", 1, null, null, 0);
  ins.run(2, "inactive (WON'T AIR)", "b.mp3", 0, 5, null, 0);
  ins.run(3, "categorised", "c.mp3", 1, 5, "commercial", 100);
  return d;
}
const pick = (d, sql, f) => _test._pickSpot(d.prepare(sql), f, 1, "2026-10-30", new Map(), new Map());

describe("spot breaks", () => {
  it('an "Any spot" category break never picks a WON\'T AIR spot, even the one waiting longest', () => {
    expect(pick(db(), _test.SPOT_SELECT_BY_CATEGORY, null)?.id).toBe(3);
  });
  it("a clock spot break (any type) never picks one either", () => {
    expect(pick(db(), _test.SPOT_SELECT, null)?.id).toBe(3);
  });
  it("with only WON'T AIR spots left, nothing is picked", () => {
    const d = db(); d.exec("DELETE FROM spots WHERE id = 3");
    expect(pick(d, _test.SPOT_SELECT_BY_CATEGORY, null)).toBeNull();
    expect(pick(d, _test.SPOT_SELECT, null)).toBeNull();
  });
});
