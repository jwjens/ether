// ConfirmDialog — the in-app confirm that replaces window.confirm, which no-ops in the packaged build (audit 5).
// useConfirm() returns [ask, dialog]: render `dialog` in the component, `await ask("Delete X?", { danger: true })`.
// Enter confirms, Esc cancels; the dialog takes focus so a stray key can't answer it for the operator.
import React, { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { createConfirmController } from "../lib/confirmController";

export function useConfirm(): [(message: string, opts?: { confirmLabel?: string; danger?: boolean }) => Promise<boolean>, React.ReactNode] {
  const ctl = useMemo(() => createConfirmController(), []);
  const req = useSyncExternalStore(ctl.subscribe, ctl.pending, ctl.pending);
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (req) okRef.current?.focus(); }, [req]);
  useEffect(() => () => ctl.answer(false), [ctl]);   // unmounting never leaves a question hanging
  const dialog = req ? (
    <div role="alertdialog" aria-modal="true" aria-label={req.message}
         onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); ctl.answer(false); } }}
         style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ minWidth: 320, maxWidth: 480, padding: 20, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)" }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16, whiteSpace: "pre-wrap" }}>{req.message}</div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={() => ctl.answer(false)}
                  style={{ minHeight: 36, padding: "0 14px", background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer", fontWeight: 700 }}>
            Cancel
          </button>
          <button ref={okRef} onClick={() => ctl.answer(true)}
                  style={{ minHeight: 36, padding: "0 14px", cursor: "pointer", fontWeight: 800,
                           background: req.danger ? "var(--accent-red, #ef4444)" : "var(--accent-blue)", color: "#fff", border: "none" }}>
            {req.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  ) : null;
  return [ctl.ask, dialog];
}
