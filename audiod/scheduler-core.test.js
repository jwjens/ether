// Unit tests for the pure scheduler core (Phase 2.5, 2026-08-10).
//   npm test              (vitest — matches electron/ha-elevate.test.js, the repo's .test.js convention)
//
// The engine is pure, so these need no database, no daemon, no Electron and no clock. That is the
// point of the phase: the scheduler has never been unit-testable before.
//
// Design: docs/goal-driven-scheduler-redesign-2026-08-10.md §4 Phase 2.5
import { describe, it, expect } from "vitest";
import core from "./scheduler-core.js";

const { planHour, createState, rankCategories, lrpFallback, violationOf } = core;

const T0 = 1_754_000_000;          // a fixed epoch — the engine never reads a clock, so this is arbitrary
const MIN = 60;

const song = (id, over = {}) => ({
  id,
  title: over.title ?? `Song ${id}`,
  artist_id: over.artist_id ?? id * 100,
  artist_name: over.artist_name ?? `Artist ${id}`,
  category_id: over.category_id ?? 1,
  duration_ms: over.duration_ms ?? 180_000,      // 180s
  last_played_at: over.last_played_at ?? 0,
  ...over,
});

const musicSlot = (index, categoryId, durationS = 180) => ({ index, type: "music", categoryId, durationS });

const CONSTRAINTS = { songRepeatMin: 180, artistSepMin: 60, titleSepMin: 120 };

