import { useState, useEffect } from "react";
import { query } from "../db/client";
import { queryScoped } from "../db/stationScoped";
import { useActiveStation } from "../hooks/useActiveStation";
const open = (opts?: { directory?: boolean; title?: string }) =>
  opts?.directory ? (window as any).ether.dialog.openDirectory() : (window as any).ether.dialog.openFile(opts);
const readDir = (path: string) => (window as any).ether.fs.readDir(path);
import { importIntoAudioLibrary } from "../lib/fileLocation";
import { readID3 } from "../audio/id3";
import { analyzeAndSave } from "../audio/songAnalysis";

interface Category {
  id: number;
  code: string;
  name: string;
  color: string;
}

interface Props {
  onDone: () => void;
}

export default function ImportDialog({ onDone }: Props) {
  const { stationId, isReady } = useActiveStation();
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedCat, setSelectedCat] = useState<number | null>(null);
  const [newCatName, setNewCatName] = useState("");
  const [newCatCode, setNewCatCode] = useState("");
  const [step, setStep] = useState<"pick" | "importing" | "done">("pick");
  const [progress, setProgress] = useState({ done: 0, total: 0, current: "" });
  const [imported, setImported] = useState(0);
  // Files the catalogue refused (disk full, permissions, a name that could not be placed).
  const [refusedFiles, setRefusedFiles] = useState<string[]>([]);

  useEffect(() => {
    if (!isReady) return;
    (async () => {
      const cats = await queryScoped<Category>("SELECT id, code, name, color FROM categories ORDER BY code", [], stationId);
      setCategories(cats);
    })();
  }, [isReady]);

  const createCategory = async () => {
    if (!newCatCode.trim() || !newCatName.trim()) return;
    const colors = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#8b5cf6", "#ec4899", "#14b8a6", "#6366f1"];
    const color = colors[categories.length % colors.length];
    await (window as any).ether.categories.create({ station_id: stationId, code: newCatCode.trim().toUpperCase(), name: newCatName.trim(), color });
    const cats = await queryScoped<Category>("SELECT id, code, name, color FROM categories ORDER BY code", [], stationId);
    setCategories(cats);
    const newCat = cats.find(c => c.code === newCatCode.trim().toUpperCase());
    if (newCat) setSelectedCat(newCat.id);
    setNewCatCode("");
    setNewCatName("");
  };

  const AUDIO_EXTS = [".mp3", ".flac", ".ogg", ".wav", ".m4a", ".aac", ".aiff"];

  // Shared import pipeline — one function, fed by either a folder scan or a file picker.
  const importFiles = async (files: string[]) => {
    setStep("importing");
    setProgress({ done: 0, total: files.length, current: "Importing..." });

    let count = 0;
    const refused: string[] = [];
    for (const browsedPath of files) {
      try {
        // ── COPY-ON-IMPORT ────────────────────────────────────────────────────────────────────
        // The song row stores the CATALOGUE path, never the browsed one. Import used to write the
        // path the operator picked, which is why 1,113 files ended up in the catalogue folder with
        // no row and rows ended up pointing at folders other machines cannot open.
        // A refusal is COLLECTED and shown at the end — never a silent skip, and never a row.
        const filePath = await importIntoAudioLibrary(browsedPath);
        if (!filePath) { refused.push(browsedPath.split(/[\/]/).pop() || browsedPath); continue; }

        // Check if already imported
        const existing = await (query<{ id: number }>("SELECT id FROM songs WHERE file_path = ?", [filePath]).then(r => r[0] ?? null));
        if (existing) {
          // Update category if one was selected
          if (selectedCat) {
            await (window as any).ether.songs.updateById(existing.id, { category_id: selectedCat });
          }
          count++;
          setProgress({ done: count, total: files.length, current: filePath.split(/[\\/]/).pop() || "" });
          continue;
        }

        // Read ID3 tags
        const tags = await readID3(filePath);
        const title = tags.title || filePath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || "Unknown";
        const artistName = tags.artist || "Unknown";

        // Get or create artist
        const artistRes = await (window as any).ether.artists.findOrCreateByName(artistName);
        const artist = artistRes.row;

        // Insert song (skip album lookup for reliability)
        await (window as any).ether.songs.create({
          title,
          file_path:   filePath,
          artist_id:   artist?.id || null,
          category_id: selectedCat,
          genre:       tags.genre || null,
          duration_ms: tags.durationSec != null ? Math.round(tags.durationSec * 1000) : undefined,
        });

        // Auto-analyze: BPM, LUFS, energy, cue points — runs in Rust background thread.
        // Non-blocking: we don't await so import stays fast; analysis happens in parallel.
        const inserted = await (query<{ id: number }>("SELECT id FROM songs WHERE file_path = ?", [filePath]).then(r => r[0] ?? null));
        if (inserted) {
          analyzeAndSave(inserted.id, filePath).catch(e => console.warn("[Import] analysis skipped:", title, e));
        }

        count++;
        setProgress({ done: count, total: files.length, current: title });
      } catch (e: any) {
        console.error("Import error:", e);
        count++;
        setProgress({ done: count, total: files.length, current: `Error: ${e?.message ?? String(e)}` });
      }
    }

    setImported(count);
    // A partial success must SAY which files did not make it, and the list has to stay on screen.
    // A refusal the operator never sees is the same as no refusal at all — they find out later, when
    // the track is due to air.
    setRefusedFiles(refused);
    setStep("done");
  };

  // Entry shape 1 — a folder (recursively scanned for audio files).
  const startImport = async () => {
    const folder = await open({ directory: true, title: "Select music folder to import" });
    if (!folder) return;
    const folderPath = Array.isArray(folder) ? folder[0] : folder;

    setStep("importing");
    setProgress({ done: 0, total: 0, current: "Scanning folder..." });

    const files: string[] = [];
    const scanDir = async (dirPath: string) => {
      try {
        const entries = await readDir(dirPath);
        for (const entry of entries) {
          const fullPath = dirPath + "/" + entry.name;
          if (entry.isDir) {
            await scanDir(fullPath);
          } else {
            const ext = "." + (entry.name.split(".").pop() || "").toLowerCase();
            if (AUDIO_EXTS.includes(ext)) files.push(fullPath);
          }
        }
      } catch (e) {
        console.error("Scan error:", e);
      }
    };

    await scanDir(folderPath);
    await importFiles(files);
  };

  // Entry shape 2 — one or more individual audio files (multi-select file picker).
  const startFileImport = async () => {
    const picked = await (window as any).ether.dialog.openFile({
      multiple: true,
      title: "Select audio file(s) to import",
      filters: [{ name: "Audio", extensions: AUDIO_EXTS.map(e => e.slice(1)) }],
    });
    if (!picked) return;
    const files = (Array.isArray(picked) ? picked : [picked]).filter(Boolean);
    if (!files.length) return;
    await importFiles(files);
  };

  return (
    <div style={{
      background: "var(--bg-secondary)",
      borderRadius: "var(--radius)",
      border: "1px solid var(--border-primary)",
      boxShadow: "var(--shadow-md)",
      padding: 20,
      marginBottom: 16,
    }}>
      {step === "pick" && (
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>Import Music</h3>
          <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 16 }}>
            Import a whole folder or pick individual songs. Choose a category for the imported songs — great for seasonal music (Christmas, Halloween), format-specific libraries, or organizing by rotation.
          </p>

          {/* Category selection */}
          <div style={{ fontSize: 11, fontWeight: 500, color: "var(--text-secondary)", textTransform: "uppercase" as any, letterSpacing: "0.06em", marginBottom: 8 }}>
            Assign to Category
          </div>
          <div style={{ display: "flex", flexWrap: "wrap" as any, gap: 6, marginBottom: 16 }}>
            <button
              onClick={() => setSelectedCat(null)}
              style={{
                padding: "6px 14px",
                borderRadius: 0,
                fontSize: 12,
                fontWeight: selectedCat === null ? 600 : 400,
                background: selectedCat === null ? "var(--accent-blue)" : "var(--bg-tertiary)",
                color: selectedCat === null ? "#fff" : "var(--text-secondary)",
                border: "none",
                cursor: "pointer",
              }}
            >No Category</button>
            {categories.map(c => (
              <button
                key={c.id}
                onClick={() => setSelectedCat(c.id)}
                style={{
                  padding: "6px 14px",
                  borderRadius: 0,
                  fontSize: 12,
                  fontWeight: selectedCat === c.id ? 600 : 400,
                  background: selectedCat === c.id ? (c.color || "var(--accent-blue)") : "var(--bg-tertiary)",
                  color: selectedCat === c.id ? "#fff" : "var(--text-secondary)",
                  border: selectedCat === c.id ? "none" : "1px solid var(--border-primary)",
                  cursor: "pointer",
                }}
              >{c.code} — {c.name}</button>
            ))}
          </div>

          {/* Create new category */}
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 16 }}>
            <input
              placeholder="Code (e.g. XMAS)"
              value={newCatCode}
              onChange={e => setNewCatCode(e.target.value)}
              style={{ width: 90, padding: "6px 10px", borderRadius: 0, fontSize: 12, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)" }}
            />
            <input
              placeholder="Name (e.g. Christmas)"
              value={newCatName}
              onChange={e => setNewCatName(e.target.value)}
              style={{ flex: 1, padding: "6px 10px", borderRadius: 0, fontSize: 12, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)" }}
            />
            <button
              onClick={createCategory}
              style={{ padding: "6px 14px", borderRadius: 0, fontSize: 12, fontWeight: 600, background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}
            >+ New</button>
          </div>

          {/* Import button */}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={startImport}
              style={{
                padding: "10px 24px",
                borderRadius: 0,
                fontSize: 13,
                fontWeight: 600,
                background: "var(--accent-blue)",
                color: "#fff",
                border: "none",
                cursor: "pointer",
              }}
            >Choose Folder & Import</button>
            <button
              onClick={startFileImport}
              style={{
                padding: "10px 24px",
                borderRadius: 0,
                fontSize: 13,
                fontWeight: 600,
                background: "var(--bg-tertiary)",
                color: "var(--text-primary)",
                border: "1px solid var(--accent-blue)",
                cursor: "pointer",
              }}
            >Choose File(s) & Import</button>
            <button
              onClick={onDone}
              style={{
                padding: "10px 16px",
                borderRadius: 0,
                fontSize: 13,
                fontWeight: 400,
                background: "var(--bg-tertiary)",
                color: "var(--text-secondary)",
                border: "none",
                cursor: "pointer",
              }}
            >Cancel</button>
          </div>
        </div>
      )}

      {step === "importing" && (
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>Importing...</h3>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 8 }}>{progress.current}</div>
          <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 8 }}>{progress.done} / {progress.total}</div>
          {progress.total > 0 && (
            <div style={{ height: 4, background: "var(--bg-tertiary)", borderRadius: 0, overflow: "hidden" }}>
              <div style={{ height: "100%", width: (progress.done / progress.total * 100) + "%", background: "var(--accent-blue)", borderRadius: 0, transition: "width 0.2s" }}></div>
            </div>
          )}
        </div>
      )}

      {step === "done" && (
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--accent-green)", marginBottom: 8 }}>Import Complete</h3>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 12 }}>{imported} songs imported{selectedCat ? " to " + (categories.find(c => c.id === selectedCat)?.name || "category") : ""}.</div>
          {/* Files the catalogue refused. Shown on the SAME screen as the success, and kept
              there: "Import Complete" over a silent partial failure is how an operator finds out at
              4pm that a track they added this morning was never really added. */}
          {refusedFiles.length > 0 && (
            <div style={{ marginBottom: 12, padding: "8px 10px", background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.3)" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#f87171", marginBottom: 4 }}>
                {refusedFiles.length} file{refusedFiles.length === 1 ? " was" : "s were"} NOT added
              </div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 6 }}>
                They could not be copied into your catalogue, so no entry was created for them.
                The reason for each was shown as it happened.
              </div>
              <div style={{ maxHeight: 120, overflowY: "auto", fontSize: 11, fontFamily: "'DM Mono', monospace", color: "rgba(248,113,113,0.85)" }}>
                {refusedFiles.map((f, i) => <div key={i}>{f}</div>)}
              </div>
            </div>
          )}
          <button
            onClick={onDone}
            style={{
              padding: "8px 20px",
              borderRadius: 0,
              fontSize: 12,
              fontWeight: 600,
              background: "var(--accent-blue)",
              color: "#fff",
              border: "none",
              cursor: "pointer",
            }}
          >Done</button>
        </div>
      )}
    </div>
  );
}
