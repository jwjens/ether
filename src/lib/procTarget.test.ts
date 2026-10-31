// Settings → Broadcast → "Target loudness" (dead-controls item 14): it wrote a key the engine ignores once a processor
// rack is saved. It now reads and writes the rack's monitor RIDE target — the value the engine runs.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeRack, setLink } from "../components/rack/rackModel";
import { localTargetOf, withLocalTarget } from "./procTarget";

const require_ = createRequire(import.meta.url);
const RackSeed = require_("../../audiod/rack-seed.js");
const read = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8");

describe("Target loudness = the rack's ride target", () => {
  it("reads the monitor branch's ride target", () => {
    expect(localTargetOf(makeRack({ target: -16 }))).toBe(-16);
  });
  it("a change lands in the rack the engine runs — and a saved rack wins over the legacy key, so this is the only way it counts", () => {
    const next = withLocalTarget(makeRack(), -23)!;
    expect(localTargetOf(next)).toBe(-23);
    // What the daemon runs for a station that has saved this rack, even with a stale legacy key:
    const stored = JSON.stringify(next);
    const run = RackSeed.seedMasterRack((k: string) => (k === "rack_master" ? stored : k === "proc_target_lufs" ? "-14" : undefined));
    expect(RackSeed.branchParams(run.doc, "local").target).toBe(-23);
    // ...and rack:set writes the legacy key through, so older builds read the same number.
    expect(RackSeed.legacyWrites(next)).toContainEqual(["proc_target_lufs", "-23"]);
  });
  it("linked: the stream follows; split: the stream keeps its own", () => {
    const linked = withLocalTarget(makeRack(), -18)!;
    expect(RackSeed.branchParams(linked, "stream").target).toBe(-18);
    const split = withLocalTarget(setLink(makeRack({ target: -14 }), false), -18)!;
    expect(RackSeed.branchParams(split, "stream").target).toBe(-14);
  });
  it("clamped to the ride's range", () => {
    expect(localTargetOf(withLocalTarget(makeRack(), -40)!)).toBe(-30);
  });
  it("the Settings field goes through rack:get / rack:set, not the bare legacy key", () => {
    const s = read("src/components/SettingsPanel.tsx");
    expect(s).toMatch(/void saveTarget\(c\)/);
    expect(s).toMatch(/api\.audio\?\.setRack\?\.\(stationId, next\)/);
    expect(s).not.toMatch(/save\("proc_target_lufs"/);
  });
});