const CATS = [
  { id: 1, code: "GO", name: "Gold",  spinsPerHour: 4, priority: 0 },
  { id: 2, code: "PW", name: "Power", spinsPerHour: 2, priority: 0 },
];

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("purity", () => {
  it("returns identical output for identical input", () => {
    const build = () => planHour({
      slots: [musicSlot(0, 1), musicSlot(1, 1)],
      hourStartTs: T0, hour: 9, categories: CATS,
      candidatesByCategory: new Map([[1, [song(1), song(2), song(3)]]]),
      constraints: CONSTRAINTS,
    });
    const a = build(), b = build();
    expect(a.picks.map(p => p.songId)).toEqual(b.picks.map(p => p.songId));
    expect(a.endTs).toBe(b.endTs);
  });

  it("never reads a clock — timing derives only from hourStartTs and durations", () => {
    const r = planHour({
      slots: [musicSlot(0, 1, 180), musicSlot(1, 1, 180)],
      hourStartTs: T0, hour: 9, categories: CATS,
      candidatesByCategory: new Map([[1, [song(1), song(2)]]]),
      constraints: CONSTRAINTS,
    });
    expect(r.picks[0].scheduledAt).toBe(T0);
    expect(r.picks[1].scheduledAt).toBe(T0 + 180);   // first song's real duration, not the slot's
    expect(r.endTs).toBe(T0 + 360);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("clock-driven mode (parity with _generateDayRows)", () => {
  it("fills each slot from the category the clock names", () => {
    const r = planHour({
      slots: [musicSlot(0, 1), musicSlot(1, 2)],
      hourStartTs: T0, hour: 9, categories: CATS,
      candidatesByCategory: new Map([[1, [song(1)]], [2, [song(9, { category_id: 2 })]]]),
      constraints: CONSTRAINTS, mode: "clock",
    });
    expect(r.picks.map(p => [p.slotIndex, p.categoryId, p.songId])).toEqual([[0, 1, 1], [1, 2, 9]]);
    expect(r.picks.every(p => p.categoryId === p.slotCategoryId)).toBe(true);   // never leaves the slot's category
  });

  it("takes the FIRST compliant candidate in the given order (Tier 1)", () => {
    const r = planHour({
      slots: [musicSlot(0, 1)],
      hourStartTs: T0, hour: 9, categories: CATS,
      candidatesByCategory: new Map([[1, [song(7), song(1), song(2)]]]),
      constraints: CONSTRAINTS, mode: "clock",
    });
    expect(r.picks[0].songId).toBe(7);
    expect(r.picks[0].reasonCode).toBe("tier1_clock");
  });

  it("advances by the SLOT duration when nothing can be placed", () => {
    const r = planHour({
      slots: [musicSlot(0, 1, 240)],
      hourStartTs: T0, hour: 9, categories: CATS,
      candidatesByCategory: new Map([[1, []]]),
      constraints: CONSTRAINTS, mode: "clock",
    });
    expect(r.picks).toHaveLength(0);
    expect(r.skipped).toHaveLength(1);
    expect(r.endTs).toBe(T0 + 240);
    expect(r.diagnostics.emptyCategories).toEqual([1]);
  });

  it("does not select for non-music slots, but still advances time", () => {
    const r = planHour({
      slots: [{ index: 0, type: "spot_break", durationS: 60 }, musicSlot(1, 1)],
      hourStartTs: T0, hour: 9, categories: CATS,
      candidatesByCategory: new Map([[1, [song(1)]]]),
      constraints: CONSTRAINTS,
    });
    expect(r.picks).toHaveLength(1);
    expect(r.picks[0].scheduledAt).toBe(T0 + 60);
    expect(r.skipped[0].type).toBe("spot_break");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("constraint enforcement", () => {
  it("blocks the same artist inside the separation window", () => {
    const state = createState();
    state.artistLastTs.set(500, T0 - 30 * MIN);            // 30 min ago, window is 60
    const r = planHour({
      slots: [musicSlot(0, 1)],
      hourStartTs: T0, hour: 9, categories: CATS,
      candidatesByCategory: new Map([[1, [song(5, { artist_id: 500 }), song(6, { artist_id: 600 })]]]),
      constraints: CONSTRAINTS, state,
    });
    expect(r.picks[0].songId).toBe(6);                      // skipped the blocked artist
    expect(r.picks[0].detail.vetoed.artist_separation).toBe(1);
  });

  it("blocks a song replayed inside its repeat window", () => {
    const state = createState();
    state.songLastTs.set(1, T0 - 60 * MIN);                 // 60 min ago, window is 180
    const r = planHour({
      slots: [musicSlot(0, 1)],
      hourStartTs: T0, hour: 9, categories: CATS,
      candidatesByCategory: new Map([[1, [song(1), song(2)]]]),
      constraints: CONSTRAINTS, state,
    });
    expect(r.picks[0].songId).toBe(2);
  });

  it("blocks a duplicate title even from a different artist", () => {
    const r = planHour({
      slots: [musicSlot(0, 1), musicSlot(1, 1)],
      hourStartTs: T0, hour: 9, categories: CATS,
      candidatesByCategory: new Map([[1, [
        song(1, { title: "Halo" }),
        song(2, { title: "halo", artist_id: 777 }),         // same title, different artist
        song(3, { title: "Other" }),
      ]]]),
      constraints: CONSTRAINTS,
    });
    expect(r.picks.map(p => p.songId)).toEqual([1, 3]);      // the title clash was skipped
  });

  it("enforces dayparting when the song carries a mask", () => {
    const r = planHour({
      slots: [musicSlot(0, 1)],
      hourStartTs: T0, hour: 3, categories: CATS,
      candidatesByCategory: new Map([[1, [
        song(1, { daypart_mask: 0 }),                        // legal in no hour
        song(2, { daypart_mask: 1 << 3 }),                   // legal at 3am
      ]]]),
      constraints: CONSTRAINTS,
    });
    expect(r.picks[0].songId).toBe(2);
    expect(r.picks[0].constraintsApplied).toContain("daypart");
  });

  it("treats a song with no mask as unrestricted (caller pre-filtered — parity)", () => {
    expect(violationOf(song(1), T0, createState(), CONSTRAINTS, 3)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("fallback ladder", () => {
  it("falls back to least-recently-played and RECORDS what it relaxed", () => {
    const state = createState();
    state.artistLastTs.set(100, T0 - 1 * MIN);              // every candidate violates artist sep
    state.artistLastTs.set(200, T0 - 1 * MIN);
    const r = planHour({
      slots: [musicSlot(0, 1)],
      hourStartTs: T0, hour: 9, categories: CATS,
      // Both are well outside the 180-min song-repeat window, so ARTIST separation is the only rule
      // in play — otherwise the fallback reports song_separation too and the test proves nothing
      // about artist handling.
      candidatesByCategory: new Map([[1, [
        song(1, { artist_id: 100, last_played_at: T0 - 20_000 }),
        song(2, { artist_id: 200, last_played_at: T0 - 30_000 }),  // older → LRP winner
      ]]]),
      constraints: CONSTRAINTS, state,
    });
    expect(r.picks[0].songId).toBe(2);
    expect(r.picks[0].reasonCode).toBe("lrp_relaxed");
    expect(r.picks[0].relaxed).toContain("artist_separation");
    expect(r.diagnostics.relaxations).toBe(1);
  });

  it("keeps the EARLIER candidate on an LRP tie (strict <, matches _lrpFallback)", () => {
    const state = createState();
    const a = song(1, { last_played_at: 5000 }), b = song(2, { last_played_at: 5000 });
    expect(lrpFallback([a, b], state).id).toBe(1);
    expect(lrpFallback([b, a], state).id).toBe(2);
  });

  it("allows reuse (Tier 3) only when every candidate is already used", () => {
    const state = createState();
    state.usedSongIds.add(1);
    expect(lrpFallback([song(1)], state).id).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("goal-driven mode", () => {
  it("prioritises the category furthest behind pace", () => {
    const state = createState();
    state.spinsByCategory.set(1, 0);                        // Gold: target 4, none placed
    state.spinsByCategory.set(2, 2);                        // Power: target 2, already met
    const r = planHour({
      // Slot 0 names Power; the hour also uses Gold, so Gold is rankable here.
      slots: [musicSlot(0, 2), musicSlot(1, 1)],            // clock says Power first…
      hourStartTs: T0, hour: 9, categories: CATS,
      candidatesByCategory: new Map([[1, [song(1)]], [2, [song(9, { category_id: 2 })]]]),
      constraints: CONSTRAINTS, state, mode: "goal",
    });
    expect(r.picks[0].categoryId).toBe(1);                  // …goals said Gold
    expect(r.picks[0].slotCategoryId).toBe(2);              // the override is visible
    expect(r.picks[0].reasonCode).toBe("tier1_goal");
  });

  it("uses FRACTIONAL urgency — a 100% starved small target beats a partly-served large one", () => {
    const cats = [
      { id: 1, name: "Big",   spinsPerHour: 8, priority: 0 },
      { id: 2, name: "Small", spinsPerHour: 2, priority: 0 },
    ];
    const state = createState();
    state.spinsByCategory.set(1, 2);                        // 25% served
    state.spinsByCategory.set(2, 0);                        // 0% served — starved
    const ranked = rankCategories([1, 2], cats, state, 8, 8);
    expect(ranked[0].categoryId).toBe(2);                   // raw deficit would have picked Big (6 vs 2)
  });

  it("paces against position in the hour rather than the full-hour target", () => {
    const cats = [{ id: 1, name: "Gold", spinsPerHour: 4, priority: 0 }];
    const state = createState();
    state.spinsByCategory.set(1, 2);
    // Pace measures the position being FILLED, so index 4 of 10 means "half the hour once this lands":
    // target 4 × 0.5 = 2 expected, 2 placed → exactly on pace, urgency 0.
    expect(rankCategories([1], cats, state, 4, 10)[0].urgency).toBe(0);
    // Still 2 placed but nine-tenths through → 3.6 expected → behind.
    expect(rankCategories([1], cats, state, 8, 10)[0].urgency).toBeGreaterThan(0);
  });

  it("leaves a satisfied hour in clock order — goals never churn what already meets target", () => {
    const state = createState();
    state.spinsByCategory.set(1, 4);
    state.spinsByCategory.set(2, 2);
    const r = planHour({
      slots: [musicSlot(0, 2)],
      hourStartTs: T0, hour: 9, categories: CATS,
      candidatesByCategory: new Map([[1, [song(1)]], [2, [song(9, { category_id: 2 })]]]),
      constraints: CONSTRAINTS, state, mode: "goal",
    });
    expect(r.picks[0].categoryId).toBe(2);                  // the clock's own category
    expect(r.picks[0].reasonCode).toBe("goal_met");
  });

  it("moves to the next category when the preferred one has no legal song", () => {
    const state = createState();
    state.spinsByCategory.set(1, 0);                        // Gold most urgent…
    const r = planHour({
      // BOTH categories must appear in the hour's clock: goal mode ranks only across the categories
      // the clock actually uses (see "never selects a category the clock's hour does not use"), so a
      // single cat-2 slot would never even consider Gold.
      slots: [musicSlot(0, 2), musicSlot(1, 1)],
      hourStartTs: T0, hour: 9, categories: CATS,
      candidatesByCategory: new Map([[1, []], [2, [song(9, { category_id: 2 })]]]),   // …but empty
      constraints: CONSTRAINTS, state, mode: "goal",
    });
    expect(r.picks[0].categoryId).toBe(2);
    expect(r.diagnostics.emptyCategories).toContain(1);
  });

  it("never selects a category the clock's hour does not use", () => {
    const cats = [...CATS, { id: 3, name: "Unused", spinsPerHour: 99, priority: 9 }];
    const state = createState();
    const r = planHour({
      slots: [musicSlot(0, 1)],
      hourStartTs: T0, hour: 9, categories: cats,
      candidatesByCategory: new Map([[1, [song(1)]], [3, [song(30, { category_id: 3 })]]]),
      constraints: CONSTRAINTS, state, mode: "goal",
    });
    expect(r.picks[0].categoryId).toBe(1);                  // category 3 is not in this hour's clock
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("explainability", () => {
  it("every pick carries a human-readable reason and the constraints checked", () => {
    const r = planHour({
      slots: [musicSlot(0, 1)],
      hourStartTs: T0, hour: 9, categories: CATS,
      candidatesByCategory: new Map([[1, [song(1)]]]),
      constraints: CONSTRAINTS,
    });
    const p = r.picks[0];
    expect(typeof p.reason).toBe("string");
    expect(p.reason.length).toBeGreaterThan(0);
    expect(p.constraintsApplied).toEqual(expect.arrayContaining(["song_separation", "artist_separation", "title_separation"]));
  });

  it("names the goal figures in the reason, in the brief's phrasing", () => {
    const state = createState();
    state.spinsByCategory.set(1, 2);
    const r = planHour({
      slots: [musicSlot(0, 1)],
      hourStartTs: T0, hour: 9, categories: CATS,
      candidatesByCategory: new Map([[1, [song(1)]]]),
      constraints: CONSTRAINTS, state, mode: "goal",
    });
    expect(r.picks[0].reason).toMatch(/Gold below target \(2\/4\)/);
  });

  it("records the vetoed counts that produced the decision", () => {
    const state = createState();
    state.artistLastTs.set(100, T0 - 1 * MIN);
    const r = planHour({
      slots: [musicSlot(0, 1)],
      hourStartTs: T0, hour: 9, categories: CATS,
      candidatesByCategory: new Map([[1, [song(1, { artist_id: 100 }), song(2, { artist_id: 200 })]]]),
      constraints: CONSTRAINTS, state,
    });
    expect(r.picks[0].detail.vetoed.artist_separation).toBe(1);
    expect(r.picks[0].detail.poolSize).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("state threading", () => {
  it("carries separation memory across an hour so later slots see earlier picks", () => {
    const r = planHour({
      slots: [musicSlot(0, 1), musicSlot(1, 1)],
      hourStartTs: T0, hour: 9, categories: CATS,
      candidatesByCategory: new Map([[1, [song(1, { artist_id: 42 }), song(2, { artist_id: 42 }), song(3, { artist_id: 43 })]]]),
      constraints: CONSTRAINTS,
    });
    expect(r.picks.map(p => p.songId)).toEqual([1, 3]);      // song 2 shares artist 42 with the first pick
  });

  it("counts spins per category for the next hour to pace against", () => {
    const r = planHour({
      slots: [musicSlot(0, 1), musicSlot(1, 1)],
      hourStartTs: T0, hour: 9, categories: CATS,
      candidatesByCategory: new Map([[1, [song(1), song(2)]]]),
      constraints: CONSTRAINTS,
    });
    expect(r.state.spinsByCategory.get(1)).toBe(2);
  });
});
