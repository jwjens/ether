# Jukebox as a Deck Source — design of record

**Date:** 2026-08-17 · **Status:** DESIGN APPROVED → **BUILT** (see §10 for the build record and the
one honest gap). Runtime **UNVERIFIED** — no one has heard it yet.
**Requested by:** Jeff · **Supersedes:** the manual-mode / play-next model in
`docs/jukebox-mode-design-2026-08-04.md` §2.3 and `docs/jukebox-rebuild-design-2026-08-17.md` §0.3.

> **The ruling:** the jukebox is an **audio source**, not a station mode. It patches into a deck like a
> microphone. Select it on a deck, fader up, channel on — its audio flows through that deck and is
> mixed on the board like any other source. The station's log, AUTO/MANUAL state and scheduling are
> **completely untouched**.

---

## 1 · The audio path — engine-native, kiosk is remote control

**Answer: the ENGINE plays the audio natively on a real deck; the kiosk window is a remote control.
A renderer-side player cannot feed a deck slot — there is no such path, and building one would put the
jukebox off-stream.** Receipts below, because this is the decision everything else rests on.

### 1.1 · What the engine can actually be told to do

The Rust NAPI surface (`native/src/lib.rs`) is **file-addressed, end to end**:

| Receipt | What it says |
|---|---|
| `native/src/lib.rs:60` | `audio_load(deck, file_path, title, artist, gain_db, station_id)` |
| `native/src/lib.rs:86` / `:99` / `:107` | `audio_play(deck)` · `audio_pause(deck)` · `audio_stop(deck)` |
| `native/src/lib.rs:123` / `:136` | `audio_set_volume(deck, volume)` · `audio_set_muted(deck, muted)` |
| `native/src/lib.rs:182` | `audio_get_state(station_id)` → per-deck `{id,status,title,artist,file_path,volume,is_finished}` |

**There is no PCM-in anywhere in that surface.** No `feed`, no `push_samples`, no input-device
capture, no stream handle. A deck's source is a *file path* the engine decodes itself. So "route a
renderer player into a deck" has nothing to attach to.

### 1.2 · Why the mic analogy is instructive but must not be copied literally

The mic *deck type* exists (`src/components/DeckConfigurator.tsx:8` —
`DeckType = "music" | "mic" | "guest" | "cart" | "desk" | "video"`), and it is the dropdown Jeff
means. But the mic's **audio** does not go through the engine at all:

- `src/components/MicDeck.tsx:113-133` — `getUserMedia` → EQ chain → gain → analyser →
  **`ctx.destination`**. That is the renderer's WebAudio output, i.e. the local sound card.
- The stream and the processing chain are fed by the **program bus** in Rust
  (`native/src/audio.rs:743-758` — ring buffer → `drain_program_bus` → stream client;
  `:1302` gates on `stream_connected`). Nothing in the renderer writes to that ring.

> **Consequence, flagged because it is bigger than the jukebox:** a renderer-side source is heard on
> the operator's own output only. It is not in the program bus, so it is not in the Icecast stream,
> the loudness/limiter chain, or the broadcast delay. If a mic deck is believed to be on-air through
> Ether rather than through a hardware console, that belief is worth a runtime check — **UNVERIFIED
> here, and out of scope for this task.** One line, not an investigation.

**Copying the mic pattern for the jukebox would therefore ship a kiosk nobody at home can hear.**
That is the opposite of "mixed on the board like any other source."

### 1.3 · The architecture that matches how decks already work

A jukebox play is exactly what a music deck play already is: a file, loaded and played on a deck, by
the daemon, in Rust.

```
kiosk window (remote control)          daemon (owns the engine)              Rust
  pick / AUTO decides a song  ──cmd──►  jukebox:play D {filePath,…}   ──►  audio_load("D", …)
                                                                      ──►  audio_play("D")
                                        emits deck + playstart
                                        writes play_log source=jukebox
  renders queue + honest state ◄─event─ deck events / jukebox:state
```

> **As built** the daemon calls the addon directly rather than going through `loadToDeck` /
> `_fireStart`, for one structural reason that is not a policy choice — `engine.js:396` resolves any
> deck that is not A or B to **deck C's state object**. See §10.0. The events and the log row are the
> same either way.

