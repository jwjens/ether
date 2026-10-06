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

// ── 4.6.59: the helper is SIGNED (4.6.58's draft shipped resources\ha-setup.exe NotSigned) ─────────────────────────
const { checkHelperSignature, afterSign } = require("./engine-pack");

describe("afterSign: a signed Windows build fails unless ha-setup.exe has a Valid signature", () => {
  const resourcesWith = (helper) => path.join(packedWin(helper).appOutDir, "resources");
  it("Valid → passes", () => {
    expect(checkHelperSignature(resourcesWith(PE), () => "Valid")).toBe("Valid");
  });
  it("NotSigned → throws HA HELPER NOT SIGNED", () => {
    expect(() => checkHelperSignature(resourcesWith(PE), () => "NotSigned")).toThrow(/HA HELPER NOT SIGNED.*"NotSigned"/s);
  });
  it("any other status (e.g. HashMismatch) → throws", () => {
    expect(() => checkHelperSignature(resourcesWith(PE), () => "HashMismatch")).toThrow(/HA HELPER NOT SIGNED/);
  });
  it("helper missing → throws before asking for a signature", () => {
    let asked = false;
    expect(() => checkHelperSignature(resourcesWith(null), () => { asked = true; return "Valid"; })).toThrow(/HA HELPER NOT PACKAGED/);
    expect(asked).toBe(false);
  });
  it("non-Windows packages are not checked", async () => {
    await expect(afterSign({ electronPlatformName: "darwin", appOutDir: "/nonexistent" })).resolves.toBeUndefined();
  });
  it("electron-builder.json registers the afterSign hook", () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "electron-builder.json"), "utf8"));
    expect(cfg.afterSign).toBe("build-resources/engine-after-sign.js");
    expect(fs.existsSync(path.join(ROOT, "build-resources/engine-after-sign.js"))).toBe(true);
  });
});

describe("CI signs the helper between building it and packaging, on tag runs only", () => {
  const yml = read(".github/workflows/build.yml");
  const step = yml.slice(yml.indexOf("- name: Sign HA helper"), yml.indexOf("- name:", yml.indexOf("- name: Sign HA helper") + 10));
  it("exists, Windows + v* tag push only (same condition as the signed package step)", () => {
    expect(step).toMatch(/if: matrix\.platform == 'win' && github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  });
  it("runs after 'Build HA helper' and before the signed package step", () => {
    const build = yml.indexOf("- name: Build HA helper (Windows)");
    const sign = yml.indexOf("- name: Sign HA helper");
    const pack = yml.indexOf("- name: Build and publish (Windows, SIGNED");
    expect(build).toBeGreaterThan(-1);
    expect(sign).toBeGreaterThan(build);
    expect(pack).toBeGreaterThan(sign);
  });
  it("uses the account/profile from electron-builder.signed.json, signs the cargo output, and verifies Valid", () => {
    expect(step).toMatch(/ConvertFrom-Json\)\.win\.azureSignOptions/);
    expect(step).toMatch(/Invoke-TrustedSigning -Endpoint \$opts\.endpoint -CodeSigningAccountName \$opts\.codeSigningAccountName/);
    expect(step).toMatch(/-CertificateProfileName \$opts\.certificateProfileName/);
    expect(step).toMatch(/native\/ha-setup\/target\/release\/ha-setup\.exe/);
    expect(step).toMatch(/if \(\$sig\.Status -ne 'Valid'\) \{ throw/);
    for (const v of ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"]) expect(step.includes(v + ": ${{ secrets." + v + " }}")).toBe(true);
  });
  it("the signed config still names the Azure account electron-builder uses", () => {
    const signed = JSON.parse(fs.readFileSync(path.join(ROOT, "electron-builder.signed.json"), "utf8"));
    expect(signed.win.azureSignOptions.codeSigningAccountName).toBe("ethercast");
    expect(signed.win.azureSignOptions.certificateProfileName).toBe("ethercast-release");
  });
});
