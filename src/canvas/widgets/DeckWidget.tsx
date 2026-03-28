import { useEffect, useState } from "react";
import OnAirDeck from "../../components/OnAirDeck";
import { WidgetInstance } from "../WidgetRegistry";
import { DeckState } from "../../audio/engine-rodio";

interface Props {
  instance: WidgetInstance;
  deckStates: Record<string, DeckState | null>;
  engine: any;
}

export default function DeckWidget({ instance, deckStates, engine }: Props) {
  const slot = instance.config.deckSlot || "A";
  const deck = deckStates[slot] || null;

  return (
    <OnAirDeck
      deck={deck}
      label={instance.label || `Deck ${slot}`}
      deckId={slot as "A" | "B" | "C"}
      onPlay={() => engine.getDeck(slot)?.play()}
      onPause={() => engine.getDeck(slot)?.pause()}
      onResume={() => engine.getDeck(slot)?.resume()}
      onStop={() => engine.getDeck(slot)?.stop()}
      onVolume={(v: number) => engine.getDeck(slot)?.setVolume(v)}
    />
  );
}
