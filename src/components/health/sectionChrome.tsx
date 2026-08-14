// ── sectionChrome — the card shell the older Health Monitor sections wear ───────────────────────
//
// The dashboard sections (HealthSection) are raised cards with a titled header bar. Everything BELOW
// the dashboard was still the original pattern: a bare div, a 9px uppercase grey heading, and a
// 1px rule — which is why the panel reads as two different products stacked on each other.
//
// These two exports convert a section's CHROME without restructuring its JSX. That matters: these
// sections are long, deeply nested, and several of them are load-bearing controls (the canary flips,
// the auto-generate toggles, the DMCA export). Rewrapping them in a new parent element would mean
// finding nine matching closing tags in a 1,600-line file, and a mismatch there breaks the panel
// silently at runtime rather than at compile time. Swapping the opening div's style and the heading
// is a one-line change per section with nothing to mis-nest.
//
// Same tokens and same look as HealthSection, deliberately — one visual language, two ways of
// reaching it while the older sections are migrated.
import { Children, createContext, isValidElement, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

/**
 * Drop-in replacement for the old `<div style={{ paddingTop: 16, borderTop: ... }}>` wrapper.
 *
 * CARRIES ITS OWN PADDING, deliberately. HealthSection puts the body in a second element so its
 * header bar can span edge to edge; doing that here would mean adding a `<div>` inside each of these
 * sections and finding nine matching closing tags in a 1,700-line file. A mis-nest there breaks the
 * panel at runtime, not at compile time. One element in, one element out — nothing to mis-nest.
 */
export const sectionCard: CSSProperties = {
  background: "var(--bg-elevated)",
  border: "1px solid var(--border-primary)",
  borderRadius: "var(--r-0, 0px)",
  marginBottom: "var(--s-4, 8px)",
  padding: "var(--s-4, 8px) var(--s-5, 12px) var(--s-5, 12px)",
};

/**
 * The section heading — replaces the old 9px grey label, one element for one element.
 *
 * Reads as a card header rather than a paragraph label: brighter, letter-spaced, with a rule under
 * it. `right` takes the controls several of these sections already carry (RELOAD, export buttons).
 */
export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      gap: "var(--s-3, 6px)",
      marginBottom: "var(--s-4, 8px)", paddingBottom: "var(--s-2, 4px)",
      borderBottom: "1px solid var(--border-primary)",
    }}>
      <span style={{ fontSize: "var(--t-micro, 9px)", fontWeight: 700, letterSpacing: "0.14em",
                     textTransform: "uppercase", color: "var(--text-secondary)" }}>
        {children}
      </span>
      {right}
    </div>
  );
}

// ── Collapse + reorder ─────────────────────────────────────────────────────────────────────────
//
// A wall display and a troubleshooting session want different panels. Rather than guess one order
// for both, the operator sets it: drag a panel by its header, collapse the ones that are not the
// question today. Both stick, per stack, in localStorage — an operator who arranges this panel for
// their studio should not have to arrange it again tomorrow.
//
// PERSISTENCE IS BY ID, NOT BY POSITION. A saved order is a list of ids, and ids not in it fall to
// the end in declaration order. That is what makes a saved layout survive a build that adds or
// removes a panel: the new panel appears (at the end) instead of the layout being discarded, and a
// removed one is simply absent instead of leaving a hole or throwing.

const ORDER_KEY = (stack: string) => `ether.health.panelOrder.${stack}`;
const COLLAPSE_KEY = (stack: string) => `ether.health.panelCollapsed.${stack}`;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    return v == null ? fallback : v as T;
  } catch { return fallback; }
}
function writeJson(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode / quota — the
    layout is a preference, never a reason to break the panel */ }
}

interface StackCtx {
  collapsed: Record<string, boolean>;
  toggle: (id: string) => void;
  dragId: string | null;
  overId: string | null;
  onDragStart: (id: string) => void;
  onDragOver: (id: string) => void;
  onDragEnd: () => void;
  drop: () => void;
}
const PanelStackContext = createContext<StackCtx | null>(null);

/** Lets a card that already has its own chrome — HealthSection, the dashboard's shell — join the
 *  stack instead of being re-wrapped in a second card. Returns null outside a stack, which is the
 *  signal to render as a plain section with no handle. */
export function usePanelStack(): StackCtx | null {
  return useContext(PanelStackContext);
}

/**
 * Orders and remembers the panels inside it.
 *
 * Takes its children as JSX siblings — NOT an array the caller has to build — and reorders them
 * itself by reading each child's `id` prop. That keeps every call site readable as a plain list of
 * panels, which is the thing a person editing this file actually wants to see.
 */
