# Implementation spec — 4.4.54 single now-playing poster (desktop only)

**Status: APPROVED by Jeff (GO given). NOT yet implemented — shell was down; needs a session restart to recover the shell, then implement + build + commit + push. STOP before install.** Self-contained for a fresh session.

## Ground rules
Receipts for every claim. No commit/push/install without Jeff's GO (already given for build+commit+push of this release; **STOP before install** — CI builds the installer, Jeff installs manually). Desktop only — do NOT touch the backend (exonerated), the dashboard, library sync, the license key, or the 3 airing stations.

## Root cause (confirmed, receipts)
The now-playing display on the dashboard flickers (Deck A cycles songs) and lags one song, showing a **ghost track that never aired**. Cause:
- **The now-playing poster runs in EVERY renderer window.** `src/App.tsx:1927` `useEffect` → `setInterval(push, 3000)` (`:1993`) posts **every** station's now-playing (`fetch POST ${ETHER_BACKEND_URL}/api/now-playing`, `:1982-1989`; logged `[NOWPLAY] POST` at `:1981`) from **that window's own engine mirror** (`buildNowPlayingPayload(eng, …)`, `:1943`). This effect is in the shared `App` component, so main window + every popout each run their own 3s poster → **last-write-wins ping-pong** on the single backend row; a stale window's mirror posts the ghost.
- Backend is CORRECT (exonerated): `POST /api/now-playing` is a single-row upsert `ON CONFLICT (station_uuid) DO UPDATE` (`ether-backend/src/index.js:4731-4741`). No backend change.
- The payload is **renderer-only**: `main.js:4573` notes the native/daemon engine has neither position nor queue — so main cannot build the payload; it must be fed by a renderer. Main currently receives only the **active** station via `iris:state` (`App.tsx:1950-1962` → `main.js:4594` `latestIrisState`), itself last-writer-wins across windows.

## The fix (exactly as approved): ONE main-process poster, fed by ONE elected window

### 1. Renderer — `src/App.tsx` (the `useEffect` at 1919-1995)
- **Remove the direct backend `fetch`** (`:1982-1989`) and the renderer-side dedup/keepalive bookkeeping (`lastNowPlaySig`/`lastNowPlayPostAt`, `:1967-1980`) — dedup moves to main.
- Keep building each station's payload (`buildNowPlayingPayload`, the art_url resolve at `:1966`) and keep the `iris:state` emit (`:1950-1962`, active station — unchanged, Iris still needs it).
- **After building each station's payload, forward it to main** over a NEW IPC channel:
  `(window as any).ether?.emit?.("nowplaying:state", payload)` — one emit per station per 3s tick (payload already carries `station_uuid`). Keep the 3s interval.
- Net: the renderer no longer posts to the backend; it only forwards payloads to main.

### 2. Main process — `main.js` (near the `iris:state` handler ~4594)
- **Elect the primary window.** Main owns window creation — find the main window ref (grep `mainWindow` / `createWindow` in main.js). Accept `nowplaying:state` ONLY from `evt.sender.id === mainWindow.webContents.id`; ignore all other windows (popouts). Re-resolve if the main window is recreated.
- **Accumulate latest payloads:** `const nowPlayingByUuid = new Map()` — on an accepted `nowplaying:state`, `nowPlayingByUuid.set(payload.station_uuid, payload)`.
- **Single POST loop (the only `[NOWPLAY]` source):** one `setInterval(3000)` in main that iterates `nowPlayingByUuid`, applies the SAME dedup signature + 20s keepalive that was at `App.tsx:1967-1980` (sig excludes position; re-POST after 20s to keep `engine_heartbeat_at` fresh), logs `[NOWPLAY] POST …` once, and `POST`s to `${ETHER_BACKEND_URL}/api/now-playing` with `x-license-key`.
  - License key in main: read from the DB (`getDb()` → `SELECT value FROM station_config_kv WHERE key='license_key'`) — same value `apiKeyRef.current` uses. `ETHER_BACKEND_URL` = `electron/lib/etherBackend.js:17`.
- Result: exactly ONE poster per machine (main), fed by ONE elected window, surviving popout/window churn.

### 3. Release chore
- `package.json` version `4.4.53` → `4.4.54`.
- `CHANGELOG.md`: prepend a `## [4.4.54]` entry — "single now-playing poster: moved the /api/now-playing heartbeat out of the per-window renderer loop into one main-process poster fed by the elected primary window; kills multi-window last-write-wins ghost/flicker on the dashboard decks."

## Build + ship (needs shell)
1. `cd /c/openair && npm run build` → must exit 0 (renderer). `node --check electron/main.js` for the main change.
2. Commit the 4 files (`src/App.tsx`, `electron/main.js`, `package.json`, `CHANGELOG.md`) on `main`, Co-Authored-By trailer. Push `origin main`. **STOP before install.**

## Verify (after Jeff installs 4.4.54)
- Exactly **one** `[NOWPLAY]` POST source in logs (main process).
- Rapid `/api/account/stations` reads → **one monotonically-advancing `updated_at`** per station, no flip-flop, no ghost.
- Dashboard **Deck A holds one song for a full track**, zero flicker; a real transition lands within seconds.

## Context / related docs
- Project map + rails: `CLAUDE.md`. Prior mirror fix (4.4.53, shipped): `docs/web-ui-mirror-handoff-2026-07-14.md`, `CHANGELOG` 4.4.53.
- Backend now-playing read paths join `station_now_playing` by `station_uuid` (`index.js:2260, 2712, 4963`) — single-row model, confirmed.
