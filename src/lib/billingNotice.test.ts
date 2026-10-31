// Billing notices on the desktop (Jeff, 2026-10-31): the server's notice from /account/connect shows as a banner in the
// page — never the old blocking overlay, never anything that touches audio — and "Later" hides it for 24 hours.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { publishBillingNotice, getBillingNotice, isDismissed, dismiss, DISMISS_MS, type BillingNotice } from "./billingNotice";

const n: BillingNotice = { kind: "payment_failed", title: "Your payment didn't go through", body: "…", action: { label: "Update card", url: "https://x" }, severity: "critical", endsAt: "2026-11-07" };
const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } }; };

describe("the billing notice store", () => {
  it("keeps the latest connect answer's notice; malformed or missing = none", () => {
    publishBillingNotice(n); expect(getBillingNotice()?.kind).toBe("payment_failed");
    publishBillingNotice({ nope: 1 }); expect(getBillingNotice()).toBe(null);
    publishBillingNotice(undefined); expect(getBillingNotice()).toBe(null);
  });
  it("Later hides that notice for 24 hours; a different notice shows at once", () => {
    const s = mem(); const t0 = 1_000_000;
    dismiss(n, t0, s);
    expect(isDismissed(n, t0 + DISMISS_MS - 1, s)).toBe(true);
    expect(isDismissed(n, t0 + DISMISS_MS + 1, s)).toBe(false);
    expect(isDismissed({ ...n, kind: "lapsed" }, t0 + 1, s)).toBe(false);
  });
});

describe("wiring", () => {
  const read = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
  it("every connect answer feeds it; the banner replaces the blocking trial overlay", () => {
    expect(read("lib/ccData.ts")).toMatch(/publishBillingNotice\(\(data as any\)\?\.billing_notice \?\? null\)/);
    const app = read("App.tsx");
    expect(app).toMatch(/<BillingBanner \/>/);
    expect(app).not.toMatch(/<TrialGate \/>/);
  });
  it("the banner is in the page flow (no fixed, full-screen layer) and has no audio call", () => {
    const b = read("components/BillingBanner.tsx");
    expect(b).not.toMatch(/position:\s*"fixed"|inset:\s*0/);
    expect(b).not.toMatch(/audio|engine|stopAll|automation/i);
  });
});
