---
feature: show-daw
title: Show+ DAW (StudioPro) — the Pro Tools / Audition pass
summary: What an Avid or Audition engineer hits first in the Show+ DAW (icons, workflow, no batch fades, a session that does not keep cuts and edits), measured from the tree, and a phased proposal.
audience: programmer
status: PROPOSAL — investigation only, no code written
---

# Show+ DAW — the Pro Tools / Audition pass (2026-10-19)

**Investigation only. Nothing changed.** Every line number is from `src/components/StudioPro.tsx` on `sched/one-scheduler`
(8,141 lines) unless another file is named. Static reads — every claim about what the running app *does* is marked
**UNVERIFIED** with the check that settles it.

## 0. Jeff's report (verbatim, 2026-10-19)

> "next the show DAW it feels very intermediate we need to avid engineers to approve the first thing i noticed is
> unrecognizable icons, workflow and no batch fades. also a session save that recognizes cuts and edit"
>
> "both audition and pro tools are good references"

The bar: **an Avid (Pro Tools) engineer, or an Audition engineer, sits down and approves it.** Four named defects:

1. **Unrecognizable icons**
2. **Workflow**
3. **No batch fades**
4. **No session save that recognizes cuts and edits**

## 1. What changed since the 08-16 design (`docs/show-daw-redesign-2026-08-16.md`)

That doc's Phase 1 (visual sweep) has largely landed: today non-zero `borderRadius` = **0** (was 22), `var(--t|s|r|e-*)`
tokens = **231** (was 0), hard-coded px `fontSize` = **5** (was 159). `boxShadow` = **36** (was 35 — not swept).
Shipped since: DAW shell + bottom TransportBar + MixerStrips (eb2c9d1), Audition-grade waveform (163182a, d705b08,
6825cd9), a Smart tool with V/G/C/T/F keys (460369e, b74a2f6).

So "intermediate" today is **not** the styling. It is the four items above. The 08-16 doc was measured against Audition
only; this pass adds Pro Tools as an equal reference (Jeff).

## 2. Findings

### 2.1 Icons — ~25 controls are a bare glyph or emoji

| Where | Bare faces (line) | Problem for a PT/Audition engineer |
|---|---|---|
| Top toolbar | `↻` loop :3849, `♩` click :3859, `▦` grid :3860, `−`/`+` zoom, `📸` snapshots :3882, `💾` save :3945, `📂` load :3946 | Emoji (`📸💾📂`) render as colour cartoons, platform-dependent; `▦`/`♩` are not any DAW's icons |
| Transport (TransportBar :6152-6166) | `⏮ ⏹ ▶/⏸ ⏺ ●/◼ ⏭` | **Two record buttons side by side**: `⏺` = global arm, `●` = record. Both read "record". PT has one transport Record + per-track rec-enable |
| Tool row (:3968-3973) | `✦` Smart, `⌖` Select, `✋` Grab, I-beam SVG **Splice**, `⊢⊣` Trim, `⌒` Fade | **The I-beam is on Splice.** In Pro Tools and Audition the I-beam *is* the Selector (time selection). A PT engineer reads our I-beam as "select" and cuts the clip instead. `⌖` (our Select) is a crosshair — no DAW uses that for select |
| Track header (:4854-4903) | `A`, `M`, `S`, `⏺`, `🛡`, `×`, colour swatch — **no `title` on any `MiniBtn`** (:5049) | M/S/rec are standard; `A` (automation) and `🛡` (original content) are not, and nothing says what they are |
| Mixer (:6035-6038), Inspector (:6305) | `M`, `S`, `⏺` with no tooltip | |

