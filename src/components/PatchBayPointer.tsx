// src/components/PatchBayPointer.tsx — where an output picker used to be: one line naming what the ENGINE has open for this
// output row, and a button to the Patch Bay (the one place outputs are patched — docs/ether-audio-patch-bay-plan.md step 1;
// Jeff's Outputs answer 1: "in one place only"). No picker here, so there is never a second place for the same thing.

import { useEffect, useState } from "react";

type Row = "master" | "cue" | "aux";
type DestState = { requested: string; pair: number; state: string; opened: string; opened_pair: number };
const pairLabel = (p: number) => `${p + 1}-${p + 2}`;

export function patchRowSummary(row: Row, list: DestState[] | undefined): { text: string; bad: boolean } {
  const live = (list || []).filter(d => d.requested || row === "master");
  if (live.length === 0 || (row !== "master" && !live[0].requested)) {
    return { text: row === "cue" ? "PFL plays over Master" : "nothing patched: the aux is silent", bad: false };
  }
  const parts = live.map(d => {
    const name = d.requested || d.opened || "Windows default";
    if (d.state === "open") return `${d.opened || name} ch ${pairLabel(d.opened_pair)}`;
    if (d.state === "not_found") return `MISSING: ${name}`;
    if (d.state === "stalled") return `STALLED: ${name}`;
    if (d.state === "failed") return `FAILED: ${name}`;
    return `${name} (${d.state.replace("_", " ")})`;
  });
  return { text: parts.join(" + "), bad: live.some(d => d.state === "not_found" || d.state === "stalled" || d.state === "failed") };
}

export default function PatchBayPointer({ stationId, row, label }: { stationId: number | null | undefined; row: Row; label: string }) {
  const [st, setSt] = useState<any>(null);
  useEffect(() => {
    if (stationId == null) return;
    let alive = true;
    const poll = async () => { try { const r = await (window as any).ether?.patchBay?.state?.(stationId); if (alive) setSt(r); } catch { /* next poll */ } };
    void poll();
    const id = setInterval(poll, 2000);
    return () => { alive = false; clearInterval(id); };
  }, [stationId]);
  const w = patchRowSummary(row, st?.[row]);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontSize: 10, letterSpacing: "0.1em", color: "var(--text-secondary)", textTransform: "uppercase", flexShrink: 0 }}>{label}</span>
      <span style={{ flex: 1, fontSize: 11, color: w.bad ? "var(--accent-red, #ef4444)" : "var(--text-secondary)", fontWeight: w.bad ? 700 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            title={st ? w.text : "waiting for the audio engine"}>{st ? w.text : "…"}</span>
      <button onClick={() => { try { (window as any).ether.invoke("window:popout", "multioutput"); } catch { /* not in Electron */ } }}
              title="Choose devices and channels in the Patch Bay"
              style={{ fontSize: 10, padding: "2px 8px", cursor: "pointer", border: "1px solid var(--border-primary)", background: "transparent", color: "var(--text-secondary)" }}>
        Patch Bay
      </button>
    </div>
  );
}
