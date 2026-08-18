# Build report — 4.4.226, 2026-08-18

**Commit:** `168e90a` · **Branch:** `log-reader-flip` · **Parent:** `f582ec3` (4.4.225)
**Artifact:** `C:\openair\dist-electron\Ether Setup 4.4.226.exe`
**Local build only** — `--publish never`. Not pushed, not tagged, not installed.

> **This is the build OV needs.** 4.4.225 cannot clear its 29,226 pending mutations — the button did
> not exist in it. This one has it (§2 proof).

---

## 1 · What shipped

Three arcs. Each has its own design doc; this report is the build-level record.

### 1.1 · Jukebox — public request kiosk, then an audio source
`docs/jukebox-rebuild-design-2026-08-17.md` · `docs/jukebox-deck-source-design-2026-08-17.md`

- **Relocated.** Left the bottom tab bar; lives in the ☰ drawer's Windows list and opens as a kiosk
  pop-out, fullscreen (F11 / Escape, handled main-side so no renderer window-control IPC returns —
  `main.js:5178-5181` records why that matters).
- **Pool is CATEGORIES, not a clock.** Settings → Programming → **Jukebox** lists every category with
  its playable-song count; ticks are the whole pool. The clock-as-playlist model is dead.
- **TouchTunes wall.** Big art, dark, lazy per-tile art via `getLocalArt` — deliberately *not*
  `resolveArtwork`, which falls through to an iTunes lookup per (title, artist).
- **Named queue.** Requester name, placement #1/#2/#3…, flashing **UP NEXT** at #2. Strict FIFO. A
  request never cuts a playing song.
- **QR** on every open, from `jukebox_request_url`.
- **THE BOARD IS THE TRUTH.** The jukebox patches into a deck like a mic: set deck **D/E/F**'s source
  to Jukebox, fader up, it is on air. No suppression, no stealth — it emits `deck` and `playstart` and
  writes `play_log` like any deck play. Isolation is structural: station automation enumerates
  `["A","B","C"]` and never looks at D/E/F.
- **Its own AUTO** shuffles the ticked categories between requests; disengaged it plays requests only
  and is silent, and says so. Routing state (fader down / channel off) is read off the deck.

### 1.2 · Native menu — audited, fixed, and routed by source window
`docs/native-menu-audit-2026-08-17.md`

- 41 items traced to channel and handler. Two genuinely dead: **Tools ▸ Show+ DAW** (pointed at a panel
  with zero render sites since the DAW became a pop-out) — rewired; **Monitors ▸ Camera** (opened a
  window reading "Unknown pop-out panel") — **removed**.
- The real defect: `send()` targeted the focused window, and pop-outs show the full menu bar while
  rendering `PopoutRenderer`, which has no `menu-action` listener. Every item in every menu was inert
  on every pop-out.
- **New routing.** From the main window: unchanged. From a pop-out: the target opens as its **own**
  pop-out (already open → focused, never duplicated) and the dashboard is not shown, focused or
  repainted — the board does not get covered mid-event. 13 panels gained `#popout` routes.
- The main-window-only bucket is **named** in the audit doc, not decided silently.

### 1.3 · Clear pending (set baseline) — the button that never existed
`docs/clear-pending-button-verify-2026-08-18.md`

Jeff reported no screen had ever shown it. Verified correct: `sync:clear-pending` shipped in 4.4.225
(3 hits in that asar) but the renderer's `clearPending()` was bound to nothing, so the minifier dropped
it — **0 hits** for its confirm text in the same artifact. A working handler with no door.

Now a real button beside PREFLIGHT / PUSH NOW / PULL NOW with a **typed** confirm (type `CLEAR`), the
pending count shown before committing, and disabled whenever any sync action is in flight so the
journal cannot be deleted mid-push.

## 2 · Artifact receipts

