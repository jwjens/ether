# Sweepers: a scheduled sweeper fires — and what actually happens at the seam

2026-09-06 · branch `log-reader-flip` · local, uncommitted

Two things in one pass: the four approved changes to the sweeper fire path, and the read-only answer to
"when a sweeper fires, does the outgoing song keep playing underneath it, or does it duck, stop, or get cut?"

---

## Part 1 — the read-only answer: it plays OVER, and nothing is cut

**The outgoing song is never stopped, faded, or ducked by a firing sweeper.** Three independent
receipts, source-level:

1. **The fire path touches only the sweeper channel.** `_fireJingle` (`audiod/engine.js:2233-2258`)
   loops over `this._sweeperChannels()` and calls `_load`/`_play` on those slots only. There is no
   `_stop`, no volume write, and no reference to deck A/B/C anywhere in it. The music deck is not an
   argument to anything in that function.

2. **On the mixer the sweeper sums into the programme, it does not gate it.** `is_aux` is
   `deck.kind == SlotKind::Source` (`native/src/audio.rs:2203`). A sweeper slot is `SlotKind::Sweeper`
   (`:969`), so `is_aux` is **false** for it, which means:
   - it is added to `core_l/core_r` — the programme base — alongside the playing music deck
     (`native/src/audio.rs:2233-2234`);
   - it can never arm the ducker: `if is_aux && duck_enabled[i] { duck_armed = true; }`
     (`:2220`) is unreachable for a sweeper slot.
   A sweeper ducking its own song is impossible by construction, not by configuration.

3. **The bridge is explicitly a weave, not a cut.** When the outgoing deck ends while a sweeper is
   confirmed firing on that seam, the normal rotation is *deferred* (`audiod/engine.js:807`) to
   `_jingleBeginBridge` (`:1956-1965`), whose comment states the rule: *"automation NEVER fades a deck —
   the outgoing rides its own mastered tail to its natural end under the jingle, and the instant it ends
   the incoming enters at full UNDER the jingle's remaining tail."* The incoming is started at
   `j.nextStart` by `_jingleTick` (`:2124-2128`).

So the shape on air today is: **outgoing tail · sweeper · incoming head**, continuous, no gap, nothing
truncated. That is what was asked for.

### The one thing that is NOT the operator's: how much sweeper lands on the head of the next song

`_jingleBeginBridge` sets `j.nextStart = now` **unconditionally**. `j.underlap` is read from the row,
carried on the armed object (`:1912`), logged (`:1918`) and emitted to the UI (`:1852`) — and **never
used in any calculation.** The amount of sweeper that plays over the head of the next song is therefore
whatever tail happens to be left (`jinDur − lead`), not a number anyone set.

Three comments (`:801`, `:1948`, `:2125`) describe "jingle end − underlap". The code does not do that.
It was a deliberate call — the continuous-weave decision, to avoid a sweeper-alone gap — but it means
one of the two timing numbers is inert in the engine. **Filed in `backlog.md`, not changed:** honouring
it (`nextStart = jingleEnd − underlap`, clamped `>= now` so it can never make dead air) changes seam
timing on every song, which is a decision, not a fix.

---

## Part 2 — the four changes

### 1. `audiod/engine.js:2148` — the spot-seam suppression is gone

```js
// deleted
if (this.deckContentClass[P] === 'SPOT' || (nextDeck && this.deckContentClass[nextDeck] === 'SPOT'))
  { this._clearScheduled("spot-seam"); return; }
```

Any seam where the outgoing *or* incoming deck was a commercial silently dropped its scheduled sweeper.
That is an editorial judgement made in code. Whether a sweeper suits a seam is the operator's call.

### 2. `audiod/engine.js` — the placement is consumed at FIRE, not at ARM

`_noteFiredRow(rowId)` moved out of `_armJingle` (was `:1917`) into `_fireJingle`, immediately after
`if (!firedOn.length) { this._cancelJingle(...) }` (now `:2256`) — i.e. only once a channel has actually
accepted the audio.

Before: arming marked the row fired. A sweeper that was then superseded (`_jingleSuperseded`), refused
by every channel (`no-channel-accepted`), or cancelled at fire was **gone forever, counted as aired**.
Safety of the move: while `this._jingle` is set, `_jingleTick` returns early at the `if (j)` branch and
never re-queries `readJingleForSeam`, so nothing can double-arm in the arm→fire gap. After a cancel the
row is legitimately back in play for the same seam.

The dead-file consume at `:2159` (`_fileOk` fails → note + skip) is untouched: that one is real, the file
cannot be played.

### 3. `src/components/SweepersPanel.tsx` — the TIMING column

Category assignments grid is now four columns: **CATEGORY · OVERLAY · TIMING (s) · ACTIVE HOURS**.
Two boxes per row, **LEAD** and **OVER**, written through `categories.updateById` — the same path as
ACTIVE HOURS, so both are `PATCHABLE` (`electron/sync/handlers/categories.js:17`) and synced scalars
(`electron/sync/synced-tables.js:253-254`), and both reach `_placeJingles` on the next Generate.

