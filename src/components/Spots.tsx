import { useState, useEffect } from "react";
import { query, execute, queryOne } from "../db/client";
const open = (opts?: any) => opts?.directory ? (window as any).ether.dialog.openDirectory() : (window as any).ether.dialog.openFile(opts);
const readDir = (p: string) => (window as any).ether.fs.readDir(p);
import { engine } from "../audio/engine-rodio";

interface Spot {
  id: number; title: string; file_path: string | null;
  spot_type: string; advertiser: string | null;
  start_date: string | null; end_date: string | null;
  max_plays_day: number; plays_today: number;
  plays_total: number; is_active: number;
  notes: string | null;
}

const SPOT_TYPES = ["promo", "psa", "jingle", "liner", "sweeper", "commercial", "imaging"];
const AUDIO_EXTS = [".mp3",".flac",".ogg",".wav",".m4a",".aac",".wma",".aiff"];
function isAudio(n: string) { return AUDIO_EXTS.some(e => n.toLowerCase().endsWith(e)); }
function titleFromFile(p: string) { return (p.split(/[\\/]/).pop() || p).replace(/\.[^.]+$/, "").replace(/[_-]/g, " "); }

const TYPE_COLORS: Record<string, string> = {
  promo: "#38bdf8", psa: "#34d399", jingle: "#a78bfa",
  liner: "#fb923c", sweeper: "#f472b6", commercial: "#fbbf24", imaging: "#22d3ee",
};

