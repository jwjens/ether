// ── ScheduleWorkspace — the docking shell (v2 Phase 1, 2026-08-10) ───────────────────────────────
//
// Shows, Clocks and Categories as dockable panes: drag, dock, stack, resize, close, reopen.
//
// HOW THE RENDER GUARD AND REACTIVITY COEXIST — read before changing the prop shape.
//
// Phase 0 measured the guard: with it, the shell rendered 0 times across 30 deck ticks while a pane
// was dragged; without it, 30. The guard is `memo` + referentially stable props, and it is fragile —
// one `onSomething={() => ...}` without useCallback reverts it silently.
//
// The first implementation of this file over-corrected: panes read the model through a REF so the
// dockview component map never had to be rebuilt. That kept the shell flat and broke the product —
// a ref mutating re-renders nothing, so panes never saw new props and clicking a clock did nothing
// (4.4.174). The tell was in the spike all along: pane render counts of 0/0/0 were not isolation,
// they were panes that never updated.
//
// The fix is CONTEXT, with the provider OUTSIDE the memoised shell:
//
//     <ModelCtx.Provider value={model}>     ← re-renders when data changes
//       <Workspace />                       ← memo, NO data props → never re-renders on a tick
//         └─ dockview → panes useModel()    ← context consumers DO re-render
//
// Context updates cross memo boundaries by design, so the panes stay live while the dockview tree
// itself stays still. `Workspace` deliberately takes no data props at all — the shape is the guard.
//
// docs/schedule-manager-v2-design-2026-08-10.md §1, §5, §6, §11
import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState, memo } from "react";
import { DockviewReact } from "dockview-react";
import type { DockviewApi, DockviewReadyEvent } from "dockview-react";
import "dockview/dist/styles/dockview.css";

import { useScheduleHub } from "../../hooks/useScheduleHub";
import { LAYOUT_KEY, parseSavedLayout, serializeLayout, PANELS, PRESETS, DEFAULT_PRESET_ID, type LayoutPreset } from "./layoutStore";
import { clocksUsingCategory } from "../../lib/scheduleData";
import { ShowsTab } from "../scheduler/ShowsTab";
import { ClocksTab } from "../scheduler/ClocksTab";
import { CategoriesTab } from "../scheduler/CategoriesTab";
import Spots from "../Spots";
import JinglesPanel from "../JinglesPanel";
import RotationAnalytics from "../RotationAnalytics";
import BroadcastCalendar from "../BroadcastCalendar";
import Logs from "../Logs";
import type { ClockSlot } from "../scheduler/types";

// ── dev instrumentation (kept from the Phase 0 spike) ────────────────────────────────────────────
const STATS_ON = (() => {
  try {
    if (typeof window === "undefined") return false;
    if (new URLSearchParams(window.location.search).get("dockstats") === "1") return true;
    return window.localStorage?.getItem("ether.dockstats") === "1";
  } catch { return false; }
})();
const renderCounts = { shell: 0, shows: 0, clocks: 0, categories: 0, spots: 0, jingles: 0, rotation: 0, log: 0, playlog: 0 };

export type GoalRow = { categoryId: number; category: string; target: number; slots: number; delta: number; unused: boolean };
type GoalClock = { clockId: number; clock: string; musicSlots: number; rows: GoalRow[] };

interface WorkspaceModel {
  hub: ReturnType<typeof useScheduleHub>;
  advisorByClock: Record<number, { rows: GoalRow[]; musicSlots: number }>;
  depth: Record<number, { songs: number; needed: number; thin: boolean }>;
  highlightClockIds: number[];
}

const ModelCtx = createContext<WorkspaceModel | null>(null);
const useModel = () => {
  const m = useContext(ModelCtx);
  if (!m) throw new Error("Schedule pane rendered outside the workspace provider");
  return m;
};

const MIN_PANE_PX = 220;

// PANELS and PRESETS are pure data in ./layoutStore, so a test can check every preset names a real
// pane and that no pane is unreachable from all of them.

// ── panes ────────────────────────────────────────────────────────────────────────────────────────
/** `flush` = no padding and NO outer scroll, for a pane that is already a full-height layout with a
 *  sticky toolbar and its own scroll region. Wrapping such a pane in the padded, scrolling frame
 *  gives it two scrollbars and pushes its toolbar out of view — which is exactly what the Log pane
 *  does, since it is the Calendar's day view whole. */
