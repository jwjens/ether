// useAutoGenerate — the auto-generate switch for one station, for a component (lib/autoGenerate.ts has the rules).
// Controlled: renders the STORED value only; a click writes, reads back, and shows the store's word.
import { useCallback, useEffect, useRef, useState } from "react";
import { readAutoGenerate, writeAutoGenerate } from "../lib/autoGenerate";

const invoke = (ch: string, ...a: any[]) => (window as any).ether?.invoke?.(ch, ...a);

export function useAutoGenerate(stationId: number | null | undefined) {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);   // a read overtaken by a click is discarded, so the switch can't flicker back

  const refresh = useCallback(async () => {
    if (stationId == null) return;
    const s = seq.current;
    const v = await readAutoGenerate(invoke, stationId);
    if (seq.current === s) setOn(v);
  }, [stationId]);
  useEffect(() => { setOn(null); setError(null); void refresh(); }, [refresh]);

  const toggle = useCallback(async () => {
    if (stationId == null || busy) return;
    const s = ++seq.current;
    setBusy(true); setError(null);
    try {
      const r = await writeAutoGenerate(invoke, stationId, !(on === true));
      if (seq.current === s) { setOn(r.stored); setError(r.error); }
    } finally { setBusy(false); }
  }, [stationId, on, busy]);

  return { on, busy, error, toggle, refresh };
}
