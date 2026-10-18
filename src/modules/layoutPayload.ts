// A built surface as data — the payload of a screen_layouts row (v64; docs/screen-builder-design-2026-10-18.md §2.5).
//
//   { v: 1, dockview: <DockviewApi.toJSON()>, panes: { <panelId>: { type, instanceId, options } } }
//
// dockview owns the arrangement (splits, tabs, sizes); `panes` owns what each pane IS — which registered module, its
// instance id and its options. On restore the panes map is the authority: every dockview panel takes its params from
// it, and a pane whose type is not registered (or whose panel is missing) is dropped, never guessed.
// Nothing here touches the database or the DOM.

export interface PaneSpec {
  type: string;
  instanceId: string;
  options: Record<string, unknown>;
}

export interface LayoutDoc {
  v: 1;
  dockview: any;
  panes: Record<string, PaneSpec>;
}

/** The dockview component every pane uses: one renderer, and the pane's params say which module it is. */
export const PANE_COMPONENT = "module";

/** The panel ids in a serialized dockview layout. */
export function panelIdsOf(dockview: any): string[] {
  return dockview && dockview.panels && typeof dockview.panels === "object" ? Object.keys(dockview.panels) : [];
}

/** Build the saved document from dockview's toJSON() and the surface's panes. Panes dockview no longer has are dropped. */
export function buildLayoutDoc(dockview: any, panes: Record<string, PaneSpec>): LayoutDoc {
  const ids = new Set(panelIdsOf(dockview));
  const kept: Record<string, PaneSpec> = {};
  for (const [id, p] of Object.entries(panes)) {
    if (ids.has(id)) kept[id] = { type: p.type, instanceId: p.instanceId, options: { ...(p.options || {}) } };
  }
  return { v: 1, dockview: JSON.parse(JSON.stringify(dockview)), panes: kept };
}

/**
 * Read a saved document back. Throws on anything that is not a v1 layout. Panes of unknown type (not in `knownTypes`)
 * are dropped, and so is their dockview panel, so a layout saved by a newer build never renders a module this build
 * cannot place.
 */
export function parseLayoutDoc(input: string | unknown, knownTypes: readonly string[]): LayoutDoc {
  const doc: any = typeof input === "string" ? JSON.parse(input) : input;
  if (!doc || doc.v !== 1 || !doc.dockview || typeof doc.panes !== "object") throw new Error("not a v1 screen layout");
  const dockview = JSON.parse(JSON.stringify(doc.dockview));
  const panes: Record<string, PaneSpec> = {};
  for (const id of panelIdsOf(dockview)) {
    const p = doc.panes[id];
    if (p && knownTypes.includes(p.type) && typeof p.instanceId === "string") {
      panes[id] = { type: p.type, instanceId: p.instanceId, options: { ...(p.options || {}) } };
      // the panes map is the authority for what the pane is
      dockview.panels[id] = { ...dockview.panels[id], contentComponent: PANE_COMPONENT, params: panes[id] };
    }
  }
  const dropped = panelIdsOf(dockview).filter(id => !panes[id]);
  if (dropped.length) removePanels(dockview, new Set(dropped));
  return { v: 1, dockview, panes };
}

/** Remove panels from a serialized dockview grid (their entries and their tab-group references). */
function removePanels(dockview: any, ids: Set<string>) {
  for (const id of ids) delete dockview.panels[id];
  const walk = (node: any) => {
    if (!node) return;
    if (node.type === "leaf" && node.data) {
      node.data.views = (node.data.views || []).filter((v: string) => !ids.has(v));
      if (ids.has(node.data.activeView)) node.data.activeView = node.data.views[0];
    }
    if (Array.isArray(node.data)) node.data.forEach(walk);
  };
  walk(dockview.grid && dockview.grid.root);
}

/** A pane id unique within the surface: "<type>-<n>". */
export function nextPaneId(type: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  let n = 1;
  while (taken.has(`${type}-${n}`)) n++;
  return `${type}-${n}`;
}
