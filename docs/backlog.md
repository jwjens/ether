# Backlog

## Show+ device layer — one acquisition service (filed 2026-07-27)
Full design: `docs/showplus-device-layer-design-2026-07-27.md`.
- **Systemic root:** NO device manager/broker/refcount anywhere — every component calls
  `getUserMedia`/`getDisplayMedia`/`enumerateDevices` directly (16 sites mapped). Windows cameras are
  single-open, so two paths on one device → "Requested device not found." The 3 device bugs this session
  were three faces of this one gap.
- **INTERIM two-patch (shipping 4.4.95):** (1) camera double-open — `HostCamera` (`ShowPlus.tsx:686`, holds
  the cam even while hidden) vs `addCameraSource` (`VideoEngineContext.tsx:498`); (2) `AudioDevices.tsx:32-41`
  gated-enumerate (second live copy of the bug fixed in `ShowPlusPanel`).
- **FULL fix (designed, not built):** one device-acquisition service — open each physical device once
  (keyed deviceId+kind), hand out shared/cloned tracks, reference-count + release on last consumer,
  enumeration fully decoupled from grants (single `listDevices`), typed errors not silent catches, one
  screen path (retire legacy `useScreenShare`). Generalizes the host-stream-by-reference pattern that already
  works (`ShowPlus.tsx:2392` + `VideoEngineCanvas.tsx:82`). Real-device code — proves out only on install.
  (added 2026-07-27)

## Seamless daemon update — no dead air on install (filed 2026-07-27)
Full design: `docs/seamless-daemon-update-design-2026-07-27.md`. **Build nothing yet.**
- **Diagnosis:** UI-only updates are ALREADY gapless (daemon detached, `installer.nsh` never kills
  `ether-engine.exe`, `quitAndInstall` relaunches only the UI). Dead air comes from ONE class: **new
  daemon code** (`audiod/*.js` or a new `native/ether-audio.node`). A native process image can't hot-swap,
  so the only way to run it is `reloadDaemon()` → shutdown → respawn, which (a) drops the Icecast mount
  (ffmpeg lives INSIDE the daemon, `audiod/stream.js`) and (b) reloads decks from zero. And the reload is
  guarded to never kill a live engine (`main.js:340-354`), so it often doesn't fire at all → CLAUDE.md's
  "must fully close and reopen" caveat.
- **PHASE 1 — Stream Relay (the only part worth considering soon).** Extract ffmpeg + the Icecast socket
  out of the daemon into a small long-lived relay that survives both app AND daemon restarts; it reads PCM
  from whichever mixer is the current producer over a stable local port and supports a producer swap. The
  Icecast mount then never drops even across today's hard daemon reload — kills the listener-facing dead
  air for the whole daemon-update class with NO shadow machinery. Leverages the 256 KB Icecast burst buffer
  already raised on Lightsail. Ships behind a flag, off-air-proven then OV-proven; rollback = today's
  in-daemon encoder. Health event `relay-producer-switch` measures the ACTUAL listener-side underrun.
- **PHASE 2 — Shadow-daemon handoff — PARKED INDEFINITELY.** Two mixers + device release/acquire + producer
  crossover is too close to the process-swap/device-contention surface behind the dead-thread and
  silent-daemon incidents (`incident-two-stations-silent-2026-07-15.md`,
  `incident-jingle-cart-panic-2026-07-15.md`), and it depends on the Log-Reader Flip reaching Phase 3 (the
  time-anchored playhead is the only clean mid-song resume primitive). Not scheduled; if ever revisited,
  strictly AFTER the flip's Phase 3 burn-in. (added 2026-07-27)

## Auto-generation — rolling-horizon top-up (filed 2026-07-22)
- **PREREQUISITE — the Generate-worker release.** Generate must move OFF the main thread into the worker
  (the same class as the 4.4.77 senses-freeze fix: synchronous 24h×slots generation blocks the main
  event loop — a `schedule:generate` 7-day run was the likely 17s freeze on 2026-07-21). Once Generate
  runs in the worker, the automatic pass below can hang off it. Auto-generation REQUIRES this — do not
  build it before the worker exists.
