# Operator closing screen + the one-input-deck migration

**DESIGN ONLY. Nothing built, nothing changed.**
Date: 2026-08-31 · Supersedes the first draft of this file, which mapped reasons to keep the old
model instead of the route out of it. This version starts from the target.

**The target (Jeff's):** the aux/source deck is the INPUT for everything with an output.
Announcements, jukebox, sweepers and carts are all **sources** you select on a source channel.
Ducking is a per-channel choice for all of them. The dedicated CART deck at slot 6 is **removed**.

Governing doc: `docs/aux-channel-ducker-announcements-design-2026-08-21.md` (ruling A.8 is reversed
by this — see §6). Related: seam bridge `audiod/engine.js:799`, overlay scheduler
`electron/main.js:7868+`, ducker `native/src/audio.rs:470+`, v52 sweeper work (`fb9332a`).

---

## 0 · Most of the target is already built

The first draft treated the old model as load-bearing. It largely is not. Three of the four
foundations the target needs **shipped already**:

| foundation | status | evidence |
|---|---|---|
| Slot identity is a KIND, not a position | **shipped** | `audio.rs:2063` `let is_aux = deck.kind == SlotKind::Source;` and `:899` — *"This replaces the positional `is_aux = i >= 3 && i <= 5` test… arithmetic pretending to be a rule."* |
| Generic per-slot telemetry | **shipped** | `DeckTel.peak` exists for **every** slot (`:126` *"available for EVERY slot"*), `bus.peaks: [f32; SLOT_COUNT]`, `lvl.decks` is a `Vec<DeckTel>` pushed for all slots |
| Fixed pool of 12 channels | **shipped** | `pub const SLOT_COUNT: usize = 12;` (`:891`) |
| A source channel declares WHAT it hosts | **shipped** | `deck_configs.kind` — already `jukebox` / `announcement` / `jingle` / `mic` / `network` |

**`level_cart` is not a separate mechanism.** It is `bus.peaks[6]` surfaced under a named field
(`audio.rs:1739`). The generic array it comes from already covers every slot.

And `_cartFlowing()` is **already half-generic** (`engine.js:1798-1803`): its fallback path reads
`lv.decks.find(d => d.id === "CART" || d.id === 6)` — the generic array, looked up by id.

So the honest summary is: the scaffolding for one-input-deck is in place, and what remains is
re-pointing the consumers plus one real structural decision (§4).

---

## 1 · The migration — what actually changes

### 1.1 · Schema / config

```
deck_configs.kind gains two values:
    'sweeper'   the AUTOMATED seam sweeper channel   (duck_enabled MUST be false — §4)
    'cart'      the hand-fired cart wall              (duck_enabled operator's choice)
```

Both are `type = 'source'`, so both are `SlotKind::Source` in the engine, so both get the source
channel's behaviour for free: never ducked themselves, optionally ducking others, generic meter,
generic fader, AUX monitor routing.

A migration assigns each station a sweeper channel and a cart channel from the free slots
(F, S1, S2… — the live install has F/S1/S2 unused on station 1) and carries the existing CART fader
level onto the cart channel.

### 1.2 · Rust

- `SlotKind::Cart` → **deleted**. Slot 6 becomes an ordinary Source slot, or is left unused.
- `default_kind_for(6)` stops returning `Cart`.
- `deck_index("CART")` → the string "CART" stops being a deck id. **This is the one place to be
  careful** — `loggen.js:464` records a crash where `DECK_LETTERS` (len 6) was indexed at slot 6 and
  killed the cpal output thread. Every string→index mapping needs auditing, not just the obvious one.
- `lvl.level_cart` → keep for one release as a deprecated alias of `peaks[6]`, then drop. Consumers
  move to `lvl.decks[slot].peak`.

### 1.3 · engine.js

- `_cartFlowing()` → `_slotFlowing(slotId)`, reading `lv.decks.find(d => d.id === slotId).peak`.
  The generic path it needs already exists and it already uses it as a fallback.
- `_jingleTick` fires to the configured sweeper slot instead of the literal `"CART"`. The call is
  `A.audioPlay(deck, stationId)` either way — a deck id, not a special API.
- `_engineState`'s live-check (`:543-545`) observes the sweeper slot instead of cart.
- Play-log stamp `deck: "CART"` (`:1855`) becomes the slot id.

### 1.4 · Overlay scheduler

`main.js:7868+` writes placement rows with `channel = 'CART'`. It writes the configured sweeper slot
instead. **Cadence, pool resolution and the `jingle_category_id`/`content_class` pairing are
untouched** — that is placement, not routing.

### 1.5 · UI

CART fader (`App.tsx:3748`) → the cart channel's fader. `ConsoleStrip.tsx:175` `lvl.cart` → generic
per-slot peak. `DeckConfigurator` cart wall (`:726, :1029`) points at the cart channel. The
`CART_SLOT_COUNT = 64` tile wall is unaffected — it is a bank of buttons, not a deck.

### 1.6 · Data migration

Measured on the live DB:

```
generated_schedule   channel='CART'  class=SWP    53,256 rows   ← must be re-pointed or read leniently
play_log             deck='CART'                  19,247 rows   ← history; leave as written
deck_configs         F / S1 / S2 free on st1                    ← the channels to assign
```

- **`generated_schedule`**: 53,256 rows carry `channel='CART'`, and most are pending — the future
  log. Either migrate them to the new slot id, or have the seam reader accept `'CART'` as a legacy
  alias while they drain. Migrating is cleaner and matches the v52 precedent.
- **`play_log`**: 19,247 rows say `deck='CART'`. That is what aired, under the channel it aired on.
  **Leave it.** Same ruling as `JIN` in v52 — history is a record, not something to keep current.

---

## 2 · The seam bridge — a RE-POINT, not a rebuild

**Answering the question directly: re-point.**

The bridge (`engine.js:799-806`) defers a rotation deck's end when a **confirmed-firing** sweeper
governs the seam. Two properties keep it from causing dead air:

1. It defers **only on observed firing** — samples actually flowing.
2. `_engineState` counts a firing sweeper as live audio, so the stall watchdog stays quiet during the
   underlap window when A/B/C are all idle.

Both properties are about **observing that a channel is producing audio**. Neither is about slot 6.
The only thing slot 6 supplies is *which* channel to look at, and the generic telemetry already
exposes every channel identically:

```js
// today
_cartFlowing() { return (lv.cart || lv.level_cart || 0) > 0.0001 || <generic lv.decks lookup for CART> }

// after
_slotFlowing(slot) { const d = (lv.decks||[]).find(x => x && x.id === slot);
                     return !!(d && (d.peak > 0.0001 || (d.source_present && d.active && !d.paused))); }
```

The logic is identical; the argument changes. **That is a re-point.** The deferral rule, the
observed-firing requirement, the underlap arithmetic and the segue-overlap interaction are all
untouched.

What makes it worth care is not complexity — it is consequence. This is the path that has produced
dead air before, so the re-point wants the existing seam smoke (`audiod/smoke-seam-stop.js`) run
against the new channel plus a firing-confirmation test that fails if the bridge ever defers without
observed audio.

---

## 3 · Automated firing keeps working, unchanged in kind

**What must keep working:** seam sweepers fire automatically every N music elements, on the seam,
during normal automated playout. Nobody hand-fires between-song sweepers — that is the whole point of
the overlay, and it does not change.

**How it works after:** exactly as now, on a different channel.

| stage | today | after |
|---|---|---|
| cadence / placement | overlay scheduler writes a row every N music elements | unchanged |
| pool resolution | `WHERE jingle_category_id=? AND content_class=?` | unchanged |
| placement row | `channel='CART'`, lead-in/underlap, pool id | `channel=<sweeper slot>` |
| seam read | `loggen.js:484` selects by `content_class IN ('SWP','JIN')` | unchanged — it reads class, not channel |
| arm / fire | `_jingleTick` → `audioPlay("CART")` | `_jingleTick` → `audioPlay(<slot>)` |
| firing confirmation | `_cartFlowing()` | `_slotFlowing(slot)` |

The sweeper stays **auto-fired**. The dropdown's hand-fired "Sweeper" entry (`kind: 'jingle'`,
`DeckConfigurator.tsx:42`) remains a separate, additional thing — one file type, two ways to fire it,
which is the same distinction that exists today and is not what is being removed.

