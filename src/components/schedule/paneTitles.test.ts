// fix 16 (docs/help-audit-2026-09-27.md): the Schedule Manager's sweeper pane was still titled "Jingles" (tab and
// Panels menu). Sweepers are never called jingles (the RCS model). The id stays "jingles" so saved layouts keep
// their pane; only the title the operator reads changes.
import { describe, it, expect } from "vitest";
import { PANELS } from "./layoutStore";

describe("the Schedule Manager's sweeper pane is called Sweepers (audit 16)", () => {
  it("no pane is titled Jingles; the sweeper pane keeps its stored id", () => {
    expect(PANELS.map(p => p.title as string)).not.toContain("Jingles");
    expect(PANELS.find(p => p.id === "jingles")?.title).toBe("Sweepers");
  });
});
