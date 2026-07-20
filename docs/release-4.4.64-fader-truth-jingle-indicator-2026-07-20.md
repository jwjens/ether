# 4.4.64 — deck fader renders engine truth + persistent jingle indicator (2026-07-20)

One release, bundling: (a) the post-4.4.63 "fader stuck at 2/3" display fix, (b) the SCHEDULED (grey)
jingle-indicator read-ahead, (c) a comment fix, and (d) **Show+ DAW chop & send**. (a)–(c) are
display/state + observability only (no audio path touched); (d) adds a production surface on verified rails.

Diagnosis that led to (a): [`fader-display-stale-diagnosis-2026-07-20.md`](fader-display-stale-diagnosis-2026-07-20.md).

---

## 0 — Show+ DAW: chop & send (Jeff's mission: "quick import, chop, send to deck / jingle / sweeper / library")

**Architecture (within CLAUDE.md "one region engine, two surfaces, never a copy" + the reel-splitter
inventory `docs/reel-splitter-verification-and-plan-2026-07-15.md`):**

- **Shared engine (new, extracted — not copied):** `src/audio/regionAudition.ts` (audition), `src/audio/
  imagingCommit.ts` (render→`ffmpeg.writeAudio`→`songs.create`+`updateById`), `src/components/
  ClassPoolSelect.tsx` (the shared class/pool commit-form atom). Reuses the existing `wavEdit.sliceRegion`/
  `encodeWav` and `silenceRegions.ts`. **The Reel Splitter was refactored onto these** (proving shared).
- **StudioPro import:** drag-drop (already real) + a new **＋ Import** file-pick (rides the same real
  `loadAudio` path). The two **dead** toolbar buttons (`sendToCartwall` 📤 / `streamThisMix` 📡 — dispatched
  `CustomEvent`s with no listener) were **removed** (honest-UI), their functions replaced by the import
  helpers.
- **StudioPro chop:** the selection is the selected region's **real trim span** `[trimStart,trimEnd]` on
  `region.buffer` (existing drag handles) — auditioned via the shared `auditionRegion`.
- **SEND TO — four real exits** (`src/components/StudioSendBar.tsx`, mounted in the RegionEditorDrawer):
  - **→ Library** — `commitRegionToLibrary(cls:"MUS")` (plain song, no tag).
  - **→ Jingle / → Sweeper** — `commitRegionToLibrary(cls:"JIN"|"SWP", poolId)` via `ClassPoolSelect`.
  - **→ Deck** — `renderRegionToDisk` → the **REAL** deck-load path `getEngine(stationId).deckCue`/
    `loadToDeck` (App.tsx:1827, the Library A/B/C path); an on-air deck is refused. **No blob-URL event.**
- **Plumbing:** `stationId` threaded StudioPro → RegionEditorDrawer → StudioSendBar (App.tsx passes the
  active station). Files: `StudioPro.tsx`, `StudioSendBar.tsx`, `ClassPoolSelect.tsx`, `regionAudition.ts`,
  `imagingCommit.ts`, `ReelSplitter.tsx` (refactor), `App.tsx` (mount prop), `docs/help-studiopro-chop-send.md`.
- **Honest scope:** the send paths reach real implementations (verified statically + typecheck); the
  end-to-end DAW flow is **unauditioned until installed** (self-contained AudioContext; the only on-air
  touch is → Deck, which uses the proven deckCue/loadToDeck path and refuses a playing deck).

---

## 1 + 2 — Faders render observed engine truth, never a remembered position

**Symptom:** after the 4.4.63 fader exorcism a deck fader could still *display* at ~2/3 while the
engine's real gain was unity. Confirmed by live `getState`: native playing-deck volume = **1.0000**;
automation provably never writes a deck fader. The 2/3 was a stale renderer value that nothing resynced.

**Root cause:** the fader renders `deck.volume` (`App.tsx:3792`). In daemon mode that value is only
refreshed when the daemon emits a `deck` event, and `_maybeEmitDeck` gated on status/title/position —
**not volume** — so an idle, unchanged deck stopped receiving corrections. The renderer's
`setVolume`/`fadeTo` write native but never write `stateX.volume` back, and there was **no resync of a
deck fader to observed truth on connect/boot.**

