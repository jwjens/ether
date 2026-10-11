// stage-engine: content-keyed staging (2026-10-10, docs/monitor-failed-test-diagnosis-2026-10-10.md).
//
// The case that matters is the one that shipped: a DIFFERENT build under the SAME version label. On OVEVENTS the
// MONITOR fix was installed as "4.6.59", version.txt already said "4.6.59", and the daemon kept the pre-fix engine.
// Every test here runs against temp dirs (baseDir) — never the machine's real %LOCALAPPDATA%\Ether\engine.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import cp from "node:child_process";

const require_ = createRequire(import.meta.url);
const { stageEngine } = require_("./stage-engine.js");
const { engineFingerprint, fileSha256 } = require_("./engine-fingerprint.js");
const realFs = require_("fs");

let tmp, srcRoot, unpacked, stage;
const put = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
const W = { platform: "win32" };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ether-stage-test-"));
  srcRoot = path.join(tmp, "install");
  unpacked = path.join(srcRoot, "resources", "app.asar.unpacked");
  stage = path.join(tmp, "engine");
  put(path.join(srcRoot, "Ether.exe"), "runtime v1");
  put(path.join(srcRoot, "icudtl.dat"), "icu");
  put(path.join(unpacked, "audiod", "ether-audiod.js"), 'require("./engine"); require("../electron/audio-library-index");');
  put(path.join(unpacked, "audiod", "engine.js"), "engine v1");
  put(path.join(unpacked, "audiod", "smoke-x.js"), "a test script — never staged");
  put(path.join(unpacked, "audiod", "engine.test.js"), "a vitest spec — never staged");
  put(path.join(unpacked, "electron", "audio-library-index.js"), "index");
  put(path.join(unpacked, "electron", "sync", "mutation-writer.js"), "mw");
  put(path.join(unpacked, "electron", "sync", "synced-tables.js"), "st");
  put(path.join(unpacked, "native", "ether-audio.node"), "PRE-FIX ENGINE");
  put(path.join(unpacked, "node_modules", "ffmpeg-static", "index.js"), "ff");
});
afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

const go = (extra = {}) => stageEngine({ srcRoot, unpacked, version: "4.6.59", baseDir: stage, ...W, ...extra });
const staged = (rel) => fs.readFileSync(path.join(stage, rel), "utf8");

describe("stageEngine — content, not version", () => {
  it("stages every runtime file and nothing that is a test", () => {
    const r = go();
    expect(r.exe).toBe(path.join(stage, "ether-engine.exe"));
    expect(staged("ether-engine.exe")).toBe("runtime v1");
    expect(staged(path.join("native", "ether-audio.node"))).toBe("PRE-FIX ENGINE");
    expect(staged(path.join("electron", "audio-library-index.js"))).toBe("index");
    expect(fs.existsSync(path.join(stage, "audiod", "smoke-x.js"))).toBe(false);
    expect(fs.existsSync(path.join(stage, "audiod", "engine.test.js"))).toBe(false);
    expect(staged("version.txt")).toBe("4.6.59");
  });

  it("THE OVEVENTS BUG: a new engine under the SAME version is staged (version.txt already matched)", () => {
    go();
    put(path.join(unpacked, "native", "ether-audio.node"), "MONITOR FIX ENGINE");   // the fix build, still "4.6.59"
    const r = go();
    expect(staged(path.join("native", "ether-audio.node"))).toBe("MONITOR FIX ENGINE");
    expect(r.replaced).toContain(path.join("native", "ether-audio.node"));
    expect(r.pending).toEqual([]);
  });

  it("new daemon code under the same version is staged", () => {
    go();
    put(path.join(unpacked, "audiod", "engine.js"), "engine v2");
    const r = go();
    expect(staged(path.join("audiod", "engine.js"))).toBe("engine v2");
    expect(r.replaced).toEqual([path.join("audiod", "engine.js")]);
  });

  it("a staged file changed behind its back is put back", () => {
    go();
    put(path.join(stage, "native", "ether-audio.node"), "SOMETHING ELSE");
    go();
    expect(staged(path.join("native", "ether-audio.node"))).toBe("PRE-FIX ENGINE");
  });

  it("copies nothing when the stage already is the install", () => {
    go();
    const copy = vi.fn(realFs.copyFileSync);
    const r = go({ copyFile: copy });
    expect(copy).not.toHaveBeenCalled();
    expect(r.replaced).toEqual([]);
  });

  it("removes a daemon .js the install no longer has", () => {
    go();
    fs.unlinkSync(path.join(unpacked, "audiod", "engine.js"));
    put(path.join(unpacked, "audiod", "ether-audiod.js"), 'require("../electron/audio-library-index");');
    go();
    expect(fs.existsSync(path.join(stage, "audiod", "engine.js"))).toBe(false);
  });

  it("the staged engine fingerprints exactly like the install (what main compares)", () => {
    go();
    expect(engineFingerprint(stage)).toEqual(engineFingerprint(unpacked));
    put(path.join(unpacked, "native", "ether-audio.node"), "MONITOR FIX ENGINE");
    expect(engineFingerprint(stage).native).not.toBe(engineFingerprint(unpacked).native);
    go();
    expect(engineFingerprint(stage)).toEqual(engineFingerprint(unpacked));
  });
});