- **AUTO-GENERATION — rolling-horizon top-up per station (requires the Generate-worker release).** A
  daily background check **in the worker, never main-thread** generates any missing days to maintain a
  configurable horizon (default **7 days ahead**; per-station setting + on/off). Respects the
  in-progress-hour rule and the clock law (deleted_at-filtered slots, per the 4.4.76 fix). Every run
  emits a health event ("generated N hours for station X" / "nothing needed"). Manual Generate stays for
  edits/regeneration; the automatic pass makes **"the log ran dry" a retired failure class**.
  - **NEW SENSE — "Schedule horizon" Health Monitor row per station:** days of log remaining (green ≥5,
    yellow <3, red <1) — the log's fuel gauge, visible. (Ships as part of this release.)
  - Sequencing after: Log-Reader Phase 3 flip (the flip promotes the log to the single playout source;
    a dry log there = dead air, so the horizon top-up + fuel gauge matter most once the flip is on).

## Jingles re-enable + the dead-thread class (2026-07-15 maiden-fire crash)
- **NEXT NATIVE RELEASE — `audio.rs:988` CART-exhaustion out-of-bounds (the root fix).** The mixer's "source exhausted" loop iterates all 7 decks and does `fin.set(DECK_LETTERS[i])`, but `DECK_LETTERS` is len 6 (`[&str;6]`, `audio.rs:577`) and slot 6 is the CART channel — so when a CART source plays to natural end (first done by the maiden jingle overlay), `DECK_LETTERS[6]` panics and kills the `cpal_wasapi_out` thread → permanent dead air. Fix: handle the CART slot by its own key (`fin.set("CART")`), never index `DECK_LETTERS`. Prove with an explicit **CART-plays-to-natural-end** test, then flip the jingle kill-switch (`audiod/loggen.js JINGLES_ENABLED`) back to true and re-enable jingles. See `docs/incident-jingle-cart-panic-2026-07-15.md`. (added 2026-07-15)
- **DEAD-THREAD RECOVERY (same family, still unbuilt) — a panic that kills a mixer/output thread must NOT equal permanent dead air.** Today proved this scenario is real: `cpal_wasapi_out` panicked, the thread died, the station stayed silent forever. The auto-recovery watchman (`startAudioLivenessWatchdog`, REOPEN-on-wedge) and AUTO-cycling CANNOT cure this class — you can't revive a dead thread by re-issuing automationStart; only rebuilding the stream/output can. Build the fix-plan's **thread-death detection + stream rebuild** machinery: detect a dead output/mixer thread (frames frozen + thread gone) and rebuild the cpal output + program bus for that station, unattended. (added 2026-07-15)

- **Reel Splitter imports → join the content-hash/songs_v2 cutover.** The Reel Splitter (shipped v4.4.58) registers rendered regions through the shipped `file_path`-based import (`songs.create` + `updateById`). When the content-hash identity / `songs_v2` / content-store cutover happens (ether-v2 D1/D4, `scripts/import-library-v2.js` is the offline genesis), the Reel Splitter's import path joins that surface — hash the rendered region, key by `content_hash`, copy into the store. (added 2026-07-15)
- **Honest-UI cleanup pass — dead controls the Reel Splitter inventory (2026-07-15) exposed. Each gets WIRED or REMOVED (dead controls violate the honest-UI principle):**
  - **Silence-trim toggle** — `setAutoSilenceTrim` is threaded into LivePanel (`App.tsx:2443/3371`) but the TRIM button is never rendered (lives only in the unapplied codemod `patch-header.js:17`). Analysis runs by default anyway; either surface the toggle or drop the dead prop + codemod.
  - **`ether.fs.writeFile` / `fs:mkdir` / `fs:copyFile`** — preload stubs (`preload.js:157-159`) with NO main handler; `invoke` throws. Add the `ipcMain.handle("fs:writeFile"…)` handlers or remove the stubs. (Read-side `fs:readFile`/`fs:exists`/`fs:readDir` ARE registered, `main.js:3059-3097`.)
  - **StudioPro "send to cartwall" / "stream this mix"** — dispatch `ether:send-to-cartwall` / `ether:stream-mix` events (`StudioPro.tsx:2920/2933`) with NO `addEventListener` consumer anywhere. Wire a listener or remove the buttons.
  - **StudioPro / BroadcastEditor / StudioEditor / zettaBridge export-to-disk** — all call the dead `ether.fs.writeFile`; StudioPro silently falls to a path-less blob download, the others just fail (`✗ Export failed`). Fix onto `ffmpeg.writeAudio` (the verified path) or remove. (added 2026-07-15)

