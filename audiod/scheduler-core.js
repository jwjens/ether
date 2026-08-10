// ── SCHEDULER CORE — the pure selection engine (Phase 2.5, 2026-08-10) ───────────────────────────
//
// PURE. This module has no `require`, touches no database, reads no wall clock, and calls no
// Math.random(). Given the same inputs it returns the same plan, every time, forever. That is the
// whole point: the scheduler has never been unit-testable, so every change to it has been validated
// by generating a day and looking at it.
//
// It is also the instrument for Phase 3. A goal-driven scheduler cannot be evaluated by staring at
// its output — you have to be able to ask WHY each row was chosen, and the losing candidates only
// exist during the pick. So every pick carries a structured reason, recorded as it happens.
// (docs/goal-driven-scheduler-redesign-2026-08-10.md §3.2, §4 Phase 2.5)
//
// TWO MODES, ONE ENGINE:
//   mode 'clock' — today's behaviour. The slot names the category; the engine picks within it.
//   mode 'goal'  — the category is chosen from rotation goals; the slot's category is a hint.
// Clock mode is goal mode with the candidate pool restricted to one category. Not a fork.
//
// PARITY NOTE — read before wiring this in. Clock mode reproduces the logic of
// electron/main.js `_generateDayRows` (the music-slot branch at :6956-6992) exactly, including the
// Tier-1 order of checks and the Tier-2/3 `_lrpFallback` tie behaviour. It CANNOT reproduce the same
// OUTPUT by construction, because the live generator draws candidates with `ORDER BY RANDOM()`.
// Identical output requires the caller to pass candidates in the same order the query returned.
// Parity is therefore established by a differential run (Phase 3 shadow), never assumed here.
//
// NOT IN SCOPE: spot selection (traffic, `_pickSpot`), jingle placement (`_placeJingles`), clock
// structure, and time anchoring. Non-music slots only advance the cursor.

"use strict";

// ── Constants ────────────────────────────────────────────────────────────────────────────────────
const SEC = 60;

// ── Small pure helpers ───────────────────────────────────────────────────────────────────────────

/** Last time this song played, in the same precedence the live generator uses. */
function lastSongTs(song, state) {
  const v = state.songLastTs.get(song.id);
  return v === undefined ? (song.last_played_at || 0) : v;
}

function titleKeyOf(song) {
  return (song.title || "").trim().toLowerCase();
}

/**
 * Dayparting. The live generator filters daypart in SQL, so a caller passing the generator's own
 * candidates will find every song already legal here and this is a no-op — parity preserved.
 * Checked in-engine only when the song actually carries a mask, so a caller that does NOT pre-filter
 * still gets correct behaviour instead of silently skipping the rule.
 */
function daypartAllows(song, hour) {
  if (song.daypart_mask === undefined || song.daypart_mask === null) return true;
  if (typeof hour !== "number") return true;
  return (song.daypart_mask & (1 << hour)) !== 0;
}

/**
 * Tier 2/3 fallback — least-recently-played. Mirrors main.js `_lrpFallback` (:6617-6623) including
 * its tie behaviour: the reduce uses a STRICT `<`, so equal timestamps keep the EARLIER candidate.
 * Changing that to `<=` would silently reorder every tie in the log.
 */
function lrpFallback(candidates, state) {
  const lrp = (s) => lastSongTs(s, state);
  const fresh = candidates.filter((s) => !state.usedSongIds.has(s.id));
  const pool = fresh.length ? fresh : candidates;    // Tier 2 (unused this hour) then Tier 3 (allow reuse)
  if (!pool.length) return null;
  return pool.reduce((a, b) => (lrp(b) < lrp(a) ? b : a));
}

// ── Constraint evaluation ────────────────────────────────────────────────────────────────────────

/**
 * Why this song cannot be placed at `atTs`, or null if it can.
 * Order matches the live generator's check order so a differential run compares like with like.
 * Returns a violation code, never throws.
 */
function violationOf(song, atTs, state, c, hour) {
  if (state.usedSongIds.has(song.id)) return "already_used_this_hour";
  if (!daypartAllows(song, hour)) return "daypart";
  if (atTs - lastSongTs(song, state) < (c.songRepeatMin || 0) * SEC) return "song_separation";

  const tk = titleKeyOf(song);
  if (tk) {
    if (state.usedTitles.has(tk)) return "title_separation";
    const lastTitle = state.titleLastTs.get(tk) || 0;
    if (atTs - lastTitle < (c.titleSepMin || 0) * SEC) return "title_separation";
  }

  if (song.artist_id) {
    if (state.usedArtistIds.has(song.artist_id)) return "artist_separation";
    const lastArtist = state.artistLastTs.get(song.artist_id) || 0;
    if (atTs - lastArtist < (c.artistSepMin || 0) * SEC) return "artist_separation";
  }
  return null;
}

