// Shared row shapes for the Schedule surfaces.
// Extracted verbatim from Scheduler.tsx (Phase A, 2026-08-10). NO FIELDS CHANGED.
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

