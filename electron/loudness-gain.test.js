// Library → Normalize never writes a made-up gain (Jeff, 2026-10-30). electron/loudness-gain.js.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { gainFor } = require_("./loudness-gain");

const ok = JSON.stringify({ lufs_integrated: 0, gain_db: -14 });
const bad = JSON.stringify({ error: "No such file or directory (os error 2)" });

describe("Normalize gain", () => {
  it("passes a real analysis through unchanged", () => {
    expect(gainFor("a.mp3", { analyze: () => -3.2, measure: () => { throw new Error("not asked"); } })).toEqual({ ok: true, gain: -3.2 });
  });
  it("the engine's failure answer (exactly -14) with a failed second measurement is a failure — nothing to write", () => {
    expect(gainFor("gone.mp3", { analyze: () => -14, measure: () => bad }))
      .toEqual({ ok: false, error: "No such file or directory (os error 2)" });
  });
  it("a genuine -14 (the second measurement succeeds) is kept", () => {
    expect(gainFor("loud.mp3", { analyze: () => -14, measure: () => ok })).toEqual({ ok: true, gain: -14 });
  });
  it("a thrown error, a non-number or no file is a failure", () => {
    expect(gainFor("x", { analyze: () => { throw new Error("boom"); }, measure: () => ok }).ok).toBe(false);
    expect(gainFor("x", { analyze: () => NaN, measure: () => ok }).ok).toBe(false);
    expect(gainFor("", { analyze: () => 1, measure: () => ok }).ok).toBe(false);
    expect(gainFor("x", { analyze: () => -14, measure: () => "not json" }).ok).toBe(false);
  });
});
