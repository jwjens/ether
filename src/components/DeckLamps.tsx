// DeckLamps — the A B C lamps on the collapsed deck strip (src/lib/deckView.ts). Exactly ONE is lit: the deck the strip
// is showing. Jeff (2026-10-28): "Only one deck plays at a time, so only one lamp may be lit." The lit state comes from
// the single `shown` value, so two can never be lit in the same render (src/lib/deckLamps.behaviour.test.tsx).
import { DECKS, type DeckId } from "../lib/deckView";

export default function DeckLamps({ shown }: { shown: DeckId }) {
  return (
    <>
      {DECKS.map(d => (
        <span key={d} data-decks-lamp={d} data-lit={d === shown ? "1" : "0"}
              title={d === shown ? `Deck ${d} — this strip is Deck ${d}'s fader` : `Deck ${d}`}
              style={{ fontSize: 9, fontWeight: 800, padding: "0 4px", borderRadius: 2,
                       color: d === shown ? "#fff" : "var(--text-tertiary)", background: d === shown ? `var(--deck-${d.toLowerCase()})` : "transparent" }}>{d}</span>
      ))}
    </>
  );
}
