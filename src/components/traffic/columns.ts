// ── Traffic column definitions (v2 Phase 4, 2026-08-10) ──────────────────────────────────────────
//
// The traffic affidavit is a legal-ish artefact — an advertiser's proof a spot aired — so its CSV is
// the most byte-sensitive export in the app. csv.test.ts pins it.
//
// SCREEN AND FILE GENUINELY DIFFER HERE, more than anywhere else:
//   screen (9 cols): Sched · Aired · Δ · Status · Cart · ISCI · Advertiser · Title · Len
//   file  (12 cols): Date · Scheduled Time · Actual Time · Delta (s) · Status · Cart · ISCI ·
//                    Advertiser · Agency · Title · Length (s) · Spot Type
//
// The file splits the screen's single "Sched" into Date + Scheduled Time, and carries Agency and
// Spot Type, which are on no screen at all. So the union is declared ONCE below in FILE order, and
// the screen is whatever survives dropping the csvOnly columns — which is exactly the nine it has
// always shown, in the order it showed them.
//
// The other systematic difference: the screen writes "—" for an absent value because a person is
// reading it, and the file writes "" because a spreadsheet is. Every such pair is deliberate.
//
// docs/schedule-manager-v2-design-2026-08-10.md §4.2
import type { GridColumn } from "../grid/csv";

export interface TrafficRow {
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

// ── the derivations, named once so screen and file cannot drift ──────────────────────────────────
export const aired = (t: TrafficRow) => t.state === "played" || t.state === "playing";
export const actualTs = (t: TrafficRow) => (aired(t) ? (t.played_at ?? t.scheduled_at) : null);
export const deltaSec = (t: TrafficRow) => { const a = actualTs(t); return a != null ? a - t.scheduled_at : null; };
/** AIRED / MISSED / PENDING. `nowSec` is passed in rather than read here so the value is the same
 *  for every row in one render or one export — and so this stays testable without mocking a clock. */
export const statusOf = (t: TrafficRow, nowSec: number) =>
  aired(t) ? "AIRED" : (t.state === "missed" || t.scheduled_at < nowSec) ? "MISSED" : "PENDING";

/** Length in seconds, or null. length_sec is authoritative; duration_s is the older field. */
export const lengthOf = (t: TrafficRow) => t.length_sec ?? t.duration_s ?? null;
/** The generator copies advertiser into gs.artist at placement (main.js:6950), so that value
 *  survives even if the spot row is later edited or removed. Prefer the live spots row. */
export const advertiserOf = (t: TrafficRow) => t.advertiser || t.artist || "";

// Screen-only clock format (locale 12/24h, h:m:s) — matches Logs.tsx fmtTimestamp exactly.
const fmtTimestamp = (epoch: number) =>
  new Date(epoch * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
// File-only clock format — forced 24h en-US, so an affidavit reads the same on every machine.
const csvTime = (epoch: number) => new Date(epoch * 1000).toLocaleTimeString("en-US", { hour12: false });

/**
 * @param nowSec the moment the view/export is anchored to (see statusOf)
 */
export function trafficColumns(nowSec: number): GridColumn<TrafficRow>[] {
  return [
    // FILE-ONLY: the screen shows one Sched column; the affidavit needs the date in its own field.
    { id: "date", header: "Date", csvOnly: true, accessor: t => t.scheduled_at,
      csv: t => new Date(t.scheduled_at * 1000).toLocaleDateString() },

    { id: "sched", header: "Sched", csvHeader: "Scheduled Time", accessor: t => t.scheduled_at,
      mono: true, width: 110, sortType: "numeric",
      cell: t => fmtTimestamp(t.scheduled_at), csv: t => csvTime(t.scheduled_at) },

    { id: "aired", header: "Aired", csvHeader: "Actual Time", accessor: t => actualTs(t),
      mono: true, width: 110, sortType: "numeric",
      cell: t => { const a = actualTs(t); return a != null ? fmtTimestamp(a) : "—"; },
      csv: t => { const a = actualTs(t); return a != null ? csvTime(a) : ""; } },

    { id: "delta", header: "Δ", csvHeader: "Delta (s)", accessor: t => deltaSec(t),
      mono: true, align: "right", width: 80, sortType: "numeric",
      cell: t => { const d = deltaSec(t); return d != null ? (d >= 0 ? "+" : "") + d + "s" : "—"; },
      // String(number) with no sign prefix and no unit — the file must be arithmetic-ready.
      csv: t => { const d = deltaSec(t); return d != null ? String(d) : ""; } },

    { id: "status", header: "Status", accessor: t => statusOf(t, nowSec), width: 100, sortType: "alpha" },

    { id: "cart", header: "Cart", accessor: t => t.cart_number, mono: true, width: 90, sortType: "alpha",
      cell: t => t.cart_number || "—", csv: t => t.cart_number || "" },

    { id: "isci", header: "ISCI", accessor: t => t.isci_code, mono: true, width: 120, sortType: "alpha",
      cell: t => t.isci_code || "—", csv: t => t.isci_code || "" },

    { id: "advertiser", header: "Advertiser", accessor: t => advertiserOf(t), width: 180, sortType: "alpha",
      cell: t => advertiserOf(t) || "—" },

    { id: "agency", header: "Agency", csvOnly: true, accessor: t => t.agency, csv: t => t.agency || "" },

    { id: "title", header: "Title", accessor: t => t.title, width: 220, sortType: "alpha",
      // The screen prints title as-is (a spot with no title shows blank); the file coerces null to "".
      csv: t => t.title || "" },

    { id: "length", header: "Len", csvHeader: "Length (s)", accessor: t => lengthOf(t),
      mono: true, align: "right", width: 80, sortType: "numeric",
      cell: t => { const l = lengthOf(t); return l != null ? l + "s" : "—"; },
      csv: t => { const l = lengthOf(t); return l != null ? String(l) : ""; } },

    { id: "spotType", header: "Spot Type", csvOnly: true, accessor: t => t.spot_type, csv: t => t.spot_type || "" },
  ];
}
