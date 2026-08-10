// ── Scheduler — the tabbed Shows / Categories / Clocks panel ─────────────────────────────────────
//
// PHASE A (2026-08-10): the three tab bodies moved into ./scheduler/ verbatim. This file keeps the
// tab chrome and re-exports them, so every existing entry point is untouched:
//   • Schedule menubar → <Scheduler defaultTab=…>            (App.tsx)
//   • the three popout windows                                (PopoutRenderer.tsx:130/133/136)
//   • the embedded programming panel                          (App.tsx, <Scheduler … embedded />)
// The Schedule Manager hub will import the tabs directly from ./scheduler/ rather than through here.
// docs/schedule-manager-design-2026-08-10.md §8 Phase A
import { useState, useEffect, useRef, useCallback } from "react";
import CreateShowWizard from "./CreateShowWizard";
import { ShowsTab } from "./scheduler/ShowsTab";
import { CategoriesTab } from "./scheduler/CategoriesTab";
import { ClocksTab } from "./scheduler/ClocksTab";
import type { ClockSlot } from "./scheduler/types";

// Re-exported so the hub (and anything else) has ONE import site per tab, and so this file stays the
// compatibility shim rather than a second source of truth.
export { ShowsTab, CategoriesTab, ClocksTab };
export type { Show, Category, Clock, ClockSlot } from "./scheduler/types";

// ── Swipe gesture hook ────────────────────────────────────────────────────────
function useSwipe(onSwipe: (dir: 'left' | 'right') => void) {
  const start = useRef<{ x: number; y: number; t: number } | null>(null);
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if ((e.target as Element).closest('button, input, a, select, [role="button"]')) return;
    start.current = { x: e.clientX, y: e.clientY, t: Date.now() };
  }, []);
  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!start.current) return;
    const dx = e.clientX - start.current.x;
    const dy = e.clientY - start.current.y;
    const dt = Date.now() - start.current.t;
    start.current = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 500)
      onSwipe(dx < 0 ? 'left' : 'right');
  }, [onSwipe]);
  return { onPointerDown, onPointerUp };
}

// HOURS / DAYS / CLOCK_SLOT_TYPE_OPTIONS / fmtHour / fmtClockPos now live in ./scheduler/shared.ts —
// one definition, imported by the tabs. Deleted from here rather than duplicated, so the two copies
// cannot drift apart.

interface SchedulerProps {
  defaultTab?: "shows" | "categories" | "clocks";
  /** Embedded mode for the on-air push-up docks: render ONLY the active tab's content
   *  (each tab has its own header + actions). The footer buttons drive the tab via
   *  defaultTab, so the wrapper chrome (title, Create-Show, tab bar) is omitted. */
  embedded?: boolean;
}

const SCHEDULER_TABS: ("shows" | "categories" | "clocks")[] = ["shows", "categories", "clocks"];

