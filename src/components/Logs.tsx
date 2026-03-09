import { useState, useEffect } from "react";
import { query, execute } from "../db/client";

interface LogEntry {
  id: number;
  title: string;
  artist: string | null;
  category_code: string | null;
  show_name: string | null;
  clock_name: string | null;
  deck: string | null;
  played_at: number;
}

function fmtTimestamp(epoch: number): string {
  const d = new Date(epoch * 1000);
  return d.toLocaleTimeString();
}

function fmtDate(epoch: number): string {
  const d = new Date(epoch * 1000);
  return d.toLocaleDateString();
}

export default function Logs() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<"today" | "all">("today");

  const load = async () => {
    let where = "";
    if (filter === "today") {
      const startOfDay = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
      where = " WHERE played_at >= " + startOfDay;
    }
    const rows = await query<LogEntry>("SELECT * FROM play_log" + where + " ORDER BY played_at DESC LIMIT 200");
    setEntries(rows);
    const r = await query<{ c: number }>("SELECT COUNT(*) as c FROM play_log" + where);
    setTotal(r.length > 0 ? r[0].c : 0);
  };

  useEffect(() => { load(); const id = setInterval(load, 5000); return () => clearInterval(id); }, [filter]);

  const clearLog = async () => {
    await execute("DELETE FROM play_log");
    load();
  };

  const exportCSV = () => {
    const header = "Time,Title,Artist,Category,Show,Clock,Deck";
    const rows = entries.map(e => {
      const time = new Date(e.played_at * 1000).toISOString();
      return [time, e.title, e.artist || "", e.category_code || "", e.show_name || "", e.clock_name || "", e.deck || ""].map(f => '"' + String(f).replace(/"/g, '""'  ) + '"').join(",");
    });
    const csv = header + "\n" + rows.join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ether-log-" + new Date().toISOString().split("T")[0] + ".csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  // Stats
  const uniqueArtists = new Set(entries.filter(e => e.artist).map(e => e.artist)).size;
  const uniqueSongs = new Set(entries.map(e => e.title)).size;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold">Play Log</h1>
        <div className="flex items-center gap-2">
          <button onClick={() => setFilter("today")} className={filter === "today" ? "px-3 py-1 rounded text-xs font-bold bg-blue-600 text-white" : "px-3 py-1 rounded text-xs font-bold bg-zinc-800 text-zinc-400"}>Today</button>
          <button onClick={() => setFilter("all")} className={filter === "all" ? "px-3 py-1 rounded text-xs font-bold bg-blue-600 text-white" : "px-3 py-1 rounded text-xs font-bold bg-zinc-800 text-zinc-400"}>All Time</button>
          <button onClick={exportCSV} className="px-3 py-1 bg-emerald-700 hover:bg-emerald-600 rounded text-xs font-bold text-white">Export CSV</button>
          <button onClick={clearLog} className="px-3 py-1 bg-zinc-800 hover:bg-red-900 rounded text-xs font-bold text-zinc-400 hover:text-red-400">Clear</button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-3 text-center">
          <div className="text-2xl font-bold text-zinc-100">{total}</div>
          <div className="text-[10px] text-zinc-500 uppercase">Songs Played</div>
        </div>
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-3 text-center">
          <div className="text-2xl font-bold text-zinc-100">{uniqueArtists}</div>
          <div className="text-[10px] text-zinc-500 uppercase">Unique Artists</div>
        </div>
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-3 text-center">
          <div className="text-2xl font-bold text-zinc-100">{uniqueSongs}</div>
          <div className="text-[10px] text-zinc-500 uppercase">Unique Songs</div>
        </div>
      </div>

      {entries.length === 0 ? (
        <div className="text-center py-12">
          <div className="text-zinc-400 text-lg mb-2">No plays yet</div>
          <div className="text-zinc-600 text-xs">Start playing music and the log will appear here.</div>
        </div>
      ) : (
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 overflow-hidden">
          <table className="w-full text-xs">
            <thead><tr className="text-left text-[10px] text-zinc-500 uppercase border-b border-zinc-800">
              <th className="px-3 py-2">Time</th>
              <th className="px-3 py-2">Title</th>
              <th className="px-3 py-2">Artist</th>
              <th className="px-3 py-2">Cat</th>
              <th className="px-3 py-2">Show</th>
              <th className="px-3 py-2">Deck</th>
            </tr></thead>
            <tbody>{entries.map(e => (
              <tr key={e.id} className="border-b border-zinc-800 hover:bg-zinc-800">
                <td className="px-3 py-1.5 text-zinc-400 font-mono">{fmtTimestamp(e.played_at)}</td>
                <td className="px-3 py-1.5 text-zinc-100">{e.title}</td>
                <td className="px-3 py-1.5 text-zinc-400">{e.artist || ""}</td>
                <td className="px-3 py-1.5 text-zinc-500">{e.category_code || ""}</td>
                <td className="px-3 py-1.5 text-zinc-500">{e.show_name || ""}</td>
                <td className="px-3 py-1.5 text-zinc-500">{e.deck || ""}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}