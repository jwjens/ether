import { useState, useRef, useCallback } from "react";
import { query, execute, queryOne } from "../db/client";
import { queryScoped } from "../db/stationScoped";
import { useActiveStation } from "../hooks/useActiveStation";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type System = "wideorbit" | "gselector" | "zetta" | null;

interface RawRow { [key: string]: string }

interface MappedRow {
  title: string;
  artist: string;
  album: string;
  duration_ms: number | null;
  category_code: string;
  rotation_status: string;
  daypart_mask: number | null;
  is_explicit: number;
  energy: number | null;
  bpm: number | null;
  raw_metadata: string; // JSON of unmapped fields
}

interface FieldMapping {
  sourceField: string;        // column name in source file
  targetField: string;        // ether DB field
  confidence: "auto" | "suggested" | "unmapped";
  value?: string;             // sample value from first row
}

interface ParseResult {
  system: System;
  rows: RawRow[];
  headers: string[];
  mappings: FieldMapping[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Field mapping tables per system
// ─────────────────────────────────────────────────────────────────────────────

const ETHER_FIELDS = ["title", "artist", "album", "duration_ms", "category_code",
  "rotation_status", "daypart_mask", "is_explicit", "energy", "bpm"];

// WideOrbit XML/CSV field names → ether fields
const WIDEORBIT_MAP: Record<string, string> = {
  title: "title", "song_title": "title", "name": "title", "cut_name": "title",
  artist: "artist", "artist_name": "artist",
  album: "album", "album_title": "album",
  duration: "duration_ms", "length": "duration_ms", "run_time": "duration_ms",
  category: "category_code", "cart_type": "category_code", "media_type": "category_code",
  rotation: "rotation_status", "rotation_category": "rotation_status", "status": "rotation_status",
  explicit: "is_explicit", "is_explicit": "is_explicit", "explicit_flag": "is_explicit",
  energy: "energy", "energy_level": "energy",
  bpm: "bpm", "tempo": "bpm",
  daypart: "daypart_mask", "daypart_mask": "daypart_mask",
};

// GSelector
const GSELECTOR_MAP: Record<string, string> = {
  "title": "title", "song": "title", "name": "title",
  "artist": "artist", "performer": "artist",
  "album": "album",
  "duration": "duration_ms", "length": "duration_ms", "runtime": "duration_ms",
  "category": "category_code", "type": "category_code", "format": "category_code",
  "rotation": "rotation_status", "status": "rotation_status", "code": "rotation_status",
  "explicit": "is_explicit",
  "energy": "energy", "intensity": "energy",
  "bpm": "bpm", "tempo": "bpm", "beats_per_minute": "bpm",
  "daypart": "daypart_mask", "restriction": "daypart_mask",
};

// Zetta
const ZETTA_MAP: Record<string, string> = {
  "title": "title", "track_title": "title", "cut_title": "title",
  "artist": "artist", "artist_name": "artist",
  "album": "album", "album_name": "album",
  "duration": "duration_ms", "length": "duration_ms", "time": "duration_ms",
  "category": "category_code", "cart_type": "category_code", "group": "category_code",
  "rotation": "rotation_status", "status": "rotation_status",
  "explicit": "is_explicit", "explicit_content": "is_explicit",
  "energy": "energy",
  "bpm": "bpm", "tempo": "bpm",
  "daypart": "daypart_mask", "hour_restriction": "daypart_mask",
};

const SYSTEM_MAPS: Record<string, Record<string, string>> = {
  wideorbit: WIDEORBIT_MAP,
  gselector: GSELECTOR_MAP,
  zetta: ZETTA_MAP,
};

// Generic fallback fuzzy map (used when system is unknown)
const GENERIC_MAP: Record<string, string> = { ...WIDEORBIT_MAP, ...GSELECTOR_MAP, ...ZETTA_MAP };

// ─────────────────────────────────────────────────────────────────────────────
// Parsers
// ─────────────────────────────────────────────────────────────────────────────

function detectSystem(content: string, filename: string): System {
  const low = content.toLowerCase() + filename.toLowerCase();
  if (low.includes("wideorbit") || low.includes("wo_") || low.includes("carttype")) return "wideorbit";
  if (low.includes("gselector") || low.includes("g_selector") || low.includes("mediabay")) return "gselector";
  if (low.includes("zetta") || low.includes("<zettaexport") || low.includes("cutsexport")) return "zetta";
  return null;
}

function parseCSV(content: string): RawRow[] {
  const lines = content.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = splitCSVLine(lines[0]);
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = splitCSVLine(line);
    const row: RawRow = {};
    headers.forEach((h, i) => { row[h.trim()] = (vals[i] || "").trim(); });
    return row;
  });
}

