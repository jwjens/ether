// JinglesPanel — JINGLES/SWEEPERS v2 overlay manager (per-station). Three jobs:
//   1) Overlay pools (JIN / SWP tabs) — typed rotating pools with lead-in/underlap. Burnout protection.
//   2) Assign overlay songs (marked JIN/SWP in the Library) to pools.
//   3) The CORE: per-music-category ASSIGNMENT — each category names a SPECIFIC overlay item OR a pool,
//      with active hours + optional timing override. This is what Generate reads to place overlays.
//   + an optional station-level FALLBACK pool for unassigned categories (none = clean dead segue).
// Selection lives here in the ONE scheduler (Generate); the daemon only orchestrates the fire. Cadence retired.
import { useEffect, useState, useCallback, Fragment } from "react";
import { query } from "../db/client";
import { JIN_TEAL, SWP_INDIGO } from "../lib/classColors";
import ReelSplitter from "./ReelSplitter";
import InlineNameEditor from "./InlineNameEditor";

interface Pool { id: number; uuid: string; name: string; color: string | null; type: string; lead_in_sec: number; underlap_sec: number; sort_order: number; }
interface OverlaySong { id: number; title: string; artist_name: string | null; content_class: string; jingle_category_id: number | null; }
interface MusicCat {
  id: number; code: string; name: string; color: string | null;
  overlay_kind: string | null; overlay_song_id: number | null; overlay_category_id: number | null;
  overlay_lead_in_sec: number | null; overlay_underlap_sec: number | null; overlay_active_hours: number | null;
}

const ether = () => (window as any).ether;
const ALWAYS = 16777215;
const maskFromRange = (from: number, to: number) => { let m = 0; for (let h = from; h <= to; h++) m |= (1 << h); return m >>> 0; };
const rangeFromMask = (mask: number) => {
  if (mask == null || mask === ALWAYS) return null;
  let lo = -1, hi = -1; for (let h = 0; h < 24; h++) if ((mask >> h) & 1) { if (lo < 0) lo = h; hi = h; }
  return lo < 0 ? { from: 0, to: 23 } : { from: lo, to: hi };
};
const hhLabel = (h: number) => `${((h % 12) || 12)}${h < 12 ? "a" : "p"}`;

