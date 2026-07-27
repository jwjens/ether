# Separation — real enforced, toggleable feature — DESIGN (no code yet)

**Date:** 2026-07-27 · **Branch:** log-reader-flip · **Status:** DESIGN — STOP for GO before building.
**Method:** read-only against source + a copy of the live DB (`scratchpad/diag.db`).

This doc also resolves the **"violator-before-clean" bug trace** Jeff asked for — because
that bug IS the motivation, and its root (Generate reads the wrong last-played source) is
the same thing enforcement must fix.

---

## PART 0 — Bug trace: why a violator is followed by clean songs

**Verdict: NOT clock-pin, NOT an inverted sort. It is a selection-logic + data-source defect
(path/data).**

Reconstructed pick sequence, station 3 "Magical Forest", real `generated_schedule` vs real
`play_log` (`scripts/diag-sep-order.js`), song_separation_min = 120 min:

```
pos scheduled_at         earlyBySec  status          title
  0 2026-07-27 00:28:13     7137     VIOLATOR(119m)  Christmas Wrapping
  1..6                       ~7100   VIOLATOR(118-9m) …6 more…
  7 2026-07-27 00:51:52        0     clean           Celebrate (It's Christmas)
  8..9                          0     clean           …2 more…
 10 2026-07-27 01:00:30     7181     VIOLATOR(120m)  The Santa Wrap
 11..19                     ~7150   VIOLATOR          …9 more…
 20 2026-07-27 01:31:32        0     clean           Here Comes Santa Claus
 21..24                        0     clean           …4 more…
```

Violators sit **before** clean songs — impossible under correct LRP. Cause, with receipts:

1. **The candidate order is RANDOM, and Tier-1 takes the first compliant — it is NOT LRP.**
   `stmtCandidates` = `… ORDER BY RANDOM()` (`electron/main.js:5991`). `selectMusic` loops
   that random list and `picked = song; break` on the **first** that passes the rest gate
   (`main.js:6151`). Least-recently-played only governs the Tier-2/3 *fallback* `_lrpFallback`
   (`main.js:6001,6166`), which fires only when *nothing* passes.

2. **The rest gate reads the WRONG, near-empty source.** The gate seeds from
   `songs.last_played_at` (`main.js:6141`: `songLastTs.get(id) ?? (song.last_played_at || 0)`).
   Receipts on the copy: **`songs.last_played_at` populated 54/530**, while **`play_log` has
   15,217 rows** (station 3 = 6,035). The daemon airplay path writes **`play_log`**
   (`audiod/playlog.js:54`), and **never** writes `songs.last_played_at` (confirmed — it only
   bumps `spots.last_played_at`, `playlog.js:60`). So a song that aired minutes ago reads as
   `last_played_at = 0 → infinitely rested` → passes the gate → is eligible → and RANDOM order
   drops it wherever, including ahead of songs that never aired (which score "clean").
   The **in-run maps** (`songLastTs/artistLastTs/titleLastTs`) reset each run, so at run start
   nothing is rested either.

3. **Not clock-pin:** `SELECT COUNT(*) FROM clock_slots WHERE song_id IS NOT NULL` = **0** on
   every station. All music is category-fill (`main.js:6242`), none pinned (`main.js:6254`).

4. **The lint is right; Generate is blind.** `lintUpcoming` (`library-health.js:153`) measures
   against `play_log` (real airplay) — the same method as the reconstruction above — so the
   "N min early" chip is correct. Generate simply never saw the violation because it read
   `songs.last_played_at`. The daemon airs `generated_schedule` verbatim (Tier 0,
   `loggen.js:328`), so Generate's authored order is what airs.

**One-line answer:** path/data — Generate places the first RANDOM candidate that looks rested
against a near-empty `songs.last_played_at`, so recently-aired songs (per `play_log`) are
mis-judged eligible and land ahead of genuinely-rested songs. Fixing enforcement = ordering
eligible candidates by LRP and judging rest from `play_log`.

---

## PART 1 — Enforcement at pick time (#1)

**Applies to every CATEGORY-FILL music pick** in both authoring and playout:
- Generate: `selectMusic` (`electron/main.js:6134`) + the sequential slot-walk twin
  (`main.js:6289-6307`).
- Daemon fill: `loggen.pickTier` Tier-1 (`audiod/loggen.js` — currently `ORDER BY RANDOM()`,
  line ~121) and `pickFromClock`. (Daemon Tier-0 just replays `generated_schedule`, so once
  Generate is correct the live queue is correct; the daemon tiers only fire when the log is
  empty, but must obey the same rule.)
