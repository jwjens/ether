// ── HealthSection — the shell every dashboard block sits in ─────────────────────────────────────
//
// Health Monitor redesign.
//
// In 4.4.206 each block was announced by a 9px uppercase tertiary heading — the SAME heading style
// as every other section in the Health Monitor. So the dashboard read as more of the wall of text it
// was replacing, because visually it was indistinguishable from it. A dashboard block needs an edge.
//
// This gives one: a raised surface, a titled header bar, and room to breathe. Still flat (--r-0),
// still muted, still dense — the brand rule is flat and dense, not small and grey.
// COLLAPSE AND DRAG live here rather than in a wrapper, because this component already IS the card.
// Wrapping a HealthSection in a HealthPanel to get a handle would put a card inside a card — two
// borders, two headers, two titles. So the section joins the stack itself: same context, same
// persistence, same handle, one card.
import { useState, type ReactNode } from "react";
import { usePanelStack } from "./sectionChrome";

export function HealthSection({ id, title, right, children, pad = true }: {
  /** Joins the surrounding PanelStack under this key — drag to reorder, and collapse remembered
   *  across reloads. Omit and the section is fixed, which is what a section outside a stack is. */
  id?: string;
  title: string;
  /** Right-aligned header slot — a window note, a RELOAD button. */
  right?: ReactNode;
  children: ReactNode;
  pad?: boolean;
}) {
  const ctx = usePanelStack();
  const [solo, setSolo] = useState(false);
  const inStack = !!(ctx && id);
  const collapsed = inStack ? (ctx!.collapsed[id!] ?? false) : solo;
  const toggle = () => (inStack ? ctx!.toggle(id!) : setSolo(v => !v));
  const isDragging = inStack && ctx!.dragId === id;
  const isOver = inStack && ctx!.overId === id && ctx!.dragId !== id;

  return (
    <section
      onDragOver={inStack ? (e) => { e.preventDefault(); ctx!.onDragOver(id!); } : undefined}
      onDrop={inStack ? (e) => { e.preventDefault(); ctx!.drop(); } : undefined}
      style={{
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-primary)",
        borderRadius: "var(--r-0, 0px)",
        marginBottom: "var(--s-4, 8px)",
        opacity: isDragging ? 0.4 : 1,
        // An edge, not a reflow: the list must not squirm out from under the pointer mid-drag.
        boxShadow: isOver ? "inset 0 3px 0 0 var(--accent-green)" : undefined,
      }}>
      <header
        draggable={inStack}
        onDragStart={inStack ? (e) => { e.dataTransfer.effectAllowed = "move"; ctx!.onDragStart(id!); } : undefined}
        onDragEnd={inStack ? () => ctx!.onDragEnd() : undefined}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: "var(--s-3, 6px)",
          padding: "var(--s-3, 6px) var(--s-5, 12px)",
          borderBottom: collapsed ? "none" : "1px solid var(--border-primary)",
          background: "var(--bg-tertiary)",
          cursor: inStack ? "grab" : "default",
        }}>
        <span style={{ display: "flex", alignItems: "center", gap: "var(--s-3, 6px)", minWidth: 0 }}>
          {inStack && (
            <span aria-hidden style={{ color: "var(--text-tertiary)", fontSize: 13, lineHeight: 1,
                                       letterSpacing: "-1px", flexShrink: 0 }}>⠿</span>
          )}
          <button
            type="button"
            onClick={toggle}
            aria-expanded={!collapsed}
            title={collapsed ? "Expand" : "Collapse"}
            style={{
              display: "flex", alignItems: "center", gap: "var(--s-3, 6px)", minWidth: 0,
              background: "none", border: "none", padding: 0, cursor: "pointer",
              textAlign: "left", font: "inherit",
            }}>
            <span style={{ color: "var(--text-tertiary)", fontSize: 11, width: 10, flexShrink: 0,
                           display: "inline-block", transition: "transform 120ms ease",
                           transform: collapsed ? "rotate(-90deg)" : "none" }}>▾</span>
            <span style={{ fontSize: "var(--t-micro, 9px)", fontWeight: 700, letterSpacing: "0.14em",
                           textTransform: "uppercase", color: "var(--text-secondary)",
                           overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {title}
            </span>
          </button>
        </span>
        {right}
      </header>
      {!collapsed && (
        <div style={{ padding: pad ? "var(--s-4, 8px) var(--s-5, 12px) var(--s-5, 12px)" : 0 }}>
          {children}
        </div>
      )}
    </section>
  );
}

export default HealthSection;
