# Library normalization — what it already does, and the one decision left

**Date:** 2026-09-06 · **Status:** READ-ONLY INVESTIGATION + PROPOSAL. Nothing built, nothing written to
any database.

**Asked for:** what normalization measures, whether it writes `gain_db` or touches files (it must not
touch files), what a 479-file pass costs, what happens to a song with no measurement, and — before
agreeing to change the level of every song on the station — **what the library actually sounds like
after, and whether quiet tracks get pushed up and by how much.**

---

## 0 · The finding that reframes the question

**The library is already normalized, and it is already at −14 LUFS.**

`lufs_measured` is each file's own loudness. `gain_db` is the trim the engine applies to that deck. Across
all 443 music rows on halloVeen that carry a measurement:

```
lufs_measured + gain_db     p05 = -14.0     median = -14.0     p95 = -14.0
```

Not approximately. Every row. The same holds for the 64 sweepers and the 2 spots — every content class is
normalized to −14.

**So the proposal is not "should we normalize".** It is: **is −14 the right target**, given what happens
when two songs at that target play together across a seam.

This corrects `docs/audio-processing-controls-2026-09-06.md` §10, which said the files were "around −6 to
−8 LUFS" and that the real fix was normalization. The **files** are −6 to −8; what reaches the bus is −14.
The correction is recorded there too.

## 1 · What it measures, and when

`src/audio/songAnalysis.ts` runs a full analysis per file at import (`:107-112`) via the Rust engine:

- **EBU R128 integrated loudness** → `songs.lufs_measured` (a real K-weighted measurement, not RMS)
- **True peak** → `songs.peak_db`
- **The applied trim** → `songs.gain_db`
- Plus BPM, energy, and the silence-based cue points (`intro_end` / `outro_start`)
- `is_processed = 1` marks the row as analysed

`gain_db` is simply `target − lufs_measured`, which is why the sum is exactly −14 everywhere.

## 2 · It writes `gain_db`. It does not touch files. It must stay that way.

The audio file is **never** rewritten. The trim is applied at mix time, per deck, per buffer
(`native/src/audio.rs:2192-2194`):

```rust
let trim = if deck.gain_db != 0.0 { 10f32.powf(deck.gain_db / 20.0).clamp(0.1, 4.0) } else { 1.0 };
let vol  = if deck.muted { 0.0 } else { deck.volume * trim };
```

This is the right architecture and it should be defended:

- **Reversible.** A target change is a number change. Nothing is destroyed, nothing needs re-encoding.
- **Lossless.** No re-encode means no generation loss on an MP3.
- **The file stays the file.** The catalogue on disk is the operator's, byte-for-byte.
- The `.clamp(0.1, 4.0)` bounds the trim to −20 … +12 dB, so a corrupt measurement cannot produce silence
  or a 40 dB boost.

**Any future normalization work writes `songs.gain_db` and nothing else.**

## 3 · What a pass costs — and why a target change costs nothing

Two very different operations get called "a normalization pass":

**(a) Re-measuring** — decode every file and run R128. That is the expensive one, and **it has already
been done**: 509 of 510 rows carry `lufs_measured`, `gain_db`, `peak_db` and `is_processed = 1`. There is
nothing to re-measure.

**(b) Changing the target** — `gain_db = new_target − lufs_measured`. That is **pure arithmetic on values
already stored**. No decode, no file read, no audio work at all. For 443 music rows it is a single UPDATE
over rows the DB already holds — well under a second.

**So changing the station's normalization target is not a 479-file pass. It is a column update.** The only
cost is that it must go through the sanctioned writer so it syncs, and that new imports must use the same
target (one place: the value `songAnalysis` normalizes to).

## 4 · A song with no measurement

**There is exactly one on halloVeen:**

```
id=647  [MUSIC]  "Don't Stop Me Now - Remastered 2011"   is_processed = null
```

What happens to it today: `gain_db` is NULL → Rust sees `0.0` → `trim = 1.0` → **it plays at the file's raw
level.** Its `intro_end` of 0.2 s says it was partially analysed and the loudness stage did not complete.
With the rest of the catalogue trimmed by a median of −6 dB, an untrimmed hot master is **roughly 6 dB
louder than everything around it** — one song that jumps out of the rotation.

That is the correct design decision (never invent a measurement) with a missing sense: nothing tells the
operator it happened. **Proposed:** the Library shows an "unmeasured" state on such rows, and re-running
analysis for one file is a right-click away. The behaviour — no measurement, no trim — stays.

## 5 · What the library sounds like now, and what changes

### Today, at −14

