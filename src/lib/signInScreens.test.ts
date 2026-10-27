// Sign-in and setup screens (OnboardingFlow), Jeff 2026-10-26: a compact window sized to its content and centered; a
// readable top line; welcoming wording that keeps the progress and file count; the app's sans-serif, not the old serif.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, "..", "..", ...p), "utf8");
const flow = read("src", "components", "OnboardingFlow.tsx");
const main = read("electron", "main.js");
const preload = read("electron", "preload.js");

describe("sign-in and setup screens", () => {
  it("1. ask for a compact window sized to the measured content, and give the full window back", () => {
    expect(flow).toMatch(/signInWindow\?\.restore/);                                   // on unmount
    expect(flow).toMatch(/api\.fit\(\{ width: SIGN_IN_WINDOW_WIDTH, height: Math\.ceil\(el\.scrollHeight\)/);
    expect(flow).toMatch(/new ResizeObserver\(fit\)/);
    const shells = (flow.match(/<div style=\{SHELL_STYLE\}/g) || []).length;
    const tagged = (flow.match(/<div style=\{SHELL_STYLE\} data-onb-shell="">/g) || []).length;
    expect(shells).toBeGreaterThan(10);
    expect(tagged).toBe(shells);                                                        // every screen is measured
    expect(preload).toMatch(/"sign-in-window:fit"/);
    expect(preload).toMatch(/"sign-in-window:restore"/);
    const fit = main.slice(main.indexOf('ipcMain.handle("sign-in-window:fit"'), main.indexOf('ipcMain.handle("sign-in-window:restore"'));
    expect(fit).toMatch(/w !== mainWindow/);                                            // the main window only
    expect(fit).toMatch(/workArea/);                                                    // never bigger than the screen
    expect(fit).toMatch(/w\.center\(\)/);
    expect(fit).toMatch(/once\("did-start-loading"/);                                   // a reload gives the full window back
  });

  it("2. the top line is readable: 16 px, not letter-spaced capitals", () => {
    const label = flow.slice(flow.indexOf("const LABEL_STYLE"), flow.indexOf("};", flow.indexOf("const LABEL_STYLE")));
    expect(label).toMatch(/fontSize: 16/);
    expect(label).not.toMatch(/uppercase/);
    expect(label).not.toMatch(/letterSpacing: "0\.2em"/);
  });

  it("3. the setup screen welcomes, and still shows the progress, percentage, step and file count", () => {
    expect(flow).toMatch(/'Welcome to Ether'/);
    expect(flow).toMatch(/Getting your station\\nready on this computer/);
    expect(flow).toMatch(/width: `\$\{syncPct\}%`/);
    expect(flow).toMatch(/\{syncPct\}%<\/span>/);
    expect(flow).toMatch(/\{syncMsg\}<\/span>/);
    expect(flow).toMatch(/\{syncSub\}<\/div>/);
  });

  it("4. no serif anywhere in the flow; headings use the app's Inter", () => {
    expect(flow).not.toMatch(/Newsreader|Georgia|font-display/);
    const heading = flow.slice(flow.indexOf("const HEADING_STYLE"), flow.indexOf("};", flow.indexOf("const HEADING_STYLE")));
    expect(heading).toMatch(/'Inter', system-ui, sans-serif/);
    expect(read("src", "index.css")).toMatch(/font-family: 'Inter'/);                  // the app's own body font
  });
});
