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
  return new Date(epoch * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtDate(epoch: number): string {
  return new Date(epoch * 1000).toLocaleDateString();
}

const DECK_COLORS: Record<string, string> = {
  A: "var(--accent-blue)",
  B: "var(--accent-green)",
  C: "var(--accent-purple)",
};

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
    }
    const rows = await query<LogEntry>("SELECT * FROM play_log" + where + " ORDER BY played_at DESC LIMIT 200");
    setEntries(rows);
    const r = await query<{ c: number }>("SELECT COUNT(*) as c FROM play_log" + where);
    setTotal(r.length > 0 ? r[0].c : 0);
  };

  useEffect(() => { load(); const id = setInterval(load, 5000); return () => clearInterval(id); }, [filter, dateFrom, dateTo]);

  const clearLog = async () => { if (!confirm("Clear the entire play log?")) return; await execute("DELETE FROM play_log"); load(); };

  const exportCSV = (format: "standard" | "bmi" | "ascap" = "standard") => {
    let header = "";
    let rows: string[] = [];
    if (format === "bmi") {
      header = "Title,Performer,Date Of Use,Time Of Use,Duration";
      rows = entries.map(e => {
        const d = new Date(e.played_at * 1000);
        return [e.title, e.artist || "Unknown", d.toLocaleDateString("en-US"), d.toLocaleTimeString("en-US", { hour12: false }), "3:30"].map(v => '"' + String(v).replace(/"/g, '""') + '"').join(",");
      });
    } else if (format === "ascap") {
      header = "Title,Artist,Date,Start Time,Duration (min),Source";
      rows = entries.map(e => {
        const d = new Date(e.played_at * 1000);
        return [e.title, e.artist || "Unknown", (d.getMonth()+1)+"/"+d.getDate()+"/"+d.getFullYear(), d.toLocaleTimeString("en-US", { hour12: false }), "3.5", "Ether Radio"].map(v => '"' + String(v).replace(/"/g, '""') + '"').join(",");
      });
    } else {
      header = "Date,Time,Title,Artist,Category,Show,Clock,Deck";
      rows = entries.map(e => {
        const d = new Date(e.played_at * 1000);
        return [d.toLocaleDateString(), d.toLocaleTimeString(), e.title, e.artist || "", e.category_code || "", e.show_name || "", e.clock_name || "", e.deck || ""].map(v => '"' + String(v).replace(/"/g, '""') + '"').join(",");
      });
    }
    const csv = header + "\n" + rows.join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "ether-" + format + "-" + new Date().toISOString().split("T")[0] + ".csv"; a.click();
    URL.revokeObjectURL(url);
  };

  const exportPDF = () => {
    const dateRange = filter === "today" ? "Today" : filter === "week" ? "Last 7 Days" : filter === "month" ? "Last 30 Days" : "All Time";
    const rows = entries.map((e, i) => {
      const d = new Date(e.played_at * 1000);
      return `<tr style="background:${i % 2 === 0 ? "#f9f9f9" : "#fff"}">
        <td>${i+1}</td><td>${d.toLocaleDateString()}</td><td>${d.toLocaleTimeString()}</td>
        <td><strong>${e.title}</strong></td><td>${e.artist || "Unknown"}</td>
        <td>${e.category_code || "—"}</td><td>${e.show_name || "—"}</td>
      </tr>`;
    }).join("\n");
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Ether — Traffic Log</title>
<style>body{font-family:Arial,sans-serif;font-size:11px;color:#333;margin:20px}h1{font-size:18px;margin-bottom:4px}.meta{color:#666;font-size:10px;margin-bottom:16px}table{width:100%;border-collapse:collapse}th{background:#1e293b;color:#fff;padding:6px 8px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.05em}td{padding:5px 8px;border-bottom:1px solid #e5e7eb}</style>
</head><body>
<h1>Ether Radio — Traffic Log</h1>
<div class="meta">Period: ${dateRange} | Generated: ${new Date().toLocaleString()} | Total: ${entries.length} plays</div>
<table><thead><tr><th>#</th><th>Date</th><th>Time</th><th>Title</th><th>Artist</th><th>Cat</th><th>Show</th></tr></thead>
<tbody>${rows}</tbody></table></body></html>`;
    const win = window.open("", "_blank");
    if (win) { win.document.write(html); win.document.close(); setTimeout(() => win.print(), 500); }
  };

  const uniqueArtists = new Set(entries.filter(e => e.artist).map(e => e.artist)).size;
  const uniqueSongs = new Set(entries.map(e => e.title)).size;

  const filterBtn = (id: typeof filter, label: string) => (
    <button onClick={() => setFilter(id)} style={{
      padding: "6px 14px", borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: "pointer",
      background: filter === id ? "var(--accent-blue)" : "var(--bg-secondary)",
      color: filter === id ? "#fff" : "var(--text-tertiary)",
      border: filter === id ? "none" : "1px solid var(--border-primary)",
      boxShadow: filter === id ? "0 2px 8px rgba(14,165,233,0.3)" : "none",
    }}>{label}</button>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column" as any, gap: 16, fontFamily: "'Inter', system-ui, sans-serif" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" as any, gap: 10 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--text-primary)", margin: 0, fontFamily: "'Syne', sans-serif" }}>Play Log</h1>

        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" as any }}>
          {/* Filter buttons */}
          {filterBtn("today", "Today")}
          {filterBtn("week", "7 Days")}
          {filterBtn("month", "30 Days")}
          {filterBtn("all", "All")}

          {/* Date range */}
          <div style={{ width: 1, height: 20, background: "var(--border-primary)", margin: "0 2px" }} />
          <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setFilter("all"); }}
            style={{ padding: "5px 8px", borderRadius: 7, fontSize: 11, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }} />
          <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>→</span>
          <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setFilter("all"); }}
            style={{ padding: "5px 8px", borderRadius: 7, fontSize: 11, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }} />

          {/* Export buttons */}
          <div style={{ width: 1, height: 20, background: "var(--border-primary)", margin: "0 2px" }} />
          <button onClick={() => exportCSV("standard")} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 11, fontWeight: 600, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer" }}>Export CSV</button>
          <button onClick={() => exportCSV("bmi")} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 11, fontWeight: 600, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer" }}>BMI</button>
          <button onClick={() => exportCSV("ascap")} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 11, fontWeight: 600, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer" }}>ASCAP</button>
          <button onClick={exportPDF} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 11, fontWeight: 600, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer" }}>PDF</button>
          <button onClick={clearLog} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 11, fontWeight: 600, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--accent-red)", cursor: "pointer" }}>Clear</button>
        </div>
      </div>

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
        {[
          { label: "Songs Played", value: total },
          { label: "Unique Artists", value: uniqueArtists },
          { label: "Unique Songs", value: uniqueSongs },
        ].map(s => (
          <div key={s.label} style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 12, padding: "16px", textAlign: "center" as any }}>
            <div style={{ fontSize: 28, fontWeight: 700, fontFamily: "'DM Mono', monospace", letterSpacing: "-0.04em", color: "var(--text-primary)" }}>{s.value}</div>
            <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.1em", marginTop: 4 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Table */}
      {entries.length === 0 ? (
        <div style={{ textAlign: "center" as any, padding: "64px 24px" }}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 12, opacity: 0.4 }}><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>
          <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>No plays yet</div>
          <div style={{ fontSize: 13, color: "var(--text-tertiary)" }}>Start playing music and it will appear here automatically</div>
        </div>
      ) : (
        <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 12, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" as any, fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-primary)", background: "var(--bg-tertiary)" }}>
                {["Time", "Title", "Artist", "Cat", "Show", "Deck"].map(h => (
                  <th key={h} style={{ padding: "10px 14px", textAlign: "left" as any, fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.1em" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={e.id}
                  style={{ borderBottom: i < entries.length - 1 ? "1px solid var(--border-primary)" : "none" }}
                  onMouseEnter={ev => (ev.currentTarget.style.background = "var(--bg-hover)")}
                  onMouseLeave={ev => (ev.currentTarget.style.background = "transparent")}
                >
                  <td style={{ padding: "10px 14px", fontFamily: "'DM Mono', monospace", fontSize: 11, color: "var(--text-tertiary)", whiteSpace: "nowrap" as any }}>{fmtTimestamp(e.played_at)}</td>
                  <td style={{ padding: "10px 14px", color: "var(--text-primary)", fontWeight: 500, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>{e.title}</td>
                  <td style={{ padding: "10px 14px", color: "var(--text-secondary)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>{e.artist || "—"}</td>
                  <td style={{ padding: "10px 14px", color: "var(--text-tertiary)", fontSize: 11 }}>{e.category_code || "—"}</td>
                  <td style={{ padding: "10px 14px", color: "var(--text-tertiary)", fontSize: 11, maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>{e.show_name || "—"}</td>
                  <td style={{ padding: "10px 14px" }}>
                    {e.deck ? (
                      <span style={{ fontSize: 10, fontWeight: 700, color: DECK_COLORS[e.deck] || "var(--text-tertiary)", background: (DECK_COLORS[e.deck] || "var(--text-tertiary)") + "20", padding: "2px 7px", borderRadius: 5 }}>
                        {e.deck}
                      </span>
                    ) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
