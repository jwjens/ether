import { useState, useEffect } from "react";
import { query } from "../db/client";
import { queryScoped } from "../db/stationScoped";
import { useActiveStation } from "../hooks/useActiveStation";
const open = (opts?: { directory?: boolean; title?: string }) =>
  opts?.directory ? (window as any).ether.dialog.openDirectory() : (window as any).ether.dialog.openFile(opts);
const readDir = (path: string) => (window as any).ether.fs.readDir(path);
import { importIntoAudioLibrary } from "../lib/fileLocation";
import { readID3, type ID3Tags } from "../audio/id3";
import { findDuplicates, fmtLen, type LibrarySong } from "../lib/importDuplicates";
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
  const [step, setStep] = useState<"pick" | "checking" | "duplicates" | "importing" | "done">("pick");
  const [progress, setProgress] = useState({ done: 0, total: 0, current: "" });
  const [imported, setImported] = useState(0);
  // Files the catalogue refused (disk full, permissions, a name that could not be placed).
  const [refusedFiles, setRefusedFiles] = useState<string[]>([]);
  // THE DUPLICATE GUARD (Jeff, 2026-10-19): files whose song is already in the library (same title + same length to the
  // second), each with the user's choice — Skip (not imported) or Replace (the library song keeps its category, history
  // and rotation; its audio becomes the new file). Nothing is imported until the user chooses.
  type Dup = { path: string; title: string; artist: string | null; durationMs: number | null; existing: LibrarySong; choice: "skip" | "replace" };
  const [dups, setDups] = useState<Dup[]>([]);
  const [pending, setPending] = useState<{ files: string[]; tags: Map<string, ID3Tags> } | null>(null);
  const [skipped, setSkipped] = useState(0);
  const [replaced, setReplaced] = useState(0);

  useEffect(() => {
    if (!isReady) return;
    (async () => {
      const cats = await queryScoped<Category>("SELECT id, code, name, color FROM categories WHERE deleted_at IS NULL ORDER BY code", [], stationId);
      setCategories(cats);
    })();
  }, [isReady]);

  const createCategory = async () => {
    if (!newCatCode.trim() || !newCatName.trim()) return;
    const colors = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#8b5cf6", "#ec4899", "#14b8a6", "#6366f1"];
    const color = colors[categories.length % colors.length];
    await (window as any).ether.categories.create({ station_id: stationId, code: newCatCode.trim().toUpperCase(), name: newCatName.trim(), color });
    const cats = await queryScoped<Category>("SELECT id, code, name, color FROM categories WHERE deleted_at IS NULL ORDER BY code", [], stationId);
    setCategories(cats);
    const newCat = cats.find(c => c.code === newCatCode.trim().toUpperCase());
    if (newCat) setSelectedCat(newCat.id);
    setNewCatCode("");
    setNewCatName("");
  };

  const AUDIO_EXTS = [".mp3", ".flac", ".ogg", ".wav", ".m4a", ".aac", ".aiff"];

  const baseName = (f: string) => f.split(/[\\/]/).pop() || f;

  // Step 1 for every import: read each file's title and length, and find the ones already in the library. Nothing is
  // copied or written here.
  const checkThenImport = async (files: string[]) => {
    setStep("checking");
    const tags = new Map<string, ID3Tags>();
    let n = 0;
    for (const f of files) {
      setProgress({ done: n, total: files.length, current: baseName(f) });
      try { tags.set(f, await readID3(f)); } catch { /* no tags: never called a duplicate */ }
      n++;
    }
    let library: LibrarySong[] = [];
    try {
      library = await query<LibrarySong>(
        "SELECT s.id, s.title, a.name AS artist, s.duration_ms, s.category_id, s.file_path FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.deleted_at IS NULL");
    } catch (e) { console.warn("[Import] library read failed — duplicates not checked:", e); }
    // The same title the import writes: the tag, else the file name without its extension.
    const titleOf = (f: string) => tags.get(f)?.title || baseName(f).replace(/\.[^.]+$/, "") || "Unknown";
    const cands = files.map(f => {
      const sec = tags.get(f)?.durationSec;
      return { path: f, title: titleOf(f), artist: tags.get(f)?.artist ?? null, durationMs: sec != null ? Math.round(sec * 1000) : null };
    });
    const hits = findDuplicates(cands, library);
    const found: Dup[] = [];
    hits.forEach((h, i) => { if (h) found.push({ ...cands[i], existing: h.song, choice: "skip" }); });
    if (!found.length) { await importFiles(files, tags, []); return; }
    setDups(found);
    setPending({ files, tags });
    setStep("duplicates");
  };

  // Shared import pipeline — one function, fed by either a folder scan or a file picker (through checkThenImport).
  const importFiles = async (files: string[], tagCache: Map<string, ID3Tags>, decided: Dup[]) => {
    setStep("importing");
    setProgress({ done: 0, total: files.length, current: "Importing..." });
    const decision = new Map(decided.map(d => [d.path, d]));

    let count = 0, nSkipped = 0, nReplaced = 0;
    const refused: string[] = [];
    for (const browsedPath of files) {
      try {
        const dup = decision.get(browsedPath);
        if (dup && dup.choice === "skip") {
          nSkipped++;
          setProgress({ done: count + nSkipped + nReplaced, total: files.length, current: `Skipped (already in your library): ${dup.title}` });
          continue;
        }
        if (dup && dup.choice === "replace") {
          // REPLACE: the library song stays (category, play history, rotation, cue settings); its audio becomes the new
          // file, copied into the catalogue first. The old file is left on disk.
          const newPath = await importIntoAudioLibrary(browsedPath);
          if (!newPath) { refused.push(baseName(browsedPath)); continue; }
          const sec = tagCache.get(browsedPath)?.durationSec;
          await (window as any).ether.songs.updateById(dup.existing.id, { file_path: newPath, ...(sec != null ? { duration_ms: Math.round(sec * 1000) } : {}) });
          analyzeAndSave(dup.existing.id, newPath).catch(e => console.warn("[Import] analysis skipped:", dup.title, e));
          nReplaced++;
          setProgress({ done: count + nSkipped + nReplaced, total: files.length, current: `Replaced: ${dup.title}` });
          continue;
        }
        // ── COPY-ON-IMPORT ────────────────────────────────────────────────────────────────────
        // The song row stores the CATALOGUE path, never the browsed one. Import used to write the
        // path the operator picked, which is why 1,113 files ended up in the catalogue folder with
        // no row and rows ended up pointing at folders other machines cannot open.
        // A refusal is COLLECTED and shown at the end — never a silent skip, and never a row.
        const filePath = await importIntoAudioLibrary(browsedPath);
        if (!filePath) { refused.push(browsedPath.split(/[\\/]/).pop() || browsedPath); continue; }

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

        // Read ID3 tags (already read by the duplicate check)
        const tags = tagCache.get(browsedPath) ?? await readID3(filePath);
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
    setSkipped(nSkipped);
    setReplaced(nReplaced);
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
    await checkThenImport(files);
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
    await checkThenImport(files);
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

      {step === "checking" && (
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>Checking for songs you already have…</h3>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 8 }}>{progress.current}</div>
          <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 8 }}>{progress.done} / {progress.total}</div>
          {progress.total > 0 && (
            <div style={{ height: 4, background: "var(--bg-tertiary)", borderRadius: 0, overflow: "hidden" }}>
              <div style={{ height: "100%", width: (progress.done / progress.total * 100) + "%", background: "var(--accent-blue)", borderRadius: 0 }}></div>
            </div>
          )}
        </div>
      )}

      {step === "duplicates" && pending && (() => {
        const total = pending.files.length, nNew = total - dups.length;
        const nRep = dups.filter(d => d.choice === "replace").length;
        const catName = (id: number | null) => id == null ? "No category" : (categories.find(c => c.id === id)?.name || `#${id}`);
        const setAll = (choice: "skip" | "replace") => setDups(ds => ds.map(d => ({ ...d, choice })));
        const go = (list: Dup[]) => importFiles(pending.files, pending.tags, list);
        const btn = (primary: boolean) => ({ padding: "8px 16px", borderRadius: 0, fontSize: 12, fontWeight: 600, cursor: "pointer",
          background: primary ? "var(--accent-blue)" : "var(--bg-tertiary)", color: primary ? "#fff" : "var(--text-primary)",
          border: primary ? "none" : "1px solid var(--border-primary)" } as const);
        return (
          <div>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>
              {dups.length} of {total} song{total === 1 ? "" : "s"} {dups.length === 1 ? "is" : "are"} already in your library
            </h3>
            <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 12 }}>
              Same title and same length as a song you have. {nNew} {nNew === 1 ? "is" : "are"} new and will be imported.
              Skip leaves your song as it is. Replace keeps your song (its category and play history) and swaps in the new file.
            </p>
            <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" as const }}>
              <button style={btn(true)} onClick={() => go(dups.map(d => ({ ...d, choice: "skip" as const })))}>Skip all {dups.length} — import only the {nNew} new</button>
              <button style={btn(false)} onClick={() => go(dups.map(d => ({ ...d, choice: "replace" as const })))}>Replace all {dups.length}</button>
            </div>
            <div style={{ fontSize: 11, fontWeight: 500, color: "var(--text-secondary)", textTransform: "uppercase" as const, letterSpacing: "0.06em", marginBottom: 6 }}>
              Or decide for each song
              <span style={{ marginLeft: 10, textTransform: "none" as const, letterSpacing: 0 }}>
                <a style={{ cursor: "pointer", color: "var(--accent-blue)" }} onClick={() => setAll("skip")}>set all to Skip</a>{" · "}
                <a style={{ cursor: "pointer", color: "var(--accent-blue)" }} onClick={() => setAll("replace")}>set all to Replace</a>
              </span>
            </div>
            <div style={{ maxHeight: 320, overflowY: "auto" as const, border: "1px solid var(--border-primary)", marginBottom: 12 }}>
              {dups.map((d, i) => (
                <div key={d.path} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", borderBottom: "1px solid var(--border-primary)", fontSize: 12 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: "var(--text-primary)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
                      {d.title}{d.artist ? ` — ${d.artist}` : ""} <span style={{ color: "var(--text-tertiary)", fontWeight: 400 }}>{fmtLen(d.durationMs)}</span>
                    </div>
                    <div style={{ color: "var(--text-tertiary)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
                      You have: {d.existing.title}{d.existing.artist ? ` — ${d.existing.artist}` : ""} · {fmtLen(d.existing.duration_ms)} · {catName(d.existing.category_id)}
                      {" · new file: "}{baseName(d.path)}
                    </div>
                  </div>
                  {(["skip", "replace"] as const).map(c => (
                    <button key={c} onClick={() => setDups(ds => ds.map((x, j) => j === i ? { ...x, choice: c } : x))}
                      style={{ padding: "4px 10px", borderRadius: 0, fontSize: 11, fontWeight: 600, cursor: "pointer",
                        background: d.choice === c ? (c === "skip" ? "var(--accent-blue)" : "#d97706") : "var(--bg-tertiary)",
                        color: d.choice === c ? "#fff" : "var(--text-secondary)", border: "1px solid var(--border-primary)" }}>
                      {c === "skip" ? "Skip" : "Replace"}
                    </button>
                  ))}
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={btn(true)} onClick={() => go(dups)}>Continue — {nNew} new, {dups.length - nRep} skipped, {nRep} replaced</button>
              <button style={btn(false)} onClick={() => { setDups([]); setPending(null); setStep("pick"); }}>Cancel import</button>
            </div>
          </div>
        );
      })()}

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
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 12 }}>{imported} songs imported{selectedCat ? " to " + (categories.find(c => c.id === selectedCat)?.name || "category") : ""}.
            {skipped > 0 ? ` ${skipped} skipped — already in your library.` : ""}{replaced > 0 ? ` ${replaced} replaced with the new file.` : ""}</div>
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
