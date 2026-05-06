import { useState, useEffect, useRef } from "react";
import { ALL_LIB_COLS, LIB_COL_LABELS, type LibCol, type MetadataDefinition, type MetadataVocabulary } from "../types/metadata";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  visibleColumns: Set<LibCol>;
  onColumnToggle: (col: LibCol) => void;
  stationId: number;
}

type DataType = MetadataDefinition["data_type"];

const DATA_TYPE_OPTIONS: { value: DataType; label: string }[] = [
  { value: "text",          label: "Freeform text" },
  { value: "number",        label: "Numeric value" },
  { value: "single_choice", label: "Pick one (vocabulary)" },
  { value: "multi_choice",  label: "Pick multiple (vocabulary)" },
  { value: "boolean",       label: "On / Off toggle" },
  { value: "date",          label: "Date value" },
];

const DATA_TYPE_LABELS: Record<DataType, string> = {
  text:          "Text",
  number:        "Number",
  single_choice: "Select",
  multi_choice:  "Multi-select",
  boolean:       "Toggle",
  date:          "Date",
};

const DATA_TYPE_STYLE: Record<DataType, { background: string; color: string }> = {
  text:          { background: "rgba(148,163,184,0.12)", color: "#94a3b8" },
  number:        { background: "rgba(56,189,248,0.12)",  color: "#38bdf8" },
  single_choice: { background: "rgba(99,102,241,0.12)",  color: "#818cf8" },
  multi_choice:  { background: "rgba(167,139,250,0.12)", color: "#c084fc" },
  boolean:       { background: "rgba(52,211,153,0.12)",  color: "#34d399" },
  date:          { background: "rgba(251,191,36,0.12)",  color: "#fbbf24" },
};

const INPUT_STYLE: React.CSSProperties = {
  width: "100%", padding: "7px 10px", borderRadius: 0, fontSize: 13,
  background: "var(--bg-primary)", border: "1px solid var(--border-primary)",
  color: "var(--text-primary)", outline: "none", boxSizing: "border-box",
};

