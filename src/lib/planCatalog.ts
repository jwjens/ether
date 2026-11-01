// THE PLAN CATALOG ON THE DESKTOP (Jeff's prices, 2026-10-31 / 11-01). Every price, name and limit comes from the
// backend (GET /public/plans = C:\ether-backend config/plans.json), never typed here: one edit there changes the
// Subscription screen too. Pure functions; the screen is src/components/PlanCatalogCards.tsx.
export interface CatalogPlan {
  label: string; price_monthly: number; price_annual?: number; per?: "account" | "station" | "stream";
  stations_included?: number; max_bitrate_kbps?: number; listeners_per_stream?: number; listener_pool?: number;
  cloud: boolean; priority_support?: boolean; extra_station?: { price_monthly: number; listeners: number }; summary?: string;
}
export interface Catalog {
  trial: { days: number; requires_card: boolean };
  plans: Record<string, CatalogPlan>;
  addons?: Record<string, { label: string; price_monthly: number; listeners?: number }>;
  discounts?: { annual_months_charged?: number };
}
export interface PlanCard { key: string; name: string; monthly: number; annual: number | null; per: string; feats: string[] }

const ORDER = ["local", "station", "pro", "unlimited"];

export function planCards(c: Catalog): PlanCard[] {
  const keys = [...ORDER.filter(k => c.plans[k]), ...Object.keys(c.plans).filter(k => !ORDER.includes(k))];
  const addon = c.addons?.listeners_50;
  return keys.map(k => {
    const p = c.plans[k];
    const feats: string[] = [];
    if (!p.cloud) {
      feats.push("The full desktop app on every computer", "Your own Icecast stream", "Updates included", "No cloud features");
    } else {
      feats.push(p.stations_included ? `${p.stations_included} hosted stations` : "1 hosted station");
      if (p.max_bitrate_kbps) feats.push(`${p.max_bitrate_kbps} kbps${p.stations_included ? " per station" : ""}`);
      if (p.listener_pool) feats.push(`${p.listener_pool} listeners shared across your stations`);
      else if (p.listeners_per_stream) feats.push(`${p.listeners_per_stream} listeners`);
      feats.push("Every cloud feature: web dashboard, remote, sync, backup, cloud library");
      if (p.priority_support) feats.push("Priority support");
      if (p.extra_station) feats.push(`Extra stations $${p.extra_station.price_monthly}/mo each, +${p.extra_station.listeners} listeners`);
      if (addon && !p.extra_station) feats.push(`+${addon.listeners ?? 50} listeners: $${addon.price_monthly}/mo`);
    }
    const per = p.per === "station" || p.per === "stream" ? "per station / month" : "per month";
    return { key: k, name: p.label, monthly: p.price_monthly, annual: p.price_annual ?? null, per, feats };
  });
}

/** "or $200/yr (2 months free)", from the catalog's own months-charged rule. */
export function annualLine(card: PlanCard, c: Catalog): string | null {
  if (card.annual == null) return null;
  const months = c.discounts?.annual_months_charged;
  const free = months && months < 12 ? ` (${12 - months} months free)` : "";
  return `or $${card.annual}/yr${free}`;
}

/** The footer line: the trial as the catalog states it. */
export function trialLine(c: Catalog): string {
  return `${c.trial.days}-day free trial${c.trial.requires_card ? "" : ", no card needed"} · Cancel anytime`;
}
