// The engine's file check never hides its own failure (Jeff, 2026-10-27: "Log the error at engine.js:1956."). 4.6.66: the
// staged engine had no electron/catalogue.js; `catch { here = null }` turned that into "every file missing" with no log
// line, and the queue never filled on OV. audiod/catalogue-check.js, audiod/engine.js _resolveLocal.
import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
const C = require("./catalogue-check");

const missingModule = () => { const e = new Error("Cannot find module '../electron/catalogue'\nRequire stack:\n- engine.js"); e.code = "MODULE_NOT_FOUND"; throw e; };
let logs, clock;
beforeEach(() => { C._said.clear(); logs = []; clock = 1_000_000; });
const check = (fp, loader = missingModule) => C.playableFile(fp, (m) => logs.push(m), loader, () => clock);

describe("a failed catalogue check is logged, with its cause and the file", () => {
  it("4.6.66's case: the module is missing → null AND a log line naming the cause", () => {
    expect(check("C:\\music\\a.mp3")).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/✗ catalogue check FAILED — MODULE_NOT_FOUND: Cannot find module '\.\.\/electron\/catalogue' — every file reads as unplayable/);
    expect(logs[0]).toMatch(/this one: C:\\music\\a\.mp3/);
  });
  it("a refill burst is one line, not a flood; it is said again every 10 minutes while it persists, with the count", () => {
    for (let i = 0; i < 40; i++) check(`C:\\music\\${i}.mp3`);
    expect(logs).toHaveLength(1);
    clock += 10 * 60 * 1000;
    check("C:\\music\\late.mp3");
    expect(logs).toHaveLength(2);
    expect(logs[1]).toMatch(/\(41 check\(s\) failed so far; this one: C:\\music\\late\.mp3\)/);
  });
  it("a different cause is its own line", () => {
    check("a.mp3");
    check("b.mp3", () => ({ playableFile: () => { throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }); } }));
    expect(logs).toHaveLength(2);
    expect(logs[1]).toMatch(/EPERM: EPERM: operation not permitted/);
  });
  it("when the catalogue loads, it answers as before and logs nothing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catcheck-"));
    const f = path.join(dir, "Here.mp3"); fs.writeFileSync(f, "x");
    try {
      expect(C.playableFile(f, (m) => logs.push(m))).toBe(f);                       // the real electron/catalogue.js
      expect(C.playableFile(path.join(dir, "Gone.mp3"), (m) => logs.push(m))).toBeNull();
      expect(logs).toEqual([]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("the engine uses it — no silent catch left at the file check", () => {
  const eng = fs.readFileSync(path.join(__dirname, "engine.js"), "utf8");
  const body = eng.slice(eng.indexOf("  _resolveLocal(fp) {"), eng.indexOf("\n  }\n", eng.indexOf("  _resolveLocal(fp) {")));
  it("_resolveLocal goes through catalogue-check with the engine's log", () => {
    expect(body).toMatch(/require\('\.\/catalogue-check'\)\.playableFile\(fp, \(m\) => this\._log\(m\)\)/);
    expect(body).not.toMatch(/catch \{ here = null; \}/);
  });
  it("and the module stays a staged engine file that pulls electron/catalogue.js into the stage", () => {
    expect(require("./engine-fingerprint").daemonAppFiles(__dirname)).toContain("electron/catalogue.js");
  });
});
