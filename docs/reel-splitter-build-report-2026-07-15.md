# Reel Splitter — build report (2026-07-15, v4.4.58)

Purpose-built jingle/sweeper reel → library workflow, built ONLY on capabilities verified to work
end-to-end. tsc --noEmit (0 new errors) + vite build green. **STOP before install.**

## Verification inventory (the rider — what genuinely works vs. renders-only, receipts)

| Reuse target | Verdict | Decision |
|---|---|---|
| **Silence analysis** — native `detect_cue_points` (`audio_engine.rs:779-850`) | ⚠️ single-clip head/tail only; returns 4 scalars, **can't emit regions**. Toggle button is dead (`patch-header.js:17`, unapplied). | **Built our own** JS silence-gap detector (`src/audio/silenceRegions.ts`) on the decoded AudioBuffer. |
| **Write to disk** | ✅ `ffmpeg.writeAudio` → `media:writeAudio` **writes bytes** (`main.js:4163`, live in VoiceTracker/PhoneDesk). ❌ `ether.fs.writeFile` = **dead stub, no handler** (`preload.js:157`; throws). | **Used `ffmpeg.writeAudio`**; avoided `fs.writeFile`. |
| **Import pipeline** | ⚠️ Works but **file_path identity, NOT content-hash** (`songs.create`, `songs.js:43`; `songs_v2`/hash is offline-script-only). `content_class`/`jingle_category_id` **dropped at create** (`songs.js:65`). | **Shipped normal pipeline**: `songs.create` + `songs.updateById({content_class, jingle_category_id})`. Content-hash = deferred `songs_v2` cutover (backlog). |
| **StudioPro** | ✅ decode/waveform/selection/region-audition are **real**. ❌ send-to-cartwall/stream events have no listener; **arrow keys don't exist**; **export-to-disk uses the dead `fs.writeFile`** (path-less blob fallback). | Reused the audition/selection *concepts*; **built our own arrow-key nav**; **deferred the StudioPro "Export selection to Library"** (item 5) — its export path fails the spec's "only if verifies as real" condition. |

## What was built
- `src/audio/silenceRegions.ts` — RMS-per-hop silence-gap detector → content regions.
- `src/components/ReelSplitter.tsx` — the one screen: drag/pick open → decode → auto-cut → waveform + region
  overlays with draggable edges → keyboard-first review (Space/←/→/Del) + split/merge/delete → batch commit
  (JIN/SWP + pool + editable names) → per region: slice AudioBuffer → `encodeWav` → `ffmpeg.writeAudio`
  (`…/imaging/<reel>/<name>.wav`) → `songs.create` + `updateById`.
- Entry points: **Tools → Reel Splitter…** (`main.js` menu + `App.tsx` panel `reelsplitter`) and a **Cut a
  reel →** button on the Jingles & Sweepers panel (via `ether:open-reel-splitter` event).
- Help: `docs/help/reel-splitter.md`.

## Deferred (with rationale)
- **Item 5 — StudioPro "Export selection to Library…"**: the spec gated it on "only if its selection/export
  path verifies as real." The **selection** is real but the **export-to-disk path is verified dead** (uses
  the missing `fs.writeFile`), and rendering a selection window inside the never-exercised 7000-line
  StudioPro is disproportionate, high-risk surgery for an ad-hoc convenience. Folded into the backlog's
  honest-UI cleanup — when StudioPro's export is wired onto `ffmpeg.writeAudio`, "Export selection to
  Library" rides the same verified path and can share the Reel Splitter commit approach.
- **Content-hash identity** — the `songs_v2` cutover (backlog); Reel Splitter imports join it then.
- **Honest-UI cleanup** — the dead controls this inventory exposed (silence-trim toggle, `fs.writeFile`
  stub, StudioPro send-to-cartwall/stream, StudioPro/BroadcastEditor export) are logged in `docs/backlog.md`
  to be wired or removed. Dead controls violate the honest-UI principle.

## Honest scope note
The audition/render/write/import path is exercised via static verification of each dependency (all reach real
implementations), but the end-to-end reel flow is **unauditioned** until installed (broadcast untouched).
It is self-contained (its own AudioContext; no engine/deck interaction) and cannot affect on-air playout.
