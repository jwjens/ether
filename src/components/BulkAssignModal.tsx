import { useState, useEffect } from "react";
import type { MetadataDefinition, MetadataVocabulary } from "../types/metadata";

interface BulkChange {
  definition_id: number;
  action: "set" | "add" | "clear";
  value_text?: string | null;
  value_vocabulary_id?: number | null;
  value_vocabulary_ids?: number[];
}

type PendingChange =
  | { action: "set"; valueText: string | null; vocabId: number | null }
  | { action: "add"; vocabIds: number[] }
  | { action: "clear" };

interface Props {
  songIds: number[];
  stationId: number;
  onClose: () => void;
  onApplied: () => void;
}

const S = {
  overlay: {
    position: "fixed" as const, inset: 0, zIndex: 9000,
    background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center",
  },
  modal: {
    background: "var(--bg-primary)", border: "1px solid var(--border-primary)",
    width: 640, maxHeight: "82vh", display: "flex", flexDirection: "column" as const,
    boxShadow: "0 8px 40px rgba(0,0,0,0.6)",
  },
  header: {
    padding: "14px 18px 12px", borderBottom: "1px solid var(--border-primary)",
    display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0,
  },
  body: { flex: 1, overflowY: "auto" as const },
  footer: {
    padding: "10px 18px", borderTop: "1px solid var(--border-primary)",
    display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, flexShrink: 0,
  },
  defRow: {
    display: "grid", gridTemplateColumns: "180px 1fr 70px",
    alignItems: "start", gap: 8, padding: "8px 18px",
    borderBottom: "1px solid rgba(255,255,255,0.04)",
  },
  label: { fontSize: 11, color: "var(--text-secondary)", paddingTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const },
  input: {
    width: "100%", padding: "4px 8px", fontSize: 11, background: "var(--bg-secondary)",
    border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", borderRadius: 0,
  },
  clearBtn: (active: boolean) => ({
    fontSize: 10, padding: "3px 8px", borderRadius: 0, cursor: "pointer",
    background: active ? "rgba(239,68,68,0.15)" : "none",
    border: `1px solid ${active ? "rgba(239,68,68,0.4)" : "var(--border-primary)"}`,
    color: active ? "var(--accent-red, #ef4444)" : "var(--text-tertiary)",
  }),
  btn: (bg: string, color = "var(--text-primary)") => ({
    padding: "6px 14px", fontSize: 11, fontWeight: 600, borderRadius: 0, cursor: "pointer",
    background: bg, border: "none", color,
  }),
};

function TextPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <input style={S.input} value={value} onChange={e => onChange(e.target.value)} placeholder="Enter value…" />;
}

function NumberPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <input style={S.input} type="number" value={value} onChange={e => onChange(e.target.value)} placeholder="0" />;
}

function DatePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <input style={{ ...S.input, colorScheme: "dark" }} type="date" value={value} onChange={e => onChange(e.target.value)} />;
}

function BoolPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select style={S.input} value={value} onChange={e => onChange(e.target.value)}>
      <option value="">— pick —</option>
      <option value="true">Yes</option>
      <option value="false">No</option>
    </select>
  );
}

function SingleChoicePicker({ vocabOptions, vocabId, onChange }: {
  vocabOptions: MetadataVocabulary[];
  vocabId: number | null;
  onChange: (id: number | null) => void;
}) {
  return (
    <select style={S.input} value={vocabId ?? ""} onChange={e => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">— pick —</option>
      {vocabOptions.map(v => <option key={v.id} value={v.id}>{v.value}</option>)}
    </select>
  );
}

function MultiChoicePicker({ vocabOptions, selectedIds, onChange }: {
  vocabOptions: MetadataVocabulary[];
  selectedIds: number[];
  onChange: (ids: number[]) => void;
}) {
  const toggle = (id: number) => {
    const next = selectedIds.includes(id) ? selectedIds.filter(x => x !== id) : [...selectedIds, id];
    onChange(next);
  };
  return (
    <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 4, padding: "2px 0" }}>
      {vocabOptions.map(v => {
        const on = selectedIds.includes(v.id);
        return (
          <label key={v.id} style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
            <input type="checkbox" checked={on} onChange={() => toggle(v.id)} style={{ cursor: "pointer" }} />
            <span style={{
              fontSize: 10, fontWeight: 600, padding: "1px 5px", borderRadius: 3,
              background: v.color ?? "#555", color: "#fff", opacity: on ? 1 : 0.45,
            }}>{v.value}</span>
          </label>
        );
      })}
      {vocabOptions.length === 0 && <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>No options defined</span>}
    </div>
  );
}

