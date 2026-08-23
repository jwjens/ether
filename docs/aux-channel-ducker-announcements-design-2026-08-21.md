# The AUX source channel, the ducker, and announcements on air — design of record

**Date:** 2026-08-21 · **Status:** **APPROVED — design of record.** Phase 1 is authorised and sliced (see
PHASE 1 BUILD PLAN). **No slice starts without Jeff's GO; nothing is built yet.**
**Superseded status line:** REVISION 3 — FINAL. Every Part A
and Part B question is ruled. One item remains open (§C.3, closing time) and it blocks only its own slice.
Still DESIGN ONLY — nothing built, nothing changed.

### Rulings of record (2026-08-21)

| # | Item | Ruling |
|---|---|---|
| **A.1-A.4** | Channel pool | **FIXED POOL, N = 12**, new source channels appended at index 7+, existing indices stable. The console feel is UI; the engine array stays fixed. **CONFIRMED.** |
| **A.2** | `is_aux` hardcode | **Retire the positional test** for an explicit per-slot **kind flag** — the "never carts" rule reads from what a slot *is*, not where it sits. **CONFIRMED, in scope.** |
| **A.6** | File vs stream | **The real dividing line.** Phase 1 = file sources. Phase 2 = one stream-capture build delivering **Mic *and* network** (IP/Zephyr/AoIP) together. Config `{ kind, address? }` from day one, no migration. **CONFIRMED.** |
| **A.5** | Meters | **Extend the generic `decks: Vec<DeckTel>`, never named fields.** Closes the standing D/E/F meter gap. **CONFIRMED, in scope.** |
| **A.7** | Naming | **SOURCE channel.** "AUX decks" keeps meaning slots 3/4/5 in the engine. **CONFIRMED.** |
| **A.8** | Jingle | **SPLIT CONFIRMED.** Automated seam jingles **stay on CART** — the seam bridge depends on it and cart is correctly duck-excluded, because a sweeper must never duck its own song. The dropdown's "Jingle" is a **hand-fired imaging channel only.** |
| **B** | Ducker insertion | **CONFIRMED.** Duck lands after the ride computes gain, before the limiter; the ride's detector sees un-ducked music only; the duck lives on the **mix path, not inside the processor**, so it works with processing OFF. §B.3–B.4 are the design of record. |
| **F2** | Mic | In the dropdown with a device selector, as **Phase 2** — named, not hidden, not dropped. |
| **F3** | Dead AUTO-DUCK button | Started, never finished. **Retire/rebuild — in scope.** |
| **F4** | Announcements | Never truly in Ether; the `new Audio()` path never aired. **Rebuild engine-native — in scope.** |
| **C.4** | Content store | **DEDICATED announcement store, with the R2 materialization gate. CONFIRMED.** |
| **D** | Manual mode | **Hand-fired announcement cart does NOT duck.** The jock rides the fader. **CONFIRMED.** |
| **C.3** | Closing time by day | **STILL OPEN** — the answer arrived with the brackets unfilled. See §C.3 for a schema that makes the question non-blocking. |

---

## 0 · Four findings that change the shape of the brief

These came out of the read and they matter more than anything else in this document. Three of them mean
the work is **not** what it looks like from the dashboard.

### F1 · "AUX" is already two other things in this codebase

| Existing meaning | Receipt |
|---|---|
| **Slots D/E/F are already called "the AUX decks"** | `native/src/audio.rs:1514` — *"AUX decks are slots 3/4/5"*, `is_aux = i >= 3 && i <= 5` |
| **The AUX monitor bus** — a separate room/monitor output with its own device | `docs/aux-monitor-bus-design-2026-08-18.md`; `bus.aux_monitor_gain[7]`, `aux_ring_prod`, `processor_aux` |

Jeff's "aux deck" is a **third** thing: a source-switchable *program* channel. Three meanings of AUX in one
mixer is how a callback gets edited wrong at 2am. **Naming needs a ruling before code.** My suggestion:
call the new strip the **SOURCE channel** (or **AUX IN**, reserving AUX for the monitor bus), and keep
"aux decks" meaning slots 3/4/5 in the engine.

### F2 · The mic is not on the program bus, and cannot be without new engine work

This is the largest hidden item in the brief.

- `native/src/lib.rs` exports **38 napi functions and not one is an input, capture, or PCM-in path.**
  Decks are **file-addressed**: `audio_load(deck, file_path, title, artist, gain_db, station_id)`.
- `src/components/MicDeck.tsx:113-133` — `getUserMedia` to a WebAudio EQ/gain chain to **`ctx.destination`**,
  i.e. the *renderer's local sound card*. The mic never touches the Rust program bus.
- The jukebox design of record already established this: *"There is no PCM-in anywhere in that surface"*
  (`docs/jukebox-deck-source-design-2026-08-17.md` §1.1-1.2).

**Consequence:** Announcements and Jukebox are *file playback* and drop straight into the existing
deck-source model. **Mic is a live capture stream and is a different category of thing.** Putting "Mic" on
the source dropdown means **building a PCM input path into the engine** — device capture in Rust, a new
slot feed, resampling, and a latency/ownership story against the Show+ device layer, which already has no
broker and collides on same-device double-open.

