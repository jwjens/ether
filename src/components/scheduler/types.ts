// Shared row shapes for the Schedule surfaces.
// Extracted verbatim from Scheduler.tsx (Phase A, 2026-08-10). NO FIELDS CHANGED.
//
// THIS IS THE ONE PLACE. src/lib/scheduleData.ts imports from here rather than declaring its own
// Show/Clock/Category/ClockSlot — a second set would be the two-definitions-that-drift disease on
// day one of the data layer, which is exactly what today's duplicate-menu hunt cost.
// Phase B (2026-08-10) added SpotCategory and ClockBreak: both shapes already existed, inline and
// untyped, inside ClocksTab's useState calls. Naming them here rather than in scheduleData.ts keeps
// the rule intact.
export interface Show {
  id: number; name: string; start_hour: number; end_hour: number;
  days: string; color: string | null; description: string | null;
  is_active: number; clock_id: number | null; clock_name: string | null;
}

export interface Category {
  id: number; uuid?: string; code: string; name: string; color: string | null;
  spins_per_hour: number; priority: number; song_count?: number;
}

export interface Clock {
  id: number; name: string; show_id: number | null;
  description: string | null; color: string | null;
}

export interface ClockSlot {
  id: number; clock_id: number; position: number;
  slot_type: string; category_id: number | null;
  song_id?: number | null;
  spot_type?: string | null;
  spot_category_id?: number | null;
  label: string | null; duration_min: number;
  chain_type?: string;
  category_code?: string; category_color?: string;
  spot_category_name?: string | null; spot_category_color?: string | null;
  song_title?: string | null; song_artist?: string | null;
  cart_id?: string | null;
}


/** Spot category — the traffic buckets a clock's spot breaks draw from.
 *  Was an inline shape in ClocksTab's useState; named here in Phase B. */
export interface SpotCategory {
  id: number; uuid: string; name: string; color: string | null;
}

/** A timed spot break on a clock (v26 clock_breaks): "3 spots at :20".
 *  Was an inline shape in ClocksTab's useState; named here in Phase B. */
export interface ClockBreak {
  id: number; uuid: string; clock_id?: number;
  minute: number; spot_category_id: number | null; count: number;
}