function Toggle({ on }: { on: boolean }) {
  return (
    <div style={{
      width: 36, height: 20, borderRadius: 10, flexShrink: 0,
      background: on ? "var(--accent-blue)" : "var(--bg-tertiary)",
      border: "1px solid " + (on ? "transparent" : "var(--border-secondary)"),
      position: "relative" as const, cursor: "pointer",
    }}>
      <div style={{
        position: "absolute" as const, top: 2, left: on ? 17 : 2,
        width: 14, height: 14, borderRadius: 7,
        background: on ? "#fff" : "var(--text-tertiary)",
        transition: "left 0.12s ease",
      }} />
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
      style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s ease", color: "var(--text-tertiary)", flexShrink: 0 }}>
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

export default function LibraryColumnsPanel({ isOpen, onClose, visibleColumns, onColumnToggle, stationId }: Props) {
  // ── Data ──────────────────────────────────────────────────────
  const [definitions, setDefinitions]   = useState<MetadataDefinition[]>([]);
  const [vocabByDefId, setVocabByDefId] = useState<Record<number, MetadataVocabulary[]>>({});
  const [loading, setLoading]           = useState(false);
  const [reloadKey, setReloadKey]       = useState(0);

  // ── Definition expand (one at a time) ─────────────────────────
  const [expandedDefId, setExpandedDefId] = useState<number | null>(null);

  // ── Definition add form ───────────────────────────────────────
  const [formOpen, setFormOpen]               = useState(false);
  const [formName, setFormName]               = useState("");
  const [formDataType, setFormDataType]       = useState<DataType>("text");
  const [formDescription, setFormDescription] = useState("");
  const [formError, setFormError]             = useState("");
  const [formPending, setFormPending]         = useState(false);

  // ── Vocabulary add form ───────────────────────────────────────
  const [vocabFormDefId, setVocabFormDefId]   = useState<number | null>(null);
  const [vocabFormValue, setVocabFormValue]   = useState("");
  const [vocabFormError, setVocabFormError]   = useState("");
  const [vocabFormPending, setVocabFormPending] = useState(false);

  // ── Highlight new definition row ──────────────────────────────
  const [newDefUuid, setNewDefUuid] = useState<string | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const nameInputRef  = useRef<HTMLInputElement>(null);
  const vocabInputRef = useRef<HTMLInputElement>(null);

  // ── Derived: count per definition ─────────────────────────────
  const vocabCounts: Record<number, number> = {};
  for (const [id, rows] of Object.entries(vocabByDefId)) {
    vocabCounts[Number(id)] = rows.length;
  }

  // ── Load data ─────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    (async () => {
      try {
        const defsRes = await (window as any).ether.metadataDefinitions.list(stationId);
        const defs: MetadataDefinition[] = defsRes?.ok ? (defsRes.rows ?? []) : [];
        const active = defs
          .filter(d => !d.deleted_at)
          .sort((a, b) => a.display_order - b.display_order || a.name.localeCompare(b.name));
        setDefinitions(active);

        const vocabRes = await (window as any).ether.metadataVocabulary.list(stationId);
        const vocab: MetadataVocabulary[] = vocabRes?.ok ? (vocabRes.rows ?? []) : [];
        const byDef: Record<number, MetadataVocabulary[]> = {};
        for (const v of vocab) {
          if (!v.deleted_at) {
            if (!byDef[v.definition_id]) byDef[v.definition_id] = [];
            byDef[v.definition_id].push(v);
          }
        }
        for (const rows of Object.values(byDef)) {
          rows.sort((a, b) => a.display_order - b.display_order || a.value.localeCompare(b.value));
        }
        setVocabByDefId(byDef);
      } catch (e) {
        console.error("[LibraryColumnsPanel] load error:", e);
      } finally {
        setLoading(false);
      }
    })();
  }, [isOpen, stationId, reloadKey]);

  // Focus name input when definition form opens
  useEffect(() => {
    if (formOpen) setTimeout(() => nameInputRef.current?.focus(), 0);
  }, [formOpen]);

  // Focus vocab input when vocab form opens
  useEffect(() => {
    if (vocabFormDefId !== null) setTimeout(() => vocabInputRef.current?.focus(), 0);
  }, [vocabFormDefId]);

  // Clear definition highlight after 1.5s
  useEffect(() => {
    if (!newDefUuid) return;
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setNewDefUuid(null), 1500);
    return () => { if (highlightTimer.current) clearTimeout(highlightTimer.current); };
  }, [newDefUuid]);

  // Reset form state on panel close or station change
  useEffect(() => {
    if (!isOpen) { setFormOpen(false); resetDefForm(); setExpandedDefId(null); closeVocabForm(); }
  }, [isOpen, stationId]);

  if (!isOpen) return null;

  // ── Definition form helpers ───────────────────────────────────

  function resetDefForm() {
    setFormName(""); setFormDataType("text"); setFormDescription("");
    setFormError(""); setFormPending(false);
  }

  function openDefForm() { resetDefForm(); setFormOpen(true); }
  function closeDefForm() { resetDefForm(); setFormOpen(false); }

  async function submitDefForm() {
    const name = formName.trim();
    if (!name) { setFormError("Name is required."); return; }
    if (definitions.some(d => d.name.toLowerCase() === name.toLowerCase())) {
      setFormError("A category with this name already exists."); return;
    }
    setFormError(""); setFormPending(true);
    try {
      const maxOrder = definitions.reduce((m, d) => Math.max(m, d.display_order ?? 0), 0);
      const res = await (window as any).ether.metadataDefinitions.create({
        station_id: stationId, name, data_type: formDataType,
        description: formDescription.trim() || "", is_required: 0, is_built_in: 0,
        display_order: maxOrder + 10,
      });
      if (!res?.ok) { setFormError(res?.error ?? "Failed to create category."); setFormPending(false); return; }
      const createdUuid: string | undefined = res.row?.uuid;
      closeDefForm();
      setReloadKey(k => k + 1);
      if (createdUuid) setNewDefUuid(createdUuid);
    } catch (e: any) { setFormError(e?.message ?? "Unexpected error."); setFormPending(false); }
  }

  // ── Vocabulary form helpers ───────────────────────────────────

  function closeVocabForm() {
    setVocabFormDefId(null); setVocabFormValue(""); setVocabFormError(""); setVocabFormPending(false);
  }

  function openVocabForm(defId: number) {
    setVocabFormValue(""); setVocabFormError(""); setVocabFormPending(false);
    setVocabFormDefId(defId);
  }

  async function submitVocabForm(def: MetadataDefinition) {
    const value = vocabFormValue.trim();
    if (!value) { setVocabFormError("Value is required."); return; }
    const existing = vocabByDefId[def.id] ?? [];
    if (existing.some(v => v.value.toLowerCase() === value.toLowerCase())) {
      setVocabFormError("This value already exists."); return;
    }
    setVocabFormError(""); setVocabFormPending(true);
    try {
      const maxOrder = existing.reduce((m, v) => Math.max(m, v.display_order ?? 0), 0);
      const res = await (window as any).ether.metadataVocabulary.create({
        station_id: stationId, definition_id: def.id,
        value, display_order: maxOrder + 10, color: null,
      });
      if (!res?.ok) { setVocabFormError(res?.error ?? "Failed to add value."); setVocabFormPending(false); return; }
      closeVocabForm();
      setReloadKey(k => k + 1);
    } catch (e: any) { setVocabFormError(e?.message ?? "Unexpected error."); setVocabFormPending(false); }
  }

  async function removeVocab(def: MetadataDefinition, vocab: MetadataVocabulary) {
    if (!confirm(`Remove value "${vocab.value}" from category "${def.name}"?`)) return;
    try {
      const res = await (window as any).ether.metadataVocabulary.delete(vocab.uuid, stationId);
      if (!res?.ok) { alert(res?.error ?? "Failed to remove value."); return; }
      setReloadKey(k => k + 1);
    } catch (e: any) { alert(e?.message ?? "Unexpected error."); }
  }

  function toggleExpand(def: MetadataDefinition) {
    setExpandedDefId(prev => prev === def.id ? null : def.id);
    // Close vocab form when collapsing or switching
    if (vocabFormDefId !== null) closeVocabForm();
  }

  const isChoiceType = (dt: DataType) => dt === "single_choice" || dt === "multi_choice";
  const canSubmitDef = formName.trim().length > 0 && !formPending;

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 9998, display: "flex", alignItems: "center", justifyContent: "center" }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: "var(--bg-primary)", border: "1px solid var(--border-primary)", borderRadius: 0,
        width: 560, maxWidth: "92vw", maxHeight: "80vh",
        display: "flex", flexDirection: "column" as const,
        boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
      }}>
        {/* Header */}
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border-primary)", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", letterSpacing: "-0.02em", fontFamily: "'Inter', sans-serif" }}>Library Columns</div>
            <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 2 }}>Choose which columns appear in the song library</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 18, lineHeight: 1, padding: "0 2px" }}>✕</button>
        </div>

        {/* Scrollable body */}
        <div style={{ overflowY: "auto" as const, flex: 1 }}>

          {/* ── Section 1: Standard Fields ── */}
          <div style={{ borderBottom: "1px solid var(--border-primary)" }}>
            <div style={{ padding: "12px 20px 10px", background: "var(--bg-secondary)", borderBottom: "1px solid var(--border-primary)" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as const, letterSpacing: "0.08em" }}>Standard Fields</div>
              <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 3 }}>Built-in song attributes — toggle which columns appear in the library table</div>
            </div>
            {ALL_LIB_COLS.map((col, idx) => (
              <div key={col} onClick={() => onColumnToggle(col)}
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 20px", borderBottom: idx < ALL_LIB_COLS.length - 1 ? "1px solid var(--border-primary)" : "none", cursor: "pointer", userSelect: "none" as const }}
                onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-hover)")}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                <span style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 500 }}>{LIB_COL_LABELS[col]}</span>
                <Toggle on={visibleColumns.has(col)} />
              </div>
            ))}
          </div>

          {/* ── Section 2: Custom Metadata ── */}
          <div>
            {/* Section 2 header */}
            <div style={{ padding: "12px 20px 10px", background: "var(--bg-secondary)", borderBottom: "1px solid var(--border-primary)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as const, letterSpacing: "0.08em" }}>Custom Metadata</div>
                <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 3 }}>Metadata categories defined for this station</div>
              </div>
              <button
                onClick={formOpen ? closeDefForm : openDefForm}
                style={{ padding: "5px 10px", borderRadius: 4, fontSize: 12, fontWeight: 600, background: formOpen ? "var(--bg-tertiary)" : "rgba(56,189,248,0.08)", color: formOpen ? "var(--text-tertiary)" : "var(--accent-blue)", border: "1px solid " + (formOpen ? "var(--border-primary)" : "rgba(56,189,248,0.3)"), cursor: "pointer", flexShrink: 0 }}>
                {formOpen ? "Cancel" : "+ Add Category"}
              </button>
            </div>

            {/* Definition add form */}
            {formOpen && (
              <div style={{ padding: "14px 20px", background: "var(--bg-secondary)", borderBottom: "1px solid var(--border-primary)", display: "flex", flexDirection: "column" as const, gap: 10 }}>
                <div>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", marginBottom: 4, textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>Name *</label>
                  <input ref={nameInputRef} value={formName} onChange={e => { setFormName(e.target.value.slice(0, 50)); setFormError(""); }}
                    onKeyDown={e => { if (e.key === "Enter" && canSubmitDef) submitDefForm(); if (e.key === "Escape") closeDefForm(); }}
                    placeholder="e.g. Vibe, Era, Format Type" style={INPUT_STYLE} maxLength={50} />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", marginBottom: 4, textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>Data Type</label>
                  <select value={formDataType} onChange={e => setFormDataType(e.target.value as DataType)} style={{ ...INPUT_STYLE, cursor: "pointer" }}>
                    {DATA_TYPE_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", marginBottom: 4, textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>
                    Description <span style={{ fontWeight: 400, textTransform: "none" as const }}>— optional</span>
                  </label>
                  <input value={formDescription} onChange={e => setFormDescription(e.target.value.slice(0, 200))}
                    onKeyDown={e => { if (e.key === "Escape") closeDefForm(); }}
                    placeholder="What is this category for?" style={INPUT_STYLE} maxLength={200} />
                </div>
                {formError && (
                  <div style={{ fontSize: 12, color: "var(--accent-red)", padding: "6px 10px", background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 4 }}>
                    {formError}
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button onClick={closeDefForm} style={{ padding: "7px 16px", borderRadius: 4, fontSize: 13, fontWeight: 600, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>Cancel</button>
                  <button onClick={submitDefForm} disabled={!canSubmitDef}
                    style={{ padding: "7px 18px", borderRadius: 4, fontSize: 13, fontWeight: 700, background: canSubmitDef ? "var(--accent-blue)" : "var(--bg-tertiary)", color: canSubmitDef ? "#fff" : "var(--text-tertiary)", border: "none", cursor: canSubmitDef ? "pointer" : "default", opacity: formPending ? 0.6 : 1 }}>
                    {formPending ? "Adding…" : "Add Category"}
                  </button>
                </div>
              </div>
            )}

            {/* Definition list */}
            {loading ? (
              <div style={{ padding: "24px 20px", fontSize: 13, color: "var(--text-tertiary)" }}>Loading...</div>
            ) : definitions.length === 0 ? (
              <div style={{ padding: "24px 20px", fontSize: 13, color: "var(--text-tertiary)" }}>No custom metadata categories yet.</div>
            ) : (
              definitions.map((def, idx) => {
                const isChoice    = isChoiceType(def.data_type);
                const isExpanded  = expandedDefId === def.id;
                const vocabRows   = vocabByDefId[def.id] ?? [];
                const count       = vocabCounts[def.id] ?? 0;
                const isHighlight = def.uuid === newDefUuid;

                return (
                  <div key={def.uuid}>
                    {/* Definition row */}
                    <div
                      onClick={isChoice ? () => toggleExpand(def) : undefined}
                      style={{
                        display: "flex", alignItems: "center", gap: 10, padding: "10px 20px",
                        borderBottom: (!isExpanded && idx < definitions.length - 1) ? "1px solid var(--border-primary)" : "none",
                        background: isHighlight ? "rgba(56,189,248,0.08)" : "transparent",
                        transition: "background 0.6s ease",
                        cursor: isChoice ? "pointer" : "default",
                        userSelect: "none" as const,
                      }}
                      onMouseEnter={isChoice ? e => { if (!isHighlight) e.currentTarget.style.background = "var(--bg-hover)"; } : undefined}
                      onMouseLeave={isChoice ? e => { e.currentTarget.style.background = isHighlight ? "rgba(56,189,248,0.08)" : "transparent"; } : undefined}
                    >
                      {/* Chevron for choice types, spacer for others */}
                      <div style={{ width: 14, flexShrink: 0 }}>
                        {isChoice && <Chevron open={isExpanded} />}
                      </div>
                      <span style={{ flex: 1, fontSize: 13, color: "var(--text-primary)", fontWeight: 500, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
                        {def.name}
                      </span>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                        <span style={{ padding: "2px 7px", borderRadius: 4, fontSize: 11, fontWeight: 600, ...DATA_TYPE_STYLE[def.data_type] }}>
                          {DATA_TYPE_LABELS[def.data_type]}
                        </span>
                        {isChoice && count > 0 && (
                          <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                            {count} {count === 1 ? "value" : "values"}
                          </span>
                        )}
                        {def.is_built_in === 1 && (
                          <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontStyle: "italic" as const }}>(built-in)</span>
                        )}
                      </div>
                    </div>

                    {/* Expanded vocabulary panel */}
                    {isChoice && isExpanded && (
                      <div style={{
                        borderLeft: "3px solid var(--border-primary)",
                        marginLeft: 20,
                        borderBottom: idx < definitions.length - 1 ? "1px solid var(--border-primary)" : "none",
                        background: "var(--bg-secondary)",
                      }}>
                        {/* Vocab rows */}
                        {vocabRows.length === 0 && vocabFormDefId !== def.id && (
                          <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic" as const }}>No values yet.</div>
                        )}
                        {vocabRows.map((v, vi) => (
                          <div key={v.uuid} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", borderBottom: vi < vocabRows.length - 1 || vocabFormDefId === def.id ? "1px solid var(--border-primary)" : "none" }}>
                            <span style={{ flex: 1, fontSize: 13, color: "var(--text-secondary)" }}>{v.value}</span>
                            <button
                              onClick={e => { e.stopPropagation(); removeVocab(def, v); }}
                              title={`Remove "${v.value}"`}
                              style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: "0 2px", flexShrink: 0 }}
                              onMouseEnter={e => (e.currentTarget.style.color = "var(--accent-red)")}
                              onMouseLeave={e => (e.currentTarget.style.color = "var(--text-tertiary)")}
                            >×</button>
                          </div>
                        ))}

                        {/* Vocab add form */}
                        {vocabFormDefId === def.id ? (
                          <div style={{ padding: "10px 16px", display: "flex", flexDirection: "column" as const, gap: 8 }}>
                            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                              <input
                                ref={vocabInputRef}
                                value={vocabFormValue}
                                onChange={e => { setVocabFormValue(e.target.value.slice(0, 50)); setVocabFormError(""); }}
                                onKeyDown={e => { if (e.key === "Enter" && vocabFormValue.trim() && !vocabFormPending) submitVocabForm(def); if (e.key === "Escape") closeVocabForm(); }}
                                placeholder="Value name"
                                style={{ flex: 1, padding: "6px 10px", borderRadius: 0, fontSize: 13, background: "var(--bg-primary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }}
                                maxLength={50}
                              />
                              <button
                                onClick={() => submitVocabForm(def)}
                                disabled={!vocabFormValue.trim() || vocabFormPending}
                                style={{ padding: "6px 14px", borderRadius: 4, fontSize: 12, fontWeight: 700, background: vocabFormValue.trim() ? "var(--accent-blue)" : "var(--bg-tertiary)", color: vocabFormValue.trim() ? "#fff" : "var(--text-tertiary)", border: "none", cursor: vocabFormValue.trim() ? "pointer" : "default", flexShrink: 0, opacity: vocabFormPending ? 0.6 : 1 }}>
                                {vocabFormPending ? "…" : "Add"}
                              </button>
                              <button
                                onClick={closeVocabForm}
                                style={{ padding: "6px 10px", borderRadius: 4, fontSize: 12, fontWeight: 600, background: "var(--bg-tertiary)", color: "var(--text-tertiary)", border: "1px solid var(--border-primary)", cursor: "pointer", flexShrink: 0 }}>
                                Cancel
                              </button>
                            </div>
                            {vocabFormError && (
                              <div style={{ fontSize: 12, color: "var(--accent-red)", padding: "4px 8px", background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 4 }}>
                                {vocabFormError}
                              </div>
                            )}
                          </div>
                        ) : (
                          <button
                            onClick={e => { e.stopPropagation(); openVocabForm(def.id); }}
                            style={{ display: "block", width: "100%", padding: "9px 16px", background: "none", border: "none", textAlign: "left" as const, fontSize: 12, color: "var(--text-tertiary)", cursor: "pointer", fontWeight: 600 }}
                            onMouseEnter={e => { e.currentTarget.style.color = "var(--accent-blue)"; e.currentTarget.style.background = "rgba(56,189,248,0.04)"; }}
                            onMouseLeave={e => { e.currentTarget.style.color = "var(--text-tertiary)"; e.currentTarget.style.background = "none"; }}
                          >
                            + Add value
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

        </div>
      </div>
    </div>
  );
}