The mic is also **the only one of the three that a ducker would classically be for**. So the feature Jeff
most likely wants ducking for is the one the engine cannot currently carry.

**Ruling needed: is Mic in v1 (and the engine grows a capture path), or is v1 Announcements + Jukebox with
Mic named as the reserved third source?** My recommendation is the latter — ship the channel and the ducker
on the two sources that already work, and treat mic-on-the-bus as its own arc with its own design doc.
Building a capture path *inside* this build hides a large engine change behind a UI dropdown.

### F3 · The mic's AUTO-DUCK button already exists and does nothing

`src/components/MicDeck.tsx:20-47` renders **"AUTO-DUCK ON / AUTO-DUCK OFF"** and its only effect is one
line: it assigns `window.__etherDuck`.

A grep for `__etherDuck` across `src/`, `electron/`, `audiod/` and `native/` returns **exactly one hit —
that write.** Nothing reads it. **There is no ducker in the product today**, and there is a control on the
dashboard claiming otherwise. That is an honest-UI violation of the kind this project treats as a defect,
and **retiring or wiring it is part of this build, not a footnote.**

### F4 · Announcements already exist — and they play OFF AIR with a counterfeit duck

`src/components/Announcements.tsx` (308 lines) is wired end to end: an `announcements` table, IPC
(`electron/preload-handlers.js:25-27`), a native menu entry (`electron/main.js:2829`), and a working
editor with `trigger_time`, `days`, `duck_music`, `duck_level`, `resume_music`.

What it actually does, at `Announcements.tsx:26-60`: it calls `deckA.setVolume(ann.duck_level)` and the
same on deck B, then builds a Blob URL and plays it with `new Audio(url)`, restoring both decks to
`setVolume(1)` in `onended`.

Five defects, all of which this design replaces:

1. **It never goes to air.** `new Audio()` plays out of the renderer's default output, not the program bus.
   Stream listeners have never heard an announcement. Same structural reason as the mic (F2).
2. **The duck is counterfeit** — an instant jump on the *fader value*, with no threshold, no hold, no fade,
   and no engine involvement.
3. **It restores to `1.0`, not to where the jock left it.** Any deck not sitting at unity comes back at the
   wrong level. This directly contradicts the channel-cut discipline the engine already honours
   (`audio.rs:1495-1502` — cut "never reads or writes the fader level").
4. **It ducks A and B only** — not C, not cart.
5. **`lastFiredMinute` is a module-level global**, shared across stations on a multi-station install.

**So Part C's *triggers* ride existing machinery; Part C's *audio path* must be rebuilt entirely.** The
existing panel is a good spec of intent and a bad implementation — exactly the thing Jeff's brief replaces.

---

## THE BUILD — Phase 1 and Phase 2

The file-vs-stream line (§A.6) is the phase boundary. Phase 1 is everything that works with the engine as it
is; Phase 2 is the one new engine capability. **Phase 1 does not depend on Phase 2 and ships whole.**

### Phase 1 — the SOURCE channel, the ducker, announcements on air (file sources)

| # | Deliverable | Where |
|---|---|---|
| 1 | **Fixed pool N = 12.** Slot constants 7 → 12; new source channels at indices 7-11; A/B/C, D/E/F, CART indices unchanged | `native/src/audio.rs` (`decks`, `peaks`, `aux_monitor_gain`, callback locals, `for i in 0..7`) |
| 2 | **Per-slot kind flag replaces `is_aux = i >= 3 && i <= 5`.** Ducker eligibility and monitor routing read the declared kind | `audio.rs:1516` + monitor-bus routing |
| 3 | **SOURCE channel strip** with `+` / `−`, fader, ON/PFL, and the source dropdown | dashboard |
| 4 | **Source config `{ kind, address? }`.** File kinds enabled: Jukebox, Announcement, hand-fired Jingle. Stream kinds shown **disabled with a Phase 2 affordance** | `deck_config` |
| 5 | **Per-channel meters** — extend `decks: Vec<DeckTel>`; closes the standing D/E/F meter gap | `audio.rs:184`, `:1276` → renderer |
| 6 | **The ducker** — detector on the source sum (post-fader, post-cut), gain on the mix path, §B.3 topology, §B.6 parameters, per-channel toggle | `audio.rs` callback + `program_processor.rs` split API |
| 7 | **Announcements engine-native** — `audio_load` / `audio_play` on a source channel. **On air for the first time** | replaces `Announcements.tsx` `new Audio()` |
| 8 | **Dedicated announcement store** with the R2 materialization gate and a health signal for missing files | new store |
| 9 | **Triggers out of the renderer** — absolute clock time + days (existing shape) plus relative-to-closing offsets | main process or daemon |
| 10 | **Retire the dead AUTO-DUCK button** (`__etherDuck`) — replaced by the real per-channel toggle | `MicDeck.tsx:20-47` |

**Phase 1 explicitly does NOT include:** any capture path, any device selector, any network source, and any
change to automated seam jingles on CART.

### Phase 2 — the stream-capture path (Mic **and** network, one build)

