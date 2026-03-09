import { useState, useEffect } from "react";
import { query, execute, queryOne } from "../db/client";
import { open } from "@tauri-apps/plugin-dialog";
import { readDir } from "@tauri-apps/plugin-fs";
import { engine } from "../audio/engine";

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
      const files = await open({
        multiple: true,
        title: "Select Spot Audio Files",
        filters: [{ name: "Audio", extensions: ["mp3", "flac", "ogg", "wav", "m4a", "aac"] }]
      });
      if (!files || (Array.isArray(files) && files.length === 0)) return;
      setImporting(true);
      const fileList = Array.isArray(files) ? files : [files];
      let n = 0;
      for (const fp of fileList) {
        const ex = await queryOne<{ id: number }>("SELECT id FROM spots WHERE file_path = ?", [fp]);
        if (!ex) {
          await execute("INSERT INTO spots (title, file_path, spot_type) VALUES (?, ?, ?)", [titleFromFile(fp), fp, "promo"]);
          n++;
        }
      }
      setStatus("Imported " + n + " spots.");
      setTimeout(() => setStatus(""), 3000);
      setImporting(false);
      load();
    } catch (e) { console.error(e); setImporting(false); }
  };

  const handleImportFolder = async () => {
    try {
      const folder = await open({ directory: true, title: "Select Spots Folder" });
      if (!folder) return;
      setImporting(true);
      setStatus("Scanning...");
      const entries = await readDir(folder as string);
      let n = 0;
      for (const e of entries) {
        if (e.name && isAudio(e.name)) {
          const sep = (folder as string).includes("/") ? "/" : "\\";
          const fp = (folder as string) + sep + e.name;
          const ex = await queryOne<{ id: number }>("SELECT id FROM spots WHERE file_path = ?", [fp]);
          if (!ex) {
            await execute("INSERT INTO spots (title, file_path, spot_type) VALUES (?, ?, ?)", [titleFromFile(fp), fp, "promo"]);
            n++;
          }
        }
      }
      setStatus("Imported " + n + " spots.");
      setTimeout(() => setStatus(""), 3000);
      setImporting(false);
      load();
    } catch (e) { console.error(e); setImporting(false); }
  };

  const save = async () => {
    if (!editing || !editing.title) return;
    if (editing.id) {
      await execute("UPDATE spots SET title=?, spot_type=?, advertiser=?, start_date=?, end_date=?, max_plays_day=?, is_active=?, notes=? WHERE id=?",
        [editing.title, editing.spot_type || "promo", editing.advertiser || null, editing.start_date || null, editing.end_date || null, editing.max_plays_day || 999, editing.is_active ?? 1, editing.notes || null, editing.id]);
    }
    setEditing(null);
    load();
  };

  const remove = async (id: number) => {
    await execute("DELETE FROM spots WHERE id=?", [id]);
    load();
  };

  const playSpot = (spot: Spot) => {
    if (spot.file_path) {
      engine.init();
      engine.loadToDeck("B", spot.file_path, spot.title, spot.spot_type);
      setTimeout(() => engine.getDeck("B")?.play(), 500);
    }
  };

  const queueSpot = (spot: Spot) => {
    if (spot.file_path) {
      engine.addToQueue([{ filePath: spot.file_path, title: "[" + spot.spot_type.toUpperCase() + "] " + spot.title, artist: spot.advertiser || "" }]);
    }
  };

  const activeCount = spots.filter(s => s.is_active).length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold">Spots & Promos</h1>
        <div className="flex gap-1">
          <button onClick={handleImportFolder} disabled={importing} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-xs font-bold text-white">Import Folder</button>
          <button onClick={handleImport} disabled={importing} className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 rounded text-xs font-bold text-zinc-300">Import Files</button>
        </div>
      </div>

      {/* Type filter */}
      <div className="flex gap-1">
        <button onClick={() => setFilter("all")} className={filter === "all" ? "px-2.5 py-1 rounded text-[10px] font-bold bg-blue-600 text-white" : "px-2.5 py-1 rounded text-[10px] font-bold bg-zinc-800 text-zinc-400"}>All ({spots.length})</button>
        {SPOT_TYPES.map(t => {
          const c = spots.filter(s => s.spot_type === t).length;
          if (c === 0 && filter !== t) return null;
          return <button key={t} onClick={() => setFilter(t)} className={filter === t ? "px-2.5 py-1 rounded text-[10px] font-bold bg-blue-600 text-white" : "px-2.5 py-1 rounded text-[10px] font-bold bg-zinc-800 text-zinc-400"}>{t} ({c})</button>;
        })}
      </div>

      {status && <div className="px-3 py-1.5 bg-blue-900 border border-blue-700 rounded text-xs text-blue-200">{status}</div>}

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-2 text-center">
          <div className="text-xl font-bold text-zinc-100">{spots.length}</div>
          <div className="text-[10px] text-zinc-500 uppercase">Total Spots</div>
        </div>
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-2 text-center">
          <div className="text-xl font-bold text-emerald-400">{activeCount}</div>
          <div className="text-[10px] text-zinc-500 uppercase">Active</div>
        </div>
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-2 text-center">
          <div className="text-xl font-bold text-zinc-100">{spots.reduce((s, sp) => s + sp.plays_total, 0)}</div>
          <div className="text-[10px] text-zinc-500 uppercase">Total Plays</div>
        </div>
      </div>

      {/* Edit modal */}
      {editing && (
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-3 space-y-2">
          <div className="text-xs font-bold text-zinc-300 mb-1">Edit Spot</div>
          <div className="grid grid-cols-3 gap-2">
            <input className="col-span-2 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" placeholder="Title" value={editing.title || ""} onChange={e => setEditing({...editing, title: e.target.value})} />
            <select className="px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" value={editing.spot_type || "promo"} onChange={e => setEditing({...editing, spot_type: e.target.value})}>
              {SPOT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <input className="px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" placeholder="Advertiser" value={editing.advertiser || ""} onChange={e => setEditing({...editing, advertiser: e.target.value})} />
            <input type="date" className="px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" value={editing.start_date || ""} onChange={e => setEditing({...editing, start_date: e.target.value})} />
            <input type="date" className="px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" value={editing.end_date || ""} onChange={e => setEditing({...editing, end_date: e.target.value})} />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-zinc-500">Max/day:</span>
              <input type="number" className="w-16 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100" value={editing.max_plays_day || 999} onChange={e => setEditing({...editing, max_plays_day: parseInt(e.target.value) || 999})} />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-[10px] text-zinc-500">Active:</label>
              <input type="checkbox" checked={editing.is_active !== 0} onChange={e => setEditing({...editing, is_active: e.target.checked ? 1 : 0})} />
            </div>
          </div>
          <textarea className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-100 h-12 resize-none" placeholder="Notes" value={editing.notes || ""} onChange={e => setEditing({...editing, notes: e.target.value})} />
          <div className="flex gap-2">
            <button onClick={save} className="px-3 py-1 bg-blue-600 rounded text-xs font-bold text-white">Save</button>
            <button onClick={() => setEditing(null)} className="px-3 py-1 bg-zinc-700 rounded text-xs text-zinc-300">Cancel</button>
          </div>
        </div>
      )}

      {/* Spot list */}
      {spots.length === 0 ? (
        <div className="text-center py-12">
          <div className="text-zinc-400 text-lg mb-2">No spots yet</div>
          <div className="text-zinc-600 text-xs mb-4">Import jingles, promos, PSAs, and liners.</div>
          <button onClick={handleImportFolder} className="px-6 py-3 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium text-white">Import Spots Folder</button>
        </div>
      ) : (
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 overflow-hidden">
          <table className="w-full text-xs">
            <thead><tr className="text-left text-[10px] text-zinc-500 uppercase border-b border-zinc-800">
              <th className="px-3 py-2">Title</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Advertiser</th>
              <th className="px-3 py-2 text-right">Plays</th>
              <th className="px-3 py-2 text-center">Active</th>
              <th className="px-3 py-2 text-right w-36">Actions</th>
            </tr></thead>
            <tbody>{spots.map(s => (
              <tr key={s.id} className={"border-b border-zinc-800 hover:bg-zinc-800" + (s.is_active ? "" : " opacity-50")}>
                <td className="px-3 py-1.5 text-zinc-100">{s.title}</td>
                <td className="px-3 py-1.5"><span className="px-1.5 py-0.5 bg-zinc-800 rounded text-[9px] font-bold text-zinc-300 uppercase">{s.spot_type}</span></td>
                <td className="px-3 py-1.5 text-zinc-400">{s.advertiser || "—"}</td>
                <td className="px-3 py-1.5 text-right text-zinc-400">{s.plays_total}</td>
                <td className="px-3 py-1.5 text-center">{s.is_active ? <span className="text-emerald-400">Yes</span> : <span className="text-zinc-600">No</span>}</td>
                <td className="px-3 py-1.5 text-right">
                  <button onClick={() => playSpot(s)} className="px-1.5 py-0.5 bg-emerald-700 hover:bg-emerald-600 rounded text-[9px] font-bold text-white mr-0.5">Play</button>
                  <button onClick={() => queueSpot(s)} className="px-1.5 py-0.5 bg-zinc-700 hover:bg-zinc-600 rounded text-[9px] font-bold text-white mr-0.5">Q</button>
                  <button onClick={() => setEditing(s)} className="px-1.5 py-0.5 bg-zinc-700 hover:bg-zinc-600 rounded text-[9px] font-bold text-zinc-300 mr-0.5">Edit</button>
                  <button onClick={() => remove(s.id)} className="px-1.5 py-0.5 bg-zinc-800 hover:bg-red-900 rounded text-[9px] font-bold text-zinc-500">Del</button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}