/**
 * EVERY rule this song breaks, not just the first.
 *
 * violationOf() short-circuits, which is right for Tier 1 (one veto is enough to move on) but wrong
 * for the relaxation report: a fallback pick that broke artist AND title separation would have been
 * recorded as breaking only artist, understating what the ladder actually bent. For a feature whose
 * purpose is explainability, a partial answer is a wrong one.
 */
function violationsOf(song, atTs, state, c, hour) {
  const out = [];
  if (state.usedSongIds.has(song.id)) out.push("already_used_this_hour");
  if (!daypartAllows(song, hour)) out.push("daypart");
  if (atTs - lastSongTs(song, state) < (c.songRepeatMin || 0) * SEC) out.push("song_separation");
  const tk = titleKeyOf(song);
  if (tk && (state.usedTitles.has(tk) || atTs - (state.titleLastTs.get(tk) || 0) < (c.titleSepMin || 0) * SEC)) out.push("title_separation");
  if (song.artist_id && (state.usedArtistIds.has(song.artist_id) || atTs - (state.artistLastTs.get(song.artist_id) || 0) < (c.artistSepMin || 0) * SEC)) out.push("artist_separation");
  return out;
}

/** First fully-compliant candidate, in the order given. Tier 1. */
function tier1(candidates, atTs, state, c, hour) {
  const vetoed = { already_used_this_hour: 0, daypart: 0, song_separation: 0, title_separation: 0, artist_separation: 0 };
  for (const song of candidates) {
    const v = violationOf(song, atTs, state, c, hour);
    if (v === null) return { song, vetoed };
    vetoed[v]++;
  }
  return { song: null, vetoed };
}

// ── Goal ranking ─────────────────────────────────────────────────────────────────────────────────

/**
 * Rank categories by how far BEHIND PACE they are.
 *
 * Pacing, not raw deficit. A 4-spins/hour category should have ~2 placed by the half-hour, not 4.
 * Without it a behind-pace category front-loads into consecutive positions and the hour sounds
 * lumpy — the classic naive-goal failure.
 *
 * Fractional, not absolute. Raw deficit makes target-8/placed-2 (25% served, deficit 6) always beat
 * target-2/placed-0 (0% served, deficit 2), even though the second is completely starved.
 *
 * Categories with no declared target (null/0) score 0 urgency and sort last — they remain eligible
 * (a clock can still name them) but never outrank a category the PD actually asked for.
 */
function rankCategories(categoryIds, categories, state, musicIndex, musicTotal) {
  const byId = new Map(categories.map((c) => [c.id, c]));
  // Pace against the position being FILLED, not the ones already filled. With `musicIndex/musicTotal`
  // the first music slot of every hour has elapsed = 0, so paced = 0, so nothing can be behind pace —
  // goals were silently ignored for slot 0 of every hour. `(musicIndex + 1)/musicTotal` asks "where
  // should we be once this pick is made", which also makes the pacing self-consistent: a 4/hr target
  // over 4 positions lands on exactly 4. (Caught by the goal-mode unit tests, 2026-08-10.)
  const elapsed = musicTotal > 0 ? (musicIndex + 1) / musicTotal : 0;
  return categoryIds
    .map((id) => {
      const cat = byId.get(id) || {};
      const target = cat.spinsPerHour > 0 ? cat.spinsPerHour : 0;
      const placed = state.spinsByCategory.get(id) || 0;
      const paced = target * elapsed;
      const urgency = target > 0 ? (paced - placed) / Math.max(target, 1) : 0;
      return { categoryId: id, target, placed, paced, urgency, priority: cat.priority || 0 };
    })
    .sort((a, b) => (b.urgency - a.urgency) || (b.priority - a.priority) || (a.categoryId - b.categoryId));
}

// ── Reason rendering ─────────────────────────────────────────────────────────────────────────────

