// boardName — ONE NAME PER FADER (Jeff's ruling, 2026-09-26): the board letter is the fader's only display name.
//
// Engine slot ids S1–S5 are internal (native/src/audio.rs deck_index) and are NEVER shown to the operator. Every
// place that names a fader — the strip, the rack window, the Aux Monitors rows, the Health Monitor, the show preset
// preview — asks this helper, so a channel is called the same thing everywhere.
//
// THE RULE: the board's slots in the order the board uses (its deck_configs rows, compareSlots — every row, enabled
// or not, so removing one channel never renames another), COMPLETED ONCE with every engine slot the rows don't list
// (in engine order). A lettered slot (A–F) is its own letter — reserved whether or not this board has a row for it,
// so S1 can never take E and collide the day E is added; CART is "CART"; each engine source slot (S1…) takes the next
// letter no lettered slot and no earlier source slot has. Default board: S1 → G … S5 → K.
//
// REGRESSION (2026-09-26, Jeff's screen "G H I J J"): a slot with no row used to be named "as if it came last" ON ITS
// OWN — so on a board with rows up to S3, S4 and S5 each came last and both became J. Completing the order once and
// naming everything in one pass makes a duplicate impossible (boardName.test.ts pins it with this machine's rows).

export const DEFAULT_BOARD_ORDER: readonly string[] = ["A", "B", "C", "D", "E", "F", "CART", "S1", "S2", "S3", "S4", "S5"];

const isLetter = (s: string) => /^[A-Z]$/.test(s);
const isEngineSource = (s: string) => /^S\d+$/.test(s);

/** The board's order completed with every engine slot it doesn't list (engine order). */
export function completeOrder(order: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of [...(order || []), ...DEFAULT_BOARD_ORDER]) { const k = String(s); if (!seen.has(k)) { seen.add(k); out.push(k); } }
  return out;
}

/** Every slot's board name, for a board whose slots come in `order` (completed — see the rule above). */
export function boardNames(order: readonly string[]): Record<string, string> {
  const list = completeOrder(order);
  const taken = new Set(list.filter(isLetter));
  const out: Record<string, string> = {};
  let next = "A".charCodeAt(0);
  for (const s of list) {
    if (!isEngineSource(s)) { out[s] = s; continue; }
    while (next <= "Z".charCodeAt(0) && taken.has(String.fromCharCode(next))) next++;
    const letter = next <= "Z".charCodeAt(0) ? String.fromCharCode(next++) : s;
    taken.add(letter);
    out[s] = letter;
  }
  return out;
}

/** One slot's board name. Computed from the COMPLETED order in one pass, so no two slots can share a name. */
export function boardName(slot: string, order: readonly string[] = DEFAULT_BOARD_ORDER): string {
  // No per-slot appending: the completed order already holds every engine slot, in one fixed place each.
  return boardNames(order)[slot] ?? String(slot);
}
