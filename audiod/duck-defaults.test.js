// ONE set of ducker defaults (docs/audio-numbers-audit-2026-10-11.md). The engine's boot default for the duck depth was
// −28 dB while the applier, show presets, main and the Ducker panel all said −22: a station whose saved value had not
// arrived yet ducked 6 dB deeper than anything on screen said. Every copy is pinned to the same numbers here.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const B = require_("./board-state.js");
const SP = require_("./show-presets.js");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

describe("ducker defaults agree everywhere", () => {
  const want = { depthDb: -22, thresholdDb: -45, attackMs: 30, holdMs: 700, releaseMs: 500 };
  it("the applier (what the engine is given)", () => {
    for (const [k, v] of Object.entries(want)) expect(B.DUCK_KEYS[k][1]).toBe(v);
  });
  it("show presets", () => {
    expect(SP.DUCK_DEFAULTS).toEqual(want);
  });
  it("the Ducker panel", () => {
    const src = read("src/components/DuckerSection.tsx");
    const block = /export const DUCK_DEFAULTS = \{([\s\S]*?)\};/.exec(src)[1];
    for (const [k, v] of Object.entries(want)) expect(new RegExp(`${k}:\\s*${v}\\b`).test(block)).toBe(true);
  });
  it("the engine's own boot defaults (native/src/audio.rs BusState::new)", () => {
    const src = read("native/src/audio.rs");
    expect(/duck_depth_db: -22\.0,/.test(src)).toBe(true);
    expect(/duck_depth_db: -28\.0/.test(src)).toBe(false);
    expect(/duck_threshold: 0\.0056,/.test(src)).toBe(true);    // 10^(−45/20)
    expect(Math.abs(20 * Math.log10(0.0056) - want.thresholdDb)).toBeLessThan(0.1);
    expect(/duck_attack_ms: 30\.0,/.test(src) && /duck_hold_ms: 700\.0,/.test(src) && /duck_release_ms: 500\.0,/.test(src)).toBe(true);
  });
  it("main's duck fan-out reads the applier's defaults, not its own copy", () => {
    const src = read("electron/main.js");
    expect(/num\('duck_depth_db', -22\)/.test(src)).toBe(false);
    expect(/BoardState\.DUCK_KEYS\.depthDb\[1\]/.test(src)).toBe(true);
  });
});
