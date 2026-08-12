// checkSeparation warns about a manual placement without refusing it.
//
// These tests exist because the design doc's proposed version would have shipped a checker that
// SILENTLY NEVER WARNED: it read map names buildRestMaps does not return, and it consulted only
// play_log (aired history) when the case it was written for — moving a track next to another in a
// future day — involves two rows that have not aired and are therefore not in play_log at all.
// A warning system that always returns "clean" is worse than none: it is reassurance.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
const { checkSeparation } = require_("./separation-enforce.js");

const WIN = { artistSepMin: 60, songRepeatMin: 180, titleSepMin: 120 };
const T = 1_000_000;                        // an arbitrary "now"
const ctx = (neighbours, maps = {}) => ({ neighbours, ...maps });

describe("checkSeparation — the future (scheduled neighbours)", () => {
  it("warns when the same ARTIST is inside the window — the design's own test C", () => {
    const w = checkSeparation(
      { uuid: "me", title: "Song A", artist: "Fleetwood Mac" },
      T,
      ctx([{ uuid: "other", scheduled_at: T + 600, title: "Song B", artist: "Fleetwood Mac" }]),
      WIN);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("Fleetwood Mac");
    expect(w[0]).toContain("10 min away");
    expect(w[0]).toContain("60 min");            // names the rule, so the DJ can judge it
  });

  it("is clean when the same artist is OUTSIDE the window", () => {
    expect(checkSeparation(
      { uuid: "me", artist: "Fleetwood Mac" },
      T,
      ctx([{ uuid: "o", scheduled_at: T + 3601, artist: "Fleetwood Mac" }]),
      WIN)).toEqual([]);
  });

  it("matches artists case- and whitespace-insensitively", () => {
    expect(checkSeparation(
      { uuid: "me", artist: "  fleetwood MAC " },
      T,
      ctx([{ uuid: "o", scheduled_at: T + 60, artist: "Fleetwood Mac" }]),
      WIN)).toHaveLength(1);
  });

  it("warns on the same SONG by id, and reports the song rule not the artist rule", () => {
    const w = checkSeparation(
      { uuid: "me", song_id: 42, artist: "A" },
      T,
      ctx([{ uuid: "o", scheduled_at: T + 1800, song_id: 42, artist: "B" }]),
      WIN);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("Same song");
    expect(w[0]).toContain("180 min");
  });

  it("warns on the same TITLE by different artists (the cover-version rule)", () => {
    const w = checkSeparation(
      { uuid: "me", title: "Hallelujah", artist: "Jeff Buckley" },
      T,
      ctx([{ uuid: "o", scheduled_at: T + 900, title: "Hallelujah", artist: "Leonard Cohen" }]),
      WIN);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("Same title");
  });

  it("NEVER compares a row against itself — by uuid or by id", () => {
    expect(checkSeparation(
      { uuid: "me", id: 7, song_id: 1, artist: "A", title: "T" },
      T,
      ctx([{ uuid: "me", id: 7, scheduled_at: T, song_id: 1, artist: "A", title: "T" }]),
      WIN)).toEqual([]);
    expect(checkSeparation(
      { id: 7, song_id: 1, artist: "A" },
      T,
      ctx([{ id: 7, scheduled_at: T, song_id: 1, artist: "A" }]),
      WIN)).toEqual([]);
  });

  it("reports the STRONGEST violation once per neighbour, not three for one row", () => {
    // Same song implies same artist and same title. Three warnings for one clash is noise.
    const w = checkSeparation(
      { uuid: "me", song_id: 5, title: "T", artist: "A" },
      T,
      ctx([{ uuid: "o", scheduled_at: T + 60, song_id: 5, title: "T", artist: "A" }]),
      WIN);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("Same song");
  });

  it("warns for a neighbour BEFORE the target as well as after", () => {
    expect(checkSeparation(
      { uuid: "me", artist: "A" }, T,
      ctx([{ uuid: "o", scheduled_at: T - 600, artist: "A" }]), WIN)).toHaveLength(1);
  });
});

describe("checkSeparation — the past (play_log rest maps)", () => {
  it("warns when this artist aired recently, using buildRestMaps' REAL map names", () => {
    const w = checkSeparation(
      { uuid: "me", artist_id: 9, artist: "A" }, T,
      ctx([], { restByArtist: new Map([[9, T - 600]]) }), WIN);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("aired 10 min ago");
  });

  it("warns when this exact file aired recently", () => {
    const w = checkSeparation(
      { uuid: "me", file_path: "C:\\a.mp3" }, T,
      ctx([], { restByFile: new Map([["C:\\a.mp3", T - 60]]) }), WIN);
    expect(w[0]).toContain("This song aired");
  });

  it("ignores airplay in the FUTURE relative to the target — that is not a repeat", () => {
    expect(checkSeparation(
      { uuid: "me", artist_id: 9 }, T,
      ctx([], { restByArtist: new Map([[9, T + 600]]) }), WIN)).toEqual([]);
  });

  it("does not warn on a never-aired identity", () => {
    expect(checkSeparation(
      { uuid: "me", artist_id: 9, file_path: "x" }, T,
      ctx([], { restByArtist: new Map(), restByFile: new Map() }), WIN)).toEqual([]);
  });
});

describe("checkSeparation — never throws, never blocks", () => {
  it("returns [] for missing row or context rather than throwing", () => {
    expect(checkSeparation(null, T, ctx([]), WIN)).toEqual([]);
    expect(checkSeparation({ uuid: "me" }, T, null, WIN)).toEqual([]);
  });

  it("tolerates a missing rule set — a rule of 0/absent is simply not checked", () => {
    expect(checkSeparation(
      { uuid: "me", artist: "A" }, T,
      ctx([{ uuid: "o", scheduled_at: T + 60, artist: "A" }]), {})).toEqual([]);
    expect(checkSeparation(
      { uuid: "me", artist: "A" }, T,
      ctx([{ uuid: "o", scheduled_at: T + 60, artist: "A" }]), undefined)).toEqual([]);
  });

  it("skips malformed neighbours instead of failing the whole check", () => {
    const w = checkSeparation(
      { uuid: "me", artist: "A" }, T,
      ctx([null, { uuid: "x" }, { uuid: "o", scheduled_at: T + 60, artist: "A" }]), WIN);
    expect(w).toHaveLength(1);
  });

  it("does not warn on empty artist/title strings matching each other", () => {
    // Spots and talk breaks have no artist. Treating "" == "" as a violation would flag every break.
    expect(checkSeparation(
      { uuid: "me", artist: "", title: "" }, T,
      ctx([{ uuid: "o", scheduled_at: T + 60, artist: "", title: "" }]), WIN)).toEqual([]);
  });
});
