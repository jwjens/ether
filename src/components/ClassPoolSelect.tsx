// ClassPoolSelect — the ONE shared imaging commit-form control cluster (class tabs + pool picker), worn by
// BOTH imaging surfaces: the Reel Splitter batch commit and the StudioPro chop-and-send. Name editing is
// the already-shared InlineNameEditor; this adds the JIN/SWP class + pool-of-that-class selection. Never
// copied — one commit form, two surfaces.
import { useEffect, useState } from "react";
import { JIN_TEAL, SWP_INDIGO } from "../lib/classColors";

export interface ImagingPool { id: number; name: string; type: string }

/** Load the station's imaging pools (jingle categories). Shared by both surfaces so the pool list is
 *  sourced identically. Returns [] until loaded / on error. */
export function useImagingPools(stationId: number): ImagingPool[] {
  const [pools, setPools] = useState<ImagingPool[]>([]);
  useEffect(() => { (async () => {
    try { const r = await (window as any).ether?.jingleCategories?.list(stationId); setPools(((r?.rows || []) as ImagingPool[])); }
    catch { setPools([]); }
  })(); }, [stationId]);
  return pools;
}

export default function ClassPoolSelect({ cls, poolId, pools, onCls, onPool, compact }: {
  cls: "SWP";
  poolId: number | null;
  pools: ImagingPool[];
  onCls: (c: "SWP") => void;
  onPool: (id: number | null) => void;
  compact?: boolean;
}) {
  // v52: one imaging class, so every pool is a sweeper pool. The old JIN/SWP toggle is gone —
  // a two-button choice with one possible answer is a control that cannot be used wrongly only
  // because it cannot be used at all. `cls` is kept in the signature so callers are unchanged.
  const tabPools = pools;
  const pad = compact ? "4px 10px" : "5px 12px";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <label style={{ fontSize: 12, color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 6 }}>
        Pool
        <select value={poolId ?? ""} onChange={e => onPool(e.target.value ? Number(e.target.value) : null)}
          style={{ background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", borderRadius: 4, padding: "3px 6px", fontSize: 12 }}>
          <option value="">— unassigned —</option>
          {tabPools.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
    </div>
  );
}
