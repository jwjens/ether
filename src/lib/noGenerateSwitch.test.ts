// No generate switch (Jeff, 2026-10-19): "Remove the 'Generate when a show runs out' switch. No switches. Inside a show
// there is always music; the log is built before a show starts, never silence while it generates."
// The switch lived in the Program Log beside Fill Day and was mirrored in the Health Monitor; main.js gated the
// unattended Generate on it. All three are gone, and the log is built ahead of every show (main.js _buildShowLogs).
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, "..", "..", ...p), "utf8");

describe("no generate switch", () => {
  it("the Program Log has no switch", () => {
    const pl = read("src", "components", "ProgramLog.tsx");
    expect(pl).not.toMatch(/useAutoGenerate/);
    expect(pl).not.toMatch(/Generate when a show runs out:/);
  });
  it("the Health Monitor neither shows nor reads it", () => {
    const hm = read("src", "components", "HealthMonitor.tsx");
    expect(hm).not.toMatch(/auto_generate_enabled/);
    expect(hm).not.toMatch(/Generate when a show runs out/);
  });
  it("main.js never asks a switch whether to build a show's log", () => {
    const main = read("electron", "main.js");
    expect(main).not.toMatch(/_autoGenerateEnabled\(/);
    expect(main).toMatch(/async function _buildShowLogs\(/);
    expect(main).toMatch(/setInterval\(\(\) => \{ _buildShowLogs\(\)/);
  });
});