export default function Scheduler({ defaultTab = "shows", embedded = false }: SchedulerProps) {
  const [tab, setTab] = useState<"shows" | "categories" | "clocks">(defaultTab);
  const [showWizard, setShowWizard] = useState(false);
  const [wizardKey, setWizardKey] = useState(0); // force ShowsTab reload after wizard

  // Sync when parent navigation changes the requested tab
  useEffect(() => { setTab(defaultTab); }, [defaultTab]);

  if (embedded) {
    return (
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 12 }}>
        {tab === "shows" && <ShowsTab />}
        {tab === "categories" && <CategoriesTab />}
        {tab === "clocks" && <ClocksTab />}
      </div>
    );
  }

  const swipe = useSwipe(useCallback((dir: 'left' | 'right') => {
    setTab(cur => {
      const idx = SCHEDULER_TABS.indexOf(cur);
      const next = dir === 'left' ? Math.min(idx + 1, SCHEDULER_TABS.length - 1) : Math.max(idx - 1, 0);
      return SCHEDULER_TABS[next];
    });
  }, []));

  return (
    <div className="space-y-3" {...swipe}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <h1 className="text-lg font-bold" style={{ margin: 0 }}>Schedule</h1>
        <button
          onClick={() => setShowWizard(true)}
          style={{
            padding: "7px 16px", borderRadius: 0, fontSize: 11, fontWeight: 700, cursor: "pointer",
            background: "var(--accent-blue)", color: "#fff", border: "none",
            boxShadow: "0 2px 8px rgb(from var(--accent-blue) r g b / 0.3)",
            minHeight: 44, display: "inline-flex", alignItems: "center",
          }}
        >
          + Create Show
        </button>
      </div>
      <div className="flex gap-1">
        {(["shows", "categories", "clocks"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ minHeight: 44 }}
            className={tab === t ? "px-3 py-1.5 rounded text-xs font-bold bg-blue-600 text-white" : "px-3 py-1.5 rounded text-xs font-bold bg-zinc-800 text-zinc-400 hover:bg-zinc-700"}
          >{t === "shows" ? "Shows & Dayparts" : t === "categories" ? "Categories" : "Clocks"}</button>
        ))}
      </div>
      {tab === "shows" && <ShowsTab key={wizardKey} />}
      {tab === "categories" && <CategoriesTab />}
      {tab === "clocks" && <ClocksTab />}
      {showWizard && (
        <CreateShowWizard
          onClose={() => setShowWizard(false)}
          onDone={() => { setShowWizard(false); setTab("shows"); setWizardKey(k => k + 1); }}
        />
      )}
    </div>
  );
}

// ============================================================
// SHOWS TAB — with clock dropdown
// ============================================================


// ============================================================
// CATEGORIES TAB
// ============================================================

// ============================================================
// CLOCKS TAB
// ============================================================

// ── Slot colors ──────────────────────────────────────────────
function slotColor(s: ClockSlot): string {
  if (s.category_color) return s.category_color;
  if (s.slot_type === "talk_break") return "#7c3aed";
  if (s.slot_type === "spot_break") return "#b91c1c";
  if (s.slot_type === "liner") return "#92400e";
  if (s.slot_type === "sweeper") return "#065f46";
  return "#374151";
}

function slotLabel(s: ClockSlot): string {
  if (s.slot_type === "talk_break") return s.label || "Talk break";
  if (s.slot_type === "spot_break") return s.label || "Spots";
  if (s.slot_type === "liner") return "Liner";
  if (s.slot_type === "sweeper") return "Sweeper";
  return s.category_code || "Song";
}

