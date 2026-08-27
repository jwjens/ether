// src/lib/contentClass.tsx — ONE definition of what an aired element is called and coloured.
//
// Jeff's ruling, 2026-08-26 (the Zetta model): a log or recently-played surface shows EVERYTHING that
// aired — songs, spots, jingles, sweepers, announcements — every element typed and coloured by class.
// Narrowing the view is a FILTER THE USER CHOOSES and can undo, never a hardcoded exclusion.
//
// This exists because the colours were previously restated at each site (App.tsx's library rows,
// Spots.tsx's type map, the queue's SPOT tint, the announcement row I added). Restating them is how
// SPOT ends up amber in one place and orange in another, and how a new class gets a badge in three
// surfaces and not the fourth. One table, imported.
//
// The tokens are the ones already audited in the tree ("Class-color audit (jingles v1 D3)"):
//   SWP  indigo #4f46e5      SPOT amber #f59e0b
//   ANN  cyan   (accent)     MUSIC — no badge, because most rows are music and a badge on every row
//                            is noise rather than information.
//
// v52 (2026-08-27): JIN is retired. There is ONE imaging class, SWP ("Sweepers"). JIN survives here
// as a READ-ONLY legacy value — a row written before v52, or one arriving from a peer that has not
// run it yet, still says JIN and must still render as a sweeper rather than falling back to MUSIC
// and disappearing into the music list. It is never written.

export type ContentClass = "MUSIC" | "SWP" | "SPOT" | "ANN";

/** The one imaging class. Write this, never a literal. */
export const SWEEPER: ContentClass = "SWP";
/** Pre-v52 rows and un-migrated peers still say this. Read it, never write it. */
export const LEGACY_SWEEPER = "JIN";
/** Is this row a sweeper, whichever vocabulary wrote it? */
export const isSweeper = (v: string | null | undefined): boolean => {
  const k = String(v ?? "").trim().toUpperCase();
  return k === SWEEPER || k === LEGACY_SWEEPER;
};

export interface ClassMeta {
  /** The canonical class code. */
  code: ContentClass;
  /** What an operator calls it. */
  label: string;
  /** Short badge text. */
  badge: string;
  fg: string;
  bg: string;
  border: string;
}

const META: Record<ContentClass, ClassMeta> = {
  MUSIC: { code: "MUSIC", label: "Songs",         badge: "MUS",  fg: "var(--text-tertiary)", bg: "transparent",              border: "transparent" },
  SWP:   { code: "SWP",   label: "Sweepers",      badge: "SWP",  fg: "#4f46e5",              bg: "rgba(79, 70, 229, 0.14)",  border: "rgba(79, 70, 229, 0.5)" },
  SPOT:  { code: "SPOT",  label: "Spots",         badge: "SPOT", fg: "#f59e0b",              bg: "rgba(245, 158, 11, 0.14)", border: "rgba(245, 158, 11, 0.45)" },
  ANN:   { code: "ANN",   label: "Announcements", badge: "ANN",  fg: "var(--accent-cyan)",   bg: "rgb(from var(--accent-cyan) r g b / 0.14)", border: "rgb(from var(--accent-cyan) r g b / 0.45)" },
};

/** The order a filter control offers them in — most common first. */
export const CLASS_ORDER: ContentClass[] = ["MUSIC", "SPOT", "SWP", "ANN"];

/**
 * NULL and '' mean MUSIC. Every row written before v29 has no class, and the whole schema treats a
 * missing class as music — `(content_class IS NULL OR content_class = 'MUSIC')` is the idiom used
 * throughout. An unrecognised class falls back to MUSIC rather than vanishing: a row that aired must
 * always be shown, even if a future build wrote a class this one has never heard of.
 */
export function normalizeClass(v: string | null | undefined): ContentClass {
  const k = String(v ?? "").trim().toUpperCase();
  // A pre-v52 row still says JIN. Fold it into the one sweeper class so it keeps its badge, its
  // colour and its place under the Sweepers filter chip — rather than falling through to MUSIC and
  // vanishing into the music list, which is how a retired name causes real data loss on screen.
  if (k === LEGACY_SWEEPER) return SWEEPER;
  return (k in META ? k : "MUSIC") as ContentClass;
}

export function classMeta(v: string | null | undefined): ClassMeta {
  return META[normalizeClass(v)];
}

/**
 * Does this row pass the user's filter? `selected` is the set of classes the operator wants; an
 * EMPTY set means "show everything", which is the default state and the thing that must never be
 * confused with "show nothing".
 */
export function passesClassFilter(v: string | null | undefined, selected: ReadonlySet<string>): boolean {
  if (!selected || selected.size === 0) return true;
  return selected.has(normalizeClass(v));
}

/** The badge. Music renders nothing — a badge on almost every row is noise, not information. */
export function ClassBadge({ value, title }: { value: string | null | undefined; title?: string }) {
  const m = classMeta(value);
  if (m.code === "MUSIC") return null;
  return (
    <span title={title ?? m.label}
      style={{
        padding: "1px 5px", fontSize: 9, fontWeight: 800, fontFamily: "'DM Mono', monospace",
        color: m.fg, background: m.bg, border: `1px solid ${m.border}`,
        letterSpacing: "0.06em", verticalAlign: "middle", flexShrink: 0, whiteSpace: "nowrap",
      }}>{m.badge}</span>
  );
}

/**
 * The Zetta-style filter control: "All" plus one toggle per class. Nothing selected = everything
 * shown, and the control says so, because a filter row that looks armed when it is not is worse than
 * no filter at all.
 */
export function ClassFilter({ selected, onChange, counts }: {
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  /** Optional per-class row counts, so the operator can see what is there before narrowing to it. */
  counts?: Partial<Record<ContentClass, number>>;
}) {
  const all = selected.size === 0;
  const toggle = (c: ContentClass) => {
    const n = new Set(selected);
    n.has(c) ? n.delete(c) : n.add(c);
    onChange(n);
  };
  const base = {
    padding: "3px 9px", fontSize: 10, fontWeight: 700, cursor: "pointer",
    border: "1px solid var(--border-primary)", background: "var(--bg-secondary)",
    letterSpacing: "0.04em",
  } as const;
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
      <button onClick={() => onChange(new Set())} title="Show every element that aired"
        style={{ ...base, background: all ? "var(--accent-blue)" : "var(--bg-secondary)",
                 color: all ? "#fff" : "var(--text-tertiary)",
                 borderColor: all ? "var(--accent-blue)" : "var(--border-primary)" }}>ALL</button>
      {CLASS_ORDER.map(c => {
        const m = META[c];
        const on = selected.has(c);
        const n = counts?.[c];
        return (
          <button key={c} onClick={() => toggle(c)} title={`Show only ${m.label}`}
            style={{ ...base, color: on ? "#fff" : m.code === "MUSIC" ? "var(--text-secondary)" : m.fg,
                     background: on ? (m.code === "MUSIC" ? "var(--accent-blue)" : m.fg) : "var(--bg-secondary)",
                     borderColor: on ? "transparent" : "var(--border-primary)" }}>
            {m.label}{n != null ? ` ${n}` : ""}
          </button>
        );
      })}
    </div>
  );
}
