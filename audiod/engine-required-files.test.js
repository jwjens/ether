// A missing required engine file fails the build and the stage — never optional, never skipped quietly (Jeff, 2026-10-27:
// "A missing required engine file fails the build. Never mark one optional or skip it silently."). 4.6.66's stage skipped
// electron/catalogue.js with one console line and the engine could play nothing. build-resources/engine-pack.js afterPack,
// audiod/stage-engine.js stagePlan.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const { stageEngine } = require_("./stage-engine.js");
const { missingEngineFiles } = require_("../build-resources/engine-pack.js");

let tmp, srcRoot, unpacked, stage;
const put = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ether-required-test-"));
  srcRoot = path.join(tmp, "install");
  unpacked = path.join(srcRoot, "resources", "app.asar.unpacked");
  stage = path.join(tmp, "engine");
  put(path.join(srcRoot, "Ether.exe"), "runtime");
  put(path.join(unpacked, "audiod", "ether-audiod.js"), 'require("./engine");');
  put(path.join(unpacked, "audiod", "engine.js"), "try { require('../electron/catalogue').playableFile(fp); } catch {}");
  put(path.join(unpacked, "electron", "sync", "mutation-writer.js"), "mw");
  put(path.join(unpacked, "electron", "sync", "synced-tables.js"), "st");
  put(path.join(unpacked, "native", "ether-audio.node"), "engine");
});
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

describe("the build fails when a file the engine requires is not unpacked", () => {
  it("names the missing file (4.6.66: electron/catalogue.js)", () => {
    expect(missingEngineFiles(unpacked)).toEqual(["electron/catalogue.js"]);
  });
  it("and follows what that file requires in turn", () => {
    put(path.join(unpacked, "electron", "catalogue.js"), 'const x = require("./audio-library-index");');
    expect(missingEngineFiles(unpacked)).toEqual(["electron/audio-library-index.js"]);
    put(path.join(unpacked, "electron", "audio-library-index.js"), "idx");
    expect(missingEngineFiles(unpacked)).toEqual([]);
  });
  it("afterPack throws on it — the build stops before anything is signed or published", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "build-resources", "engine-pack.js"), "utf8");
    expect(src).toMatch(/const missing = missingEngineFiles\(unpacked\);\s*\n\s*if \(missing\.length\) \{\s*\n\s*throw new Error\(`\[engine-pack\] ENGINE FILES NOT PACKAGED/);
    const builder = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "electron-builder.json"), "utf8"));
    expect(builder.afterPack).toBe("build-resources/engine-after-pack.js");
    expect(fs.readFileSync(path.join(__dirname, "..", "build-resources", "engine-after-pack.js"), "utf8")).toMatch(/require\("\.\/engine-pack"\)\.afterPack/);
  });
});

describe("the stage never skips a required file", () => {
  it("a missing one fails the stage, by name, and no manifest claims a good engine", () => {
    const said = [];
    const r = stageEngine({ srcRoot, unpacked, version: "t", baseDir: stage, platform: "win32", log: (m) => said.push(m) });
    expect(r).toBeNull();                                                  // nothing staged before → nothing to run
    expect(said.join("\n")).toMatch(/installed file missing: electron[\\/]catalogue\.js — the engine requires it; nothing was staged/);
    expect(fs.existsSync(path.join(stage, "ether-engine.exe"))).toBe(false);          // nothing half-written for a fallback to run
    expect(fs.existsSync(path.join(stage, "audiod"))).toBe(false);
    expect(fs.existsSync(path.join(stage, "stage-manifest.json"))).toBe(false);
  });
  it("with it present, it is staged and in the manifest", () => {
    put(path.join(unpacked, "electron", "catalogue.js"), "cat");
    const r = stageEngine({ srcRoot, unpacked, version: "t", baseDir: stage, platform: "win32" });
    expect(r && r.exe).toBe(path.join(stage, "ether-engine.exe"));
    const m = JSON.parse(fs.readFileSync(path.join(stage, "stage-manifest.json"), "utf8"));
    expect(Object.keys(m.dst)).toContain(path.join("electron", "catalogue.js"));
  });
  it("no app file is planned as optional", () => {
    const src = fs.readFileSync(path.join(__dirname, "stage-engine.js"), "utf8");
    const line = src.split("\n").find(l => l.includes("FP.daemonAppFiles(audiod)) plan.push("));
    expect(line).toBeTruthy();
    expect(line).not.toMatch(/optional/);
  });
});
