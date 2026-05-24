// Dev-only globals attached to window for DevTools console use.
// The entire module is dead code in production — main.tsx imports it
// conditionally on `import.meta.env.DEV` so Vite tree-shakes it out
// of the prod bundle entirely.

import { setPlanGlobally, type PlanTier } from "../hooks/usePlan";

// Marketing label → internal tier code. Mirrors the mapping in DebugPanel.tsx;
// keeping them duplicated avoids importing the panel from globals (which would
// pull in React + a panel of UI just to expose 3 functions to the console).
const TIER_BY_LABEL: Record<string, PlanTier> = {
  solo:       "free",
  studio:     "pro",
  network:    "station",
  enterprise: "operator",
};

type DevLabel = keyof typeof TIER_BY_LABEL;

// Same set of onboarding KV keys that DebugPanel's Reset Onboarding clears.
// See DebugPanel.tsx for rationale on what's in vs. out of this list.
const ONBOARDING_KEYS = [
  "first_run_complete",
  "onboarding_library_pulled",
  "onboarding_path",
  "onboarding_license_entered",
  "onboarding_account_joined",
  "experience_mode",
  "venue_type",
];

async function setTier(label: DevLabel): Promise<void> {
  const code = TIER_BY_LABEL[label];
  if (!code) {
    console.error(`[dev] unknown tier label "${label}". Use one of: ${Object.keys(TIER_BY_LABEL).join(", ")}`);
    return;
  }
  const ether = (window as any).ether;
  await ether.stationConfigKv.upsertByKey(1, "plan_tier_dev_override", label);
  setPlanGlobally(code);
  window.dispatchEvent(new CustomEvent("ether:dev-tier-override-changed"));
  console.log(`[dev] tier override set: ${label} (${code})`);
}

async function clearTier(): Promise<void> {
  const ether = (window as any).ether;
  await ether.stationConfigKv.removeByKey(1, "plan_tier_dev_override");
  window.dispatchEvent(new CustomEvent("ether:dev-tier-override-changed"));
  console.log(`[dev] tier override cleared — real license will take over on next read`);
  // Tell usePlan to re-read from license-driven plan_tier
  window.dispatchEvent(new Event("station-switched"));
}

async function resetOnboarding(): Promise<void> {
  const ether = (window as any).ether;
  for (const key of ONBOARDING_KEYS) {
    try { await ether.stationConfigKv.removeByKey(1, key); } catch { /* key may not exist */ }
  }
  console.log(`[dev] onboarding state cleared — reloading...`);
  setTimeout(() => window.location.reload(), 100);
}

declare global {
  interface Window {
    __devSetTier?: (label: DevLabel) => Promise<void>;
    __devClearTier?: () => Promise<void>;
    __devResetOnboarding?: () => Promise<void>;
  }
}

export function initDevGlobals(): void {
  window.__devSetTier = setTier;
  window.__devClearTier = clearTier;
  window.__devResetOnboarding = resetOnboarding;
  console.log("[dev] globals attached: __devSetTier('studio') / __devClearTier() / __devResetOnboarding()");
}

export { ONBOARDING_KEYS, TIER_BY_LABEL };
export type { DevLabel };
