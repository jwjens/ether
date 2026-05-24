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

Parked for future arcs:

- **OB19** — remove the auto-seeded "Station 1" entirely (audit `station_id=1` hardcodes, restructure default seed data). Multi-session arc.
- **OB20** — pre-launch tier feature-gating audit, **blocked on the operator refreshing the website tier-feature list** (current list is stale). Includes the multi-station label/gate mismatch (labeled Enterprise, website says Network).
- **HA Phase 2.5** — mutual supervision (Ether relaunches a dead watchdog); closes the "who watches the watchdog" gap. Small follow-up — see §9.
- **HA Phase 3–5** — startup registration, auto-logon installer, health dashboard. Fully scoped in §9.

**Next session entry point:** this file. The HA arc continues at **Phase 3 (§9)** — open product decisions there need the operator's call before code. (Other parked work: OB19/OB20 in `docs/close-out-tracker.md`.)

---

## 9. HA arc — Phase 3–5 plan (scoped, not started)

Context: Phase 1 (`/health`) + Phase 2 (crash/hang watchdog) shipped this session. The watchdog must currently be started by hand (`npm run watchdog:dev`). The remaining phases make HA automatic, survive unattended reboots, and surface health. Architecture rationale (why not a Windows Service: in-process session-scoped audio + per-user data) is in the watchdog README and the earlier investigation.

### Phase 2.5 — Mutual supervision (small follow-up, do alongside Phase 3)
- **What:** Ether's main process learns the watchdog's PID (passed as an env var at spawn) and relaunches the watchdog if it's gone; the watchdog already relaunches Ether. Bi-directional keep-alive.
- **Why:** v1 gap — if the watchdog process itself dies, Ether runs unsupervised until next logon.
- **Scope:** ~40–70 LOC. `watchdog/watchdog.js` (pass `ETHER_WATCHDOG_PID`/handshake), `electron/main.js` (periodic check + relaunch of the watchdog binary).
- **Dependencies:** Phase 2 (done).
- **Open decisions:** how Ether re-launches the watchdog in dev vs packaged (mirror the watchdog's own dev/packaged spawn logic); guard against a mutual-respawn storm.

### Phase 3 — Startup registration (watchdog auto-launches at logon)
- **What:** register the watchdog as a per-user logon item so it starts automatically whenever the operator logs in; it then spawns Ether. Implements `registerStartup`/`unregisterStartup` (currently stubbed in `platform/win32.js`). This is also where the **packaged-build validation (#8)** finally happens.
- **Why:** without it, HA only runs when someone manually launches the watchdog. This makes "Ether is always running after logon" true out of the box.
- **Scope:** ~80–150 LOC + a packaged build. `watchdog/platform/win32.js` (implement register/unregister), likely a small `watchdog/install/register.js` CLI the app/Settings invokes, a Settings toggle, `electron-builder.json` if a post-install hook is wanted.
- **Dependencies:** Phase 2 (done); needs a **packaged build** to validate properly (dev spawn path already works).
- **Open decisions (need your call):**
  1. **Mechanism:** per-user **Scheduled Task** ("at log on", with restart-on-failure as a backstop) vs **HKCU\…\Run** key. Recommend Scheduled Task (delay-start, more control, a built-in backstop).
  2. **Per-user (HKCU/no-admin) vs all-users (HKLM/admin).** Recommend per-user — matches the no-admin per-user install.
  3. Confirm the **watchdog-as-parent** model (watchdog launched at logon → spawns Ether), vs the inverse.

### Phase 4 — Auto-logon installer (the big arc)
- **What:** opt-in, consented configuration that boots the machine straight into the operator session (so Ether returns after an unattended reboot), via the **LSA-secret** method (`AutoAdminLogon` + `DefaultUserName` in Winlogon, password stored encrypted via `LsaStorePrivateData` — the Sysinternals Autologon approach). Plus a Settings **enable/disable/repair** surface and **uninstall teardown**.
- **Why:** covers unattended reboot (power loss, Windows Update, manual). Without auto-logon a reboot stops at the login screen and Ether never starts; the in-session watchdog can't help until a session exists.
- **Scope:** ~300–500 LOC + an elevated helper. New `watchdog/install/ha-setup` (elevated helper: Winlogon keys + LSA secret + scheduled-task register/unregister), `build-resources/installer.nsh` (NSIS `customInstall`/`customUnInstall` + consent prompt), `electron-builder.json` (`nsis.include`), Settings UI (`SettingsPanel.tsx`) enable/disable/repair + status.
- **Dependencies:** Phase 3 (auto-logon brings the session up; the startup item launches the watchdog). Needs the installer + elevation.
- **Open decisions (need your call):**
  1. **Consent + default:** opt-in, default OFF, with copy spelling out the physical-access tradeoff (machine boots into the operator account). (Locked earlier — reconfirm at build time.)
  2. **Password capture:** the installer/helper must capture the Windows account password to store the LSA secret — which screen, and how it's handled.
  3. **Elevation model:** per-user install + a one-time UAC-elevated `ha-setup` helper, vs a perMachine installer.
  4. **Graceful degradation messaging** for machines where auto-logon can't apply (domain/Entra-joined, Windows Hello for Business, BitLocker boot PIN, GPO that strips AutoAdminLogon) — what the UI tells the customer.
  5. **LSA helper implementation:** PowerShell calling `advapi32!LsaStorePrivateData`, a tiny native exe, or shelling to Sysinternals Autologon (licensing/redistribution check).
  6. **Teardown scope:** uninstall + "disable HA" must clear `AutoAdminLogon`, the LSA secret, and the startup registration — confirm.

### Phase 5 — Health dashboard UI + operational runbook
- **What:** surface the existing `/health` data in-app (a Station Health panel: process uptime, audio-liveness, sync state, active station, memory; plus watchdog status / last restart / alarm) and write an operator runbook ("what to do when…").
- **Why:** `/health` is rich but only curl-able today; operators need an at-a-glance view + documented recovery procedures. (Roadmap HA pieces 3 + 4.)
- **Scope:** ~200–300 LOC UI + a doc. New `src/components/StationHealth.tsx` (poll `/health`), nav wiring; new `docs/ha-runbook.md`. Surfacing watchdog internals (restart count, alarm marker) needs a small watchdog→app channel (read `watchdog.log`/alarm file, or an IPC).
- **Dependencies:** Phase 1 (`/health`, done) for the data — so Phase 5 is largely **independent** and could slot earlier if desired. Watchdog-status surfacing wants Phase 2/3.
- **Open decisions:** standalone panel vs fold into Settings/Logs; how much watchdog internal state to surface (and the channel for it); runbook format/audience.

**Suggested order:** Phase 3 (+ 2.5 alongside) → Phase 4 → Phase 5 (or pull Phase 5 earlier — it only needs `/health`). Phase 4 is the heaviest and most decision-laden; resolve its open decisions before coding.
