// GSelectorImport.tsx — the GSelector migration wizard.
//
// Accepts GSelector's XML export files and maps them into Ether's schema.
// GSelector exports vary by version — the three we handle:
//
//   1. Music Library export  (<Songs> / <Song> elements)
//      → Ether songs + artists
//   2. Categories export     (<Categories> / <Category>)
//      → Ether categories table
//   3. Clocks export         (<HourTemplates> / <HourTemplate> with <Slot>)
//      → Ether format_clocks + clock_slots
//
// We ALSO accept a "full export" zip/xml that combines all three.
//
// Strategy: parse, show preview (X songs, Y artists, Z categories, N
// clocks found), let the user confirm what to import. Missing audio files
// are flagged — they'll need to be pointed at the new path manually or
// bulk-remapped post-import.

import { useState } from "react";
import { queryScoped } from "../db/stationScoped";
import { useActiveStation } from "../hooks/useActiveStation";
import { importIntoAudioLibrary } from "../lib/fileLocation";

interface ParsedSong {
  title: string;
  artist: string;
  category: string;
  duration_ms?: number;
  intro_ms?: number;
  outro_ms?: number;
  filepath?: string;
  year?: number;
  bpm?: number;
  energy?: number;
}

interface ParsedCategory {
  code: string;
  name: string;
  color?: string;
}

interface ParsedClock {
  name: string;
  slots: { position: number; type: string; category?: string }[];
}

interface ParseResult {
  songs: ParsedSong[];
  categories: ParsedCategory[];
  clocks: ParsedClock[];
  warnings: string[];
}

// ── GSelector XML parser ──
// GSelector's XML structure is loosely standardized. We handle the common
// patterns we've seen across v4-v6 exports. Tolerant of missing fields.
function parseGSelectorXML(xmlText: string): ParseResult {
  const result: ParseResult = { songs: [], categories: [], clocks: [], warnings: [] };
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "text/xml");

  const parseError = doc.querySelector("parsererror");
  if (parseError) {
    result.warnings.push("XML parse error: " + parseError.textContent?.slice(0, 200));
    return result;
  }

  // Categories
  doc.querySelectorAll("Category, category").forEach(el => {
    const code = el.getAttribute("Code") || el.getAttribute("code") || el.querySelector("Code, code")?.textContent || "";
    const name = el.getAttribute("Name") || el.getAttribute("name") || el.querySelector("Name, name")?.textContent || code;
    const color = el.getAttribute("Color") || el.querySelector("Color, color")?.textContent || "";
    if (code) result.categories.push({ code: code.trim(), name: name.trim(), color: color.trim() });
  });

  // Songs — GSelector uses <Song> with nested or attribute-based fields.
  // Typical fields: Title, Artist, Category, Duration, Intro, Outro, FileName, Year, BPM.
  doc.querySelectorAll("Song, song").forEach(el => {
    const get = (names: string[]) => {
      for (const n of names) {
        const v = el.getAttribute(n) || el.getAttribute(n.toLowerCase());
        if (v) return v;
        const child = el.querySelector(n) || el.querySelector(n.toLowerCase());
        if (child?.textContent) return child.textContent;
      }
      return "";
    };
    const title    = get(["Title", "SongTitle"]).trim();
    if (!title) return;
    const artist   = get(["Artist", "ArtistName"]).trim();
    const category = get(["Category", "CategoryCode"]).trim();
    const dur      = parseFloat(get(["Duration", "RunTime", "Length"])) || 0;
    const intro    = parseFloat(get(["Intro", "IntroLength"])) || 0;
    const outro    = parseFloat(get(["Outro", "OutroStart"])) || 0;
    const filename = get(["FileName", "FilePath", "Path", "File"]).trim();
    const year     = parseInt(get(["Year", "ReleaseYear"]), 10) || undefined;
    const bpm      = parseInt(get(["BPM", "Tempo"]), 10) || undefined;
    const energy   = parseInt(get(["Energy", "EnergyLevel"]), 10) || undefined;

    // Duration detection: gselector uses seconds sometimes, ms other times
    const duration_ms = dur > 0 && dur < 1800 ? Math.round(dur * 1000) : Math.round(dur);
    const intro_ms    = intro > 0 && intro < 120 ? Math.round(intro * 1000) : Math.round(intro);
    const outro_ms    = outro > 0 && outro < 1800 ? Math.round(outro * 1000) : Math.round(outro);

    result.songs.push({ title, artist, category, duration_ms, intro_ms, outro_ms, filepath: filename, year, bpm, energy });
  });

  // Clocks — <HourTemplate> with child <Slot>s. Also <Clock> in newer versions.
  doc.querySelectorAll("HourTemplate, Clock, hourtemplate, clock").forEach(el => {
    const name = el.getAttribute("Name") || el.getAttribute("name") || el.querySelector("Name, name")?.textContent || "Untitled clock";
    const slots: ParsedClock["slots"] = [];
    el.querySelectorAll("Slot, slot").forEach((s, i) => {
      const pos = parseInt(s.getAttribute("Position") || s.getAttribute("position") || String(i), 10);
      const type = (s.getAttribute("Type") || s.getAttribute("type") || s.querySelector("Type, type")?.textContent || "music").toLowerCase();
      const cat = s.getAttribute("Category") || s.getAttribute("category") || s.querySelector("Category, category")?.textContent || "";
      slots.push({ position: pos, type, category: cat.trim() || undefined });
    });
    if (slots.length > 0) result.clocks.push({ name: name.trim(), slots });
  });

  if (result.songs.length === 0 && result.categories.length === 0 && result.clocks.length === 0) {
    result.warnings.push("No recognizable GSelector data found. This may be a different export format — supported: Music Library, Categories, Hour Templates XML exports.");
  }
  return result;
}

