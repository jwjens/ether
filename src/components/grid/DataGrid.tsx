// ── DataGrid — the shared table (v2 Phase 3, 2026-08-10) ─────────────────────────────────────────
//
// TanStack Table v8, headless, wearing our tokens. 16 components render their own <table>; each
// re-implements headers, alignment and empty states, and none can sort or resize. This replaces
// them one at a time — Rotation Analytics first, Traffic in Phase 4, the rest opportunistically.
// No big-bang migration.
//
// WHAT IT OWNS: sorting (click, shift-click for secondary), operator-resizable columns persisted per
// grid per station, dense token-driven rows, CSV from the column definitions, and a required empty
// state — no grid can ship a blank rectangle.
//
// WHAT IT DOES NOT OWN: the data. It never fetches, never writes, never sorts server-side.
//
// VIRTUALISATION IS DEFERRED, deliberately. Every row is in the DOM. At Rotation Analytics' scale
// (~400 rows/day, and the burn table shows 25) that is comfortably fine, and react-window is another
// dependency in a renderer bundle already warned about on every build. REVISIT AT ~2,000 ROWS in one
// grid — that is the point where scroll jank becomes visible and the dependency earns its place.
// Traffic over a long window is the likeliest first caller to cross it.
//
// docs/schedule-manager-v2-design-2026-08-10.md §4.1
import { useEffect, useMemo, useRef, useState } from "react";
import {
  useReactTable, getCoreRowModel, getSortedRowModel, flexRender,
  type ColumnDef, type SortingState, type ColumnSizingState,
} from "@tanstack/react-table";
import type { GridColumn } from "./csv";
import { toCsv, downloadCsv } from "./csv";

export interface DataGridProps<T> {
  columns: GridColumn<T>[];
  rows: T[];
  /** REQUIRED. Shown when there are no rows — say what is absent and why, never a bare rectangle. */
  empty: React.ReactNode;
  /** Stable row identity. Falls back to the index, which is fine for read-only reporting grids. */
  getRowId?: (row: T, index: number) => string;
  /** Per-row emphasis, e.g. a violation. */
  rowStyle?: (row: T) => React.CSSProperties;
  /** Default sort. Matches each panel's pre-conversion order — see the Phase 3 gate. */
  initialSort?: SortingState;
  /** Column widths persist under this id, per station, on this machine only. Omit to not persist. */
  persistKey?: string;
  stationId?: number | null;
  /** Renders an Export CSV button in the footer. `rows` defaults to the displayed rows — pass the
   *  full set when the grid shows a capped view, or the file will be truncated too. */
  csv?: { filename: string; label?: string; rows?: T[] };
  /** Extra footer controls, e.g. a second export. */
  footer?: React.ReactNode;
}

const WIDTH_PREFIX = "grid_widths_";

