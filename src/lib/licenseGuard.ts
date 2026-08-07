// ── LICENSE VALIDATION LAYER ──────────────────────────────────────────────────────────────────────
// The pay structure already exists; this is the layer that keeps it honest — and it is why OV went
// stale. Adobe/Avid pattern: validate quietly, heal automatically, and NEVER take a station off air
// because a license server was unreachable.
//
// The user's credential is EMAIL + PASSWORD. The license key is internal: assigned per account,
// managed by the app, never seen or typed by an operator.
//
// Rules this file exists to enforce:
//   1. Sign-in stamps the account's current key into all three slots (ccData.stampLicenseEverywhere).
//   2. A 401 tries every other stored key before giving up (ccData.healStaleLicense).
//   3. Re-validate + re-stamp silently on EVERY LAUNCH when signed in.
//   4. Re-validate on an interval while running — silently.
//   5. OFFLINE GRACE — unreachable backend never locks out and never stops audio. Days of grace, then
//      a notice at most. A station going dark because the internet did is not acceptable.
//   6. Only a CONFIRMED revoke/expire is ever surfaced. Never a transient network miss.
//
// docs/desktop-signin-license-stamping-2026-08-07.md · docs/ov-license-401-stale-key-2026-08-06.md

import { ETHER_BACKEND_URL } from "./etherBackend";
import { stampLicenseEverywhere } from "./ccData";

export type LicenseState = "ok" | "offline" | "revoked" | "unknown";

export interface LicenseDecision {
  state: LicenseState;
  /** Re-stamp the three slots with this key. */
  stamp?: string;
  /** Try the other stored keys — the anchor was rejected. */
  heal: boolean;
  /** Show something to the operator. ONLY ever true for a confirmed revoke. */
  surface: boolean;
  /** Keep running regardless — this is never false. Stated explicitly so it cannot be "optimised" away. */
  keepRunning: true;
  reason: string;
}

/** Grace before a persistently unreachable backend is even mentioned. Airing is never affected. */
export const GRACE_DAYS = 14;
const DAY_MS = 86_400_000;

/**
 * PURE decision function — no I/O, no globals. This is the part worth testing, and the part that must
 * never get a network failure confused with a revoked licence.
 */
export function decideLicenseAction(input: {
  ok: boolean;
  status?: number | null;
  errorCode?: string | null;
  networkError?: boolean;
  licenseKey?: string | null;
  lastValidatedAt?: number | null;
  now?: number;
  graceDays?: number;
}): LicenseDecision {
  const now = input.now ?? Date.now();
  const graceMs = (input.graceDays ?? GRACE_DAYS) * DAY_MS;

  // Backend said yes. Re-stamp and record the moment.
  if (input.ok) {
    return { state: "ok", stamp: input.licenseKey || undefined, heal: false, surface: false,
             keepRunning: true, reason: "validated" };
  }

  // Could not reach the backend AT ALL. This is the case that must never punish the operator: an
  // outage, a router reboot, a venue with no WAN. Keep running, say nothing, try again later.
  if (input.networkError) {
    const last = input.lastValidatedAt ?? null;
    const beyondGrace = last != null && now - last > graceMs;
    return {
      state: "offline",
      heal: false,
      // Past the grace window we mention it ONCE — still no lock-out, still on air.
      surface: beyondGrace,
      keepRunning: true,
      reason: beyondGrace
        ? `offline beyond ${input.graceDays ?? GRACE_DAYS}d grace (last ok ${last ? new Date(last).toISOString() : "never"})`
        : "offline within grace",
    };
  }

  // The backend answered and rejected the key. That is not proof the ACCOUNT is dead — the key may
  // simply be stale (OV). Heal first; only a heal that also fails is a confirmed revoke.
  if (input.status === 401 || input.errorCode === "invalid_license_key" || input.errorCode === "no_license") {
    return { state: "unknown", heal: true, surface: false, keepRunning: true,
             reason: "key rejected — trying other stored keys" };
  }

  // Explicit end-of-entitlement from the backend. This is the ONLY thing worth telling an operator.
  if (input.status === 402 || input.errorCode === "license_expired" || input.errorCode === "subscription_cancelled") {
    return { state: "revoked", heal: false, surface: true, keepRunning: true,
             reason: input.errorCode || `http ${input.status}` };
  }

  // Anything else (500s, gateway errors, nonsense) is treated like an outage: never the operator's
  // problem, never a lock-out.
  return { state: "offline", heal: false, surface: false, keepRunning: true,
           reason: `unhandled response ${input.status ?? "?"} ${input.errorCode ?? ""}`.trim() };
}

