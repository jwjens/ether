# Imaging as a first-class part of Ether — the Zetta model, designed

**Date:** 2026-09-06 · **Status:** DESIGN ONLY — nothing built. Jeff rules before any code.
**Framing (Jeff, 2026-09-06):** *"Imaging has been treated as an afterthought — a small section at the
bottom of the clock. It needs its own life in Ether, the way it has in Zetta."* The surface is designed
first; the mechanics hang off it.

---

## 0 · What the read established, with receipts

Five findings. The design rests on them, and two of them change the shape of the work.

### 0.1 · There is a governing design already, and it is gated

`docs/sweepers-rcs-model-design-2026-08-22.md` is binding and **DESIGN ONLY**. Its rulings of record:
two dedicated sweeper decks from the 12-slot pool; `SlotKind::Sweeper` so a sweeper structurally
cannot duck; **`chain_type` per element** as the RCS behaviour key; the rename last; and the
acceptance test *"a station sounds identical after the rename — only the word changed."*

**Its build is gated behind the aux/ducker slices.** Piece 3 below extends that doc's `chain_type`
rather than inventing a key — but it also means piece 3 either rides today's sweeper-channel path or
waits for that arc. **Flagged as a conflict for Jeff (§7), not resolved here.**

Part of it has already landed: `SlotKind::Sweeper` exists (`native/src/audio.rs:969`), and
`_sweeperChannels()` resolves the fire target from a slot table, which is why sweepers fire on
**Source E** today rather than CART.

### 0.2 · The intro columns exist — and they mean something else

`songs` and `library_asset` both carry `cue_in`, `cue_out`, `cue_in_ms`, `cue_out_ms`, `intro_end`,
`outro_start`, `intro_end_ms`, `outro_start_ms`, `has_intro`, `intro_version_path`. All are already
`PATCHABLE` and in the INSERT (`electron/sync/handlers/songs.js:19,68`), so they sync.

**`intro_end` is not a post.** `src/audio/songAnalysis.ts:41` defines it as *"seconds — where music
starts"*, computed by Rust **silence analysis**. The live values say the same thing:

| song | duration | `intro_end` | `outro_start` |
|---|---|---|---|
| Don't Stop Me Now | 209s | **0.2** | 209.43 |
| test track | 201s | **1.33** | 201.17 |
| a 5s sweeper | 5s | **0.12** | 5.18 |

Those are leading- and trailing-silence boundaries, not musical marks. **Any design that "just uses
`intro_end`" is wrong.**

### 0.3 · Coverage on halloVeen, measured 2026-09-06

| content_class | rows | `intro_end` | `intro_end_ms` | `cue_in_ms` | `has_intro` |
|---|---|---|---|---|---|
| MUSIC | 444 | **3** | 0 | 0 | 0 |
| SWP | 64 | **64** | 0 | 0 | 0 |
| SPOT | 2 | 1 | 0 | 0 | 0 |
| **total** | **510** | 68 | **0** | **0** | **0** |

So the `_ms` family and the cue family are **completely unwritten** — free space. And even the
silence-trim `intro_end` is absent on 441 of 444 music rows on this station. (An older audit,
`docs/library-columns-metadata-audit-2026-07-24.md`, reports 462/530 on station 4 — a different
profile with a different import history. Coverage is per-install, not universal.)

### 0.4 · `introEnd` is plumbed but not consumed

`audiod/loggen.js:161,169,237,257,347,523` SELECT `intro_end`/`outro_start` and put `introEnd` /
`outroStart` on every queue item. **`audiod/engine.js` never reads either.** (The 2026-07-24 audit
lists them as WIRED to "live daemon crossfade"; that was true of the legacy in-renderer engine
`src/audio/loggen.ts`, not the daemon that airs today.) So the transport for a mark already exists
from the DB to the engine — only the consumer is missing.

### 0.5 · The seam is not honest yet

`audiod/engine.js:886,899-901` force-stops the outgoing deck `crossfadeDuration*1000 + 500` = 3500 ms
after a rotate, regardless of audio remaining. With segueOverlap = 5 that truncates every song by
**1.5 s**. Every arithmetic in piece 3 anchors on "when the incoming song starts" and "when the
outgoing ends"; **neither is trustworthy until that is fixed.** See §7, slice 0.

---

## 1 · PIECE 5 FIRST — the Imaging surface

Today imaging has one door: a push-up at the bottom bar. That is a room, not a home — and by the
doors-before-rooms rule a feature its owner can't find is a defect. Zetta gives imaging a peer-level
place; Ether should too.