**A greyed box is the current value, not an empty box.** With no override the box shows `2` in grey —
the number that is actually airing — and typing over it brightens the border to the sweeper accent.
Clearing the box writes NULL and returns the category to the station default. Commit is on blur/Enter
(one write, not one per keystroke); values clamp to 0–60 and non-numeric input leaves the stored value
alone.

### 4. One number, three places

| file | was | now |
|---|---|---|
| `electron/main.js:8398` `SWEEPER_DEFAULT` | `{ lead: 5, under: 2 }` | `{ lead: 2, under: 2 }` |
| `audiod/loggen.js:492-493` | `cls === 'SWP' ? 2 : 5` / `? 1 : 2` | `2` / `2` |
| `src/components/SweepersPanel.tsx` `createPool` | `lead_in_sec: 5, underlap_sec: 2` | `DEF_LEAD` / `DEF_UNDER` |

The class fork is retired with the class: SWP and JIN timed the same seam differently depending on a
label. `SweepersPanel` names the numbers as `DEF_LEAD`/`DEF_UNDER` and renders them, so the default is
visible rather than private.

---

## What this does NOT change

- **The 53,256 existing `generated_schedule` rows still carry `lead_in_sec = 5`.** The new default only
  applies to rows written by a future Generate. The backfill is proposed separately, with counts.
- `_ARM_WINDOW_S = 30` (`audiod/engine.js:1846`) — the read-ahead window, confirmed harmless at 1–3s
  lead-ins; not part of this change.
- The underlap bridge (Part 1, above) — filed, not changed.

## Restart

| file | process | needs |
|---|---|---|
| `audiod/engine.js` | daemon | **full close + reopen** |
| `audiod/loggen.js` | daemon | **full close + reopen** |
| `electron/main.js` | main | **full close + reopen** |
| `src/components/SweepersPanel.tsx` | renderer | hot-reloads |

The daemon does not reload on auto-update — closing and reopening the app is required for the first
three, and until then the running engine keeps the old suppression and the old arm-time consume.

## Verification

- `npx tsc --noEmit` — **0 errors**.
- `node --check` on `audiod/engine.js`, `audiod/loggen.js`, `electron/main.js` — all pass.
- On-air effect is **UNVERIFIED** until a restart and a run: the check that settles it is
  scheduled-vs-aired sweepers over a window (`scratchpad/swp-aired.js`), which measured **70 scheduled /
  40 aired = 57%** before this change.

---

## Part 3 — resolution: underlap is gone, LEAD is the only number

Ruled the same day, and it supersedes the "filed, not changed" note in Part 1:

> Song is 3:34. Lead is 3. Sweeper fires at 3:31. The sweeper is 6 seconds long, so it ends 3 seconds into
> the next song. The next song starts when the outgoing song ends — its natural end, exactly as it does with
> no sweeper at all. The sweeper's length is not an input. Where it lands in the next song is arithmetic,
> not a decision.

The engine already behaves this way — `_jingleBeginBridge` is reached only from the deck-end handler
(`audiod/engine.js:807`, ten lines after `_setDeck(deckId, {status:"ended"})` at `:797`), so its `now` **is**
the outgoing's natural end as the 250 ms poll observes it. No change was needed to the fire path.

So underlap was never a setting — it was a leftover, carried through five files and read by nothing.
**Stripped**, in the engine (`j.underlap`, the ARMED log, the daemon-jingle event, the scheduled hint),
`loggen.js` (the SELECT and the fallback), `main.js` (`SWEEPER_DEFAULT.under`, the `stmtAssign` SELECT,
`underOverride`, the `jinRows` write, the window forward), `audio-health.js`, and the panel (the OVER box,
`DEF_UNDER`, and the equally-dead pool-level underlap input).

**The three DB columns stay.** `categories.overlay_underlap_sec`, `generated_schedule.underlap_sec` and
`jingle_categories.underlap_sec` are synced scalars (`electron/sync/synced-tables.js`,
`handlers/categories.js:17`); dropping one is a schema migration that older peers would keep writing to.
Two are nullable so the writes simply stop; `jingle_categories.underlap_sec` is `NOT NULL DEFAULT 2` and its
create handler already supplies a storage value (`handlers/jingle_categories.js:51`), so `createPool` just
stops passing it.

`SWEEPER_DEFAULT` is now `{ lead: 2 }`. TIMING is now a single **LEAD (s)** column.

**No privileged value.** 2 is where LEAD stands today and it is shown greyed in every category box as the
current value, not hidden as a default. Nothing in the engine, the panel or the docs treats it as a target.

## Part 4 — segueOverlap, proposed (not built)

`audiod/engine.js:120` — `this.segueOverlap = 3`. Same defect class, bigger blast radius: it governs
**every** music-to-music seam, not just seams with imaging. Proposal is in the 2026-09-06 report and filed
in `backlog.md`. Nothing built.
