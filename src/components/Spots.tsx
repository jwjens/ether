import { useState, useEffect } from "react";
import { queryScoped } from "../db/stationScoped";
import { query } from "../db/client";
import { useActiveStation } from "../hooks/useActiveStation";
const open = (opts?: any) => opts?.directory ? (window as any).ether.dialog.openDirectory() : (window as any).ether.dialog.openFile(opts);
const readDir = (p: string) => (window as any).ether.fs.readDir(p);
// Path → fetchable URL (Windows backslashes → forward slashes, three-slash file URL). Matches StudioPro.
const toFileUrl = (p: string) => p.startsWith("http") || p.startsWith("blob:") ? p : `file:///${p.replace(/\\/g, "/")}`;
import { useAudioEngine } from "../audio/AudioEngineContext";
import { clearSpotArtCache } from "../lib/albumArt";

interface Spot {
  id: number; title: string; file_path: string | null;
  spot_type: string; advertiser: string | null;
  start_date: string | null; end_date: string | null;
  max_plays_day: number; play_count: number;
  is_active: number;
  notes: string | null;
  spot_category_id: number | null;
  length_sec: number | null;
  // v36 — operator-chosen artwork, a base64 data URL stored in the row (the station-logo
  // pattern). NULL = no override. Local: choosing an image makes no network call.
  art_image: string | null;
}

interface SpotCategory { id: number; name: string; color: string | null; uuid: string; }

const SPOT_TYPES = ["promo", "psa", "jingle", "liner", "sweeper", "commercial", "imaging"];
const AUDIO_EXTS = [".mp3",".flac",".ogg",".wav",".m4a",".aac",".wma",".aiff"];
function isAudio(n: string) { return AUDIO_EXTS.some(e => n.toLowerCase().endsWith(e)); }
function titleFromFile(p: string) { return (p.split(/[\\/]/).pop() || p).replace(/\.[^.]+$/, "").replace(/[_-]/g, " "); }

