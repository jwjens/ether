import { useState, useEffect } from "react";
import { queryScoped } from "../db/stationScoped";
import { useActiveStation } from "../hooks/useActiveStation";

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
  const { stationId } = useActiveStation();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<"today" | "week" | "month" | "all">("today");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  // Customer's actual station name — used in CSV exports + printed traffic
  // log header instead of a hardcoded placeholder. Empty until KV fetch
  // resolves; headers and exports gracefully omit the prefix when empty.
  const [stationName, setStationName] = useState<string>("");
  useEffect(() => {
    if (!stationId) return;
    (async () => {
      try {
        const result = await (window as any).ether.stationConfigKv.list(stationId);
        const rows = result?.ok ? result.rows : [];
        const sn = rows.find((r: any) => r.key === "station_name")?.value;
        if (sn) setStationName(sn);
      } catch {}
    })();
  }, [stationId]);

  const load = async () => {
    // station_id scoping: Strategy C — dynamic WHERE builder; station_id is the base condition
    let sql = "SELECT * FROM play_log WHERE station_id = ?";
    const params: any[] = [stationId];
    let countSql = "SELECT COUNT(*) as c FROM play_log WHERE station_id = ?";
    const countParams: any[] = [stationId];

    if (filter === "today") {
      const startOfDay = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
      sql += " AND played_at >= " + startOfDay;
      countSql += " AND played_at >= " + startOfDay;
    } else if (filter === "week") {
      const weekAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
      sql += " AND played_at >= " + weekAgo;
      countSql += " AND played_at >= " + weekAgo;
    } else if (filter === "month") {
      const monthAgo = Math.floor(Date.now() / 1000) - 30 * 86400;
      sql += " AND played_at >= " + monthAgo;
      countSql += " AND played_at >= " + monthAgo;
    } else if (dateFrom && dateTo) {
      const from = Math.floor(new Date(dateFrom).getTime() / 1000);
      const to = Math.floor(new Date(dateTo).getTime() / 1000) + 86400;
      sql += " AND played_at >= " + from + " AND played_at <= " + to;
      countSql += " AND played_at >= " + from + " AND played_at <= " + to;
    }
    sql += " ORDER BY played_at DESC LIMIT 200";

    const rows = await queryScoped<LogEntry>(sql, params, stationId, { skipScoping: true });
    setEntries(rows);
    const r = await queryScoped<{ c: number }>(countSql, countParams, stationId, { skipScoping: true });
    setTotal(r.length > 0 ? r[0].c : 0);
  };

  useEffect(() => { load(); const id = setInterval(load, 5000); return () => clearInterval(id); }, [filter, dateFrom, dateTo]);

  const [showReconcile, setShowReconcile] = useState(false);
  const [reconcileData, setReconcileData] = useState<{ scheduled: any[]; actual: any[]; matched: any[] } | null>(null);

  // station_id scoping: manual WHERE — DELETE without original WHERE must be scoped explicitly
  const clearLog = async () => { if (!confirm("Clear the entire play log?")) return; await (window as any).ether.playLog.clearByStation(stationId); load(); };

  // As-Run reconciliation: compare scheduled_log vs play_log for the current filter period
  const runReconcile = async () => {
    let startEpoch = 0, endEpoch = Math.floor(Date.now() / 1000) + 86400;
    if (filter === "today") startEpoch = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
    else if (filter === "week") startEpoch = Math.floor(Date.now() / 1000) - 7 * 86400;
    else if (filter === "month") startEpoch = Math.floor(Date.now() / 1000) - 30 * 86400;
    else if (dateFrom) startEpoch = Math.floor(new Date(dateFrom).getTime() / 1000);
    if (dateTo) endEpoch = Math.floor(new Date(dateTo).getTime() / 1000) + 86400;

    // station_id scoping: Strategy B — both tables have existing WHERE clauses
    const scheduled = await queryScoped<any>(
      "SELECT *, created_at as epoch FROM scheduled_log WHERE created_at >= ? AND created_at <= ? ORDER BY hour, position",
      [startEpoch, endEpoch],
      stationId
    ) || [];
    const actual = await queryScoped<any>(
      "SELECT * FROM play_log WHERE played_at >= ? AND played_at <= ? ORDER BY played_at",
      [startEpoch, endEpoch],
      stationId
    ) || [];

    // Match: for each scheduled item, find the closest actual play by title (case-insensitive, within 10 min)
    const usedActual = new Set<number>();
    const matched = scheduled.map((s: any) => {
      const sTitle = (s.title || "").toLowerCase();
      let bestMatch: any = null;
      let bestDist = Infinity;
      for (const a of actual) {
        if (usedActual.has(a.id)) continue;
        if ((a.title || "").toLowerCase() === sTitle) {
          const timeDist = Math.abs((a.played_at || 0) - (s.epoch || 0));
          if (timeDist < bestDist && timeDist < 600) { bestMatch = a; bestDist = timeDist; }
        }
      }
      if (bestMatch) usedActual.add(bestMatch.id);
      const status = bestMatch ? "match" : "missed";
      return { scheduled: s, actual: bestMatch, status };
    });
    // Unscheduled items (played but not in schedule)
    const unscheduled = actual.filter((a: any) => !usedActual.has(a.id)).map((a: any) => ({
      scheduled: null, actual: a, status: "unscheduled",
    }));

    setReconcileData({ scheduled, actual, matched: [...matched, ...unscheduled] });
    setShowReconcile(true);
  };

  const exportAsRun = () => {
    if (!reconcileData) return;
    const header = "Time,Scheduled Title,Scheduled Artist,Actual Title,Actual Artist,Status,Duration";
    const rows = reconcileData.matched.map((m: any) => {
      const t = m.actual ? new Date((m.actual.played_at || 0) * 1000).toLocaleTimeString("en-US", { hour12: false })
                        : (m.scheduled ? `${m.scheduled.hour || 0}:${String((m.scheduled.position || 0) * 3).padStart(2, "0")}:00` : "");
      return [
        t,
        m.scheduled?.title || "",
        m.scheduled?.artist || "",
        m.actual?.title || "",
        m.actual?.artist || "",
        m.status === "match" ? "MATCH" : m.status === "missed" ? "MISSED" : "UNSCHED",
        m.actual?.duration_ms ? (m.actual.duration_ms / 1000).toFixed(0) : "",
      ].map(v => '"' + String(v).replace(/"/g, '""') + '"').join(",");
    });
    const csv = header + "\n" + rows.join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "ether-asrun-" + new Date().toISOString().split("T")[0] + ".csv"; a.click();
    URL.revokeObjectURL(url);
  };

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
        return [e.title, e.artist || "Unknown", (d.getMonth()+1)+"/"+d.getDate()+"/"+d.getFullYear(), d.toLocaleTimeString("en-US", { hour12: false }), "3.5", stationName].map(v => '"' + String(v).replace(/"/g, '""') + '"').join(",");
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
<h1>${stationName ? stationName + " — " : ""}Traffic Log</h1>
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
      padding: "6px 14px", borderRadius: 0, fontSize: 11, fontWeight: 700, cursor: "pointer",
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
            style={{ padding: "5px 8px", borderRadius: 0, fontSize: 11, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }} />
          <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>→</span>
          <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setFilter("all"); }}
            style={{ padding: "5px 8px", borderRadius: 0, fontSize: 11, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }} />

          {/* Export buttons */}
          <div style={{ width: 1, height: 20, background: "var(--border-primary)", margin: "0 2px" }} />
          <button onClick={() => exportCSV("standard")} style={{ padding: "6px 12px", borderRadius: 0, fontSize: 11, fontWeight: 600, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer" }}>Export CSV</button>
          <button onClick={() => exportCSV("bmi")} style={{ padding: "6px 12px", borderRadius: 0, fontSize: 11, fontWeight: 600, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer" }}>BMI</button>
          <button onClick={() => exportCSV("ascap")} style={{ padding: "6px 12px", borderRadius: 0, fontSize: 11, fontWeight: 600, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer" }}>ASCAP</button>
          <button onClick={exportPDF} style={{ padding: "6px 12px", borderRadius: 0, fontSize: 11, fontWeight: 600, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer" }}>PDF</button>
          <button onClick={runReconcile} style={{ padding: "6px 12px", borderRadius: 0, fontSize: 11, fontWeight: 600, background: showReconcile ? "var(--accent-purple)" : "var(--bg-secondary)", border: showReconcile ? "none" : "1px solid var(--border-primary)", color: showReconcile ? "#fff" : "var(--accent-purple)", cursor: "pointer" }}>As-Run</button>
          <button onClick={clearLog} style={{ padding: "6px 12px", borderRadius: 0, fontSize: 11, fontWeight: 600, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--accent-red)", cursor: "pointer" }}>Clear</button>
        </div>
      </div>

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
        {[
          { label: "Songs Played", value: total },
          { label: "Unique Artists", value: uniqueArtists },
          { label: "Unique Songs", value: uniqueSongs },
        ].map(s => (
          <div key={s.label} style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, padding: "16px", textAlign: "center" as any }}>
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
        <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, overflow: "hidden" }}>
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
                      <span style={{ fontSize: 10, fontWeight: 700, color: DECK_COLORS[e.deck] || "var(--text-tertiary)", background: (DECK_COLORS[e.deck] || "var(--text-tertiary)") + "20", padding: "2px 7px", borderRadius: 0 }}>
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
      {/* As-Run Reconciliation */}
      {showReconcile && reconcileData && (() => {
        const matchCount = reconcileData.matched.filter((m: any) => m.status === "match").length;
        const missedCount = reconcileData.matched.filter((m: any) => m.status === "missed").length;
        const unschedCount = reconcileData.matched.filter((m: any) => m.status === "unscheduled").length;
        const totalSched = reconcileData.scheduled.length;
        const pct = totalSched > 0 ? Math.round((matchCount / totalSched) * 100) : 0;
        const STATUS_STYLE: Record<string, { bg: string; color: string; label: string }> = {
          match: { bg: "rgba(52,211,153,0.12)", color: "var(--accent-green)", label: "✓ MATCH" },
          missed: { bg: "rgba(248,113,113,0.12)", color: "var(--accent-red)", label: "✗ MISSED" },
          unscheduled: { bg: "rgba(56,189,248,0.12)", color: "var(--accent-blue)", label: "+ UNSCHED" },
        };
        return (
          <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", overflow: "hidden" }}>
            <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-primary)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" as any }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", fontFamily: "'Syne', sans-serif" }}>As-Run Reconciliation</span>
              <div style={{ display: "flex", gap: 10, fontSize: 11 }}>
                <span style={{ color: "var(--accent-green)", fontWeight: 700 }}>{matchCount} matched</span>
                <span style={{ color: "var(--accent-red)", fontWeight: 700 }}>{missedCount} missed</span>
                <span style={{ color: "var(--accent-blue)", fontWeight: 700 }}>{unschedCount} unscheduled</span>
              </div>
              <div style={{ flex: 1 }} />
              <div style={{ width: 100, height: 6, background: "var(--bg-tertiary)", overflow: "hidden" }}>
                <div style={{ height: "100%", width: pct + "%", background: pct >= 90 ? "var(--accent-green)" : pct >= 70 ? "var(--accent-amber)" : "var(--accent-red)", transition: "width 0.3s" }} />
              </div>
              <span style={{ fontSize: 12, fontWeight: 700, fontFamily: "'DM Mono', monospace", color: pct >= 90 ? "var(--accent-green)" : pct >= 70 ? "var(--accent-amber)" : "var(--accent-red)" }}>{pct}%</span>
              <button onClick={exportAsRun} style={{ padding: "5px 12px", borderRadius: 0, fontSize: 10, fontWeight: 700, background: "var(--accent-purple)", color: "#fff", border: "none", cursor: "pointer" }}>Export As-Run CSV</button>
              <button onClick={() => setShowReconcile(false)} style={{ padding: "5px 10px", borderRadius: 0, fontSize: 10, background: "var(--bg-tertiary)", color: "var(--text-tertiary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>Close</button>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse" as any, fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border-primary)", background: "var(--bg-tertiary)" }}>
                  {["Time", "Scheduled", "Actual", "Status"].map(h => (
                    <th key={h} style={{ padding: "8px 14px", textAlign: "left" as any, fontSize: 9, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.1em" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {reconcileData.matched.map((m: any, i: number) => {
                  const st = STATUS_STYLE[m.status] || STATUS_STYLE.match;
                  const time = m.actual ? fmtTimestamp(m.actual.played_at) : (m.scheduled ? `${m.scheduled.hour}:${String((m.scheduled.position || 0) * 3).padStart(2, "0")}` : "—");
                  return (
                    <tr key={i} style={{ borderBottom: "1px solid var(--border-primary)" }}>
                      <td style={{ padding: "8px 14px", fontFamily: "'DM Mono', monospace", fontSize: 10, color: "var(--text-tertiary)", whiteSpace: "nowrap" as any }}>{time}</td>
                      <td style={{ padding: "8px 14px", color: m.scheduled ? "var(--text-primary)" : "var(--text-tertiary)", maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>
                        {m.scheduled ? `${m.scheduled.title} — ${m.scheduled.artist || ""}` : "—"}
                      </td>
                      <td style={{ padding: "8px 14px", color: m.actual ? "var(--text-primary)" : "var(--text-tertiary)", maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>
                        {m.actual ? `${m.actual.title} — ${m.actual.artist || ""}` : "—"}
                      </td>
                      <td style={{ padding: "8px 14px" }}>
                        <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 8px", background: st.bg, color: st.color }}>{st.label}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })()}
    </div>
  );
}
