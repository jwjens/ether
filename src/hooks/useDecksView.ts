// useDecksView — the board's A/B/C view for the active station (src/lib/deckView.ts): read from this computer's setting,
// re-read when it changes anywhere (the toggle in another window, or a show preset Take), set through main.
import { useCallback, useEffect, useState } from "react";
import { useActiveStation } from "./useActiveStation";
import { parseDecksView, type DecksView } from "../lib/deckView";

export function useDecksView(): [DecksView, (v: DecksView) => void] {
  const { stationId, stationUuid } = useActiveStation();
  const [view, setView] = useState<DecksView>("expanded");
  useEffect(() => {
    let alive = true;
    const api = (window as any).ether?.boardView;
    if (stationId == null || !api) return;
    api.getDecks(stationId).then((v: unknown) => { if (alive) setView(parseDecksView(v)); }).catch(() => {});
    const off = api.onDecks?.((m: { stationUuid: string | null; view: unknown }) => {
      if (m && m.stationUuid && stationUuid && m.stationUuid !== stationUuid) return;
      setView(parseDecksView(m && m.view));
    });
    return () => { alive = false; try { off?.(); } catch { /* gone */ } };
  }, [stationId, stationUuid]);
  const set = useCallback((v: DecksView) => {
    setView(v);
    try { void (window as any).ether?.boardView?.setDecks?.(stationId, v); } catch { /* not in Electron */ }
  }, [stationId]);
  return [view, set];
}
