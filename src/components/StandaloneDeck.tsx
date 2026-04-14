// StandaloneDeck.tsx — self-contained deck panel for pop-out windows
// Polls audio:getState independently from the main window.
// Supports play/pause/stop/volume. Queue management stays in the main window.

import { useState, useEffect } from "react";
import type { DeckState } from "../audio/engine-rodio";
import OnAirDeck from "./OnAirDeck";

interface Props { deckId: "A" | "B" | "C"; }

export default function StandaloneDeck({ deckId }: Props) {
  const [deck, setDeck] = useState<DeckState | null>(null);

  useEffect(() => {
    let handle: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const raw = await (window as any).ether.audio.getState();
        const s: any = typeof raw === "string" ? JSON.parse(raw) : raw;
        const key = `deck${deckId}` as "deckA" | "deckB" | "deckC";
        const d = s[key];
        if (d) {
          setDeck({
            status:      d.status      ?? "idle",
            title:       d.title       ?? "",
            artist:      d.artist      ?? "",
            filePath:    d.filePath    ?? "",
            positionSec: d.positionSec ?? 0,
            durationSec: d.durationSec ?? 0,
            volume:      d.volume      ?? 1,
          } as DeckState);
        }
      } catch { /* native addon may not be ready yet */ }
      handle = setTimeout(poll, 100);
    }

    poll();
    return () => clearTimeout(handle);
  }, [deckId]);

  return (
    <div style={{ height: "100%", overflow: "hidden" }}>
      <OnAirDeck
        deck={deck}
        label={`Deck ${deckId}`}
        deckId={deckId}
        onPlay={()  => (window as any).ether.audio.play(deckId)}
        onPause={()  => (window as any).ether.audio.pause(deckId)}
        onResume={()  => (window as any).ether.audio.play(deckId)}
        onStop={()  => (window as any).ether.audio.stop(deckId)}
        onVolume={(v) => (window as any).ether.audio.setVolume(deckId, v)}
      />
    </div>
  );
}
