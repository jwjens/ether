import { etherConfirm } from "../lib/etherConfirm";
import { appVersionField } from "../lib/appVersion";
import { useState, useEffect } from "react";
import { stampLicenseEverywhere } from "../lib/ccData";
import { useActiveStation } from "../hooks/useActiveStation";
import { ETHER_BACKEND_URL } from "../lib/etherBackend";
import { setPlanGlobally, usePlan } from "../hooks/usePlan";
import { planName } from "../lib/planLabels";
import PlanCatalogCards from "./PlanCatalogCards";

// Plans are sold on the account site (PlanCatalogCards opens it); this screen holds no Stripe link or price of its own.

export type PlanTier = "free" | "pro" | "station" | "pro_lifetime" | "station_lifetime" | "operator" | "unlimited";

export default function SubscriptionPanel() {
  // Effective plan from usePlan() — override-aware and reactive, so the dev tier picker
  // (and any license change) updates THIS screen too, not just the rest of the app.
  const { plan } = usePlan();
  const currentPlan = plan as PlanTier;
  const [licenseKey, setLicenseKey]         = useState("");
  const [licenseEmail, setLicenseEmail]     = useState("");
  const [showLicenseEntry, setShowLicenseEntry] = useState(false);
  const [pendingPlan, setPendingPlan]       = useState<PlanTier | null>(null);
  const [licenseError, setLicenseError]     = useState("");
  const [licenseSuccess, setLicenseSuccess] = useState(false);
  const [loading, setLoading]               = useState(false);
  // Account sign-in (desktop activation bridge) — trial users activate with their web email/password.
  const [showSignIn, setShowSignIn]         = useState(false);
  const [acctEmail, setAcctEmail]           = useState("");
  const [acctPassword, setAcctPassword]     = useState("");
  const [signinError, setSigninError]       = useState("");
  const [signinLoading, setSigninLoading]   = useState(false);
  const { stationId, isReady } = useActiveStation();

  useEffect(() => {
    if (!isReady) return;
    (async () => {
      try {
        const result = await (window as any).ether.stationConfigKv.list(stationId);
        const rows: { key: string; value: string }[] = result.ok ? result.rows : [];
        const email = rows.find((r: { key: string }) => r.key === 'license_email')?.value;
        if (email) setLicenseEmail(email);
      } catch {}
    })();
  }, [stationId, isReady]);

  const validateLicense = async () => {
    const ADMIN_KEYS: Record<string, PlanTier> = {
      "ETHER-OWNER-2026":    "station",
      "ETHER-ADMIN-STATION": "station",
      "ETHER-ADMIN-PRO":     "pro",
      "ETHER-DEV-STATION":   "station",
      "ETHER-DEV-PRO":       "pro",
    };
    const trimmedKey = licenseKey.trim();
    if (ADMIN_KEYS[trimmedKey]) {
      const tier = ADMIN_KEYS[trimmedKey];
      setLoading(true);
      // TIER IS ACCOUNT-LEVEL: persist at INSTALL scope (install_config_kv) so usePlan reads it
      // independent of any station/local id. License key/email stay station-scoped (license binding).
      await (window as any).ether.installConfigKv.upsertByKey('plan_tier', tier);
      await (window as any).ether.stationConfigKv.upsertByKey(stationId, 'license_key', trimmedKey);
      window.dispatchEvent(new CustomEvent('ether:license-changed'));
      if (licenseEmail.trim()) {
        await (window as any).ether.stationConfigKv.upsertByKey(stationId, 'license_email', licenseEmail.trim());
      }
      setPlanGlobally(tier);
      setLicenseSuccess(true);
      setShowLicenseEntry(false);
      setTimeout(() => setLicenseSuccess(false), 4000);
      setLoading(false);
      return;
    }
    if (!licenseKey.trim() || !licenseEmail.trim()) {
      setLicenseError("Please enter your email and license key.");
      return;
    }
    setLoading(true);
    setLicenseError("");
    try {
      // Send a stable per-machine id (client_identity) so seats are tracked per machine, not per
      // email. If identity isn't available the backend falls back to a per-email seat.
      let machine_id = "", machine_name = "";
      try {
        const idResp = await (window as any).ether.identity?.get?.();
        if (idResp?.ok) { machine_id = idResp.machine_id || ""; machine_name = idResp.machine_name || ""; }
      } catch { /* fall through — backend treats absent machine_id as a per-email seat */ }
      const res = await fetch(`${ETHER_BACKEND_URL}/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ license_key: licenseKey.trim(), email: licenseEmail.trim(), machine_id, machine_name, os: navigator.platform }),
      });
      const data = await res.json();
      if (!data.valid) {
        setLicenseError(data.error || "Invalid license key. Please check and try again.");
        setLoading(false);
        return;
      }
      await (window as any).ether.installConfigKv.upsertByKey('plan_tier', data.plan);   // account-level tier (install scope)
      await (window as any).ether.stationConfigKv.upsertByKey(stationId, 'license_key', licenseKey.trim());
      window.dispatchEvent(new CustomEvent('ether:license-changed'));
      await (window as any).ether.stationConfigKv.upsertByKey(stationId, 'license_email', licenseEmail.trim());
      setPlanGlobally(data.plan as PlanTier);
      setLicenseSuccess(true);
      setShowLicenseEntry(false);
      setTimeout(() => setLicenseSuccess(false), 4000);
    } catch {
      setLicenseError("Could not reach the license server. Check your internet connection.");
    }
    setLoading(false);
  };

  // Desktop activation bridge — sign in with the web account; the backend provisions/returns the
  // license (Network trial or paid), we store it the same way as a key activation, and unlock.
  const signInActivate = async () => {
    if (!acctEmail.trim() || !acctPassword) { setSigninError("Enter your email and password."); return; }
    setSigninLoading(true); setSigninError("");
    try {
      let machine_id = "", machine_name = "";
      try {
        const idResp = await (window as any).ether.identity?.get?.();
        if (idResp?.ok) { machine_id = idResp.machine_id || ""; machine_name = idResp.machine_name || ""; }
      } catch { /* backend falls back to a per-account seat if absent */ }
      const res = await fetch(`${ETHER_BACKEND_URL}/api/user/desktop-activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: acctEmail.trim(), password: acctPassword, machine_id, machine_name, os: navigator.platform, ...appVersionField() }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setSigninError(
          data.error === "invalid_credentials" ? "Email or password is incorrect."
          : data.message || "Could not sign in. Please try again."
        );
        setSigninLoading(false);
        return;
      }
      const kv = (window as any).ether.stationConfigKv;
      await (window as any).ether.installConfigKv.upsertByKey('plan_tier', data.plan);   // account-level tier (install scope)
      // Stamp the account's CURRENT key into ALL THREE slots the sync transport resolves from, not
      // just this station's legacy one. Writing only station_config_kv left a stale
      // `account_license_key` anchor in charge, so an install could sign in with correct credentials
      // and STILL sync with a dead key — 401 invalid_license_key forever, with nothing the operator
      // could do about it. Signing in is how a machine heals now; the user never sees a key.
      // docs/ov-license-401-stale-key-2026-08-06.md
      if (data.license_key) {
        await kv.upsertByKey(stationId, 'license_key', data.license_key);
        try { await stampLicenseEverywhere(String(data.license_key).trim()); }
        catch (e) { console.warn('[signin] license stamp failed:', (e as any)?.message ?? e); }
      }
      await kv.upsertByKey(stationId, 'license_email', data.email);
      // Store/clear the trial end date so TrialGate can run the end-of-trial choice.
      if (data.trial && data.trial_ends_at) await kv.upsertByKey(stationId, 'trial_ends_at', data.trial_ends_at);
      else await kv.removeByKey(stationId, 'trial_ends_at');
      setPlanGlobally(data.plan as PlanTier);
      window.dispatchEvent(new CustomEvent('ether:license-changed'));
      setAcctPassword("");
      setLicenseSuccess(true);
      setShowSignIn(false);
      setTimeout(() => setLicenseSuccess(false), 4000);
    } catch {
      setSigninError("Could not reach the server. Check your internet connection.");
    }
    setSigninLoading(false);
  };

  const cancelPlan = async () => {
    if (!(await etherConfirm("Downgrade to Free? You'll keep access until the end of your billing period.", { danger: true }))) return;
    await (window as any).ether.installConfigKv.upsertByKey('plan_tier', 'free');   // account-level tier (install scope)
    await (window as any).ether.stationConfigKv.removeByKey(stationId, 'license_key');
    setPlanGlobally("free");
  };

  // switchAccount — REMOVED (4.4.216). It stripped license_key / license_email / plan_tier and the
  // onboarding flags out of the CURRENT account's database and relaunched, which under
  // profile-per-account damages the profile it leaves behind rather than switching away from it.
  // There is one door out of an account now: File ▸ Sign Out, which closes Ether completely.

  const planColor = (plan: PlanTier) => {
    if (plan === "pro")              return "var(--accent-cyan)";
    if (plan === "station")          return "#a78bfa";
    if (plan === "pro_lifetime")     return "#f59e0b";
    if (plan === "station_lifetime") return "#f59e0b";
    if (plan === "operator")         return "#10b981";
    if (plan === "unlimited")        return "#10b981";
    return "#34d399";
  };

  const planLabel = (plan: PlanTier) => {
    // One table of names (src/lib/planLabels.ts): station / pro / unlimited carry the catalog's names.
    return planName(plan);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column" as const, gap: 0, fontFamily: "'Inter', system-ui, sans-serif", maxWidth: 1240, margin: "0 auto", padding: "0 24px 40px" }}>

      {/* Header */}
      <div style={{ padding: "32px 0 20px" }}>
        <h1 style={{ fontFamily: "'Newsreader', Georgia, serif", fontSize: 28, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--text-primary)", margin: 0, marginBottom: 8 }}>
          Subscription
        </h1>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 13, color: "var(--text-tertiary)" }}>Current plan:</span>
          <span style={{
            padding: "3px 12px", borderRadius: 0, fontSize: 11, fontWeight: 700,
            letterSpacing: "0.1em", textTransform: "uppercase" as const,
            background: `${planColor(currentPlan)}20`,
            color: planColor(currentPlan),
            border: `1px solid ${planColor(currentPlan)}40`,
          }}>
            {planLabel(currentPlan)}
          </span>
          {licenseSuccess && <span style={{ fontSize: 12, color: "#34d399", fontWeight: 600 }}>✓ License activated!</span>}
          {currentPlan !== "free" && (
            <button
              onClick={() => window.dispatchEvent(new CustomEvent("ether:open-managedevices"))}
              style={{
                marginLeft: "auto",
                padding: "5px 12px", borderRadius: 0, fontSize: 11, fontWeight: 600,
                background: "var(--bg-tertiary)", color: "var(--text-secondary)",
                border: "1px solid var(--border-primary)", cursor: "pointer",
                letterSpacing: "0.02em",
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "var(--accent-cyan)"; (e.currentTarget as HTMLElement).style.borderColor = "var(--accent-cyan)"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)"; (e.currentTarget as HTMLElement).style.borderColor = "var(--border-primary)"; }}
            >
              Manage Devices →
            </button>
          )}
        </div>
      </div>

      {/* Activate — sign in with the Ether account (Jeff, 2026-11-01: the email is the license; customers never use a key).
          Lives at the top so the form it opens (directly below) appears right here, not off-screen. */}
      <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, padding: "18px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" as const, marginBottom: 24 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>Activate Ether</div>
          <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>Sign in with your Ether account.</div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={() => { setShowSignIn(true); setShowLicenseEntry(false); setSigninError(""); }} style={{ padding: "9px 20px", borderRadius: 0, background: "var(--accent-cyan)", border: "none", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
            Sign In
          </button>
        </div>
      </div>

      {/* Account sign-in — desktop activation bridge */}
      {showSignIn && (
        <div style={{
          background: "var(--bg-secondary)", border: "1px solid rgb(from var(--accent-cyan) r g b / 0.35)",
          borderRadius: 0, padding: 28, marginBottom: 24,
          boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
        }}>
          <div style={{ fontFamily: "'Newsreader', Georgia, serif", fontSize: 16, fontWeight: 700, color: "var(--text-primary)", marginBottom: 6 }}>
            Sign in to activate
          </div>
          <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginBottom: 20 }}>
            Use the email and password from your Ether account. During your free trial this unlocks the full Unlimited plan.
          </div>
          <div style={{ display: "flex", flexDirection: "column" as const, gap: 10 }}>
            <input
              type="email"
              placeholder="Email address"
              value={acctEmail}
              onChange={e => setAcctEmail(e.target.value)}
              style={{ padding: "10px 14px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", fontFamily: "'Inter', sans-serif" }}
            />
            <input
              type="password"
              placeholder="Password"
              value={acctPassword}
              onChange={e => setAcctPassword(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") signInActivate(); }}
              style={{ padding: "10px 14px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", fontFamily: "'Inter', sans-serif" }}
            />
            {signinError && <div style={{ fontSize: 12, color: "#f87171" }}>{signinError}</div>}
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={signInActivate} disabled={signinLoading} style={{ flex: 1, padding: "10px 0", borderRadius: 0, background: "var(--accent-cyan)", color: "#fff", border: "none", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "'Newsreader', Georgia, serif" }}>
                {signinLoading ? "Signing in..." : "Sign In & Activate"}
              </button>
              <button onClick={() => { setShowSignIn(false); setSigninError(""); }} style={{ padding: "10px 16px", borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", fontSize: 13, cursor: "pointer" }}>
                Cancel
              </button>
            </div>
            <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
              No account yet?{" "}
              <span style={{ color: "var(--accent-cyan)", cursor: "pointer", fontWeight: 600 }} onClick={() => { try { (window as any).ether.invoke("open_url", { url: "https://signup.ether-technologies.com" }); } catch {} }}>
                Start a free trial →
              </span>
            </div>
          </div>
        </div>
      )}


      {/* ── PLANS — from the catalog (GET /public/plans), Jeff's prices 2026-10-31 ── */}
      <PlanCatalogCards current={currentPlan} />
    </div>
  );
}
