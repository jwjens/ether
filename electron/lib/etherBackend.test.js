import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

// A dev build can be pointed at a LOCAL backend (ETHER_BACKEND_URL_DEV, 2026-11-01 local billing test). Only a
// localhost URL is taken; outside electron (a plain node process counts as packaged) it is never read; the renderer
// half only in a dev build.
const require = createRequire(import.meta.url);
const MOD = require.resolve("./etherBackend.js");
const load = () => { delete require.cache[MOD]; return require("./etherBackend.js"); };

describe("backend URL", () => {
  afterEach(() => { delete process.env.ETHER_BACKEND_URL_DEV; });
  it("a plain node process (treated as packaged) always uses production, even with the override set", () => {
    process.env.ETHER_BACKEND_URL_DEV = "http://127.0.0.1:8787";
    expect(load().ETHER_BACKEND_URL).toBe("https://ether-backend-production.up.railway.app");
  });
  it("the renderer takes only a localhost URL, only in dev", () => {
    const src = readFileSync(join(__dirname, "..", "..", "src", "lib", "etherBackend.ts"), "utf8");
    expect(src).toMatch(/if \(!import\.meta\.env\.DEV\) return null;/);
    expect(src).toMatch(/\^http:\\\/\\\/\(127\\\.0\\\.0\\\.1\|localhost\)\(:\\d\+\)\?\$/);
    expect(src).toMatch(/export const ETHER_BACKEND_URL = DEV_URL \|\| "https:\/\/ether-backend-production\.up\.railway\.app";/);
  });
  it("the main process takes only a localhost URL, never when packaged", () => {
    const src = readFileSync(join(__dirname, "etherBackend.js"), "utf8");
    expect(src).toMatch(/return !_packaged\(\) && \/\^http:\\\/\\\/\(127\\\.0\\\.0\\\.1\|localhost\)\(:\\d\+\)\?\$\/\.test\(v\) \? v : null;/);
  });
});
