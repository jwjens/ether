# Design of record — the renderer becomes a pure VIEW of the daemon's deck state

**Date:** 2026-07-30 · **Status:** DESIGN ONLY. Nothing built. Supersedes the §3 patch in
`deck-state-mixed-across-tracks-2026-07-29.md` and the 4.4.104 resync — **both failed because they
corrected the copy instead of removing it.**

**The rule being restored:** the daemon is the single source of truth for deck state; the renderer consumes
events and never mirrors state back. Today's renderer keeps a second, independently-evolving copy — and
every deck fault of the last two days is that copy diverging from the daemon's truth:

| Symptom | The divergence |
|---|---|
| Frozen countdown / dead animation | duration carried across a track change → position clamps at the wrong value → `stateChanged` sees nothing move → no listener fires |
| 0:00 ↔ correct oscillation (4.4.104) | position re-anchored from a source that has no position |
| Two decks on air (station 4) | the renderer running its **own advance chain** into the daemon's Rust engine |

One cause, three faces.

---

## 1. What gets DELETED (daemon mode)

All in `src/audio/engine-rodio.ts` unless noted.

### 1.1 The Rust round-trip that opens every poll — `:408`

```ts
const s = await invoke("audio_get_state", { stationId: this.stationId });
```

Unconditional, 4×/second, in **both** modes. In daemon mode `s` describes main's in-process addon, which is
not the engine producing audio. It feeds `prevA/B/C`, `rustEnded*`, `checkEndByPosition` and the CART block —
every one of which is either already inert in daemon mode or must become so. **Delete in daemon mode; keep
only for the in-process branch (§3).**

Note it also returns a payload with **no `position_sec` / `duration_sec`** at all
(`native/src/audio.rs:82-92`, `DeckInfo`) — the fact that made 4.4.104 write zeros. That is not a bug to fix
here; it is the reason this call has no business being a state source.

### 1.2 The local wall-clock position tick **as state** — `:411-413`, `:420-424`, `:429-431`

```ts
const elapsed = (now - this.lastPollTime) / 1000;      :410
const durA = this.stateA.durationSec;                   :415   ← carry-forward, see 1.3
const posA = (this.stateA.status === "playing")
  ? Math.min(this.stateA.positionSec + elapsed, durA || 9999)   :420
  : this.stateA.positionSec;
this.stateA = this.daemonDriven ? { ...this.stateA, positionSec: posA } : { … };   :429
```

The tick itself is not the problem — a smooth countdown between ~1 Hz events is desirable. **Writing it into
`stateA/B/C` is.** Once written it becomes indistinguishable from observed truth, it is what the next tick
extrapolates from, and it is what `stateChanged` compares. Delete the write; the interpolation moves to
render time (§2.2).

### 1.3 The duration carry-forward — `:415-417` and `:429-431`, and CART `:456-460`

```ts
const durA = this.stateA.durationSec;                                    :415
… { ...makeState("A", s.deckA), durationSec: durA, positionSec: posA }   :429  (in-process branch)
const durCart = this.stateCart.durationSec; …                            :456-460
```

This is the mixing bug exactly: title/artist/filePath/status rebuilt fresh, `durationSec` re-imposed from the
previous tick. **Delete.** Duration arrives with its track, in the same `onDeck` payload, or not at all.

### 1.4 The raw-Rust state rebuild — `:429-431` (in-process branch) and `:460` (CART)

`{ ...makeState("A", s.deckA), … }` — a whole-state rebuild from §1.1's payload. **Delete in daemon mode.**
Retained only under §3's in-process gate.

### 1.5 The renderer's advance / preload / end-detection paths — daemon mode

These are **already guarded**, and the guards are correct. The design does not add guards; it makes the
guard's premise enforceable (§3), because on station 4 `daemonDriven` was **false** while the daemon was
driving, so every one of these ran:

| Path | Line | Guard today |
|---|---|---|
| `checkEndByPosition` — end detection + `handleRotate` | `:472`, guard `:479` | `if (this.daemonDriven) return;` |
| `preloadDeck` | `:584`, guard `:585` | same |
| `refillIfNeeded` | guard `:605` | same |
| post-rotate preload pair (**the rogue loader**) | `:547-556` → `preloadDeck` | via `:585` |
| queue purge | guard `:717` | same |
| `handleRotate` | `:520` | reached only from `checkEndByPosition` |

**Additionally delete in daemon mode:** `checkEndByPosition`'s three call sites (`:441-443`) and the CART
block (`:453-461`) — CART position/duration should come from the daemon's own cart events, not a local tick.

### 1.6 `setDeckDuration` — `:629-633`

