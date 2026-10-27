// InlineNameEditor — explicit, unambiguous rename affordance for an item row (4.4.63).
// Shows the name with a small EDIT button; clicking swaps to a text field with explicit SAVE and CANCEL.
// No double-click, no blur-to-save ambiguity. onSave writes the caller's normal update path (which then
// propagates everywhere — pools, dropdowns, placements, the on-air indicator). Used by the Library grid,
// the Jingles panel item rows, and the Reel Splitter's pre-commit region list.
// A FAILED SAVE IS SHOWN (Jeff, 2026-10-26: "make a failed save show an error instead of silently bouncing back"): if
// onSave throws or returns { ok: false, error }, the field stays open with what was typed and the reason under it.
import { useState, useEffect } from "react";

interface Props {
  value: string;
  /** Throw, or return { ok: false, error }, when the save was refused — the editor then stays open and shows why. */
  onSave: (next: string) => void | { ok?: boolean; error?: string } | Promise<void | { ok?: boolean; error?: string } | undefined>;
  /** Optional custom display node (badges etc.) shown instead of the raw value when NOT editing. */
  display?: React.ReactNode;
  /** Hide the EDIT button (e.g. a borrowed/read-only catalog row). */
  readOnly?: boolean;
  /** Compact styling for dense rows. */
  compact?: boolean;
}

export default function InlineNameEditor({ value, onSave, display, readOnly, compact }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  const close = () => { setError(null); setEditing(false); };

  const fs = compact ? 12 : 13;
  const btn = (bg: string, bd: string, fg: string): React.CSSProperties => ({
    padding: compact ? "2px 6px" : "3px 8px", fontSize: 10, fontWeight: 800, letterSpacing: "0.06em",
    background: bg, border: `1px solid ${bd}`, color: fg, borderRadius: 0, cursor: "pointer", flexShrink: 0,
  });

  const save = async () => {
    const next = draft.trim();
    if (!next || next === value) { close(); return; }
    setBusy(true);
    let failed: string | null = null;
    try {
      const r = await onSave(next);
      if (r && typeof r === "object" && r.ok === false) failed = r.error || "the save was refused";
    } catch (e: any) { failed = String(e?.message || e) || "the save failed"; }
    setBusy(false);
    if (failed) { setError(`Not saved: ${failed}`); return; }   // stays open, with what was typed
    close();
  };

  if (editing) {
    return (
      <span style={{ display: "flex", flexDirection: "column" as any, flex: 1, minWidth: 0 }}>
      <span style={{ display: "flex", alignItems: "center", gap: 4, flex: 1, minWidth: 0 }} onDoubleClick={e => e.stopPropagation()}>
        <input
          autoFocus
          value={draft}
          disabled={busy}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); save(); } if (e.key === "Escape") { e.preventDefault(); close(); } }}
          onClick={e => e.stopPropagation()}
          aria-invalid={error ? true : undefined}
          style={{ flex: 1, minWidth: 0, padding: "2px 6px", fontSize: fs, background: "var(--bg-tertiary)", border: `1px solid ${error ? "var(--accent-red, #ef4444)" : "var(--accent-blue)"}`, color: "var(--text-primary)", outline: "none" }}
        />
        <button onClick={e => { e.stopPropagation(); save(); }} disabled={busy} title="Save name" style={btn("var(--accent-blue)", "var(--accent-blue)", "#fff")}>SAVE</button>
        <button onClick={e => { e.stopPropagation(); close(); }} disabled={busy} title="Cancel" style={btn("var(--bg-tertiary)", "var(--border-primary)", "var(--text-secondary)")}>CANCEL</button>
      </span>
      {error && <span role="alert" style={{ fontSize: 11, color: "var(--accent-red, #ef4444)", marginTop: 2, whiteSpace: "normal" }}>{error}</span>}
      </span>
    );
  }

  return (
    <span style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{display ?? (value || "—")}</span>
      {!readOnly && (
        <button
          onClick={e => { e.stopPropagation(); setDraft(value); setEditing(true); }}
          title="Edit name"
          style={btn("transparent", "var(--border-primary)", "var(--text-tertiary)")}
        >EDIT</button>
      )}
    </span>
  );
}