**Fix:**
- **Daemon** (`audiod/engine.js`) — `_changed` now includes `prev.volume !== next.volume`, so a deck
  event re-emits on any volume change; the UI can never lag the fader truth.
- **Renderer** (`src/audio/engine-rodio.ts`) — new `resyncDaemonDecks()` pulls the daemon's
  authoritative per-deck volume and merges **only** volume into `stateA/B/C` on **connect** (called
  alongside `resyncDaemonQueue`/`resyncDaemonEngineState`). The **event** path (onDeck → `makeState`,
  volume defaults to unity) and **load** path (`loadToDeck` → `volume:1`) already resync. Result: a
  stale fractional value is impossible; it also self-heals on the next rotation without a reload.

Consistent with the exorcism thesis: *a deck sits at unity unless a human drags that fader.*

---

## 3 — Persistent jingle indicator: SCHEDULED (grey) → ARMED (white) → FIRING (yellow)

The deck's third-line jingle indicator previously appeared only inside the 30s arm window (white/yellow).
It now appears **from the moment the song starts** as **grey = SCHEDULED** — a read-ahead that a jingle
is placed for this song's upcoming seam — promoting to **white = ARMED** in the seam window and **blinking
yellow = FIRING** on air. Class-aware (JIN/SWP).

- **Daemon** (`audiod/engine.js`) — `_jingleTick` maintains a `_scheduled` hint via new
  `_setScheduled`/`_clearScheduled` helpers. Re-queried only when the seam identity (`_scheduledSig` =
  deck + window bounds) changes → **at most one DB read per song, never per poll tick.** Promotion to
  ARMED nulls the hint without a CLEARED emit, so the indicator flips grey→white in the same tick (no
  gap). Display-only — never touches playout; wrapped in the existing tick try/catch.
- **Renderer** (`src/components/UpNext.tsx`) — renders grey (`#8b909b`) for SCHEDULED. `App.tsx`'s
  overlay handler was already state-generic, so SCHEDULED flows through unchanged.
- **Help** — `docs/help-jingles.md` updated to the three-state lifecycle.

---

## 4 — A comment that lied

`_jingleBeginBridge` claimed the outgoing deck "already faded to 0 under the jingle (the segue fade)".
There is no fade — the outgoing rides its own mastered tail. Comment corrected to match the code.

---

## Gates

- **Typecheck:** zero new errors (the 3 reported — App.tsx:4913, OnboardingFlow, PhoneDesk — are the
  known pre-existing ones; the App.tsx edits here were comment-only).
- **Fader invariant** (`scripts/test-fader-invariant.js`): ✅ **1197 samples, every deck fader exactly
  1.0000**, no panic, across 10 segues + 2 jingle fires.
- **No silent throw:** daemon log clean through the full run; the SCHEDULED path ran every tick without
  error (correctly quiet on non-scheduled queues).
- **Build:** vite ✓, electron-builder ✓ signed → `C:\openair\dist-electron\Ether Setup 4.4.64.exe`
  (`--publish never`).

## Files

```
audiod/engine.js                 _changed +volume; _jingleTick read-ahead; _setScheduled/_clearScheduled; comment fix
src/audio/engine-rodio.ts        resyncDaemonDecks() on connect
src/components/UpNext.tsx        SCHEDULED grey render + comments
src/App.tsx                      comments only (overlay type/handler already state-generic)
docs/help-jingles.md             three-state indicator help
CHANGELOG.md / package.json      4.4.64
scripts/probe-deck-volumes.js    read-only diagnostic (one-shot, no persistence armed)
```

## Validation still owed on install

The **SCHEDULED grey indicator's visual** can only be confirmed by launching with real JIN placements
(the "actual screen" rule) — the gates prove it doesn't crash and doesn't move faders. The running box
won't self-correct a stale fader until it installs 4.4.64 and relaunches (attach-resync fires on connect).

**Status:** built, not installed, nothing committed or pushed.
