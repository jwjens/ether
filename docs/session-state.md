# Session State — Roadmap Tracking

**Updated:** 2026-05-24
**Purpose:** Snapshot of where the project actually is relative to `roadmap.md`, including in-flight detours that don't show up in the roadmap doc itself. Maintained so a fresh session (or a returning operator after time away) can pick up the actual current thread without reconstructing it from chat history.

This doc supplements `roadmap.md` — it does not replace it. The roadmap is the long-arc plan; this doc is "what's actually happening right now."

---

## 1. Current roadmap position

**Officially:** Item 3 — High Availability Architecture (`roadmap.md` §3).

Items 1 (Sync Backend) and 2 (Deploy OV + 2nd Client) are complete. Item 3 is the declared next major arc. Items 4 (Iris-as-Platform), 5 (Multi-Tenant Control Center), 6 (Plugins/OSS/BYO-Cloud), 7 (AirLogger), and 8 (Onboarding & Library Distribution) follow per the roadmap.

Note: roadmap.md still shows Item 2 as "Ready to start" and Item 8 as "Not started." Both are stale — Item 2 was proven 2026-05-19 (commit 36d92dc), and Item 8's R2 schema columns landed in v17/v18 (commits 5b2afe8 et al). Roadmap update is itself a small follow-up.

---

## 2. Detours queued before Item 3

Several arcs sit in front of Item 3's actual execution. None are in roadmap.md by name — they're support work for the main path.

### UI tooling — Phase 1 (debug panel)

**Status:** Built & verified, BUT still uncommitted in the working tree as of 2026-05-24 — it was never folded into a commit this session (every commit deliberately worked around it). The 5 files below remain dirty/untracked. Commit it as its own change next session (or whenever convenient).

**Scope:** Dev-only debug panel reached via `#debug` URL hash or footer-version triple-click. Three sections — tier override (Solo/Studio/Network/Enterprise marketing labels mapped to free/pro/station/operator code values), reset onboarding, jump-to-screen (Onboarding / Subscription / Manage Devices / About / Settings). Plus `window.__devSetTier/__devClearTier/__devResetOnboarding` console helpers. Three layers of gating (`import.meta.env.DEV` build-time + runtime) ensure zero footprint in packaged builds.

**Files touched (5):**
- New: `src/components/DebugPanel.tsx`, `src/lib/devGlobals.ts`
- Edited: `src/main.tsx`, `src/hooks/usePlan.tsx`, `src/App.tsx`

**Why it's a detour:** Closes the immediate visibility gap — operator could not see UI changes in-session without reinstalling a packaged build. Phase 1 enables every subsequent UI arc (including the HA work's health dashboard) to be testable as it's built.

### UI tooling — Phases 2–5

**Status:** DEFERRED post-launch. Scoped in prior session.

- Phase 2: Playwright + critical-path tests (onboarding, license activation, station switch) — ~2–3 sessions
- Phase 3: Beta release channel via electron-updater — ~½ session
- Phase 4: Storybook + component isolation + mock layer — ~3–4 sessions (incremental)
- Phase 5: Visual regression (Playwright snapshots first, Chromatic if Storybook lands) — ~½ session

Sequencing rationale: Phase 1 alone closes the immediate gap. Phases 2–5 compound over time but are not blocking any product arc.

### Tier rename arc

**Status:** DEFERRED. Full execution plan drafted (4 commits across 2 repos: 3 ether-backend + 1 openair). Not blocking.

**Plan summary:** Rename `free/pro/pro_lifetime/station/station_lifetime/operator` → `solo/studio/studio_lifetime/network/network_lifetime/enterprise` across both repos. Production data is tiny (4 active licenses, all internal: 2× sync-test, 2× djdeniro). Hard cutover with transient-window safety via unioned `VALID_PLANS` in backend. Total ~218 LOC.

**Why deferred:** Cosmetic cleanup. The marketing labels (Solo/Studio/Network/Enterprise) are already being introduced in UI copy and the debug panel. Code-level rename can wait for a calmer window.

### Phase A — multi-station main-process work