| # | Deliverable |
|---|---|
| 1 | **PCM-in path in the engine** — the capability that does not exist today (F2): samples arriving from somewhere other than a decoded file, fed to a source slot |
| 2 | **`Mic (device…)`** — the dropdown entry enabled, with a device selector, as one *kind* of stream source |
| 3 | **Network sources** — IP / Zephyr / AoIP endpoints as another kind, using the same `address` field Phase 1 already stores |
| 4 | **The Show+ device-broker story** — a mic device selector is a second claimant on hardware that already fails on same-device double-open. Phase 2 cannot ship without an owner for device acquisition |

**Why one build, not two:** Mic and network are the same problem — audio arriving as samples rather than as
a file. The capture path that serves a local input device serves a network endpoint with a different feeder
in front of it. Building them separately would build the hard part twice.

**The ducker does not change in Phase 2.** It triggers on source-channel audio regardless of where the
samples came from, so a mic and a Zephyr feed duck exactly like an announcement does — which is the point
of putting them all on one channel type.

---

## PART A — the SOURCE channel, console model (RULED)

**Jeff's reframe:** neither a pure wrap nor a fixed D/E/F picker. Configure Decks is already cramped — six
rows by seven source buttons. He wants the **console model**: **addable** channels on the dashboard (`+` / `−`),
each carrying a **source dropdown** like a Wheatstone bus selector. Sources: Jukebox, Jingle, Announcement,
Mic — and designed from day one to accept **network sources** (IP / Zephyr / AoIP) as later entries.

That is closer to REPLACE than WRAP, and it collides with the hot-path warning in the first pass. So this
section does what Jeff asked: **it treats "can this be addable safely" as its own question**, with the real
engine risk on both sides.

### A.1 · The fact that decides it — "fixed 7" is a compile-time constant, not an architecture

Every slot-count assumption in the engine is a **literal `7`**, not a structural limit:

| Receipt | What it is |
|---|---|
| `audio.rs:389` | `pub decks: [DeckSlot; 7]` |
| `audio.rs:395` | `pub peaks: [f32; 7]` |
| `audio.rs:445` | `pub aux_monitor_gain: [f32; 7]` |
| `audio.rs:1482-1483` | callback locals `exhausted = [false; 7]`, `frame_peaks = [0.0f32; 7]` |
| `audio.rs:1626` | `for i in 0..7 { bus.peaks[i] = ... }` |
| `audio.rs:1516` | `let is_aux = i >= 3 && i <= 5;` |

And — the part that matters most — **the callback already skips unused slots on a branch**:

```rust
for (i, deck) in bus.decks.iter_mut().enumerate() {
    if !deck.active || deck.paused { continue; }
    let Some(ref mut src) = deck.source else { deck.active = false; continue; };
```

**An empty slot costs one predictable branch per buffer and nothing else.** Raising `7` to `N` therefore adds
**no per-buffer work for channels nobody is using**. This is the single fact that makes the console feel
affordable, and it is why my first-pass warning was aimed at the wrong thing: the danger was never the
array's *size*, it was making the array's size *change at runtime*.

### A.2 · Option 1 — FIXED POOL (grow the constant once; the UI reveals and hides)

The engine array grows from 7 to N at **compile time**. The dashboard `+` reveals the next unused source
channel; `−` hides and releases it. To the operator it is addable; to the realtime callback nothing ever
changes shape.

**Index plan that keeps every existing invariant true:**

```
0,1,2   rotation decks A/B/C      (unchanged)
3,4,5   legacy aux decks D/E/F    (unchanged — the jukebox lives here today)
6       CART                      (unchanged — bus.peaks[6] is wired to level_cart)
7..N-1  NEW source channels
```

Appending keeps indices **stable**, which matters: `deck_config` rows, `bus.peaks[6]` feeding `level_cart`
(`audio.rs:1222`), and the monitor bus 3..5 special-case all keep working untouched.

**One hardcode to retire while we are here.** `is_aux = i >= 3 && i <= 5` is positional. With channels at
7.. it would become `i >= 3 && i <= 5 || i >= 7`, which is worse. **Replace the positional test with an
explicit per-slot kind flag** set from config (`deck.is_source_channel`). That makes the ducker's "never
carts" rule and the monitor bus routing read from the slot's declared kind instead of its address —
structural, not arithmetic. It touches the monitor bus, so it is a real (small) change, not free.

**Risk: LOW.** No allocation, no lock change, no new hot-path shape. The riskiest edit is the `is_aux`
replacement, which is testable off the audio thread.

### A.3 · Option 2 — DYNAMIC SLOTS (`Vec<DeckSlot>` sized at runtime)

`bus.decks` becomes a `Vec`, grown and shrunk as the operator adds and removes channels.

**Where the danger actually is** — and it is not where it looks:

- The callback iterates `bus.decks.iter_mut()` **while holding the BusState lock**, so add/remove is already
  serialized against it. Corruption is not the risk.
- The risk is that **growing a `Vec` reallocates and memcpys the whole backing store** — and `DeckSlot` holds
  live decoder state. That memcpy happens **inside the lock the callback needs every buffer**. An unbounded
  copy under the audio lock is exactly the shape of the 2026-07-10 mixer-callback wedge that
  `program_processor.rs` header exists to warn about.
