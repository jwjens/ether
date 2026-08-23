# Sweepers on the normal playout path — the RCS model, and the jingle→sweeper rename

**Date:** 2026-08-22 · **Status:** DESIGN ONLY — nothing built. **Jeff rules before any build.**
**Framing confirmed by Jeff:** this is a **re-route plus deck arithmetic**, not a scheduler rebuild.
**Rulings folded in:** dedicated sweeper deck(s) from the 12-slot pool · the full RCS behaviour set,
per element · CART retired only as the *automated* path and kept for hand-fired carts · the
jingle→sweeper rename, migrating existing audio and scheduling.

---

## 0 · What the read established

Four findings, with receipts, because the whole design rests on them.

### 0.1 · Sweepers are ALREADY scheduled log elements

They are rows in `generated_schedule`, not a separate subsystem:

```sql
-- audiod/loggen.js:478-486  (readJingleForSeam)
SELECT gs.id, gs.scheduled_at, gs.title, gs.content_class,
       COALESCE(gs.file_path, s.file_path) AS file_path,
       gs.lead_in_sec, gs.underlap_sec, gs.jingle_category_id
  FROM generated_schedule gs LEFT JOIN songs s ON s.id = gs.song_id
 WHERE gs.station_id = ? AND gs.content_class IN ('JIN','SWP') AND gs.deleted_at IS NULL
   AND gs.scheduled_at > ? AND gs.scheduled_at <= ?
```

The scheduler places them, with **per-element timing already on the row** (`lead_in_sec`,
`underlap_sec`). **Nothing about placement needs to be built.**

### 0.2 · The RCS keys already exist in the playout path

| RCS behaviour | What already implements it |
|---|---|
| Overlap the segue | `segueOverlap` (default 3s, `engine.js:120`) — incoming starts **at full over the outgoing's natural tail, no fades** (`_segueTick:1982`) |
| Element in its own slot | `deckContentClass[deck] === 'SPOT'` → **clean IN and clean OUT** (`engine.js:1994-2000`) |
| Per-element behaviour key | **`chainType: "segue" \| "stop"`**, carried per queue item and per deck (`deckChainType`; `engine-rodio.ts:98`) |
| Automation never fades | outgoing rides its mastered tail to natural end (`_jingleBeginBridge:1867`) |

### 0.3 · The ONLY non-RCS part is the divert to CART

`_jingleTick` (`engine.js:2008`) does everything correctly — read-ahead hint, arm inside a window,
fire on the advance chain, weave the incoming under the tail, supersede on air-generation change,
suppress across a SPOT seam — and then plays the element on **CART, slot 6, an overlay bus**, instead
of loading it to a deck on the normal path.

### 0.4 · JIN and SWP differ ONLY by timing defaults

This is the reconciliation Jeff asked for, and it is smaller than it looks:

```js
// audiod/loggen.js:492-493
leadInSec:   row.lead_in_sec   != null ? row.lead_in_sec   : (cls === 'SWP' ? 2 : 5),
underlapSec: row.underlap_sec  != null ? row.underlap_sec  : (cls === 'SWP' ? 1 : 2),
```

Two content classes, identical handling, **different default lead-in/underlap**. They are not two
kinds of thing — they are two timing presets of one thing.

---

## 1 · The target model

**A sweeper is a scheduled audio element that plays on the normal playout path, on its own deck,
under the normal segue rules.**

```
generated_schedule row
   content_class = 'SWP'
   chain_type    = 'segue' | 'stop'      ← the RCS behaviour key, per element
   lead_in_sec, underlap_sec             ← per-element timing (already on the row)
   sweeper_category_id                   ← renamed from jingle_category_id
        │
        ▼
  loaded to a DEDICATED SWEEPER DECK (slot from the 12-slot pool)
        │
        ├─ chain_type 'segue' → OVERLAP: rides the outgoing tail into the incoming head
        └─ chain_type 'stop'  → DRY:     clean IN, clean OUT, plays alone in its own slot
```

Both behaviours are the *existing* mechanisms, applied to a new deck — not new engine features.

### 1.1 · Behaviour A — the overlapping sweeper

The weave `_jingleBeginBridge` already produces, unchanged in character:

```
outgoing tail ──────────────┐
                sweeper ────┼──────────┐
                            incoming head ──────────►
```

- **Fire** when the outgoing deck's `remaining <= lead_in_sec` (today's `_jingleTick:2019`).
- **Incoming enters** at `sweeper_end − underlap_sec`, under the sweeper's remaining tail.
- **Nothing fades.** The outgoing rides its own mastered tail to its natural end.

What changes: the sweeper is a deck the rotation knows about, so this stops being a bespoke bridge
and becomes the ordinary segue-overlap rule with a third participant.

### 1.2 · Behaviour B — the dry drop / ID

`chain_type = 'stop'` → the element gets **clean edges**, exactly as a SPOT does today: song ends,
element plays alone, next song starts. The existing rule is written for the literal string `'SPOT'`
(`engine.js:1997`); it generalises to *"content classes that are exclusive program"*, with SWP-dry
joining SPOT in that set.