Wrong or stale labels found on the way (each a one-liner):
- Track menu says **"Toggle mute (M)"** (:3810); `M` drops a marker (:1781).
- Transport `⏸` tooltip says **"Pause"**, the handler calls `stop()` (:6154).
- Record's error status says **"Toggle ⏺ in toolbar"** — `⏺` is in the transport, not the toolbar.
- `?` keyboard overlay (:7577) omits S, Home/End, `,`/`.`, `\`, Z, +/−, 1–9, Ctrl+Shift+S.
- Editor drawer EQ tab says "10-band", track FX says "7-Band EQ".

### 2.2 Workflow — where PT/Audition muscle memory breaks

| PT / Audition expects | Ours | Receipt |
|---|---|---|
| **Selector drags a time range, across tracks** (PT F7, Audition Time Selection) | Select (V) only places the playhead; a ruler drag sets the **loop** range, not a selection | :3969, `onRulerMouseDown` :3277 |
| Marquee / range select many clips on many tracks | Multi-select is **one track only** (Shift/Ctrl-click); clicking another track resets it | `multiSel` :978, `handleRegionSelect` :1269-1281 |
| **B = Separate Clip** at selection/playhead (PT); Ctrl+K split (Audition) | `S` splits the single selected clip at the playhead; `C` picks the Splice tool | :1585, b74a2f6 |
| Copy / delete / move / fade act on the whole selection | Act on `selection.regionId` only; clipboard holds one region | :1637-1660, :1703-1708, :304 |
| Tool keys F6–F10 (PT) | V / G / C / T / F | :1804 |
| Undo covers everything | Markers not covered; editor-drawer fade drags and inspector clip-gain fader write **one history entry per mousemove** (no begin/endGesture) | :1529-1581, :5308-5316, :6326 |
| A send that sounds like the timeline | **Every "send" ignores fades** — `sendToDeck` :2980-3003 connects `src → trackGain` with no clip gain or fade; `renderMixOffline` :3366 (used by Norm) has clip gain, no fades | |

**Top-toolbar "To Deck ▾" (`sendToDeck` :2980) dispatches `ether:deck-load`; no listener for it exists in `src`**
(the only other hit is a second dispatch at `VoiceTracker.tsx:749`). Per the code it does nothing. Runtime
**UNVERIFIED** — check: put a clip on a track, To Deck ▾ → Deck A, look at Deck A. (The **Editor drawer's** `→ Deck`
in `StudioSendBar` is a different, real path — `deckCue`/`loadToDeck`.)

### 2.3 Fades — per clip, by hand, one shape

- Model: `StudioRegion.fadeInMs` / `fadeOutMs` (:150-161). **No shape field.**
- Made by: Smart-tool corners, Fade tool (F) edges, Alt+edge-trim, editor-drawer dots. Inspector shows fades read-only
  (:6321). **No fade dialog, no fade item in any menu.** One clip at a time.
- Shape: one hard-coded `exponentialRampToValueAtTime` from 0.0001. The waveform draws a **linear** taper
  (`WaveformGL.tsx:121-125`) and the overlay a straight wedge (:5675) — **what you see is not what you hear**.
- Crossfades: two independent per-clip fades kept equal (`AUTO_CROSSFADE` :749-762, auto effect :1117-1154). No crossfade
  object, no equal-power curve — an exponential-in/exponential-out crossfade dips in the middle.
- The fade maths is **copied three times**: playback `buildAndStart` :2028-2066, mix export :2634-2656, stem export
  :2786-2801.
- **Batch fades: none.** No apply-to-selection for fades or clip gain anywhere.

### 2.4 Session save — does not keep cuts and edits

Three save paths, two different serializers, all non-destructive in *shape* (clip = source file + offset + trims + fades):

| Path | Trigger | Where | Notes |
|---|---|---|---|
| Save to disk | `💾` :3945 (no shortcut) | JSON via `ether.fs.writeFile` | **No main handler for `fs:writeFile`** (only `preload.js:316`; already in `docs/backlog.md` honest-UI list). Falls back to a browser blob download. Missing `clipGainDb` and markers |
| Save version | Ctrl+Shift+S, Hist ▾ | `studio_session_versions` | Has markers + clip gain, missing loop + flags. **Serializers have drifted** |
| Autosave | every 5 min | `localStorage["studiopro_autosave"]` + an "Auto-save" version | localStorage key is **write-only** — nothing reads it back |

**Cuts and edits do not survive a save → reopen (per the code):**
- **Split** (`splitRegion` :1585, reducer :658-671) copies samples into two new buffers and sets both halves to the
  *original* `filePath` with `trimStartMs: 0, trimEndMs: 0`. On reload each half loads the **whole source file**. Two
  full overlapping copies.
- **Merge** (:1285-1323) concatenates into a new buffer, keeps the first clip's `filePath`, trims 0 → reloads as the
  first source, whole.
- **Recordings** (`blob:` :2423) and **file-picker / drag-drop imports** (`URL.createObjectURL` :3428, :3223) are
  `blob:` → **dropped on save** (:2857-2861).
- **Library drops** are stored as `file:///path` and reloaded through `convertFileSrc` again → `file:///file:///…` →
  fetch fails → **clip silently skipped** (:3213, :2939, :2949-2951).
