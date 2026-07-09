# Jingles as a first-class content class — design (2026-07-09)

Design-only (no code). Concept: **songs, jingles, spots are three content CLASSES**, not three song
categories. Jingles rotate like songs (least-recently-played within their category) but transition
differently (overlay, not a deck segue) and **never pollute music math** (artist separation, rotation,
music reporting). HOLD for GO on the phased plan below.

## DECISIONS — GO'd 2026-07-09 (override earlier proposals)
- **Jingle accent = TEAL / CYAN** (NOT violet — purple-family is reserved for Iris). Every "violet" below → teal.
- **Data-first phasing confirmed.** Phase order: **(1) schema + class field → (2) overlay strip (manual cart
  mixer, immediately useful) → (3) transition/orchestration → UI class-colors throughout.** Receipts + HOLD
  between phases.
- **Jingles live in the `songs` table with `content_class` (MUSIC/JIN/SPOT) — no parallel table.** Class
  drives exclusion from music math + affidavit; storage stays unified. (Spot-table unification into `songs`
  is a larger, separate migration — NOT in Phase 1; spots stay in `spots`, tagged SPOT at the query/UI layer
  for now. Flagged for a later explicit GO.)
- **Priority:** this rides BEHIND the watchdog / health-monitor / stall work. If session capacity forces a
  choice, **stalls outrank jingles.**

## Discovery — how content is modeled today (receipts)

### Data
- **Two separate tables today, not a class field.** Music lives in `songs` (many columns: `rotation_status`,
  `no_repeat_hours`, `last_played_at`, `daypart_mask`, `intro_version_path`, `energy` … `main.js:828-845`).
  Spots live in a separate `spots` table (`isci_code`, `cart_number`, `agency`, `length_sec`,
  `main.js:860-863`) + `spot_categories` (v24). There is **no `content_class` column** anywhere.
- **Spots are clock-placed, not rotation-selected.** `clock_slots.slot_type` ∈ {`music`, `spot_break`, …}
  (`main.js:849,5359,5373`); a `spot_break` slot pulls from `spots` by `spot_category_id`/`spot_type` via
  `_pickSpot` (`main.js:5445-5515`) — a *different* rotation than music. `clock_breaks` (v26) = per-minute
  spot breaks. So spots ≠ songs at both the data and rotation layers.
- **Rotation (LRP) is the songs path.** `songs.last_played_at` + `no_repeat_hours` drive least-recently-played
  selection in `loggen`. Jingles want THIS engine (LRP), unlike spots.
- **play_log** columns: `…deck, duration_ms, played_at, category_code, station_id, station_uuid, file_path…`
  (no content_class). Spots are mirrored into play_log for the affidavit (audience/affidavit arc).

### Transition / overlay — the cart channel already exists
- **A dedicated overlay bus exists: the CART channel = native mixer slot 6.** `DeckSlot::new() // slot 6 =
  dedicated cart channel ("CART")` (`native/src/audio.rs:275`); `"CART" => Some(6) // not user-assignable`
  (`:299`); `level_cart`/`deck_cart` (`audio.rs:87,197`); routed in `lib.rs:428` (`"CART" => &mut
  audio.deck_cart`). Renderer: *"Dedicated cart channel (native slot CART) — fires out of master, OVER the
  music"* (`engine-rodio.ts:80`) and *"does NOT advance the music queue; the cart UI polls
  getDeck('CART')"* (`:360,547`).
- **Deck rotation is strictly A→B→C segue.** `deckChainType {A,B,C:"segue"}` (`engine.js:54`),
  `handleRotate(from,to)` crossfades (`engine.js:376-385`), `crossfadeDuration=3` (`:71`). Rotate consumes a
  queue entry via `dequeue()` (`:63`).
