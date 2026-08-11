// ── Schedule Manager — Shows | Clocks | Categories in one workspace (Phase C, 2026-08-10) ────────
//
// The three surfaces have always been tabs: you could edit a clock or read a category's targets, but
// never both at once, and nothing told you they disagreed. This puts them side by side and links
// them: pick a category and the clocks using it light up; pick a show and its clock comes into
// focus; edit anything and all three refresh from one store.
//
// HOSTS, DOES NOT REWRITE. The panes are the same ShowsTab / ClocksTab / CategoriesTab the tabbed
// panel and the three popouts use. Every prop they take is optional with self-fetch as the default,
// so those surfaces are untouched — no dual implementations.
//
// ONE STORE. useScheduleHub is the only thing fetching shared entities; panes get props and report
// writes with onMutated. Writes themselves still go through the existing ether.<table>.* IPC — the
// paths shared with the remote web editor, which must not fork.
//
// FIXED THREE-PANE LAYOUT. No docking, no drag-resize, no saved layouts — cut deliberately; see the
// design doc for what adding dockview later would cost.
//
// docs/schedule-manager-design-2026-08-10.md · docs/help-schedule-manager.md
import { useEffect, useState, useMemo } from "react";
import { useScheduleHub } from "../hooks/useScheduleHub";
import { clocksUsingCategory } from "../lib/scheduleData";
import { ShowsTab } from "./scheduler/ShowsTab";
import { ClocksTab } from "./scheduler/ClocksTab";
import { CategoriesTab } from "./scheduler/CategoriesTab";
import type { ClockSlot } from "./scheduler/types";

type GoalRow = { categoryId: number; category: string; target: number; slots: number; delta: number; unused: boolean };
type GoalClock = { clockId: number; clock: string; musicSlots: number; rows: GoalRow[] };

const pane: React.CSSProperties = {
  background: "var(--bg-secondary)", border: "1px solid var(--border-primary)",
  display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, overflow: "hidden",
};
const paneHead: React.CSSProperties = {
  padding: "8px 12px", borderBottom: "1px solid var(--border-primary)", background: "var(--bg-tertiary)",
  fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-tertiary)",
  display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexShrink: 0,
};
const paneBody: React.CSSProperties = { flex: 1, minHeight: 0, overflowY: "auto", padding: 10 };

/** onOpenAnalytics is supplied by App — a real navigation, not a dispatched event nothing listens
 *  for. A link-out that looks like a link and does nothing is the decorative-control failure. */