---

## 4 · What genuinely breaks — one thing, and it is real

Everything in §1-3 is mechanical. One item is not.

### The structural guarantee "a sweeper never ducks its own song" becomes a flag

Today it is impossible by construction: `SlotKind::Cart` cannot arm the ducker, so a sweeper on cart
physically cannot duck the song it is sweeping into. Delete `SlotKind::Cart` and put sweepers on a
Source channel, and the protection becomes `duck_enabled = false` on that channel — a boolean someone
can set wrong, in a config table, fanned out at boot.

**This is a genuine loss of structure, not a risk to be waved through.** It should be replaced with
structure at a different layer rather than accepted as a flag:

> **The writer refuses it.** `deck_configs` rejects `duck = 1` on a channel whose `kind = 'sweeper'`,
> and `armAllStationDuckers` (`main.js:4785`) refuses to arm it regardless of what the row says. The
> rule then lives in code that cannot be configured around, which is where it lives today — just
> expressed against the channel's declared purpose instead of its slot number.

That is strictly better than the current arrangement, because it states the actual rule ("sweepers
don't duck") rather than relying on a coincidence of layout ("slot 6 can't duck").

### Everything else is a re-point

For completeness, and being explicit rather than hedging:

| item | verdict |
|---|---|
| seam bridge | re-point (§2) |
| `_engineState` live-check | re-point — same observation, different slot |
| `_jingleTick` fire target | re-point — same `audioPlay`, different deck id |
| overlay scheduler `channel` | re-point — one written value |
| meters / faders / console strip | re-point — generic telemetry already exists |
| `level_cart` | alias, then delete |
| `deck_index("CART")` / `DECK_LETTERS` | **audit, not re-point** — bounds bugs here killed the output thread once (`loggen.js:464`) |
| `generated_schedule.channel` | data migration, 53,256 rows |
| `play_log.deck` | leave — it is history |
| SFX immunity | **nothing to do** — a Source slot is never ducked (structural), and `duck_duckable[]` already exists per deck |
| Mic / PCM capture | **nothing to do** — every element here is a file source; Phase 2 is untouched |

---

## 5 · STOP — it already exists

**Answering the question: it exists, end to end, and it does exactly what is described.**

`native/src/audio.rs:278-281`:

> `SetMuted { deck, muted }` — *Console channel on/off for one slot. muted=true cuts the channel to
> the program bus.*

and `:2056`:

```rust
let vol = if deck.muted { 0.0 } else { deck.volume * trim };
```

**The deck keeps decoding.** `src.next()` is still called every frame; only the gain applied to those
frames is zero. So the deck advances, `frames_played` advances, the song ends when it would have
ended, rotation rotates, the seam is untouched. That is precisely the semantic asked for: *rotation
runs, output muted, un-mute returns to live wherever rotation has got to.*

It is per-slot, and it is already wired: Rust → `audioSetMuted` → daemon `setMuted`
(`ether-audiod.js:284`) → `main.js:4602` → `preload.js:21`.

### Where it mutes

Muting a rotation deck removes it from **both** program paths — `mix_*` (AIR) and `core_*` (ROOM) —
because both are built from `l * vol`. It does **not** touch source channels: they are summed
separately (`src_*`) and the room's `mon` tap is taken pre-cut for aux slots only.

**So a closing cart on a source channel is fully audible while the music is muted.** That is the
property the brief requires, and it falls out of the existing structure rather than needing anything.

### The design

```
STOP  =  setMuted(true)  on the rotation decks A, B, C          (not master, not the sources)
```

- Music silent, rotation running underneath, log advancing, seam intact.
- Carts and announcements still reach output — they are on source channels.
- Release = `setMuted(false)` on A/B/C. Music returns mid-song wherever rotation has advanced to.
- `_engineState` still reads `playing` on the muted decks, so the stall watchdog stays quiet and
  nothing mistakes STOP for a fault.

**Two things to decide:**

1. **Does STOP silence the stream too?** Muting the rotation decks removes them from the AIR path as
   well as the room, so an Icecast listener hears the carts over silence. For a park PA that is
   right. If a station streams, it may want STOP to be room-only — which would need a separate
   room-mute, since today the two share `vol`.
2. **Should STOP time out?** A STOP left on is dead air to a listener. A visible elapsed timer, and
   optionally an "still stopped — 5 minutes" nag, fits the honest-state principle.

**Nothing here is a pause.** Pause fires the next track and is not used anywhere in this design; the
first draft's pause reasoning is withdrawn.

---

## 6 · The A.8 reversal, stated plainly

Ruling A.8 (2026-08-21) kept automated sweepers on CART on two grounds: the seam bridge depends on
it, and cart is correctly duck-excluded.

Both grounds have weakened since:

- The seam bridge's dependency is on **observing a channel**, and generic per-slot telemetry shipped
  (A.5). It is a re-point (§2), not the "scheduler-adjacent rebuild" A.8 anticipated.
- The duck exclusion is no longer positional (A.2 shipped), so "cart is duck-excluded" is already a
  statement about a KIND. Replacing `SlotKind::Cart` with a writer-enforced rule on
  `kind='sweeper'` keeps the guarantee (§4).

**A.8 is superseded by this document.** The reason it was right in August was that the generic
foundations were not yet in place. They are now.

---

## 7 · Staged path

Each stage is independently shippable and none leaves the tree in a state that can produce dead air.

| stage | what | notes |
|---|---|---|
| **1** | **Closing screen, read-only** — now-playing, closing time (display + edit), tonight's announcement queue derived from it. | touches no audio |
| **2** | **STOP** — mute A/B/C, timer, un-mute. | uses `setMuted`, which already ships end to end |
| **3** | **Cart channel** — `kind='cart'` source slot, `duck_enabled=true`, closing carts fire on it and duck. Closing Mode applies the config so the operator configures nothing. | no engine change; config + UI |
| **4** | **Sweeper channel** — `kind='sweeper'`, writer-enforced no-duck, `_slotFlowing` re-point, `_jingleTick` target, scheduler `channel`. | the re-point of §2-3 |
| **5** | **Remove slot 6** — delete `SlotKind::Cart`, migrate `generated_schedule.channel`, retire `level_cart`, audit `deck_index`/`DECK_LETTERS`. | the cleanup, once nothing points at it |

Stages 1-3 deliver the whole operator brief. Stages 4-5 deliver the architecture — and by then the
cart channel from stage 3 has already proven the source-channel path in production.

**Verification that must exist before stage 4 ships:** the seam smoke re-run against the new channel;
a test that the bridge never defers without observed firing; a test that `duck` cannot be armed on a
`kind='sweeper'` channel; and rotation pools unchanged on all four stations.

---

## 8 · The operator screen

```
┌─ NOW PLAYING ──────────────────────────────────────────────────────────────┐
│  ▸ Time Warp — Little Nell, Patricia Quinn            2:18 / 3:19          │
│  PARK CLOSES   [ 10:00 PM ] ▲▼      ← the ONE input the night derives from │
└────────────────────────────────────────────────────────────────────────────┘
┌─ TONIGHT ──────────────────────────────────────────────────────────────────┐
│   9:45 PM   15 MINUTES TO CLOSE       will duck the music                  │
│  10:00 PM   PARK IS CLOSED            will duck the music         [ Skip ] │
│  10:15 PM   FULL CLOSING OUTRO        will duck the music                  │
└────────────────────────────────────────────────────────────────────────────┘
┌─ CLOSING CARTS — press to play over the music ─────────────────────────────┐
│  [ PARK CLOSING ]  [ 15 MINUTES ]  [ THANK YOU ]  [ GOODNIGHT ]            │
│                                                                            │
│  ⏹ STOP   music does not play · everything else still works                │
└────────────────────────────────────────────────────────────────────────────┘
```

Closing time is the single derived input — every scheduled item is an offset from it, so moving it
moves the night. The cart row is load-bearing: people do not leave when asked, so the operator fires
"park closing" four or five times as a crowd trickles out.

**Closing Mode** is per-station saved config — which channel, which carts, which offsets — applied
when the screen opens. The operator never opens a deck, presses ON, or applies ducking, because it is
data rather than a remembered sequence.

**Trust model.** Plain language before firing (*"9:45 PM — '15 minutes to close' — will duck the
music"*); sanity rails that **flag** obviously-wrong scheduling against closing time rather than
block it; STOP always available and never touching rotation; and if Iris drafts a schedule from a
park calendar it **proposes**, a human confirms, the system executes — Iris never arms a fire.

---

## 9 · What Jeff rules on

1. **A.8 reversal** — confirm sweepers move to a source channel (§6).
2. **STOP scope** — program-wide (stream goes silent too) or room-only? (§5)
3. **STOP timeout/nag** — silent indefinitely, or a visible timer and a nag?
4. **`generated_schedule.channel`** — migrate the 53,256 rows, or read `'CART'` as a legacy alias
   while they drain?
5. **Sweeper no-duck enforcement** — writer-refuses (recommended) or config flag only?
6. **Closing time scope** — per weekday, per date, or both. (`C.3` in the governing doc is still open;
   this screen forces the answer.)
