---
feature: showplus-renderer
title: Show+ DAW renderer fixes — white at zoom-out, zoom-out floor, fade taper
summary: Three defects in the Show+ canvas. Two root causes proven in the tree and fixed; the white-at-zoom-out cause is fixed at three code-level sources but is RUNTIME-UNVERIFIED — the repro needs Jeff's screen.
audience: programmer
date: 2026-08-16
---

# Show+ DAW renderer fixes — 2026-08-16

Dev mode. `tsc 0 · node --check 446/446 · vitest 332/332`. No bump, no build, no commit.

---

## 0. Two premises in the brief that the tree does not support

Recorded first because both would have sent the fix in the wrong direction.

**"An earlier fix (opaque dark base fills, eb2c9d1) killed one cause — transparent clip fills."**
There are no opaque dark base fills in `eb2c9d1`. That commit changed `WaveformGL.tsx` in four ways:
DPR tracked in state via a self-re-arming `matchMedia` listener, a total-pixel backing-store cap
instead of a ratio cap, standard alpha blending in place of additive, and amplitude-tracking alpha.
The GL canvas still clears **transparent** (`gl.clearColor(0, 0, 0, 0)`, `WaveformGL.tsx:301`) and
the clip body is still a **12%-alpha wash** (`track.color + "1f"`, `StudioPro.tsx:5385`). So
"transparent clip fills" was never the cause that got killed, and nothing was made opaque.

**"Keep the mip cache and dirty-flag discipline from the renderer work."**
Neither existed. There was no mip cache, and the GL draw effect had **no dependency array at all** —
it re-ran on every React render of every clip. This change introduces the first of both: a max-pooled
mip pyramid (`WaveformGL.tsx:227`) and an uploaded-level cache so the texture re-uploads only when
the chosen level actually changes (`:283`).

---

## 1. White at far zoom-out — three code-level sources fixed, **runtime UNVERIFIED**

**I could not run the repro.** Loading a song and zooming to the extreme is a runtime observation and
I have no way to drive the Electron UI. Per the house rule, what follows is what the source proves —
not a claim about what the running app does. **The one check that settles it is Jeff's**, below.

### Source A — unbounded fragment accumulation (fixed at the root)

At far zoom-out a full song is ~10⁵–10⁶ peaks drawn into a clip a few hundred device pixels wide.
The vertex shader emitted **one quad per peak** (`drawArrays(..., s.n * 6)`), so thousands of
fragments landed on a single pixel. Under standard alpha compositing each one composites over the
last and the pixel converges to **fully-opaque tint** — the lane becomes a solid slab with every
transient erased. It converges to the track colour rather than to white, so this alone does not
explain a *white* timeline, but it is the mechanism that makes any bright element saturate.

**Fix:** a max-pooled mip pyramid built once per peak array (`WaveformGL.tsx:227-267`) — each level
is the pairwise MAX of the one below, so decimation preserves peaks instead of averaging them away.
The draw picks the coarsest level carrying ~2 texels per device pixel (`:278-286`) and caps the draw
at **one quad per device pixel** (`:288-290`). Fragments can no longer stack. Redraw cost falls at
zoom-out rather than rising.

### Source B — the selection border on a narrow clip (`StudioPro.tsx:5387`)

A selected region drew `border: 2px solid #fff`. At far zoom-out a clip is 4–10px wide, so a 2px
white border on each side **is** the clip: a solid white block. Below 16px the border is now 1px at
55% white.

### Source C — the smart-tool affordance, a regression from job 2 (`StudioPro.tsx:5463`)

The hover marker painted a `SMART_CORNER_W`-wide (14px) white wedge using the **raw constant**, while
the hit-test used bands clamped to clip width. On a clip narrower than 14px that wedge covered the
whole clip in white — and it triggers *precisely* when ctrl+wheel-zooming out with the pointer resting
on a clip, which is the exact gesture in the report. This shipped in the uncommitted job-2 work an
hour before the report. Markers are now sized from the same clamped bands and are suppressed entirely
below 24px; the cursor still carries the meaning.

