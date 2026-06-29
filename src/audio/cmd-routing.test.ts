import { describe, it, expect } from "vitest";
import { resolveCommandTarget, isStationScopedCommand, commandTargetsThisMachine, type LocalStation } from "./cmd-routing";

// The three live stations are the real-world hazard this guards: a per-license command must reach
// ONLY the machine that runs the targeted station, and act on THAT station — never fan out to all.
const STATIONS: LocalStation[] = [
  { id: 1, uuid: "uuid-ov" },
  { id: 7, uuid: "uuid-halloveen" },
  { id: 9, uuid: "uuid-magic" },
];

describe("resolveCommandTarget", () => {
  it("uuid matches a local station → that station's id (not the active one)", () => {
    // Active is OV (1), but the command targets HalloVeen (7) → route to 7, not 1.
    expect(resolveCommandTarget("uuid-halloveen", 1, STATIONS)).toEqual({ kind: "target", stationId: 7 });
    expect(resolveCommandTarget("uuid-magic", 1, STATIONS)).toEqual({ kind: "target", stationId: 9 });
    expect(resolveCommandTarget("uuid-ov", 7, STATIONS)).toEqual({ kind: "target", stationId: 1 });
  });

  it("uuid present but NOT run on this machine → ignore (the anti-fan-out fix)", () => {
    // This machine runs only OV; a command for a station it doesn't have must be dropped.
    expect(resolveCommandTarget("uuid-somewhere-else", 1, [{ id: 1, uuid: "uuid-ov" }])).toEqual({ kind: "ignore" });
    expect(resolveCommandTarget("uuid-magic", 1, [])).toEqual({ kind: "ignore" });
  });

  it("no/blank uuid → fall back to the active station (back-compat for the companion / legacy callers)", () => {
    expect(resolveCommandTarget(undefined, 7, STATIONS)).toEqual({ kind: "active", stationId: 7 });
    expect(resolveCommandTarget(null, 9, STATIONS)).toEqual({ kind: "active", stationId: 9 });
    expect(resolveCommandTarget("", 1, STATIONS)).toEqual({ kind: "active", stationId: 1 });
    expect(resolveCommandTarget("   ", 1, STATIONS)).toEqual({ kind: "active", stationId: 1 });
  });

  it("trims a padded uuid before matching", () => {
    expect(resolveCommandTarget("  uuid-magic  ", 1, STATIONS)).toEqual({ kind: "target", stationId: 9 });
  });

  it("never matches a real uuid against a station whose local uuid is null/empty", () => {
    const rows: LocalStation[] = [{ id: 2, uuid: null }, { id: 3, uuid: "" }, { id: 4, uuid: "uuid-real" }];
    expect(resolveCommandTarget("uuid-real", 99, rows)).toEqual({ kind: "target", stationId: 4 });
    expect(resolveCommandTarget("uuid-missing", 99, rows)).toEqual({ kind: "ignore" });
  });

  it("exact-match only — a uuid is an opaque identity, no case-folding", () => {
    expect(resolveCommandTarget("UUID-OV", 1, STATIONS)).toEqual({ kind: "ignore" });
  });
});

describe("commandTargetsThisMachine (guided handoff per-machine gate)", () => {
  it("no target_machine_id → applies to this machine (back-compat)", () => {
    expect(commandTargetsThisMachine(undefined, "mid-jensj")).toBe(true);
    expect(commandTargetsThisMachine(null, "mid-jensj")).toBe(true);
    expect(commandTargetsThisMachine("", "mid-jensj")).toBe(true);
    expect(commandTargetsThisMachine("   ", "mid-jensj")).toBe(true);
  });
  it("target matches this machine → applies", () => {
    expect(commandTargetsThisMachine("mid-jensj", "mid-jensj")).toBe(true);
    expect(commandTargetsThisMachine("  mid-jensj  ", "mid-jensj")).toBe(true);
  });
  it("target is a DIFFERENT machine → does NOT apply (only the named machine acts)", () => {
    expect(commandTargetsThisMachine("mid-studioD", "mid-jensj")).toBe(false);
  });
  it("target set but this machine's id unknown → does not apply (never act on an unknown identity)", () => {
    expect(commandTargetsThisMachine("mid-studioD", null)).toBe(false);
    expect(commandTargetsThisMachine("mid-studioD", "")).toBe(false);
  });
});

describe("isStationScopedCommand", () => {
  it("station-scoped commands route by station_uuid", () => {
    for (const c of ["skip", "automation_on", "automation_off", "stop_all", "play", "pause", "play_now",
                     "set_volume", "play_emergency_cart", "mic_on",
                     "deck:load", "deck:cue", "deck:crossfade",
                     "queue:enqueue", "queue:reorder", "queue:remove", "queue:move", "queue:clear",
                     "stream:start", "stream:stop"]) {
      expect(isStationScopedCommand(c)).toBe(true);
    }
  });

  it("license-scoped commands are NEVER gated by station_uuid (must apply install-wide)", () => {
    for (const c of ["db:apply", "library:addSong", "library:syncDownload"]) {
      expect(isStationScopedCommand(c)).toBe(false);
    }
  });

  it("unknown commands are treated as license-scoped (not station-gated) → handled by execCmd's default", () => {
    expect(isStationScopedCommand("totally_unknown")).toBe(false);
    expect(isStationScopedCommand("")).toBe(false);
  });
});
