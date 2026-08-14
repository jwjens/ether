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
import type { ReactNode } from "react";

export function HealthSection({ title, right, children, pad = true }: {
  title: string;
  /** Right-aligned header slot — a window note, a RELOAD button. */
  right?: ReactNode;
  children: ReactNode;
  pad?: boolean;
}) {
  return (
    <section style={{
      background: "var(--bg-elevated)",
      border: "1px solid var(--border-primary)",
      borderRadius: "var(--r-0, 0px)",
      marginBottom: "var(--s-4, 8px)",
    }}>
      <header style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: "var(--s-3, 6px)",
        padding: "var(--s-3, 6px) var(--s-5, 12px)",
        borderBottom: "1px solid var(--border-primary)",
        background: "var(--bg-tertiary)",
      }}>
        <span style={{ fontSize: "var(--t-micro, 9px)", fontWeight: 700, letterSpacing: "0.14em",
                       textTransform: "uppercase", color: "var(--text-secondary)" }}>
          {title}
        </span>
        {right}
      </header>
      <div style={{ padding: pad ? "var(--s-4, 8px) var(--s-5, 12px) var(--s-5, 12px)" : 0 }}>
        {children}
      </div>
    </section>
  );
}

export default HealthSection;
