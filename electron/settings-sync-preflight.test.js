// Settings opens at once (Jeff, 2026-10-29: "opening Settings still freezes Ether for at least 5 seconds ... fix the root
// cause so Settings is usable the moment it appears; anything slow loads in the background and fills in when ready").
// The installed 4.6.68's stall-sense named it: `ipc sync:preflight 8836 ms` and `9962 ms`, held in its journal counts —
// byOrigin reads the whole `mutations` journal (no index on origin): 12.8 s cold on OVEVENTS' 200,695 rows, on main's
// thread. The counts now come from sync:preflight-journal on the screen-read worker (screen-read-queries.js syncJournal);
// the worker half against a real database copy is scripts/smoke-screen-reads.js (D).
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
const Database = require_("better-sqlite3");
const Q = require_("./screen-read-queries");

const main = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
const handler = (name) => {
  const a = main.indexOf(`ipcMain.handle(${name}`);
  expect(a, name).toBeGreaterThan(0);
  return main.slice(a, main.indexOf("\n});", a));
};

describe("Settings never waits on the sync journal", () => {
  it("sync:preflight — called the moment Settings opens — reads nothing from the journal", () => {
    const h = handler("'sync:preflight'");
    expect(h).not.toMatch(/FROM mutations/);
    expect(h).toMatch(/schedulerRunning/);   // still answers the instant part
  });

  it("the journal counts are counted on the screen-read worker; main only waits on its message", () => {
    const h = handler("'sync:preflight-journal'");
    expect(h).toMatch(/await _screenReads\.fn\('syncJournal', excluded\)/);
    expect(h).not.toMatch(/\.prepare\(|getDb\(\)/);
  });

  it("Settings shows the section first and fills the counts in when they arrive", () => {
    const sp = fs.readFileSync(path.join(__dirname, "..", "src", "components", "SettingsPanel.tsx"), "utf8");
    const a = sp.indexOf("const refresh = async () => {");
    const body = sp.slice(a, sp.indexOf("\n  };", a));
    expect(body.indexOf('"sync:preflight"')).toBeGreaterThan(0);
    expect(body.indexOf("setBusy(null)")).toBeLessThan(body.indexOf('"sync:preflight-journal"'));   // buttons free first
    expect(sp).toMatch(/counting…/);
    expect(sp).toMatch(/disabled=\{busy !== null \|\| !pf\?\.ok \|\| !pf\?\.mutations\}/);       // Clear quotes the counts
  });
});

describe("syncJournal gives the same answers the panel had", () => {
  it("pending vs waiting to sync vs journal only, totals, origin, statuses and song deletes", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE mutations (id INTEGER PRIMARY KEY, table_name TEXT, op TEXT, sync_status TEXT, origin TEXT)`);
    const add = db.prepare("INSERT INTO mutations (table_name, op, sync_status, origin) VALUES (?, ?, ?, ?)");
    for (let i = 0; i < 5; i++) add.run("songs", "update", "pending", "local");
    for (let i = 0; i < 7; i++) add.run("generated_schedule", "create", "pending", "local");   // never sent
    for (let i = 0; i < 3; i++) add.run("songs", "DELETE", "synced", "remote");
    add.run("categories", "update", "conflicted", "remote");
    const j = Q.syncJournal(db, ["generated_schedule", "install_secrets_kv", "monitor_routing"]);
    expect(j).toEqual({
      pending: 12, pendingPushable: 5, pendingJournalOnly: 7, total: 16,
      byStatus: [{ sync_status: "pending", n: 12 }, { sync_status: "synced", n: 3 }, { sync_status: "conflicted", n: 1 }],
      byOrigin: [{ origin: "local", n: 12 }, { origin: "remote", n: 4 }],
      songDeletes: 3,
    });
    expect(Q.syncJournal(db, []).pendingPushable).toBe(12);
  });
});
