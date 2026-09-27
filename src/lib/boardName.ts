// boardName — ONE NAME PER FADER (Jeff's ruling, 2026-09-26): the board letter is the fader's only display name.
//
// Engine slot ids S1–S5 are internal (native/src/audio.rs deck_index) and are NEVER shown to the operator. Every
// place that names a fader — the strip, the rack window, the Aux Monitors rows, the Health Monitor, the show preset
// preview — asks this helper, so a channel is called the same thing everywhere.
//
// THE RULE: walk the board's slots in the order the board uses (its deck_configs rows, compareSlots — every row,
// enabled or not, so removing one channel never renames another). A lettered slot (A–F) is its own letter; CART is
// "CART"; each engine source slot (S1…) takes the next letter that no lettered slot on this board uses and no
// earlier source slot has taken. On the default board (A–F, CART, S1–S5) that is S1 → G … S5 → K.

export const DEFAULT_BOARD_ORDER: readonly string[] = ["A", "B", "C", "D", "E", "F", "CART", "S1", "S2", "S3", "S4", "S5"];

const isLetter = (s: string) => /^[A-Z]$/.test(s);
const isEngineSource = (s: string) => /^S\d+$/.test(s);

/** Every slot's board name, for a board whose slots come in `order`. */
export function boardNames(order: readonly string[]): Record<string, string> {
  const list = (order && order.length ? order : DEFAULT_BOARD_ORDER).map(String);
  const taken = new Set(list.filter(isLetter));
  const out: Record<string, string> = {};
  let next = "A".charCodeAt(0);
  for (const s of list) {
    if (s in out) continue;
    if (!isEngineSource(s)) { out[s] = s; continue; }
    while (next <= "Z".charCodeAt(0) && taken.has(String.fromCharCode(next))) next++;
    const letter = next <= "Z".charCodeAt(0) ? String.fromCharCode(next++) : s;
    taken.add(letter);
    out[s] = letter;
  }
  return out;
}

/** One slot's board name. A slot the order doesn't list is named as if it came last. */
export function boardName(slot: string, order: readonly string[] = DEFAULT_BOARD_ORDER): string {
  const list = order && order.length ? order : DEFAULT_BOARD_ORDER;
  return boardNames(list.includes(slot) ? list : [...list, slot])[slot] ?? String(slot);
}
