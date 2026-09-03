# "On air but invisible" — making it unexpressible

**Design of record. Steps 1–3 authorised; steps 4–6 GATED on Jeff verifying 1–3. Row 7 out of scope.**
Date: 2026-09-03 · Branch `log-reader-flip` at `addaa62` · Jeff's ruling, this session.

---

## 0 · The disease, named

Jeff, 2026-09-03, after a morning of it:

> The VU meter is a separate mechanism wired alongside the audio instead of being a READING of it.
> That's why slot 6 can be summed to master and simultaneously have no meter — a nonsense state a
> mixer shouldn't be able to express. Every bug today is the same disease: **a claim decoupled from
> the thing it claims about.**

The four instances, all found today:

| claim | what it was decoupled from | receipt |
|---|---|---|
| the ON lamp | the engine's `muted` flag, which nothing ever set | `App.tsx:4331` — `srcChannelOn[slot] ?? true`, and `setMuted` sent ONLY on a button press |
| "samples flowing" | actual signal | `audiod/engine.js` `_cartFlowing` returned true from `source_present && active && !paused` |
| the as-run log | whether the engine accepted the play | `main.js` `fireAnnouncement` never awaited `audiodClient.cmd()`, then stamped `last_played_at` |
| a channel on air | having a strip, fader, cut or meter | slot 6 sums to `mix` and has no `deck_configs` row |

**The principle: one trigger, one thing, and every display derives from the same truth.**

---

## 0.1 · THE ROOT CAUSE, and what "done" means — Jeff's ruling, 2026-09-03

> The original build had SEPARATE systems with dedicated decks for sweepers, announcements and
> carts. When we designed the UNIVERSAL assignable deck system, those old dedicated systems were
> supposed to be **DELETED and replaced**. They never were — so both exist at once.

That is the root cause behind every symptom in §0. Slot 6 is a special Cart species; sweepers are
hardwired to a literal `"CART"`; announcements had their own kind-lookup capped at `LIMIT 1`; nothing
on slot 6 is uniformly metered or controllable. **The universal system was built ON TOP OF the
dedicated ones instead of replacing them.**

### The end state — this arc is not "done" until these are GONE, not coexisting

1. **One uniform assignable channel type.** No Cart species, no dedicated sweeper/announcement/cart
   deck.
2. **What you dial in is the SOURCE. The channel is generic** — meter, fader, cut, monitor and
   duck-eligibility all by construction.
3. **Nothing addresses a hardwired slot by name** because it is "the cart deck" or "the sweeper
   deck".

### DEMOLITION INVENTORY — every surviving piece of the old dedicated systems

Each line is an item that must GO, not be built alongside. Verified present in the tree at
`addaa62`, 2026-09-03.

**A · The dedicated CART deck (engine)**

| item | receipt |
|---|---|
| `SlotKind::Cart` | `audio.rs:917` (`default_kind_for`), `:1269` (test) |
| `deck_index("CART") => Some(6)` | `audio.rs:630` |
| `deck_finished_key(6) => "CART"` | `audio.rs:929` — the len-6 `DECK_LETTERS` panic guard travels with it |
| `audio.deck_cart` as a named deck | `lib.rs:246` (`"deckCart"`), `:606` (`"CART" => &mut audio.deck_cart`) |
| `level_cart` as a named level field | `audio.rs:1739` — it is only `bus.peaks[6]` under another name |

**B · The dedicated CART deck (renderer)**

| item | receipt |
|---|---|
| `DeckType` still carries `"cart"` **and** `"jukebox"` as species | `DeckConfigurator.tsx:15` — jukebox migrated to a source kind in `11e0240` but the TYPE was never removed |
| the `deckType === "cart"` board branch | `App.tsx:4431` |
| CARTS button suppressed by a deck TYPE | `App.tsx:2621-2622` |
| the dock hidden by a deck TYPE | `App.tsx:4537` |
| `lvl.cart` consumed as a named channel | `ConsoleStrip.tsx:175`, `DeckConfigurator.tsx:799` |
| `CART_CHANNEL`'s `\|\| "CART"` fallback | `DeckConfigurator.tsx`, and the twin in `App.tsx` remote `cart:fire` |

**C · The dedicated SWEEPER path**

| item | receipt |
|---|---|
| four `"CART"` literals in the fire lifecycle | `audiod/engine.js` `_load` / `_play` / `_stop` / the flow observation |
| overlay scheduler writes `channel: 'CART'` | `electron/main.js:8235` |
| `play_log.deck = "CART"` stamp | `audiod/engine.js` `_logJinglePlay` |

**D · The dedicated ANNOUNCEMENT path**

| item | status |
|---|---|
| `LIMIT 1` kind-lookup — one channel only, ever | **REMOVED this session** (`main.js` `fireAnnouncement` + `announcements:can-fire`) |
| fire-and-forget stamping | **FIXED this session** — awaited and checked |
| the renderer-local `new Audio()` player | **STILL PRESENT** — `src/components/Announcements.tsx:870`. Plays out of the renderer's default output, never the program bus (design doc §F4). A second, off-air announcement system coexisting with the real one. |

