# Who reads the cue columns · and what protects the outgoing song's last word
2026-09-08 · read-only · **nothing built**

---

## 1 · The cue columns: every hit, classified

`grep -rn "cue_in\|cue_out\|intro_end\|outro_start" audiod/ electron/ native/src/`, plus the
`introEnd`/`outroStart` names those values travel under once they leave SQL.

### Writers — things that SET a value

| where | what |
|---|---|
| `native/src/audio_engine.rs:803-849` | the analyser. `cue_in` **hardcoded 0** (*"jock sets this manually"*), `cue_out` **hardcoded to the duration**, `intro_end` = first sustained audio, `outro_start` = start of trailing silence |
| `src/components/CueEditor.tsx`, `CueEditorWindow.tsx`, `AutoCue.tsx`, `TrackEditor.tsx`, `GSelectorImport.tsx` | the operator-facing editors and the G-Selector import |

### Plumbing — things that STORE or SYNC a value

| where | what |
|---|---|
| `electron/sync/handlers/songs.js:19,70,71` · `library_asset.js:42,43` | `PATCHABLE` + INSERT column lists |
| `electron/sync/synced-tables.js:137,138,932-939` | registry scalars. Note `:936-937` — `intro_end` / `outro_start` are marked **`local-only`, "legacy marker, superseded by intro_end_ms"** |

### Carriers — things that READ a value and pass it on

| where | what |
|---|---|
| `audiod/loggen.js:161, 169, 237, 257, 347, 523` | SELECTs `s.intro_end, s.outro_start` and maps them onto the queue item as `introEnd` / `outroStart` |
| `src/audio/loggen.ts:602-603, 626, 683-684` · `src/App.tsx:2447` | the same, on the renderer side |
| `src/audio/engine-rodio.ts:46` | declares `outroStartSec?: number` on the queue-item type |

### Consumers — things that ACT on a value

**None.**

- `audiod/engine.js` and `audiod/ether-audiod.js`: **zero hits** for `introEnd` / `outroStart`.
- `native/src/audio.rs` — the playout engine: **zero hits** for any cue column. No seek, no trim, no
  early stop. Every file plays from sample 0 to its last sample.
- `outroStartSec` at `engine-rodio.ts:46` is the one typed field that could have consumed it. It is
  **declared and never assigned and never read** — that line is its only occurrence in the tree.

### Plainly

**The cue editor has been writing values that nothing acts on.** `intro_end` and `outro_start` are
computed by the analyser, stored, synced, selected by the log generator and carried onto every queue
item — and then dropped on the floor. `cue_in` and `cue_out` are not even computed to anything
meaningful (0 and the duration) and are unset on all 64 cuts.

**Correction to what I said earlier.** I reported "no reader exists in `audiod/`". That was wrong: I
grepped `audiod/engine.js` and `audiod/ether-audiod.js`, not the `audiod/` tree, and `audiod/loggen.js`
does read both columns. The conclusion survives — nothing *acts* on them — but "no reader" was an
overstatement produced by a grep that was narrower than the claim it was used for.

---

## 2 · What protects the outgoing song's last word

### Today: nothing

`audiod/engine.js`, `_jingleTick`, the `armed` branch:

```js
if (remaining <= j.leadIn + this.segueOverlap) this._fireJingle(j);
```

`remaining` is the **outgoing** deck's remaining seconds. With `LEAD 2` the sweeper fires two seconds
plus the overlap before the outgoing ends, **with no knowledge of whether that song is still singing.**
On a song that ends on a vocal, it stomps the last word. Every time, for that song, forever.

And this is deliberate as far as it goes — the comment above that line says so: *"LEAD 3 puts three
seconds of sweeper over the tail of whatever came before it, every time, whatever that was."* The
overlap is the feature. The stomp is the same feature meeting a song that does not have three spare
seconds at the end.

### Under the model you just approved: protected, for free

The new fire arm reads the **incoming** deck:

```
fire when incoming position P >= post − cue_out
selection guarantees cue_out <= post − segueOverlap
therefore                    P >= segueOverlap
```

The incoming starts when the outgoing has `segueOverlap` left (`_segueTick`), so **the outgoing ends at
exactly `P = segueOverlap`.** The sweeper cannot start before that moment.

**So the same term protects both songs.** The rule you approved to keep imaging off the incoming
vocal also keeps it off the outgoing one, and it does so without any outgoing-side mark. That holds for
any `segueOverlap`, including 0. It is the third thing this model deletes.

### But only where it applies — and that is the catch

I recommended: **no post on the incoming song → fall back to today's fixed LEAD.** That fallback
preserves today's defect exactly. With 444 of 444 songs unmarked, **today's stomp is what plays on
every seam** until marking starts.

That is a consequence of my own recommendation and it should be on the table when you weigh it.

### Four ways to protect the outgoing on the LEAD path

| | what it does | costs |
|---|---|---|
| **1 · Accept it** | today's behaviour on unmarked seams | the stomp stays until a song is marked |
| **2 · Fire at the rotate** (LEAD becomes "seconds into the intro", never before) | never touches the outgoing, on any seam, marked or not | **removes the deliberate tail overlap** — the thing LEAD exists to do. And with no post it may then stomp the *incoming* vocal instead. A trade, not a fix. |
| **3 · Mark the outgoing** — `end_post_ms`, fire no earlier than the last vocal | accurate, preserves the tail overlap, works on unmarked-incoming seams | **a second mark per song.** Doubles the only work that scales. |
| **4 · Let marking migrate the seams** — each marked song moves its seam to the new anchor | no new mark, no new behaviour, the stomp disappears seam by seam | it is gradual, and the protection follows the **incoming** song |

**Recommended: 4, with 3 named and unbuilt as you ruled.**

Point 4 has a property worth stating precisely, because it is better than it sounds:
**marking song X protects the song that plays *before* X.** The protection attaches to the seam, not to
the marked song, and the most-played songs are the ones that appear most often as the incoming — so
marking the thirty that carry the station converts a large share of all seams, not thirty of them.

### What this changes about the outro column

It stops being "for a deliberate outro mode later" and becomes **the only thing that can protect the
outgoing on a seam whose incoming song is unmarked.** That is a stronger reason to exist than the one
in the last proposal — but it does not change your ruling, because option 4 covers the same ground
without a second marking pass, and it covers it exactly where marking has been done.

**Name it now, as ruled. Build it if, after hearing AUTO-POST, the unmarked seams still bother you.**

---

## 3 · What this document does not claim

The fire arithmetic in §2 is **designed, not measured** — no placement has been made under it and
nothing has been heard. That the outgoing ends at `P = segueOverlap` is read from `_segueTick` and the
conditional-retire behaviour shipped in slice 0; it has **not** been observed on a live seam with a
stopwatch. The claim that nothing consumes the cue columns is a claim about the source tree, verified by
the greps above — not a runtime observation.
