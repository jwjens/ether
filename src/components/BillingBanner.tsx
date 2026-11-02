import { useEffect, useState } from "react";
import { getBillingNotice, onBillingNotice, shouldShowPopup, markPopupShown, type BillingNotice } from "../lib/billingNotice";

// The billing popup (Jeff, 2026-10-31: "a popup window, like Adobe's"). A small window floating at the top right under the
// header with the notice's words and two buttons — Update card / Add a card, and Later. It is NOT modal: no backdrop, the
// rest of Ether stays clickable, and it never takes keyboard focus (nothing here calls focus(), and the window is not a
// focus trap), so a jock's shortcut keys keep firing while it is up. Both buttons close it. It shows when Ether opens and
// at most once a day after that (src/lib/billingNotice.ts). Billing never touches audio or playout.
const COLORS: Record<string, { accent: string; fg: string }> = {
  critical: { accent: "#ef4444", fg: "#fca5a5" },
  warning:  { accent: "#f59e0b", fg: "#fcd34d" },
  info:     { accent: "#8868D8", fg: "#c4b5fd" },
};

export default function BillingBanner() {
  const [notice, setNotice] = useState<BillingNotice | null>(() => getBillingNotice());
  const [open, setOpen] = useState(false);
  useEffect(() => onBillingNotice(setNotice), []);
  // Due now? On the first notice of this run; a DIFFERENT notice at once; the same notice again once a day while Ether
  // runs (checked every minute). src/lib/billingNotice.ts shouldShowPopup.
  useEffect(() => {
    if (!notice) { setOpen(false); return; }
    const check = () => { if (shouldShowPopup(Date.now(), localStorage, undefined, notice)) { markPopupShown(Date.now(), localStorage, notice); setOpen(true); } };
    // While it is open its words follow the newest notice; that notice counts as shown (Later closes it until it is due).
    if (!open) check(); else markPopupShown(Date.now(), localStorage, notice);
    const t = setInterval(() => { if (!open) check(); }, 60_000);
    return () => clearInterval(t);
  }, [notice, open]);
  if (!notice || !open) return null;
  const c = COLORS[notice.severity === "error" ? "critical" : (notice.severity || "warning")] || COLORS.warning;
  const act = () => {
    const url = notice.action?.url;
    if (url) { const sys = (window as any).ether?.system; if (sys?.openUrl) sys.openUrl(url); else window.open(url, "_blank"); }
    setOpen(false);
  };
  // onMouseDown preventDefault keeps a click on the popup from moving keyboard focus onto its buttons.
  const noFocus = (e: React.MouseEvent) => e.preventDefault();
  return (
    <div role="dialog" aria-modal="false" aria-labelledby="billing-popup-title" data-billing-kind={notice.kind}
      style={{ position: "fixed", top: 64, right: 16, width: 420, maxWidth: "calc(100vw - 32px)", zIndex: 9000,
        background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderTop: `3px solid ${c.accent}`,
        boxShadow: "0 18px 50px rgba(0,0,0,0.45)", padding: "16px 18px 14px" }}>
      <div id="billing-popup-title" style={{ fontSize: 15, fontWeight: 700, color: c.fg, marginBottom: 6 }}>{notice.title}</div>
      <div style={{ fontSize: 13, lineHeight: 1.5, color: "var(--text-secondary)", marginBottom: 14 }}>{notice.body}</div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button tabIndex={-1} onMouseDown={noFocus} onClick={() => setOpen(false)}
          style={{ padding: "7px 14px", fontSize: 12, background: "transparent", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>
          Later
        </button>
        {notice.action?.url && (
          <button tabIndex={-1} onMouseDown={noFocus} onClick={act}
            style={{ padding: "7px 16px", fontSize: 12, fontWeight: 700, background: c.accent, color: "#fff", border: "none", cursor: "pointer" }}>
            {notice.action.label}
          </button>
        )}
      </div>
    </div>
  );
}
