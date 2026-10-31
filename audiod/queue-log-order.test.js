// Up Next → Play Next / Move Up / Move Down / Move to Bottom / drag (dead-controls item 26): the move is made in the log,
// so the 2 s rebuild from generated_schedule keeps it instead of snapping it back. Real SQLite.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");
const { applyLogReorder, planLogReorder } = require_("./queue-log-order");

function db() {
  const d = new DatabaseSync(":memory:");
  d.exec(`CREATE TABLE generated_schedule (id INTEGER PRIMARY KEY, station_id INTEGER, title TEXT, scheduled_at INTEGER,
          log_hour_ts INTEGER, state TEXT, source TEXT, updated_at TEXT, deleted_at TEXT)`);
  const ins = d.prepare("INSERT INTO generated_schedule (id, station_id, title, scheduled_at, log_hour_ts, state) VALUES (?, 1, ?, ?, 3600, 'pending')");
  ins.run(1, "one", 3600); ins.run(2, "two", 3800); ins.run(3, "three", 4000); ins.run(4, "four", 4200);
  return d;
}
// What the reader reads: log order (log hour, scheduled_at, id) — loggen.readLog.
const logOrder = (d) => d.prepare("SELECT id FROM generated_schedule WHERE station_id = 1 AND deleted_at IS NULL ORDER BY COALESCE(log_hour_ts, scheduled_at), scheduled_at, id").all().map(r => r.id);

describe("Up Next moves write the log", () => {
  it("Play Next: the moved row takes the first place and the rest keep their order", () => {
    const d = db();
    expect(applyLogReorder(d, 1, [3, 1, 2, 4])).toEqual({ ok: true, moved: 3 });
    expect(logOrder(d)).toEqual([3, 1, 2, 4]);
    const r = d.prepare("SELECT scheduled_at, source FROM generated_schedule WHERE id = 3").get();
    expect(r).toEqual({ scheduled_at: 3600, source: "operator" });                 // Generate keeps it
    expect(d.prepare("SELECT source FROM generated_schedule WHERE id = 4").get().source).toBeNull();   // untouched row
  });
  it("Move Down and Move to Bottom", () => {
    const d = db();
    applyLogReorder(d, 1, [2, 1, 3, 4]);
    expect(logOrder(d)).toEqual([2, 1, 3, 4]);
    applyLogReorder(d, 1, [1, 3, 4, 2]);
    expect(logOrder(d)).toEqual([1, 3, 4, 2]);
  });
  it("the same places stay in use — no row gets a time that was not already in the log", () => {
    const d = db();
    applyLogReorder(d, 1, [4, 3, 2, 1]);
    const times = d.prepare("SELECT scheduled_at FROM generated_schedule ORDER BY scheduled_at").all().map(r => r.scheduled_at);
    expect(times).toEqual([3600, 3800, 4000, 4200]);
  });
  it("only a plan moves: a row that aired meanwhile refuses the whole move, nothing written", () => {
    const d = db();
    d.exec("UPDATE generated_schedule SET state = 'played' WHERE id = 2");
    const r = applyLogReorder(d, 1, [3, 1, 2, 4]);
    expect(r.ok).toBe(false);
    expect(logOrder(d)).toEqual([1, 2, 3, 4]);
    expect(d.prepare("SELECT COUNT(*) n FROM generated_schedule WHERE source = 'operator'").get().n).toBe(0);
  });
  it("a row gone from the log (regenerated) refuses the move", () => {
    expect(planLogReorder([1, 9], [{ id: 1, scheduled_at: 1, log_hour_ts: null, state: "pending" }]).ok).toBe(false);
  });
  it("the engine's reorder goes through it on the log reader, and the Program Log is told", () => {
    const eng = readFileSync(join(__dirname, "engine.js"), "utf8");
    expect(eng).toMatch(/require\("\.\/queue-log-order"\)\.applyLogReorder\(this\.db, this\.stationId, ids\)/);
    expect(eng).toMatch(/this\.emit\("log-row-moved"/);
    expect(readFileSync(join(__dirname, "..", "electron", "main.js"), "utf8")).toMatch(/m\.event === "log-row-moved"\) _scheduleChanged/);
  });
});
