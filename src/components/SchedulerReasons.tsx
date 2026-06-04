// SchedulerReasons.tsx — view WHY each song was picked.
//
// Pulls from the scheduler_reasons table (filled by loggen.ts on every
// queue-fill). Two views:
//   - Recent: chronological list of every pick + its reason
//   - By song: pick a song, see every time the scheduler chose it
//
// This is the audit trail PDs use to defend music decisions ("why did
// this Power play after only 12 minutes?") and tune their rules.

import { useEffect, useMemo, useState } from "react";
import { query } from "../db/client";

interface ReasonRow {
  id: number;
  picked_at: number;
  song_id: number;
  source: "clock" | "rule" | "random" | "manual";
  source_detail: string;
  category_id: number | null;
  hour: number;
  filters_json: string;
  pool_size: number;
  notes: string;
  // joined
  title?: string;
  artist_name?: string;
  category_code?: string;
  category_color?: string;
}

const SOURCE_LABEL: Record<string, string> = {
  clock:  "Format Clock",
  rule:   "Smart Rule",
  random: "Fallback Random",
  manual: "PD Pick",
};

const SOURCE_COLOR: Record<string, string> = {
  clock:  "var(--accent-blue)",
  rule:   "#a78bfa",
  random: "#94a3b8",
  manual: "#f59e0b",
};

function fmtTimeAgo(unixSec: number) {
  if (!unixSec) return "—";
  const sec = Math.floor(Date.now()/1000) - unixSec;
  if (sec < 60)    return `${sec}s ago`;
  if (sec < 3600)  return `${Math.floor(sec/60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec/3600)}h ago`;
  return `${Math.floor(sec/86400)}d ago`;
}

