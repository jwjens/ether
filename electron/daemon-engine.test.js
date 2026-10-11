// The engine-match rule (2026-10-10, docs/monitor-failed-test-diagnosis-2026-10-10.md). Pinned: a daemon running a
// different engine under the same version is reported, with both hashes; a daemon that cannot report is UNKNOWN, never
// a guessed match.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { decideDaemonEngine } = require_("./daemon-engine.js");

const PRE = "0ebf6ccbf1855116" + "a".repeat(48);
const FIX = "9f7d7079f4e70383" + "b".repeat(48);
const CODE = "c".repeat(64), CODE2 = "d".repeat(64);

describe("decideDaemonEngine", () => {
  it("reports the OVEVENTS case: same version, different engine — red, both hashes named", () => {
    const r = decideDaemonEngine({ daemon: { native: PRE, code: CODE }, installed: { native: FIX, code: CODE } });
    expect(r.stale).toBe(true);
    expect(r.reason).toBe("mismatch");
    expect(r.parts).toEqual(["native"]);
    expect(r.daemon.native).toBe(PRE);
    expect(r.installed.native).toBe(FIX);
    expect(r.message).toContain("0ebf6ccbf185");
    expect(r.message).toContain("9f7d7079f4e7");
    expect(r.message).toMatch(/no station is on air/);
  });

  it("reports stale daemon code even when the native engine matches", () => {
    const r = decideDaemonEngine({ daemon: { native: FIX, code: CODE }, installed: { native: FIX, code: CODE2 } });
    expect(r.stale).toBe(true);
    expect(r.parts).toEqual(["code"]);
  });

  it("is a match only when both parts match", () => {
    const r = decideDaemonEngine({ daemon: { native: FIX, code: CODE }, installed: { native: FIX, code: CODE } });
    expect(r.stale).toBe(false);
    expect(r.reason).toBe(null);
  });

  it("a daemon that predates the engine command is UNKNOWN and stale — never assumed current", () => {
    const r = decideDaemonEngine({ error: new Error("unknown cmd: engine"), installed: { native: FIX, code: CODE } });
    expect(r.stale).toBe(true);
    expect(r.reason).toBe("unknown");
    expect(r.daemon.native).toBe(null);
    expect(r.message).toContain("9f7d7079f4e7");
  });

  it("a daemon that cannot read its own engine is a mismatch, not a match", () => {
    const r = decideDaemonEngine({ daemon: { native: null, code: CODE }, installed: { native: FIX, code: CODE } });
    expect(r.stale).toBe(true);
    expect(r.message).toContain("engine unknown");
  });

  it("draws no conclusion from a connection error or an unreadable install", () => {
    expect(decideDaemonEngine({ error: new Error("daemon cmd timeout: engine"), installed: { native: FIX, code: CODE } })).toBeNull();
    expect(decideDaemonEngine({ daemon: { native: PRE, code: CODE }, installed: { native: null, code: null } })).toBeNull();
  });
});
