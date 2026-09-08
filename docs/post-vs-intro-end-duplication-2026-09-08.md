# post_ms is INTRO END · the marking model already existed
2026-09-08 · read-only · **nothing deleted yet**

---

## 1 · There are THREE fields claiming the front of a song, and two of them are mine

| column | units | written by | read by | rows set (444 MUSIC) |
|---|---|---|---|---|
| `intro_end` | **seconds** | the ANALYSER — first sustained audio, i.e. the silence boundary | nothing acts on it | **3** |
| `intro_end_ms` | **milliseconds** | the **CUE EDITOR** — the operator's INTRO END marker | nothing acts on it | **0** |
| `post_ms` | milliseconds | the RACK editor I built in slice 2 | `_placeJingles` (AUTO-POST) | **0** |

**`intro_end_ms` is the cue editor's INTRO END, and it is exactly what `post_ms` was created to be:**
an operator-set mark, in milliseconds, never auto-filled, consumed by nothing until now.

`post_ms` is a duplicate of a field that already had a mature editor.

### Your Beach Boys observation is not silence detection

`CueEditor.tsx:83` loads `row.intro_end_ms || 0`, and `:106-107` auto-fills **only** CUE IN and CUE
OUT from analysis — **INTRO END is never auto-filled.** It reads 0:00.0 on that track because
`intro_end_ms` has never been written for it. The analyser's silence value lives in a *different
column* (`intro_end`, in seconds) that the cue editor does not read.

So INTRO END is not "silence detection giving the wrong answer". It is an empty field displaying zero,
and it already means the post. **Nothing needs fixing in the cue editor — not a fifth marker, not a
corrected INTRO END.** It has been right all along and unused.

Measured: `intro_end_ms` is set on **0 of 444** music rows and **0 of 64** cuts. There is no data to
migrate and nothing to reconcile.

## 2 · The same is true of the other two marks I proposed

The cue editor has four markers, and they are the whole model:

| cue editor | means | my duplicate |
|---|---|---|
| **CUE IN** | where playback starts — the head trim | (the START handle I proposed for RACK) |
| **INTRO END** | where the vocal begins — **the post** | `post_ms` |
| **OUTRO START** | where the outro begins — the last vocal | `end_post_ms` |
| **CUE OUT** | where playback ends — the tail trim | (the END handle I proposed for RACK) |

**All four already exist, in milliseconds, operator-set, with a waveform, zoom and Save.** Every column
slice 2 added is a second name for one of them.

`dry_ms` is the only one with no counterpart — and it was already dropped when the model became
selection-by-length.

## 3 · Recommendation

**AUTO-POST reads `intro_end_ms`.** One line in `_placeJingles`. You set the post in the cue editor you
already use, on the songs you already right-click.

- `post_ms` / `post_source` / `post_confirmed_at` — stop reading and writing them.
- `dry_ms` / `dry_source` / `dry_confirmed_at` — already unused.
- `end_post_ms` / `end_post_source` / `end_post_confirmed_at` — retire the name; **`outro_start_ms` is
  the outro mark**, and it is the same conclusion as the post one.
- **Leave the columns in place.** All nine are nullable and empty on every row, so there is nothing to
  lose; dropping them is a table rebuild on `songs`, which is more risk than nine dead columns are
  worth. If you want them gone it should be its own cleanup, not part of this.

### The one thing that is genuinely still wrong, and predates me

`intro_end` (seconds, analyser, silence) and `intro_end_ms` (milliseconds, operator, post) **differ by a
suffix and mean entirely different things** — the exact trap §2.1 of the redesign named when it
rejected reusing the field. That hazard is real and it is why `post_ms` was created. It is also
survivable: nothing acts on either column, and the cue editor only ever touches the `_ms` pair.

Renaming `intro_end` to something honest (`audio_start_sec`) would end it for good, but it is a
migration to fix a comment-level problem. **My recommendation: document it, do not churn it.** Your
call.

## 4 · What comes out of RACK

**Deleted:**

| | |
|---|---|
| `src/components/MarkEditor.tsx` | the whole component — the cue editor is the marking surface |
| RACK's `IMAGING CUTS / SONGS` toggle | RACK is imaging cuts only |
| RACK's songs query, the JS sort, the placement-count query | song timing does not live in the imaging window |
| the POST / DRY column and the `mark…` button | |
| `writeMark`, `rackMode`, `editing`, the mark fields on `RackRow` | |
| the marking paragraphs in `docs/help-imaging.md` | |

**Stays:**

| | |
|---|---|
| RACK: NAME · TYPE · LENGTH · POOLS, read-only, de-correlated, paged | the imaging cut list |
| POOLS, ASSIGNMENTS, ON DECK, RULES | unchanged |
| `src/audio/waveformPeaks.ts` | the lift out of ReelSplitter was right regardless — ReelSplitter imports it and that de-duplication survives |
| the v56 / v57 columns | empty, unread, cheaper to leave than to drop |
| AUTO-POST, its harness, the selection rule | unchanged except which column supplies the post |

**Net effect on the marking workflow: it gets shorter.** Right-click a song → Open in Cue Editor → drag
INTRO END → Save. The list ordered most-scheduled-first is the one thing RACK's songs mode gave you
that the cue editor does not — worth rebuilding **in the Library**, where songs live, if you want it.

## 5 · Why this was not caught

Three chances, all missed by me:

1. **The design doc said to build it** — *"RACK gets a waveform with one draggable marker"* — and I
   built to the doc without asking whether the app already had one. CLAUDE.md says never rebuild what
   exists and to search for prior implementations first. I searched for the *region engine* and reused
   it correctly; I never searched for an *editor*.
2. **`CueEditor.tsx` was in my own output.** The cue-column audit I ran two exchanges ago lists it as a
   writer of cue columns. I classified it as plumbing and did not ask what it was.
3. **I repeated the doc's claim that `intro_end_ms` was "empty on every row"** without checking who
   writes it. It is empty because nobody has used INTRO END yet — not because the field is vestigial.
   One `grep intro_end_ms src/` would have shown the cue editor reading and writing it.

The pattern in all three: I treated the design document as the survey. It was a proposal, and it says
so in its own §8.
