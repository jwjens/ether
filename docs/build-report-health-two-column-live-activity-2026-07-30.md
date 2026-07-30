# Build report — System Health: two-column layout + Live Activity terminal

**Date:** 2026-07-30 · **Scope:** the health screen becomes two columns; the right column is a terminal
tailing the daemon log that already exists.
**State:** built, typecheck at baseline, tail + classifier verified against the live log. **No bump, no
commit, no build** — awaiting authorisation.

---

## Blast radius — display-only, confirmed

**Nothing was added to the daemon, the engine, or any writer.** The feature is one read-only IPC plus two
renderer files.

| Layer | Change | Can it affect audio? |
|---|---|---|
| `audiod/` | **none** | — |
| `native/` | **none** | — |
| `electron/main.js:2792-2831` | **added** `activity:tail` — `fs.statSync` + one `fs.readSync` of a byte range, returns strings | No. Read-only file I/O; issues no daemon command, touches no engine state. |
| `electron/preload.js:198-202` | **added** `activity.tail(offset)` bridge | No. |
| `src/components/LiveActivityTerminal.tsx` | **new** — polls that IPC, renders text | No. Calls nothing but `ether.activity.tail`. |
| `src/components/HealthMonitor.tsx` | layout wrapper + import | No. |

No new log writer, no new event channel, no new instrumentation — it streams what
`audiod/daemon-log.js` already writes. The health screen reads; it never acts.

## 1. Two columns

`src/components/HealthMonitor.tsx`:

- **`:9-27`** — `TWO_COL_MIN_PX = 1000` and `useTwoColumn()`, a window-resize hook. Window-based rather than
  a `ResizeObserver` because this panel is either the full main window or its own popout (`PopoutBtn
  panel="health"`), so the window *is* its width.
- **`:453-461`** — the former single scroll container is now wrapped in a flex row (`flexDirection: twoCol ?
  "row" : "column"`). **Left column** (`:460`) keeps the existing content unchanged and stacked in order:
  `LiveHealthMonitor` (Live Events) → Legacy diagnostics → HA rollup → Core Systems → High Availability →
  Library & Rotation → Log-Reader shadow → Play Log export → Infrastructure.
- **`:790-800`** — **right column**: 460 px wide with a left border beside the sections; when narrow it
  becomes a 340 px-tall band **below** them with a top border instead.

**Each column scrolls independently.** There is no outer scroller any more, so scrolling the health sections
never moves the terminal and vice-versa. The one existing content change is that the left column carries
`minWidth: 0` so long lines wrap instead of forcing the row wider.

## 2. The Live Activity terminal

### Source — the existing log, followed by offset

`electron/main.js:2792-2831`, `activity:tail`:

```js
const size = fs.statSync(p).size;
const seeding = !Number.isFinite(prev) || prev < 0;   // first call → seed from the tail
const rotated = !seeding && prev > size;              // file shrank → rotated/truncated
let start = seeding ? Math.max(0, size - MAX_CHUNK) : rotated ? 0 : prev;
```

- **Follows, never re-reads.** Only `[offset, size)` is read. **The renderer holds the cursor** and passes it
  back each call, so main stays stateless and the panel + its popout can each tail independently without
  fighting over one offset.
- **Bounded per call** — `MAX_CHUNK = 256 KB`, so a large catch-up can never stall the UI.
- **Rotation handled.** `daemon-log.js:23,51` rotates at 5 MB to `.log.1` and starts a fresh `.log`. The new
  file is smaller than our cursor, so `prev > size` is the signal: restart at the head and return
  `reset: true`, which the terminal renders as a `— log rotated —` marker.
- **No split lines.** Only up to the last `\n` is consumed; a line still being written is picked up whole on
  the next poll. A partial head is dropped when we did not begin on a line boundary.

**Verified against the live log** (read-only harness, session scratchpad):

```
seed:     1653 lines, offset 518544 (file 518544)   → seeds exactly to EOF
follow:   0 new lines, offset unchanged             → confirms it is NOT re-reading
rotation: reset=true                                → shrink detected
partial/split lines in seed: 0
```

### Presentation — `src/components/LiveActivityTerminal.tsx`

- **Monospace, newest at bottom, auto-scrolling** (`:130-135`).
- **Pause / scroll-lock** (`:137-148`): a Pause button, **and scrolling up engages the lock automatically** so
  reading doesn't fight the feed. **The tail keeps running while paused** (`:96-124`) — pausing freezes the
  view, it does not drop activity. "Resume" jumps back to live.
