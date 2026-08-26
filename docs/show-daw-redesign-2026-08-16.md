---
feature: show-daw
title: Show+ DAW (StudioPro) — redesign toward Audition-class
summary: Inventory of what StudioPro already is, what it is missing against Adobe Audition, and a phased plan to make it dense, flat and keyboard-first without touching the audio graph.
audience: programmer
status: DESIGN ONLY — no code written
---

# Show+ DAW (StudioPro) — redesign (2026-08-16)

**Design only. Nothing built.** Every number below is measured from the tree, not estimated.

---

## 0. The headline the brief gets wrong, in our favour

The brief describes the UI as "intermediate: bubbly, spacious, web-app feel". That is accurate, and
the reason is precise and worth naming: **the 4.4.218 visual pass never reached this file.**

| Measured in `src/components/StudioPro.tsx` (7,280 lines) | |
|---|---|
| non-zero `borderRadius` | **22** |
| `boxShadow` uses | **35** |
| hard-coded px `fontSize` | **159** |
| `fontSize` ≥ 16px | **6** |
| uses of `--t-*` / `--s-*` / `--r-*` tokens | **0** |

Zero token adoption. The Schedule Manager pass converted 341 font sizes, 29 radii and 6 shadows
across eleven files; **StudioPro was explicitly out of scope** (`schedule-manager-v2-design`
§3.2 named "StudioPro's 35 shadows" as a separate cosmetic pass with its own risk — that count is
still exactly 35, so nothing has drifted since).

**So the visual half of this brief is a known, scoped, already-costed sweep — not a redesign.** That
matters enormously for effort: Phase 1 below is mechanical and provably safe, because the identical
codemod has already run successfully on eleven other files.

---

## 1. Inventory — what StudioPro already is

This is not a toy. Measured component inventory from the file:

### 1.1 Architecture
- Single 7,280-line component with a **reducer** (`reducer(s, a)` at `:562`) — state is already
  centralised and action-based, which is what makes the layout changes below cheap.
- `StudioEditor.tsx` (869 lines) — the single-clip editor
- `StudioSendBar.tsx` (115 lines) — the Ether exits
- `AIVoiceStudio.tsx` (546 lines) — TTS surface

### 1.2 Editing model
| Piece | Receipt |
|---|---|
| Tracks / regions / offsets | `newTrack :320`, `newRegion :310`, `regionDurMs :299` |
| Automation lanes with interpolation | `interpolateLane :343`, `AutomationLaneView :5074` |
| Peak extraction for waveforms | `extractPeaks :421` (resolution 2000) |
| WAV encode / export | `encodeWav :436` |
| Live recording overlay | `LiveRecordingOverlay :5028` |
| Beat grid + ruler | `Ruler :4538`, `BeatGrid :4573` |
| Markers | keyboard `M` at `:1455` |

### 1.3 DSP already shipped
| Effect | Receipt |
|---|---|
| 10-band EQ (±12 dB, 31 Hz–16 kHz) | `EQ_FREQS :84`, `EQ_BANDS :86`, `EQ_DB_RANGE :87` |
| Compressor + live curve display | `TrackCompressor :137`, `CompressorCurve :6294` |
| Convolution reverb, 4 IR types, generated | `makeReverbIR :361`, `ReverbType :91` |
| Saturation (curve-generated) | `makeSatCurve :409`, `TrackSaturation :153` |
| Master limiter | `limiterEnabled :814` |
| Spectrum analyser | `SpectrumAnalyzer :4209` |
| Presets, per-effect, user-extensible | `usePresets :5695`, `EQ_PRESETS :5727`, `COMP_PRESETS :5736`, `REVERB_PRESETS :5744` |
| Master FX chain | `MasterFxWindow :5817` |
| Stem + mix export, watermarking | `ExportMenu :5674`, `ExportWatermarkDialog :5569` |

### 1.4 Ether integration — already real, and the differentiator
`StudioSendBar.tsx` sends a finished region to:
- **A real deck** via the actual deck-load path — `deckCue` / `loadToDeck`, the same call the
  Library A/B/C buttons use (`:61-66`), with a refusal if the deck is on air (`:64`)
- **Jingles / Sweepers** pools by content class (`:92`)

That is the honest-UI principle already honoured: send-to-deck rides the real path or is omitted.
**Audition cannot do this at all.** It is the one axis where we are not catching up.

### 1.5 What is genuinely missing (the brief's list, confirmed)
Grep confirms **no** clip-gain envelope, **no** time-stretch/pitch-shift, **no** noise reduction, and
**no** VST host. All four absent.

---

## 2. Competitive analysis — Adobe Audition

### 2.1 Where Audition wins, ranked by what a radio producer actually hits

