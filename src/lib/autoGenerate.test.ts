// fix 19 (docs/held-items-proposals-2026-09-27.md; Jeff's GO 2026-09-27): the per-station auto-generate switch
// (auto_generate_enabled) lived only in the Log-Reader Flip Canary panel. It now lives in the Program Log, beside
// Fill Day, where runway is read; the Canary shows a READ-ONLY mirror that says where the real switch is.
// The read / write / read-back rules move, unchanged, into lib/autoGenerate.ts (stored value only, never optimistic).
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { AUTO_GENERATE_KEY, readAutoGenerate, writeAutoGenerate } from "./autoGenerate";

function fakeKv(initial: Record<string, string | null> = {}, refuse = false) {
  const store = { ...initial };
  const calls: any[][] = [];
  const invoke = async (ch: string, sid: number, key: string, value?: string) => {
    calls.push([ch, sid, key, value]);
    if (ch === "station_config_kv:get-value") return { ok: true, value: store[`${sid}:${key}`] ?? null };
    if (ch === "station_config_kv:set-local") {
      if (refuse) return { ok: false, error: "not a local-only key" };
      store[`${sid}:${key}`] = value!; return { ok: true };
    }
    throw new Error("unexpected channel " + ch);
  };
  return { invoke, calls, store };
}

describe("the auto-generate switch (audit 19)", () => {
  it("unset reads OFF (4.4.185 default); '1' reads ON; an unreadable store reads null", async () => {
    expect(AUTO_GENERATE_KEY).toBe("auto_generate_enabled");
    expect(await readAutoGenerate(fakeKv().invoke, 3)).toBe(false);
    expect(await readAutoGenerate(fakeKv({ "3:auto_generate_enabled": "1" }).invoke, 3)).toBe(true);
    expect(await readAutoGenerate(async () => ({ ok: false }), 3)).toBeNull();
  });
  it("a write goes through set-local and reports the READ-BACK, not the wish", async () => {
    const kv = fakeKv();
    const r = await writeAutoGenerate(kv.invoke, 3, true);
    expect(kv.calls.find(c => c[0] === "station_config_kv:set-local")).toEqual(["station_config_kv:set-local", 3, "auto_generate_enabled", "1"]);
    expect(r).toEqual({ stored: true, error: null });
  });
  it("a refused write says so and reports what is actually stored", async () => {
    const r = await writeAutoGenerate(fakeKv({}, true).invoke, 3, true);
    expect(r.stored).toBe(false);
    expect(r.error).toMatch(/refused: not a local-only key/);
  });

  it("the Program Log carries the switch beside Fill Day", () => {
    const pl = fs.readFileSync(path.join(__dirname, "..", "components", "ProgramLog.tsx"), "utf8");
    expect(pl).toMatch(/useAutoGenerate\(stationId\)/);
    expect(pl).toMatch(/Keep the log filled/);
  });
  it("the Canary panel only mirrors it and names where the real switch is", () => {
    const hm = fs.readFileSync(path.join(__dirname, "..", "components", "HealthMonitor.tsx"), "utf8");
    expect(hm).not.toMatch(/"station_config_kv:set-local", sid, AUTO_KEY/);
    expect(hm).not.toMatch(/toggleAutoGen/);
    expect(hm).toMatch(/switch it in the Program Log/);
  });
});
