// fix 12, header part (docs/help-audit-2026-09-27.md): the sweeper pool grid declared four columns and a
// "UNDERLAP s" header, but each row renders three cells (name, LEAD-IN, delete) — so the header named a column that
// does not exist and every row after the first slid one cell out of line. The grid now declares the columns it draws.
// (The LEAD-IN box itself is still not read by the engine — that needs Jeff's ruling on lead precedence; see the report.)
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const src = fs.readFileSync(path.join(__dirname, "..", "components", "SweepersPanel.tsx"), "utf8");
const grid = src.slice(src.indexOf("{tabPools.length > 0 && ("), src.indexOf("WHAT IS IN THIS POOL"));

describe("the sweeper pool grid's header matches its rows (audit 12)", () => {
  it("no UNDERLAP header", () => { expect(grid).not.toMatch(/UNDERLAP/); });
  it("as many declared columns as header cells as cells per row", () => {
    const cols = (grid.match(/gridTemplateColumns: "([^"]+)"/) || [])[1] || "";
    const declared = cols.trim().split(/\s+/).length;
    const header = grid.slice(0, grid.indexOf("{tabPools.map("));
    const headerCells = (header.match(/<div( [^>]*)?\/>|<div [^>]*>[^<]*<\/div>/g) || []).length;
    const row = grid.slice(grid.indexOf("<Fragment key={p.id}>"), grid.indexOf("</Fragment>"));
    const rowCells = new Set(row.match(/key=\{p\.id \+ "[a-z]"\}/g) || []).size;   // the ro / editable pair share one cell
    expect(headerCells).toBe(declared);
    expect(rowCells).toBe(declared);
  });
});
