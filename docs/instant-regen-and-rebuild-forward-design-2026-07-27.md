# Instant regenerate (from the playhead) + Rebuild-forward — DESIGN (no code yet)

**Date:** 2026-07-27 · **Branch:** log-reader-flip · **Status:** DESIGN — STOP for GO.

Two related asks from Jeff:
1. **Generate must apply IMMEDIATELY** — rewrite the forward schedule from the *current playhead*, leaving **only the song actually playing** untouched. The cued (not-playing) decks must also flush and reload from the fresh schedule. A fix should take effect at once, not at the next top of hour.
2. **"Regenerate from now forward" / rebuild-runway** — one action that re-authors every already-generated future day with the current picker, so a logic change (like the rotation fix) propagates without hand-regenerating each day.

## Why it isn't instant today (receipts)

- **Generate is top-of-hour anchored.** `schedule:generateDay` (`electron/main.js`) sets
  `effStart = max(dayStart, ceil(now/3600)*3600)` and deletes/rewrites gs only from that next
  `:00` forward; the current hour's rows are left as-is. Late at night it no-ops entirely
  (`effStart >= dayEnd`). So a regen changes nothing you can hear until the hour rolls over.
- **The daemon keeps ALL deck-bound entries.** `intentClearPending` (`audiod/engine.js:993`)
  keeps every entry in `boundQids` — that's the playing deck **and** the cued decks B/C — and
  only clears the pending queue. So cued decks never refresh from a new schedule (Jeff's "the 3
  decks are unchangeable unless queued from the library").
- **The daemon refills lazily.** It only refills when `queue.length < 5` (`engine.js:439,657`),
  so even a rewritten log isn't picked up until the queue drains.

## Feature A — Instant regenerate from the playhead

**Generate side (`electron/main.js`):**
- Anchor at **NOW**, not the next `:00`: `effStart = max(dayStart, nowTs)` (with a tiny guard so
  the row currently on air is never deleted — see below). Drop the `effStart >= dayEnd` night
  no-op for the current-day case (there IS forward time within the hour).
- **Partial current hour:** `_generateDayRows` currently starts every hour at `hourStartTs` and
  walks slots to `:00`. Add a per-hour **start override** so the current hour fills from
  `effStart → :00` (break anchors whose minute already elapsed are skipped; only breaks still
  ahead of the playhead are placed). Full hours after are unchanged.
- **Never delete the playing row:** delete `WHERE state='pending' AND scheduled_at >= effStart`
  (the on-air row is `state='playing'` or sits at/just-before the playhead, so it survives).

**Daemon side (`audiod/engine.js`) — a new `intentResyncFromLog()`:**
- Keep **only the deck whose status is `playing`**. Free/unbind the cued (ready, not-playing)
  A/B/C decks and clear the pending queue (unlike `intentClearPending`, which keeps cued decks).
- **Immediately** re-read gs from the playhead (Tier 0 / `readGeneratedSchedule`) and rebuild:
  cue the next fresh rows onto the freed decks + refill the pending queue **now**, not at the
  `<5` watermark. (Reuses the proven preload/cue path — a deck load must still not stall on a
  fetch.)
- Guarantee: audio never stops (playing deck untouched) and never dead-airs (if the fresh read
  yields nothing playable for the partial hour, keep the existing rows).

**Wiring:** after `generateDay`/rebuild writes rows, signal the daemon over the command bus
(new `queue:resync`) so it runs `intentResyncFromLog()` at once. Today the renderer calls
`queueClearPending()` after Generate (`src/App.tsx:2737`) — upgrade that call site to the resync.

**Contract change to confirm:** this breaks the "hard top-of-hour, each hour starts fresh"
rule for the *current* hour (it becomes a playhead→`:00` partial fill). That's inherent to
"instant." Everything from the next `:00` on is unchanged.

## Feature B — Rebuild-forward (propagate a picker change)

New IPC **`schedule:rebuildForward(stationId)`** + a calendar affordance ("Regenerate from now"):
- Delete `state='pending'` gs from the playhead to the **runway tail** (all authored future days)
  for the station, then regenerate the whole span with the current picker — one
  `_buildScheduleCtx` (rest maps built once) looped over `_generateDayRows` day by day from the
  partial current hour to the tail.
- Fire the same **instant daemon resync** at the end.
- Result: a logic change (e.g. the rotation fix) re-authors the entire forward schedule in one
  action, instead of hand-regenerating each day. This is what would have made 4.4.89 visible
  immediately tonight (the airing content was a July-25 bulk + a 4.4.88 partial, neither touched
  by a single-day regen).

## Blast radius

| Area | File | Change |
|---|---|---|
| Generate anchor + partial hour | `electron/main.js` `schedule:generateDay`, `_generateDayRows` | effStart→playhead; per-hour start override; keep playing row |
| Rebuild-forward | `electron/main.js` (new `schedule:rebuildForward`) | delete pending playhead→tail, regen span, resync |
| Daemon instant apply | `audiod/engine.js` (new `intentResyncFromLog`) + cmd routing | drop cued decks + pending, keep playing deck, immediate gs re-read |
| Command bus | `src/audio/cmd-routing.ts`, `engine-rodio.ts`, preload | add `queue:resync` |
| UI | `src/App.tsx`, `src/components/BroadcastCalendar.tsx` | resync after Generate; "Regenerate from now" button |

## Risks / decisions for GO

1. **Cued-deck flush mid-air:** dropping B/C and re-cueing from the fresh log must complete
   before the playing song ends. Near a segue boundary there's a small window; the resync should
   re-cue the immediate next row **first** (synchronously) before rebuilding the rest, so the
   next transition always has a loaded deck. Confirm acceptable.
2. **Partial-hour clock semantics** (breaks already elapsed are skipped) — confirm.
3. **Rebuild-forward scale:** the tail can be ~16k rows; one bulk insert + one ctx. Generate
   already does multi-day, so fine, but it's a heavier action — gate it behind an explicit
   button, not automatic.
4. **Daemon must be current** — the daemon never reloads on update; instant-apply only works once
   the daemon is running the new build (fully close + reopen).

**STOP — awaiting GO.** No code written. On GO, suggested order: (A) daemon `intentResyncFromLog`
+ `queue:resync` wiring, (A) Generate playhead anchor + partial hour, then (B) rebuild-forward +
its button — proving each on a DB copy and, for the deck behavior, in the running app.
