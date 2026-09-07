// SweepersPanel — the imaging home (per-station). Three jobs:
//
// v52 (2026-08-27): "jingle" is retired. There is ONE imaging concept — a sweeper — so this panel
// has ONE list, not two tabs. The JIN/SWP split that used to live here is gone with it.
//
// The `jingle_categories` TABLE keeps its name deliberately: it is a synced table and the receiver
// dispatches on REGISTRY[m.table_name], so renaming it would make a peer's mutation under the old
// name land nowhere and drop silently. Invisible to operators; not worth the divergence risk.
// (Superseded note, kept for the reader: the old text here said renaming meant rewriting ~63k
// generated_schedule and play_log rows, which is a separate filed project tied to the sweeper
// redesign, not a label change.
//   1) Sweeper pools — rotating pools. Burnout protection.
//   2) Assign sweepers (marked in the Library) to pools.
//   3) The CORE: per-music-category ASSIGNMENT — each category names a SPECIFIC overlay item OR a pool,
//      with active hours + optional timing override. This is what Generate reads to place overlays.
//   + an optional station-level FALLBACK pool for unassigned categories (none = clean dead segue).
// Selection lives here in the ONE scheduler (Generate); the daemon only orchestrates the fire. Cadence retired.
import { useEffect, useState, useCallback, Fragment } from "react";
import { query } from "../db/client";
import { SWP_INDIGO } from "../lib/classColors";
import ReelSplitter from "./ReelSplitter";
import InlineNameEditor from "./InlineNameEditor";
import { useFileMenu } from "../lib/fileLocation";

interface Pool { id: number; uuid: string; name: string; color: string | null; type: string; lead_in_sec: number; sort_order: number; }
interface OverlaySong { id: number; title: string; artist_name: string | null; content_class: string; jingle_category_id: number | null; }
interface MusicCat {
  id: number; code: string; name: string; color: string | null;
  overlay_kind: string | null; overlay_song_id: number | null; overlay_category_id: number | null;
  overlay_lead_in_sec: number | null; overlay_underlap_sec: number | null; overlay_active_hours: number | null;
}

const ether = () => (window as any).ether;
const ALWAYS = 16777215;
// The station default LEAD. NOT a private constant: when a category sets no override this is the number
// that airs, so the LEAD column renders it in the box (greyed) as the current value — the operator can
// always see what is running and type over it. Must match SWEEPER_DEFAULT in electron/main.js and the
// fallback in audiod/loggen.js — three places, one number.
const DEF_LEAD = 2;
// THE ENGINE'S ARM WINDOW, MIRRORED. A sweeper is only promoted from SCHEDULED to ARMED inside this many
// seconds of the outgoing song's end (audiod/engine.js _ARM_WINDOW_S), and it cannot fire before it arms.
// So the largest lead the engine can honour is (ARM_WINDOW_S - segue overlap), and the input below is
// bounded there — the UI must never offer a number the engine will silently reduce.
//
// Observed on the real _jingleTick before this bound existed: LEAD 40 at overlap 5 armed at 30s remaining
// and fired at 29.75s, giving 24.75s of lead. The control accepted 40, the log printed 40, and the seam
// got 25. KEEP THIS IN STEP WITH engine.js.
const ARM_WINDOW_S = 90;
const maskFromRange = (from: number, to: number) => { let m = 0; for (let h = from; h <= to; h++) m |= (1 << h); return m >>> 0; };
const rangeFromMask = (mask: number) => {
  if (mask == null || mask === ALWAYS) return null;
  let lo = -1, hi = -1; for (let h = 0; h < 24; h++) if ((mask >> h) & 1) { if (lo < 0) lo = h; hi = h; }
  return lo < 0 ? { from: 0, to: 23 } : { from: lo, to: hi };
};
const hhLabel = (h: number) => `${((h % 12) || 12)}${h < 12 ? "a" : "p"}`;

