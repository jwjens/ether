// Dev-only debug panel — tier override, onboarding reset, jump-to-screen.
//
// Reach via:
//   - #debug URL hash (App.tsx watches the hash and mounts this panel)
//   - footer-version triple-click (App.tsx handler navigates to #debug)
//   - console: window.__devSetTier / __devClearTier / __devResetOnboarding (devGlobals.ts)
//
// Entire module is dead in production builds — App.tsx imports it only when
// import.meta.env.DEV is true, so Vite tree-shakes it from the prod bundle.

import { useEffect, useState } from "react";
import { setPlanGlobally, type PlanTier } from "../hooks/usePlan";
import { ONBOARDING_KEYS, TIER_BY_LABEL, type DevLabel } from "../lib/devGlobals";

const TIERS: Array<{ label: DevLabel; display: string; code: PlanTier }> = [
  { label: "solo",       display: "Solo",       code: "free"     },
  { label: "studio",     display: "Studio",     code: "pro"      },
  { label: "network",    display: "Network",    code: "station"  },
  { label: "enterprise", display: "Enterprise", code: "operator" },
];

const PANEL_BG     = "#0e0e12";
const PANEL_BORDER = "#2a2a3a";
const TEXT_PRIMARY = "#e0e0f0";
const TEXT_MUTED   = "#707080";
const TEXT_DIM     = "#505060";
const ACCENT       = "#f59e0b"; // amber — debug/override color
const ACCENT_DIM   = "rgba(245,158,11,0.15)";

// ── Banner ────────────────────────────────────────────────────────────────
// Renders at the very top of the app shell when an override is active.

