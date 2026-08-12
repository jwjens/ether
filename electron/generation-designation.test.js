// Phase A changes no behaviour, so the only thing that can be wrong is the DECISION and the
// DISPLAY — both pure. These run without a database or a second machine.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
const D = require_("./generation-designation.js");
const { decide, status, parseRecord, nextRecord, mayAutoGenerate, STALE_YELLOW_SEC, STALE_RED_SEC } = D;

const NOW = 1_800_000_000;
const ME = "machine-A", OTHER = "machine-B";
const rec = (o = {}) => ({ machine_id: OTHER, machine_name: "OV", designated_at: NOW - 9999,
                           last_checked: NOW - 60, last_generated: NOW - 3600, ...o });

// PHASE B (4.4.201) — the gate that can STOP a station's log being built. Every one of these cases
// is a way to take a station off the air if it is wrong, which is why the rule is a pure function
// rather than four conditions inlined in the tick.
describe("mayAutoGenerate — the Phase B gate", () => {
  it("ALLOWS the designated machine", () => {
    const g = mayAutoGenerate({ record: rec({ machine_id: ME }), machineId: ME });
    expect(g.allow).toBe(true);
    expect(g.holder).toBe(ME);
  });

  it("BLOCKS a machine that is not the holder — the whole point of the feature", () => {
    const g = mayAutoGenerate({ record: rec(), machineId: ME });
    expect(g.allow).toBe(false);
    expect(g.holder).toBe(OTHER);
    expect(g.reason).toContain("OV");        // names the holder, for the log line and the ledger
  });

  it("ALLOWS an UNDESIGNATED station — refusing would be the gate causing dead air", () => {
    // A brand-new station has no record. If the gate refused here it would never build a log at
    // all, which is worse than the two-writer problem the gate exists to prevent. The tick claims
    // it by generating (the zero-config rule).
    const g = mayAutoGenerate({ record: null, machineId: ME });
    expect(g.allow).toBe(true);
    expect(g.holder).toBe(null);
  });

  it("the kill switch OUTRANKS the gate, even when another machine holds it", () => {
    // A bug in designation must never be able to stop a station being built with no way out.
    const g = mayAutoGenerate({ record: rec(), machineId: ME, killSwitch: true });
    expect(g.allow).toBe(true);
    expect(g.reason).toContain("kill_designation");
  });

  it("ALLOWS when this machine has no identity — it cannot prove it is not the holder", () => {
    // client_identity unreadable. Failing OPEN is right: the cost of a wrong block is a station
    // that stops building, the cost of a wrong allow is the pre-Phase-B behaviour we had all along.
    for (const id of [null, undefined, ""])
      expect(mayAutoGenerate({ record: rec(), machineId: id }).allow).toBe(true);
  });

  it("BLOCKS however stale the holder is — takeover stays human-only", () => {
    for (const age of [60, STALE_YELLOW_SEC + 1, STALE_RED_SEC + 1, 999 * 86400])
      expect(mayAutoGenerate({ record: rec({ last_checked: NOW - age }), machineId: ME }).allow).toBe(false);
  });

  it("survives a malformed record rather than throwing inside the tick", () => {
    expect(mayAutoGenerate({ record: parseRecord("not json"), machineId: ME }).allow).toBe(true);
    expect(mayAutoGenerate({ record: undefined, machineId: ME }).allow).toBe(true);
  });
});