```
MUSIC lufs_measured (the files)     min -17.3   p05 -12.6   median -8.0   p95 -5.9   max -5.0
post-trim peak per deck             min -11.0   p05  -8.3   median -6.2   p95 -2.5   max +0.6
```

**Quiet tracks pushed up: 27 rows have a positive `gain_db`, and the largest boost in the entire library
is +3.3 dB** ("Do You Want to Build a Snowman?", −17.3 LUFS). Most of the boosted rows are Christmas
sweeper effects at +0.1 to +2.0 dB. There is no track being hauled up 10 dB, and no noise-floor problem at
+3.3 dB.

Everything else comes **down** — a median of −6 dB.

### The seam arithmetic, which is the whole reason this came up

Two decks each at −14 LUFS, median post-trim peak −6.2 dBFS:

| | |
|---|---|
| programme during a two-song overlap | ≈ **−11 LUFS** — about **+3 LU** above the ride's target |
| two peaks summing, incoherent (typical) | ≈ −3.2 dBFS |
| two peaks summing, coherent (worst case) | ≈ **−0.2 dBFS** — over the −1 dBTP ceiling |

So at a seam the ride walks down about 3 dB (≈2 s at 1.5 dB/s), holds, then walks back up over the head of
the incoming song; and the limiter catches transients where two post-trim peaks line up. That is the
mechanism, and it is proportionate to what was heard.

### If the target moved to −18

Everything moves down 4 dB. Nothing gets pushed up — at −18, **zero** songs have a positive trim.

| | at −14 (today) | at −18 |
|---|---|---|
| programme, one song | −14 LUFS | −18 LUFS |
| programme, two-song overlap | ≈ −11 LUFS (**+3 over target**) | ≈ −15 LUFS (**3 under target**) |
| ride behaviour at a seam | walks down ~3 dB, then back up | **barely moves** |
| median post-trim peak | −6.2 dBFS | −10.2 dBFS |
| two peaks, coherent worst case | −0.2 dBFS (limiter engages) | −4.2 dBFS (**clears the ceiling**) |
| largest boost anywhere | +3.3 dB | none |

**The overlap stops provoking the processor.** The cost is 4 dB of programme level — which, on
single-song passages, the ride will try to make back by boosting toward its own target unless the target
moves with it. That is the trade, stated plainly:

- **Keep target and ride target aligned at −18** → quieter station, clean seams, ride mostly idle. Listeners
  on a streaming platform that normalizes anyway hear no difference; listeners comparing you to a −14
  station hear you as quieter.
- **Normalize to −18 but leave the ride at −14** → the ride boosts single songs 4 dB back up, and the seam
  lands at −15, near target. Best of both, at the cost of the ride constantly working — and a ride that is
  always moving is a ride you will hear.

**Recommendation: normalize to −18 and set the ride target to −16.** Single songs sit 2 dB under the ride,
so it does gentle upward work; a two-song overlap lands at −15, which is *above* −16 by 1 dB instead of 3 —
inside the noise of the ride's own step size, so a seam stops being an event. I have not heard this; it is
arithmetic, and it needs your ears before it is anything else.

## 6 · What I would build, if you want it

Small, and separable from the processor-controls work:

1. **Surface the target.** A station setting, `normalization_target_lufs`, in `station_config_kv`, synced —
   showing **−14** as the current value, because that is what every row is normalized to today. No hidden
   default; the number that shaped the whole library becomes visible for the first time.
2. **Re-trim on change.** Changing it recomputes `gain_db = target − lufs_measured` for every measured row
   through the sanctioned writer. Arithmetic only. Reversible by setting it back.
3. **Use it on import**, so new files land at the station's target rather than a constant.
4. **Show unmeasured rows** (§4) and let one be re-analysed from the Library.

**What must not happen:** no file is ever rewritten, and no row with a NULL measurement is given an
invented `gain_db`.

## 7 · The honest bottom line

You asked whether quiet tracks get pushed up and by how much before agreeing to change the level of every
song. The answer is that **the level of every song has already been changed** — at import, to −14, by a
constant nobody surfaced. The largest upward move in the library is +3.3 dB and the median move is −6 dB.

The decision in front of you is not whether to normalize. It is **what target**, and whether you want the
number visible. My recommendation is to make it visible first (step 1, which changes no sound at all) and
decide the target separately, with your ears, once the processor controls let you A/B it.

---

## What this document does not claim

Everything in §0–§5 is measured from the live halloVeen database and read from source with `file:line`. The
−18/−16 recommendation in §5 is **arithmetic, not a listening test** — no build exists that does it, and no
one has heard it. The claim that a target change costs no decode is read from the schema and the
`gain_db = target − lufs_measured` identity holding across all 443 rows; it has not been executed.