**Note on precedence:** the jukebox is the one source that *completed* this migration
(`11e0240` — "jukebox becomes a source, legacy strip retired"). It is the worked example for every
row above: the dedicated strip was deleted, not left beside the new one. The residue is that
`DeckType` still lists `"jukebox"`.

**A closed item, for the record:** `5540bd3` deleted the SWEEPERS strip — the right move under the
end state, but taken *before* the replacement existed, which is why slot 6 has been on air with no
face since. Demolition ahead of replacement is what produced the worst symptom of the day. Order
matters: the generic channel must exist before the dedicated one is removed.

---

## 1 · The root cause of the fourth one: two lists that disagree

There are two answers in the system to "what channels exist", and nothing reconciles them.

| list | membership means | source |
|---|---|---|
| `bus.decks[0..SLOT_COUNT]` — 12 slots | **on air** (`mix_l[f] += lv`, `audio.rs:2087`; and `mix = core + src`, `:2215`) | the engine |
| `deck_configs` rows | **visible and controllable** | the database |

Slot 6 is in the first and not the second. That is the whole of "on air but invisible" — not a
forgotten wire, but a slot that exists in the mixer and not in the table the UI enumerates.
`AuxMonitorSlots` builds its rows from `deck_configs` too (`:100-110`), which is why the AUX MONITORS
panel lists D/E/F/G and silently omits CART.

**So the coupling belongs at the enumeration, not at each strip.** The board renders one strip per
entry in the engine's slot telemetry, and consults `deck_configs` only for that slot's label and
patch point. Configuration then *describes* a slot; it stops deciding whether one *exists*.

---

## 2 · The telemetry is already the right vehicle — one field short

`DeckTel` (`audio.rs:104-120`, filled `:1791-1801`) is published for **all 12 slots** on every levels
frame:

```
id, source_present, active, paused, volume, gain_db, frames_played, peak, duck
```

- `peak` is `bus.peaks[i]` — the real post-fader number. **The meter for slot 6 is already computed
  and broadcast right now; nothing displays it.** No engine work is needed for metering.
- `volume` is there, so the fader is a reading too.
- `duck` is there, and its own comment already states the principle:
  > *"Observed, never inferred. The strip's DUCK ON is what the DATABASE says; this is what the
  > ENGINE has."*
- **`muted` is absent.** That is precisely the gap that produced the ON-lamp bug: the lamp had
  nothing to read, so it defaulted to `?? true` and became a claim.

Asserting the claim downward (shipped this session, `App.tsx`) *corrects* the bug. The `muted` field
is what makes it **unexpressible**.

---

## 3 · Steps 1–3 — authorised, and they touch no audio path

### Step 1 · `muted` into `DeckTel`

Two lines of Rust: the struct field, and `muted: d.muted` in the push beside `duck`.

> **OPERATIONAL COST, and it is not zero.** `native/ether-audio.node` is a PREBUILT binary checked
> into the tree (see the `ether-audio.node.bak-pre-*` series). A Rust change requires a napi rebuild
> and a copy to both `native/` and `electron/`, **with the app and daemon fully closed** — the
> running processes hold the .node open. So this step cannot land while Jeff is testing.
>
> **Consequence for ordering:** the renderer work (step 2) reads `muted` **when the field is
> present** and falls back to the existing behaviour when it is absent, so steps 2–3 land and work
> immediately against the current addon, and the lamp becomes a true reading the moment the rebuilt
> binary is in. No flag day.

### Step 2 · The board enumerates from the engine

- Strips are rendered one per `decks[]` entry, not one per `deck_configs` row.
- The meter reads `decks[i].peak` — the number the mixer already computes.
- The lamp reads `muted` (falling back while the addon predates step 1).
- `deck_configs` supplies label and patch point only.

`setVolume` / `setMuted` are **already generic** over any deck id — `deck_index` covers A–F, CART and
S1–S5 — so controllability needs no new engine surface. Only the UI was gating it.

### Step 3 · The constraint

A test asserting every id in `decks[]` appears in the board's rendered set. This is the part that
turns a convention into a constraint: everything else can drift back, but a test that fails when a
slot is in `decks[]` and not on the board is what stops "on air but invisible" from being sayable
again.

**Stop after 3.** Jeff verifies slot 6 has a strip, fader, cut and meter.

---

## 4 · Steps 4–6 — GATED, do not start

Deleting `SlotKind::Cart` so every slot is uniformly an assignable source channel.

**The kind and the name are two different problems.** `SlotKind::Cart` has exactly two references in
all of Rust:

```
audio.rs:917    6 => SlotKind::Cart,                          // default_kind_for
audio.rs:1269   assert_eq!(b.decks[6].kind, SlotKind::Cart);   // one test
```

Nothing else branches on it; everything downstream reads `is_aux = deck.kind == SlotKind::Source`
(`:2063`). **Slot 6 can become `SlotKind::Source` while still being addressed as the string
`"CART"`.** Conflating the kind with the id is what made this look like a large migration.

### What flipping the kind actually changes — six lines at once