export default function SchedulerReasons({ onClose }: { onClose?: () => void }) {
  const [reasons, setReasons] = useState<ReasonRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "clock" | "rule" | "random" | "manual">("all");
  const [hours, setHours] = useState<24 | 168 | 720>(24); // 1d / 7d / 30d
  const [search, setSearch] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const since = Math.floor(Date.now()/1000) - hours * 3600;
      const rows = await query<ReasonRow>(
        `SELECT r.*, s.title, a.name as artist_name,
                c.code as category_code, c.color as category_color
         FROM scheduler_reasons r
         LEFT JOIN songs s ON s.id = r.song_id
         LEFT JOIN artists a ON a.id = s.artist_id
         LEFT JOIN categories c ON c.id = r.category_id
         WHERE r.picked_at >= ?
         ORDER BY r.picked_at DESC
         LIMIT 1000`,
        [since]
      );
      setReasons(rows);
    } catch (e) {
      console.error("[SchedulerReasons] load failed:", e);
    }
    setLoading(false);
  };
  useEffect(() => { load(); }, [hours]);

  const filtered = useMemo(() => {
    return reasons.filter(r => {
      if (filter !== "all" && r.source !== filter) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!(r.title || "").toLowerCase().includes(q) &&
            !(r.artist_name || "").toLowerCase().includes(q) &&
            !(r.source_detail || "").toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [reasons, filter, search]);

  // Quick stats by source
  const sourceCounts = useMemo(() => {
    const c: Record<string, number> = { clock: 0, rule: 0, random: 0, manual: 0 };
    reasons.forEach(r => { c[r.source] = (c[r.source] || 0) + 1; });
    return c;
  }, [reasons]);

  return (
    <div style={{ padding: 24, color: "var(--text-primary)", fontFamily: "'Inter', system-ui, sans-serif", minHeight: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: "-0.04em" }}>Scheduler Reasons</h1>
          <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 4 }}>
            Audit trail of every song the auto-scheduler picked and why
          </div>
        </div>
        {onClose && <button onClick={onClose} style={btnStyle}>Close</button>}
      </div>

      {/* Source breakdown stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 18 }}>
        {(["clock","rule","manual","random"] as const).map(s => (
          <div key={s} style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", padding: "12px 14px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: SOURCE_COLOR[s] }} />
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.06em" }}>{SOURCE_LABEL[s]}</span>
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: "var(--text-primary)" }}>{sourceCounts[s] || 0}</div>
            <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
              {reasons.length > 0 ? `${Math.round((sourceCounts[s] || 0) / reasons.length * 100)}%` : "—"} of picks
            </div>
          </div>
        ))}
      </div>

      {/* Filter row */}
      <div style={{ display: "flex", gap: 10, marginBottom: 14, alignItems: "center", flexWrap: "wrap" as any }}>
        <div style={{ display: "flex", gap: 4 }}>
          {(["all","clock","rule","manual","random"] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)} style={{
              padding: "6px 12px", borderRadius: 0, fontSize: 12, fontWeight: 600,
              background: filter === f ? "var(--accent-blue)" : "var(--bg-secondary)",
              color:      filter === f ? "#fff" : "var(--text-secondary)",
              border: filter === f ? "none" : "1px solid var(--border-primary)",
              cursor: "pointer", textTransform: "capitalize" as any,
            }}>{f}</button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {[
            { h: 24,  label: "24h" },
            { h: 168, label: "7d" },
            { h: 720, label: "30d" },
          ].map(({ h, label }) => (
            <button key={h} onClick={() => setHours(h as any)} style={{
              padding: "6px 12px", borderRadius: 0, fontSize: 12, fontWeight: 600,
              background: hours === h ? "var(--accent-blue)" : "var(--bg-secondary)",
              color:      hours === h ? "#fff" : "var(--text-secondary)",
              border: hours === h ? "none" : "1px solid var(--border-primary)",
              cursor: "pointer",
            }}>{label}</button>
          ))}
        </div>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search title, artist, or source..."
          style={{ flex: 1, minWidth: 200, padding: "6px 10px", borderRadius: 0, fontSize: 12, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }} />
      </div>

      {loading ? (
        <div style={{ padding: 40, textAlign: "center" as any, color: "var(--text-tertiary)" }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: 60, textAlign: "center" as any, background: "var(--bg-secondary)", border: "1px dashed var(--border-primary)" }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 4 }}>No reasons logged yet</div>
          <div style={{ fontSize: 13, color: "var(--text-tertiary)" }}>Reasons are recorded automatically when AUTO is on and the scheduler fills the queue.</div>
        </div>
      ) : (
        <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" as any, fontSize: 12 }}>
            <thead>
              <tr style={{ background: "var(--bg-tertiary)", borderBottom: "1px solid var(--border-primary)" }}>
                {["When","Source","Title","Artist","Category","Detail","Pool"].map(h => (
                  <th key={h} style={{ padding: "10px 12px", textAlign: "left" as any, fontSize: 11, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.08em" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => {
                let filters: any = {};
                try { filters = JSON.parse(r.filters_json || "{}"); } catch {}
                return (
                  <tr key={r.id} style={{ borderBottom: "1px solid var(--border-primary)" }}>
                    <td style={{ padding: "8px 12px", fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "var(--text-secondary)" }} title={new Date(r.picked_at*1000).toLocaleString()}>
                      {fmtTimeAgo(r.picked_at)}
                    </td>
                    <td style={{ padding: "8px 12px" }}>
                      <span style={{
                        padding: "2px 8px", fontSize: 10, fontWeight: 700, letterSpacing: "0.04em",
                        background: SOURCE_COLOR[r.source] + "22", color: SOURCE_COLOR[r.source],
                        textTransform: "uppercase" as any,
                      }}>{r.source}</span>
                    </td>
                    <td style={{ padding: "8px 12px", color: "var(--text-primary)", fontWeight: 600, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title || `#${r.song_id}`}</td>
                    <td style={{ padding: "8px 12px", color: "var(--text-secondary)" }}>{r.artist_name || "—"}</td>
                    <td style={{ padding: "8px 12px" }}>
                      {r.category_code ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                          <span style={{ width: 6, height: 6, borderRadius: "50%", background: r.category_color || "#94a3b8" }} />
                          <span style={{ color: "var(--text-secondary)", fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>{r.category_code}</span>
                        </span>
                      ) : <span style={{ color: "var(--text-tertiary)" }}>—</span>}
                    </td>
                    <td style={{ padding: "8px 12px", color: "var(--text-secondary)", fontSize: 11 }}>
                      <div>{r.source_detail || "—"}</div>
                      {Object.keys(filters).length > 0 && (
                        <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 2 }} title={JSON.stringify(filters, null, 2)}>
                          {Object.entries(filters).slice(0, 3).map(([k, v]) =>
                            <span key={k} style={{ marginRight: 8 }}>{k}: <code>{Array.isArray(v) ? v.join(",") : String(v ?? "—")}</code></span>
                          )}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: "8px 12px", color: "var(--text-tertiary)", fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>
                      {r.pool_size > 0 ? r.pool_size : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: "6px 12px", borderRadius: 0, fontSize: 12, fontWeight: 600,
  background: "var(--bg-tertiary)", color: "var(--text-secondary)",
  border: "1px solid var(--border-primary)", cursor: "pointer",
};