export function DataGrid<T>({
  columns, rows, empty, getRowId, rowStyle, initialSort, persistKey, stationId, csv, footer,
}: DataGridProps<T>) {
  const [sorting, setSorting] = useState<SortingState>(initialSort ?? []);
  const [sizing, setSizing] = useState<ColumnSizingState>({});
  const [sizingLoaded, setSizingLoaded] = useState(!persistKey);

  // ── widths: load ───────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    let stop = false;
    (async () => {
      if (!persistKey || !stationId) { setSizingLoaded(true); return; }
      try {
        const raw = await (window as any).ether?.invoke?.("station_config_kv:get-value", stationId, WIDTH_PREFIX + persistKey);
        const parsed = raw ? JSON.parse(raw) : null;
        // A stored width set names columns. Ones that no longer exist are ignored by TanStack, and
        // new columns simply take their declared default — so a column change degrades quietly.
        if (!stop && parsed && typeof parsed === "object") setSizing(parsed);
      } catch { /* a lost width is cosmetic */ }
      if (!stop) setSizingLoaded(true);
    })();
    return () => { stop = true; };
  }, [persistKey, stationId]);

  // ── widths: save (debounced; dragging a divider fires continuously) ────────────────────────────
  const saveTimer = useRef<any>(null);
  useEffect(() => {
    if (!persistKey || !stationId || !sizingLoaded || Object.keys(sizing).length === 0) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      // set-local: how wide YOUR columns are is per-machine ergonomics. Syncing it would reach
      // across and rearrange a colleague's screen — the same rule the pane layout follows.
      try { (window as any).ether?.invoke?.("station_config_kv:set-local", stationId, WIDTH_PREFIX + persistKey, JSON.stringify(sizing)); } catch {}
    }, 600);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [sizing, persistKey, stationId, sizingLoaded]);

  const tanColumns = useMemo<ColumnDef<T, any>[]>(() => columns.map(c => ({
    id: c.id,
    // null → undefined for the TABLE ONLY, so `sortUndefined: "last"` can keep "no value" at the
    // bottom in both directions. The CSV path reads GridColumn.accessor directly and still sees the
    // real null, which is what the byte contract expects.
    accessorFn: (row: T) => { const v = c.accessor(row); return v === null ? undefined : v; },
    header: c.header,
    cell: info => (c.cell ? c.cell(info.row.original) : (info.getValue() as React.ReactNode)),
    enableSorting: true,
    sortUndefined: "last",
    sortingFn: c.sortType === "numeric" ? "basic" : "alphanumeric",
    size: c.width ?? 120,
    minSize: c.minWidth ?? 48,
  })), [columns]);

  const table = useReactTable({
    data: rows,
    columns: tanColumns,
    state: { sorting, columnSizing: sizing },
    onSortingChange: setSorting,
    onColumnSizingChange: setSizing,
    columnResizeMode: "onChange",
    enableColumnResizing: true,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: getRowId ? (row, i) => getRowId(row, i) : undefined,
  });

  const byId = useMemo(() => new Map(columns.map(c => [c.id, c])), [columns]);

  const th: React.CSSProperties = {
    position: "relative", padding: "var(--s-3) var(--s-4)", textAlign: "left",
    fontSize: "var(--t-micro)", fontWeight: 700, color: "var(--text-tertiary)",
    textTransform: "uppercase", letterSpacing: "0.1em", whiteSpace: "nowrap",
    userSelect: "none", cursor: "pointer",
  };
  const td: React.CSSProperties = {
    padding: "var(--s-2) var(--s-4)", fontSize: "var(--t-small)",
    color: "var(--text-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
  };

  const exportCsv = () => {
    if (!csv) return;
    downloadCsv(csv.filename, toCsv(columns, csv.rows ?? rows));
  };

  return (
    <div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
          <thead>
            {table.getHeaderGroups().map(hg => (
              <tr key={hg.id} style={{ background: "var(--bg-tertiary)" }}>
                {hg.headers.map(h => {
                  const col = byId.get(h.column.id);
                  const dir = h.column.getIsSorted();
                  const idx = h.column.getSortIndex();
                  return (
                    <th key={h.id} style={{ ...th, width: h.getSize(), textAlign: col?.align === "right" ? "right" : "left" }}
                      onClick={h.column.getToggleSortingHandler()}
                      title="Click to sort · Shift-click to add a secondary sort · drag the edge to resize">
                      {flexRender(h.column.columnDef.header, h.getContext())}
                      {/* Sort marks are text, not icons: they survive any theme and read at 9px. */}
                      {dir && <span style={{ marginLeft: "var(--s-2)", color: "var(--accent-purple)", fontFamily: "'DM Mono', monospace" }}>
                        {dir === "desc" ? "▼" : "▲"}{table.getState().sorting.length > 1 ? String(idx + 1) : ""}
                      </span>}
                      {/* Resize grip. onClick stops the drag from also toggling the sort. */}
                      <span
                        onMouseDown={h.getResizeHandler()}
                        onTouchStart={h.getResizeHandler()}
                        onClick={e => e.stopPropagation()}
                        style={{
                          position: "absolute", right: 0, top: 0, height: "100%", width: 5,
                          cursor: "col-resize", userSelect: "none", touchAction: "none",
                          background: h.column.getIsResizing() ? "var(--accent-purple)" : "transparent",
                        }} />
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map(r => (
              <tr key={r.id} style={{ borderTop: "1px solid var(--border-primary)", ...(rowStyle ? rowStyle(r.original) : {}) }}>
                {r.getVisibleCells().map(c => {
                  const col = byId.get(c.column.id);
                  return (
                    <td key={c.id} style={{
                      ...td,
                      width: c.column.getSize(),
                      textAlign: col?.align === "right" ? "right" : "left",
                      ...(col?.mono ? { fontFamily: "'DM Mono', monospace" } : {}),
                    }}>
                      {flexRender(c.column.columnDef.cell, c.getContext())}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.length === 0 && (
        <div style={{ padding: "var(--s-6) var(--s-5)", fontSize: "var(--t-small)", color: "var(--text-tertiary)", textAlign: "center" }}>
          {empty}
        </div>
      )}

      {(csv || footer) && (
        <div style={{ padding: "var(--s-4) var(--s-5)", borderTop: "1px solid var(--border-primary)", display: "flex", gap: "var(--s-3)", alignItems: "center" }}>
          {csv && (
            <button onClick={exportCsv} style={{
              padding: "var(--s-2) var(--s-5)", borderRadius: "var(--r-0)", fontSize: "var(--t-small)", fontWeight: 600,
              background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer",
            }}>{csv.label ?? "Export CSV"}</button>
          )}
          {footer}
        </div>
      )}
    </div>
  );
}

export default DataGrid;
