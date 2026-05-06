import { useState, useEffect } from "react";
import { ALL_LIB_COLS, LIB_COL_LABELS, type LibCol, type MetadataDefinition, type MetadataVocabulary } from "../types/metadata";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  visibleColumns: Set<LibCol>;
  onColumnToggle: (col: LibCol) => void;
  stationId: number;
}

const DATA_TYPE_LABELS: Record<MetadataDefinition["data_type"], string> = {
  text:          "Text",
  number:        "Number",
  single_choice: "Select",
  multi_choice:  "Multi-select",
  boolean:       "Toggle",
  date:          "Date",
};

const DATA_TYPE_STYLE: Record<MetadataDefinition["data_type"], { background: string; color: string }> = {
  text:          { background: "rgba(148,163,184,0.12)", color: "#94a3b8" },
  number:        { background: "rgba(56,189,248,0.12)",  color: "#38bdf8" },
  single_choice: { background: "rgba(99,102,241,0.12)",  color: "#818cf8" },
  multi_choice:  { background: "rgba(167,139,250,0.12)", color: "#c084fc" },
  boolean:       { background: "rgba(52,211,153,0.12)",  color: "#34d399" },
  date:          { background: "rgba(251,191,36,0.12)",  color: "#fbbf24" },
};

function Toggle({ on }: { on: boolean }) {
  return (
    <div style={{
      width: 36, height: 20, borderRadius: 10, flexShrink: 0,
      background: on ? "var(--accent-blue)" : "var(--bg-tertiary)",
      border: "1px solid " + (on ? "transparent" : "var(--border-secondary)"),
      position: "relative" as const,
      cursor: "pointer",
    }}>
      <div style={{
        position: "absolute" as const,
        top: 2,
        left: on ? 17 : 2,
        width: 14, height: 14, borderRadius: 7,
        background: on ? "#fff" : "var(--text-tertiary)",
        transition: "left 0.12s ease",
      }} />
    </div>
  );
}

export default function LibraryColumnsPanel({ isOpen, onClose, visibleColumns, onColumnToggle, stationId }: Props) {
  const [definitions, setDefinitions] = useState<MetadataDefinition[]>([]);
  const [vocabCounts, setVocabCounts] = useState<Record<number, number>>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    (async () => {
      try {
        const defs: MetadataDefinition[] = await (window as any).ether.metadataDefinitions.list(stationId) ?? [];
        const active = defs
          .filter(d => !d.deleted_at)
          .sort((a, b) => a.display_order - b.display_order || a.name.localeCompare(b.name));
        setDefinitions(active);

        const vocab: MetadataVocabulary[] = await (window as any).ether.metadataVocabulary.list(stationId) ?? [];
        const counts: Record<number, number> = {};
        for (const v of vocab) {
          if (!v.deleted_at) counts[v.definition_id] = (counts[v.definition_id] ?? 0) + 1;
        }
        setVocabCounts(counts);
      } catch (e) {
        console.error("[LibraryColumnsPanel] load error:", e);
      } finally {
        setLoading(false);
      }
    })();
  }, [isOpen, stationId]);

  if (!isOpen) return null;

  const isChoiceType = (dt: MetadataDefinition["data_type"]) =>
    dt === "single_choice" || dt === "multi_choice";

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 9998, display: "flex", alignItems: "center", justifyContent: "center" }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: "var(--bg-primary)",
        border: "1px solid var(--border-primary)",
        borderRadius: 0,
        width: 560,
        maxWidth: "92vw",
        maxHeight: "80vh",
        display: "flex",
        flexDirection: "column" as const,
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

          {/* Section 1 — Standard Fields */}
          <div style={{ borderBottom: "1px solid var(--border-primary)" }}>
            <div style={{ padding: "12px 20px 10px", background: "var(--bg-secondary)", borderBottom: "1px solid var(--border-primary)" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as const, letterSpacing: "0.08em" }}>Standard Fields</div>
              <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 3 }}>Built-in song attributes — toggle which columns appear in the library table</div>
            </div>
            {ALL_LIB_COLS.map((col, idx) => (
              <div
                key={col}
                onClick={() => onColumnToggle(col)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "11px 20px",
                  borderBottom: idx < ALL_LIB_COLS.length - 1 ? "1px solid var(--border-primary)" : "none",
                  cursor: "pointer",
                  userSelect: "none" as const,
                }}
                onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-hover)")}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
              >
                <span style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 500 }}>{LIB_COL_LABELS[col]}</span>
                <Toggle on={visibleColumns.has(col)} />
              </div>
            ))}
          </div>

          {/* Section 2 — Custom Metadata */}
          <div>
            <div style={{ padding: "12px 20px 10px", background: "var(--bg-secondary)", borderBottom: "1px solid var(--border-primary)" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as const, letterSpacing: "0.08em" }}>Custom Metadata</div>
              <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 3 }}>Metadata categories defined for this station</div>
            </div>
            {loading ? (
              <div style={{ padding: "24px 20px", fontSize: 13, color: "var(--text-tertiary)" }}>Loading...</div>
            ) : definitions.length === 0 ? (
              <div style={{ padding: "24px 20px", fontSize: 13, color: "var(--text-tertiary)" }}>No custom metadata categories yet.</div>
            ) : (
              definitions.map((def, idx) => (
                <div
                  key={def.uuid}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "10px 20px",
                    borderBottom: idx < definitions.length - 1 ? "1px solid var(--border-primary)" : "none",
                  }}
                >
                  <span style={{ flex: 1, fontSize: 13, color: "var(--text-primary)", fontWeight: 500, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
                    {def.name}
                  </span>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                    <span style={{ padding: "2px 7px", borderRadius: 4, fontSize: 11, fontWeight: 600, ...DATA_TYPE_STYLE[def.data_type] }}>
                      {DATA_TYPE_LABELS[def.data_type]}
                    </span>
                    {isChoiceType(def.data_type) && (vocabCounts[def.id] ?? 0) > 0 && (
                      <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                        {vocabCounts[def.id]} {vocabCounts[def.id] === 1 ? "value" : "values"}
                      </span>
                    )}
                    {def.is_built_in === 1 && (
                      <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontStyle: "italic" as const }}>(built-in)</span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

        </div>
      </div>
    </div>
  );
}
