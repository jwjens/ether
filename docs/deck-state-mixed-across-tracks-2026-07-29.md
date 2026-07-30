# Why renderer deck state gets mixed across tracks — the animation bug

**Date:** 2026-07-29 · **Mode:** READ-ONLY. Source read only. Nothing changed, nothing built.
**Symptom:** every deck shows a duration belonging to a *different* track than its title, position clamps at that
wrong duration, and the countdown/animation stops. Distinct from the double-play.

---

## The cause, in one line

**`src/audio/engine-rodio.ts:438-440` rebuilds title, artist, filePath and status from Rust on every poll tick,
then deliberately overwrites `durationSec` with the value from the *previous tick*.** Title and duration therefore
come from two different sources by construction — every tick, for the life of the deck.

```ts
:427   const durA = this.stateA.durationSec;        // ← the PREVIOUS tick's duration
…
:438   this.stateA = this.daemonDriven
         ? { ...this.stateA, positionSec: posA }                                  // daemon branch — atomic
         : { ...makeState("A", s.deckA), durationSec: durA, positionSec: posA,    // in-process branch — MIXED
             contentClass: this.deckContentClass["A"] ?? null };
```

`makeState("A", s.deckA)` builds a **complete, coherent** state from Rust's current view of deck A — including
`duration_sec` (`:61`). The very next property in the same object literal throws that away and re-imposes `durA`.
When the track on the deck changes, the title flips to the new track and the duration does not. And it is
**self-perpetuating**: next tick `durA` is read back out of the state this line just wrote, so the wrong duration is
copied forward forever.

The correct duration is *present in the object being spread* and is discarded on the same line.

## 1. Are title, durationSec and positionSec updated atomically? — **Depends on the branch.**

**Daemon-driven: yes, atomic.** The `onDeck` handler builds the whole state from one payload and assigns it whole:

```ts
:233   const st = makeState(id, m.state || {});
:237   if (id === "A") this.stateA = st; else if (id === "B") this.stateB = st; else this.stateC = st;
```

One event in, one object out. Title, duration and position can never disagree on this path.

**In-process: no — they are guaranteed to come from different events.** Per `:438-440`, on every tick:

| Field | Source |
|---|---|
| `title`, `artist`, `filePath`, `status` | **Rust, now** (`makeState(id, s.deckA)`) |
| `durationSec` | **renderer memory, from an arbitrarily old tick** (`durA`) |
| `positionSec` | **renderer memory + wall clock**, clamped to that old duration |

This is not a race that sometimes loses. **It is the steady-state behaviour of the line.**

## 2. Can a stale duration survive while the title updates? — **Yes, and nothing can clear it.**

Every write to `durationSec` in the file (`grep durationSec src/audio/engine-rodio.ts`):

```
:438-440  the poll rebuild            → writes the PREVIOUS value back (the defect)
:469      the same pattern for CART   → same defect
:299-300  resyncDaemonDecks            → daemon mode only
:640-642  setDeckDuration(id, dur)     → only called by a renderer-side caller
:686      loadToDeck seed              → durationMs passed in by the caller
:694-697  loadToDeck async correction  → invoke("get_file_duration") resolving later
```

**Only `loadToDeck` and `setDeckDuration` can refresh a duration in-process, and both are renderer-initiated.** When
the **daemon** is the thing loading and rotating decks, `loadToDeck` is never called in the renderer for those
tracks — so no refresh ever happens. The stale duration is permanent for that deck.

**The consequence chain, exactly as seen:**

1. Deck's track changes in Rust → title updates, duration does not.
2. `positionSec` advances under `Math.min(pos + elapsed, durA || 9999)` (`:433`) → it **clamps at the wrong,
   usually shorter duration** and stops.
3. `stateChanged` (`:476-485`) compares status, filePath, title, `Math.floor(positionSec)` and durationSec. Once
   position is pinned at the clamp and nothing else moves, **it returns false on every tick — so no listener is
   ever called and the UI stops repainting entirely.** That is the "animation does not work" report, precisely.
4. The 4.4.104 position resync cannot rescue it: it re-anchors position, then the very next tick re-clamps that
   position against the same wrong `durA`.