| Receipt | What it gives us |
|---|---|
| `audiod/engine.js:1380` `loadToDeck(id, item)` | the single load funnel; `id` is passed straight through |
| `audiod/engine.js:339` `_load(deck, fp, …)` → `A.audioLoad(deck, …)` | the deck id reaches Rust unmodified |
| `native/src/audio.rs:212-222` | Rust accepts decks **A, B, C, D, E, F, CART** |
| `audiod/engine.js:1392-1401` `_fireStart(deckId)` | emits `playstart` **and writes `play_log`** — for whatever deck id it is handed |

The kiosk never holds audio. The daemon stays the single source of truth for what is playing, exactly
as it is for every other deck.

### 1.4 · The isolation is structural, not a flag — the best receipt in this doc

**Station automation enumerates decks A, B and C. Only.** Hard-coded, in every path:

`audiod/engine.js:521`, `:604`, `:648`, `:708`, `:751`, `:905`, `:950`, `:1239`, `:1261`, `:1599`,
`:1664`, `:1698`, `:1795`, `:1868`, `:1965` — all `["A", "B", "C"]`.

So a jukebox routed to **D, E or F is invisible to rotation, the log reader, the top-of-hour cut and
the advance chain** — not because a flag says to leave it alone, but because those code paths never
name that deck. "The station's own world is COMPLETELY UNTOUCHED" becomes a property of the
architecture rather than a promise in a comment.

> **Therefore: jukebox routing is restricted to decks D/E/F.** Offering A/B/C would hand the public a
> deck rotation also drives — two schedulers fighting over one deck, which is the exact failure the
> previous design was rejected for. The dropdown must not offer them.

### 1.5 · The one gap to build

The daemon's **inbound** command handlers gate to A/B/C (`audiod/engine.js:1484`, `:1569`, `:1643`),
so today nothing can ask it to load D/E/F. That gap is the build:

- a small jukebox-scoped command set (`jukebox:play` / `jukebox:stop` / `jukebox:state`) that accepts
  **D/E/F only** and **does not** enter the rotate/advance chain or touch `deckReady` / `manualCue`;
- no change to any A/B/C path. Nothing existing is modified — this is additive.

**Built as described** (§10.1), with the load/play issued straight to the addon rather than through
`loadToDeck` — §10.0 records why.

---

## 2 · The jukebox's own AUTO

A button inside the kiosk window, owned entirely by the kiosk. It has no relationship of any kind to
the station's AUTO — different decks, different code path (§1.4).

| State | Behaviour |
|---|---|
| **AUTO engaged** | Continuously shuffles the checked categories on the jukebox deck. A request **jumps the shuffle** — it plays next, then shuffle resumes. Blinking on-air indicator in the window corner. |
| **AUTO disengaged** | Plays **only** explicit requests, in order. Queue empty → **silence**, deliberately, and the window says so rather than inventing something to play. |

**Chaining** is off the engine's own state, never a renderer timer: `audio_get_state` reports
`is_finished` and `status` per deck (`native/src/lib.rs:182`), delivered on the existing engine-state
stream. When the jukebox deck goes idle, the kiosk decides the next item and issues one load+play.
Nothing is predicted; the next song is chosen when the deck actually finishes.

**Honest indicator:** the on-air blink is driven by the deck's *observed* `status === "playing"` for
the routed deck, not by whether AUTO is engaged. AUTO engaged with the fader down must not blink
"on air" — that would be a claimed state, and this codebase has paid for those.

## 3 · Routing state — what the operator is told

The kiosk reads the routed deck's `volume` and `status` (both in `audio_get_state`) and says exactly
what is true. It **keeps its queue in every case** — routing is about audibility, not about the queue.

| Observed | What the window says |
|---|---|
| no deck assigned | "Not routed to a deck — pick Jukebox as a deck source on the dashboard." |
| routed, fader down / muted | "Routed to Deck D — fader is down. Nothing is reaching air." |
| routed, channel off | "Routed to Deck D — channel is off." |
| routed, up, playing | the blinking on-air indicator, and nothing else |

Same rule as everywhere: observed, never inferred. The window never claims air it cannot see.

## 4 · play_log

**Free, and correct, by taking the path above.** `_fireStart` writes the row for any deck it is
handed (`audiod/engine.js:1392-1401` → `audiod/playlog.js:21` `logPlay`), including `deck`/`deck_id`,
`file_path`, `station_id` and `content_class`. A jukebox play logs like any deck source plays,
carrying its deck letter, so reporting and the affidavit join keep working with no special case.

