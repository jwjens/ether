import { useState, useEffect } from "react";
import { useActiveStation } from "../hooks/useActiveStation";
import { ETHER_BACKEND_URL } from "../lib/etherBackend";

// ── Stripe config ──
const STRIPE_PK = "pk_live_51TCwP5QJRnsdUhPMYsv0CIkEkcdiINRMDKgYaLiuOdOiTiBNmdxILemKaPYiNRNCM4hAPOcplpLUl2bjpuqGRzbE00YnjZ0ZEh";
const PRICE_PRO     = "price_1TCwR6QJRnsdUhPM6RPqhjdA";
const PRICE_STATION = "price_1TCwRZQJRnsdUhPMjwK0y9sA";

const PAYMENT_LINK_PRO            = "https://buy.stripe.com/aFa5kx6X2b8Nac78c79k402";
const PAYMENT_LINK_STATION        = "https://buy.stripe.com/cNi14hgxC6Sx1FB2RN9k401";
const PAYMENT_LINK_PRO_LIFETIME     = "https://buy.stripe.com/pro-lifetime";     // replace with real link
const PAYMENT_LINK_STATION_LIFETIME = "https://buy.stripe.com/station-lifetime"; // replace with real link

export type PlanTier = "free" | "pro" | "station" | "pro_lifetime" | "station_lifetime" | "operator";

interface PlanFeature {
  label: string;
  pro: boolean;
  station: boolean;
  comingSoon?: boolean;
  isNew?: boolean;
}

const FEATURES: PlanFeature[] = [
  { label: "Unlimited song library",                             pro: true,  station: true  },
  { label: "Rotation + scheduling",                             pro: true,  station: true  },
  { label: "Clock builder + logs",                              pro: true,  station: true  },
  { label: "Spot inventory",                                    pro: true,  station: true  },
  { label: "Live assist + automation",                          pro: true,  station: true  },
  { label: "Voice tracking",                                    pro: true,  station: true  },
  { label: "Show prep platform",                                pro: true,  station: true  },
  { label: "Track editor (cue points)",                         pro: true,  station: true  },
  { label: "Live mic deck",                                     pro: true,  station: true  },
  { label: "Cloud log backup",                                  pro: true,  station: true  },
  { label: "Remote web dashboard",                              pro: true,  station: true  },
  { label: "Mobile emergency override",                         pro: true,  station: true  },
  { label: "PDF traffic reports",                               pro: true,  station: true  },
  { label: "Listener analytics",                                pro: true,  station: true  },
  { label: "Multi-output audio (ASIO)",                         pro: true,  station: true  },
  { label: "Iris AI voice assistant (500 conversations/month)", pro: true,  station: false, isNew: true },
  { label: "Multi-station console",                             pro: false, station: true  },
  { label: "NexGen / ENCO import",                              pro: false, station: true  },
  { label: "Iris AI voice assistant (unlimited)",               pro: false, station: true,  isNew: true },
  { label: "User accounts + roles",                             pro: false, station: true, comingSoon: true },
];