function splitCSVLine(line: string): string[] {
  const result: string[] = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; }
    else if (c === ',' && !inQ) { result.push(cur); cur = ""; }
    else { cur += c; }
  }
  result.push(cur);
  return result;
}

function parseXML(content: string): RawRow[] {
  const rows: RawRow[] = [];
  // Find all record/song/cut/track/item elements
  const recordRe = /<(?:record|song|cut|track|item|entry|Cart)\b[^>]*>([\s\S]*?)<\/(?:record|song|cut|track|item|entry|Cart)>/gi;
  let m: RegExpExecArray | null;
  while ((m = recordRe.exec(content)) !== null) {
    const block = m[1];
    const row: RawRow = {};
    // Extract child elements
    const fieldRe = /<([A-Za-z_][A-Za-z0-9_]*)[^>]*>([^<]*)<\/\1>/g;
    let f: RegExpExecArray | null;
    while ((f = fieldRe.exec(block)) !== null) {
      row[f[1].toLowerCase()] = f[2].trim();
    }
    // Also extract attributes from the parent element
    const attrRe = /([A-Za-z_][A-Za-z0-9_]*)="([^"]*)"/g;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(m[0].split('>')[0])) !== null) {
      if (!row[a[1].toLowerCase()]) row[a[1].toLowerCase()] = a[2].trim();
    }
    if (Object.keys(row).length > 0) rows.push(row);
  }
  return rows;
}

function buildMappings(headers: string[], system: System, sampleRow: RawRow): FieldMapping[] {
  const map = system ? SYSTEM_MAPS[system] : GENERIC_MAP;
  const used = new Set<string>();
  const mappings: FieldMapping[] = [];

  for (const h of headers) {
    const key = h.toLowerCase().replace(/\s+/g, "_");
    const direct = map[key] || map[h.toLowerCase()];
    if (direct && !used.has(direct)) {
      used.add(direct);
      mappings.push({
        sourceField: h,
        targetField: direct,
        confidence: "auto",
        value: sampleRow[h] || "",
      });
    } else {
      // Fuzzy match: find closest ether field name
      const fuzzy = ETHER_FIELDS.find(ef =>
        !used.has(ef) && (key.includes(ef) || ef.includes(key.replace("_ms", "")))
      );
      mappings.push({
        sourceField: h,
        targetField: fuzzy || "unmapped",
        confidence: fuzzy ? "suggested" : "unmapped",
        value: sampleRow[h] || "",
      });
      if (fuzzy) used.add(fuzzy);
    }
  }
  return mappings;
}

// ─────────────────────────────────────────────────────────────────────────────
// Duration normaliser — handles "3:45", "225", "225000", "3m45s"
// ─────────────────────────────────────────────────────────────────────────────

function normaliseDuration(raw: string): number | null {
  if (!raw) return null;
  const mmss = raw.match(/^(\d+):(\d{2})(?:\.(\d+))?$/);
  if (mmss) return (parseInt(mmss[1]) * 60 + parseInt(mmss[2])) * 1000;
  const secs = parseFloat(raw);
  if (!isNaN(secs)) {
    // If value looks like milliseconds (> 3600000 ms = over 60 min, unlikely), treat as ms
    // Values < 7200 treat as seconds, else as ms
    return secs < 7200 ? Math.round(secs * 1000) : Math.round(secs);
  }
  return null;
}

function normaliseRotation(raw: string): string {
  const v = raw.toLowerCase();
  if (v.includes("inact") || v === "0" || v === "off" || v === "no") return "inactive";
  if (v.includes("light") || v.includes("l")) return "light";
  if (v.includes("heavy") || v.includes("h")) return "heavy";
  return "active";
}

