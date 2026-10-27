// removeSourceChannel — the board's "−": take a source channel off the board in ONE action (2026-10-27).
//
// Jeff's report (ovowforestmusic): "the "−" (Remove source channel) button does nothing for a source channel that has an
// input patched … SOURCE G (Link input …) and SOURCE H (Park patch "park:N" …) can't be removed. Clicking "−" shows the
// tooltip … but the column stays. Fix the root cause. No workaround that relies on the operator unpatching first."
//
// The old handler only set enabled:false on the slot's row. Three causes kept the column:
//   1. the patch stayed, so the engine kept the slot's input open (source_present), and the board shows every slot the
//      engine reports (src/lib/boardSlots.ts) — the column came straight back;
//   2. a slot with no row was not in the list, so the map changed nothing and an unchanged list was saved;
//   3. a Link-kind channel re-patches itself whenever no Link input is set (src/lib/linkPairing.ts), so releasing the
//      Link alone could be undone by the strip in another window.
//
// THE ORDER IS THE FIX. The row is marked OFF first — from that moment the channel is "explicitly removed": the board no
// longer shows it whatever the engine reports, and no window's Link auto-patch touches it. Then this slot's own inputs
// are released (its Park/mic patch, the Link if it is on THIS slot) and its deck stopped, so the engine stops reporting
// it. Nothing else is touched: no other channel, no programme, no air. If the engine REFUSES a step, the row is put back
// as it was and the reason is returned, to be shown next to the channel — never a silent no-op.
import type { DeckConfig } from "../components/DeckConfigurator";

export type StepResult = { ok: boolean; reason?: string };
export interface RemoveDeps {
  /** The board's rows as this window has them. */
  configs: DeckConfig[];
  /** Persist the whole board (useDeckConfig().save). */
  save: (configs: DeckConfig[]) => Promise<unknown>;
  /** This slot's stored input patch ({device:"park:2"} for a Park mic, a device for a mic), or null/undefined. */
  micPatch: { device: string } | null | undefined;
  /** Clear this slot's input patch (useMicInputs().setPatch(slot, null)). */
  clearMicPatch: () => Promise<StepResult>;
  /** Which slot the Link input is patched to on this machine, or null. */
  linkInputSlot: string | null;
  /** Release the Link input (useRemoteLink().setInput(null)). */
  releaseLink: () => Promise<StepResult>;
  /** Stop this slot's deck (engine.getDeck(slot).stop()) — a file-fed channel (announcement, jukebox) stops reporting. */
  stopDeck: () => Promise<unknown>;
}

/** The row that says "removed": the slot's own row with enabled:false, or a new one when the slot has none. */
export function removedRow(slot: string, existing: DeckConfig | undefined): DeckConfig {
  return existing ? { ...existing, enabled: false }
    : { slot, type: "source", kind: "", label: `Source ${slot}`, color: "#8868D8", enabled: false, purpose: "", address: null, duck: false } as DeckConfig;
}

export async function removeSourceChannel(slot: string, d: RemoveDeps): Promise<StepResult> {
  const before = d.configs;
  const existing = before.find(c => c.slot === slot);
  const removed = existing ? before.map(c => (c.slot === slot ? removedRow(slot, c) : c)) : [...before, removedRow(slot, undefined)];
  // 1. Off the board, for every window, before anything is released (no re-patch can race it).
  try { await d.save(removed); }
  catch (e: any) { return { ok: false, reason: `not removed — the board could not be saved: ${String(e?.message || e)}` }; }

  const putBack = async (reason: string): Promise<StepResult> => {
    try { await d.save(before); } catch { /* the reason below still says what failed */ }
    return { ok: false, reason };
  };
  // 2. Its own inputs — the Park mic / mic patch, and the Link when it is on THIS slot.
  if (d.micPatch && d.micPatch.device) {
    const r = await d.clearMicPatch().catch((e: any) => ({ ok: false, reason: String(e?.message || e) }));
    if (!r.ok) return putBack(`not removed — its input (${d.micPatch.device}) could not be unpatched: ${r.reason || "refused by the engine"}`);
  }
  if (d.linkInputSlot === slot) {
    const r = await d.releaseLink().catch((e: any) => ({ ok: false, reason: String(e?.message || e) }));
    if (!r.ok) return putBack(`not removed — the Link input could not be released: ${r.reason || "refused by the engine"}`);
  }
  // 3. Its deck — a file-fed channel stops. An empty slot answers "nothing loaded", which is not a failure.
  try { await d.stopDeck(); } catch { /* nothing loaded on it */ }
  return { ok: true };
}

/** Slots the operator removed (rows with enabled:false) — the board never brings these back on the engine's word. */
export function removedSlots(configs: readonly DeckConfig[] | null | undefined): string[] {
  return (configs || []).filter(c => c && c.enabled === false).map(c => c.slot);
}