| Audition capability | Our state | Radio impact |
|---|---|---|
| **Clip gain envelope** (drag a line on the clip) | absent | **Highest.** Ducking a bed under a VO is the single most common radio edit |
| **Spectral Frequency Display + heal brush** | absent | High for VO cleanup — a cough, a lip smack, a chair creak |
| **Noise reduction / DeNoise / DeReverb** | absent | High. Studio VO is rarely clean |
| **Time-stretch to fit** | absent | **High and specific to us:** stretching a VO to fit a 30s break is a daily radio task |
| **Essential Sound panel** (tag a clip "Dialogue", get a chain) | absent | Medium-high — it is a workflow, not a DSP feature, and it is cheap |
| **Loudness (ITU-R BS.1770 / LUFS) normalise** | limiter only | **High** — broadcast delivery is loudness-spec'd |
| VST3 host | absent | Medium. Real, but a large surface |
| Multitrack + automation | **shipped** | — |
| EQ / comp / reverb | **shipped** | — |

### 2.2 Where Audition's *look* wins, and it is not taste
Audition's density is the product. Its transport, timeline, mixer and panel chrome sit on a ~28px
row grid, 11px labels, zero radius, no lift. Ours is 159 hard-coded font sizes with 35 shadows.
**The gap is not that we chose a different aesthetic — it is that we never chose one here.**

### 2.3 Where we already beat it
- **Send to air.** A finished cut lands on Deck A, or in the Jingles pool, in one click.
- **One region engine.** The Reel Splitter and the DAW share `silenceRegions.ts` (per `CLAUDE.md`),
  so a cut behaves identically in both surfaces. Audition has no equivalent of "this is the same
  object my scheduler will play."

**Strategic read:** we should not chase Audition on spectral repair. We should be the DAW that is
*inside the radio station*. Phase 3 below is chosen on that basis.

---

## 3. Proposed visual language

**No new tokens.** The scale retuned in 4.4.218 is exactly the target: `--t-small` 11px labels,
`--t-body` 12px data, `--t-lead` 13px, `--t-head` 16px ceiling, `--s-*` 2/4/6/8/12/16/24, `--r-0`,
`--e-0`, `--e-float` for floating panels only.

### 3.1 Rules, specific to a DAW
1. **Radius 0 everywhere.** Exception: knob caps and meter LEDs are circles (`--r-full`) — they are
   physical objects, not cards.
2. **No shadow on anything docked.** FX windows and menus float → `--e-float`. All 35 current
   shadows are audited into one of those two buckets.
3. **Track header row height 28px**, matching the Schedule Manager's `roomy` DataGrid. Currently
   variable.
4. **Colour is signal, not decoration.** Track colour (`PALETTE :50`) is data — it identifies the
   track in the timeline and the mixer. Accent colours mean state only: red = record-armed, amber =
   clipping, green = on air.
5. **Type: 11px uppercase tracked labels; 12px values; monospace tabular for all timecode** —
   `fmtTimecode :284` output must never reflow as digits change.

### 3.2 Layout — the Audition three-zone shape
```
┌─────────────────────────────────────────────────────────────────┐
│ TRANSPORT · timecode · tools · session          [24px, one row]  │
├──────────┬──────────────────────────────────────────┬───────────┤
│ TRACK    │ TIMELINE                                 │ INSPECTOR │
│ HEADERS  │ ruler · regions · automation lanes       │ fx / clip │
│ 28px/row │                                          │  (dockable)│
├──────────┴──────────────────────────────────────────┴───────────┤
│ MIXER (collapsible) · faders · meters · master      [collapsed] │
└─────────────────────────────────────────────────────────────────┘
```
Every one of these components already exists (`TrackHeaderRow :4279`, `TrackLane :4590`,
`Inspector :5223`, `Fader :5383`, `MeterBar :4252`). **This is a re-arrangement and a restyle, not a
rebuild** — which is why Phase 2 is days rather than weeks.

---

## 4. Proposed workflow improvements

### 4.1 Keyboard-first — the biggest workflow win, and it is nearly free
**Measured: exactly 4 global shortcuts exist** — copy/paste/duplicate (`:1408`), delete (`:1433`),
space/play (`:1449`), M/marker (`:1455`). The handler at `:1401` is already a single global
`onKey` — adding to it is additive and low-risk.

Proposed map (Audition/Pro Tools muscle memory where it exists):

| Key | Action | Key | Action |
|---|---|---|---|
| `Space` | play/stop *(exists)* | `S` | split at playhead |
| `Home`/`End` | start / end | `E` | toggle clip-gain envelope |
| `[` `]` | set in / out | `F` | fade selected edge |
| `,` `.` | nudge −/+ frame | `R` | record-arm focused track |
| `Ctrl+D` | duplicate *(exists)* | `M` | marker *(exists)* |
| `Z` | zoom to selection | `Shift+Z` | zoom to fit |
| `Ctrl+Shift+N` | new track | `1..9` | focus track N |
| `Alt+↑/↓` | move region between tracks | `G` | toggle snap |