### 1.1 · The shape

**IMAGING becomes a top-level destination in the hamburger**, beside Library and Clocks — not a tab
under something else. Inside it, five views. Each is a place, not a modal.

```
IMAGING
 ├─ RACK        every imaging asset · audition · MARK (dry length) · run dates · hours · type
 ├─ POOLS       grouping + rotation + burnout · pool-level constraints
 ├─ ASSIGNMENTS category → pool or item · chain type · active hours   (today's SweepersPanel grid)
 ├─ ON DECK     what fires ahead of you, in log order · change or kill one placement
 └─ RULES       segue bans — where a produced cut may not go
```

- **RACK** is the browse-and-mark surface. One row per imaging asset from `library_asset`
  (type SWEEPER / ANNOUNCEMENT / and later PROMO / BED / ID), with waveform, audition, the dry-length
  mark, total length, run dates, hour mask, and pool membership. **This is where piece 2 lives.**
- **POOLS** is today's pool list, promoted: rotation, burnout, and the pool-level constraints piece 4
  needs.
- **ASSIGNMENTS** is today's category grid — CATEGORY · OVERLAY · LEAD, gaining CHAIN TYPE.
- **ON DECK** is the jock's view: the imaging that will fire, per upcoming song, with the specific cut
  named. It is also where a placement is swapped or killed for one seam.
- **RULES** is a short, readable list of bans — not a rules engine.

### 1.2 · Why a home rather than a tab