export function DevTierBanner() {
  const [override, setOverride] = useState<DevLabel | null>(null);

  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      try {
        const ether = (window as any).ether;
        const result = await ether.stationConfigKv.list(1);
        if (cancelled || !result?.ok) return;
        const row = result.rows.find((r: { key: string }) => r.key === "plan_tier_dev_override");
        const val = row?.value as DevLabel | undefined;
        setOverride(val && val in TIER_BY_LABEL ? val : null);
      } catch { /* ether not ready yet */ }
    };
    read();
    const handler = () => read();
    window.addEventListener("ether:dev-tier-override-changed", handler);
    return () => {
      cancelled = true;
      window.removeEventListener("ether:dev-tier-override-changed", handler);
    };
  }, []);

  if (!override) return null;

  const tier = TIERS.find(t => t.label === override);
  const display = tier?.display ?? override;
  const code = tier?.code ?? "?";

  return (
    // Fixed, content-width pill anchored top-center (the empty gap in the window menu bar)
    // so it never pushes app layout down. Click the pill to reopen the dev panel.
    <div
      onClick={() => { window.location.hash = "#debug"; }}
      title="Open dev panel"
      style={{
        position: "fixed", top: 0, left: "50%", transform: "translateX(-50%)", zIndex: 100000,
        padding: "3px 12px", background: ACCENT, color: "#1a1a22",
        fontSize: 11, fontWeight: 800, letterSpacing: "0.08em",
        display: "flex", alignItems: "center", gap: 12, cursor: "pointer",
        fontFamily: "'DM Mono', monospace",
        borderRadius: "0 0 6px 6px", boxShadow: "0 2px 8px rgba(0,0,0,0.45)",
      }}
    >
      <span>▓ DEV TIER — {display.toUpperCase()} ({code}) ▓</span>
      <button
        onClick={(e) => { e.stopPropagation(); window.__devClearTier?.(); }}
        style={{
          padding: "2px 10px", background: "rgba(0,0,0,0.2)", color: "#1a1a22",
          border: "1px solid rgba(0,0,0,0.3)", fontSize: 10, fontWeight: 800,
          letterSpacing: "0.08em", cursor: "pointer", borderRadius: 0,
        }}
      >CLEAR</button>
    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────

type Props = { onClose: () => void };

export default function DebugPanel({ onClose }: Props) {
  const [activeOverride, setActiveOverride] = useState<DevLabel | null>(null);
  const [busy, setBusy] = useState(false);

  // Read current override on mount + when it changes elsewhere
  useEffect(() => {
    const read = async () => {
      try {
        const ether = (window as any).ether;
        const result = await ether.stationConfigKv.list(1);
        if (!result?.ok) return;
        const row = result.rows.find((r: { key: string }) => r.key === "plan_tier_dev_override");
        const val = row?.value as DevLabel | undefined;
        setActiveOverride(val && val in TIER_BY_LABEL ? val : null);
      } catch { /* ignore */ }
    };
    read();
    const handler = () => read();
    window.addEventListener("ether:dev-tier-override-changed", handler);
    return () => window.removeEventListener("ether:dev-tier-override-changed", handler);
  }, []);

  // Esc closes the panel
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const selectTier = async (label: DevLabel) => {
    setBusy(true);
    try {
      const code = TIER_BY_LABEL[label];
      const ether = (window as any).ether;
      await ether.stationConfigKv.upsertByKey(1, "plan_tier_dev_override", label);
      setPlanGlobally(code);
      window.dispatchEvent(new CustomEvent("ether:dev-tier-override-changed"));
    } finally {
      setBusy(false);
    }
  };

  const clearTier = async () => {
    setBusy(true);
    try {
      const ether = (window as any).ether;
      await ether.stationConfigKv.removeByKey(1, "plan_tier_dev_override");
      window.dispatchEvent(new CustomEvent("ether:dev-tier-override-changed"));
      window.dispatchEvent(new Event("station-switched")); // triggers usePlan re-read from real license
    } finally {
      setBusy(false);
    }
  };

  const resetOnboarding = async () => {
    setBusy(true);
    try {
      const ether = (window as any).ether;
      for (const key of ONBOARDING_KEYS) {
        try { await ether.stationConfigKv.removeByKey(1, key); } catch { /* not present */ }
      }
      setTimeout(() => window.location.reload(), 100);
    } finally {
      // setBusy not strictly needed — page reloads
      setBusy(false);
    }
  };

  const jumpTo = (target: "onboarding" | "subscription" | "managedevices" | "about" | "settings") => {
    // Close debug first (clear hash) so the target screen gets a clean view
    window.location.hash = "";
    onClose();
    setTimeout(() => {
      if (target === "onboarding") {
        resetOnboarding(); // full reload into the welcome screen
      } else if (target === "subscription") {
        window.dispatchEvent(new CustomEvent("ether:open-subscription"));
      } else if (target === "managedevices") {
        window.dispatchEvent(new CustomEvent("ether:open-managedevices"));
      } else if (target === "about") {
        window.dispatchEvent(new CustomEvent("ether:open-about"));
      } else if (target === "settings") {
        window.location.hash = "#settings/station";
      }
    }, 50);
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
        zIndex: 99999, display: "flex", justifyContent: "flex-end",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 380, height: "100%", background: PANEL_BG,
          borderLeft: `1px solid ${PANEL_BORDER}`,
          padding: "20px 22px", overflowY: "auto",
          fontFamily: "system-ui, -apple-system, sans-serif",
          color: TEXT_PRIMARY,
        }}
      >
        {/* Header */}
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          marginBottom: 18, paddingBottom: 10, borderBottom: `1px solid ${PANEL_BORDER}`,
        }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.14em", color: ACCENT }}>
            ▓ DEBUG PANEL ▓
          </div>
          <button
            onClick={onClose}
            style={{
              background: "transparent", color: TEXT_MUTED, border: "none",
              fontSize: 18, cursor: "pointer", padding: "0 6px",
            }}
            title="Close (Esc)"
          >×</button>
        </div>

        {/* Tier override */}
        <Section title="TIER OVERRIDE">
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
            {TIERS.map(t => {
              const selected = activeOverride === t.label;
              return (
                <label
                  key={t.label}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "8px 10px", cursor: "pointer",
                    background: selected ? ACCENT_DIM : "transparent",
                    border: `1px solid ${selected ? ACCENT : PANEL_BORDER}`,
                    fontSize: 12,
                  }}
                >
                  <input
                    type="radio"
                    name="dev-tier"
                    checked={selected}
                    disabled={busy}
                    onChange={() => selectTier(t.label)}
                    style={{ accentColor: ACCENT }}
                  />
                  <span style={{ flex: 1, color: TEXT_PRIMARY, fontWeight: selected ? 700 : 500 }}>
                    {t.display}
                  </span>
                  <span style={{ color: TEXT_DIM, fontFamily: "'DM Mono', monospace", fontSize: 10 }}>
                    ({t.code})
                  </span>
                </label>
              );
            })}
          </div>
          <button
            onClick={clearTier}
            disabled={busy || !activeOverride}
            style={{
              width: "100%", padding: "8px 12px", borderRadius: 0,
              background: activeOverride ? "transparent" : "rgba(255,255,255,0.02)",
              color: activeOverride ? TEXT_PRIMARY : TEXT_DIM,
              border: `1px solid ${activeOverride ? PANEL_BORDER : "#1a1a22"}`,
              fontSize: 11, fontWeight: 600, letterSpacing: "0.04em",
              cursor: activeOverride && !busy ? "pointer" : "not-allowed",
            }}
          >
            Clear override — use real license
          </button>
        </Section>

        {/* Onboarding */}
        <Section title="ONBOARDING">
          <button
            onClick={resetOnboarding}
            disabled={busy}
            style={primaryButtonStyle(busy)}
          >
            Reset onboarding (clear flags + reload)
          </button>
          <div style={{ fontSize: 10, color: TEXT_DIM, marginTop: 8, lineHeight: 1.5 }}>
            Clears <code>first_run_complete</code>, <code>experience_mode</code>,
            <code> venue_type</code>, and step trackers. Keeps license + station
            data — re-walking onboarding pre-fills with prior input.
          </div>
        </Section>

        {/* Jump to screen */}
        <Section title="JUMP TO SCREEN">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <button onClick={() => jumpTo("onboarding")}    disabled={busy} style={jumpButtonStyle(busy)}>Onboarding (Welcome)</button>
            <button onClick={() => jumpTo("subscription")}  disabled={busy} style={jumpButtonStyle(busy)}>Subscription</button>
            <button onClick={() => jumpTo("managedevices")} disabled={busy} style={jumpButtonStyle(busy)}>Manage Devices</button>
            <button onClick={() => jumpTo("about")}         disabled={busy} style={jumpButtonStyle(busy)}>About</button>
            <button onClick={() => jumpTo("settings")}      disabled={busy} style={jumpButtonStyle(busy)}>Settings</button>
          </div>
        </Section>

        {/* Console hints */}
        <div style={{
          marginTop: 24, padding: "10px 12px", background: "rgba(255,255,255,0.02)",
          border: `1px solid ${PANEL_BORDER}`,
          fontFamily: "'DM Mono', monospace", fontSize: 10, color: TEXT_MUTED,
          lineHeight: 1.7,
        }}>
          <div style={{ color: TEXT_DIM, marginBottom: 6, letterSpacing: "0.06em" }}>CONSOLE</div>
          <div>window.__devSetTier(<span style={{ color: ACCENT }}>'studio'</span>)</div>
          <div>window.__devClearTier()</div>
          <div>window.__devResetOnboarding()</div>
        </div>
      </div>
    </div>
  );
}

