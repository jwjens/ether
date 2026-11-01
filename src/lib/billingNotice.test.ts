// Billing notices on the desktop (Jeff, 2026-10-31): the server's notice from /account/connect shows as a popup like
// Adobe's — two buttons (Update card / Add a card, and Later), never modal, never takes keyboard focus, never touches
// audio — when Ether opens and at most once a day after that.
import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import { publishBillingNotice, getBillingNotice, shouldShowPopup, markPopupShown, SHOW_EVERY_MS, _resetRun, type BillingNotice } from "./billingNotice";

const n: BillingNotice = { kind: "payment_failed", title: "Your payment didn't go through", body: "…", action: { label: "Update card", url: "https://x" }, severity: "error" };
const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } }; };

describe("the billing notice store", () => {
  it("keeps the latest connect answer's notice; malformed or missing = none", () => {
    publishBillingNotice(n); expect(getBillingNotice()?.kind).toBe("payment_failed");
    publishBillingNotice({ nope: 1 }); expect(getBillingNotice()).toBe(null);
    publishBillingNotice(undefined); expect(getBillingNotice()).toBe(null);
  });
});

describe("when the popup shows: when Ether opens, then at most once a day", () => {
  beforeEach(() => _resetRun());
  it("the first notice of a run shows at once, even if it showed an hour ago in the last run", () => {
    const s = mem(); s.setItem("ether_billing_popup_last_shown", String(1000));
    expect(shouldShowPopup(1000 + 3600_000, s)).toBe(true);
  });
  it("after it showed this run, not again until a full day has passed", () => {
    const s = mem(); const t0 = 5_000_000;
    markPopupShown(t0, s);
    expect(shouldShowPopup(t0 + 60_000, s)).toBe(false);
    expect(shouldShowPopup(t0 + SHOW_EVERY_MS - 1, s)).toBe(false);
    expect(shouldShowPopup(t0 + SHOW_EVERY_MS, s)).toBe(true);
  });
});

describe("the popup never blocks and never takes focus", () => {
  const read = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
  const b = read("components/BillingBanner.tsx");
  it("not modal: no backdrop layer, aria-modal false, a small window (not full screen)", () => {
    expect(b).toMatch(/aria-modal="false"/);
    expect(b).not.toMatch(/inset:\s*0/);
    expect(b).toMatch(/width: 420/);
  });
  it("never takes keyboard focus: no focus() call, buttons out of the tab order, a click doesn't move focus", () => {
    expect(b).not.toMatch(/\.focus\(|autoFocus/);
    expect(b.match(/tabIndex=\{-1\}/g)?.length).toBe(2);
    expect(b).toMatch(/onMouseDown=\{noFocus\}/);
  });
  it("two buttons, both close it; nothing touches audio", () => {
    expect(b).toMatch(/>\s*Later\s*</);
    expect(b).toMatch(/\{notice\.action\.label\}/);
    expect(b.match(/setOpen\(false\)/g)!.length).toBeGreaterThanOrEqual(2);
    const code = b.split(String.fromCharCode(10)).filter(l => !l.trim().startsWith("//")).join(" ");
    expect(code).not.toMatch(/audio|engine|stopAll|automation/i);
  });
  it("every connect answer feeds it; it replaced the blocking trial overlay", () => {
    expect(read("lib/ccData.ts")).toMatch(/publishBillingNotice\(\(data as any\)\?\.billing_notice \?\? null\)/);
    expect(read("App.tsx")).toMatch(/<BillingBanner \/>/);
    expect(read("App.tsx")).not.toMatch(/<TrialGate \/>/);
  });
});
