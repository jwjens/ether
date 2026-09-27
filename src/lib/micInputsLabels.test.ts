// fix 26 (docs/help-audit-2026-09-27.md): Preferences → Mic Inputs headed each row "S1 · …" — the engine slot id,
// which is internal (one name per fader, src/lib/boardName.ts). Rows are now headed by the board letter.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { boardName } from "./boardName";
import { micChannelRows } from "./boardLabels";

const ENGINE_ID = /\bS\d\b/;

describe("Preferences → Mic Inputs names rows by board letter (audit 26)", () => {
  it("a mic channel with no label, and a patched slot that is not a mic channel, show no engine id", () => {
    const rows = micChannelRows(
      [{ slot: "S1", enabled: true, type: "source", kind: "mic", label: "" },
       { slot: "S2", enabled: true, type: "source", kind: "mic", label: "Host mic" }],
      ["S1", "S3"], s => boardName(s));
    expect(rows.map(r => r.slot)).toEqual(["S1", "S2", "S3"]);
    for (const r of rows) expect(r.heading, r.slot).not.toMatch(ENGINE_ID);
    expect(rows[0].heading).toBe("G");
    expect(rows[1].heading).toBe("H · Host mic");
    expect(rows[2].heading).toBe("I · not a mic channel");
  });
  it("the screen heads each row with the builder, never the slot id", () => {
    const mi = fs.readFileSync(path.join(__dirname, "..", "components", "MicInputsSettings.tsx"), "utf8");
    expect(mi).toMatch(/micChannelRows\(/);
    expect(mi).toMatch(/useBoardName\(\)/);
    expect(mi).not.toMatch(/\{slot\} ·/);
  });
});
