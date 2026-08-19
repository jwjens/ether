# The orphan engine — unstoppable audio, and the fix

**Date:** 2026-08-18 · **Severity:** critical · **Open item 10, escalated and closed.**

> Jeff closed dev mode completely; Halloween music kept playing; no window, no tray icon, no control
> anywhere could stop it.

That is the defect, in his words, and the fix is sized to it. Audio that cannot be stopped is the
worst thing an audio product can do.

---

## 1 · What tied the daemon's life to the app — and where it broke

`ether-audiod` is spawned by two independent parents, with two different intents:

| | dev (`!app.isPackaged`) | packaged |
|---|---|---|
| spawn | `detached: false` | `detached: true` — **deliberate**, so a gapless update leaves audio playing |
| self-terminate | `ETHER_DAEMON_DEV=1` → reap on last-client-disconnect | **none** |
| told to stop on quit | `fullStopAndQuit` / `before-quit` | same |

Deliberate survival is real and wanted: an app update kills every `Ether.exe`, and the station must
stay on air across it. The bug is not that the daemon can outlive the app. **The bug is that nothing
bounded it.**

### 1.1 · The entire safety net was one event-armed timer, and it has never fired

`audiod/ether-audiod.js`, inside `sock.on("close")`:

```js
if (DEV_REAP && clients.size === 0) {
  setTimeout(() => { if (clients.size === 0) { log("dev: no clients for 3s — exiting"); shutdown(); } }, 3000);
}
```

**Receipt, from `%APPDATA%/Ether/logs/ether-audiod.log` (2026-08-16 → 08-19):**

```
grep -c "no clients for 3s"  →  0
grep -c "listening on"       →  57
grep -c "shutting down"      →  51
```

**Zero.** Fifty-seven daemon starts, fifty-one orderly shutdowns — **six daemons started that never
logged a shutdown**, and the net caught none of them. Four defects, all in that one line:

- **D1 — dev only.** `ETHER_DAEMON_DEV` is never set for a packaged build. An installed Ether that
  crashes or is force-killed leaves a detached engine playing *until the machine is rebooted*, with
  no window and no tray. The code comment called this intended. Surviving a crash is intended;
  surviving *unboundedly, with no owner and nothing to click*, is the defect.
- **D2 — armed by an event, single-shot.** If a client is connected at the 3-second mark the timer
  is discarded and **never re-armed**, because arming only happens on a close event. The HA
  watchdog's own `probeDaemon()` connects to the pipe every cycle — one overlapping probe disarms
  the reap permanently.
- **D3 — `sock.on("error")` deletes the client with no reap check at all** (`ether-audiod.js`, the
  line right after the close handler). Any disconnect that surfaces as an error, not a close, skips
  the net entirely.
- **D4 — `clients.size` is not ownership.** It means "somebody has a socket open". A diagnostic
  probe, the watchdog, or a second app instance all counted as reasons to keep an engine playing.

### 1.2 · The stale-daemon check compares version strings, which never change in dev

`electron/main.js:520` `checkStaleDaemon()` asks the daemon its `ETHER_DAEMON_VERSION` and compares
it with `app.getVersion()`. In dev both are `4.4.228` **no matter how much daemon code changed**. So
a leftover daemon running yesterday's code reported the same version, was declared fresh, and every
"full restart" attached to it and ran it.

**This is why the procmeters work appeared not to run.** It ran — against a daemon that did not have
it. Three sessions in a row have now been bitten by this.

### 1.3 · Dev shutdown leaked, and is leaking right now

`electron:dev` was `concurrently "npm run dev" "wait-on … electron electron/main.js"` — **no
`--kill-others`**. Closing Electron leaves vite running forever.

**Receipt, taken live during this investigation:**

```
PID 27056  node vite.js       created 2026-08-17 6:34:58 PM   ← yesterday's dev server
netstat -ano | findstr :1420  →  TCP 127.0.0.1:1420 LISTENING 27056
```

`vite.config.ts` sets `strictPort: true`, so **this session's `npm run dev` died instantly** on the
port clash, `wait-on` was satisfied by *yesterday's* server, and Electron attached to it. The
renderer has the same disease as the daemon. Four processes from that 8/17 session (concurrently,
two npm wrappers, vite) are still alive, parented to dead `cmd.exe`.

