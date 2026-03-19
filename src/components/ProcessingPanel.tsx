import { useState, useEffect } from "react";
import { processAllSongs, getProcessingStats } from "../audio/processor";
import { query, execute } from "../db/client";

interface SongLevel {
  id: number; title: string; artist_name: string | null;
  lufs_measured: number | null; peak_db: number | null;
  gain_db: number;
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
    // is_processed column may not exist — use lufs_measured as proxy for processed status
    setSongs(await query<SongLevel>(
      "SELECT s.id, s.title, a.name as artist_name, s.lufs_measured, s.peak_db, s.gain_db " +
      "FROM songs s LEFT JOIN artists a ON a.id = s.artist_id " +
      "WHERE s.file_path IS NOT NULL ORDER BY s.lufs_measured ASC NULLS LAST LIMIT 100"
    ));
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
    // Only reset columns that exist
    await execute("UPDATE songs SET lufs_measured=NULL, peak_db=NULL, gain_db=0");
    load();
  };

  const lufsBar = (lufs: number | null) => {
    if (lufs === null) return <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>—</span>;
    const pct = Math.max(0, Math.min(100, ((lufs + 30) / 30) * 100));
    const color = Math.abs(lufs - (-14)) < 2 ? "#22c55e" : Math.abs(lufs - (-14)) < 5 ? "#f59e0b" : "#ef4444";
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <div style={{ width: 64, height: 4, background: "var(--bg-tertiary)", borderRadius: 2, overflow: "hidden" }}>
          <div style={{ width: pct + "%", height: "100%", background: color, borderRadius: 2 }} />
        </div>
        <span style={{ fontSize: 9, fontFamily: "'DM Mono', monospace", color }}>{lufs}</span>
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>Audio Processing</h2>
          <p style={{ fontSize: 11, color: "var(--text-tertiary)", margin: "4px 0 0", lineHeight: 1.4 }}>
            Measures loudness (LUFS) and normalizes all songs to -14 LUFS broadcast standard.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={handleResetAll}
            style={{ padding: "6px 14px", borderRadius: 8, fontSize: 11, fontWeight: 600, background: "var(--bg-tertiary)", color: "var(--text-tertiary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}
          >Reset All</button>
          <button
            onClick={handleProcessAll}
            disabled={processing}
            style={{ padding: "6px 14px", borderRadius: 8, fontSize: 11, fontWeight: 700, background: processing ? "var(--bg-tertiary)" : "var(--accent-blue)", color: processing ? "var(--text-tertiary)" : "#fff", border: "none", cursor: processing ? "default" : "pointer", opacity: processing ? 0.6 : 1 }}
          >{processing ? "Processing..." : "Analyze All"}</button>
        </div>
      </div>

      {/* Progress */}
      {progress && (
        <div style={{ padding: "10px 14px", background: "rgba(56,189,248,0.08)", border: "1px solid rgba(56,189,248,0.2)", borderRadius: 10, fontSize: 12, color: "var(--accent-blue)" }}>
          {progress}
          {total > 0 && (
            <div style={{ width: "100%", height: 3, background: "rgba(56,189,248,0.15)", borderRadius: 2, marginTop: 8, overflow: "hidden" }}>
              <div style={{ width: (done / total * 100) + "%", height: "100%", background: "var(--accent-blue)", borderRadius: 2, transition: "width 0.3s ease" }} />
            </div>
          )}
        </div>
      )}

      {/* Stats grid */}
      {stats && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
          {[
            { label: "Analyzed", value: stats.processed + "/" + stats.total, color: "var(--text-primary)" },
            { label: "Avg LUFS", value: stats.avgLufs || "—", color: "var(--text-primary)" },
            { label: "Target LUFS", value: "-14", color: "var(--accent-green)" },
            { label: "Pending", value: stats.unprocessed, color: stats.unprocessed > 0 ? "var(--accent-amber)" : "var(--accent-green)" },
          ].map(s => (
            <div key={s.label} style={{ background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", borderRadius: 10, padding: "12px 14px", textAlign: "center" as any }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: s.color, fontFamily: "'DM Mono', monospace", letterSpacing: "-0.03em" }}>{s.value}</div>
              <div style={{ fontSize: 9, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.1em", marginTop: 4 }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Loudest/quietest */}
      {stats?.loudest && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div style={{ background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", borderRadius: 10, padding: "10px 14px", fontSize: 12 }}>
            <span style={{ color: "var(--text-tertiary)" }}>Loudest: </span>
            <span style={{ color: "var(--accent-red)", fontWeight: 500 }}>{stats.loudest}</span>
          </div>
          <div style={{ background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", borderRadius: 10, padding: "10px 14px", fontSize: 12 }}>
            <span style={{ color: "var(--text-tertiary)" }}>Quietest: </span>
            <span style={{ color: "var(--accent-blue)", fontWeight: 500 }}>{stats.quietest}</span>
          </div>
        </div>
      )}

      {/* Songs table */}
      {songs.length > 0 && (
        <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 12, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-primary)" }}>
                {["Title", "Artist", "LUFS", "Peak", "Gain", "Status"].map(h => (
                  <th key={h} style={{ padding: "8px 12px", textAlign: "left" as any, fontSize: 9, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.1em" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {songs.map((s, i) => (
                <tr key={s.id} style={{ borderBottom: i < songs.length - 1 ? "1px solid var(--border-primary)" : "none" }}
                  onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-hover)")}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                >
                  <td style={{ padding: "8px 12px", color: "var(--text-primary)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>{s.title}</td>
                  <td style={{ padding: "8px 12px", color: "var(--text-secondary)" }}>{s.artist_name || ""}</td>
                  <td style={{ padding: "8px 12px" }}>{lufsBar(s.lufs_measured)}</td>
                  <td style={{ padding: "8px 12px", color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace", fontSize: 10 }}>{s.peak_db !== null ? s.peak_db + " dB" : "—"}</td>
                  <td style={{ padding: "8px 12px", fontFamily: "'DM Mono', monospace", fontSize: 10 }}>
                    <span style={{ color: s.gain_db > 0 ? "var(--accent-green)" : s.gain_db < -3 ? "var(--accent-red)" : "var(--text-tertiary)" }}>
                      {s.gain_db > 0 ? "+" : ""}{s.gain_db} dB
                    </span>
                  </td>
                  <td style={{ padding: "8px 12px" }}>
                    <span style={{ fontSize: 10, fontWeight: 600, color: s.lufs_measured !== null ? "var(--accent-green)" : "var(--text-tertiary)" }}>
                      {s.lufs_measured !== null ? "Done" : "Pending"}
                    </span>
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
