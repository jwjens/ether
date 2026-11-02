import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

// The isolated run (own userData, own engine pipe, no :3400): the release smoke check, or a DEV build's
// ETHER_ISOLATED_DEV=1 (the local billing test, 2026-11-01). Never without an explicit --user-data-dir; never
// ETHER_ISOLATED_DEV in a packaged build.
const require = createRequire(import.meta.url);
const { isIsolatedRun } = require("./isolated-run.js");

describe("isolated run", () => {
  it("ETHER_SMOKE=1 with --user-data-dir is isolated, packaged or not", () => {
    expect(isIsolatedRun({ env: { ETHER_SMOKE: "1" }, packaged: true, hasUserDataDir: true })).toBe(true);
    expect(isIsolatedRun({ env: { ETHER_SMOKE: "1" }, packaged: false, hasUserDataDir: true })).toBe(true);
  });
  it("ETHER_ISOLATED_DEV=1 with --user-data-dir is isolated in a dev build only", () => {
    expect(isIsolatedRun({ env: { ETHER_ISOLATED_DEV: "1" }, packaged: false, hasUserDataDir: true })).toBe(true);
    expect(isIsolatedRun({ env: { ETHER_ISOLATED_DEV: "1" }, packaged: true, hasUserDataDir: true })).toBe(false);
  });
  it("never without an explicit --user-data-dir", () => {
    expect(isIsolatedRun({ env: { ETHER_SMOKE: "1" }, packaged: false, hasUserDataDir: false })).toBe(false);
    expect(isIsolatedRun({ env: { ETHER_ISOLATED_DEV: "1" }, packaged: false, hasUserDataDir: false })).toBe(false);
  });
  it("nothing set: a normal run", () => {
    expect(isIsolatedRun({ env: {}, packaged: false, hasUserDataDir: true })).toBe(false);
    expect(isIsolatedRun({ env: { ETHER_ISOLATED_DEV: "0" }, packaged: false, hasUserDataDir: true })).toBe(false);
  });
  it("main.js decides SMOKE_ISOLATED with it, before userData is set", () => {
    const src = readFileSync(join(__dirname, "..", "main.js"), "utf8");
    const at = src.indexOf('const SMOKE_ISOLATED = require("./lib/isolated-run").isIsolatedRun(');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(src.indexOf('app.setPath("userData", _newUserData)'));
  });
});
