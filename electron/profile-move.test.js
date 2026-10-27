// A profile folder moves only after everything lets go of it, and a refusal names the real holder (electron/profile-move.js).
// Jeff, 2026-10-26: signing in on a new computer (4.6.64) failed with "a file was still in use", every time.
// The lock tests use REAL Windows locks and the REAL "who holds it" query (Restart Manager, file-lockers-win.js).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
const { moveProfileReleasing, profileInUseMessage } = require("./profile-move");
const { whoHolds } = require("./file-lockers-win");

const WIN = process.platform === "win32";
let root, from, to;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "profile-move-"));
  from = path.join(root, "_pending"); to = path.join(root, "ETH-STN-TEST");
  fs.mkdirSync(path.join(from, "logs"), { recursive: true });
  fs.writeFileSync(path.join(from, "openair.db"), "db");
  fs.writeFileSync(path.join(from, "logs", "rotation.log"), "x");
});
afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

const base = (over = {}) => ({ from, to, tries: 3, waitMs: 50, whoHolds, daemonPid: () => null, ...over });

describe("moveProfileReleasing", () => {
  it.runIf(WIN)("a file held open blocks the move; once release() closes it, the move goes through and Ether reopens on the new folder", async () => {
    const fd = fs.openSync(path.join(from, "openair.db"), "r+");
    let reopenedOn = null;
    const r = await moveProfileReleasing(base({
      release: async () => { fs.closeSync(fd); return [{ name: "show-log worker", ok: true, how: "closed" }]; },
      reacquire: (moved) => { reopenedOn = moved ? "new" : "old"; },
    }));
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(to, "openair.db"))).toBe(true);
    expect(fs.existsSync(from)).toBe(false);
    expect(reopenedOn).toBe("new");
  });

  it.runIf(WIN)("the control: without the release, the same open file makes Windows refuse the rename", () => {
    const fd = fs.openSync(path.join(from, "openair.db"), "r+");
    try { expect(() => fs.renameSync(from, to)).toThrow(/EPERM|EBUSY|EACCES/); }
    finally { fs.closeSync(fd); }
  });

  it.runIf(WIN)("a holder inside Ether that did not let go is named as Ether, the folder is untouched, and Ether reopens on it", async () => {
    const fd = fs.openSync(path.join(from, "logs", "rotation.log"), "r+");   // this process = "Ether's main program"
    let reopenedOn = null;
    try {
      const r = await moveProfileReleasing(base({ release: async () => [], reacquire: (m) => { reopenedOn = m ? "new" : "old"; } }));
      expect(r.ok).toBe(false);
      expect(r.error).toBe("profile_in_use");
      expect(r.holders.map((h) => h.pid)).toContain(process.pid);
      expect(r.detail).toMatch(/Ether's main program still had a file in it open/);
      expect(fs.existsSync(path.join(from, "openair.db"))).toBe(true);
      expect(reopenedOn).toBe("old");
    } finally { fs.closeSync(fd); }
  }, 30000);

  it.runIf(WIN)("another program holding a file is named by Windows, not blamed on Ether", async () => {
    const held = path.join(from, "openair.db");
    const child = spawn(process.execPath, ["-e", `const fs=require('fs');fs.openSync(${JSON.stringify(held)},'r+');console.log('held');setInterval(()=>{},1000)`], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      await new Promise((res) => child.stdout.once("data", res));
      const r = await moveProfileReleasing(base({ release: async () => [], reacquire: () => {} }));
      expect(r.ok).toBe(false);
      expect(r.holders.map((h) => h.pid)).toContain(child.pid);
      expect(r.detail).toMatch(new RegExp(`process ${child.pid}\\) has a file in it open`));
      expect(r.detail).not.toMatch(/Ether's main program/);
    } finally { child.kill(); }
  }, 30000);

  it("a part of Ether that failed to release is named even when Windows names no one", () => {
    const m = profileInUseMessage({ heldBy: [{ name: "audio engine", ok: false, error: "pid 9 still running after 8 s" }], holders: [] });
    expect(m).toMatch(/audio engine still had a file in it open/);
  });

  it("the audio engine's pid is named as the audio engine", () => {
    const m = profileInUseMessage({ holders: [{ pid: 4242, process: "Ether" }], daemonPid: 4242, selfPid: 1 });
    expect(m).toMatch(/Ether's audio engine still had a file in it open/);
  });

  it("nobody named and everything released: says so, blames no one", () => {
    const m = profileInUseMessage({ heldBy: [{ name: "show-log worker", ok: true }], holders: [] });
    expect(m).toMatch(/Windows did not say which program/);
  });

  it("a non-lock failure is not retried and still reopens", async () => {
    let tries = 0, reopened = false;
    const r = await moveProfileReleasing(base({
      release: async () => [],
      rename: () => { tries++; const e = new Error("no such dir"); e.code = "ENOENT"; throw e; },
      whoHolds: async () => [],
      reacquire: () => { reopened = true; },
    }));
    expect(r.ok).toBe(false);
    expect(tries).toBe(1);
    expect(reopened).toBe(true);
  });
});

describe("main.js: every path that moves or removes a profile folder releases everything first", () => {
  const src = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  const body = (marker) => { const i = src.indexOf(marker); return src.slice(i, src.indexOf("\n});", i)); };

  it("sign-in (profile:adopt) moves through moveProfileReleasing — no bare rename left", () => {
    const b = body('ipcMain.handle("profile:adopt"');
    expect(b).toMatch(/moveProfileReleasing\(/);
    expect(b).toMatch(/release: \(\) => _releaseActiveProfile\(/);
    expect(b).not.toMatch(/fs\.renameSync\(/);
  });

  it("the release gates main, stops the engine client so it cannot respawn, waits for the engine to exit, closes the workers", () => {
    const i = src.indexOf("async function _releaseActiveProfile");
    const b = src.slice(i, src.indexOf("\n}\n", i));
    expect(b).toMatch(/setRestoreGate\(/);
    expect(b).toMatch(/audiodClient\.stop\(\)/);
    expect(b).toMatch(/_waitPidGone\(/);
    expect(b).toMatch(/dbHolders\.releaseAll\(\)/);
    expect(b).toMatch(/db\.close\(\)/);
  });

  it("the factory-reset wipe releases everything before removing the folder, and reports the named holder", () => {
    const i = src.indexOf("async function _wipeLocalIdentityAndData");
    const b = src.slice(i, src.indexOf("\n}\n", i));
    expect(b.indexOf("_releaseActiveProfile(")).toBeGreaterThan(-1);
    expect(b.indexOf("_releaseActiveProfile(")).toBeLessThan(b.indexOf("rm(profileDir)"));
    expect(b).toMatch(/profileInUseMessage\(/);
  });
});
