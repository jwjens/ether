# Incident — two stations silent-while-playing (2026-07-15)

**halloVeen + Magical Forest went silent (RED, peak .00, frames ~45k/s advancing) at ~12:01:33 local
(19:01:33 UTC), both within ~2s. Open Format unaffected. Root cause: a daemon reload+respawn triggered by
the app updating to 4.4.59 — NOT the jingle path.** halloVeen restored (AUTO); Magical Forest pending.

## 1. Capture — what fired at onset (receipts)

Not a jingle. A **stale-version daemon reload** after the app updated to 4.4.59 while the daemon was still 4.4.58:

```
ether-startup.log
19:00:00.759  === SESSION START ===  version: 4.4.59        ← app relaunched/updated to 4.4.59
19:00:01.358  [AUDIO] stale-check: daemon v4.4.58 != app v4.4.59 — arming reload
19:01:33.604  [AUDIO] RELOAD daemon — reason: stale/song boundary (armed reload fired)
19:01:44.234  [audiod-client] spawned daemon (detached) pid 52744

ether-audiod.log
19:01:33.608  [audiod] cmd shutdown          → 19:01:33.682-683  s1/s2/s3 _started: true→false
19:01:46.058  [audiod] cmd automationStart station=1 → 19:01:46.148  deck A LIVE — Sunday Morning
```

- **No jingle armed/fired, no CART event at onset** — grep `jingle|CART|ARMED|FIRING` in the window = nothing.
- **Deck volumes all 1.00** — nothing muted (`[mix]` lines: every deck `vol=1.00`).
- After respawn only **station 1** got "deck A LIVE." Stations 2 & 3 came back paused/idle:
  - `[mix s3] active=0 peak=0.000 | A src=0 a=0 p=1 | B src=1 a=0 p=1 | C src=0 a=0 p=1` — all decks
    paused, no active source → silent. Frames keep advancing (~45k/s) because the cpal callback keeps pulling;
    it's just summing paused decks to silence.
- Health JSONL: `19:01:46 Magical Forest RED "engine restarted" enginePid 52744`; both stations' silence
  starts ~19:01:33 — the shared trigger.

## 2. Restore
- **halloVeen (s2): DONE** — AUTO press: `19:12:24 automationStart station=2 → deck A LIVE — Love Ain't It`.
- **Magical Forest (s3): still silent.** Re-issuing automationStart hits the buggy path
  (`19:12:13 automationStart station=3 → "adopting running playout"` — adopts the silent deck instead of
  starting one). Fix: switch to Magical Forest → **AUTO off, then AUTO on** (or **SKIP**) to force a fresh deck.

## 3. Verdict (plainly)

**What zeroed the output:** a **daemon reload + respawn** — not deck volumes, not CART/overlay, not the jingle
commit. Installing 4.4.59 left the running daemon at 4.4.58; the app armed a stale-version reload (the daemon
can't hot-reload on update) and fired it at the next song boundary (12:01:33). The respawn's auto-resume
cleanly restarted **1 of 3** stations; **2 & 3 came back silent-while-playing** — the pre-existing
**daemon-respawn auto-resume gap** (decks not re-started; then automationStart "adopts" the silent deck).

**Is the jingle path implicated? No.** No fire/CART/overlay at onset; volumes untouched. What IS implicated is
the **act of updating to 4.4.59** — any version install triggers the stale-daemon reload, and the
daemon-respawn resume is buggy for multi-station. The 14-jingle Reel Splitter commit was coincidental to the
window; it didn't restart the daemon or touch audio. An **update-driven daemon respawn exposed a known
respawn-resume defect** — it will recur on every update until the respawn resume reliably restarts ALL on-air
stations and automationStart stops adopting a silent/paused deck.

**Open Format ~81k/s (≈2×):** telemetry double-count, not real audio. Health frames/s is fed from TWO paths —
the daemon levels forward AND the in-process levels fallback (`main.js:2260`). During the post-respawn
reconnect window both briefly fed `noteLevels` for the same station → frames delta counted twice (~45k →
~81-90k). Settled back to 45k once the daemon path took over. Harmless, but a real double-feed to de-dupe.

## Backlog (real defects to fix)
1. **Daemon-respawn auto-resume must restart ALL on-air stations** — on reload/respawn, replay automationStart
   for every on-air station AND make automationStart never "adopt" a silent/paused deck (verify a deck is
   actually producing audio, else force-start). Today only 1 of 3 recovered; the other two sat silent-while-
   "playing." Recurs on every version update.
2. **Health Monitor frames double-count during daemon reconnect** — `noteLevels` is fed by both the daemon
   forward and the in-process fallback; dedupe per station so frames/s doesn't read ~2× in the reconnect window.