| | |
|---|---|
| Path | `C:\openair\dist-electron\Ether Setup 4.4.226.exe` |
| Size | 195 MB (204,168,278 bytes) |
| Built | 2026-08-18 09:36 |
| `Ether.exe` ProductVersion | **4.4.226.0** (FileVersion 4.4.226, ProductName Ether) — read off the artifact, not assumed |
| sha256 | `90e5b5ff2d59b05c3333d1ae54ddb6a73380894007551169cb9be6e31ada2ede` |
| Signing | signtool on Ether.exe, ffmpeg.exe, elevate.exe, uninstaller, installer |
| Blockmap | written |

**Packaged-asar proof** — the same grep that exposed the missing button in 4.4.225, re-run on both:

| String | 4.4.225 | **4.4.226** |
|---|---|---|
| `CLEAR PENDING` | 0 | **1** |
| `DISCARD BACKLOG` | 0 | **1** |
| `sync:clear-pending` | 3 | 4 |
| `jukebox:play` | — | 4 |
| `jukebox_requests` | — | 13 |
| `menuNav` (menu routing) | — | 25 |
| `programlog` (new pop-out) | — | 5 |

## 3 · Gates

- `npx tsc --noEmit` → **0 errors** (the zero bar; vite/esbuild strip types and never typecheck)
- `node --check` → OK on every touched JS file: `main.js`, `preload.js`, `audiod/ether-audiod.js`,
  `audiod/playlog.js`, `electron/sync/synced-tables.js`, both migrations
- `verify-transformer-chain` → **39 migrations discovered, gaps: none**, fresh-install chain
  v0-baseline + v1–v39 clean
