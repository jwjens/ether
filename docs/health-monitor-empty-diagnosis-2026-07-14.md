# Health Monitor shows empty in 4.4.49 — read-only diagnosis (2026-07-14)

**Symptom:** just-installed 4.4.49 — Health Monitor page shows "No stations reporting" and the mini
panel shows "waiting for health feed…" while stations are playing and deck VUs are moving. Engine
section (uptime/pid) works; event-loop ping shows "—".

**Verdict:** the Health Monitor is empty because the running 4.4.49 app is on the **in-process audio
fallback**, not the daemon — and the Health Monitor only taps the daemon feed. Not a renderer or
preload bug. Read-only diagnosis; nothing changed, nothing restarted (playout is live).

---

## The exact break (with receipts)

**The 4.4.49 app is running the in-process engine, not the daemon; the Health Monitor only consumes
daemon events, so it has no data.**

1. **App is in in-process mode (`AUDIO_DAEMON` = false).** `electron/main.js:2194-2204` runs
   `if (!AUDIO_DAEMON) setInterval(() => … audio.audioGetLevels(sid) … sendToAllWindows("audio:levels"), 33)`
   — a 30 Hz in-process level poll. It is active (this is what moves the deck VUs). It emits
   `audio:levels` **with no `_health.note*` call**, and only for the **active** station
   (`getActiveStationId()`, "single active engine").

2. **The daemon is idle.** It restarted at the install (pid `46048 → 31096`); its last `[mix sN]`
   line is **2026-07-14T01:06:18Z**, with none since the app booted at **01:15:11Z**. An idle daemon
   broadcasts no `levels`/`deck`/`enginestate` events (ether-audiod.js gates broadcasts on
   `stations.size > 0`).

3. **main is not a persistent daemon client.** The daemon log cycles
   `client connected (1 total)` → `client disconnected (0 left)` every ~5 s — that is only the
   transient Bug-A watcher ping (pid 75092). If main were attached, the peak would be 2, not 1.

4. **Therefore the daemon-event handler never fires.** `audiodClient.setEventHandler` (main.js:483-517
   — the ONLY place `_health.noteLevels/noteDeck/…` live) receives nothing →
   `snapshot.stations` stays empty ("No stations reporting" / "waiting for health feed…"), and
   `audiodClient.cmd("ping")` has no socket → `ping = null` → "—".

5. **Engine section still works** because uptime/pid come from a read-only tail of the daemon log,
   independent of the pipe connection.

### Ruled out (the other two hypotheses)
- **Preload whitelist:** `electron/preload.js:366` `on()` is a generic pass-through with **no channel
  whitelist**, so `audio:health` is allowed. Not the issue.
- **Renderer subscription dead:** it is **alive** — the snapshot arrives (the engine uptime/pid render
  from it). The empty stations array comes from the main process, not a dead subscription.
- **Ping cmd unsupported:** the daemon **does** support `ping`; main simply is not connected.

---

## Minimal fix (proposed — not applied; STOP for review)

### 1. Make the monitor mode-aware (the health-scoped fix)
Also feed the health module from the in-process path: add `_health?.noteLevels(sid, levels)` at
`main.js:2202`, plus the in-process deck/enginestate/queue emitters.
- Requires promoting `_health` from the `if (AUDIO_DAEMON_DESIRED)` block to a module-level
  `let _health = null` (assigned inside the block; guard `_health?.` at the in-process call sites).
- **Caveats:** the in-process `audio.audioGetLevels` JSON may lack `frames_total` / per-deck `decks[]`
  (those are the daemon's Rust getLevels fields). Where absent, the state machine must fall back to
  peak + enginestate + queue (the frames-based GREEN / degraded / frozen checks degrade gracefully).
  The in-process poll meters only the **active** station, so the monitor shows 1 row in fallback vs 3
  on the daemon.

### 2. The real anomaly to flag (bigger than the monitor)
4.4.49 **fell back to in-process after the install** — the daemon restarted to a fresh **idle** 31096
and the app never reconnected/drove it (no `automationStart` replayed → daemon idle). That is why the
daemon-designed monitor is blank. It likely also means **only the active station is actually airing
in-process** (the daemon is not playing the other two) — worth verifying the on-air state. Fixing
*that* (why `AUDIO_DAEMON` went false / why the app did not reconnect after the install's daemon
restart) restores full daemon telemetry and makes the monitor work as designed.
- Could not read the connect/fallback reason from `ether-startup.log` — main's `console.log` is not
  teed there. That root-cause needs its own read-only look at the connection logs.

---

## Recommendation
Ship #1 so the monitor never goes blind again — but treat **#2 as the priority**: a live broadcast box
silently on the single-station in-process fallback is the actual risk that the empty monitor is
(correctly) reflecting. The empty Health Monitor is a true-negative, not a false alarm.

*Read-only diagnosis. Nothing changed, nothing restarted.*