export default function ScheduleManager({ onOpenAnalytics }: { onOpenAnalytics?: () => void } = {}) {
  const hub = useScheduleHub();
  const [goals, setGoals] = useState<GoalClock[]>([]);
  const [depth, setDepth] = useState<Record<number, { songs: number; needed: number; thin: boolean }>>({});

  // ── the advisor, on demand ─────────────────────────────────────────────────────────────────────
  // Same goalCheck the Station Health sense uses (§3.3). Refetched on mount, on station change, and
  // on every committed mutation via hub.revision — never per keystroke.
  useEffect(() => {
    let stop = false;
    (async () => {
      if (!hub.isReady || !hub.stationId) return;
      try {
        const r = await (window as any).ether?.invoke?.("library-health:goals", hub.stationId);
        if (!stop && r && Array.isArray(r.mismatches)) setGoals(r.mismatches);
        else if (!stop) setGoals([]);
      } catch { if (!stop) setGoals([]); }
      // Library-depth facts come from the same health snapshot the Rotation depth row uses — one
      // sense, two readers, rather than a second query that could disagree with it.
      try {
        const s = await (window as any).ether?.invoke?.("library-health:get");
        const st = s?.stations?.find((x: any) => x.stationId === hub.stationId);
        const map: Record<number, { songs: number; needed: number; thin: boolean }> = {};
        for (const d of (st?.depth || [])) map[d.categoryId] = { songs: d.songs, needed: d.needed, thin: d.thin };
        if (!stop) setDepth(map);
      } catch { /* depth is a nicety; its absence must not blank the panel */ }
    })();
    return () => { stop = true; };
  }, [hub.isReady, hub.stationId, hub.revision]);

  const advisorByClock = useMemo(() => {
    const m: Record<number, { rows: GoalRow[]; musicSlots: number }> = {};
    for (const g of goals) m[g.clockId] = { rows: g.rows, musicSlots: g.musicSlots };
    return m;
  }, [goals]);

  // Which clocks use the selected category. Derived from slots already in hand for the SELECTED
  // clock only — the hub does not hold every clock's slots, so this is honest about its scope:
  // it can light up the current clock, and the advisor covers the rest.
  const highlightClockIds = useMemo(() => {
    if (hub.selection.categoryId == null || !hub.selection.clockId) return [];
    const byClock = new Map<number, ClockSlot[]>([[hub.selection.clockId, hub.slots]]);
    return clocksUsingCategory(byClock, hub.selection.categoryId);
  }, [hub.selection.categoryId, hub.selection.clockId, hub.slots]);

  const selCat = hub.categories.find(c => c.id === hub.selection.categoryId);
  const selCatDepth = selCat ? depth[selCat.id] : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, height: "100%", minHeight: 0, fontFamily: "'Inter', system-ui, sans-serif" }}>

      {/* header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--text-primary)", margin: 0, fontFamily: "'Newsreader', Georgia, serif" }}>Schedule Manager</h1>
          <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
            {hub.loading ? "loading…" : `${hub.shows.length} shows · ${hub.clocks.length} clocks · ${hub.categories.length} categories`}
          </span>
        </div>
        {onOpenAnalytics && (
          <button
            onClick={onOpenAnalytics}
            style={{ padding: "6px 12px", borderRadius: 0, fontSize: 11, fontWeight: 600, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer" }}>
            Rotation Analytics →
          </button>
        )}
      </div>

      {hub.error && (
        <div style={{ padding: "10px 14px", background: "var(--bg-secondary)", border: "1px solid var(--accent-red)", fontSize: 12, color: "var(--accent-red)", flexShrink: 0 }}>{hub.error}</div>
      )}

      {/* context strip — what the current selection means, in words */}
      {selCat && (
        <div style={{ padding: "8px 14px", background: "rgba(167,139,250,0.10)", border: "1px solid var(--accent-purple)", fontSize: 12, color: "var(--text-secondary)", flexShrink: 0 }}>
          <strong style={{ color: "var(--text-primary)" }}>{selCat.name}</strong>
          {selCat.spins_per_hour > 0 ? ` · target ${selCat.spins_per_hour}/hr` : " · no target declared"}
          {selCatDepth ? ` · ${selCatDepth.songs} songs, needs ~${selCatDepth.needed}${selCatDepth.thin ? " — THIN" : ""}` : ""}
          {highlightClockIds.length > 0 ? " · used by the selected clock" : ""}
        </div>
      )}

      {/* three panes, fixed */}
      <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "minmax(240px, 1fr) minmax(360px, 1.6fr) minmax(260px, 1fr)", gap: 10 }}>

        <section style={pane}>
          <div style={paneHead}><span>Shows</span><span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>which clock airs when</span></div>
          <div style={paneBody}>
            <ShowsTab
              shows={hub.shows}
              clocks={hub.clocks}
              onMutated={hub.onMutated}
              selectedShowId={hub.selection.showId}
              onSelectShow={hub.selectShow}
            />
          </div>
        </section>

        <section style={pane}>
          <div style={paneHead}>
            <span>Clock</span>
            <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
              {hub.selection.clockId ? (hub.clocks.find(c => c.id === hub.selection.clockId)?.name || "") : "pick a show or clock"}
            </span>
          </div>
          <div style={paneBody}>
            <ClocksTab
              clocks={hub.clocks}
              cats={hub.categories}
              onMutated={hub.onMutated}
              clockId={hub.selection.clockId}
              onSelectClock={hub.selectClock}
              highlightClockIds={highlightClockIds}
              advisor={advisorByClock}
            />
          </div>
        </section>

        <section style={pane}>
          <div style={paneHead}><span>Categories</span><span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>targets &amp; depth</span></div>
          <div style={paneBody}>
            <CategoriesTab
              cats={hub.categories}
              onMutated={hub.onMutated}
              selectedCategoryId={hub.selection.categoryId}
              onSelectCategory={hub.selectCategory}
              depth={depth}
            />
          </div>
        </section>
      </div>
    </div>
  );
}
