import { useState, useEffect, useRef } from "react";
import { queryScoped } from "../db/stationScoped";
import { useActiveStation } from "../hooks/useActiveStation";

interface Clock { id: number; name: string; description: string | null; color: string | null; }
interface Category { id: number; code: string; name: string; color: string | null; priority: number; }

interface SlotRow {
  _id: number;        // positive = real DB id, negative = unsaved new row
  clock_id: number;
  position: number;
  slot_type: string;
  category_id: number | null;
  label: string | null;
  duration_min: number;
  category_code?: string;
  category_color?: string | null;
}

const SLOT_TYPES = [
  { value: "music",      label: "Song",    color: "#38bdf8" },
  { value: "spot_break", label: "Spot",    color: "#ef4444" },
  { value: "talk_break", label: "Talk",    color: "#a78bfa" },
  { value: "liner",      label: "Liner",   color: "#34d399" },
  { value: "sweeper",    label: "Sweeper", color: "#f59e0b" },
];

function fmtMSS(minutes: number): string {
  const totalSec = Math.round(minutes * 60);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Accepts "M:SS" or a bare number (treated as seconds)
function parseMSS(str: string): number | null {
  const trimmed = str.trim();
  const colon = trimmed.match(/^(\d+):(\d{1,2})$/);
  if (colon) return (parseInt(colon[1]) * 60 + parseInt(colon[2])) / 60;
  const n = parseFloat(trimmed);
  if (!isNaN(n) && n > 0) return n / 60; // bare number = seconds
  return null;
}

let _tmpCounter = -1;
function nextTmpId() { return _tmpCounter--; }

type EditCell = { slotId: number; field: "type" | "cat" | "runtime" } | null;

export default function ClocksV2() {
  const { stationId, isReady } = useActiveStation();

  const [clocks, setClocks]       = useState<Clock[]>([]);
  const [search, setSearch]       = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [slots, setSlots]         = useState<SlotRow[]>([]);
  const [deletedIds, setDeletedIds] = useState<Set<number>>(new Set());
  const [isDirty, setIsDirty]     = useState(false);
  const [cats, setCats]           = useState<Category[]>([]);
  const [editCell, setEditCell]   = useState<EditCell>(null);
  const [dragIdx, setDragIdx]     = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [saving, setSaving]       = useState(false);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newClockName, setNewClockName] = useState("");
  const newNameRef = useRef<HTMLInputElement>(null);

  // ── Load ────────────────────────────────────────────────────────
  const loadClocks = async () => {
    if (!isReady) return;
    setClocks(await queryScoped<Clock>(
      "SELECT * FROM clocks WHERE deleted_at IS NULL ORDER BY name", [], stationId
    ));
  };

  const loadCats = async () => {
    if (!isReady) return;
    setCats(await queryScoped<Category>(
      "SELECT * FROM categories ORDER BY priority, code", [], stationId
    ));
  };

  const loadSlots = async (clockId: number) => {
    const rows = await queryScoped<SlotRow & { id: number }>(
      `SELECT cs.*, c.code as category_code, c.color as category_color
       FROM clock_slots cs LEFT JOIN categories c ON c.id = cs.category_id
       WHERE cs.clock_id = ? AND cs.station_id = ? AND cs.deleted_at IS NULL ORDER BY cs.position`,
      [clockId, stationId], stationId, { skipScoping: true }
    );
    setSlots(rows.map(r => ({ ...r, _id: r.id })));
    setDeletedIds(new Set());
    setIsDirty(false);
  };

  useEffect(() => { if (isReady) { loadClocks(); loadCats(); } }, [isReady]);

  useEffect(() => {
    if (selectedId) { loadSlots(selectedId); }
    else { setSlots([]); setDeletedIds(new Set()); setIsDirty(false); }
  }, [selectedId]);

  // Close any open edit cell when clicking outside
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target as Element).closest("[data-v2cell]")) setEditCell(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  // ── Local slot mutation helpers ──────────────────────────────────
  const patchSlot = (id: number, patch: Partial<SlotRow>) => {
    setSlots(s => s.map(r => r._id === id ? { ...r, ...patch } : r));
    setIsDirty(true);
  };

  const changeType = (id: number, type: string) => {
    const isMusicNow = type === "music";
    patchSlot(id, {
      slot_type: type,
      category_id: isMusicNow ? slots.find(r => r._id === id)?.category_id ?? null : null,
      label: isMusicNow ? null : SLOT_TYPES.find(o => o.value === type)?.label ?? null,
      category_code: isMusicNow ? slots.find(r => r._id === id)?.category_code : undefined,
      category_color: isMusicNow ? slots.find(r => r._id === id)?.category_color : null,
    });
  };

  const changeCat = (id: number, catId: number | null) => {
    const cat = cats.find(c => c.id === catId);
    patchSlot(id, {
      category_id: catId,
      label: cat?.name ?? null,
      category_code: cat?.code,
      category_color: cat?.color ?? null,
    });
  };

  // ── Add / delete ─────────────────────────────────────────────────
  const addSlot = () => {
    if (!selectedId) return;
    const firstCat = cats[0];
    setSlots(s => [...s, {
      _id: nextTmpId(),
      clock_id: selectedId,
      position: s.length,
      slot_type: "music",
      category_id: firstCat?.id ?? null,
      label: firstCat?.name ?? null,
      duration_min: 3.5,
      category_code: firstCat?.code,
      category_color: firstCat?.color ?? null,
    }]);
    setIsDirty(true);
  };

  const deleteSlot = (id: number) => {
    setSlots(s => s.filter(r => r._id !== id));
    if (id > 0) setDeletedIds(prev => new Set([...prev, id]));
    setIsDirty(true);
  };

  // ── Drag-drop reorder ────────────────────────────────────────────
  const handleDrop = (toIdx: number) => {
    if (dragIdx === null || dragIdx === toIdx) { setDragIdx(null); setDragOverIdx(null); return; }
    const reordered = [...slots];
    const [moved] = reordered.splice(dragIdx, 1);
    reordered.splice(toIdx, 0, moved);
    setSlots(reordered);
    setDragIdx(null); setDragOverIdx(null);
    setIsDirty(true);
  };

  // ── Save ──────────────────────────────────────────────────────────
  const save = async () => {
    if (!selectedId || saving) return;
    setSaving(true);
    try {
      for (const id of deletedIds) {
        await (window as any).ether.clockSlots.deleteById(id);
      }
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        const payload = {
          clock_id: selectedId, position: i,
          slot_type: s.slot_type, category_id: s.category_id,
          label: s.label, duration_min: s.duration_min,
        };
        if (s._id > 0) {
          await (window as any).ether.clockSlots.updateById(s._id, payload);
        } else {
          await (window as any).ether.clockSlots.create({ ...payload, station_id: stationId });
        }
      }
      await loadSlots(selectedId);
    } catch (e) {
      console.error("ClocksV2 save failed:", e);
    }
    setSaving(false);
  };

  // ── Create clock ─────────────────────────────────────────────────
  const createClock = async () => {
    if (!newClockName.trim()) return;
    const res = await (window as any).ether.clocks.create({ station_id: stationId, name: newClockName.trim() });
    setNewClockName(""); setShowNewForm(false);
    await loadClocks();
    setSelectedId(res.row.id);
  };

  // ── Derived ───────────────────────────────────────────────────────
  const filteredClocks = search.trim()
    ? clocks.filter(c => c.name.toLowerCase().includes(search.toLowerCase()))
    : clocks;

  const positions: number[] = [];
  let cumMin = 0;
  slots.forEach(s => { positions.push(cumMin); cumMin += s.duration_min; });
  const totalMin = cumMin;
  const remaining = Math.max(0, 60 - totalMin);
  const overrun = totalMin > 60;

  const slotColor = (s: SlotRow) => {
    if (s.slot_type === "music") return (s.category_color as string | null) || "#38bdf8";
    return SLOT_TYPES.find(o => o.value === s.slot_type)?.color ?? "#94a3b8";
  };

  const typeLabel = (s: SlotRow) =>
    SLOT_TYPES.find(o => o.value === s.slot_type)?.label ?? s.slot_type;

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div style={{ fontFamily: "'Inter', system-ui, sans-serif", display: "flex", flexDirection: "column" as const, gap: 0 }}>

      {/* Page header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 800, color: "var(--text-primary)", margin: 0, fontFamily: "'Syne', sans-serif", letterSpacing: "-0.03em" }}>
            Clocks{" "}
            <span style={{ fontSize: 9, fontWeight: 800, padding: "2px 6px", borderRadius: 3, background: "rgba(251,191,36,0.15)", color: "#fbbf24", letterSpacing: "0.1em", verticalAlign: "middle" }}>
              BETA
            </span>
          </h2>
          <p style={{ fontSize: 11, color: "var(--text-tertiary)", margin: "3px 0 0" }}>
            Zetta-style grid — double-click any cell to edit
          </p>
        </div>
        <button
          onClick={save}
          disabled={!isDirty || saving}
          style={{
            padding: "7px 20px", fontSize: 12, fontWeight: 700, borderRadius: 0,
            cursor: isDirty && !saving ? "pointer" : "default",
            background: isDirty ? "var(--accent-blue)" : "var(--bg-secondary)",
            color: isDirty ? "#fff" : "var(--text-tertiary)",
            border: isDirty ? "none" : "1px solid var(--border-primary)",
            opacity: saving ? 0.6 : 1, transition: "all 0.15s",
            boxShadow: isDirty ? "0 2px 8px rgba(56,189,248,0.3)" : "none",
          }}
        >
          {saving ? "Saving…" : isDirty ? "Save" : "Saved ✓"}
        </button>
      </div>

      <div style={{ display: "flex", gap: 16 }}>

        {/* ── Left panel — clock list ──────────────────────────────── */}
        <div style={{ width: 232, flexShrink: 0, display: "flex", flexDirection: "column" as const, gap: 6 }}>

          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search clocks…"
            style={{
              padding: "7px 10px", fontSize: 12, borderRadius: 0, outline: "none",
              background: "var(--bg-secondary)", border: "1px solid var(--border-primary)",
              color: "var(--text-primary)", width: "100%", boxSizing: "border-box" as const,
            }}
          />

          <div style={{ display: "flex", flexDirection: "column" as const, gap: 3, overflowY: "auto", maxHeight: 480 }}>
            {filteredClocks.map(c => (
              <button key={c.id} onClick={() => setSelectedId(c.id)}
                style={{
                  width: "100%", padding: "8px 10px", borderRadius: 0, fontSize: 12,
                  textAlign: "left" as const, cursor: "pointer", boxSizing: "border-box" as const,
                  fontWeight: selectedId === c.id ? 700 : 400,
                  background: selectedId === c.id ? "rgba(56,189,248,0.12)" : "var(--bg-secondary)",
                  border: selectedId === c.id ? "1px solid rgba(56,189,248,0.3)" : "1px solid var(--border-primary)",
                  color: selectedId === c.id ? "var(--accent-blue)" : "var(--text-secondary)",
                }}
              >{c.name}</button>
            ))}
            {filteredClocks.length === 0 && (
              <div style={{ fontSize: 11, color: "var(--text-tertiary)", fontStyle: "italic", padding: "6px 4px" }}>
                {search ? "No matches" : "No clocks yet"}
              </div>
            )}
          </div>

          {showNewForm ? (
            <div style={{ display: "flex", gap: 4 }}>
              <input
                ref={newNameRef}
                value={newClockName}
                onChange={e => setNewClockName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter") createClock();
                  if (e.key === "Escape") { setShowNewForm(false); setNewClockName(""); }
                }}
                placeholder="Clock name…"
                autoFocus
                style={{
                  flex: 1, padding: "6px 8px", fontSize: 11, borderRadius: 0, outline: "none",
                  background: "var(--bg-secondary)", border: "1px solid var(--accent-blue)",
                  color: "var(--text-primary)", minWidth: 0, boxSizing: "border-box" as const,
                }}
              />
              <button onClick={createClock}
                style={{ padding: "6px 10px", fontSize: 11, fontWeight: 700, borderRadius: 0, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer" }}
              >OK</button>
            </div>
          ) : (
            <button
              onClick={() => { setShowNewForm(true); setTimeout(() => newNameRef.current?.focus(), 40); }}
              style={{
                width: "100%", padding: "7px", fontSize: 11, fontWeight: 700, borderRadius: 0,
                background: "var(--bg-secondary)", border: "1px dashed var(--border-secondary)",
                color: "var(--text-tertiary)", cursor: "pointer",
              }}
            >+ New Clock</button>
          )}
        </div>

        {/* ── Center panel — grid ──────────────────────────────────── */}
        {selectedId ? (
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" as const, gap: 8 }}>

            {/* Progress bar */}
            <div style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "7px 12px", background: "var(--bg-secondary)", border: "1px solid var(--border-primary)",
            }}>
              <div style={{ flex: 1, height: 5, background: "var(--bg-tertiary)", overflow: "hidden" }}>
                <div style={{
                  height: "100%", borderRadius: 0, transition: "width 0.2s",
                  width: Math.min(totalMin / 60 * 100, 100) + "%",
                  background: overrun ? "#ef4444" : totalMin >= 55 ? "#34d399" : "var(--accent-blue)",
                }} />
              </div>
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-primary)", fontFamily: "'DM Mono', monospace", whiteSpace: "nowrap" as const }}>
                {totalMin.toFixed(1)} / 60 min
              </span>
              <span style={{ fontSize: 10, whiteSpace: "nowrap" as const, color: overrun ? "#ef4444" : remaining < 1 ? "#34d399" : "var(--text-tertiary)" }}>
                {overrun
                  ? `+${(totalMin - 60).toFixed(1)}m over`
                  : remaining < 0.1 ? "Hour full ✓" : remaining.toFixed(1) + "m left"}
              </span>
            </div>

            {/* Grid */}
            <div style={{ border: "1px solid var(--border-primary)", overflow: "hidden" }}>

              {/* Headers */}
              <div style={{
                display: "grid",
                gridTemplateColumns: "32px 60px 80px 1fr 64px 22px 22px",
                padding: "5px 10px", background: "var(--bg-tertiary)",
                borderBottom: "1px solid var(--border-primary)",
                fontSize: 9, fontWeight: 800, letterSpacing: "0.1em",
                color: "var(--text-secondary)", textTransform: "uppercase" as const,
              }}>
                <span>#</span>
                <span>AIRTIME</span>
                <span>TYPE</span>
                <span>CATEGORY</span>
                <span style={{ textAlign: "right" as const }}>RUNTIME</span>
                <span></span><span></span>
              </div>

              {/* Rows */}
              <div style={{ maxHeight: 460, overflowY: "auto" as const }}>
                {slots.map((s, i) => {
                  const color = slotColor(s);
                  const isET  = editCell?.slotId === s._id && editCell.field === "type";
                  const isEC  = editCell?.slotId === s._id && editCell.field === "cat";
                  const isER  = editCell?.slotId === s._id && editCell.field === "runtime";

                  return (
                    <div
                      key={s._id}
                      draggable
                      onDragStart={e => { e.dataTransfer.effectAllowed = "move"; setDragIdx(i); }}
                      onDragOver={e => { e.preventDefault(); setDragOverIdx(i); }}
                      onDragEnter={e => e.preventDefault()}
                      onDrop={e => { e.preventDefault(); handleDrop(i); }}
                      onDragEnd={() => { setDragIdx(null); setDragOverIdx(null); }}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "32px 60px 80px 1fr 64px 22px 22px",
                        padding: "0 10px", minHeight: 34, alignItems: "center",
                        cursor: "grab",
                        background: dragOverIdx === i
                          ? "rgba(56,189,248,0.07)"
                          : i % 2 === 0 ? "var(--bg-secondary)" : "rgba(255,255,255,0.012)",
                        borderBottom: "1px solid rgba(255,255,255,0.03)",
                        borderLeft: `3px solid ${color}`,
                        opacity: dragIdx === i ? 0.35 : 1,
                        transition: "background 0.08s",
                      }}
                    >
                      {/* Row # */}
                      <span style={{ fontSize: 10, color: "var(--text-tertiary)", fontWeight: 600 }}>
                        {i + 1}
                      </span>

                      {/* Airtime */}
                      <span style={{ fontSize: 10, fontFamily: "'DM Mono', monospace", color: "var(--text-secondary)", letterSpacing: "0.02em" }}>
                        {fmtMSS(positions[i])}
                      </span>

                      {/* Type */}
                      <div data-v2cell="1" style={{ paddingRight: 8 }}>
                        {isET ? (
                          <select
                            autoFocus
                            value={s.slot_type}
                            onChange={e => { changeType(s._id, e.target.value); setEditCell(null); }}
                            onBlur={() => setEditCell(null)}
                            onClick={e => e.stopPropagation()}
                            style={{ fontSize: 11, width: "100%", background: "var(--bg-tertiary)", border: "1px solid var(--accent-blue)", color: "var(--text-primary)", outline: "none", padding: "2px 4px" }}
                          >
                            {SLOT_TYPES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        ) : (
                          <span
                            onDoubleClick={() => setEditCell({ slotId: s._id, field: "type" })}
                            title="Double-click to edit"
                            style={{
                              display: "inline-block", fontSize: 10, fontWeight: 800,
                              letterSpacing: "0.07em", padding: "2px 5px",
                              background: color + "20", color, cursor: "text", userSelect: "none" as const,
                            }}
                          >{typeLabel(s)}</span>
                        )}
                      </div>

                      {/* Category */}
                      <div data-v2cell="1" style={{ paddingRight: 8, overflow: "hidden" }}>
                        {s.slot_type === "music" ? (
                          isEC ? (
                            <select
                              autoFocus
                              value={s.category_id ?? ""}
                              onChange={e => { changeCat(s._id, e.target.value ? Number(e.target.value) : null); setEditCell(null); }}
                              onBlur={() => setEditCell(null)}
                              onClick={e => e.stopPropagation()}
                              style={{ fontSize: 11, width: "100%", background: "var(--bg-tertiary)", border: "1px solid var(--accent-blue)", color: "var(--text-primary)", outline: "none", padding: "2px 4px" }}
                            >
                              <option value="">— none —</option>
                              {cats.map(c => (
                                <option key={c.id} value={c.id}>{c.code}{c.name ? ` — ${c.name}` : ""}</option>
                              ))}
                            </select>
                          ) : (
                            <span
                              onDoubleClick={() => setEditCell({ slotId: s._id, field: "cat" })}
                              title="Double-click to edit"
                              style={{
                                fontSize: 11, cursor: "text", userSelect: "none" as const,
                                color: (s.category_color as string | null) || "var(--text-secondary)",
                                display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const,
                              }}
                            >{s.category_code ?? "—"}</span>
                          )
                        ) : (
                          <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>—</span>
                        )}
                      </div>

                      {/* Runtime */}
                      <div data-v2cell="1" style={{ textAlign: "right" as const }}>
                        {isER ? (
                          <input
                            autoFocus
                            defaultValue={fmtMSS(s.duration_min)}
                            onBlur={e => {
                              const val = parseMSS(e.target.value);
                              if (val !== null) patchSlot(s._id, { duration_min: val });
                              setEditCell(null);
                            }}
                            onKeyDown={e => {
                              if (e.key === "Enter")  e.currentTarget.blur();
                              if (e.key === "Escape") setEditCell(null);
                              if (e.key === "Tab")    { e.preventDefault(); e.currentTarget.blur(); }
                            }}
                            onClick={e => e.stopPropagation()}
                            style={{
                              width: 54, padding: "2px 5px", fontSize: 11, textAlign: "right" as const,
                              fontFamily: "'DM Mono', monospace", fontWeight: 700, borderRadius: 0,
                              background: "var(--bg-tertiary)", border: "1px solid var(--accent-blue)",
                              color: "var(--text-primary)", outline: "none",
                            }}
                          />
                        ) : (
                          <span
                            onDoubleClick={() => setEditCell({ slotId: s._id, field: "runtime" })}
                            title="Double-click to edit"
                            style={{ fontSize: 11, fontFamily: "'DM Mono', monospace", fontWeight: 600, color: "var(--text-secondary)", cursor: "text", userSelect: "none" as const }}
                          >{fmtMSS(s.duration_min)}</span>
                        )}
                      </div>

                      {/* Drag grip */}
                      <svg width="8" height="10" viewBox="0 0 8 10" fill="var(--text-tertiary)"
                        style={{ opacity: 0.32, cursor: "grab", flexShrink: 0 }}>
                        <circle cx="2" cy="2" r="1.1"/><circle cx="6" cy="2" r="1.1"/>
                        <circle cx="2" cy="5" r="1.1"/><circle cx="6" cy="5" r="1.1"/>
                        <circle cx="2" cy="8" r="1.1"/><circle cx="6" cy="8" r="1.1"/>
                      </svg>

                      {/* Delete */}
                      <button
                        onClick={() => deleteSlot(s._id)}
                        style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 12, padding: "2px 3px" }}
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "#ef4444"; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}
                      >✕</button>
                    </div>
                  );
                })}

                {slots.length === 0 && (
                  <div style={{ padding: "32px 16px", textAlign: "center" as const, color: "var(--text-tertiary)", fontSize: 12, fontStyle: "italic" }}>
                    Empty clock — click "+ Add Slot" below to start building your hour
                  </div>
                )}
              </div>

              {/* Footer summary */}
              {slots.length > 0 && (
                <div style={{
                  display: "grid",
                  gridTemplateColumns: "32px 60px 80px 1fr 64px 22px 22px",
                  padding: "5px 10px", background: "var(--bg-tertiary)",
                  borderTop: "1px solid var(--border-primary)",
                  fontSize: 9, fontWeight: 700, fontFamily: "'DM Mono', monospace",
                  color: overrun ? "#ef4444" : "#34d399",
                }}>
                  <span></span>
                  <span>{fmtMSS(totalMin)}</span>
                  <span></span>
                  <span style={{ color: "var(--text-tertiary)", fontFamily: "'Inter', sans-serif", fontWeight: 400, fontSize: 10 }}>
                    {overrun
                      ? `⚠ ${(totalMin - 60).toFixed(1)}m over — remove slots`
                      : remaining < 0.1 ? "✓ Hour complete" : `${remaining.toFixed(1)} min remaining`}
                  </span>
                  <span style={{ textAlign: "right" as const }}>{totalMin.toFixed(1)}m</span>
                  <span></span><span></span>
                </div>
              )}
            </div>

            {/* Add slot */}
            <button
              onClick={addSlot}
              style={{
                width: "100%", padding: "8px", fontSize: 12, fontWeight: 700, borderRadius: 0,
                background: "var(--bg-secondary)", border: "1px dashed var(--border-secondary)",
                color: "var(--text-tertiary)", cursor: "pointer",
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = "var(--accent-blue)"; (e.currentTarget as HTMLElement).style.color = "var(--accent-blue)"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "var(--border-secondary)"; (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}
            >+ Add Slot</button>
          </div>
        ) : (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-tertiary)", fontSize: 12, fontStyle: "italic" }}>
            Select a clock from the list, or create a new one
          </div>
        )}
      </div>
    </div>
  );
}
