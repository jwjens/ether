// src/lib/planLabels.ts — the plan NAMES the desktop shows (dead-controls item 20c: old names Studio / Network still on
// screen). Names only: no gate, rank, entitlement or license logic lives or changes here (usePlan's TIER_RANK decides who
// gets what, unchanged).
//
// The catalog (C:\ether-backend\config\plans.json v2, Jeff's prices 2026-10-31) sells Local, Live 128, Live 320 and
// Network. The server keys station / pro / unlimited are those plans, so they take the catalog's names.
// Keys the catalog does not sell: the old free key stays "Free (old key)" (license 21, Jeff 2026-11-01); lifetime keys
// and operator are the top plan forever (docs/pricing-2026-10-31-before-build.md) — names only, no license changes.

const CATALOG_NAME: Record<string, string> = { local: "Local", station: "Live 128", pro: "Live 320", unlimited: "Network" };
const LEGACY_NAME: Record<string, string> = { free: "Free (old key)", pro_lifetime: "Network (Lifetime)", station_lifetime: "Network (Lifetime)", operator: "Network (Enterprise)" };

/** The name of the plan a license is on. */
export function planName(key: string | null | undefined): string {
  const k = String(key || "free");
  return CATALOG_NAME[k] || LEGACY_NAME[k] || k;
}

// The desktop's existing ranks (usePlan.tsx TIER_RANK) — read, never changed, so the words match what the gate does.
const RANK: Record<string, number> = { free: 0, pro: 1, pro_lifetime: 1, station: 2, station_lifetime: 2, operator: 3, unlimited: 3 };
const CATALOG_ORDER = ["station", "pro", "unlimited"];

/** "Live 128, Live 320 or Network" — the catalog plans that pass a gate of `required`, by the gate's own rank. */
export function requiredPlansText(required: string): string {
  const need = RANK[required] ?? 99;
  const names = CATALOG_ORDER.filter(k => (RANK[k] ?? 0) >= need).map(k => CATALOG_NAME[k]);
  if (names.length === 0) return planName(required);
  if (names.length === 1) return names[0];
  return names.slice(0, -1).join(", ") + " or " + names[names.length - 1];
}
