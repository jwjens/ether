# v4.4.67 — Show+ DAW (StudioPro) becomes a pop-out window — build report, 2026-07-20

**One line:** StudioPro now opens in its OWN window (like Master Out / Health Monitor), not a
takeover of the main dashboard. Remembers size/position, warns on close with uncommitted regions,
chop-and-send exits work cross-window, and — verified — the DAW window runs NO station-state writers.

Design: `docs/studiopro-popout-window-design-2026-07-20.md`. Decision: A (send-to-studio opens the
popout + forwards over IPC).

## What changed

- **`electron/main.js`**
  - `POPOUT_SIZES.studiopro = 1280×800`.
  - Refactored `window:popout` → `openPopoutWindow(panel)` (reused by the send hand-off).
  - **Bounds persistence (all pop-outs):** per-panel bounds saved to `userData/popout-bounds.json`
    on `moved`/`resized`, restored on open (with an on-screen guard for a vanished monitor); falls
    back to default size + secondary-monitor placement.
  - **Close-guard (studiopro):** `win.on('close')` intercept → if the renderer reports dirty,
    `preventDefault` + `studio:confirm-close`; guards Alt+F4 / OS close, not just the shell X.
    `studio:set-dirty` / `studio:force-close` IPC back-channel.
  - **`studio:push-track` IPC:** opens/focuses the DAW window and delivers a track to THAT window —
    cold (on `did-finish-load`) or warm (immediately). The single-surface hand-off.
- **`src/components/PopoutRenderer.tsx`:** `case "studiopro"` → `<StudioProPopout>` which resolves
  the active station via `useActiveStation()` (machine-global `getActive`) and renders StudioPro.
- **`src/components/StudioPro.tsx`:** three small bridges — (a) report dirty (`state.tracks.some(t =>
  t.regions.length > 0)`) to main; (b) `studio:confirm-close` → in-app confirm → `studio:force-close`;
  (c) `studio:load-track` → re-dispatch the existing `ether:send-to-studio` DOM event (one load path).
- **`src/App.tsx`:** added **Show+ DAW** to the drawer's **WINDOWS** section (pop-out list, same
  affordance as Decks/Carts/…); Tools → Show+ DAW opens the pop-out; Library → **Send to Studio** now
  calls `studio:push-track` (opens the DAW + delivers the track); **removed the inline
  `panel==="studio"` takeover** and its now-unused import. No inline DAW — single production surface.

## Receipts — requirement (4): NO station-state writers in the DAW window

- **Isolated render tree:** `main.tsx` routes `#popout/*` → `<PopoutRenderer>` only, never `<App>`.
  App's now-playing poster effect (the sole `nowplaying:state` emitter) never mounts in the DAW window.
- **StudioPro emits nothing:** grep `nowplaying|emit|broadcast` in StudioPro → zero. Its only new IPC
  is `studio:set-dirty` / `studio:force-close` / `studio:load-track` — window-lifecycle + a track
  hand-off, NOT station state. No now-playing, no engine mirror, no station push.
- **Belt-and-suspenders:** the 4.4.54 election (`main.js`) still accepts `nowplaying:state` ONLY from
  `mainWindow.webContents.id`; every other window is ignored. The per-window-poster ghost cannot recur.
  → The DAW pop-out is an **editor window, not a console.** Exactly one now-playing poster on the
  machine (main), unchanged.

## Receipt — requirement (3): send works cross-window

`StudioSendBar` → `getEngine(stationId)` (daemon-backed) `deckCue`/`loadToDeck` + `commitRegionToLibrary`
(DB/IPC). The popout resolves the same active `stationId` via `getActive` (machine-global). Send rides
IPC/daemon, not same-window state. Known minor: a station switch in main while the DAW is open doesn't
live-update the popout's stationId (resolved at open) — a later polish if needed.

## Gates

- `node --check electron/main.js` OK.
- `npx tsc --noEmit`: **zero NEW errors** (3 pre-existing: `App.tsx:4908`, `OnboardingFlow.tsx:2039`,
  `PhoneDesk.tsx:777`). One new error I introduced (`openPopout` out of scope in the Tools MenuBar
  component) was fixed by invoking the popout IPC inline there.
- `npm run build` OK; installer built.

## Artifact

`C:\openair\dist-electron\Ether Setup 4.4.67.exe` — 202,613,033 bytes, `--publish never`. Install manually.

## Help

`docs/help-studiopro-chop-send.md` updated: new "Open it — its own window" section (WINDOWS menu /
Tools / Library→Send-to-Studio; remembers size/position; close-guard on uncommitted regions).

Nothing committed; nothing pushed.
