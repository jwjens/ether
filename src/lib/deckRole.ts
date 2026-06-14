import type { DeckState } from "../audio/engine-rodio";

export type DeckId = "A" | "B" | "C";
export type DeckRole = "playing" | "next" | "third";

export type DeckStates = { A: DeckState | null; B: DeckState | null; C: DeckState | null };

// Role of a deck in the live A→B→C rotation, used to color-code the queue decks:
//   playing → the deck on air (gets the duration-progress animation)
//   next    → the next cued deck after the playing one, cyclically (pulses)
//   third   → any other deck, or all decks when nothing is on air (solid)
// A deck counts as "cued" (eligible to be next) if it holds a loaded track (has a title).
export function computeDeckRole(deckId: DeckId, decks: DeckStates): DeckRole {
  const order: DeckId[] = ["A", "B", "C"];
  const playing = order.find(id => decks[id]?.status === "playing") || null;
  if (deckId === playing) return "playing";
  if (!playing) return "third";

  const cued = (d: DeckState | null) => !!d && !!d.title;
  const startIdx = order.indexOf(playing);
  let nextId: DeckId | null = null;
  for (let i = 1; i <= 2; i++) {
    const cand = order[(startIdx + i) % 3];
    if (cued(decks[cand])) { nextId = cand; break; }
  }
  return deckId === nextId ? "next" : "third";
}
