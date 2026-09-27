// useBoardName — the board letter for a slot, from THIS station's deck_configs order (src/lib/boardName.ts).
import { useCallback, useMemo } from "react";
import { useDeckConfig } from "../components/DeckConfigurator";
import { DEFAULT_BOARD_ORDER, boardName } from "../lib/boardName";

export function useBoardName(): (slot: string) => string {
  const { configs } = useDeckConfig();
  // Every row, enabled or not (already in compareSlots order): removing one channel never renames another.
  const order = useMemo(() => (configs && configs.length ? configs.map(c => String(c.slot)) : DEFAULT_BOARD_ORDER), [configs]);
  return useCallback((slot: string) => boardName(slot, order), [order]);
}
