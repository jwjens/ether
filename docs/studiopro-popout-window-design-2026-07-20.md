# Show+ DAW (StudioPro) → pop-out window — design + architecture receipts (2026-07-20)

**STATUS: investigation complete, read-only. NO code changed. One decision open (§Send-to-Studio
hand-off) before build.** Target release: next UI release.

Brief: StudioPro opens in its OWN separate window (like Master Out / Health Monitor popouts), not a
takeover of the main dashboard; resizable + remembers size/position; close-guard on uncommitted
regions; chop-and-send exits keep working cross-window; and — critically — the DAW window must run
**no** station-state writers (the now-playing ghost was per-window posters).

---

## What already exists (the pattern we ride)

- **`window:popout` IPC** (`electron/main.js:3757`) creates a frameless `BrowserWindow` loading
  `#popout/<panel>`, deduped by window title, placed on the secondary monitor if present.
- **`POPOUT_SIZES`** map (`main.js:3745`) — per-panel default sizes. Has a `videostudio` entry
  (1024×640) but see correction #1.
- **`PopoutShell`** (`src/components/PopoutShell.tsx`) — frameless titlebar (drag region) + close X
  (`window.close()`), plus `headerExtra` slot. Exports **`PopoutBtn`** — a reusable pop-out trigger
  (`ether.invoke("window:popout", panel)`) to drop in any panel header.
- **`PopoutRenderer`** (`src/components/PopoutRenderer.tsx`) — routes `#popout/<panel>` → component,
  wrapped in `PopoutShell`. Existing panels: decks, master, mic, phone, voicetrack, upnext, health,
  carts, shows, clocks, categories, calendar, library.
- **Cross-window relay** (`main.js:3832`) — `ether.emit("ether:broadcast", {channel,data})` fans a
  message to all OTHER windows; each receives via `ether.on(channel, cb)`.

## Architecture receipts

### (4) NO station-state writers in the DAW window — GREEN by construction

1. **Isolated render tree.** `src/main.tsx boot()` routes `#popout/*` → `<PopoutRenderer>` **only,
   never `<App>`** (`main.tsx:95`). App's now-playing poster effect — the sole renderer emitter of
   `nowplaying:state` — never mounts in a popout. The DAW window renders StudioPro alone.
2. **StudioPro emits nothing.** grep `nowplaying|emit|broadcast` in `StudioPro.tsx` → **zero
   matches**. Its only IPC is `db/client` (`execute`/`query`) for its own session; no engine mirror,
   no poster, no station push.
3. **Belt-and-suspenders election.** The 4.4.54 single-poster fix (`main.js:4672`) already accepts
   `nowplaying:state` **only** from `mainWindow.webContents.id` and ignores every other window. Even
   if the DAW window emitted, main would drop it. The per-window-poster ghost cannot recur.

   → Receipt for the report: the DAW popout is an **editor window, not a console** — no writers, and
   the machine still has exactly ONE now-playing poster (main).

### (3) Chop-and-send exits work cross-window

`StudioSendBar` (`src/components/StudioSendBar.tsx`):
- **→ Deck:** `renderRegionToDisk` → `getEngine(stationId)` (daemon-backed engine registry) →
  `deckCue` (daemon-driven) / `loadToDeck` — the real Library A/B/C load path.
- **→ Library / Jingle / Sweeper:** `commitRegionToLibrary` — the ONE shared imaging engine (DB/IPC).

Both ride process-crossing rails (daemon + DB), **not** same-window React state. Correct in a popout
**iff the window resolves the active `stationId`**. `useActiveStation()` reads
`stations.getActive()` (DB `is_active=1`, machine-global) — the same source the existing Library
popout uses. So the popout targets the same active station as the main window. ✓
Known minor: a station **switch in main while the DAW is open** won't live-update the popout's
stationId (the `station-switched` event is a per-window DOM event). v1 resolves at open; a
cross-window refresh is a later polish if needed.

## Two corrections to the brief

1. **Target is `panel:"studio"` = StudioPro (audio DAW), and needs a NEW `"studiopro"` popout key.**
   The existing `videostudio` popout key is the **VideoStudio** (camera/WebRTC) component
   (`App.tsx:2570`), a different surface. Drawer wiring today: **"Show+ DAW"** → `set("studio")` =
   StudioPro (`App.tsx:3013`); **"Show+"** → `set("videostudio")` = VideoStudio (`App.tsx:3014`).
   We add a distinct `"studiopro"` panel key; we do NOT reuse `videostudio`.
2. **The "splitter's tab-state fix" close-guard does not exist.** No `beforeunload` /
   uncommitted-regions guard exists in StudioPro, ReelSplitter, or JinglesPanel — only plain
   `confirm()` dialogs elsewhere (account switch, category assign, pool delete). Point (2)'s
   close-warning is **net-new code**, not a pattern to mirror. Design below.

## Build plan (all four points)

- **`electron/main.js`**
  - `POPOUT_SIZES.studiopro = { width: 1280, height: 800 }`.
  - **Bounds persistence** (satisfies "remembers size/position"): persist per-panel window bounds to
    `userData/popout-bounds.json` on the window's `moved`/`resized` events; restore on open (fall
    back to `POPOUT_SIZES` + secondary-monitor placement when no saved bounds). Generic — benefits
    every popout, not just the DAW.
  - **Close-guard** for `studiopro`: `win.on('close', e => …)` → if the DAW renderer reports dirty,
    `preventDefault` + send `popout:confirm-close`; the renderer shows an in-app confirm and, on
    proceed, force-closes. Guards Alt+F4 / OS close, not just the shell X. Proposed **dirty = the DAW
    session holds ≥1 loaded region** (StudioPro's session is not persisted, so any loaded audio is by
    definition uncommitted).
- **`src/components/PopoutRenderer.tsx`**: `case "studiopro": content = <StudioPro
  stationId={useActiveStation().stationId} deckAPath={null} deckBPath={null} … />;` add title.
- **`src/App.tsx`**: drawer **"Show+ DAW"** → `ether.invoke("window:popout","studiopro")` instead of
  `set("studio")`. Main dashboard stays on its current panel — no takeover; decks/meters/health/queue
  stay live. Retire (or leave dead) the inline `panel==="studio"` branch.

## OPEN DECISION — Library "→ Send to Studio" hand-off

Library right-click **"Send to Studio"** today does `setPanel("studio")` + a same-window
`ether:send-to-studio` DOM event (`App.tsx:2472/2479`) — it assumes StudioPro is mounted in the MAIN
window. Once the DAW is a popout, this hand-off crosses windows. Options:

- **A (recommended):** Send-to-Studio opens the `studiopro` popout and forwards the track to it via
  the existing `ether:broadcast` relay (main → popout). One coherent flow; no inline DAW; matches
  "StudioPro is the single production surface."
- **B:** Keep an inline StudioPro ONLY as the send-to-studio target; popout for standalone use. Two
  homes for the DAW — contradicts the single-surface principle.
- **C:** Drop Library→Studio for now; the DAW is import-inside-the-popout only.

Default if unspecified: **A**.

## Gates (at build time)

`npx tsc --noEmit` (zero new errors), `npm run build`, `npm run electron:build:win -- --publish
never`. Help entry: update `docs/help-studiopro-chop-send.md` (or a new `docs/help-showplus-daw.md`)
with the pop-out + close-guard behavior. STOP before install.

---

*Read-only investigation. No files changed. Awaiting the Send-to-Studio decision (A/B/C) before
building.*
