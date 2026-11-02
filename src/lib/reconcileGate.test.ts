import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canCompareStations } from "./reconcileGate";

describe("the 20-second account check compares stations only on a real station list", () => {
  it("an OK answer with a station list (even an empty one) may be compared", () => {
    expect(canCompareStations({ ok: true }, { stations: [] })).toBe(true);
    expect(canCompareStations({ ok: true }, { stations: [{ uuid: "a" }] })).toBe(true);
  });
  it("a refused answer (401 trial_expired, invalid key, 5xx) is never treated as 'no stations'", () => {
    expect(canCompareStations({ ok: false }, { error: "trial_expired", renew_url: "x" })).toBe(false);
    expect(canCompareStations({ ok: false }, { error: "invalid_license_key" })).toBe(false);
    expect(canCompareStations({ ok: false }, { stations: [] })).toBe(false);
    expect(canCompareStations({ ok: true }, { error: "odd" })).toBe(false);
    expect(canCompareStations(null, null)).toBe(false);
  });
  it("wired: reconcile stops before the copy-down and register steps when it cannot compare", () => {
    const src = readFileSync(join(__dirname, "ccData.ts"), "utf8");
    const gate = src.indexOf("if (!canCompareStations(res, data)) return 0;");
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(src.indexOf("/account/register-station"));
    expect(gate).toBeLessThan(src.indexOf("selectAttachedStationsToMaterialize({"));
  });
});
