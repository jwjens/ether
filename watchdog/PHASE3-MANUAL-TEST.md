# HA Phase 3 + 2.5 — manual logout/login test

The automated checks (`npm run watchdog:test`, `node scripts/ha-smoke-phase3.js`)
validate the supervision loop **within one session**. They cannot validate the
one thing Phase 3 is actually for: **the watchdog auto-launching at logon** (and
therefore Ether coming back after an unattended reboot). That needs a real
logout/login, so it's a manual checklist run on the packaged build.

> Run this on the **packaged** build (`Ether.exe`), not dev. Registration is
> per-user (no admin). The flags only act when Ether is **not already running**.

## Pre-test — arm HA

1. Make sure Ether is **not running** (quit from the tray, confirm no `Ether.exe`
   in Task Manager and nothing on `http://127.0.0.1:3400/health`).
2. Run once:
   ```
   "C:\Path\To\Ether.exe" --enable-ha
   ```
3. Confirm the Scheduled Task exists:
   ```
   schtasks /Query /TN EtherHAWatchdog
   ```
   - [ ] Task is listed (Trigger: At log on, Run as the current user)
4. Confirm a watchdog is supervising:
   - [ ] `%APPDATA%\Ether\.ether-watchdog.pid` exists
   - [ ] `%APPDATA%\Ether\watchdog.log` shows `adopted existing Ether pid … (healthy)`
   - [ ] `http://127.0.0.1:3400/health` returns 200

## The actual test — logout / login

5. **Log out** of Windows (Start → user → Sign out). Do **not** just lock.
6. **Log back in.**
7. Wait ~30s (the task has a 15s logon delay, then the watchdog spawns Ether).
8. Verify the watchdog auto-launched:
   - [ ] Task Manager shows an `Ether.exe` running as the watchdog (it spawned at logon)
   - [ ] `watchdog.log` has a fresh `watchdog starting … pid=…` line timestamped after login
9. Verify Ether auto-launched:
   - [ ] Ether window / tray badge is visible
   - [ ] `http://127.0.0.1:3400/health` returns 200
   - [ ] Audio is working (play something — confirms session-scoped audio is intact)

## Crash recovery (real process, not a mock)

10. Kill the **Ether app** process in Task Manager (the one serving the UI, *not*
    the watchdog).
    - [ ] Within ~15s Ether relaunches on its own (`watchdog.log`: `unexpected exit → CRASH` then `spawning Ether (crash-restart)`)
    - [ ] `/health` returns 200 again

## Mutual supervision (Phase 2.5)

11. Kill the **watchdog** process (the `Ether.exe` whose pid matches
    `.ether-watchdog.pid`).
    - [ ] Within ~10–15s the app relaunches a new watchdog (`.ether-watchdog.pid` shows a NEW pid; `watchdog.log` shows a fresh start that re-adopts the running app)
    - [ ] Ether keeps running the whole time (no respawn storm, no second window)

## Cleanup — disarm HA

12. Quit Ether from the tray (so `:3400` is free).
13. Run:
    ```
    "C:\Path\To\Ether.exe" --disable-ha
    ```
14. Confirm teardown:
    - [ ] `schtasks /Query /TN EtherHAWatchdog` reports the task does **not** exist
    - [ ] No watchdog respawns Ether after you quit it
15. (Optional) Reboot/login once more and confirm Ether does **not** auto-start.

---

If any box fails, capture `%APPDATA%\Ether\watchdog.log` + the failing step and
ship a follow-up fix commit — per the agreed solo-dev pace, a fix commit is
cheaper than gating the first HA commit on a full packaging→logout→login cycle.
