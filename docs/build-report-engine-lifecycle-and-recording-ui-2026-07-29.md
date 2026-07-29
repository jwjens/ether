# Build report — engine stop/dispose + Show+ recording UI honesty

**Date:** 2026-07-29 · **Files:** `src/audio/engine-rodio.ts`, `src/App.tsx`,
`src/components/VideoEngine/VideoEnginePanel.tsx` · **Status:** built + typechecked.
**No bump, no commit, no build.** Awaiting GO.

Two independent pieces of work, both authorised in this session.

---

# PART A — one live engine at a time

## The hazard this closes

The HOP 4 fix (`558bc88`) started every active station's engine, but `AudioEngine` had **no teardown at all** — no
`clearInterval(this.pollTimer)` anywhere in `engine-rodio.ts`. Visiting N stations therefore left N poll timers
running for the session. In daemon mode that is only untidy; in the **in-process fallback** it is a rotation hazard,
because every initialised engine runs end-detection in `poll()` against the single global native engine, so two of
them detect the same track end and both advance.

## `AudioEngine.stop()` — `engine-rodio.ts:156-186`

```js
stop() {
  if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }   // :177
  for (const off of this.daemonUnsub) { try { off(); } catch {} }                 // :178
  this.daemonUnsub = [];                                                          // :179
  this.daemonDetectStarted = false;   // a later init() re-attaches cleanly       // :181
}
```

It releases exactly what `init()` started, using the `daemonUnsub` closures the engine already collects
(`:193`, `:212`, `:218` — `offQueue`/`offDeck`/`offPlayStart`, backed by `preload.js:38,40,42`). Idempotent, safe
before `init()`, and it touches **no deck state, no queue, nothing the daemon owns** — it stops the renderer's
mirror, never playout.

`hasPlayingDeck()` (`:189-193`) reports whether any music deck is playing, for the safety rule below.

## Stopping the engine being left — `src/App.tsx:1513-1531`

The display-subscription effect is keyed `[engine]`, so its cleanup runs exactly when the active station changes:

```js
const leaving = engine;
return () => {
  unsub();
  if (leaving.isDaemonDriven || !leaving.hasPlayingDeck()) leaving.stop();
};
```

**The condition is the load-bearing part.** In daemon mode the daemon owns playout and this engine is a mirror, so
stopping it cannot affect air. In the **in-process fallback the renderer engine IS the playout driver** — stopping an
engine with a playing deck would silence an airing station. Tidying a timer is never worth dead air, so an airing
in-process engine is left running and the (pre-existing) accumulation is accepted for that case only.

Net effect in the production path: switch stations any number of times and exactly one initialised, subscribed engine
is live — the active one. No accumulation, no two engines advancing.

## What this does and does not claim about the decay

**It removes accumulation and the double-advance path.** That is real and worth having.

**It is not proven to be the "works then dies after minutes" cause**, and I want that on the record rather than
discovered later. In **daemon mode** — the production path — `poll()` returns early before end-detection
(`"daemon owns end-detection + advance"`), so two mirrors do not fight; accumulation there is cost, not corruption.
A decay observed on a daemon-driven machine therefore has a suspect this patch does not touch: the **daemon deck-event
subscription going quiet for that station**. If deck events stop while `status` is still `"playing"`, `poll()` keeps
advancing `positionSec` locally until it clamps at `durationSec`, which looks exactly like "the countdown worked, then
froze" while NOW PLAYING — fed by a different channel — keeps updating.

**The check that separates them:** when it dies again, note whether the console shows daemon deck events still
arriving for that station. Events still flowing → the fault is renderer-side and this patch is the right area.
Events stopped → the fault is the daemon subscription/connection, and the next fix is there.

---

# PART B — Show+ recording UI (feedback + wording only)

The pipeline is untouched: no change to `buildRecorder`, `startRecording`, or anything in `VideoEngineContext.tsx`.

## The picker chooses a FILE, not a folder — confirmed

