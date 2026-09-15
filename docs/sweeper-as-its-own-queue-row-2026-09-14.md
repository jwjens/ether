# The sweeper should be its own row, above the song it introduces — proposal

**Report (verbatim, Jeff, 2026-09-14):**
> "The queue needs to show sweepers as their own row, not a badge on the song. A sweeper is a separate
> element that plays BEFORE the song it introduces, so it should sit above that song as its own
> smaller row, in the same deck colour — a thin red row above deck A's song, blue above B, green above
> C. It carries the sweeper's name and its length. Right now the SWP badge sits inside the song's row,
> which reads as 'plays with this song' when it actually plays before it. I can't tell from looking
> what's about to happen."

**PROPOSAL ONLY — nothing built.**

---

## 1. What it does today

`src/components/UpNext.tsx:545-566`. The sweeper is a **third line inside a deck row**, absolutely
positioned at `bottom: 6` within that row: an `SWP` tag, the title, and the duration, with colour
carrying the state — grey SCHEDULED, white ARMED, yellow blinking FIRING.

## 2. It is on the WRONG SONG, not just in the wrong place

This is the part worth reading before any styling decision, because it changes what the fix is.

The row renders where `jingleOverlay.deck === id`. That deck comes from `_armJingle(jin, deck)` in
`audiod/engine.js`, where `deck` is **`P`, the deck currently PLAYING** — the outgoing song. But
imaging here is *leading*: `_placeJingles` stamps the placement at the **incoming** song's
`scheduled_at`, and its own header says *"v2 is LEADING imaging — the overlay introduces the song
being placed"*.

So today the sweeper line sits under the song it plays **over the tail of**, not the song it
**introduces**. Jeff's reading of it — "it reads as *plays with this song*" — is exactly what the
markup says, and the element it is attached to is the wrong one either way.

**Moving it above the incoming song fixes the sentence and the fact at the same time.** That is the
substance of this change; the thin coloured row is how it is said.

## 3. Proposed

A **sweeper row** — its own row, sitting immediately **above** the song it introduces, at roughly a
third the height of a song row, in that song's deck colour (A red, B blue, C green), carrying the
sweeper's **name** and its **length**. In the queue list below the decks, the same row sits above the
queue item it introduces, in that item's eventual deck colour where known and neutral where not.

It reads top-to-bottom in the order things actually air:

    ┌ SWP  audiocoffee-halloween-impact 01            0:06 ┐  <- thin, deck-A red
    │ Remember Me (Ernesto de la Cruz)                1:49 │  <- deck A song row
    └──────────────────────────────────────────────────────┘

### State, on the row itself

Same four states the daemon already emits (`_emitJingle`: `SCHEDULED`, `ARMED`, `FIRING`,
`ARMED_CANCELLED`, `CLEARED`) — no new plumbing, the event already carries deck, title, contentClass
and `jinDurSec`:

| state | the row |
|---|---|
| SCHEDULED | present, dimmed — "this is planned" |
| ARMED | present, solid — "this is next" |
| FIRING | present, highlighted — "this is playing now" |
| ARMED_CANCELLED / CLEARED | **the row goes away** |

The one rule that matters: **the row is only ever present when the sweeper will actually play.** It
never sits there as a promise.

## 4. What the row shows when the outgoing element is a spot

Jeff asked specifically: *"say what the row shows when a sweeper is refused because the outgoing
element is a spot — it must not sit there promising something that won't play."*

**After tonight's 4.6.36 fix there is no refusal in that case, and the row should not imply one.** The
sweeper is not dropped — that was deliberately avoided, because `bd87a95` had already removed
exactly that behaviour for silently discarding operator placements. Its **lead is clamped to 0**, so
it starts *at* the seam instead of 2s into the commercial's tail. It still plays, in full, introducing
the same song.

So the row **stays**, and says the one thing that changed:

    ┌ SWP  audiocoffee-halloween-impact 01     at seam   0:06 ┐

`at seam` (or "after the spot") appears **only** when the lead was actually clamped by this rule — the
daemon already emits it as `sweeper-lead-clamped-spot` with `requestedSec` and `effectiveSec`, added
in 4.6.36 precisely so the reduction is never silent. This obeys the engine's own standing rule:
*never assert a number the engine did not honour.* A row that showed a 2s lead there would be the same
class of lie the badge is being replaced for.

**The genuine "won't play" cases are the cancels**, and they are real: `dead-file` (the sweeper's audio
is missing), `no-seam`, superseded, or `_cancelJingle`. In every one of those the daemon emits
`ARMED_CANCELLED` or `CLEARED` and **the row disappears**. It is never greyed-but-present, because a
greyed row that means "this will not happen" is indistinguishable at a glance from SCHEDULED, which
means the opposite.

## 5. What this does NOT change

- **No engine change.** Every state and field needed is already emitted.
- **The badge is replaced, not supplemented.** Two indicators for one element is how the current
  confusion started.
