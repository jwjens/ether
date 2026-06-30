import { useState, useEffect } from "react";
import { queryScoped } from "../db/stationScoped";
import { useActiveStation } from "../hooks/useActiveStation";
const open = (opts?: any) => opts?.directory ? (window as any).ether.dialog.openDirectory() : (window as any).ether.dialog.openFile(opts);
const readDir = (p: string) => (window as any).ether.fs.readDir(p);
import { useAudioEngine } from "../audio/AudioEngineContext";

interface Spot {
  id: number; title: string; file_path: string | null;
  spot_type: string; advertiser: string | null;
  start_date: string | null; end_date: string | null;
  max_plays_day: number; play_count: number;
  is_active: number;
  notes: string | null;
  spot_category_id: number | null;
}

interface SpotCategory { id: number; name: string; color: string | null; uuid: string; }
interface BreakRow { minute: number; spotCategoryId: number | null; count: number; }

const SPOT_TYPES = ["promo", "psa", "jingle", "liner", "sweeper", "commercial", "imaging"];
const AUDIO_EXTS = [".mp3",".flac",".ogg",".wav",".m4a",".aac",".wma",".aiff"];
function isAudio(n: string) { return AUDIO_EXTS.some(e => n.toLowerCase().endsWith(e)); }
function titleFromFile(p: string) { return (p.split(/[\\/]/).pop() || p).replace(/\.[^.]+$/, "").replace(/[_-]/g, " "); }

const TYPE_COLORS: Record<string, string> = {
  promo: "var(--accent-blue)", psa: "#34d399", jingle: "#a78bfa",
  liner: "#fb923c", sweeper: "#f472b6", commercial: "#fbbf24", imaging: "var(--accent-cyan)",
};