- The mitigation is `Vec::with_capacity(MAX)` and never exceeding it — **at which point it is a fixed pool
  with extra steps.** Dynamic buys exactly one thing over a fixed pool: the ability to exceed the
  reservation. That single capability is also the only unsafe case.

**Risk: MEDIUM-HIGH for zero practical gain.**

### A.4 · RECOMMENDATION — fixed pool

**Take Option 1.** The console feel Jeff wants — press `+`, get a channel, pick a source — is a **UI
property, not an engine property**. A fixed pool delivers it exactly, and the realtime path never learns
that anything changed.

**Suggested N = 12**: 3 rotation + 3 legacy aux + 1 cart + **5 new source channels**. Eight source-capable
channels total, more simultaneous aux than any plausible station. **N is Jeff's to set** — the cost of a
larger N is one branch per unused slot per buffer plus a `DeckSlot` of idle memory.

### A.5 · What the console feel actually costs — the same under either option

**Source channels have no VU today.** The levels payload surfaces only the named fields
`level_a / level_b / level_c / level_cart` (`audio.rs:129-132`, `:1219-1222`), and the comment at `:120`
records that only A/B/C/CART were ever surfaced. The jukebox design already logged this as its honest gap
(`jukebox-deck-source-design-2026-08-17.md` §10.2: *D/E/F have no VU meter or position*).

A console channel strip without a meter is not a console channel strip. **The fix is already half-built:**
`Levels` carries `pub decks: Vec<DeckTel>` (`:184`), populated per slot with `peak: bus.peaks[i]` (`:1276`).
**Extend that generic per-slot vector; do not add more named fields.** Named fields are what made D/E/F
invisible in the first place.

This is the largest UI/telemetry item in Part A and it is **unavoidable under either option**, so it does
not affect the fixed-vs-dynamic ruling.

### A.6 · File sources vs streamed sources — the real dividing line, and Phase 2

The dropdown mixes two fundamentally different kinds of source. Naming the difference now prevents a schema
change later:

| Kind | Sources | What the engine needs |
|---|---|---|
| **File sources** | Jukebox, Announcement, Jingle | `audio_load(slot, file_path, …)` — **works today** |
| **Streamed sources** | **Mic**, and every **network source** (IP / Zephyr / AoIP) | **a PCM-in path that does not exist** (F2) |

So Mic and network are **the same build**, not two. Both are audio arriving as samples rather than as a
file. This changes how Phase 2 scopes: building the capture path for the mic **also** delivers the
network-source capability Jeff wants reserved.

**Phase 1 (this build):** the SOURCE channel, the `+`/`−` pool, the dropdown, per-channel meters, and the
ducker — on **file sources only**: Jukebox, Announcement, Jingle.

**Phase 2 (named, not hidden, not dropped):** the PCM-in path — `Mic (device…)` with a device selector, and
network sources on the same plumbing. Phase 2 must also answer the Show+ device-broker problem (no broker
today; same-device double-open already fails), because a mic device selector is a second claimant on the
same hardware.

The dropdown ships in Phase 1 **showing** `Mic (device…)` **disabled, with a Phase 2 affordance** rather
than absent — a door that says "not yet" beats a door that is not there.

**Config shape from day one:** a source is `{ kind, address? }` — `address` unused for file sources, a device
id for Mic, a URL/AoIP endpoint for network. One column now, no migration later.

### A.7 · Naming — SOURCE channel

Jeff offered "Source channel" or "AUX IN" and asked me to pick the clearest. **SOURCE channel.**

"AUX IN" still contains AUX, which already means two other things here (§F1) — the D/E/F slot group and the
AUX monitor bus with its own output device. A third AUX is how the wrong line gets edited in the callback.
**SOURCE** says exactly what the control does, and collides with nothing. Engine-side, "aux decks" keeps
meaning slots 3/4/5 as it does today.

### A.8 · The Jingle source — RULED: the split

**Jingles fire on CART today, and the seam machinery depends on it:**

- `audiod/engine.js:356` — *CART is the jingle overlay, not a rotation deck.*
- `engine.js:521` — `_jingleTick(now)` arms and fires the CART overlay each poll.
- `engine.js:799-800` — the **seam bridge** defers a rotation deck's end when a confirmed-firing jingle
  governs that seam.

Moving jingles onto a source channel would do two unwanted things:

1. **Break the seam bridge**, which keys on the CART overlay.
2. **Make jingles duck the music** — ducking triggers on source channels and cart is deliberately excluded
   (§B.5). A sweeper that ducks the song it is sweeping into is wrong.

**Recommendation:** keep **automated seam jingles on CART, untouched**, and let the dropdown Jingle entry
mean a **manually-patched imaging channel** — a jingle fired by hand on a source channel, which ducks like
any other source. Two different behaviours that happen to share audio files.

**RULED (2026-08-21): the split stands.** The alternative — one jingle path on a source channel — means rebuilding the seam bridge,
which is a scheduler-adjacent change, not a mixer change.

### A.9 · Folding the shipped jukebox in

Unchanged by the reframe: the jukebox already **is** a D/E/F deck source with `canHostJukebox(slot)` gating
(`DeckConfigurator.tsx:15, :228`). Under the fixed pool it keeps its slot and gains a better surface.
**Nothing in the jukebox audio path is touched.**