- migration **v38** self-verification → all PASS (incl. "NO uuid column", "not registered in
  synced-tables.js")
- migration **v39** self-verification → all PASS (incl. "no rows added or lost", "NO backfill —
  existing history is left unmarked, not invented")
- `npm run test:sync` → **46/46** (re-run because `synced-tables.js` changed)
- `npm run build` → clean · `electron-builder` → exit 0

Run under Electron's ABI (`ELECTRON_RUN_AS_NODE=1`) where a DB handle is needed: `better-sqlite3` is
compiled for Electron after any packaging run, so plain `node` cannot open it until `npm rebuild`.

## 4 · Schema

| Migration | Table / column | Sync treatment |
|---|---|---|
| **v38** | `jukebox_requests` (new table) | **LOCAL-ONLY** — not in `synced-tables.js`, **no `uuid` column**. Per `docs/sync-systems-map.md` §2, cloud/peer rows written through ordinary handlers become CRDT mutations; a stranger's typed name must never reach the wire. |
| **v39** | `play_log.source` (`'jukebox'` \| NULL) | **SYNCED** scalar. Opposite call to `generated_schedule.source` (local-authoritative playout state) — play_log is history that already travels, and a mark that stayed home would be honest on one machine and misleading on every other. Never read to make a playout decision. |

Both additive. v39 has **no backfill**: stamping existing rows would be inventing history.

## 5 · Architecture compliance

| Rail | Receipt |
|---|---|
| ONE scheduler | The jukebox schedules nothing on the station. It owns a deck (D/E/F) that rotation, the log reader and the top-of-hour cut structurally cannot see — `audiod/engine.js:521, 604, 648, 708, 751, 905, 950, 1239, 1261, 1599, 1664, 1698, 1795, 1868, 1965` are all `["A","B","C"]`. |
| Daemon is the single source of truth | Deck state, status, fader and finished-flag all read from the daemon / `audio_get_state`. No renderer queue mirror; no optimistic list. |
| Honest state, observed not claimed | ON AIR blinks on the deck's observed `status`, not on AUTO; routing banner reports fader-down / not-routed; missing-file songs excluded from the wall; "request store not created yet" says so rather than erroring. |
| No `?? 1` station guessing | The kiosk refuses to guess: explicit station resolution, honest "No station selected" panel. It never calls `useAudioEngine()` — `AudioEngineContext.tsx:6` defaults to **1** and a pop-out has no provider above it, which is the `?? 1` bug wearing a convenience hook. |
| Physical deck positions are sacred | The jukebox occupies a real Rust deck; deck D shows what Rust deck D is decoding. Rust already sums every slot with fader, cut and trim (`native/src/audio.rs:1151`). |
| Doors before rooms | Jukebox reachable from the canonical ☰ drawer **and** with a help entry; the dead Show+ DAW menu door rewired; the lying Camera door removed; `sync:clear-pending` finally has a door. |
| Station = switchable context | Jukebox pool and request URL are per-station `station_config_kv`; requests carry `station_id`. |
| No new schema without cause | Two additive migrations, both justified above. The category pool needed none — it is a KV scalar. |
| Build the sense | Category counts and pool total in Preferences, routing/on-air state in the kiosk, pending count in the clear-pending confirm, `play_log.source` for honest history. |

## 6 · Help entries

- **`docs/help-jukebox.md`** — new. Covers set-up (tick categories → patch into deck D/E/F → open from
  ☰), the queue and placement, its own AUTO vs the station's, ON AIR vs fader, Escape/F11, what it does
  to what's on air (event tool: music only, no traffic or spots, ever), troubleshooting including the
  D/E/F meter gap, and what is deliberately absent (phone requests, payments, paid-skip).
- No help entry was needed for the menu fixes (behaviour restored, not a new feature). The clear-pending
  button is documented in its verification doc; if it becomes a routine operator action rather than a
  recovery tool it should earn a help entry too.

## 7 · Known caveats — read before installing anywhere

1. **NOT packaged-smoked.** Nothing has launched this exe. Per the standing bar, a packaged smoke on
   this exact artifact belongs before it reaches OV.
2. **All three arcs are runtime-UNVERIFIED.** Every claim above is a claim about the source and the
   gates. Nobody has seen the jukebox play, clicked the menus in this build, or pressed the new button.
3. **rcedit failed twice during packaging** — `Unable to load file: Ether.exe` on the version/icon
   stamp step. electron-builder retried and the final exe *is* correctly stamped (verified, §2). That
   signature is usually a transient file lock (McAfee, or the signing step). If it recurs and a retry
   does not win, the version/icon stamp silently falls back to defaults — check ProductVersion on every
   build rather than trusting exit 0.
4. **The audio daemon does not reload on auto-update.** Clients must fully close and reopen Ether
   (window **and** tray) for the daemon-side jukebox commands to take effect.
5. **D/E/F have no VU meter or position readout.** Pre-existing and affecting any source on those decks,
   not introduced here: `native/src/audio.rs:962` builds per-deck telemetry from
   `[(0,"A"),(1,"B"),(2,"C"),(6,"CART")]`. Audio plays and mixes correctly; only the meter is blind. The
   fix is adding `(3,"D"),(4,"E"),(5,"F")` there — an audio hot-path change needing a native rebuild, so
   it is Jeff's call, not a side effect.
6. **Clear pending is per-machine.** It discards *this* machine's backlog and sets *this* machine's
   watermark. Running it on OV clears nothing on OVEVENTS.

## 8 · Sequencing from here

1. **Packaged smoke** on `Ether Setup 4.4.226.exe`.
2. **Install on both machines.** The re-key guard from 4.4.225 only protects the machine running it and
   works on the *receiving* side, so an un-updated machine stays exposed.
3. **Then** the re-key repair (`5→1, 6→2, 7→3, 8→4`, uuid-anchored) — dry run and DB-copy proof first,
   Ether fully closed for the write. In progress; its own doc will carry the JSON receipts.
4. **Then** OV's clear-pending: Preflight (record pending + baseline) → `CLEAR PENDING…` → type
   `CLEAR` → `DISCARD BACKLOG` → Preflight again.
5. Open, unbuilt, and previously flagged: Phase 2 of the jukebox (public request page — no deploy
   without explicit GO), the D/E/F metering change, and the native Monitors submenu's missing Jukebox
   entry (one-line parity fix).
