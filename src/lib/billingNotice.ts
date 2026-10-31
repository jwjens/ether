// THE BILLING NOTICE (Jeff, 2026-10-31: trial ending / ended / payment failed / card expired / grace / lapsed). The
// server decides which one applies (C:\ether-backend src/lib/billing-notice.js) and sends it with every /account/connect
// answer as `billing_notice`; the running app already polls that every 20 s (src/lib/ccData.ts). This holds the latest
// one for the banner. The lapse rule (docs/paywall-entitlements-plan.md): a banner only — never a blocking screen,
// never anything that touches audio or playout.
export interface BillingNotice {
  kind: "trial_ending" | "trial_ended" | "payment_failed" | "card_expired" | "card_expiring" | "grace" | "lapsed";
  title: string;
  body: string;
  action?: { label: string; url: string } | null;
  severity?: "info" | "warning" | "critical";
  endsAt?: string | null;
  daysLeft?: number | null;
}

let current: BillingNotice | null = null;
const listeners = new Set<(n: BillingNotice | null) => void>();

/** A connect answer arrived: keep its notice (null = none). A malformed one is dropped, never guessed. */
export function publishBillingNotice(n: unknown): void {
  const ok = n && typeof n === "object" && typeof (n as any).kind === "string" && typeof (n as any).title === "string";
  current = ok ? (n as BillingNotice) : null;
  for (const l of listeners) l(current);
}
export function getBillingNotice(): BillingNotice | null { return current; }
export function onBillingNotice(fn: (n: BillingNotice | null) => void): () => void {
  listeners.add(fn); return () => { listeners.delete(fn); };
}

/** Dismissed for 24 hours, per notice (kind + its date), on this computer. A different notice shows at once. */
export const DISMISS_MS = 24 * 3600 * 1000;
export const dismissKey = (n: BillingNotice) => `ether_billing_dismissed:${n.kind}:${n.endsAt || ""}`;
export function isDismissed(n: BillingNotice, now = Date.now(), store: Pick<Storage, "getItem"> = localStorage): boolean {
  try { const t = Number(store.getItem(dismissKey(n))); return Number.isFinite(t) && t > 0 && now - t < DISMISS_MS; } catch { return false; }
}
export function dismiss(n: BillingNotice, now = Date.now(), store: Pick<Storage, "setItem"> = localStorage): void {
  try { store.setItem(dismissKey(n), String(now)); } catch { /* ignore */ }
}
