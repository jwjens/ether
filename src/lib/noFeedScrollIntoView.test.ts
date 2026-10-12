// FEEDS NEVER MOVE THE SCREEN (Jeff, 2026-10-12; src/lib/stickyScroll.ts). element.scrollIntoView() scrolls EVERY scrollable
// ancestor, so a feed that calls it on new rows drags the panels around it — the Master Out console dragged the column
// holding the MASTER/MONITOR faders off the screen on every track start. Allowed only inside an operator's click.
// The behaviour itself is proven in a real Chromium by scripts/smoke-feed-no-jump.js.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : /\.(tsx?|jsx?)$/.test(n) && !/\.test\./.test(n) ? [p] : []; });
}

describe("no feed scrolls the screen around it", () => {
  it("scrollIntoView appears only inside an onClick (an operator act), never in an effect", () => {
    const offenders: string[] = [];
    for (const f of files(join(__dirname, ".."))) {
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/\.scrollIntoView\(/.test(line) || /^\s*\/\//.test(line)) return;
        // An operator's handler: onClick=…, or a named on<Action>= callback prop on this line or the line above.
        if (/\bon[A-Z]\w*=/.test(line) || /\bon[A-Z]\w*=\{?\(\)\s*=>\s*$/.test(lines[i - 1] || "")) return;
        offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(offenders).toEqual([]);
  });
  it("the Master Out console follows with useStickyScroll", () => {
    const m = readFileSync(join(__dirname, "..", "components", "MasterOutput.tsx"), "utf8");
    expect(m).toMatch(/useStickyScroll\(lastLineId\)/);
    expect(m).toMatch(/new event\{feed\.unseen === 1 \? "" : "s"\}/);
  });
});
