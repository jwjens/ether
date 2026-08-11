// ── THE TRAFFIC BYTE-FOR-BYTE GATE (v2 Phase 4) ──────────────────────────────────────────────────
//
// The traffic affidavit is an advertiser's proof a spot aired, so its CSV is the most byte-sensitive
// export in the app. The conversion is allowed to change how the table looks and behaves; it is not
// allowed to change one byte of the file.
//
// HOW THIS GATE IS WEAKER THAN ROTATION ANALYTICS', SAID PLAINLY:
//
// Rotation Analytics' gate requires the REAL shipped exporter (electron/rotation-analytics.js) and
// compares against it, so it cannot drift. The traffic exporter was inline inside a React component
// and could not be imported, so `legacyTrafficCsv` below is a VERBATIM TRANSCRIPT of the
// pre-conversion Logs.tsx exportTraffic body (git 6f9ccdd:src/components/Logs.tsx:252-286).
//
// It therefore proves: the new column-driven exporter agrees with that transcript, and neither
// changes from here without this failing. It does NOT prove the transcript matches what shipped —
// only reading the diff does, which is why the source range is cited above rather than described.
import { describe, it, expect } from "vitest";
import { toCsv, csvColumns, screenColumns } from "../grid/csv";
import { trafficColumns, type TrafficRow } from "./columns";

// ── VERBATIM from Logs.tsx before the conversion. Do not tidy, do not modernise. ─────────────────
function legacyTrafficCsv(traffic: TrafficRow[], nowSec: number): string {
  const header = "Date,Scheduled Time,Actual Time,Delta (s),Status,Cart,ISCI,Advertiser,Agency,Title,Length (s),Spot Type";
  const rows = traffic.map(t => {
    const sd = new Date(t.scheduled_at * 1000);
    const aired = t.state === "played" || t.state === "playing";
    const actualTs = aired ? (t.played_at ?? t.scheduled_at) : null;
    const status = aired ? "AIRED"
                 : t.state === "missed" ? "MISSED"
                 : t.scheduled_at < nowSec ? "MISSED"
                 : "PENDING";
    return [
      sd.toLocaleDateString(),
      sd.toLocaleTimeString("en-US", { hour12: false }),
      actualTs != null ? new Date(actualTs * 1000).toLocaleTimeString("en-US", { hour12: false }) : "",
      actualTs != null ? String(actualTs - t.scheduled_at) : "",
      status,
      t.cart_number || "",
      t.isci_code || "",
      t.advertiser || t.artist || "",
      t.agency || "",
      t.title || "",
      String(t.length_sec ?? t.duration_s ?? ""),
      t.spot_type || "",
    ].map(v => '"' + String(v).replace(/"/g, '""') + '"').join(",");
  });
  return header + "\n" + rows.join("\n");
}

const row = (o: Partial<TrafficRow>): TrafficRow => ({
  id: 1, scheduled_at: 1_700_000_000, played_at: null, state: "pending", title: "Spot",
  artist: null, duration_s: null, file_path: null, advertiser: null, isci_code: null,
  cart_number: null, agency: null, length_sec: null, spot_type: null, ...o,
});

// Fixed timestamps, no clock mocking: 1.7e9 is 2023 (comfortably past), 4.1e9 is 2099 (comfortably
// future), so AIRED / MISSED / PENDING are all reachable and the test cannot go flaky at midnight.
const PAST = 1_700_000_000;
const FUTURE = 4_100_000_000;
const NOW = 1_800_000_000;

const FIXTURE: TrafficRow[] = [
  // aired late, quotes and a comma in the advertiser, all optional fields present
  row({ id: 1, scheduled_at: PAST, played_at: PAST + 47, state: "played", title: 'The "Big" Sale, Today',
        advertiser: 'Bob\'s Autos, "The Best"', agency: "Acme Media", isci_code: "ABC1234567",
        cart_number: "C-101", length_sec: 30, spot_type: "commercial" }),
  // aired EARLY — negative delta, which must keep its minus sign and no plus prefix
  row({ id: 2, scheduled_at: PAST, played_at: PAST - 12, state: "played", title: "Early Bird", length_sec: 60 }),
  // aired exactly on time — delta 0 must survive as "0", not blank
  row({ id: 3, scheduled_at: PAST, played_at: PAST, state: "played", title: "On The Dot", length_sec: 15 }),
  // playing counts as aired, with played_at null → falls back to scheduled_at
  row({ id: 4, scheduled_at: PAST, played_at: null, state: "playing", title: "Now Playing" }),
  // missed by state
  row({ id: 5, scheduled_at: PAST, state: "missed", title: "Missed One", advertiser: null, artist: "Fallback Advertiser" }),
  // pending in the future
  row({ id: 6, scheduled_at: FUTURE, state: "pending", title: "Future Spot", duration_s: 45 }),
  // everything absent — the "" vs "—" divergence between file and screen
  row({ id: 7, scheduled_at: PAST, state: null, title: "" }),
];

describe("traffic CSV is byte-identical to the pre-conversion exporter", () => {
  it("matches over the full fixture", () => {
    expect(toCsv(trafficColumns(NOW), FIXTURE)).toBe(legacyTrafficCsv(FIXTURE, NOW));
  });

  for (const r of FIXTURE) {
    it(`matches row ${r.id} in isolation`, () => {
      expect(toCsv(trafficColumns(NOW), [r])).toBe(legacyTrafficCsv([r], NOW));
    });
  }

  it("emits the exact affidavit header", () => {
    expect(toCsv(trafficColumns(NOW), FIXTURE).split("\n")[0])
      .toBe("Date,Scheduled Time,Actual Time,Delta (s),Status,Cart,ISCI,Advertiser,Agency,Title,Length (s),Spot Type");
  });

  it("keeps a delta of exactly 0 as \"0\" and a negative delta signed", () => {
    const cells = (id: number) => toCsv(trafficColumns(NOW), [FIXTURE.find(r => r.id === id)!]).split("\n")[1].split(",");
    expect(cells(3)[3]).toBe('"0"');
    expect(cells(2)[3]).toBe('"-12"');
  });

  it("doubles embedded quotes in the advertiser", () => {
    expect(toCsv(trafficColumns(NOW), [FIXTURE[0]])).toContain('"Bob\'s Autos, ""The Best"""');
  });

  it("falls back to the artist column for an advertiser recorded at placement time", () => {
    // The generator copies advertiser into gs.artist (main.js:6950) so it survives spot-row edits.
    expect(toCsv(trafficColumns(NOW), [FIXTURE[4]])).toContain('"Fallback Advertiser"');
  });
});

describe("screen and file shapes", () => {
  it("the file has all 12 affidavit columns", () => {
    expect(csvColumns(trafficColumns(NOW)).map(c => c.csvHeader ?? c.header)).toEqual([
      "Date", "Scheduled Time", "Actual Time", "Delta (s)", "Status", "Cart", "ISCI",
      "Advertiser", "Agency", "Title", "Length (s)", "Spot Type",
    ]);
  });

  it("the screen keeps its original 9 columns, in its original order", () => {
    expect(screenColumns(trafficColumns(NOW)).map(c => c.header)).toEqual([
      "Sched", "Aired", "Δ", "Status", "Cart", "ISCI", "Advertiser", "Title", "Len",
    ]);
  });

  it("Date, Agency and Spot Type are file-only — they were never on screen", () => {
    const shown = screenColumns(trafficColumns(NOW)).map(c => c.id);
    for (const id of ["date", "agency", "spotType"]) expect(shown).not.toContain(id);
  });
});