**This is a generalisation of an existing branch, not a new path.**

### 1.3 · Behaviour C — per-element choice

`chain_type` on the row decides, set by the element and the clock. No new key, no new column: it is
the column the queue already carries.

---

## 2 · Deck strategy — dedicated sweeper decks (Jeff's ruling 1)

### 2.1 · Why A/B/C cannot host this

The weave needs **outgoing + sweeper + incoming playing simultaneously — three decks.** A/B/C is
exactly three, which leaves **nothing free to preload the song after next**. That starvation is
precisely why CART exists as a fourth player. Cramming sweepers onto A/B/C would recreate the problem
that produced the architecture we are removing.

### 2.2 · The proposal

Slice 1 raised the engine pool to **`SLOT_COUNT = 12`** with channels appended at 7-11 and an explicit
**per-slot kind flag** — which is exactly the seam this needs.

- **Two dedicated sweeper decks**, from the pool. Two, not one, so a sweeper can preload while another
  is still weaving (back-to-back seams at a tight clock).
- **A new `SlotKind::Sweeper`**, distinct from `Source`. A source channel is *operator-patched*; a
  sweeper deck is *automation-owned*. Different owner, different rules — and the ducker must treat
  them differently: **a sweeper deck must never trigger ducking** (a sweeper must not duck its own
  song), which the kind flag expresses structurally rather than by slot arithmetic.
- Rotation never starves: A/B/C keep doing exactly what they do now.

**Open for Jeff:** two sweeper decks or one? Two costs one idle `DeckSlot` and one branch per buffer.

---

## 3 · Reused vs new

| Piece | Status |
|---|---|
| Placement in `generated_schedule` | **EXISTS** — no change |
| Per-element `lead_in_sec` / `underlap_sec` | **EXISTS** on the row |
| Seam-window query (`readJingleForSeam`) | **EXISTS** — renamed only |
| Read-ahead SCHEDULED hint | **EXISTS** — unchanged |
| Supersession (`_jingleSuperseded`) | **EXISTS** — unchanged |
| SPOT suppression (no imaging over a commercial) | **EXISTS** — unchanged |
| `chainType` segue/stop | **EXISTS** — now honoured for sweepers |
| Clean-edge rule for exclusive content | **EXISTS for SPOT** — generalise to SWP-dry |
| `segueOverlap` machinery | **EXISTS** — now governs a three-participant seam |
| **Load the element to a deck instead of CART** | **NEW** — the re-route |
| **Sweeper deck slots + `SlotKind::Sweeper`** | **NEW** — small, rides slice 1's pool |
| **Three-participant seam arithmetic** | **NEW** — the real engineering |
| **Play-log stamps the real deck** | **NEW** — one field |
| **The rename** | **NEW** — mechanical, wide |

---

## 4 · CART's fate (Jeff's ruling 3)

**Retired only as the automated sweeper path. Kept for hand-fired carts/drops.**

| Thing | Fate |
|---|---|
| CART slot 6 as a bus | **KEPT** — manual imaging still fires here |
| The static fader | **KEPT, RENAMED** to its real purpose — it is the hand-fired cart bus, not "JINGLES". Its level and cut are the operator's only control of that bus |
| MIDI `cart_volume` (`MidiEngine.tsx:211`) | **STAYS WITH CART** — it is the hand-fired bus's level. The automated sweeper's level follows its own deck's fader, like every other scheduled element |
| Play-log `deck: "CART"` (`_logJinglePlay:1854`) | **FOLLOWS THE SWEEPER** — an automated sweeper stamps its real deck. Hand-fired carts keep stamping CART |
| `_cartFlowing()` liveness (`:545`, `:1796`) | **NARROWS** to hand-fired carts. An automated sweeper is live via ordinary deck state |
| Duck exclusion | **UNCHANGED IN EFFECT** — CART is not a source channel, and neither is a sweeper deck. Neither can ever trigger a duck |

---

## 5 · The rename — jingle → sweeper (Jeff's ruling 4)

**501 hits.** The identifiers that actually matter:

| Current | Becomes | Count | Kind |
|---|---|---|---|
| `jingle_categories` (table) | `sweeper_categories` | 70 | **DB — migration** |
| `jingle_category_id` (column) | `sweeper_category_id` | 38 | **DB — migration** |
| `content_class 'JIN'` | `'SWP'` | — | **DB — see §5.1** |
| `jingleOverlay` | `sweeperOverlay` | 17 | renderer state/props |
| `JinglesPanel` | `SweepersPanel` | 8 | component + its door |
| `_jingleTick` / `_armJingle` / `_fireJingle` / `_cancelJingle` / `_clearJingle` / `_jingleSuperseded` / `_jingleShouldBridge` / `_jingleBeginBridge` / `_logJinglePlay` / `_emitJingle` / `_jingleCartGen` | `_sweeper*` equivalents | ~40 | daemon engine |
| `readJingleForSeam` | `readSweeperForSeam` | 4 | loggen |
| `JINGLES_ENABLED` | `SWEEPERS_ENABLED` | 2 | kill-switch |
| `hasJinglePool` / `onOpenJingleSettings` / `jingleVol` / `jingleClass` | `hasSweeperPool` / `onOpenSweeperSettings` / `cartVol` (see §4) / `sweeperClass` | ~18 | renderer |
| `audio:daemon-jingle` (IPC channel) | `audio:daemon-sweeper` | 3 | **IPC — leak-guard touched this channel before; re-check the ratchet** |
| UI strings "JINGLES" / "Jingle" | "SWEEPERS" / "Sweeper" | many | labels |
| `docs/help-jingles.md` | `docs/help-sweepers.md` | 1 | **help entry — the feature is not done without it** |

