// Item 36 (Jeff's 5b and 6c, 2026-10-30): Generate relaxes SOFT rules before breaking a STRICT one, moves a STRICT
// max-in-a-row slot to the next different category, and marks every bent or broken rule on the row (and STRICT ones in
// Health through ctx.relaxed). electron/generate-core.js, audiod/loggen.js.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const gen = readFileSync(join(__dirname, "generate-core.js"), "utf8");
const loggen = readFileSync(join(__dirname, "..", "audiod", "loggen.js"), "utf8");
describe("Generate follows 5b and 6c", () => {
  it("order: every rule → SOFT relaxed (strictOnly) → least recently played (STRICT broken, into Health)", () => {
    const a = gen.indexOf("ctx.core.pick(_pool(ctx, categoryId, hour), ts, tl, ctx.rules);");
    const b = gen.indexOf("{ strictOnly: true }");
    const c = gen.indexOf("ctx.core.leastRecent(_pool(ctx, categoryId, hour)");
    expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(a); expect(c).toBeGreaterThan(b);
    expect(gen).toMatch(/\.\.\.\(r\.softBent \? \{ soft: r\.softBent \} : \{\}\)/);
  });
  it("max in a row: STRICT takes the next different category; otherwise broken and marked (STRICT → Health)", () => {
    expect(gen).toMatch(/const alt = mr\.hard \? nextCats\.find\(c => c && c !== categoryId\) : null;/);
    expect(gen).toMatch(/maxRow = \{ moved: true, from: categoryId, to: alt/);
    expect(gen).toMatch(/if \(mr\.hard\) ctx\.relaxed\.push\(\{[^}]*broke: \{ rule: 'max-in-a-row'/);
    expect(gen.match(/_catsAfter\((slots, si|musicSlots, mi)\)/g)?.length).toBe(2);
  });
  it("on air, only STRICT rules refuse a row", () => {
    expect(loggen).toMatch(/nowTs, rules, true\);\s*\/\/ STRICT rules only on air/);
  });
});
