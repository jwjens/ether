# A sweeper plays over the GC spot — diagnosis, 2026-09-14 (urgent, on air)

**Report (verbatim, Jeff, station 2 halloVeen):**
> "sweepers are being scheduled against the GC spot. They should only attach to songs in the HV
> category, per the Sweepers window."

**The report is correct.** A sweeper is audibly playing over the GC commercial. The mechanism is not
either of the two we suspected, and the fix is in a third place.

---

## 1. The GC spot's rows — correctly labelled

    spots #6  "GC Sponsorship EnglishVersion 15 Secs"  station=2  active=1  spot_category_id=3

    class    song_id   state      n     window
    SPOT     NULL      pending    447   2026-09-14 19:00 .. 2026-09-20 23:40
    SPOT     NULL      played      21   2026-09-14 11:00 .. 2026-09-14 18:40
    SPOT     NULL      missed       3

`content_class = 'SPOT'`, `song_id` NULL, on every row. **It is not landing as MUSIC**, and no `songs`
row shares its file path. The voice-track hypothesis — nothing sets `content_class`, so it defaults to
MUSIC — does **not** apply here; `generate-core.js:333/:423` set `'SPOT'` explicitly.

## 2. No sweeper is stamped at a spot's slot

    sweeper rows sharing a scheduled_at with a SPOT row (whole station log):  0

The earlier measurement (0 sweeper placements at a SPOT slot across 22,215 rows) still holds, and
`_placeJingles`'s `content_class === 'MUSIC' && song_id` filter is not being defeated. Every sweeper
row is paired with a MUSIC row at the identical `scheduled_at`, exactly as designed.

**That is why this looked fine and is not fine.** The two facts are compatible: the sweeper belongs to
the *song*, and it is heard over the *spot*.

## 3. What is actually happening — the LEAD reaches backwards

The log around an upcoming GC slot:

    6:59:25 PM  MUSIC  dur=229  cat=7  Oingo Boingo - Dead Man's Party
    7:00:00 PM  SPOT   dur=15   cat=-  GC Sponsorship EnglishVersion 15 Secs   <== the spot
    7:00:15 PM  SWP    dur=6           audiocoffee-halloween-impact 01   lead=2s
    7:00:15 PM  MUSIC  dur=109  cat=7  Remember Me (Ernesto de la Cruz)