---

## PART B — the ducker, and the insertion-point ruling — CONFIRMED BY JEFF (2026-08-21)

**This is the whole technical risk, exactly as Jeff said.**

### B.1 · The chain as it actually is today

From `docs/aux-monitor-bus-design-2026-08-18.md` §1, confirmed against `native/src/audio.rs`:

```
slots 0..6 ──sum──► mix_l/mix_r        (post cut / trim / fader, :1151)
                       │
                       ├─ EQ (:1240) ─► × master_vol (:1265) ─► out_l/out_r (clean)
                       │                                          │
                       │                    [optional processor → proc_l/proc_r (:1291)]
                       │                                          │
  AIR  ◄── ring_prod ◄─┴──────────────────────────────────────────┤  (:1317, proc_stream ? proc : clean)
  ROOM ◄── data[] × monitor_vol × master_monitor_vol ◄────────────┘  (:1331, proc_local  ? proc : clean)
```

The processor is **one monolithic call**. `ProgramProcessor::process_planar` runs `ride.update(scratch)` on
**the same buffer it is about to gain**, then feeds the limiter — the ride's meter is fed the full summed
mix, and the gain it returns is applied to that same mix.

### B.2 · Why the obvious placement cancels the feature

If the duck attenuates the music inside the slot sum — i.e. **anywhere upstream of the processor** — then
`LoudnessRide::update` measures a quieter program, computes `desired = target - in_lufs`, and walks
`gain_db` upward at `rate_db_per_s = 1.5` toward a `clamp_db = 12.0` ceiling.

**The ride claws the duck back over roughly eight seconds, then pumps when the duck releases.** This is
precisely the failure Jeff named, and those constants are the receipt for it.

### B.3 · THE RULING

> **The duck multiply goes AFTER the ride's gain is computed and BEFORE the limiter. The ride's detector is
> fed the UN-DUCKED music sum only. The aux sum joins AFTER the duck and BEFORE the limiter.**

```
core sum (A/B/C/CART) ─► EQ ─► × master_vol ─┬─► ride.update(core) ──► g     [detector: music only]
                                             │
                                             └─► core × g × duckGain ──┐
                                                                       ├─► + ─► limiter (−1 dBTP) ─► AIR / ROOM
aux sum (D/E/F, post-fader, post-cut) ─────────────────────────────────┘
        │
        └─► duck detector (threshold → attack → hold → release) ─► duckGain
```

**Why each edge is where it is:**

1. **Ride measures music only, un-ducked.** The announcement must not drag the music's loudness ride, and the
   ride must never try to "make up" a level the ducker deliberately took away. This is the edge that makes
   the two features coexist.
2. **Aux sums in after the duck.** Otherwise the duck attenuates the announcement along with the music.
3. **Limiter sees the sum.** The −1 dBTP ceiling must hold on what actually leaves the box, announcement
   included. The existing bench already asserts exactly this shape for carts —
   `criterion_4_cart_processed_identically_and_ceiling_held`. **That test is the template for the ducker's
   ceiling test.**
4. **Detector reads the aux sum post-fader and post-cut.** Jeff already ruled this tap POST-FADER/POST-CUT on
   2026-08-18 (`audio.rs:1516-1528`, `aux-monitor-bus-design` §9.3) after an incident where a PFL tap produced
   "a source with no off switch". For a ducker this is not merely consistent, it is **required**: fader down or
   channel off means no audio, which means no duck. The board stays the gate.

### B.3a · AMENDMENT (2026-08-22) — the ride HOLD replaces the separate music stream

**§B.3 above stands as the goal. Its mechanism does not, and this is what gets built.**

Surfaced during slice 3: feeding the ride a music-only stream *at the same point in the chain* means
running that stream through the EQ — and `bus.eq` is **one stateful biquad instance behind a
try_lock**. The aux-monitor design already ruled a second pass through it a trap, in its own words:

> "obtaining EQ(aux) means running the **same stateful biquad chain** a second time on a different
> signal … feeding it two different streams per callback corrupts its state. This is a trap, not an
> optimisation." — `docs/aux-monitor-bus-design-2026-08-18.md` §3

The alternative — measuring the music pre-EQ instead — moves the shipped loudness ride's measurement
basis from post-EQ full-mix to pre-EQ music-only, **changing how processing behaves for every station
that has it on, duck or no duck**. Jeff's ruling: *"risking the shipped loudness ride to serve a
feature that isn't live yet is the wrong trade."*

**What is built instead:**

1. **Split in the deck loop.** Source-kind slots accumulate separately from the rest — the loop
   already discriminates by `deck.kind` (slice 1). `mix = music × duckGain + source`. **One EQ pass,
   unchanged.**
2. **Ride HOLD.** While `duckGain < 1`, `LoudnessRide.gain_db` does not move. On release it resumes
   from where it was.

This delivers §B.3's purpose exactly — **the ride cannot claw the duck back because it cannot move** —
with no change to the measurement basis and no second EQ pass. §B.4 is satisfied for free: the duck
lives in the deck loop, which always runs, so it works with processing OFF.

