import { describe, it, expect } from "vitest";
import { validateSlug, slugify } from "./slug";

describe("validateSlug (client mirror)", () => {
  it("accepts valid slugs", () => {
    for (const s of ["ov", "ab", "rock1029", "kjazz", "wxyz-fm", "abc", "my-cool-station"]) {
      expect(validateSlug(s)).toEqual({ ok: true });
    }
  });
  it("rejects too short / long / bad chars / hyphen edges as invalid", () => {
    for (const s of ["a", "a".repeat(33), "Rock", "my station", "under_score", "-abc", "abc-", "a--b"]) {
      expect(validateSlug(s)).toMatchObject({ ok: false, reason: "invalid" });
    }
  });
  it("rejects reserved slugs", () => {
    for (const s of ["admin", "api", "listen", "dashboard"]) {
      expect(validateSlug(s)).toEqual({ ok: false, reason: "reserved" });
    }
  });
});

describe("slugify (client mirror)", () => {
  it("normalizes names to slugs", () => {
    expect(slugify("Rock 102.9 FM")).toBe("rock-102-9-fm");
    expect(slugify("  KJAZZ!!  ")).toBe("kjazz");
    expect(slugify("Café Münich")).toBe("cafe-munich");
  });
  it("caps length and trims trailing hyphen", () => {
    const out = slugify("x".repeat(40));
    expect(out.length).toBeLessThanOrEqual(32);
    expect(out.endsWith("-")).toBe(false);
  });
});