function PaneFrame({ children, flush }: { children: React.ReactNode; flush?: boolean }) {
  return (
    <div style={{
      height: "100%", background: "var(--bg-secondary)", borderRadius: "var(--r-0)", boxShadow: "var(--e-0)",
      ...(flush ? { overflow: "hidden", padding: 0 } : { overflowY: "auto", padding: "var(--s-4)" }),
    }}>
      {children}
    </div>
  );
}

// Module-scope and stable: rebuilding this map would remount every pane on each change.
const components = {
  shows: () => {
    if (STATS_ON) renderCounts.shows++;
    const { hub } = useModel();
    return (
      <PaneFrame>
        <ShowsTab shows={hub.shows} clocks={hub.clocks} onMutated={hub.onMutated}
          selectedShowId={hub.selection.showId} onSelectShow={hub.selectShow} />
      </PaneFrame>
    );
  },
  clocks: () => {
    if (STATS_ON) renderCounts.clocks++;
    const { hub, advisorByClock, highlightClockIds } = useModel();
    return (
      <PaneFrame>
        {/* hideSpotCategories: the Spots pane manages them here. Timed BREAKS stay on this pane —
            they belong to a clock. The clock editor still receives the category list, because the
            segment picker and the break rows name categories. */}
        <ClocksTab clocks={hub.clocks} cats={hub.categories} onMutated={hub.onMutated}
          clockId={hub.selection.clockId} onSelectClock={hub.selectClock}
          highlightClockIds={highlightClockIds} advisor={advisorByClock}
          spotCats={hub.spotCategories} hideSpotCategories />
      </PaneFrame>
    );
  },
  categories: () => {
    if (STATS_ON) renderCounts.categories++;
    const { hub, depth } = useModel();
    return (
      <PaneFrame>
        <CategoriesTab cats={hub.categories} onMutated={hub.onMutated}
          selectedCategoryId={hub.selection.categoryId} onSelectCategory={hub.selectCategory}
          depth={depth} />
      </PaneFrame>
    );
  },
  // Spots & Promos, the shipped traffic manager — hosted whole, not re-implemented. It already owned
  // spot-category create/rename/delete; a second category editor in this shell would have been a
  // third surface for one table.
  spots: () => {
    if (STATS_ON) renderCounts.spots++;
    const { hub } = useModel();
    return (
      <PaneFrame>
        <Spots onMutated={hub.onMutated} />
      </PaneFrame>
    );
  },
  // The JINGLES push-up stays the canonical imaging home (per CLAUDE.md); this is the same panel
  // hosted beside the clocks it feeds, not a rival surface.
  jingles: () => {
    if (STATS_ON) renderCounts.jingles++;
    const { hub } = useModel();
    if (!hub.stationId) return <PaneFrame><div style={{ color: "var(--text-tertiary)", fontSize: "var(--t-body)" }}>No station selected.</div></PaneFrame>;
    return (
      <PaneFrame>
        <JinglesPanel stationId={hub.stationId} onMutated={hub.onMutated} />
      </PaneFrame>
    );
  },
  // Read-only, and takes no hub props on purpose: it reports on what ALREADY AIRED, from play_log
  // and generated_schedule, not on the shows and clocks being edited beside it. Wiring it to the
  // store would imply an edit here changes the numbers, and it does not — those rows are history.
  // The loop is: declare targets in Categories, shape clocks against the advisor, read here.
  rotation: () => {
    if (STATS_ON) renderCounts.rotation++;
    return (
      <PaneFrame>
        <RotationAnalytics hideHeader />
      </PaneFrame>
    );
  },
  // ── THE LOG ────────────────────────────────────────────────────────────────────────────────────
  // The Calendar's day view, hosted whole — the same component, the same state, the same handlers.
  // Generate, pin, delete, inline edit and drag-to-reorder are not re-implemented here; they are the
  // ones the Calendar page has always used, which is why they behave identically. The Calendar page
  // stays exactly as it was: another door onto this room.
  //
  // It already renders on the SHARED DataGrid (4.4.200) — sortable headers, operator-resizable
  // columns persisted per station, dense rows, required empty state. So "reuse the grid, do not
  // invent a second one" is satisfied by hosting rather than by conversion; there was no second grid
  // to avoid building.
  //
  // Unlike Rotation Analytics — which is read-only history and deliberately takes no hub props —
  // this pane WRITES. So it takes onMutated and joins the workspace's one-store-one-refresh rule.
  log: () => {
    if (STATS_ON) renderCounts.log++;
    const { hub } = useModel();
    // Click a show → the log focuses that show's hours (the same scoping a show block on the week
    // grid applies). Deselect and it widens back to the whole day.
    const show = hub.shows.find(s => s.id === hub.selection.showId);
    return (
      <PaneFrame flush>
        <BroadcastCalendar
          hostedDayLog
          focusShow={show ? { name: show.name, startHour: show.start_hour, endHour: show.end_hour } : null}
          onMutated={hub.onMutated}
        />
      </PaneFrame>
    );
  },
  // ── PLAY LOG ───────────────────────────────────────────────────────────────────────────────────
  // The as-run record, hosted beside the plan that produced it. Read-only and permanent, so like
  // Rotation Analytics it takes NO hub props: nothing edited in this workspace can change what
  // already went to air, and wiring it to the store would imply otherwise.
  playlog: () => {
    if (STATS_ON) renderCounts.playlog++;
    return (
      <PaneFrame flush>
        <Logs hideHeader />
      </PaneFrame>
    );
  },
};