- **The deck row's own layout** — art, title, artist, countdown — is untouched. The sweeper line
  currently overlaps the bottom of that row at `bottom: 6`; lifting it out actually gives the deck row
  its full height back.

## 6. Open question for Jeff, worth settling before it is built

`jingleOverlay` today is **one object for the whole app** (`App.tsx:703`) — a single sweeper, on one
deck. Rendering a row above *the incoming* song means the row and the event's `deck` field no longer
agree, and with three decks it is possible for a sweeper to be armed for one seam while another is
already scheduled for the next.

Two ways:

- **(a) Keep one overlay, render it against the incoming deck.** Smallest change; correct for the
  single-sweeper case, which is every case today.
- **(b) Key the overlay by deck** (`{A: …, B: …, C: …}`). Correct if two can ever be live at once.

I would build (a) and note the limit at the call site, unless you know of a case where two sweepers
are pending simultaneously — you would know that from operating it and I would only be guessing.

---

# REVISED after Jeff's answer — the log is the source, not the engine

**Jeff, 2026-09-14:**
> "sweepers should ALWAYS be visible for every upcoming song in the queue, not just the one that's
> armed. That's what I've wanted from the start and it kept only showing the next one. So don't build
> the single-overlay version. jingleOverlay is the LIVE armed state — one at a time by nature. The
> queue should read the placements from generated_schedule, the same rows the calendar shows… The
> live armed state can still mark the one that's currently armed or firing, but it isn't the source
> of the list."

This is right, and §6 above (the one-overlay-vs-keyed-by-deck question) is **withdrawn** — both
options were wrong, because both took the list from the live state. One overlay can only ever
describe one seam, so "it kept only showing the next one" was not a bug in the rendering; it was the
data source having exactly one slot.

## The join already exists, exactly

`_placeJingles` stamps a placement at **the incoming song's `scheduled_at`** — the same second as the
song it introduces. And the queue's items already carry that key: `loggen.ts:606` puts
`scheduledAt: s.scheduled_at` on every item it queues, described in-place as *"generated_schedule row
identity — single source for the calendar"*.

So the lookup is `sweeperMap[item.scheduledAt]`. No matching on title, no time arithmetic, no
guessing which song a sweeper belongs to.

## It is not a new data path — the precedent is in the same file

`UpNext.tsx:170-186` already does precisely this shape for the separation lint:

    const [lintMap, setLintMap] = useState<Record<number, number>>({});   // scheduledAt -> value
    const rows = await ether.invoke("library-health:queue-lint", stationId);
    for (const r of rows) m[r.scheduledAt] = r.violatesBySec;
    ...
    const lintEarly = lintMap[item.scheduledAt];

A sweeper map is the same type, the same population pattern, the same per-row read. The component
already reads main-process data keyed by `scheduledAt` on an interval; this adds a second map beside
the first.

**And the index is already there.** Migration v31 created
`idx_gensched_class_station_at ON generated_schedule(station_id, content_class, scheduled_at)` —
station + class + time, which is exactly the query.

## Proposed

1. **New IPC — `schedule:sweeper-placements(stationId, fromTs, toTs)`.** Returns the SWP/JIN rows in
   the window: `{ scheduledAt, title, durationMs, leadInSec, playable }`. One indexed read.
