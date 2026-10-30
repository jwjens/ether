// Program Log → ⚙ Shows & Dayparts → delete called ether.shows['delete-by-id'], which does not exist (Jeff, 2026-10-30).
// Every ether.shows.<name> the Program Log calls must be a function the preload exposes.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("Program Log shows calls", () => {
  it("only call functions the preload exposes on ether.shows", () => {
    const pre = read("electron/preload-handlers.js");
    const block = pre.slice(pre.indexOf("shows: {"), pre.indexOf("},", pre.indexOf("shows: {")));
    const exposed = new Set([...block.matchAll(/^\s+(\w+):/gm)].map((m) => m[1]));
    const used = [...read("src/components/ProgramLog.tsx").matchAll(/ether\.shows(?:\.(\w+)|\['([^']+)'\])/g)].map((m) => m[1] || m[2]);
    expect(used.length).toBeGreaterThan(0);
    for (const u of used) expect(exposed.has(u), `ether.shows.${u}`).toBe(true);
  });
});
