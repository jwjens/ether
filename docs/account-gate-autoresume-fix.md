# Scope: gate startup auto-resume behind the account session (design — no code)

Status: **SCOPE ONLY. No code.** Date: 2026-06-22

## The bug (confirmed read-only)
On launch the renderer auto-resumes playout **before/without an account session**:
- `src/App.tsx:1286-1298` — a startup effect gated **only** on `localStorage["ether_autoAdv"] === "1"`
  ("AUTO was ON when last closed") issues `automationStart` after a 2s grace.
- The renderer's audio engine targets `engine.stationId`, which defaults to the legacy
  **`station_id = 1`** (the "40 callsites rely on DEFAULT station_id=1" debt).
- So on a machine where AUTO was left on and station 1 exists, the daemon resumes **station 1** at
  launch regardless of sign-in — observed: station 1 = a leftover "Opportunity Village" airing while
  the app sat at sign-in with NO account (`license_key`/`account_name`/`licenses` all empty).

This violates account-is-root (CLAUDE.md): until a valid account session exists, nothing downstream —
including playout — should act. It is a facet of the open bug *"the account session must be the
unconditional gate for the entire app."*

## What is NOT the bug (leave intact)
- **AUTO persisting across restarts is intended** — broadcasters expect automation to resume after a
  restart so they don't lose air. The fix gates *when* it may fire, it does not remove it.
- **The watchdog crash-resume exception is intended** — `_wasOnAir()` (on-air marker +
  `ETHER_WATCHDOG_PID`, main.js:1719) must STILL bring a station that was streaming live back on air
  WITHOUT sign-in (unattended box, no human to sign in). This path must keep working untouched.

## The fix (scope)
The auto-resume may fire only when **one** of these holds:
1. **A valid account session exists AND the active station is resolved from it** — the normal path.
   The `if (autoAdv) → automationStart` startup effect must not run until the account session is
   valid and `getActiveStationId()` resolves to a real, account-owned station. Then resume AUTO for
   **that** station — never the hardcoded default 1.
2. **The watchdog on-air-resume exception** (`_wasOnAir()` true) — unchanged.

Concretely:
- **`src/App.tsx`** (startup effect ~1286): add the account-session gate — do not arm the
  auto-start timer until the session is valid (the same signal that should gate the whole app render
  per the account-is-root work). If `_wasOnAir()`, allow the existing crash-resume path instead.
- **Station identity**: when auto-resume runs, the engine's `stationId` must come from the resolved
  **active** station, not the legacy `1` default. (Full removal of the station_id=1 default is the
  broader multi-station audit; here, at minimum, resolve from the active station before resuming.)
- **Preferred structural form**: enforce the account gate at the app-render boundary (only the
  sign-in screen renders until the session is valid). If that gate is real, this startup effect
  cannot run pre-sign-in by construction, and the audio path is gated for free. Do this as part of
  the account-is-root enforcement, not a one-off guard buried in the audio effect.

## Risks / must-not-break
- The watchdog crash-resume (marker + `ETHER_WATCHDOG_PID`) must still resume without sign-in.
- Legitimate post-sign-in resume must still work (sign in → AUTO station resumes if AUTO was on).
- Don't delete/renumber the `station_id=1` default out from under the 40 callsites that rely on it;
  fixing the engine's active-station resolution is the surgical change, not removing station 1.

## How to verify (the only valid test is launching the app — CLAUDE.md)
1. **No account** → launch → sign-in screen, **nothing playing**. (The bug today: it plays.)
2. **Sign in** with AUTO previously on → the **account's active** station resumes (not station 1).
3. **Watchdog respawn** with the on-air marker set → comes back on air WITHOUT sign-in (exception
   preserved).

## Not in scope here
- The broader account-is-root render gate and the full `station_id=1` default removal — related, but
  larger; this scope is specifically "don't let auto-resume fire before the account gate."
- No code in this document.