// Hosted in the Schedule Manager's docking shell as the Jingles pane (v2 Phase 2). It keeps its own
// fetching — pools, overlay songs and the fallback are its data alone. The one overlap is the music
// CATEGORY rows it patches (overlay_kind / overlay_song_id / overlay_category_id / overlay_active_hours),
// which the hub also owns; onMutated is how the Categories pane learns an assignment changed.
// Optional, so the JINGLES push-up (its canonical home) is unchanged.
export default function JinglesPanel({ stationId, onMutated }: { stationId: number; onMutated?: (tables?: string[]) => void }) {
  const [tab, setTab] = useState<"JIN" | "SWP">("JIN");
  const [pools, setPools] = useState<Pool[]>([]);
  const [songs, setSongs] = useState<OverlaySong[]>([]);
  const [cats, setCats] = useState<MusicCat[]>([]);
  const [fallbackId, setFallbackId] = useState<number | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"manage" | "create">("manage");   // push-up: Manage vs Add imaging (reel splitter)

  const reload = useCallback(async () => {
    try { const r = await ether()?.jingleCategories?.list(stationId); setPools(((r?.rows || []) as Pool[])); } catch { setPools([]); }
    try { const r = await ether()?.categories?.list(stationId); setCats(((r?.rows || []) as MusicCat[]).sort((a, b) => (a.code || "").localeCompare(b.code || ""))); } catch { setCats([]); }
    try {
      const rows = await query<OverlaySong>("SELECT s.id, s.title, a.name AS artist_name, s.content_class, s.jingle_category_id FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.content_class IN ('JIN','SWP') AND s.deleted_at IS NULL ORDER BY s.content_class, s.title");
      setSongs(rows || []);
    } catch { setSongs([]); }
    try {
      const r = await ether()?.stationConfigKv?.list(stationId);
      const v = ((r?.rows || []) as { key: string; value: string }[]).find(x => x.key === "overlay_fallback_category_id")?.value;
      setFallbackId(v ? (parseInt(v, 10) || null) : null);
    } catch { setFallbackId(null); }
  }, [stationId]);
  useEffect(() => { reload(); }, [reload]);

  const tabPools = pools.filter(p => (p.type || "JIN") === tab);
  const tabSongs = songs.filter(s => s.content_class === tab);
  const accent = tab === "SWP" ? SWP_INDIGO : JIN_TEAL;

  const createPool = async () => {
    const name = newName.trim(); if (!name || busy) return; setBusy(true);
    try {
      await ether()?.jingleCategories?.create({ station_id: stationId, name, color: accent, type: tab,
        lead_in_sec: tab === "SWP" ? 2 : 5, underlap_sec: tab === "SWP" ? 1 : 2, sort_order: tabPools.length });
      setNewName(""); await reload();
    } finally { setBusy(false); }
  };
  const patchPool = async (p: Pool, patch: Partial<Pool>) => { try { await ether()?.jingleCategories?.updateById(p.id, patch); await reload(); } catch {} };
  const delPool = async (p: Pool) => { if (!confirm(`Delete pool "${p.name}"? Assigned overlays become unassigned (not deleted).`)) return; try { await ether()?.jingleCategories?.delete(p.uuid, stationId); await reload(); } catch {} };
  const assignSong = async (s: OverlaySong, poolId: number | null) => { try { await ether()?.songs?.updateById(s.id, { jingle_category_id: poolId }); await reload(); } catch {} };
  const setFallback = async (poolId: number | null) => { try { await ether()?.stationConfigKv?.upsertByKey(stationId, "overlay_fallback_category_id", poolId != null ? String(poolId) : ""); setFallbackId(poolId); } catch {} };

  // Category assignment: encode as "item:<songId>" | "pool:<poolId>" | "".
  const assignCategory = async (c: MusicCat, value: string) => {
    let patch: Partial<MusicCat> = { overlay_kind: null, overlay_song_id: null, overlay_category_id: null };
    if (value.startsWith("item:")) patch = { overlay_kind: "item", overlay_song_id: Number(value.slice(5)), overlay_category_id: null };
    else if (value.startsWith("pool:")) patch = { overlay_kind: "pool", overlay_category_id: Number(value.slice(5)), overlay_song_id: null };
    try { await ether()?.categories?.updateById(c.id, patch); await reload(); onMutated?.(["categories"]); } catch {}
  };
  const catValue = (c: MusicCat) => c.overlay_kind === "item" && c.overlay_song_id != null ? `item:${c.overlay_song_id}` : c.overlay_kind === "pool" && c.overlay_category_id != null ? `pool:${c.overlay_category_id}` : "";
  const setHours = async (c: MusicCat, mask: number) => { try { await ether()?.categories?.updateById(c.id, { overlay_active_hours: mask }); await reload(); onMutated?.(["categories"]); } catch {} };

  const inp: React.CSSProperties = { width: 46, background: "var(--bg-secondary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", borderRadius: 3, padding: "2px 4px", fontSize: 12, fontFamily: "'DM Mono', monospace" };
  const sel: React.CSSProperties = { background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", borderRadius: 4, padding: "3px 6px", fontSize: 12 };

  const jinPools = pools.filter(p => (p.type || "JIN") === "JIN");
  const swpPools = pools.filter(p => (p.type || "JIN") === "SWP");
  const jinItems = songs.filter(s => s.content_class === "JIN");
  const swpItems = songs.filter(s => s.content_class === "SWP");

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", color: "var(--text-primary)", minHeight: 0 }}>
      {/* Mode tabs — Manage the imaging library vs. Add imaging (reel splitter / single cut) */}
      <div style={{ display: "flex", gap: 4, padding: "8px 16px 0", borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}>
        {(["manage", "create"] as const).map(m => (
          <button key={m} onClick={() => { setMode(m); if (m === "manage") reload(); }} style={{
            padding: "6px 14px", background: "transparent", border: "none", borderBottom: `2px solid ${mode === m ? accent : "transparent"}`,
            color: mode === m ? accent : "var(--text-tertiary)", fontWeight: 800, fontSize: 12, letterSpacing: "0.04em", cursor: "pointer",
          }}>{m === "manage" ? "MANAGE" : "ADD IMAGING — CUT A REEL"}</button>
        ))}
      </div>
      {mode === "create" ? (
        <div style={{ flex: 1, minHeight: 0 }}><ReelSplitter stationId={stationId} embedded onCommitted={reload} /></div>
      ) : (
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16, maxWidth: 900 }}>
      <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 16, lineHeight: 1.5 }}>
        Overlay imaging fires on the seam between songs (over master). Assign a <b>specific</b> jingle/sweeper
        or a <b>rotating pool</b> to each music category below — some categories get imaging, some don't. Mark
        songs <b style={{ color: JIN_TEAL }}>JIN</b> / <b style={{ color: SWP_INDIGO }}>SWP</b> in the Library first.
      </div>

      {/* ── Category assignments (the core) ── */}
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-secondary)", textTransform: "uppercase", marginBottom: 8 }}>Category assignments</div>
      {cats.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic", marginBottom: 20 }}>No music categories yet.</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "150px 1fr auto", gap: "6px 14px", alignItems: "center", marginBottom: 14 }}>
          <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>CATEGORY</div>
          <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>OVERLAY</div>
          <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>ACTIVE HOURS</div>
          {cats.map(c => {
            const rng = rangeFromMask(c.overlay_active_hours ?? ALWAYS);
            const always = rng === null;
            return (
              <Fragment key={c.id}>
                <div key={c.id + "n"} style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden" }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: c.color || "var(--text-tertiary)", flexShrink: 0 }} />
                  <span style={{ fontSize: 12.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.code}{c.name && c.name !== c.code ? ` · ${c.name}` : ""}</span>
                </div>
                <select key={c.id + "s"} value={catValue(c)} onChange={e => assignCategory(c, e.target.value)} style={sel}>
                  <option value="">— none (clean segue) —</option>
                  {jinItems.length > 0 && <optgroup label="Specific jingle">{jinItems.map(s => <option key={"i" + s.id} value={`item:${s.id}`}>♪ {s.title}</option>)}</optgroup>}
                  {swpItems.length > 0 && <optgroup label="Specific sweeper">{swpItems.map(s => <option key={"i" + s.id} value={`item:${s.id}`}>♫ {s.title}</option>)}</optgroup>}
                  {jinPools.length > 0 && <optgroup label="Jingle pool (rotates)">{jinPools.map(p => <option key={"p" + p.id} value={`pool:${p.id}`}>◆ {p.name}</option>)}</optgroup>}
                  {swpPools.length > 0 && <optgroup label="Sweeper pool (rotates)">{swpPools.map(p => <option key={"p" + p.id} value={`pool:${p.id}`}>◆ {p.name}</option>)}</optgroup>}
                </select>
                <div key={c.id + "h"} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-secondary)", cursor: "pointer" }}>
                    <input type="checkbox" checked={always} onChange={e => setHours(c, e.target.checked ? ALWAYS : maskFromRange(6, 19))} /> Always
                  </label>
                  {!always && rng && (
                    <>
                      <select value={rng.from} onChange={e => setHours(c, maskFromRange(Math.min(Number(e.target.value), rng.to), rng.to))} style={{ ...sel, padding: "2px 4px" }}>
                        {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hhLabel(h)}</option>)}
                      </select>
                      <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>–</span>
                      <select value={rng.to} onChange={e => setHours(c, maskFromRange(rng.from, Math.max(Number(e.target.value), rng.from)))} style={{ ...sel, padding: "2px 4px" }}>
                        {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hhLabel(h)}</option>)}
                      </select>
                    </>
                  )}
                </div>
              </Fragment>
            );
          })}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 22, fontSize: 12, color: "var(--text-secondary)" }}>
        <span>Fallback for unassigned categories:</span>
        <select value={fallbackId ?? ""} onChange={e => setFallback(e.target.value ? Number(e.target.value) : null)} style={sel}>
          <option value="">None (clean segue — silence is fine)</option>
          {pools.map(p => <option key={p.id} value={p.id}>{p.type} · {p.name}</option>)}
        </select>
      </div>

      {/* ── Overlay library: JIN / SWP pools + song assignment ── */}
      <div style={{ display: "flex", gap: 6, marginBottom: 12, borderBottom: "1px solid var(--border-primary)" }}>
        {(["JIN", "SWP"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: "6px 14px", background: "transparent", border: "none", borderBottom: `2px solid ${tab === t ? (t === "SWP" ? SWP_INDIGO : JIN_TEAL) : "transparent"}`,
            color: tab === t ? (t === "SWP" ? SWP_INDIGO : JIN_TEAL) : "var(--text-tertiary)", fontWeight: 800, fontSize: 12, letterSpacing: "0.06em", cursor: "pointer",
          }}>{t === "SWP" ? "SWEEPERS" : "JINGLES"}</button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === "Enter" && createPool()}
          placeholder={tab === "SWP" ? "New sweeper pool (e.g. Legal IDs)" : "New jingle pool (e.g. Station IDs)"}
          style={{ flex: 1, maxWidth: 280, background: "var(--bg-secondary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", borderRadius: 4, padding: "6px 10px", fontSize: 13 }} />
        <button onClick={createPool} disabled={busy || !newName.trim()} style={{ padding: "6px 14px", borderRadius: 4, border: "none", background: accent, color: "#04201c", fontWeight: 700, fontSize: 13, cursor: "pointer", opacity: busy || !newName.trim() ? 0.5 : 1 }}>Add pool</button>
      </div>

      {tabPools.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", gap: "6px 12px", alignItems: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>POOL</div>
          <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>LEAD-IN s</div>
          <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>UNDERLAP s</div>
          <div />
          {tabPools.map(p => (
            <Fragment key={p.id}>
              <div key={p.id + "n"} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: p.color || accent }} />
                <input defaultValue={p.name} onBlur={e => e.target.value.trim() && e.target.value !== p.name && patchPool(p, { name: e.target.value.trim() })}
                  style={{ flex: 1, background: "transparent", color: "var(--text-primary)", border: "1px solid transparent", borderRadius: 3, padding: "2px 4px", fontSize: 13, fontWeight: 600 }} />
                <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>{tabSongs.filter(s => s.jingle_category_id === p.id).length} in pool</span>
              </div>
              <input key={p.id + "l"} type="number" min={0} step={0.5} defaultValue={p.lead_in_sec} onBlur={e => patchPool(p, { lead_in_sec: Math.max(0, parseFloat(e.target.value) || p.lead_in_sec) })} style={inp} />
              <input key={p.id + "u"} type="number" min={0} step={0.5} defaultValue={p.underlap_sec} onBlur={e => patchPool(p, { underlap_sec: Math.max(0, parseFloat(e.target.value) || p.underlap_sec) })} style={inp} />
              <button key={p.id + "d"} onClick={() => delPool(p)} title="Delete pool" style={{ background: "transparent", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 14 }}>✕</button>
            </Fragment>
          ))}
        </div>
      )}

      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-secondary)", textTransform: "uppercase", marginBottom: 8 }}>{tab === "SWP" ? "Sweepers" : "Jingles"} ({tabSongs.length})</div>
      {tabSongs.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic" }}>None tagged. In the Library, right-click an item and choose “Mark as {tab === "SWP" ? "Sweeper (SWP)" : "Jingle (JIN)"}”, then assign it to a pool here.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {tabSongs.map(s => (
            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 8px", background: "var(--bg-secondary)", borderRadius: 4 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: accent, flexShrink: 0 }} />
              <InlineNameEditor
                value={s.title}
                display={<span style={{ fontSize: 13 }}>{s.title}{s.artist_name ? ` — ${s.artist_name}` : ""}</span>}
                onSave={async (next) => { try { await ether()?.songs?.updateById(s.id, { title: next }); await reload(); } catch {} }}
              />
              <select value={s.jingle_category_id ?? ""} onChange={e => assignSong(s, e.target.value ? Number(e.target.value) : null)} style={sel}>
                <option value="">— unassigned —</option>
                {tabPools.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          ))}
        </div>
      )}
      </div>
      )}
    </div>
  );
}