**The screenshot is this signature on all three decks at once:**

| Deck shows | Queue says the track really is |
|---|---|
| California Christmas — **1:12 / 1:12** | 3:33 |
| Spot_Free_Christma… — **1:47 / 1:48** | 0:18 |
| Holiday Road - 2024… — **3:31 / 3:32** | 2:12 |

Every deck: position == duration (clamped), duration unrelated to the titled track. NOW PLAYING reads `1:12` and
`-0:00`.

**Two further mixing sites, narrower but the same class:**

- **`loadToDeck`'s async duration (`:692-698`)** — `invoke("get_file_duration")` resolves *later* and writes
  `durationSec` onto whatever the deck holds at that moment. If the deck changed track during the await, it stamps
  the **old file's** duration onto the **new** track. A genuine race, unguarded by any identity check.
- **`resyncDaemonDecks` (`:281-301`)** — `merged = { ...cur, volume: auth.volume }` keeps `cur`'s title, then
  conditionally takes `auth.durationSec` and `auth.positionSec`. If `cur` is stale relative to `auth`, the result is
  the old title with the new duration. Narrow (the next `onDeck` event corrects it within ~1 s) but it is a mixing
  path, and it is code I shipped in 4.4.104 — owning it here.

## A corroboration worth recording

The primary defect lives **only in the in-process branch**. The daemon branch is atomic and cannot produce a
persistent three-deck mismatch. **So the station in the screenshot was running its renderer engine in in-process
mode** — independent support for the second-brain finding in
`docs/station4-vs-working-stations-diff-2026-07-29.md`, arriving from the UI instead of from the daemon log.

Marked as strong inference, **not proof**: the runtime receipt is still the `[ROT] daemon-driven` vs
`[ROT] in-process` line, which goes to a path that does not resolve in a packaged install
(`electron/main.js:3299`) — the repair you authorised and I have not built.

## 3. The fix — deck state is one coherent unit per track

**Principle: a duration only ever applies to the track it was measured for.** Any value carried across a track
change is wrong by definition. Three changes, all in `src/audio/engine-rodio.ts`, no daemon involvement.

**(1) Carry track identity in `DeckState`, and key every carried-forward value on it.** `filePath` is already in
the state and already the identity `stateChanged` uses (`:480`) — no new field strictly needed, though an explicit
`loadGen` counter bumped in `loadToDeck` is sturdier against two loads of the same file. This is the pattern
already established in this codebase by **4.4.93 (`fix(ui): deck progress fill re-arms per track — identity-keyed`)**
— follow it, don't invent a second one.

**(2) The poll rebuild takes duration from the same payload as the title.** Replace the unconditional
`durationSec: durA` with: use the fresh value from `makeState`, and fall back to the carried value **only when the
identity is unchanged AND the fresh value is absent or 0.** That preserves the reason the override exists — Rust
can report `duration_sec = 0` briefly right after a load, and the async `get_file_duration` value is the accurate
one — while making it impossible for a duration to outlive its track. Same treatment for CART at `:469`.

**(3) The async duration write is identity-guarded.** In `loadToDeck` (`:692-698`), capture the identity before
`await`/`.then()` and apply the resolved duration **only if the deck still holds that same track**; otherwise drop
it. Same guard for `resyncDaemonDecks`: take title, duration and position from `auth` **together, or take none of
them** — never merge one track's title with another's duration.

**What this does not fix, stated plainly:** it corrects what the *renderer displays*. It does not change any
daemon decision, does not touch playout, and does not address why a station is in in-process mode in the first
place — that is the second-brain question and a separate change.

**Blast radius:** renderer display only. `src/audio/engine-rodio.ts` is not on the audio output path in daemon
mode — no `_stop`/`_play`/rotate/timing behaviour is involved. The one thing to be careful of is (2)'s fallback: if
the fresh-value test is written wrong, a deck could briefly show `0:00` duration right after a load, where today it
shows a stale one. That is a visible regression, not an audible one, and it is the only risk surface.

---

## Scope note

Read-only. Source read; no file in `C:\openair` changed, nothing committed, nothing built. **No fix applied —
awaiting authorisation.**
