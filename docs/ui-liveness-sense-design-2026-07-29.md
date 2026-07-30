# UI liveness — a permanent sense for "the station is playing but its deck view has stopped" (design of record, 2026-07-29)

**STATUS: DESIGN ONLY — build nothing from this doc yet.** Written to prove the sense fits the existing Health
Monitor architecture before any code exists.

**The failure it must name:** a live, automation-running station whose daemon *is* emitting deck events — audio
plays, decks advance, tracks segue — while the renderer's deck view has stopped updating. Producer and transport
proven alive on the live machine (`docs/deck-freeze-live-evidence-2026-07-29.md`): station 4's engine segued and
ended a deck at 18:16 with automation engaged since 17:51:42, one daemon client connected with no reconnect, and
`sendToAllWindows` individually guarded. The renderer stopped applying. **Nothing in the product says so.**

---

## 1. The existing architecture — the contract a new sense must satisfy

### 1.1 Two sense modules, one feed

| Module | Scope | Precedent value |
|---|---|---|
| `electron/audio-health.js` (265 lines) | Audio/playout liveness per station — frames, peak, decks, queue, engine state | The state machine and event conventions |
| `electron/library-health.js` | Five library senses per station (materialization, pool, skipped-at-load, prefetch lag, rotation eligibility) | **Proof that a second sense module is the sanctioned pattern**, not a fork |

Both are **main-process**, both compute deterministically from data they are *given*, and both append to the same
`health-events.jsonl` (`audio-health.js:51`, `library-health.js:25`).

### 1.2 The level model — four levels, ranked, with display hysteresis

```js
audio-health.js:27   const RANK = { GREY: 0, GREEN: 1, YELLOW: 2, RED: 3 };
```

- **GREY** — genuinely idle. Deliberately *not* inferred from one flag: `enginestate === "off" && activeDecks === 0
  && framesPerSec <= 1` (`:153`), because in-process playout emits no enginestate events. **Idle is proven, never
  assumed.**
- **GREEN** — the clearest healthy signal available (`framesPerSec >= 0.90 * 44100`, `:173`).
- **YELLOW** — early warning, degradation, or a recent bad event.
- **RED** — the station is failing now.

**Two-level output per station, and this is load-bearing** (`:196-208`):

- `level` — the **raw** level. Every transition is written to JSONL immediately, full fidelity, for Iris.
- `displayLevel` — a **5 s hysteresis** view for the UI: a *worse* level must hold `DISPLAY_HYSTERESIS_MS` before it
  surfaces; *recovery surfaces immediately*. This exists to kill sub-5 s flapping in the UI while the JSONL keeps
  every raw transition.

A new sense **must** produce both, or it will either flap on screen or lie to Iris.

### 1.3 How a sense is defined

`evaluate(r, t)` (`audio-health.js:150-183`) is a pure function of a per-station record `r` and the current time,
returning `{ level, reason }`. Its structure is a strict precedence ladder — **GREY → frozen → RED → YELLOW →
GREEN** — with every threshold a named constant at the top of the file (`:15-26`):

```js
const FROZEN_MS        = 3000;    // frames frozen >= 3s → RED
const SILENT_RED_MS    = 30000;   // peak silent > 30s while playing → RED
const SILENT_YELLOW_MS = 10000;   // 10–30s → YELLOW
const QUEUE_LOW        = 5;
```

Every `reason` is a human sentence with the measurement in it — `` `frames frozen ${n}s` ``, `` `queue depth ${n} < 5` ``.
Not a code. That is the convention.

**The most important convention, and the one this new sense is an instance of** (`:174-181`):

> *"quiet ≠ no data … if the levels STREAM is still ARRIVING, PCM is flowing even if this sample's frames/s dipped
> — do NOT flap to YELLOW."*

The existing code already distinguishes **"the measurement stopped arriving"** from **"the thing being measured
stopped"**. That is exactly the distinction the UI-liveness sense needs, applied one layer out.