export function PanelStack({ stack, children }: { stack: string; children: ReactNode }) {
  // Anything that is not a panel — a rollup banner, a last-error block — is PINNED above the
  // reorderable panels rather than dropped. Dropping it would be a silent failure of exactly the
  // kind this panel exists to catch: the child compiles, renders nothing, and nobody notices the
  // alert is missing. Pinned at the top is also where an alert belongs.
  const { items, pinned } = useMemo(() => {
    const items: Array<{ id: string; node: ReactNode }> = [];
    const pinned: ReactNode[] = [];
    Children.forEach(children, (child) => {
      if (child == null || typeof child === "boolean") return;   // {cond && …} that resolved false
      const id = isValidElement(child) ? (child.props as { id?: string })?.id : undefined;
      if (id) items.push({ id, node: child });
      else pinned.push(child);
    });
    return { items, pinned };
  }, [children]);

  const [order, setOrder] = useState<string[]>(() => readJson<string[]>(ORDER_KEY(stack), []));
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => readJson(COLLAPSE_KEY(stack), {}));
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  // Saved ids first, in saved order; anything unknown keeps its declaration position at the end.
  const ordered = useMemo(() => {
    const known = new Map(items.map(i => [i.id, i]));
    const out: typeof items = [];
    for (const id of order) { const it = known.get(id); if (it) { out.push(it); known.delete(id); } }
    for (const it of items) if (known.has(it.id)) out.push(it);
    return out;
  }, [items, order]);

  const toggle = useCallback((id: string) => {
    setCollapsed(prev => {
      const next = { ...prev, [id]: !prev[id] };
      writeJson(COLLAPSE_KEY(stack), next);
      return next;
    });
  }, [stack]);

  const drop = useCallback(() => {
    setDragId(null); setOverId(null);
    if (!dragId || !overId || dragId === overId) return;
    const ids = ordered.map(i => i.id);
    const from = ids.indexOf(dragId), to = ids.indexOf(overId);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, dragId);
    setOrder(ids);
    writeJson(ORDER_KEY(stack), ids);
  }, [dragId, overId, ordered, stack]);

  const ctx = useMemo<StackCtx>(() => ({
    collapsed, toggle, dragId, overId,
    onDragStart: setDragId, onDragOver: setOverId,
    onDragEnd: () => { setDragId(null); setOverId(null); },
    drop,
  }), [collapsed, toggle, dragId, overId, drop]);

  return (
    <PanelStackContext.Provider value={ctx}>
      {pinned}
      {ordered.map(i => i.node)}
    </PanelStackContext.Provider>
  );
}

/**
 * A section that can be collapsed and dragged.
 *
 * Drag lives on the HEADER only, deliberately. Making the whole card draggable would mean an
 * operator cannot select a reason string or click a control inside it without the card following
 * the pointer — several of these panels carry load-bearing switches.
 *
 * Outside a PanelStack it still collapses; it just cannot be reordered, because there is nothing to
 * reorder it against. That keeps it usable as a plain section.
 */
