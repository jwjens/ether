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

// ── TRAFFIC / AS-RUN (2026-08-09) ───────────────────────────────────────────────────────────────
// A spot row in `generated_schedule` already carries its own as-run truth: `scheduled_at` (when it
// was meant to air), `played_at` + `state` (what actually happened — written by the daemon at
// engine.js:1087/1455-1462). Reconciliation is therefore an EXACT per-row read, not a fuzzy
// title match. The advertiser/ISCI/cart/agency fields live on `spots` and join by file_path — the
// same key the generator wrote the row with (main.js:6950).
// docs/help-traffic.md
interface TrafficRow {
  id: number;
  scheduled_at: number;
  played_at: number | null;
  state: string | null;          // pending | playing | played | missed
  title: string;
  artist: string | null;         // generator stores advertiser here for spot rows (main.js:6950)
  duration_s: number | null;
  file_path: string | null;
  advertiser: string | null;
  isci_code: string | null;
  cart_number: string | null;
  agency: string | null;
  length_sec: number | null;
  spot_type: string | null;
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
  const [view, setView] = useState<"plays" | "traffic">("plays");
  const [traffic, setTraffic] = useState<TrafficRow[]>([]);
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

  // The one place the selected period becomes epochs. Previously each consumer recomputed it and
  // they drifted apart; traffic + reconcile now share this so an export and the table on screen can
  // never describe different windows.
  const rangeEpochs = (): [number, number] => {
    let start = 0, end = Math.floor(Date.now() / 1000) + 86400;
    if (filter === "today") start = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
    else if (filter === "week") start = Math.floor(Date.now() / 1000) - 7 * 86400;
    else if (filter === "month") start = Math.floor(Date.now() / 1000) - 30 * 86400;
    else if (dateFrom) start = Math.floor(new Date(dateFrom).getTime() / 1000);
    if (filter === "all" && dateTo) end = Math.floor(new Date(dateTo).getTime() / 1000) + 86400;
    return [start, end];
  };

  // TRAFFIC — every SPOT the log placed in the period, with what actually aired.
  // LEFT JOIN so a spot whose source row was since deleted still appears (billing must show it);
  // the join is station-scoped as well as file-path matched, because `spots.file_path` is only
  // unique WITHIN a station (main.js:6525) and an unscoped join would duplicate rows across stations.
  const loadTraffic = async () => {
    if (!stationId) return;
    const [start, end] = rangeEpochs();
    const rows = await queryScoped<TrafficRow>(
      `SELECT gs.id, gs.scheduled_at, gs.played_at, gs.state, gs.title, gs.artist,
              gs.duration_s, gs.file_path,
              sp.advertiser, sp.isci_code, sp.cart_number, sp.agency, sp.length_sec, sp.spot_type
         FROM generated_schedule gs
         LEFT JOIN spots sp
           ON sp.file_path = gs.file_path
          AND sp.station_id = gs.station_id
          AND sp.deleted_at IS NULL
        WHERE gs.station_id = ?
          AND gs.content_class = 'SPOT'
          AND gs.deleted_at IS NULL
          AND gs.scheduled_at >= ? AND gs.scheduled_at <= ?
        ORDER BY gs.scheduled_at`,
      [stationId, start, end],
      stationId,
      { skipScoping: true }
    ) || [];
    setTraffic(rows);
  };

  useEffect(() => { load(); const id = setInterval(load, 5000); return () => clearInterval(id); }, [filter, dateFrom, dateTo]);
  useEffect(() => { if (view === "traffic") loadTraffic(); }, [view, filter, dateFrom, dateTo, stationId]);

  const [showReconcile, setShowReconcile] = useState(false);
  const [reconcileData, setReconcileData] = useState<{ scheduled: any[]; actual: any[]; matched: any[] } | null>(null);

  // station_id scoping: manual WHERE — DELETE without original WHERE must be scoped explicitly
  const clearLog = async () => { if (!confirm("Clear the entire play log?")) return; await (window as any).ether.playLog.clearByStation(stationId); load(); };