### The check that settles it

Reproduce once and read the element, not the pixel: zoom out until it goes white, then in DevTools
hover the white area and report **which element** is painting — `RegionBlock`'s div (border), the
affordance `<svg>`/bar, or the `<canvas>`. If it is the canvas, Source A's cap is the answer and the
colour should now be the track tint, never white. If it is either of the others, B and C already
cover it. **Until that read exists, defect 1 is fixed-in-source and unverified-in-product.**

---

## 2. Zoom-out could not reach whole-song-in-window — root cause found

The floor was **0.25**, in two places, and they disagreed with two others:

| Path | Old floor | `file:line` |
|---|---|---|
| Ctrl+wheel zoom | `Math.max(0.25, …)` | `StudioPro.tsx:3127` (was) |
| Toolbar `−` button | `Math.max(0.25, …)` | `StudioPro.tsx:3735` (was) |
| `+` / `-` keys | `clamp(…, 0.05, 8)` | `StudioPro.tsx:1611` (was) |
| `Z` "zoom to fit" | `clamp((30_000 / end) * 4, 0.05, 8)` | `StudioPro.tsx:1604` (was) |

`BASE_PPS = 80`, so zoom 0.25 is **20 px/s**. A three-minute song is 3,600px wide — it can never fit
a ~1,200px editor. Jeff uses the toolbar and the wheel, both floored at 0.25: zoom-out was not merely
limited, it stopped a factor of ~4 short of the thing he was trying to see.

The `Z` "fit" was not a fit at all — `(30_000 / end) * 4` never consults the editor's width, so it
could only land on a fitting zoom by coincidence.

**New floor math:** `MIN_ZOOM = 0.002` (`StudioPro.tsx:80`) — 0.16 px/s, an hour-long session inside
600px — and all four paths now clamp to the same `MIN_ZOOM`/`MAX_ZOOM` pair.

**Fit-to-window** (`StudioPro.tsx:1243`), on the `\` key, on `Z`, and on a new **FIT** button beside
the zoom controls (`:3737`):

```
zoom = clamp( (editorWidthPx * 1000) / (sessionMs * BASE_PPS), MIN_ZOOM, MAX_ZOOM )
```

The focal point is the **playhead** (session centre when the playhead is at 0), applied as
`scrollLeft = focusX - width/2` on the next frame. When the session fits, scrollLeft naturally
resolves to 0; when it cannot fit even at `MIN_ZOOM`, the view centres on where Jeff was working
instead of snapping to the left edge.

---

## 3. Fades committed but never drew — cause found

`WaveformGL` had **no concept of a fade**. Its props carried cue, intro, outro and tint, and nothing
else; the shader scaled amplitude by `peak * 0.92` and stopped. Every fade in Show+ was drawn as an
SVG decal *on top of* the clip (`StudioPro.tsx:5407-5420`) while the waveform underneath continued to
show full-level audio. The edit was committed to the store and invisible in the medium that matters —
the honest-UI violation named in the brief.

**Fix — the taper is in the audio, not on top of it:**

- Two new props, `fadeInEnd` / `fadeOutStart`, in the renderer's normalized space
  (`WaveformGL.tsx:24-30`), computed per clip from `fadeInMs` / `fadeOutMs` against buffer duration
  (`StudioPro.tsx:5297-5302`).
- The **vertex shader** multiplies amplitude by the same linear gain the mix applies
  (`WaveformGL.tsx:69-82`), so the envelope visibly tapers to nothing at the clip edge.
- The 2D overlay draws the **gain line** and a **hairline at the fade boundary**
  (`WaveformGL.tsx:342-360`) — the Audition read: you can see where the fade ends.
- Undefined bounds collapse to the view edges, which the shader reads as "no fade" — clips without
  fades are bit-identical to before.

No audio behaviour changed. This is render only; the mix already applied these fades.

---

## Acceptance (Jeff's screen)

One continuous gesture: zoom from sample detail out to whole-song-in-window and back — dark at every
frame — then `\` for instant fit, then pull a corner fade and watch the waveform taper under it.

If white still appears at any zoom, the DevTools element read in §1 is the next step, not another
speculative fix.

---

# Round 2 — white appears EARLIER after the fixes (2026-08-16, later)

Jeff's report, verbatim: **white appears EARLIER after the fixes**, and the DevTools picker cannot
resolve anything inside the timeline.

## Finding from the tree — the timeline's background is theme-dependent and two themes are light

The DOM ancestry of the waveform canvas, read out of the source:

| Element | Background | `file:line` |
|---|---|---|
| StudioPro root | `var(--bg-primary)` — **no fallback** | `StudioPro.tsx:3705` |
| Timeline scroll container (editor root) | `var(--bg-primary)` — **no fallback** | `StudioPro.tsx:3970` |
| `TrackLane` | `track.color + "0a"` — **4% alpha**, defers to the ancestor | `StudioPro.tsx:5011` |
| `RegionBlock` clip body | `track.color + "1f"` — 12% alpha | `StudioPro.tsx:5398` |
| GL canvas | cleared **transparent** `(0,0,0,0)` | `WaveformGL.tsx:308` |

Nothing in that chain is opaque and dark. Every one of them defers to `--bg-primary`, and
`--bg-primary` is **not always dark**:

- `.light-theme` → `#f0eeeb` (`index.css:310`)
- `.theme-ether-default` → `#b8bcc4`, commented *"App-wide backgrounds — light polished aluminum"*
  (`index.css:433`) — and the class is applied to `documentElement` as `theme-<presetId>` by
  `SkinPicker.tsx:734`