export default function Spots() {
  const engine = useAudioEngine();
  const { stationId, isReady } = useActiveStation();
  const [spots, setSpots] = useState<Spot[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [catFilter, setCatFilter] = useState<"all" | "none" | number>("all");
  const [editing, setEditing] = useState<Partial<Spot> | null>(null);
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState("");

  // ── Spot categories (per station) ──────────────────────────────
  const [cats, setCats] = useState<SpotCategory[]>([]);
  const [catCounts, setCatCounts] = useState<Record<number, number>>({});
  const [newCatName, setNewCatName] = useState("");
  const [newCatColor, setNewCatColor] = useState("#8868D8");
  const [editCat, setEditCat] = useState<{ id: number; name: string; color: string } | null>(null);

  // ── Timed spot-break grid (per station; the generator reads this) ──
  const [gridEnabled, setGridEnabled] = useState(false);
  const [breaks, setBreaks] = useState<BreakRow[]>([]);
  const [gridSaved, setGridSaved] = useState(false);

  const load = async () => {
    if (!isReady) return;
    const conds: string[] = [], params: any[] = [];
    if (filter !== "all")    { conds.push("spot_type = ?"); params.push(filter); }
    if (catFilter === "none") conds.push("spot_category_id IS NULL");
    else if (catFilter !== "all") { conds.push("spot_category_id = ?"); params.push(catFilter); }
    const where = conds.length ? " WHERE " + conds.join(" AND ") : "";
    setSpots(await queryScoped<Spot>("SELECT * FROM spots" + where + " ORDER BY title", params, stationId));
  };
  useEffect(() => { load(); }, [filter, catFilter, isReady]);

  const catName = (id: number | null) => (id == null ? null : cats.find(c => c.id === id)?.name ?? null);
  const catColor = (id: number | null) => (id == null ? null : cats.find(c => c.id === id)?.color ?? "var(--accent-blue)");

  const loadCats = async () => {
    if (!isReady) return;
    const res = await (window as any).ether.spotCategories.list(stationId);
    setCats(res?.rows || []);
    const counts = await queryScoped<{ spot_category_id: number; c: number }>(
      "SELECT spot_category_id, COUNT(*) c FROM spots WHERE spot_category_id IS NOT NULL GROUP BY spot_category_id", [], stationId);
    const map: Record<number, number> = {};
    for (const r of counts) map[r.spot_category_id] = r.c;
    setCatCounts(map);
  };

  const loadGrid = async () => {
    if (!isReady) return;
    try {
      const res = await (window as any).ether.stationConfigKv.list(stationId);
      const row = (res?.rows || []).find((r: any) => r.key === "spot_break_grid");
      if (row?.value) {
        const p = JSON.parse(row.value) || {};
        setGridEnabled(!!p.enabled);
        setBreaks(Array.isArray(p.breaks)
          ? p.breaks.map((b: any) => ({
              minute: Math.max(0, Math.min(59, parseInt(b.minute, 10) || 0)),
              spotCategoryId: b.spotCategoryId == null ? null : Number(b.spotCategoryId),
              count: Math.max(1, Math.min(10, parseInt(b.count, 10) || 1)),
            }))
          : []);
      } else { setGridEnabled(false); setBreaks([]); }
    } catch {}
  };

  useEffect(() => { loadCats(); loadGrid(); }, [isReady, stationId]);

  // ── Category CRUD ──────────────────────────────────────────────
  const addCat = async () => {
    const name = newCatName.trim(); if (!name) return;
    const res = await (window as any).ether.spotCategories.create({ station_id: stationId, name, color: newCatColor });
    if (res?.ok === false) { setStatus("Could not add category: " + (res.error || "")); setTimeout(() => setStatus(""), 4000); return; }
    setNewCatName(""); loadCats();
  };
  const saveCat = async () => {
    if (!editCat || !editCat.name.trim()) return;
    await (window as any).ether.spotCategories.updateById(editCat.id, { name: editCat.name.trim(), color: editCat.color });
    setEditCat(null); loadCats();
  };
  const removeCat = async (c: SpotCategory) => {
    if (!confirm(`Delete spot category "${c.name}"?\n\nSpots in it become uncategorized, and any break using it will pull nothing until reassigned.`)) return;
    await (window as any).ether.spotCategories.delete(c.uuid, stationId);
    loadCats(); loadGrid(); load();
  };

  // ── Break grid persistence (per station, in station_config_kv) ──
  const saveGrid = async (enabled: boolean, br: BreakRow[]) => {
    const grid = { enabled, breaks: br.map(b => ({ minute: b.minute, spotCategoryId: b.spotCategoryId, count: b.count })) };
    try {
      await (window as any).ether.stationConfigKv.upsertByKey(stationId, "spot_break_grid", JSON.stringify(grid));
      setGridSaved(true); setTimeout(() => setGridSaved(false), 1200);
    } catch {}
  };
  const toggleGrid = (v: boolean) => { setGridEnabled(v); saveGrid(v, breaks); };
  const addBreakRow = () => { const nb = [...breaks, { minute: 0, spotCategoryId: cats[0]?.id ?? null, count: 1 }]; setBreaks(nb); saveGrid(gridEnabled, nb); };
  const removeBreakRow = (i: number) => { const nb = breaks.filter((_, idx) => idx !== i); setBreaks(nb); saveGrid(gridEnabled, nb); };
  const setBreakField = (i: number, patch: Partial<BreakRow>, persist: boolean) => {
    const nb = breaks.map((b, idx) => idx === i ? { ...b, ...patch } : b);
    setBreaks(nb);
    if (persist) saveGrid(gridEnabled, nb);
  };

  const handleImport = async () => {
    try {
      const files = await open({ multiple: true, title: "Select Spot Audio Files", filters: [{ name: "Audio", extensions: ["mp3","flac","ogg","wav","m4a","aac"] }] });
      if (!files || (Array.isArray(files) && files.length === 0)) return;
      setImporting(true);
      const fileList = Array.isArray(files) ? files : [files];
      let n = 0;
      for (const fp of fileList) {
        const ex = (await queryScoped<{ id: number }>("SELECT id FROM spots WHERE file_path = ?", [fp], stationId))[0] ?? null;
        if (!ex) { await (window as any).ether.spots.create({ station_id: stationId, title: titleFromFile(fp), file_path: fp, spot_type: "promo" }); n++; }
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
          const ex = (await queryScoped<{ id: number }>("SELECT id FROM spots WHERE file_path = ?", [fp], stationId))[0] ?? null;
          if (!ex) { await (window as any).ether.spots.create({ station_id: stationId, title: titleFromFile(fp), file_path: fp, spot_type: "promo" }); n++; }
        }
      }
      setStatus("Imported " + n + " spots."); setTimeout(() => setStatus(""), 3000);
      setImporting(false); load();
    } catch (e) { console.error(e); setImporting(false); }
  };

  // ── Traffic CSV Import ──────────────────────────────────────
  // Standard format: Cart/ISCI, Title, Advertiser, Agency, Length(sec), Start Date, End Date, Spot Type
  // Auto-detects column positions by header. Supports WideOrbit, Marketron, Natural Log exports.
  const handleTrafficImport = async () => {
    try {
      const files = await open({ multiple: false, title: "Select Traffic CSV/TSV", filters: [{ name: "Traffic File", extensions: ["csv", "tsv", "txt"] }] });
      if (!files) return;
      const filePath = Array.isArray(files) ? files[0] : files;
      setImporting(true); setStatus("Reading traffic file...");

      // Read file via IPC
      let content = "";
      try {
        const bytes = await (window as any).ether.invoke("read_audio_file", { filePath });
        content = new TextDecoder().decode(new Uint8Array(bytes));
      } catch {
        // Fallback: try fetch (for local file protocol)
        const resp = await fetch("file://" + filePath);
        content = await resp.text();
      }

      const lines = content.split(/\r?\n/).filter(l => l.trim());
      if (lines.length < 2) { setStatus("File is empty or has no data rows."); setImporting(false); return; }

      // Auto-detect delimiter
      const delim = lines[0].includes("\t") ? "\t" : ",";
      const parseRow = (line: string) => {
        if (delim === "\t") return line.split("\t").map(c => c.trim());
        // CSV with possible quoted fields
        const cols: string[] = [];
        let cur = "", inQ = false;
        for (const ch of line) {
          if (ch === '"') { inQ = !inQ; continue; }
          if (ch === "," && !inQ) { cols.push(cur.trim()); cur = ""; continue; }
          cur += ch;
        }
        cols.push(cur.trim());
        return cols;
      };

      // Parse header to find column indices
      const header = parseRow(lines[0]).map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ""));
      const findCol = (...names: string[]) => header.findIndex(h => names.some(n => h.includes(n)));
      const iTitle      = findCol("title", "name", "description", "spottitle", "cuttitle");
      const iISCI       = findCol("isci", "cart", "cartnumber", "cartno", "cutid", "spotid");
      const iAdvertiser = findCol("advertiser", "client", "sponsor", "agency", "account");
      const iAgency     = findCol("agency", "agencyname");
      const iLength     = findCol("length", "duration", "sec", "len");
      const iStart      = findCol("start", "startdate", "airdate", "firstair");
      const iEnd        = findCol("end", "enddate", "lastair", "killdate", "expire");
      const iType       = findCol("type", "spottype", "class", "material");

      if (iTitle < 0 && iISCI < 0) {
        setStatus("Could not find Title or ISCI/Cart column in header. Check CSV format.");
        setImporting(false); return;
      }

      let imported = 0;
      for (let i = 1; i < lines.length; i++) {
        const cols = parseRow(lines[i]);
        if (cols.length < 2) continue;
        const title = cols[iTitle >= 0 ? iTitle : 0] || `Traffic Item ${i}`;
        const isci = iISCI >= 0 ? cols[iISCI] || null : null;
        const advertiser = iAdvertiser >= 0 ? cols[iAdvertiser] || null : null;
        const agency = iAgency >= 0 ? cols[iAgency] || null : null;
        const lengthSec = iLength >= 0 ? parseInt(cols[iLength]) || null : null;
        const startDate = iStart >= 0 ? cols[iStart] || null : null;
        const endDate = iEnd >= 0 ? cols[iEnd] || null : null;
        const spotType = iType >= 0 ? (cols[iType] || "commercial").toLowerCase() : "commercial";

        // Dedupe by ISCI or title
        const ex = isci
          ? (await queryScoped<{ id: number }>("SELECT id FROM spots WHERE isci_code = ?", [isci], stationId))[0] ?? null
          : (await queryScoped<{ id: number }>("SELECT id FROM spots WHERE title = ? AND advertiser = ?", [title, advertiser], stationId))[0] ?? null;
        if (ex) {
          // Update dates/agency if changed; only pass non-null values to preserve existing data
          const patch: Record<string, any> = { is_active: 1 };
          if (startDate != null) patch.start_date = startDate;
          if (endDate != null) patch.end_date = endDate;
          if (agency != null) patch.agency = agency;
          await (window as any).ether.spots.updateById(ex.id, patch);
          continue;
        }

        await (window as any).ether.spots.create({
          station_id: stationId, title,
          spot_type: SPOT_TYPES.includes(spotType) ? spotType : "commercial",
          advertiser, agency, isci_code: isci, cart_number: isci,
          length_sec: lengthSec, start_date: startDate, end_date: endDate, is_active: 1,
        });
        imported++;
      }

      setStatus(`Imported ${imported} spots from traffic file (${lines.length - 1} rows processed).`);
      setTimeout(() => setStatus(""), 5000);
      setImporting(false); load();
    } catch (e) { console.error("Traffic import error:", e); setStatus("Import failed: " + String(e)); setImporting(false); }
  };

  const save = async () => {
    if (!editing || !editing.title) return;
    if (editing.id) {
      await (window as any).ether.spots.updateById(editing.id, { title: editing.title, spot_type: editing.spot_type || "promo", advertiser: editing.advertiser || null, start_date: editing.start_date || null, end_date: editing.end_date || null, max_plays_day: editing.max_plays_day || 999, is_active: editing.is_active ?? 1, notes: editing.notes || null, spot_category_id: editing.spot_category_id ?? null });
    }
    setEditing(null); load(); loadCats();
  };

  const remove = async (id: number) => { if (!confirm("Delete this spot?")) return; await (window as any).ether.spots.deleteById(id); load(); };

  const playSpot = (spot: Spot) => {
    if (spot.file_path) { engine.init(); engine.loadToDeck("B", spot.file_path, spot.title, spot.spot_type); setTimeout(() => engine.getDeck("B")?.play(), 500); }
  };
  const queueSpot = (spot: Spot) => {
    if (spot.file_path) engine.addToQueue([{ filePath: spot.file_path, title: "[" + spot.spot_type.toUpperCase() + "] " + spot.title, artist: spot.advertiser || "" }]);
  };

  const activeCount = spots.filter(s => s.is_active).length;
  const totalPlays = spots.reduce((s, sp) => s + (sp.play_count || 0), 0);

  const iBtn = (label: string, color: string, onClick: () => void, outline = false) => (
    <button onClick={onClick} style={{
      padding: "7px 14px", borderRadius: 0, fontSize: 11, fontWeight: 600, cursor: "pointer",
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
        <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--text-primary)", margin: 0, fontFamily: "'Newsreader', Georgia, serif" }}>Spots & Promos</h1>
        <div style={{ display: "flex", gap: 8 }}>
          {iBtn("Import Folder", "var(--accent-blue)", handleImportFolder)}
          {iBtn("Import Files", "", handleImport, true)}
          {iBtn("Import Traffic CSV", "var(--accent-amber)", handleTrafficImport)}
        </div>
      </div>

      {/* Type filter pills */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" as any }}>
        <button onClick={() => setFilter("all")} style={{
          padding: "5px 12px", borderRadius: 0, fontSize: 11, fontWeight: 600, cursor: "pointer",
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
              padding: "5px 12px", borderRadius: 0, fontSize: 11, fontWeight: 600, cursor: "pointer",
              background: filter === t ? color : "var(--bg-secondary)",
              color: filter === t ? "#000" : "var(--text-tertiary)",
              border: filter === t ? "none" : "1px solid var(--border-primary)",
            }}>{t} ({c})</button>
          );
        })}
      </div>

      {/* Category filter pills */}
      {cats.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" as any, alignItems: "center" }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.1em", marginRight: 2 }}>Category</span>
          {([["all", "All"], ...cats.map(c => [c.id, `${c.name} (${catCounts[c.id] || 0})`] as [number, string]), ["none", "Uncategorized"]] as [string | number, string][]).map(([val, label]) => {
            const active = catFilter === val;
            const color = typeof val === "number" ? (catColor(val) || "var(--accent-blue)") : "var(--accent-blue)";
            return (
              <button key={String(val)} onClick={() => setCatFilter(val as any)} style={{
                padding: "5px 12px", borderRadius: 0, fontSize: 11, fontWeight: 600, cursor: "pointer",
                background: active ? color : "var(--bg-secondary)",
                color: active ? "#000" : "var(--text-tertiary)",
                border: active ? "none" : "1px solid var(--border-primary)",
              }}>{label}</button>
            );
          })}
        </div>
      )}

      {status && <div style={{ padding: "10px 14px", background: "rgb(from var(--accent-blue) r g b / 0.08)", border: "1px solid rgb(from var(--accent-blue) r g b / 0.2)", borderRadius: 0, fontSize: 12, color: "var(--accent-blue)" }}>{status}</div>}

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
        {[
          { label: "Total Spots", value: spots.length, color: "var(--text-primary)" },
          { label: "Active", value: activeCount, color: "var(--accent-green)" },
          { label: "Total Plays", value: totalPlays, color: "var(--text-primary)" },
        ].map(s => (
          <div key={s.label} style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, padding: 16, textAlign: "center" as any }}>
            <div style={{ fontSize: 28, fontWeight: 700, fontFamily: "'DM Mono', monospace", letterSpacing: "-0.04em", color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.1em", marginTop: 4 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* ── Manage spot categories (per station) ── */}
      <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, padding: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4, fontFamily: "'Newsreader', Georgia, serif" }}>Spot Categories</div>
        <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 14 }}>Group your spots — e.g. Top-of-Hour IDs, Local Sponsors, Ad Campaign. Timed breaks pull from these. Per station.</div>
        {cats.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column" as any, marginBottom: 14 }}>
            {cats.map((c, i) => (
              <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: i < cats.length - 1 ? "1px solid var(--border-primary)" : "none" }}>
                {editCat?.id === c.id ? (
                  <>
                    <input type="color" value={editCat.color} onChange={e => setEditCat({ ...editCat, color: e.target.value })} style={{ width: 28, height: 28, border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", cursor: "pointer", padding: 0 }} />
                    <input value={editCat.name} onChange={e => setEditCat({ ...editCat, name: e.target.value })} onKeyDown={e => { if (e.key === "Enter") saveCat(); if (e.key === "Escape") setEditCat(null); }} autoFocus
                      style={{ flex: 1, padding: "6px 10px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }} />
                    <button onClick={saveCat} style={{ padding: "5px 12px", fontSize: 11, fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer" }}>Save</button>
                    <button onClick={() => setEditCat(null)} style={{ padding: "5px 10px", fontSize: 11, fontWeight: 600, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>Cancel</button>
                  </>
                ) : (
                  <>
                    <span style={{ width: 14, height: 14, borderRadius: 0, background: c.color || "var(--accent-blue)", flexShrink: 0 }} />
                    <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>{c.name}</span>
                    <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace" }}>{catCounts[c.id] || 0} spots</span>
                    <button onClick={() => setEditCat({ id: c.id, name: c.name, color: c.color || "#8868D8" })} style={{ padding: "4px 9px", fontSize: 10, fontWeight: 700, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>Rename</button>
                    <button onClick={() => removeCat(c)} title="Delete category" style={{ padding: "4px 9px", fontSize: 10, fontWeight: 700, background: "transparent", color: "var(--text-tertiary)", border: "none", cursor: "pointer" }}>✕</button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="color" value={newCatColor} onChange={e => setNewCatColor(e.target.value)} title="Category color" style={{ width: 32, height: 32, border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", cursor: "pointer", padding: 0 }} />
          <input placeholder="New category name…" value={newCatName} onChange={e => setNewCatName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") addCat(); }}
            style={{ flex: 1, padding: "8px 12px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }} />
          <button onClick={addCat} style={{ padding: "8px 16px", fontSize: 12, fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer" }}>Add Category</button>
        </div>
      </div>

      {/* ── Timed spot breaks (the core feature — per station) ── */}
      <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", fontFamily: "'Newsreader', Georgia, serif" }}>Timed Spot Breaks</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {gridSaved && <span style={{ fontSize: 11, color: "var(--accent-green)", fontFamily: "'DM Mono', monospace" }}>SAVED</span>}
            <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Enabled</span>
            <div onClick={() => toggleGrid(!gridEnabled)} style={{ width: 36, height: 20, cursor: "pointer", background: gridEnabled ? "var(--accent-green)" : "var(--bg-tertiary)", border: "1px solid " + (gridEnabled ? "var(--accent-green)" : "var(--border-secondary)"), position: "relative", flexShrink: 0 }}>
              <div style={{ position: "absolute", top: 3, left: gridEnabled ? 18 : 3, width: 12, height: 12, background: "#fff", transition: "left 0.2s" }} />
            </div>
          </div>
        </div>
        <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 14 }}>Air breaks at set minutes past every hour, on all clocks for this station. Each break pulls from its category and drops at the next song boundary, so a song is never cut. Empty = no timed breaks.</div>
        {breaks.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--text-tertiary)", padding: "4px 0 14px" }}>No breaks yet — add one below.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" as any, gap: 8, marginBottom: 14, opacity: gridEnabled ? 1 : 0.55 }}>
            <div style={{ display: "grid", gridTemplateColumns: "130px 1fr 110px 36px", gap: 8, fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.08em" }}>
              <span>Minutes past hr</span><span>Spot category</span><span>Spots</span><span></span>
            </div>
            {breaks.map((b, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "130px 1fr 110px 36px", gap: 8, alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ fontSize: 14, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace" }}>:</span>
                  <input type="number" min={0} max={59} value={b.minute}
                    onChange={e => setBreakField(i, { minute: Math.max(0, Math.min(59, parseInt(e.target.value, 10) || 0)) }, true)}
                    style={{ width: 80, padding: "6px 8px", borderRadius: 0, fontSize: 13, fontFamily: "'DM Mono', monospace", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", textAlign: "center" as any }} />
                </div>
                <select value={b.spotCategoryId ?? ""} onChange={e => setBreakField(i, { spotCategoryId: e.target.value === "" ? null : parseInt(e.target.value, 10) }, true)}
                  style={{ padding: "6px 10px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: b.spotCategoryId == null ? "var(--accent-amber)" : "var(--text-primary)", outline: "none" }}>
                  <option value="">— pick a category —</option>
                  {cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <input type="number" min={1} max={10} value={b.count}
                  onChange={e => setBreakField(i, { count: Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 1)) }, true)}
                  style={{ width: 90, padding: "6px 8px", borderRadius: 0, fontSize: 13, fontFamily: "'DM Mono', monospace", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", textAlign: "center" as any }} />
                <button onClick={() => removeBreakRow(i)} title="Remove break" style={{ padding: "6px 9px", fontSize: 12, fontWeight: 700, background: "transparent", color: "var(--text-tertiary)", border: "none", cursor: "pointer" }}>✕</button>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={addBreakRow} style={{ padding: "8px 16px", fontSize: 12, fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer" }}>+ Add break</button>
          {cats.length === 0 && <span style={{ fontSize: 12, color: "var(--accent-amber)" }}>Create a spot category above first, so breaks have something to pull.</span>}
        </div>
      </div>

      {/* Edit panel */}
      {editing && (
        <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, padding: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", marginBottom: 14, fontFamily: "'Newsreader', Georgia, serif" }}>Edit Spot</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 160px", gap: 8, marginBottom: 8 }}>
            <input placeholder="Title" value={editing.title || ""} onChange={e => setEditing({...editing, title: e.target.value})}
              style={{ gridColumn: "1 / 3", padding: "8px 12px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }} />
            <select value={editing.spot_type || "promo"} onChange={e => setEditing({...editing, spot_type: e.target.value})}
              style={{ padding: "8px 12px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }}>
              {SPOT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: "var(--text-tertiary)", whiteSpace: "nowrap" as any }}>Spot category:</span>
            <select value={editing.spot_category_id ?? ""} onChange={e => setEditing({ ...editing, spot_category_id: e.target.value === "" ? null : parseInt(e.target.value, 10) })}
              style={{ flex: 1, padding: "8px 12px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }}>
              <option value="">— No category (won't be pulled by a timed break) —</option>
              {cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
            <input placeholder="Advertiser" value={editing.advertiser || ""} onChange={e => setEditing({...editing, advertiser: e.target.value})}
              style={{ padding: "8px 12px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }} />
            <input type="date" value={editing.start_date || ""} onChange={e => setEditing({...editing, start_date: e.target.value})}
              style={{ padding: "8px 12px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }} />
            <input type="date" value={editing.end_date || ""} onChange={e => setEditing({...editing, end_date: e.target.value})}
              style={{ padding: "8px 12px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>Max plays/day:</span>
              <input type="number" value={editing.max_plays_day || 999} onChange={e => setEditing({...editing, max_plays_day: parseInt(e.target.value) || 999})}
                style={{ width: 60, padding: "6px 10px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", textAlign: "center" as any }} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>Active:</span>
              <div onClick={() => setEditing({...editing, is_active: editing.is_active ? 0 : 1})} style={{
                width: 36, height: 20, borderRadius: 0, cursor: "pointer",
                background: editing.is_active ? "var(--accent-green)" : "var(--bg-tertiary)",
                border: "1px solid " + (editing.is_active ? "var(--accent-green)" : "var(--border-secondary)"),
                position: "relative", transition: "background 0.2s",
              }}>
                <div style={{ position: "absolute", top: 3, left: editing.is_active ? 18 : 3, width: 12, height: 12, borderRadius: 0, background: "#fff", transition: "left 0.2s" }} />
              </div>
            </div>
          </div>
          <textarea placeholder="Notes" value={editing.notes || ""} onChange={e => setEditing({...editing, notes: e.target.value})}
            style={{ width: "100%", padding: "8px 12px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", height: 60, resize: "none" as any, marginBottom: 12, boxSizing: "border-box" as any }} />
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={save} style={{ padding: "7px 18px", borderRadius: 0, fontSize: 12, fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer" }}>Save</button>
            <button onClick={() => setEditing(null)} style={{ padding: "7px 14px", borderRadius: 0, fontSize: 12, fontWeight: 600, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Spot list */}
      {spots.length === 0 ? (
        <div style={{ textAlign: "center" as any, padding: "64px 24px" }}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 12, opacity: 0.4 }}><path d="M3 11l19-9-9 19-2-8-8-2z"/></svg>
          <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>No spots yet</div>
          <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginBottom: 20 }}>Import jingles, promos, PSAs, and liners</div>
          <button onClick={handleImportFolder} style={{ padding: "9px 20px", borderRadius: 0, fontSize: 13, fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer" }}>Import Spots Folder</button>
        </div>
      ) : (
        <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" as any, fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-primary)", background: "var(--bg-tertiary)" }}>
                {["Title", "Type", "Category", "Advertiser", "Plays", "Active", ""].map(h => (
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
                      <span style={{ fontSize: 9, fontWeight: 700, color: typeColor, background: typeColor + "20", padding: "2px 8px", borderRadius: 0, textTransform: "uppercase" as any, letterSpacing: "0.06em" }}>{s.spot_type}</span>
                    </td>
                    <td style={{ padding: "10px 14px" }}>
                      {catName(s.spot_category_id)
                        ? <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-secondary)" }}><span style={{ width: 9, height: 9, background: catColor(s.spot_category_id) || "var(--accent-blue)", flexShrink: 0 }} />{catName(s.spot_category_id)}</span>
                        : <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>—</span>}
                    </td>
                    <td style={{ padding: "10px 14px", color: "var(--text-secondary)" }}>{s.advertiser || "—"}</td>
                    <td style={{ padding: "10px 14px", fontFamily: "'DM Mono', monospace", fontSize: 12, color: "var(--text-tertiary)" }}>{s.play_count}</td>
                    <td style={{ padding: "10px 14px" }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: s.is_active ? "var(--accent-green)" : "var(--text-tertiary)" }}>{s.is_active ? "Yes" : "No"}</span>
                    </td>
                    <td style={{ padding: "10px 14px" }}>
                      <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                        <button onClick={() => playSpot(s)} style={{ padding: "4px 9px", borderRadius: 0, fontSize: 10, fontWeight: 700, background: "rgba(52,211,153,0.15)", color: "var(--accent-green)", border: "none", cursor: "pointer" }}>▶ Play</button>
                        <button onClick={() => queueSpot(s)} style={{ padding: "4px 9px", borderRadius: 0, fontSize: 10, fontWeight: 700, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>Q</button>
                        <button onClick={() => setEditing(s)} style={{ padding: "4px 9px", borderRadius: 0, fontSize: 10, fontWeight: 700, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>Edit</button>
                        <button onClick={() => remove(s.id)} style={{ padding: "4px 9px", borderRadius: 0, fontSize: 10, fontWeight: 700, background: "transparent", color: "var(--text-tertiary)", border: "none", cursor: "pointer" }}>✕</button>
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