| line | today (Cart) | as Source |
|---|---|---|
| `:2075` `mon = if is_aux {aux_gain[i]}` | **0.0 — no room path** | gains the AUX monitor tap |
| `:2101` `aux_l += lv * mon` | never runs | audible in the room, post-fader/post-cut |
| `:2089` `if !is_aux { core_l += lv }` | in `core` | moves to `src` |
| `:2095` `if is_aux { src_l += lv }` | never | in the source sum |
| `:2077` `if is_aux && duck_enabled[i]` | **cannot arm the ducker** | duck-eligible unless enforced off |
| `:2092` `if !duck_duckable[i] { imm += }` | duckable by others | no longer attenuated by another channel's duck |

### The golden test will move, by design

`abc_cart_bit_identical_with_no_source_channels` (`:1080`) pins
`GOLDEN_7_SLOT = 0xfb5c26536f759828`, computed **with CART in the core sum**. Moving slot 6 to `src`
changes the grouping in `mix = core + src`, and float addition is not associative.

**It must be re-derived, not rubber-stamped.** That test's own comment records that an earlier
version passed against everything because it compared silence to silence — the decks were left
`paused: true` and the callback skipped them all. Re-baselining with the decks genuinely playing is a
required step, not a formality.

### Ordering constraint

**Writer-enforced no-duck ships BEFORE the kind flips**, or there is a window in which a sweeper
channel can arm the ducker and duck the song it is sweeping into.

---

## 5 · A.8 is superseded — recorded, with receipts

`docs/aux-channel-ducker-announcements-design-2026-08-21.md` ruling A.8 kept automated seam sweepers
on CART on two grounds. `docs/operator-closing-screen-and-source-routing-2026-08-31.md` §6 already
reversed it in writing; the code now confirms the reversal:

**Ground 1 — "the seam bridge depends on CART." Factually gone.** The bridge gates on
`firingConfirmedAt`, set from the flow observation, which reads `lv.cart` and then falls back to
`decks[].find(d => d.id === "CART" || d.id === 6)` — **already a generic per-slot lookup by id**.
Generic per-slot telemetry shipped as A.5. The bridge needs an *observable channel*, not a special
species of one.

**Ground 2 — "cart is correctly duck-excluded." Real, and it becomes a flag.** Today it is impossible
by construction. As a Source channel it becomes `duck_enabled[6] = false`, which someone can set
wrong. The replacement is the one §4 of the 2026-08-31 doc already ruled, and it is strictly better
because it states the actual rule rather than relying on a coincidence of slot layout:

> the `deck_configs` writer refuses `duck = 1` where `kind = 'sweeper'`, and `armAllStationDuckers`
> (`electron/main.js:4964`) refuses to arm it regardless of what the row says.

---

## 6 · Row 7 — out of scope, and confirmed unnecessary

The `"CART"` string id, `level_cart`, `deck_index`, `deck_finished_key`, the four daemon literals,
`play_log.deck`, and the **53,256 `generated_schedule` rows carrying `channel='CART'`** are all left
alone.

**The 53k rows need nothing at all.** `audiod/loggen.js:478-486` selects the seam on
`content_class IN ('JIN','SWP')` and never reads `channel`; a grep for a `channel` filter across
`loggen.js`, `engine.js` and `autofit.js` returns nothing on the fire path. `channel` is written by
the overlay scheduler and read by nobody who fires. The 2026-08-31 doc's assumption that these rows
"must be re-pointed or read leniently" is superseded by that receipt.

---

## 7 · One thing that stays true afterwards

Making slot 6 a Source channel gives it a **room** path via the monitor tap, but its monitor level
starts at 0 like every other aux deck — *silence is never something an upgrade decides for you*
(`AuxMonitorSlots`, the assert-downward rule). So the first sweeper after step 4 will be metered and
on air and **still inaudible in the studio** until that row's MONITOR slider is raised.

**Metered ≠ monitored.** Naming it here so it is not mistaken for a regression later.

---

## 8 · Architecture Compliance

| requirement | receipt |
|---|---|
| Governing docs cited | `aux-channel-ducker-announcements-design-2026-08-21.md` (A.5, A.8); `operator-closing-screen-and-source-routing-2026-08-31.md` (§4, §6) |
| Conflict surfaced, not built over | A.8's ground 1 is disproved by the code; ground 2 keeps its guarantee via the writer-enforced rule §4 already ruled |
| Nothing rebuilt that exists | `DeckTel.peak` for all 12 slots, generic `setVolume`/`setMuted` via `deck_index`, and the levels broadcast all already exist. Steps 2–3 surface what is already computed. |
| Correct minimal change | Steps 1–3 deliver the guarantee **without touching the mixer**. Row 7 explicitly not built; the 53k-row migration explicitly not built, with the receipt for why. |
| Build the sense, not the scaffold | The meter becomes a reading of `peak`; the lamp becomes a reading of `muted`; step 3 makes the coupling a test rather than a habit. |
| Doors before rooms | Slot 6 gains a strip, fader, cut and meter — the first time it has had any of them since `5540bd3`. |
