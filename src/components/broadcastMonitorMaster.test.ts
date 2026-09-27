// fix 1 (docs/help-audit-2026-09-27.md): the pop-out Master Out's MASTER fader only set display state — it never
// reached the engine — and it opened at 1.0 whatever the engine was running. It now rides the same path as the inline
// Master Out (MasterOutput.tsx applyMaster → engine.setMasterVolume → audio:setMasterVolume → the program bus) and
// reads back the level the engine was last given (useShowState levels.master). The master gain is applied in Rust
// before the meter, so the pop-out's VU must not multiply the fader in a second time.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const src = fs.readFileSync(path.join(__dirname, "BroadcastMonitor.tsx"), "utf8");
const main = src.slice(src.indexOf("export default function BroadcastMonitor("));

describe("pop-out MASTER drives the engine (audit 1)", () => {
  it("the MASTER fader's onChange sends the level to the engine", () => {
    const fader = main.match(/<BigFader label="Master"[^>]*onChange=\{(\w+)\}/);
    expect(fader).not.toBeNull();
    const handler = fader![1];
    expect(handler).not.toBe("setMasterVol");
    const body = main.slice(main.indexOf(`const ${handler}`), main.indexOf(`const ${handler}`) + 300);
    expect(body).toMatch(/engine\??\.setMasterVolume\??\.\(v\)/);
    expect(main).toMatch(/useAudioEngine\(\)/);
  });
  it("it opens at what the engine is running, not 1.0 (reads show levels.master back)", () => {
    expect(main).toMatch(/useShowState\(\)/);
    expect(main).toMatch(/show\.levels\.master != null\) setMasterVol\(show\.levels\.master\)/);
  });
  it("the VU shows the metered master (post-gain) — the fader is not applied a second time", () => {
    expect(main).not.toMatch(/masterLevel \* masterVol/);
  });
});
