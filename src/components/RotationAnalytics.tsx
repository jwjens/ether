// ── ROTATION ANALYTICS (Phase 4, 2026-08-10) ─────────────────────────────────────────────────────
// Read-only rotation reporting: spins vs target, artist burn, turnover, and why each row was picked.
// Changes nothing about what airs — every backing handler is a SELECT.
// Engine: electron/rotation-analytics.js · docs/help-rotation-analytics.md
import { useEffect, useState } from "react";
import { useActiveStation } from "../hooks/useActiveStation";

type Range = "24h" | "7d" | "30d";
const RANGE_SEC: Record<Range, number> = { "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400 };

interface Snapshot {
  spins: any[]; hourly: any[]; burn: any[]; turnover: any[];
  reasonCoverage: { total: number; withReason: number; pct: number; columnPresent: boolean };
  fromTs: number; toTs: number;
}

const card: React.CSSProperties = { background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0 };
const th: React.CSSProperties = { padding: "8px 12px", textAlign: "left", fontSize: 9, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.1em", whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "8px 12px", fontSize: 12, color: "var(--text-secondary)", whiteSpace: "nowrap" };
const mono: React.CSSProperties = { ...td, fontFamily: "'DM Mono', monospace", fontSize: 11 };

function Section({ title, sub, children }: { title: string; sub?: string; children: any }) {
  return (
    <div style={{ ...card, overflow: "hidden" }}>
      <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border-primary)", background: "var(--bg-tertiary)" }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)", fontFamily: "'Newsreader', Georgia, serif" }}>{title}</div>
        {sub && <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>{sub}</div>}
      </div>
      <div style={{ overflowX: "auto" }}>{children}</div>
    </div>
  );
}