  // ── As-Run reconciliation ───────────────────────────────────────────────────────────────────────
  // FIXED 2026-08-09. This used to read `scheduled_log`, which NOTHING WRITES — ProgramLog.tsx:162
  // records it plainly: "scheduled_log has 0 rows and schedule generation has never worked." So the
  // scheduled side was always empty and every aired item was reported "+ UNSCHED". The real playout
  // source is `generated_schedule` (the Log-Reader Flip's single source).
  //
  // It also no longer fuzzy-matches titles within a 10-minute window. Each generated_schedule row
  // carries its OWN outcome — `state` and `played_at`, stamped by the daemon (engine.js:1455-1462) —
  // so a scheduled item and its airing are the same row. Title matching could pair the wrong airing
  // of a song that ran twice in a period; a row cannot be mistaken for itself.
  const runReconcile = async () => {
    const [startEpoch, endEpoch] = rangeEpochs();
    const nowSec = Math.floor(Date.now() / 1000);

    const scheduled = await queryScoped<any>(
      `SELECT id, scheduled_at, played_at, state, title, artist, duration_s, content_class, file_path
         FROM generated_schedule
        WHERE station_id = ? AND deleted_at IS NULL
          AND scheduled_at >= ? AND scheduled_at <= ?
        ORDER BY scheduled_at`,
      [stationId, startEpoch, endEpoch],
      stationId,
      { skipScoping: true }
    ) || [];
    const actual = await queryScoped<any>(
      "SELECT * FROM play_log WHERE station_id = ? AND played_at >= ? AND played_at <= ? ORDER BY played_at",
      [stationId, startEpoch, endEpoch],
      stationId,
      { skipScoping: true }
    ) || [];

    const matched = scheduled.map((s: any) => {
      const aired = s.state === "played" || s.state === "playing";
      // A row still 'pending' whose time has passed did not air — report it as missed rather than
      // leaving it in a limbo the operator has to interpret.
      const status = aired ? "match"
                   : s.state === "missed" ? "missed"
                   : s.scheduled_at < nowSec ? "missed"
                   : "pending";
      return {
        scheduled: s,
        actual: aired ? {
          id: s.id, title: s.title, artist: s.artist,
          played_at: s.played_at ?? s.scheduled_at,
          duration_ms: (s.duration_s || 0) * 1000,
        } : null,
        status,
      };
    });

    // Anything that reached air without a log row behind it — a hand-load, a cart fired live.
    // Keyed on file_path (what the log and the play log both record) rather than on title.
    const schedPaths = new Set(scheduled.map((s: any) => s.file_path).filter(Boolean));
    const unscheduled = actual
      .filter((a: any) => a.file_path && !schedPaths.has(a.file_path))
      .map((a: any) => ({ scheduled: null, actual: a, status: "unscheduled" }));

    setReconcileData({ scheduled, actual, matched: [...matched, ...unscheduled] });
    setShowReconcile(true);
  };

