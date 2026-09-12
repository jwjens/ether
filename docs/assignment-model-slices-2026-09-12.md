# The assignment model — build slices

**Status:** PROPOSAL. Nothing built.
**The model lives in** `docs/unified-library-architecture-2026-08-26.md` **§2a** (Jeff's ruling,
2026-09-12). This document is only the ORDER OF WORK. If the two ever disagree, §2a wins.
**The defect being fixed:** *"I have cuts in the library as carts and I can't use them as sweepers."*

---

## THE CONSTRAINT THAT OUTRANKS THE PLAN (Jeff, 2026-09-12)

> "I should not have to re-import or re-assign anything I already have. Existing carts, sweepers and
> pools convert by migration, not by me rebuilding them."
>
> "If any slice can't convert something automatically, say so before it's built and tell me exactly
> what I'd have to redo."

**No slice ships that asks the operator to rebuild what he already has.** Every slice below carries a
CONVERSION line saying what migrates automatically, and a REDO line — which must read *nothing* or
name exactly what is lost and why. A slice whose REDO line is non-empty is not ready; it goes back
until the conversion is written or Jeff accepts the cost with the number in front of him.

This is not a preference about convenience. A conversion that "the operator can just redo" is an
unwritten migration, and an unwritten migration is one that was never tested against his data.

---

## The simplification that falls out of the ruling, and it is a large one

**Membership IS the type.** Once assignment tables are the truth, being a sweeper means *having a row
in `sweeper_pool_member`*, and being a cart means *having a cart slot pointing at you*. There is no
need for a multi-valued type column, and no migration to make `content_class` hold a list.

`type` / `content_class` survives as the Library's **filter and default** — what Jeff picks so the
Library can show him "my sweepers" — but it stops gating eligibility. That removes the single hardest
piece of the original §2 design before slice 1 begins.

---

## Slice 1 — one cut, a cart AND a sweeper

**The thing Jeff cannot do today, first, exactly as he asked.** Additive: no storage moves, nothing is
dropped, no surface loses a capability.

1. `cart_slots.asset_uuid TEXT` — new, nullable, alongside the existing `file_path`.
2. The cart fire path resolves **asset first, `file_path` as fallback**. A slot with no `asset_uuid`
   behaves exactly as it does today, so nothing on OV's wall changes on the day it lands.
3. The cart wall gains **"choose from Library"** — a picker over existing assets. This is an
   ASSIGNMENT, not an import: it creates no audio and no library row, which is what keeps it legal on
   a WHEN surface.
4. Backfill: match every existing `cart_slots.file_path` to a library asset by `file_key` first, then
   basename. Whatever matches gets `asset_uuid`. Whatever does not is **reported, never guessed**.

**Delivered:** take any sweeper cut, put it on a hotkey, and it is both. The file is not copied and
there is no second row.

**CONVERSION:** every existing cart converts automatically. `cart_slots.file_path` is matched to a
library asset by `file_key`, then by basename; the match writes `asset_uuid`. A cart imported through
the cart door with no library row at all gets an asset CREATED for it from the file it already points
at — the audio is in the catalogue either way, so this is registration, not import.

**REDO: nothing.** No cart is re-imported and no hotkey is re-assigned.

**By hand, Jeff:** read the dry-run report before it writes — same shape as the sweeper backfill,
which recovered 16 stranded cuts and 11 pool memberships on OVEVENTS without a single re-cut. Then
fire one converted cart after install to confirm the audio is right.

---

## Slice 2 — the Library becomes the only import door

**No import in the cart wall. No ADD IMAGING in Sweepers. No import anywhere but the Library.**

1. Remove the picker and the drop handler from `BoutiqueCartWall`, and from App's second wall.
2. Remove the **ADD IMAGING — CUT A REEL** tab from `SweepersPanel`; the push-up becomes MANAGE only.
3. The Library grows the assignment gestures those doors used to imply: *mark as sweeper → pool*,
   *mark as cart → slot*, on selection, the way a category is assigned now.
4. The Reel Splitter moves — see §"Where the Reel Splitter belongs" below.

**CONVERSION:** including App's localStorage wall — **and I was wrong about this earlier.**

I said `ether_carts_v1` could not be migrated because it holds `{key, filePath}` in browser storage
with no database row, and that those carts would have to be re-made by hand. That was wrong. It
cannot be converted by a SQL migration, which is not the same thing: a one-shot conversion in the
renderer on first launch can read that key, register each path as a library asset, write the
`cart_slots` assignments, and then clear it. The data is right there and it is structured.

