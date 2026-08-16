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
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  useReactTable, getCoreRowModel, getSortedRowModel, flexRender,
  type ColumnDef, type SortingState, type ColumnSizingState,
} from "@tanstack/react-table";
import type { GridColumn } from "./csv";
import { toCsv, downloadCsv, screenColumns } from "./csv";

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

  // ── OPT-IN EXTENSIONS (2026-08-12, the day-log conversion) ──────────────────────────────────────
  // All three default OFF. Every existing caller — Rotation Analytics, and Traffic when it converts
  // in Phase 4 — renders byte-identically without them. The day log needed capabilities a reporting
  // grid never does; adding them here rather than hand-rolling a 17th table is the whole point of
  // §4.1 ("one grid, sixteen replacements").

  /** Alternating row backgrounds. Striped by DISPLAY position, so stripes stay correct after a sort
   *  — which is why this cannot be done through rowStyle, that only sees the row. */
  zebra?: boolean;

  /** Full-width separator rows between groups (the day log's hour markers).
   *  Emitted whenever `key` CHANGES between consecutive display rows, so it follows the current sort
   *  rather than assuming one. Pass undefined to turn grouping off — which is what the caller should
   *  do when the grid is sorted by anything that makes the grouping meaningless. */
  groupBy?: {
    key: (row: T) => string | number;
    render: (key: string | number, firstRow: T) => React.ReactNode;
  };

  /** Row drag-and-drop. The CALLER decides when dragging is legal (see onSortingChange) — the grid
   *  has no opinion about what a row order means. */
  rowDrag?: {
    /** Off entirely when false, with `disabledReason` shown as the row tooltip. */
    enabled: boolean;
    disabledReason?: string;
    /** Per-row veto, e.g. a row that has already aired. */
    canDrag?: (row: T) => boolean;
    onDrop: (fromId: string, toId: string) => void;
  };

  /** Row size. `compact` (default) is the reporting density every existing grid uses; `roomy` is the
   *  scannable 38px/14px the log needs. Existing callers keep compact by omission. */
  density?: "compact" | "roomy";

  /** Told the current sort so the caller can gate drag/grouping on it. */
  onSortingChange?: (sorting: SortingState) => void;
}

const WIDTH_PREFIX = "grid_widths_";

/**
 * A COMPACT drag image, replacing the browser's default.
 *
 * The default is a translucent snapshot of the WHOLE ROW — every column, full width — dragged over a
 * dense table so two sets of text render through each other. That, not any styling of ours, is the
 * "clashes with the text underneath". A small chip obscures one line instead of a whole row and
 * makes what is in hand obvious.
 *
 * Off-screen because setDragImage needs the node in the document and rendered at drag start; removed
 * on the next tick, once the browser has taken its picture.
 */
function setCompactDragImage(e: React.DragEvent, label: string) {
  try {
    const el = document.createElement("div");
    el.textContent = `⇅  ${label}`;
    el.style.cssText = [
      "position:fixed", "top:-9999px", "left:-9999px", "z-index:-1",
      "padding:5px 12px", "max-width:320px", "overflow:hidden",
      "white-space:nowrap", "text-overflow:ellipsis",
      "font:800 11px 'Inter',system-ui,sans-serif",
      "color:#fff", "background:#6040C0", "border:1px solid #8868D8",
      "box-shadow:0 4px 14px rgba(0,0,0,0.5)", "pointer-events:none",
    ].join(";");
    document.body.appendChild(el);
    e.dataTransfer.setDragImage(el, 16, 14);
    setTimeout(() => { try { el.remove(); } catch {} }, 0);
  } catch { /* unsupported → browser default, which still works */ }
}

