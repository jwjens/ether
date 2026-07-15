// JinglesPanel — JINGLES overlay v1 management (per-station). Create/edit jingle categories (name, color,
// lead-in, underlap, cadence) and assign JIN songs to a pool. Selection lives in the ONE scheduler:
// Generate reads these categories + the cadence and places transition-attached JIN rows; the daemon
// orchestrates the CART overlay fire. Mark a song "JIN" from the Library context menu first; it then
// appears here for pool assignment. Teal is the canonical jingle color (matches the JINGLES fader).
import { useEffect, useState, useCallback } from "react";
import { query } from "../db/client";
import { JIN_TEAL } from "../lib/classColors";

interface JingleCategory {
  id: number; uuid: string; name: string; color: string | null;
  lead_in_sec: number; underlap_sec: number; cadence_every_n: number; sort_order: number;
}
interface JinSong { id: number; title: string; artist_name: string | null; jingle_category_id: number | null; }

const ether = () => (window as any).ether;

export default function JinglesPanel({ stationId }: { stationId: number }) {
  const [cats, setCats] = useState<JingleCategory[]>([]);
  const [songs, setSongs] = useState<JinSong[]>([]);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const r = await ether()?.jingleCategories?.list(stationId);
      setCats((r?.rows || []) as JingleCategory[]);
    } catch { setCats([]); }
    try {
      const rows = await query<JinSong>(
        "SELECT s.id, s.title, a.name AS artist_name, s.jingle_category_id FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.content_class = 'JIN' AND s.deleted_at IS NULL ORDER BY s.title");
      setSongs(rows || []);
    } catch { setSongs([]); }
  }, [stationId]);

  useEffect(() => { reload(); }, [reload]);

  const createCat = async () => {
    const name = newName.trim(); if (!name || busy) return;
    setBusy(true);
    try {
      await ether()?.jingleCategories?.create({ station_id: stationId, name, color: JIN_TEAL, lead_in_sec: 5, underlap_sec: 2, cadence_every_n: 4, sort_order: cats.length });
      setNewName(""); await reload();
    } finally { setBusy(false); }
  };
  const patchCat = async (c: JingleCategory, patch: Partial<JingleCategory>) => {
    try { await ether()?.jingleCategories?.updateById(c.id, patch); await reload(); } catch { /* ignore */ }
  };
  const delCat = async (c: JingleCategory) => {
    let n = 0; try { const r = await ether()?.jingleCategories?.refs(c.uuid); n = r?.songs || 0; } catch {}
    if (!confirm(`Delete jingle category "${c.name}"?${n ? ` ${n} assigned jingle(s) will become unassigned (not deleted).` : ""}`)) return;
    try { await ether()?.jingleCategories?.delete(c.uuid, stationId); await reload(); } catch { /* ignore */ }
  };
  const assignSong = async (s: JinSong, catId: number | null) => {
    try { await ether()?.songs?.updateById(s.id, { jingle_category_id: catId }); await reload(); } catch { /* ignore */ }
  };

  const num = (v: string, d: number) => { const n = parseFloat(v); return Number.isFinite(n) && n >= 0 ? n : d; };
  const inp: React.CSSProperties = { width: 52, background: "var(--bg-secondary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", borderRadius: 3, padding: "2px 4px", fontSize: 12, fontFamily: "'DM Mono', monospace" };

  return (
    <div style={{ padding: 16, color: "var(--text-primary)", maxWidth: 860 }}>
      <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: "0.08em", color: JIN_TEAL, textTransform: "uppercase", marginBottom: 4 }}>Jingles</div>
      <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 16, lineHeight: 1.5 }}>
        Jingle pools rotate least-recently-played and fire as an overlay on the seam between songs (over master).
        <b> lead-in</b> = seconds the jingle starts before the outgoing song ends; <b>underlap</b> = seconds the next song starts before the jingle ends;
        <b> cadence</b> = fire one from this pool every N song transitions. Mark songs "JIN" in the Library, then assign them below.
      </div>

      {/* First-run walkthrough — plain-language 3 steps (shown until the first pool exists). */}
      {cats.length === 0 && (
        <div style={{ border: "1px solid rgba(20,224,200,0.35)", background: "rgba(20,224,200,0.06)", borderRadius: 6, padding: "12px 14px", marginBottom: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: JIN_TEAL, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 8 }}>Set up jingles — 3 steps</div>
          <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.7 }}>
            <li><b>Create a pool</b> below (e.g. “Station IDs”). A pool is a group of jingles that rotate together.</li>
            <li><b>Tag songs as jingles.</b> In the <b>Library</b>, right-click a sting / ID / sweeper and choose <b>“Mark as Jingle (JIN)”</b>. Tagged jingles then appear in the list at the bottom of this page — assign each to your pool.</li>
            <li><b>Set the cadence</b> on the pool (“every N songs”) plus lead-in and underlap seconds. Then <b>Generate</b> your schedule — jingles are placed automatically on the song seams and fire as an overlay on air.</li>
          </ol>
        </div>
      )}

      {/* Categories */}
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-secondary)", textTransform: "uppercase", marginBottom: 8 }}>Pools</div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === "Enter" && createCat()}
          placeholder="New pool name (e.g. Station IDs)" style={{ flex: 1, maxWidth: 280, background: "var(--bg-secondary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", borderRadius: 4, padding: "6px 10px", fontSize: 13 }} />
        <button onClick={createCat} disabled={busy || !newName.trim()} style={{ padding: "6px 14px", borderRadius: 4, border: "none", background: JIN_TEAL, color: "#04201c", fontWeight: 700, fontSize: 13, cursor: "pointer", opacity: busy || !newName.trim() ? 0.5 : 1 }}>Add pool</button>
      </div>

      {cats.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic", marginBottom: 20 }}>No jingle pools yet — add one above. Until a pool exists (with assigned jingles), no jingles are placed.</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto auto", gap: "6px 12px", alignItems: "center", marginBottom: 20 }}>
          <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>POOL</div>
          <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>LEAD-IN s</div>
          <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>UNDERLAP s</div>
          <div style={{ fontSize: 10, color: "var(--text-tertiary)" }}>EVERY N</div>
          <div />
          {cats.map(c => (
            <Row key={c.uuid} c={c} inp={inp} num={num} onName={(v) => patchCat(c, { name: v })}
              onLead={(v) => patchCat(c, { lead_in_sec: v })} onUnder={(v) => patchCat(c, { underlap_sec: v })}
              onCad={(v) => patchCat(c, { cadence_every_n: v })} onDel={() => delCat(c)}
              count={songs.filter(s => s.jingle_category_id === c.id).length} />
          ))}
        </div>
      )}

      {/* JIN song assignment */}
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-secondary)", textTransform: "uppercase", marginBottom: 8 }}>Jingles ({songs.length})</div>
      {songs.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic" }}>No JIN-tagged songs. In the Library, right-click a sting/ID and choose “Mark as Jingle (JIN)”, then assign it to a pool here.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {songs.map(s => (
            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 8px", background: "var(--bg-secondary)", borderRadius: 4 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: JIN_TEAL, flexShrink: 0 }} />
              <span style={{ flex: 1, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}{s.artist_name ? ` — ${s.artist_name}` : ""}</span>
              <select value={s.jingle_category_id ?? ""} onChange={e => assignSong(s, e.target.value ? Number(e.target.value) : null)}
                style={{ background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", borderRadius: 4, padding: "3px 6px", fontSize: 12 }}>
                <option value="">— unassigned —</option>
                {cats.map(c => <option key={c.uuid} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ c, inp, num, onName, onLead, onUnder, onCad, onDel, count }: {
  c: JingleCategory; inp: React.CSSProperties; num: (v: string, d: number) => number;
  onName: (v: string) => void; onLead: (v: number) => void; onUnder: (v: number) => void; onCad: (v: number) => void; onDel: () => void; count: number;
}) {
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: c.color || JIN_TEAL }} />
        <input defaultValue={c.name} onBlur={e => e.target.value.trim() && e.target.value !== c.name && onName(e.target.value.trim())}
          style={{ flex: 1, background: "transparent", color: "var(--text-primary)", border: "1px solid transparent", borderRadius: 3, padding: "2px 4px", fontSize: 13, fontWeight: 600 }} />
        <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>{count} jingle{count === 1 ? "" : "s"}</span>
      </div>
      <input type="number" min={0} step={0.5} defaultValue={c.lead_in_sec} onBlur={e => onLead(num(e.target.value, c.lead_in_sec))} style={inp} />
      <input type="number" min={0} step={0.5} defaultValue={c.underlap_sec} onBlur={e => onUnder(num(e.target.value, c.underlap_sec))} style={inp} />
      <input type="number" min={1} step={1} defaultValue={c.cadence_every_n} onBlur={e => onCad(Math.max(1, Math.round(num(e.target.value, c.cadence_every_n))))} style={inp} />
      <button onClick={onDel} title="Delete pool" style={{ background: "transparent", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 14 }}>✕</button>
    </>
  );
}
