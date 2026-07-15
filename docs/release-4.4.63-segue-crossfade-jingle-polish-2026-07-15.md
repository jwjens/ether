# Release 4.4.63 — Routine segue overlap (auto) + jingle polish (2026-07-15)

**Corrected build.** The feature is an **early start of the next song**, NOT a fade. Automation **never moves a
deck fader** — an earlier build-day attempt implemented "fade" as fader automation, which visibly yanked the
console faders down and fought the operator's hand (drag up → it pulled back down). That was removed entirely.
Off-air proof obtained; **ear-test gate pending** (Jeff signs one plain segue AND one jingle seam). STOP before
install.

## A · Segue overlap (auto) — the whole feature
- **Settings → Audio, two labelled sliders** (`src/components/SettingsPanel.tsx`):
  - **"Manual crossfade (X key)"** — existing slider, relabelled; unchanged (manual X / AUTO-X).
  - **"Segue overlap (auto)"** — NEW, `0–10s`, default 3, `0 = off`. "How many seconds the next song starts
    before the current one ends."
- **Persist + deliver** (`src/App.tsx`, `src/audio/engine-rodio.ts`, `audiod/ether-audiod.js`): stored in
  `localStorage.ether_segue_overlap`; pushed via `setSegueOverlap`; re-pushed on every daemon (re)connect +
  automation start (survives the update/crash respawn).
- **Daemon** (`audiod/engine.js`, `_segueTick`): when the playing deck has `remaining ≤ segueOverlap` and the
  next deck is ready, start the incoming NOW at full over the outgoing's natural tail (reusing `handleRotate`).
  Both play; the outgoing **ends on its own** (handleRotate's deferred stop already no-ops while the deck is
  still playing, so the full tail is preserved). Double-trigger guarded (`segueTriggered`).
- **NO fader automation.** The fade ramp, `_fadeOutDeck`, `_segueRamps`, `_fadedDecks`, `_clearSegueRamp`, and
  the `_play` volume-reset are all **removed**. There is **no `audioSetVolume` anywhere in the daemon** now —
  automation never touches a fader.

## B · Jingle seams overlap too (no fades)
- `_segueTick` runs on jingle seams as well: the next song starts early **under the firing jingle**. It waits
  only while a jingle on this deck is still **ARMED** (starting the incoming would bump the on-air generation
  and supersede the not-yet-fired jingle); once the jingle is **FIRING**, the early start proceeds and overlaps
  the jingle tail.
- The jingle bridge (`_jingleBeginBridge`, for the `overlap=0` case) is guarded by `!segueTriggered` so the
  early overlap owns the seam when enabled. No fades on the jingle path.

## C · Indicator (unchanged from the first 4.4.63 build, kept)
- Fader-strip chip gone; the jingle's **name + time** is a third line under the playing deck's duration in the
  Up Next row (`src/components/UpNext.tsx`): **solid white = ARMED, blinking yellow = FIRING**, class-aware
  (JIN/SWP). Countdown colors untouched.

## Proof (off-air, isolation harness — no live daemon touched)
`node scripts/test-segue-overlap.js` (own daemon, DB copy, monitor muted, pinned short tones):
```
PASS incoming deck B started EARLY (overlap — next song began before A ended)
PASS outgoing + incoming played TOGETHER (real overlap window)
PASS music never stopped across the seam (no dead air) — min master across seam = 0.2441
PASS *** deck faders NEVER moved from 1.0 (automation never touched a fader) *** — max |vol−1.0| = 0.0000
PASS NO panic in the daemon log
✅ SEGUE-OVERLAP PROOF — ALL PASS
```
Receipt: `segue overlap: A→B — incoming starts 3s early over A's tail (no fade)` · `deck B LIVE — tone-1` ·
`deck A ended (pos=9.9/10s …)` (A played its full tail). The jingle-seam overlap is code-level + the operator
**ear-test gate** (one plain segue AND one jingle seam signed before ship).

## Gates
- `node --check` clean on `audiod/engine.js` + `audiod/ether-audiod.js`; **no `audioSetVolume` in engine.js**.
- `npx tsc --noEmit`: only the known pre-existing errors (App.tsx:4911, OnboardingFlow, PhoneDesk) — zero new.
- `npm run build` + installer `--publish never`.

## Files
`audiod/engine.js` · `audiod/ether-audiod.js` · `src/audio/engine-rodio.ts` · `src/App.tsx` ·
`src/components/SettingsPanel.tsx` · `src/components/UpNext.tsx` · `src/components/ConsoleStrip.tsx` ·
`electron/main.js` · `scripts/test-segue-overlap.js` (new; old test-segue-crossfade.js removed) ·
`docs/help-segue-overlap.md` (new; old help-segue-crossfade.md removed) · `package.json` · `CHANGELOG.md`.

## Architecture compliance
- **Deck faders are operator controls** — automation now provably never moves them (harness: `max |vol−1.0| =
  0.0000`). This is the core correction.
- **ONE scheduler / log-reader untouched** — the overlap is a playout-transition trigger, no selection change.
- **Honest UI** — the overlap airs on the real program bus; the indicator reflects OBSERVED daemon jingle state.
- **No native change** — the overlap reuses the existing `handleRotate`; no `audioSetVolume` at all.

## Not in this release (scoped separately)
- **MIC source-audit** (source × [device] × [program bus]) — still its own deliverable.