/** Slots the transport resolves from, in priority order — read for validation. */
async function resolveLicenseKey(): Promise<string | null> {
  const ether = (window as any).ether;
  try {
    const anchor = (await ether.installConfigKv?.list?.())?.rows?.find?.((r: any) => r.key === "account_license_key");
    if (anchor?.value) return String(anchor.value).trim();
  } catch { /* fall through */ }
  try {
    const local = await ether.stations.list();
    const list = (Array.isArray(local) ? local : (local?.rows || [])) as any[];
    const withKey = list.find(s => !s.deleted_at && s.owner_license_key);
    if (withKey?.owner_license_key) return String(withKey.owner_license_key).trim();
  } catch { /* fall through */ }
  return null;
}

async function readNumber(key: string): Promise<number | null> {
  try {
    const rows = (await (window as any).ether.installConfigKv?.list?.())?.rows || [];
    const v = rows.find((r: any) => r.key === key)?.value;
    const n = v ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

/**
 * One validation pass. Silent unless the backend CONFIRMS the entitlement is gone.
 * Never throws, never blocks, never stops audio.
 */
export async function validateLicense(reason: string): Promise<LicenseDecision> {
  const ether = (window as any).ether;
  const licenseKey = await resolveLicenseKey();
  if (!licenseKey) {
    return { state: "unknown", heal: false, surface: false, keepRunning: true, reason: "no license on this install" };
  }

  const idResp = await ether.identity?.get?.().catch(() => null);
  let ok = false, status: number | null = null, errorCode: string | null = null, networkError = false;
  try {
    const res = await fetch(`${ETHER_BACKEND_URL}/account/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        license_key:  licenseKey,
        machine_id:   idResp?.ok ? idResp.machine_id   : "",
        machine_name: idResp?.ok ? idResp.machine_name : "",
      }),
    });
    status = res.status;
    ok = res.ok;
    if (!ok) { const d = await res.json().catch(() => ({})); errorCode = String((d as any)?.error || "") || null; }
  } catch {
    networkError = true;                       // unreachable — an outage, not a verdict
  }

  const lastValidatedAt = await readNumber("license_last_validated_at");
  const decision = decideLicenseAction({ ok, status, errorCode, networkError, licenseKey, lastValidatedAt });

  try {
    if (decision.stamp) {
      await stampLicenseEverywhere(decision.stamp);
      await ether.installConfigKv?.upsertByKey?.("license_last_validated_at", String(Date.now()));
    }
    await ether.installConfigKv?.upsertByKey?.("license_state", decision.state);
  } catch { /* persistence is best-effort — it must never break a launch */ }

  if (decision.heal) {
    // The anchor was rejected; ccData's reconcile owns the recovery (bounded to one pass) and will
    // stamp whatever the backend accepts.
    try {
      const { reconcileAccountStations } = await import("./ccData");
      await reconcileAccountStations(licenseKey);
    } catch { /* next tick */ }
  }

  if (decision.surface) {
    try { window.dispatchEvent(new CustomEvent("ether:license-attention", { detail: decision })); } catch {}
  }
  console.log(`[license] ${reason}: ${decision.state} — ${decision.reason}`);
  return decision;
}

/**
 * Launch + heartbeat. Fire-and-forget; every failure path is swallowed so a licence check can never be
 * the reason a station does not come up.
 */
const HEARTBEAT_MS = 6 * 60 * 60 * 1000;   // 6h — entitlement changes are rare; hammering is rude
let started = false;

export function startLicenseGuard(): () => void {
  if (started) return () => {};
  started = true;
  const run = (why: string) => { validateLicense(why).catch(() => {}); };

  // 3. Every launch, once the app has settled — background, invisible when healthy.
  const launchTimer = setTimeout(() => run("launch"), 12_000);
  // 4. Periodic while running.
  const beat = setInterval(() => run("heartbeat"), HEARTBEAT_MS);
  // Re-check the moment the machine is back online, so grace ends as soon as it can.
  const onOnline = () => run("back online");
  try { window.addEventListener("online", onOnline); } catch {}

  return () => {
    clearTimeout(launchTimer); clearInterval(beat);
    try { window.removeEventListener("online", onOnline); } catch {}
    started = false;
  };
}
