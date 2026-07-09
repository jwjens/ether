# PARKED — least-recently-played / same-song repeats within the hour (2026-07-08)

Queued AFTER the mobile listener background-playback fix. Discovery started read-only; not implemented.

## Symptom (Open Format, generated day, screenshot 2026-07-08)
Same **recording** repeats inside the hour:
- **Good Times – 2018 Remaster (CHIC)** — 12:11 PM **and** 1:42 PM (~91 min apart).
- **Wake Me Up Before You Go-Go (Wham!)** — 12:20 PM **and** 1:21 PM (~61 min apart).
(Not a repeat: the two "Happy" titles are different recordings — Ashanti vs Pharrell.)

## What already exists (receipts)
- Separation rules ARE seeded per station (`electron/main.js:1140-1142`, all `is_hard=1`):
  artist_separation_min=60, **song_separation_min=180**, **title_separation_min=120**.
- BUT the generator enforces song-repeat via each song's own column, not those rules —
  `src/audio/loggen.ts:165`: `AND (s.last_played_at IS NULL OR s.last_played_at < (unixepoch() - s.no_repeat_hours*3600))`; artist via `artist_separation_min` (`:168-179`). **`song_separation_min` / `title_separation_min` look seeded-but-unwired** — confirm.

## Likely root cause (strong hypothesis — confirm next)
The separation query keys off **`s.last_played_at`**, which reflects **real on-air plays**, not positions
within the current Generate run. When generating a whole day ahead, songs already placed earlier in the
*same generated log* haven't "aired" yet, so their `last_played_at` is stale → the query doesn't see them
as recent → the same recording gets placed again 60–90 min later. The generator needs an **in-run recency
ledger** (each placed song + its scheduled time) and must enforce separation against **scheduled
positions**, not just airplay history. Plus a title-level guard (same title, different recording) if wanted.

## Proposed (for the GO next)
1. Track placed songs during a Generate run; enforce song/title/artist separation against the *scheduled*
   timeline (least-recently-placed), not just `last_played_at`.
2. Decide the wiring of `song_separation_min` (180) / `title_separation_min` (120) vs per-song
   `no_repeat_hours` — one source of truth, not both silently.
3. Least-recently-played tiebreak so heavy-rotation titles spread out, not cluster hourly.

**Not implemented. Parked behind the mobile fix.**