// Hosted in the Schedule Manager's docking shell as the Sweepers pane (v2 Phase 2). It keeps its own
// fetching — pools, overlay songs and the fallback are its data alone. The one overlap is the music
// CATEGORY rows it patches (overlay_kind / overlay_song_id / overlay_category_id / overlay_active_hours),
// which the hub also owns; onMutated is how the Categories pane learns an assignment changed.
// Optional, so the SWEEPERS push-up (its canonical home) is unchanged.
// LIFTED, NOT COPIED (imaging slice 1, 2026-09-07). The IMAGING surface renders THIS component for its
// ASSIGNMENTS and POOLS views rather than growing its own tables, because two views of the same thing
// that can disagree is a failure Jeff has already had. Two props do it:
//
//   section   which half to render. Omitted = both, plus the MANAGE / ADD IMAGING tabs — the push-up,
//             unchanged, still the canonical editor.
//   readOnly  IMAGING is a read-only surface in slice 1. Every control is disabled AND every write
//             handler returns early: the guard is not the disabled attribute alone, because a control
//             that cannot be clicked is not the same as a path that cannot write.
export default function SweepersPanel({ stationId, onMutated, section, readOnly }: {
  stationId: number; onMutated?: (tables?: string[]) => void;
  section?: "assignments" | "pools"; readOnly?: boolean;
}) {
  const ro = !!readOnly;
  const showAssign = !section || section === "assignments";
  const showPools  = !section || section === "pools";
  // Right-click on any file-backed row: Open / Change File Location, from the shared set.
  const fileMenu = useFileMenu();
  const [pools, setPools] = useState<Pool[]>([]);
  const [songs, setSongs] = useState<OverlaySong[]>([]);
  const [cats, setCats] = useState<MusicCat[]>([]);
  const [fallbackId, setFallbackId] = useState<number | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"manage" | "create">("manage");   // push-up: Manage vs Add imaging (reel splitter)
  // Typing buffer for the TIMING boxes, keyed "<catId>:lead|under". Committed on blur/Enter so a
  // three-digit entry is one write, not one per keystroke; cleared on commit so the DB value shows again.
  const [timingDraft, setTimingDraft] = useState<Record<string, string>>({});
  // The station's segue overlap, read from the same KV the daemon reads. It sets the LEAD ceiling, so the
  // bound moves with the operator's own setting rather than assuming one.
  const [segueOverlap, setSegueOverlap] = useState(0);
  const maxLead = Math.max(1, ARM_WINDOW_S - segueOverlap);

  const reload = useCallback(async () => {
    try { const r = await ether()?.jingleCategories?.list(stationId); setPools(((r?.rows || []) as Pool[])); } catch { setPools([]); }
    try { const r = await ether()?.categories?.list(stationId); setCats(((r?.rows || []) as MusicCat[]).sort((a, b) => (a.code || "").localeCompare(b.code || ""))); } catch { setCats([]); }
    try {
      // A FILTERED VIEW OVER THE ONE TYPED LIBRARY (docs/library-current-state.md, Option 1).
      // library_asset type='SWEEPER' drives the list; the row still comes from `songs` because that is
      // where a sweeper's pool assignment lives.
      //
      // One list: v50 typed both old classes as SWEEPER and v52 collapsed the data to a single SWP,
      // so the type filter alone is now the whole story.
      const rows = await query<OverlaySong>("SELECT s.id, la.title AS title, a.name AS artist_name, s.content_class, s.jingle_category_id FROM library_asset la JOIN songs s ON s.uuid = la.uuid LEFT JOIN artists a ON a.id = s.artist_id WHERE la.type = 'SWEEPER' AND la.deleted_at IS NULL AND s.deleted_at IS NULL ORDER BY s.content_class, la.title");
      setSongs(rows || []);
    } catch { setSongs([]); }
    try {
      const r = await ether()?.stationConfigKv?.list(stationId);
      const rows = (r?.rows || []) as { key: string; value: string }[];
      const v = rows.find(x => x.key === "overlay_fallback_category_id")?.value;
      setFallbackId(v ? (parseInt(v, 10) || null) : null);
      const so = parseInt(rows.find(x => x.key === "segue_overlap_sec")?.value ?? "", 10);
      setSegueOverlap(isNaN(so) ? 0 : Math.max(0, Math.min(10, so)));
    } catch { setFallbackId(null); }
  }, [stationId]);
  useEffect(() => { reload(); }, [reload]);

  // One class, so no filtering: every pool is a sweeper pool and every row is a sweeper.
  const tabPools = pools;
  const tabSongs = songs;
  const accent = SWP_INDIGO;

  const createPool = async () => {
    if (ro) return;
    const name = newName.trim(); if (!name || busy) return; setBusy(true);
    try {
      // Seeded from the same station default the LEAD column shows. underlap_sec is not passed: the
      // column is NOT NULL and the handler supplies its own storage value for a field nothing reads.
      await ether()?.jingleCategories?.create({ station_id: stationId, name, color: accent, type: "SWP",
        lead_in_sec: DEF_LEAD, sort_order: tabPools.length });
      setNewName(""); await reload();
    } finally { setBusy(false); }
  };
  const patchPool = async (p: Pool, patch: Partial<Pool>) => { if (ro) return; try { await ether()?.jingleCategories?.updateById(p.id, patch); await reload(); } catch {} };
  const delPool = async (p: Pool) => { if (ro) return; if (!confirm(`Delete pool "${p.name}"? Assigned overlays become unassigned (not deleted).`)) return; try { await ether()?.jingleCategories?.delete(p.uuid, stationId); await reload(); } catch {} };
  const assignSong = async (s: OverlaySong, poolId: number | null) => { if (ro) return; try { await ether()?.songs?.updateById(s.id, { jingle_category_id: poolId }); await reload(); } catch {} };
  const setFallback = async (poolId: number | null) => { if (ro) return; try { await ether()?.stationConfigKv?.upsertByKey(stationId, "overlay_fallback_category_id", poolId != null ? String(poolId) : ""); setFallbackId(poolId); } catch {} };

  // Category assignment: encode as "item:<songId>" | "pool:<poolId>" | "".
  const assignCategory = async (c: MusicCat, value: string) => {
    if (ro) return;
    let patch: Partial<MusicCat> = { overlay_kind: null, overlay_song_id: null, overlay_category_id: null };
    if (value.startsWith("item:")) patch = { overlay_kind: "item", overlay_song_id: Number(value.slice(5)), overlay_category_id: null };
    else if (value.startsWith("pool:")) patch = { overlay_kind: "pool", overlay_category_id: Number(value.slice(5)), overlay_song_id: null };
    try { await ether()?.categories?.updateById(c.id, patch); await reload(); onMutated?.(["categories"]); } catch {}
  };
  const catValue = (c: MusicCat) => c.overlay_kind === "item" && c.overlay_song_id != null ? `item:${c.overlay_song_id}` : c.overlay_kind === "pool" && c.overlay_category_id != null ? `pool:${c.overlay_category_id}` : "";
  const setHours = async (c: MusicCat, mask: number) => { if (ro) return; try { await ether()?.categories?.updateById(c.id, { overlay_active_hours: mask }); await reload(); onMutated?.(["categories"]); } catch {} };

  // LEAD commit. Blank clears the override so the category falls back to the station default (and the
  // box greys to show it). Written through the same categories.updateById path as ACTIVE HOURS, so it
  // syncs and reaches _placeJingles on the next Generate exactly like every other overlay field.
  const commitLead = async (c: MusicCat) => {
    if (ro) return;
    const dk = String(c.id);
    const raw = timingDraft[dk];
    setTimingDraft(d => { const n = { ...d }; delete n[dk]; return n; });
    if (raw === undefined) return;
    let next: number | null = null;
    if (raw.trim() !== "") {
      const n = Number(raw);
      if (!Number.isFinite(n)) return;                     // gibberish → leave the stored value alone
      // BOUNDED AT WHAT THE ENGINE WILL HONOUR. Above (ARM_WINDOW_S - overlap) the sweeper cannot arm in
      // time, so the excess was silently discarded — the control accepted a number the seam never got.
      next = Math.max(0, Math.min(maxLead, Math.round(n)));
    }
    if (next === c.overlay_lead_in_sec) return;
    try { await ether()?.categories?.updateById(c.id, { overlay_lead_in_sec: next }); await reload(); onMutated?.(["categories"]); } catch {}
  };

  const inp: React.CSSProperties = { width: 46, background: "var(--bg-secondary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", borderRadius: "var(--r-0)", padding: "2px 4px", fontSize: "var(--t-body)", fontFamily: "'DM Mono', monospace" };
  const sel: React.CSSProperties = { background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", borderRadius: "var(--r-0)", padding: "3px 6px", fontSize: "var(--t-body)" };

  const swpPools = pools;
  const swpItems = songs;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", color: "var(--text-primary)", minHeight: 0 }}>
      {/* Mode tabs — Manage the imaging library vs. Add imaging (reel splitter / single cut).
          PUSH-UP ONLY: inside IMAGING the surface supplies its own tabs, and a second row of them
          would be the duplicate-door failure this slice exists to end. */}
      {!section && (
      <div style={{ display: "flex", gap: 4, padding: "8px 16px 0", borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}>
        {(["manage", "create"] as const).map(m => (
          <button key={m} onClick={() => { setMode(m); if (m === "manage") reload(); }} style={{
            padding: "6px 14px", background: "transparent", border: "none", borderBottom: `2px solid ${mode === m ? accent : "transparent"}`,
            color: mode === m ? accent : "var(--text-tertiary)", fontWeight: 800, fontSize: "var(--t-body)", letterSpacing: "0.04em", cursor: "pointer",
          }}>{m === "manage" ? "MANAGE" : "ADD IMAGING — CUT A REEL"}</button>
        ))}
      </div>
      )}
      {!section && mode === "create" ? (
        <div style={{ flex: 1, minHeight: 0 }}><ReelSplitter stationId={stationId} embedded onCommitted={reload} /></div>
      ) : (
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16, maxWidth: 900 }}>
      {showAssign && (<>
      <div style={{ fontSize: "var(--t-body)", color: "var(--text-tertiary)", marginBottom: 16, lineHeight: 1.5 }}>
        Overlay imaging fires on the seam between songs (over master). Assign a <b>specific</b> jingle/sweeper
        or a <b>rotating pool</b> to each music category below — some categories get imaging, some don't. Mark
        songs as <b style={{ color: SWP_INDIGO }}>sweepers</b> in the Library first.
      </div>
      {ro && (
        <div style={{ fontSize: "var(--t-body)", color: "var(--text-tertiary)", marginBottom: 12, fontStyle: "italic" }}>
          Read-only here. Edit assignments in the SWEEPERS push-up at the bottom bar.
        </div>
      )}

      {/* ── Category assignments (the core) ── */}
      <div style={{ fontSize: "var(--t-small)", fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-secondary)", textTransform: "uppercase", marginBottom: 8 }}>Category assignments</div>
      {cats.length === 0 ? (
        <div style={{ fontSize: "var(--t-body)", color: "var(--text-tertiary)", fontStyle: "italic", marginBottom: 20 }}>No music categories yet.</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "150px 1fr auto auto", gap: "6px 14px", alignItems: "center", marginBottom: 14 }}>
          <div style={{ fontSize: "var(--t-micro)", color: "var(--text-tertiary)" }}>CATEGORY</div>
          <div style={{ fontSize: "var(--t-micro)", color: "var(--text-tertiary)" }}>OVERLAY</div>
          <div style={{ fontSize: "var(--t-micro)", color: "var(--text-tertiary)" }} title={`Maximum ${maxLead}s. ` + "Seconds before the NEXT song starts that this category's sweeper fires — so it plays over the tail of whatever came before it. The sweeper introduces the song it is assigned to, plays on over its opening and ends when it ends; its length is never an input. A greyed box is the station default; type over it to set this category's own."}>LEAD (s)</div>
          <div style={{ fontSize: "var(--t-micro)", color: "var(--text-tertiary)" }}>ACTIVE HOURS</div>
          {cats.map(c => {
            const rng = rangeFromMask(c.overlay_active_hours ?? ALWAYS);
            const always = rng === null;
            return (
              <Fragment key={c.id}>
                <div key={c.id + "n"} style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden" }}>
                  <span style={{ width: 8, height: 8, borderRadius: "var(--r-0)", background: c.color || "var(--text-tertiary)", flexShrink: 0 }} />
                  <span style={{ fontSize: "var(--t-small)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.code}{c.name && c.name !== c.code ? ` · ${c.name}` : ""}</span>
                </div>
                <select key={c.id + "s"} value={catValue(c)} disabled={ro} onChange={e => assignCategory(c, e.target.value)} style={sel}>
                  <option value="">— none (clean segue) —</option>
                  {swpItems.length > 0 && <optgroup label="Specific sweeper">{swpItems.map(s => <option key={"i" + s.id} value={`item:${s.id}`}>♫ {s.title}</option>)}</optgroup>}

                  {swpPools.length > 0 && <optgroup label="Sweeper pool (rotates)">{swpPools.map(p => <option key={"p" + p.id} value={`pool:${p.id}`}>◆ {p.name}</option>)}</optgroup>}
                </select>
                {(() => {
                  const dk = String(c.id);
                  const draft = timingDraft[dk];
                  const isDefault = c.overlay_lead_in_sec == null && draft === undefined;   // the station default, not a set value
                  return (
                    <div key={c.id + "t"} style={{ display: "flex", alignItems: "center", gap: 4 }}
                      title={(isDefault
                        ? `A ${c.code} song starts with its sweeper already ${DEF_LEAD}s in — the station default. Type a number to give ${c.code} its own.`
                        : `A ${c.code} song starts with its sweeper already ${c.overlay_lead_in_sec}s in. Clear the box to go back to the station default.`)
                        + ` Maximum ${maxLead}s: the engine arms a sweeper ${ARM_WINDOW_S}s before the end and your segue overlap is ${segueOverlap}s, so it cannot honour more.`}>
                      <input type="number" min={0} max={maxLead} step={1}
                        value={draft ?? String(c.overlay_lead_in_sec ?? DEF_LEAD)}
                        disabled={ro}
                        onChange={e => setTimingDraft(d => ({ ...d, [dk]: e.target.value }))}
                        onBlur={() => commitLead(c)}
                        onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                        style={{ ...inp, width: 52, textAlign: "right",
                          opacity: isDefault ? 0.5 : 1,
                          borderColor: isDefault ? "var(--border-primary)" : accent,
                          color: isDefault ? "var(--text-tertiary)" : "var(--text-primary)" }} />
                      <span style={{ fontSize: "var(--t-micro)", color: "var(--text-tertiary)" }}>s</span>
                    </div>
                  );
                })()}
                <div key={c.id + "h"} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: "var(--t-small)", color: "var(--text-secondary)", cursor: "pointer" }}>
                    <input type="checkbox" checked={always} disabled={ro} onChange={e => setHours(c, e.target.checked ? ALWAYS : maskFromRange(6, 19))} /> Always
                  </label>
                  {!always && rng && (
                    <>
                      <select value={rng.from} disabled={ro} onChange={e => setHours(c, maskFromRange(Math.min(Number(e.target.value), rng.to), rng.to))} style={{ ...sel, padding: "2px 4px" }}>
                        {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hhLabel(h)}</option>)}
                      </select>
                      <span style={{ fontSize: "var(--t-small)", color: "var(--text-tertiary)" }}>–</span>
                      <select value={rng.to} disabled={ro} onChange={e => setHours(c, maskFromRange(rng.from, Math.max(Number(e.target.value), rng.from)))} style={{ ...sel, padding: "2px 4px" }}>
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
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 22, fontSize: "var(--t-body)", color: "var(--text-secondary)" }}>
        <span>Fallback for unassigned categories:</span>
        <select value={fallbackId ?? ""} disabled={ro} onChange={e => setFallback(e.target.value ? Number(e.target.value) : null)} style={sel}>
          <option value="">None (clean segue — silence is fine)</option>
          {pools.map(p => <option key={p.id} value={p.id}>{p.type} · {p.name}</option>)}
        </select>
      </div>

      </>)}

      {/* ── Sweeper pools + assignment. One list: there is one imaging class (v52). ── */}
      {showPools && (<>
      {ro && (
        <div style={{ fontSize: "var(--t-body)", color: "var(--text-tertiary)", marginBottom: 12, fontStyle: "italic" }}>
          Read-only here. Create, rename and fill pools in the SWEEPERS push-up at the bottom bar.
        </div>
      )}
      {!ro && (
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === "Enter" && createPool()}
          placeholder="New sweeper pool (e.g. Legal IDs)"
          style={{ flex: 1, maxWidth: 280, background: "var(--bg-secondary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", borderRadius: "var(--r-0)", padding: "6px 10px", fontSize: "var(--t-lead)" }} />
        <button onClick={createPool} disabled={busy || !newName.trim()} style={{ padding: "var(--s-2) var(--s-3)", borderRadius: "var(--r-0)", border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", color: "var(--text-secondary)", fontWeight: 700, fontSize: "var(--t-small)", letterSpacing: "0.06em", textTransform: "uppercase", cursor: "pointer", opacity: busy || !newName.trim() ? 0.5 : 1 }}>Add pool</button>
      </div>
      )}

      {tabPools.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", gap: "6px 12px", alignItems: "center", marginBottom: 16 }}>
          <div style={{ fontSize: "var(--t-micro)", color: "var(--text-tertiary)" }}>POOL</div>
          <div style={{ fontSize: "var(--t-micro)", color: "var(--text-tertiary)" }}>LEAD-IN s</div>
          <div style={{ fontSize: "var(--t-micro)", color: "var(--text-tertiary)" }}>UNDERLAP s</div>
          <div />
          {tabPools.map(p => (
            <Fragment key={p.id}>
              <div key={p.id + "n"} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: p.color || accent }} />
                <input defaultValue={p.name} disabled={ro} onBlur={e => e.target.value.trim() && e.target.value !== p.name && patchPool(p, { name: e.target.value.trim() })}
                  style={{ flex: 1, background: "transparent", color: "var(--text-primary)", border: "1px solid transparent", borderRadius: "var(--r-0)", padding: "2px 4px", fontSize: "var(--t-lead)", fontWeight: 600 }} />
                <span style={{ fontSize: "var(--t-micro)", color: "var(--text-tertiary)" }}>{tabSongs.filter(s => s.jingle_category_id === p.id).length} in pool</span>
              </div>
              {/* Bounded at the same ceiling as the category LEAD. Nothing reads jingle_categories.lead_in_sec
                  today — _placeJingles takes its lead from categories.overlay_lead_in_sec only, and that is
                  filed separately — but an unbounded input is a control that lies whether or not anything
                  is listening. */}
              <input key={p.id + "l"} type="number" disabled={ro} min={0} max={maxLead} step={0.5} title={`Maximum ${maxLead}s — the engine cannot honour a longer lead.`} defaultValue={p.lead_in_sec} onBlur={e => patchPool(p, { lead_in_sec: Math.max(0, Math.min(maxLead, parseFloat(e.target.value) || p.lead_in_sec)) })} style={inp} />
              {ro ? <span key={p.id + "d"} /> :
              <button key={p.id + "d"} onClick={() => delPool(p)} title="Delete pool" style={{ background: "transparent", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: "var(--t-lead)" }}>✕</button>}
            </Fragment>
          ))}
        </div>
      )}

      <div style={{ fontSize: "var(--t-small)", fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-secondary)", textTransform: "uppercase", marginBottom: 8 }}>Sweepers ({tabSongs.length})</div>
      {tabSongs.length === 0 ? (
        <div style={{ fontSize: "var(--t-body)", color: "var(--text-tertiary)", fontStyle: "italic" }}>None tagged. In the Library, right-click an item and choose “Mark as Sweeper”, then assign it to a pool here.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {tabSongs.map(s => (
            <div key={s.id}
              // Sweepers are `songs` rows (content_class SWP/JIN), so the table is songs.
              onContextMenu={e => fileMenu.open(e, { table: "songs", id: s.id, filePath: (s as any).file_path, title: s.title }, reload)}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 8px", background: "var(--bg-secondary)", borderRadius: "var(--r-0)" }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: accent, flexShrink: 0 }} />
              {ro ? (
                <span style={{ fontSize: "var(--t-lead)", flex: 1 }}>{s.title}{s.artist_name ? ` — ${s.artist_name}` : ""}</span>
              ) : (
              <InlineNameEditor
                value={s.title}
                display={<span style={{ fontSize: "var(--t-lead)" }}>{s.title}{s.artist_name ? ` — ${s.artist_name}` : ""}</span>}
                onSave={async (next) => { try { await ether()?.songs?.updateById(s.id, { title: next }); await reload(); } catch {} }}
              />
              )}
              <select value={s.jingle_category_id ?? ""} disabled={ro} onChange={e => assignSong(s, e.target.value ? Number(e.target.value) : null)} style={sel}>
                <option value="">— unassigned —</option>
                {tabPools.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          ))}
        </div>
      )}
      </>)}
      </div>
      )}
      {fileMenu.node}
    </div>
  );
}
