# Jukebox pool mismatch — Settings says 156, the kiosk says 0

**Date:** 2026-08-18 · **Report:** Jeff — Settings → Programming → Jukebox (Open Format) shows
*Pool: 156 songs across 6 categories* with per-category counts rendering, while the kiosk window
simultaneously shows *"0 songs" / "No songs available to pick"*, AUTO on, routed to Deck D.
Screenshots of both. **Confirmed, root-caused, fixed.**

---

## 1 · The two queries are not the same query — and the difference is invisible in the source

`queryScoped` (`src/db/stationScoped.ts:60-81`) **auto-injects `station_id = ?`** into any SQL that
does not already mention `station_id`. That is the whole bug.

| | Query root | What the injection binds to | Result |
|---|---|---|---|
| **Settings** `SettingsPanel.tsx:2142` | `FROM categories c` | `categories.station_id` — the column exists, scoping is correct | **156 across 6** ✓ |
| **Kiosk** `Jukebox.tsx` `runQuery` | `FROM songs s LEFT JOIN artists a` | `songs` has **no** `station_id`, so it resolves to **`artists.station_id`** | **0** ✗ |

Both used the same playability filter (`deleted_at IS NULL`, `file_path` present and non-blank,
`content_class IS NULL OR 'MUSIC'`) and the same `stationId`. The filter was never the problem.

### Proven on the live database (read-only)

```
songs is a table;  songs has station_id? false  (43 columns)
categories has station_id? true
artists has station_id?  true   (every row station_id = 1)
jukebox_categories(st1) = [4,2,5,8,3,1]      <- the 6 ticks Settings shows

A) kiosk SQL, NO station scoping      ->  156 songs     <- what Settings promises
B) kiosk SQL + injected station_id    ->    0 songs     <- what the kiosk rendered
C) same SQL WITHOUT the artists join + injected station_id -> THREW "no such column: station_id"
```

**The `LEFT JOIN artists` is what made this silent instead of loud.** With the join, the injected
predicate has a column to bind to, so SQLite does not complain — it just filters on
`artists.station_id = 1`, which (a) converts the outer join into an inner one and (b) drops every song
whose `artist_id` does not resolve. Without the join the same injection throws immediately. C is the
control that proves it.

Related: the integrity check run earlier the same day reported **475 dangling `songs -> artists`**
references, which is why the surviving count collapsed all the way to zero rather than partway.

### The same fault silenced AUTO

`pickShuffleSong` carries the identical `LEFT JOIN artists` and the same scoping, so it returned `null`
on every tick. That is why the kiosk sat with **Deck D routed and AUTO lit and nothing ever playing** —
not a deck problem, not a routing problem: the same zero.

### This predates the rebuild

`runQuery` was carried over verbatim from the 08-04 Slice 1 implementation. The wall has never
populated on this machine; the rebuild inherited the defect and made it visible by putting an honest
count next to it in Settings.

## 2 · Station resolution was CORRECT — ruled out, with evidence

The kiosk rendered *"No songs available to pick"* (the in-wall empty state), **not** *"The jukebox isn't
set up yet"* (the `configLoaded && !categoryIds.length` gate). Those are different branches, so the
popout must have had the ids. Confirmed independently: `jukebox_categories` exists for **st1**
`[4,2,5,8,3,1]` and **st2** `[4,2,10]`, and the kiosk was working from the 6-id set — station 1, the
same station Settings was showing. No `?? 1`, no stale station, no cross-station read.

## 3 · Stale-until-reopen — a SECOND, independent bug

The config effect's deps were `[isReady, stationId]`, so `jukebox_categories` was read **once per
station**. Ticking categories in Settings never reached an open kiosk. Even with §1 fixed, the
acceptance criterion "updates when ticks change without reopening" would still have failed.

## 4 · Fixes

| # | Fix | Where |
|---|---|---|
| 1 | `{ skipScoping: true }` on all three song queries (count, page, shuffle). `songs` is account-scoped — it has no `station_id` — and the pool is already narrowed by this station's categories. | `Jukebox.tsx` `runQuery`, `pickShuffleSong` |
| 2 | A failed query no longer renders as an empty pool. `poolError` is separate state, and the wall says *"The song list couldn't be loaded — this is a fault, not an empty library"* with the message. | `Jukebox.tsx` |
| 3 | The ticks are re-read every 4s, with an identity-stable comparison so an unchanged value causes no re-render and no re-query. Settings changes now reach an open kiosk. | `Jukebox.tsx` config effect |

Fix 2 is the one that matters beyond this bug. *"No songs available to pick"* is a sentence about the
library; the truth was that the query never ran. A plausible sentence over a failed query is how this
sat unnoticed — the same failure mode as a dead menu item or a handler with no door.

## 5 · Wider exposure — CORRECTED 2026-08-18, and smaller than first stated

**An earlier version of this section claimed ~10 vulnerable call sites. That was wrong** — it came from
a `grep -A 3` that could not see a `{ skipScoping: true }` sitting further down a multi-line call.
Checked properly (8 lines of context per site), **5 of those 10 already carry it**:

| Site | Status |
|---|---|
| `App.tsx:1672`, `:1867`, `:1951` | already `skipScoping` ✓ |
| `canvas/widgets/Widgets.tsx:151` | already `skipScoping` ✓ |
| `components/JockStrip.tsx:46` | already `skipScoping` ✓ |
| `App.tsx:3339` | **no skipScoping** |
| `App.tsx:4948` | **no skipScoping** |
| `components/AutoCue.tsx:231` | **no skipScoping** |
| `components/CueEditor.tsx:79` | **no skipScoping** |
| `components/DeckConfigurator.tsx:360` | **no skipScoping** |

So the real exposure is **5 sites**, and they fail in the *loud* way, not the jukebox's silent way:
none of the five carries a `LEFT JOIN artists`, so the injected predicate has no column to bind to and
the query **throws `no such column: station_id`**. Whatever catch sits above each one decides what the
operator then sees — most likely an empty list.

That also **retracts the prediction** made earlier about stations 2/3/4. It was reasoned from the silent
`artists.station_id` mechanism, which does not apply to any of the five: they throw on every station,
including station 1, or they do not throw at all. If AutoCue's song list or the deck-configurator
playlist has ever been empty, this is the first thing to check — on any station, not just 2/3/4.

`App.tsx:4847` carries `skipScoping` already, so the trap has been recognised and patched at several
sites over time without a sweep that finished the job. Still worth a deliberate pass; still out of
scope here.

## 6 · Gates

`tsc --noEmit` → 0 errors · `npm run build` → clean.

**Runtime UNVERIFIED.** The 156 figure is proven at the database level by probe A above, which is the
exact SQL the fixed code now runs — but a passing query is not a rendered wall.

**Acceptance:** the kiosk shows the same 156-song wall Settings promises, and follows tick changes
without reopening the window. Needs a fresh renderer (reinstall or dev relaunch) since this is renderer
code.
