# Reel Splitter — verification inventory + build plan (2026-07-15)

**Status: VERIFICATION DONE (read-only, receipts). Build plan below awaits one GO (content-hash vs
file_path). No feature code yet.** Per the "don't build on visible-but-dead UI" rider — inventory first.

## Verification inventory (what genuinely works vs. renders-only)

| Reuse target | Verdict | Receipt |
|---|---|---|
| **Silence analysis** | ⚠️ Can't pre-slice as-is | Native `detect_cue_points` (`native/src/audio_engine.rs:779-850`) is real DSP but returns **4 scalars** for ONE clip (cue_in/intro_end/outro_start/cue_out, `:849`) — head/tail/intro/outro only; `break`s on first/last run, discards interior gaps. No region array. The `autoSilenceTrim` **toggle button is dead** (threaded into LivePanel `App.tsx:2443/3371`, never rendered; exists only in the unapplied codemod `patch-header.js:17`). The analysis itself DOES run by default on deck-load (`App.tsx:1819` → `songAnalysis.ts:201/84` → `main.js:3524` → `lib.rs:352` → `audio_engine.rs:956/779`). |
| **Write audio to disk** | ✅ one path works; the obvious one is DEAD | `ether.ffmpeg.writeAudio` → `media:writeAudio` **writes bytes** (`electron/main.js:4163-4172`), proven live by `VoiceTracker.tsx:719-726` + PhoneDesk. **`ether.fs.writeFile` has NO main handler** (`preload.js:157` stub; no `ipcMain.handle("fs:writeFile")` anywhere) → it throws. |
| **Import pipeline** | ⚠️ works, but NOT content-hash | Shipped import = `songs.create({file_path,…})` (`ImportDialog.tsx:85`, handler `electron/sync/handlers/songs.js:43`) — identity is **file_path/id, no SHA-256**. Content-hash/`songs_v2` (spec D1/D4) is **script-only, not wired** (`scripts/import-library-v2.js`, "run with app CLOSED"). `content_class`/`jingle_category_id` are **dropped at create** (in PATCHABLE but absent from the INSERT, `songs.js:65`) → tag via a 2nd `updateById`. Files **referenced in place** (no store copy). |
| **StudioPro** | ✅ genuinely deep & mostly real | Decode/load (`StudioPro.tsx:1155`), **WaveformGL** real WebGL2 peaks (`WaveformGL.tsx:127-168`), region select + **loopRange** (`:2786`, consumed by playback), **region audition / space-to-play** (`buildAndStart :1658`, space `:1385`) all WORK. **DEAD**: "send to cartwall/stream" (events dispatched with no listener, `:2920/2933`), **arrow keys (none exist)**, **export-to-disk** (uses the dead `fs.writeFile`, silently falls to a path-less blob download, `:2277-2299`). |

## How the inventory redirects the build (onto verified rails)
1. **Render + write** each region via `OfflineAudioContext → encodeWav (src/audio/wavEdit.ts:152) → ether.ffmpeg.writeAudio(bytes, path)` to a **persistent** folder (`getAppDataDir()/imaging/<reel>/…wav`, the VoiceTracker pattern) — NOT `fs.writeFile`.
2. **Auto-cut** = a small **JS silence-region detector** on the decoded `AudioBuffer` (RMS/threshold, same concept as the native one) — the native detector can't emit regions. Self-contained, no native rebuild.
3. **Commit** = the shipped normal pipeline: `songs.create({title,file_path,duration_ms,category_id})` then `songs.updateById(id,{content_class, jingle_category_id})`. No side doors.
4. **StudioPro "Export selection to Library…"** — feasible ONLY on verified pieces (its `loopRange` selection + render are real): render the selection → `ffmpeg.writeAudio` → the shared commit form. Its existing export path is dead and won't be reused.
5. Reuse **WaveformGL** + **extractPeaks** for the waveform; **build our own arrow-key** navigation (none exists anywhere).

## The one thing to confirm (spec vs. shipped)
The spec says commit "through the NORMAL import pipeline **(content-hash identity, no side doors)**." **Content-hash identity is not shipped** — the live import is `file_path`-based; `songs_v2`/hash/content-store is spec + offline-script only. I can honor "normal pipeline, no side doors" (the exact shipped `songs.create`/`updateById` path the Library uses), but it will be **file_path identity, not content-hash**. Content-hash means cutting over `songs_v2` — a large separate migration, out of this feature's scope.

**Recommend: build on the shipped file_path import now** (the real "normal pipeline"); note content-hash as the deferred `songs_v2` cutover.

## Build plan (once confirmed) — one release, usual gates, STOP before install
- **ReelSplitter component** (dedicated one screen; NOT a DAW extension): open (drag-drop / file-pick) → decode (`decodeAudioData`) → waveform (`WaveformGL`) → **JS silence auto-cut** into numbered regions → keyboard-first review (space = audition current region, ←/→ move, drag boundaries, merge/split/delete) → **batch commit form** (content_class JIN/SWP, optional pool, naming pattern reel+index editable per region) → per region: `OfflineAudioContext` render → `ffmpeg.writeAudio` → `songs.create` + `updateById`.
- **Entry points**: Tools menu + a button on the Jingles & Sweepers panel.
- **StudioPro**: minimal "Export selection to Library…" using the verified render→writeAudio→shared commit form (its selection is real; its export is not).
- **Help**: `docs/help/reel-splitter.md` — "Cutting a jingle reel" (corpus template).
- **Gates**: tsc --noEmit (0 new), vite build, commit/push, installer to dist-electron, STOP. Inventory (above) goes in the build report.

**GO needed: build on the shipped file_path import (recommended), or block on the songs_v2 content-hash cutover?**
