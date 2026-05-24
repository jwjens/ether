# Ether High Availability — Operator Runbook

This is the field guide for keeping Ether running 24/7. It is written for a
station operator — no coding required. Engineers will find the internals in the
**Appendix** at the bottom.

> **TL;DR:** Ether can supervise itself. A small companion program (the
> *watchdog*) watches the main app and restarts it if it crashes or freezes. You
> can see its status any time in **System Health** (the NOMINAL dot, bottom-left).
> A green **HEALTHY** banner means supervision is working.

---

## 1. What HA protects against — and what it does NOT

**It protects against:**

- **Crashes** — if Ether exits unexpectedly, the watchdog relaunches it (with a
  short, increasing backoff).
- **Hangs** — if Ether is still running but stops responding (frozen UI, wedged
  process), the watchdog detects it within ~15 seconds, force-kills it, and
  relaunches.
- **The watchdog itself dying** — Ether watches the watchdog too (*mutual
  supervision*). If the watchdog disappears, Ether starts a new one.
- **Reboots / logoff** — when registered, the watchdog relaunches automatically
  at the next logon.

**It does NOT protect against (by design):**

- **Dead air from a stuck audio thread.** HA supervises the *process*, not the
  *sound*. A separate dead-air safeguard handles audio recovery. HA deliberately
  does **not** kill the whole app just because audio went quiet — that would be
  too blunt (silence during a stop/segue is normal).
- **Power loss, disk-full, or a full OS crash.** Nothing inside Ether can survive
  the machine going down. Use a UPS and disk monitoring for those.
- **Network outages.** HA is entirely local; it needs no network.
- **A genuinely broken build that crashes on every launch.** HA will retry, then
  give up and raise an **alarm** (see §5) rather than loop forever.

---

## 2. How to tell if HA is working

Open **System Health** (click the **NOMINAL** indicator at the bottom-left, or
menu → System Health). You can also pop it out (↗ icon in its header) and keep it
on a second monitor during a broadcast.

The big banner at the top rolls everything up:

