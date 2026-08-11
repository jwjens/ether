// ── Column definitions and CSV export (v2 Phase 3, 2026-08-10) ───────────────────────────────────
//
// One CSV implementation, driven by the column definitions, replacing per-panel exporters.
// Pure — no React, no TanStack, no window — so the byte-for-byte gate can be a unit test.
//
// WHY A COLUMN CARRIES TWO IDENTITIES
//
// The obvious design is "export what's on screen". It fails immediately against the exports we
// already ship, and the byte-for-byte gate is what proved it:
//
//   screen: Δ/hr     "+3"      "—"        "12 min"    a red INSIDE RULE badge
//   file:   Delta/hr "3"       "(none)"   "12"        YES
//
// The screen is for reading; the file is for a spreadsheet, where "+3" is text and "12 min" cannot
// be summed. They are genuinely different renderings of one value, so a column declares `cell` for
// the screen and `csv` for the file, and `csvHeader` when the wording differs. Where they agree —
// most columns — `accessor` serves both and nothing is repeated.
//
// `csvOrder` exists because Rotation Analytics' turnover export puts off-category fifth while the
// screen puts it last. Column ORDER, not just wording, can differ between the two.
//
// docs/schedule-manager-v2-design-2026-08-10.md §4.1
import type { ReactNode } from "react";

export interface GridColumn<T> {
  id: string;
  /** Header on screen. */
  header: string;
  /** The underlying value: the sort key, and the CSV value unless `csv` overrides it. */
  accessor: (row: T) => any;
  /** Screen rendering. Defaults to the accessor's value. */
  cell?: (row: T) => ReactNode;
  /** Header in the file, when it differs from the screen's. */
  csvHeader?: string;
  /** Value in the file, when it differs from the accessor's. */
  csv?: (row: T) => any;
  /** Screen-only (a badge with no cell of its own). Never in the file. */
  csvExclude?: boolean;
  /** This column's FINAL position (0-based) in the file, when it differs from its screen position.
   *  Unset columns keep screen order and flow around the placed ones. */
  csvOrder?: number;
  align?: "left" | "right";
  /** Tabular figures — numbers that must line up. */
  mono?: boolean;
  /** Starting width in px, before any operator resize. */
  width?: number;
  minWidth?: number;
  /** Sort as text or as a number. Numeric sorting puts null/undefined last, always. */
  sortType?: "alpha" | "numeric";
}

// ── the byte contract ────────────────────────────────────────────────────────────────────────────
// Replicates electron/rotation-analytics.js exactly, and is TESTED against it (csv.test.ts):
//   · every DATA cell quoted, embedded " doubled
//   · the HEADER row unquoted — asymmetric, but it is what ships, and a "fix" here is a silent
//     change to every file an operator has ever archived
//   · rows joined with \n, no trailing newline, no BOM
// Excel opens this correctly. Do not "improve" it without a reason that outweighs breaking
// byte-compatibility with every previously exported file.
const csvCell = (v: any) => '"' + String(v ?? "").replace(/"/g, '""') + '"';

/**
 * The file's column order: screen order, with `csvOrder` columns moved to that exact final position.
 * Screen-only columns are dropped first, so positions count columns that are actually in the file.
 *
 * Placement, not sorting. Sorting by `csvOrder ?? index` looks equivalent and is not: turnover's
 * off-category declares 4 while `spins` sits at implicit index 4, the tie resolved by array order,
 * and off-category came out SIXTH. The gate caught it on its first run. Positioning is unambiguous
 * where a shared sort key is not.
 */
export function csvColumns<T>(columns: GridColumn<T>[]): GridColumn<T>[] {
  const included = columns.filter(c => !c.csvExclude);
  const out = included.filter(c => c.csvOrder == null);
  for (const c of included.filter(c => c.csvOrder != null).sort((a, b) => a.csvOrder! - b.csvOrder!)) {
    out.splice(Math.min(c.csvOrder!, out.length), 0, c);
  }
  return out;
}

/**
 * CSV for `rows` under `columns`.
 *
 * Takes the rows explicitly rather than reading the grid's own, because the two are not always the
 * same set: Rotation Analytics shows the top 25 artists and exports all of them. Passing the
 * displayed rows would silently truncate the file — which is exactly what the byte-for-byte gate
 * caught on the first attempt.
 */
export function toCsv<T>(columns: GridColumn<T>[], rows: T[]): string {
  const cols = csvColumns(columns);
  const header = cols.map(c => c.csvHeader ?? c.header).join(",");
  const body = rows.map(r => cols.map(c => csvCell(c.csv ? c.csv(r) : c.accessor(r))).join(","));
  return [header, ...body].join("\n");
}

/** Save a CSV via the browser's download path. Renderer-only; the string comes from `toCsv`. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