- **Load from disk:** `dialog:openFile` returns an array (`main.js:7422`), the loader expects a string (:2910) → returns
  silently. `fs:readFile` returns `{data,error}` capped at 256 KB; the loader treats it as bytes (:2913).
- **`sessionId` is a new uuid on every mount** (:1042, never set) → every reopen is a new `studio_sessions` row; earlier
  versions and notes are unreachable. **No open/recent-sessions list** (no `SELECT … FROM studio_sessions` anywhere).
- **Dirty state** = "has any clip" (:1502), not "changed since save". The `studio:set-dirty` IPC is `ipcMain.on` vs a
  renderer `invoke` → the close guard never fires (`main.js:8695-8702`, already in `docs/backlog.md:573-590`).
- `version: 1` is written, never read; no migration.

Runtime **UNVERIFIED** for the whole of 2.4 — the one check: import a file, split it, save (`💾`), close Show+, reopen,
load (`📂`). Per the code the load does nothing; if it loads, the split comes back as two full copies.

## 3. Proposal

Ordered by what blocks an engineer's approval. **Session first**: batch fades and new tools are wasted if the work
cannot be saved.

### Phase A — A session that keeps every cut and edit (PT session model)

- **A session is a folder** (Pro Tools model): `<Session Name>/<Session Name>.ethersession` + `Audio Files/`.
  Every import, recording and consolidated clip is **copied/written into `Audio Files/`** at the moment it enters the
  session — nothing is ever `blob:`. Clips reference files *relative to the session*, so the folder moves as one.
- **Cuts are edits, not new audio.** Split = two clip records on the same source file with real `trimStartMs` /
  `trimEndMs` (no sample copy). Merge becomes **Consolidate** (PT/Audition name): renders one new file into
  `Audio Files/`. Buffers are shared per source file, not per clip.
- **One serializer** for save, save-as, autosave and versions. Saves everything: clips (source, offset, trims, fades +
  shapes, clip gain), tracks, markers, loop, flags, master, mixer snapshots. `version` is read; v1 sessions migrate on
  open.
- **Ctrl+S Save / Ctrl+Shift+S Save As / Ctrl+O Open / recent sessions** list; stable session id; title shows `*` when
  changed since last save; close guard fixed (`ipcMain.handle`).