**The cost, stated rather than buried:** during a long source the ride stops adapting to the music.
Announcements are seconds long, so the trade is right — but it is a trade, not a free win. If a source
is ever held open for minutes (a mic, Phase 2), revisit this.

### B.4 · The trap that would ship a dead feature

**Processing defaults to OFF.** Both toggles are off by default, so the branch takes the clean tap and
**never calls the processor at all** (`audio.rs:428`; bench `criterion_2_passthrough_bit_identical`).

**Therefore the duck multiply cannot live inside `ProgramProcessor`.** If it does, ducking silently does
nothing for every station that has not switched processing on — which is all of them by default. Jeff would
fire an announcement, hear no duck, and the panel would claim it ducked.

**The duck must be applied on the mix path, with the processor as an optional stage inside it.** Concretely,
the callback owns the duck; `ProgramProcessor` either gains a split API (ride-gain and limit as separate
calls) or a combined `process_planar_ducked(core_l, core_r, aux_l, aux_r, duck_gain)`. Either way the
hot-path contract in the file header holds: **no heap allocation, no new lock.**

### B.5 · What already exists and should be reused

**The core/aux split is already built.** `audio.rs:1478-1548` maintains `aux_l` / `aux_r` alongside the main
sum, with `is_aux = i >= 3 && i <= 5`, created for the AUX monitor bus. The ducker **reuses that split** — it
does not invent one. This is the single biggest reason the ducker is smaller than it looks.

It also gives the cart exclusion for free: **cart is slot 6, `is_aux` is 3..5**, so carts and SFX can never
trigger a duck. Jeff's "never carts, never sound effects" rule is **structural, not a flag** — the same
quality of receipt the jukebox design was proud of.

### B.6 · Detector parameters (all adjustable, per aux channel)

| Parameter | Default | Note |
|---|---|---|
| Trigger threshold | ~−45 dBFS on the aux sum | below it, silence |
| Attack | 20–50 ms | duck fast; a late duck is heard as a stumble |
| **Hold** | **0.5–1.0 s** | Jeff's spec — bridges the gaps between words |
| Release fade-up | 300–800 ms | the "house system returning" feel |
| **Duck depth** | **−12 dB** | *in dB, not the prototype's `duck_level` 0..1 fader value* |
| Enabled | per-aux-channel toggle | off means aux mixes at full with no duck |

**Ducking never stops or starts anything.** It is a gain on the program path only. The music continues
underneath, at its own position, and rises back mid-song — which is exactly Jeff's spec, and it falls out of
the topology for free rather than needing to be implemented.

---

## PART C — announcements on the aux channel

### C.1 · Audio path — the rebuild

Announcements become **engine-native file playback on an aux slot**, identical in kind to the jukebox:
`audio_load(slot, file_path, ...)` then `audio_play(slot)`. This puts them **on air for the first time** and
makes them duckable by Part B. The renderer `new Audio()` path is deleted.

### C.2 · Triggers — mostly existing machinery, in the wrong process

The `announcements` table already carries `trigger_time` + `days`, which is already **hard clock time, not
seam-fit** — Jeff's requirement is satisfied by the existing schema shape.

Two changes needed:

1. **Move the timer out of the renderer.** `setInterval(checkAnnouncements, 10000)` in `Announcements.tsx:60`
   only runs while that renderer is alive. A trigger that depends on a window being open is not a broadcast
   feature. It belongs in the main process or the daemon.
2. **Add relative-to-closing triggers.** Store an offset (close−30, close−15, close−1, close) resolved against
   the station's closing time, alongside the existing absolute `trigger_time`.

**Overlap with the anchor/clock machinery — flagged, as asked:** these triggers are **independent of it
today**, and I recommend they stay that way. Clock anchors schedule *log content* under the ONE-scheduler
model; announcements deliberately do not touch the log, the rotation, or AUTO/MANUAL — the same isolation the
jukebox has. Folding them into the scheduler would give an announcement the power to move a song, which is the
opposite of the requirement. **This is a recommendation, not a decision — Jeff rules.**

### C.3 · Closing time — STILL OPEN, and a schema that makes it non-blocking

**The answer came through with the brackets unfilled** — `[ONE TIME per station / VARIES BY DAY OF WEEK] —
[Jeff picks]` — so this is still owed. Rather than block Phase 1 on it, here is a shape where the answer
stops being schema-critical.

**Recommendation: store closing time as seven per-day values, with a "same every day" toggle in the UI that
writes all seven.**

- If the answer is **ONE TIME**, the toggle stays on, the UI shows a single field, and all seven rows carry
  the same value. The operator never sees the per-day structure.
- If the answer is **VARIES BY DAY**, the toggle comes off and seven rows appear. No migration, no schema
  change, no rebuild.

The cost of carrying seven values instead of one is nothing; the cost of guessing wrong is a schema
migration on a table that gates on-air behaviour. **A park closing earlier on Sunday is the common real-world
case**, which is the tiebreaker if Jeff has no strong preference.

**Where it lives:** `station_config_kv`, the established per-station settings store (used for
`experience_mode`, `SettingsPanel.tsx:298`), with the editor beside the announcement list.

**What still needs Jeff:** whether the operator-facing UI defaults to the single field or the seven rows.
That is a UI default, not a schema decision, so **it no longer blocks the build** — but the relative-trigger
slice should not ship until Jeff has seen which one he gets.

