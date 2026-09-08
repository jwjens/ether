# Selection by length — what the simpler model costs and what it deletes
2026-09-08 · read-only · **nothing built**

Jeff's model, verbatim:

> *"A song's intro is N seconds. The engine picks a sweeper SHORTER than N. A cut longer than the intro
> is not selected. That's it."*

It is simpler than what is designed, and it removes the hardest part of slice 3. Everything below is
measured against the live profile (opened read-only) and read from source.

---

## 0 · What is true today, before any of this

| fact | evidence |
|---|---|
| **Nothing selects imaging by length.** `_placeJingles` picks by least-recently-played within a pool and never looks at duration. | `electron/main.js` `resolvePool` |
| **Playout ignores cue points entirely.** No reader of `cue_in`/`cue_out`/`intro_end`/`outro_start` exists in `audiod/`, `electron/` or `native/src/audio.rs`. The engine plays whole files from sample 0. | `grep -rln` across the play path returns only the editors, the sync handlers and the analyser |
| **`cue_in` is hardcoded 0 and `cue_out` is hardcoded to the duration** by the analyser — *"always start at 0 (jock sets this manually)"*. | `native/src/audio_engine.rs:803, :825` |
| **`intro_end` = first sustained audio; `outro_start` = start of trailing silence.** These are the SILENCE boundaries, computed automatically. | `native/src/audio_engine.rs:806-843` |
| On the 64 cuts: **all 64 have `intro_end` and `outro_start`; none has `cue_in` or `cue_out`.** | measured |
| On the 444 songs: **3 have `intro_end > 0` (avg 0.52 s), 0 have `post_ms`.** | measured |

**So there are two pairs of columns, and they do not mean the same thing:**

- `intro_end` / `outro_start` — **where the audio starts and stops being audible.** Auto-detected,
  present on every cut. This is the silence trim.
- `cue_in` / `cue_out` — **the operator's playback window.** Never auto-set to anything meaningful
  (0 and duration), unset on every cut, and read by nothing at playout.

They overlap in meaning, which is the same suffix-trap `post_ms` was created to avoid. §6 proposes
which one the editor writes.

---

## 1 · Does this fit slice 3, or replace it?

**It is AUTO-POST plus a selection filter — and it deletes the hard half of slice 3.**

§4.2 of the redesign needed a **two-sided trigger** because a cut could be longer than the post:

> *`L > post` → the fire point is before the rotate… `L <= post` → the fire point is after the rotate…
> So AUTO-POST needs a two-sided trigger… This is new work in `_jingleTick` and it is the only
> genuinely hard part of piece 3.*

**Selection guarantees `L <= post`. The first case cannot happen.** The fire point is always after the
rotate, so there is one arm reading one deck:

```
fire when the incoming deck's position P >= post − (audible end of the cut)
```

One comparison, on the deck that is already being polled. The hardest named piece of slice 3
disappears — not deferred, unnecessary.

### What else it makes unnecessary

| dropped | why |
|---|---|
| **`dry_ms` as a marking task** | Nothing needs it. Confirmed: 64 cuts × ~15 s of marking, gone. |
| **LINK-SONG** | It exists to place a cut that does NOT fit — the voice rides the outgoing tail because there is no room in the intro. If selection guarantees the cut fits, the normal case never needs it. Keep the *name* for a future deliberate long-cut mode; do not build it now. |
| **`chain_type` vocabulary** | Shrinks from four to three: `auto_post` \| `segue` \| `stop`. |
| **The warning in §4.2** (`L − dry > post`) | Cannot arise — selection is that check, applied earlier. |

### What it does NOT make unnecessary

- **`post_ms` on songs.** It is now the *only* mark, and the whole model rests on it.
- **`chain_type_effective` on the placement row.** More necessary, not less: with selection able to
  find nothing (§2), ON DECK has to be able to say why a seam is bare.
- **The detector question.** It becomes *more* load-bearing, because post is the only input and
  **444 of 444 songs have none**, with no usable proxy — `intro_end` is set on 3 of them and averages
  0.52 s, which is leading silence, not a vocal onset.

---

## 2 · When no cut in the pool is short enough

Your call. Four options, and what each costs:

| option | behaviour | cost |
|---|---|---|
| **A — nothing plays** | Clean segue, and the placement records why. | Silence where you expected imaging. **Recommended:** the entire point of the rule is not to talk over a vocal, and A is the only option that cannot. |
| **B — shortest cut plays anyway, ending at the post** | It must start before the rotate. | **Brings the two-sided trigger back**, which is the thing this model just deleted. |
| **C — shortest cut plays, starting at the rotate** | It runs past the post and over the vocal. | This is what the model exists to prevent. |
| **D — fall back to a station "short cuts" pool** | A second pool of very short IDs for tight intros. | A pool to curate, but it turns A's silence into a station ID. Sits on top of A rather than replacing it. |

**Recommended: A now, D later if the silence bothers you.** With A, ON DECK reads *"no cut short enough
(intro 3.2 s, shortest in pool 4.1 s)"* — which is a shopping list, not an error.

### How often would A fire, on your library?

Cut lengths, all 64:

```
 1s  ██ 2          6s  ███████ 7         11s  █ 1
 2s  █████████ 9   7s  █████ 5           12s  ██ 2
 3s  █ 1          8s  █████ 5           13s  █ 1
 4s  ████ 4       9s  ██ 2              19s  █ 1
 5s  ██████████████████████ 22   10s  █ 1     44s  █ 1
```