### 1.4 · A third spawner, with no ownership at all

`watchdog/watchdog.js:146` spawned the daemon with `env: { ELECTRON_RUN_AS_NODE: '1' }` and nothing
else — no version, no dev flag, no owner. Every watchdog-spawned daemon was permanently ownerless.

---

## 2 · The fix — NO OWNER, NO ENGINE

**This daemon always has a named owner process, and it exits when that owner is gone.** Not an
event: a **poll**, once a second, from boot, forever — so a close event that never arrives, or
arrives only as an error, can no longer leave an engine running.

### 2.1 · Ownership is claimed, not implied

- **At birth:** `ETHER_OWNER_PID`, now passed by **both** spawners — the app client
  (`audio-daemon-client.js`, dev *and* packaged) and the watchdog (its own pid; its whole job is to
  bring an owner back). Absent → fall back to `process.ppid`, so a hand-started daemon or an
  `audiod/smoke-*` harness still has a real owner and the rule needs no test exemption.
- **Thereafter:** the `hello` command. The app announces itself on **every** connect, so an app that
  restarts — crash, update, watchdog respawn — **adopts** the running daemon and the countdown
  clears. This is what keeps a station on air across an app restart.
- **A bare pipe connection is not ownership.** The watchdog's `probeDaemon()` connects and destroys
  without a word; so does any diagnostic. Neither can rescue an orphan (proven: T4 below).
- `hello` also carries `supervisorPid` (`ETHER_WATCHDOG_PID`). An HA-supervised station whose app is
  force-killed keeps playing, because the daemon can see a responsible party still standing.

### 2.2 · Grace periods — survival must be asked for, with a deadline

| situation | grace | why |
|---|---|---|
| dev | **5s** | no gapless requirement; code changes every restart |
| packaged | **45s** | long enough for the watchdog to relaunch Ether and for that cold start (splash + DB open) to reach `hello`, so a supervised station never drops |
| update | **120s** | from the app's own `.ether-expected-restart` sentinel — the gapless-update window |

The update window is the point: **"the daemon outlives the app during an update" is still true, but
it is now something the app asks for, with a deadline, instead of the default.** If the sentinel is
unreadable the daemon uses the *shorter* grace — the failure mode is a shorter life, never a longer
one.

### 2.3 · PID reuse cannot fake an owner

Windows recycles pids. A pid once **observed dead** is latched in `_knownDead` and never believed
alive again, so an unrelated process inheriting the old app's number cannot silently re-own an
orphaned engine — the exact failure this mechanism exists to prevent, wearing a disguise.

### 2.4 · Dev: the app only ever talks to a daemon it spawned

`hello` returns `spawnedFor` (the birth owner). In dev, if that is not this process, the client
**evicts** the daemon (`shutdown`) and respawns a fresh one from the current tree. Capped at 3
attempts, after which it uses the daemon anyway and says so **loudly** rather than looping. Version
strings are not consulted — they were the thing that lied.

### 2.5 · An engine with no visible owner is forbidden by construction

Jeff's rule: *if deliberate tray-survival is a feature, the tray must provably exist whenever the
engine runs.* So:

- `createTray()` is wrapped — a failure sets `tray = null` and is written to the startup log instead
  of taking the app down or passing silently.
- `trayExists()` gates the close dialog. **"Keep Playing in Tray" is only offered when there is a
  tray to hide to.** With no tray, the dialog offers *Stop & Quit* / *Cancel* and says why. The
  window can no longer vanish and leave audio playing with nothing to click.

### 2.6 · Dev shutdown takes the whole tree

`electron:dev` gains `-k --kill-signal SIGTERM`. `concurrently` kills via `tree-kill`, so
grandchildren (vite under `npm run dev`) go too. And because `strictPort: true` makes vite exit on a
port clash, `-k` now takes Electron down with it — **a stale dev server can no longer be silently
adopted; the launch fails loudly instead.**

---

## 3 · Proof

Harness: the **real daemon**, isolated pipe and log, stand-in owner process. Never touches the live
app, the live pipe, or any database (`loadDb()` is lazy; the harness sends only `ping`/`hello`).

