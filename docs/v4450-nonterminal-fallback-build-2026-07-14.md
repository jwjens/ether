# v4.4.50 — non-terminal fallback + handover + Health Monitor never-blind (BUILD, 2026-07-14)

**Status: BUILT, compiles clean (node --check ×3 + vite build green). Committed + pushed. NOT built to
an installer, NOT installed. STOP for the reviewing session before any install.** Playout on the live
box was untouched throughout (in-process fallback still airing).

Addresses the root cause in `docs/inprocess-fallback-rootcause-2026-07-14.md`.

---

## (a) Non-terminal fallback + song-boundary handover + retrying connect

**`electron/audio-daemon-client.js` — the fallback is no longer terminal:**
- New `spawnGivenUp` flag. When the spawn cap (`MAX_SPAWN_ATTEMPTS=5`) is hit, we now **stop spawning
  but keep probing** (`scheduleReconnect`) instead of `stopped=true`. So a late/externally-started
  daemon is attached. Reset on connect (`attach()`). Probe cadence slows to 8 s in probe-only mode
  (no busy loop, no PID storm).

**`electron/main.js` `setupAudioBackend` (fallback branch):**
- Removed the terminal `audiodClient.stop()`. Sets `_inProcessFallback = true`, inits in-process (no
  dead air), and **leaves the client reconnecting**. The 5 s boot gate still commits to in-process
  quickly (no dead air), but it is no longer final — the client retries in the background, so the
  decision is effectively a retrying check, not a one-shot gate.

**`electron/main.js` handover (`_armInProcessHandover` / `_doInProcessToDaemonHandover`):**
- `setConnectedHandler`: if we fell back and the daemon now attaches, **do not** drive the daemon
  (that would double up with the live in-process audio) — arm a handover instead.
- The handover watcher polls the active station's in-process `audioGetState` (500 ms); when the
  current song **ends** (a boundary: was-playing → now-nothing), it primes the daemon
  (`automationStart`), flips `AUDIO_DAEMON=true` (all audio IPC now routes to the daemon), releases the
  already-ended in-process decks, and replays intents. Never mid-song.

## (b) Health Monitor fed from the in-process path

- `_health` promoted to module scope (main.js) so both paths feed it.
- `main.js:2202` (the in-process 30 Hz level emitter) now calls `_health.noteLevels(sid, raw)` — and
  the in-process addon is the SAME native addon, so it carries the full `frames_total`/`decks[]`
  telemetry. In-process meters only the **active** station (1 row vs 3 on the daemon).
- `electron/audio-health.js`: GREY now requires genuine idleness (`enginestate off` **and** no active
  decks **and** frames ≤1) — because in-process emits no `enginestate` events, so activity is inferred
  from decks/frames. Prevents a playing in-process station from showing GREY.

## (c) Playout mode + RED banner

- `audio-health.js`: `modeProvider` option; `snapshot.mode` = `"daemon" | "in-process"`.
- `main.js`: `modeProvider: () => AUDIO_DAEMON ? "daemon" : "in-process"`.
- `src/audio/health.tsx`: `HealthModeBanner` — a pulsing **RED** banner rendered whenever
  `mode === "in-process"`; shown on the FULL page (`LiveHealthMonitor`) and the MINI panel
  (`MasterOutput.tsx`, compact).

## Observability (the already-staged edits, included in this commit)
- `audio-daemon-client.js`: `setLog()` + durable `_log()` on every spawn/connect/reconnect/give-up.
- `main.js` `setupAudioBackend`: `audiodClient.setLog(logStartup)` + `logStartup(...)` for the
  ACTIVE / connect-ms / UNREACHABLE→fallback decision. So the backend decision is never invisible again.

---

## Blast-radius audit
- **Normal daemon mode is unchanged.** The handover functions and `_inProcessFallback` path activate
  ONLY after a boot-time fallback (`_inProcessFallback === true`). In the common case (`AUDIO_DAEMON`
  true from boot), `setConnectedHandler` behaves exactly as before.
- **Health module remains display + event-logging only** — no playout mutation; guarded throughout.
- **The observability + client-probe changes are low-risk**: `spawnGivenUp` only changes what happens
  AFTER the existing give-up point (probe instead of dead-stop); logging is guarded.
- **HIGHEST RISK — the live handover** (`_doInProcessToDaemonHandover`). It stops in-process decks,
  flips `AUDIO_DAEMON`, and starts the daemon at a boundary. Risks to verify in a soak BEFORE trusting
  it on air:
  1. **Gap at the boundary** — the daemon spins up its first song after `automationStart`; there may be
     a short silence. Needs measuring; may want to pre-`fill` the daemon before the boundary.
  2. **Boundary detection** — main polls in-process `audioGetState` at 500 ms; a mis-detect could fire
     early/late. The renderer also drives advance — convergence (renderer's next play routes to daemon)
     is expected but must be confirmed.
  3. **Multi-station** — in-process airs only the ACTIVE station, so the handover restores that one;
     restoring all on-air stations to the daemon is follow-up (the app/renderer drives the others once
     `AUDIO_DAEMON` is true).
  **Recommendation:** review the handover closely and soak it (fallback → daemon-late-start →
  boundary) on a non-broadcast box before installing on air. It only triggers in the fallback path, so
  it cannot affect a clean daemon boot.

## Verify
- `node --check` green: `audio-daemon-client.js`, `audio-health.js`, `main.js`.
- `npm run build` (vite) → **✓ built, exit 0** (renderer: banner + mode compile).
- Live box: still in-process fallback, **untouched** (no restart, no install). Bug-A watcher (pid
  75092) still running.

## Commit / push
Committed as 4.4.50 and pushed to origin for the reviewing session. **No installer built, nothing
installed.** After review (especially the handover), the manual recovery for the *current* stuck
session remains a **relaunch** (daemon 31096 is already listening → clean daemon boot); or install
4.4.50 in a maintenance window and let the non-terminal path + handover self-heal future fallbacks.

**STOP — awaiting the reviewing session's verification against origin before any install.**
