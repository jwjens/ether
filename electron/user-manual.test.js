// Help → Documentation opens the user manual that ships with Ether (Jeff, 2026-11-02): electron/user-manual.js, the
// installer's extraResources entry, the afterPack check that fails a build without it, and the PDF itself.
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
const { manualPath, openUserManual, MANUAL_FILE } = require("./user-manual");

const ROOT = path.join(__dirname, "..");
const fake = (openResult = "") => ({ shell: { openPath: vi.fn(async () => openResult), openExternal: vi.fn() }, dialog: { showMessageBox: vi.fn(async () => ({})) } });

describe("where the manual is", () => {
  it("installed: resources/Ether-User-Manual.pdf; dev run: build-resources/", () => {
    expect(manualPath({ isPackaged: true, resourcesPath: "C:/Program Files/Ether/resources", appDir: "x" })).toBe(path.join("C:/Program Files/Ether/resources", MANUAL_FILE));
    expect(manualPath({ isPackaged: false, resourcesPath: "x", appDir: path.join(ROOT, "electron") })).toBe(path.join(ROOT, "build-resources", MANUAL_FILE));
  });
});

describe("opening it", () => {
  it("opens the local PDF with the computer's viewer — never a web page", async () => {
    const e = fake("");
    const r = await openUserManual({ electron: e, isPackaged: true, resourcesPath: "R", appDir: "A", exists: () => true });
    expect(r).toEqual({ ok: true, path: path.join("R", MANUAL_FILE) });
    expect(e.shell.openPath).toHaveBeenCalledWith(path.join("R", MANUAL_FILE));
    expect(e.shell.openExternal).not.toHaveBeenCalled();
    expect(e.dialog.showMessageBox).not.toHaveBeenCalled();
  });
  it("a missing manual is said in a message (and nothing else is opened)", async () => {
    const e = fake("");
    const r = await openUserManual({ electron: e, isPackaged: true, resourcesPath: "R", appDir: "A", exists: () => false });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/missing from this installation/);
    expect(e.shell.openPath).not.toHaveBeenCalled();
    expect(e.shell.openExternal).not.toHaveBeenCalled();
    expect(e.dialog.showMessageBox.mock.calls[0][0].detail).toMatch(/Reinstall Ether/);
  });
  it("no PDF viewer: the viewer's reason is shown", async () => {
    const e = fake("No application is associated with the specified file");
    const r = await openUserManual({ electron: e, isPackaged: true, resourcesPath: "R", appDir: "A", exists: () => true });
    expect(r.ok).toBe(false);
    expect(e.dialog.showMessageBox.mock.calls[0][0].detail).toMatch(/No application is associated[\s\S]*A PDF viewer is needed/);
  });
});

describe("wired and shipped", () => {
  it("Help → Documentation uses it (not github.com)", () => {
    const main = fs.readFileSync(path.join(ROOT, "electron", "main.js"), "utf8");
    const line = main.split("\n").find((l) => /label: "Documentation"/.test(l));
    expect(line).toMatch(/require\("\.\/user-manual"\)\.openUserManual\(/);
    expect(line).not.toMatch(/github\.com/);
  });
  it("the installer copies the PDF into resources, and afterPack fails a build without it", () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "electron-builder.json"), "utf8"));
    expect(cfg.extraResources).toContainEqual({ from: "build-resources/Ether-User-Manual.pdf", to: "Ether-User-Manual.pdf" });
    const pack = fs.readFileSync(path.join(ROOT, "build-resources", "engine-pack.js"), "utf8");
    expect(pack).toMatch(/USER MANUAL NOT PACKAGED/);
    expect(pack).toMatch(/"%PDF-"/);
  });
  it("the PDF is there, is a PDF, and is built from docs/user-manual.md for this version", () => {
    const pdf = fs.readFileSync(path.join(ROOT, "build-resources", MANUAL_FILE));
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(200 * 1024);
    const md = fs.readFileSync(path.join(ROOT, "docs", "user-manual.md"), "utf8");
    const version = require(path.join(ROOT, "package.json")).version;
    expect(md.split("\n")[0]).toBe(`# Ether User Manual — version ${version}`);
    for (const s of ["## 8. Your plan", "## 9. Billing notices", "## Start streaming", "Stream Manager"]) expect(md).toContain(s);
    expect(md).not.toMatch(/go on air|going on air/i);
    expect(md).not.toMatch(/# 27\. The platform console/);
  });
});
