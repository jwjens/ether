// audiod/scheduler-core.test.js — THE ONE PICK (Phase 2, docs/scheduler-rotation-playout-design.md §3.2).
// The old tests here exercised planHour / pickForCategory / lrpFallback (goal ranking, the least-recently-played
// fallback that broke rules to fill a slot). Those are deleted; these pin what replaced them.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
const core = require_("./scheduler-core.js");

const T0 = 1_800_000_000;
const MIN = 60;
const song = (id, over = {}) => ({ id, title: `Song ${id}`, artist: `Artist ${id}`, file: `C:/m/song${id}.mp3`, duration_ms: 180_000, ...over });
const RULES = { songMin: 120, artistMin: 60, titleMin: 120 };
const tlWith = (...events) => { const tl = new core.Timeline(); for (const [s, ts] of events) core.commit(tl, s, ts); return tl; };

describe("the rules are obeyed, against what aired AND the log on either side", () => {
  it("a song inside its separation is never picked, even if it waited longest", () => {
    const a = song(1), b = song(2);
    const tl = tlWith([a, T0 - 30 * MIN], [b, T0 - 10 * 3600]);
    expect(core.pick([a, b], T0, tl, RULES).song.id).toBe(2);
  });
  it("the AFTER side counts: a song already in the log 30 min later is blocked now", () => {
    const a = song(1), b = song(2);
    const tl = tlWith([a, T0 + 30 * MIN], [b, T0 - 3 * 3600]);
    expect(core.pick([a, b], T0, tl, RULES).song.id).toBe(2);
  });
  it("artist: every credited artist; title: the normalised title", () => {
    const tl = tlWith([song(9, { artist: "Danny Elfman & Catherine O'Hara", title: "This Is Halloween (2006)" }), T0 - 20 * MIN]);
    const byArtist = song(1, { artist: "Catherine O'Hara" });
    const byTitle = song(2, { title: "This Is Halloween - From The Nightmare Before Christmas" });
    const free = song(3);
    expect(core.pick([byArtist, byTitle, free], T0, tl, RULES).song.id).toBe(3);
  });
  it("a gap EQUAL to the rule passes; one second shorter does not", () => {
    const a = song(1);
    expect(core.pick([a], T0, tlWith([a, T0 - 120 * MIN]), RULES).song.id).toBe(1);
    expect(core.pick([a], T0, tlWith([a, T0 - 120 * MIN + 1]), RULES).song).toBe(null);
  });
  it("a rule that is off is off — nothing is assumed in its place", () => {
    const a = song(1);
    expect(core.pick([a], T0, tlWith([a, T0 - 5 * MIN]), { songMin: null, artistMin: null, titleMin: null }).song.id).toBe(1);
  });
  it("per-song no-repeat hours: its own window, when longer than the song rule", () => {
    const a = song(1, { noRepeatHours: 6 });
    expect(core.pick([a], T0, tlWith([a, T0 - 3 * 3600]), RULES).song).toBe(null);
    expect(core.pick([a], T0, tlWith([a, T0 - 6 * 3600]), RULES).song.id).toBe(1);
  });
});

describe("the pick: the longest-waiting song that passes; random only for an exact tie", () => {
  it("never aired waits longest", () => {
    const a = song(1), b = song(2);
    expect(core.pick([a, b], T0, tlWith([a, T0 - 20 * 3600]), RULES).song.id).toBe(2);
  });
  it("of those that aired, the one that aired longest ago", () => {
    const a = song(1), b = song(2), c = song(3);
    const tl = tlWith([a, T0 - 5 * 3600], [b, T0 - 9 * 3600], [c, T0 - 7 * 3600]);
    expect(core.pick([a, b, c], T0, tl, RULES).song.id).toBe(2);
  });
  it("an exact tie is broken by the random source, and only then", () => {
    const a = song(1), b = song(2);
    expect(core.pick([a, b], T0, new core.Timeline(), RULES, () => 0).song.id).toBe(1);
    expect(core.pick([a, b], T0, new core.Timeline(), RULES, () => 0.99).song.id).toBe(2);
    expect(core.pick([a, b], T0, tlWith([a, T0 - 9 * 3600]), RULES, () => 0).song.id).toBe(2);   // not a tie
  });
  it("this run's own placement counts as last aired from then on (a week cannot repeat one song)", () => {
    const pool = [song(1), song(2), song(3)];
    const tl = new core.Timeline();
    const got = [];
    for (let i = 0; i < 6; i++) { const r = core.pick(pool, T0 + i * 3 * 3600, tl, RULES, () => 0); core.commit(tl, r.song, T0 + i * 3 * 3600); got.push(r.song.id); }
    expect(got).toEqual([1, 2, 3, 1, 2, 3]);
  });
});

describe("nothing passes: UNSCHEDULED, with the rule — never a rule broken to fill the slot", () => {
  it("returns no song and names the closest songs and their rules", () => {
    const a = song(1), b = song(2, { artist: "Artist 1" });
    const r = core.pick([a, b], T0, tlWith([a, T0 - 50 * MIN]), RULES);
    expect(r.song).toBe(null);
    expect(r.closest[0].rule).toBe("artist");
    expect(r.closest[0].measuredMin).toBe(50);
  });
});

