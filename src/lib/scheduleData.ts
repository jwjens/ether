// ── scheduleData — typed reads for the Schedule surfaces (Phase B, 2026-08-10) ───────────────────
//
// READ ONLY. Every function here is a SELECT or a `.list()`. There is deliberately no create/update/
// delete: the write paths are shared with the remote web editor (dashboard → /api/cmd → SSE →
// execCmd → applyDbMutation converges on the same tables the panes write through), and a second
// write layer would fork them. Panes keep calling `window.ether.<table>.*` exactly as they do today.
//
// TYPES COME FROM ../components/scheduler/types. This module declares none of its own. Phase A
// pulled Show/Category/Clock/ClockSlot into one file precisely so a data layer could not introduce a
// second set, and Phase B added SpotCategory/ClockBreak there for the same reason.
//
// The queries below are the ones the tabs already issue, kept verbatim so the hub cannot serve
// subtly different data than the panes fetch for themselves. Where two tabs disagreed, the
// difference is called out at the function.
//
// This is also the first instance of the typed IPC layer the audit named as refactor #3
// ("no data layer — every component calls window.ether.invoke directly"). It is scoped to Schedule
// on purpose: one feature's worth, reusable, rather than a speculative framework.
//
// docs/schedule-manager-design-2026-08-10.md §3.2, §6.1
import { queryScoped } from "../db/stationScoped";
import type { Show, Clock, Category, ClockSlot, SpotCategory, ClockBreak } from "../components/scheduler/types";

/** `window.ether` is untyped at the boundary; keep the cast in ONE place rather than at every call. */
const ether = (): any => (window as any).ether;

// ── station-wide entities ────────────────────────────────────────────────────────────────────────

/** Shows with their clock's name joined, ordered by start hour — as ShowsTab reads them. */
export async function readShows(stationId: number): Promise<Show[]> {
  return await queryScoped<Show>(
    "SELECT s.*, c.name as clock_name FROM shows s LEFT JOIN clocks c ON c.id = s.clock_id WHERE s.station_id = ? AND s.deleted_at IS NULL ORDER BY s.start_hour",
    [stationId], stationId, { skipScoping: true }
  ) || [];
}

/** Clocks, ordered by name — as both ShowsTab and ClocksTab read them. */
export async function readClocks(stationId: number): Promise<Clock[]> {
  return await queryScoped<Clock>(
    "SELECT * FROM clocks WHERE deleted_at IS NULL ORDER BY name", [], stationId
  ) || [];
}

/**
 * Categories with their song counts.
 *
 * The two tabs disagreed: CategoriesTab selects song_count and orders by code; ClocksTab selects
 * bare rows and orders by priority, code. This takes the SUPERSET — song_count included, ordered by
 * priority then code — so either pane can be served from one read. Ordering by priority first is
 * the more useful default and is what ClocksTab (the busier consumer) already used.
 */
export async function readCategories(stationId: number): Promise<Category[]> {
  return await queryScoped<Category>(
    `SELECT c.*, (SELECT COUNT(*) FROM songs WHERE category_id = c.id) as song_count
       FROM categories c
      WHERE c.station_id = ? AND c.deleted_at IS NULL
      ORDER BY c.priority, c.code`,
    [stationId], stationId, { skipScoping: true }
  ) || [];
}

/** Spot categories — via the sync handler's list IPC, which is how ClocksTab gets them. */
export async function readSpotCategories(stationId: number): Promise<SpotCategory[]> {
  try {
    const res = await ether()?.spotCategories?.list(stationId);
    return (res?.rows) || [];          // the IPC contract is { rows: [...] } — unwrap it here, once
  } catch { return []; }
}

// ── per-clock entities ───────────────────────────────────────────────────────────────────────────

/** Slots for one clock, with category and spot-category display fields joined — as ClocksTab reads. */
export async function readClockSlots(stationId: number, clockId: number): Promise<ClockSlot[]> {
  if (!clockId) return [];
  return await queryScoped<ClockSlot>(
    `SELECT cs.*, c.code as category_code, c.color as category_color,
            sc.name as spot_category_name, sc.color as spot_category_color
       FROM clock_slots cs
       LEFT JOIN categories c ON c.id = cs.category_id
       LEFT JOIN spot_categories sc ON sc.id = cs.spot_category_id
      WHERE cs.clock_id = ? AND cs.station_id = ? AND cs.deleted_at IS NULL
      ORDER BY cs.position`,
    [clockId, stationId], stationId, { skipScoping: true }
  ) || [];
}

/** Timed spot breaks for one clock (v26). */
export async function readClockBreaks(stationId: number, clockId: number): Promise<ClockBreak[]> {
  if (!clockId) return [];
  try {
    const res = await ether()?.clockBreaks?.list(stationId, { clockId });
    return ((res?.rows) || []).map((r: any) => ({
      id: r.id, uuid: r.uuid, clock_id: r.clock_id,
      minute: r.minute, spot_category_id: r.spot_category_id, count: r.count,
    }));
  } catch { return []; }
}

// ── derived facts (no extra fetch) ───────────────────────────────────────────────────────────────

/**
 * Which clocks use a category, derived from slots already in hand.
 * Context linking (design §3.4) is a derivation, not a query — highlighting a category's clocks must
 * not cost a round trip per hover.
 */
export function clocksUsingCategory(slotsByClock: Map<number, ClockSlot[]>, categoryId: number): number[] {
  const out: number[] = [];
  for (const [clockId, slots] of slotsByClock) {
    if (slots.some(s => s.slot_type === "music" && s.category_id === categoryId)) out.push(clockId);
  }
  return out;
}

/** Music-slot count per category for one clock — the input the goal advisor compares against. */
export function musicSlotCounts(slots: ClockSlot[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const s of slots) {
    if (s.slot_type !== "music" || s.category_id == null) continue;
    m.set(s.category_id, (m.get(s.category_id) || 0) + 1);
  }
  return m;
}