describe("stageEngine — a file in use by a running engine", () => {
  const busy = (match) => (src, dst) => {
    if (dst.endsWith(match) && fs.existsSync(dst)) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    return realFs.copyFileSync(src, dst);
  };

  it("renames the in-use engine aside and stages the installed one; the old copy is swept later", () => {
    go();
    put(path.join(unpacked, "native", "ether-audio.node"), "MONITOR FIX ENGINE");
    const r = go({ copyFile: busy("ether-audio.node") });
    expect(r.swapped).toEqual([path.join("native", "ether-audio.node")]);
    expect(r.pending).toEqual([]);
    expect(staged(path.join("native", "ether-audio.node"))).toBe("MONITOR FIX ENGINE");
    const old = fs.readdirSync(path.join(stage, "native")).filter(n => /\.old-\d+$/.test(n));
    expect(old.length).toBe(1);
    expect(fs.readFileSync(path.join(stage, "native", old[0]), "utf8")).toBe("PRE-FIX ENGINE");   // what the running daemon keeps
    go();
    expect(fs.readdirSync(path.join(stage, "native")).filter(n => /\.old-\d+$/.test(n))).toEqual([]);
  });

  it("when it cannot be replaced at all: keeps it, names both hashes, and replaces it on the next stage", () => {
    go();
    put(path.join(unpacked, "native", "ether-audio.node"), "MONITOR FIX ENGINE");
    const lines = [];
    vi.spyOn(realFs, "renameSync").mockImplementation(() => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); });
    const r = go({ copyFile: busy("ether-audio.node"), log: (m) => lines.push(m) });
    expect(r.exe).toBe(path.join(stage, "ether-engine.exe"));            // the daemon can still be started
    expect(staged(path.join("native", "ether-audio.node"))).toBe("PRE-FIX ENGINE");
    expect(r.pending).toEqual([{ rel: path.join("native", "ether-audio.node"),
      staged: fileSha256(path.join(stage, "native", "ether-audio.node")), installed: fileSha256(path.join(unpacked, "native", "ether-audio.node")) }]);
    expect(lines.join("\n")).toMatch(/IN USE.*staged [0-9a-f]{12}, installed [0-9a-f]{12}/);
    vi.restoreAllMocks();
    go();                                                                  // the engine stopped → next start replaces it
    expect(staged(path.join("native", "ether-audio.node"))).toBe("MONITOR FIX ENGINE");
  });

  it.skipIf(process.platform !== "win32")("REAL Windows lock: a running ether-engine.exe is renamed aside, keeps running, and the new one is staged", async () => {
    // Stage a real executable (this node) as ether-engine.exe and run it from the stage, as the daemon runs.
    put(path.join(srcRoot, "Ether.exe"), fs.readFileSync(process.execPath));
    go();
    const script = path.join(tmp, "hold.js");
    fs.writeFileSync(script, "setInterval(() => {}, 1000);");
    const child = cp.spawn(path.join(stage, "ether-engine.exe"), [script], { stdio: "ignore" });
    try {
      await new Promise(r => setTimeout(r, 700));
      expect(child.exitCode).toBe(null);
      // A plain overwrite of the running exe really fails on Windows — this is the case being handled.
      expect(() => realFs.copyFileSync(path.join(srcRoot, "icudtl.dat"), path.join(stage, "ether-engine.exe"))).toThrow();
      const updated = Buffer.concat([fs.readFileSync(process.execPath), Buffer.from("new runtime")]);
      put(path.join(srcRoot, "Ether.exe"), updated);
      const r = go();
      expect(r.swapped).toEqual(["ether-engine.exe"]);
      expect(r.pending).toEqual([]);
      expect(fileSha256(path.join(stage, "ether-engine.exe"))).toBe(fileSha256(path.join(srcRoot, "Ether.exe")));
      expect(child.exitCode).toBe(null);                                   // the running engine was not touched
    } finally {
      child.kill();
      await new Promise(r => setTimeout(r, 300));
    }
  }, 60000);
});
