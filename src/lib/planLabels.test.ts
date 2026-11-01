// Plan names in the desktop: the catalog's names (plans.json v2, Jeff's prices 2026-10-31: Local, Live 128, Live 320,
// Network). Names only — the gates and ranks are untouched.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { planName, requiredPlansText } from "./planLabels";

const read = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8");

describe("plan names", () => {
  it("the plans the catalog sells carry its names", () => {
    expect(planName("station")).toBe("Live 128");
    expect(planName("pro")).toBe("Live 320");
    expect(planName("unlimited")).toBe("Network");
  });
  it("the old free key stays Free (old key) (license 21, Jeff 2026-11-01); lifetime and operator are the top plan", () => {
    expect(planName("free")).toBe("Free (old key)");
    expect(planName("station_lifetime")).toBe("Network (Lifetime)");
    expect(planName("pro_lifetime")).toBe("Network (Lifetime)");
    expect(planName("operator")).toBe("Network (Enterprise)");
  });
  it("a gate's words list exactly the catalog plans its rank lets through", () => {
    expect(requiredPlansText("pro")).toBe("Live 128, Live 320 or Network");   // rank 1: every paid catalog plan
    expect(requiredPlansText("station")).toBe("Live 128 or Network");    // rank 2: today's gate does not pass key 'pro'
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