// ── Live clock wheel — proper radio programming clock ──────────
function ClockWheel({ slots, totalTarget = 60 }: { slots: ClockSlot[]; totalTarget?: number }) {
  const SIZE = 340;
  const CX = SIZE / 2; const CY = SIZE / 2;
  const R_OUT = SIZE / 2 - 8;   // outer radius
  const R_IN  = SIZE * 0.26;    // inner radius — thick ring
  const R_MID = R_IN + (R_OUT - R_IN) / 2;

  const filled = slots.reduce((s, sl) => s + sl.duration_min, 0);
  const remaining = Math.max(0, totalTarget - filled);
  let angle = -Math.PI / 2;

  // Build segment arcs
  const arcs: { path: string; color: string; id: number; label: string; artist: string; midAngle: number; sweep: number; durMin: number }[] = [];
  slots.forEach((s, i) => {
    const dur = Math.max(s.duration_min, 0.01); // prevent zero-sweep
    const sweep = (dur / totalTarget) * Math.PI * 2;
    const midAngle = angle + sweep / 2;
    const x1o = CX + R_OUT * Math.cos(angle);         const y1o = CY + R_OUT * Math.sin(angle);
    const x2o = CX + R_OUT * Math.cos(angle + sweep); const y2o = CY + R_OUT * Math.sin(angle + sweep);
    const x1i = CX + R_IN  * Math.cos(angle + sweep); const y1i = CY + R_IN  * Math.sin(angle + sweep);
    const x2i = CX + R_IN  * Math.cos(angle);         const y2i = CY + R_IN  * Math.sin(angle);
    const large = sweep > Math.PI ? 1 : 0;
    const path = `M ${x1o.toFixed(2)} ${y1o.toFixed(2)} A ${R_OUT} ${R_OUT} 0 ${large} 1 ${x2o.toFixed(2)} ${y2o.toFixed(2)} L ${x1i.toFixed(2)} ${y1i.toFixed(2)} A ${R_IN} ${R_IN} 0 ${large} 0 ${x2i.toFixed(2)} ${y2i.toFixed(2)} Z`;
    arcs.push({ path, color: slotColor(s), id: i, label: (s as any).song_title || slotLabel(s), artist: (s as any).song_artist || "", midAngle, sweep, durMin: dur });
    angle += sweep;
  });

  // Unfilled portion of ring
  const filledSweep = (Math.min(filled, totalTarget) / totalTarget) * Math.PI * 2;
  const emptyStart = -Math.PI / 2 + filledSweep;
  const emptyAngle = Math.PI * 2 - filledSweep;
  const ex1 = CX + R_OUT * Math.cos(emptyStart);       const ey1 = CY + R_OUT * Math.sin(emptyStart);
  const ex2 = CX + R_OUT * Math.cos(emptyStart + emptyAngle); const ey2 = CY + R_OUT * Math.sin(emptyStart + emptyAngle);
  const ei1 = CX + R_IN  * Math.cos(emptyStart + emptyAngle); const ei2_y = CY + R_IN * Math.sin(emptyStart + emptyAngle);
  const ei2 = CX + R_IN  * Math.cos(emptyStart);       const ei2y = CY + R_IN * Math.sin(emptyStart);
  const emptyLarge = emptyAngle > Math.PI ? 1 : 0;
  const emptyPath = emptyAngle > 0.01
    ? `M ${ex1.toFixed(2)} ${ey1.toFixed(2)} A ${R_OUT} ${R_OUT} 0 ${emptyLarge} 1 ${ex2.toFixed(2)} ${ey2.toFixed(2)} L ${ei1.toFixed(2)} ${ei2_y.toFixed(2)} A ${R_IN} ${R_IN} 0 ${emptyLarge} 0 ${ei2.toFixed(2)} ${ei2y.toFixed(2)} Z`
    : "";

  // Hour markers (12 ticks for 5-min intervals)
  const ticks = Array.from({ length: 12 }, (_, i) => {
    const a = -Math.PI / 2 + (i / 12) * Math.PI * 2;
    const r1 = R_OUT + 6; const r2 = R_OUT + 14;
    return { x1: CX + r1 * Math.cos(a), y1: CY + r1 * Math.sin(a), x2: CX + r2 * Math.cos(a), y2: CY + r2 * Math.sin(a), main: i === 0 };
  });

  const fmtTime = (min: number) => `${Math.floor(min)}:${String(Math.round((min % 1) * 60)).padStart(2, "0")}`;

  return (
    <div style={{ position: "relative" as const, width: SIZE, height: SIZE, flexShrink: 0 }}>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
        {/* Outer tick ring */}
        <circle cx={CX} cy={CY} r={R_OUT + 10} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
        {ticks.map((t, i) => (
          <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
            stroke={t.main ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.2)"}
            strokeWidth={t.main ? "2" : "1"} strokeLinecap="round" />
        ))}

        {/* Empty ring background */}
        {emptyPath && <path d={emptyPath} fill="rgba(255,255,255,0.04)" />}

        {/* Filled segments */}
        {arcs.map((a, i) => (
          <g key={a.id}>
            <path d={a.path} fill={a.color} stroke="#080810" strokeWidth="1.5" opacity="0.92" />
            {/* Separator line at start of each segment */}
            {i > 0 && <line
              x1={CX + R_IN * Math.cos(arcs[i].midAngle - a.sweep / 2)}
              y1={CY + R_IN * Math.sin(arcs[i].midAngle - a.sweep / 2)}
              x2={CX + R_OUT * Math.cos(arcs[i].midAngle - a.sweep / 2)}
              y2={CY + R_OUT * Math.sin(arcs[i].midAngle - a.sweep / 2)}
              stroke="#080810" strokeWidth="1.5"
            />}
            {/* Label text — only if segment is wide enough */}
            {a.sweep > 0.18 && (
              <text
                x={CX + R_MID * Math.cos(a.midAngle)}
                y={CY + R_MID * Math.sin(a.midAngle)}
                textAnchor="middle" dominantBaseline="middle"
                fill="#fff" fontSize={a.sweep > 0.4 ? "9" : "7"} fontWeight="700"
                fontFamily="Inter,sans-serif"
                style={{ pointerEvents: "none" as const }}
                transform={`rotate(${(a.midAngle * 180 / Math.PI) + 90}, ${CX + R_MID * Math.cos(a.midAngle)}, ${CY + R_MID * Math.sin(a.midAngle)})`}
              >
                {a.label.length > 12 ? a.label.slice(0, 10) + "…" : a.label}
              </text>
            )}
          </g>
        ))}

        {/* 12 o'clock marker */}
        <line x1={CX} y1={CY - R_OUT - 4} x2={CX} y2={CY - R_OUT + 8}
          stroke="rgba(255,255,255,0.9)" strokeWidth="2.5" strokeLinecap="round" />

        {/* Inner circle */}
        <circle cx={CX} cy={CY} r={R_IN - 2} fill="#080810" />
        <circle cx={CX} cy={CY} r={R_IN - 2} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="1" />

        {/* Center content */}
        <text x={CX} y={CY - 22} textAnchor="middle" fill="rgba(255,255,255,0.25)" fontSize="9" letterSpacing="3" fontFamily="Inter,sans-serif">HOUR CLOCK</text>
        <text x={CX} y={CY + 4} textAnchor="middle" fill="rgba(255,255,255,0.95)" fontSize="28" fontWeight="800" fontFamily="Inter,sans-serif">{fmtTime(filled)}</text>
        <text x={CX} y={CY + 20} textAnchor="middle" fill="rgba(255,255,255,0.3)" fontSize="9" fontFamily="Inter,sans-serif">of 60 min</text>
        <text x={CX} y={CY + 36} textAnchor="middle"
          fill={remaining < 0.5 ? "#34d399" : remaining < 10 ? "#fbbf24" : "rgba(255,255,255,0.2)"}
          fontSize="10" fontWeight="700" fontFamily="Inter,sans-serif">
          {remaining < 0.1 ? "● HOUR FULL" : fmtTime(remaining) + " left"}
        </text>

        {/* Slot count ring label */}
        <text x={CX} y={CY - 36} textAnchor="middle" fill="rgba(255,255,255,0.15)" fontSize="8" fontFamily="Inter,sans-serif">{slots.length} segments</text>
      </svg>
    </div>
  );
}


// ── Talk break duration picker ────────────────────────────────

// ── Segment picker — shows ALL categories from DB ────────────

// ── Clock skeleton ────────────────────────────────────────────
function ClockSkeleton() {
  const SIZE = 300; const CX = SIZE/2; const CY = SIZE/2;
  const R_OUT = SIZE/2 - 8; const R_IN = SIZE * 0.26;
  return (
    <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} style={{ opacity: 0.4 }}>
      <circle cx={CX} cy={CY} r={R_OUT} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="1"/>
      <circle cx={CX} cy={CY} r={R_IN} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="1"/>
      <text x={CX} y={CY+6} textAnchor="middle" fill="rgba(255,255,255,0.15)" fontSize="11" fontFamily="Inter,sans-serif">Add segments →</text>
    </svg>
  );
}

// ── Format time as MM:SS ──────────────────────────────────────
function fmtClockPos(totalMin: number): string {
  const m = Math.floor(totalMin);
  const s = Math.round((totalMin - m) * 60);
  return `:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

// ── ClocksTab — professional spreadsheet with clock positions ─