- **Conclusion:** the engine CAN overlay a third element without consuming a deck rotation — that's exactly
  what the CART channel does today (fires over master, no dequeue). Jingles ride the cart channel. What's
  NEW is the *orchestration + timing* (fire the jingle over the outgoing song's tail; start the incoming
  song under the jingle's tail) and making jingles a *rotating class* rather than a manually-fired cart.

### Clock + timing today
- Clocks place `music` (category_id) and `spot_break` (spot_category_id) slots; the generator fills music by
  category + fills breaks by spot rotation. A `jingle` would be a new slot_type OR (better, see below) an
  automatic transition overlay.
- **Timing precision:** end-detection is poll-based — `poll()` every **250 ms** + position check
  (`engine.js:108`, checkEndByPosition). So engine timing is ~250 ms-grained today; sub-100 ms jingle tail
  timing would need a scheduled timer, not the poll. Intro ramps exist (`has_intro`, `intro_version_path`).

### UI surfaces that render content items (inventory)
Decks: `OnAirDeck`, `ConsoleStrip`, `VUMeter`, `DeckConfigurator`. Now-playing / up-next: `MasterOutput`
(NOW PLAYING + NEXT UP), `Fullscreen` (queue + recent), `NowPlaying`. Play-log/reporting: `ProgramLog`,
`Logs`, `ListenerAnalytics`, the affidavit. Programming: the clock editor (clock_slots), `Categories`,
`Spots`/`SpotsPromos`, `BroadcastCalendar` (generated schedule), `JockStrip`. Future: Health Monitor tails.

## Proposal

### 1. Data layer — `content_class` (MUSIC / JIN / SPOT)
- Add **`content_class TEXT DEFAULT 'MUSIC'`** to `songs` (additive `ALTER TABLE`, phase-sync migration vN+1
  with an **identity `payloadTransformer`** + `station_uuid` backfill, exactly like the v28 pattern — and it
  MUST be in `stage-engine` DAEMON_FILES-adjacent concerns are N/A here since it's schema, but the migration
  must ship + carry a payloadTransformer or the pre-commit chain-verifier fails). Jingles live in `songs`
  with `content_class='JIN'` so they inherit the LRP engine (`last_played_at`/`no_repeat_hours`) — but every
  music query filters `content_class='MUSIC'` so jingles never enter artist-separation / format-rotation /
  music reporting math. (Spots stay in the `spots` table; `content_class='SPOT'` is conceptual there for UI
  uniformity, or a view.)
- **Jingle categories:** reuse the `categories` table with a class tag (or a `jingle_categories` mirror of
  `spot_categories`). LRP is per-category (jingles rotate within their category), same as music.
- **Sync/CRDT:** additive column, LWW like every other song field; station-scoped by `station_uuid`. No new
  CRDT semantics.
- **play_log / affidavit:** add `content_class` to `play_log`. Jingles ARE logged (proof of play) but
  **flagged non-music** → excluded from music reporting, artist-separation windows, and rotation counts so
  separation math stays honest (the "never pollute music math" rule enforced at the query layer).

### 2. Transition engine — jingles on the CART channel (no deck rotation)
- Jingles fire on the **existing CART channel** (native slot 6) — overlay over master, `dequeue()` untouched,
  A→B→C rotation not consumed. This satisfies "must NOT consume a deck rotation" using proven plumbing.
- **New orchestration (the real work):** a jingle trigger that (a) loads+plays the next LRP jingle on CART
  timed to fire `leadIn` sec before the outgoing song ends, and (b) schedules the incoming song's deck
  rotation to start `underlap` sec before the jingle ends. This is a *scheduler on top of* the cart channel
  + `handleRotate` — new timed logic in `engine.js`, not a new mixer path.
- Precision caveat: the 250 ms poll is too coarse for tight tail timing → introduce a per-transition
  `setTimeout` scheduled off the outgoing song's known duration/position (engine already tracks these).

### 3. Clock placement + generator
- Two modes, propose supporting both, ship the first:
  - **Automatic transition jingles (primary):** between music elements the generator/engine can fire a
    jingle from a designated jingle category (LRP), governed by a per-clock or per-station cadence
    ("jingle every N transitions" / "at :00 and :30"). No new slot needed for the common case.
  - **Explicit `jingle` clock slot (secondary):** a new `slot_type='jingle'` with `jingle_category_id`,
    mirroring `spot_break` — for deterministic placement. Generator pulls LRP from the jingle category.
- Generator pulls jingles via the songs LRP path filtered to `content_class='JIN'` + the jingle category —
  reusing the music selector's LRP logic, isolated from music by the class filter.

### 4. Timing model — where the offsets live
- **Per-jingle-category** overlap offsets (default), with optional **per-item** override:
  `lead_in_sec` (jingle starts this long before the current song ends) and `underlap_sec` (next song starts
  this long before the jingle ends). Store on the jingle category (columns), item override on the `songs`
  row (JIN). Engine reads them at trigger time.
- Deliverable precision: ~event-scheduled via `setTimeout` off the outgoing song's duration → tens-of-ms
  achievable; document the 250 ms poll is NOT the timing source for jingles.

### 5. UI — color identity per class (every surface)
- **Music = neutral** (current), **Spots = amber** (already), **Jingles = propose a distinct accent** —
  recommend **violet/purple** (`#8868D8`, the brand accent — instantly reads "Ether jingle" and is unused
  for content state) OR teal if purple is too tied to brand chrome. One token, applied everywhere.
- Apply the class color across the inventoried surfaces: decks (`OnAirDeck`/`ConsoleStrip`/`VUMeter`),
  `MasterOutput` NOW PLAYING + NEXT UP, `Fullscreen`, play-log (`ProgramLog`/`Logs`/`ListenerAnalytics`),
  clock editor slots, `Categories`, `Spots`, `BroadcastCalendar`, and the future Health Monitor tails.

## Phased build plan (recommend DATA CLASS first)
- **Phase 1 — Data class + rotation + reporting (foundation, low risk):** `content_class` migration
  (+payloadTransformer), jingle categories, loggen LRP for JIN isolated from music math, play_log
  `content_class` + reporting/separation exclusions, and the UI color identity everywhere. **Outcome:**
  jingles exist as a logged, non-polluting rotating class — even before fancy overlap, a jingle can play as
  a normal element or a simple cart fire.
- **Phase 2 — Engine overlay + timing (the differentiator):** the CART-channel jingle trigger with
  `lead_in_sec`/`underlap_sec` orchestration + the scheduled-timer precision path. **Outcome:** jingles fire
  over the song tail with the incoming song under the jingle tail, no deck rotation consumed.
- **Phase 3 — Clock JIN slots + cadence controls:** explicit `slot_type='jingle'` + per-clock/station jingle
  cadence in the clock editor.

Rationale for data-first: the class model, LRP isolation, and reporting honesty are the invariants
everything else depends on; the overlay engine is riskier (live daemon timing) and benefits from the class
+ metadata already existing. Each phase is its own GO.

---

## UI treatments — jingles are VISIBLE but NOT song-shaped (mocks, 2026-07-09)

Governing principle: **decks carry songs; a jingle rides the SEAM between two songs.** It occupies a
schedule position (generator places it, log records it) without pretending to be a rotation item. This also
refines the data shape (below): a jingle is attached to a **transition**, not a deck slot.

### (a) Queue / up-next — slim CONNECTOR ROW between two song rows
Not a full card: thinner, accent (violet), indented, bracketing the two songs it overlaps. The operator
reads the hour naturally: song → ⟨jingle⟩ → song.

```
  NEXT UP
  ┌────────────────────────────────────────────────┐
  │ ▸  Bounce, Rock, Skate, Roll     Vaughan Mason  │   song card — neutral, full height
  └────────────────────────────────────────────────┘
     ╲                                                    seam bracket, violet
      ┈┈◈ JIN · "Summer Sweep" ID          ⤶ 3.0s ┈┈     connector row — thin, violet, indented
     ╱                                                    (overlaps the song above ⇢ into the one below)
  ┌────────────────────────────────────────────────┐
  │    Sunday Morning                 Maroon 5       │   song card — neutral, full height
  └────────────────────────────────────────────────┘
```
- Half-height, violet text/rule, a bracket that visually **bridges** the song above and below.
- Shows: `JIN · <title>` + the overlap length (`3.0s`). No album art, no deck letter, no rotation badge.
- It's clearly a *between-two-songs* element, not a queue item you can reorder like a song.

### (b) Decks as it approaches — a SEAM indicator, never a deck
Jingles never occupy Deck A/B/C. A small CART/JIN chip sits on the **transition seam** between the outgoing
and incoming deck, with three states:

```
   DECK A ── red ──┐         ┌── DECK B ── blue ──┐         DECK C ── green
   ┌───────────────┐         ┌────────────────────┐         ┌──────────────┐
   │ Bounce, Rock… │         │ Sunday Morning     │         │   —  (idle)  │
   │ ▓▓▓▓▓▓▓░ -0:06│         │ cued · ready       │         │              │
   └───────────────┘         └────────────────────┘         └──────────────┘
                   └──◈ JIN ARMED ──┘
                      (violet glow on the A→B seam — outgoing song entered the overlap window)

   states:   ◇ idle (hidden)  →  ◈ JIN ARMED (violet glow, outgoing in lead-in window)
             →  ▶ JIN FIRING (solid violet, during the overlap)  →  clears (seam empty)
```
- The chip lives ON the seam between the two decks (A→B here), NOT inside any deck strip.
- **ARMED:** appears when the outgoing song crosses into its `lead_in_sec` window (glow, no audio yet).
- **FIRING:** solid violet + a tiny level tick sourced from the CART channel (`level_cart`) while it plays.
- **Clears** when the jingle ends; the deck strip only ever showed the two songs — the truth.
- Deck-letter mapping stays sacred (A/B/C = the Rust decks); the jingle is the cart channel, shown as a seam
  ornament, never a fourth deck.

### Data shape this implies (refines §1)
A jingle is a **transition-attached placement**, not a deck slot:
- In `generated_schedule`, a JIN placement row bound to the seam between music items N and N+1 — either a
  fractional `scheduled_at`/position between them or explicit `from_item`/`to_item` refs — carrying
  `content_class='JIN'`, `lead_in_sec`, `underlap_sec`, and `channel='CART'`. It does **not** hold a deck.
- The generator emits it when placing the transition; the engine reads it to arm/fire on the seam.
- `play_log` records the jingle with its **actual fire time** + `content_class='JIN'` (flagged non-music),
  so it's proof-of-play without entering music separation/rotation/reporting math.

These two treatments are the contract the engine + generator build toward; nothing renders a jingle as a
song card or a deck. **Mocks are design-only — no engine code.**

---

## Overlay console strip — CART/JIN (design + native receipts, 2026-07-09)

A visible **fourth strip** beside Decks A/B/C so overlay audio is never invisible: its own fader (rides the
slot-6 bus live), its own VU (tapped from the overlay channel, station-scoped), and a now-firing readout
(cart/jingle name + ARMED/FIRING). Distinct from decks: **never scheduler-fed, never in rotation** — shows
live overlay activity only. Reuses the existing `ConsoleStrip` family, placed alongside the mic/aux strips.

### Native receipts — everything the strip needs ALREADY exists (no native addition required)
- **Live bus gain for slot 6:** `deck_meta_mut` routes `"CART" => &mut audio.deck_cart` (`lib.rs:420-431`);
  `audio_set_volume(deck, volume, station_id)` (`lib.rs:101-105`) sets the meta + sends `SetVolume`; the
  handler applies `bus.decks[idx].volume = volume` with `deck_index("CART") = 6` (`audio.rs:299, 706-709`);
  slot 6 is "always summed to the program bus… carts fire out of master over the music" (`audio.rs:196`).
  → **The strip fader wires to the EXISTING `audio_set_volume("CART", v, stationId)`.** No new native call.
- **VU tap:** `level_cart` is written post-fader by the mixer and exposed as `audio_get_levels().cart`
  (`audio.rs:87`, `lib.rs:159-163`). → the strip VU consumes `lvl.cart`, **station-scoped via the 4.4.40
  `matchesStation` levels filter** (same UUID gate). **While wiring the VU, fix `ConsoleStrip.tsx:140`** —
  it still gates the meter by `isPlaying` (the "meters are taps" law violation flagged in the v4.4.40 arc);
  the overlay VU must read the real tap unconditionally.
- **Now-firing readout:** the cart/jingle name + status is exposed via `deck_cart.info("CART")`
  (`lib.rs:145`, the `deckCart` field). ARMED/FIRING are the new engine states (from the jingle overlay
  orchestration); the readout renders them + the raw name for manually-fired carts.

### Wiring (reuses existing patterns)
- **Component:** a `ConsoleStrip` instance with `deckId="CART"`, rendered alongside the mic/aux strips
  (`MicChannel` wraps `ConsoleStrip`, `MicChannel.tsx:124`; deck strips at `App.tsx:3651,3694`). Same
  menu/visibility treatment as mic/aux.
- **Fader → ride:** `audio_set_volume("CART", value, stationId)` (the renderer already calls
  `invoke("audio_set_volume", {deck, volume, stationId})` for decks — deckId `"CART"` reuses it).
- **Per-sound gain → trim (separate):** each cart/jingle item keeps its own `gain_db` (applied at load —
  `audio_load(..., gain_db, ...)` `lib.rs:59-71`; stored in library/cart settings). **Trim (per-item
  gain_db) vs ride (bus fader) stay independent** — the fader never rewrites item trims.
- **MIDI:** add a fader action to `MIDI_ACTIONS` (`MidiEngine.tsx:49`, `{id, label, isFader:true}`) so the
  overlay fader is an assignable target in the existing profiles (RØDECaster Pro II / X-Touch / DDJ) — same
  mechanism as the deck faders.

### Placement in the phasing
The strip **ships WITH or BEFORE Phase 2** (the jingle overlay engine) so a firing jingle is never invisible
audio. Because every primitive exists (gain, VU tap, readout, ConsoleStrip, MIDI target), the strip can land
even in **Phase 1** as a manual cart mixer + overlay meter, then light up ARMED/FIRING when Phase 2's jingle
orchestration arrives. **The only "native addition" the brief asked about is not needed** — slot 6 already
has live gain control.

**HOLD for GO on this plan. No code written.**