/** What to write on the drag chip: the first text-bearing column's value. */
function dragLabel<T>(row: T, columns: GridColumn<T>[]): string {
  for (const c of columns) {
    if (c.csvOnly || c.mono) continue;
    const v = c.accessor(row);
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "row";
}

export function DataGrid<T>({
  columns, rows, empty, getRowId, rowStyle, initialSort, persistKey, stationId, csv, footer,
  zebra, groupBy, rowDrag, density, onSortingChange,
}: DataGridProps<T>) {
  const [sorting, setSorting] = useState<SortingState>(initialSort ?? []);
  // Drag state lives here so a row can render as ghost/target without the caller re-rendering.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  useEffect(() => { onSortingChange?.(sorting); }, [sorting, onSortingChange]);
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

  // File-only columns never reach the table. The full list still drives the CSV, so a column can
  // exist in the export without being rendered — see GridColumn.csvOnly.
  const shown = useMemo(() => screenColumns(columns), [columns]);

  const tanColumns = useMemo<ColumnDef<T, any>[]>(() => shown.map(c => ({
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
  })), [shown]);

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

  // Column headers: 11px UPPERCASE with letter-spacing — the workspace's label voice, used
  // identically in every pane so a header reads as a header anywhere you look.
  const th: React.CSSProperties = {
    position: "relative", padding: "var(--s-2) var(--s-4)", textAlign: "left",
    fontSize: "var(--t-small)", fontWeight: 700, color: "var(--text-tertiary)",
    textTransform: "uppercase", letterSpacing: "0.1em", whiteSpace: "nowrap",
    userSelect: "none", cursor: "pointer",
  };
  // ROW HEIGHT IS THE WHOLE ARGUMENT. Both densities now land inside 24–28px, where a broadcast
  // log belongs: the operator is scanning a hundred rows for the one that is wrong, and every
  // pixel of row height is a row they cannot see. `roomy` was 38px with 14px text — a third of the
  // screen spent on air. It is now 28px/13px: still the roomier of the two, still comfortable for
  // the drag-and-edit the log needs, but a third more rows in the same pane.
  const roomy = density === "roomy";
  const td: React.CSSProperties = {
    padding: roomy ? "var(--s-2) var(--s-4)" : "var(--s-1) var(--s-4)",
    fontSize: roomy ? "var(--t-lead)" : "var(--t-body)",
    height: roomy ? 28 : 24,
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
            {table.getRowModel().rows.map((r, displayIndex) => {
              const prev = displayIndex > 0 ? table.getRowModel().rows[displayIndex - 1] : null;
              const gKey = groupBy ? groupBy.key(r.original) : null;
              // A separator whenever the group CHANGES between consecutive displayed rows — so it
              // tracks the current sort instead of assuming the data arrived grouped.
              const newGroup = !!groupBy && (!prev || groupBy.key(prev.original) !== gKey);

              const canDrag = !!rowDrag?.enabled && (rowDrag.canDrag ? rowDrag.canDrag(r.original) : true);
              const dragging = dragId === r.id;
              const isTarget = !!dragId && dropId === r.id && dragId !== r.id && canDrag;

              return (
                <Fragment key={r.id}>
                  {newGroup && (
                    <tr>
                      <td colSpan={r.getVisibleCells().length}
                        style={{ padding: roomy ? "var(--s-4) var(--s-4) var(--s-2)" : "var(--s-3) var(--s-4)",
                                 background: "var(--bg-tertiary)", borderTop: "1px solid var(--border-primary)" }}>
                        {groupBy!.render(gKey!, r.original)}
                      </td>
                    </tr>
                  )}
                  <tr
                    draggable={canDrag}
                    onDragStart={canDrag ? (e) => {
                      setDragId(r.id);
                      try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", r.id); } catch {}
                      setCompactDragImage(e, dragLabel(r.original, columns));
                    } : undefined}
                    onDragEnd={canDrag ? () => { setDragId(null); setDropId(null); } : undefined}
                    onDragOver={canDrag ? (e) => {
                      if (dragId && dragId !== r.id) {
                        e.preventDefault();
                        try { e.dataTransfer.dropEffect = "move"; } catch {}
                        if (dropId !== r.id) setDropId(r.id);   // only on CHANGE — no per-pixel setState
                      }
                    } : undefined}
                    // NO onDragLeave, deliberately: it fires when the pointer crosses into a child
                    // cell, so the indicator flickered several times per row traversed. dragover on
                    // the next row supersedes the target; dragend/drop always clear it.
                    onDrop={canDrag ? (e) => {
                      e.preventDefault();
                      const from = dragId; setDragId(null); setDropId(null);
                      if (from && from !== r.id) rowDrag!.onDrop(from, r.id);
                    } : undefined}
                    title={rowDrag && !rowDrag.enabled ? rowDrag.disabledReason : undefined}
                    style={{
                      borderTop: "1px solid var(--border-primary)",
                      // Zebra by DISPLAY position, so it stays correct after any sort.
                      ...(zebra && displayIndex % 2 === 1 ? { background: "var(--bg-secondary)" } : {}),
                      ...(rowStyle ? rowStyle(r.original) : {}),
                      // The drop line: an inset shadow, not a real element, so changing target costs
                      // no layout and the rows below never judder.
                      ...(isTarget ? { boxShadow: "inset 0 3px 0 0 var(--accent-purple, #8868D8)" } : {}),
                      ...(dragging ? {
                        opacity: 0.4,
                        outline: "1px dashed rgba(136,104,216,0.55)", outlineOffset: "-1px",
                      } : {}),
                      cursor: canDrag ? (dragId ? "grabbing" : "grab") : undefined,
                    }}>
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
                </Fragment>
              );
            })}
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
