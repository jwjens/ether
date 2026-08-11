// ── THE BYTE-FOR-BYTE GATE (v2 Phase 3) ──────────────────────────────────────────────────────────
//
// Phase 3 changes how the tables LOOK and BEHAVE. It must not change what they SAY.
//
// So the new column-def-driven exporter is compared against the SHIPPED one — the actual
// electron/rotation-analytics.js module, required directly, not a copy of it — over the same
// snapshot. Equal strings, or the conversion is wrong. If the diff is empty, the data pipeline
// survived the reskin untouched.
//
// This is a real comparison, not a transcription check: the moment someone edits toCsv in main or a
// csvHeader here, the two drift and this fails.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { toCsv as gridCsv, csvColumns } from "./csv";
import { SPINS_COLUMNS, BURN_COLUMNS, TURNOVER_COLUMNS, HOURLY_COLUMNS } from "../rotation/columns";

const require_ = createRequire(import.meta.url);
// The shipped exporter. Pure functions over a snapshot — no electron, no db handle at import time.
const engine = require_("../../../electron/rotation-analytics.js");

// A snapshot built to break a naive exporter, not to look tidy:
//   · a quote and a comma in an artist name (the escaping path)
//   · hasTarget false (screen "—" vs file "(none)")
//   · deltaPerHour exactly 0 (`??` vs `||` — 0 must survive as "0", not blank)
//   · a negative delta, and a null tightest gap
//   · an apostrophe and a unicode dash in a category name
const SNAP = {
  spins: [
    { categoryId: 1, category: "Feel Good", hasTarget: true, target: 4, actualPerHour: 7, deltaPerHour: 3, spins: 168, distinctSongs: 37, sharePct: 74 },
    { categoryId: 2, category: "Power — Gold", hasTarget: false, target: 0, actualPerHour: 2, deltaPerHour: 0, spins: 48, distinctSongs: 40, sharePct: 21 },
    { categoryId: 3, category: "Rock 'n' Roll", hasTarget: true, target: 5, actualPerHour: 3, deltaPerHour: -2, spins: 12, distinctSongs: 9, sharePct: 5 },
    { categoryId: null, category: "Uncategorised", hasTarget: false, target: 0, actualPerHour: 0, deltaPerHour: 0, spins: 0, distinctSongs: 0, sharePct: 0 },
  ],
  hourly: [
    { hour: "00", category: "Feel Good", spins: 7 },
    { hour: "01", category: 'The "Late" Show', spins: 3 },
  ],
  burn: [
    { artist: 'Marvin Gaye & Tammi Terrell, "Duets"', spins: 9, tightestGapMin: 28, separationRuleMin: 60, violatesRule: true },
    { artist: "Bee Gees", spins: 6, tightestGapMin: 18, separationRuleMin: 60, violatesRule: true },
    { artist: "Someone Once", spins: 1, tightestGapMin: null, separationRuleMin: 60, violatesRule: false },
  ],
  turnover: [
    { categoryId: 1, category: "Feel Good", librarySize: 37, songsUsed: 30, coveragePct: 81, driftSongs: 4, spins: 268, spinsPerSong: 7.24 },
    { categoryId: 2, category: "Power — Gold", librarySize: 120, songsUsed: 12, coveragePct: 10, driftSongs: 0, spins: 24, spinsPerSong: 2 },
  ],
};

const COLUMNS: Record<string, any> = {
  spins: SPINS_COLUMNS, hourly: HOURLY_COLUMNS, burn: BURN_COLUMNS, turnover: TURNOVER_COLUMNS,
};
const ROWS: Record<string, any[]> = {
  spins: SNAP.spins, hourly: SNAP.hourly, burn: SNAP.burn, turnover: SNAP.turnover,
};

describe("CSV export matches the shipped exporter byte for byte", () => {
  for (const kind of ["spins", "hourly", "burn", "turnover"]) {
    it(`${kind}: identical to electron/rotation-analytics.js toCsv`, () => {
      expect(gridCsv(COLUMNS[kind], ROWS[kind])).toBe(engine.toCsv(kind, SNAP));
    });
  }

  it("exports EVERY row, not the 25 the screen shows", () => {
    // The burn table displays the top 25 and always exported all of them. Generating the file from
    // the grid's visible rows would silently truncate it — caught here rather than by an operator
    // whose 40-artist report arrived with 25.
    const many = Array.from({ length: 40 }, (_, i) => ({
      artist: `Artist ${i}`, spins: 40 - i, tightestGapMin: i, separationRuleMin: 60, violatesRule: i < 3,
    }));
    const csv = gridCsv(BURN_COLUMNS, many);
    expect(csv.split("\n")).toHaveLength(41);                       // 40 + header
    expect(engine.toCsv("burn", { ...SNAP, burn: many })).toBe(csv);
  });
});

describe("the byte contract itself", () => {
  it("quotes data cells, leaves the header row unquoted", () => {
    const [header, first] = gridCsv(SPINS_COLUMNS, SNAP.spins).split("\n");
    expect(header).toBe("Category,Target/hr,Actual/hr,Delta/hr,Spins,Distinct songs,Share %");
    expect(first).toBe('"Feel Good","4","7","3","168","37","74"');
  });

  it("doubles embedded quotes", () => {
    expect(gridCsv(BURN_COLUMNS, SNAP.burn).split("\n")[1])
      .toContain('"Marvin Gaye & Tammi Terrell, ""Duets"""');
  });

  it("keeps a delta of exactly 0 as \"0\", not blank", () => {
    // `?? ""` not `|| ""`. A category exactly on target is the best possible outcome; reporting it
    // as missing data would be a lie in the direction of alarm.
    const row = gridCsv(SPINS_COLUMNS, [SNAP.spins[1]]).split("\n")[1];
    expect(row.split(",")[3]).toBe('"0"');
  });

  it("writes no trailing newline and no BOM", () => {
    const csv = gridCsv(SPINS_COLUMNS, SNAP.spins);
    expect(csv.endsWith("\n")).toBe(false);
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
  });

  it("emits a header-only file for no rows, never an empty string", () => {
    expect(gridCsv(SPINS_COLUMNS, [])).toBe("Category,Target/hr,Actual/hr,Delta/hr,Spins,Distinct songs,Share %");
  });
});

describe("column order in the file", () => {
  it("turnover puts off-category fifth, where the file has always had it", () => {
    expect(csvColumns(TURNOVER_COLUMNS).map(c => c.csvHeader ?? c.header)).toEqual([
      "Category", "Library size", "Songs used", "Coverage %", "Off-category (stale)", "Spins", "Spins per song",
    ]);
  });

  it("screen order is unchanged by csvOrder — it puts off-category last", () => {
    expect(TURNOVER_COLUMNS.map(c => c.id)).toEqual([
      "category", "librarySize", "songsUsed", "coveragePct", "spins", "spinsPerSong", "driftSongs",
    ]);
  });

  it("drops screen-only columns from the file", () => {
    const cols = [...SPINS_COLUMNS, { id: "x", header: "Screen only", accessor: () => "x", csvExclude: true }];
    expect(csvColumns(cols as any).find(c => c.id === "x")).toBeUndefined();
  });
});
