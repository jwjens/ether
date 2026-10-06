// 4.6.58 — the HA auto-logon helper ships in every Windows installer, and an UPDATE never disables auto-logon.
// docs/ha-setup-installer-check-2026-10-05.md: through 4.6.57 CI never built native/ha-setup (electron-builder only
// warned), and installer.nsh's customUnInstall — which electron-builder runs on UPDATES too (the old uninstaller,
// with --updated) — raised a UAC prompt to disable auto-logon whenever the old install held ha-setup.exe.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { afterPack } = require("./engine-pack");
const { Arch } = require("builder-util");
const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const PE = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);       // "MZ…"
const NOT_PE = Buffer.from("#!/bin/sh\n");

// A fake packed Windows app: resources/app.asar.unpacked/native/ether-audio.node (PE) ± resources/ha-setup.exe.
function packedWin(helper) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "ether-pack-"));
  const native = path.join(out, "resources", "app.asar.unpacked", "native");
  fs.mkdirSync(native, { recursive: true });
  fs.writeFileSync(path.join(native, "ether-audio.node"), PE);
  if (helper) fs.writeFileSync(path.join(out, "resources", "ha-setup.exe"), helper);
  return { electronPlatformName: "win32", arch: Arch.x64, appOutDir: out, packager: { appInfo: { productFilename: "Ether" } } };
}

describe("afterPack: a Windows package without the HA helper fails the build", () => {
  it("missing resources\\ha-setup.exe → throws, so nothing is signed or published", async () => {
    await expect(afterPack(packedWin(null))).rejects.toThrow(/HA HELPER NOT PACKAGED/);
  });
  it("a helper that is not a PE executable → throws", async () => {
    await expect(afterPack(packedWin(NOT_PE))).rejects.toThrow(/packaged HA helper is unknown, expected pe/);
  });
  it("a PE helper beside a PE engine → passes", async () => {
    await expect(afterPack(packedWin(PE))).resolves.toBeUndefined();
  });
});

describe("CI builds the helper before packaging (Windows only)", () => {
  const yml = read(".github/workflows/build.yml");
  it("has a Windows-only release build of native/ha-setup", () => {
    expect(yml).toMatch(/- name: Build HA helper \(Windows\)\n\s+if: matrix\.platform == 'win'\n\s+run: cargo build --release --manifest-path native\/ha-setup\/Cargo\.toml/);
  });
  it("that step runs before the signed Windows package step", () => {
    const build = yml.indexOf("- name: Build HA helper (Windows)");
    const pack = yml.indexOf("- name: Build and publish (Windows, SIGNED");
    expect(build).toBeGreaterThan(-1);
    expect(pack).toBeGreaterThan(build);
  });
  it("the package still copies it from exactly where cargo puts it", () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "electron-builder.json"), "utf8"));
    expect(cfg.extraResources).toContainEqual({ from: "native/ha-setup/target/release/ha-setup.exe", to: "ha-setup.exe" });
  });
});

describe("installer.nsh: only a REAL uninstall disables auto-logon", () => {
  const nsh = read("build-resources/installer.nsh");
  const macro = nsh.slice(nsh.indexOf("!macro customUnInstall"), nsh.indexOf("!macroend", nsh.indexOf("!macro customUnInstall")));
  it("the disable call sits inside ${ifNot} ${isUpdated} … ${endIf}", () => {
    const guard = macro.indexOf("${ifNot} ${isUpdated}");
    const call = macro.indexOf("ha-setup.exe\" 'disable");
    const end = macro.indexOf("${endIf}");
    expect(guard).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(guard);
    expect(end).toBeGreaterThan(call);
  });
});

describe("the local packaged-build gate checks it too", () => {
  it("audiod/verify-packaged.js exits non-zero on Windows when resources\\ha-setup.exe is missing", () => {
    const v = read("audiod/verify-packaged.js");
    expect(v).toMatch(/const HA_HELPER = path\.join\(ROOT, "resources", "ha-setup\.exe"\);/);
    expect(v).toMatch(/if \(!MAC && !fs\.existsSync\(HA_HELPER\)\) \{[^}]*process\.exit\(1\); \}/);
  });
});