// Class-color audit (jingles v1 D3): JIN uses the canonical teal token; commercial stays amber.
const TYPE_COLORS: Record<string, string> = {
  promo: "var(--accent-blue)", psa: "#34d399", jingle: "#14e0c8",
  liner: "#fb923c", sweeper: "#4f46e5", commercial: "#fbbf24", imaging: "var(--accent-cyan)",
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

  // Build-the-sense (v4.4.83): active-clock spot breaks whose category has 0 eligible spots on THIS station.
  // A silent empty break (all spots deleted/inactive/uncategorized, or the break points at another station's
  // category id) becomes a visible fact — this is exactly the failure that aired nothing.
  const [emptyBreaks, setEmptyBreaks] = useState<{ minute: number; category: string; foreign: boolean }[]>([]);

  const load = async () => {
    if (!isReady) return;
    // deleted_at IS NULL is FIRST and unconditional — a soft-deleted spot must never render here. Without it
    // the panel showed deleted rows (so Delete looked dead — the row never left the list — and the panel
    // misreported deleted spots as live). This is the truth-fix (v4.4.83).
    const conds: string[] = ["deleted_at IS NULL"], params: any[] = [];
    if (filter !== "all")    { conds.push("spot_type = ?"); params.push(filter); }
    if (catFilter === "none") conds.push("spot_category_id IS NULL");
    else if (catFilter !== "all") { conds.push("spot_category_id = ?"); params.push(catFilter); }
    const where = " WHERE " + conds.join(" AND ");
    const rows = await queryScoped<Spot>("SELECT * FROM spots" + where + " ORDER BY title", params, stationId);
    setSpots(rows);
    // Repair any fake/missing durations from the file, then re-load once to reflect them (the second pass
    // finds nothing to heal → terminates, no loop).
    if (await healDurations(rows)) load();
  };
  useEffect(() => { load(); }, [filter, catFilter, isReady]);

  // Probe the REAL audio duration (seconds) via the native probe every import uses — so length_sec is
  // truthful (a fake default corrupts the calendar, generator spacing, and anchor-fit). null on failure.
  const probeLen = async (fp: string | null): Promise<number | null> => {
    if (!fp) return null;
    try { const d = await (window as any).ether.audio.getFileDuration(fp); return (typeof d === "number" && d > 0) ? Math.round(d) : null; }
    catch { return null; }
  };
  // Self-heal existing spots whose length_sec is missing or the old 30s default: re-probe from the file.
  // One-shot after each load; only touches rows that need it (bounded), via the proper spots.update IPC.
  const healDurations = async (rows: Spot[]): Promise<boolean> => {
    let changed = false;
    for (const s of rows) {
      if (!s.file_path) continue;
      const cur = s.length_sec;
      if (cur != null && cur !== 30) continue;   // trust a real, non-default value
      const real = await probeLen(s.file_path);
      if (real != null && real !== cur) { try { await (window as any).ether.spots.updateById(s.id, { length_sec: real }); changed = true; } catch {} }
    }
    return changed;
  };

  const catName = (id: number | null) => (id == null ? null : cats.find(c => c.id === id)?.name ?? null);
  const catColor = (id: number | null) => (id == null ? null : cats.find(c => c.id === id)?.color ?? "var(--accent-blue)");

  const loadCats = async () => {
    if (!isReady) return;
    const res = await (window as any).ether.spotCategories.list(stationId);
    setCats(res?.rows || []);
    const counts = await queryScoped<{ spot_category_id: number; c: number }>(
      "SELECT spot_category_id, COUNT(*) c FROM spots WHERE spot_category_id IS NOT NULL AND deleted_at IS NULL GROUP BY spot_category_id", [], stationId);
    const map: Record<number, number> = {};
    for (const r of counts) map[r.spot_category_id] = r.c;
    setCatCounts(map);
  };

  useEffect(() => { loadCats(); }, [isReady, stationId]);

  // Recompute the empty-break sense whenever spots/categories change (so the warning clears the moment
  // Jeff activates/categorizes a spot or re-picks the break's category).
  const loadBreakSense = async () => {
    if (!isReady) return;
    const today = new Date().toISOString().slice(0, 10);
    let breaks: { minute: number; spot_category_id: number | null }[] = [];
    try {
      // Cross-table JOIN → unscoped query() with an explicit station filter (queryScoped can't auto-scope JOINs).
      breaks = await query(
        `SELECT cb.minute, cb.spot_category_id
           FROM clock_breaks cb JOIN shows sh ON sh.clock_id = cb.clock_id
          WHERE sh.station_id = ? AND sh.is_active = 1 AND sh.deleted_at IS NULL AND cb.deleted_at IS NULL
          ORDER BY cb.minute`, [stationId]);
    } catch { breaks = []; }
    const out: { minute: number; category: string; foreign: boolean }[] = [];
    for (const b of breaks) {
      // The EXACT eligibility Generate's SPOT_SELECT_BY_CATEGORY uses.
      const cnt = (await query<{ n: number }>(
        `SELECT COUNT(*) n FROM spots WHERE station_id = ? AND deleted_at IS NULL AND is_active = 1 AND file_path IS NOT NULL
           AND (? IS NULL OR spot_category_id = ?)
           AND (start_date IS NULL OR start_date = '' OR start_date <= ?)
           AND (end_date   IS NULL OR end_date   = '' OR end_date   >= ?)`,
        [stationId, b.spot_category_id, b.spot_category_id, today, today]))[0]?.n ?? 0;
      if (cnt > 0) continue;
      let category = "Any active spot", foreign = false;
      if (b.spot_category_id != null) {
        const c = (await query<{ name: string; station_id: number }>(
          `SELECT name, station_id FROM spot_categories WHERE id = ?`, [b.spot_category_id]))[0];
        if (c) { category = c.name; foreign = c.station_id !== stationId; }
        else { category = `category #${b.spot_category_id}`; foreign = true; }
      }
      out.push({ minute: b.minute, category, foreign });
    }
    setEmptyBreaks(out);
  };
  useEffect(() => { loadBreakSense(); }, [isReady, stationId, spots.length, cats.length]);

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
    const refs = await (window as any).ether.spotCategories.refs(c.uuid);
    const breaks = refs?.breaks || 0, spots = refs?.spots || 0;
    const msg = (breaks + spots === 0)
      ? `Delete spot category "${c.name}"?`
      : `Delete "${c.name}"?\n\nIt's used by ${breaks} timed break(s) and ${spots} spot(s). Deleting will set those breaks to "Any spot" and make those spots uncategorized. This changes what airs on the next Generate.\n\nDelete anyway?`;
    if (!confirm(msg)) return;
    await (window as any).ether.spotCategories.delete(c.uuid, stationId);
    loadCats(); load();
  };

  const handleImport = async () => {
    try {
      const files = await open({ multiple: true, title: "Select Spot Audio Files", filters: [{ name: "Audio", extensions: ["mp3","flac","ogg","wav","m4a","aac"] }] });
      if (!files || (Array.isArray(files) && files.length === 0)) return;
      setImporting(true);
      const fileList = Array.isArray(files) ? files : [files];
      let n = 0, skipped = 0;
      for (const fp of fileList) {
        // deleted_at IS NULL: a soft-deleted spot must NOT block re-import (that was the halloVeen silent
        // failure — its two deleted rows shared this file, so dedup matched and skipped). Only a LIVE dup skips.
        const ex = (await queryScoped<{ id: number }>("SELECT id FROM spots WHERE file_path = ? AND deleted_at IS NULL", [fp], stationId))[0] ?? null;
        if (!ex) { await (window as any).ether.spots.create({ station_id: stationId, title: titleFromFile(fp), file_path: fp, spot_type: "promo", length_sec: await probeLen(fp) }); n++; }
        else skipped++;
      }
      setStatus(`Imported ${n} spot${n === 1 ? "" : "s"}${skipped ? ` · ${skipped} already in the library (skipped)` : ""}.`); setTimeout(() => setStatus(""), 4000);
      setImporting(false); load();
    } catch (e) { console.error(e); setStatus("Import failed: " + String(e)); setImporting(false); }
  };

  const handleImportFolder = async () => {
    try {
      const folder = await open({ directory: true, title: "Select Spots Folder" });
      if (!folder) return;
      setImporting(true); setStatus("Scanning...");
      const entries = await readDir(folder as string);
      let n = 0, skipped = 0;
      for (const e of entries) {
        if (e.name && isAudio(e.name)) {
          const sep = (folder as string).includes("/") ? "/" : "\\";
          const fp = (folder as string) + sep + e.name;
          const ex = (await queryScoped<{ id: number }>("SELECT id FROM spots WHERE file_path = ? AND deleted_at IS NULL", [fp], stationId))[0] ?? null;
          if (!ex) { await (window as any).ether.spots.create({ station_id: stationId, title: titleFromFile(fp), file_path: fp, spot_type: "promo", length_sec: await probeLen(fp) }); n++; }
          else skipped++;
        }
      }
      setStatus(`Imported ${n} spot${n === 1 ? "" : "s"}${skipped ? ` · ${skipped} already in the library (skipped)` : ""}.`); setTimeout(() => setStatus(""), 4000);
      setImporting(false); load();
    } catch (e) { console.error(e); setStatus("Import failed: " + String(e)); setImporting(false); }
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

      // Read the traffic CSV/TSV as text directly from disk (renderer can fetch file:// URLs).
      const content = await (await fetch(toFileUrl(filePath))).text();

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
          ? (await queryScoped<{ id: number }>("SELECT id FROM spots WHERE isci_code = ? AND deleted_at IS NULL", [isci], stationId))[0] ?? null
          : (await queryScoped<{ id: number }>("SELECT id FROM spots WHERE title = ? AND advertiser = ? AND deleted_at IS NULL", [title, advertiser], stationId))[0] ?? null;
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
      await (window as any).ether.spots.updateById(editing.id, { title: editing.title, spot_type: editing.spot_type || "promo", advertiser: editing.advertiser || null, start_date: editing.start_date || null, end_date: editing.end_date || null, max_plays_day: editing.max_plays_day || 999, is_active: editing.is_active ?? 1, notes: editing.notes || null, spot_category_id: editing.spot_category_id ?? null, art_image: editing.art_image || null });
      // Drop the cached artwork for this file so the new override shows on air immediately
      // instead of after a restart.
      clearSpotArtCache(editing.file_path ?? null, stationId);
    }
    setEditing(null); load(); loadCats();
  };

  // ── Artwork override ──────────────────────────────────────────────────────────
  // Reuses the station-logo picker (electron/main.js:5586): it opens an image dialog, reads the
  // file in main, and returns a base64 data URL. It makes NO network call — the bytes go into the
  // spots row and nowhere else. Saved by `save()` above through the existing updateById.
  const chooseArt = async () => {
    if (!editing) return;
    const result = await (window as any).ether.station.uploadLogo();
    if (result?.ok && result.dataUrl) setEditing({ ...editing, art_image: result.dataUrl });
  };
  const clearArt = () => { if (editing) setEditing({ ...editing, art_image: null }); };

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
          {iBtn("Add Files", "var(--accent-green)", handleImport)}
          {iBtn("Import Folder", "var(--accent-blue)", handleImportFolder)}
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

      {/* Empty-break sense — silent breaks that would air nothing, made visible (v4.4.83). */}
      {emptyBreaks.length > 0 && (
        <div style={{ padding: "12px 14px", background: "rgba(251,191,36,0.08)", border: "1px solid rgba(251,191,36,0.45)", borderRadius: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: "#fbbf24", marginBottom: 4 }}>⚠ {emptyBreaks.length} spot break{emptyBreaks.length > 1 ? "s" : ""} on this station's active clock will air NOTHING</div>
          <div style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.5 }}>
            Each pulls a category with <strong>0 eligible spots</strong> (active, categorized, in-flight, on-disk):
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {emptyBreaks.map((e, i) => (
                <li key={i}>:{String(e.minute).padStart(2, "0")} → <strong>{e.category}</strong>{e.foreign
                  ? <> — that category belongs to <em>another station</em>; re-pick it in <strong>Clocks → Timed Spot Breaks</strong></>
                  : " — add or activate a spot in this category"}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

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
        <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 14 }}>Group your spots — e.g. Top-of-Hour IDs, Local Sponsors, Ad Campaign. A spot-break slot in your clocks pulls from one of these. Per station.</div>
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
          {/* Notes + Artwork, side by side — artwork sits beside Advertiser and Notes. */}
          <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "stretch" }}>
            <textarea placeholder="Notes" value={editing.notes || ""} onChange={e => setEditing({...editing, notes: e.target.value})}
              style={{ flex: 1, padding: "8px 12px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", height: 84, resize: "none" as any, boxSizing: "border-box" as any }} />

            <div style={{ display: "flex", gap: 10, alignItems: "center", padding: 10, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", boxSizing: "border-box" as any, minWidth: 250 }}>
              {/* Thumbnail, or an empty state that explains itself */}
              {editing.art_image ? (
                <img src={editing.art_image} alt="Spot artwork"
                  style={{ width: 64, height: 64, objectFit: "cover" as any, border: "1px solid var(--border-secondary)", flexShrink: 0, background: "var(--bg-secondary)" }} />
              ) : (
                <div style={{ width: 64, height: 64, flexShrink: 0, border: "1px dashed var(--border-secondary)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, lineHeight: 1.25, textAlign: "center" as any, color: "var(--text-tertiary)", padding: 4, boxSizing: "border-box" as any }}>
                  No artwork
                </div>
              )}
              <div style={{ display: "flex", flexDirection: "column" as any, gap: 6, minWidth: 0 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-secondary)" }}>Artwork</span>
                <span style={{ fontSize: 10, color: "var(--text-tertiary)", lineHeight: 1.3 }}>
                  {editing.art_image ? "Stays on this computer." : "Pick your own image for this spot."}
                </span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={chooseArt} style={{ padding: "5px 10px", borderRadius: 0, fontSize: 11, fontWeight: 600, background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer", whiteSpace: "nowrap" as any }}>Choose image…</button>
                  <button onClick={clearArt} disabled={!editing.art_image}
                    style={{ padding: "5px 10px", borderRadius: 0, fontSize: 11, fontWeight: 600, background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: editing.art_image ? "pointer" : "default", opacity: editing.art_image ? 1 : 0.4, whiteSpace: "nowrap" as any }}>Clear</button>
                </div>
              </div>
            </div>
          </div>
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
          <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginBottom: 20 }}>Import jingles, promos, PSAs, and liners — pick individual files or a whole folder</div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center" as any }}>
            <button onClick={handleImport} style={{ padding: "9px 20px", borderRadius: 0, fontSize: 13, fontWeight: 700, background: "var(--accent-green)", color: "#fff", border: "none", cursor: "pointer" }}>Add Files</button>
            <button onClick={handleImportFolder} style={{ padding: "9px 20px", borderRadius: 0, fontSize: 13, fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer" }}>Import Folder</button>
          </div>
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
                    <td style={{ padding: "10px 14px", color: "var(--text-primary)", fontWeight: 500, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>
                      {s.title}
                      {(!s.is_active || s.spot_category_id == null) && (
                        <span
                          title={`This spot will not be placed by Generate — ${!s.is_active ? "it is inactive" : ""}${!s.is_active && s.spot_category_id == null ? " and " : ""}${s.spot_category_id == null ? "it has no category (category breaks pull spots by category)" : ""}. Edit it to fix.`}
                          style={{ marginLeft: 8, padding: "1px 6px", fontSize: 9, fontWeight: 800, fontFamily: "'DM Mono', monospace", color: "#fbbf24", background: "rgba(251,191,36,0.14)", border: "1px solid rgba(251,191,36,0.45)", letterSpacing: "0.05em", verticalAlign: "middle" as any }}
                        >⚠ WON'T AIR</span>
                      )}
                    </td>
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
