# Ether HA watchdog (Phase 2)

In-session process supervisor that keeps Ether running. Runs as a **separate
process** (never embedded in Electron main — if main hangs/crashes, an embedded
watchdog would die with it), spawns Ether as its child, and restarts it on
**crash** or **hang**.

Why in-session (not a Windows Service): Ether's audio (cpal/WASAPI, in-process)
and its data (per-user `%APPDATA%\Ether`) are session-scoped — a session-0
service can't reach the operator's audio devices. See the HA architecture
investigation. The watchdog therefore lives in the interactive user session;
getting that session up unattended (auto-logon) + launching the watchdog at
logon are **Phase 3/4**.

## How it runs

- **Runtime:** the bundled Electron-as-Node — `ELECTRON_RUN_AS_NODE=1 <electron> watchdog/watchdog.js`. No extra runtime shipped; cross-platform.
- **Dev:** `npm run watchdog:dev` (spawns the dev app via `electron .`).
- **Prod (Phase 3):** registered as the logon startup item; it spawns the packaged `Ether.exe`.

## Restart triggers (conservative — bias against killing a healthy Ether)

- **Crash:** child exits unexpectedly (no clean-exit sentinel).
- **Hang:** `GET /health` fails `maxConsecutiveMisses` times in a row (default 3 × 5 s poll, 2 s timeout ≈ 15 s) while the process is still alive. On hang the child is force-killed (`taskkill /F /T`), and the respawn waits until the old process is gone **and** `:3400` refuses — so the new instance isn't bounced by Electron's `requestSingleInstanceLock`.
- **NOT a trigger in v1:** `audio.alive === false`. It's logged, but audio-thread recovery belongs to the dead-air watchdog, not the process supervisor — killing the whole app for an audio blip is too blunt.

## Sentinel handshake (the contract `electron/main.js` must honor)

Files in `userData` (`%APPDATA%\Ether`):

| Sentinel | Written by main.js when… | Watchdog reaction |
|---|---|---|
| `.ether-clean-exit` | user quits intentionally (tray/menu Quit → `before-quit`) | stand down, **no respawn**, watchdog exits |
| `.ether-expected-restart` | `app.relaunch()` / updater install | wait up to 60 s for self-relaunch; resume if it returns, respawn only if it doesn't |

Crash-loop guard: `> maxRestartsInWindow` (default 5 / 5 min) → **halt**, write `.ether-ha-alarm`, stop respawning (stay quiescent so a startup mechanism doesn't re-loop). Logs to `userData/watchdog.log` (rotated at 2 MB).

## ⚠️ Known gap (v1): "who watches the watchdog"

If the **watchdog process itself** dies, Ether (its child) keeps running but
**unsupervised** until the next logon restarts the watchdog. Mitigations in v1:
the loop is tiny + dependency-free and traps `uncaughtException`/
`unhandledRejection` so it shouldn't die on a throw. **Mutual supervision**
(Ether relaunches a dead watchdog via a PID passed at spawn) is the **Phase 2.5**
follow-up — deliberately deferred to keep Phase 2 single-direction.

## Platform status

`platform/win32.js` implemented. `platform/darwin.js` + `platform/linux.js` are
stubs (the core loop is OS-agnostic; only kill / userData-path / startup
registration are per-OS). Windows-first.

## Tests

`node watchdog/test/run-tests.js` — drives the real `watchdog.js` against
`test/mock-ether.js` (isolated temp `userData`, fast tunables via `WD_*` env).
Test-only seams in `watchdog.js`: `WATCHDOG_USER_DATA`, `WATCHDOG_TEST_CMD`,
`WATCHDOG_TEST_ARGS` (never set in prod).

### Coverage vs the 8 required scenarios

| # | Scenario | Status |
|---|---|---|
| 1 | User quit → no respawn | ✅ logic test (clean-exit) |
| 2 | Crash → respawn | ✅ logic test |
| 3 | Hang → kill + respawn | ✅ logic test (+ regression: no crash-path double-spawn) |
| 4 | Update relaunch → don't fight, resume | ✅ logic test (expected-restart + simulated self-relaunch) |
| 5 | Watchdog itself crashes | ⚠️ **known gap** — graceful (Ether survives unsupervised) + documented; auto-recovery is Phase 2.5 |
| 6 | Crash loop → backoff then alarm | ✅ logic test |
| 7 | Single-instance: respawn not bounced | ◑ kill-confirm gate logic tested (gone + port-free before respawn); the real `requestSingleInstanceLock` interaction needs a packaged integration run (Phase 3/4) |
| 8 | Packaged build | ◑ deferred to Phase 3/4 packaging (dev/spawn-target validated in dev) |