2. **`sweeperMap` in UpNext**, beside `lintMap`: fetched on mount, on `ether:queue-changed`, and on a
   ~30s interval (faster than lint's 60s — the window is short — and cheap because it is indexed).
3. **Render** the thin row above any deck row or queue item whose `scheduledAt` is in the map. Both
   surfaces use the same map: the sweeper row above deck A's song and above a queue item are the same
   lookup, so they cannot disagree.
4. **`jingleOverlay` keeps its job and loses the list.** It marks *which* of the rendered rows is
   ARMED or FIRING — an accent on a row that is already on screen, not the reason a row exists.

### One field to add

`DeckRowState` (`UpNext.tsx:43`) does not carry `scheduledAt`, though the daemon has been emitting it
per deck since `engine.js:820` (`scheduledAt: this.deckSched[id] ?? null`). One field on the
interface, one line in the mapper at `:248`. The data is already on the wire.

## What it costs, stated plainly

**Cheap:** one IPC handler, one state map, one interface field, one render block. No engine change,
no migration, no new index, and the component already reads the DB this way.

**The real cost is not the query — it is that a plan is not a promise**, and that is the thing to get
right rather than to discover later:

- **A row read from the log says "this is planned", not "this will play."** The daemon can still
  refuse at arm time — a missing file (`_fileOk`), no seam, or a supersede. Jeff's own constraint
  from the first proposal still binds: *"it must not sit there promising something that won't play."*
  - **Mitigation, and it belongs in v1:** the IPC checks each placement's `file_path` on disk and
    returns `playable: false` for any that is missing, so the one failure the engine most often hits
    is visible *before* air rather than as a silent no-show. That is the same "build the sense, not
    the scaffold" rule the rest of this arc has followed. A non-playable placement renders struck
    through / muted with the reason, never as a clean promise.
- **The queue and the log can legitimately disagree.** Hand-loads, cart fires and drag-reorders put
  items in the daemon queue with no `scheduledAt` at all. Those simply have no sweeper row, which is
  correct — nothing was scheduled for them. Reordering is safe by construction: the item carries its
  own key, so its sweeper row travels with it.
- **Refresh lag.** Between a Generate and the next fetch (≤30s) the map is stale. The consequence is
  a row briefly present or absent for a song further down the queue — not an audio effect. Fetching
  on `ether:queue-changed` covers the common case immediately.

**A bonus that falls out of reading the log:** the `at seam` label from §4 no longer needs the live
event. 4.6.36 writes `lead_in_sec = 0` into the log for placements whose seam is the end of a spot,
so the clamp is visible on **every** upcoming one, not only the armed one — which is the same
complaint Jeff is making here, solved by the same move.

## Limit worth naming

A sweeper whose song is not yet in the daemon's queue has no row to sit above and will not render
until that song is queued. The queue is the surface; it shows what the queue holds. If the ask later
becomes "show the next hour of imaging regardless of the queue", that is the calendar, not this panel.

---

# Built 2026-09-14 (v4.6.37)

## What landed

| piece | where |
|---|---|
| `schedule:sweeper-placements(stationId, from, to)` | `electron/main.js` |
| `schedule.sweeperPlacements` on the bridge | `electron/preload.js` |
| `SweeperRow` + `sweeperMap` + `sweeperState` | `src/components/UpNext.tsx` |
| `DeckRowState.scheduledAt` | `src/components/UpNext.tsx` |
| the old in-row SWP badge | **deleted** |

The query's shape is copied from `audiod/loggen.js readJingleForSeam` deliberately — same class set,
same `deleted_at` filter, and the same two `COALESCE`s. A sweeper placement carries `file_key` and
**not** `file_path` (`_placeJingles` writes only the basename), so its audio resolves through the
songs row it points at. Reading it any other way would show a different answer from the one that airs.

## `playable`

By the daemon's own test: the stored path if it exists, else the audio-library index by basename —
both tiers from the same `electron/audio-library-index` module `audiod` uses, so the two cannot drift
about what "playable" means.

**One honest difference, named in the code rather than hidden:** the daemon also requires
`_dur(path) > 0`, which decodes the file. That is far too heavy for a list refreshed every 30s, so a
zero-length or corrupt file still reports playable. The common failure — the file is not on this
machine — is caught, and that is the one this flag exists for.

An unplayable row renders **struck through, in words**: `FILE MISSING — WILL NOT PLAY`. Not a dimmer
shade of planned: a greyed row that means "this will not happen" is indistinguishable at a glance from
SCHEDULED, which means the opposite.

## `atSeam` — derived, never inferred

Marked from the **spot's end time**, not from `lead_in_sec === 0`. An operator may legitimately set
LEAD 0 on a whole category — Jeff did exactly that tonight as a stopgap — and then every row would
claim a clamp that never happened. The smoke sets LEAD 0 across the board and asserts that **exactly
one** row is still at-seam.

A useful consequence: the flag is correct on rows generated *before* 4.6.36, which still carry
`lead_in_sec = 2`. The air side clamps them anyway; the row says so in advance.

## Verified against the live log

Station 2, next two hours: **40 placements, all playable**, and AT SEAM on exactly the three
spot-following ones (8:00:15, 8:20:16, 8:40:15 — the :00/:20/:40 spot pattern).

## Receipts

`scripts/smoke-sweeper-queue-rows.js`, 17 checks. Beyond the list itself it pins the two things most
likely to be got wrong later:

- **the COALESCE matches `loggen`** — a placement's duration comes from the songs row, so a test that
  only read `duration_s` would pass while the UI showed the wrong length;
- **at-seam survives a global LEAD 0** — the check that stops anyone "simplifying" the derivation into
  `leadInSec === 0`.

Plus the wiring that actually broke last time: the channel is registered, exposed on the bridge, and
`DeckRowState` carries the key — the three links `smoke-preload-bridge.js` covers, asserted here
against this specific feature.

## Known limits

- A sweeper whose song is not yet in the daemon's queue has no row to sit above. The queue shows what
  the queue holds; "the next hour of imaging regardless of the queue" is the calendar.
- Between a Generate and the next fetch (≤30s, and immediate on `ether:queue-changed`) the map is
  stale — a row briefly present or absent further down the queue. Never an audio effect.
- `jingleOverlay` matches its row **by title**, because its `deck` field names the OUTGOING deck while
  the placement belongs to the song being introduced. With one pool of similarly-named cuts two rows
  could in principle both light up; the placement rowId would be the exact key, and it is not on the
  overlay event today. Filed rather than guessed at.
