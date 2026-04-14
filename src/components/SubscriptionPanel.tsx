import { useState, useEffect } from "react";
import { execute, query } from "../db/client";

// ── Stripe config ──
const STRIPE_PK = "pk_live_51TCwP5QJRnsdUhPMYsv0CIkEkcdiINRMDKgYaLiuOdOiTiBNmdxILemKaPYiNRNCM4hAPOcplpLUl2bjpuqGRzbE00YnjZ0ZEh";
const PRICE_PRO     = "price_1TCwR6QJRnsdUhPM6RPqhjdA";
const PRICE_STATION = "price_1TCwRZQJRnsdUhPMjwK0y9sA";
const API_URL       = "https://ether-backend-production.up.railway.app";

const PAYMENT_LINK_PRO     = "https://buy.stripe.com/aFa5kx6X2b8Nac78c79k402";
const PAYMENT_LINK_STATION = "https://buy.stripe.com/cNi14hgxC6Sx1FB2RN9k401";

export type PlanTier = "free" | "pro" | "station";

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
  const [currentPlan, setCurrentPlan] = useState<PlanTier>("free");
  const [licenseKey, setLicenseKey] = useState("");
  const [licenseEmail, setLicenseEmail] = useState("");
  const [showLicenseEntry, setShowLicenseEntry] = useState(false);
  const [pendingPlan, setPendingPlan] = useState<PlanTier | null>(null);
  const [licenseError, setLicenseError] = useState("");
  const [licenseSuccess, setLicenseSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        await execute(`CREATE TABLE IF NOT EXISTS station_config_kv (key TEXT PRIMARY KEY, value TEXT)`, []);
        const rows = await query<{ value: string }>("SELECT value FROM station_config_kv WHERE key = 'plan_tier'");
        if (rows.length > 0) setCurrentPlan(rows[0].value as PlanTier);
        const emailRows = await query<{ value: string }>("SELECT value FROM station_config_kv WHERE key = 'license_email'");
        if (emailRows.length > 0) setLicenseEmail(emailRows[0].value);
      } catch {}
    })();
  }, []);

  const openCheckout = async (plan: PlanTier) => {
    setPendingPlan(plan);
    const url = plan === "pro" ? PAYMENT_LINK_PRO : PAYMENT_LINK_STATION;
    try {
      const invoke = (cmd: string, args?: any) => (window as any).ether.invoke(cmd, args);
      await invoke("open_url", { url });
    } catch {
      // fallback — copy to clipboard and show instructions
      try { await navigator.clipboard.writeText(url); } catch {}
      alert(`Please open this URL in your browser:\n\n${url}`);
    }
    setTimeout(() => setShowLicenseEntry(true), 3000);
  };

  const validateLicense = async () => {
    if (!licenseKey.trim() || !licenseEmail.trim()) {
      setLicenseError("Please enter your email and license key.");
      return;
    }
    setLoading(true);
    setLicenseError("");

    try {
      const res = await fetch(`${API_URL}/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ license_key: licenseKey.trim(), email: licenseEmail.trim() }),
      });
      const data = await res.json();

      if (!data.valid) {
        setLicenseError(data.error || "Invalid license key. Please check and try again.");
        setLoading(false);
        return;
      }

      // Save locally
      await execute("INSERT OR REPLACE INTO station_config_kv (key, value) VALUES ('plan_tier', ?)", [data.plan]);
      await execute("INSERT OR REPLACE INTO station_config_kv (key, value) VALUES ('license_key', ?)", [licenseKey.trim()]);
      await execute("INSERT OR REPLACE INTO station_config_kv (key, value) VALUES ('license_email', ?)", [licenseEmail.trim()]);
      setCurrentPlan(data.plan as PlanTier);
      setLicenseSuccess(true);
      setShowLicenseEntry(false);
      setTimeout(() => setLicenseSuccess(false), 4000);
    } catch (e) {
      setLicenseError("Could not reach the license server. Check your internet connection.");
    }
    setLoading(false);
  };

  const cancelPlan = async () => {
    if (!confirm("Downgrade to Free? You'll keep access until the end of your billing period.")) return;
    await execute("INSERT OR REPLACE INTO station_config_kv (key, value) VALUES ('plan_tier', 'free')", []);
    await execute("DELETE FROM station_config_kv WHERE key = 'license_key'", []);
    setCurrentPlan("free");
  };

  const planColor = (plan: PlanTier) => {
    if (plan === "pro") return "#22d3ee";
    if (plan === "station") return "#a78bfa";
    return "#34d399";
  };

  return (
    <div style={{ display: "flex", flexDirection: "column" as const, gap: 0, fontFamily: "'Inter', system-ui, sans-serif", maxWidth: 960, margin: "0 auto", padding: "0 24px 40px" }}>

      {/* Header */}
      <div style={{ padding: "32px 0 24px" }}>
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
            {currentPlan === "free" ? "Free" : currentPlan === "pro" ? "Ether Creator" : "Ether Station"}
          </span>
          {licenseSuccess && <span style={{ fontSize: 12, color: "#34d399", fontWeight: 600 }}>✓ License activated!</span>}
        </div>
      </div>

      {/* Product Hunt promo banner */}
      {currentPlan === "free" && (
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

      {/* License entry modal */}
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

      {/* Plan cards */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 32 }}>

        {/* Free */}
        <div style={{
          background: "var(--bg-secondary)", borderRadius: 0,
          border: `1px solid ${currentPlan === "free" ? "#34d39940" : "var(--border-primary)"}`,
          padding: "28px 24px",
          boxShadow: currentPlan === "free" ? "0 0 24px rgba(52,211,153,0.08)" : "none",
        }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.18em", color: "var(--text-tertiary)", textTransform: "uppercase" as const, marginBottom: 12 }}>Free</div>
          <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 40, fontWeight: 800, letterSpacing: "-0.04em", color: "#34d399", marginBottom: 4 }}>$0</div>
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 24 }}>forever · no credit card</div>
          <div style={{ padding: "10px 0", borderRadius: 0, background: "rgba(52,211,153,0.08)", border: "1px solid rgba(52,211,153,0.2)", textAlign: "center" as const, fontSize: 12, fontWeight: 700, color: "#34d399", marginBottom: 24 }}>
            {currentPlan === "free" ? "✓ Current Plan" : "Downgrade"}
          </div>
          <div style={{ display: "flex", flexDirection: "column" as const, gap: 8 }}>
            {FEATURES.filter(f => !f.pro && !f.station || (f.label.includes("library") || f.label.includes("scheduling") || f.label.includes("Clock") || f.label.includes("Spot") || f.label.includes("Live assist") || f.label.includes("Voice") || f.label.includes("Show") || f.label.includes("Track editor") || f.label.includes("Live mic"))).slice(0, 9).map(f => (
              <div key={f.label} style={{ fontSize: 11, color: "var(--text-secondary)", display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ color: "#34d399", flexShrink: 0 }}>✓</span>{f.label}
              </div>
            ))}
            <div style={{ fontSize: 11, color: "var(--text-secondary)", display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ color: "#34d399", flexShrink: 0 }}>✓</span>Iris AI assistant (limited — 50 conversations/month)
            </div>
          </div>
        </div>

        {/* Pro */}
        <div style={{
          background: "var(--bg-secondary)", borderRadius: 0,
          border: `2px solid ${currentPlan === "pro" ? "#22d3ee" : "rgba(34,211,238,0.25)"}`,
          padding: "28px 24px", position: "relative" as const,
          boxShadow: "0 0 32px rgba(34,211,238,0.08)",
        }}>
          <div style={{ position: "absolute" as const, top: -1, left: "50%", transform: "translateX(-50%)", background: "#22d3ee", color: "#000", fontSize: 9, fontWeight: 800, letterSpacing: "0.12em", padding: "4px 14px", borderRadius: "0 0 8px 8px" }}>MOST POPULAR</div>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.18em", color: "#22d3ee", textTransform: "uppercase" as const, marginBottom: 12, marginTop: 8 }}>Creator</div>
          <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 40, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--text-primary)", marginBottom: 4 }}>$19</div>
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 24 }}>per month · solo creator / podcaster / streamer</div>
          {currentPlan === "pro" ? (
            <button onClick={cancelPlan} style={{ width: "100%", padding: "10px 0", borderRadius: 0, background: "rgba(34,211,238,0.1)", border: "1px solid rgba(34,211,238,0.3)", color: "#22d3ee", fontSize: 12, fontWeight: 700, cursor: "pointer", marginBottom: 24 }}>
              ✓ Active — Cancel Plan
            </button>
          ) : (
            <button onClick={() => openCheckout("pro")} style={{ width: "100%", padding: "10px 0", borderRadius: 0, background: "#22d3ee", border: "none", color: "#000", fontSize: 12, fontWeight: 700, cursor: "pointer", marginBottom: 24, boxShadow: "0 0 24px rgba(34,211,238,0.3)", fontFamily: "'Syne', sans-serif" }}>
              {currentPlan === "station" ? "Downgrade to Creator" : "Upgrade to Creator →"}
            </button>
          )}
          <div style={{ display: "flex", flexDirection: "column" as const, gap: 8 }}>
            <div style={{ fontSize: 11, color: "var(--text-tertiary)", fontWeight: 600, marginBottom: 4 }}>Everything in Free, plus:</div>
            {FEATURES.filter(f => f.pro).map(f => (
              <div key={f.label} style={{ fontSize: 11, color: f.comingSoon ? "var(--text-tertiary)" : "var(--text-secondary)", display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ color: "#22d3ee", flexShrink: 0 }}>✓</span>
                {f.label}
                {f.isNew && <span style={{ fontSize: 8, background: "rgba(34,211,238,0.2)", color: "#22d3ee", padding: "1px 5px", borderRadius: 0, fontWeight: 800, letterSpacing: "0.06em", flexShrink: 0 }}>NEW</span>}
                {f.comingSoon && <span style={{ fontSize: 9, background: "rgba(34,211,238,0.15)", color: "#22d3ee", padding: "1px 6px", borderRadius: 0, fontWeight: 700 }}>SOON</span>}
              </div>
            ))}
          </div>
        </div>

        {/* Station */}
        <div style={{
          background: "var(--bg-secondary)", borderRadius: 0,
          border: `1px solid ${currentPlan === "station" ? "#a78bfa40" : "var(--border-primary)"}`,
          padding: "28px 24px",
          boxShadow: currentPlan === "station" ? "0 0 24px rgba(167,139,250,0.08)" : "none",
        }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.18em", color: "#a78bfa", textTransform: "uppercase" as const, marginBottom: 12 }}>Station</div>
          <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 40, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--text-primary)", marginBottom: 4 }}>$79</div>
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 24 }}>per month · commercial station</div>
          {currentPlan === "station" ? (
            <button onClick={cancelPlan} style={{ width: "100%", padding: "10px 0", borderRadius: 0, background: "rgba(167,139,250,0.1)", border: "1px solid rgba(167,139,250,0.3)", color: "#a78bfa", fontSize: 12, fontWeight: 700, cursor: "pointer", marginBottom: 24 }}>
              ✓ Active — Cancel Plan
            </button>
          ) : (
            <button onClick={() => openCheckout("station")} style={{ width: "100%", padding: "10px 0", borderRadius: 0, background: "rgba(167,139,250,0.12)", border: "1px solid rgba(167,139,250,0.3)", color: "#a78bfa", fontSize: 12, fontWeight: 700, cursor: "pointer", marginBottom: 24, fontFamily: "'Syne', sans-serif" }}>
              {currentPlan === "pro" ? "Upgrade to Station →" : "Get Station →"}
            </button>
          )}
          <div style={{ display: "flex", flexDirection: "column" as const, gap: 8 }}>
            <div style={{ fontSize: 11, color: "var(--text-tertiary)", fontWeight: 600, marginBottom: 4 }}>Everything in Creator, plus:</div>
            {FEATURES.filter(f => f.station && !f.pro).map(f => (
              <div key={f.label} style={{ fontSize: 11, color: f.comingSoon ? "var(--text-tertiary)" : "var(--text-secondary)", display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ color: "#a78bfa", flexShrink: 0 }}>✓</span>
                {f.label}
                {f.isNew && <span style={{ fontSize: 8, background: "rgba(167,139,250,0.2)", color: "#a78bfa", padding: "1px 5px", borderRadius: 0, fontWeight: 800, letterSpacing: "0.06em", flexShrink: 0 }}>NEW</span>}
                {f.comingSoon && <span style={{ fontSize: 9, background: "rgba(167,139,250,0.15)", color: "#a78bfa", padding: "1px 6px", borderRadius: 0, fontWeight: 700 }}>SOON</span>}
              </div>
            ))}
            <div style={{ marginTop: 8, fontSize: 11, color: "#a78bfa" }}>✓ Phone + SLA support</div>
          </div>
        </div>
      </div>

      {/* Free plan upgrade banner */}
      {currentPlan === "free" && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", background: "rgba(124,58,237,0.07)", border: "1px solid rgba(124,58,237,0.25)", borderRadius: 0, marginBottom: 0 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4, fontFamily: "'Syne', sans-serif" }}>You're on the Free plan</div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>Upgrade to Creator for Iris AI assistant, cloud backup, remote dashboard, and more</div>
          </div>
          <button onClick={() => openCheckout("pro")} style={{ flexShrink: 0, marginLeft: 20, padding: "10px 20px", borderRadius: 0, background: "#7c3aed", border: "none", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" as const }}>
            Upgrade to Creator — $19/mo
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

      {/* Footer note */}
      <div style={{ marginTop: 20, fontSize: 11, color: "var(--text-tertiary)", textAlign: "center" as const, lineHeight: 1.7 }}>
        All plans include a 14-day free trial · Cancel anytime · Questions? <span style={{ color: "var(--accent-blue)" }}>legal@etherradio.app</span>
      </div>
    </div>
  );
}