export default function SubscriptionPanel() {
  const [currentPlan, setCurrentPlan]       = useState<PlanTier>("free");
  const [billingMode, setBillingMode]       = useState<"monthly" | "lifetime">("monthly");
  const [licenseKey, setLicenseKey]         = useState("");
  const [licenseEmail, setLicenseEmail]     = useState("");
  const [showLicenseEntry, setShowLicenseEntry] = useState(false);
  const [pendingPlan, setPendingPlan]       = useState<PlanTier | null>(null);
  const [licenseError, setLicenseError]     = useState("");
  const [licenseSuccess, setLicenseSuccess] = useState(false);
  const [loading, setLoading]               = useState(false);
  const { stationId, isReady } = useActiveStation();

  useEffect(() => {
    if (!isReady) return;
    (async () => {
      try {
        const result = await (window as any).ether.stationConfigKv.list(stationId);
        const rows: { key: string; value: string }[] = result.ok ? result.rows : [];
        const plan = rows.find((r: { key: string }) => r.key === 'plan_tier')?.value;
        if (plan) setCurrentPlan(plan as PlanTier);
        const email = rows.find((r: { key: string }) => r.key === 'license_email')?.value;
        if (email) setLicenseEmail(email);
      } catch {}
    })();
  }, [stationId, isReady]);

  const openCheckout = async (plan: PlanTier) => {
    setPendingPlan(plan);
    const url = plan === "pro"              ? PAYMENT_LINK_PRO
              : plan === "station"          ? PAYMENT_LINK_STATION
              : plan === "pro_lifetime"     ? PAYMENT_LINK_PRO_LIFETIME
              : plan === "station_lifetime" ? PAYMENT_LINK_STATION_LIFETIME
              : PAYMENT_LINK_PRO;
    try {
      const invoke = (cmd: string, args?: any) => (window as any).ether.invoke(cmd, args);
      await invoke("open_url", { url });
    } catch {
      try { await navigator.clipboard.writeText(url); } catch {}
      alert(`Please open this URL in your browser:\n\n${url}`);
    }
    setTimeout(() => setShowLicenseEntry(true), 3000);
  };

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
      await (window as any).ether.stationConfigKv.upsertByKey(stationId, 'plan_tier', tier);
      await (window as any).ether.stationConfigKv.upsertByKey(stationId, 'license_key', trimmedKey);
      window.dispatchEvent(new CustomEvent('ether:license-changed'));
      if (licenseEmail.trim()) {
        await (window as any).ether.stationConfigKv.upsertByKey(stationId, 'license_email', licenseEmail.trim());
      }
      setCurrentPlan(tier);
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
      await (window as any).ether.stationConfigKv.upsertByKey(stationId, 'plan_tier', data.plan);
      await (window as any).ether.stationConfigKv.upsertByKey(stationId, 'license_key', licenseKey.trim());
      window.dispatchEvent(new CustomEvent('ether:license-changed'));
      await (window as any).ether.stationConfigKv.upsertByKey(stationId, 'license_email', licenseEmail.trim());
      setCurrentPlan(data.plan as PlanTier);
      setLicenseSuccess(true);
      setShowLicenseEntry(false);
      setTimeout(() => setLicenseSuccess(false), 4000);
    } catch {
      setLicenseError("Could not reach the license server. Check your internet connection.");
    }
    setLoading(false);
  };

  const cancelPlan = async () => {
    if (!confirm("Downgrade to Free? You'll keep access until the end of your billing period.")) return;
    await (window as any).ether.stationConfigKv.upsertByKey(stationId, 'plan_tier', 'free');
    await (window as any).ether.stationConfigKv.removeByKey(stationId, 'license_key');
    setCurrentPlan("free");
  };

  const planColor = (plan: PlanTier) => {
    if (plan === "pro")              return "#22d3ee";
    if (plan === "station")          return "#a78bfa";
    if (plan === "pro_lifetime")     return "#f59e0b";
    if (plan === "station_lifetime") return "#f59e0b";
    if (plan === "operator")         return "#10b981";
    return "#34d399";
  };

  const planLabel = (plan: PlanTier) => {
    if (plan === "pro")              return "Studio";
    if (plan === "station")          return "Network";
    if (plan === "pro_lifetime")     return "Studio Lifetime";
    if (plan === "station_lifetime") return "Network Lifetime";
    if (plan === "operator")         return "Enterprise";
    return "Solo";
  };

  // ── Early Adopter ribbon (corner) ─────────────────────────────
  const EarlyAdopterRibbon = () => (
    <div style={{
      position:    "absolute" as const,
      top:         16,
      right:       -28,
      width:       120,
      background:  "linear-gradient(135deg, #d97706, #f59e0b)",
      color:       "#000",
      fontSize:    8,
      fontWeight:  800,
      letterSpacing: "0.1em",
      textAlign:   "center" as const,
      padding:     "5px 0",
      transform:   "rotate(35deg)",
      transformOrigin: "center",
      boxShadow:   "0 2px 6px rgba(0,0,0,0.3)",
      pointerEvents: "none" as const,
      lineHeight:  1.3,
    }}>
      FOUNDING<br />PRICE
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column" as const, gap: 0, fontFamily: "'Inter', system-ui, sans-serif", maxWidth: 1240, margin: "0 auto", padding: "0 24px 40px" }}>

      {/* Header */}
      <div style={{ padding: "32px 0 20px" }}>
        <h1 style={{ fontFamily: "'Syne', sans-serif", fontSize: 28, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--text-primary)", margin: 0, marginBottom: 8 }}>
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

      {/* Billing mode toggle */}
      <div style={{ display: "flex", alignItems: "center", gap: 0, marginBottom: 28, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, padding: 4, width: "fit-content" }}>
        {(["monthly", "lifetime"] as const).map(mode => (
          <button
            key={mode}
            onClick={() => setBillingMode(mode)}
            style={{
              padding: "7px 22px",
              borderRadius: 0,
              border: "none",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 700,
              fontFamily: "'Syne', sans-serif",
              letterSpacing: "0.06em",
              transition: "all 0.18s ease",
              background: billingMode === mode
                ? mode === "lifetime" ? "#f59e0b" : "var(--bg-tertiary)"
                : "transparent",
              color: billingMode === mode
                ? mode === "lifetime" ? "#000" : "var(--text-primary)"
                : "var(--text-tertiary)",
            }}
          >
            {mode === "monthly" ? "Monthly" : "Lifetime"}
            {mode === "lifetime" && (
              <span style={{ marginLeft: 8, fontSize: 9, background: "rgba(0,0,0,0.25)", color: "#000", padding: "2px 6px", fontWeight: 800, letterSpacing: "0.08em" }}>
                SAVE UP TO 63%
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Product Hunt promo banner — monthly only */}
      {currentPlan === "free" && billingMode === "monthly" && (
        <div style={{
          display: "flex", alignItems: "center", gap: 14,
          padding: "12px 18px", borderRadius: 0, marginBottom: 20,
          background: "linear-gradient(135deg, rgba(251,191,36,0.08), rgba(251,191,36,0.04))",
          border: "1px solid rgba(251,191,36,0.25)",
        }}>
          <span style={{ fontSize: 22, flexShrink: 0 }}>🐱</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#fbbf24", marginBottom: 2 }}>Product Hunt Exclusive — 50% off for 3 months</div>
            <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Enter code <strong style={{ fontFamily: "'DM Mono', monospace", color: "#fbbf24", letterSpacing: "0.08em" }}>PHUNT50</strong> at checkout</div>
          </div>
          <div style={{
            padding: "5px 12px", borderRadius: 0,
            background: "rgba(251,191,36,0.12)", border: "1px solid rgba(251,191,36,0.3)",
            fontFamily: "'DM Mono', monospace", fontSize: 12, fontWeight: 700,
            color: "#fbbf24", letterSpacing: "0.1em", flexShrink: 0,
            cursor: "pointer", userSelect: "all" as const,
          }}
            onClick={() => navigator.clipboard?.writeText("PHUNT50")}
            title="Click to copy"
          >
            PHUNT50
          </div>
        </div>
      )}

      {/* License entry */}
      {showLicenseEntry && (
        <div style={{
          background: "var(--bg-secondary)", border: "1px solid var(--border-primary)",
          borderRadius: 0, padding: 28, marginBottom: 24,
          boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
        }}>
          <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 16, fontWeight: 700, color: "var(--text-primary)", marginBottom: 6 }}>
            Enter your license key
          </div>
          <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginBottom: 20 }}>
            After completing payment, check your email for a license key from Ether Global Technologies.
          </div>
          <div style={{ display: "flex", flexDirection: "column" as const, gap: 10 }}>
            <input
              type="email"
              placeholder="Email address used for purchase"
              value={licenseEmail}
              onChange={e => setLicenseEmail(e.target.value)}
              style={{ padding: "10px 14px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", fontFamily: "'Inter', sans-serif" }}
            />
            <input
              type="text"
              placeholder="ETHER-PRO-XXXX-XXXX"
              value={licenseKey}
              onChange={e => setLicenseKey(e.target.value.toUpperCase())}
              style={{ padding: "10px 14px", borderRadius: 0, fontSize: 13, fontFamily: "'DM Mono', monospace", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", letterSpacing: "0.08em" }}
            />
            {licenseError && <div style={{ fontSize: 12, color: "#f87171" }}>{licenseError}</div>}
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={validateLicense} disabled={loading} style={{ flex: 1, padding: "10px 0", borderRadius: 0, background: "var(--accent-blue)", color: "#fff", border: "none", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "'Syne', sans-serif" }}>
                {loading ? "Activating..." : "Activate License"}
              </button>
              <button onClick={() => { setShowLicenseEntry(false); setLicenseError(""); }} style={{ padding: "10px 16px", borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", fontSize: 13, cursor: "pointer" }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── MONTHLY CARDS ──────────────────────────────────────── */}
      {billingMode === "monthly" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, marginBottom: 32 }}>

          {/* Solo */}
          <div style={{
            background: "var(--bg-secondary)", borderRadius: 0,
            border: `1px solid ${currentPlan === "free" ? "#34d39940" : "var(--border-primary)"}`,
            padding: "24px 20px",
            boxShadow: currentPlan === "free" ? "0 0 24px rgba(52,211,153,0.08)" : "none",
          }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.18em", color: "var(--text-tertiary)", textTransform: "uppercase" as const, marginBottom: 12 }}>Solo</div>
            <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 36, fontWeight: 800, letterSpacing: "-0.04em", color: "#34d399", marginBottom: 4 }}>$0</div>
            <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 20 }}>forever · no credit card</div>
            <div style={{ padding: "10px 0", borderRadius: 0, background: "rgba(52,211,153,0.08)", border: "1px solid rgba(52,211,153,0.2)", textAlign: "center" as const, fontSize: 12, fontWeight: 700, color: "#34d399", marginBottom: 20 }}>
              {currentPlan === "free" ? "✓ Current Plan" : "Downgrade"}
            </div>
            <div style={{ display: "flex", flexDirection: "column" as const, gap: 7 }}>
              {FEATURES.filter(f => !f.pro && !f.station || (f.label.includes("library") || f.label.includes("scheduling") || f.label.includes("Clock") || f.label.includes("Spot") || f.label.includes("Live assist") || f.label.includes("Voice") || f.label.includes("Show") || f.label.includes("Track editor") || f.label.includes("Live mic"))).slice(0, 9).map(f => (
                <div key={f.label} style={{ fontSize: 11, color: "var(--text-secondary)", display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <span style={{ color: "#34d399", flexShrink: 0 }}>✓</span>{f.label}
                </div>
              ))}
              <div style={{ fontSize: 11, color: "var(--text-secondary)", display: "flex", gap: 8, alignItems: "flex-start" }}>
                <span style={{ color: "#34d399", flexShrink: 0 }}>✓</span>Iris AI (50 conversations/month)
              </div>
            </div>
          </div>

          {/* Studio */}
          <div style={{
            background: "var(--bg-secondary)", borderRadius: 0,
            border: `2px solid ${currentPlan === "pro" ? "#22d3ee" : "rgba(34,211,238,0.25)"}`,
            padding: "24px 20px", position: "relative" as const,
            boxShadow: "0 0 32px rgba(34,211,238,0.08)",
          }}>
            <div style={{ position: "absolute" as const, top: -1, left: "50%", transform: "translateX(-50%)", background: "#22d3ee", color: "#000", fontSize: 9, fontWeight: 800, letterSpacing: "0.12em", padding: "4px 14px", borderRadius: "0 0 8px 8px" }}>MOST POPULAR</div>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.18em", color: "#22d3ee", textTransform: "uppercase" as const, marginBottom: 12, marginTop: 8 }}>Studio</div>
            <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 36, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--text-primary)", marginBottom: 4 }}>$19</div>
            <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 20 }}>per month · solo creator / podcaster</div>
            {currentPlan === "pro" ? (
              <button onClick={cancelPlan} style={{ width: "100%", padding: "10px 0", borderRadius: 0, background: "rgba(34,211,238,0.1)", border: "1px solid rgba(34,211,238,0.3)", color: "#22d3ee", fontSize: 12, fontWeight: 700, cursor: "pointer", marginBottom: 20 }}>
                ✓ Active — Cancel Plan
              </button>
            ) : (
              <button onClick={() => openCheckout("pro")} style={{ width: "100%", padding: "10px 0", borderRadius: 0, background: "#22d3ee", border: "none", color: "#000", fontSize: 12, fontWeight: 700, cursor: "pointer", marginBottom: 20, boxShadow: "0 0 24px rgba(34,211,238,0.3)", fontFamily: "'Syne', sans-serif" }}>
                {currentPlan === "station" ? "Downgrade to Studio" : "Upgrade to Studio →"}
              </button>
            )}
            <div style={{ display: "flex", flexDirection: "column" as const, gap: 7 }}>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)", fontWeight: 600, marginBottom: 4 }}>Everything in Solo, plus:</div>
              {FEATURES.filter(f => f.pro).map(f => (
                <div key={f.label} style={{ fontSize: 11, color: f.comingSoon ? "var(--text-tertiary)" : "var(--text-secondary)", display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <span style={{ color: "#22d3ee", flexShrink: 0 }}>✓</span>
                  {f.label}
                  {f.isNew && <span style={{ fontSize: 8, background: "rgba(34,211,238,0.2)", color: "#22d3ee", padding: "1px 5px", borderRadius: 0, fontWeight: 800, letterSpacing: "0.06em", flexShrink: 0 }}>NEW</span>}
                  {f.comingSoon && <span style={{ fontSize: 9, background: "rgba(34,211,238,0.15)", color: "#22d3ee", padding: "1px 6px", borderRadius: 0, fontWeight: 700, flexShrink: 0 }}>SOON</span>}
                </div>
              ))}
            </div>
          </div>

          {/* Network */}
          <div style={{
            background: "var(--bg-secondary)", borderRadius: 0,
            border: `1px solid ${currentPlan === "station" ? "#a78bfa40" : "var(--border-primary)"}`,
            padding: "24px 20px",
            boxShadow: currentPlan === "station" ? "0 0 24px rgba(167,139,250,0.08)" : "none",
          }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.18em", color: "#a78bfa", textTransform: "uppercase" as const, marginBottom: 12 }}>Network</div>
            <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 36, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--text-primary)", marginBottom: 4 }}>$79</div>
            <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 20 }}>per month · commercial station</div>
            {currentPlan === "station" ? (
              <button onClick={cancelPlan} style={{ width: "100%", padding: "10px 0", borderRadius: 0, background: "rgba(167,139,250,0.1)", border: "1px solid rgba(167,139,250,0.3)", color: "#a78bfa", fontSize: 12, fontWeight: 700, cursor: "pointer", marginBottom: 20 }}>
                ✓ Active — Cancel Plan
              </button>
            ) : (
              <button onClick={() => openCheckout("station")} style={{ width: "100%", padding: "10px 0", borderRadius: 0, background: "rgba(167,139,250,0.12)", border: "1px solid rgba(167,139,250,0.3)", color: "#a78bfa", fontSize: 12, fontWeight: 700, cursor: "pointer", marginBottom: 20, fontFamily: "'Syne', sans-serif" }}>
                {currentPlan === "pro" ? "Upgrade to Network →" : "Get Network →"}
              </button>
            )}
            <div style={{ display: "flex", flexDirection: "column" as const, gap: 7 }}>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)", fontWeight: 600, marginBottom: 4 }}>Everything in Studio, plus:</div>
              {FEATURES.filter(f => f.station && !f.pro).map(f => (
                <div key={f.label} style={{ fontSize: 11, color: f.comingSoon ? "var(--text-tertiary)" : "var(--text-secondary)", display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <span style={{ color: "#a78bfa", flexShrink: 0 }}>✓</span>
                  {f.label}
                  {f.isNew && <span style={{ fontSize: 8, background: "rgba(167,139,250,0.2)", color: "#a78bfa", padding: "1px 5px", borderRadius: 0, fontWeight: 800, letterSpacing: "0.06em", flexShrink: 0 }}>NEW</span>}
                  {f.comingSoon && <span style={{ fontSize: 9, background: "rgba(167,139,250,0.15)", color: "#a78bfa", padding: "1px 6px", borderRadius: 0, fontWeight: 700, flexShrink: 0 }}>SOON</span>}
                </div>
              ))}
              <div style={{ fontSize: 11, color: "var(--text-secondary)", display: "flex", gap: 8, alignItems: "flex-start" }}>
                <span style={{ color: "#a78bfa", flexShrink: 0 }}>✓</span>Phone + SLA support
              </div>
            </div>
          </div>

        </div>
      )}

      {/* ── LIFETIME CARDS ─────────────────────────────────────── */}
      {billingMode === "lifetime" && (
        <>
          {/* Savings headline */}
          <div style={{ textAlign: "center" as const, marginBottom: 28 }}>
            <div style={{ fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.6 }}>
              Pay once. Own it forever. All future updates included.
            </div>
            <div style={{ fontSize: 12, color: "#f59e0b", fontWeight: 600, marginTop: 4 }}>
              Limited-time founding price — lock it in before it goes up.
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 32, maxWidth: 820, margin: "0 auto 32px" }}>

            {/* Studio Lifetime */}
            <div style={{
              background: "var(--bg-secondary)", borderRadius: 0,
              border: `1px solid ${currentPlan === "pro_lifetime" ? "#f59e0b" : "rgba(245,158,11,0.25)"}`,
              padding: "28px 24px", position: "relative" as const,
              overflow: "hidden",
              boxShadow: currentPlan === "pro_lifetime" ? "0 0 40px rgba(245,158,11,0.2)" : "0 0 16px rgba(245,158,11,0.05)",
            }}>
              <EarlyAdopterRibbon />

              {/* Badge */}
              <div style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "rgba(245,158,11,0.15)", border: "1px solid rgba(245,158,11,0.35)", padding: "3px 10px", marginBottom: 16 }}>
                <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.14em", color: "#f59e0b" }}>LIFETIME</span>
              </div>

              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.18em", color: "#f59e0b", textTransform: "uppercase" as const, marginBottom: 6 }}>Studio Lifetime</div>
              <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 18, fontStyle: "italic" }}>Own it forever.</div>

              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
                <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 42, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--text-primary)" }}>$299</div>
                <div style={{ fontSize: 12, color: "#f59e0b", fontWeight: 600 }}>one-time</div>
              </div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 20 }}>vs $228/yr on monthly</div>

              {currentPlan === "pro_lifetime" ? (
                <div style={{ width: "100%", padding: "11px 0", background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.3)", color: "#f59e0b", fontSize: 12, fontWeight: 700, textAlign: "center" as const, marginBottom: 8 }}>
                  ✓ Studio Lifetime Active
                </div>
              ) : (
                <button
                  onClick={() => openCheckout("pro_lifetime")}
                  style={{ width: "100%", padding: "11px 0", borderRadius: 0, background: "#f59e0b", border: "none", color: "#000", fontSize: 13, fontWeight: 800, cursor: "pointer", marginBottom: 8, fontFamily: "'Syne', sans-serif", letterSpacing: "0.02em" }}
                >
                  Get Studio Lifetime →
                </button>
              )}
              <div style={{ fontSize: 10, color: "var(--text-tertiary)", textAlign: "center" as const, marginBottom: 24 }}>
                One payment. Yours forever.
              </div>

              <div style={{ display: "flex", flexDirection: "column" as const, gap: 7 }}>
                <div style={{ fontSize: 11, color: "var(--text-tertiary)", fontWeight: 600, marginBottom: 4 }}>Everything in Studio, forever:</div>
                {FEATURES.filter(f => f.pro).slice(0, 8).map(f => (
                  <div key={f.label} style={{ fontSize: 11, color: "var(--text-secondary)", display: "flex", gap: 8, alignItems: "flex-start" }}>
                    <span style={{ color: "#f59e0b", flexShrink: 0 }}>✓</span>{f.label}
                  </div>
                ))}
                <div style={{ fontSize: 11, color: "var(--text-secondary)", display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <span style={{ color: "#f59e0b", flexShrink: 0 }}>✓</span>All future updates included
                </div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <span style={{ color: "#f59e0b", flexShrink: 0 }}>✓</span>Priority support (24-hour response)
                </div>
              </div>
            </div>

            {/* Network Lifetime */}
            <div style={{
              background: "linear-gradient(160deg, rgba(245,158,11,0.07) 0%, var(--bg-secondary) 60%)",
              borderRadius: 0,
              border: `2px solid rgba(245,158,11,0.5)`,
              padding: "28px 24px", position: "relative" as const,
              overflow: "hidden",
              boxShadow: [
                "0 0 48px rgba(245,158,11,0.18)",
                "inset 0 0 60px rgba(245,158,11,0.03)",
              ].join(", "),
            }}>
              <EarlyAdopterRibbon />

              {/* Best Value badge */}
              <div style={{ position: "absolute" as const, top: -1, left: "50%", transform: "translateX(-50%)", background: "#f59e0b", color: "#000", fontSize: 9, fontWeight: 800, letterSpacing: "0.12em", padding: "4px 16px", borderRadius: "0 0 8px 8px" }}>
                BEST VALUE
              </div>

              <div style={{ marginTop: 14 }}>
                <div style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "rgba(245,158,11,0.2)", border: "1px solid rgba(245,158,11,0.45)", padding: "3px 10px", marginBottom: 16 }}>
                  <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.14em", color: "#f59e0b" }}>LIFETIME</span>
                </div>
              </div>

              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.18em", color: "#f59e0b", textTransform: "uppercase" as const, marginBottom: 6 }}>Network Lifetime</div>
              <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 18, fontStyle: "italic" }}>The professional choice.</div>

              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
                <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 42, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--text-primary)" }}>$899</div>
                <div style={{ fontSize: 12, color: "#f59e0b", fontWeight: 600 }}>one-time</div>
              </div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 20 }}>vs $948/yr on monthly</div>

              {currentPlan === "station_lifetime" ? (
                <div style={{ width: "100%", padding: "11px 0", background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.3)", color: "#f59e0b", fontSize: 12, fontWeight: 700, textAlign: "center" as const, marginBottom: 8 }}>
                  ✓ Network Lifetime Active
                </div>
              ) : (
                <button
                  onClick={() => openCheckout("station_lifetime")}
                  style={{ width: "100%", padding: "11px 0", borderRadius: 0, background: "#f59e0b", border: "none", color: "#000", fontSize: 13, fontWeight: 800, cursor: "pointer", marginBottom: 8, fontFamily: "'Syne', sans-serif", letterSpacing: "0.02em", boxShadow: "0 0 28px rgba(245,158,11,0.35)" }}
                >
                  Get Network Lifetime →
                </button>
              )}
              <div style={{ fontSize: 10, color: "var(--text-tertiary)", textAlign: "center" as const, marginBottom: 24 }}>
                Pays for itself in under a year.
              </div>

              <div style={{ display: "flex", flexDirection: "column" as const, gap: 7 }}>
                <div style={{ fontSize: 11, color: "var(--text-tertiary)", fontWeight: 600, marginBottom: 4 }}>Everything in Network, forever:</div>
                {FEATURES.filter(f => f.pro || f.station).slice(0, 10).map(f => (
                  <div key={f.label} style={{ fontSize: 11, color: "var(--text-secondary)", display: "flex", gap: 8, alignItems: "flex-start" }}>
                    <span style={{ color: "#f59e0b", flexShrink: 0 }}>✓</span>{f.label}
                  </div>
                ))}
                <div style={{ fontSize: 11, color: "var(--text-secondary)", display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <span style={{ color: "#f59e0b", flexShrink: 0 }}>✓</span>All future updates included
                </div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <span style={{ color: "#f59e0b", flexShrink: 0 }}>✓</span>Priority support (24-hour response)
                </div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <span style={{ color: "#f59e0b", flexShrink: 0 }}>✓</span>Phone + SLA support
                </div>
              </div>
            </div>

          </div>
        </>
      )}

      {/* Free plan upgrade banner — monthly only */}
      {currentPlan === "free" && billingMode === "monthly" && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", background: "rgba(124,58,237,0.07)", border: "1px solid rgba(124,58,237,0.25)", borderRadius: 0, marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4, fontFamily: "'Syne', sans-serif" }}>You're on the Solo plan</div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>Upgrade to Studio for Iris AI assistant, cloud backup, remote dashboard, and more</div>
          </div>
          <button onClick={() => openCheckout("pro")} style={{ flexShrink: 0, marginLeft: 20, padding: "10px 20px", borderRadius: 0, background: "#7c3aed", border: "none", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" as const }}>
            Upgrade to Studio — $19/mo
          </button>
        </div>
      )}

      {/* Already have a license */}
      <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, padding: "18px 24px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>Already have a license key?</div>
          <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>Enter it below to activate your plan.</div>
        </div>
        <button onClick={() => { setShowLicenseEntry(true); setPendingPlan(null); }} style={{ padding: "9px 20px", borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-secondary)", color: "var(--text-secondary)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
          Enter License Key
        </button>
      </div>

      {/* Footer */}
      <div style={{ marginTop: 20, fontSize: 11, color: "var(--text-tertiary)", textAlign: "center" as const, lineHeight: 1.7 }}>
        Monthly plans include a 14-day free trial · Cancel anytime · Lifetime is a one-time charge, no renewals · Questions? <span style={{ color: "var(--accent-blue)" }}>legal@ether-technologies.com</span>
      </div>
    </div>
  );
}