```
PASS  T1 owner dies -> daemon exits
        daemon exited 6.3s after the owner was killed (dev grace 5s + poll)
PASS  T2 born ownerless -> daemon exits
        daemon exited 6.1s after start (owner pid 33468 was already dead)
PASS  T3 hello adopts an orphan -> keeps playing
        adopted by pid 35888 (daemon reports ownerPid 35888) and still running 9s past the grace
PASS  T4 a bare probe cannot rescue an orphan
        daemon exited 6.0s despite a client socket held open the whole time

4/4 passed
```

The daemon's own log, verbatim:

```
[audiod] ORPHANED — owner 32332 / watchdog (none) / spawner 32332 all gone; no owner, no engine.
         Exiting in 5s unless an app adopts me (clients=0)
[audiod] ORPHANED for 6s with no owner — shutting the engine down (no unstoppable audio)
[audiod] shutting down — stopping streams + engines + decks + closing pipe

[audiod] owner 29648 → 28732 (adopted via hello)      ← T3, the rescue
[audiod] adopted while orphaned — countdown cleared

[audiod] ORPHANED — … all gone … (clients=1)          ← T4, socket held open, still exits
```

`T4` is the old D2 bug, dead: `clients=1` for the entire grace, and it still stopped.

`node audiod/smoke-shutdown.js` → PASS (the `ppid` fallback keeps the existing harnesses working).

Gates: `node --check` on all four changed JS files · `npx tsc --noEmit` **0 errors** ·
`npm run build` clean.

---

## 4 · Files

| File | Change |
|---|---|
| `audiod/ether-audiod.js` | owner poll (1s), `hello` handshake, pid-reuse latch, graded grace; the event-armed reap retired |
| `electron/audio-daemon-client.js` | `ETHER_OWNER_PID` at spawn (dev **and** packaged); `hello` on every attach; dev eviction of a foreign daemon |
| `watchdog/watchdog.js` | passes `ETHER_OWNER_PID` (its own pid) — the third spawner no longer produces ownerless engines |
| `electron/main.js` | `trayExists()`; `createTray()` failure survivable and logged; close dialog withholds tray-survival when there is no tray |
| `package.json` | `electron:dev` gains `-k` (tree-kill) |

**No version bump. No commit.** Rides into 4.4.229 with the rest.

---

## 5 · What I deliberately did NOT build

- **No daemon-initiated app relaunch.** Bringing the owner back is the watchdog's job and it already
  does it; a second resurrector would fight it.
- **No tray owned by the daemon.** It runs under `ELECTRON_RUN_AS_NODE` and has no GUI. The
  structural answer is that it dies instead.
- **No change to the packaged detach model.** Gapless updates still work the same way; they are now
  bounded by the sentinel rather than unbounded.

---

## 6 · The trade-off, stated plainly

**Packaged + HA off + a crash: audio now stops after 45 seconds instead of continuing indefinitely.**

Before, it played forever with no window and no tray. With HA on — the OV/park configuration — the
watchdog relaunches Ether within seconds, `hello` adopts the daemon, and nothing drops. With HA off
the operator has chosen no supervision, and 45s of trailing audio then silence is the lesser evil
against an engine nobody can stop.

`ORPHAN_GRACE_MS` in `audiod/ether-audiod.js` is the one knob if that number should be different.

---

## 7 · Acceptance — Jeff's, on his machine

**This session's dev app is running against yesterday's vite (PID 27056) and must be cleared first**,
or the test measures the old world. Close Ether, then:

```
taskkill /F /PID 27056        # yesterday's vite, holding port 1420
```

(the other three 8/17 leftovers — 27672, 31668, 29560 — die with it or can be killed the same way).

Then:

1. `npm run electron:dev` — the daemon log should show a **fresh** `listening on \\.\pipe\ether-audiod`.
2. Close the app any way: window X → *Stop & Quit*; File → Quit; tray → Quit; or `Ctrl+C` on the dev
   terminal; or `taskkill` the Electron process outright.
3. Within seconds: `Get-Process | Where-Object Name -like "*ether*"` → nothing, and **silence**.
   A deliberate quit is immediate; a hard kill takes the 5s grace.
4. Relaunch clean — the meters test now runs against a daemon that actually has the new code.