### 1.4 Per-station model, ingest, and cadence

- Records are keyed by **station UUID** — `rec(uuidOf(stationId))` (`:105`). Not the integer id.
- Facts arrive through named `note*` ingest functions, each called from `electron/main.js` as daemon events land:
  `noteLevels`, `noteEngineState`, **`noteDeck`** (`:103`, called at `main.js:575`), `noteQueue`, `notePlaySkip`,
  `notePlayStart`, `noteStreamStatus`, `noteEnginePid`, `noteJingle` (exported `:260`).
- `tick()` (`:186`) evaluates **every station every tick** and then `broadcastSnapshot(t)`.
- Output: `broadcast("audio:health", snapshot(t))` (`:248`), plus `ipcMain.handle("health:snapshot", …)`
  (`main.js:533`) for a cold read.

### 1.5 Event shape — must be matched exactly

```js
audio-health.js:218-221
  const ev = { ts: iso(t), stationUuid: r.uuid, stationName: r.name,
               level: r.level, prevLevel, reason: r.reason, metrics: _metrics(r) };
  fs.appendFileSync(jsonlPath, JSON.stringify(ev) + "\n");
```

and the UI ring buffer `pushRecent` (`:223-227`) which **only records YELLOW/RED** display transitions.

`metrics` (`:212-215`) is a flat bag of the numbers behind the decision: `framesPerSec, peak, activeDecks,
queueDepth, nextDeckReady, trackLeftSec, enginestate, streaming, drainBps, pingMs, enginePid`.

**The contract, in one line:** per-station, UUID-keyed, four ranked levels, raw + 5 s-hysteresis display, a
human-sentence reason carrying its measurement, named threshold constants, one JSONL line per raw transition with
the metrics that justified it.

---

## 2. Where the signal lives — and the honest answer about the second half

The sense needs **two facts per station**:

### Fact A — "is the daemon emitting deck events?" — **already available, no new plumbing**

`main.js:571-576` receives every daemon deck event and already calls `_health.noteDeck(...)`. The health module can
record an arrival timestamp per station in that existing ingest. **Nothing new crosses a boundary.** Today `noteDeck`
(`audio-health.js:103-113`) uses the payload but records no arrival time; adding `r.lastDeckEventAt = nowMs()` is a
one-line extension of an existing sense's own record.

### Fact B — "did the renderer apply one recently?" — **NOT cleanly available today**

This is the part that must not be faked. Three wrong ways to get it, and why each is rejected:

| Rejected approach | Why |
|---|---|
| Have the monitor reach into renderer internals | The monitor is main-process and computes from facts it is *given*. Nothing in either sense module reads renderer state, and it must stay that way |
| A bespoke IPC "the renderer is alive" side-channel | A side-channel invented for one bug is the definition of a bolt-on. It would have no place in the sense model and nothing else would ever use it |
| Infer it from something else (now-playing updates, window focus) | Inference is what got this wrong twice already. `docs/deck-freeze-live-evidence-2026-07-29.md` exists because inference kept producing confident wrong answers |

**The architecturally correct place to expose it: the renderer already has the fact, and the app already has a
pattern for publishing renderer-side truth to main.** `AudioEngine`'s daemon `onDeck` handler (`engine-rodio.ts`) is
the exact line where an event becomes applied state — it writes `stateA/B/C` and fans out to listeners. The correct
exposure is a **narrow, named renderer→main heartbeat carrying only what the sense needs**:

```
{ stationId, deck, appliedAt }     ← "this renderer applied a deck event for this station"
```

published on a normal IPC channel and ingested by a new `noteDeckApplied(stationId, deck)` alongside the existing
`note*` family. Three properties make it a sense feed rather than a side-channel:

1. **It is a fact, not a request** — same shape as every other `note*` input.
2. **It is one-directional and lossy-tolerant** — the monitor only ever cares "how long since the last one", so a
   dropped message costs nothing.