export default function BulkAssignModal({ songIds, stationId, onClose, onApplied }: Props) {
  const [defs, setDefs] = useState<MetadataDefinition[]>([]);
  const [vocabByDef, setVocabByDef] = useState<Record<number, MetadataVocabulary[]>>({});
  const [pending, setPending] = useState<Map<number, PendingChange>>(new Map());
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const [defsRes, vocabRes] = await Promise.all([
          (window as any).ether.metadataDefinitions.list(stationId),
          (window as any).ether.metadataVocabulary.list(stationId),
        ]);
        const defRows: MetadataDefinition[] = (defsRes?.ok ? (defsRes.rows ?? []) : [])
          .filter((d: MetadataDefinition) => !d.deleted_at)
          .sort((a: MetadataDefinition, b: MetadataDefinition) => a.display_order - b.display_order || a.name.localeCompare(b.name));
        setDefs(defRows);
        const byDef: Record<number, MetadataVocabulary[]> = {};
        for (const v of (vocabRes?.ok ? (vocabRes.rows ?? []) : []).filter((v: any) => !v.deleted_at)) {
          (byDef[v.definition_id] ??= []).push(v);
        }
        for (const arr of Object.values(byDef)) arr.sort((a, b) => a.display_order - b.display_order);
        setVocabByDef(byDef);
      } catch (e) { console.error("[BulkAssignModal] load failed:", e); }
    })();
  }, [stationId]);

  const setChange = (defId: number, ch: PendingChange | null) => {
    setPending(prev => {
      const m = new Map(prev);
      if (ch === null) m.delete(defId); else m.set(defId, ch);
      return m;
    });
  };

  const markClear = (defId: number) => {
    const cur = pending.get(defId);
    if (cur?.action === "clear") setChange(defId, null);
    else setChange(defId, { action: "clear" });
  };

  const apply = async () => {
    if (pending.size === 0) return;
    setApplying(true);
    setError("");
    try {
      const changes: BulkChange[] = [];
      for (const [defId, ch] of pending) {
        if (ch.action === "clear") {
          changes.push({ definition_id: defId, action: "clear" });
        } else if (ch.action === "set") {
          changes.push({
            definition_id:      defId,
            action:             "set",
            value_text:         ch.valueText,
            value_vocabulary_id: ch.vocabId,
          });
        } else if (ch.action === "add") {
          if (ch.vocabIds.length === 0) continue;
          changes.push({ definition_id: defId, action: "add", value_vocabulary_ids: ch.vocabIds });
        }
      }
      if (changes.length === 0) { setApplying(false); return; }
      const res = await (window as any).ether.songMetadataValues.bulkApply({ song_ids: songIds, changes, station_id: stationId });
      if (!res?.ok) throw new Error(res?.error ?? "Unknown error");
      onApplied();
    } catch (e: any) {
      setError(e.message ?? String(e));
      setApplying(false);
    }
  };

  const changeCount = pending.size;

  return (
    <div style={S.overlay} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={S.modal}>
        {/* Header */}
        <div style={S.header}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)", letterSpacing: "-0.01em" }}>
            Bulk assign metadata to {songIds.length} song{songIds.length !== 1 ? "s" : ""}
          </span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 16, lineHeight: 1 }}>✕</button>
        </div>

        {/* Column headings */}
        <div style={{ ...S.defRow, borderBottom: "1px solid var(--border-primary)", background: "var(--bg-secondary)" }}>
          <span style={{ fontSize: 9, fontWeight: 700, color: "var(--text-tertiary)", letterSpacing: "0.08em", textTransform: "uppercase" as const }}>Definition</span>
          <span style={{ fontSize: 9, fontWeight: 700, color: "var(--text-tertiary)", letterSpacing: "0.08em", textTransform: "uppercase" as const }}>Value</span>
          <span style={{ fontSize: 9, fontWeight: 700, color: "var(--text-tertiary)", letterSpacing: "0.08em", textTransform: "uppercase" as const }}>Clear</span>
        </div>

        {/* Definition rows */}
        <div style={S.body}>
          {defs.length === 0 && (
            <div style={{ padding: "24px 18px", fontSize: 12, color: "var(--text-tertiary)" }}>Loading definitions…</div>
          )}
          {defs.map(def => {
            const ch = pending.get(def.id);
            const isClearing = ch?.action === "clear";
            const vocab = vocabByDef[def.id] ?? [];

            let picker: React.ReactNode = null;
            if (!isClearing) {
              if (def.data_type === "text") {
                const v = ch?.action === "set" ? (ch.valueText ?? "") : "";
                picker = <TextPicker value={v} onChange={s => setChange(def.id, { action: "set", valueText: s || null, vocabId: null })} />;
              } else if (def.data_type === "number") {
                const v = ch?.action === "set" ? (ch.valueText ?? "") : "";
                picker = <NumberPicker value={v} onChange={s => setChange(def.id, { action: "set", valueText: s || null, vocabId: null })} />;
              } else if (def.data_type === "date") {
                const v = ch?.action === "set" ? (ch.valueText ?? "") : "";
                picker = <DatePicker value={v} onChange={s => setChange(def.id, { action: "set", valueText: s || null, vocabId: null })} />;
              } else if (def.data_type === "boolean") {
                const v = ch?.action === "set" ? (ch.valueText ?? "") : "";
                picker = <BoolPicker value={v} onChange={s => setChange(def.id, { action: "set", valueText: s || null, vocabId: null })} />;
              } else if (def.data_type === "single_choice") {
                const vid = ch?.action === "set" ? ch.vocabId : null;
                picker = <SingleChoicePicker vocabOptions={vocab} vocabId={vid ?? null} onChange={id => {
                  if (id === null) setChange(def.id, null);
                  else setChange(def.id, { action: "set", valueText: null, vocabId: id });
                }} />;
              } else if (def.data_type === "multi_choice") {
                const ids = ch?.action === "add" ? ch.vocabIds : [];
                picker = <MultiChoicePicker vocabOptions={vocab} selectedIds={ids} onChange={ids => {
                  if (ids.length === 0) setChange(def.id, null);
                  else setChange(def.id, { action: "add", vocabIds: ids });
                }} />;
              }
            }

            const hasPending = !!ch;
            return (
              <div key={def.id} style={{
                ...S.defRow,
                background: hasPending ? "rgba(96,64,192,0.06)" : "transparent",
              }}>
                <span style={S.label} title={def.name}>{def.name}</span>
                <div>{isClearing
                  ? <span style={{ fontSize: 10, color: "var(--text-tertiary)", fontStyle: "italic" }}>will clear all values</span>
                  : picker
                }</div>
                <div style={{ display: "flex", justifyContent: "center" }}>
                  <button
                    style={S.clearBtn(isClearing) as React.CSSProperties}
                    onClick={() => markClear(def.id)}
                    title={isClearing ? "Cancel clear" : "Clear all values for this definition"}
                  >
                    {isClearing ? "Undo" : "Clear"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div style={S.footer}>
          {error && <span style={{ fontSize: 11, color: "var(--accent-red, #ef4444)", flex: 1 }}>{error}</span>}
          <button onClick={onClose} style={{ ...S.btn("var(--bg-secondary)"), border: "1px solid var(--border-primary)" }}>Cancel</button>
          <button
            onClick={apply}
            disabled={changeCount === 0 || applying}
            style={{ ...S.btn("var(--accent-purple, #6040c0)", "#fff"), opacity: changeCount === 0 || applying ? 0.45 : 1, cursor: changeCount === 0 ? "not-allowed" : "pointer" }}
          >
            {applying ? "Applying…" : `Apply (${changeCount} change${changeCount !== 1 ? "s" : ""})`}
          </button>
        </div>
      </div>
    </div>
  );
}
