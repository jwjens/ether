// src/components/ClockEditor.tsx
//
// Ether Clock Editor
//
// The music director builds a format clock by dragging slot types
// onto a visual hour timeline. Each slot has a type (song category,
// break, news, sweeper) and a duration. The clock auto-fills 60 minutes.
//
// Clocks are saved to SQLite and read by:
//   • VoiceTracker (break slots)
//   • Automation engine (sequence order)
//   • Production Editor right-click "Send to break library"

import { useCallback, useEffect, useRef, useState } from "react";
import { query, execute } from "../db/client";

// ── Types ──────────────────────────────────────────────────────

type SlotType =
  | "song-a"   // Power rotation
  | "song-b"   // Current
  | "song-c"   // Recurrent
  | "song-d"   // Gold
  | "song-x"   // Custom category
  | "break"    // Jock break — voice track required
  | "spot"     // Spot set — commercials
  | "news"     // News / weather
  | "sweeper"  // Station ID / imaging only
  | "liner"    // Liner / phone cue
  | "open";    // Open / TBD

interface ClockSlot {
  id: string;
  type: SlotType;
  label: string;
  durationSec: number;   // 0 = flexible (fills remaining time)
  requiresVoiceTrack: boolean;
  notes: string;
}

interface Clock {
  id: number | null;
  name: string;
  daypart: string;
  slots: ClockSlot[];
}

// ── Slot metadata ──────────────────────────────────────────────

const SLOT_META: Record<SlotType, {
  label: string;
  color: string;
  bg: string;
  border: string;
  defaultDuration: number;
  icon: string;
}> = {
  "song-a":  { label: "Power A",   color: "#38bdf8", bg: "rgba(56,189,248,0.15)",  border: "rgba(56,189,248,0.4)",  defaultDuration: 210, icon: "A" },
  "song-b":  { label: "Current B", color: "#34d399", bg: "rgba(52,211,153,0.15)",  border: "rgba(52,211,153,0.4)",  defaultDuration: 210, icon: "B" },
  "song-c":  { label: "Recurrent", color: "#a78bfa", bg: "rgba(167,139,250,0.15)", border: "rgba(167,139,250,0.4)", defaultDuration: 210, icon: "C" },
  "song-d":  { label: "Gold",      color: "#fb923c", bg: "rgba(251,146,60,0.15)",  border: "rgba(251,146,60,0.4)",  defaultDuration: 210, icon: "D" },
  "song-x":  { label: "Custom",    color: "#e879f9", bg: "rgba(232,121,249,0.15)", border: "rgba(232,121,249,0.4)", defaultDuration: 210, icon: "X" },
  "break":   { label: "Jock Break",color: "#f87171", bg: "rgba(248,113,113,0.18)", border: "rgba(248,113,113,0.5)", defaultDuration: 90,  icon: "🎙" },
  "spot":    { label: "Spot Set",  color: "#fbbf24", bg: "rgba(251,191,36,0.15)",  border: "rgba(251,191,36,0.4)",  defaultDuration: 120, icon: "₿" },
  "news":    { label: "News",      color: "#60a5fa", bg: "rgba(96,165,250,0.15)",  border: "rgba(96,165,250,0.4)",  defaultDuration: 120, icon: "📰" },
  "sweeper": { label: "Sweeper",   color: "#94a3b8", bg: "rgba(148,163,184,0.15)", border: "rgba(148,163,184,0.4)", defaultDuration: 10,  icon: "≋" },
  "liner":   { label: "Liner",     color: "#c4b5fd", bg: "rgba(196,181,253,0.12)", border: "rgba(196,181,253,0.3)", defaultDuration: 15,  icon: "▸" },
  "open":    { label: "Open",      color: "#4b5563", bg: "rgba(75,85,99,0.12)",    border: "rgba(75,85,99,0.25)",   defaultDuration: 60,  icon: "○" },
};