3. **It is rate-limited at the source** — at most one per station per second is enough for a
   seconds-scale threshold; deck events fire ~1/s per playing deck, so this is not new traffic of consequence.

**The window question, stated rather than glossed:** more than one renderer can be alive (main window plus popouts,
each its own process). The honest reading is **"at least one renderer is applying"** — the monitor takes the most
recent `appliedAt` across windows. That is the correct semantic: the failure being named is "no UI anywhere is
tracking this station", and a per-window breakdown is a refinement, not v1.

**Cold-start caveat that must be designed in:** a renderer that has not yet mounted, or a station nobody is viewing,
has no reason to apply anything. That is **GREY**, not RED — see §3.

---

## 3. The sense definition

**Name:** UI LIVENESS (per station).

### Thresholds — named constants, matching `audio-health.js:15-26` convention

```js
const UI_APPLIED_YELLOW_MS = 10000;  // deck events arriving, none applied for 10s → YELLOW
const UI_APPLIED_RED_MS    = 30000;  // ... for 30s → RED
const UI_VIEWED_GRACE_MS   = 5000;   // after a station is first viewed, allow this long before judging
```

10 s / 30 s deliberately mirrors `SILENT_YELLOW_MS` / `SILENT_RED_MS` (`:19-20`) — the same "a live thing has gone
quiet" shape, so operators learn one timing model rather than three. Deck events arrive ~1/s while playing, so 10 s
is ten missed updates: unambiguous, and far outside any GC pause or window-minimise hitch.

### Levels

| Level | Condition | Reason string |
|---|---|---|
| **GREY** | No renderer is viewing this station (no `appliedAt` ever, or none since the last view change), **or** the daemon is not emitting deck events for it (nothing to apply) | `"no UI viewing this station"` |
| **GREEN** | Deck events arriving **and** applied within `UI_APPLIED_YELLOW_MS` | `"deck view live"` |
| **YELLOW** | Deck events arriving for ≥ 10 s with no apply | `` `deck view stalled ${n}s (events arriving)` `` |
| **RED** | Same for ≥ 30 s **while the station is playing** | `` `deck view frozen ${n}s while playing` `` |

**GREY is the load-bearing level here**, and it follows `evaluate`'s own precedent at `:153` — idle must be *proven*,
never assumed. A station nobody is looking at is not broken. The sense must never turn a closed panel into a RED.

**The RED condition requires the station to be playing** — the same `playing` predicate the existing evaluator
already computes (`:155`). A stopped station whose view is idle is not a fault.

### Event shape — identical to the existing one

```json
{ "ts": "2026-07-29T18:16:05.162Z", "stationUuid": "…", "stationName": "Christmas In July",
  "level": "RED", "prevLevel": "GREEN", "reason": "deck view frozen 34s while playing",
  "metrics": { "lastDeckEventAgeMs": 1000, "lastAppliedAgeMs": 34000, "activeDecks": 1,
               "enginestate": "live", "viewingWindows": 1 } }
```

Same five top-level fields, same `metrics` bag convention (`:212-215`) extended with the three numbers that justify
*this* decision. Raw transitions to JSONL immediately; `displayLevel` through the same 5 s hysteresis; `pushRecent`
only for YELLOW/RED, exactly as `:223-227`.

**The metrics are the whole diagnostic.** `lastDeckEventAgeMs` small + `lastAppliedAgeMs` large is the signature of
the failure we chased for a day — and it is *self-evident in one line of JSONL*, with no instrumentation build, no
console, and nobody watching a screen.

---

## 4. Fit check — new sense, inside the existing audio-health module

**It is not an extension of the drain/liveness senses.** Those measure *the audio pipeline*: frames per second, peak,
drain bytes/sec — all facts about whether PCM is moving. This sense measures something categorically different: **the
observability layer above the pipeline.** A station can be perfectly GREEN on every audio sense while this one is
RED — that is precisely the case that occurred, and collapsing them would destroy the distinction that makes either
useful.

