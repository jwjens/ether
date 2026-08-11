// ── layoutStore — the saved-workspace-layout contract (v2 Phase 2, 2026-08-10) ───────────────────
//
// Pulled out of ScheduleWorkspace so the STALE-LAYOUT FALLBACK can be tested. That path had never
// executed in the product — v1 was the only version that had ever existed — and Phase 2 is the
// release that makes it fire for every operator who has already used the workspace. A branch that
// runs for the first time on every install at once is not a branch to verify by reading.
//
// Pure: no React, no window, no IPC. The caller does the storage.
// docs/schedule-manager-v2-design-2026-08-10.md §6

/** The station_config_kv slot. NOT versioned in the key — the version lives INSIDE the payload, so
 *  an upgrade overwrites the old layout instead of orphaning a row per version forever. */
export const LAYOUT_KEY = "schedule_layout_v1";

/** The layout schema. Bump whenever the PANE SET changes: a saved layout only names panes, so after
 *  a change it describes a workspace that no longer exists — restoring it would leave new panes
 *  permanently absent while the Panels menu insists they are open.
 *  v1 → v2: added the Spots and Jingles panes.
 *  v2 → v3: added the Rotation Analytics pane. */
export const LAYOUT_VERSION = 3;

export interface StoredLayout { v: number; layout: unknown }

// ── the pane registry ────────────────────────────────────────────────────────────────────────────
/** Every pane the workspace can show. The Panels menu is generated from this, so a pane missing here
 *  would be closable with no way back — the 4.4.174 defect. Pure data, kept out of the component so
 *  the presets below can be checked against it by a test rather than by eye. */
export const PANELS = [
  { id: "shows", title: "Shows" },
  { id: "clocks", title: "Clocks" },
  { id: "categories", title: "Categories" },
  { id: "spots", title: "Spots" },
  { id: "jingles", title: "Jingles" },
  { id: "rotation", title: "Rotation Analytics" },
] as const;

export type PanelId = (typeof PANELS)[number]["id"];

// ── presets ──────────────────────────────────────────────────────────────────────────────────────
//
// A preset is an ARRANGEMENT, not a mode: it opens a set of panes in columns, and from that instant
// it is just your layout again — drag it, resize it, close panes, and it persists as normal. There
// is no preset "state" to get out of sync with the screen.
//
// Which is why THE STORED SHAPE IS UNCHANGED and LAYOUT_VERSION stays at 3. Recording "the active
// preset" would have added a field, invalidating every saved layout for the third build running,
// and bought only a tick in a menu — while inviting the lie where the stored name says Traffic and
// the screen has been rearranged into something else.
//
// Each column is a group; ids after the first in a column open as TABS in that group.
export interface LayoutPreset {
  id: string;
  title: string;
  /** One line, shown under the name — says who it is for, not what it contains. */
  description: string;
  columns: PanelId[][];
}

export const PRESETS: LayoutPreset[] = [
  {
    id: "programming",
    title: "Programming",
    description: "Build the hour: shows, clocks, and the categories they draw from.",
    columns: [["shows"], ["clocks"], ["categories", "jingles", "spots"]],
  },
  {
    id: "traffic",
    title: "Traffic",
    description: "Spot work: categories to pull from, and the breaks that place them.",
    columns: [["spots"], ["clocks"], ["jingles", "categories"]],
  },
  {
    id: "analysis",
    title: "Analysis",
    description: "What actually aired, next to the targets and clocks that asked for it.",
    columns: [["rotation"], ["categories", "shows"], ["clocks"]],
  },
];

/** The arrangement a fresh workspace opens with — Programming, by name rather than by duplication. */
export const DEFAULT_PRESET_ID = "programming";

/** Decide whether a stored payload is usable. null means "rebuild the default layout".
 *  Every failure — absent, empty, corrupt JSON, wrong shape, old version, missing layout — returns
 *  null rather than throwing. A saved layout is ergonomics; it must never be able to block the panel. */
export function parseSavedLayout(raw: string | null | undefined, version: number = LAYOUT_VERSION): any | null {
  if (!raw) return null;
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.v !== version) return null;          // stale (or a hand-edited payload with no version)
  return parsed.layout ?? null;
}

/** Stamp a layout for storage. Always writes the CURRENT version — the round trip is the contract. */
export function serializeLayout(layout: unknown): string {
  return JSON.stringify({ v: LAYOUT_VERSION, layout } satisfies StoredLayout);
}