**Why it got worse after the last round.** The old renderer drew one quad per peak, so at zoom-out
thousands of fragments piled onto each pixel and the lane composited to solid opaque tint. That slab
was *masking* the light ancestor. Capping the draw at one quad per device pixel removed the mask, so
the light background now shows at a shallower zoom. The fix did not create white — it stopped
hiding it. That is a genuine regression in appearance and it points straight at the real cause.

**Status: still a tree finding, not a runtime finding.** The colours decide.

## The diagnostic (temporary — logged in `docs/backlog.md` with its teardown)

`SP_DIAG()` — `StudioPro.tsx:80`, `WaveformGL.tsx:40`. Toggle with **Ctrl+Alt+D** inside the Show+
DAW; a black banner appears with the legend so the run is self-explaining.

| Colour | Layer | `file:line` |
|---|---|---|
| **RED** (opaque clear) | the WebGL canvas | `WaveformGL.tsx:310` |
| **GREEN** | the timeline DOM root | `StudioPro.tsx:3970` |
| **BLUE** (6px frame) | the 2D overlay canvas | `WaveformGL.tsx:337` |
| **MAGENTA** (30%) | a DOM overlay on a clip — border, wedge, handle | `StudioPro.tsx:5398`, `:5478` |

The 2D overlay is a **frame, not a fill**, deliberately: a full blue fill sits on top of the GL
canvas and would hide RED, answering nothing.

**Run it:** open Show+, Ctrl+Alt+D, zoom out to the white point, report the colour.

## Fixes pre-staged against each answer

- **GREEN** → the edit surface stops depending on the theme. A DAW timeline is dark by convention
  even under a light UI skin (Audition, Pro Tools). Set the timeline container and lane surface to
  an explicit dark value rather than `var(--bg-primary)`.
- **RED** → `clearColor(0.05, 0.05, 0.05, 1.0)` with `COLOR_BUFFER_BIT`.
- **BLUE or MAGENTA** → one structural `OVERLAY_VISIBILITY_THRESHOLD_PX = 16` clamp that every clip
  overlay passes through, replacing the two hand-tuned thresholds now in the tree (`regionW < 16`
  on the border, `regionW >= 24` on the affordance).

Whichever lands, the diagnostic flag is stripped in the same change.

---

# Round 3 — the real disease: dead renderer instances over a light ancestry

Jeff's receipts from the diagnostic run, verbatim: **specific WaveformGL instances went white and
stayed dead; pressing C (splice) remounted fresh instances that render correctly; no console
errors; everything red-tinted app-wide and the toggle would not turn off.**