## Teardown log (temporary diagnostic tooling)
- **2026-07-14 — TORN DOWN: `bug-watcher.sh` dead-air/wedge watcher (+ `pull-monitor.sh`, `web2desktop-monitor.sh`).** Read-only diagnostic loops in an old session scratchpad (`Temp/claude/H--/8ba6e781…/scratchpad`). `bug-watcher.sh` shelled out to `powershell.exe` ×2 every 15s for Ether/daemon liveness; the git-bash `while true` self-multiplied into **9 forked loops** → ~18 conhost windows/15s → machine freeze. **No registered persistence existed** (no scheduled task, Run/RunOnce key, Startup entry, or watcher service — `CoworkVMService` is the Claude desktop app's own packaged service, untouched). Killed all 9 by cmdline match (Ether/daemon/HA-watchdog untouched); renamed the 3 scripts to `*.sh.disabled-20260714`. Daemon + all 3 stations aired through it (drain real≈354k B/s each, zero silence; watcher's own alert log clean after the 18:08 relaunch). Replaced by the **Health Monitor** (built-in observability) — do NOT re-arm external watchers; see the two new CLAUDE.md ground rules.

- Watcher signal-quality rework: base per-station health on the Rust drain layer (real vs zero B/s), not the `[mix sN]` JS heartbeat (which only emits for the active station). v2 draft exists in session scratchpad; formalize + decide permanent home. (added 2026-07-14)
- BOOT RECOVERY: after a machine crash/reboot nothing self-started; the `EtherHAWatchdog` scheduled task is Disabled. It should be enabled/fixed to bring the stack back unattended. (added 2026-07-14)
- ether-dashboard: 4 Dependabot vulnerabilities on default branch (2 high, 1 moderate, 1 low) — review + bump. https://github.com/jwjens/ether-dashboard/security/dependabot (added 2026-07-14)
- Desktop account sign-in routes through `/api/user/desktop-activate` (`src/components/OnboardingFlow.tsx:424,445`) → lk-less `typ:"user"` token → account-scoped READ endpoints (`/api/account/stations`, `/data`, `/api/me/memberships`) return empty/404 for the install. Route it (also) through `/api/auth/owner-login` (email+password → `lk`-bearing token, same path the dashboard uses) and store that as `account_jwt`. Real but SEPARATE from the categories/programming sync (which is license-keyed). Fixes RBAC/account-scoped reads only. (added 2026-07-14)
- **`src/lib/spotProjection.ts` duplicates `loggen.orderForNearestAnchor` — one rule, two implementations.** The Health Monitor's Spot Schedule section projects when a pending spot will actually air, and for flipped stations that requires the nearest-anchor comparison (reach window, 2s tie band, `:00` exclusion). Rather than reach into the daemon, the renderer mirrors the arithmetic — so `TIE_SEC` and the reach test now exist in two files that must be kept in step, and a change to the selector silently makes the projection lie. **Permanent fix: the daemon exposes its OWN projection** (it already computes seam, queue and the promotion decision) and the renderer just displays it; delete the renderer copy. **Rides with renderer-as-pure-view §1/§2** (`docs/design-renderer-as-pure-view-2026-07-30.md`), which is already removing the renderer's parallel state — same principle, same release. Both files carry a comment pointing here. (added 2026-07-30)
- **GENERATE writes rows for NULL-category songs that the on-format read can never select.** Song id 397 `'"The Munsters" Theme'` has `category_id = NULL`; station 4's first Generate run (2026-07-24T21:02:42, the day the station was created) scheduled it 82 times. `getFormatCategoryIds()` derives the on-format set from `clock_slots.category_id`, so a NULL-category song is in NO category and is dropped by every on-format read — the rows sit `pending` forever, never airing, inflating the log-reader's `missed` backlog and appearing to the auto-fitter as candidates that can never be picked. **Same family as the 2026-07-21 OF cat-1 finding** (`docs/generate-clock-law-deleted-slots-2026-07-21.md`): Generate walks rows the on-format read then rejects. Jeff's ruling there applies — *the clock is law; Generate is the violator*. **SCOPE, measured 2026-07-30:** 74 songs have `category_id IS NULL` (a mix — `Daydream Believer`, `Spooky Halloween Sounds`, `This Is Halloween`, `Golden`, and the `14_CHRISTMAS_Transition…` jingle files); 0 songs point at a deleted/missing category; and `generated_schedule` rows referencing a NULL-category song number **s1 1 · s2 9,613 · s3 4,684 · s4 8,341**. So this is NOT confined to station 4 — it is the biggest single source of unairable pending rows across the install. **TWO QUESTIONS TO ANSWER FIRST:** (1) how does a song get imported with no category at all — which import path leaves it NULL, and should the schema forbid it? (2) should Generate refuse to schedule a NULL-category song, or should import assign one? Debris cleanup for s4's 7/24 rows is `scripts/cleanup-stale-pending-s4.js` — that clears the symptom only. (added 2026-07-30)

