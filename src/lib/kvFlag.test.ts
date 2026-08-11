// Regression test for the 4.4.183 auto-generate toggle flicker.
import { describe, it, expect } from "vitest";
import { parseKvFlag } from "./kvFlag";

describe("parseKvFlag", () => {
  it("THE 4.4.183 BUG: an envelope carrying \"0\" is OFF, not ON", () => {
    // The shipped caller compared the whole { ok, value } object against "0" — never equal — so a
    // stored OFF read back as ON and the button snapped back on every click.
    expect(parseKvFlag({ ok: true, value: "0" }, true)).toBe(false);
  });

  it("reads a stored 1/true as on", () => {
    expect(parseKvFlag({ ok: true, value: "1" }, false)).toBe(true);
    expect(parseKvFlag({ ok: true, value: "true" }, false)).toBe(true);
  });

  it("applies the per-flag default when the key is UNSET", () => {
    // auto_generate: a station nobody configured must still not run dry.
    expect(parseKvFlag({ ok: true, value: null }, true)).toBe(true);
    expect(parseKvFlag({ ok: true, value: "" }, true)).toBe(true);
    // log_reader_flip: a canary you opt into.
    expect(parseKvFlag({ ok: true, value: null }, false)).toBe(false);
  });

  it("returns null for UNREADABLE — which is not the same as off", () => {
    for (const bad of [null, undefined, {}, { ok: false }, { ok: false, error: "nope" }]) {
      expect(parseKvFlag(bad as any, true)).toBeNull();
    }
  });

  it("treats any other stored string as off, not as truthy", () => {
    expect(parseKvFlag({ ok: true, value: "yes" }, true)).toBe(false);
    expect(parseKvFlag({ ok: true, value: "0.0" }, true)).toBe(false);
  });
});

describe("auto_generate_enabled defaults OFF (4.4.185)", () => {
  // An unattended writer to the playout log is switched on deliberately, never inherited. Default-ON
  // (4.4.183-184) meant every fresh install of a multi-machine station became a second generator
  // immediately — the two-writer hazard itself, not a step toward it.
  it("an UNSET key is OFF, not ON", () => {
    expect(parseKvFlag({ ok: true, value: null }, false)).toBe(false);
    expect(parseKvFlag({ ok: true, value: undefined }, false)).toBe(false);
    expect(parseKvFlag({ ok: true, value: "" }, false)).toBe(false);
  });

  it("an UNREADABLE store is OFF at the call site — never generate blind", () => {
    // parseKvFlag reports null (unknown); the caller resolves that to OFF for this flag, because
    // "I could not tell" is not a reason to let a background process write the log.
    expect(parseKvFlag({ ok: false, error: "boom" }, false)).toBeNull();
    expect(parseKvFlag(null, false)).toBeNull();
  });

  it("an explicit \"1\" turns it on, and survives the round trip", () => {
    expect(parseKvFlag({ ok: true, value: "1" }, false)).toBe(true);
  });

  it("an existing install with a stored value keeps it, whatever the default", () => {
    expect(parseKvFlag({ ok: true, value: "1" }, false)).toBe(true);
    expect(parseKvFlag({ ok: true, value: "0" }, true)).toBe(false);
  });
});