- **38 of 64 are ≤ 5 s.** A song with a 6 s intro has plenty of choice.
- **11 of 64 are ≤ 2 s.** A 3 s intro is thin but workable.
- **A 2 s intro has 2 candidates.** That is where A starts firing.
- **The 44.8 s cut can never qualify** for any realistic intro, and the 19 s one almost never.

I cannot tell you the *rate* until posts exist — that needs `post_ms` on the songs that actually air.
Once even 30 are marked I can give you the real number.

---

## 3 · A song with no post

**Today that is 444 of 444, so this is not an edge case — it is the starting state**, and it decides
whether turning the feature on silences your imaging.

| option | behaviour |
|---|---|
| **A — no imaging on that seam** | Correct and safe, but with nothing marked it means **no imaging at all** until you have marked your way through the library. |
| **B — fall back to today's fixed LEAD** | The seam behaves exactly as it does now. Imaging keeps firing; songs you have marked get the better treatment; songs you have not are unchanged. **Recommended.** |

B makes the marking pass **incremental and rewarding** rather than a gate: every song you mark improves
that song and nothing regresses. The placement records `chain_type_effective='lead'` so ON DECK can say
*"fixed lead (no post on this song)"* — the §2.4 rule, unchanged.

---

## 4 · Does this change the pool design?

**Yes, and the histogram above is the brief.** The pool stops being "cuts that sound right" and becomes
"cuts that sound right, spread across lengths". Two concrete consequences:

1. **The bottom of the range is thin.** 2 cuts at 1 s, 9 at 2 s. Every song with a short intro draws
   from those 11, so they will burn out fast and be recognisable.
2. **Two cuts are dead weight** for this rule — 19 s and 44.8 s qualify only for a song with an intro
   longer than that, which is not radio. They stay useful for other things; they will never be picked
   by AUTO-POST.

The real answer needs both distributions overlaid, and **I can give you that the moment posts exist** —
"for each song, how many of the 64 qualify" is one query. Marking 30 songs is enough to make it
meaningful.

---

## 5 · Trimmed length or file length?

**Today neither: nothing measures length at all, and playout ignores every cue column.** So this is a
free choice, and it should be **trimmed**.

**The arithmetic that needs no engine change.** Because the engine plays from sample 0, the useful
number is not the trimmed *length* but the **audible END measured from file start** — `outro_start`,
or `cue_out` when the operator has set one:

```
qualifies when   cue_out <= post
fire when        P >= post − cue_out
```

The cut's audible content then ends exactly at the post, and any leading silence simply plays silently
inside the intro. **No seek, no engine change, no new bench.** That is worth protecting.

Measured, this matters less than expected on your current library: **the 64 cuts have an average of
0.00 s and a maximum of 0.02 s of trailing dead air.** Your imported cuts are already tight. It will
matter for cuts you produce yourself, which is exactly the case the handles are for.

**Where a START handle would pay off, honestly:** only if the engine SEEKS to it. Without a seek,
trimming the head changes nothing about qualification — the audible end is where it always was. With a
seek, a cut with 3 s of leading silence becomes 3 s shorter and qualifies for shorter intros. The seek
itself is small — one `skip_duration` combinator on the decoder chain — but it is an audio-path change
in three places and I have **not established which of the three is the live deck path**, so I will not
price it as trivial.

---

## 6 · The editor — one component, two handles on a cut, one marker on a song

Agreed, and it is a small change to what shipped in 4.6.17.

**Which columns the handles write: `cue_in` and `cue_out`.** They already mean exactly "the operator's
playback window", they are empty on all 64, and nothing reads them — so writing them invents no
conflict. `intro_end` / `outro_start` stay what they are: the auto-detected silence boundaries, and the
handles **open on them** rather than at 0 and duration, so a cut starts pre-trimmed by the detector and
the operator only corrects it.

That gives the honest three-layer story the marks were designed for:

| layer | column | source |
|---|---|---|
| what the analyser heard | `intro_end` / `outro_start` | auto, already present on all 64 |
| what the jock decided | `cue_in` / `cue_out` | operator, stamped |
| what selection uses | `cue_out` if set, else `outro_start`, else duration | — |

**On a song: one marker, `post_ms`**, exactly as it works today.

Same component, same shared waveform (`audio/waveformPeaks`), same shared audition
(`audio/regionAudition`), same 3-seconds-before preroll. The only difference is one handle or two.

`dry_ms` stops being offered. **The columns stay** — removing them costs a migration to undo a
migration, and they are six nullable columns nothing reads. They are simply no longer asked for.

---

## 7 · What this costs, in total

| | |
|---|---|
| **Delete** | the two-sided trigger; LINK-SONG; `dry_ms` marking; the `L − dry > post` warning |
| **Add** | a length filter in `resolvePool`; `chain_type` + `chain_type_effective`; a second handle in the editor |
| **Unchanged** | `post_ms` and its 444-row marking pass; the detector question; ON DECK's fallback reporting |
| **Engine change** | **none required**, if selection and firing key on the audible end from file start |

The model is cheaper than the design it replaces, and the part it removes is the part I would have been
most likely to get wrong.

## 8 · What this document does not claim

The fire arithmetic in §5 is **designed, not measured** — no placement has been made under it. The
qualification rates in §2 are arithmetic on the cut histogram alone; the song side of that comparison
does not exist yet, because no song carries a post. Which of the three decoder sites is the live deck
path is **unverified**.
