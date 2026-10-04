// deckConfigWrites.ts — how the renderer writes deck_configs rows (useDeckConfig in DeckConfigurator.tsx).
//
// Pure functions over the preload API (window.ether.deckConfigs), so the write shape is a test rather than a habit.
//
// ── A WHOLE-BOARD SAVE NEVER WRITES channel_on (RC5, OV station 2, 2026-10-04 04:00:04Z) ──────────────────────
// Source E was cut by a LOCAL save of the whole board: 9 rows in one burst, nothing but updated_at moving in the
// synced payload. Every writer on the board (add / kind / duck / ON / remove, and the configurator's Apply) saved
// EVERY row from the calling window's in-memory copy, channel_on included. The board renders in the dashboard AND in
// its own window, and the configurator keeps a snapshot taken when it opened — so any window holding a stale
// "E off" re-cut E on its next save of ANYTHING, with nothing on the wire to show it (channel_on is not a synced
// column).
//
// The ON lamp is a property of ONE channel and is written only by the act of pressing that channel's lamp:
// writeChannelOn → one deck_configs:update-by-slot for that slot, carrying channel_on alone. A whole-board save
// cannot carry it at all, so no stale copy of the board can cut or open a channel as a side effect.
import type { DeckConfig } from "../components/DeckConfigurator";

/** The slice of window.ether.deckConfigs these writers use (electron/preload-handlers.js). */
export interface DeckConfigsApi {
  updateBySlot: (stationId: number | null | undefined, slot: string, patch: Record<string, unknown>) => Promise<any>;
}

/** The row patch a whole-board save writes for one config. NO channel_on — see the note above. */
export function bulkRowPatch(c: DeckConfig): Record<string, unknown> {
  return {
    type: c.type, label: c.label, color: c.color,
    enabled: c.enabled ? 1 : 0, purpose: c.purpose || "",
    // SLICE 2 — the patch point travels with every save; address is written even while unused so Phase 2 needs
    // no migration.
    kind: c.kind || "", address: c.address ?? null, duck: c.duck ? 1 : 0,
  };
}

/** Write every row in `next`. Returns the failures (slot + error); never throws on a per-row {ok:false}. */
export async function writeBoard(api: DeckConfigsApi, stationId: number | null | undefined, next: DeckConfig[]) {
  const results = await Promise.all(next.map(async c => ({ slot: c.slot, res: await api.updateBySlot(stationId, c.slot, bulkRowPatch(c)) })));
  return results.filter(r => r.res && r.res.ok === false).map(r => ({ slot: r.slot, error: String(r.res.error || "unknown error") }));
}

/** THE ON LAMP — write ONE channel's channel_on and nothing else. Throws on a failed write. */
export async function writeChannelOn(api: DeckConfigsApi, stationId: number | null | undefined, slot: string, on: boolean) {
  const res = await api.updateBySlot(stationId, slot, { channel_on: on ? 1 : 0 });
  if (res && res.ok === false) throw new Error(`Could not save the ON lamp for ${slot}: ${res.error || "unknown error"}`);
  return res;
}
