# Show+ engine panel — "Start Recording", and the "Phase 4" notice

**Date:** 2026-07-29 · **Mode:** READ-ONLY. No edits, nothing fixed.
Treated as two separate questions until the evidence joined them — it does not.

---

## Headline

**They are independent.** The recording button's most likely failure is a **missing output path**, which the code
guards on before it does anything else. The "Phase 0 / Phase 4" notice describes a real *audio* limitation of what
gets recorded — it does not disable the button.

**And the button is not silent.** Every failure path writes to `err`, which the panel renders
(`VideoEnginePanel.tsx:156-161`). If clicking appears to do nothing, the message is on screen — small, in the panel's
error block — or the click never reached the handler at all.

---

## 1. What "Start Recording" does on click

```
VideoEnginePanel.tsx:592   <Btn red onClick={startRecording}>● Start Recording</Btn>
  → VideoEngineContext.tsx:743  const startRecording = useCallback(async () => {
```

The handler, in order (`VideoEngineContext.tsx:743-758`):

| Step | Line | What |
|---|---|---|
| **Path guard** | `:744` | `if (!recordPath) { setErr("Choose recording path first."); return; }` — **returns before anything else happens** |
| Spawn the writer | `:746-750` | `ether.video.startRecording({filePath, fps, bitrate_kbps, keyframe_interval, codec})` → `video:start-recording` |
| Build the MediaRecorder | `:751-753` | `buildRecorder(chunk => ether.video.pushChunk(chunk))` |
| Bail if no recorder | `:754` | `if (!rec) { await ether.video.stopRecording(); return; }` |
| Arm | `:755-756` | keep the recorder in a ref, clear the error |

**`recordPath` starts empty** — `useState<string>("")` (`VideoEngineContext.tsx:344`). It is only set by the path
picker in the panel (`VideoEnginePanel.tsx:124-135`: a save dialog, falling back to `prompt("Recording file path:")`).
**So on a fresh panel, with no path chosen, the first click can only ever hit the `:744` guard and return.**

**The main-process side is present and wired**, so this is not a missing handler:

```
electron/preload.js:225        startRecording → invoke("video:start-recording")
electron/preload.js:227        pushChunk      → invoke("video:chunk")
electron/video-engine.js:335   ipcMain.handle("video:start-recording", …) → spawnSink("record", `MP4 → …`, args)
electron/video-engine.js:348   ipcMain.handle("video:chunk", …) → pushChunk
electron/main.js:4334-4336     require("./video-engine.js").installVideoEngine(ipcMain, { ffmpegBin })
```

## 2. Silent or loud?

**Not silent — but quiet.** Every failure sets `err`, and the panel renders it:

```
VideoEnginePanel.tsx:45     const { … err, setErr } = useVideoEngine();
VideoEnginePanel.tsx:156    {err && (
VideoEnginePanel.tsx:161      {err}
```

The four messages reachable from a click:

| Message | Line | Cause |
|---|---|---|
| `Choose recording path first.` | `Context:744` | No output path selected |
| `Canvas capture stream not ready yet.` | `Context:648` | `captureStreamRef` unset — the compositor canvas has not registered its capture stream |
| `Start record: <error>` | `Context:757` | The IPC threw — e.g. `ffmpeg-static not available` (`video-engine.js:337`) |
| `Stop record: <error>` | `Context:764` | Stop path threw |

**There is no `console.log`/`console.error` anywhere in this path** — nothing is written to DevTools. So the only
evidence is the on-screen `err` block. That is the honest-state weakness here: a failure that is rendered in one
small area and nowhere else reads as "the button does nothing."

**UNKNOWN without a runtime look:** which of the four messages is actually showing. The check that settles it —
click Start Recording and read the error block in the ENGINE panel (it sits just under the status LEDs at
`VideoEnginePanel.tsx:156`).

## 3. Related to the "Phase 4 / video-only" notice? **No.**

The notice is at **`VideoEnginePanel.tsx:611`**:

> `Phase 0 — video-only. Audio routing arrives in Phase 4.`

What it actually describes is `buildRecorder` (`VideoEngineContext.tsx:646-664`):

```js
const combined = new MediaStream();
videoStream.getVideoTracks().forEach(t => combined.addTrack(t));   // :654  canvas video
for (const src of sources) {                                        // :656
  const at = src.stream.getAudioTracks();
  if (at.length > 0) { combined.addTrack(at[0]); break; }           // :660  ONE audio track, first found
}
```

So a recording gets **the composited canvas video plus at most one source's audio track** — the first source that
happens to have one — rather than a mix of all sources. That is a real limitation of *what is captured*. **It does
not gate the button**: `buildRecorder` returns a recorder whether or not it found audio (`audioFound` is only used
for the codec choice), and the only `null` return is the canvas-not-ready case at `:648`.

**Independent.** The button would behave exactly the same if the audio routing were finished.

## 4. What exactly happens

Three distinct outcomes, and which one you are seeing depends on state I cannot read statically:

| State | Outcome |
|---|---|
| **No path chosen** (default) | Nothing starts. `err` = "Choose recording path first." No file, no ffmpeg process, no console line. **Most likely what you are hitting.** |
| Path chosen, canvas capture not registered | `video:start-recording` **does** spawn ffmpeg, then `buildRecorder` returns null, so `stopRecording()` is called immediately (`:754`). Net effect: a file may be created and instantly closed — **an empty or zero-frame MP4** |
| Path chosen, everything ready | Recording starts; `status.recording` becomes true because `getStatus` reports `sinks.has("record")` (`video-engine.js:281`), polled every 500 ms (`Context:428-445`), and the button flips to "◼ Stop Recording" (`VideoEnginePanel.tsx:589-592`) |

**The button label is the tell.** It is driven by `isRecording = !!status?.recording` (`VideoEnginePanel.tsx:139`),
which reflects a *real ffmpeg sink in the main process*, not renderer optimism. If it never changes to "Stop
Recording", no sink was spawned — which points at row 1 or 3, not at a half-started recording.

---

## Other internal/dev language in the same panel — flagged, not fixed

| Where | String |
|---|---|
| `VideoEnginePanel.tsx:611` | **"Phase 0 — video-only. Audio routing arrives in Phase 4."** — the one you spotted. "Phase 0"/"Phase 4" are build-plan terms with no meaning to an operator |
| `VideoEnginePanel.tsx:1` | `// VideoEnginePanel.tsx — Phase 0 right-sidebar.` (comment, not user-visible) |
| `VideoEngineCanvas.tsx:1` | `// VideoEngineCanvas.tsx — Phase 0 main-area preview.` (comment) |
| `VideoEngineContext.tsx:1, :11, :663` | Phase 0 / Phase 4 references (comments) |

**Only `:611` is user-visible.** The rest are source comments and harmless. I did not find other operator-facing
phase/dev language in that panel — the neighbouring status text ("Idle — no active sinks", the LED labels) is plain.

For when the fix is authorised: what is *true* today is that a recording captures the composited video plus at most
one source's audio. "Recording captures video only" would understate it slightly; something like *"Records the
program video with one source's audio — full audio mixing isn't available yet"* is accurate. Not changed here.

## Scope note

Read-only. No file modified, nothing committed, nothing built. No fix applied to either the notice or the recording
path.
