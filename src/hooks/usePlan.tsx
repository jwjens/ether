/**
 * usePlan.ts — Ether Technologies plan gating
 *
 * Reads plan_tier from SQLite once on mount, exposes simple booleans.
 * Use anywhere in the app:
 *
 *   const { isPro, isStation, plan } = usePlan();
 *   if (!isPro) return <UpgradePrompt feature="PDF Reports" />;
 *
 * Also exports:
 *   requirePlan(plan, currentPlan) — returns true if currentPlan meets requirement
 *   UpgradePrompt                  — inline locked-feature UI
 *   PlanGate                       — wrapper component that shows children or upgrade prompt
 */

import { useState, useEffect } from "react";
import { useActiveStation } from "./useActiveStation";

export type PlanTier = "free" | "pro" | "station" | "operator";

const TIER_RANK: Record<PlanTier, number> = { free: 0, pro: 1, station: 2, operator: 3 };

/** Returns true if the user's current plan meets or exceeds the required tier */
export function requirePlan(required: PlanTier, current: PlanTier): boolean {
  return TIER_RANK[current] >= TIER_RANK[required];
}

// ─── Hook ─────────────────────────────────────────────────────

let _cached: PlanTier | null = null;
const _listeners = new Set<(p: PlanTier) => void>();

function notifyAll(p: PlanTier) {
  _cached = p;
  _listeners.forEach(fn => fn(p));
}

/** Call this after a successful license validation to update all components instantly */
export function setPlanGlobally(plan: PlanTier) {
  notifyAll(plan);
}

export function usePlan() {
  const [plan, setPlan] = useState<PlanTier>(_cached ?? "free");
  const { stationId, isReady } = useActiveStation();

  useEffect(() => {
    // Register listener for live updates (e.g. after license activation)
    _listeners.add(setPlan);
    return () => { _listeners.delete(setPlan); };
  }, []);

  useEffect(() => {
    // Dev override always wins — must run before _cached check so a real license
    // in the DB doesn't prevent the flag from taking effect on subsequent boots
    if (import.meta.env.VITE_DEV_FORCE_OPERATOR_TIER === "true") {
      notifyAll("operator");
      return;
    }
    if (!isReady) return;
    if (_cached) { setPlan(_cached); return; }
    // Load from DB
    (async () => {
      try {
        const result = await (window as any).ether.stationConfigKv.list(stationId);
        const rows: { key: string; value: string }[] = result.ok ? result.rows : [];
        const p = (rows.find((r: { key: string }) => r.key === 'plan_tier')?.value ?? "free") as PlanTier;
        notifyAll(p);
      } catch {
        notifyAll("free");
      }
    })();
  }, [stationId, isReady]);

  return {
    plan,
    isPro:      requirePlan("pro",      plan),
    isStation:  requirePlan("station",  plan),
    isOperator: requirePlan("operator", plan),
    isFree:     plan === "free",
  };
}

// ─── UpgradePrompt component ───────────────────────────────────

interface UpgradePromptProps {
  feature:    string;
  required:   PlanTier;
  compact?:   boolean;
  onUpgrade?: () => void;
}

export function UpgradePrompt({ feature, required, compact = false, onUpgrade }: UpgradePromptProps) {
  // Operator tier is enterprise-only — never show a self-serve upgrade prompt
  if (required === "operator") return null;

  const label  = required === "pro" ? "Pro" : "Station";
  const color  = required === "pro" ? "#22d3ee" : "#a78bfa";
  const price  = required === "pro" ? "$19/mo" : "$79/mo";

  const handleUpgrade = () => {
    if (onUpgrade) { onUpgrade(); return; }
    // Default: navigate to subscription panel
    window.dispatchEvent(new CustomEvent("ether:open-subscription"));
  };

  if (compact) {
    return (
      <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <div style={{
          fontSize: 9, fontWeight: 800, letterSpacing: "0.1em",
          color, background: color + "18",
          border: `1px solid ${color}35`,
          borderRadius: 0, padding: "2px 7px",
          cursor: "pointer",
        }} onClick={handleUpgrade}>
          {label.toUpperCase()} FEATURE
        </div>
      </div>
    );
  }

  return (
    <div style={{
      display: "flex", flexDirection: "column" as const,
      alignItems: "center", justifyContent: "center",
      padding: "40px 32px", gap: 16,
      background: "var(--bg-secondary)",
      border: `1px solid ${color}25`,
      borderRadius: 0,
      textAlign: "center" as const,
    }}>
      {/* Lock icon */}
      <div style={{
        width: 52, height: 52, borderRadius: 0,
        background: color + "15",
        border: `1px solid ${color}30`,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round">
          <rect x="3" y="11" width="18" height="11" rx="2"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
      </div>

      <div>
        <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)", marginBottom: 6 }}>
          {feature}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-tertiary)", maxWidth: 280, lineHeight: 1.6 }}>
          This feature is included in the <span style={{ color, fontWeight: 700 }}>{label} plan</span> — {price}
        </div>
      </div>

      <button
        onClick={handleUpgrade}
        style={{
          padding: "9px 24px", borderRadius: 0, fontSize: 12, fontWeight: 700,
          background: color, color: required === "pro" ? "#000" : "#fff",
          border: "none", cursor: "pointer",
          boxShadow: `0 0 20px ${color}40`,
          letterSpacing: "0.02em",
        }}
      >
        Upgrade to {label} →
      </button>
    </div>
  );
}

// ─── PlanGate component ────────────────────────────────────────

interface PlanGateProps {
  requires:   PlanTier;
  feature:    string;
  children:   React.ReactNode;
  compact?:   boolean;
  onUpgrade?: () => void;
}

/**
 * Wraps any feature. Shows children if the user has the right plan,
 * otherwise shows an UpgradePrompt.
 *
 * Usage:
 *   <PlanGate requires="pro" feature="PDF Traffic Reports">
 *     <PdfReportPanel />
 *   </PlanGate>
 */
export function PlanGate({ requires, feature, children, compact, onUpgrade }: PlanGateProps) {
  const { plan } = usePlan();
  if (requirePlan(requires, plan)) return <>{children}</>;
  return <UpgradePrompt feature={feature} required={requires} compact={compact} onUpgrade={onUpgrade} />;
}
