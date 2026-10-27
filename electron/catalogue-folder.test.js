// The catalogue folder always has a default, Ether creates it at launch, and the user can choose another (Jeff, 2026-10-27:
// "there is always a default. Ether creates the catalogue folder at its default location so there is always a starting
// point. The user can always choose a different location, both in first-run setup and in Preferences."). Real folders.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
const { createCatalogueFolder } = require("./catalogue-folder");

let root, music, setting, fallback, logs, cf;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "catfolder-"));
  music = path.join(root, "Music"); setting = path.join(root, "profile", "music-dir.txt"); fallback = path.join(root, "r2-cache");
  fs.mkdirSync(music); fs.mkdirSync(path.dirname(setting));
  logs = [];
  cf = createCatalogueFolder({ musicPath: () => music, settingFile: setting, fallbackDir: fallback, log: (m) => logs.push(m) });
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
const def = () => path.join(music, "ether music library");

describe("there is always a default, and Ether creates it at launch", () => {
  it("a fresh install: the default is <Music>\\ether music library, and launch creates it", () => {
    expect(cf.defaultDir()).toBe(def());
    expect(fs.existsSync(def())).toBe(false);
    const r = cf.ensureAtLaunch();
    expect(r).toEqual({ dir: def(), isDefault: true, created: true, present: true });
    expect(fs.statSync(def()).isDirectory()).toBe(true);
    expect(logs.join("\n")).toMatch(/the default\) — created/);
  });
  it("the next launch finds it present and creates nothing new", () => {
    cf.ensureAtLaunch();
    expect(cf.ensureAtLaunch()).toMatchObject({ dir: def(), created: false, present: true });
  });
  it("no Music folder on this OS → the fallback folder, still created", () => {
    const c = createCatalogueFolder({ musicPath: () => { throw new Error("no music"); }, settingFile: setting, fallbackDir: fallback });
    expect(c.ensureAtLaunch()).toMatchObject({ dir: fallback, isDefault: true, present: true });
  });
});

describe("the user can choose a different location (first-run setup and Preferences both call music:set-dir)", () => {
  it("a chosen folder is created, saved, and used from then on — at launch too", () => {
    const mine = path.join(root, "D-drive", "Station Audio");
    expect(cf.set(mine)).toEqual({ ok: true, dir: mine });
    expect(fs.readFileSync(setting, "utf8")).toBe(mine);
    expect(cf.current()).toBe(mine);
    expect(cf.ensureAtLaunch()).toMatchObject({ dir: mine, isDefault: false, present: true });
    expect(cf.defaultDir()).toBe(def());                                 // the default is still reported as the default
  });
  it("a chosen folder that has since been removed is made again at launch — not swapped for the default", () => {
    const mine = path.join(root, "chosen");
    cf.set(mine); fs.rmSync(mine, { recursive: true });
    expect(cf.ensureAtLaunch()).toMatchObject({ dir: mine, isDefault: false, created: true, present: true });
  });
  it("it can be changed again, any number of times", () => {
    cf.set(path.join(root, "a")); cf.set(path.join(root, "b"));
    expect(cf.current()).toBe(path.join(root, "b"));
  });
  it("an empty choice is refused and the folder in force is kept", () => {
    cf.set(path.join(root, "a"));
    expect(cf.set("  ")).toEqual({ ok: false, error: "empty path" });
    expect(cf.current()).toBe(path.join(root, "a"));
  });
});

describe("main wires it", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  it("launch creates the folder, right after the session starts", () => {
    const boot = main.slice(main.indexOf("logStartup('=== SESSION START ===')"), main.indexOf("createWindow();", main.indexOf("logStartup('=== SESSION START ===')")));
    expect(boot).toMatch(/_catalogueFolder\.ensureAtLaunch\(\)/);
  });
  it("music:get-dir reports the real default (it used to report the r2-cache fallback)", () => {
    expect(main).toMatch(/ipcMain\.handle\('music:get-dir', \(\) => \(\{ ok: true, dir: getMusicDir\(\), default: _catalogueFolder\.defaultDir\(\) \}\)\)/);
    expect(main).not.toMatch(/default: R2_CACHE_DIR/);
  });
  it("music:set-dir is the user's choice, and both first-run setup and Preferences offer it", () => {
    expect(main).toMatch(/ipcMain\.handle\('music:set-dir', \(_, dir\) => setMusicDir\(dir\)\)/);
    expect(main).toMatch(/function setMusicDir\(dir\) \{ return _catalogueFolder\.set\(dir\); \}/);
    for (const f of ["OnboardingFlow.tsx", "SettingsPanel.tsx"]) {
      const s = fs.readFileSync(path.join(__dirname, "..", "src", "components", f), "utf8");
      expect(s).toMatch(/ether\.dialog\?\.openDirectory\?\.\(\)/);
      expect(s).toMatch(/ether\.music\?\.setDir\?\.\(/);
    }
  });
});