Open question for Jeff, deliberately not decided here: **should jukebox plays be distinguishable in
the log** (e.g. the requester's name, or a marker), or is an ordinary play row on deck D exactly
right? The `jukebox_requests` row already holds the name and can be joined by `file_path` + time, so
nothing is lost either way — but if you want it visible *in Play History*, say so and it is one field.

## 5 · The (B) play-next path — **agreed, KILL it**

No disagreement. Killing it is right, and for a stronger reason than operator confusion:

Under the deck-source model a request must **never** enter the station's queue. If it did, it would
air through the station's own decks, outside the jukebox fader, on the operator's log — the precise
coupling this ruling removes. (B) is not a redundant second path; it is a path that would now be
*wrong*.

**Sequencing consequence, stated plainly:** (B) is the only thing that currently makes a request
audible. Between removing it and finishing §1.5, the jukebox takes requests and plays nothing. That is
correct-but-mute, not broken — worth knowing before the interim build is judged on Jeff's screen.

## 6 · What Phase 1 (already built) keeps, unchanged

Relocation to hamburger → Windows, the kiosk pop-out, categories-as-pool in Preferences, the artwork
wall, the named queue with placement and the flashing **UP NEXT** at #2, the QR, the local-only
`jukebox_requests` table (migration v38, already verified 24/24), and the station-identity refusal to
guess. None of that is affected by this ruling — only what happens *after* a request is accepted.

## 7 · Phase 2 (public page) — unchanged

Requests land in the jukebox queue regardless of routing, exactly as designed in
`docs/jukebox-rebuild-design-2026-08-17.md` §2. Routing decides audibility; the web page decides
membership of the queue. No deploy without Jeff's explicit GO.

## 8 · Architecture compliance

| Rail | How this complies |
|---|---|
| ONE scheduler | The jukebox schedules nothing on the station. It owns one deck the station's scheduler structurally cannot see (§1.4). |
| Daemon = single source of truth | Load/play go through `loadToDeck` + the daemon's own state; the kiosk holds no audio and mirrors no queue. |
| Physical deck positions are sacred | Deck D shows what Rust deck D is decoding. The jukebox occupies a real deck honestly rather than inventing a virtual one. |
| Honest state | On-air blink and routing banners are read from observed deck status/volume, never from intent. |
| Build the sense | Routing state, on-air state and the play log are all visible in v1 — no bolt-on later. |
| Doors before rooms | The door is the deck source dropdown operators already use for mic/guest, plus the existing help entry. |
| No new schema | None. Deck assignment is a `deck_configs` type (v35 table) + the existing `station_config_kv` keys. |

## 9 · What I need from Jeff before building

1. **Deck restriction to D/E/F — confirm.** §1.4 is the whole isolation guarantee. If you want the
   jukebox selectable on A/B/C, say so and I will design the collision handling instead, but I would
   be building the problem the ruling just removed.
2. **§4 — plain deck play row, or mark jukebox plays in Play History?**
3. Anything in §2's AUTO behaviour you want different — in particular whether a request should
   interrupt a shuffled song already playing, or wait for it to end. **I have assumed it waits**
   (jumps the *shuffle*, not the *song*), because cutting a song mid-play in front of an audience is
   the more surprising behaviour and the harder one to undo.

---

## 10 · Build record — 2026-08-17

### 10.0 · Jeff's clarifications, and the one place they changed the build

> **THE BOARD IS THE TRUTH.** "The jukebox does not need to hide from the station — whatever fader is
> live is what streams; putting the jukebox on air is an operator decision at the fader, exactly like
> a mic. Emit deck events normally for D/E/F. Don't build suppression or stealth; a jukebox play is a
> normal deck play on a deck automation happens to ignore."
>
> Plus: **event tool, not playout — no traffic, no spots, ever**; the play_log mark is **for honest
> history only**; requests are **strict FIFO** with no priority handling (priority/paid-skip is a
> future design with donations); and a request **never cuts a playing song**.

An earlier draft of the daemon path argued for skipping `playstart` so a public pick could not retitle
the station's now-playing. **That was overruled and removed.** There is no suppression anywhere in
this build: a jukebox play emits `deck` and `playstart` on the same channels as any deck play and
writes `play_log` like any deck play.

What survived from that draft is the *structural* reason for a standalone path, which is not a policy
choice: `audiod/engine.js:396` is
`_deckState(id) { return id === "A" ? this.stateA : id === "B" ? this.stateB : this.stateC; }` —
anything not A or B resolves to **deck C's state object**. Routing a jukebox load through the engine's
deck machinery would silently read and overwrite the mirrored state of the deck the station may be
airing from. The daemon's JS engine models exactly three decks; until that model is widened, the
jukebox keeps its own state and emits the same events.

### 10.1 · What was built

| Piece | Where |
|---|---|
| `play_log.source` — `NULL` = ordinary playout, `'jukebox'` = public pick | migration **v39** `scripts/migrate-play-log-source-phase-sync-39.js`; registered `scalar` in `electron/sync/synced-tables.js` play_log |
| daemon jukebox source, D/E/F only, emits `deck` + `playstart`, logs with the mark | `audiod/ether-audiod.js` — `jukebox:play` / `jukebox:stop` / `jukebox:state` |
| `source` threaded through the daemon's play logger | `audiod/playlog.js` |
| main-process IPC + R2/local path resolution + in-process fallback | `electron/main.js` — `jukebox:play` / `jukebox:stop` / `jukebox:deck-state` |
| renderer bridge | `electron/preload.js` — `ether.jukebox.play/stop/deckState` |
| `jukebox` deck type, offered on **D/E/F only** | `src/components/DeckConfigurator.tsx` — `DeckType`, `JUKEBOX_SLOTS`, `canHostJukebox`, type-picker filter |
| kiosk: own AUTO, ON AIR indicator, routing banner, FIFO drive, no-cut rule | `src/components/Jukebox.tsx` |
| the (B) play-next-into-rotation path | **REMOVED** — `Jukebox.tsx` no longer touches the station queue at all |

**Sync treatment of the mark:** `play_log.source` is a plain **synced** scalar, unlike the
local-authoritative `generated_schedule.source` it shares a name with. play_log is append-only history
that already travels (scope `station`); a mark that stayed home would make the history honest on one
machine and misleading on every other. It is never read to make a playout decision, so a remote value
cannot steer anything.

### 10.2 · The honest gap — D/E/F have no VU meter or position, and that is pre-existing

Jeff's clarification said meters should behave like any deck. They do not yet, and this is **not**
something the jukebox introduced:

- `native/src/audio.rs:962` — the per-deck telemetry loop is
  `for (i, id) in [(0usize, "A"), (1, "B"), (2, "C"), (6, "CART")]`.
  **Deck slots 3/4/5 (D/E/F) are not in it**, so they publish no level and no sample-clock position.
- `native/src/lib.rs:213-250` — `audio_get_levels` names `a`, `b`, `c`, `cart`, `master`. There is no
  `d`/`e`/`f`.

So a jukebox deck **plays and is mixed correctly** (`native/src/audio.rs:1151` sums *every* deck slot
with fader, channel cut and trim) and its **status/volume/finished are readable**
(`audio_get_state`, which does cover deckD/E/F) — but its VU meter reads 0 and it has no position
readout. The same is true today of any guest or mic deck on D/E/F.

**The fix is small and contained** — add `(3,"D"), (4,"E"), (5,"F")` to that tuple list, keeping the
existing `if i < 3` guard so `active_decks` keeps its meaning for `electron/audio-health.js`. It was
**not** done here because it is a change to the audio hot path in Rust and needs a native rebuild
(`cargo`/napi) plus a fresh `.node` for both the app and the daemon — Jeff's call, not a side effect
of a jukebox build. The incident note at `native/src/audio.rs:955-959` (the `DECK_LETTERS[6]` panic
that caused permanent dead air) is exactly why that loop gets changed deliberately or not at all.

### 10.3 · Gates

- `npx tsc --noEmit` → **0 errors**
- `node --check` → OK on all six touched JS files
- `verify-transformer-chain` → **39 migrations, no gaps, fresh chain v1–v39 clean**
- migration v39 self-verification → **all PASS**, including "no rows added or lost" and
  "NO backfill — existing history is left unmarked, not invented"
- `npm run test:sync` → **46/46** (re-run because `synced-tables.js` changed)
- `npm run build` → clean

### 10.4 · Not built, deliberately

Priority / paid-skip, donations, payments. Traffic and spots — the jukebox is an event tool and airs
neither, ever. The D/E/F metering change in §10.2. Phase 2 (the public request page) is unchanged and
still gated on Jeff's explicit GO.
