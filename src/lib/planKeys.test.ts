import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// THE DESKTOP KNOWS EVERY PLAN KEY THE SERVER SELLS. A key missing from a rank table reads as rank 0 (Solo: no cloud
// backup, no sync) — so a customer on it would silently lose features. unlimited (2026-10-29) is the catalog's top plan.
const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const RANK_TABLE = /(?:TIER_RANK|TIER_RANK_LOCAL)(?::[^=]+)?\s*=\s*\{([^}]*)\}/g;
const SERVER_KEYS = ["free", "pro", "pro_lifetime", "station", "station_lifetime", "operator", "unlimited"];

describe("plan keys on the desktop", () => {
  for (const file of ["src/hooks/usePlan.tsx", "electron/cloud-backup.js", "electron/main.js"]) {
    it(`every rank table in ${file} has every server plan key, unlimited at the top`, () => {
      const tables = [...read(file).matchAll(RANK_TABLE)].map((m) => m[1]);
      expect(tables.length).toBeGreaterThan(0);
      for (const t of tables) {
        const rank = Object.fromEntries([...t.matchAll(/(\w+)\s*:\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]));
        for (const k of SERVER_KEYS) expect(rank[k], `${file}: ${k}`).toBeTypeOf("number");
        expect(rank.unlimited).toBe(Math.max(...Object.values(rank)));
      }
    });
  }
  it("Unlimited has its own name on the subscription panel", () => {
    expect(read("src/components/SubscriptionPanel.tsx")).toMatch(/plan === "unlimited"\)\s+return "Unlimited"/);
  });
});