### 5.1 · Reconciling JIN and SWP

They differ only by default timing (§0.4). **Collapse to one class, `SWP`**, with behaviour carried by
`chain_type` and timing by the row's own `lead_in_sec`/`underlap_sec`:

- Forward-looking tables (`generated_schedule`, category config): `JIN` → `SWP`, and where a row had
  no explicit timing, **write the JIN defaults (5 / 2) onto the row** so its behaviour is preserved
  exactly rather than silently re-timed to the SWP defaults (2 / 1). *A migration that changes how a
  station sounds is not a rename.*
- **`play_log` history is NOT rewritten.** Airplay history is evidence for the affidavit; the standing
  rule is that a delete retracts a song's future, never its past, and the same applies here. Readers
  accept `'JIN'` as a legacy synonym of `'SWP'` forever.

---

## 6 · Migration — nothing loses its audio or its schedule

1. `ALTER TABLE ... RENAME TO` for `jingle_categories` → `sweeper_categories`; column rename for
   `jingle_category_id`. Both are SQLite-supported renames that preserve every row.
2. `UPDATE generated_schedule SET lead_in_sec = COALESCE(lead_in_sec, 5), underlap_sec =
   COALESCE(underlap_sec, 2) WHERE content_class = 'JIN'` — **freeze the old behaviour onto the row
   first**, then `SET content_class = 'SWP'`. Order matters: reclassifying first would re-time them.
3. Existing scheduled rows keep their `scheduled_at`, so **today's log still airs its imaging**.
4. Audio files are untouched — the rename is metadata only.
5. Idempotent, and non-fatal on error: a station that cannot migrate still opens (the robustness rule).
6. **A build that reaches customers must leave the DB openable by the previous build** — the 4.4.151
   lesson. A table rename does not satisfy that on its own; §9 flags it.

---

## 7 · Phased build

| Phase | Content | Gate |
|---|---|---|
| **S1** | Sweeper deck slots + `SlotKind::Sweeper` in the engine; no behaviour change (sweepers still on CART) | golden regression: core mix + aux bit-identical |
| **S2** | Re-route: load the scheduled sweeper to its deck; overlap behaviour via the existing weave | Jeff's ears — a sweeper rides the seam exactly as it does today, from a different deck |
| **S3** | Dry behaviour: generalise the SPOT clean-edge rule to `chain_type='stop'` | Jeff's ears — dry drop plays alone, clean both sides |
| **S4** | CART narrows to hand-fired; fader renamed; play-log deck stamping; MIDI confirmed | hand-fired cart still fires and still stamps CART |
| **S5** | The rename, end to end, + migration + `docs/help-sweepers.md` | migration receipt: rows touched; nothing loses audio or schedule |

The rename is deliberately **last**: renaming before the re-route would mean renaming code that is
about to be rewritten, and would make every diff in S2-S4 unreadable.

---

## 8 · Honest sizing

**Substantial, but concentrated.** The scheduler, the placement, the timing math, the seam query and
the safety rails all exist and are reused verbatim. The genuinely new engineering is:

1. **The three-participant seam** — outgoing, sweeper, incoming on three separate decks with the
   rotation preloading a fourth. This is the hard part and the only part that can go wrong on air.
2. **Sweeper deck slots and their kind** — small, and slice 1 already built the pool.
3. **The rename** — wide, mechanical, low-risk once the re-route has settled.

---

## 9 · Open questions for Jeff

1. **One sweeper deck or two?** Two lets a sweeper preload while another weaves. I recommend two.
2. **`SlotKind::Sweeper` as its own kind** (vs reusing `Source`)? I recommend its own — automation
   owns it, and the ducker must never see it as a source.
3. **Downgrade safety.** Renaming `jingle_categories` means an OLDER build opening this database
   finds no such table. Per the 4.4.151 rule, that strands anyone who rolls back. Options: keep a
   legacy VIEW named `jingle_categories`, or defer the table rename to a release where rollback is
   ruled out. **I recommend the view** — it costs nothing and keeps the old build openable.
4. **`audio:daemon-jingle` → `audio:daemon-sweeper`** touches an IPC channel the station-identity
   leak-guard has already migrated once. Confirm the ratchet baseline is re-checked in S5 rather than
   assumed.

**Nothing is built. No code has been written or changed for any of this.**
