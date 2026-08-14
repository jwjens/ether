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
