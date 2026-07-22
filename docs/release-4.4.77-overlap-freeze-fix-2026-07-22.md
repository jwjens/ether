# v4.4.77 — deck-overlap + main-loop-freeze fix (audio-spine, 2026-07-22)

Fixes the 2026-07-21 Open Format incident (`docs/incident-of-overlap-main-freeze-2026-07-21.md`): two
decks audible at once + app-wide sluggishness. Root: a synchronous senses sweep froze the main event
loop (measured 17s), and the Phase-1/3 log-reader shadow did DB work on the daemon's advance critical
path, so under contention a rotation's deck-stop was delayed and a decoding deck leaked. **This release
is a FLIP PREREQUISITE — the §2.7 shadow burn-in restarts clean on it.** All four fixed, one release.

## (1) Shadow OFF the advance critical path — `audiod/engine.js`
`_fireStart` deferred `_shadowEvalTimeAnchor` + `_shadowStampPlayhead` to **`setImmediate`** (fire-and-
forget, after the advance tick completes). Their DB read (a `COUNT`) + writes (2 `UPDATE`s) can no longer
sit on the serialized advance chain, so a slow op under DB contention can **never again delay a rotation
or its deferred deck-stop**. The row id is captured at call time (deckSchedId may be overwritten before
the deferred run); eval-then-stamp order preserved. Enforces the shadow's own stated principle
("must never perturb playout") by placement.

## (2) Kill the main-loop freeze — `electron/library-health.js`
`eligibility()` ran **three `play_log` subqueries per song**, over ~all songs × 3 stations, synchronously
every sweep (45s prefetch + 120s timer) — that was the freeze. Replaced with **two set-based `GROUP BY`
scans** (per-file_path last-play + count; per-artist last-play) looked up in memory. Same output.
`computeAll` now stamps `sweepMs` (a first-class cost sense in `library-health.jsonl`).

**Bench (`scripts/bench-eligibility-sweep.js`, read-only live DB):**
```
Open Format    163 songs · OLD 568ms · NEW  9ms ·  63x
halloVeen      172 songs · OLD 746ms · NEW  7ms · 107x
Magical Forest  76 songs · OLD 188ms · NEW  7ms ·  27x
SWEEP TOTAL:   OLD 1502ms → NEW 23ms
```
1.5s of synchronous main-thread work per sweep → 23ms. (Under the incident's load/contention it reached
17s; the batched form removes the quadratic entirely.) `depthCheck` (4.4.76) verified cheap alongside.

## (3) Deck-stop hardening — Bug-A guard — `audiod/engine.js`
The deferred post-crossfade stop used to `return` early if the outgoing deck still reported `"playing"`
("never stop a playing deck") — but a still-playing outgoing deck past the crossfade grace **is** the
leaked/overlap deck the stop exists to clear. Extracted the decision into a pure, testable
`_outgoingStopAction(fromId, fromGen, toId)`:
- `skip-reloaded` — a fresh source was loaded since the rotate (`deckGen` bumped) → never wipe it.
- `skip-target` — this is the deck we rotated INTO → never stop the incoming.
- `stop` — same outgoing source, not the target → **stop it, even if still "playing"** (force). The
  decision no longer depends on play-status — that dependency was the leak escape.

**Bench (`audiod/smoke-seam-stop.js`, real DaemonEngine, no audio/DB):** 5/5 PASS — the stop always
lands for the leak case; `deckGen`/target skips preserved; decision independent of play-status.

## (4) Event-loop lag is now a first-class Health Monitor row — `electron/main.js` + `HealthMonitor.tsx`
A 1s self-timer in main measures its own scheduling drift (`_mainLoopLagMs` + a rolling ~60s peak) —
canonical, daemon-independent (unlike the ping RTT). Folded into `buildHealthSnapshot`
(`eventLoopLagMs` / `eventLoopLagPeakMs`) and rendered in the System Health section:
**"Event-loop lag — N s peak"** (warn ≥500ms, error ≥2s). A UI freeze is now an observed fact on the
panel, not archaeology.

## Gates
- `node --check` engine.js / library-health.js / main.js: OK.
- `audiod/smoke-seam-stop.js`: 5/5 PASS. `audiod/smoke-enginestate.js`: unaffected.
- `npx tsc --noEmit`: zero new errors (1 pre-existing — PhoneDesk).
- Leak-guard: **14** (baseline holds).
- `npm run build` + installer: OK.

## Artifact — STOP before install
`C:\openair\dist-electron\Ether Setup 4.4.77.exe` — `--publish never`. Full close/reopen (daemon doesn't
hot-reload). After install: the Health Monitor gains the **Event-loop lag** row (should read ~0ms), the
senses sweep no longer stutters the UI, and a delayed deck-stop can no longer leak a second decoding
deck. The §2.7 shadow burn-in restarts clean on this build.

## Files
- `audiod/engine.js` — shadow deferred to setImmediate; `_outgoingStopAction` + force-stop.
- `electron/library-health.js` — batched `eligibility()`; `sweepMs`.
- `electron/main.js` — main-loop lag probe + `eventLoopLagMs`/`eventLoopLagPeakMs` in the health snapshot.
- `src/components/HealthMonitor.tsx` — Event-loop lag row.
- `audiod/smoke-seam-stop.js` — the seam bench. `scripts/bench-eligibility-sweep.js` — sweep bench (read-only).
- `package.json` 4.4.76 → 4.4.77.