- The in-process twin `src/audio/loggen.ts`.

**Algorithm (per category-fill slot, when enforcement ON):**
1. Candidate pool = category ∩ active ∩ MUSIC ∩ daypart ∩ (not used-this-run).
2. For each candidate compute `lastAir = max(play_log last air for its file_path on THIS
   station, in-run placement ts)`. **Source = `play_log`, station-scoped, by `file_path`** —
   NOT `songs.last_played_at`.
3. **Eligible** = candidates whose song/artist/title windows are all satisfied at the slot's ts.
4. **Order eligible by LRP** (oldest `lastAir` first) and pick the first → the most-rested
   eligible song. (This is the change: LRP-ordered, not RANDOM-first-compliant.)
5. **Exhausted** (no eligible candidate): relax by **shortest overage** — pick the candidate
   whose window is closest to satisfied, i.e. the greatest `slotTs − lastAir` (= LRP among the
   too-soon). Place it (**never dead air**) and emit a **loud health event**
   (`separation-relaxed`: station, category, song, which rule, seconds-over). Reuse the
   existing relaxation channel: Generate already collects `ctx.relaxed` and
   `library-health.noteGenerate` already emits `generate-relaxed` (`library-health.js:337`);
   the daemon emits via `engine.emit` → main health ledger (the `fill-starved` pattern shipped
   in 4.4.87).

Anchor-fit (`main.js:6156`) stays: it already picks within the **compliant** pool; it just
consumes the new LRP-ordered eligible set.

**Performance constraint (hard):** do NOT run a `play_log` subquery per-candidate-per-slot.
A full day × many slots × candidates would freeze the main loop — this exact pattern caused a
17s freeze fixed on 2026-07-22 (`library-health.js:96-99`). Enforcement must **pre-load one
per-station `file_path → last_air` map from `play_log` once per Generate run** (and refresh it
in the daemon on its refill cadence), then look up in memory. This is a first-class part of the
build, not an afterthought.

---

## PART 2 — Clock-is-law conflict (#2)

- **Pinned slot** (`clock_slots.song_id IS NOT NULL`, `main.js:6254`): the operator chose that
  exact song for that slot. **Enforcement DEFERS — place it regardless of rest, no override.**
  A too-soon pinned song is a deliberate choice, not a violation to fix. (Optional: emit an
  informational `pinned-too-soon` note for visibility, but never move/replace it.)
- **Category-fill slot** (`song_id IS NULL`, picker chooses): **enforcement APPLIES** (Part 1).
- **Spot / JIN / SWP** slots: out of scope (not music rest).

Net: enforcement governs exactly the slots where the picker has a choice. Today every slot is
category-fill (0 pins), so in practice enforcement covers all music now; the pin carve-out is
the explicit rule for when pins exist.

---

## PART 3 — The toggle (#3)

- **Home:** `station_config_kv` (per-station key/value; same table as
  `overlay_fallback_category_id`, `main.js:6023`). Key `enforce_separation`, value `'1'|'0'`.
- **UI:** the **Programming** surface — the Separation rules already live in
  `src/components/RulesEditor.tsx`; add an "Enforce separation" on/off there (per station).
- **Read path:** Generate reads it in `_buildScheduleCtx` (`main.js:5955`); the daemon reads it
  in a `sepConfig`-style helper (`loggen.js:21`, already station-scoped). Both gate the Part-1
  algorithm.
- **Semantics:** OFF = today's behavior (rest ignored at pick, warn-only lint stays). ON = Part 1.
- **Default: recommend OFF (opt-in)** so no existing station's rotation changes without the
  operator turning it on — consistent with this codebase's flag/canary discipline. (Jeff's call;
  ON-by-default is a one-line default flip if he prefers correctness-first.)
- **Sync:** confirm `station_config_kv` replicates so the toggle set in the dashboard reaches the
  install (handler `electron/sync/handlers/station_programming.js` / kv path) — **flagged**.

---

## PART 4 — Data dependency (#4)

- **Enforcement reads `play_log`, not `songs.last_played_at`.** `play_log` is populated on every
  air by `audiod/playlog.js:54` (station_id + file_path + played_at) — 15,217 rows on the copy.
  `songs.last_played_at` is 54/530 and **never written by the daemon** — using it is the Part-0
  bug. So: **no backfill is required** for enforcement, *provided it keys off `play_log`.*
