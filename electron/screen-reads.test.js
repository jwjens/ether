// A screen's database reads never run on the main thread (electron/screen-reads.js; Jeff, 2026-10-26: "Screen switching
// freezes the audio. Nothing on the air path may depend on the screen."). The database half — the worker answering every
// typed read channel on its own read-only connection while main stays on time — is scripts/smoke-screen-reads.js.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
const { isScreenRead, routeScreenReads } = require("./screen-reads");

const main = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
const handler = (name) => {
  const a = main.indexOf(`ipcMain.handle(${name}`);
  expect(a).toBeGreaterThan(0);
  return main.slice(a, main.indexOf("\n});", a));
};

describe("screen reads off the main thread", () => {
  it("classifies the typed read verbs as reads and every write verb as a write", () => {
    for (const ch of ["songs:list", "songs:get-by-id", "songs:get-by-int-id", "station_config_kv:get-value", "sync:refs", "pinned_songs:list-by-song", "x:counts", "x:get"]) expect(isScreenRead(ch)).toBe(true);
    for (const ch of ["songs:create", "songs:update", "songs:delete", "songs:update-by-id", "songs:mark-played", "x:upsert", "x:set-pin", "x:bulk-apply", "x:find-or-create-by-name", "list", ""]) expect(isScreenRead(ch)).toBe(false);
  });

  it("a read channel is answered by the worker host and never by the handler main would have run", async () => {
    const installed = new Map();
    const ipc = { handle: (ch, fn) => installed.set(ch, fn), on() {}, removeHandler() {} };
    const calls = [];
    const host = { channel: async (ch, args) => { calls.push([ch, args]); return { ok: true, rows: ["from the worker"] }; } };
    const r = routeScreenReads(ipc, host);
    let mainRan = false;
    r.handle("songs:list", () => { mainRan = true; return { ok: true, rows: ["from main"] }; });
    const write = () => ({ ok: true, row: "written on main" });
    r.handle("songs:create", write);
    expect(await installed.get("songs:list")(null, { stationId: 2 })).toEqual({ ok: true, rows: ["from the worker"] });
    expect(mainRan).toBe(false);
    expect(calls).toEqual([["songs:list", [{ stationId: 2 }]]]);
    expect(installed.get("songs:create")).toBe(write);   // writes stay on main, unchanged
    expect(r.routed).toEqual(["songs:list"]);
  });

  it("a worker that cannot answer gives the screen an error, not a stall", async () => {
    const installed = new Map();
    const r = routeScreenReads({ handle: (ch, fn) => installed.set(ch, fn) }, { channel: async () => { throw new Error("worker stopped"); } });
    r.handle("songs:list", () => ({ ok: true }));
    expect(await installed.get("songs:list")(null)).toEqual({ ok: false, error: "worker stopped" });
  });

  it("main's db:query, schedule:get and schedule:categoryHealth wait on the worker, never on SQLite", () => {
    for (const name of ['"db:query"', "'schedule:get'", "'schedule:categoryHealth'"]) {
      const h = handler(name);
      expect(h).toMatch(/await _screenReads\./);
      expect(h).not.toMatch(/\.prepare\(/);
    }
    expect(main).toMatch(/installAll\(ipc, getDb\)/);
    expect(main).toMatch(/routeScreenReads\(ipcMain, _screenReads\)/);
    expect(main).toMatch(/dbHolders\.register\("screen-read worker"/);
  });

  it("the Health screen's poll never runs a subprocess synchronously", () => {
    const c = main.slice(main.indexOf("async function cachedStartupStatus"), main.indexOf("\n}", main.indexOf("async function cachedStartupStatus")));
    expect(c).toMatch(/startupStatusAsync\(\)/);
    expect(c).not.toMatch(/startupStatus\(\)/);
    expect(handler('"ha:dashboard"')).toMatch(/await cachedStartupStatus\(\)/);
    expect(handler('"ha:status"')).toMatch(/await cachedStartupStatus\(\)/);
    const win = fs.readFileSync(path.join(__dirname, "..", "watchdog", "platform", "win32.js"), "utf8");
    const a = win.slice(win.indexOf("function startupStatusAsync"), win.indexOf("\n}", win.indexOf("function startupStatusAsync")));
    expect(a).toMatch(/execFile\(/);
    expect(a).not.toMatch(/spawnSync/);
  });
});
