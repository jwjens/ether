import { useState, useEffect } from "react";
import { processAllSongs, getProcessingStats } from "../audio/processor";
import { query, execute } from "../db/client";

interface SongLevel {
  id: number; title: string; artist_name: string | null;
  lufs_measured: number | null; peak_db: number | null;
  gain_db: number; is_processed: number;
}

export default function ProcessingPanel() {
  const [stats, setStats] = useState<{ total: number; processed: number; unprocessed: number; avgLufs: number; loudest: string | null; quietest: string | null } | null>(null);
  const [songs, setSongs] = useState<SongLevel[]>([]);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState("");
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);

  const load = async () => {
    setStats(await getProcessingStats());
    setSongs(await query<SongLevel>("SELECT s.id, s.title, a.name as artist_name, s.lufs_measured, s.peak_db, s.gain_db, s.is_processed FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.file_path IS NOT NULL ORDER BY s.lufs_measured ASC NULLS LAST LIMIT 100"));
  };
  useEffect(() => { load(); }, []);

  const handleProcessAll = async () => {
    setProcessing(true);
    setProgress("Starting...");
    const count = await processAllSongs((d, t, title) => {
      setDone(d); setTotal(t);
      setProgress("Processing: " + title + " (" + d + "/" + t + ")");
    });
    setProgress("Done! Processed " + count + " songs.");
    setProcessing(false);
    load();
  };

  const handleResetAll = async () => {
    await execute("UPDATE songs SET lufs_measured=NULL, peak_db=NULL, gain_db=0, is_processed=0");
    load();
  };

  const lufsBar = (lufs: number | null) => {
    if (lufs === null) return null;
    // Scale: -30 to 0 LUFS mapped to 0-100%
    const pct = Math.max(0, Math.min(100, ((lufs + 30) / 30) * 100));
    const color = Math.abs(lufs - (-14)) < 2 ? "#22c55e" : Math.abs(lufs - (-14)) < 5 ? "#f59e0b" : "#ef4444";
    return (
      <div className="flex items-center gap-1">
        <div className="w-20 h-2 bg-zinc-800 rounded-full overflow-hidden">
          <div className="h-full rounded-full" style={{ width: pct + "%", backgroundColor: color }}></div>
        </div>
        <span className="text-[9px] font-mono" style={{ color }}>{lufs}</span>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-zinc-300">Audio Processing</h2>
        <div className="flex gap-2">
          <button onClick={handleProcessAll} disabled={processing} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-xs font-bold text-white">{processing ? "Processing..." : "Analyze All"}</button>
          <button onClick={handleResetAll} className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-xs text-zinc-400">Reset All</button>
        </div>
      </div>

      <div className="text-xs text-zinc-500">Measures loudness (LUFS) and calculates gain adjustment to normalize all songs to -14 LUFS (broadcast standard). Gain is applied during playback.</div>

      {progress && (
        <div className="px-3 py-2 bg-blue-900 border border-blue-700 rounded text-xs text-blue-200">
          {progress}
          {total > 0 && (
            <div className="w-full h-1.5 bg-blue-800 rounded-full mt-1 overflow-hidden">
              <div className="h-full bg-blue-400 rounded-full transition-all" style={{ width: (done / total * 100) + "%" }}></div>
            </div>
          )}
        </div>
      )}

      {stats && (
        <div className="grid grid-cols-4 gap-3">
          <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-2 text-center">
            <div className="text-xl font-bold text-zinc-100">{stats.processed}/{stats.total}</div>
            <div className="text-[10px] text-zinc-500 uppercase">Analyzed</div>
          </div>
          <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-2 text-center">
            <div className="text-xl font-bold text-zinc-100">{stats.avgLufs || "--"}</div>
            <div className="text-[10px] text-zinc-500 uppercase">Avg LUFS</div>
          </div>
          <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-2 text-center">
            <div className="text-xl font-bold text-zinc-100">-14</div>
            <div className="text-[10px] text-zinc-500 uppercase">Target LUFS</div>
          </div>
          <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-2 text-center">
            <div className="text-xl font-bold text-emerald-400">{stats.unprocessed}</div>
            <div className="text-[10px] text-zinc-500 uppercase">Pending</div>
          </div>
        </div>
      )}

      {stats?.loudest && (
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="bg-zinc-900 rounded border border-zinc-800 p-2">
            <span className="text-zinc-500">Loudest: </span><span className="text-red-400">{stats.loudest}</span>
          </div>
          <div className="bg-zinc-900 rounded border border-zinc-800 p-2">
            <span className="text-zinc-500">Quietest: </span><span className="text-blue-400">{stats.quietest}</span>
          </div>
        </div>
      )}

      {songs.length > 0 && (
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 overflow-hidden">
          <table className="w-full text-xs">
            <thead><tr className="text-left text-[10px] text-zinc-500 uppercase border-b border-zinc-800">
              <th className="px-3 py-2">Title</th>
              <th className="px-3 py-2">Artist</th>
              <th className="px-3 py-2">LUFS</th>
              <th className="px-3 py-2">Peak</th>
              <th className="px-3 py-2">Gain</th>
              <th className="px-3 py-2">Status</th>
            </tr></thead>
            <tbody>{songs.map(s => (
              <tr key={s.id} className="border-b border-zinc-800 hover:bg-zinc-800">
                <td className="px-3 py-1.5 text-zinc-100 truncate max-w-[200px]">{s.title}</td>
                <td className="px-3 py-1.5 text-zinc-400">{s.artist_name || ""}</td>
                <td className="px-3 py-1.5">{lufsBar(s.lufs_measured)}</td>
                <td className="px-3 py-1.5 text-zinc-400 font-mono text-[10px]">{s.peak_db !== null ? s.peak_db + " dB" : "--"}</td>
                <td className="px-3 py-1.5 font-mono text-[10px]"><span className={s.gain_db > 0 ? "text-emerald-400" : s.gain_db < -3 ? "text-red-400" : "text-zinc-400"}>{s.gain_db > 0 ? "+" : ""}{s.gain_db} dB</span></td>
                <td className="px-3 py-1.5">{s.is_processed ? <span className="text-emerald-400 text-[10px]">Done</span> : <span className="text-zinc-600 text-[10px]">Pending</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