### C.4 · Content — where announcement audio lives

| Option | For | Against |
|---|---|---|
| **A dedicated content class / store** | Matches content-class isolation; announcements never enter rotation, never get picked by the generator, never counted in category stats | New store: needs its own R2 sync and its own materialization gate |
| **A reserved category in the library** | Free R2 sync, free file materialization, free import UI | Must be excluded from every picker — the exact defeat pattern behind the deleted-songs bug |

**Recommendation: dedicated store.** The library-category route requires every music picker to remember an
exclusion, and this codebase has a documented history of that class of leak. A dedicated store makes the
isolation structural rather than remembered.

**But it must inherit the R2 materialization gate.** Half a station's library once never aired because
`file_path` pointed at files that existed only in R2. An announcement that cannot be found at trigger time is
dead air at exactly the moment someone is listening for it. **Announcement files must be verified present
locally, with a visible health signal when they are not.**

Recorded and Chatterbox-voiced files are the same thing at this layer: both end as a local file in the store.
Chatterbox writes into it; the recorder writes into it. No second path.

---

## PART D — MANUAL mode

**Unchanged. Standing contract.** No trigger fires in MANUAL; announcements are available as carts fired by
hand.

**One consequence to flag rather than leave for discovery:** under Part B the duck trigger is `is_aux` =
slots 3/4/5, and **cart is slot 6**. So a hand-fired announcement cart will **not** duck. In MANUAL the jock
rides the fader themselves, so I believe that is intended — but it is a behaviour difference between AUTO and
MANUAL for the same audio, and Jeff should confirm it rather than meet it live.

---

## NEW engineering vs EXISTING machinery

| Item | Status |
|---|---|
| Jukebox routing to an aux slot | **EXISTS, SHIPPED** — `jukebox-deck-source-design-2026-08-17.md` §10. Untouched under WRAP |
| Core/aux sum split in the callback | **EXISTS** — `audio.rs:1478-1548`, built for the AUX monitor bus |
| Post-fader/post-cut aux tap | **EXISTS** — Jeff's ruling 2026-08-18, and exactly what a duck detector needs |
| Cart excluded from ducking | **EXISTS, STRUCTURAL** — cart is slot 6, `is_aux` is 3..5 |
| Loudness ride + −1 dBTP limiter | **EXISTS** — `program_processor.rs`, bench-proven |
| Announcement table, IPC, editor, menu entry | **EXISTS** — `Announcements.tsx`, `preload-handlers.js:25` |
| Hard clock-time + days triggers | **EXISTS** in schema shape |
| **The ducker (detector + gain + placement)** | **NEW** — the one genuinely new engine piece |
| **Splitting the processor so the duck lands between ride and limiter** | **NEW** — small, hot-path, must keep no-alloc/no-lock |
| **Duck on the mix path so it works with processing OFF** | **NEW** — and the trap that would otherwise ship a dead feature |
| **The source-channel strip UI + source dropdown** | **NEW** (UI only under WRAP) |
| **Announcements as engine-native playback (on air at last)** | **NEW** — replaces the renderer `new Audio()` path |
| **Relative-to-closing triggers + closing time setting** | **NEW** — extends existing triggers |
| **Announcement content store + materialization gate** | **NEW** |
| **The `+`/`−` source-channel pool (fixed N, UI reveals)** | **NEW** — engine change is a compile-time constant, not a hot-path rework (§A.1-A.4) |
| **Per-source-channel VU / meters** | **NEW** — extend the generic `decks: Vec<DeckTel>`; D/E/F have never had meters (§A.5) |
| **Mic + network sources (streamed, not file)** | **PHASE 2, NAMED** — one shared PCM-in path serves both; includes the Show+ device-broker story (§A.6) |
| Retiring the fake `__etherDuck` AUTO-DUCK button | **NEW** — honest-UI cleanup, in scope |

---

## PHASE 1 BUILD PLAN — five slices, each gated on Jeff

**Approved 2026-08-21. Nothing builds until GO on slice 1, and no slice starts until the previous one passes
Jeff.** No version bump and no installer per slice — local commits only, per the standing rule.

**What each slice costs Jeff to verify** matters as much as what it delivers, so it is stated per slice.
Slices touching Rust need `cargo build --release`, the addon copied to `native/ether-audio.node`, and a
**full app close-and-reopen** — the daemon never reloads in place. Renderer-only slices verify on the dev
server.

**Convention followed:** back up `native/ether-audio.node` to `ether-audio.node.bak-pre-<slice>-<date>`
before replacing it, matching the existing `bak-pre-auxdevice` / `bak-pre-auxmonitor` practice in-tree.

### Slice 1 — the pool, the kind flag, the meters (engine plumbing only)

Everything else sits on this, and it is independently verifiable because it closes a standing gap.

- Slot constants 7 → 12 (`decks`, `peaks`, `aux_monitor_gain`, callback locals, `for i in 0..7`)
- New source channels at indices 7-11; A/B/C = 0-2, D/E/F = 3-5, CART = 6 **unchanged**
- Per-slot **kind flag** replaces `is_aux = i >= 3 && i <= 5`; monitor routing and ducker eligibility read
  the declared kind