const DAYPARTS = [
  "Morning Drive", "Mid-Morning", "Midday", "Afternoon Drive",
  "Evening", "Night", "Overnight", "Weekend", "Custom",
];

// ── Helpers ────────────────────────────────────────────────────

let slotSeq = 0;
const newSlotId = () => `slot_${++slotSeq}`;

function fmtSec(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0 ? `${m}:00` : `${m}:${String(s).padStart(2, "0")}`;
}

function totalSec(slots: ClockSlot[]): number {
  return slots.reduce((s, sl) => s + sl.durationSec, 0);
}

const HOUR_SEC = 3600;

// ── ClockEditor ────────────────────────────────────────────────

interface Props {
  clockId?: number | null;
  onSave?: (clock: Clock) => void;
  onClose?: () => void;
}

export default function ClockEditor({ clockId, onSave, onClose }: Props) {
  const [clock, setClock] = useState<Clock>({
    id: null,
    name: "New Clock",
    daypart: "Morning Drive",
    slots: [],
  });

  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);
  const [draggingType, setDraggingType] = useState<SlotType | null>(null);
  const [draggingSlotId, setDraggingSlotId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [clocks, setClocks] = useState<{ id: number; name: string; daypart: string }[]>([]);

  const timelineRef = useRef<HTMLDivElement>(null);

  // ── Load existing clocks ──────────────────────────────────────

  useEffect(() => {
    const load = async () => {
      try {
        const rows = await query<{ id: number; name: string; daypart: string; slots_json: string }>(
          "SELECT id, name, daypart, slots_json FROM format_clocks ORDER BY daypart, name"
        );
        setClocks(rows.map(r => ({ id: r.id, name: r.name, daypart: r.daypart })));
        if (clockId) {
          const row = rows.find(r => r.id === clockId);
          if (row) {
            setClock({
              id: row.id,
              name: row.name,
              daypart: row.daypart,
              slots: JSON.parse(row.slots_json || "[]"),
            });
          }
        }
      } catch {
        // Table may not exist yet — create it
        await execute(`CREATE TABLE IF NOT EXISTS format_clocks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          daypart TEXT NOT NULL DEFAULT 'Morning Drive',
          slots_json TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER DEFAULT (strftime('%s','now'))
        )`);
      }
    };
    load();
  }, [clockId]);

  // ── Save clock ────────────────────────────────────────────────

  const saveClock = async () => {
    setSaving(true);
    try {
      const json = JSON.stringify(clock.slots);
      if (clock.id) {
        await execute(
          "UPDATE format_clocks SET name=?, daypart=?, slots_json=? WHERE id=?",
          [clock.name, clock.daypart, json, clock.id]
        );
      } else {
        await execute(
          "INSERT INTO format_clocks (name, daypart, slots_json) VALUES (?,?,?)",
          [clock.name, clock.daypart, json]
        );
      }
      setStatus("✓ Clock saved");
      onSave?.(clock);
    } catch (e) {
      setStatus(`✗ Save failed: ${e}`);
    }
    setSaving(false);
  };

  // ── Slot operations ───────────────────────────────────────────

  const addSlot = useCallback((type: SlotType, atIndex?: number) => {
    const meta = SLOT_META[type];
    const newSlot: ClockSlot = {
      id: newSlotId(),
      type,
      label: meta.label,
      durationSec: meta.defaultDuration,
      requiresVoiceTrack: type === "break",
      notes: "",
    };
    setClock(prev => {
      const slots = [...prev.slots];
      if (atIndex !== undefined) slots.splice(atIndex, 0, newSlot);
      else slots.push(newSlot);
      return { ...prev, slots };
    });
    setSelectedSlotId(newSlot.id);
  }, []);

  const removeSlot = useCallback((id: string) => {
    setClock(prev => ({ ...prev, slots: prev.slots.filter(s => s.id !== id) }));
    setSelectedSlotId(null);
  }, []);

  const updateSlot = useCallback((id: string, patch: Partial<ClockSlot>) => {
    setClock(prev => ({
      ...prev,
      slots: prev.slots.map(s => s.id === id ? { ...s, ...patch } : s),
    }));
  }, []);

  const moveSlot = useCallback((fromIdx: number, toIdx: number) => {
    setClock(prev => {
      const slots = [...prev.slots];
      const [moved] = slots.splice(fromIdx, 1);
      slots.splice(toIdx, 0, moved);
      return { ...prev, slots };
    });
  }, []);

  // ── Keyboard shortcuts ────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selectedSlotId) {
        e.preventDefault();
        removeSlot(selectedSlotId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedSlotId, removeSlot]);

  // ── Derived values ────────────────────────────────────────────

  const used    = totalSec(clock.slots);
  const remain  = HOUR_SEC - used;
  const pctUsed = Math.min(100, (used / HOUR_SEC) * 100);
  const overrun = used > HOUR_SEC;
  const selectedSlot = clock.slots.find(s => s.id === selectedSlotId) || null;

  // ── Render ────────────────────────────────────────────────────

  return (
    <div style={{
      display: "flex", height: "100%", flexDirection: "column",
      background: "var(--bg-primary)", fontFamily: "'Inter', system-ui, sans-serif",
    }}>

      {/* ── Header ── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12, flexShrink: 0,
        padding: "10px 20px", borderBottom: "1px solid var(--border-primary)",
        background: "var(--bg-secondary)",
      }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "'Syne', sans-serif", color: "var(--text-primary)", letterSpacing: "-0.02em" }}>
            Clock Editor
          </div>
          <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>
            Drag slots onto the timeline · Del = remove · click to edit
          </div>
        </div>

        {/* Clock name */}
        <input
          value={clock.name}
          onChange={e => setClock(p => ({ ...p, name: e.target.value }))}
          style={{
            fontSize: 13, fontWeight: 700, color: "var(--text-primary)",
            background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
            borderRadius: 7, padding: "4px 10px", outline: "none", minWidth: 160,
          }}
        />

        {/* Daypart picker */}
        <select
          value={clock.daypart}
          onChange={e => setClock(p => ({ ...p, daypart: e.target.value }))}
          style={{
            fontSize: 11, color: "var(--text-secondary)",
            background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
            borderRadius: 7, padding: "4px 8px", outline: "none", cursor: "pointer",
          }}
        >
          {DAYPARTS.map(d => <option key={d} value={d}>{d}</option>)}
        </select>

        {/* Time used */}
        <div style={{
          marginLeft: "auto", display: "flex", alignItems: "center", gap: 12,
        }}>
          <div style={{ textAlign: "right" as const }}>
            <div style={{
              fontSize: 18, fontWeight: 800, fontFamily: "'DM Mono', monospace",
              color: overrun ? "#ef4444" : remain < 60 ? "#fbbf24" : "#34d399",
            }}>
              {fmtSec(used)}
            </div>
            <div style={{ fontSize: 9, color: "var(--text-tertiary)", letterSpacing: "0.06em" }}>
              {overrun ? `OVER by ${fmtSec(used - HOUR_SEC)}` : `${fmtSec(remain)} remaining`}
            </div>
          </div>

          {status && (
            <span style={{ fontSize: 10, color: status.startsWith("✓") ? "#34d399" : "#ef4444" }}>
              {status}
            </span>
          )}

          <button onClick={saveClock} disabled={saving} style={{
            padding: "6px 16px", borderRadius: 8, fontSize: 11, fontWeight: 700,
            background: "rgba(52,211,153,0.15)", color: "#34d399",
            border: "1px solid rgba(52,211,153,0.4)", cursor: "pointer",
          }}>
            {saving ? "Saving..." : "Save Clock"}
          </button>

          {onClose && (
            <button onClick={onClose} style={{
              width: 28, height: 28, borderRadius: 7, fontSize: 14,
              background: "var(--bg-tertiary)", color: "var(--text-tertiary)",
              border: "1px solid var(--border-primary)", cursor: "pointer",
            }}>✕</button>
          )}
        </div>
      </div>

      {/* ── Body: palette + timeline + inspector ── */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>

        {/* ── LEFT: Slot palette ── */}
        <div style={{
          width: 168, flexShrink: 0,
          borderRight: "1px solid var(--border-primary)",
          background: "var(--bg-secondary)",
          display: "flex", flexDirection: "column",
          padding: "12px 10px",
          gap: 4, overflowY: "auto",
        }}>
          <div style={{ fontSize: 8, fontWeight: 800, letterSpacing: "0.14em", color: "var(--text-tertiary)", marginBottom: 4 }}>
            DRAG TO TIMELINE
          </div>
          {(Object.keys(SLOT_META) as SlotType[]).map(type => {
            const m = SLOT_META[type];
            return (
              <div
                key={type}
                draggable
                onDragStart={e => {
                  setDraggingType(type);
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onDragEnd={() => setDraggingType(null)}
                onClick={() => addSlot(type)}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "7px 10px", borderRadius: 7,
                  background: draggingType === type ? m.bg : "var(--bg-tertiary)",
                  border: `1px solid ${draggingType === type ? m.border : "var(--border-primary)"}`,
                  cursor: "grab", transition: "all 0.12s",
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = m.bg; (e.currentTarget as HTMLElement).style.borderColor = m.border; }}
                onMouseLeave={e => { if (draggingType !== type) { (e.currentTarget as HTMLElement).style.background = "var(--bg-tertiary)"; (e.currentTarget as HTMLElement).style.borderColor = "var(--border-primary)"; } }}
              >
                <div style={{
                  width: 22, height: 22, borderRadius: 5,
                  background: m.bg, border: `1px solid ${m.border}`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 10, color: m.color, fontWeight: 800, flexShrink: 0,
                }}>
                  {m.icon.length === 1 ? m.icon : ""}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-primary)", whiteSpace: "nowrap" as const }}>
                    {m.label}
                  </div>
                  <div style={{ fontSize: 9, color: "var(--text-tertiary)" }}>
                    {fmtSec(m.defaultDuration)}
                  </div>
                </div>
              </div>
            );
          })}

          <div style={{ marginTop: 8, borderTop: "1px solid var(--border-primary)", paddingTop: 8 }}>
            <div style={{ fontSize: 8, fontWeight: 800, letterSpacing: "0.14em", color: "var(--text-tertiary)", marginBottom: 6 }}>
              SAVED CLOCKS
            </div>
            {clocks.length === 0 && (
              <div style={{ fontSize: 10, color: "var(--text-tertiary)", fontStyle: "italic" }}>
                No saved clocks yet
              </div>
            )}
            {clocks.map(c => (
              <div key={c.id} style={{
                fontSize: 10, color: "var(--text-secondary)", padding: "4px 6px",
                borderRadius: 5, cursor: "pointer",
                background: clock.id === c.id ? "rgba(255,255,255,0.05)" : "transparent",
              }}>
                {c.name}
                <span style={{ fontSize: 9, color: "var(--text-tertiary)", marginLeft: 4 }}>
                  {c.daypart}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* ── CENTER: Timeline ── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>

          {/* Progress bar */}
          <div style={{ height: 4, background: "var(--bg-tertiary)", flexShrink: 0 }}>
            <div style={{
              height: "100%", width: `${pctUsed}%`,
              background: overrun ? "#ef4444" : remain < 60 ? "#fbbf24" : "#34d399",
              transition: "width 0.2s, background 0.3s",
            }} />
          </div>

          {/* Timeline scroll area */}
          <div
            ref={timelineRef}
            style={{
              flex: 1, overflowY: "auto", overflowX: "hidden",
              padding: "16px 20px",
            }}
            onDragOver={e => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              // Find drop index based on Y position
              const children = timelineRef.current?.querySelectorAll("[data-slot]");
              if (!children) return;
              let idx = clock.slots.length;
              children.forEach((el, i) => {
                const rect = el.getBoundingClientRect();
                if (e.clientY < rect.top + rect.height / 2) idx = Math.min(idx, i);
              });
              setDropIndex(idx);
            }}
            onDragLeave={() => setDropIndex(null)}
            onDrop={e => {
              e.preventDefault();
              if (draggingType) {
                addSlot(draggingType, dropIndex ?? undefined);
                setDraggingType(null);
              } else if (draggingSlotId) {
                const fromIdx = clock.slots.findIndex(s => s.id === draggingSlotId);
                if (fromIdx >= 0 && dropIndex !== null) {
                  moveSlot(fromIdx, dropIndex > fromIdx ? dropIndex - 1 : dropIndex);
                }
                setDraggingSlotId(null);
              }
              setDropIndex(null);
            }}
          >
            {/* Empty state */}
            {clock.slots.length === 0 && (
              <div style={{
                border: "2px dashed var(--border-primary)", borderRadius: 12,
                padding: "48px 24px", textAlign: "center" as const,
                color: "var(--text-tertiary)", fontSize: 13,
              }}>
                <div style={{ fontSize: 28, marginBottom: 12, opacity: 0.4 }}>⊕</div>
                Drag slots from the left panel or click them to add
              </div>
            )}

            {/* Slot list */}
            {clock.slots.map((slot, idx) => {
              const m     = SLOT_META[slot.type];
              const isSelected = selectedSlotId === slot.id;
              const pct   = (slot.durationSec / HOUR_SEC) * 100;

              return (
                <div key={slot.id}>
                  {/* Drop indicator */}
                  {dropIndex === idx && (
                    <div style={{
                      height: 3, borderRadius: 2, margin: "2px 0",
                      background: "#a78bfa", boxShadow: "0 0 8px rgba(167,139,250,0.6)",
                    }} />
                  )}

                  {/* Slot row */}
                  <div
                    data-slot={slot.id}
                    draggable
                    onDragStart={e => {
                      setDraggingSlotId(slot.id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => { setDraggingSlotId(null); setDropIndex(null); }}
                    onClick={() => setSelectedSlotId(isSelected ? null : slot.id)}
                    style={{
                      display: "flex", alignItems: "center", gap: 10,
                      padding: "8px 12px", marginBottom: 4, borderRadius: 8,
                      background: isSelected ? m.bg : "var(--bg-secondary)",
                      border: `1px solid ${isSelected ? m.border : "var(--border-primary)"}`,
                      cursor: "grab", transition: "all 0.12s",
                      opacity: draggingSlotId === slot.id ? 0.4 : 1,
                    }}
                  >
                    {/* Position number */}
                    <div style={{
                      width: 20, height: 20, borderRadius: 4, flexShrink: 0,
                      background: "rgba(255,255,255,0.05)",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 9, color: "var(--text-tertiary)", fontWeight: 700,
                    }}>
                      {idx + 1}
                    </div>

                    {/* Color chip */}
                    <div style={{
                      width: 10, height: 32, borderRadius: 3, flexShrink: 0,
                      background: m.color, opacity: 0.8,
                    }} />

                    {/* Label + type */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>
                          {slot.label}
                        </span>
                        {slot.requiresVoiceTrack && (
                          <span style={{
                            fontSize: 8, fontWeight: 700, letterSpacing: "0.08em",
                            padding: "1px 5px", borderRadius: 3,
                            background: "rgba(248,113,113,0.15)", color: "#f87171",
                            border: "1px solid rgba(248,113,113,0.3)",
                          }}>
                            VT REQUIRED
                          </span>
                        )}
                      </div>
                      {/* Timeline bar */}
                      <div style={{ marginTop: 4, height: 4, background: "rgba(255,255,255,0.07)", borderRadius: 2, overflow: "hidden" }}>
                        <div style={{
                          height: "100%", width: `${Math.min(100, pct * 6)}%`,
                          background: m.color, borderRadius: 2, opacity: 0.7,
                          transition: "width 0.2s",
                        }} />
                      </div>
                    </div>

                    {/* Duration */}
                    <div style={{
                      fontSize: 12, fontFamily: "'DM Mono', monospace",
                      color: m.color, fontWeight: 700, flexShrink: 0, minWidth: 36,
                      textAlign: "right" as const,
                    }}>
                      {fmtSec(slot.durationSec)}
                    </div>

                    {/* Quick duration adjust */}
                    <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
                      <button
                        onMouseDown={e => e.stopPropagation()}
                        onClick={e => { e.stopPropagation(); updateSlot(slot.id, { durationSec: Math.max(5, slot.durationSec - 15) }); }}
                        style={{ ...miniBtn, color: m.color }}>−</button>
                      <button
                        onMouseDown={e => e.stopPropagation()}
                        onClick={e => { e.stopPropagation(); updateSlot(slot.id, { durationSec: slot.durationSec + 15 }); }}
                        style={{ ...miniBtn, color: m.color }}>+</button>
                    </div>

                    {/* Delete */}
                    <button
                      onMouseDown={e => e.stopPropagation()}
                      onClick={e => { e.stopPropagation(); removeSlot(slot.id); }}
                      style={{ ...miniBtn, color: "#ef4444", opacity: 0.5, flexShrink: 0 }}
                    >✕</button>
                  </div>
                </div>
              );
            })}

            {/* Drop indicator at end */}
            {dropIndex === clock.slots.length && clock.slots.length > 0 && (
              <div style={{
                height: 3, borderRadius: 2, margin: "2px 0",
                background: "#a78bfa", boxShadow: "0 0 8px rgba(167,139,250,0.6)",
              }} />
            )}

            {/* Clock summary */}
            {clock.slots.length > 0 && (
              <div style={{
                marginTop: 16, padding: "12px 16px", borderRadius: 10,
                background: overrun
                  ? "rgba(239,68,68,0.08)" : "rgba(255,255,255,0.03)",
                border: `1px solid ${overrun ? "rgba(239,68,68,0.2)" : "var(--border-primary)"}`,
                display: "flex", gap: 20, flexWrap: "wrap" as const,
              }}>
                <Stat label="Total" value={fmtSec(used)} color={overrun ? "#ef4444" : "#34d399"} />
                <Stat label="Remaining" value={fmtSec(Math.abs(remain))} color={overrun ? "#ef4444" : "var(--text-secondary)"} />
                <Stat label="Songs" value={String(clock.slots.filter(s => s.type.startsWith("song")).length)} color="#38bdf8" />
                <Stat label="Breaks" value={String(clock.slots.filter(s => s.type === "break" || s.type === "spot").length)} color="#f87171" />
                <Stat label="Slots" value={String(clock.slots.length)} color="var(--text-secondary)" />
              </div>
            )}
          </div>
        </div>

        {/* ── RIGHT: Inspector panel ── */}
        <div style={{
          width: 220, flexShrink: 0,
          borderLeft: "1px solid var(--border-primary)",
          background: "var(--bg-secondary)",
          padding: "14px 14px",
          overflowY: "auto",
        }}>
          {selectedSlot ? (
            <>
              <div style={{
                fontSize: 10, fontWeight: 800, letterSpacing: "0.12em",
                color: "var(--text-tertiary)", marginBottom: 12,
              }}>
                SLOT SETTINGS
              </div>

              {/* Label */}
              <Label>Name</Label>
              <input
                value={selectedSlot.label}
                onChange={e => updateSlot(selectedSlot.id, { label: e.target.value })}
                style={inputStyle}
              />

              {/* Duration */}
              <Label>Duration</Label>
              <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 10 }}>
                <input
                  type="number" min={5} max={3600} step={15}
                  value={selectedSlot.durationSec}
                  onChange={e => updateSlot(selectedSlot.id, { durationSec: Number(e.target.value) })}
                  style={{ ...inputStyle, marginBottom: 0, width: 70 }}
                />
                <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>
                  sec = {fmtSec(selectedSlot.durationSec)}
                </span>
              </div>

              {/* Type */}
              <Label>Type</Label>
              <select
                value={selectedSlot.type}
                onChange={e => updateSlot(selectedSlot.id, {
                  type: e.target.value as SlotType,
                  label: SLOT_META[e.target.value as SlotType].label,
                })}
                style={{ ...inputStyle, cursor: "pointer" }}
              >
                {(Object.keys(SLOT_META) as SlotType[]).map(t => (
                  <option key={t} value={t}>{SLOT_META[t].label}</option>
                ))}
              </select>

              {/* Voice track required toggle */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <input
                  type="checkbox"
                  id="vt-req"
                  checked={selectedSlot.requiresVoiceTrack}
                  onChange={e => updateSlot(selectedSlot.id, { requiresVoiceTrack: e.target.checked })}
                  style={{ accentColor: "#a78bfa", width: 14, height: 14 }}
                />
                <label htmlFor="vt-req" style={{ fontSize: 11, color: "var(--text-secondary)", cursor: "pointer" }}>
                  Requires voice track
                </label>
              </div>

              {/* Notes */}
              <Label>Notes</Label>
              <textarea
                value={selectedSlot.notes}
                onChange={e => updateSlot(selectedSlot.id, { notes: e.target.value })}
                placeholder="MD notes for this slot..."
                rows={3}
                style={{
                  ...inputStyle,
                  resize: "none" as const, fontFamily: "inherit", lineHeight: 1.5,
                  height: "auto",
                }}
              />

              {/* Delete slot */}
              <button
                onClick={() => removeSlot(selectedSlot.id)}
                style={{
                  width: "100%", padding: "6px", marginTop: 8, borderRadius: 7,
                  background: "rgba(239,68,68,0.08)", color: "#ef4444",
                  border: "1px solid rgba(239,68,68,0.2)",
                  fontSize: 11, fontWeight: 600, cursor: "pointer",
                }}
              >
                Remove Slot
              </button>
            </>
          ) : (
            <div style={{ color: "var(--text-tertiary)", fontSize: 11, lineHeight: 1.6 }}>
              <div style={{ marginBottom: 12, fontWeight: 600, color: "var(--text-secondary)" }}>
                Clock Inspector
              </div>
              Click any slot to edit its settings here.
              <br /><br />
              Drag slots from the left panel to add them to the clock.
              <br /><br />
              Drag existing slots up or down to reorder.
              <br /><br />
              Use +/− to quickly adjust duration in 15-second increments.
            </div>
          )}
        </div>
      </div>

      <style>{`
        input[type=range] { accent-color: var(--accent-purple, #a78bfa); }
      `}</style>
    </div>
  );
}

// ── Small helpers ──────────────────────────────────────────────

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)", marginBottom: 4, textTransform: "uppercase" as const }}>
      {children}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" as const, gap: 1 }}>
      <span style={{ fontSize: 8, color: "var(--text-tertiary)", letterSpacing: "0.1em", textTransform: "uppercase" as const }}>{label}</span>
      <span style={{ fontSize: 14, fontFamily: "'DM Mono', monospace", fontWeight: 700, color }}>{value}</span>
    </div>
  );
}

const miniBtn: React.CSSProperties = {
  width: 20, height: 20, borderRadius: 4, fontSize: 12, fontWeight: 700,
  background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)",
  cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
  padding: 0, lineHeight: 1,
};

const inputStyle: React.CSSProperties = {
  width: "100%", fontSize: 11, color: "var(--text-primary)",
  background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
  borderRadius: 6, padding: "5px 8px", outline: "none",
  marginBottom: 10, boxSizing: "border-box" as const,
};
