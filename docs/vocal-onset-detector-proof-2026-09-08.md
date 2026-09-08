# The vocal-onset detector — the 20-song proof, before anything is built
2026-09-08 · proposal · **no detector code exists and none is proposed for merge here**

Jeff's gate, recorded in `docs/imaging-model-redesign-2026-09-06.md` §2.2:

> *"Do not build the Rust detector until Jeff has heard it. Prove the candidate on 20 songs and let him
> check them against his ear. If it is not good, I would rather mark by hand most-scheduled-first than
> correct 444 bad guesses."*

This proposes **the proof**, not the detector. Nothing here ships, nothing writes to the database, and
no schema or Rust is involved.

---

## 1 · What is being decided

Not "does the detector work" in the abstract. One question, answerable by ear:

> **Would you accept these 20 candidates as a starting point, or would correcting them cost more than
> marking from scratch?**

That framing matters because a candidate does not need to be *right* — it needs to be **closer than
zero and never badly wrong in the same direction**. A post 200 ms early is a nudge. A post 4 seconds
late puts a voice over the first line, and if that happens even twice in twenty, the answer is no.

## 2 · The 20 songs

Not the easiest twenty, and not random — **the twenty that would actually be marked first**, which is
the most-scheduled-first order RACK already sorts by. If the detector fails on the songs that carry the
station, it fails where it matters.

Composition, chosen to expose the failure modes rather than avoid them:

| kind | n | why it is in the set |
|---|---|---|
| cold open — vocal in the first second | 3 | the case where a wrong answer is worst |
| long instrumental intro (>15 s) | 4 | where a detector drifts, or fires on a lead line |
| spoken/rap entry | 3 | different spectral shape from a sung entry |
| quiet or breathy entry | 3 | the case a threshold misses entirely |
| intro with backing vocals / "oohs" before the lyric | 4 | the classic false positive |
| ordinary sung entry after a bar or two | 3 | the case that must be right if any is |

**Chosen by me from the halloVeen library and named in the results, not hand-picked to flatter the
detector.** If Jeff wants to swap any of the twenty, that is better than me choosing all of them.

## 3 · How the candidate is produced for the proof

**In TypeScript, in a throwaway script — not in Rust, not in the analysis pass, not shipped.**

The existing analysis already computes `intro_end` (the silence boundary) at
`src/audio/songAnalysis.ts`. The candidate is: decode the file, take the first sustained rise in the
vocal band **after** `intro_end`, and report it in ms.

Approach, deliberately the simplest thing that could work:

- band-limit to roughly 200 Hz – 4 kHz, where a voice's fundamental and first formants sit and where
  most bass and cymbal energy is not
- take a short-window energy envelope of that band
- find the first point after `intro_end` where the band energy rises above its own running floor by a
  margin and **stays** there for ~300 ms — the "stays" is what separates a voice from a snare

**I have not measured this and will not claim it works.** It is a starting point cheap enough to throw
away. If it fails on the twenty, the answer to the gate is "no", and that is a completely acceptable
outcome of a proof — cheaper than a Rust detector nobody trusts.

## 4 · What Jeff actually does

The output is not a table of numbers. Numbers cannot be checked by ear.

**A throwaway page in RACK — or a standalone HTML file, his preference — with 20 rows. Each row plays
from 3 seconds before the candidate and runs 2 seconds past it**, exactly the audition the mark editor
already uses, so what he hears in the proof is what he would hear while marking.

Three buttons per row: **RIGHT · NUDGE · WRONG.**

- **RIGHT** — I would have put it there, or close enough that I would not move it
- **NUDGE** — in the right place but needs a small drag; still saves me time
- **WRONG** — I would delete this and start over

That is the whole instrument. It takes about ten minutes.

## 5 · The bar, agreed before the test rather than after

Set in advance so the result cannot be argued into a pass:

| result | meaning |
|---|---|
| **≥ 15 RIGHT or NUDGE, and 0 late-by-more-than-1s** | build the detector |
| **any 2 candidates land after the vocal has started** | **do not build it** — mark by hand |
| anything between | Jeff's call, with the recordings in front of him |

The asymmetry is deliberate. **Early is survivable, late is not.** A candidate 1 s early means imaging
stops talking a beat sooner than it could. A candidate 1 s late means imaging is still talking over
the first word — the exact thing the post exists to prevent — and it would do it on every play of that
song until someone noticed.

## 6 · What happens if it fails

Nothing is lost, and the plan is already in place:

- The columns exist and the by-ear editor works — that shipped in slice 2 and does not depend on this.
- RACK already orders songs **unmarked first, most-scheduled first**, which is the by-hand plan.
- The measured cost of the by-hand pass is Jeff's time: ~20–30 s per song, so **the thirty songs that
  carry the station are about fifteen minutes**, not an evening. The 444-song tail never has to be done
  at all — a song with no post simply falls back, and slice 3 records that it did.

**The by-hand path is not a consolation prize. It is the safe default that the detector has to beat.**

## 7 · If it passes

Then, and only then:
1. Port the same algorithm to Rust in the analysis pass, so it runs on import instead of on demand.
2. Write candidates with `post_source='auto'` and **no** `post_confirmed_at` — a candidate, never a
   fact, exactly as the columns already model it.
3. RACK's AUTO chip and the editor's "CANDIDATE — auto, unconfirmed" header already exist to carry it.
4. A confirmation pass remains Jeff's, at his pace, most-scheduled-first.

The detector never silently becomes truth. That is not a rule anyone has to remember — it is the shape
of the two columns.

## 8 · Cost of the proof itself

- Mine: the throwaway script and the 20-row page.
- Jeff's: **about ten minutes of listening.**
- Shipped: nothing. If the answer is no, the script is deleted and the by-hand pass proceeds.

## 9 · What this document does not claim

The algorithm in §3 is **unmeasured** — no candidate has been computed against any file. The song
composition in §2 is a plan, not a selection; the twenty are not yet chosen. The by-hand timing in §6
is arithmetic on a 20–30 s-per-song rate, which is an estimate and not a measurement of Jeff marking
anything.