describe("decide", () => {
  it("designates when nothing is designated — zero-config for a single machine", () => {
    expect(decide({ record: null, machineId: ME, autoOn: true }).action).toBe("designate");
  });
  it("stamps a heartbeat when it is the designated machine", () => {
    expect(decide({ record: rec({ machine_id: ME }), machineId: ME, autoOn: true }).action).toBe("stamp");
  });
  it("NEVER takes a designation from another machine, however stale", () => {
    // The whole difference from the lease this replaced: takeover is human-only.
    for (const age of [60, STALE_YELLOW_SEC + 1, STALE_RED_SEC + 1, 999 * 86400]) {
      const d = decide({ record: rec({ last_checked: NOW - age }), machineId: ME, autoOn: true });
      expect(d.action).toBe("observe");
      expect(d.holder).toBe(OTHER);
    }
  });
  it("a switched-OFF machine never takes the designation", () => {
    expect(decide({ record: null, machineId: ME, autoOn: false }).action).toBe("observe");
  });
  it("the kill switch stops designating and stamping alike", () => {
    for (const r of [null, rec(), rec({ machine_id: ME })])
      expect(decide({ record: r, machineId: ME, autoOn: true, killSwitch: true }).action).toBe("skip");
  });
});

describe("status — what the operator reads", () => {
  it("green while the designated machine checked in recently", () => {
    expect(status({ record: rec({ machine_id: ME }), now: NOW, machineId: ME }).level).toBe("green");
  });
  it("yellow after 6h without a check-in, red after 24h", () => {
    expect(status({ record: rec({ last_checked: NOW - STALE_YELLOW_SEC - 1 }), now: NOW, machineId: ME }).level).toBe("yellow");
    expect(status({ record: rec({ last_checked: NOW - STALE_RED_SEC - 1 }), now: NOW, machineId: ME }).level).toBe("red");
  });
  it("names the other machine rather than calling it unknown", () => {
    const s = status({ record: rec(), now: NOW, machineId: ME });
    expect(s.state).toBe("other");
    expect(s.text).toContain("OV");
  });
  it("NEUTRAL, not red, when nothing is designated yet", () => {
    // Phase A gates nothing, so an undesignated station is still being topped up by every
    // switched-on machine. Red would be an alarm for a normal state, and an alarm that is usually
    // wrong is one people stop reading. It becomes a warning in Phase B, when the consequence is real.
    const s = status({ record: null, now: NOW, machineId: ME });
    expect(s.level).toBe("grey");
    expect(s.state).toBe("none");
    expect(s.text).toContain("no machine has auto-generated");
  });
  it("reports last_generated SEPARATELY from the heartbeat", () => {
    // A machine can be watching (fresh last_checked) and correctly generating nothing, because the
    // runway is long. Merging the two would make a healthy station look idle.
    const s = status({ record: rec({ machine_id: ME, last_checked: NOW - 5, last_generated: NOW - 4 * 86400 }), now: NOW, machineId: ME });
    expect(s.level).toBe("green");
    expect(s.lastGenerated).toBe(NOW - 4 * 86400);
  });
  it("says bypassed rather than showing a designation it is ignoring", () => {
    expect(status({ record: rec(), now: NOW, machineId: ME, killSwitch: true }).state).toBe("bypassed");
  });
});

describe("record round-trip", () => {
  it("a malformed record is ABSENT, never someone else's claim", () => {
    for (const bad of [null, "", "{", "[]", "42", '{"machine_name":"x"}'])
      expect(parseRecord(bad)).toBeNull();
  });
  it("preserves designated_at and last_generated across a heartbeat", () => {
    const first = parseRecord(nextRecord({ record: null, now: NOW - 1000, machineId: ME, machineName: "dev", generated: true }));
    const beat = parseRecord(nextRecord({ record: first, now: NOW, machineId: ME, machineName: "dev", generated: false }));
    expect(beat.designated_at).toBe(NOW - 1000);        // not reset by a heartbeat
    expect(beat.last_generated).toBe(NOW - 1000);       // untouched when nothing was generated
    expect(beat.last_checked).toBe(NOW);
  });
  it("stamps last_generated only when the log was actually extended", () => {
    const r = parseRecord(nextRecord({ record: null, now: NOW, machineId: ME, generated: false }));
    expect(r.last_generated).toBeNull();
    expect(r.last_checked).toBe(NOW);
  });
});
