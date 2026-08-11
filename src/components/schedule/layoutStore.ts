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
 *  v1 → v2: added the Spots and Jingles panes. */
export const LAYOUT_VERSION = 2;

export interface StoredLayout { v: number; layout: unknown }

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