- **Per-station colour AND a filter** (`:63-68`, `:171-178`): s1 blue, s2 amber, s3 green, s4 pink, with
  All/s1-s4 buttons. Station buttons are discovered from the stream, so a fifth station needs no code change.
  Deliberately not the brand purple — that reads as "selected", not "station 1".
- **Severity** (`:28-40`): three views — **Decisions** *(default)*, **All activity**, **Warnings**.
- **Buffer capped** at `MAX_LINES = 800` (`:11`), trimmed on every append. Poll `POLL_MS = 1000`.

### The default view is "what changed", measured

Classifying **1,646 real lines** from the live log:

```
routine 1339  ·  decision 299  ·  warning 8      → the default hides 81% (the 250 ms mix spam)
```

Warnings that survive are all genuine — `[LOGREADER-SHADOW] behind` on s3/s4, i.e. the schedule drift from
`docs/spot-anchor-drift-generated-vs-playout-2026-07-30.md`. **Station attribution: 1646/1646 lines** resolved
to a station (`[engine sN]`, `[mix sN]`, `[RUST] Station N`).

## Found while testing — flagged, NOT fixed

The 4.4.105 liveDeck observer logs **`liveDeck OBSERVER — foreign deck cleared after 2.1s`** on ordinary
segue overlaps. `_foreignSince` is set as soon as any foreign deck appears — *before* the 7.5 s grace — and
the clear branch logs whenever it was set, even though nothing was ever reported. Harmless (observation-only
code, log noise), one-line fix: log the clear only when `_foreignLastLogAt` was set, i.e. only when the
condition was actually reported.

**Not fixed here** — outside this task's scope. Handled in the terminal instead: only `TWO DECKS ON AIR` is
classified a warning; the clear line is a decision, so every rotation doesn't flag red (`:33-35`).

## Help entry

`docs/help-live-activity.md` — flat name in `docs/`, written to the `help-jingles.md` template: what it is,
when to use it, step-by-step, the filters, the pause behaviour, and a table translating the log lines
(`segue: deck B LIVE`, `clean spot edge`, `TWO DECKS ON AIR`, `watchdog: STALL`, `LOGREADER-SHADOW: behind`)
into plain language.

**Door:** none needed — the terminal is inside the Health Monitor, which already has its canonical door (the
footer **NOMINAL** button). It is visible on open, not behind a tab.

## Architecture compliance

- **BUILD THE SENSE, NOT THE SCAFFOLD** — permanent built-in observability on an existing channel, shipped
  with the feature. Nothing temporary, nothing to tear down, no `docs/backlog.md` entry needed.
- **DOORS BEFORE ROOMS** — reachable from the canonical health door, has a help entry, and explains itself in
  its empty state ("Waiting for activity from the audio daemon…" / "Nothing matches this filter").
- **Honest UI** — it displays observed log lines verbatim and claims nothing else. No synthesized events.
- **Correct minimal solution** — deliberately NOT built: a new event bus, a websocket/push channel, daemon
  changes, log-level changes, search/regex filtering, export from the terminal (Export Play Log CSV already
  exists below it), and the observer clear-line fix above.

## Gates

- `./node_modules/.bin/tsc --noEmit` → **exactly the 2 accepted-baseline errors** (`OnboardingFlow.tsx:2039`,
  `PhoneDesk.tsx:777`). No new errors; none in the changed files.
- Tail + classifier exercised against the live `ether-audiod.log` read-only (results above). The live file was
  not modified.

## Files

```
electron/main.js                            +40   activity:tail
electron/preload.js                          +5   activity.tail bridge
src/components/LiveActivityTerminal.tsx     new   the terminal
src/components/HealthMonitor.tsx            +40   two-column layout + useTwoColumn
docs/help-live-activity.md                  new   help entry
```

Also uncommitted in the tree from earlier work: the 4.4.106 `engine-rodio.ts` revert, and the 4.4.105 liveDeck
observer in `audiod/`.

## Not verified

**I have not seen this on screen.** Layout, colours and the scroll-lock feel are unverified until it runs —
the tail logic and classification are proven against real data, the rendering is not. First launch should
check: two columns above ~1000 px and stacked below it, the terminal filling its column height, and the
scroll-lock engaging when you scroll up.
