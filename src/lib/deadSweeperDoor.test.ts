// fix 14 (docs/help-audit-2026-09-27.md): the "Set up sweepers →" affordance was dead — App still queried every
// station's pools on each panel change and passed hasJinglePool / onOpenJingleSettings to LivePanel, which used
// neither. The button they fed was removed with the sweeper strip on 2026-09-02 (5540bd3, Jeff: "the static sweepers
// teal deck is not needed"); the door to sweepers is the JINGLES push-up in the bottom bar. The plumbing is removed.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("no dead sweeper-setup plumbing (audit 14)", () => {
  it("App neither computes nor passes the dead props", () => {
    const app = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
    expect(app).not.toMatch(/hasJinglePool/);
    expect(app).not.toMatch(/onOpenJingleSettings/);
  });
});