**Status:** Partial. Phase B1 (Rust BusMixer + Program Bus TCP) shipped (commit 3249da6). Phases B2–B6 not shipped. Original Phase A multi-station plumbing (Step 0-C INSERT audit, engine map in main.js, per-station stream state map) not finished.

**Why it's a detour:** Phase A is the foundation for the Item 3 "graceful audio crossfade across restart" piece. The in-memory Program Bus tap that B1 introduced is the architectural seam where crossfade-across-restart would be wired. Item 3 can ship its other 4 pieces without Phase A, but the crossfade piece architecturally wants B1 (done) plus a separate audio host process (not done).

---

## 3. Item 3 (HA) scope decision

**Locked:** Ship the Phase-A-independent HA pieces first. Defer crossfade-across-restart until a separate audio host process exists.

**What ships in the first HA arc:**
1. Process supervisor with crash detection + auto-restart (single Ether process)
2. Sync engine resilience hardening (UI surfacing of disconnect state, powerMonitor network hooks, observability on long disconnects)
3. Health dashboard (process uptime, last sync tick, deck states, cursor position)
4. Operational runbook for station operators

**What's deferred to the post-Phase-A HA arc:**
5. Graceful audio crossfade across process restart

**Reasoning:** OV currently fails the Program Director Test the moment Ether crashes — no crash recovery exists. A supervisor that auto-restarts in 5–30 seconds is a huge improvement deliverable in days. Doing all of Phase A first would leave OV with no crash recovery for the duration of Phase A (multi-week arc). Crossfade-across-restart is real but architecturally entangled; better to wait for the right seam to land. Listeners will hear 5–30s of dead air on the restart instead of indefinite silence — acceptable interim state, huge net improvement.

---

## 4. Sequencing locked

```
1. Debug panel                        (today — in progress)
2. Partial HA — OV crash recovery     (next arc)
3. Phase A multi-station OR
   Tier rename OR
   Item 4 (Iris-as-Platform)          (next-next — operator picks)
```

The choice at step 3 is open. Each is a multi-session arc and they don't block each other:
- **Phase A** completes the architectural foundation for the deferred Item 3 crossfade piece and unblocks Item 5 (Control Center).
- **Tier rename** is cleanup; longer it sits, the more sites accrete with the old names.
- **Item 4** is a big architectural arc (Iris-as-Platform) with substantial open design questions.

---

## 5. Open tracker items surfaced today

**OB17 — Consolidate duplicate `TIER_RANK_LOCAL`**

The tier-rank lookup table is duplicated 4 times across the codebase: `electron/main.js:3188`, `electron/main.js:3879`, `electron/main.js:4025`, `electron/cloud-backup.js:27`. Each is a verbatim copy of the canonical `TIER_RANK` in `src/hooks/usePlan.tsx:20`. Surfaced during the tier rename audit — flagged for cleanup but kept duplicated for this phase to avoid mixing rename with refactor.

**Resolution:** Extract a shared module (e.g., `electron/lib/tier-rank.js`) that the 4 electron-side sites can import. Will eliminate 4× drift risk during future renames.

**Bundle with:** Tier rename arc when it executes, or as a standalone tiny cleanup commit.

---

## 6. Operator-side follow-ups (dashboard / manual work)

These are not Claude-actionable — they require operator-level access to external dashboards. Tracked here so they don't fall off the radar.

- **Resend domain verification** for `ether-technologies.com` — confirm DNS records and email deliverability propagation through the rename from `etherradio.app`.
- **Rotate `ADMIN_SECRET`** — exposed in chat during recent debugging. Update on Railway → restart backend → confirm `/admin/issue` still works with the new value.
- **Rotate Postgres password** — exposed in chat (visible via `railway variables` output). Update on Railway → confirm backend reconnects.
- **Verify email aliases work** — `support@`, `legal@`, `noreply@` at `ether-technologies.com`. Send test mails, confirm delivery + reply routing.

---

## 7. Last verified working state

