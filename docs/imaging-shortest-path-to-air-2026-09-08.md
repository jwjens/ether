# The shortest path to hearing selection-by-length
2026-09-08 · plan · **nothing built**

Jeff: *"What's the shortest path to hearing this work? One station, one category, a handful of marked
songs, audible selection-by-length. I'm not marking 444 songs before I know the model sounds right."*

Rulings taken as given: strict test `cue_out <= post − segueOverlap`; name the outro column, build
nothing for it; fix RACK and invert POOLS before scale.

---

## The path, in three steps

### Step 0 — today, on 4.6.17, no build needed

**Mark 5–10 songs that are in ONE music category on halloVeen.** RACK → Songs already orders them
unmarked-first, most-scheduled-first, so the top of that list is the right ten.

This is not preparation for the test, it *is* the first half of it: it tells you whether the marking
gesture is right before any of it touches air, and it gives me real post values instead of assumed
ones. **If the gesture is wrong, we find out here, at the cost of ten minutes.**

### Step 1 — one build

| piece | what it is |
|---|---|
| **The opt-in** | `categories.overlay_chain_type`, unset everywhere. **Unset = today's behaviour, byte for byte.** Exactly one category gets `'auto_post'`. |
| **Selection** | in `_placeJingles`, candidates filtered to `cue_out <= post − segueOverlap`, using `outro_start` when the operator has set no `cue_out`. No post on the song → today's fixed LEAD, recorded. |
| **The placement row** | carries the incoming song's `post_ms`, the chosen cut's audible end, and `chain_type_effective` — so the daemon never queries and ON DECK can say what rule ran and why. |
| **The fire** | one arm in `_jingleTick`: after the rotate, fire when the INCOMING deck's `positionSec >= post − cue_out`. Only for placements marked `auto_post`; every other placement takes the existing path untouched. |
| **RACK / POOLS** | ruling 3 — de-correlate the cut page, one flat membership query, POOLS inverted to pool-first. Cannot affect a seam, so it rides along safely. |
| **The outro column** | ruling 2 — named and migrated, read by nothing. |

### Step 2 — hear it

Set the one category to `auto_post`, Generate a day, open ON DECK, listen to a few seams.

**With as few as three marked songs in that category you can hear the model.** Seams into a marked song
use the new rule; every other seam on the station is unchanged.

---

## What you will hear that is different

**Today:** the sweeper fires `LEAD` seconds before the incoming song starts, plays over the tail of the
outgoing song and into the new one, and ends wherever its own length puts it — which may be on top of
the first vocal.

**After:** the sweeper starts *inside* the new song's intro and its last audible moment lands on the
first word. It never touches the outgoing song at all.

**What to listen for, in order:**

1. **Does the cut land on the vocal, or near it?** That is the model working. If it lands early, the
   post is marked late, or the cut has trailing silence the analyser did not trim.
2. **Does anything talk over the end of the outgoing song?** It must not, ever. If it does, the strict
   test is not being applied.
3. **Does a seam go bare?** That is selection finding nothing short enough. ON DECK will say so with
   the numbers — it is a shopping list, not a fault.
4. **Do unmarked songs sound exactly as they do now?** They must. That is the fallback working.

---

## The one genuinely new piece of engine work

Today's arm reads the **outgoing** deck: `remaining <= leadIn + segueOverlap`, fires *before* the
rotate, and the bridge machinery starts the incoming deck at the outgoing's natural end
(`audiod/engine.js` `_jingleTick`, the `armed` branch).

The new arm reads the **incoming** deck, *after* the rotate. That means the armed entry has to survive
the rotate rather than being consumed by it, and the fire condition changes deck. It is one branch and
it is simpler than today's — no bridge is involved, because the sweeper no longer spans the seam — but
it is the only part of this that touches the fire path, and it is where the risk is.

**Contained by the opt-in:** a placement without `chain_type='auto_post'` never enters that branch.

---

## What is NOT on this path

- Marking 444 songs. Ten is enough to hear it; the rest can wait forever.
- The detector. It proposes marks; you are marking by hand for this test anyway.
- The outro *behaviour*. Column named, nothing built.
- `dry_ms`, LINK-SONG, the two-sided trigger. All deleted by the model.
- Chain types as a full vocabulary. One value, `auto_post`, opt-in on one category.

## What this document does not claim

The fire arithmetic is designed, not measured — no placement has been made under it, and nothing has
been heard. Whether the armed entry can survive the rotate cleanly is **read from source, not tested**;
it is the piece most likely to need a second pass.
