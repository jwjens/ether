# Rotation regression 131 → 236 — cause and fix (2026-10-19)

## Jeff (verbatim)

> Find why the station 3 rotation score went 131 → 236 and fix it. Rotation can't get worse.

## The score

Scheduler gate **T3** (`npm run test:scheduler-gate`), station 3 = fixture FX-PLAYTHROUGH: the number of go-lives that pushed a category's play counts past a spread of 1 while a lower-count song was free. Lower is better. Untouched code (the installed build's lineage): **131**. After the hour rules (d1252f3): **236**.

## How it was found

1. Bisect by file, the rest of the tree new: old `loggen.js` → still 236; old `generate-core.js` → 131. The cause is in Generate, not the reader.
2. Inside Generate, the change that matters is rule 3's first cut: rows timed past their hour's end (the Extra clock places 20 rows in a 60-minute hour, so 4 run past :00 every hour) and rows marked didn't-play were counted on Generate's timeline as plays.
3. Experiment (temporary, reverted): leave those rows out of Generate's view entirely → station 3 back to **131** exactly, station 1 **141** (ratchet 154). That pins the whole regression on them.
4. A middle attempt — keep them for the separation rules, drop them only from "waited longest" — gave 188 / 286 (station 1 worse). Rejected.

## Why it happened

A row timed past its hour's end never airs: rule 1 marks it didn't-play when the hour ends. Counting it as a play "burned" the song placed there — Generate treated it as just played, passed it over, it never aired, and its play count fell behind (T3's examples: the same five low-count songs passed over every time). The installed build already guarded against exactly this (its comment: "they would otherwise count songs that are marked didn't-play as aired"); the first cut of rule 3 removed the guard.

## The fix

Only rows that air count:

- `electron/generate-core.js`: a song placed in a row timed past its piece's end keeps the rules among that hour's own extra rows while the hour is built, then comes off the timeline (restored `pastEnd` / `uncommit`).
- `audiod/scheduler-core.js` `loadTimeline`: rows marked didn't-play or refused, and automatic rows timed past their hour's end, are not loaded. Every other row of the log — pending, timed earlier, placed by hand — still counts (rule 3: the previous hour's rows that air block repeats).
- An on-air repeat stays impossible: if a row past :00 does air because the hour ran short, the reader refuses a song that breaks separation against what aired (gate T10).
- The gate's checker mirrors it (T1 log check and T2 re-derivation count only rows that air).

## Result (gate on the final tree)

| | ratchet | before the fix | after |
|---|---|---|---|
| T3 station 1 | 154 | 154 | **131** |
| T3 station 2 | 1268 | 0 | **0** |
| T3 station 3 | (not recorded) — untouched code 131 | 236 | **131** |
| T1, T2 all stations | 0 | 0 | **0** |

T3 still fails as it did before this work (it never passed on these fixtures); it is now no worse than untouched code on any station and better on station 1. T18 (335) is unchanged from untouched code.

`npm run test:three-pm` rule-3 checks updated: a 2 PM row timed past 3:00, or marked didn't-play, does not burn its song; a pending 2 PM row timed before 3:00 still blocks it.
