// THE BILLING NOTICE (Jeff, 2026-10-31: trial ending / ended / payment failed / card expired / grace / lapsed). The
// server decides which one applies (C:\ether-backend src/lib/billing-notice.js) and sends it with every /account/connect
// answer as `billing_notice`; the running app already polls that every 20 s (src/lib/ccData.ts). This holds the latest
// one for the popup. The lapse rule (docs/paywall-entitlements-plan.md): never a blocking screen, never anything that
// touches audio or playout.
export interface BillingNotice {
  kind: "trial_ending" | "trial_ended" | "payment_failed" | "card_expired" | "card_expiring" | "grace" | "lapsed";
  title: string;
  body: string;
  action?: { label: string; url: string } | null;
  severity?: "info" | "warning" | "error" | "critical";
  endsAt?: string | null;
  daysLeft?: number | null;
  /** The period the notice is about (the server's period_key: the day a payment failed, the card's month, …). */
  period_key?: string | null;
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

// WHEN THE POPUP SHOWS (Jeff, 2026-10-31; 2026-11-01): "when Ether opens, and at most once a day after that while
// Ether runs" — and "once a day" applies only to the SAME notice repeating. A different notice (payment failed after
// "card expires soon", plan ended, lapsed after grace) shows right away, even if another popup was closed that day.
// The first notice of a run shows at once. Later always closes it (until it is due again).
// (Billing test 2026-11-01: a payment failure's popup waited up to a day behind an earlier "card expires soon".)
export const SHOW_EVERY_MS = 24 * 3600 * 1000;
const LAST_SHOWN_KEY = "ether_billing_popup_last_shown";
const LAST_ID_KEY = "ether_billing_popup_last_id";
let shownThisRun = false;
/** Which notice this is: the same kind about the same period, offering the same way out, is the same notice. */
export function noticeId(n: Pick<BillingNotice, "kind" | "period_key" | "action"> | null | undefined): string {
  return n ? `${n.kind}|${n.period_key ?? ""}|${n.action?.label ?? ""}` : "";
}
export function shouldShowPopup(now = Date.now(), store: Pick<Storage, "getItem"> = localStorage, firstThisRun = !shownThisRun,
  notice?: Pick<BillingNotice, "kind" | "period_key" | "action"> | null): boolean {
  if (firstThisRun) return true;
  try {
    if (notice && noticeId(notice) !== (store.getItem(LAST_ID_KEY) || "")) return true;   // a different notice: now
    const t = Number(store.getItem(LAST_SHOWN_KEY));
    return !(Number.isFinite(t) && t > 0) || now - t >= SHOW_EVERY_MS;
  } catch { return false; }
}
export function markPopupShown(now = Date.now(), store: Pick<Storage, "setItem"> = localStorage,
  notice?: Pick<BillingNotice, "kind" | "period_key" | "action"> | null): void {
  shownThisRun = true;
  try { store.setItem(LAST_SHOWN_KEY, String(now)); if (notice) store.setItem(LAST_ID_KEY, noticeId(notice)); } catch { /* ignore */ }
}
/** Tests only. */
export function _resetRun(): void { shownThisRun = false; }