- **Reconcile fires a doomed fetch at Railway every ~20 s — 1,767 failures in `ether-startup.log`, first on 2026-07-09.** `[reconcile] account stations reconcile failed: Failed to fetch (ether-backend-production.up.railway.app)`. Railway is eliminated as a dependency, so this timer is calling a host that is not coming back: it burns a network round-trip and a log line three times a minute forever, and it drowns the startup log — during the 2026-08-03 freeze trace it was ~95% of the file, which actively slowed diagnosis. **Fix: kill the timer or repoint it at the surviving endpoint**, and make its failure state visible once (a health event) instead of logged endlessly. Small and self-contained. (added 2026-08-03)
- **`health-events.jsonl` stopped being written at 09:00 on 2026-08-03 — seven minutes BEFORE the Generate freeze at 09:07.** The watcher went blind exactly when it was most needed: the minutes leading into the hang have no health record, so event-loop lag immediately pre-freeze is unknowable. Last events written were three YELLOW `event-loop lag` entries (576/772/709 ms) at 15:58:50–15:59:13Z, all in the first 90 s after launch. **Question to answer first: did the writer stop because main was already degrading, or on its own (rotation, size cap — the file is 29 MB, handle loss)?** That determines whether the silence is a symptom or a second bug. **This is a BUILD-THE-SENSE failure either way** — the observability layer must not be the first thing to fail under the load it exists to observe. (added 2026-08-03)
- **Idle-CPU diet — the app holds ~2.2 cores doing nothing.** Measured 2026-08-03 on 4.4.121 over ~10 min uptime: main 511 s CPU, renderers 402 s + 429 s (≈85%, 67%, 71% of a core each, sustained, with no operator activity). Memory is fine (202/227/254 MB, no leak). **Step 1 is a per-source breakdown, not a trim** — candidates are the proc-meter subscription, the 5 s KV poll, the Live Activity terminal tail, the Spot Schedule board walk, and the Health Monitor's 1 s playout-mode poll. Instrument each, attribute the cost, THEN cut. Also check listener re-registration on station switch (subscribe without cleanup is the classic accumulator). (added 2026-08-03)
