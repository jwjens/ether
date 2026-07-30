# Handoff — 2026-07-30 (part 2)

**For the architecture/planning chat.** Covers everything after
`docs/handoff-2026-07-29-30-double-play-drift-and-health.md`. Written to be read cold; that doc is the
prerequisite for background, this one is the delta.

**Builds this window:** 4.4.107 (health two-column + Live Activity terminal) · 4.4.108 (canary-toggle fix).
Installed on the box: **4.4.108**. Nothing pushed, nothing tagged. Working tree carries uncommitted work
from 4.4.105 onward.

---

## 1. ★ The rogue loader is identified — it is the renderer's in-process engine

This is the headline. The 2026-07-29 root cause said "a deck was started outside the advance chain" and could
not name the sender. **Today it named itself**, because turning the log-reader flip on activated §2.5's
operator-row writer, which logs every inbound `load`.

**Two live double-play incidents on station 4:**

```
16:35:10 → 16:35:51   46.0 s   engine live deck B="California Christmas"  FOREIGN A="Holiday Road"
16:37:24 → 16:38:14   50.6 s   engine live deck B="Numbah One Day…"        FOREIGN A="Holiday Road"
```

Both ended **only** because the Bug-A guard happened to catch deck A on its next real rotate. Nothing else in
the engine could have ended them.

**The receipt — `generated_schedule.source='operator'` rows** (written by `_writeOperatorLogRow` ←
`noteManualCue` ← every inbound `load`, `ether-audiod.js:107`):

```
16:35:05.579  "Jingle Bell Rock - John's Version"   ┐ 1.248 s apart
16:35:06.827  "Holiday Road - 2024 Remaster"        ┘
16:37:23.793  "Candy Christmas"                     ┐ 1.239 s apart
16:37:25.032  "Spot_Free_Christmas…"                ┘
16:43:16.630  "Holiday Road - 2024 Remaster"
```

**All five on station 4. Zero on stations 1, 2, 3.**

Three independent lines converge:

1. **Station 4 is the only station with `is_active = 1`** — the only one whose renderer `AudioEngine` is
   `init()`-ed (`src/App.tsx:1084-1086`: non-active stations' engines "are created but never init()-ed").
2. **The pair signature is the renderer's post-rotate preload, to the millisecond.**
   `src/audio/engine-rodio.ts:547-556`:
   ```js
   const nearDelay = (this.crossfadeDuration * 1000) + 800;
   setTimeout(() => this.preloadDeck(X, 0), 800);
   setTimeout(() => this.preloadDeck(Y, 1), nearDelay);
   ```
   Pair gap = `nearDelay − 800` = **1.24 s** at the shipped default. Observed: 1.248 s and 1.239 s.
3. **`preloadDeck` early-returns when `daemonDriven`** (`:585`). It ran ⇒ **station 4's renderer engine has
   `daemonDriven === false`** — running its own advance in parallel with the daemon.

**Still open:** whether the renderer initiated or relayed, and *why* `daemonDriven` resolved false. Both need
the `[ROT]` line, which writes to `__dirname/../tmp-userdata/rotation.log` (`electron/main.js:3299`) — absent
in a packaged install, inside a silent try/catch. **That repair is authorised, still unbuilt, and is now the
highest-value remaining diagnostic in the whole arc.**

**Corrected premise:** AUTO off/on is **not** the trigger. `stop()` does stop all three decks
(`engine.js:240-246`) and `start()` has an adopt guard (`:1156-1187`) — a clean cycle cannot produce two
decks. There was no `automationStop`/`automationStart` for s4 at either incident.

## 2. (c)-enforce is BUILT — the liveDeck GUARD (not yet authorised to ship)

The observation release (4.4.105) did its job: it named the fault and measured its cost. The guard now acts.

Same placement (`poll()` `:298`), same derived grace (`(segueOverlap + crossfadeDuration) × 1000 + 1500` =
7500 ms). Past grace it logs **and stops** the foreign deck — on the advance chain (`_advance`), with three
re-checks under the chain (is it now live? still playing? did a rotate land?), never touching `liveDeck`,
never touching CART, clearing `deckReady`/`endTriggered` like the Bug-A guard. Emits
`error {where:"liveDeckGuard"}` so the Health Monitor sees it.

**A legitimate overlap cannot trip it, arithmetically:** normal overlaps end at `cf×1000 + 500` = 3500 ms; the
grace is 7500 ms. Both derive from the same two settings, so they move together.

**Bench `audiod/smoke-seam-stop.js`: 27 → 35, all pass.** Includes overlap probed at three points inside the
grace asserting no stop; foreign-past-grace asserting the stop ran on the chain, hit only the foreign deck,
never the live deck, and cleared `deckReady`; CART never foreign; and a rotate landing between tick and turn
cancelling the queued stop.

**Blast radius:** live-air advance path, four stations, no staging. Second change to this area for a two-decks
bug (the first, 2026-07-22, exists because an earlier edit caused the 2026-07-21 OF incident). Failure mode if
wrong: a music deck stopped that should be playing — audible immediately. Watch the first hour for any
`liveDeck GUARD` line *not* accompanied by an inbound `load` in the same window.

## 3. The canary toggle was inverted — found, fixed, shipped in 4.4.108

**Symptom:** clicking the per-station flip button wrote `'0'` every time; the flag could never be turned on.

**Cause:** `toggleFlip(sid, !on)` derived the **written value from what was rendered**
(`HealthMonitor.tsx:734`, old). Combined with a state map that could go stale — whole-map replace as the last
statement inside a swallowed `try` (`:319-320`), plus overlapping refreshes with last-to-resolve-wins
(`useCallback([libHealth])`, `:321`) — a stale `true` made every click write `'0'`, the exact value that keeps
it stale. **A display bug that defended itself.** It *did* re-read after writing; the missing half was
deriving the write **from** a read.

**Fix (`:307-367`, `:729-762`):** `readFlip(sid)` is the single source of truth; `refreshFlipFlags` merges
**per station with functional updates** (no whole-map replace, overlapping runs merge); `toggleFlip(sid)`
takes **only the station id** — reads current, computes the target from that read, writes, inspects the
write's verdict, then **renders the read-back**. Tri-state render: `LOG-READER ON` / `LEGACY` / **`UNKNOWN`**
(amber) / `…` busy, with a red per-station line when a write is refused or doesn't stick.

## 4. The flip is ON on all four stations — and has still never executed

```
s1 '1' 16:33:07   s2 '1' 16:33:07   s3 '1' 16:33:08   s4 '1' 16:34:23
```

`_logReaderOn()` is proven true for s4 by behaviour: `_writeOperatorLogRow` early-returns unless the flip is
on (`engine.js:874`), and it fired five times.

**But `_refillFromLog` has never run.** Receipt: s4's `generated_schedule` is still
`pending 15117 · played 1871 · playing 1` — **zero `missed`**, which the flip stamps loudly when behind.

**Why — one gate, on the caller side:**

```js
audiod/engine.js:524
if (this.continuous && this.queue.length < 5) this.refillIfNeeded();
```

`refillIfNeeded` checks the flip *first*, before any queue test (`:739`) — but it is only **called** when the
queue drops under 5, and the queue has been 17-19 all day. The only other caller is `start()` (`:1150`,
unconditional), and the last `automationStart` for s4 was **16:30:41 — four minutes before the flag went on**.

**So: one AUTO cycle on station 4 engages it.** Expect `LOG-READER: behind Xm — stamped N skipped-past rows
'missed'` then `logreader refill: N pending from log (mode=…)`.

**Design question for the planning chat:** `:524` is the wrong gate for a time-anchored reader. A row-cursor
queue only needs refilling when it runs low; a *time-anchored* reader needs to re-evaluate on a cadence
regardless of depth, because the whole point is "what should be on air now". As written, the flip inherits the
legacy queue-depth trigger and can sit inert for an hour behind a full queue — and the top-of-hour hard cut
refills to ~20, resetting that clock every hour. **This likely needs its own tick, not the legacy gate.**

## 5. Spot anchors — what today actually demonstrated

- **Top of the hour works.** `16:00:00.785 top-of-hour @9:00 HARD CUT → Spot_Free…` → `deck A LIVE` at
  `16:00:01.079`, 1.1 s after the hour. The `:00` spots land because the hard cut is the one enforced anchor.
- **The `:20` anchor does not.** The `09:20:30` spot row is stamped `played` but aired at `09:17:03`
  (3.5 min early, caused by an AUTO restart loading it onto deck A), and at `09:20:45` a four-minute track
  took the anchor slot.
- **Songs repeated within five minutes** — `Tidings Of Comfort And Joy` at 09:13:57 and 09:18:31,
  `Funky New Year` at 09:16:11 and 09:20:45. The row cursor is replaying a block (`loggen.js:414` resets the
  cursor to 0 on exhaustion; `_schedCursor` at `:185` is module-level and **shared by all four stations**).
  Separation is being violated on air.

**Jeff's requirement, unchanged and now twice-stated:** he crossfaded past two songs by hand to land a spot on
time — *"i wont always be around, i need ether to watch that."* That is the **auto-fitter** (§2.7 ruling:
deterministic look-ahead, no LLM, swap upcoming rows for shorter same-category songs on overshoot / insert
short fills on undershoot, `source='autofit'`, written minutes ahead, visible on the calendar before air;
boundary DROP last-resort only). **Not built.** Prerequisite is the flip actually executing (§4).

**Expectation to keep straight:** the flip alone gets the spot to its anchor by **cutting** the song in
progress. Hitting the anchor *and* keeping the music intact is the fitter.

## 6. Health Monitor — two-column + Live Activity (4.4.107), threshold fixed

Display-only; no daemon changes, no new writers. `activity:tail` (`main.js:2792-2831`) follows
`ether-audiod.log` from a byte offset — renderer holds the cursor, 256 KB cap, rotation detected as
`prev > size`, consumes only to the last `\n`. Terminal: monospace, auto-scroll, pause + auto scroll-lock,
per-station colour and filter, Decisions/All/Warnings (default hides 81% of lines — measured 1339 routine /
299 decision / 8 warning on 1,646 real lines), 800-line cap, 1 s poll. Help entry
`docs/help-live-activity.md` (`tour: true`).

**Threshold defect, found on air and fixed:** the ~950 px Station Health popout rendered the terminal as a
bottom row. `TWO_COL_MIN_PX` was 1000 measured against `window.innerWidth` — right code, wrong thing
measured. Now **820**, measured on **the panel's own element** via `ResizeObserver`
(`HealthMonitor.tsx:10-38`, ref at `:512`).

## 7. Open, ranked

1. **`[ROT]` repair** (`main.js:3299`) — authorised, unbuilt. Names the rogue loader and settles
   `daemonDriven` per station. Everything in §1 is blocked behind it.
2. **Auto-fitter** — the stated requirement. Design doc first. Blocked on §4.
3. **The flip's refill trigger** (§4) — the `queue.length < 5` gate is architecturally wrong for a
   time-anchored reader. Needs a decision.
4. **`_schedCursor` shared across stations** (`loggen.js:185`) + cursor reset on exhaustion (`:414`) — causing
   on-air repeats *today*.
5. **Renderer duration-mixing / frozen countdown** — still open. Reported again on 4.4.108; the Live Activity
   1 s poll has **not** been ruled out as an aggravator. **One-minute test: close Station Health, watch two
   songs.** Healthy closed + frozen open ⇒ the terminal; frozen either way ⇒ the pre-existing bug
   (`engine-rodio.ts:438-440`).
6. **(a)** effective-overlap clamp and **(b)** observed-condition stop, from the no-floor family.
7. Spots written to `play_log` as `content_class='MUSIC'` — affidavit reporting won't see them as spots.
8. Observer's noisy `foreign deck cleared` line on ordinary overlaps (one-line fix).

## 8. Tree state

Uncommitted, all local:

```
audiod/engine.js                          liveDeck observer → GUARD (enforce)
audiod/smoke-seam-stop.js                 bench 5 → 35
src/audio/engine-rodio.ts                 the 4.4.106 revert
electron/main.js                          activity:tail
electron/preload.js                       activity.tail bridge
src/components/HealthMonitor.tsx          two-column + container breakpoint + canary-toggle fix
src/components/LiveActivityTerminal.tsx   new
package.json                              4.4.108
docs/…                                    reports below + help-live-activity.md
```

`tsc --noEmit`: the 2 standing baseline errors only (`OnboardingFlow.tsx:2039`, `PhoneDesk.tsx:777`)
throughout. `node audiod/smoke-seam-stop.js`: 35/35.
Installer: `C:\openair\dist-electron\Ether Setup 4.4.108.exe`.

## 9. Docs added this window

```
canary-toggle-inverted-state-fix-2026-07-30.md
auto-cycle-double-play-and-flip-engagement-2026-07-30.md
build-report-livedeck-guard-enforce-2026-07-30.md
handoff-2026-07-30-part2-guard-flip-and-loader.md   ← this file
```
