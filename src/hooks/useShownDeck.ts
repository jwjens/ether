// useShownDeck — which deck the collapsed A/B/C strip shows (src/lib/deckView.ts shownDeck), from the decks' statuses.
//
// The previous statuses are CAPTURED before they are replaced. The first version passed `prev.current` into a functional
// setState, which React runs at the next render — after `prev.current` had already been overwritten with the new
// statuses, so a deck that had just started never looked "started" and the strip waited for the old deck to stop
// (found by src/lib/deckLamps.behaviour.test.tsx, 2026-10-28).
import { useEffect, useRef, useState } from "react";
import { shownDeck, type DeckId } from "../lib/deckView";

export function useShownDeck(a: string | undefined, b: string | undefined, c: string | undefined): DeckId {
  const prev = useRef<Record<DeckId, string | undefined>>({ A: undefined, B: undefined, C: undefined });
  const [shown, setShown] = useState<DeckId>("A");
  useEffect(() => {
    const before = prev.current;
    const now = { A: a, B: b, C: c };
    prev.current = now;
    setShown(s => shownDeck(s, before, now));
  }, [a, b, c]);
  return shown;
}