| Banner | Meaning | Action |
|---|---|---|
| 🟢 **HEALTHY** | Watchdog alive, startup task registered, mutual supervision on, no alarm. | None. |
| 🟡 **DEGRADED** | Running, but missing a guarantee (e.g. startup task not registered → won't survive a reboot). The banner lists why. | Address the listed reason when convenient. |
| 🔴 **ALARM** | The watchdog gave up after too many restarts (crash loop). | **Act now — see §5.** |
| ⚪ **HA INACTIVE** | The app was launched without HA. This is a *valid* mode, not an error. | Enable HA if you want supervision (§6). |

The **High Availability** section below the banner breaks out each signal:
watchdog process, startup task, mutual supervision, crash-loop alarm, process
uptime, audio output, sync, and memory.

You can also confirm from the OS:

- **Task Scheduler** → look for **EtherHAWatchdog**. If present and Ready/Running,
  the logon launcher is armed.
- **Task Manager** → you'll see two `Ether.exe` trees (see §9, "Which process is
  which").

---

## 3. How to test HA without breaking your show

You want to verify supervision **without** risking dead air on a live signal. Do
this **off-air** (or on a test box) the first time.

**Safest verification — no kill required:**

1. Launch Ether normally and open **System Health**.
2. If the banner shows **HA INACTIVE**, HA isn't running yet — enable it (§6).
3. Confirm the banner is **HEALTHY** and the *Watchdog Process* row shows
   `Running · pid NNNN`. That alone proves the watchdog is up and adopting the
   running app.
4. Open **Recent Events** in the panel (or read `watchdog.log`, §7). A healthy
   start logs lines like `adopted existing Ether pid … (healthy)`.

**Enable / disable flow (the supported on/off switch):**

- **Turn HA on:** launch Ether once with the `--enable-ha` flag. This registers
  the `EtherHAWatchdog` logon task and starts a watchdog that *adopts* the
  already-running app (it does **not** spawn a second copy, so there's no audio
  interruption).
- **Turn HA off:** launch Ether with `--disable-ha` (or run it against the
  running instance). This removes the logon task and stops the watchdog. The app
  keeps playing — disabling supervision never touches playback.

> Tip: to run a flag from inside Ether's session, type `! Ether.exe --enable-ha`
> in the Claude prompt, or run it from a terminal. On a dev checkout the flag is
> passed to the Electron launcher.

**Proving a restart actually works (do this OFF-AIR):**

1. With HA healthy, note the *Process Uptime* in the panel.
2. End the main `Ether.exe` task in Task Manager (the app, **not** the watchdog —
   see §9).
3. Within a few seconds the watchdog relaunches Ether; *Process Uptime* resets to
   near-zero and **Recent Events** logs a `spawning Ether (crash-restart)` line.
4. This confirms crash recovery. Because a real restart **does** briefly stop
   audio, only do this when you're not on-air.

---

## 4. What each `/health` field means

The watchdog polls a tiny local status endpoint (`http://127.0.0.1:3400/health`)
every 5 seconds. The same values feed the **System Health** panel:

| Field | Plain meaning |
|---|---|
| `ok` | The app answered at all — the core "not hung" signal. |
| `uptimeSec` | How long the **main process** has been running. A surprisingly low number means something restarted recently. |
| `audio.alive` | Was sound flowing in the last 2 seconds? `false` during silence/stop is normal — it is a *warning*, never a restart trigger. |
| `audio.staleMs` | Milliseconds since the last audio output callback. |
| `sync` | The metadata sync engine (off by default). Shows applied-mutation count when on. |
| `station.activeId` | Which station is currently active. |
| `memRssMb` | Main-process memory use, in MB. Watch for steady growth (a leak). |
| `pid` | The main process ID — handy when you need to identify or end it. |

---

## 5. The ALARM — what it means and how to clear it

A 🔴 **ALARM** (and a red **ALARM** indicator bottom-left) means the watchdog
restarted Ether **more than 5 times within 5 minutes**, decided it's in a crash
loop, and **halted auto-restart** to avoid thrashing the machine. Ether may be
down or repeatedly dying. This needs a human.

**Do this, in order:**

1. **Read `watchdog.log` first (§7).** The repeated `spawning Ether (...)` and
   exit lines tell you *why* it keeps dying. Don't just clear the alarm and hope.
2. **Fix the root cause** if you can (bad update, corrupt session, missing audio
   device, full disk).
3. **Clear the alarm and restart supervision:** delete the alarm file
   `%APPDATA%\Ether\.ether-ha-alarm`, then start a fresh watchdog by launching
   Ether with `--enable-ha`. A clean watchdog start also clears the alarm
   automatically.
4. If the app crashes again immediately, **leave HA off** (§6) and keep Ether
   running unsupervised while you investigate — better a running app you're
   watching than a restart loop.

---

## 6. Disabling HA in an emergency

If supervision itself is causing trouble (e.g. an unexpected restart loop you
can't yet diagnose), turn it off without stopping the broadcast:

- **Preferred:** launch Ether with `--disable-ha`. Removes the logon task, stops
  the watchdog, leaves playback untouched.
- **Manual fallbacks (any one):**
  - Delete the scheduled task: in an Admin-free PowerShell,
    `schtasks /Delete /TN EtherHAWatchdog /F`.
  - End the **watchdog** `Ether.exe` in Task Manager (§9). *Do not* end the main
    app.
  - Create `%APPDATA%\Ether\ha-config.json` containing `{ "enabled": false }` —
    the watchdog exits on next start instead of supervising.

To re-enable later: `--enable-ha` (and remove the `ha-config.json` override if you
set one).

---

## 7. How to read `watchdog.log`

Location: **`%APPDATA%\Ether\watchdog.log`** (rotated to `watchdog.log.1` at 2 MB).
Open it in any text editor, or use **Recent Events** in the System Health panel.

Lines are timestamped. The ones that matter:

| Log line contains | What happened |
|---|---|
| `watchdog starting` | The watchdog process came up. |
| `adopted existing Ether pid …` | It attached to an already-running app (no new launch). |
| `Ether spawned pid …` | It launched a fresh app. |
| `health miss N/3` | A `/health` poll failed; 3 in a row → hang. |
| `HANG declared — force-killing` | The app was frozen and got killed. |
| `unexpected exit → CRASH` | The app exited on its own; a restart follows. |
| `spawning Ether (crash-restart\|hang-restart)` | A recovery launch, with the running-restart count. |
| `clean-exit sentinel → … user quit` | You quit on purpose; the watchdog stood down. |
| `CRASH LOOP … HALTING` | The alarm (§5) — too many restarts; gave up. |

---

## 8. File locations (`%APPDATA%\Ether\`)

| File | Purpose |
|---|---|
| `watchdog.log` (+ `.1`) | The watchdog's activity log. |
| `.ether-watchdog.pid` | The running watchdog's process ID. |
| `.ether-ha-alarm` | Present only when the crash-loop alarm has tripped (§5). |
| `.ether-clean-exit` | Brief marker written when you quit on purpose (tells the watchdog to stand down). |
| `.ether-expected-restart` | Brief marker for an update/relaunch (tells the watchdog to wait, not respawn). |
| `ha-config.json` | Optional `{ "enabled": false }` to keep HA off. |

(The `.ether-clean-exit` / `.ether-expected-restart` markers are transient — they
appear and are consumed within seconds. Seeing one is normal.)

---

## 9. Which process is which

Both the app and its watchdog show up as **`Ether.exe`** in Task Manager. To tell
them apart:

- The **watchdog** is the one launched by the **EtherHAWatchdog** scheduled task,
  and its PID matches `.ether-watchdog.pid`. It has no window. The *Watchdog
  Process* row in System Health shows its PID.
- The **main app** is the one with the window (the UI you interact with). Its PID
  is the `pid` shown in System Health / `/health`.

When a step here says "end the watchdog," use the PID from `.ether-watchdog.pid`
or the System Health panel — **never** end the main app to disable HA, and never
end the watchdog expecting playback to stop (it won't; they're separate).

---

## 10. After a reboot or update

- **Reboot / logon:** the **EtherHAWatchdog** task launches the watchdog ~15s
  after logon, which then starts Ether. Confirm via System Health (banner
  HEALTHY) or Task Scheduler.
- **App update:** updates use an *expected-restart* marker so the watchdog waits
  for the app to come back on its own instead of racing it. If the updated app
  doesn't return within ~60s, the watchdog launches it.
- **After either,** glance at System Health and confirm the *Startup Task* row is
  **Registered** — that's your guarantee it'll come back next time too.

---

---

## Appendix — Engineer notes

For future-Jeff debugging. Authoritative source is the code; this is orientation.

### Topology

- **`watchdog/watchdog.js`** — separate process, run as `ELECTRON_RUN_AS_NODE=1`
  Electron (so it ships in the bundle, no extra runtime). Spawns Ether as a
  detached child (so the app outlives the watchdog) or *adopts* an
  already-running instance via `ETHER_ADOPT_PID`. Single-direction supervision.
- **`electron/main.js`** — serves `GET /health` on `:3400` (lock-free; see
  `buildHealthSnapshot()`), runs the **mutual-supervision** monitor
  (`startWatchdogMonitor`) that relaunches a dead watchdog, and owns the HA
  control surface (`ha:status`, `ha:dashboard`, `ha:alarmStatus`, `ha:readLog`,
  and the `--enable-ha`/`--disable-ha` bootstrap in `handleHaBootstrapFlags`).
- **`watchdog/platform/win32.js`** — registers/queries/removes the
  `EtherHAWatchdog` per-user logon **Scheduled Task** (`InteractiveToken`,
  `LeastPrivilege`, no admin, no stored password). `darwin.js`/`linux.js` are
  stubs; `supported` is win32-only today.

### Restart logic (conservative on purpose)

- Poll `/health` every **5s** (`config.js: pollIntervalMs`), 2s per-request
  timeout. **3** consecutive misses (~15s) with the process still alive → **HANG**
  → `taskkill /F /T` → confirm dead + port free → respawn.
- Unexpected child exit → **CRASH** → backoff respawn (`backoffMs`
  `[2,5,10,20,30]s` by restart index).
- **>5 restarts in a 5-min window** → `tripCrashLoop()`: write `.ether-ha-alarm`,
  go quiescent (no exit, so a startup mechanism doesn't relaunch into another
  loop). Cleared on a fresh watchdog start or by deleting the marker.
- `audio.alive === false` is **logged, never a restart trigger** in v1.

### Sentinels

`consumeSentinel()` reads-and-deletes; only "fresh" (<30s) markers count.
`.ether-clean-exit` → stand down. `.ether-expected-restart` → wait for
self-relaunch within `expectedRestartGraceMs` (60s) before respawning.

### Dashboard data path (Phase 5)

- `ha:dashboard` IPC = `{ health: buildHealthSnapshot(), ha: {...control-plane} }`,
  one round-trip, polled at 5s by `HealthMonitor`, paused via `document.hidden`
  (not blur — second-monitor popouts must keep updating).
- `startup` (the `schtasks /Query`) is **cached 30s** in main so the poll doesn't
  spawn a subprocess 12×/min.
- The rollup banner is a pure function: `src/lib/haRollup.ts → deriveHaRollup()`,
  truth-tabled in `haRollup.test.ts`. Precedence: alarm → health-down → inactive
  → degraded → healthy.
- `ha:alarmStatus` is an `fs.existsSync`-only check for the footer dot.

### Tunables

All in `watchdog/config.js` (`TUNABLES`), overridable via `WD_*` env vars
(tests only; prod uses the locked defaults). Bias every change toward **not**
killing a healthy-but-busy Ether mid-broadcast.

### Known gaps / next

- HA on/off is currently CLI-flag driven (`--enable-ha` / `--disable-ha`). The
  customer-facing **Settings toggle + auto-logon installer is Phase 4** — the only
  remaining HA arc after this dashboard.