- **Version shipped:** Ether v4.1.11 (commit fbd9112).
- **Branch:** main on both repos (`C:\openair` and `C:\ether-backend`).
- **All session work merged:** no in-flight branches pending integration on either repo.
- **Railway deployments:** active. Backend at `ether-backend-production.up.railway.app` healthy.
- **Production licenses (Railway):** 4 active rows confirmed 2026-05-23 via `list-licenses.js` — 2× pro (sync-test@ether.dev, sync-test2@ether.dev), 2× station (djdeniro@gmail.com × 2). No unexpected plan values.
- **Sync convergence:** proven 2026-05-19 (commit 36d92dc) — LIVE CONVERGENCE + LIVE-DATA FK-VALID.
- **OV install:** running v4.1.11 against the active backend. No outstanding deployment.

---

## 8. Session close — 2026-05-24

What shipped this session (newest last):

- **v4.1.11 customer release** — already live (commit fbd9112).
- **Debug panel (Phase 1 UI tooling)** — built, verified, **shipped** (commit 20d8efd: `DebugPanel.tsx`, `devGlobals.ts` + integration in `App.tsx`/`usePlan.tsx`/`main.tsx`). Dev-only, tree-shakes out of prod. Known minor (deferred, dev-only): Clear-Override doesn't dismiss the tier banner.
- **OB18 — onboarding local-mirror fix** — submitAddStation/submitBindSeat now mirror backend station create/bind into the local stations table (commits 165f8d1 + e42ae26).
- **EB17 — abandoned-onboarding cloud orphan** — cleanup tooling shipped (`ether-backend/scripts/delete-orphan-station.js`, commits 005d310 + 52de3f8; tracker entry 69ca965) **and executed** — orphan "Ether Radio" + its dangling seat binding deleted from Railway.
- **Onboarding connect-path redesign** — returning customers pick an existing station and drop straight into the app (skip experience/venue/name/audio/pull); empty-account → add-station fallback (commit 2c3f61f).
- **Manage Stations delete fix** — `stations:list`/`:get-active` now filter `deleted_at IS NULL` (bundled in 2c3f61f).
- **Ghost "Station 1" soft-deleted at pick** — pragmatic interim; proper fix tracked as OB19 (bundled in 2c3f61f).
- **Tier label rename (customer-facing)** — Free→Solo, Creator/Pro→Studio, Station→Network, Operator→Enterprise across both repos; internal code values unchanged (openair af1c786 + ether-backend fe1df59).
- **HA Phase 1 — health signal** (commit 4ceaca9): `GET /health` on the :3400 server + a lock-free audio-liveness atomic (`audioLastCallbackMs`, stamped on every cpal callback; engine-thread liveness). Verified via curl + a node smoke test.
- **HA Phase 2 — watchdog process** (commit 5a762b3): separate-process supervisor (bundled Electron-as-Node) that spawns Ether as a child and restarts on **crash** or **hang**; sentinel handshake in `main.js` (`.ether-clean-exit` / `.ether-expected-restart`); kill-confirm gate (hang) + crash-loop guard (`.ether-ha-alarm`). **Logic harness 16/16** (caught + fixed a double-respawn race on hang-kill). **Real-app smoke 9/9** — crash → respawn → new instance acquired `:3400` (real `requestSingleInstanceLock` verified). Windows implemented; mac/linux stubbed. Status vs the 8 required scenarios: **5/8 fully-green automated** (user-quit, crash, hang, update-relaunch, crash-loop), #3 hardened by the bug found, **#5 (watchdog self-crash) = documented Phase 2.5 gap**, **#7 real single-instance** verified by the smoke, **#8 (packaged build) deferred to Phase 3**.
- **HA Phase 3 + 2.5 — startup registration + mutual supervision** (commit 13c01ad):
  - **Startup registration (Phase 3):** per-user logon **Scheduled Task** (`EtherHAWatchdog`) via `schtasks /XML` in `watchdog/platform/win32.js` — no admin, `InteractiveToken`/`LeastPrivilege`, 15s logon delay + restart-on-failure backstop. Self-dispatch guard in `main.js` (`--ether-watchdog` runs the watchdog supervisor before the single-instance lock).
  - **CLI bootstrap:** `Ether.exe --enable-ha` (register task + spawn an adopting watchdog) / `--disable-ha` (unregister + kill the watchdog via `.ether-watchdog.pid`). Executed in the `:3400` listen callback so the adopting spawn doesn't race `/health`. No customer-facing toggle yet — `ha:status` is the only HA IPC; enable/disable/repair deferred to Phase 4.
  - **Mutual supervision (Phase 2.5):** Ether monitors `ETHER_WATCHDOG_PID` and relaunches a dead watchdog through the adopt path (`ETHER_ADOPT_PID`), with a 3/5-min storm guard. Closes the "who watches the watchdog" gap (Phase 2 scenario #5).
  - **Bug the smoke caught:** the watchdog spawned the app `detached:false`, so the app died *with* its watchdog — making the 2.5 relaunch impossible in the normal logon path. Fixed: `spawnEther` now spawns `detached:true` so the app outlives the watchdog (symmetric with `relaunchWatchdog`).
  - **Tests:** mock harness **21/21** (`npm run watchdog:test`, incl. adopt + no-storm), in-session smoke **11/11** (`node scripts/ha-smoke-phase3.js`). The smoke caught the detached bug the mock harness couldn't.
  - **Manual logout/login checklist** exists at `watchdog/PHASE3-MANUAL-TEST.md` (packaged build only — validates watchdog auto-launch at logon). **Not yet run.**
- **HA Phase 5 — health dashboard UI + runbook** (commit a22fd33): merged HA supervision state into the existing **System Health** panel (`HealthMonitor.tsx`) rather than a separate view. GREEN/AMBER/RED/INACTIVE rollup banner via pure `deriveHaRollup()` (`src/lib/haRollup.ts`, **11/11** unit tests); High Availability section (watchdog process, startup task, mutual supervision, crash-loop alarm, uptime, audio output, sync, memory) reusing `HealthRow`/`HealthDot`; Recent Events = on-demand `watchdog.log` tail. New IPC: `ha:dashboard` (= `buildHealthSnapshot()` + control-plane, one round-trip, 5s poll paused on `document.hidden`), `ha:alarmStatus` (cheap footer-dot check), `ha:readLog`; `/health` body extracted into shared `buildHealthSnapshot()` with **byte-identical** wire output (watchdog contract untouched); `schtasks /Query` cached 30s. Panel now popout-able (filled the dead `PopoutRenderer` `health` slot); footer NOMINAL dot turns red on a tripped alarm. Operator runbook at `docs/ha-runbook.md` (incl. "test HA without breaking your show") + engineer appendix. Verified: unit 11/11, `tsc` clean, prod `vite build` clean, runtime `/health` served the unchanged contract from the edited main (pid 5060). **Visual click-through (popout/banner colors/footer-red) pending interactive confirmation** — see manual script.

- **HA Phase 4 — auto-logon installer** (commit 16414c4): customer-facing auto-recovery — a **Settings → System → "Keep My Station On Air"** toggle (opt-in, default OFF) that registers the watchdog startup task AND configures Windows auto-logon so a station PC returns to air unattended after a reboot. **This completes the HA arc.** New native crate `native/ha-setup` → `ha-setup.exe` (Rust, windows-rs + winreg): does only the admin work — HKLM Winlogon (`AutoAdminLogon`/`DefaultUserName`/`DefaultDomainName`) + the LSA `DefaultPassword` secret via `LsaStorePrivateData` (encrypted store, not a plaintext registry value); `disable` clears all of it. Password reaches the elevated helper over a **named pipe** (in memory, zeroized — never an argument, never on disk); helper reports via a tiny JSON result file + exit code. `asInvoker` manifest (build.rs) — elevation comes from the `runas` launch, not the exe name (keeps Windows installer-detection from forcing UAC on `cargo test`). IPC `ha:enable`/`ha:repair`/`ha:disable` wired up (were stubs): enable = `registerStartup` (no elevation) → elevated helper via PowerShell `Start-Process -Verb RunAs` (**one UAC**) → write `ha-config.json {enabled,autologon,user}` → bring up the session watchdog, rolling the task back if the elevated step fails; repair re-runs full enable. Pure injection-safe PS-command builder in `electron/ha-elevate.js`. `ha:dashboard` gains `currentUser`. Packaging: `ha-setup.exe` bundled via `extraResources`; NSIS `customUnInstall` (`build-resources/installer.nsh`) best-effort clears auto-logon on uninstall (in-app Disable is the guaranteed teardown). Verified: Rust 3/3 unit + 3 unprivileged smoke cases (arg validation, result JSON, graceful registry-denied), JS 17/17 (`haRollup` + `ha-elevate`), `tsc` + prod `vite build` clean. **The elevated enable/disable round-trip (UAC + real Windows password) + the named-pipe handoff need manual verification on a real desktop — documented for hand-off.**

Parked for future arcs:

- **OB19** — remove the auto-seeded "Station 1" entirely (audit `station_id=1` hardcodes, restructure default seed data). Multi-session arc.
- **OB20** — pre-launch tier feature-gating audit, **blocked on the operator refreshing the website tier-feature list** (current list is stale). Includes the multi-station label/gate mismatch (labeled Enterprise, website says Network).
- **HA arc — COMPLETE.** Phases 1, 2, 2.5, 3, 4, 5 all shipped (see §8). No remaining HA work. Phase 4 (auto-logon installer) shipped 2026-05-24, commit 16414c4.

**Next session entry point:** this file. **The HA arc is complete** (roadmap Item 3 — process supervision, mutual supervision, startup registration, auto-logon installer, and health dashboard all shipped). Next up is whatever Jeff prioritizes from the roadmap — Item 2 (Deploy OV + 2nd Client) remains the gating item for Items 5/8, and Item 9 (Listener Platform, Tier 1 PWA) is independent and parallel-capable. One HA follow-up remains MANUAL, not code: the packaged-build logout/login validation (`watchdog/PHASE3-MANUAL-TEST.md`) + the Phase 4 elevated enable/disable round-trip. (Other parked work: OB19/OB20 in `docs/close-out-tracker.md`.)

---

## 9. HA arc — COMPLETE (Phases 1, 2, 2.5, 3, 4, 5 all SHIPPED)

Context: Phase 1 (`/health`), Phase 2 (crash/hang watchdog), **Phase 2.5 (mutual supervision)**, and **Phase 3 (startup registration)** are all shipped (see §8). HA now auto-launches at logon (per-user Scheduled Task) and the keep-alive is bi-directional. The **remaining** phases make HA survive unattended reboots (Phase 4) and surface health in-app (Phase 5). Architecture rationale (why not a Windows Service: in-process session-scoped audio + per-user data) is in the watchdog README and the earlier investigation.

### Phase 2.5 — Mutual supervision ✅ SHIPPED (commit 13c01ad, 2026-05-24)
- **Delivered:** Ether reads `ETHER_WATCHDOG_PID` and relaunches a dead watchdog via the adopt path (`ETHER_ADOPT_PID`), with a 3/5-min storm guard (`relaunchWatchdog`/`startWatchdogMonitor` in `main.js`). Bi-directional keep-alive — closes the Phase 2 scenario-#5 gap.
- **Resolved decisions:** dev vs packaged relaunch mirrors the watchdog's own spawn logic; storm guard caps relaunches per window; **both directions spawn `detached:true`** so neither process dies with the other (the bug the smoke caught — `spawnEther` was `detached:false`, killing the app with its watchdog).

### Phase 3 — Startup registration ✅ SHIPPED (commit 13c01ad, 2026-05-24)
- **Delivered:** per-user logon **Scheduled Task** (`EtherHAWatchdog`) via `schtasks /XML` — `registerStartup`/`unregisterStartup`/`startupStatus` implemented in `platform/win32.js`. Bootstrap via **`Ether.exe --enable-ha` / `--disable-ha`** CLI flags (not a Settings toggle — that's Phase 4). `ha:status` IPC reports registration + watchdog liveness.
- **Resolved decisions:** (1) **Scheduled Task** chosen over `HKCU\…\Run` (logon delay + restart-on-failure backstop); (2) **per-user, no-admin** (`InteractiveToken`/`LeastPrivilege`); (3) **watchdog-as-parent** confirmed (logon task → watchdog → spawns Ether).
- **Validation:** mock harness 21/21 + in-session smoke 11/11. **Packaged-build / logout-login validation (#8) is the one remaining manual step** — `watchdog/PHASE3-MANUAL-TEST.md`, not yet run.

### Phase 4 — Auto-logon installer ✅ SHIPPED (commit 16414c4, 2026-05-24)
- **Delivered:** opt-in (default OFF) **Settings → System → "Keep My Station On Air"** that registers the watchdog startup task and configures Windows auto-logon (`AutoAdminLogon` + `DefaultUserName`/`DefaultDomainName` + the LSA `DefaultPassword` secret), so the machine returns to air unattended after a reboot. New native crate `native/ha-setup` → `ha-setup.exe` (Rust, windows-rs + winreg). `ha:enable`/`ha:repair`/`ha:disable` IPC; one UAC per action via PowerShell `Start-Process -Verb RunAs`. Uninstall teardown via NSIS `customUnInstall`.
- **Resolved decisions:** (1) **opt-in, default OFF**, with consent copy spelling out the physical-access tradeoff. (2) **Password captured in the Settings section** (not the installer), sent to the elevated helper over a **named pipe** — in memory, zeroized, never an argument or on disk. (3) **Per-user install + one-time UAC-elevated helper** (not perMachine). (4) **Edge cases skipped** (domain/Entra/Hello/BitLocker) — built for normal local Windows accounts, per the locked scope. (5) **Tiny native Rust exe** — Sysinternals Autologon redistribution is **forbidden by its EULA** (confirmed), so `ha-setup.exe` calls `LsaStorePrivateData` directly. (6) **Full teardown** on disable/uninstall — clears `AutoAdminLogon`, `DefaultUserName`/`DefaultDomainName`, the LSA secret, the Scheduled Task, and `ha-config.json`.
- **Notable build details:** `asInvoker` manifest (build.rs) — elevation is from the `runas` launch, not the exe name, which also keeps Windows installer-detection from forcing UAC on `cargo test`. Pure injection-safe PowerShell builder in `electron/ha-elevate.js`. `enable` rolls the task back if the elevated step fails.
- **Validation:** Rust 3/3 unit + 3 unprivileged smoke cases (arg validation, result JSON, graceful registry-denied); JS 17/17; `tsc` + prod `vite build` clean. **MANUAL pending:** the elevated enable/disable round-trip (UAC + real Windows password) and the named-pipe password handoff — can't be exercised headlessly.

### Phase 5 — Health dashboard UI + operational runbook ✅ SHIPPED (commit a22fd33, 2026-05-24)
- **Delivered:** HA state **merged into the existing System Health panel** (`HealthMonitor.tsx`), not a separate view. Rollup banner (GREEN/AMBER/RED/INACTIVE) from pure `deriveHaRollup()` (`src/lib/haRollup.ts`, 11/11 unit tests); HA section reusing `HealthRow`/`HealthDot`; Recent Events = on-demand `watchdog.log` tail; popout-able (filled the dead `PopoutRenderer` `health` slot); footer NOMINAL dot reds on alarm. Operator runbook `docs/ha-runbook.md` + engineer appendix.
- **Resolved decisions:** (1) **merge** into System Health (not standalone/Settings); (2) watchdog internals surfaced via a combined **`ha:dashboard`** IPC (health snapshot + control-plane) + **`ha:alarmStatus`** (footer dot) + **`ha:readLog`** (events) — `/health` left byte-identical via shared `buildHealthSnapshot()`; (3) `schtasks` cached 30s so the 5s poll never spawns a subprocess; (4) poll paused on `document.hidden` (not blur — second-monitor popouts keep updating); (5) runbook = operator-facing + engineer appendix.
- **Validation:** unit 11/11, `tsc` clean, prod `vite build` clean (859 modules), runtime `/health` served the unchanged contract from the edited main (pid 5060). **Visual click-through (popout / banner colors / footer-red on alarm) pending interactive confirmation.**

**Suggested order:** ~~Phase 3 (+ 2.5)~~ ✅ → ~~Phase 5~~ ✅ → ~~Phase 4 — auto-logon installer~~ ✅. **The HA arc is complete.** Remaining is manual validation only: the packaged-build logout/login test (`watchdog/PHASE3-MANUAL-TEST.md`) and the Phase 4 elevated enable/disable round-trip.
