// src/lib/closingTime.ts — THE ONE WRITER of a station's closing time for given dates (2026-10-13).
//
// Jeff: "On Save, the closing time updates and every announcement timed from closing time moves with it, exactly as
// changing it in Preferences does (same code path, not a copy)." Preferences → Announcements and the Park page's Save
// (the `ops:set-closing` command from the phone) both call THIS. It merges byDate[date] = time for each date and touches
// nothing else — default and byWeekday are read and written back untouched (THE HARD RULE, Jeff 2026-08-31, pinned by
// scripts/smoke-closing-isolation.js). Announcements timed from closing are not rewritten: they are resolved against the
// day's closing time at the moment they fire (electron/main.js dueTimeFor), so they move with this write by construction.
// Then the Park page's mirror is re-pushed, so the phone shows the new announcement times at once.

export type ClosingCfg = { default: string | null; byWeekday: Record<string, string>; byDate: Record<string, string> };

export function parseClosingCfg(raw: string | null | undefined): ClosingCfg {
  const empty: ClosingCfg = { default: null, byWeekday: {}, byDate: {} };
  if (!raw) return empty;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object") return empty;
    return {
      default: typeof v.default === "string" ? v.default : null,
      byWeekday: (v.byWeekday && typeof v.byWeekday === "object") ? v.byWeekday : {},
      byDate: (v.byDate && typeof v.byDate === "object") ? v.byDate : {},
    };
  } catch { return empty; }   // corrupt value — replaced, never inherited half-parsed
}

/** Set the closing time for each of `dates` (YYYY-MM-DD) to `time` (HH:MM) on one station. */
export async function setClosingForDates(stationId: number, dates: string[], time: string): Promise<ClosingCfg> {
  const ether = (window as any).ether;
  const res: any = await ether?.stationConfigKv?.list?.(stationId);
  const kvRows: any[] = Array.isArray(res) ? res : (res?.rows ?? []);
  const cfg = parseClosingCfg(kvRows.find(r => r?.key === "closing_time" && !r?.deleted_at)?.value ?? null);
  const byDate = { ...cfg.byDate };
  for (const d of dates) byDate[d] = time;
  const next = { ...cfg, byDate };
  await ether.stationConfigKv.upsertByKey(stationId, "closing_time", JSON.stringify(next));
  window.dispatchEvent(new CustomEvent("ether:ops-push", { detail: { stationId } }));
  return next;
}