export default function RotationAnalytics() {
  const { stationId } = useActiveStation();
  const [range, setRange] = useState<Range>("24h");
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    if (!stationId) return;
    setBusy(true); setErr(null);
    try {
      const to = Math.floor(Date.now() / 1000);
      const r = await (window as any).ether?.invoke?.("rotation:analytics", stationId, to - RANGE_SEC[range], to);
      if (r?.ok) setSnap(r.data); else setErr(r?.error || "analytics unavailable");
    } catch (e: any) { setErr(e?.message || String(e)); }
    setBusy(false);
  };
  useEffect(() => { load(); }, [stationId, range]);

  const exportCsv = async (kind: string) => {
    try {
      const to = Math.floor(Date.now() / 1000);
      const r = await (window as any).ether?.invoke?.("rotation:csv", stationId, kind, to - RANGE_SEC[range], to);
      if (!r?.ok) return;
      const blob = new Blob([r.csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `ether-rotation-${kind}-${range}-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
      URL.revokeObjectURL(url);
    } catch {}
  };

  const rangeBtn = (id: Range, label: string) => (
    <button key={id} onClick={() => setRange(id)} style={{
      padding: "6px 14px", borderRadius: 0, fontSize: 11, fontWeight: 700, cursor: "pointer",
      background: range === id ? "var(--accent-purple)" : "var(--bg-secondary)",
      color: range === id ? "#fff" : "var(--text-tertiary)",
      border: range === id ? "none" : "1px solid var(--border-primary)",
    }}>{label}</button>
  );
  const csvBtn = (kind: string, label: string) => (
    <button onClick={() => exportCsv(kind)} style={{ padding: "4px 10px", borderRadius: 0, fontSize: 10, fontWeight: 600, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer" }}>{label}</button>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, fontFamily: "'Inter', system-ui, sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--text-primary)", margin: 0, fontFamily: "'Newsreader', Georgia, serif" }}>Rotation Analytics</h1>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {rangeBtn("24h", "24 Hours")}{rangeBtn("7d", "7 Days")}{rangeBtn("30d", "30 Days")}
          <button onClick={load} disabled={busy} style={{ padding: "6px 12px", borderRadius: 0, fontSize: 11, fontWeight: 600, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: busy ? "wait" : "pointer" }}>{busy ? "…" : "Refresh"}</button>
        </div>
      </div>

      {err && <div style={{ ...card, padding: "12px 14px", borderColor: "var(--accent-red)", fontSize: 12, color: "var(--accent-red)" }}>{err}</div>}

      {snap && (
        <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
          {new Date(snap.fromTs * 1000).toLocaleString()} → {new Date(snap.toTs * 1000).toLocaleString()} · read-only, nothing here changes what airs
        </div>
      )}

      {/* ── SPINS vs TARGET ─────────────────────────────────────────────────────────────────────── */}
      {snap && (
        <Section title="Spins per hour — actual vs target"
          sub="A category with no spins/hr target shows “—”. Not declaring a goal is a choice, not a miss.">
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr style={{ background: "var(--bg-tertiary)" }}>
              {["Category", "Target/hr", "Actual/hr", "Δ/hr", "Spins", "Distinct songs", "Share"].map(h => <th key={h} style={th}>{h}</th>)}
            </tr></thead>
            <tbody>
              {snap.spins.map((r: any) => {
                const off = r.hasTarget && Math.abs(r.deltaPerHour) >= 1;
                return (
                  <tr key={r.categoryId ?? r.category} style={{ borderTop: "1px solid var(--border-primary)" }}>
                    <td style={{ ...td, color: "var(--text-primary)", fontWeight: 500 }}>{r.category}</td>
                    <td style={mono}>{r.hasTarget ? r.target : "—"}</td>
                    <td style={mono}>{r.actualPerHour}</td>
                    <td style={{ ...mono, color: !r.hasTarget ? "var(--text-tertiary)" : off ? "var(--accent-amber)" : "var(--accent-green)" }}>
                      {r.hasTarget ? (r.deltaPerHour > 0 ? "+" : "") + r.deltaPerHour : "—"}
                    </td>
                    <td style={mono}>{r.spins}</td>
                    <td style={mono}>{r.distinctSongs}</td>
                    <td style={{ ...mono, color: r.sharePct >= 50 ? "var(--accent-amber)" : "var(--text-tertiary)" }}>{r.sharePct}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ padding: "8px 12px", borderTop: "1px solid var(--border-primary)", display: "flex", gap: 6 }}>
            {csvBtn("spins", "Export CSV")}{csvBtn("hourly", "Hourly grid CSV")}
          </div>
        </Section>
      )}

      {/* ── ARTIST BURN ─────────────────────────────────────────────────────────────────────────── */}
      {snap && (
        <Section title="Artist burn"
          sub="Tightest gap is the closest two airings of that artist. Compared against this station’s own artist-separation rule, not an invented threshold.">
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr style={{ background: "var(--bg-tertiary)" }}>
              {["Artist", "Spins", "Tightest gap", "Rule", ""].map(h => <th key={h} style={th}>{h}</th>)}
            </tr></thead>
            <tbody>
              {snap.burn.slice(0, 25).map((r: any) => (
                <tr key={r.artist} style={{ borderTop: "1px solid var(--border-primary)" }}>
                  <td style={{ ...td, color: "var(--text-primary)", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" }}>{r.artist}</td>
                  <td style={mono}>{r.spins}</td>
                  <td style={{ ...mono, color: r.violatesRule ? "var(--accent-red)" : "var(--text-tertiary)" }}>{r.tightestGapMin == null ? "—" : r.tightestGapMin + " min"}</td>
                  <td style={{ ...mono, color: "var(--text-tertiary)" }}>{r.separationRuleMin} min</td>
                  <td style={td}>{r.violatesRule && <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 8px", background: "rgba(248,113,113,0.12)", color: "var(--accent-red)" }}>INSIDE RULE</span>}</td>
                </tr>
              ))}
              {snap.burn.length === 0 && <tr><td style={td} colSpan={5}>No artist aired more than once in this window.</td></tr>}
            </tbody>
          </table>
          <div style={{ padding: "8px 12px", borderTop: "1px solid var(--border-primary)" }}>{csvBtn("burn", "Export CSV")}</div>
        </Section>
      )}

      {/* ── TURNOVER ────────────────────────────────────────────────────────────────────────────── */}
      {snap && (
        <Section title="Turnover"
          sub="Coverage = share of the eligible library that actually aired. Spins/song near 1.0 is even rotation; high means a few songs are carrying the category.">
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr style={{ background: "var(--bg-tertiary)" }}>
              {["Category", "Library", "Used", "Coverage", "Spins", "Spins/song", ""].map(h => <th key={h} style={th}>{h}</th>)}
            </tr></thead>
            <tbody>
              {snap.turnover.map((r: any) => (
                <tr key={r.categoryId} style={{ borderTop: "1px solid var(--border-primary)" }}>
                  <td style={{ ...td, color: "var(--text-primary)", fontWeight: 500 }}>{r.category}</td>
                  <td style={mono}>{r.librarySize}</td>
                  <td style={mono}>{r.songsUsed}</td>
                  <td style={{ ...mono, color: r.spins === 0 ? "var(--text-tertiary)" : r.coveragePct < 50 ? "var(--accent-amber)" : "var(--accent-green)" }}>{r.coveragePct}%</td>
                  <td style={mono}>{r.spins}</td>
                  <td style={{ ...mono, color: r.spinsPerSong >= 4 ? "var(--accent-amber)" : "var(--text-tertiary)" }}>{r.spinsPerSong}</td>
                  <td style={td}>{r.driftSongs > 0 && (
                    <span title="Songs in the log that are no longer in this category — re-filed, deleted or rotation-disabled since it was generated"
                      style={{ fontSize: 9, fontWeight: 700, padding: "2px 8px", background: "rgba(251,191,36,0.12)", color: "var(--accent-amber)" }}>
                      {r.driftSongs} OFF-CATEGORY
                    </span>)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ padding: "8px 12px", borderTop: "1px solid var(--border-primary)" }}>{csvBtn("turnover", "Export CSV")}</div>
        </Section>
      )}

      {/* ── EXPLAINABILITY ──────────────────────────────────────────────────────────────────────── */}
      {snap && (
        <Section title="Why was this picked?"
          sub="Reasons are written as the log is generated. They cannot be reconstructed afterwards — the vetoed and losing candidates only exist during the pick.">
          <div style={{ padding: "14px" }}>
            {snap.reasonCoverage.total === 0 ? (
              <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>No music rows in this window.</div>
            ) : snap.reasonCoverage.withReason === 0 ? (
              <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.6 }}>
                <strong style={{ color: "var(--accent-amber)" }}>0 of {snap.reasonCoverage.total} rows carry a reason.</strong><br />
                {snap.reasonCoverage.columnPresent
                  ? "These rows were generated before pick_reason existed. Run Generate again and new rows will record why each song was chosen — the existing ones cannot be explained retroactively."
                  : "This database has not picked up the pick_reason column yet. Fully close and reopen Ether, then run Generate."}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                <strong style={{ color: "var(--accent-green)" }}>{snap.reasonCoverage.withReason} of {snap.reasonCoverage.total}</strong> rows ({snap.reasonCoverage.pct}%) carry a recorded reason.
                <div style={{ marginTop: 6, color: "var(--text-tertiary)" }}>Open the Calendar and click a scheduled row to see its explanation.</div>
              </div>
            )}
          </div>
        </Section>
      )}

      {!snap && !err && <div style={{ ...card, padding: "48px", textAlign: "center", color: "var(--text-tertiary)", fontSize: 13 }}>Loading rotation data…</div>}
    </div>
  );
}