### 4.2 Contextual tool strip
Replace the always-on toolbar with a strip that changes with selection: **nothing selected** → view
controls; **region** → gain / fade / split / stretch; **automation point** → curve type. Audition's
Essential Sound panel is the reference, and it is a UI grouping over DSP we already ship.

### 4.3 The Ether workflow, tightened
- **Drag from Library** directly onto a track (today it is import-then-place)
- **Send to VoiceTrack** as a first-class exit next to Deck/Jingles/Sweepers in `StudioSendBar`
- **"Fit to break"** — the killer radio feature: select a region, type `:30`, it time-stretches to
  fit. Depends on Phase 3's stretch engine.

---

## 5. Phased plan with effort

| Phase | Contents | Effort | Risk |
|---|---|---|---|
| **1. Visual sweep** | Token conversion: 22 radii, 35 shadows (float-audited), 159 font sizes; 28px track rows | **1 day** | **Low** — the identical codemod ran on 11 files in 4.4.218; `tsc` + a screen check is the gate |
| **2. Layout + keyboard** | Three-zone shape, collapsible mixer, dockable inspector, ~16 new shortcuts, contextual tool strip | **3–4 days** | Low-medium — re-arranges existing components; the reducer already centralises state |
| **3. Clip gain + fades** | Per-region gain envelope with draggable points, reusing `AutomationLaneView :5074` and `interpolateLane :343` | **2–3 days** | Medium — new audio-graph node per region; **the highest-value feature in the document** |
| **4. Loudness + fit-to-break** | LUFS (BS.1770) meter and normalise; time-stretch via a WSOLA/phase-vocoder worker | **4–5 days** | Medium-high — DSP correctness, and stretch MUST run off the audio thread |
| **5. Noise reduction** | Spectral-subtraction denoise on a worker; capture a noise profile from a selection | **4–5 days** | High — quality is the whole feature; a bad denoiser is worse than none |
| **6. VST3 host** | Out-of-process plugin host, scanning, parameter bridge | **3–4 weeks** | **High** — crash isolation, licensing, 32/64-bit, per-plugin quirks. **Recommend deferring indefinitely** |

**Recommended cut: Phases 1–4 (~10–13 days).** That lands a dense, keyboard-first, flat DAW with
clip gain, loudness compliance and fit-to-break — the four things a radio producer touches daily.
Phase 5 is a genuine project. Phase 6 is a different product.

### 5.1 Performance — the constraint that shapes 4 and 5
The brief flags CPU, correctly. Rules for the later phases:
- **Nothing new on the audio thread.** Stretch and denoise run in Workers over an
  `OfflineAudioContext`, rendering to a new buffer — the realtime graph is untouched.
- **Clip gain is a `GainNode` per region**, not per-sample maths — it costs nothing.
- `extractPeaks :421` is fixed at 2000 points regardless of length; long sessions should scale that
  with zoom rather than re-extract. Worth fixing in Phase 2 while the timeline is open anyway.
- LUFS metering is a rolling integrator on existing analyser taps — cheap.

---

## 6. Risks and open questions for Jeff

1. **StudioPro is 7,280 lines in one component.** Phases 2+ get materially safer if it is split
   first (timeline / mixer / inspector / fx). That is ~1 extra day and no user-visible change. **I'd
   do it, but it is a real cost and it belongs to you to rule on.**
2. **Phase 6 (VST) — recommend not doing it.** It is 3–4 weeks and imports every third-party crash
   into the app that runs the transmitter. Say so out loud now rather than carrying it as "planned".
3. **Is the single-clip `StudioEditor` (869 lines) still needed** once the DAW is dense enough, or
   does it fold into StudioPro as a one-track view? Two editors for one job is the surface this
   codebase has removed twice already (Spots, operators).
4. **Phase order:** I have ranked clip gain (3) above loudness (4) because it is the more frequent
   edit. If broadcast loudness compliance is a delivery requirement, flip them.

---

## 7. Compliance

- **Design only.** No code, no dependency, nothing changed.
- **Measured, not assumed** — §0 and §1 numbers are grep counts from the current file, and the
  35-shadow figure matches the 2026-08-10 design doc exactly, confirming no drift.
- **Compose over rebuild** — §3.2's layout uses components that already exist, named with line
  numbers; §4.1 extends the existing global key handler rather than adding a second one.
- **Existing tokens only** — §3 adds no token; the 4.4.218 scale is the target as-is.
- **Honest UI** — §1.4 records that send-to-deck already rides the real deck path, and §2.3 names
  it as the thing Audition structurally cannot do.
- **Conflict surfaced** — §6.2 recommends against a deliverable the brief lists (VST host), with the
  reason, rather than costing it and hoping.