Three of the five views do not exist anywhere today (RACK's marking, ON DECK, RULES), and the two that
do are buried behind a push-up. Adding three more tabs to a push-up would repeat the failure the
doors-before-rooms rule names. Imaging also acquires its own vocabulary — post, dry, chain type,
ban — which needs somewhere to be taught; the help entry (`docs/help-imaging.md`) hangs off this
surface, and the push-up becomes a shortcut INTO it rather than the thing itself.

**What breaks:** nothing functional. The push-up stays as a door. `SweepersPanel.tsx` is lifted, not
rewritten — ASSIGNMENTS is that component. The one real cost is the hamburger gaining an entry and
the panel router gaining a route.

**By hand:** Jeff decides whether "IMAGING" or "SWEEPERS" is the door's label. The RCS doc rules that
the *element* is a sweeper; the *surface* covering sweepers, IDs, promos and beds is imaging.

---

## 2 · PIECE 1 — intro marks on songs (the post)

### 2.1 · Where it is stored

**A new column, `post_ms INTEGER` on `songs` and on `library_asset`.** Not `intro_end_ms`.

The minimal move would be to reuse `intro_end_ms`, which is empty on every row. It is rejected: it
would leave `intro_end` (silence boundary, in seconds) and `intro_end_ms` (the post, in milliseconds)
differing by a suffix and meaning entirely different things. That trap already cost a wrong
measurement in the session that produced this document. **One column, one meaning, an unambiguous
name.** `intro_end` keeps its silence-trim meaning and its existing readers, untouched.

Alongside it, two small companions:

| column | type | meaning |
|---|---|---|
| `post_ms` | INTEGER, nullable | milliseconds from file start to where the vocal begins |
| `post_source` | TEXT, nullable | `'auto'` \| `'operator'` — who set it |
| `post_confirmed_at` | TEXT, nullable | when a human last agreed with it |

`post_source` is the honesty mechanism: **an auto value is a candidate, never a fact.** AUTO-POST may
be offered against an unconfirmed post, but the surface says so, and the ban rules (§5) can require a
confirmed post for produced imaging.

**Migration:** one schema version (v55), `ALTER TABLE ADD COLUMN` ×3 on two tables — the additive
pattern that cannot strand an older build. Plus `PATCHABLE` and the INSERT in
`electron/sync/handlers/songs.js` (and the `library_asset` handler), and `synced-tables.js` scalars so
the marks travel with the account. A mark is a programming decision about a record; it belongs to the
account, not the machine.

### 2.2 · How it is set

**Two paths, and the auto one never wins silently.**

1. **Auto-detected on import — BUT THE DETECTOR IS GATED (Jeff, 2026-09-06).** The analysis pass
   already runs per file (`src/audio/songAnalysis.ts:107-112`, which writes `intro_end`/`outro_start`
   today). Vocal onset is a harder problem than silence detection, and it produces a *candidate*: the
   first sustained rise in the vocal band after `intro_end`, stamped `post_source='auto'`.

   > **Do not build the Rust detector until Jeff has heard it.** His ruling: prove the candidate on
   > **20 songs** and let him check them against his ear. *"If it's not good, I'd rather mark by hand
   > most-scheduled-first than correct 444 bad guesses."*

   So slice 2 opens with a throwaway proof — 20 candidates, audible, no schema and no Rust shipped —
   and the detector is built only if it survives that. If it does not, §2.3's backfill becomes the
   by-hand pass alone, ordered most-scheduled-first.
2. **Editable by ear, in RACK.** The region engine already exists — `src/audio/silenceRegions.ts` plus
   the Reel Splitter's region/audition mechanics — and CLAUDE.md rules it is **shared, never copied**.
   RACK gets a waveform with one draggable marker and a "play from 3s before the post" audition
   button. Setting it stamps `post_source='operator'` and `post_confirmed_at`.

### 2.3 · What the backfill costs

444 music rows on halloVeen.

- **The auto pass is cheap and unattended.** It is the existing per-file analysis over 444 files. I
  have **not measured** its per-file cost on this library and will not invent one; the measurement is
  a single timed run over 20 files, which I can do on request.
- **The confirmation pass is the real cost, and it is Jeff's time.** At 20–30 seconds per song to
  audition and nudge a marker, 444 songs is **roughly 2.5 to 3.5 hours** of listening. That is the
  honest number.
- **It does not have to be done at once.** Nothing breaks with a null post (§2.4), and RACK can sort
  by "no post, most-scheduled first" so the songs that actually air get marked first. The 30 songs
  that carry the station are an evening; the tail can wait forever.

### 2.4 · A song with no post

**AUTO-POST is unavailable for that song, and nothing guesses.**

The placement falls back in a stated order: `auto_post` → `link_song` → `segue`, taking the first the
song's marks support. The fallback is **recorded on the placement row** (`chain_type_effective`) so
ON DECK can show "LINK-SONG (no post on this song)" rather than silently doing something else. A
guessed post would put a voice over a vocal — the exact failure the mark exists to prevent.

---

## 3 · PIECE 2 — dry length on sweepers

### 3.1 · Where it is stored

**`dry_ms INTEGER` on `library_asset` and on `songs`**, with `dry_source` / `dry_confirmed_at`
mirroring §2.1. Both tables because a sweeper is a `songs` row (`content_class='SWP'`) joined by uuid
to a `library_asset` row (`type='SWEEPER'`), and `_placeJingles` reads `songs` while RACK reads
`library_asset` — the same duplication the existing cue columns already have.

Same v55 migration, same sync treatment.

### 3.2 · How it is set

Same two paths as the post, and the detector is the same one: **dry length is the vocal onset of the
sweeper**, measured from its own start. A cut with no voice at all (a stinger, a transition) has
`dry_ms = duration` — fully dry, which is meaningful, not missing.

RACK is the primary place: 64 items is an afternoon, not a project.

### 3.3 · The 64 already in the library

All 64 already carry `intro_end` (silence trim), so their audio start is known — the marker starts
there rather than at zero. At ~15 seconds each to audition and mark, **64 sweepers is about 20
minutes** of Jeff's time. This is the cheapest of the four pieces and the one that unlocks LINK-SONG.

### 3.4 · A sweeper with no dry length

**LINK-SONG is unavailable for that cut.** AUTO-POST still works — it needs only the sweeper's total
length and the song's post. SEGUE always works. Same recorded-fallback rule as §2.4.

---

## 4 · PIECE 3 — chain types, replacing the fixed LEAD

### 4.1 · The column

`generated_schedule.chain_type`, from the RCS design doc — **not a new key.** Today the queue carries
`chainType: 'segue' | 'stop'` (`deckChainType`, `engine-rodio.ts:98`). The vocabulary extends:

| value | meaning |
|---|---|
| `auto_post` | the sweeper ENDS exactly at the incoming song's post |
| `link_song` | the sweeper's dry portion lies across the song's intro |
| `segue` | no imaging on this seam, clean |
| `stop` | (existing) dry drop, clean edges both sides — the RCS doc's Behaviour B |

Set per element: a default per category in ASSIGNMENTS, written onto each placement at Generate,
overridable per placement in ON DECK. **`lead_in_sec` does not go away** — it stays as the explicit
number for the seams that want one, and becomes the fallback when a chain type's marks are missing.

### 4.2 · The arithmetic

Everything is expressed against one anchor: **`T_in`, the moment the incoming song actually starts.**
Today that is when the outgoing has `segueOverlap` seconds remaining (`_segueTick:2080`). The engine
knows this live from deck position; **it is never read from `scheduled_at`** — a plan is not a clock,
measured 2026-09-06 at only ~10% of plays landing within 1s of schedule.

Let `L` = sweeper length, `post` = incoming song's `post_ms`/1000, `dry` = sweeper's `dry_ms`/1000,
`R` = the outgoing deck's remaining seconds, `P` = the incoming deck's position.

**AUTO-POST — the sweeper ends at the post.** Fire at `T_in + post − L`.

Two cases, and this is the real engineering:

- `L > post` → the fire point is **before** the rotate. Trigger off the outgoing:
  **fire when `R <= segueOverlap + L − post`.**
- `L <= post` → the fire point is **after** the rotate, inside the song's intro. Trigger off the
  incoming: **fire when `P >= post − L`.**

So AUTO-POST needs a **two-sided trigger** — one arm reading the outgoing's remaining, one reading the
incoming's position, both live deck readings. Whichever side the fire point falls on, the other arm
never fires. This is new work in `_jingleTick` and it is the only genuinely hard part of piece 3.

**LINK-SONG — the sweeper's VOICE starts when the song starts.** Fire at `T_in − dry`, i.e.
**fire when `R <= segueOverlap + dry`** — the sweeper's dry ramp runs over the **outgoing** song's
tail, and its voice enters exactly as the new record begins, riding that record's dry intro.

**RULED 2026-09-06 (Jeff), option B**, correcting an earlier reading in this document:

> *"The sweeper's VOICE starts when the song starts; its dry ramp runs over the outgoing song's tail.
> That matches what I described — 3:34 song, sweeper fires at 3:31, over the tail and into the head —
> and it puts the sweeper's voice on the song's dry intro, which is the same space the segue bans are
> protecting for the jock."*
>
> *"Ignore my earlier 'dry portion ends when the vocal starts' — that was wrong and would put the
> sweeper's voice on the vocal."*

A warning, not a refusal, when the sweeper's voice would outlast the post — i.e. `L − dry > post`.
Surface it in ASSIGNMENTS and ON DECK; never block.

**SEGUE — no imaging.** A placement rule, not a fire rule: `_placeJingles` places nothing.

**STOP** — unchanged from the RCS doc: clean edges, generalising the existing `'SPOT'` branch.

### 4.3 · What changes, what breaks

| | |
|---|---|
| DB | `generated_schedule.chain_type` + `chain_type_effective`; `categories.overlay_chain_type` |
| `electron/main.js` | `_placeJingles` writes the chain type and the effective fallback |
| `audiod/loggen.js` | `readJingleForSeam` returns `chain_type`, `post`, `dry` (join the incoming song) |
| `audiod/engine.js` | `_jingleTick`'s single `remaining <= leadIn` becomes a per-chain-type two-sided trigger |
| Renderer | ASSIGNMENTS gains a chain-type column; ON DECK shows the effective type |

**What breaks:** the fire point moves for every seam that gets a chain type. Rows with no chain type
keep today's `lead_in_sec` behaviour exactly, so **the change is opt-in per category** and a station
that sets nothing sounds identical — the RCS doc's acceptance test, applied here.

**By hand:** Jeff sets a chain type per category, and rules on the LINK-SONG anchor above.

---

## 5 · PIECE 4 — segue bans

### 5.1 · Where the rule lives

**At placement, in `_placeJingles` — never at fire.** A ban is a scheduling decision: it must be
visible in the log before air, and a jock must be able to see that a seam was deliberately left open.
A fire-time ban would be an engine deciding what is appropriate, which is the rule this whole arc has
been removing.

### 5.2 · What it matches on

**Pool-level constraints plus a station default — not a rules engine.** Pools already exist and are
the natural grouping: a pool of fully-produced sweepers is exactly the set that must not land in a
short intro.

| attribute | on | used for |
|---|---|---|
| `min_post_sec` | pool | don't place this pool's cuts against a song whose post is shorter |
| `requires_confirmed_post` | pool | don't place produced imaging against an auto-guessed post |
| `max_length_vs_post` | pool | don't place a cut longer than N× the post |
| `talk_over_reserved` | category | this category's intros belong to the jock — imaging never |
| `dry_ms` / `post_ms` | asset / song | the measured inputs |

A cut is "fully produced" when `dry_ms < duration` — it has voice. That is measured, not tagged.

RULES renders these as sentences: *"Produced IDs are not placed against songs with an intro under 8
seconds."* When a ban suppresses a placement, `_placeJingles` records the reason on the seam so ON
DECK can say **why** the seam is empty — silence that is explained is a programming choice; silence
that is unexplained is the bug this arc started with.

**What breaks:** fewer placements. That is the point, and the count must be visible: the Generate
report should say how many placements a ban suppressed, or bans will quietly eat the imaging.

**By hand:** Jeff sets `min_post_sec` per pool and marks which categories are his to talk over.

---

## 6 · Order

Each slice is useful alone and none depends on a later one.

| # | Slice | Depends on | Why here |
|---|---|---|---|
| **0** | **Seam truth: the timed force-stop becomes conditional** | — | Every arithmetic in piece 3 anchors on the outgoing's real end and the incoming's real start. Today the outgoing is killed 1.5 s early. **Nothing else is worth building on a seam that lies.** |
| **1** | **The IMAGING surface, read-only** — RACK, POOLS, ASSIGNMENTS lifted, ON DECK showing what is placed | 0 for ON DECK's honesty | Doors before rooms. It ships value on day one: the jock can finally see what fires ahead. No engine change at all. |
| **2** | **Marks** — `post_ms` / `dry_ms` + the by-ear editor in RACK + the auto candidate + the 64-sweeper pass | 1 (the editor needs a home) | 20 minutes of marking unlocks LINK-SONG. Nothing consumes the marks yet, so this cannot change how anything sounds. |
| **3** | **Chain types** — the two-sided trigger | 0, 2 | The real engineering. Opt-in per category; unset = today's behaviour. |
| **4** | **Bans** | 2, and 1 for RULES | Needs marks to match on and a surface to explain itself in. |
| **5** | **Overrides in ON DECK** — swap or kill one placement | 1 | Designed separately; the durable-override question is open (a delete does not survive Generate today). |

**Slice 2 is the best value per hour of Jeff's time** — 64 sweepers, one afternoon, and the marks are
permanent. **Slice 0 is the one that must go first regardless.**

---

## 7 · Rulings, 2026-09-06

All five settled by Jeff. Recorded here as the record.

1. **The gate is lifted — verified in the record, not taken on trust.** The aux/ducker arc is in HEAD:
   `0baf168` slice 3a the ducker, `e72b050` slice 3b the duck toggle, `6852077` the receiver side,
   `66a39f3` slice 4 announcements reach air, `4e7425e` slice 5 scheduled announcements,
   `058ccde` aux monitors per deck. The sweeper re-route itself shipped 2026-09-03 as `c1d2a30`
   ("a sweeper joins the programme with the music, at whatever address you dial") — `SlotKind::Cart`
   became `SlotKind::Sweeper`, set at runtime from `deck_configs`, summed into core, unable to arm the
   ducker. **Proceed.**

   **What is genuinely still unbuilt from that doc, named:**
   - **Two sweeper decks.** Ruling 1 of the RCS doc was TWO, so one preloads while another weaves.
     Station 2 has exactly **one** — `deck_configs` slot E, kind `jingle`. Back-to-back seams on a
     tight clock can still starve, and AUTO-POST with a long cut makes that likelier.
   - **`chain_type` does not exist on `generated_schedule`** — only `content_class`. The RCS doc's
     per-element behaviour key is unbuilt at the DB level. Piece 3 adds it.
   - **The dry / clean-edge behaviour (RCS S3)**, which depends on that column.
   - **The rename (RCS S5).** `jingle_categories` and `jingle_category_id` are still live (6 refs in
     `synced-tables.js`, 3 in `loggen.js`), and the slot kind is still the string `'jingle'`.
2. **LINK-SONG: option B** — the sweeper's voice starts when the song starts, dry over the outgoing's
   tail. §4.2 corrected.
3. **`post_ms`, a new column.** *"intro_end already means silence trim and I won't have two columns a
   suffix apart meaning different things."*
4. **`segueOverlap` becomes a station setting, stored with the station, in slice 0.**
5. **The door is IMAGING.**

Order confirmed: 0 seam truth · 1 surface read-only · 2 marks · 3 chain types · 4 bans · 5 overrides.
Slice 0 ships on its own, before any of the redesign.

---

## 8 · What this document does not claim

§0.2–§0.4 are measured against the live halloVeen DB and read from source, with the queries and
`file:line` shown. **Everything from §1 onward is a proposal.** No code has been written, no schema
changed, and no runtime behaviour of any proposed slice has been observed. The per-file cost of the
auto-detect backfill (§2.3) is explicitly **unmeasured**; the confirmation-pass estimate is arithmetic
on a listening rate, not a measurement.