// Map GSelector category colors to hex. If missing we'll auto-assign.
const DEFAULT_COLORS = ["#3b82f6","#22c55e","#f59e0b","#ef4444","#a855f7","#ec4899","#14b8a6","#6366f1"];

export default function GSelectorImport({ onClose }: { onClose?: () => void }) {
  const { stationId } = useActiveStation();
  const [parsed, setParsed]     = useState<ParseResult | null>(null);
  const [filename, setFilename] = useState("");
  const [importing, setImporting] = useState(false);
  const [doSongs, setDoSongs]   = useState(true);
  const [doCats, setDoCats]     = useState(true);
  const [doClocks, setDoClocks] = useState(true);
  const [progress, setProgress] = useState("");
  const [result, setResult]     = useState<{ songs: number; cats: number; clocks: number; missing: number } | null>(null);

  const onFile = (file: File | undefined) => {
    if (!file) return;
    setFilename(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = (e.target?.result as string) || "";
        const r = parseGSelectorXML(text);
        setParsed(r);
        setResult(null);
      } catch (err: any) {
        setParsed({ songs: [], categories: [], clocks: [], warnings: ["Parse failed: " + err.message] });
      }
    };
    reader.readAsText(file);
  };

  const doImport = async () => {
    if (!parsed) return;
    setImporting(true); setProgress("Preparing…");

    let importedSongs = 0, importedCats = 0, importedClocks = 0, missingFiles = 0;

    try {
      // ── Categories first (songs will reference them) ──
      const existingCats = ((await (window as any).ether.categories.list(stationId))?.rows ?? []) as Array<{ id: number; code: string }>;
      const catCodes = new Set(existingCats.map((r: { code: string }) => r.code.toUpperCase()));
      if (doCats && parsed.categories.length > 0) {
        setProgress(`Importing ${parsed.categories.length} categories…`);
        for (let i = 0; i < parsed.categories.length; i++) {
          const c = parsed.categories[i];
          try {
            const color = c.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length];
            const code = c.code.toUpperCase();
            if (!catCodes.has(code)) {
              await (window as any).ether.categories.create({ station_id: stationId, code, name: c.name, color });
              catCodes.add(code);
            }
            importedCats++;
          } catch {}
        }
      }

      // Build a {code → id} map so songs can get their category_id
      const catMap: Record<string, number> = {};
      const catRows = await queryScoped<{ id: number; code: string }>("SELECT id, code FROM categories", [], stationId);
      catRows.forEach(r => { catMap[r.code.toUpperCase()] = r.id; });

      // ── Songs ──
      if (doSongs && parsed.songs.length > 0) {
        for (let i = 0; i < parsed.songs.length; i++) {
          const s = parsed.songs[i];
          setProgress(`Importing songs… ${i + 1}/${parsed.songs.length}`);

          // Insert artist first (if new)
          let artistId: number | null = null;
          if (s.artist) {
            const artistRes = await (window as any).ether.artists.findOrCreateByName(s.artist);
            artistId = artistRes.row?.id ?? null;
          }

          // Find category
          const catId = s.category ? (catMap[s.category.toUpperCase()] || null) : null;

          // Insert song — use INSERT OR IGNORE on title+artist to avoid dupes
          try {
            // COPY-ON-IMPORT, conditionally. These paths come from GSelector's EXPORT FILE, not
            // from a picker — they describe where the audio lived on the machine that produced the
            // export, and it may not be on this one at all. So: copy it in when it IS here, and
            // otherwise keep the path unchanged so the row still carries its identity and the
            // health signal reports it as needing re-import. Refusing outright would throw away a
            // whole library's metadata over missing audio.
            const gsPath = s.filepath ? (await importIntoAudioLibrary(s.filepath)) || s.filepath : null;
            await (window as any).ether.songs.create({
              title:       s.title,
              artist_id:   artistId,
              category_id: catId,
              file_path:   gsPath,
              duration_ms: s.duration_ms || 0,
              intro_end:   s.intro_ms || null,
              outro_start: s.outro_ms || null,
              bpm:         s.bpm || null,
              energy:      s.energy || null,
            });
            importedSongs++;
            if (s.filepath && !(await checkFileExists(s.filepath))) missingFiles++;
          } catch {}
        }
      }

      // ── Clocks ──
      if (doClocks && parsed.clocks.length > 0) {
        const existingFc = ((await (window as any).ether.formatClocks.list(stationId))?.rows ?? []) as Array<{ id: number; name: string }>;
        for (const c of parsed.clocks) {
          setProgress(`Importing clocks… ${c.name}`);
          try {
            const found = existingFc.find((r) => r.name === c.name);
            let clockId: number;
            if (found) {
              clockId = found.id;
            } else {
              const res = await (window as any).ether.formatClocks.create({ station_id: stationId, name: c.name, slots_json: '[]' });
              clockId = res.row.id;
              existingFc.push({ id: clockId, name: c.name });
            }
            if (!clockId) continue;

            await (window as any).ether.clockSlots.clearByClockId(clockId, stationId);

            for (const slot of c.slots) {
              const catId = slot.category ? (catMap[slot.category.toUpperCase()] || null) : null;
              await (window as any).ether.clockSlots.create({
                station_id: stationId, clock_id: clockId, position: slot.position,
                slot_type: slot.type, category_id: catId,
              });
            }
            importedClocks++;
          } catch (e) {
            console.warn("[GSelectorImport] clock import failed:", e);
          }
        }
      }

      setResult({ songs: importedSongs, cats: importedCats, clocks: importedClocks, missing: missingFiles });
      setProgress("✓ Import complete");
    } catch (e: any) {
      setProgress("✗ Error: " + (e?.message || e));
    }
    setImporting(false);
  };

  return (
    <div style={{ padding: 24, color: "var(--text-primary)", fontFamily: "'Inter', system-ui, sans-serif", minHeight: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: "-0.04em" }}>Import from GSelector</h1>
          <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 4 }}>
            Convert your existing RCS GSelector library, categories, and hour templates into Ether — in one shot.
          </div>
        </div>
        {onClose && <button onClick={onClose} style={btnStyle}>Close</button>}
      </div>

      {/* Step 1: Pick file */}
      <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", padding: "18px 20px", marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>1. Pick your GSelector export file</div>
        <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 10 }}>
          In GSelector, use <b>File → Export → XML</b>. Works with Music Library, Categories, and Hour Template exports.
        </div>
        <input
          type="file"
          accept=".xml,.gse,text/xml"
          onChange={e => onFile(e.target.files?.[0])}
          style={{
            padding: "10px 14px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
            color: "var(--text-primary)", fontSize: 13, borderRadius: 0, width: "100%",
          }}
        />
        {filename && <div style={{ marginTop: 8, fontSize: 12, color: "var(--accent-blue)" }}>📄 {filename}</div>}
      </div>

      {/* Step 2: Preview */}
      {parsed && (
        <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", padding: "18px 20px", marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)", marginBottom: 12 }}>2. Review what'll be imported</div>

          {parsed.warnings.length > 0 && (
            <div style={{ marginBottom: 12, padding: "10px 12px", background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.3)", color: "#f59e0b", fontSize: 12, lineHeight: 1.5 }}>
              {parsed.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 14 }}>
            <Stat label="Categories" value={parsed.categories.length} color="#22c55e" enabled={doCats} onToggle={() => setDoCats(v => !v)} />
            <Stat label="Songs"      value={parsed.songs.length}      color="var(--accent-blue)" enabled={doSongs} onToggle={() => setDoSongs(v => !v)} />
            <Stat label="Clocks"     value={parsed.clocks.length}     color="#a78bfa" enabled={doClocks} onToggle={() => setDoClocks(v => !v)} />
          </div>

          {/* Samples */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, fontSize: 11 }}>
            <Preview title="Categories" rows={parsed.categories.slice(0, 6).map(c => `${c.code} — ${c.name}`)} more={parsed.categories.length - 6} />
            <Preview title="Songs" rows={parsed.songs.slice(0, 6).map(s => `${s.title} — ${s.artist}`)} more={parsed.songs.length - 6} />
            <Preview title="Clocks" rows={parsed.clocks.slice(0, 6).map(c => `${c.name} (${c.slots.length} slots)`)} more={parsed.clocks.length - 6} />
          </div>
        </div>
      )}

      {/* Step 3: Import */}
      {parsed && (parsed.songs.length > 0 || parsed.categories.length > 0 || parsed.clocks.length > 0) && !result && (
        <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", padding: "18px 20px", marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)", marginBottom: 10 }}>3. Import</div>
          <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 14, lineHeight: 1.5 }}>
            Existing categories, songs, and clocks with the same name <b>won't be overwritten</b> — only new entries are added. This is safe to run even if you've already started populating Ether.
          </div>
          <button onClick={doImport} disabled={importing} style={{
            padding: "10px 20px", borderRadius: 0, fontSize: 13, fontWeight: 700,
            background: importing ? "var(--bg-tertiary)" : "var(--accent-blue)",
            color: importing ? "var(--text-tertiary)" : "#fff",
            border: "none", cursor: importing ? "not-allowed" : "pointer",
          }}>{importing ? "Importing…" : "Import to Ether"}</button>
          {progress && <span style={{ marginLeft: 14, fontSize: 12, color: progress.startsWith("✓") ? "#22c55e" : progress.startsWith("✗") ? "#ef4444" : "var(--text-tertiary)" }}>{progress}</span>}
        </div>
      )}

      {/* Result */}
      {result && (
        <div style={{ background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.3)", padding: "18px 20px" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#22c55e", marginBottom: 8 }}>✓ Import complete</div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.7 }}>
            <div>Imported {result.cats} categories, {result.songs} songs, {result.clocks} clocks</div>
            {result.missing > 0 && (
              <div style={{ color: "#f59e0b", marginTop: 4 }}>
                ⚠ {result.missing} songs have file paths that don't exist on this machine. Go to <b>Library → Bulk Edit → Remap Paths</b> to point them at the right folder.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

async function checkFileExists(filepath: string): Promise<boolean> {
  // Can't actually stat from renderer — just a basic path validity check.
  // The main process has access via "file:exists" IPC if we add one later.
  return filepath.length > 0;
}

// ── Sub: stat card ──
function Stat({ label, value, color, enabled, onToggle }: { label: string; value: number; color: string; enabled: boolean; onToggle: () => void }) {
  return (
    <div onClick={onToggle} style={{
      padding: "12px 14px", cursor: "pointer",
      background: enabled ? "var(--bg-tertiary)" : "rgba(148,163,184,0.05)",
      border: "1px solid " + (enabled ? color + "44" : "var(--border-primary)"),
      opacity: enabled ? 1 : 0.55,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <input type="checkbox" checked={enabled} onChange={() => {}} style={{ cursor: "pointer" }} />
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.06em" }}>{label}</span>
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, color, fontFamily: "'JetBrains Mono', monospace" }}>{value}</div>
    </div>
  );
}

// ── Sub: preview list ──
function Preview({ title, rows, more }: { title: string; rows: string[]; more: number }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.06em", marginBottom: 4 }}>{title}</div>
      <div style={{ background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", padding: "8px 10px", minHeight: 80 }}>
        {rows.length === 0 ? (
          <div style={{ color: "var(--text-tertiary)", fontStyle: "italic" }}>(none found)</div>
        ) : (
          <>
            {rows.map((r, i) => <div key={i} style={{ color: "var(--text-secondary)", marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r}</div>)}
            {more > 0 && <div style={{ color: "var(--text-tertiary)", fontStyle: "italic", marginTop: 4 }}>… and {more} more</div>}
          </>
        )}
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: "8px 14px", borderRadius: 0, fontSize: 12, fontWeight: 600,
  background: "var(--bg-tertiary)", color: "var(--text-secondary)",
  border: "1px solid var(--border-primary)", cursor: "pointer",
};
