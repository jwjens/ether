import { useEffect, useState } from "react";
import OnAirDeck from "../../components/OnAirDeck";
import { WidgetInstance } from "../WidgetRegistry";
import { DeckState } from "../../audio/engine-rodio";
import { computeDeckRole } from "../../lib/deckRole";

interface Props {
  instance: WidgetInstance;
  deckStates: Record<string, DeckState | null>;
  engine: any;
}

export default function DeckWidget({ instance, deckStates, engine }: Props) {
  const slot = instance.config.deckSlot || "A";
  const deck = deckStates[slot] || null;
  const role = computeDeckRole(slot as "A" | "B" | "C", {
    A: deckStates["A"] || null, B: deckStates["B"] || null, C: deckStates["C"] || null,
  });

  return (
    <OnAirDeck
      deck={deck}
      label={instance.label || `Deck ${slot}`}
      deckId={slot as "A" | "B" | "C"}
      role={role}
      onPlay={() => engine.getDeck(slot)?.play()}
      onPause={() => engine.getDeck(slot)?.pause()}
      onResume={() => engine.getDeck(slot)?.resume()}
      onStop={() => engine.getDeck(slot)?.stop()}
      onVolume={(v: number) => engine.getDeck(slot)?.setVolume(v)}
    />
  );
}