**REDO: nothing.** The wall is retired and its carts arrive on the real wall, converted.

**By hand, Jeff:** confirm the Library's assign gestures are reachable BEFORE the old doors close.
**Doors before rooms** — if slice 2 lands and assignment is hard to find, the feature reads as
removed. And check the converted localStorage carts once: it is the one conversion reading from a
store no migration can see, so it deserves an eye rather than a verdict from me.

---

## Slice 3 — `cart_slots` stops owning audio

Only after a release of slice 1 running clean on OV.

1. Drop `file_path` and `file_key` from `cart_slots`; `asset_uuid` is the only pointer.
2. Registry: the `blob-ref` column goes, so cart rows stop carrying a machine path across sync — one
   fewer surface for [N-23a] to defend.
3. `AUDIO_TABLES` in `audio-library-index.js` loses `cart_slots`: it is no longer a file-bearing
   table, so library-health stops classifying it and starts seeing carts through their asset.

**CONVERSION:** nothing left to convert — slice 1 did it, and slice 3 only drops columns no longer
read. The guard is that it must not run until slice 1 reports **zero** carts on the legacy path.

**REDO: nothing** — provided that check passes. If a cart were still on `file_path` when the column
is dropped it would go silent, which is why slice 3 is gated on slice 1's report rather than on time.

**By hand, Jeff:** nothing.

---

## Slice 4 — the remaining types

Spots and announcements, per the architecture doc §4 steps 3-7, unchanged by this ruling except that
they now join as **assignments** rather than as a type value. Sweepers-as-scheduled-elements (§4 step
6) stays last and behind a canary: it is the only step that changes what airs.

---

## Where the Reel Splitter belongs

**It moves into the Library, as an import mode.**

The rule is "the Library is the only import door", and the Reel Splitter looks like an exception
because it *creates* audio rather than copying it. It is not an exception. Take the rule literally:
the Library is where a file BECOMES a library asset. The splitter takes one reel that is not in the
library and produces twelve assets that are — it is an **import multiplier**, and that is the import
door's job by definition.

Its presence in the SWEEPERS push-up is the accident. It is there because sweepers were the first use
of it, which is precisely the "typed by which door you used" defect: cut a reel from the sweeper panel
and the output is sweepers, necessarily, whether or not that is what the operator wanted. One of those
twelve cuts is very often a cart.

**So:**

- **Library → Import → Cut a reel.** Same component, same shared region engine
  (`silenceRegions.ts` + `imagingCommit.ts`), new home. Typing at the point of import stays legal
  here, because the Library IS the typing surface — the operator can mark all twelve as sweepers and
  pool them in one pass, exactly as today, and can now also mark one of them a cart.
- **StudioPro keeps chop-and-send**, because production is its job (CLAUDE.md: *"production
  (import/chop/send) → StudioPro"*). Its SEND TO targets collapse: **Library** creates the asset;
  **Deck** stays because loading a deck is transient and makes no row. *Send to Sweeper* and *Send to
  Jingle* disappear as separate exits — they were type-at-creation, which is the thing being removed.
- **One engine, two surfaces, still.** `renderRegionToDisk` and the region model stay shared and are
  never copied. That rule does not change; only the surfaces either side of it do.

**What this costs:** nothing in steps for the common case. Cutting a reel of sweepers is the same
number of gestures, in a different place. What it buys is that the twelfth cut can be a cart.

**The one thing to get right:** the Library's import affordance has to be obvious enough that an
operator looking for "cut a reel" finds it. It moves from a labelled tab to somewhere new, and a
feature its own owner cannot find is a bug.

---

## What this arc deliberately does not do

- It does not merge schedules. Four schedulers stay distinct — §5 of the architecture doc.
- It does not answer §6.1 (`songs` vs `library_asset`). Assignments point at a uuid, and v50 already
  made `library_asset.uuid == songs.uuid`, so slices 1-3 work either way. **§6.2 (install vs station
  scope) DOES need a ruling before slice 3**: the asset is install-scoped and the assignment is
  per-station, so the same cut can be cart 3 on one station and unassigned on another. That is
  believed to be what Jeff wants and it should be confirmed, not assumed.
- It does not touch the Reel Splitter's silent-commit defect
  (`docs/reel-splitter-silent-commit-2026-09-12.md`). That is a live bug on OV today and should be
  fixed on its own, before any of this — it is unrelated, and it will still be there afterwards.