export default function Spots() {
  const [spots, setSpots] = useState<Spot[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [editing, setEditing] = useState<Partial<Spot> | null>(null);
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState("");

  const load = async () => {
    const where = filter === "all" ? "" : " WHERE spot_type = '" + filter + "'";
    setSpots(await query<Spot>("SELECT * FROM spots" + where + " ORDER BY title"));
  };
  useEffect(() => { load(); }, [filter]);

  const handleImport = async () => {
    try {
      const files = await open({ multiple: true, title: "Select Spot Audio Files", filters: [{ name: "Audio", extensions: ["mp3","flac","ogg","wav","m4a","aac"] }] });
      if (!files || (Array.isArray(files) && files.length === 0)) return;
      setImporting(true);
      const fileList = Array.isArray(files) ? files : [files];
      let n = 0;
      for (const fp of fileList) {
        const ex = await queryOne<{ id: number }>("SELECT id FROM spots WHERE file_path = ?", [fp]);
        if (!ex) { await execute("INSERT INTO spots (title, file_path, spot_type) VALUES (?, ?, ?)", [titleFromFile(fp), fp, "promo"]); n++; }
      }
      setStatus("Imported " + n + " spots."); setTimeout(() => setStatus(""), 3000);
      setImporting(false); load();
    } catch (e) { console.error(e); setImporting(false); }
  };

  const handleImportFolder = async () => {
    try {
      const folder = await open({ directory: true, title: "Select Spots Folder" });
      if (!folder) return;
      setImporting(true); setStatus("Scanning...");
      const entries = await readDir(folder as string);
      let n = 0;
      for (const e of entries) {
        if (e.name && isAudio(e.name)) {
          const sep = (folder as string).includes("/") ? "/" : "\\";
          const fp = (folder as string) + sep + e.name;
          const ex = await queryOne<{ id: number }>("SELECT id FROM spots WHERE file_path = ?", [fp]);
          if (!ex) { await execute("INSERT INTO spots (title, file_path, spot_type) VALUES (?, ?, ?)", [titleFromFile(fp), fp, "promo"]); n++; }
        }
      }
      setStatus("Imported " + n + " spots."); setTimeout(() => setStatus(""), 3000);
      setImporting(false); load();
    } catch (e) { console.error(e); setImporting(false); }
  };

  const save = async () => {
    if (!editing || !editing.title) return;
    if (editing.id) {
      await execute("UPDATE spots SET title=?, spot_type=?, advertiser=?, start_date=?, end_date=?, max_plays_day=?, is_active=?, notes=? WHERE id=?",
        [editing.title, editing.spot_type || "promo", editing.advertiser || null, editing.start_date || null, editing.end_date || null, editing.max_plays_day || 999, editing.is_active ?? 1, editing.notes || null, editing.id]);
    }
    setEditing(null); load();
  };

  const remove = async (id: number) => { if (!confirm("Delete this spot?")) return; await execute("DELETE FROM spots WHERE id=?", [id]); load(); };

  const playSpot = (spot: Spot) => {
    if (spot.file_path) { engine.init(); engine.loadToDeck("B", spot.file_path, spot.title, spot.spot_type); setTimeout(() => engine.getDeck("B")?.play(), 500); }
  };
  const queueSpot = (spot: Spot) => {
    if (spot.file_path) engine.addToQueue([{ filePath: spot.file_path, title: "[" + spot.spot_type.toUpperCase() + "] " + spot.title, artist: spot.advertiser || "" }]);
  };

  const activeCount = spots.filter(s => s.is_active).length;
  const totalPlays = spots.reduce((s, sp) => s + sp.plays_total, 0);

  const iBtn = (label: string, color: string, onClick: () => void, outline = false) => (
    <button onClick={onClick} style={{
      padding: "7px 14px", borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: "pointer",
      background: outline ? "var(--bg-secondary)" : color,
      color: outline ? "var(--text-secondary)" : "#fff",
      border: outline ? "1px solid var(--border-primary)" : "none",
      opacity: importing ? 0.6 : 1,
    }}>{label}</button>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column" as any, gap: 16, fontFamily: "'Inter', system-ui, sans-serif" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--text-primary)", margin: 0, fontFamily: "'Syne', sans-serif" }}>Spots & Promos</h1>
        <div style={{ display: "flex", gap: 8 }}>
          {iBtn("Import Folder", "var(--accent-blue)", handleImportFolder)}
          {iBtn("Import Files", "", handleImport, true)}
        </div>
      </div>

      {/* Type filter pills */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" as any }}>
        <button onClick={() => setFilter("all")} style={{
          padding: "5px 12px", borderRadius: 20, fontSize: 11, fontWeight: 600, cursor: "pointer",
          background: filter === "all" ? "var(--accent-blue)" : "var(--bg-secondary)",
          color: filter === "all" ? "#fff" : "var(--text-tertiary)",
          border: filter === "all" ? "none" : "1px solid var(--border-primary)",
        }}>All ({spots.length})</button>
        {SPOT_TYPES.map(t => {
          const c = spots.filter(s => s.spot_type === t).length;
          if (c === 0 && filter !== t) return null;
          const color = TYPE_COLORS[t] || "var(--accent-blue)";
          return (
            <button key={t} onClick={() => setFilter(t)} style={{
              padding: "5px 12px", borderRadius: 20, fontSize: 11, fontWeight: 600, cursor: "pointer",
              background: filter === t ? color : "var(--bg-secondary)",
              color: filter === t ? "#000" : "var(--text-tertiary)",
              border: filter === t ? "none" : "1px solid var(--border-primary)",
            }}>{t} ({c})</button>
          );
        })}
      </div>

      {status && <div style={{ padding: "10px 14px", background: "rgba(56,189,248,0.08)", border: "1px solid rgba(56,189,248,0.2)", borderRadius: 8, fontSize: 12, color: "var(--accent-blue)" }}>{status}</div>}

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
        {[
          { label: "Total Spots", value: spots.length, color: "var(--text-primary)" },
          { label: "Active", value: activeCount, color: "var(--accent-green)" },
          { label: "Total Plays", value: totalPlays, color: "var(--text-primary)" },
        ].map(s => (
          <div key={s.label} style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 12, padding: 16, textAlign: "center" as any }}>
            <div style={{ fontSize: 28, fontWeight: 700, fontFamily: "'DM Mono', monospace", letterSpacing: "-0.04em", color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.1em", marginTop: 4 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Edit panel */}
      {editing && (
        <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 12, padding: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", marginBottom: 14, fontFamily: "'Syne', sans-serif" }}>Edit Spot</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 160px", gap: 8, marginBottom: 8 }}>
            <input placeholder="Title" value={editing.title || ""} onChange={e => setEditing({...editing, title: e.target.value})}
              style={{ gridColumn: "1 / 3", padding: "8px 12px", borderRadius: 8, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }} />
            <select value={editing.spot_type || "promo"} onChange={e => setEditing({...editing, spot_type: e.target.value})}
              style={{ padding: "8px 12px", borderRadius: 8, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }}>
              {SPOT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
            <input placeholder="Advertiser" value={editing.advertiser || ""} onChange={e => setEditing({...editing, advertiser: e.target.value})}
              style={{ padding: "8px 12px", borderRadius: 8, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }} />
            <input type="date" value={editing.start_date || ""} onChange={e => setEditing({...editing, start_date: e.target.value})}
              style={{ padding: "8px 12px", borderRadius: 8, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }} />
            <input type="date" value={editing.end_date || ""} onChange={e => setEditing({...editing, end_date: e.target.value})}
              style={{ padding: "8px 12px", borderRadius: 8, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>Max plays/day:</span>
              <input type="number" value={editing.max_plays_day || 999} onChange={e => setEditing({...editing, max_plays_day: parseInt(e.target.value) || 999})}
                style={{ width: 60, padding: "6px 10px", borderRadius: 8, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", textAlign: "center" as any }} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>Active:</span>
              <div onClick={() => setEditing({...editing, is_active: editing.is_active ? 0 : 1})} style={{
                width: 36, height: 20, borderRadius: 10, cursor: "pointer",
                background: editing.is_active ? "var(--accent-green)" : "var(--bg-tertiary)",
                border: "1px solid " + (editing.is_active ? "var(--accent-green)" : "var(--border-secondary)"),
                position: "relative", transition: "background 0.2s",
              }}>
                <div style={{ position: "absolute", top: 3, left: editing.is_active ? 18 : 3, width: 12, height: 12, borderRadius: 6, background: "#fff", transition: "left 0.2s" }} />
              </div>
            </div>
          </div>
          <textarea placeholder="Notes" value={editing.notes || ""} onChange={e => setEditing({...editing, notes: e.target.value})}
            style={{ width: "100%", padding: "8px 12px", borderRadius: 8, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", height: 60, resize: "none" as any, marginBottom: 12, boxSizing: "border-box" as any }} />
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={save} style={{ padding: "7px 18px", borderRadius: 8, fontSize: 12, fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer" }}>Save</button>
            <button onClick={() => setEditing(null)} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Spot list */}
      {spots.length === 0 ? (
        <div style={{ textAlign: "center" as any, padding: "64px 24px" }}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 12, opacity: 0.4 }}><path d="M3 11l19-9-9 19-2-8-8-2z"/></svg>
          <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>No spots yet</div>
          <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginBottom: 20 }}>Import jingles, promos, PSAs, and liners</div>
          <button onClick={handleImportFolder} style={{ padding: "9px 20px", borderRadius: 8, fontSize: 13, fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer" }}>Import Spots Folder</button>
        </div>
      ) : (
        <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 12, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" as any, fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-primary)", background: "var(--bg-tertiary)" }}>
                {["Title", "Type", "Advertiser", "Plays", "Active", ""].map(h => (
                  <th key={h} style={{ padding: "10px 14px", textAlign: "left" as any, fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.1em" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {spots.map((s, i) => {
                const typeColor = TYPE_COLORS[s.spot_type] || "var(--text-tertiary)";
                return (
                  <tr key={s.id}
                    style={{ borderBottom: i < spots.length - 1 ? "1px solid var(--border-primary)" : "none", opacity: s.is_active ? 1 : 0.45 }}
                    onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-hover)")}
                    onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                  >
                    <td style={{ padding: "10px 14px", color: "var(--text-primary)", fontWeight: 500, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>{s.title}</td>
                    <td style={{ padding: "10px 14px" }}>
                      <span style={{ fontSize: 9, fontWeight: 700, color: typeColor, background: typeColor + "20", padding: "2px 8px", borderRadius: 20, textTransform: "uppercase" as any, letterSpacing: "0.06em" }}>{s.spot_type}</span>
                    </td>
                    <td style={{ padding: "10px 14px", color: "var(--text-secondary)" }}>{s.advertiser || "—"}</td>
                    <td style={{ padding: "10px 14px", fontFamily: "'DM Mono', monospace", fontSize: 12, color: "var(--text-tertiary)" }}>{s.plays_total}</td>
                    <td style={{ padding: "10px 14px" }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: s.is_active ? "var(--accent-green)" : "var(--text-tertiary)" }}>{s.is_active ? "Yes" : "No"}</span>
                    </td>
                    <td style={{ padding: "10px 14px" }}>
                      <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                        <button onClick={() => playSpot(s)} style={{ padding: "4px 9px", borderRadius: 6, fontSize: 10, fontWeight: 700, background: "rgba(52,211,153,0.15)", color: "var(--accent-green)", border: "none", cursor: "pointer" }}>▶ Play</button>
                        <button onClick={() => queueSpot(s)} style={{ padding: "4px 9px", borderRadius: 6, fontSize: 10, fontWeight: 700, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>Q</button>
                        <button onClick={() => setEditing(s)} style={{ padding: "4px 9px", borderRadius: 6, fontSize: 10, fontWeight: 700, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>Edit</button>
                        <button onClick={() => remove(s.id)} style={{ padding: "4px 9px", borderRadius: 6, fontSize: 10, fontWeight: 700, background: "transparent", color: "var(--text-tertiary)", border: "none", cursor: "pointer" }}>✕</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