// ── Mount ─────────────────────────────────────────────────────────────────
// Watches window.location.hash and renders DebugPanel when hash === '#debug'.
// Closing the panel (Esc, X, click-outside) clears the hash.

export function DebugMount() {
  const [open, setOpen] = useState(window.location.hash === "#debug");

  useEffect(() => {
    const sync = () => setOpen(window.location.hash === "#debug");
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  if (!open) return null;
  return <DebugPanel onClose={() => {
    if (window.location.hash === "#debug") {
      // Restore previous hash (or clear) — replaceState so back button isn't polluted
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    setOpen(false);
  }} />;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{
        fontSize: 10, fontWeight: 800, letterSpacing: "0.14em",
        color: TEXT_MUTED, marginBottom: 10,
      }}>{title}</div>
      {children}
    </div>
  );
}

function primaryButtonStyle(busy: boolean): React.CSSProperties {
  return {
    width: "100%", padding: "10px 12px", borderRadius: 0,
    background: ACCENT_DIM, color: ACCENT,
    border: `1px solid ${ACCENT}`,
    fontSize: 12, fontWeight: 700, letterSpacing: "0.04em",
    cursor: busy ? "wait" : "pointer",
    opacity: busy ? 0.5 : 1,
  };
}

function jumpButtonStyle(busy: boolean): React.CSSProperties {
  return {
    width: "100%", padding: "9px 12px", borderRadius: 0,
    background: "transparent", color: TEXT_PRIMARY,
    border: `1px solid ${PANEL_BORDER}`,
    fontSize: 12, fontWeight: 600, letterSpacing: "0.02em",
    cursor: busy ? "wait" : "pointer", textAlign: "left",
    opacity: busy ? 0.5 : 1,
  };
}