**It is also not a new module.** `library-health.js` earns separateness by having a different *data source* (the DB
and disk) and a different cadence. This sense's inputs are `noteDeck` — already in `audio-health.js` — plus one new
`note*` sibling. It belongs **in `audio-health.js`, as an additional branch of the existing per-station record and
`evaluate()` ladder**, for three reasons:

1. It shares the record (`r.uuid`, `r.activeDecks`, `r.enginestate`, the `playing` predicate at `:155`).
2. It shares the tick, the hysteresis, the JSONL writer and the snapshot — free, and identical by construction.
3. A second module would need its own copy of all of that, which is how conventions drift.

**Precedent modelled on: the silence sense** (`audio-health.js:164`, `:169`). Structurally identical — "a thing that
should be producing a signal has not produced one for N seconds, while we know it is live" — with the same two-tier
10 s/30 s ladder and the same "while playing" qualifier. This sense is that pattern applied one layer up: from
*"audio is flowing but silent"* to *"events are flowing but unapplied"*.

**One design decision to make explicitly at build time:** whether UI LIVENESS contributes to the station's single
rolled-up level or is reported as a **separate axis**. Recommendation: **separate axis.** A frozen deck view is not
an on-air emergency and must never make an airing station show RED next to genuine dead-air conditions. The station
level answers *"is this station on air correctly?"*; UI liveness answers *"can the operator see it?"* — related,
not the same question. That needs your call before code.

---

## 5. What this does NOT do

**It observes and reports. It does not fix.**

- **No auto-recovery.** It will not re-subscribe, re-init an engine, reload a window, or touch playout. Naming the
  failure is the deliverable; recovery is a separate decision with its own risk (a re-subscribe that fires while a
  station is airing is exactly the class of change that needs its own design).
- **It does not diagnose the cause.** It says *"events are arriving and not being applied for station N"* — a fact.
  Which renderer, which guard, which stale closure is still a code question. What it removes is the part that cost a
  day: not knowing which side was dead.
- **It does not replace the temporary `[DECKDBG]` instrumentation** for the current hunt; it is what that
  instrumentation should become once the cause is known. Per `CLAUDE.md`, the temporary tooling still expires — it is
  logged for teardown at the top of `docs/backlog.md`.
- **It does not cover popout windows individually** in v1 — "at least one renderer is applying" (§2). Per-window
  attribution is a refinement.
- **It does not change any existing threshold, level, or event.** Purely additive.

---

## Architecture compliance

- **`CLAUDE.md` — "BUILD THE SENSE, NOT THE SCAFFOLD … honest state (observed, never claimed)."** This is the
  permanent sense the temporary instrumentation is standing in for. Every level is computed from an observed
  timestamp; nothing is inferred.
- **`CLAUDE.md` — "Every feature ships with its own built-in observability … visibility in the Health Monitor."**
  It lands in the Health Monitor by construction, using the existing snapshot and JSONL.
- **`CLAUDE.md` — "TEMPORARY TOOLING EXPIRES … if a diagnosis ever seems to need a temporary watcher, that is a
  product gap: propose the permanent built-in sense instead."** This document is that proposal, filed while the
  temporary watcher is still armed.
- **Precedent honoured:** `library-health.js` proves the multi-module pattern; the silence sense
  (`audio-health.js:164,169`) supplies the exact threshold shape; `:174-181` supplies the "quiet ≠ no data"
  discipline this sense generalises.

## Open decisions before code

1. **Separate axis vs rolled into the station level** (§4). Recommendation: separate axis.
2. **The renderer→main applied heartbeat** — its channel name and rate limit (§2, Fact B). It is the only new
   plumbing, and the only place this design touches the renderer.
3. **Per-window attribution** — deferred; confirm "at least one renderer" is the right v1 semantic.

## Scope note

Design only. No code written, nothing committed, nothing built. The temporary `[DECKDBG]` instrumentation and the
un-shipped engine-teardown and recording-UI changes remain in the working tree, untouched by this document.