  const exportAsRun = () => {
    if (!reconcileData) return;
    const header = "Time,Scheduled Title,Scheduled Artist,Actual Title,Actual Artist,Status,Duration";
    const rows = reconcileData.matched.map((m: any) => {
      // generated_schedule carries a real epoch; the old hour/position arithmetic belonged to
      // scheduled_log and produced a fabricated clock time.
      const t = m.actual ? new Date((m.actual.played_at || 0) * 1000).toLocaleTimeString("en-US", { hour12: false })
                        : (m.scheduled ? new Date((m.scheduled.scheduled_at || 0) * 1000).toLocaleTimeString("en-US", { hour12: false }) : "");
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

  // TRAFFIC EXPORT — the affidavit a station bills against. Scheduled vs actual per spot, with the
  // advertiser identifiers a traffic system needs to reconcile. Empty cells are written empty rather
  // than filled with a guess: an unmatched spot is a real condition the traffic manager must see.
  const exportTraffic = () => {
    const header = "Date,Scheduled Time,Actual Time,Delta (s),Status,Cart,ISCI,Advertiser,Agency,Title,Length (s),Spot Type";
    const rows = traffic.map(t => {
      const sd = new Date(t.scheduled_at * 1000);
      const aired = t.state === "played" || t.state === "playing";
      const actualTs = aired ? (t.played_at ?? t.scheduled_at) : null;
      const status = aired ? "AIRED"
                   : t.state === "missed" ? "MISSED"
                   : t.scheduled_at < Math.floor(Date.now() / 1000) ? "MISSED"
                   : "PENDING";
      return [
        sd.toLocaleDateString(),
        sd.toLocaleTimeString("en-US", { hour12: false }),
        actualTs != null ? new Date(actualTs * 1000).toLocaleTimeString("en-US", { hour12: false }) : "",
        actualTs != null ? String(actualTs - t.scheduled_at) : "",
        status,
        t.cart_number || "",
        t.isci_code || "",
        // The generator copies advertiser into gs.artist at placement (main.js:6950), so that value
        // survives even if the spot row is later edited or removed. Prefer the live spots row, fall
        // back to what was recorded at the time it aired.
        t.advertiser || t.artist || "",
        t.agency || "",
        t.title || "",
        String(t.length_sec ?? t.duration_s ?? ""),
        t.spot_type || "",
      ].map(v => '"' + String(v).replace(/"/g, '""') + '"').join(",");
    });
    const csv = header + "\n" + rows.join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "ether-traffic-" + new Date().toISOString().split("T")[0] + ".csv"; a.click();
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
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--text-primary)", margin: 0, fontFamily: "'Newsreader', Georgia, serif" }}>
            {view === "traffic" ? "Traffic" : "Play Log"}
          </h1>
          {/* Two readings of the same period: everything that aired, or just the spots and whether
              they made air. Same date filter drives both. */}
          <div style={{ display: "flex", gap: 2 }}>
            {([["plays", "Play Log"], ["traffic", "Traffic"]] as const).map(([id, label]) => (
              <button key={id} onClick={() => setView(id)} style={{
                padding: "5px 12px", borderRadius: 0, fontSize: 11, fontWeight: 700, cursor: "pointer",
                background: view === id ? "var(--accent-purple)" : "var(--bg-secondary)",
                color: view === id ? "#fff" : "var(--text-tertiary)",
                border: view === id ? "none" : "1px solid var(--border-primary)",
              }}>{label}</button>
            ))}
          </div>
        </div>

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
          {view === "traffic" ? (
            <button onClick={exportTraffic} disabled={traffic.length === 0}
              title={traffic.length === 0 ? "No spots scheduled in this period" : "Export the traffic affidavit as CSV"}
              style={{ padding: "6px 12px", borderRadius: 0, fontSize: 11, fontWeight: 700, background: traffic.length ? "var(--accent-purple)" : "var(--bg-secondary)", border: traffic.length ? "none" : "1px solid var(--border-primary)", color: traffic.length ? "#fff" : "var(--text-tertiary)", cursor: traffic.length ? "pointer" : "not-allowed" }}>
              Export Traffic CSV
            </button>
          ) : (<>
          <button onClick={() => exportCSV("standard")} style={{ padding: "6px 12px", borderRadius: 0, fontSize: 11, fontWeight: 600, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer" }}>Export CSV</button>
          <button onClick={() => exportCSV("bmi")} style={{ padding: "6px 12px", borderRadius: 0, fontSize: 11, fontWeight: 600, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer" }}>BMI</button>
          <button onClick={() => exportCSV("ascap")} style={{ padding: "6px 12px", borderRadius: 0, fontSize: 11, fontWeight: 600, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer" }}>ASCAP</button>
          <button onClick={exportPDF} style={{ padding: "6px 12px", borderRadius: 0, fontSize: 11, fontWeight: 600, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer" }}>PDF</button>
          </>)}
          <button onClick={runReconcile} style={{ padding: "6px 12px", borderRadius: 0, fontSize: 11, fontWeight: 600, background: showReconcile ? "var(--accent-purple)" : "var(--bg-secondary)", border: showReconcile ? "none" : "1px solid var(--border-primary)", color: showReconcile ? "#fff" : "var(--accent-purple)", cursor: "pointer" }}>As-Run</button>
          <button onClick={clearLog} style={{ padding: "6px 12px", borderRadius: 0, fontSize: 11, fontWeight: 600, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--accent-red)", cursor: "pointer" }}>Clear</button>
        </div>
      </div>

      {/* ── TRAFFIC ─────────────────────────────────────────────────────────────────────────────── */}
      {view === "traffic" && (() => {
        const nowSec = Math.floor(Date.now() / 1000);
        const airedRows = traffic.filter(t => t.state === "played" || t.state === "playing");
        const missedRows = traffic.filter(t => t.state === "missed" || (t.state !== "played" && t.state !== "playing" && t.scheduled_at < nowSec));
        const due = airedRows.length + missedRows.length;
        const onTimePct = due > 0 ? Math.round((airedRows.length / due) * 100) : 0;
        // A spot the log placed but that has no matching `spots` row can still be billed from what
        // was recorded at placement — but the operator should know the identifiers are missing.
        const unmatched = traffic.filter(t => !t.advertiser && !t.isci_code && !t.cart_number).length;

        return (
          <div style={{ display: "flex", flexDirection: "column" as any, gap: 16 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
              {[
                { label: "Spots Scheduled", value: traffic.length, color: "var(--text-primary)" },
                { label: "Aired", value: airedRows.length, color: "var(--accent-green)" },
                { label: "Missed", value: missedRows.length, color: missedRows.length ? "var(--accent-red)" : "var(--text-primary)" },
                { label: "Aired of Due", value: due ? onTimePct + "%" : "—", color: onTimePct >= 95 ? "var(--accent-green)" : onTimePct >= 80 ? "var(--accent-amber)" : "var(--accent-red)" },
              ].map(s => (
                <div key={s.label} style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, padding: "16px", textAlign: "center" as any }}>
                  <div style={{ fontSize: 28, fontWeight: 700, fontFamily: "'DM Mono', monospace", letterSpacing: "-0.04em", color: s.color }}>{s.value}</div>
                  <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.1em", marginTop: 4 }}>{s.label}</div>
                </div>
              ))}
            </div>

            {unmatched > 0 && (
              <div style={{ background: "rgba(251,191,36,0.10)", border: "1px solid var(--accent-amber)", padding: "10px 14px", fontSize: 12, color: "var(--text-secondary)" }}>
                <strong style={{ color: "var(--accent-amber)" }}>{unmatched}</strong> spot{unmatched === 1 ? " has" : "s have"} no advertiser, cart or ISCI on file. They still export, but with those columns blank — fill them in <strong>Spots &amp; Promos</strong> so the affidavit is billable.
              </div>
            )}

            {traffic.length === 0 ? (
              <div style={{ textAlign: "center" as any, padding: "64px 24px" }}>
                <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>No spots scheduled in this period</div>
                <div style={{ fontSize: 13, color: "var(--text-tertiary)", maxWidth: 460, margin: "0 auto" }}>
                  Traffic reads the generated log. Add spot breaks to a clock and run <strong>Generate</strong> in the Calendar, then spots will appear here with the time they aired.
                </div>
              </div>
            ) : (
              <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, overflowX: "auto" as any }}>
                <table style={{ width: "100%", borderCollapse: "collapse" as any, fontSize: 12, minWidth: 900 }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid var(--border-primary)", background: "var(--bg-tertiary)" }}>
                      {["Sched", "Aired", "Δ", "Status", "Cart", "ISCI", "Advertiser", "Title", "Len"].map(h => (
                        <th key={h} style={{ padding: "9px 12px", textAlign: "left" as any, fontSize: 9, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.1em", whiteSpace: "nowrap" as any }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {traffic.map((t, i) => {
                      const aired = t.state === "played" || t.state === "playing";
                      const actualTs = aired ? (t.played_at ?? t.scheduled_at) : null;
                      const delta = actualTs != null ? actualTs - t.scheduled_at : null;
                      const status = aired ? "AIRED" : (t.state === "missed" || t.scheduled_at < nowSec) ? "MISSED" : "PENDING";
                      const sc = status === "AIRED" ? "var(--accent-green)" : status === "MISSED" ? "var(--accent-red)" : "var(--text-tertiary)";
                      return (
                        <tr key={t.id} style={{ borderBottom: i < traffic.length - 1 ? "1px solid var(--border-primary)" : "none" }}>
                          <td style={{ padding: "8px 12px", fontFamily: "'DM Mono', monospace", fontSize: 11, color: "var(--text-secondary)", whiteSpace: "nowrap" as any }}>{fmtTimestamp(t.scheduled_at)}</td>
                          <td style={{ padding: "8px 12px", fontFamily: "'DM Mono', monospace", fontSize: 11, color: aired ? "var(--text-primary)" : "var(--text-tertiary)", whiteSpace: "nowrap" as any }}>{actualTs != null ? fmtTimestamp(actualTs) : "—"}</td>
                          <td style={{ padding: "8px 12px", fontFamily: "'DM Mono', monospace", fontSize: 11, color: delta != null && Math.abs(delta) > 120 ? "var(--accent-amber)" : "var(--text-tertiary)", whiteSpace: "nowrap" as any }}>
                            {delta != null ? (delta >= 0 ? "+" : "") + delta + "s" : "—"}
                          </td>
                          <td style={{ padding: "8px 12px" }}>
                            <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 8px", background: sc + "1f", color: sc, whiteSpace: "nowrap" as any }}>{status}</span>
                          </td>
                          <td style={{ padding: "8px 12px", fontFamily: "'DM Mono', monospace", fontSize: 11, color: "var(--text-tertiary)" }}>{t.cart_number || "—"}</td>
                          <td style={{ padding: "8px 12px", fontFamily: "'DM Mono', monospace", fontSize: 11, color: "var(--text-tertiary)" }}>{t.isci_code || "—"}</td>
                          <td style={{ padding: "8px 12px", color: "var(--text-primary)", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>{t.advertiser || t.artist || "—"}</td>
                          <td style={{ padding: "8px 12px", color: "var(--text-secondary)", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>{t.title}</td>
                          <td style={{ padding: "8px 12px", fontFamily: "'DM Mono', monospace", fontSize: 11, color: "var(--text-tertiary)", whiteSpace: "nowrap" as any }}>{(t.length_sec ?? t.duration_s ?? "—")}{(t.length_sec ?? t.duration_s) != null ? "s" : ""}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })()}

      {/* Stats */}
      {view === "plays" && (<>
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
      </>)}
      {/* As-Run Reconciliation */}
      {showReconcile && reconcileData && (() => {
        const matchCount = reconcileData.matched.filter((m: any) => m.status === "match").length;
        const missedCount = reconcileData.matched.filter((m: any) => m.status === "missed").length;
        const unschedCount = reconcileData.matched.filter((m: any) => m.status === "unscheduled").length;
        const pendingCount = reconcileData.matched.filter((m: any) => m.status === "pending").length;
        // Denominator is what has actually come DUE (match + missed). Dividing by every scheduled row
        // would count not-yet-aired rows as failures and show a station running perfectly at 12% all week.
        const due = matchCount + missedCount;
        const pct = due > 0 ? Math.round((matchCount / due) * 100) : 0;
        const STATUS_STYLE: Record<string, { bg: string; color: string; label: string }> = {
          match: { bg: "rgba(52,211,153,0.12)", color: "var(--accent-green)", label: "✓ MATCH" },
          missed: { bg: "rgba(248,113,113,0.12)", color: "var(--accent-red)", label: "✗ MISSED" },
          unscheduled: { bg: "rgb(from var(--accent-blue) r g b / 0.12)", color: "var(--accent-blue)", label: "+ UNSCHED" },
          // Scheduled but not yet due — must NOT be coloured as a failure, or a week-range report
          // shows every future row as missed.
          pending: { bg: "rgba(148,163,184,0.12)", color: "var(--text-tertiary)", label: "· PENDING" },
        };
        return (
          <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", overflow: "hidden" }}>
            <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-primary)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" as any }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", fontFamily: "'Newsreader', Georgia, serif" }}>As-Run Reconciliation</span>
              <div style={{ display: "flex", gap: 10, fontSize: 11 }}>
                <span style={{ color: "var(--accent-green)", fontWeight: 700 }}>{matchCount} matched</span>
                <span style={{ color: "var(--accent-red)", fontWeight: 700 }}>{missedCount} missed</span>
                <span style={{ color: "var(--accent-blue)", fontWeight: 700 }}>{unschedCount} unscheduled</span>
                {pendingCount > 0 && <span style={{ color: "var(--text-tertiary)", fontWeight: 700 }}>{pendingCount} pending</span>}
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
                  const time = m.actual ? fmtTimestamp(m.actual.played_at) : (m.scheduled ? fmtTimestamp(m.scheduled.scheduled_at) : "—");
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
