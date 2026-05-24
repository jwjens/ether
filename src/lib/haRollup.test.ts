import { describe, it, expect } from "vitest";
import { deriveHaRollup, type HaDashboard } from "./haRollup";

// Builds a fully-healthy dashboard, then lets each test override a slice.
function dash(overrides: {
  health?: Partial<HaDashboard["health"]>;
  ha?: Partial<HaDashboard["ha"]>;
} = {}): HaDashboard {
  return {
    health: {
      ok: true,
      ts: Date.now(),
      pid: 1234,
      uptimeSec: 3600,
      audio: { lastCallbackMs: Date.now(), staleMs: 12, alive: true },
      sync: null,
      station: { activeId: 1 },
      memRssMb: 220,
      ...overrides.health,
    },
    ha: {
      platform: "win32",
      supported: true,
      active: true,
      config: { enabled: true },
      startup: { registered: true, taskName: "EtherHAWatchdog" },
      watchdog: { pid: 9876, alive: true, monitoring: true },
      alarm: false,
      ...overrides.ha,
    },
  };
}

describe("deriveHaRollup", () => {
  it("null dashboard → loading", () => {
    expect(deriveHaRollup(null).level).toBe("loading");
  });

  it("all signals good → healthy", () => {
    const r = deriveHaRollup(dash());
    expect(r.level).toBe("healthy");
    expect(r.reasons).toHaveLength(0);
  });

  it("alarm marker takes precedence over everything → alarm", () => {
    // Even with the watchdog dead AND inactive, alarm wins.
    const r = deriveHaRollup(dash({ ha: { alarm: true, active: false, watchdog: { pid: null, alive: false, monitoring: false } } }));
    expect(r.level).toBe("alarm");
  });

  it("health endpoint not ok → alarm", () => {
    const r = deriveHaRollup(dash({ health: { ok: false } }));
    expect(r.level).toBe("alarm");
  });

  it("HA not active (and no alarm) → inactive, not red", () => {
    const r = deriveHaRollup(dash({ ha: { active: false } }));
    expect(r.level).toBe("inactive");
  });

  it("active but watchdog dead → degraded", () => {
    const r = deriveHaRollup(dash({ ha: { watchdog: { pid: 9876, alive: false, monitoring: true } } }));
    expect(r.level).toBe("degraded");
    expect(r.reasons.join(" ")).toMatch(/watchdog process is not alive/i);
  });

  it("active + supported but startup task unregistered → degraded", () => {
    const r = deriveHaRollup(dash({ ha: { startup: { registered: false } } }));
    expect(r.level).toBe("degraded");
    expect(r.reasons.join(" ")).toMatch(/reboot/i);
  });

  it("startup unregistered on an UNSUPPORTED platform is not a demotion", () => {
    const r = deriveHaRollup(dash({ ha: { supported: false, startup: { registered: false } } }));
    expect(r.level).toBe("healthy");
  });

  it("active but mutual supervision off → degraded", () => {
    const r = deriveHaRollup(dash({ ha: { watchdog: { pid: 9876, alive: true, monitoring: false } } }));
    expect(r.level).toBe("degraded");
    expect(r.reasons.join(" ")).toMatch(/mutual supervision/i);
  });

  it("multiple problems accumulate reasons", () => {
    const r = deriveHaRollup(dash({ ha: { watchdog: { pid: null, alive: false, monitoring: false }, startup: { registered: false } } }));
    expect(r.level).toBe("degraded");
    expect(r.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it("audio.alive=false does NOT demote the rollup", () => {
    const r = deriveHaRollup(dash({ health: { audio: { lastCallbackMs: 0, staleMs: null, alive: false } } }));
    expect(r.level).toBe("healthy");
  });
});