```
VideoEnginePanel.tsx:124-135   ether.invoke("dialog:saveFile", { defaultPath: `recording_${Date.now()}.mp4`,
                                                                 filters: [{ name: "Video", extensions: ["mp4"] }] })
electron/main.js:3322-3325     ipcMain.handle("dialog:saveFile", …) → dialog.showSaveDialog(…) → result.filePath
```

`showSaveDialog` returns a **full file path including the name**, and `startRecording` passes it straight through as
`filePath` (`VideoEngineContext.tsx:747`). So the wording is **"destination file"**, matching what actually happens —
not "folder".

**What a folder-based flow would take, if you want it:** a folder picker already exists —
`dialog:openDirectory` (`electron/main.js:3316-3320`, `showOpenDialog` with `properties:["openDirectory"]`). The
change would be: pick a folder once, store it, and have `startRecording` compose `<folder>/recording_<timestamp>.mp4`
per session. That is a change to the recording pipeline's input contract (`VideoEngineContext.tsx:744-750`), which
this build was told not to touch. Not built.

## The three changes

| # | Where | What |
|---|---|---|
| 1 | `VideoEnginePanel.tsx:589-596` | Instruction line above the button. No path → amber **"First choose a destination file — click … above to pick where the recording is saved."** Path chosen → **"Recording to `<path>`"** in monospace. The requirement is stated before the click, not discovered by clicking |
| 2 | `VideoEnginePanel.tsx:600-607` | Start Recording is **`disabled={!recordPath}`**, with a `title` explaining why. The guard in `VideoEngineContext.tsx:744` is unchanged — this stops the operator clicking into it and seeing nothing |
| 3 | `VideoEnginePanel.tsx:625-630` | The notice: ~~"Phase 0 — video-only. Audio routing arrives in Phase 4."~~ → **"Records program video with one source's audio — full audio mixing not available yet."** |

`Btn` gained a `disabled` prop (`VideoEnginePanel.tsx:672-696`): greyed background, `cursor: not-allowed`, 0.55
opacity, and the real HTML `disabled` attribute so the click cannot fire.

The new wording is what `buildRecorder` actually does (`VideoEngineContext.tsx:646-664`): the composited canvas video
plus **the first audio track it finds among the sources**, then `break`. Not silent, not a mix — and the sentence
claims neither.

Source-comment phase references (`VideoEnginePanel.tsx:1`, `VideoEngineCanvas.tsx:1`, `VideoEngineContext.tsx:1,11,663`)
are left alone as instructed; none is user-visible.

---

## Typecheck

```
$ npx tsc --noEmit
src/components/OnboardingFlow.tsx(2039,42): error TS2366: …
src/components/PhoneDesk.tsx(777,21): error TS2345: …
```

**PASS — the 2 standing baseline errors only. Zero new, none in the three files touched.**

## Architecture compliance

- **"A station is a shell over one implementation."** Part A makes the *lifecycle* identical too: every station's
  engine is started the same way and released the same way. No station accumulates state another does not.
- **`CLAUDE.md` — "Physical deck positions are sacred … Esc never kills audio."** The stop condition exists precisely
  to honour this: an engine driving audio is never stopped.
- **`CLAUDE.md` — "BUILD THE SENSE."** Part B replaces a quiet `err` string with a stated precondition and a disabled
  control, and replaces a build-phase label with what the feature actually records.
- **`CLAUDE.md` — "Correct minimal solution … name what you're NOT building."** Not built: folder-based recording
  paths, the daemon-subscription liveness question in Part A's caveat, popout-renderer engine init, and the
  ConsoleStrip re-arm key.

## Verification (runtime — not claimed here)

**Part A:** switch across all four stations repeatedly; each should show a live sweep and a ticking countdown, and it
should stay live. If a station dies after minutes again, capture whether daemon deck events are still arriving —
that decides renderer vs daemon per the caveat above.

**Part B:** open Show+ → ENGINE → RECORDING. With no file chosen the button is greyed and unclickable with the amber
line above it; after choosing a file the line becomes "Recording to …" and the button enables.