function renderReason(r) {
  const cat = r.categoryName || ("category " + r.categoryId);
  if (r.code === "tier1_clock")  return `${cat}: clock slot, first compliant candidate of ${r.poolSize}`;
  if (r.code === "tier1_goal")   return `${cat} below target (${r.goal.placed}/${r.goal.target}) — prioritised, first compliant of ${r.poolSize}`;
  if (r.code === "lrp_relaxed")  return `${cat}: no compliant candidate of ${r.poolSize} — least-recently-played, ${r.relaxed.join(" + ")} relaxed`;
  if (r.code === "goal_met")     return `${cat}: all targets met, clock order`;
  if (r.code === "empty")        return `${cat}: no candidates available`;
  return `${cat}: ${r.code}`;
}

// ── Selection for one music position ─────────────────────────────────────────────────────────────

function pickForCategory(categoryId, candidates, atTs, state, c, hour) {
  if (!candidates || !candidates.length) return { song: null, relaxed: [], vetoed: {}, poolSize: 0 };
  const t1 = tier1(candidates, atTs, state, c, hour);
  if (t1.song) return { song: t1.song, relaxed: [], vetoed: t1.vetoed, poolSize: candidates.length };

  // Tier 2/3 — the ladder bends, and says which rule it bent. A relaxation that is not recorded is
  // indistinguishable from a clean pick, which is how "never dead air" becomes dishonest.
  const song = lrpFallback(candidates, state);
  if (!song) return { song: null, relaxed: [], vetoed: t1.vetoed, poolSize: candidates.length };
  return {
    song,
    relaxed: violationsOf(song, atTs, state, c, hour),   // ALL rules bent, not just the first
    vetoed: t1.vetoed,
    poolSize: candidates.length,
  };
}

/** Commit a pick into the running state. Mirrors main.js :6983-6988 exactly. */
function commit(song, categoryId, atTs, state) {
  state.usedSongIds.add(song.id);
  if (song.artist_id) {
    state.usedArtistIds.add(song.artist_id);
    state.artistLastTs.set(song.artist_id, atTs);
  }
  const tk = titleKeyOf(song);
  if (tk) {
    state.usedTitles.add(tk);
    state.titleLastTs.set(tk, atTs);
  }
  state.songLastTs.set(song.id, atTs);
  state.spinsByCategory.set(categoryId, (state.spinsByCategory.get(categoryId) || 0) + 1);
}

// ── Public API ───────────────────────────────────────────────────────────────────────────────────

/**
 * Build the mutable state the engine threads through an hour. Callers own it, so an hour can be
 * seeded from real history (play_log) and successive hours can share separation memory.
 */
function createState(seed) {
  const s = seed || {};
  return {
    usedSongIds:   s.usedSongIds   || new Set(),
    usedArtistIds: s.usedArtistIds || new Set(),
    usedTitles:    s.usedTitles    || new Set(),
    songLastTs:    s.songLastTs    || new Map(),
    artistLastTs:  s.artistLastTs  || new Map(),
    titleLastTs:   s.titleLastTs   || new Map(),
    spinsByCategory: s.spinsByCategory || new Map(),
  };
}

/**
 * Plan one hour.
 *
 * @param {object}  input
 * @param {Array}   input.slots         [{ index, type:'music'|'spot_break'|'talk'|…, categoryId, durationS }]
 * @param {number}  input.hourStartTs    unix seconds — SUPPLIED, never read from a clock
 * @param {number}  input.hour           0-23, for dayparting
 * @param {Array}   input.categories     [{ id, code, name, spinsPerHour, priority }]
 * @param {Map}     input.candidatesByCategory  Map<categoryId, song[]> — caller's order is preserved
 * @param {object}  input.constraints    { songRepeatMin, artistSepMin, titleSepMin }
 * @param {object}  [input.state]        from createState(); created fresh if omitted
 * @param {string}  [input.mode]         'clock' (default) | 'goal'
 * @returns {{ picks:Array, skipped:Array, state:object, endTs:number, diagnostics:object }}
 */
