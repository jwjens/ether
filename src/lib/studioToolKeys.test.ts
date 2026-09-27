// fixes 27 + 28 (docs/help-audit-2026-09-27.md): in Show+ (StudioPro) the tool row says Grab (G) and Splice (C), but
// G was caught first by a branch that only drew a guide line at 250 ms (snapMs is the drag's snap-guide position, not
// snap — snapping is gridEnabled), and C spliced the selected clip instead of picking the Splice tool. G and C now
// pick their tools like V / T / F (press again → back to Smart). Splitting the selected clip at the playhead stays on S.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const src = fs.readFileSync(path.join(__dirname, "..", "components", "StudioPro.tsx"), "utf8");
const start = src.indexOf("const onKey = (e: KeyboardEvent)");
const handler = src.slice(start, src.indexOf('window.addEventListener("keydown", onKey, true)', start));
// The branches in the order the handler runs them: the first one matching a bare key wins.
const firstBranch = (key: string) => {
  const m = handler.match(new RegExp(`if \(k === "${key}"[^)]*\)[^{]*\{[\s\S]*?\n      \}`));
  return m ? m[0] : "";
};

describe("Show+ G picks the Grab tool (audit 27)", () => {
  it("the handler is found", () => { expect(start).toBeGreaterThan(0); expect(handler.length).toBeGreaterThan(500); });
  it("no branch ahead of the tool keys takes G", () => {
    expect(handler).not.toMatch(/setSnapMs\(/);
    expect(firstBranch("g")).not.toMatch(/snap/i);
  });
  it("G toggles grab", () => { expect(handler).toMatch(/if \(k === "g"\) \{ toggleTool\("grab"\);\s+return; \}/); });
});

describe("Show+ C picks the Splice tool (audit 28)", () => {
  const toolBlock = handler.slice(handler.indexOf('if (k === "v" || k === "g" || k === "c"'));
  it("C toggles the Splice (blade) tool", () => {
    expect(toolBlock).toMatch(/if \(k === "c"\) \{ toggleTool\("blade"\);\s+return; \}/);
  });
  it("C no longer splices — the tool keys cut nothing (splitting at the playhead stays on S)", () => {
    expect(toolBlock).not.toMatch(/splitRegion\(/);
    expect(handler).toMatch(/if \(k === "s" && !mod && selection\?\.regionId && selection\.trackId\) \{[\s\S]{0,120}splitRegion\(/);
  });
});
