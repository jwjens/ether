// Shared constants + formatters for the Schedule surfaces.
// Extracted verbatim from Scheduler.tsx (Phase A, 2026-08-10). NO LOGIC CHANGED.
//
// NOTE: SLOT_TYPES, slotColor, slotLabel, ClockWheel and ClockSkeleton were deliberately NOT moved.
// They are a dead island in Scheduler.tsx: ClockWheel is the only consumer of slotColor/slotLabel and
// is itself never rendered, and ClocksTab defines its own local slotColor. Left in place so Phase A
// stays a pure move; flagged for the same sweep as ClockEditor.tsx.
export const HOURS = Array.from({length: 24}, (_, i) => i);
export const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const CLOCK_SLOT_TYPE_OPTIONS = [
  { value: "music",      label: "Song",    color: "var(--accent-blue)" },
  { value: "spot_break", label: "Spots",     color: "#ef4444" },
  { value: "talk_break", label: "Talk break", color: "#a78bfa" },
  { value: "liner",      label: "Liner",   color: "#34d399" },
  { value: "sweeper",    label: "Sweeper", color: "#f59e0b" },
];


export function fmtHour(h: number): string {
  if (h === 0) return "12 AM";
  if (h === 12) return "12 PM";
  return h < 12 ? h + " AM" : (h - 12) + " PM";
}


export function fmtClockPos(totalMin: number): string {
  const m = Math.floor(totalMin);
  const s = Math.round((totalMin - m) * 60);
  return `:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}
