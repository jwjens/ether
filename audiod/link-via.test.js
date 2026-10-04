// The fader remembers HOW its key was paired (2026-10-04): "account" (picked from this account's computers — the
// receiver re-fetches it when the sender replaces its key), "code" (a guest's one-use code — never re-fetched), or
// "line" (the advanced paste). Anything else is dropped, never invented; a stored key from before this reads as "line".
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const L = require_("./link.js");
const KEY = "a".repeat(64);
const stored = (from) => JSON.stringify({ slot: "S1", jitterMs: 120, port: 9760, autoCut: false, autoCutSec: 5, from });

describe("link_input.from.via", () => {
  it("round-trips account / code / line", () => {
    for (const via of ["account", "code", "line"]) {
      const p = L.parseInput(stored({ machine: "ov", name: "OV", keyId: 3, key: KEY, via }));
      expect(p.from.via).toBe(via);
      expect(L.parseInput(L.serializeInput(p)).from.via).toBe(via);
    }
  });
  it("a key stored before pairing existed (no via) reads as a pasted line", () => {
    expect(L.parseInput(stored({ machine: "ov", name: "OV", keyId: 3, key: KEY })).from.via).toBe("line");
  });
  it("an unknown via is not carried", () => {
    expect(L.parseInput(stored({ machine: "ov", name: "OV", keyId: 3, key: KEY, via: "made-up" })).from.via).toBe("line");
  });
});
