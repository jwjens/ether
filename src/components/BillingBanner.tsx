import { useEffect, useState } from "react";
import { getBillingNotice, onBillingNotice, isDismissed, dismiss, type BillingNotice } from "../lib/billingNotice";

// The billing banner (src/lib/billingNotice.ts). A strip in the page above the header — it pushes the screen down a line,
// never covers the decks or any control, and never blocks: the station keeps playing whatever it says. "Later" hides it
// for 24 hours; a different notice shows at once. Replaces the old full-screen "Your free trial has ended" overlay.
const COLORS: Record<string, { bg: string; border: string; fg: string }> = {
  critical: { bg: "rgba(239,68,68,0.12)", border: "rgba(239,68,68,0.45)", fg: "#fca5a5" },
  warning:  { bg: "rgba(245,158,11,0.12)", border: "rgba(245,158,11,0.45)", fg: "#fcd34d" },
  info:     { bg: "rgba(136,104,216,0.14)", border: "rgba(136,104,216,0.45)", fg: "#c4b5fd" },
};

export default function BillingBanner() {
  const [notice, setNotice] = useState<BillingNotice | null>(() => getBillingNotice());
  const [, setTick] = useState(0);
  useEffect(() => onBillingNotice(setNotice), []);
  if (!notice || isDismissed(notice)) return null;
  const c = COLORS[notice.severity || "warning"] || COLORS.warning;
  const open = () => {
    const url = notice.action?.url; if (!url) return;
    const sys = (window as any).ether?.system;
    if (sys?.openUrl) sys.openUrl(url); else window.open(url, "_blank");
  };
  return (
    <div role="status" aria-live="polite" data-billing-kind={notice.kind}
      style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 16px", background: c.bg, borderBottom: `1px solid ${c.border}`, flexShrink: 0, flexWrap: "wrap" }}>
      <div style={{ flex: 1, minWidth: 240 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: c.fg }}>{notice.title}</span>
        <span style={{ fontSize: 13, color: "var(--text-secondary)", marginLeft: 8 }}>{notice.body}</span>
      </div>
      {notice.action?.url && (
        <button onClick={open} style={{ padding: "6px 14px", fontSize: 12, fontWeight: 700, background: c.fg, color: "#111", border: "none", cursor: "pointer" }}>
          {notice.action.label}
        </button>
      )}
      <button onClick={() => { dismiss(notice); setTick(t => t + 1); }} title="Hide for 24 hours"
        style={{ padding: "6px 10px", fontSize: 12, background: "transparent", color: "var(--text-tertiary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>
        Later
      </button>
    </div>
  );
}