- The daemon fill path already reads `play_log` for song/artist separation
  (`loggen.js:43-54`). The **fix is on the Generate side**: switch its rest source from
  `songs.last_played_at` (`main.js:6141,6148,6002`) to the pre-loaded `play_log` map.
- Match key is `file_path`. This interacts with the orphan/duplicate-file issue fixed in 4.4.87
  (a song's rest is only seen under its own `file_path`); no new work, just noted.
- `songs.last_played_at` can stay as-is (other consumers may read it); optionally start writing
  it on air for parity — **out of scope** for this feature.

---

## PART 5 — Rules in scope + rest-window source (#5)

**In scope** (the three Generate + lint already compute):
- **song-repeat** — `main.js:6142`, `loggen.js:43-46`, `library-health.js:159`.
- **artist** — `main.js:6149`, `loggen.js:48-54`, `library-health.js:161`.
- **title** — `main.js:6146` (Generate computes it; the daemon/lint currently do song+artist —
  title enforcement in the daemon tiers would be new but small).

**Out of scope:** `max_same_gender`, `max_same_category` (sequencing constraints, not rest
windows) — flag as a later, separate feature.

**Rest-window source — resolve the current split (must pick one):**
- Generate uses `separation_rules.song_separation_min` (global) for song-repeat
  (`main.js:5960`).
- Daemon + lint use **per-song `no_repeat_hours`** (COALESCE 3h) for song-repeat
  (`loggen.js:45`, `library-health.js:159`), and `separation_rules` for artist.
- **Decision (recommended):** song-repeat window = **per-song `no_repeat_hours` when set, else
  station `separation_rules.song_separation_min`, else default** — honors per-song overrides
  while keeping a station default, and unifies Generate with the daemon/lint. Artist/title
  windows from `separation_rules` (per station).
- **Station-scoping fix (prerequisite, small):** Generate reads `separation_rules` **without a
  station_id** (`main.js:5958-5963`: `… WHERE rule_type=? AND is_active=1 LIMIT 1`) → it picks
  some station's rule at random. `loggen.sepConfig` scopes by station (`loggen.js:23`).
  Enforcement must read per-station rules in Generate too.

---

## Blast radius

| Area | File(s) | Change |
|---|---|---|
| Generate selection | `electron/main.js` `_buildScheduleCtx` 5955, `selectMusic` 6134, slot-walk 6289 | LRP-order eligible from a pre-loaded `play_log` map; per-station rules; toggle gate; relax+health-event |
| Daemon fill | `audiod/loggen.js` `sepConfig` 21, `baseConditions` 36, `pickTier` ~115 | toggle gate; Tier-1 LRP order; title window; per-run `play_log` map |
| In-process twin | `src/audio/loggen.ts` | mirror the above (cold-stage fallback) |
| Toggle UI | `src/components/RulesEditor.tsx` (Programming) | per-station "Enforce separation"; writes `station_config_kv` |
| Toggle read | `electron/main.js`, `audiod/loggen.js` | read `enforce_separation` per station |
| Health/observability | `electron/library-health.js` (reuse `noteGenerate`/`generate-relaxed`), `audiod/engine.js`→`main.js` ledger | `separation-relaxed` events; keep the lint as the monitor |
| Sync | `electron/sync/handlers/station_programming.js` (kv) | confirm `station_config_kv` replicates the toggle |
| Perf | Generate + daemon | one `play_log` scan per run, in-memory map — mandatory (2026-07-22 freeze precedent) |

**Explicitly NOT building:** `max_same_gender`/`max_same_category` enforcement; backfilling or
writing `songs.last_played_at`; turning the lint into a hard blocker at playout (playout still
airs the authored log; enforcement happens at authoring/fill); changing pinned-slot behavior.

**Risks:** (1) thin categories (station 4 CS = 46 songs, 180-min window) will relax constantly —
the health event makes that visible, and the depth-check (`library-health.js:55`) already warns;
(2) ON-by-default would visibly change every station's rotation — hence OFF-default recommended;
(3) perf if the `play_log` map isn't pre-loaded.

**STOP — awaiting GO.** No code written. On GO, suggested cut: (A) Generate side (fixes the
Part-0 bug + toggle) as the first shippable slice; (B) daemon tiers + twin; (C) UI toggle polish
+ sync confirm.
