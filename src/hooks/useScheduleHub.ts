// ── useScheduleHub — one store for the Schedule Manager's three panes (Phase B, 2026-08-10) ──────
//
// THE PROBLEM THIS SOLVES. Today each tab is mounted alone, so independent fetching is invisible.
// Put Shows, Clocks and Categories on screen at once and it becomes three bugs: `clocks` is fetched
// by both ShowsTab and ClocksTab, `categories` by both CategoriesTab and ClocksTab, and an edit in
// one pane leaves the others stale until they remount.
//
// THE RULES (design §3.2):
//   1. ONE FETCHER. This hook loads the shared entities. Panes receive them as props and never
//      fetch shared entities themselves.
//   2. ONE REFRESH PATH. A pane that writes calls onMutated(tables). The store re-reads everything
//      and bumps `revision`. There is no per-pane invalidation and no cross-pane messaging — a
//      selective-refresh scheme is where "why is that pane stale?" bugs come from, and the whole
//      read costs milliseconds.
//   3. READ ONLY. Writes stay on the existing ether.<table>.* IPC, because those paths are shared
//      with the remote web editor and must not fork. This store never writes.
//   4. SELECTION IS STATE, NOT NAVIGATION. Selecting a category does not change panels; panes derive
//      their highlighting from `selection`.
//
// NO UI USES THIS YET. Phase B is the invisible layer Phase C will consume.
// docs/schedule-manager-design-2026-08-10.md §3.2, §6.1
import { useState, useEffect, useCallback, useRef } from "react";
import { useActiveStation } from "./useActiveStation";
import {
  readShows, readClocks, readCategories, readSpotCategories,
  readClockSlots, readClockBreaks,
} from "../lib/scheduleData";
import type { Show, Clock, Category, ClockSlot, SpotCategory, ClockBreak } from "../components/scheduler/types";

export interface ScheduleSelection {
  showId: number | null;
  clockId: number | null;
  categoryId: number | null;
}

export interface ScheduleHub {
  // station-wide
  shows: Show[];
  clocks: Clock[];
  categories: Category[];
  spotCategories: SpotCategory[];
  // for the selected clock
  slots: ClockSlot[];
  breaks: ClockBreak[];

  selection: ScheduleSelection;
  selectShow: (showId: number | null) => void;
  selectClock: (clockId: number | null) => void;
  selectCategory: (categoryId: number | null) => void;

  /** Call after ANY write. Re-reads and bumps `revision`. `tables` is recorded, not used to
   *  narrow the refresh — see rule 2. */
  onMutated: (tables?: string[]) => void;
  /** Increments on every completed refresh. Panes can key effects off it. */
  revision: number;

  loading: boolean;
  error: string | null;
  stationId: number;
  isReady: boolean;
  /** The last tables passed to onMutated — for diagnostics only. */
  lastMutated: string[];
}

export function useScheduleHub(): ScheduleHub {
  const { stationId, isReady } = useActiveStation();

  const [shows, setShows] = useState<Show[]>([]);
  const [clocks, setClocks] = useState<Clock[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [spotCategories, setSpotCategories] = useState<SpotCategory[]>([]);
  const [slots, setSlots] = useState<ClockSlot[]>([]);
  const [breaks, setBreaks] = useState<ClockBreak[]>([]);

  const [selection, setSelection] = useState<ScheduleSelection>({ showId: null, clockId: null, categoryId: null });
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastMutated, setLastMutated] = useState<string[]>([]);

  // Every load carries a token. A station switch or a fast second refresh supersedes the one in
  // flight, and the stale result is dropped instead of overwriting fresher data — the same guard
  // useActiveStation itself uses for rapid station switches.
  const token = useRef(0);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // ── station-wide load ──────────────────────────────────────────────────────────────────────────
  const loadStation = useCallback(async () => {
    if (!isReady || !stationId) return;
    const t = ++token.current;
    setLoading(true);
    try {
      const [sh, cl, ca, sc] = await Promise.all([
        readShows(stationId),
        readClocks(stationId),
        readCategories(stationId),
        readSpotCategories(stationId),
      ]);
      if (!alive.current || t !== token.current) return;   // superseded
      setShows(sh); setClocks(cl); setCategories(ca); setSpotCategories(sc);
      setError(null);
    } catch (e: any) {
      if (!alive.current || t !== token.current) return;
      setError(e?.message || String(e));
    } finally {
      if (alive.current && t === token.current) setLoading(false);
    }
  }, [isReady, stationId]);

  // ── per-clock load ─────────────────────────────────────────────────────────────────────────────
  const loadClock = useCallback(async (clockId: number | null) => {
    if (!isReady || !stationId || !clockId) { setSlots([]); setBreaks([]); return; }
    const t = ++token.current;
    try {
      const [sl, br] = await Promise.all([
        readClockSlots(stationId, clockId),
        readClockBreaks(stationId, clockId),
      ]);
      if (!alive.current || t !== token.current) return;
      setSlots(sl); setBreaks(br);
    } catch (e: any) {
      if (!alive.current || t !== token.current) return;
      setError(e?.message || String(e));
    }
  }, [isReady, stationId]);

  // Load on mount and whenever the station changes. Selection is cleared on a station switch —
  // a show or clock id from the previous station means nothing here.
  useEffect(() => {
    setSelection({ showId: null, clockId: null, categoryId: null });
    setSlots([]); setBreaks([]);
    void loadStation();
  }, [loadStation]);

  useEffect(() => { void loadClock(selection.clockId); }, [selection.clockId, loadClock, revision]);

  // ── the ONE refresh path ───────────────────────────────────────────────────────────────────────
  const onMutated = useCallback((tables?: string[]) => {
    setLastMutated(tables || []);
    void (async () => {
      await loadStation();
      if (!alive.current) return;
      setRevision(r => r + 1);   // per-clock reload is keyed off revision in the effect above
    })();
  }, [loadStation]);

  // ── selection ──────────────────────────────────────────────────────────────────────────────────
  // Selecting a show focuses its clock (design §3.4) — the context link, derived here rather than
  // duplicated in whichever pane happens to handle the click.
  const selectShow = useCallback((showId: number | null) => {
    setSelection(prev => {
      if (showId == null) return { ...prev, showId: null };
      const show = shows.find(s => s.id === showId);
      return { ...prev, showId, clockId: show?.clock_id ?? prev.clockId };
    });
  }, [shows]);

  const selectClock = useCallback((clockId: number | null) => {
    setSelection(prev => ({ ...prev, clockId }));
  }, []);

  const selectCategory = useCallback((categoryId: number | null) => {
    setSelection(prev => ({ ...prev, categoryId: prev.categoryId === categoryId ? null : categoryId }));
  }, []);

  return {
    shows, clocks, categories, spotCategories, slots, breaks,
    selection, selectShow, selectClock, selectCategory,
    onMutated, revision,
    loading, error, stationId, isReady, lastMutated,
  };
}