A public setter that writes `durationSec` into state from outside. Nothing should be able to do that in
daemon mode. **Delete, or make it a no-op when `daemonDriven`** (check callers first).

## 2. What REMAINS

### 2.1 Atomic event application — **already correct, keep verbatim**

`:224-241`. One payload in, one whole object out:

```ts
const st = makeState(id, m.state || {});                     :233
if (id === "A") this.stateA = st; else if (id === "B") … ;    :237
this.lastFiredState[id] = st;
this.listeners.forEach(l => l(id, st));                       :239
```

Title, artist, filePath, status, position, duration and contentClass all come from the same daemon payload
and can never disagree. **This is the whole state machine after the deletion.** The station guard (`:230`)
and the A/B/C guard (`:232`) stay as they are.

### 2.2 Display-only interpolation — the one new thing

The daemon emits ~1/s per playing deck (`_changed` includes `Math.floor(positionSec)`), which is too coarse
for a smooth countdown or progress fill. So interpolate **at render time, never into state**:

```
DeckState (from the daemon, immutable between events):
    positionSec, durationSec, status, observedAt   ← observedAt stamped on receipt

displayPosition(state, now) =
    state.status !== "playing" ? state.positionSec
      : min(state.positionSec + (now - state.observedAt)/1000, state.durationSec || Infinity)
```

Properties that matter:

- **Pure function of (last event, clock).** Never accumulates — each frame recomputes from the last observed
  anchor, so error can never compound. Today's tick adds `elapsed` to its own previous output, which is
  exactly why a missed event freezes forever.
- **Self-healing.** A late or dropped event costs at most one interval of smoothness; the next event resets
  the anchor. No correction path is needed, which is what 4.4.104 was trying and failing to build.
- **Cannot mix tracks.** `positionSec` and `durationSec` come from the same object; there is no carry.
- **Where it lives:** a `useDeckDisplay(state)` hook driven by `requestAnimationFrame` (or a 250 ms timer
  for text-only readouts), returning `{ positionSec, remainingSec, progress }`. `observedAt` is the only new
  field on `DeckState`, and it is set exactly once, in the `onDeck` handler.

**The clamp survives, but harmlessly** — clamping a value derived from a duration that always belongs to the
current track is correct behaviour, not a freeze.

### 2.3 Everything else the engine does

Queue/Up-Next (`resyncDaemonQueue`), engine-state mirror, playstart relay, `deckSched`, jingle events,
volume, and every **command** method (`play`/`pause`/`stop`/`loadToDeck` as *operator actions*) are unchanged.
The renderer stays a full controller — it just stops being a second model.

## 3. The in-process branch — when it is legitimate, and how to make the gate real

**Legitimate exactly when the daemon is genuinely absent:** `AUDIO_DAEMON` off by configuration, the daemon
failed to spawn, or a platform without it. Then main's in-process addon *is* the engine, and everything in §1
is correct behaviour, not a bug. **It must not be deleted — it must be made unreachable while the daemon
drives.**

**Why the gate failed on station 4.** `daemonDriven` is decided **once**, and never revisited:

```ts
:186-190   if (this.daemonDetectStarted) return;
           this.daemonDetectStarted = true;
           a.daemonEnabled().then(on => { this.daemonDriven = !!on; if (on) { …attach… } });
```

If that resolves `false` — the socket not up yet at init, which is the known cold-stage race in
[[cold-stage daemon race]] — the engine runs its own advance **for the life of that engine, with no retry**.
That is how two brains ended up on one Rust engine.

**Three changes, smallest first:**

1. **Make the decision re-checkable, not one-shot.** Poll `daemonEnabled()` on the existing low-frequency
   tick until it answers `true`, then attach and latch. Never latch `false`.
2. **Make the modes mutually exclusive at the command boundary, not at each call site.** Today each path
   carries its own `if (this.daemonDriven) return;` — six places, any one of which can be missed by a future
   edit. Replace with a single choke point: in daemon mode the engine's *autonomous* actions
   (`checkEndByPosition`, `preloadDeck`, `refillIfNeeded`, `handleRotate`) are not reachable at all — e.g.
   the poll loop that drives them is never started. **One decision, not six.**
3. **Make the mode observable.** `[ROT] daemon-driven` vs `[ROT] in-process` now lands on disk (repaired in
   4.4.109), and the mode belongs in the Health Monitor per station beside the engine row. A station running
   in-process while the daemon is up is a **fault**, and it should say so rather than be inferred from an
   operator-row timing signature two days later.

**Assertion worth adding:** if `daemonEnabled()` is true and this engine has `daemonDriven === false`, that is
a contradiction — log it loudly and refuse to run the local advance.

