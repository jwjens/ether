# Release 4.4.63 — Routine segue crossfade + jingle polish (2026-07-15)

One release, three parts, built exactly as proposed (GO: option **(a) continuous weave**). Off-air proof
obtained; **ear-test gate pending** — Jeff signs the sound of one plain segue AND one jingle seam before it
ships. **STOP before install.**

## A · Routine segue crossfade (new setting + real fade)
- **Settings → Audio, two labelled sliders** (`src/components/SettingsPanel.tsx`):
  - **"Manual crossfade (X key)"** — the existing slider, relabelled; unchanged behaviour (manual X / AUTO-X).
  - **"Segue crossfade (auto)"** — NEW, `0–10s`, default 3, `0 = hard cut`. Teal accent, shows "hard" at 0.
- **Persist + deliver** (`src/App.tsx`, `src/audio/engine-rodio.ts`, `audiod/ether-audiod.js`): stored in
  `localStorage.ether_segue_crossfade`; pushed to the daemon via a new `setSegueCrossfade` command, and
  **re-pushed on every daemon (re)connect + automation start** (survives the update/crash respawn — the
  daemon resets to its default on a fresh engine).
- **Real fade in the daemon** (`audiod/engine.js`): a new `_segueTick(now)` runs each poll. When the playing
  deck reaches `remaining ≤ segueCrossfade` and the next deck is ready, it (1) ramps the outgoing deck's
  fader **1 → 0** over its remaining time via `audioSetVolume` (`_fadeOutDeck`, ~50ms steps) and (2) starts
  the incoming deck now (reusing the proven `handleRotate`), so the incoming crosses up while the outgoing
  fades down. `_play` resets a deck's fader to full + clears its segue flags (a deck faded on its last turn
  returns at full). Double-trigger guarded (`segueTriggered` / `_fadedDecks` sets). `segueCrossfade = 0`
  keeps the legacy hard cut. **No native rebuild** — `audioSetVolume` already existed.

## B · Jingle rides the same fade + gap closed (continuous weave)
- On a jingle seam `_segueTick` still fades the outgoing (one fade policy) but **skips the early rotate** —
  the jingle bridge owns the incoming entry.
- `_jingleBeginBridge` now sets `nextStart = now`: the instant the (already-faded) outgoing ends, the
  incoming enters at full and rides **under the jingle's remaining tail**. `_jingleShouldBridge` bridges
  whenever there's >150ms of jingle left. This closes the old `jinDur − leadIn − underlap` silence gap (the
  8.4s Transition 14 → ~1.4s jingle-alone "three events" from the maiden fire).

## C · Indicator rebuilt (per Jeff's screenshots)
- The **fader-strip chip is gone** (`src/components/ConsoleStrip.tsx` — props retained, ignored).
- The jingle indicator is now a **third line under the playing deck's duration** in the Up Next deck row
  (`src/components/UpNext.tsx`): the jingle's **name + time**, **solid white = ARMED, blinking yellow =
  FIRING**, class-aware (JIN/SWP). The **countdown colors are untouched**. Payload carries the jingle
  duration now (`jinDurSec` added through `audiod/engine.js` → `electron/main.js` → `src/App.tsx`).

## Proof (off-air, isolation harness — no live daemon touched)
`node scripts/test-segue-crossfade.js` (own daemon, DB copy, monitor muted, pinned short tones):
```
PASS outgoing deck A FADED (fader ramped 1 → low before it ended) — min deckA.volume while playing = 0.200
PASS incoming deck B started (segue advanced)
PASS crossfade OVERLAP observed (both decks audible together)
PASS music never stopped across the seam (no silence gap) — min master across seam = 0.2441
PASS NO panic in the daemon log
✅ SEGUE-CROSSFADE PROOF — ALL PASS
```
Daemon receipts: `segue fade: deck A 3.0s → 0` · `segue: crossfade A→B (3s)` · `segue: deck B LIVE — tone-1` ·
`deck A ended (pos=9.9/10s …)` (A still played to its end = the overlap).

The **jingle-seam** continuous-weave is code-level (above) + the operator **ear-test gate** — as Jeff
specified: he signs the sound of one plain segue AND one jingle seam before ship.

## Gates
- `npx tsc --noEmit`: only the three known pre-existing errors (App.tsx:4911, OnboardingFlow, PhoneDesk) —
  **zero new** in any changed file.
- `node --check` clean on `audiod/engine.js` + `audiod/ether-audiod.js`.
- `npm run build` + installer `--publish never`.

## Files
`audiod/engine.js` · `audiod/ether-audiod.js` · `src/audio/engine-rodio.ts` · `src/App.tsx` ·
`src/components/SettingsPanel.tsx` · `src/components/UpNext.tsx` · `src/components/ConsoleStrip.tsx` ·
`electron/main.js` · `scripts/test-segue-crossfade.js` (new) · `docs/help-segue-crossfade.md` (new) ·
`package.json` · `CHANGELOG.md`.

## Architecture compliance
- **ONE scheduler / log-reader untouched** — the segue is a playout-transition concern (deck faders +
  rotate), not a selection change; no scheduler, queue-source, or generated_schedule logic touched.
- **Honest UI** — the indicator reflects OBSERVED daemon jingle state (ARMED/FIRING), same event stream as
  before; the fade airs on the real program bus (post-fader), so what you see/hear is what airs.
- **Deck positions sacred** — decks A/B/C still show what the daemon plays; the fade only moves faders, never
  reassigns decks. `_play` restoring full fader keeps a reused deck honest.
- **No native change** — reused the existing `audio_set_volume`.

## Not in this release (scoped separately)
- **MIC source-audit** (source × [device] × [program bus]) — still its own deliverable.
