// The Subscription screen's plans (src/lib/planCatalog.ts + PlanCatalogCards): the catalog's prices, nothing typed.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { planCards, annualLine, trialLine, type Catalog } from "./planCatalog";

const read = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8");
// a copy of C:\ether-backend config/plans.json v2 (Jeff's prices 2026-10-31 / 11-01)
const catalog: Catalog = {
  trial: { days: 15, requires_card: false }, discounts: { annual_months_charged: 10 },
  addons: { listeners_50: { label: "+50 listeners", price_monthly: 10, listeners: 50 } },
  plans: {
    local: { label: "Local", price_monthly: 20, price_annual: 200, per: "account", cloud: false },
    station: { label: "Live 128", price_monthly: 25, price_annual: 250, per: "station", cloud: true, max_bitrate_kbps: 128, listeners_per_stream: 50 },
    pro: { label: "Live 320", price_monthly: 49, price_annual: 490, per: "station", cloud: true, max_bitrate_kbps: 320, listeners_per_stream: 150, priority_support: true },
    unlimited: { label: "Network", price_monthly: 79, price_annual: 790, per: "account", cloud: true, stations_included: 5, max_bitrate_kbps: 128, listener_pool: 250, priority_support: true, extra_station: { price_monthly: 15, listeners: 50 } },
  },
};

describe("Subscription plans from the catalog", () => {
  it("Local $20, Live 128 $25, Live 320 $49, Network $79 — annual 10 months, no free plan", () => {
    expect(planCards(catalog).map(c => [c.name, c.monthly, c.annual])).toEqual([["Local", 20, 200], ["Live 128", 25, 250], ["Live 320", 49, 490], ["Network", 79, 790]]);
    expect(annualLine(planCards(catalog)[0], catalog)).toBe("or $200/yr (2 months free)");
  });
  it("Network: 5 stations, 128 kbps each, 250 shared listeners, extra station $15 adding 50", () => {
    const n = planCards(catalog).find(c => c.key === "unlimited")!;
    expect(n.feats).toEqual(expect.arrayContaining(["5 hosted stations", "128 kbps per station", "250 listeners shared across your stations", "Extra stations $15/mo each, +50 listeners"]));
  });
  it("the trial line: 15 days, no card", () => {
    expect(trialLine(catalog)).toBe("15-day free trial, no card needed · Cancel anytime");
  });
  it("no old price, Stripe link or payment-link id is left on the Subscription screen or the promo slides", () => {
    const sub = read("src/components/SubscriptionPanel.tsx") + read("src/components/PlanCatalogCards.tsx");
    expect(sub).not.toMatch(/buy\.stripe\.com|pk_live_|price_1T|\$19|\$79|\$299|\$899|\$0</);
    expect(read("src/components/NowPlaying.tsx")).not.toMatch(/\$19 \/ MONTH|\$79 \/ MONTH/);
  });
});

describe("the ☰ menu is a door to Plans & Subscription", () => {
  it("the entry opens the Subscription screen", () => {
    expect(read("src/App.tsx")).toMatch(/drawerClick\("subscription", \(\) => \{ setPanel\("subscription"\); setDrawerOpen\(false\); \}\)/);
    expect(read("src/App.tsx")).toMatch(/Plans &amp; Subscription/);
  });
});