- Per-slot meters through the generic `decks: Vec<DeckTel>` — **no new named `level_*` fields**

**No new feature is visible yet** except one: **D/E/F get meters for the first time.**

| Gate | Requirement |
|---|---|
| `cargo build --release` | clean |
| `npx tsc --noEmit` | zero errors |
| `npx vitest run` | all pass |
| `node scripts/test-station-identity-leak.js` | ≤ baseline 13 |
| `node scripts/check-no-global-audio-statics.js` | pass |
| **Regression receipt** | A/B/C/CART audio unchanged — the callback's existing path must be bit-identical for a station with no source channels configured |

**Jeff verifies:** play the jukebox on D/E/F — **its meter moves**, where before there was none. Normal
station audio is unaffected. Rust slice: full close-and-reopen.

### Slice 2 — the SOURCE channel strip

- Dashboard `+` / `−`, fader, ON / PFL, and the source dropdown
- `deck_config` gains **`{ kind, address? }`** — the Phase 2 shape, from day one
- File kinds live: **Jukebox, Announcement, Jingle (hand-fired)**
- Stream kinds — **Mic (device…), Network** — shown **disabled with a Phase 2 affordance**, not hidden

**Jeff verifies:** press `+`, pick **Jukebox**, fader up → it airs on that channel. Press `−` → the channel
releases. Renderer-only: dev server.

### Slice 3 — the ducker

- Detector on the source sum, **post-fader and post-cut**
- Duck applied **on the mix path**, after the ride computes gain, **before the limiter** (§B.3)
- `ProgramProcessor` gains the split API so the duck can land between the stages (§B.4)
- Per-channel toggle + threshold / attack / hold / release / depth (§B.6)
- **Retire the dead `__etherDuck` AUTO-DUCK button** (F3)

| Gate | Requirement |
|---|---|
| Ceiling test | OUT true-peak holds −1 dBTP through a duck cycle — modelled on `criterion_4_cart_processed_identically_and_ceiling_held` |
| Hot-path discipline | no heap allocation, no new lock in the callback |
| **Processing OFF** | the duck works with **both** processing toggles off (§B.4) |

**Jeff verifies by ear** — this is a feel feature and no static test settles it:
1. Duck is clean on the first syllable; **holds** between words without fluttering.
2. Release rises like a house system returning, not a lurch.
3. **The music does not creep back up under the announcement** — the §B.3 ruling actually working.
4. **Processing OFF still ducks** — the §B.4 trap, the failure most likely to reach a customer unnoticed.

Rust slice: full close-and-reopen.

### Slice 4 — announcements on air

- **Dedicated announcement store** with the R2 materialization gate and a health signal for missing files
- Engine-native playback: `audio_load` / `audio_play` on a source channel
- The renderer `new Audio()` path deleted (F4)

**Jeff verifies — the receipt that has never existed:** fire an announcement by hand and confirm it reaches
**the Icecast stream**, not just the room. **The check must be made on the stream** (the listener page or the
mount directly), because room audio has always worked and is not the thing in question. A local-speaker
confirmation proves nothing here.

### Slice 5 — timed triggers

- Timer **out of the renderer** into the main process or daemon
- Absolute clock time + days (existing shape) **plus** relative-to-closing offsets (close−30 / −15 / −1 / close)
- **Seven-per-day closing time** with the "same every day" toggle (§C.3)

**Jeff verifies — the full acceptance he specified:** in **AUTO**, a trigger fires → **the music ducks, the
announcement airs to the stream, the music rises back mid-song.** Nothing stopped, nothing new started, no
song cut.

### What is deliberately NOT in Phase 1

Any capture path · any device selector · any network source · any change to automated seam jingles on CART.
Those are Phase 2, and the dropdown says so on screen rather than pretending they are missing.

---

## What is left for Jeff

Every Part A and Part B question is ruled and folded in. Two items remain, and neither blocks the bulk of
Phase 1.

1. **§C.3 — closing time.** The answer arrived with the brackets unfilled. §C.3 proposes seven per-day values
   with a "same every day" toggle, which makes the question a **UI default rather than a schema decision** —
   so Phase 1 can start regardless. Still needed before the relative-trigger slice (close−30 / close−15 /
   close−1 / close) ships.

2. **Approval to build Phase 1.** The scope is the ten items in "THE BUILD — Phase 1". Phase 2 (stream
   capture: mic + network) is designed and named but explicitly **not** in this build.

### What I would want verified with Jeff's ears, not a gate

The ducker is a feel feature and no static test can settle it. Once Phase 1 is on his machine:

- **Threshold and hold** against a real announcement — does the music dip cleanly on the first syllable and
  stay down between words, or does it flutter?
- **Release** — does the music come back like a house system returning, or does it lurch?
- **Ride interaction** — play a quiet passage and a hot one, duck through both, and confirm the music does
  **not** creep back up under the announcement. That is the §B.3 ruling working, and it is the one thing
  worth listening for specifically.
- **Processing OFF** — confirm the duck still works with both processing toggles off. That is the §B.4 trap,
  and it is the failure most likely to reach a customer unnoticed.

**Nothing is built. No code has been written or changed for any of this.**
