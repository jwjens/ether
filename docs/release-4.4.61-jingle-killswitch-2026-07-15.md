# Release 4.4.61 — jingle kill-switch + respawn resume (2026-07-15)

One combined release. Fixes the live dead-air and stands jingles down until the native CART crash is proven
fixed. Committed `8733614` (`dba8398..8733614`), signed installer `dist-electron/Ether Setup 4.4.61.exe`.
**STOP before install — the install IS the acceptance test.**

## What shipped

**1. Jingle kill-switch (the crash mitigation).**
- `audiod/loggen.js`: `readJingleForSeam` returns null behind `JINGLES_ENABLED = false`. The daemon never
  finds a seam placement → never arms/fires → the CART-exhaustion path (the crash surface) is **unreachable**.
- Selection/placement in Generate is untouched and harmless (JIN/SWP rows may still be written); only the
  FIRE is gated. Re-enable = flip that one flag, after the native fix + a CART-plays-to-end test.

**2. Carries 4.4.60 (respawn resume + health dedupe).**
- Persisted per-station on-air intent + observed-live registration → a daemon reload replays EVERY airing
  station, not just the active one.
- `automationStart` refuses to adopt a **silent** deck (audio observed via master peak, not claimed) —
  force-starts a fresh deck instead.
- Health frames double-count fixed (one levels writer wins once the daemon is authoritative).

## Why this release exists (the incident)
The first live jingle overlay played a CART source to natural end and tripped a latent native out-of-bounds —
`audio.rs:988`, `DECK_LETTERS` (len 6) indexed at the CART slot (6) — that **panicked and killed a station's
`cpal_wasapi_out` output thread → permanent dead air**. AUTO-cycling couldn't recover it (you can't revive a
dead thread). Full analysis: `docs/incident-jingle-cart-panic-2026-07-15.md`.

## Install = double acceptance test
1. The update **restarts the daemon → respawns the dead output thread** → the station's dead air clears.
2. Per the respawn fix, **all three stations come back audible, unattended** — no AUTO presses.
3. Jingles are **off**, so the CART-exhaustion panic cannot recur.

If any station does NOT come back audible within seconds of the update, capture the onset window (daemon log
+ health JSONL) — that's the signal the respawn fix needs another look.

## Gates
`node --check` (loggen) clean · schema pre-commit gate passed · committed + pushed. (No schema/renderer
changes in this release beyond the carried 4.4.60 code; tsc/vite were green on 4.4.60.)

## Next / backlog (same family — in `docs/backlog.md`)
- **Native `audio.rs:988` guard** — handle the CART slot by its own `"CART"` key, never `DECK_LETTERS`;
  prove with a CART-plays-to-natural-end test; then flip `JINGLES_ENABLED` back on to re-enable jingles.
- **Dead-thread recovery** — a panic that kills a mixer/output thread must not equal permanent dead air:
  detect thread death (frames frozen + thread gone) and rebuild the cpal output + program bus, unattended.
  Today proved the class is real, and that the liveness watchman / AUTO cannot cure it.
