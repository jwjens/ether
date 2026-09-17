// Live Activity classification: a play the engine REFUSED is a WARNING, not a routine or decision line
// (2026-09-16). The two lines below are the daemon's own wording (audiod/engine.js _resumePlayout and
// native/src/lib.rs audio_play) — the receipts of the 2-second dead-air loop, which this pane showed
// for a month as ordinary "decision" lines.
import { describe, it, expect } from "vitest";
import { parseActivityLine } from "./LiveActivityTerminal";

describe("LiveActivityTerminal.parseActivityLine — REFUSED is a warning", () => {
  it("the JS engine's refusal line", () => {
    const l = parseActivityLine("2026-09-16T05:08:03.943Z [INFO] [engine s2] resume-playout: deck B REFUSED by the engine (no content loaded) — falling through to the queue");
    expect(l.level).toBe("warning");
    expect(l.station).toBe(2);
  });
  it("Rust's refusal line (stderr, no timestamp)", () => {
    const l = parseActivityLine("[RUST] Play deck B: REFUSED — no content loaded on this deck");
    expect(l.level).toBe("warning");
  });
  it("a normal go-live is still a decision", () => {
    expect(parseActivityLine("2026-09-16T05:08:03.943Z [INFO] [engine s2] resume-playout: deck A LIVE — Next Real Song").level).toBe("decision");
  });
  it("the heartbeat is still routine", () => {
    expect(parseActivityLine("2026-09-16T05:08:03.943Z [INFO] [mix s2] active=1 frames=+225930 peak=0.6").level).toBe("routine");
  });
});
