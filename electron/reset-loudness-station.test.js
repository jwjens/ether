// Song Analysis → Reset (Jeff, 2026-10-31): only the active station's songs (songs in its categories), and only after
// Ether's own confirm window. It cleared every song on the computer, with no question.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");
const read = (p) => readFileSync(join(__dirname, "..", p), "utf8");

describe("reset loudness: this station's songs only", () => {
  it("the query clears songs in the station's categories and nothing else", () => {
    const src = read("electron/sync/handlers/songs.js");
    const sql = src.match(/SELECT s\.\* FROM \$\{TABLE\} s JOIN categories c[\s\S]*?\.all\(stationId\)/)[0]
      .replace("${TABLE}", "songs").replace(/`[\s\S]*$/, "").replace(/^SELECT/, "SELECT");
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE categories (id INTEGER PRIMARY KEY, station_id INTEGER, deleted_at TEXT);
             CREATE TABLE songs (id INTEGER PRIMARY KEY, category_id INTEGER, deleted_at TEXT);
             INSERT INTO categories VALUES (1, 2, NULL), (2, 4, NULL);
             INSERT INTO songs VALUES (10, 1, NULL), (11, 2, NULL), (12, NULL, NULL);`);
    const q = src.match(/`(SELECT s\.\* FROM \$\{TABLE\} s JOIN categories c[\s\S]*?)`/)[1].replace("${TABLE}", "songs");
    expect(db.prepare(q).all(2).map(r => r.id)).toEqual([10]);
    expect(sql).toBeTruthy();
  });
  it("no station = nothing cleared", () => {
    expect(read("electron/sync/handlers/songs.js")).toMatch(/if \(stationId == null\) return \{ ok: false, error: 'no station' \};/);
  });
  it("both Reset buttons ask in Ether's confirm window first", () => {
    for (const f of ["src/components/SettingsPanel.tsx", "src/components/ProcessingPanel.tsx"])
      expect(read(f), f).toMatch(/etherConfirm\("Clear the loudness[^"]*this station's songs/);
  });
});
