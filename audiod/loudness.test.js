// ONE loudness normalization for every source (audiod/loudness.js; Jeff, 2026-10-11). gain = target − measured; measured
// once per file CONTENT; never on the playout path; an unmeasured file plays at 0 dB and is said, never hidden.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const L = require_("./loudness.js");

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ether-loud-")); });
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
const file = (name, body) => { const p = path.join(tmp, name); fs.writeFileSync(p, body); return p; };

describe("the rule", () => {
  it("gain = target − measured, the same for every source", () => {
    // 2026-10-11, measured: music −15.8, a sweeper −9.6, a cart −7.3, an announcement −15.1 → all land on −16
    for (const [lufs, want] of [[-15.8, -0.2], [-9.6, -6.4], [-7.3, -8.7], [-15.1, -0.9], [-21.7, 5.7]]) {
      const g = L.gainFor(lufs, -16);
      expect(g.measured).toBe(true);
      expect(g.gainDb).toBeCloseTo(want, 9);
      expect(lufs + g.gainDb).toBeCloseTo(-16, 9);
    }
  });
  it("an unmeasured file gets 0 dB and says so", () => {
    expect(L.gainFor(null, -16)).toEqual({ gainDb: 0, measured: false, clamped: false });
  });
  it("outside the engine's trim range it is held at the range and SAYS it was clamped", () => {
    const g = L.gainFor(-45, -16);
    expect(g.gainDb).toBe(12);
    expect(g.clamped).toBe(true);
    expect(g.wantDb).toBe(29);
  });
  it("reads ffmpeg's ebur128 summary", () => {
    const err = "[Parsed_ebur128_0] t: 3.0 M: -20 S: -21 I: -22.0 LUFS\n[Parsed_ebur128_0] Summary:\n\n  Integrated loudness:\n    I:         -15.8 LUFS\n    Threshold: -26.0 LUFS\n";
    expect(L.parseIntegrated(err)).toBe(-15.8);
    expect(L.parseIntegrated("Summary:\n I: -70.0 LUFS")).toBe(null);   // silence: nothing to normalize
    expect(L.parseIntegrated("no summary")).toBe(null);
  });
});

describe("the measurer", () => {
  it("measures once per file CONTENT — a copy of the same bytes is not measured again", async () => {
    let calls = 0;
    const lo = L.createLoudness({ cachePath: path.join(tmp, "cache.json"), measure: async () => { calls++; return -9.6; } });
    const a = file("sweeper.wav", "same-bytes"), b = file("copy-of-sweeper.wav", "same-bytes");
    expect(lo.lookup(a)).toBe(null);
    lo.enqueue(a); await lo.idle();
    lo.enqueue(b); await lo.idle();
    expect(calls).toBe(1);
    expect(lo.lookup(a)).toBe(-9.6);
    expect(lo.lookup(b)).toBe(-9.6);
    expect(lo.gainFor(b, -16).gainDb).toBeCloseTo(-6.4, 9);
  });
  it("an edited file is measured again", async () => {
    let n = -10;
    const lo = L.createLoudness({ cachePath: path.join(tmp, "cache.json"), measure: async () => n-- });
    const a = file("cart.mp3", "v1");
    lo.enqueue(a); await lo.idle();
    expect(lo.lookup(a)).toBe(-10);
    fs.writeFileSync(a, "v2-edited-and-longer");
    expect(lo.lookup(a)).toBe(null);                  // stale by size/mtime → not trusted
    lo.enqueue(a); await lo.idle();
    expect(lo.lookup(a)).toBe(-11);
  });
  it("lookup never measures (the playout path calls it)", async () => {
    let calls = 0;
    const lo = L.createLoudness({ cachePath: path.join(tmp, "cache.json"), measure: async () => { calls++; return -14; } });
    const a = file("song.mp3", "x");
    for (let i = 0; i < 50; i++) lo.lookup(a);
    expect(calls).toBe(0);
  });
  it("backfill queues only audio files not yet measured", async () => {
    const lo = L.createLoudness({ cachePath: path.join(tmp, "cache.json"), measure: async () => -14 });
    const a = file("a.mp3", "1"), b = file("b.wav", "2"), t = file("notes.txt", "3");
    expect(lo.backfill([a, b, t])).toBe(2);
    await lo.idle();
    expect(lo.backfill([a, b, t])).toBe(0);
    expect(lo.status().cached).toBe(2);
  });
  it("the cache survives a restart (the daemon and main share it)", async () => {
    const cachePath = path.join(tmp, "cache.json");
    const lo = L.createLoudness({ cachePath, measure: async () => -12.3 });
    const a = file("a.mp3", "z");
    lo.enqueue(a); await lo.idle();
    await new Promise(r => setTimeout(r, 2300));      // the debounced save
    const lo2 = L.createLoudness({ cachePath, measure: async () => { throw new Error("must not measure"); } });
    expect(lo2.lookup(a)).toBe(-12.3);
  }, 10000);
});