## 4. What breaks — every consumer of the renderer's state fields

The engine's read surface is `getDeck(id).getState()` (`:638-641`) and the `on(fn)` listener (`:627`). Both
keep their shapes; only the *provenance* of `positionSec`/`durationSec` changes.

| Consumer | Reads | Survives? |
|---|---|---|
| `App.tsx:466-468`, `:1513-1515` — deck state → React | whole `DeckState` | **Yes.** Same object shape; values now event-sourced. |
| `App.tsx:1338-1339`, `:1389`, `:1429-1451` — status checks for keyboard/automation | `status` | **Yes.** `status` is already event-owned in daemon mode. |
| `ConsoleStrip` / deck fill — progress bar | `durationSec - positionSec` | **Changes.** Must switch to `useDeckDisplay` for smoothness; reading raw state gives a 1 Hz step. **This is the fix for the frozen fill**, not a regression. |
| `BroadcastMonitor.tsx:95-134`, `:389-390`, `:427-428` | `positionSec`, `durationSec` | **Yes** — already takes them as props from a payload; wire to the interpolator for smoothness. |
| `AutoCue.tsx:146,192` | `durationMs` from the song row, not deck state | **Unaffected.** |
| Now-Playing push / play log (`onPlayStart`) | title/artist/filePath | **Yes** — relayed from the daemon already (`:243-247`). |
| Up Next (`resyncDaemonQueue`) | queue, not deck state | **Unaffected.** |
| `getDeckSched` (`:712`) — Calendar row identity | `deckSched`, set in the `onDeck` handler (`:235`) | **Yes.** |
| Cart UI — polls `getDeck("CART").getState()` | CART position/duration | **EXCEPTION — see below.** CART keeps its local tick. |
| `setDeckDuration` callers (`:629`) | writes duration | **Must be audited** before §1.6. |
| In-process installs (daemon off) | everything | **Unaffected** — §3 keeps that path intact. |

### The CART exception — DECIDED 2026-07-30 (Jeff)

**CART keeps its local tick. It is the one documented exception to "the renderer is a pure view", and
§1.4's deletion does NOT apply to `stateCart`.**

Reasoning of record:

- **CART is an operator instrument, not rotation.** It is the 7th mixer slot, fired by hand, and it never
  participates in the advance chain — no rotate, no preload, no end-detection drives the music queue from it
  (`poll()`'s CART block is explicitly excluded from `checkEndByPosition` for exactly that reason).
- **The divergence class cannot bite it.** The mixing bug needs a *track change the renderer did not
  originate*. Every CART change is operator-initiated in this same renderer, so duration and title always
  arrive together from the caller that loaded it.
- **The alternative costs more than it buys.** Making the daemon emit CART deck events adds a new event type
  and a new consumer to the very boundary this design exists to simplify, to serve the one surface with none
  of the problem.

**Obligation that comes with the exception:** it must be written down where the next person will look — a
comment at the CART block in `poll()` and at `stateCart`'s declaration saying *why* it is exempt, so it reads
as a decision rather than an oversight. Without that note the exception becomes the next inconsistency
someone "fixes".

**One thing I will not claim:** that
no component reads `positionSec` off a render-tick assumption I have not found. **Before building, the
sweep is: every `getState()` call site and every `on(fn)` subscriber, enumerated and classified.** That sweep
is part of the build, not of this design.

## 5. Sequencing

1. **§3 first** — the gate. It is the safety property: it removes the second brain and makes the mode
   observable. It is also the smallest change and independently valuable.
2. **§2.2** — add `observedAt` + the display interpolator, wired to one deck as a canary, while the old tick
   still runs. Both visible side by side.
3. **§1** — delete the local state writes, mode by mode, with the consumer sweep done first.
4. Retire the resync remnants and `setDeckDuration`.

**Not to be bundled with:** the auto-fitter, the flip's refill trigger, or `_schedCursor`. This is a renderer
architecture change; those are playout scheduling.

## Blast radius

**The renderer's entire deck UI.** No daemon change, no audio path change — but every deck readout, progress
fill, countdown and keyboard status check reads through this state. A mistake here is silently wrong numbers
on screen during a live show, which is the failure mode Ether can least afford after the last two days.
Mitigations: the canary step in §5.2, the consumer sweep before §5.3, and the fact that §3 alone (the highest
value) touches no display code at all.

---

**Approval requested on:** the deletion list (§1), the interpolator contract (§2.2), the single-choke-point
gate (§3.2), and the CART decision in §4. **Building nothing until Jeff approves.**
