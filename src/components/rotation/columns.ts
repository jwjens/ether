// ── Rotation Analytics column definitions (v2 Phase 3, 2026-08-10) ───────────────────────────────
//
// One declaration per table, read by BOTH the grid and the CSV exporter. Previously the screen was
// in RotationAnalytics.tsx and the file was in electron/rotation-analytics.js — two hand-maintained
// lists that had already drifted apart in wording and, for turnover, in column order.
//
// The `csv*` fields are not cosmetic. They are transcribed from the shipped exporter, and
// csv.test.ts asserts byte-equality against it for all four kinds. If you change a `csvHeader` or a
// `csv` here, that test fails — by design. It is guarding files operators have already archived.
//
// docs/schedule-manager-v2-design-2026-08-10.md §4.1
import type { GridColumn } from "../grid/csv";

// The engine returns untyped rows (electron/rotation-analytics.js). Shapes are named here rather
// than spread as `any` through the grid.
export interface SpinRow {
  categoryId: number | null; category: string; hasTarget: boolean; target: number;
  actualPerHour: number; deltaPerHour: number; spins: number; distinctSongs: number; sharePct: number;
}
export interface BurnRow {
  artist: string; spins: number; tightestGapMin: number | null;
  separationRuleMin: number; violatesRule: boolean;
}
export interface TurnoverRow {
  categoryId: number; category: string; librarySize: number; songsUsed: number;
  coveragePct: number; driftSongs: number; spins: number; spinsPerSong: number;
}
export interface HourlyRow { hour: string; category: string; spins: number }

// ── Spins vs target ──────────────────────────────────────────────────────────────────────────────
// Screen and file agree on order; they differ on two headers and two values.
export const SPINS_COLUMNS: GridColumn<SpinRow>[] = [
  { id: "category", header: "Category", accessor: r => r.category, width: 200, sortType: "alpha" },
  {
    id: "target", header: "Target/hr", accessor: r => r.target, mono: true, align: "right", width: 90, sortType: "numeric",
    // Screen says "—" (not declaring a goal is a choice); the file says "(none)" so a spreadsheet
    // does not read an em-dash as data.
    cell: r => (r.hasTarget ? r.target : "—"),
    csv: r => (r.hasTarget ? r.target : "(none)"),
  },
  { id: "actualPerHour", header: "Actual/hr", accessor: r => r.actualPerHour, mono: true, align: "right", width: 90, sortType: "numeric" },
  {
    id: "deltaPerHour", header: "Δ/hr", csvHeader: "Delta/hr", accessor: r => r.deltaPerHour,
    mono: true, align: "right", width: 80, sortType: "numeric",
    cell: r => (r.hasTarget ? (r.deltaPerHour > 0 ? "+" : "") + r.deltaPerHour : "—"),
    // `?? ""` mirrors the shipped exporter exactly: a null delta becomes empty, and a delta of 0
    // stays "0". A `||` here would turn 0 into blank — a category exactly on target would read as
    // missing data.
    csv: r => r.deltaPerHour ?? "",
  },
  { id: "spins", header: "Spins", accessor: r => r.spins, mono: true, align: "right", width: 70, sortType: "numeric" },
  { id: "distinctSongs", header: "Distinct songs", accessor: r => r.distinctSongs, mono: true, align: "right", width: 110, sortType: "numeric" },
  {
    id: "sharePct", header: "Share", csvHeader: "Share %", accessor: r => r.sharePct,
    mono: true, align: "right", width: 80, sortType: "numeric",
    cell: r => r.sharePct + "%",   // the file keeps the bare number so it can be summed
  },
];

// ── Artist burn ──────────────────────────────────────────────────────────────────────────────────
export const BURN_COLUMNS: GridColumn<BurnRow>[] = [
  { id: "artist", header: "Artist", accessor: r => r.artist, width: 260, sortType: "alpha" },
  { id: "spins", header: "Spins", accessor: r => r.spins, mono: true, align: "right", width: 70, sortType: "numeric" },
  {
    id: "tightestGapMin", header: "Tightest gap", csvHeader: "Tightest gap (min)",
    accessor: r => r.tightestGapMin, mono: true, align: "right", width: 110, sortType: "numeric",
    cell: r => (r.tightestGapMin == null ? "—" : r.tightestGapMin + " min"),
    csv: r => r.tightestGapMin ?? "",
  },
  {
    id: "separationRuleMin", header: "Rule", csvHeader: "Rule (min)", accessor: r => r.separationRuleMin,
    mono: true, align: "right", width: 90, sortType: "numeric",
    cell: r => r.separationRuleMin + " min",
  },
  {
    // On screen a red INSIDE RULE badge; in the file "YES" or empty. Same column, same position.
    id: "violatesRule", header: "", csvHeader: "Violates rule", accessor: r => r.violatesRule,
    width: 120, sortType: "numeric",
    csv: r => (r.violatesRule ? "YES" : ""),
  },
];

// ── Turnover ─────────────────────────────────────────────────────────────────────────────────────
// The one table where screen order and file order genuinely differ: off-category is fifth in the
// file and last on screen. csvOrder carries that, so neither had to be bent to match the other.
export const TURNOVER_COLUMNS: GridColumn<TurnoverRow>[] = [
  { id: "category", header: "Category", accessor: r => r.category, width: 200, sortType: "alpha" },
  { id: "librarySize", header: "Library", csvHeader: "Library size", accessor: r => r.librarySize, mono: true, align: "right", width: 90, sortType: "numeric" },
  { id: "songsUsed", header: "Used", csvHeader: "Songs used", accessor: r => r.songsUsed, mono: true, align: "right", width: 80, sortType: "numeric" },
  {
    id: "coveragePct", header: "Coverage", csvHeader: "Coverage %", accessor: r => r.coveragePct,
    mono: true, align: "right", width: 100, sortType: "numeric",
    cell: r => r.coveragePct + "%",
  },
  { id: "spins", header: "Spins", accessor: r => r.spins, mono: true, align: "right", width: 70, sortType: "numeric" },
  { id: "spinsPerSong", header: "Spins/song", csvHeader: "Spins per song", accessor: r => r.spinsPerSong, mono: true, align: "right", width: 100, sortType: "numeric" },
  {
    id: "driftSongs", header: "", csvHeader: "Off-category (stale)", accessor: r => r.driftSongs,
    csvOrder: 4, width: 150, sortType: "numeric",
  },
];

// ── Hourly grid ──────────────────────────────────────────────────────────────────────────────────
// EXPORT-ONLY, and that is pre-existing: the panel has always fetched `hourly`, always offered
// "Hourly grid CSV", and has never rendered a table for it. Declared here so the export runs
// through the same one implementation as the rest. Rendering it is an OPEN ITEM, not a silent
// addition — an export with no on-screen counterpart is a door that only opens outward.
export const HOURLY_COLUMNS: GridColumn<HourlyRow>[] = [
  { id: "hour", header: "Hour", accessor: r => r.hour, width: 120, sortType: "alpha" },
  { id: "category", header: "Category", accessor: r => r.category, width: 200, sortType: "alpha" },
  { id: "spins", header: "Spins", accessor: r => r.spins, mono: true, align: "right", width: 70, sortType: "numeric" },
];
