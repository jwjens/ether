// boardSlots — the ONE answer to "what channels does the board show".
//
// THE INVARIANT THIS FILE EXISTS TO ENFORCE:
//
//     A slot the engine is carrying is ALWAYS on the board.
//
// There used to be two answers to "what channels exist" and nothing reconciled them: the engine's
// `bus.decks[]` (membership = summed into master) and the database's `deck_configs` rows (membership
// = visible and controllable). The CART slot was in the first and not the second, so it aired with
// no strip, no fader, no cut and no meter — a state a mixer should not be able to express, and the
// one that cost a full day of chasing a channel nobody could see.
//
// Configuration decides ORDER and LABEL. The engine decides EXISTENCE. Keeping that split in a pure
// function is what lets the rule be a TEST rather than a habit — see boardSlots.test.ts.
//
// docs/on-air-but-invisible-slot-enumeration-2026-09-03.md

/**
 * The board's channel list.
 *
 * @param configured  enabled deck_configs slots, in the operator's order
 * @param engineLive  slot ids the engine reports as carrying audio (source loaded or mixer pulling)
 * @returns the configured order, followed by any live engine slot the configuration does not mention
 */
export function boardSlots(configured: readonly string[], engineLive: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of configured) {
    if (!s || seen.has(s)) continue;      // a duplicate row must not produce two strips
    seen.add(s);
    out.push(s);
  }
  for (const s of engineLive) {
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}
