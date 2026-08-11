// ── As-run affidavit column definitions (2026-08-11) ─────────────────────────────────────────────
//
// The "Export CSV" (standard) file from the Logs panel. Replaces a header that had shipped for a
// long time as:
//
//     Date,Time,Title,Artist,Category,Show,Clock,Deck
//
// of which THREE columns could never carry data:
//   · Clock    — `play_log` has no clock_name column at all.
//   · Show     — `audiod/playlog.js:41` writes show_name: null, always.
//   · Category — same line, category_code: null, always.
//
// So the file offered eight columns and told the truth in five. Category is kept here, but sourced
// from a JOIN (the song's category) rather than the column that is never written — a column that
// cannot be populated is worse than an absent one, because it reads as "no category" rather than
// "we never recorded it".
//
// What an affidavit actually has to answer is "did this spot air, when, and for how long", so the
// timing is explicit: Start Time, End Time (start + duration) and Duration.
//
// docs/help-logs.md
import type { GridColumn } from "../grid/csv";

export interface AsRunRow {
  played_at: number;
  title: string;
  artist: string | null;
  deck: string | null;
  duration_ms: number | null;
  category: string | null;      // joined: songs.category_id → categories
  advertiser: string | null;    // joined: spots by file_path
  isci_code: string | null;
  cart_number: string | null;
  content_class: string | null;
}

const two = (n: number) => String(n).padStart(2, "0");

/** Duration as M:SS — broadcast convention, so a :30 reads as 0:30. Empty when unknown: an affidavit
 *  must not imply a length it does not have. */
export function fmtDuration(ms: number | null): string {
  if (ms == null || !(ms > 0)) return "";
  const total = Math.round(ms / 1000);
  return Math.floor(total / 60) + ":" + two(total % 60);
}

const clock = (epoch: number) => new Date(epoch * 1000).toLocaleTimeString("en-US", { hour12: false });

/** End = start + duration. Empty when the duration is unknown — NOT equal to the start, which would
 *  assert a zero-length airing. */
export function endTime(r: AsRunRow): string {
  if (r.duration_ms == null || !(r.duration_ms > 0)) return "";
  return clock(r.played_at + Math.round(r.duration_ms / 1000));
}

export const AS_RUN_COLUMNS: GridColumn<AsRunRow>[] = [
  { id: "startTime", header: "Start Time", accessor: r => r.played_at, csv: r => clock(r.played_at) },
  { id: "endTime", header: "End Time", accessor: r => endTime(r) },
  { id: "duration", header: "Duration", accessor: r => fmtDuration(r.duration_ms) },
  { id: "date", header: "Date", accessor: r => r.played_at, csv: r => new Date(r.played_at * 1000).toLocaleDateString() },
  { id: "title", header: "Title", accessor: r => r.title, csv: r => r.title || "" },
  { id: "artist", header: "Artist", accessor: r => r.artist, csv: r => r.artist || "" },
  { id: "deck", header: "Deck", accessor: r => r.deck, csv: r => r.deck || "" },
  { id: "category", header: "Category", accessor: r => r.category, csv: r => r.category || "" },
  { id: "advertiser", header: "Advertiser", accessor: r => r.advertiser, csv: r => r.advertiser || "" },
  { id: "isci", header: "ISCI", accessor: r => r.isci_code, csv: r => r.isci_code || "" },
  { id: "cart", header: "Cart Number", accessor: r => r.cart_number, csv: r => r.cart_number || "" },
  // Every row in play_log AIRED — that is what the table records, and it is the claim an affidavit
  // makes. "Scheduled" and "Missed" are states of generated_schedule, not of the play log: a spot
  // that never aired leaves no row here to label. Those live in the Traffic view, which reads the
  // schedule. Constant by construction, and kept because an affidavit column that says what is
  // being asserted is the point of the document.
  { id: "status", header: "Status", accessor: () => "Aired" },
];
