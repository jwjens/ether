// CategoriesTab — rotation categories, targets and library depth.
// Extracted verbatim from Scheduler.tsx (Phase A, 2026-08-10) — lines 311-462 of the pre-split file.
// NO LOGIC CHANGED. Scheduler.tsx re-exports this so the tabbed panel, the three popouts
// (PopoutRenderer.tsx) and the embedded programming panel (App.tsx) behave identically.
// docs/schedule-manager-design-2026-08-10.md §8 Phase A
import { useState, useEffect } from "react";
import { queryScoped } from "../../db/stationScoped";
import { useActiveStation } from "../../hooks/useActiveStation";
import type { Category } from "./types";

/** All optional — with none supplied, behaves exactly as before (see ShowsTabProps). §4.3 */
export interface CategoriesTabProps {
  cats?: Category[];
  onMutated?: (tables?: string[]) => void;
  selectedCategoryId?: number | null;
  onSelectCategory?: (categoryId: number) => void;
  /** Library-depth facts keyed by category id, from the Station Health sense. Rendered when given. */
  depth?: Record<number, { songs: number; needed: number; thin: boolean }>;
}

export function CategoriesTab({ cats: catsProp, onMutated, selectedCategoryId, onSelectCategory, depth }: CategoriesTabProps = {}) {
  const { stationId, isReady } = useActiveStation();
  const hosted = !!onMutated;
  const [catsLocal, setCats] = useState<Category[]>([]);
  const cats = catsProp ?? catsLocal;
  const [editing, setEditing] = useState<Partial<Category> | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState("");
  const [saveError, setSaveError] = useState("");
  const [catSaved, setCatSaved] = useState(false);

  const load = async () => {
    if (hosted) { onMutated!(["categories"]); return; }
    if (!isReady) return;
    const rows = await queryScoped<Category & { song_count: number }>(
      "SELECT c.*, (SELECT COUNT(*) FROM songs WHERE category_id = c.id) as song_count FROM categories c WHERE c.station_id = ? ORDER BY c.code",
      [stationId], stationId, { skipScoping: true }
    );
    setCats(rows);
  };
  useEffect(() => { if (!hosted) load(); }, [isReady, hosted]);

  const scanDurations = async () => {
    setScanning(true);
    setScanStatus("Finding songs...");
    try {
      const invoke = <T = any>(cmd: string, args?: any): Promise<T> => (window as any).ether.invoke(cmd, args);
      const songs = await queryScoped<{ id: number; file_path: string; title: string }>(
        "SELECT id, file_path, title FROM songs WHERE duration_ms IS NULL OR duration_ms < 1000",
        [], stationId
      );
      if (songs.length === 0) { setScanStatus("✓ All songs have duration data"); setScanning(false); return; }
      setScanStatus(`Scanning ${songs.length} songs...`);
      let fixed = 0; let failed = 0;
      for (let i = 0; i < songs.length; i++) {
        const song = songs[i];
        try {
          // Rust command takes native file path, returns seconds as f64
          const durSec = await invoke<number>("get_file_duration", { filePath: song.file_path });
          const durMs = Math.round(durSec * 1000);
          if (durMs > 1000) {
            await (window as any).ether.songs.updateById(song.id, { duration_ms: durMs });
            fixed++;
          } else { failed++; }
        } catch { failed++; }
        if (i % 5 === 0) setScanStatus(`Scanning... ${i+1}/${songs.length} (${fixed} fixed, ${failed} failed)`);
      }
      setScanStatus(`✓ Done — ${fixed} updated, ${failed} failed`);
    } catch (e) {
      setScanStatus(`✗ Error: ${e}`);
    }
    setScanning(false);
  };

  const save = async () => {
    if (!editing || !editing.code) return;
    setSaveError("");
    try {
      if (editing.id) {
        await (window as any).ether.categories.updateById(editing.id, {
          code: editing.code, name: editing.name || editing.code, color: editing.color || null,
          spins_per_hour: editing.spins_per_hour || 0, priority: editing.priority || 0,
        });
      } else {
        await (window as any).ether.categories.create({ station_id: stationId,
          code: editing.code, name: editing.name || editing.code, color: editing.color || null,
          spins_per_hour: editing.spins_per_hour || 0, priority: editing.priority || 0,
        });
      }
      setCatSaved(true);
      load();
      setTimeout(() => { setCatSaved(false); setEditing(null); }, 1400);
    } catch (e: any) {
      setSaveError(e?.message || "Save failed");
    }
  };

  const del = async () => {
    if (!editing?.id || !editing.uuid) return;
    const label = `${editing.code}${editing.name ? " — " + editing.name : ""}`;
    if (!confirm(`Delete category "${label}"?\n\nSongs in this category won't be deleted, but they'll lose this category assignment.`)) return;
    setSaveError("");
    try {
      await (window as any).ether.categories.delete(editing.uuid, stationId);
      load();
      setEditing(null);
    } catch (e: any) {
      setSaveError(e?.message || "Delete failed");
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-zinc-300">Rotation Categories</h2>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {scanStatus && <span style={{ fontSize: 10, color: scanStatus.startsWith("✓") ? "#34d399" : scanStatus.startsWith("✗") ? "#ef4444" : "#94a3b8" }}>{scanStatus}</span>}
          <button
            onClick={scanDurations}
            disabled={scanning}
            style={{ padding: "4px 10px", borderRadius: 0, fontSize: 11, fontWeight: 700, cursor: scanning ? "default" : "pointer", background: "rgba(251,191,36,0.12)", color: "#fbbf24", border: "1px solid rgba(251,191,36,0.3)", opacity: scanning ? 0.6 : 1 }}
          >
            {scanning ? "Scanning..." : "⏱ Scan Durations"}
          </button>
          <button onClick={() => setEditing({ code: "", name: "", color: "#3b82f6", spins_per_hour: 0, priority: 0 })} className="px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded text-xs font-bold text-white">+ New Category</button>
        </div>
      </div>
      <div className="text-xs text-zinc-500 bg-zinc-900 rounded p-2 border border-zinc-800">
        <strong>How rotation works:</strong> A = Power Current (heavy rotation, newest hits). B = Secondary (medium rotation). C = Recurrent (familiar favorites). D = Gold (classic library).
      </div>
      {editing && (
        <div className="bg-zinc-900 rounded-none border border-zinc-800 p-3 space-y-2">
          <div className="grid grid-cols-5 gap-2">
            <input className="px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" placeholder="Code (A)" value={editing.code || ""} onChange={e => setEditing({...editing, code: e.target.value})} />
            <input className="col-span-2 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" placeholder="Name" value={editing.name || ""} onChange={e => setEditing({...editing, name: e.target.value})} />
            <input type="number" className="px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" placeholder="Spins/hr" value={editing.spins_per_hour || ""} onChange={e => setEditing({...editing, spins_per_hour: parseInt(e.target.value) || 0})} />
            <input type="color" className="h-8 w-full bg-zinc-800 border border-zinc-700 rounded" value={editing.color || "#3b82f6"} onChange={e => setEditing({...editing, color: e.target.value})} />
          </div>
          <div className="flex items-center gap-2">
            <button onClick={save} disabled={catSaved} className={`px-3 py-1 rounded text-xs font-bold text-white transition-colors ${catSaved ? "bg-emerald-600" : "bg-blue-600 hover:bg-blue-500"}`}>{catSaved ? "✓ Saved" : "Save Category"}</button>
            <button onClick={() => { setEditing(null); setSaveError(""); }} className="px-3 py-1 bg-zinc-700 rounded text-xs text-zinc-300">Cancel</button>
            {saveError && <span className="text-xs text-red-400">{saveError}</span>}
            {editing.id && (
              <button onClick={del} className="ml-auto px-3 py-1 bg-red-700 hover:bg-red-600 rounded text-xs font-bold text-white">Delete Category</button>
            )}
          </div>
        </div>
      )}
      {catSaved && <span style={{ fontSize: 11, color: "#34d399", fontWeight: 600 }}>✓ Saved</span>}
      <div className="bg-zinc-900 rounded-none border border-zinc-800 overflow-hidden">
        <table className="w-full text-xs">
          <thead><tr className="text-left text-[10px] text-zinc-500 uppercase border-b border-zinc-800">
            <th className="px-3 py-2 w-8">Color</th>
            <th className="px-3 py-2 w-12">Code</th>
            <th className="px-3 py-2">Name</th>
            <th className="px-3 py-2 text-right">Songs</th>
            <th className="px-3 py-2 text-right">Spins/hr</th>
            <th className="px-3 py-2 text-right w-16"></th>
          </tr></thead>
          <tbody>{cats.map(c => (
            <tr key={c.id}
              onClick={onSelectCategory ? () => onSelectCategory(c.id) : undefined}
              className="border-b border-zinc-800 hover:bg-zinc-800"
              style={onSelectCategory ? { cursor: "pointer", background: selectedCategoryId === c.id ? "rgba(167,139,250,0.14)" : undefined } : undefined}
              title={depth?.[c.id] ? `${depth[c.id].songs} songs · needs ~${depth[c.id].needed}${depth[c.id].thin ? " — THIN" : ""}` : undefined}>
              <td className="px-3 py-2"><div className="w-4 h-4 rounded" style={{ backgroundColor: c.color || "#444" }}></div></td>
              <td className="px-3 py-2 font-bold text-zinc-100">{c.code}</td>
              <td className="px-3 py-2 text-zinc-300">{c.name}</td>
              <td className="px-3 py-2 text-right text-zinc-400">{c.song_count || 0}</td>
              <td className="px-3 py-2 text-right text-zinc-400">{c.spins_per_hour || "--"}</td>
              <td className="px-3 py-2 text-right"><button onClick={() => setEditing(c)} className="px-2 py-0.5 bg-zinc-700 hover:bg-zinc-600 rounded text-[10px] text-zinc-300">Edit</button></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

