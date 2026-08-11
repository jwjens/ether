// The version-mismatch rule. The case worth pinning is UNKNOWN: a daemon that predates the version
// command cannot report its build, and the whole point of this guard is that the UI admits that
// rather than showing a confident number it cannot support.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { decideDaemonVersion } = require_("./daemon-version.js");

describe("decideDaemonVersion", () => {
  it("reports a mismatch when both versions are known and differ", () => {
    expect(decideDaemonVersion({ daemonVersion: "4.4.170", appVersion: "4.4.178" }))
      .toEqual({ stale: true, reason: "mismatch", daemonVersion: "4.4.170", appVersion: "4.4.178" });
  });

  it("is quiet when the versions match", () => {
    const r = decideDaemonVersion({ daemonVersion: "4.4.178", appVersion: "4.4.178" });
    expect(r.stale).toBe(false);
    expect(r.reason).toBeNull();
  });

  it("reports UNKNOWN — never a guessed version — when the daemon predates the version command", () => {
    const r = decideDaemonVersion({ error: new Error("unknown cmd: version"), appVersion: "4.4.178" });
    expect(r).toEqual({ stale: true, reason: "unknown", daemonVersion: null, appVersion: "4.4.178" });
    // The banner prints daemonVersion. Anything non-null here would put a fabricated build number
    // in front of the operator, which is the exact defect this guard exists to remove.
    expect(r.daemonVersion).toBeNull();
  });

  it("draws NO conclusion from a plain connection error — a starting daemon is not a stale one", () => {
    expect(decideDaemonVersion({ error: new Error("ECONNREFUSED"), appVersion: "4.4.178" })).toBeNull();
    expect(decideDaemonVersion({ error: new Error("socket hang up"), appVersion: "4.4.178" })).toBeNull();
  });

  it("treats the daemon's own \"0\" placeholder as no-version, not as a mismatch", () => {
    const r = decideDaemonVersion({ daemonVersion: "0", appVersion: "4.4.178" });
    expect(r.stale).toBe(false);
    expect(r.daemonVersion).toBeNull();
  });

  it("survives a missing/blank version without inventing one", () => {
    for (const dv of [null, undefined, ""]) {
      const r = decideDaemonVersion({ daemonVersion: dv, appVersion: "4.4.178" });
      expect(r.stale).toBe(false);
      expect(r.daemonVersion).toBeNull();
    }
  });

  it("matches on the string, so a numeric version from the wire behaves", () => {
    expect(decideDaemonVersion({ daemonVersion: 4.4, appVersion: "4.4" }).stale).toBe(false);
  });
});
