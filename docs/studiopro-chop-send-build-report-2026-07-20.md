# Show+ DAW — chop & send: build report (2026-07-20, v4.4.64)

Jeff's mission statement: **"quick import, chop up, send to deck or jingle or sweeper or library."**
Built ONLY on capabilities verified end-to-end, and onto the shared imaging engine (never a copy).
`tsc --noEmit` (0 new errors) + fader-invariant PASS + vite/electron build green. **STOP before install.**

Governing docs cited: CLAUDE.md ("Imaging & production surfaces — one region engine, two surfaces");
`reel-splitter-verification-and-plan-2026-07-15.md` (the verified-rails inventory);
`reel-splitter-build-report-2026-07-15.md` (what the splitter already shipped and shares).

---

## Verification inventory (real vs. renders-only — receipts, per the rider)

| Target | Verdict | Decision |
|---|---|---|
| **StudioPro import** | ✅ `loadAudio()` (`StudioPro.tsx:1156`) + drag-drop `onLaneDrop` (`:2705`) are REAL (fetch→decodeAudioData→ADD_REGION). No toolbar file-pick existed. | **Added ＋ Import** file-pick that rides the SAME real `loadAudio` path (blob URL → new track). |
| **StudioPro send-to-cartwall / stream** | ❌ DEAD — `sendToCartwall`/`streamThisMix` dispatched `CustomEvent`s (`ether:send-to-cartwall` / `ether:stream-mix`) with **no listener anywhere**. | **REMOVED** both buttons + functions (honest-UI: no decoration); replaced with the real ＋ Import + the Send bar. |
| **Region selection / trim** | ✅ RegionEditorDrawer trim handles (`:4744-4747`) set `trimStartMs`/`trimEndMs` on the region's real `buffer`. | **Reused as the chop** — the selection is the region's trimmed span `[trimStart,trimEnd]`. |
| **Region audition** | ⚠️ StudioPro's own `buildAndStart`/loop plays the whole timeline, not an isolated clip. | **Used the SHARED `regionAudition.auditionRegion`** (the splitter's mechanic) for a clip-only ▶ Audition. |
| **Write to disk** | ✅ `ffmpeg.writeAudio` → `media:writeAudio` writes bytes (live). ❌ `fs.writeFile` dead stub; StudioPro `exportWav` falls to a path-less blob download. | **Used `ffmpeg.writeAudio`** (via shared `imagingCommit`); avoided `fs.writeFile`/blob. |
| **Import pipeline** | ⚠️ `songs.create` + `updateById` (file_path identity; content-hash/`songs_v2` still offline-script-only). | **Shipped normal pipeline** via shared `imagingCommit.commitRegionToLibrary`. Content-hash = deferred `songs_v2` cutover (backlog). |
| **Send to deck** | ⚠️ StudioPro's `sendToDeck` dispatches `ether:deck-load` with a **blob URL** — a blob can't load in the daemon/native. | **Wired the REAL path**: render region to disk → `getEngine(stationId).deckCue` (daemon) / `loadToDeck` (in-process), the exact Library A/B/C path (`App.tsx:1827`); an on-air deck is refused. |

---

## Architecture — one region engine, two surfaces (never a copy)

Extracted the shared imaging engine so the **Reel Splitter** and the **StudioPro chop-and-send** wear the
same parts (CLAUDE.md mandate):

- `src/audio/regionAudition.ts` — `auditionRegion(ctx, buffer, start, end)` (the one audition mechanic).
- `src/audio/imagingCommit.ts` — `renderRegionToDisk` + `commitRegionToLibrary` (slice→`encodeWav`→
  `ffmpeg.writeAudio`→`songs.create`+`updateById`); `ImagingClass = JIN|SWP|MUS`.
- `src/components/ClassPoolSelect.tsx` — the shared class-tab + pool-picker commit-form atom (`useImagingPools`).
- Reuses the pre-existing `wavEdit.sliceRegion`/`encodeWav` and `silenceRegions.ts`.
- **`ReelSplitter.tsx` was refactored onto all of the above** (−53 lines of now-shared duplication) — proving
  the engine is shared, not copied. Its behavior is unchanged.

## What was built

- `src/components/StudioSendBar.tsx` — the "Send selection" bar, mounted in the RegionEditorDrawer under the
  waveform. Name (InlineNameEditor) · ▶ Audition (shared) · four exits: **→ Library** (`cls:MUS`), **→ Jingle**
  (`JIN`+pool), **→ Sweeper** (`SWP`+pool), **→ Deck** (A/B/C, real deck-load). Reads the active `stationId`.
- `StudioPro.tsx` — added ＋ Import (`pickImport`/`importFiles`); removed the two dead send buttons + funcs;
  threaded `stationId` → `RegionEditorDrawer` → `StudioSendBar`.
- `App.tsx` — passes `stationId` to `<StudioPro>`.
- Help: `docs/help-studiopro-chop-send.md` — "Cut and send from the Show+ DAW."

## Deferred (with rationale)

- **Free-form sample-level region marquee** inside the timeline — the chop uses the region's existing trim
  span (real, low-risk). A separate in-waveform marquee is a larger StudioPro surgery; not needed for
  quick-import→chop→send.
- **Content-hash identity** — the `songs_v2` cutover (backlog); these imports join it when the splitter's do.
- **StudioPro `exportWav` / session-save** still use the `fs.writeFile`→blob-fallback — untouched here;
  logged in the backlog's honest-UI cleanup (out of this feature's scope).

## Honest scope note

The send paths reach real implementations (verified statically + typecheck), but the **end-to-end DAW
chop→send flow is unauditioned until installed** — the audition uses the DAW's own AudioContext and the
only on-air touch is **→ Deck**, which rides the proven `deckCue`/`loadToDeck` path and refuses a playing
deck. Broadcast playout is otherwise untouched.

## Gates

- `tsc --noEmit`: 0 new errors (the lone `App.tsx` error is the known pre-existing one, shifted 4913→4914 by
  one added line).
- Fader-invariant (`scripts/test-fader-invariant.js`): ✅ 1197 samples, every deck fader exactly 1.0.
- vite build ✓ · electron-builder ✓ signed → `dist-electron\Ether Setup 4.4.64.exe`.
- Committed `6c8dab4`, pushed to `origin/main` (no `v*` tag → no client release). **Not installed.**
