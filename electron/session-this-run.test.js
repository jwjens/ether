// A window reload never signs anyone out while Ether runs (Jeff, 2026-10-30). electron/session-this-run.js.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { createSessionThisRun } = require_("./session-this-run");
const read = (p) => readFileSync(join(__dirname, "..", p), "utf8");

describe("sign-in survives a reload", () => {
  it("a fresh run with no self-relaunch marker asks for sign-in", () => {
    expect(createSessionThisRun({ consumeKeepSession: () => false }).resume()).toBe(false);
  });
  it("once this run opened the gate, every later reload resumes — without touching the marker", () => {
    let asked = 0;
    const s = createSessionThisRun({ consumeKeepSession: () => { asked++; return false; } });
    s.markOpened();
    expect(s.resume()).toBe(true);
    expect(s.resume()).toBe(true);
    expect(asked).toBe(0);
  });
  it("a self-relaunch marker opens the gate and is remembered for later reloads", () => {
    let left = 1;
    const s = createSessionThisRun({ consumeKeepSession: () => left-- > 0 });
    expect(s.resume()).toBe(true);
    expect(s.resume()).toBe(true);
  });
  it("main answers resume-session from it, and every sign-in path marks it", () => {
    const m = read("electron/main.js");
    expect(m).toMatch(/ipcMain\.handle\("account:resume-session", \(\) => \{[^\n]*sessionThisRun\.resume\(\)/);
    expect(m).toMatch(/AccountSession\.setSession\(s,[^\n]*sessionThisRun\.markOpened\(\)/);
    expect(m).toMatch(/accountRenewer\(\)\.signedIn\(\);\s*sessionThisRun\.markOpened\(\);\s*return \{ ok: true, stored/);
    expect(m).toMatch(/ipcMain\.handle\("account:gate-opened"/);
  });
  it("the renderer tells main when its sign-in gate opens", () => {
    const a = read("src/App.tsx");
    const h = a.slice(a.indexOf("const handleWizardComplete"), a.indexOf("const handleWizardComplete") + 700);
    expect(h).toMatch(/invoke\("account:gate-opened"\)/);
  });
});