The sweeper is stamped at **7:00:15**, the incoming song's slot — correct. But LEAD is *"how far
before the OUTGOING song ends the sweeper fires"* (`main.js`, above `SWEEPER_DEFAULT`), and the daemon
arms it against the **currently-playing deck** (`audiod/engine.js:2137 _armJingle` — *"ARMED … over
deck X seam"*), firing `lead` seconds before that element ends.

At that seam the outgoing element is **the GC spot**. So the sweeper fires at **7:00:13 — two seconds
before the commercial ends, over its tail.**

**Nothing anywhere checks what the outgoing element is.**

## 4. How often

    SPOT rows in the log (station 2, live):                4,223
    sweepers whose seam is the END of a spot:              4,223

Those two numbers are identical, and that is the finding: **every single spot in the log is followed
by a sweeper whose lead fires into its last 2 seconds.** Not most — all of them.

### The class census, which also settles the latent hazard

    class   rows     of which song_id IS NULL
    MUSIC   34,223   16
    SWP     28,397   0
    SPOT     4,223   4,223

The **16 MUSIC rows with a NULL song_id** are placed voice tracks — the mislabelling found earlier
today (`insertVoiceTrack` never sets `content_class`; the column defaults to MUSIC). They are real and
present in this log. They are **not** currently drawing sweepers, because `_placeJingles` also
requires `r.song_id`, and theirs is NULL. So the hazard is armed but not firing: it would bite the
moment such a row carried a song_id. That is worth fixing on its own terms, and it is still not the
cause of tonight's symptom.

## 5. The rule, as it actually stands

Jeff's statement of the rule is right and matches the code: a sweeper fires because the **incoming**
element's category has a pool assigned. Measured:

    categories with an overlay assignment (station 2):
      id=7  HV  HalloVeen   kind=pool  pool=3  lead=null

    overlay_fallback_category_id = 3  ("Halloween", type SWP)

Only HV carries an assignment, so the sweeper-bearing songs are HV songs — what the Sweepers window
says. (A count of 28,401 "uncategorised" sweeper-bearing rows in a first pass was an artifact of my
query joining sweeper rows to themselves — sweeper rows also carry a `song_id`. The real figure is
the 28,071 HV pairs. Not a finding.)

**Worth knowing separately:** the station fallback pool IS set. Today it is invisible because only HV
has music in the log, but it means "only HV gets sweepers" is not what is configured — any music
category with no assignment would also draw from pool 3.

## 6. Why the proposed rule change does not fix tonight

Jeff's correction — *"Gate on the category having a pool, not on the class"* — is **right, and it does
not address this symptom.** The incoming HV song's category genuinely has a pool; it is supposed to
get a sweeper. The defect is that the sweeper's lead plays over whatever precedes it, and nothing
constrains what that is.

The class-gate correction is still worth making, for the reason given: `(r.content_class || 'MUSIC')`
treats NULL as MUSIC, so any mislabelled row inherits imaging it was never assigned — which is exactly
what a placed voice track (`content_class` defaulting to MUSIC, `song_id` NULL) would do if it ever
carried a `song_id`. That is a real latent hazard. It is a **different** bug from this one and should
not be sold as the fix for it.

---

## Proposed — tonight

### A. No build, available right now: set the HV LEAD to 0

Sweepers panel → TIMING → LEAD for the HalloVeen category. `lead_in_sec = 0` is honoured
(`loggen.js:511` only defaults when the value is NULL, and `_armJingle` takes `min(0, ceiling)`), and
the sweeper then starts **at** the seam instead of 2s before it. The commercial finishes clean.

Cost, stated honestly: the sweeper also stops overlapping the outgoing *song*, which is the effect the
2s lead exists to create. It is a blunt instrument that works in minutes and needs no installer.

### B. The fix: refuse the seam when the outgoing element is not music

Two places, and I propose **both**, because they answer different questions:

1. **Air side — `audiod/engine.js`, the arm predicate.** Before arming, check what the outgoing deck
   is holding; if it is a SPOT (or any non-music class), do not arm, and log the refusal. This is the
   *guarantee*: it holds for hand-loads, live picks and anything Generate never saw, and it takes
   effect on the next full close-and-reopen without regenerating a single row. Refusing to arm is
   also the safe direction — it never yanks audio, it only declines to add some.

2. **Generate side — `_placeJingles` in `electron/main.js`.** Omit the placement when the row
   immediately preceding the seam is not music. This makes the *log tell the truth* — the operator can
   see there is no sweeper there — rather than the log promising one that air-time then refuses.

Both are the same predicate stated in two places, which is the shape the sweeper work already uses
(selection in the scheduler, refusal in the daemon).

### C. And the class-gate correction, separately

`_placeJingles` currently gates on `(r.content_class || 'MUSIC') === 'MUSIC' && r.song_id`. Change to:
the row's category resolves to an overlay assignment (or the station fallback), and drop the class
test. An element with no category, or a category with no overlay and no fallback, gets nothing
regardless of label.

**Conflict to resolve before building C:** the station fallback (`overlay_fallback_category_id = 3`
here) deliberately gives sweepers to music whose category has *no* assignment. "No category → no
sweeper" and "fallback pool" cannot both be absolute. My reading is that the fallback should apply
only to rows that are genuinely music by a trustworthy signal, which is precisely what the TYPE-column
model is for — so C should land with that model, not before it.

**NOT BUILT. Read-only investigation.**

---

# Built 2026-09-14 (v4.6.36) — clamped, not refused

Jeff approved "air-side arm refusal and generate-side omission". **Both landed as a LEAD CLAMP to 0
rather than a refusal**, and the reason is a prior ruling in the same function that a refusal would
have reversed.

## What changed the shape of the fix

`bd87a95` — *"a scheduled sweeper fires, and LEAD is the operator's number"* — **deleted** a guard that
suppressed the seam whenever the outgoing or incoming deck held a SPOT:

> an editorial judgement ("imaging doesn't belong next to a commercial") that silently dropped
> scheduled placements. Deleted. Whether a sweeper suits a seam is the operator's call; the only
> condition that may cancel one is preventing actual dead air.

Building a refusal would have re-introduced exactly that, three weeks after it was removed on purpose.

But two other things in the tree say the overlap itself is wrong:

- `_segueTick` already refuses it for music: *"CLEAN SPOT EDGES: a SPOT is exclusive PROGRAM content —
  never overlap the incoming over a spot's tail… The spot plays alone."*
- `docs/help-spots.md:78` has promised operators, in shipped help, *"clean start, clean end, no music
  overlap in or out **and no sweeper over it**"*.

So this was never an open question — it was **an unimplemented promise**. The sweeper path was the one
route that never honoured a rule the segue path and the help text both already stated.

**The clamp satisfies both.** The placement still fires (bd87a95 stands — nothing is dropped); its
lead is capped at 0 so it starts *at* the seam instead of over the commercial's tail.

## Air side — `audiod/engine.js`, `_armJingle`

    const outgoingIsSpot = this.deckContentClass[deck] === "SPOT";
    const ceiling = outgoingIsSpot ? 0 : this.effectiveLeadCeiling();
    const effective = Math.min(jin.leadInSec, ceiling);

Expressed as a **ceiling**, so it rides the clamp machinery already in that function — including its
standing rule that *"the engine never asserts a number it did not honour"*: the reduction is logged
and emitted as `sweeper-lead-clamped-spot`, never silently applied.

`deckContentClass` already existed and is maintained on every occupant change, so no new state.

This is the guarantee: it holds for hand-loads, live picks and any row Generate never saw, and it
takes effect on a full close-and-reopen without regenerating anything.

## Generate side — `electron/main.js`, `_placeJingles`

    const spotEndsAt = new Set();   // scheduled_at values where a SPOT ends
    ...
    lead_in_sec: spotEndsAt.has(incoming.scheduled_at) ? 0 : (leadOverride ?? def.lead)

This makes the **log tell the truth**. The operator reads `lead_in` in the calendar and should not
have to know air-time will disagree with it. The placement is not dropped here either.

## Receipts

`scripts/smoke-sweeper-clean-spot-edge.js`, 14 checks. Beyond the clamp itself it asserts the two
things most likely to be got wrong:

- **"the spot case does NOT return early — the placement still fires (bd87a95 stands)"** — a
  structural check that the clamp has not quietly become the refusal that was deleted.
- **"lead 2s over MUSIC is untouched"** and **"the arm-window ceiling still applies on a music seam"** —
  an over-broad clamp would flatten every sweeper on the station, which is a worse bug than the one
  being fixed and would be invisible in a test that only checked the spot case.

## No help change needed

`docs/help-spots.md` already describes this behaviour. It is now true.

## Noted, not touched

`audiod/smoke-topofhour.js` fails on this tree **and fails identically with these changes stashed** —
it is pre-existing and unrelated. Not investigated (out of scope tonight).
