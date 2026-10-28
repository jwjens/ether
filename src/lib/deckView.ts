// THE A/B/C VIEW (Jeff, 2026-10-28): the music rotation decks A, B and C either show as three strips (expanded, exactly as
// before) or collapse into ONE strip that IS the playing deck's own fader. "While Deck A plays, it shows and controls A's
// fader, ON and PFL. When Deck B starts, the strip rotates right to B's fader … then C, then back to A."
// Collapsing or expanding is drawing only: never a level, never what plays. Saved per computer (board_view_decks, set
// locally) and in show presets (board.view.decks).

export type DeckId = "A" | "B" | "C";
export type DecksView = "collapsed" | "expanded";
export const DECKS: readonly DeckId[] = ["A", "B", "C"];
export const BOARD_VIEW_KEY = "board_view_decks";

export const parseDecksView = (v: unknown): DecksView => (v === "collapsed" ? "collapsed" : "expanded");

type Status = string | null | undefined;

/**
 * Which deck the collapsed strip shows. The deck that STARTED most recently: when B starts while A is still playing (a
 * crossfade), the strip goes to B. With nothing newly started it stays where it is; if what it shows has stopped and
 * another deck plays, it goes there. With nothing playing at all it keeps the last one (A at first).
 */
export function shownDeck(prevShown: DeckId | null, prev: Record<DeckId, Status>, now: Record<DeckId, Status>): DeckId {
  const started = DECKS.filter(d => now[d] === "playing" && prev[d] !== "playing");
  if (started.length) return started[started.length - 1];
  const cur = prevShown ?? "A";
  if (now[cur] === "playing") return cur;
  const playing = DECKS.find(d => now[d] === "playing");
  return playing ?? cur;
}

/** The board's slot order with A, B and C replaced by ONE entry where A was (collapsed), or unchanged (expanded). */
export const COLLAPSED_SLOT = "ABC";
export function viewOrder(order: readonly string[], view: DecksView): string[] {
  if (view !== "collapsed") return [...order];
  const out: string[] = [];
  for (const s of order) {
    if ((DECKS as readonly string[]).includes(s)) { if (!out.includes(COLLAPSED_SLOT)) out.push(COLLAPSED_SLOT); continue; }
    out.push(s);
  }
  return out;
}
