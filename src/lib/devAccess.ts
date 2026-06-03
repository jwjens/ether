// Gate for the in-app dev tools (tier-override Debug Panel + console helpers).
//
// History: these tools used to be gated purely on `import.meta.env.DEV`, so they
// vanished from packaged builds ("lost in updates"). They are now available in any
// build when the OWNER license key is the active license — so the owner install keeps
// the tier picker, while customers (Stripe-issued keys) never see it and can't
// self-grant a paid tier.
export const OWNER_LICENSE_KEY = "ETHER-OWNER-2026";

// True when the dev tools should be available: always in the dev server, or in any
// build when the owner license key is active for station 1 (the station the debug
// panel itself reads/writes).
export async function isDevToolsEnabled(): Promise<boolean> {
  if (import.meta.env.DEV) return true;
  try {
    const ether = (window as any).ether;
    const result = await ether?.stationConfigKv?.list?.(1);
    if (!result?.ok) return false;
    const key = result.rows.find((r: { key: string }) => r.key === "license_key")?.value;
    return String(key ?? "").trim() === OWNER_LICENSE_KEY;
  } catch {
    return false;
  }
}
