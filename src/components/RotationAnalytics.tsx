// ── ROTATION ANALYTICS (Phase 4, 2026-08-10 · DataGrid conversion v2 Phase 3, 2026-08-10) ────────
// Read-only rotation reporting: spins vs target, artist burn, turnover, and why each row was picked.
// Changes nothing about what airs — every backing handler is a SELECT.
// Engine: electron/rotation-analytics.js · docs/help-rotation-analytics.md
//
// PHASE 3: the three tables are now DataGrid — sortable, resizable, widths remembered per station.
// Two things were deliberately held still while the surface changed:
//
//   1. NO DEFAULT SORT. The grids render in the engine's order (turnover by coverage ascending, and
//      so on), exactly as before. Imposing a "nicer" default would have changed the first thing a
//      PD reads, which is not what a reskin is allowed to do.
//   2. THE CSV IS BYTE-IDENTICAL. Export now runs from the column definitions (src/components/
//      rotation/columns.ts) instead of a second hand-maintained list in main, and
//      src/components/grid/csv.test.ts asserts equality against the shipped exporter for all four
//      kinds. electron/rotation-analytics.js keeps its toCsv: it is the counterparty that test
//      compares against, so removing it would remove the gate.
//
// One behaviour did change, in the operator's favour: the file is now built from the snapshot ON
// SCREEN, where it used to re-query with a fresh `to` timestamp at click time and could return a
// slightly different window than the one being read.
import { useEffect, useState } from "react";
import { useActiveStation } from "../hooks/useActiveStation";
import { DataGrid } from "./grid/DataGrid";
import { type GridColumn } from "./grid/csv";
import {
  SPINS_COLUMNS, BURN_COLUMNS, TURNOVER_COLUMNS, HOURLY_COLUMNS,
  type SpinRow, type BurnRow, type TurnoverRow, type HourlyRow,
} from "./rotation/columns";

type Range = "24h" | "7d" | "30d";
const RANGE_SEC: Record<Range, number> = { "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400 };

/** The burn table has always shown the top 25 while exporting all of them. */
const BURN_VISIBLE = 25;

interface Snapshot {
  spins: SpinRow[]; hourly: any[]; burn: BurnRow[]; turnover: TurnoverRow[];
  reasonCoverage: { total: number; withReason: number; pct: number; columnPresent: boolean };
  fromTs: number; toTs: number;
}

const card: React.CSSProperties = { background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0 };

/** Colour lives here, not in the column definitions: those stay pure so the CSV gate can import
 *  them without React. This overlays cell renderers onto the shared definitions by id. */
function styled<T>(cols: GridColumn<T>[], cells: Record<string, (row: T) => React.ReactNode>): GridColumn<T>[] {
  return cols.map(c => (cells[c.id] ? { ...c, cell: cells[c.id] } : c));
}

const badge = (text: string, colour: string, bg: string, title?: string) => (
  <span title={title} style={{ fontSize: "var(--t-micro)", fontWeight: 700, padding: "2px 8px", background: bg, color: colour }}>{text}</span>
);

function Section({ title, sub, children }: { title: string; sub?: string; children: any }) {
  return (
    <div style={{ ...card, overflow: "hidden" }}>
      <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border-primary)", background: "var(--bg-tertiary)" }}>
        <div style={{ fontSize: "var(--t-lead)", fontWeight: 700, color: "var(--text-primary)", fontFamily: "'Newsreader', Georgia, serif" }}>{title}</div>
        {sub && <div style={{ fontSize: "var(--t-small)", color: "var(--text-tertiary)", marginTop: 2 }}>{sub}</div>}
      </div>
      {children}
    </div>
  );
}

export interface RotationAnalyticsProps {
  /** Hosted in the docking workspace, where the pane tab already names it. */
  hideHeader?: boolean;
}