function planHour(input) {
  const mode = input.mode === "goal" ? "goal" : "clock";
  const state = input.state || createState();
  const c = input.constraints || {};
  const hour = input.hour;
  const cats = input.categories || [];
  const catName = new Map(cats.map((x) => [x.id, x.name || x.code || ("#" + x.id)]));
  const pools = input.candidatesByCategory || new Map();
  const slots = input.slots || [];

  const musicSlots = slots.filter((s) => s.type === "music" && s.categoryId != null);
  const musicTotal = musicSlots.length;
  // Every category this hour may legally draw from. Goal mode ranks across these; it never invents a
  // category the clock's hour does not touch, which keeps the widened on-format guard bounded.
  const clockCategoryIds = [...new Set(musicSlots.map((s) => s.categoryId))];

  const picks = [], skipped = [];
  const diagnostics = { emptyCategories: new Set(), relaxations: 0, mode };
  let ts = input.hourStartTs;
  let musicIndex = 0;

  for (const slot of slots) {
    const slotDur = slot.durationS || 0;

    if (slot.type !== "music" || slot.categoryId == null) {
      skipped.push({ slotIndex: slot.index, type: slot.type, scheduledAt: ts, reason: "not a music slot — engine does not select spots or imaging" });
      ts += slotDur;
      continue;
    }

    // Which categories to try, in order.
    let order, ranking = null;
    if (mode === "goal") {
      ranking = rankCategories(clockCategoryIds, cats, state, musicIndex, musicTotal);
      order = ranking.map((r) => r.categoryId);
      // Nothing is behind pace → keep the clock's own order. Goals never churn a satisfied hour.
      if (!ranking.some((r) => r.urgency > 0)) order = [slot.categoryId, ...order.filter((id) => id !== slot.categoryId)];
    } else {
      order = [slot.categoryId];
    }

    let chosen = null, chosenCat = null, res = null;
    for (const catId of order) {
      const pool = pools.get(catId) || [];
      if (!pool.length) { diagnostics.emptyCategories.add(catId); continue; }
      const r = pickForCategory(catId, pool, ts, state, c, hour);
      if (r.song) { chosen = r.song; chosenCat = catId; res = r; break; }
    }

    if (!chosen) {
      skipped.push({ slotIndex: slot.index, type: "music", categoryId: slot.categoryId, scheduledAt: ts, reason: renderReason({ code: "empty", categoryId: slot.categoryId, categoryName: catName.get(slot.categoryId) }) });
      ts += slotDur;
      musicIndex++;
      continue;
    }

    const goalRow = ranking ? ranking.find((r) => r.categoryId === chosenCat) : null;
    const code = res.relaxed.length ? "lrp_relaxed"
               : mode === "goal" ? (goalRow && goalRow.urgency > 0 ? "tier1_goal" : "goal_met")
               : "tier1_clock";

    const reasonParts = {
      code, categoryId: chosenCat, categoryName: catName.get(chosenCat),
      poolSize: res.poolSize, relaxed: res.relaxed,
      goal: goalRow ? { target: goalRow.target, placed: goalRow.placed, paced: Math.round(goalRow.paced * 100) / 100, urgency: Math.round(goalRow.urgency * 1000) / 1000 } : null,
    };

    const constraintsApplied = ["song_separation", "artist_separation", "title_separation"];
    if (chosen.daypart_mask !== undefined && chosen.daypart_mask !== null) constraintsApplied.push("daypart");
    if (mode === "goal") constraintsApplied.push("rotation_goal");

    commit(chosen, chosenCat, ts, state);
    if (res.relaxed.length) diagnostics.relaxations++;

    const durationS = chosen.duration_ms ? Math.round(chosen.duration_ms / 1000) : slotDur;
    picks.push({
      slotIndex: slot.index,
      scheduledAt: ts,
      songId: chosen.id,
      categoryId: chosenCat,
      slotCategoryId: slot.categoryId,        // differs from categoryId only when a goal overrode the clock
      durationS,
      reason: renderReason(reasonParts),
      reasonCode: code,
      constraintsApplied,
      relaxed: res.relaxed,
      detail: { poolSize: res.poolSize, vetoed: res.vetoed, goal: reasonParts.goal, mode },
    });

    ts += durationS;
    musicIndex++;
  }

  diagnostics.emptyCategories = [...diagnostics.emptyCategories];
  return { picks, skipped, state, endTs: ts, diagnostics };
}

module.exports = {
  planHour,
  createState,
  // Slot-level entry — the live generator's clock-mode authority (electron/main.js _generateDayRows).
  // Deliberately does NOT commit: the caller owns every state mutation, so the generator's own maps
  // can be handed in as a view and the engine cannot drift out of step with the rows being written.
  pickForCategory,
  // exported for targeted tests — all pure
  rankCategories,
  lrpFallback,
  violationOf,
  daypartAllows,
};
