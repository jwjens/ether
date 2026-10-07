// The MONITOR bypass sense (electron/local-output-sense.js) and how the Health Monitor shows it.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { eventLevel } from "../src/components/health/healthUtils";

const require = createRequire(import.meta.url);
const { isMonitorBypass } = require("./local-output-sense");

describe("isMonitorBypass", () => {
  it("MONITOR at 0 and sound left for a local device → bypass", () => {
    expect(isMonitorBypass({ local_out_peak: 0.4, master_monitor: 0 })).toBe(true);
  });
  it("MONITOR at 0 and silence → no bypass (the fixed engine)", () => {
    expect(isMonitorBypass({ local_out_peak: 0, master_monitor: 0 })).toBe(false);
  });
  it("MONITOR up and sound → normal, not a bypass", () => {
    expect(isMonitorBypass({ local_out_peak: 0.4, master_monitor: 0.7 })).toBe(false);
  });
  it("float dust below the threshold is not sound", () => {
    expect(isMonitorBypass({ local_out_peak: 0.0005, master_monitor: 0 })).toBe(false);
  });
  it("an older engine without the fields says nothing", () => {
    expect(isMonitorBypass({ master: 0.5 })).toBe(false);
    expect(isMonitorBypass(null)).toBe(false);
  });
});

describe("Health Monitor", () => {
  it("shows monitor-bypass-error in RED", () => {
    expect(eventLevel("monitor-bypass-error")).toBe("red");
  });
});