export function HealthPanel({ id, title, right, children, defaultCollapsed = false }: {
  id: string; title: ReactNode; right?: ReactNode; children: ReactNode; defaultCollapsed?: boolean;
}) {
  const ctx = useContext(PanelStackContext);
  const [soloCollapsed, setSoloCollapsed] = useState(defaultCollapsed);
  const isCollapsed = ctx ? (ctx.collapsed[id] ?? defaultCollapsed) : soloCollapsed;
  const toggle = () => (ctx ? ctx.toggle(id) : setSoloCollapsed(v => !v));

  const isDragging = ctx?.dragId === id;
  const isOver = ctx?.overId === id && ctx?.dragId !== id;

  return (
    <div
      onDragOver={ctx ? (e) => { e.preventDefault(); ctx.onDragOver(id); } : undefined}
      onDrop={ctx ? (e) => { e.preventDefault(); ctx.drop(); } : undefined}
      style={{
        ...sectionCard,
        opacity: isDragging ? 0.4 : 1,
        // The drop target is shown as an edge, not as a moved card: nothing reflows until the
        // pointer is released, so the list does not squirm out from under the operator mid-drag.
        boxShadow: isOver ? "inset 0 3px 0 0 var(--accent-green)" : undefined,
        paddingBottom: isCollapsed ? "var(--s-4, 8px)" : undefined,
      }}
    >
      <div
        draggable={!!ctx}
        onDragStart={ctx ? (e) => { e.dataTransfer.effectAllowed = "move"; ctx.onDragStart(id); } : undefined}
        onDragEnd={ctx ? () => ctx.onDragEnd() : undefined}
        style={{
          display: "flex", alignItems: "center", gap: "var(--s-3, 6px)",
          marginBottom: isCollapsed ? 0 : "var(--s-4, 8px)",
          paddingBottom: isCollapsed ? 0 : "var(--s-2, 4px)",
          borderBottom: isCollapsed ? "none" : "1px solid var(--border-primary)",
          cursor: ctx ? "grab" : "default",
        }}
      >
        {ctx && (
          <span aria-hidden style={{ color: "var(--text-tertiary)", fontSize: 13, lineHeight: 1, letterSpacing: "-1px", flexShrink: 0 }}>⠿</span>
        )}
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!isCollapsed}
          title={isCollapsed ? "Expand" : "Collapse"}
          style={{
            display: "flex", alignItems: "center", gap: "var(--s-3, 6px)",
            flex: 1, minWidth: 0, background: "none", border: "none", padding: 0,
            cursor: "pointer", textAlign: "left", font: "inherit",
          }}
        >
          <span style={{ color: "var(--text-tertiary)", fontSize: 11, width: 10, flexShrink: 0,
                         display: "inline-block", transition: "transform 120ms ease",
                         transform: isCollapsed ? "rotate(-90deg)" : "none" }}>▾</span>
          <span style={{ fontSize: "var(--t-micro, 9px)", fontWeight: 700, letterSpacing: "0.14em",
                         textTransform: "uppercase", color: "var(--text-secondary)",
                         overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {title}
          </span>
        </button>
        {right}
      </div>
      {!isCollapsed && children}
    </div>
  );
}

/**
 * THE meter row for everything below the dashboard.
 *
 * Geometry is copied from the dashboard's deck meters on purpose — 52px label, a `flex: 1` bar at
 * height 14 on the primary ground, a 92px monospace readout — because the complaint that produced
 * it was that the lower meters read as "small strips" beside instruments. Three different bar
 * geometries in one panel is three different products in one panel.
 *
 * `from` exists for the bidirectional ride-gain meter, which grows right when boosting and left when
 * cutting from a unity mark at centre. Everything else leaves it at 0 and fills from the left.
 */
export function PanelMeter({ label, read, pct, color, from = 0, tickPct, tickColor, readTone }: {
  label: string;
  read: string;
  /** Width of the fill, 0..100. */
  pct: number;
  color: string;
  /** Left edge of the fill, 0..100 — only the ride meter needs this. */
  from?: number;
  /** A reference mark: −6 dBFS on a peak meter, unity on the ride meter. */
  tickPct?: number;
  tickColor?: string;
  readTone?: string;
}) {
  const w = Math.max(0, Math.min(100, pct || 0));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3, 6px)" }}>
      <span style={{ width: 52, flexShrink: 0, fontSize: "var(--t-body, 12px)", fontWeight: 700,
                     color: "var(--text-secondary)" }}>{label}</span>
      <div style={{ flex: 1, minWidth: 60, height: 14, background: "var(--bg-primary)",
                    border: "1px solid var(--border-primary)", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: 0, bottom: 0, left: `${from}%`, width: `${w}%`,
                      background: color, transition: "left .1s linear, width .1s linear" }} />
        {tickPct != null && (
          <div style={{ position: "absolute", top: 0, height: "100%", width: 1, opacity: 0.45,
                        left: `${tickPct}%`, background: tickColor || "var(--accent-amber)" }} />
        )}
      </div>
      <span style={{ width: 92, flexShrink: 0, textAlign: "right" as const,
                     fontSize: "var(--t-small, 10px)", fontFamily: "'DM Mono', monospace",
                     color: readTone || "var(--text-secondary)", whiteSpace: "nowrap" }}>{read}</span>
    </div>
  );
}

/**
 * A status dot with a WORD beside it.
 *
 * The word is not decoration. This panel encodes almost everything as red/green, which is the common
 * colour deficiency — and on a wall display seen from across a room, a 7px dot is the first thing to
 * become unreadable. Anything that carries status carries text too.
 */
export function StatusPill({ level, label, sub }: {
  level: "green" | "yellow" | "red" | "grey";
  label: string;
  sub?: string;
}) {
  const color = level === "green" ? "var(--accent-green)"
              : level === "yellow" ? "var(--accent-amber)"
              : level === "red" ? "var(--accent-red)"
              : "var(--text-tertiary)";
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: "var(--s-3, 6px)",
      padding: "var(--s-3, 6px) var(--s-4, 8px)",
      background: "var(--bg-secondary)",
      border: "1px solid var(--border-primary)",
      borderLeft: `3px solid ${color}`,
      minWidth: 0,
    }}>
      <span style={{ width: 8, height: 8, borderRadius: "var(--r-full, 999px)", background: color, flexShrink: 0 }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: "var(--t-body, 12px)", fontWeight: 600, color: "var(--text-primary)",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</div>
        {sub && (
          <div style={{ fontSize: "var(--t-small, 10px)", color: "var(--text-tertiary)",
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</div>
        )}
      </div>
    </div>
  );
}

/**
 * A small labelled figure — uptime, pid, restarts, ping.
 *
 * Reads as a reading rather than as a sentence: the number leads, its name sits underneath in the
 * quiet colour. Four of these in a row is the Engine section.
 */
export function StatTile({ label, value, tone }: {
  label: string;
  value: ReactNode;
  /** Only when the figure itself carries a verdict — most do not, and colouring them all would make
   *  the colour mean nothing. */
  tone?: "green" | "yellow" | "red";
}) {
  const color = tone === "green" ? "var(--accent-green)"
              : tone === "yellow" ? "var(--accent-amber)"
              : tone === "red" ? "var(--accent-red)"
              : "var(--text-primary)";
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 18, fontWeight: 800, lineHeight: 1.15, color,
                    fontVariantNumeric: "tabular-nums", overflow: "hidden",
                    textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</div>
      <div style={{ fontSize: "var(--t-micro, 9px)", fontWeight: 700, letterSpacing: "0.12em",
                    textTransform: "uppercase", color: "var(--text-tertiary)", marginTop: 1 }}>{label}</div>
    </div>
  );
}
