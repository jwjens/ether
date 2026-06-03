import { useEffect, useState } from "react";
import { setPlanGlobally } from "../hooks/usePlan";

// Adobe-style end-of-trial gate. When a trial activated via account sign-in reaches its end date,
// lock features back to Solo (free) and present a choice: subscribe to keep the plan, or continue
// free. Runs on launch and every 10 minutes. A real subscriber who lapses here just signs in again
// (Subscription panel) to restore their paid plan instantly.
export default function TrialGate() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const check = async () => {
      try {
        const kv = (window as any).ether?.stationConfigKv;
        if (!kv) return;
        const result = await kv.list(1);
        const rows: { key: string; value: string }[] = result?.ok ? result.rows : [];
        const get = (k: string) => rows.find((r) => r.key === k)?.value;
        const ends = get("trial_ends_at");
        const plan = get("plan_tier") || "free";
        if (!ends || plan === "free") return;                  // no live trial to gate
        if (Date.now() <= new Date(ends).getTime()) return;     // trial still active
        // Trial has ended → lock to Solo and invite the customer to choose.
        await kv.upsertByKey(1, "plan_tier", "free");
        setPlanGlobally("free");
        window.dispatchEvent(new CustomEvent("ether:license-changed"));
        setShow(true);
      } catch { /* never block the app on this */ }
    };
    check();
    const id = setInterval(check, 10 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  if (!show) return null;

  const seePlans = () => { window.dispatchEvent(new CustomEvent("ether:open-subscription")); setShow(false); };

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      background: "rgba(0,0,0,0.66)", backdropFilter: "blur(3px)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
      fontFamily: "'Inter', system-ui, sans-serif",
    }}>
      <div style={{
        width: "100%", maxWidth: 460, background: "var(--bg-secondary)",
        border: "1px solid rgba(136,104,216,0.4)", borderRadius: 0,
        padding: 36, boxShadow: "0 24px 80px rgba(0,0,0,0.5)",
      }}>
        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.16em", textTransform: "uppercase", color: "#8868D8", marginBottom: 14 }}>
          Trial ended
        </div>
        <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 24, fontWeight: 800, letterSpacing: "-0.03em", color: "var(--text-primary)", marginBottom: 12 }}>
          Your free trial has ended
        </div>
        <div style={{ fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.65, marginBottom: 28 }}>
          Subscribe to keep your full Ether plan, or keep using Ether free on the Solo plan.
          Your stations, library, and settings are all saved either way.
        </div>
        <div style={{ display: "flex", flexDirection: "column" as const, gap: 10 }}>
          <button onClick={seePlans} style={{ width: "100%", padding: "12px 0", borderRadius: 0, background: "#8868D8", border: "none", color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "'Syne', sans-serif", letterSpacing: "0.02em" }}>
            See plans &amp; subscribe →
          </button>
          <button onClick={() => setShow(false)} style={{ width: "100%", padding: "11px 0", borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            Continue on Solo (Free)
          </button>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-tertiary)", textAlign: "center" as const, marginTop: 16, lineHeight: 1.6 }}>
          Already subscribed? Open <span style={{ color: "#8868D8", cursor: "pointer", fontWeight: 600 }} onClick={seePlans}>Subscription</span> and sign in to restore your plan.
        </div>
      </div>
    </div>
  );
}