- **Missing files are counted and named on open** (PT's "missing files" dialog), never silently skipped. Relink = later.
- Writes ride the verified `ffmpeg.writeAudio` path for audio and a new, path-checked `fs:writeFile` handler for the
  session file (scoped to the session folder).
- Help: `docs/help-studiopro-sessions.md`.

### Phase B — Batch fades (PT Fades dialog, Audition fade presets)

- **Selection first:** the Selector (I-beam) drags a **time range across tracks**; Shift/Ctrl-click and marquee select
  clips **on any track**. Copy / delete / move / clip gain act on the whole selection.
- **Fades dialog — Ctrl+F** (PT's key): applies to every selected clip / boundary at once: fade-ins, fade-outs,
  crossfades where clips meet. Length + **shape** (Linear, Exponential, Logarithmic, S-curve; crossfades Equal Power /
  Equal Gain). Also on the clip right-click menu.
- **One fade function** used by playback, mix export, stem export, every send, Norm, the editor drawer and the waveform
  drawing — removes the three copies, makes the send match the timeline, and makes the drawn fade the heard fade.
- Existing sessions sound unchanged: their fades load with today's exponential shape.
- Help: `docs/help-studiopro-fades.md`.

### Phase C — Icons and workflow an engineer recognises

- **One SVG icon set**, drawn to DAW convention, no emoji: Selector = I-beam, Grabber = hand, Trimmer = bracket, Smart =
  the PT combined glyph, Separate = blade, Fade = fade curve. Transport: standard ⏮ ⏹ ▶ ⏺ ⏭ drawn as SVG.
  **One Record** on the transport + per-track rec-enable (the global arm merges into it).
- **Every control has a label or a tooltip naming its shortcut** — no bare glyph without one.
- **Pro Tools key map available** (F6–F10 tools, B separate, Ctrl+F fades, Ctrl+E consolidate…), alongside today's keys.
- The wrong labels in 2.1 fixed; `?` overlay generated from the one key handler so it cannot go stale.
- Undo covers markers; the drawer and clip-gain drags become one entry each.
- Help: update `docs/help-smart-tool.md`, `docs/help-studiopro-chop-send.md`.

### The approval test (how we know it passed)

A written script an Avid or Audition engineer runs cold, no explanation: import two files, cut a section out, drag a
range over three tracks, apply crossfades to all boundaries with one dialog, save, quit, reopen — everything is where
they left it and sounds the same; bounce; send to Deck A. Every step done by recognition alone.

## 4. Decisions for Jeff

1. **Order** — A (session) → B (batch fades) → C (icons/workflow)? Or C first because icons are the first thing seen?
2. **Where sessions live** — a folder the user picks (PT model, default `Documents\Ether Sessions\`), and/or synced to
   the account through R2 so a session opens on any computer (the account-is-everything rule)?
3. **Key map** — Pro Tools keys **added** alongside today's V/G/C/T/F, or a switch in Preferences (Ether / Pro Tools /
   Audition)?
4. **Global record arm** — merge it into the transport Record (PT model)?
5. **Top-toolbar "To Deck ▾"** — wire it onto the real deck-load path (same as the send bar), or remove it?
6. **Default fade shape** for new fades (no hidden defaults) — the dialog remembers the last used; what is the first?

### Jeff's rulings (2026-10-19, verbatim)

> "1 yes 2. yes user would pick in the browser window when saving. 3.lets go with pro tools but not mention it.
> 4. Don't merge the record buttons. Track record-arm on each track, one Record in the transport, laid out and drawn
> like Pro Tools so they can't be confused. 5. Wire top-toolbar To Deck to the real deck-load path. 6. Default fade
> shape is a Preferences setting. Phase 2 uses one fade calculation everywhere so playback, export, send-to-deck and the
> drawn fade all match. Start Phase 1 (session)."

1. Order A (session) → B (batch fades) → C (icons/workflow).
2. Sessions are folders; **the user picks where in the save dialog** when saving. ("yes" to account sync as well —
   built as its own slice after the local session works; see the Phase A build report.)
3. Pro Tools key map — **the UI never names Pro Tools.**
4. Record buttons stay separate: per-track record-arm + one transport Record, drawn and laid out so they cannot be
   confused.
5. Top-toolbar To Deck → wired onto the real deck-load path.
7. **(Jeff, 2026-10-19, verbatim): "All icons and graphics must be original Ether artwork. Follow Pro Tools/Audition
   conventions, but never copy their icons, images or code."** Binding on Phase C: conventions (placement, meaning,
   keys) yes; their icon art, images, code — never. Every glyph is drawn for Ether.
6. Default fade shape = a Preferences setting. Phase B: one fade calculation for playback, export, send-to-deck and the
   drawn fade.

## 5. Architecture compliance

- **Governing docs read:** `CLAUDE.md` "Imaging & production surfaces" (StudioPro is the single production surface;
  no new standalone editor — this proposal adds none); `docs/show-daw-redesign-2026-08-16.md` (builds on it, §1 records
  what of it shipped); `docs/backlog.md` honest-UI list (the dead `fs:writeFile` and close guard are already logged
  there — Phase A closes them for StudioPro).
- **One region engine:** `src/audio/silenceRegions.ts` is used only by `ReelSplitter.tsx:10`; StudioPro does not use it.
  The CLAUDE.md claim that the region engine is shared between the push-up and the DAW is **not true of the tree today**.
  Phase A's clip model is where that sharing would land — **surfaced, not decided**.
- **Honest UI:** the dead "To Deck ▾" and the send-ignores-fades are named, not built over.
- **Nothing built, nothing changed.**
