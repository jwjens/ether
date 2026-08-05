# Hand-loads and the airable log — design of record

**Date:** 2026-08-04 · **Status:** DESIGN. Trace conclusive. **NOTHING BUILT.**
**Severity:** touches `generated_schedule`, the one file every station airs from.

---

## 1 · What happened, proven

Firing cart 1 on halloVeen produced this row:

```
generated_schedule id 190000 · station 2 · 2026-08-05 00:46:02
title          "Adele   Someone Like You 68"   ← the CART's title, triple space and all
file_path      C:\Users\jensj\Music\Adele - Someone Like You 68.mp3   ← the CART's file
source         'operator'
content_class  'MUSIC'
state          'pending'      ← AIRABLE
```

- **Adele is a cart only.** No library song matches it (`songs` scan, 2026-08-04).
- **`log_reader_flip` = 1 on all four stations**, so a `pending` row at the playhead is what the reader
  **plays**. That is how cart audio reached a music deck — via the log, not via the CART channel.
- The operator did **not** hand-load anything from the library. The row's `source='operator'` label was
  false, and taking that label at face value cost a round of wrong diagnosis. **The label was the
  suspect, not the operator's memory.**
- Four more `source='operator'` rows across stations 2 and 4 carry SPOT files stamped
  `content_class='MUSIC'`. All `state='missed'`, so not airable — but the mis-stamp is systemic, not a
  one-off.

**The operator's account (Jeff, 2026-08-04), recorded verbatim:**

> "firing cart 1 (earlier, when carts were open) wrote a phantom airable row"

So the trigger is established: **a cart fire.** What is NOT yet established is the code path, and the
gap is real and must not be glossed: both cart entry points (tile click `DeckConfigurator.tsx:733`,
hotkey `:653`) call `fireCart`, which loads deck `"CART"`; `noteManualCue` (`engine.js:1332`) returns
early for any deck that is not A/B/C; and `audio:load` (`main.js:3129`) passes `deck` through
unchanged. On the code as read, a cart fire cannot reach `_writeOperatorLogRow` — yet it demonstrably
did. **Some path presents a cart as an A/B/C load and has not been found.** Slice B names it the next
time it happens.

**The fix below does not depend on solving that.** Every path converges on one writer, and the writer is
where the defect lives.

---

## 2 · The two defects in `_writeOperatorLogRow` (`audiod/engine.js:1183-1196`)

### 2.1 · It hardcodes the content class

```js
VALUES (…, 'pending', 'operator', 'MUSIC', …)
```

`content_class` is a literal. A cart, jingle or spot hand-load therefore enters the log **as music**,
and every music query — rotation, the picker, the calendar — treats it as eligible. This is the same
content-class isolation failure as the spot-artwork bug, moved from artwork into the log.

### 2.2 · It writes an airable row

`state='pending'` is not a record of something that happened. **It is an instruction to air.** The
reader's job is to play pending rows at the playhead. So a "we noticed you loaded a deck" note is
indistinguishable from "play this next".

---

## 3 · What a hand-load should record

The original intent (Log-Reader Flip §2.5) is sound **for music**: a jock hand-loading a library song
should appear in the one file, so the calendar reflects reality and there are zero off-log airs. That
intent does not extend to imaging.

**The rule:**

> A hand-load is written to `generated_schedule` **only when the loaded file is a library MUSIC song.**
> Carts, jingles and spots are overlay and break content — they are not the music log, and they must
> never become rows the reader can pick up. Their airing is already recorded by `play_log`, which
> resolves content class correctly (`audiod/playlog.js:27-35`, including the `spots` fallback).

### 3.1 · Resolving the real class — and why `songs` alone is not enough

`playlog.js` resolves `songs.content_class`, then falls back to `spots`. **That is insufficient here:**
a cart file may exist in neither table. Adele is exactly that case — no `songs` row, no `spots` row,
only a `cart_slots` row. A `songs`-only lookup returns the `MUSIC` default and reproduces the bug.

Resolution order for a hand-load, in full:

| # | Check | Result |
|---|---|---|
| 1 | `songs.content_class` by `file_path` | use it (MUSIC / JIN / SWP) |
| 2 | `spots` by `file_path` | `SPOT` |
| 3 | **`cart_slots` by `file_path`** | **cart — imaging, not music** |
| 4 | none of the above | **unknown — do NOT write a row** |

Step 4 is the important one. Today "unknown" silently means MUSIC. It must mean *"I don't know what this
is, so I will not put it in the airable music log."* Refusing to write is always safe; writing a wrong
row is not.

### 3.2 · Non-music hand-loads

**Write nothing to `generated_schedule`.** Not a `played` row, not a soft-deleted row — nothing. The
airing is captured by `play_log` with its real class. Adding a "history" row to the airable log just to
record it invites exactly the confusion this document exists to end.

### 3.3 · Music hand-loads

Keep the §2.5 behaviour, with the class resolved rather than assumed, and with the deck recorded.

---

## 4 · Observability — so the next mislabel names itself

The current log line is why this took two rounds:

```
LOG-READER: operator deck-load → wrote source='operator' log row "Adele   Someone Like You 68"
```

Title only. No deck, no class, no caller — nothing to check the label against.

Replace with, on **every** call including the refusals:

```
LOG-READER hand-load: deck=<A|B|C|CART|?> class=<resolved> via=<caller> file="<basename>" → wrote row id=<n>
LOG-READER hand-load: deck=C class=SPOT via=noteManualCue file="..." → NO ROW (not music)
LOG-READER hand-load: deck=? class=UNKNOWN via=intentDeckCue file="..." → NO ROW (unresolved)
```

- **deck** — `noteManualCue` and `intentDeckCue` both know it and neither passes it. One argument.
- **class** — the resolved value, and which table resolved it.
- **via** — a literal caller tag passed by each call site. Two call sites exist
  (`engine.js:1352`, `engine.js:1425`); a third would have to declare itself.
- **refusals are logged too.** A silent refusal is how this class of bug hides.

This is permanent product sense, not diagnostic scaffolding — no watcher, no temporary tooling, nothing
to tear down (CLAUDE.md: build the sense, not the scaffold).

---

## 5 · The existing bad rows

- **id 190000** (station 2, cart, `pending`) — airable. Soft-deleted by
  `scripts/fix-phantom-operator-log-row.js`, verified on a copy: guarded to that exact id + station +
  source + path, aborts on any mismatch, `PASS` on "no longer airable".
- **ids 184694, 184697, 184698, 184708** — spot files stamped MUSIC, all `state='missed'`. Not airable.
  **Left alone**: they are historical, harmless, and rewriting history to look tidy is not a fix.

Soft-delete rather than a state rewrite: the row is a defect artifact, not a programming decision, and
every loggen query already filters `deleted_at IS NULL`.

---

## 6 · Architecture compliance

| Rail | Compliance |
|---|---|
| ONE scheduler / one log | The fix is at the single writer; no new path into `generated_schedule`. |
| Content-class isolation | Imaging and commercials can no longer enter the music log — the same rule the spot artwork fix applied to artwork. |
| Honest state | "Unknown" stops meaning MUSIC. Refusals are logged, not silent. |
| Build the sense | Deck + class + caller on every call, including refusals. Permanent, no scaffolding. |
| Correct minimal solution | One function's class resolution and write condition, plus one argument at two call sites. No schema change, no migration. |

---

## 7 · Build order

1. **Slice A — stop the bleeding.** Resolve the real class (songs → spots → cart_slots → unknown), and
   write a row **only** for library MUSIC. Non-music and unknown write nothing.
2. **Slice B — the sense.** Deck + class + caller on every call, refusals included.
3. **Slice C — the DB fix.** Run `fix-phantom-operator-log-row.js --apply` with Ether fully closed.

A and B are one small release together. C is an operator action, not code.

**Open:** which control wrote the row is still unknown. Slice B answers it the next time it happens
without another screenshot round.
