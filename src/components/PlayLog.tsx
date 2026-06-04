// src/components/PlayLog.tsx
// Historical play log — view, filter, and export songs played on air.
// Reads from the play_log table only. No scheduling functionality.

import { useState, useEffect, useCallback } from "react";
import { queryScoped } from "../db/stationScoped";
import { useActiveStation } from "../hooks/useActiveStation";

interface LogEntry {
  id: number;
  title: string;
  artist: string | null;
  deck: string | null;
  deck_id: string | null;
  duration_ms: number | null;
  session_id: string | null;
  played_at: number;
}

function fmtTime(epoch: number): string {
  const d = new Date(epoch * 1000);
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function fmtDate(epoch: number): string {
  const d = new Date(epoch * 1000);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function fmtMs(ms: number | null): string {
  if (!ms) return "—";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}`;
}
function isoDate(epoch: number): string {
  return new Date(epoch * 1000).toISOString().slice(0, 10);
}
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

interface Props {
  onClose?: () => void;
}

export default function PlayLog({ onClose }: Props) {
  const { stationId } = useActiveStation();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [deckFilter, setDeckFilter] = useState("");
  const [dateFrom, setDateFrom] = useState(todayIso());
  const [dateTo, setDateTo] = useState(todayIso());
  const [status, setStatus] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Convert ISO dates → unix timestamps (start of day / end of day)
      const fromTs = Math.floor(new Date(dateFrom + "T00:00:00").getTime() / 1000);
      const toTs   = Math.floor(new Date(dateTo   + "T23:59:59").getTime() / 1000);
      // station_id scoping: Strategy B — single table with existing WHERE clause
      const rows = await queryScoped<LogEntry>(
        `SELECT * FROM play_log
         WHERE played_at >= ? AND played_at <= ?
         ORDER BY played_at DESC
         LIMIT 2000`,
        [fromTs, toTs],
        stationId
      );
      setEntries(rows);
    } catch (e) {
      setStatus("Error loading log: " + e);
    }
    setLoading(false);
  }, [dateFrom, dateTo]);

  useEffect(() => { load(); }, [load]);

  const filtered = entries.filter(e => {
    const matchSearch = !search ||
      (e.title || "").toLowerCase().includes(search.toLowerCase()) ||
      (e.artist || "").toLowerCase().includes(search.toLowerCase());
    const matchDeck = !deckFilter || (e.deck || "").toUpperCase() === deckFilter.toUpperCase();
    return matchSearch && matchDeck;
  });

  const exportCsv = () => {
    const header = "Date,Time,Title,Artist,Deck,Duration\n";
    const rows = filtered.map(e =>
      [
        fmtDate(e.played_at),
        fmtTime(e.played_at),
        `"${(e.title || "").replace(/"/g, '""')}"`,
        `"${(e.artist || "").replace(/"/g, '""')}"`,
        e.deck || "",
        fmtMs(e.duration_ms),
      ].join(",")
    ).join("\n");
    const blob = new Blob([header + rows], { type: "text/csv" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `play-log-${dateFrom}-to-${dateTo}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const decks = Array.from(new Set(entries.map(e => e.deck).filter(Boolean))) as string[];

  return (
    <div style={{
      display: "flex", flexDirection: "column", height: "100%",
      fontFamily: "'Inter', system-ui, sans-serif",
    }}>
      {/* ── Header ── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "14px 20px", borderBottom: "1px solid var(--border-primary)",
        background: "var(--bg-secondary)", flexShrink: 0,
      }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, fontFamily: "'Syne', sans-serif", color: "var(--text-primary)", letterSpacing: "-0.03em" }}>
            Program Log
          </h1>
          <p style={{ margin: 0, fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
            Historical record of every song played on air
          </p>
        </div>
        <button onClick={exportCsv} style={{
          padding: "7px 16px", borderRadius: 0, fontSize: 11, fontWeight: 700,
          background: "rgba(52,211,153,0.12)", color: "#34d399",
          border: "1px solid rgba(52,211,153,0.35)", cursor: "pointer",
        }}>
          ↓ Export CSV
        </button>
        {onClose && (
          <button onClick={onClose} style={{
            width: 28, height: 28, borderRadius: 0, fontSize: 14,
            background: "var(--bg-tertiary)", color: "var(--text-tertiary)",
            border: "1px solid var(--border-primary)", cursor: "pointer",
          }}>✕</button>
        )}
      </div>

      {/* ── Filters ── */}
      <div style={{
        display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
        padding: "12px 20px", borderBottom: "1px solid var(--border-primary)",
        background: "var(--bg-secondary)", flexShrink: 0,
      }}>
        {/* Date range */}
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-tertiary)", fontWeight: 600, letterSpacing: "0.05em" }}>
          FROM
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
            style={{ padding: "5px 8px", borderRadius: 0, fontSize: 11, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }} />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-tertiary)", fontWeight: 600, letterSpacing: "0.05em" }}>
          TO
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
            style={{ padding: "5px 8px", borderRadius: 0, fontSize: 11, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }} />
        </label>
        <button onClick={load} style={{
          padding: "5px 14px", borderRadius: 0, fontSize: 11, fontWeight: 700,
          background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer",
        }}>Refresh</button>

        <div style={{ width: 1, height: 24, background: "var(--border-primary)" }} />

        {/* Search */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", padding: "5px 10px", flex: 1, minWidth: 200 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ opacity: 0.4 }}>
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search title or artist..."
            style={{ background: "transparent", border: "none", outline: "none", fontSize: 12, color: "var(--text-primary)", flex: 1 }}
          />
          {search && <button onMouseDown={e => { e.preventDefault(); setSearch(""); }} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-tertiary)", fontSize: 16, lineHeight: 1 }}>×</button>}
        </div>

        {/* Deck filter */}
        <select value={deckFilter} onChange={e => setDeckFilter(e.target.value)}
          style={{ padding: "5px 10px", borderRadius: 0, fontSize: 11, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", outline: "none", cursor: "pointer" }}>
          <option value="">All Decks</option>
          {decks.map(d => <option key={d} value={d}>Deck {d}</option>)}
        </select>

        <span style={{ fontSize: 11, color: "var(--text-tertiary)", marginLeft: 4 }}>
          {filtered.length} entries
        </span>
      </div>

      {/* ── Status ── */}
      {status && (
        <div style={{ padding: "8px 20px", background: "rgba(239,68,68,0.08)", borderBottom: "1px solid rgba(239,68,68,0.2)", fontSize: 12, color: "#ef4444", flexShrink: 0 }}>
          {status}
        </div>
      )}

      {/* ── Table ── */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--text-tertiary)", fontSize: 13 }}>Loading...</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--text-tertiary)", fontSize: 13 }}>
            No entries found for the selected filters.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" as const, fontSize: 12 }}>
            <thead>
              <tr style={{ background: "var(--bg-secondary)", position: "sticky" as const, top: 0, zIndex: 1 }}>
                {["Time", "Title", "Artist", "Deck", "Duration"].map(h => (
                  <th key={h} style={{
                    padding: "8px 14px", textAlign: "left" as const,
                    fontSize: 9, fontWeight: 700, letterSpacing: "0.1em",
                    color: "var(--text-tertiary)", textTransform: "uppercase" as const,
                    borderBottom: "1px solid var(--border-primary)",
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((e, i) => {
                const isNewDate = i === 0 || isoDate(filtered[i - 1].played_at) !== isoDate(e.played_at);
                return (
                  <>
                    {isNewDate && (
                      <tr key={`date-${e.id}`}>
                        <td colSpan={5} style={{
                          padding: "6px 14px 3px",
                          fontSize: 9, fontWeight: 800, letterSpacing: "0.12em",
                          color: "var(--accent-blue)", textTransform: "uppercase" as const,
                          background: "rgb(from var(--accent-blue) r g b / 0.04)",
                          borderBottom: "1px solid rgb(from var(--accent-blue) r g b / 0.1)",
                        }}>
                          {fmtDate(e.played_at)}
                        </td>
                      </tr>
                    )}
                    <tr key={e.id} style={{ borderBottom: "1px solid var(--border-primary)" }}
                      onMouseEnter={ev => (ev.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.02)"}
                      onMouseLeave={ev => (ev.currentTarget as HTMLElement).style.background = "transparent"}>
                      <td style={{ padding: "9px 14px", color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace", fontSize: 11, whiteSpace: "nowrap" as const }}>
                        {fmtTime(e.played_at)}
                      </td>
                      <td style={{ padding: "9px 14px", color: "var(--text-primary)", fontWeight: 600, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
                        {e.title}
                      </td>
                      <td style={{ padding: "9px 14px", color: "var(--text-secondary)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
                        {e.artist || "—"}
                      </td>
                      <td style={{ padding: "9px 14px" }}>
                        {e.deck && (
                          <span style={{
                            display: "inline-block", padding: "2px 8px",
                            fontSize: 9, fontWeight: 800, letterSpacing: "0.08em",
                            background: "rgb(from var(--accent-blue) r g b / 0.1)", color: "var(--accent-blue)",
                            border: "1px solid rgb(from var(--accent-blue) r g b / 0.2)", borderRadius: 0,
                          }}>
                            {e.deck}
                          </span>
                        )}
                      </td>
                      <td style={{ padding: "9px 14px", color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace", fontSize: 11 }}>
                        {fmtMs(e.duration_ms)}
                      </td>
                    </tr>
                  </>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
