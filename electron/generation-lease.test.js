// Phase 1 is observability, so the only thing that can be wrong is the DECISION — and that is pure.
// These run without a database or a second machine.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
const L = require_("./generation-lease.js");
const { decide, status, parseLease, nextLease, LEASE_TTL_SEC } = L;

const NOW = 1_800_000_000;
const ME = "machine-A", OTHER = "machine-B";
const lease = (o = {}) => ({ machine_id: OTHER, last_renewal: NOW - 60, ttl: LEASE_TTL_SEC, version: 1, ...o });

describe("decide", () => {
  it("claims when no lease exists", () => {
    expect(decide({ lease: null, now: NOW, machineId: ME, autoOn: true }).action).toBe("claim");
  });
  it("renews its own lease", () => {
    expect(decide({ lease: lease({ machine_id: ME }), now: NOW, machineId: ME, autoOn: true }).action).toBe("renew");
  });
  it("observes a lease another machine holds — never steals a live one", () => {
    const d = decide({ lease: lease(), now: NOW, machineId: ME, autoOn: true });
    expect(d.action).toBe("observe");
    expect(d.holder).toBe(OTHER);
  });
  it("claims an EXPIRED lease", () => {
    const d = decide({ lease: lease({ last_renewal: NOW - LEASE_TTL_SEC - 1 }), now: NOW, machineId: ME, autoOn: true });
    expect(d.action).toBe("claim");
    expect(d.expired).toBe(true);
  });
  it("holds at exactly the TTL boundary — expiry is strictly greater", () => {
    expect(decide({ lease: lease({ last_renewal: NOW - LEASE_TTL_SEC }), now: NOW, machineId: ME, autoOn: true }).expired).toBe(false);
  });
  it("a switched-OFF machine never claims — it has been told not to generate", () => {
    // Otherwise an off machine could sit on the lease and stop one that should be generating.
    expect(decide({ lease: null, now: NOW, machineId: ME, autoOn: false }).action).toBe("observe");
  });
  it("the kill switch stops every claim and renewal", () => {
    for (const l of [null, lease(), lease({ machine_id: ME })]) {
      expect(decide({ lease: l, now: NOW, machineId: ME, autoOn: true, killSwitch: true }).action).toBe("skip");
    }
  });
});

describe("status — the operator's view", () => {
  it("green while a live lease is held", () => {
    expect(status({ lease: lease({ machine_id: ME }), now: NOW, machineId: ME, autoOn: true }).level).toBe("green");
  });
  it("names the OTHER machine when it holds the lease", () => {
    const s = status({ lease: lease({ machine_name: "OV" }), now: NOW, machineId: ME, autoOn: true });
    expect(s.state).toBe("held-by-other");
    expect(s.text).toContain("OV");
  });
  it("RED when nobody holds it and this machine is not generating either — the zero-writer hazard", () => {
    const s = status({ lease: null, now: NOW, machineId: ME, autoOn: false });
    expect(s.level).toBe("red");
    expect(s.text).toContain("nothing is set to top up");
  });
  it("YELLOW and honest about two writers when unheld while this machine generates", () => {
    // Phase 1 does not enforce, so an unclaimed lease means any other ON machine is generating too.
    const s = status({ lease: null, now: NOW, machineId: ME, autoOn: true });
    expect(s.level).toBe("yellow");
    expect(s.text).toContain("so is any other switched-on machine");
  });
  it("says so when the kill switch is on rather than showing a false holder", () => {
    expect(status({ lease: lease(), now: NOW, machineId: ME, autoOn: true, killSwitch: true }).state).toBe("bypassed");
  });
});

describe("parseLease — a malformed lease is ABSENT, never trusted", () => {
  it("rejects junk, partial and non-object values", () => {
    for (const bad of [null, "", "{", "[]", "42", '{"machine_id":"x"}', '{"last_renewal":1}'])
      expect(parseLease(bad)).toBeNull();
  });
  it("round-trips a lease it wrote", () => {
    const raw = nextLease({ lease: null, now: NOW, machineId: ME, machineName: "dev", claiming: true });
    const p = parseLease(raw);
    expect(p.machine_id).toBe(ME);
    expect(p.last_renewal).toBe(NOW);
    expect(p.version).toBe(1);
  });
  it("increments version on a re-claim so writes can be ordered", () => {
    const p = parseLease(nextLease({ lease: lease({ version: 4 }), now: NOW, machineId: ME, claiming: true }));
    expect(p.version).toBe(5);
  });
});
