# Rotation Diagnostic — 2026-05-31 (read-only)

No edits/builds/commits. Findings only. Evidence: AppData logs + staged engine + source.

## 1 — Version truth
- Repo `C:\openair\package.json`: **4.3.23**
- Staged daemon `…\Local\Ether\engine\version.txt`: **4.3.23** (written 5/31 3:22 PM)
- **Currently running app self-reports 4.3.23.** `ether-startup.log` last session
  `2026-06-01T00:08:56Z  version: 4.3.23  packaged: true  pid: 10468` — and pid **10468** is the live `Ether.exe` (started 5/31 5:08 PM local = 00:08Z). So repo and running build are the SAME tree.
- **BUT the "v4.3.8" sighting is real and recent.** Same log shows
  `2026-05-31T23:40:39Z  version: 4.3.8  packaged: true  pid: 21088` — a 4.3.8 build was launched ~28 min before the current one, then replaced by a fresh 4.3.23 install at 23:56Z. The install slot `…\Programs\Ether` has been overwritten repeatedly today (log shows 4.3.13→14→16→17→22→23, then a 4.3.8 regression, then 23 again).
- **Verdict:** not a stale binary *right now* — current footer is 4.3.23. There was version thrash in the same install folder today, including a brief 4.3.8 downgrade. If a footer still shows 4.3.8, that window is the 21088 process, which is dead; the live process is 10468 = 4.3.23.

## 2 — Scheduler / auto-fill location
- **Moved to the daemon (Item-10 done).** `audiod/engine.js` header: *"Refill is the node:sqlite-backed scheduler in loggen.js — the daemon keeps its own queue full and advances unattended, with no renderer. Owns: queue, advance/rotate/preload, end-detection, on-format refill (read-only DB)."* It `require("./loggen")` and calls `refillIfNeeded()`.
- The renderer copy `src/audio/loggen.ts` still exists but is the **in-process fallback** (used only when the daemon is OFF). In daemon mode the renderer queue/decks are a read-only mirror; the daemon is the single source of truth.
- Daemon mode is **ON** in this build: `watchdog.log` → `audio daemon supervision ON (ETHER_AUDIO_DAEMON=1)`, and `ether-engine.exe` (pid 15424) is running. So auto-fill is executing inside the daemon, not the renderer.

## 3 — Logs around hand-off
On-disk logs (only two are real app logs):
- `…\Roaming\openair\ether-startup.log` — **window lifecycle only** (session start / version / splash / ready-to-show). No audio engine events, no deck-finished, no scheduler tick.
- `…\Roaming\Ether\watchdog.log` — process supervision + **the key audio signal**:
  - `ether-audiod not responding (pipe dead) — (re)spawned daemon … (staged engine)` (every launch)
  - `WARN /health ok but audio.alive=false (engine thread not firing) — logged, NOT a v1 restart trigger` (appears 5/29 and 5/31 22:37)
  - Repeated `Ether pid … exited (code=0) → CRASH → respawn` (UI crash-looped 2/5 in the window at 19:23–19:24 today).
- **There is NO daemon audio-event log on disk — by design.** `electron/audio-daemon-client.js` spawns the daemon `detached: true, stdio: "ignore"` (so it survives gapless updates). The daemon's `console.log` deck-finished/segue/advance/refill lines go to a discarded stdout. They only reach the renderer devtools console over the named pipe — not persisted in a packaged build. **So the exact hand-off moment cannot be tailed from disk.** That is itself a diagnostic gap worth closing (pipe daemon stdout to a file).
- Closest captured signal to "song should hand off but doesn't" = the watchdog `audio.alive=false (engine thread not firing)` warning, which the watchdog explicitly does NOT act on.

## 4 — Daemon present / mid-migration?
- **Daemon present AND running:** `ether-engine.exe` pid 15424 (started 00:08:53Z, same session as the app), staged at `…\Local\Ether\engine` with `audiod/*.js`, `native/ether-audio.node`, version.txt 4.3.23. Migration to the daemon is **complete in code** (engine owns queue+advance+scheduler+refill+playlog+stream).
- **Prime suspect for "decks play but rotation doesn't continue" — confirmed plausible from code + logs:**
  - The daemon's stall-recovery watchdog and the whole advance/refill path are gated on `_started === true` (`engine.js:144 if (!this._started) return; // never auto-start a fresh daemon`).
  - The watchdog log shows the daemon being **(re)spawned on a dead pipe** at every launch. A freshly respawned daemon comes up with `_started = false`.
  - Per the known open follow-up: **on a fresh daemon reconnect, if the station was on air, the app must re-issue `automationStart` — it currently does not** (the watchdog won't, because it's gated on `_started=false`). Result: a deck already loaded plays to its end, but nothing advances/refills → rotation stops / dead air. Manual `automationStart` over the pipe recovers it.
  - The `audio.alive=false (engine thread not firing)` warnings are consistent with the engine poll loop not ticking on a just-respawned (not-yet-started) daemon.
- **Net:** this is not a stale-binary problem (current = 4.3.23 = repo). It is the documented daemon-respawn auto-resume gap: the out-of-process engine respawned, was never re-armed with `automationStart`, so its advance/refill loop never runs after the current track ends.

### Suggested next step (no change made)
Reproduce live, then confirm by either (a) sending `automationStart` over `\\.\pipe\ether-audiod` and watching rotation resume, or (b) temporarily piping the daemon's stdio to a file (instead of `"ignore"`) to capture the deck-finished/advance/refill trace at the hand-off. Both are read-only-ish diagnostics pending your go-ahead.
