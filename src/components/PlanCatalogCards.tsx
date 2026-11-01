import { useEffect, useState } from "react";
import { ETHER_BACKEND_URL } from "../lib/etherBackend";
import { SITES } from "../lib/publicPages";
import { planCards, annualLine, trialLine, type Catalog } from "../lib/planCatalog";

// The plans on the Subscription screen (Jeff's prices, 2026-10-31 / 11-01), straight from the catalog
// (GET /public/plans). Buying happens on the account site, the one place that sells plans; this screen never opens a
// payment link of its own. `current` is the plan key this license is on; a lifetime key shows on the Network card.
export default function PlanCatalogCards({ current }: { current: string }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(`${ETHER_BACKEND_URL}/public/plans`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(c => { if (live) setCatalog(c); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);

  const lifetime = /_lifetime$|^operator$/.test(current);
  const isCurrent = (k: string) => k === current || (lifetime && k === "unlimited");
  const choose = () => {
    const url = `${SITES.signup}/?billing=add-card`;
    const sys = (window as any).ether?.system;
    if (sys?.openUrl) sys.openUrl(url); else window.open(url, "_blank");
  };

  if (!catalog) {
    return (
      <div style={{ padding: "18px 24px", border: "1px solid var(--border-primary)", background: "var(--bg-secondary)", fontSize: 12, color: "var(--text-tertiary)", marginBottom: 16 }}>
        {failed ? "Couldn't load the plans — this computer can't reach Ether's server right now. Nothing about your license changes." : "Loading plans…"}
      </div>
    );
  }
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 16, marginBottom: 16 }}>
        {planCards(catalog).map(p => {
          const here = isCurrent(p.key);
          const annual = annualLine(p, catalog);
          return (
            <div key={p.key} data-plan={p.key} style={{ display: "flex", flexDirection: "column" as const, padding: "22px 20px", background: "var(--bg-secondary)",
              border: here ? "2px solid var(--accent-cyan)" : "1px solid var(--border-primary)" }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase" as const, color: "var(--accent-cyan)", marginBottom: 10 }}>{p.name}</div>
              <div style={{ fontFamily: "'Newsreader', Georgia, serif", fontSize: 36, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--text-primary)" }}>${p.monthly}</div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: annual ? 2 : 16 }}>{p.per}</div>
              {annual && <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 16 }}>{annual}</div>}
              <ul style={{ listStyle: "none", margin: 0, padding: 0, flex: 1, marginBottom: 18 }}>
                {p.feats.map((f, i) => (
                  <li key={i} style={{ display: "flex", gap: 8, fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5, marginBottom: 6 }}>
                    <span style={{ color: "var(--accent-cyan)", flexShrink: 0 }}>✓</span>{f}
                  </li>
                ))}
              </ul>
              {here ? (
                <div style={{ padding: "9px 0", textAlign: "center" as const, fontSize: 12, fontWeight: 700, color: "var(--accent-cyan)", border: "1px solid var(--accent-cyan)" }}>
                  {lifetime ? "Yours for life" : "Your plan"}
                </div>
              ) : (
                <button onClick={choose} style={{ padding: "9px 0", fontSize: 12, fontWeight: 700, background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-secondary)", cursor: "pointer" }}>
                  Choose {p.name}
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-tertiary)", textAlign: "center" as const, lineHeight: 1.7 }}>
        {trialLine(catalog)} · Plans are bought on your account page, which opens in your browser.
      </div>
    </>
  );
}
