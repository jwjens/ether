// Categories → "⏱ Scan Durations" and the clock preview ask main for `get_file_duration`; it had no handler (Jeff,
// 2026-10-30: "Scan Durations: make it work"). Every caller's channel must be registered in main.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

describe("get_file_duration", () => {
  it("is asked for by Scan Durations and the clock preview", () => {
    expect(read("src/components/scheduler/CategoriesTab.tsx")).toMatch(/invoke<number>\("get_file_duration"/);
    expect(read("src/components/scheduler/ClocksTab.tsx")).toMatch(/invoke<number>\("get_file_duration"/);
  });
  it("has a handler in main that reads the file's length through the engine", () => {
    const main = read("electron/main.js");
    expect(main).toMatch(/ipcMain\.handle\("get_file_duration", \(_, args\) => \{[\s\S]{0,300}audio\.getFileDuration\(/);
  });
});