// ── the shell: NO data props, so memo actually holds ─────────────────────────────────────────────
function WorkspaceInner({ onReady }: { onReady: (e: DockviewReadyEvent) => void }) {
  if (STATS_ON) renderCounts.shell++;
  return <DockviewReact className="ether-dock dockview-theme-dark" components={components as any} onReady={onReady} />;
}
const Workspace = memo(WorkspaceInner);

// ── the panel ────────────────────────────────────────────────────────────────────────────────────
export default function ScheduleWorkspace({ onOpenAnalytics, onUseFixedLayout }: {
  onOpenAnalytics?: () => void;
  onUseFixedLayout?: () => void;
} = {}) {
  const hub = useScheduleHub();
  const [goals, setGoals] = useState<GoalClock[]>([]);
  const [depth, setDepth] = useState<Record<number, { songs: number; needed: number; thin: boolean }>>({});
  const [initialLayout, setInitialLayout] = useState<any | null | undefined>(undefined);
  const [openIds, setOpenIds] = useState<string[]>([]);
  const [panelsMenu, setPanelsMenu] = useState(false);
  const [, forceStats] = useState(0);

  const apiRef = useRef<DockviewApi | null>(null);
  const layoutRef = useRef<any | null>(null);
  layoutRef.current = initialLayout ?? null;

  // Advisor + depth — same goalCheck the Station Health sense uses, on demand (§3.3).
  useEffect(() => {
    let stop = false;
    (async () => {
      if (!hub.isReady || !hub.stationId) return;
      try {
        const r = await (window as any).ether?.invoke?.("library-health:goals", hub.stationId);
        if (!stop) setGoals(r && Array.isArray(r.mismatches) ? r.mismatches : []);
      } catch { if (!stop) setGoals([]); }
      try {
        const s = await (window as any).ether?.invoke?.("library-health:get");
        const st = s?.stations?.find((x: any) => x.stationId === hub.stationId);
        const map: Record<number, { songs: number; needed: number; thin: boolean }> = {};
        for (const d of (st?.depth || [])) map[d.categoryId] = { songs: d.songs, needed: d.needed, thin: d.thin };
        if (!stop) setDepth(map);
      } catch { /* depth is a nicety */ }
    })();
    return () => { stop = true; };
  }, [hub.isReady, hub.stationId, hub.revision]);

  // ── layout: load ───────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    let stop = false;
    (async () => {
      if (!hub.isReady || !hub.stationId) return;
      try {
        const raw = await (window as any).ether?.invoke?.("station_config_kv:get-value", hub.stationId, LAYOUT_KEY);
        if (!stop) setInitialLayout(parseSavedLayout(raw));
      } catch { if (!stop) setInitialLayout(null); }
    })();
    return () => { stop = true; };
  }, [hub.isReady, hub.stationId]);

  // ── layout: save (debounced; a drag fires continuously) ────────────────────────────────────────
  const saveTimer = useRef<any>(null);
  const stationRef = useRef(hub.stationId);
  stationRef.current = hub.stationId;
  const persist = useCallback((api: DockviewApi) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      try {
        const payload = serializeLayout(api.toJSON());
        // set-local: layouts are per-machine ergonomics. Syncing one would rearrange a colleague's screen.
        (window as any).ether?.invoke?.("station_config_kv:set-local", stationRef.current, LAYOUT_KEY, payload);
      } catch { /* a lost layout is cosmetic */ }
    }, 600);
  }, []);

  const addPanel = useCallback((api: DockviewApi, id: string, opts?: any) => {
    const def = PANELS.find(p => p.id === id);
    if (!def) return;
    api.addPanel({ id: def.id, component: def.id, title: def.title, ...(opts || {}) });
  }, []);

  // Declared before its callers: every useCallback below lists it as a dependency, and a dep array
  // is evaluated during render, so a later `const` would be a temporal-dead-zone crash on mount.
  const syncOpen = useCallback((api: DockviewApi) => {
    setOpenIds(api.panels.map(p => p.id));
    for (const g of api.groups) { try { (g as any).api?.setConstraints?.({ minimumWidth: MIN_PANE_PX, minimumHeight: 120 }); } catch {} }
  }, []);

  // A preset is COLUMNS of panes; anything after the first id in a column opens as a TAB in that
  // group. Three columns rather than six: at the 220px floor, six side by side would need 1,320px
  // before any one of them is usable, and the extras are surfaces you consult while working in the
  // first two, not ones to stare at continuously. Opening them rather than leaving them shut also
  // keeps the Panels button from reading "N hidden" on a fresh layout — announcing a problem that
  // isn't one.
  const applyPreset = useCallback((api: DockviewApi, preset: LayoutPreset) => {
    let prevColumnAnchor: string | null = null;
    for (const column of preset.columns) {
      const [first, ...tabs] = column;
      addPanel(api, first, prevColumnAnchor
        ? { position: { referencePanel: prevColumnAnchor, direction: "right" } }
        : undefined);
      for (const t of tabs) {
        // inactive: the column's first pane stays the visible tab.
        addPanel(api, t, { position: { referencePanel: first, direction: "within" }, inactive: true });
      }
      prevColumnAnchor = first;
    }
  }, [addPanel]);

  const buildDefault = useCallback((api: DockviewApi) => {
    applyPreset(api, PRESETS.find(p => p.id === DEFAULT_PRESET_ID) ?? PRESETS[0]);
  }, [applyPreset]);

  // Switching preset REPLACES the arrangement, like Reset layout — in place, no reload, session
  // untouched. From the moment it lands it is just your layout again: drag it, close panes, and it
  // persists as normal. Nothing remembers which preset you picked, because nothing should claim a
  // name for an arrangement you have since rearranged.
  const selectPreset = useCallback((preset: LayoutPreset) => {
    const api = apiRef.current;
    if (!api) return;
    try {
      for (const p of [...api.panels]) api.removePanel(p);
      applyPreset(api, preset);
      syncOpen(api);
    } catch { /* leave whatever is on screen rather than blanking it */ }
  }, [applyPreset, syncOpen]);

  // Stable: onReady fires once, so reading the layout through a ref here is safe — unlike pane data,
  // which must be reactive and therefore goes through context.
  const onReady = useCallback((event: DockviewReadyEvent) => {
    const api = event.api;
    apiRef.current = api;
    let restored = false;
    if (layoutRef.current) {
      // A corrupt or stale layout must never block the panel. Phase 2 made every saved v1 layout
      // stale by adding panes; the version gate above already turned those into null, so this only
      // ever sees a v2 layout. The try/catch stays for a corrupt payload: fall through to defaults.
      // `panels.length > 0` is the second guard — a layout that parses to an EMPTY workspace is
      // indistinguishable from a broken one to the operator, so it is rebuilt rather than shown.
      try { api.fromJSON(layoutRef.current); restored = api.panels.length > 0; } catch { restored = false; }
    }
    if (!restored) buildDefault(api);
    syncOpen(api);
    api.onDidLayoutChange(() => { persist(api); syncOpen(api); });
  }, [buildDefault, syncOpen, persist]);

  // ── Focus a pane from outside ──────────────────────────────────────────────────────────────────
  // Schedule ▸ Program Log opens this workspace and asks for that pane. It REOPENS the pane first
  // if the operator had closed it: a menu item that lands on a workspace where the thing it just
  // named is hidden is a door onto a wall.
  useEffect(() => {
    const onFocusPane = (e: Event) => {
      const id = String((e as CustomEvent).detail || "");
      const api = apiRef.current;
      if (!api || !PANELS.some(p => p.id === id)) return;
      if (!api.panels.find(p => p.id === id)) {
        const anchor = api.panels[api.panels.length - 1];
        addPanel(api, id, anchor ? { position: { referencePanel: anchor.id, direction: "right" } } : undefined);
        syncOpen(api);
      }
      try { (api.panels.find(p => p.id === id) as any)?.api?.setActive?.(); }
      catch { /* focus is a nicety, never a blocker */ }
    };
    window.addEventListener("ether:focus-schedule-pane", onFocusPane);
    return () => window.removeEventListener("ether:focus-schedule-pane", onFocusPane);
  }, [addPanel, syncOpen]);

  // ── Panels menu: close is reversible ───────────────────────────────────────────────────────────
  const togglePanel = useCallback((id: string) => {
    const api = apiRef.current;
    if (!api) return;
    const existing = api.panels.find(p => p.id === id);
    if (existing) { api.removePanel(existing); }
    else {
      const anchor = api.panels[api.panels.length - 1];
      addPanel(api, id, anchor ? { position: { referencePanel: anchor.id, direction: "right" } } : undefined);
    }
    syncOpen(api);
  }, [addPanel, syncOpen]);

  // ── Reset Layout: IN PLACE. No reload, no navigation, session untouched. ───────────────────────
  // 4.4.174 called window.location.reload() here, which dropped App's in-memory `accountSignedIn`
  // (App.tsx:571) and dumped the operator on the sign-in screen. A layout control must touch the
  // layout and nothing else.
  const resetLayout = useCallback(async () => {
    const api = apiRef.current;
    try { await (window as any).ether?.invoke?.("station_config_kv:set-local", stationRef.current, LAYOUT_KEY, ""); } catch {}
    if (!api) return;
    try {
      for (const p of [...api.panels]) api.removePanel(p);
      buildDefault(api);
      syncOpen(api);
    } catch { /* leave whatever is on screen rather than blanking it */ }
  }, [buildDefault, syncOpen]);

  const advisorByClock = useMemo(() => {
    const m: Record<number, { rows: GoalRow[]; musicSlots: number }> = {};
    for (const g of goals) m[g.clockId] = { rows: g.rows, musicSlots: g.musicSlots };
    return m;
  }, [goals]);

  const highlightClockIds = useMemo(() => {
    if (hub.selection.categoryId == null || !hub.selection.clockId) return [];
    const byClock = new Map<number, ClockSlot[]>([[hub.selection.clockId, hub.slots]]);
    return clocksUsingCategory(byClock, hub.selection.categoryId);
  }, [hub.selection.categoryId, hub.selection.clockId, hub.slots]);

  const model = useMemo<WorkspaceModel>(
    () => ({ hub, advisorByClock, depth, highlightClockIds }),
    [hub, advisorByClock, depth, highlightClockIds]
  );

  const selCat = hub.categories.find(c => c.id === hub.selection.categoryId);
  const selCatDepth = selCat ? depth[selCat.id] : undefined;
  const missing = PANELS.filter(p => !openIds.includes(p.id));

  const btn: React.CSSProperties = {
    padding: "var(--s-3) var(--s-5)", borderRadius: "var(--r-0)", fontSize: "var(--t-small)", fontWeight: 700,
    letterSpacing: "0.06em", textTransform: "uppercase", background: "var(--bg-secondary)",
    border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer", boxShadow: "var(--e-0)",
  };

  if (initialLayout === undefined) {
    return <div style={{ padding: "var(--s-7)", color: "var(--text-tertiary)", fontSize: "var(--t-body)" }}>Loading workspace…</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)", height: "100%", minHeight: 0, fontFamily: "'Inter', system-ui, sans-serif" }}>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "var(--s-4)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "var(--s-5)" }}>
          <h1 style={{ fontSize: "var(--t-lead)", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-secondary)", margin: 0 }}>Schedule Manager</h1>
          <span style={{ fontSize: "var(--t-small)", color: "var(--text-tertiary)", letterSpacing: "0.04em" }}>
            {hub.loading ? "LOADING" : `${hub.shows.length} SHOWS · ${hub.clocks.length} CLOCKS · ${hub.categories.length} CATEGORIES`}
          </span>
        </div>

        <div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap", position: "relative" }}>
          {STATS_ON && (
            <span style={{ ...btn, cursor: "default", fontFamily: "'DM Mono', monospace", color: "var(--accent-amber)" }}
              onClick={() => forceStats(n => n + 1)}>
              shell {renderCounts.shell} · s{renderCounts.shows} c{renderCounts.clocks} k{renderCounts.categories} p{renderCounts.spots} j{renderCounts.jingles} r{renderCounts.rotation} L{renderCounts.log}
            </span>
          )}

          {/* Panels — the way back from an X. Amber when something is closed, so a missing pane
              reads as recoverable rather than lost. */}
          <button
            style={{ ...btn, ...(missing.length ? { borderColor: "var(--accent-amber)", color: "var(--accent-amber)" } : {}) }}
            onClick={() => setPanelsMenu(v => !v)}>
            Panels{missing.length ? ` (${missing.length} hidden)` : ""}
          </button>
          {panelsMenu && (
            <>
              <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={() => setPanelsMenu(false)} />
              <div style={{ position: "absolute", top: "calc(100% + var(--s-2))", right: 0, zIndex: 41, minWidth: 240, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", boxShadow: "var(--e-float)" }}>
                {PANELS.map(p => {
                  const open = openIds.includes(p.id);
                  return (
                    <button key={p.id} onClick={() => togglePanel(p.id)}
                      style={{ display: "flex", alignItems: "center", gap: "var(--s-3)", width: "100%", padding: "var(--s-3) var(--s-4)", background: "transparent", border: "none", borderBottom: "1px solid var(--border-primary)", color: open ? "var(--text-primary)" : "var(--text-tertiary)", fontSize: "var(--t-body)", cursor: "pointer", textAlign: "left" }}>
                      <span style={{ width: 12, fontFamily: "'DM Mono', monospace" }}>{open ? "✓" : ""}</span>{p.title}
                    </button>
                  );
                })}
                {/* Layouts: named arrangements, not modes. Picking one replaces the arrangement and
                    then gets out of the way — from that moment it is your layout again. */}
                <div style={{ padding: "var(--s-3) var(--s-4) var(--s-2)", borderTop: "1px solid var(--border-primary)", fontSize: "var(--t-micro)", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-tertiary)" }}>
                  Layouts
                </div>
                {PRESETS.map(p => (
                  <button key={p.id} onClick={() => { selectPreset(p); setPanelsMenu(false); }} title={p.description}
                    style={{ display: "block", width: "100%", padding: "var(--s-3) var(--s-4)", background: "transparent", border: "none", borderBottom: "1px solid var(--border-primary)", color: "var(--text-primary)", fontSize: "var(--t-body)", cursor: "pointer", textAlign: "left" }}>
                    {p.title}
                    <div style={{ fontSize: "var(--t-small)", color: "var(--text-tertiary)", marginTop: 2, whiteSpace: "normal" }}>{p.description}</div>
                  </button>
                ))}
                <button onClick={() => { resetLayout(); setPanelsMenu(false); }}
                  style={{ width: "100%", padding: "var(--s-3) var(--s-4)", background: "transparent", border: "none", color: "var(--accent-blue)", fontSize: "var(--t-body)", fontWeight: 700, cursor: "pointer", textAlign: "left" }}>
                  Reset layout
                </button>
              </div>
            </>
          )}

          <button style={btn} onClick={resetLayout}>Reset layout</button>
          {onUseFixedLayout && <button style={btn} onClick={onUseFixedLayout}>Fixed layout</button>}
          {onOpenAnalytics && <button style={btn} onClick={onOpenAnalytics}>Rotation Analytics →</button>}
        </div>
      </div>

      {hub.error && (
        <div style={{ padding: "var(--s-3) var(--s-5)", background: "var(--bg-secondary)", border: "1px solid var(--accent-red)", fontSize: "var(--t-body)", color: "var(--accent-red)", flexShrink: 0 }}>{hub.error}</div>
      )}

      {selCat && (
        <div style={{ padding: "var(--s-3) var(--s-5)", background: "var(--bg-tertiary)", border: "1px solid var(--accent-purple)", fontSize: "var(--t-body)", color: "var(--text-secondary)", flexShrink: 0 }}>
          <strong style={{ color: "var(--text-primary)" }}>{selCat.name}</strong>
          {selCat.spins_per_hour > 0 ? ` · target ${selCat.spins_per_hour}/hr` : " · no target declared"}
          {selCatDepth ? ` · ${selCatDepth.songs} songs, needs ~${selCatDepth.needed}${selCatDepth.thin ? " — THIN" : ""}` : ""}
          {highlightClockIds.length > 0 ? " · used by the selected clock" : ""}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, border: "1px solid var(--border-primary)" }}>
        <ModelCtx.Provider value={model}>
          <Workspace onReady={onReady} />
        </ModelCtx.Provider>
      </div>
    </div>
  );
}
