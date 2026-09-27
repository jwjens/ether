// SpotMarkDialog — "Mark as Spot": pick a spot category (or type a new one) and a type, then markAsSpot tags the
// track SPOT and creates its spots record. ONE dialog for every door — the Library's right-click and the shared song
// menu on decks and Up Next (audit 10). Moved from LibraryPanel unchanged.
import React, { useEffect, useState } from "react";
import { markAsSpot } from "../lib/markAsSpot";

export interface SpotMarkSong { id: number; title: string | null; file_path: string | null }

export default function SpotMarkDialog({ song, stationId, onClose }: { song: SpotMarkSong; stationId: number; onClose: (marked: boolean) => void }) {
  const [catId, setCatId] = useState<number | null>(null);
  const [newCat, setNewCat] = useState("");
  const [type, setType] = useState("commercial");
  const [spotCats, setSpotCats] = useState<{ id: number; name: string; color: string | null }[]>([]);
  useEffect(() => {
    (async () => {
      try { const r = await (window as any).ether.spotCategories.list(stationId); setSpotCats((r && r.rows) || []); } catch { setSpotCats([]); }
    })();
  }, [stationId]);

  const confirm = async () => {
    const r = await markAsSpot((window as any).ether, { stationId, song, catId, newCat, type });
    if (!r.ok) { window.alert(r.reason); return; }
    onClose(true);
  };
  const ready = !!(catId || newCat.trim());

  return (
    <div onMouseDown={() => onClose(false)} style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div onMouseDown={e => e.stopPropagation()} style={{ width: 400, background: "var(--bg-secondary)", border: "1px solid #f59e0b", boxShadow: "0 16px 48px rgba(0,0,0,0.6)", padding: 18 }}>
        <div style={{ fontSize: 14, fontWeight: 800, color: "#f59e0b", marginBottom: 4 }}>Mark as Spot</div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 14, lineHeight: 1.5 }}>
          “{song.title}” leaves music rotation and becomes a spot. Fine-tune dates, max-plays &amp; advertiser later in <strong>Spots &amp; Promos</strong>.
        </div>
        <label style={{ display: "block", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: "var(--text-tertiary)", textTransform: "uppercase" as const, marginBottom: 4 }}>Category <span style={{ color: "#f87171" }}>*required</span></label>
        <select value={catId ?? ""} onChange={e => { setCatId(e.target.value ? Number(e.target.value) : null); setNewCat(""); }}
          style={{ width: "100%", padding: "8px 10px", background: "var(--bg-primary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", fontSize: 13, marginBottom: 8 }}>
          <option value="">— Uncategorized —</option>
          {spotCats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input value={newCat} onChange={e => { setNewCat(e.target.value); if (e.target.value) setCatId(null); }}
          placeholder="…or type a new category name" style={{ width: "100%", padding: "8px 10px", background: "var(--bg-primary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", fontSize: 13, marginBottom: 14 }} />
        <label style={{ display: "block", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: "var(--text-tertiary)", textTransform: "uppercase" as const, marginBottom: 4 }}>Type</label>
        <select value={type} onChange={e => setType(e.target.value)}
          style={{ width: "100%", padding: "8px 10px", background: "var(--bg-primary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", fontSize: 13, marginBottom: 18 }}>
          <option value="commercial">Commercial</option>
          <option value="promo">Promo</option>
          <option value="psa">PSA</option>
          <option value="sponsorship">Sponsorship</option>
        </select>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={() => onClose(false)} style={{ padding: "8px 16px", background: "transparent", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Cancel</button>
          <button onClick={confirm} disabled={!ready} title={ready ? "" : "Pick or create a category first"} style={{ padding: "8px 16px", background: ready ? "#f59e0b" : "var(--surface, #333)", border: `1px solid ${ready ? "#f59e0b" : "var(--border-primary)"}`, color: ready ? "#000" : "var(--text-tertiary)", fontSize: 12, fontWeight: 800, cursor: ready ? "pointer" : "not-allowed", opacity: ready ? 1 : 0.6 }}>Mark as Spot</button>
        </div>
      </div>
    </div>
  );
}
