// Old plan names in the desktop (dead-controls item 20c): Studio / Network replaced by the catalog's names (plans.json:
// Local, Station, Pro, Unlimited). Names only — the gates and ranks are untouched.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { planName, requiredPlansText } from "./planLabels";

const read = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8");

describe("plan names", () => {
  it("the plans the catalog sells carry its names", () => {
    expect(planName("station")).toBe("Station");
    expect(planName("pro")).toBe("Pro");
    expect(planName("unlimited")).toBe("Unlimited");
  });
  it("a gate's words list exactly the catalog plans its rank lets through", () => {
    expect(requiredPlansText("pro")).toBe("Station, Pro or Unlimited");   // rank 1: every paid catalog plan
    expect(requiredPlansText("station")).toBe("Station or Unlimited");    // rank 2: today's gate does not pass key 'pro'
  });
  it("no screen says Studio plan / Network plan any more", () => {
    for (const f of ["src/App.tsx", "src/hooks/usePlan.tsx", "src/components/SettingsPanel.tsx", "src/components/ProgramLog.tsx"]) {
      expect(read(f), f).not.toMatch(/Studio plan|Network plan|"Studio"|: Studio —/);
    }
    expect(read("src/components/SubscriptionPanel.tsx")).not.toMatch(/return "Studio";|return "Network";|full Network plan/);
  });
  it("the gates themselves are unchanged (names only)", () => {
    expect(read("src/hooks/usePlan.tsx")).toMatch(/const TIER_RANK: Record<PlanTier, number> = \{ free: 0, pro: 1, pro_lifetime: 1, station: 2, station_lifetime: 2, operator: 3, unlimited: 3 \}/);
  });
});