## What actually happened to the diagnostic — it never ran

The Ctrl+Alt+D handler was **unreachable dead code**. Two earlier gates in the same keydown
handler swallow it:

- `StudioPro.tsx:1538` — `(e.ctrlKey || e.metaKey) && e.key === "d"` → `duplicateSelectedRegion()`,
  and it never excludes Alt. **Ctrl+Alt+D duplicated a region.**
- `StudioPro.tsx:1550` — `if (e.ctrlKey || e.metaKey || e.altKey) return;` — a blanket bail.

The diag block sat below both. So the colours never painted, the toggle had no off-path because it
had no on-path, and **every press added another clip to the session**. That is the opposite of
inert instrumentation: it manufactured the very WebGL-context pressure being diagnosed. The
"red-tint app-wide" is not explained by anything in the tree — the flag it depends on can never
have been set from that key — and it is recorded here unexplained rather than rationalised.

## The disease

**Every clip owns its own WebGL context.** `RegionBlock` renders a `WaveformGL`, and `WaveformGL`
calls `getContext("webgl2")` per instance (`WaveformGL.tsx:196`). Browsers cap live WebGL contexts
— Chrome evicts around 16 — and eviction is **silent**: `webglcontextlost` fires, no exception is
thrown, nothing reaches the console, and that canvas never paints again. Nothing in the file
listened for that event. A remount (splice, undo, any key that rebuilds the region list) creates a
fresh context, which is exactly why C "fixed" the dead clips.

A dead canvas paints *nothing*, and everything behind it is theme-dependent (Round 2). Dead
instance + light ancestor = **white**.

## The fixes

**A — structural dark at every layer**

| Layer | Now | `file:line` |
|---|---|---|
| GL clear | `clearColor(0.05, 0.05, 0.05, 1.0)` + `COLOR_BUFFER_BIT` | `WaveformGL.tsx:318` |
| GL canvas element | `background: #0d0d0d` — covers a context that never existed or is gone | `WaveformGL.tsx:398` |
| Timeline container | `SURFACE_DARK`, never `var(--bg-primary)` | `StudioPro.tsx:3966` |
| Track lane | track wash composited **on** `SURFACE_DARK` | `StudioPro.tsx:5007` |

Consequence worth naming: the clip body's 12% track-colour wash no longer shows through the
waveform canvas, because the canvas is opaque now. Track identity still reads from the waveform
tint and the clip border.

**B — silent instance death is handled**

`webglcontextlost` / `webglcontextrestored` handlers at `WaveformGL.tsx:191-205`. Lost calls
`preventDefault()` (without it the context can never be restored), drops `st.current`, invalidates
the uploaded-mip cache and bumps `glEpoch`; restored re-runs the init effect, which rebuilds
program, VAO and texture and forces a re-upload. Init is keyed on `[glEpoch]` (`:251`) instead of
`[]`, so it is genuinely re-entrant. The draw effect additionally refuses to touch a lost context
(`:300`). **Invariant: no bail path leaves the instance painting nothing — if it cannot paint the
waveform, it paints dark.**

**C — diagnostic stripped**

Flag, toggle, colour tinting, banner and `diagTick` all removed from both files; grep confirms zero
residual references. Backlog entry marked TORN DOWN with the shortcut-collision lesson.

**D — one structural overlay threshold**

`OVERLAY_VISIBILITY_THRESHOLD_PX = 16` (`StudioPro.tsx:773`) replaces the two hand-tuned numbers
(`regionW < 16` on the border, `regionW >= 24` on the affordance). Every clip overlay passes through
it and renders nothing below it.

## Not built, deliberately

**A shared/pooled WebGL context across clips.** Context loss is now *recovered*, but the cap is
still one context per clip, so a large session will still churn. The correct fix is one context (or
a small pool) rendering every clip, which is an architectural change to the renderer, not a defect
fix — it belongs with the phase (c) renderer work in `docs/show-daw-redesign-2026-08-16.md`.
