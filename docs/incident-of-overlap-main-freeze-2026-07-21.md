# Incident — Open Format deck overlap + app-wide sluggishness (2026-07-21, on 4.4.75/76)

Jeff reported, live on Open Format (~4:36 PM local / 23:36 UTC): two decks audible at once
("I Gotta Feeling" 3:08 in AND "Rather Be" 0:22 in, both VUs live) plus app-wide sluggishness.
Read-only investigation from the live logs (Ether running; the DB was never touched).

## Status: self-resolved, cause still live
By the time of investigation (03:05 UTC, ~3.5h later) `[mix s1]` reads `active=1` — single deck, healthy.
The daemon's own stall-watchdog broke the overlap at 23:40:35 ("no deck playing 1006ms → forcing
advance → deck A LIVE"). Nothing to force now. **But the cause is real and will recur.**

## Evidence (receipts)
Sources: `%APPDATA%\Ether\logs\ether-audiod.log` (daemon) and `…\logs\health-events.jsonl` (audio-health).

### Sluggishness = main-process event-loop freezes, measured
`audio-health` ping RTT (the event-loop-lag sense):
```
23:26:24  lag  911ms
23:30:49  lag  781ms
23:31:24  lag 17409ms   ← 17-SECOND main-process freeze
23:33:26  lag  3784ms
now       0–2ms (recovered)
```
The daemon's `[mix sN]` heartbeats held steady at 5s throughout and audio drain stayed nominal
(`ring_occ=0`, real≈target 352800 B/s) — **the daemon never froze; the MAIN process did.** The two big
freezes land on the **library-health senses cadence** (120s timer + the 45s prefetch's `computeAll`).
`library-health.js eligibility()` runs three `play_log` subqueries **per song, over every song, ×3
stations**, synchronously (better-sqlite3 blocks the event loop) — that is the 17s UI freeze.

### The seam trace (`[engine s1]`, non-heartbeat)
```
23:36:47.911 deck A ended (pos=174.7/174.9s, chain=segue, readyB=true readyC=false readyA=true)
23:36:47.911 advance → handleRotate            → 23:36:47.920 segue: deck B LIVE — Rather Be   (9ms)
23:36:51.411 advance → stop:A                  → done stop:A 0ms
23:40:35.610 watchdog: STALL — no deck playing 1006ms, forcing advance
23:40:35.626 resume-playout: deck A LIVE — Sweet Child O' Mine   (recovery)
```
Every advance was FAST (9–28ms) — **the advance chain was not wedged at the logged seams.** The overlap
window (screenshots 23:34–23:37) sits **immediately after the 17s freeze (23:31–23:33)**. During the
overlap `[mix s1]` showed `active=2` with one deck faded to `vol=0.00` and never stopped = a leaked
decoding deck (the outgoing deck's stop was skipped).

## Verdict — two coupled defects, one family
1. **Sluggishness root (pre-existing, independent of the flip):** the senses sweep freezes the main
   event loop up to 17s. `eligibility()`'s per-song ×3 subquery loop over all songs ×3 stations,
   synchronous.
2. **Overlap / leaked-deck root — Bug-A family, and recent shadow code is on the critical path:** the
   Phase-1/3 log-reader shadow does DB work **inside `_fireStart`, on the serialized advance chain** —
   `_shadowEvalTimeAnchor` (a `COUNT(*)` over `generated_schedule`; the log's "missed 122/379") +
   `_shadowStampPlayhead` (2 `UPDATE`s) on **every go-live** (`audiod/engine.js:701,704`). During a
   main-process freeze the shared `openair.db` contends; a stalled shadow op stalls `_fireStart` →
   stalls the advance chain → the deferred deck-stop is delayed, and `handleRotate`'s guard
   `if (deckState === "playing") return` then **skips the stop** → the outgoing deck keeps decoding =
   the overlap + the `active=2` leak. This violates the principle the Phase-1 comment itself asserts
   ("the shadow write must NEVER perturb playout") — its placement on the advance chain breaks it.

**Certainty:** the 17s main freeze is measured fact. The overlap↔shadow-contention coupling is the
leading mechanism (timing + shadow-on-critical-path), but the frozen-window rotation itself was not
cleanly logged — strongly supported, not proven.

## Minimal fix (proposed — NOT built; audio spine + live → STOP for go)
1. **Shadow off the advance critical path** — defer `_shadowEvalTimeAnchor` + `_shadowStampPlayhead` to
   after the advance completes (fire-and-forget / `setImmediate`), so a slow DB op can never delay a
   rotation or its stop. Highest confidence, lowest risk, correct regardless of whether it is *the*
   cause. My own recent code — my regression to own.
2. **Kill the main freeze** — batch `eligibility()`'s per-song subqueries into set-based queries (one
   pass for last-play / last-artist / play-count across all songs), so the 120s/45s sweep is
   milliseconds, not 17s. The app-wide-sluggishness fix. Verify the new `depthCheck` (4.4.76) stays
   cheap.
3. **Harden the deck-stop (Bug-A guard treatment)** — don't indefinitely skip the stop for a "playing"
   outgoing deck whose slot has ended and that isn't the just-rotated-in deck; force-stop so a delayed
   stop cannot leak a deck.

Item 1 most directly de-risks the live overlap and is entirely the recent shadow code.

## A sense gap this exposed
Main-process event-loop lag was only visible because `audio-health`'s ping RTT happened to catch it.
It should be a first-class Health Monitor row (it already computes `pingMs` / "event-loop lag Nms") —
surface it, so a 17s UI freeze is an observed fact on the panel, not something reconstructed from a log.
