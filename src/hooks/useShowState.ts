// useShowState — SLICE 7: the blade's show state for the active station (docs/dsp-show-presets.md §3).
//
// The UI never holds the pending set or the levels: it READS them back from the blade (show:state), on mount, on
// every station switch and whenever the blade says something changed. So a reload, a second window and the pop-out
// board all show the same thing — what the engine service is doing.
import { useCallback, useEffect, useState } from "react";
import { useActiveStation } from "./useActiveStation";
import { EMPTY_SHOW_STATE, type ShowState } from "../lib/showPresets";

export function useShowState() {
  const { stationId, stationUuid } = useActiveStation();
  const [state, setState] = useState<ShowState>(EMPTY_SHOW_STATE);

  const reload = useCallback(async () => {
    const show = (window as any).ether?.show;
    if (stationId == null || !show?.state) { setState(EMPTY_SHOW_STATE); return; }
    try {
      const s = await show.state(stationId);
      setState({ ...EMPTY_SHOW_STATE, ...(s || {}), levels: (s && s.levels) || {}, pending: (s && s.pending) || [] });
    } catch { /* the engine service is not up — the board keeps what it shows */ }
  }, [stationId]);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    const show = (window as any).ether?.show;
    if (!show?.onState) return;
    const mine = (m: any) => !!m && (!stationUuid || !m.stationUuid || m.stationUuid === stationUuid);
    const hs = show.onState((m: any) => {
      if (!mine(m)) return;
      setState(prev => ({ ...prev, current: m.current ?? null, armed: m.armed ?? null, pending: m.pending || [], levels: m.levels || prev.levels }));
    });
    // A drag anywhere (this window, the other board, MIDI) lands here, so a fader released after a drag stays where
    // the engine is — not where this window last thought it was.
    const hl = show.onLevels?.((m: any) => { if (mine(m)) setState(prev => ({ ...prev, levels: m.levels || {} })); });
    return () => { show.offState?.(hs); if (hl) show.offLevels?.(hl); };
  }, [stationUuid]);

  return { state, reload, stationId, stationUuid };
}