describe("identity", () => {
  it("one recording on two song rows is one song (by its stored file name)", () => {
    const a = song(1, { file: "C:/x/Thriller.mp3" }), dup = song(2, { file: "D:\\y\\thriller.MP3", artist: "Other", title: "Other" });
    expect(core.pick([dup], T0, tlWith([a, T0 - 30 * MIN]), RULES).song).toBe(null);
  });
});

describe("title rule: same name AND same length (Jeff, 2026-10-19)", () => {
  it("same title, different length is a different song — the title rule does not block it", () => {
    const kids = song(1, { title: "A Nightmare On My Street", artist: "kids bop", duration_ms: 235_500, file: "C:/m/kids.mp3" });
    const will = song(2, { title: "A Nightmare On My Street", artist: "Will Smith", duration_ms: 298_700, file: "C:/m/will.mp3" });
    expect(core.pick([will], T0, tlWith([kids, T0 - 30 * MIN]), RULES).song.id).toBe(2);
  });
  it("same title and the same length to the second is the same song — blocked", () => {
    const a = song(1, { title: "Thriller", artist: "A", duration_ms: 357_900, file: "C:/m/a.mp3" });
    const b = song(2, { title: "Thriller (Remaster)", artist: "B", duration_ms: 358_100, file: "C:/m/b.mp3" });
    expect(core.pick([b], T0, tlWith([a, T0 - 30 * MIN]), RULES).song).toBe(null);
  });
});

describe("nothing passes → least recently played (Jeff, 2026-10-19)", () => {
  it("returns the pool's least recently played song and the rule it breaks", () => {
    const a = song(1), b = song(2), c = song(3);
    const tl = tlWith([a, T0 - 50 * MIN], [b, T0 - 90 * MIN], [c, T0 - 20 * MIN]);
    expect(core.pick([a, b, c], T0, tl, RULES).song).toBe(null);
    const r = core.leastRecent([a, b, c], T0, tl, RULES);
    expect(r.song.id).toBe(2);
    expect(r.broke.rule).toBe("song");
  });
  it("once every song has played, the first one played comes round again", () => {
    const pool = [song(1), song(2), song(3)];
    const tl = new core.Timeline(); const got = [];
    for (let i = 0; i < 6; i++) {
      const ts = T0 + i * 4 * MIN;
      const r = core.pick(pool, ts, tl, RULES, () => 0).song ? core.pick(pool, ts, tl, RULES, () => 0) : core.leastRecent(pool, ts, tl, RULES, () => 0);
      core.commit(tl, r.song, ts); got.push(r.song.id);
    }
    expect(got).toEqual([1, 2, 3, 1, 2, 3]);
  });
  it("an empty pool has no song", () => {
    expect(core.leastRecent([], T0, new core.Timeline(), RULES).song).toBe(null);
  });
});

// ── STRICT / SOFT and max in a row (dead-controls item 36; Jeff's 5b and 6c, 2026-10-30) ──────────────────────────
describe("STRICT / SOFT: SOFT rules are relaxed first, STRICT holds", () => {
  const SOFT_ARTIST = { songMin: 120, artistMin: 60, titleMin: 120, hard: { song: true, artist: false, title: true } };
  it("with strictOnly, a SOFT rule doesn't block; a STRICT one still does", () => {
    const a = song(1, { artist: "Same" }), b = song(2, { artist: "Same" });
    const tl = tlWith([song(9, { artist: "Same" }), T0 - 10 * MIN], [b, T0 - 30 * MIN]);
    expect(core.pick([a], T0, tl, SOFT_ARTIST).song).toBe(null);                                   // all rules: blocked by artist
    expect(core.pick([a], T0, tl, SOFT_ARTIST, Math.random, { strictOnly: true }).song.id).toBe(1); // SOFT artist relaxed
    expect(core.pick([b], T0, tl, SOFT_ARTIST, Math.random, { strictOnly: true }).song).toBe(null); // STRICT song rule holds
    expect(core.breach(tl, a, T0, SOFT_ARTIST).rule).toBe("artist");                                // the row can say what bent
  });
  it("a rule with no STRICT/SOFT setting is STRICT", () => {
    const a = song(1, { artist: "Same" });
    const tl = tlWith([song(9, { artist: "Same" }), T0 - 10 * MIN]);
    expect(core.pick([a], T0, tl, RULES, Math.random, { strictOnly: true }).song).toBe(null);
  });
});

describe("the station's rules from the database", () => {
  const db = (rows) => ({ prepare: () => ({ all: () => rows }) });
  it("reads STRICT/SOFT per rule and max in a row", () => {
    const r = core.stationRules(db([
      { rule_type: "song_separation_min", value: 180, is_hard: 1 }, { rule_type: "artist_separation_min", value: 60, is_hard: 0 },
      { rule_type: "max_same_category", value: 3, is_hard: 1 },
    ]), 1);
    expect(r).toMatchObject({ songMin: 180, artistMin: 60, hard: { song: true, artist: false }, maxRow: { n: 3, hard: true } });
  });
  it("max in a row: one too many from the same category", () => {
    const rules = { maxRow: { n: 3, hard: true } };
    expect(core.overMaxRow({ cat: 5, n: 3 }, 5, rules)).toBe(true);
    expect(core.overMaxRow({ cat: 5, n: 2 }, 5, rules)).toBe(false);
    expect(core.overMaxRow({ cat: 5, n: 3 }, 6, rules)).toBe(false);
    expect(core.overMaxRow({ cat: 5, n: 9 }, 5, { maxRow: null })).toBe(false);
  });
});