function applyMappings(row: RawRow, mappings: FieldMapping[]): MappedRow {
  const result: MappedRow = {
    title: "", artist: "", album: "", duration_ms: null,
    category_code: "", rotation_status: "active", daypart_mask: null,
    is_explicit: 0, energy: null, bpm: null, raw_metadata: "{}",
  };
  const unmapped: Record<string, string> = {};

  for (const m of mappings) {
    const val = row[m.sourceField] || "";
    if (m.targetField === "unmapped" || m.confidence === "unmapped") {
      if (val) unmapped[m.sourceField] = val;
      continue;
    }
    switch (m.targetField) {
      case "title":          result.title          = val; break;
      case "artist":         result.artist         = val; break;
      case "album":          result.album          = val; break;
      case "duration_ms":    result.duration_ms    = normaliseDuration(val); break;
      case "category_code":  result.category_code  = val.toUpperCase().slice(0, 8); break;
      case "rotation_status":result.rotation_status = normaliseRotation(val); break;
      case "daypart_mask":   result.daypart_mask   = parseInt(val) || null; break;
      case "is_explicit":    result.is_explicit    = (val === "1" || val.toLowerCase() === "true" || val.toLowerCase() === "yes" || val.toLowerCase() === "e") ? 1 : 0; break;
      case "energy":         result.energy         = parseFloat(val) || null; break;
      case "bpm":            result.bpm            = parseFloat(val) || null; break;
    }
  }
  result.raw_metadata = JSON.stringify(unmapped);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

interface Props { onClose: () => void; }

const BTN: React.CSSProperties = {
  padding: "8px 20px", border: "1px solid var(--border-secondary)",
  background: "var(--bg-tertiary)", color: "var(--text-secondary)",
  fontSize: 11, fontWeight: 600, cursor: "pointer", letterSpacing: "0.06em",
  textTransform: "uppercase", borderRadius: 0, transition: "all 0.12s",
};
const BTN_PRIMARY: React.CSSProperties = {
  ...BTN, background: "var(--accent-blue)", color: "#fff",
  border: "none", boxShadow: "0 2px 8px rgba(14,165,233,0.3)",
};

type ImportStep = "pick" | "preview" | "importing" | "done";

export default function LibraryImport({ onClose }: Props) {
  const { stationId } = useActiveStation();
  const [step, setStep]           = useState<ImportStep>("pick");
  const [hint, setHint]           = useState<System>(null);
  const [dragging, setDragging]   = useState(false);
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [mappings, setMappings]   = useState<FieldMapping[]>([]);
  const [progress, setProgress]   = useState({ done: 0, total: 0 });
  const [summary, setSummary]     = useState({ imported: 0, skipped: 0, unmapped: 0 });
  const [error, setError]         = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // ── File processing ────────────────────────────────────────────────────────

  const processFile = useCallback(async (file: File) => {
    setError(null);
    const ext = file.name.split(".").pop()?.toLowerCase() || "";
    if (!["xml", "csv"].includes(ext)) {
      setError("Unsupported file type. Please use XML or CSV.");
      return;
    }
    const content = await file.text();
    const detectedSystem = hint || detectSystem(content, file.name);

    let rows: RawRow[] = [];
    try {
      rows = ext === "xml" ? parseXML(content) : parseCSV(content);
    } catch (e) {
      setError("Failed to parse file. Check that it's a valid " + ext.toUpperCase() + ".");
      return;
    }
    if (rows.length === 0) {
      setError("No records found in file.");
      return;
    }

    const headers = Object.keys(rows[0]);
    const maps = buildMappings(headers, detectedSystem, rows[0]);

    setParseResult({ system: detectedSystem, rows, headers, mappings: maps });
    setMappings(maps);
    setStep("preview");
  }, [hint]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  }, [processFile]);

  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  };

  // ── Mapping override ───────────────────────────────────────────────────────

  const updateMapping = (sourceField: string, newTarget: string) => {
    setMappings(prev => prev.map(m =>
      m.sourceField === sourceField
        ? { ...m, targetField: newTarget, confidence: "auto" }
        : m
    ));
  };

  // ── Import ─────────────────────────────────────────────────────────────────

  const startImport = async () => {
    if (!parseResult) return;
    setStep("importing");
    setProgress({ done: 0, total: parseResult.rows.length });

    // Ensure raw_metadata column exists
    try { await execute("ALTER TABLE songs ADD COLUMN raw_metadata TEXT"); } catch {}

    // Pre-load category map
    const cats = await queryScoped<{ id: number; code: string }>("SELECT id, code FROM categories", [], stationId);
    const catMap: Record<string, number> = {};
    cats.forEach(c => { catMap[c.code] = c.id; });

    let imported = 0, skipped = 0, unmappedCount = 0;

    for (let i = 0; i < parseResult.rows.length; i++) {
      const mapped = applyMappings(parseResult.rows[i], mappings);

      if (!mapped.title) { skipped++; setProgress({ done: i + 1, total: parseResult.rows.length }); continue; }

      // Count unmapped fields
      const rawObj = JSON.parse(mapped.raw_metadata || "{}");
      if (Object.keys(rawObj).length > 0) unmappedCount++;

      // Skip duplicate (title + artist match)
      const existing = await queryOne<{ id: number }>(
        "SELECT id FROM songs WHERE title = ? AND (artist_id IN (SELECT id FROM artists WHERE name = ?) OR ? = '')",
        [mapped.title, mapped.artist, mapped.artist]
      );
      if (existing) { skipped++; setProgress({ done: i + 1, total: parseResult.rows.length }); continue; }

      // Resolve or create artist
      let artistId: number | null = null;
      if (mapped.artist) {
        const artistRes = await (window as any).ether.artists.findOrCreateByName(mapped.artist);
        artistId = artistRes.row?.id ?? null;
      }

      // Resolve or create category
      let categoryId: number | null = null;
      if (mapped.category_code && mapped.category_code.length > 0) {
        if (catMap[mapped.category_code]) {
          categoryId = catMap[mapped.category_code];
        } else {
          const colors = ["#3b82f6","#22c55e","#f59e0b","#ef4444","#8b5cf6","#14b8a6"];
          const color = colors[Object.keys(catMap).length % colors.length];
          const res = await (window as any).ether.categories.create({ station_id: stationId, code: mapped.category_code, name: mapped.category_code, color });
          const newId = res.row?.id;
          if (newId) { catMap[mapped.category_code] = newId; categoryId = newId; }
        }
      }

      await (window as any).ether.songs.create({
        title:           mapped.title,
        artist_id:       artistId,
        duration_ms:     mapped.duration_ms,
        category_id:     categoryId,
        rotation_status: mapped.rotation_status,
        daypart_mask:    mapped.daypart_mask,
        is_explicit:     mapped.is_explicit,
        energy:          mapped.energy,
        bpm:             mapped.bpm,
        raw_metadata:    mapped.raw_metadata,
      });
      imported++;
      setProgress({ done: i + 1, total: parseResult.rows.length });
    }

    setSummary({ imported, skipped, unmapped: unmappedCount });
    setStep("done");
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  const systemLabel = (s: System) =>
    s === "wideorbit" ? "WideOrbit" : s === "gselector" ? "GSelector" : s === "zetta" ? "Zetta" : "Unknown";

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 3000,
      background: "rgba(0,0,0,0.72)", backdropFilter: "blur(4px)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        width: 780, maxHeight: "88vh",
        background: "var(--bg-primary)", border: "1px solid var(--border-primary)",
        display: "flex", flexDirection: "column", overflow: "hidden",
      }}>

        {/* Header */}
        <div style={{
          padding: "14px 20px", borderBottom: "1px solid var(--border-primary)",
          display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)", letterSpacing: "-0.01em" }}>
              Import Library
            </div>
            <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 2 }}>
              WideOrbit · GSelector · Zetta — XML and CSV formats
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 18, lineHeight: 1 }}>✕</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflow: "auto", padding: "20px" }}>

          {/* ── STEP: PICK ── */}
          {step === "pick" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

              {/* System selector */}
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 10 }}>
                  Select source system (optional — auto-detected from file)
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  {(["wideorbit", "gselector", "zetta"] as const).map(sys => (
                    <button key={sys} onClick={() => setHint(hint === sys ? null : sys)}
                      style={{
                        ...BTN,
                        flex: 1,
                        padding: "12px 16px",
                        background: hint === sys ? "var(--accent-blue)" : "var(--bg-secondary)",
                        color: hint === sys ? "#fff" : "var(--text-secondary)",
                        border: hint === sys ? "1px solid var(--accent-blue)" : "1px solid var(--border-secondary)",
                        display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
                      }}>
                      <span style={{ fontSize: 13, fontWeight: 700 }}>
                        {sys === "wideorbit" ? "WideOrbit" : sys === "gselector" ? "GSelector" : "Zetta"}
                      </span>
                      <span style={{ fontSize: 9, opacity: 0.7, textTransform: "none", letterSpacing: 0 }}>
                        {sys === "wideorbit" ? "Automation / traffic" : sys === "gselector" ? "Music scheduling" : "Automation / playout"}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Drop zone */}
              <div
                onDragOver={e => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                onClick={() => fileRef.current?.click()}
                style={{
                  border: `2px dashed ${dragging ? "var(--accent-blue)" : "var(--border-secondary)"}`,
                  padding: "48px 20px",
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 10,
                  cursor: "pointer", transition: "border-color 0.15s",
                  background: dragging ? "rgba(14,165,233,0.04)" : "var(--bg-secondary)",
                }}>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)" }}>
                  Drop XML or CSV file here
                </div>
                <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                  or click to browse
                </div>
                <input ref={fileRef} type="file" accept=".xml,.csv" style={{ display: "none" }} onChange={onFileInput} />
              </div>

              {error && (
                <div style={{ padding: "10px 14px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)", color: "#f87171", fontSize: 11 }}>
                  {error}
                </div>
              )}
            </div>
          )}

          {/* ── STEP: PREVIEW ── */}
          {step === "preview" && parseResult && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

              {/* File info */}
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap" as const }}>
                <Chip label="System" value={systemLabel(parseResult.system)} />
                <Chip label="Records" value={String(parseResult.rows.length)} />
                <Chip label="Fields detected" value={String(parseResult.headers.length)} />
                <Chip label="Auto-mapped"
                  value={String(mappings.filter(m => m.confidence === "auto").length)}
                  color="var(--accent-green)" />
                <Chip label="Suggested"
                  value={String(mappings.filter(m => m.confidence === "suggested").length)}
                  color="var(--accent-amber)" />
                <Chip label="Unmapped"
                  value={String(mappings.filter(m => m.confidence === "unmapped").length)}
                  color="var(--text-tertiary)" />
              </div>

              {/* Field mapping table */}
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 8 }}>
                  Field Mapping — edit if needed
                </div>
                <div style={{ border: "1px solid var(--border-primary)", overflow: "hidden" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                    <thead>
                      <tr style={{ background: "var(--bg-secondary)" }}>
                        <Th>Source field</Th>
                        <Th>Sample value</Th>
                        <Th>Maps to</Th>
                        <Th>Status</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {mappings.map((m, idx) => (
                        <tr key={idx} style={{ borderTop: "1px solid var(--border-primary)", background: idx % 2 === 0 ? "var(--bg-primary)" : "var(--bg-secondary)" }}>
                          <td style={{ padding: "6px 12px", fontFamily: "'DM Mono', monospace", color: "var(--text-secondary)", fontSize: 10 }}>
                            {m.sourceField}
                          </td>
                          <td style={{ padding: "6px 12px", color: "var(--text-tertiary)", fontSize: 10, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
                            {m.value || <span style={{ opacity: 0.4 }}>—</span>}
                          </td>
                          <td style={{ padding: "4px 8px" }}>
                            <select
                              value={m.targetField}
                              onChange={e => updateMapping(m.sourceField, e.target.value)}
                              style={{
                                width: "100%", padding: "3px 6px", fontSize: 10,
                                background: "var(--bg-tertiary)", border: "1px solid var(--border-secondary)",
                                color: "var(--text-primary)", borderRadius: 0,
                              }}>
                              <option value="unmapped">— do not import —</option>
                              {ETHER_FIELDS.map(f => (
                                <option key={f} value={f}>{f}</option>
                              ))}
                            </select>
                          </td>
                          <td style={{ padding: "6px 12px" }}>
                            {m.confidence === "auto" && (
                              <span style={{ fontSize: 9, fontWeight: 700, color: "var(--accent-green)", letterSpacing: "0.06em" }}>AUTO</span>
                            )}
                            {m.confidence === "suggested" && (
                              <span style={{ fontSize: 9, fontWeight: 700, color: "var(--accent-amber)", letterSpacing: "0.06em" }}>⚠ SUGGESTED</span>
                            )}
                            {m.confidence === "unmapped" && (
                              <span style={{ fontSize: 9, color: "var(--text-tertiary)", letterSpacing: "0.06em" }}>UNMAPPED</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Sample data preview (first 3 rows) */}
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 8 }}>
                  Preview — first 3 records
                </div>
                <div style={{ border: "1px solid var(--border-primary)", overflow: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, minWidth: 500 }}>
                    <thead>
                      <tr style={{ background: "var(--bg-secondary)" }}>
                        {["title","artist","album","duration","category","rotation"].map(h => <Th key={h}>{h}</Th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {parseResult.rows.slice(0, 3).map((row, i) => {
                        const m = applyMappings(row, mappings);
                        return (
                          <tr key={i} style={{ borderTop: "1px solid var(--border-primary)" }}>
                            <Td>{m.title || <E />}</Td>
                            <Td>{m.artist || <E />}</Td>
                            <Td>{m.album || <E />}</Td>
                            <Td>{m.duration_ms ? Math.round(m.duration_ms / 1000) + "s" : <E />}</Td>
                            <Td>{m.category_code || <E />}</Td>
                            <Td>{m.rotation_status}</Td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 6 }}>
                  Unmapped fields are saved as JSON in <code style={{ fontFamily: "'DM Mono',monospace", background: "var(--bg-tertiary)", padding: "1px 4px" }}>raw_metadata</code> — no data is lost.
                </div>
              </div>

              {/* Actions */}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button style={BTN} onClick={() => { setStep("pick"); setParseResult(null); }}>← Back</button>
                <button style={BTN_PRIMARY} onClick={startImport}>
                  Start Import — {parseResult.rows.length.toLocaleString()} records
                </button>
              </div>
            </div>
          )}

          {/* ── STEP: IMPORTING ── */}
          {step === "importing" && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 20, padding: "40px 0" }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                Importing {progress.total.toLocaleString()} records…
              </div>
              <div style={{ width: "100%", height: 6, background: "var(--bg-tertiary)", overflow: "hidden" }}>
                <div style={{
                  height: "100%", background: "var(--accent-blue)",
                  width: progress.total > 0 ? (progress.done / progress.total * 100) + "%" : "0%",
                  transition: "width 0.1s linear",
                }} />
              </div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                {progress.done.toLocaleString()} / {progress.total.toLocaleString()}
              </div>
            </div>
          )}

          {/* ── STEP: DONE ── */}
          {step === "done" && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 20, padding: "40px 0" }}>
              <div style={{ fontSize: 32, lineHeight: 1 }}>✓</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)" }}>Import complete</div>
              <div style={{ display: "flex", gap: 24 }}>
                <SumBox label="Imported" value={summary.imported} color="var(--accent-green)" />
                <SumBox label="Skipped (duplicate)" value={summary.skipped} color="var(--text-tertiary)" />
                <SumBox label="Unmapped fields saved" value={summary.unmapped} color="var(--accent-amber)" />
              </div>
              {summary.unmapped > 0 && (
                <div style={{ fontSize: 11, color: "var(--text-tertiary)", textAlign: "center" as const, maxWidth: 440 }}>
                  {summary.unmapped} records had fields that don't map to ether's schema. They've been saved in <code style={{ fontFamily: "'DM Mono',monospace" }}>raw_metadata</code> as JSON so nothing is lost.
                </div>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button style={BTN} onClick={() => { setStep("pick"); setParseResult(null); setSummary({ imported: 0, skipped: 0, unmapped: 0 }); }}>
                  Import another file
                </button>
                <button style={BTN_PRIMARY} onClick={onClose}>Done</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helper components
// ─────────────────────────────────────────────────────────────────────────────

function Chip({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ padding: "4px 10px", background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", display: "flex", gap: 6, alignItems: "baseline" }}>
      <span style={{ fontSize: 9, color: "var(--text-tertiary)", letterSpacing: "0.08em", textTransform: "uppercase" }}>{label}</span>
      <span style={{ fontSize: 12, fontWeight: 700, color: color || "var(--text-primary)", fontFamily: "'DM Mono', monospace" }}>{value}</span>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th style={{ padding: "6px 12px", textAlign: "left" as const, fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" as const, color: "var(--text-tertiary)", borderRight: "1px solid var(--border-primary)" }}>{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td style={{ padding: "5px 12px", color: "var(--text-secondary)", borderRight: "1px solid var(--border-primary)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{children}</td>;
}
function E() {
  return <span style={{ opacity: 0.3 }}>—</span>;
}
function SumBox({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ textAlign: "center" as const, padding: "16px 24px", background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", minWidth: 120 }}>
      <div style={{ fontSize: 28, fontWeight: 700, color, fontFamily: "'DM Mono', monospace", lineHeight: 1 }}>{value.toLocaleString()}</div>
      <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 6, letterSpacing: "0.06em" }}>{label}</div>
    </div>
  );
}