export default function RotationAnalytics({ hideHeader }: RotationAnalyticsProps = {}) {
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

  const csvName = (kind: string) => `ether-rotation-${kind}-${range}-${new Date().toISOString().slice(0, 10)}.csv`;

  const rangeBtn = (id: Range, label: string) => (
    <button key={id} onClick={() => setRange(id)} style={{
      padding: "6px 14px", borderRadius: 0, fontSize: "var(--t-small)", fontWeight: 700, cursor: "pointer",
      background: range === id ? "var(--accent-purple)" : "var(--bg-secondary)",
      color: range === id ? "#fff" : "var(--text-tertiary)",
      border: range === id ? "none" : "1px solid var(--border-primary)",
    }}>{label}</button>
  );

  // ── cell rendering: the same emphasis the panel has always carried ─────────────────────────────
  const spinsCols = styled<SpinRow>(SPINS_COLUMNS, {
    category: r => <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>{r.category}</span>,
    target: r => (r.hasTarget ? r.target : "—"),
    deltaPerHour: r => {
      const off = r.hasTarget && Math.abs(r.deltaPerHour) >= 1;
      return <span style={{ color: !r.hasTarget ? "var(--text-tertiary)" : off ? "var(--accent-amber)" : "var(--accent-green)" }}>
        {r.hasTarget ? (r.deltaPerHour > 0 ? "+" : "") + r.deltaPerHour : "—"}
      </span>;
    },
    sharePct: r => <span style={{ color: r.sharePct >= 50 ? "var(--accent-amber)" : "var(--text-tertiary)" }}>{r.sharePct}%</span>,
  });

  const burnCols = styled<BurnRow>(BURN_COLUMNS, {
    artist: r => <span style={{ color: "var(--text-primary)" }}>{r.artist}</span>,
    tightestGapMin: r => <span style={{ color: r.violatesRule ? "var(--accent-red)" : "var(--text-tertiary)" }}>
      {r.tightestGapMin == null ? "—" : r.tightestGapMin + " min"}
    </span>,
    separationRuleMin: r => <span style={{ color: "var(--text-tertiary)" }}>{r.separationRuleMin} min</span>,
    violatesRule: r => (r.violatesRule ? badge("INSIDE RULE", "var(--accent-red)", "rgba(248,113,113,0.12)") : null),
  });

  const turnoverCols = styled<TurnoverRow>(TURNOVER_COLUMNS, {
    category: r => <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>{r.category}</span>,
    coveragePct: r => <span style={{ color: r.spins === 0 ? "var(--text-tertiary)" : r.coveragePct < 50 ? "var(--accent-amber)" : "var(--accent-green)" }}>{r.coveragePct}%</span>,
    spinsPerSong: r => <span style={{ color: r.spinsPerSong >= 4 ? "var(--accent-amber)" : "var(--text-tertiary)" }}>{r.spinsPerSong}</span>,
    driftSongs: r => (r.driftSongs > 0
      ? badge(`${r.driftSongs} OFF-CATEGORY`, "var(--accent-amber)", "rgba(251,191,36,0.12)",
              "Songs in the log that are no longer in this category — re-filed, deleted or rotation-disabled since it was generated")
      : null),
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, fontFamily: "'Inter', system-ui, sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: hideHeader ? "flex-end" : "space-between", flexWrap: "wrap", gap: 10 }}>
        {!hideHeader && <h1 style={{ fontSize: "var(--t-head)", fontWeight: 800, letterSpacing: "-0.04em", color: "var(--text-primary)", margin: 0, fontFamily: "'Newsreader', Georgia, serif" }}>Rotation Analytics</h1>}
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {rangeBtn("24h", "24 Hours")}{rangeBtn("7d", "7 Days")}{rangeBtn("30d", "30 Days")}
          <button onClick={load} disabled={busy} style={{ padding: "6px 12px", borderRadius: 0, fontSize: "var(--t-small)", fontWeight: 600, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: busy ? "wait" : "pointer" }}>{busy ? "…" : "Refresh"}</button>
        </div>
      </div>

      {err && <div style={{ ...card, padding: "12px 14px", borderColor: "var(--accent-red)", fontSize: "var(--t-body)", color: "var(--accent-red)" }}>{err}</div>}

      {snap && (
        <div style={{ fontSize: "var(--t-small)", color: "var(--text-tertiary)" }}>
          {new Date(snap.fromTs * 1000).toLocaleString()} → {new Date(snap.toTs * 1000).toLocaleString()} · read-only, nothing here changes what airs
        </div>
      )}

      {/* ── SPINS vs TARGET ─────────────────────────────────────────────────────────────────────── */}
      {snap && (
        <Section title="Spins per hour — actual vs target"
          sub="A category with no spins/hr target shows “—”. Not declaring a goal is a choice, not a miss.">
          <DataGrid<SpinRow>
            columns={spinsCols} rows={snap.spins}
            getRowId={(r, i) => String(r.categoryId ?? r.category ?? i)}
            persistKey="rotation_spins" stationId={stationId}
            empty="No music aired in this window."
            csv={{ filename: csvName("spins") }}
          />
        </Section>
      )}

      {/* ── HOURLY GRID ─────────────────────────────────────────────────────────────────────────── */}
      {/* This data has ALWAYS been fetched and ALWAYS been exportable ("Hourly grid CSV"), and until
          now was never displayed — an export with no on-screen counterpart, which is a door that only
          opens outward. It is at most 24 hours × categories, so there was never a size reason for the
          gap. The export moved here, onto the table it describes. */}
      {snap && (
        <Section title="Hourly grid"
          sub="Spins per category per hour, summed across the window. Sort by Spins to see which hour a category owns.">
          <DataGrid<HourlyRow>
            columns={HOURLY_COLUMNS} rows={snap.hourly}
            getRowId={(r, i) => `${r.hour}-${r.category}-${i}`}
            persistKey="rotation_hourly" stationId={stationId}
            empty="No music aired in this window."
            csv={{ filename: csvName("hourly") }}
          />
        </Section>
      )}

      {/* ── ARTIST BURN ─────────────────────────────────────────────────────────────────────────── */}
      {snap && (
        <Section title="Artist burn"
          sub="Tightest gap is the closest two airings of that artist. Compared against this station’s own artist-separation rule, not an invented threshold.">
          <DataGrid<BurnRow>
            columns={burnCols} rows={snap.burn.slice(0, BURN_VISIBLE)}
            getRowId={r => r.artist}
            persistKey="rotation_burn" stationId={stationId}
            empty="No artist aired more than once in this window."
            rowStyle={r => (r.violatesRule ? { background: "rgba(248,113,113,0.04)" } : {})}
            // The file gets every artist, not the 25 on screen — the pre-conversion behaviour, and
            // the reason csv.rows exists at all.
            csv={{ filename: csvName("burn"), rows: snap.burn }}
            footer={snap.burn.length > BURN_VISIBLE
              ? <span style={{ fontSize: "var(--t-small)", color: "var(--text-tertiary)" }}>
                  Showing the {BURN_VISIBLE} most-played of {snap.burn.length} artists · the export has all {snap.burn.length}
                </span>
              : undefined}
          />
        </Section>
      )}

      {/* ── TURNOVER ────────────────────────────────────────────────────────────────────────────── */}
      {snap && (
        <Section title="Turnover"
          sub="Coverage = share of the eligible library that actually aired. Spins/song near 1.0 is even rotation; high means a few songs are carrying the category.">
          <DataGrid<TurnoverRow>
            columns={turnoverCols} rows={snap.turnover}
            getRowId={r => String(r.categoryId)}
            persistKey="rotation_turnover" stationId={stationId}
            empty="No categories aired in this window."
            csv={{ filename: csvName("turnover") }}
          />
        </Section>
      )}

      {/* ── EXPLAINABILITY ──────────────────────────────────────────────────────────────────────── */}
      {snap && (
        <Section title="Why was this picked?"
          sub="Reasons are written as the log is generated. They cannot be reconstructed afterwards — the vetoed and losing candidates only exist during the pick.">
          <div style={{ padding: "14px" }}>
            {snap.reasonCoverage.total === 0 ? (
              <div style={{ fontSize: "var(--t-body)", color: "var(--text-tertiary)" }}>No music rows in this window.</div>
            ) : snap.reasonCoverage.withReason === 0 ? (
              <div style={{ fontSize: "var(--t-body)", color: "var(--text-secondary)", lineHeight: 1.6 }}>
                <strong style={{ color: "var(--accent-amber)" }}>0 of {snap.reasonCoverage.total} rows carry a reason.</strong><br />
                {snap.reasonCoverage.columnPresent
                  ? "These rows were generated before pick_reason existed. Run Generate again and new rows will record why each song was chosen — the existing ones cannot be explained retroactively."
                  : "This database has not picked up the pick_reason column yet. Fully close and reopen Ether, then run Generate."}
              </div>
            ) : (
              <div style={{ fontSize: "var(--t-body)", color: "var(--text-secondary)" }}>
                <strong style={{ color: "var(--accent-green)" }}>{snap.reasonCoverage.withReason} of {snap.reasonCoverage.total}</strong> rows ({snap.reasonCoverage.pct}%) carry a recorded reason.
                <div style={{ marginTop: 6, color: "var(--text-tertiary)" }}>Open the Calendar and click a scheduled row to see its explanation.</div>
              </div>
            )}
          </div>
        </Section>
      )}

      {!snap && !err && <div style={{ ...card, padding: "48px", textAlign: "center", color: "var(--text-tertiary)", fontSize: "var(--t-lead)" }}>Loading rotation data…</div>}
    </div>
  );
}
