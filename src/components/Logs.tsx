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
  const [filter, setFilter] = useState<"today" | "week" | "month" | "all">("today");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const load = async () => {
    let where = "";
    if (filter === "today") {
      const startOfDay = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
      where = " WHERE played_at >= " + startOfDay;
    } else if (filter === "week") {
      const weekAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
      where = " WHERE played_at >= " + weekAgo;
    } else if (filter === "month") {
      const monthAgo = Math.floor(Date.now() / 1000) - 30 * 86400;
      where = " WHERE played_at >= " + monthAgo;
    } else if (dateFrom && dateTo) {
      const from = Math.floor(new Date(dateFrom).getTime() / 1000);
      const to = Math.floor(new Date(dateTo).getTime() / 1000) + 86400;
      where = " WHERE played_at >= " + from + " AND played_at <= " + to;
    } else if (filter === "week") {
      const weekAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
      where = " WHERE played_at >= " + weekAgo;
    } else if (filter === "month") {
      const monthAgo = Math.floor(Date.now() / 1000) - 30 * 86400;
      where = " WHERE played_at >= " + monthAgo;
    } else if (dateFrom && dateTo) {
      const from = Math.floor(new Date(dateFrom).getTime() / 1000);
      const to = Math.floor(new Date(dateTo).getTime() / 1000) + 86400;
      where = " WHERE played_at >= " + from + " AND played_at <= " + to;
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

  const exportCSV = (format: "standard" | "bmi" | "ascap" = "standard") => {
    let header = "";
    let rows: string[] = [];

    if (format === "bmi") {
      // BMI format: Title, Artist, Date, Time, Duration
      header = "Title,Performer,Date Of Use,Time Of Use,Duration";
      rows = entries.map(e => {
        const d = new Date(e.played_at * 1000);
        const date = d.toLocaleDateString("en-US");
        const time = d.toLocaleTimeString("en-US", { hour12: false });
        return [e.title, e.artist || "Unknown", date, time, "3:30"].map(v => '"' + String(v).replace(/"/g, '""') + '"').join(",");
      });
    } else if (format === "ascap") {
      // ASCAP format
      header = "Title,Artist,Date,Start Time,Duration (min),Source";
      rows = entries.map(e => {
        const d = new Date(e.played_at * 1000);
        const date = (d.getMonth()+1) + "/" + d.getDate() + "/" + d.getFullYear();
        const time = d.toLocaleTimeString("en-US", { hour12: false });
        return [e.title, e.artist || "Unknown", date, time, "3.5", "Ether Radio"].map(v => '"' + String(v).replace(/"/g, '""') + '"').join(",");
      });
    } else {
      header = "Date,Time,Title,Artist,Category,Show,Clock,Deck";
      rows = entries.map(e => {
        const d = new Date(e.played_at * 1000);
        const date = d.toLocaleDateString();
        const time = d.toLocaleTimeString();
        return [date, time, e.title, e.artist || "", e.category_code || "", e.show_name || "", e.clock_name || "", e.deck || ""].map(v => '"' + String(v).replace(/"/g, '""') + '"').join(",");
      });
    }

    const csv = header + "\n" + rows.join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ether-" + format + "-" + new Date().toISOString().split("T")[0] + ".csv";
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
          <button onClick={() => setFilter("week")} className={filter === "week" ? "px-3 py-1 rounded text-xs font-bold bg-blue-600 text-white" : "px-3 py-1 rounded text-xs font-bold bg-zinc-800 text-zinc-400"}>7 Days</button>
          <button onClick={() => setFilter("month")} className={filter === "month" ? "px-3 py-1 rounded text-xs font-bold bg-blue-600 text-white" : "px-3 py-1 rounded text-xs font-bold bg-zinc-800 text-zinc-400"}>30 Days</button>
          <button onClick={() => setFilter("all")} className={filter === "all" ? "px-3 py-1 rounded text-xs font-bold bg-blue-600 text-white" : "px-3 py-1 rounded text-xs font-bold bg-zinc-800 text-zinc-400"}>All</button>
          <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setFilter("all"); }} style={{ padding: "2px 6px", borderRadius: 6, fontSize: 11, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)" }} />
          <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>→</span>
          <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setFilter("all"); }} style={{ padding: "2px 6px", borderRadius: 6, fontSize: 11, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)" }} />
          <button onClick={() => exportCSV("standard")} className="px-3 py-1 bg-emerald-700 hover:bg-emerald-600 rounded text-xs font-bold text-white">Export CSV</button>
          <button onClick={() => exportCSV("bmi")} className="px-3 py-1 bg-purple-700 hover:bg-purple-600 rounded text-xs font-bold text-white">BMI</button>
          <button onClick={() => exportCSV("ascap")} className="px-3 py-1 bg-indigo-700 hover:bg-indigo-600 rounded text-xs font-bold text-white">ASCAP</button>
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