import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IRIS_SHIPS_WITH_INSTALLER } from "./irisShips";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("the IRIS button", () => {
  it("is hidden while the installer does not ship Iris", () => {
    const packagesIris = /iris/i.test(read("electron-builder.json"));
    expect(IRIS_SHIPS_WITH_INSTALLER).toBe(packagesIris);
  });
  it("is rendered only behind the flag, and its code stays", () => {
    const app = read("src/App.tsx");
    expect(app).toMatch(/\{IRIS_SHIPS_WITH_INSTALLER && \(\s*<button onClick=\{\(\) => setIrisOpen/);
    expect(app).toMatch(/>IRIS<\/button>\s*\)\}/);
    expect(app).toMatch(/<IrisBadge /);
  });
});
