# Daemon-respawn resume + health double-count — build report (2026-07-15, v4.4.60)

Fixes the two defects from `docs/incident-two-stations-silent-2026-07-15.md`. Gates: node --check (engine +
main), existing auto-resume unit test PASS, tsc unchanged (3 pre-existing, no src/ changes), vite build green.
**STOP before install — the install IS the acceptance test.**

## (1) Respawn resume — complete and honest

**1a. Persisted, per-station on-air intent (root cause of the incident).**
- Why it broke: `_automationIntent` (electron/main.js) is in-memory. An app relaunch — every version update —
  reset it to empty; the renderer only boot-starts the *active* station, so at the 4.4.59 update the map held
  only station 1. The stale-daemon reload's `replayIntents` therefore replayed only station 1; halloVeen +
  Magical Forest sat silent.
- Fix: `_persistAutomationIntent()` writes `[..._automationIntent.keys()]` to `userData/automation-intent.json`
  on every automationStart/Stop; `_seedAutomationIntentFromDisk()` loads it back **before the first command**
  (in the `audio:daemon` handler + the connected handler) so a boot automationStart can't clobber it. Plus:
  the daemon-enginestate handler registers intent for any station observed **live** — so even on the first
  install (where prior versions never persisted), every genuinely-airing station is captured. No privileged
  station, no guessing. `replayIntents` (unchanged) then resumes them all.

**1b. `automationStart` never adopts a silent/paused deck (observed, not claimed).**
- Why it mattered: a deck can read `status="playing"` while output is silent. The old adopt path ("already on
  air → adopting running playout") then did nothing → silent forever; re-issuing automationStart re-adopted.
- Fix (`audiod/engine.js` `start()`): `alreadyOnAir = claimsPlaying && await this._isAudiblyOnAir()`.
  `_isAudiblyOnAir()` samples the master peak 4× over ~400ms (EPS 0.002; healthy ~0.9, silent wedge 0.000) —
  a between-song gap can't false-trip. If a deck claims playing but is silent, it hard-clears all decks and
  force-starts a fresh one (the load-A path) instead of adopting a dead deck.

**Acceptance test (= the install):** trigger a stale-version daemon reload with 3 stations airing → all 3
audibly playing within seconds, unattended. On a fresh respawned daemon (idle decks) every station takes the
force-start path (no `_isAudiblyOnAir` delay); the adopt-guard covers the surviving-daemon reconnect case.

## (2) Health frames double-count

- Why: the in-process levels `setInterval` is created at boot when `AUDIO_DAEMON` is false (in-process
  fallback). After the in-process→daemon handover `AUDIO_DAEMON` flips true and the daemon forward feeds
  `_health.noteLevels`, but the interval kept feeding too → frames/s ~2× (Open Format ~81k).
- Fix (`electron/main.js`): the interval bails `if (AUDIO_DAEMON) return;` — one levels writer wins (the
  daemon forward once it's authoritative).

## Honest scope note
The daemon adopt-guard (1b) runs only in the live daemon (needs the native addon), so it's unauditioned until
install — which is exactly the acceptance test. The intent persistence (1a) and health dedupe (2) are
logic-verified + covered by the passing auto-resume unit test; 1a's file I/O is best-effort (never throws
into playout). If the 4.4.60 install does NOT bring all 3 back audibly within seconds, that's the signal to
dig — capture the same onset window.
