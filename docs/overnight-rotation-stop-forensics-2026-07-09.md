# Overnight rotation-stop forensics — jensj (2026-07-09)

Read-only. **Corrects my earlier call:** the air was NOT live — it was dead air (silence) on connected
mounts. Receipts below.

## Correction of the prior verdict
Earlier I said "all three streams live, false alarm, don't restart." **Wrong.** I measured Icecast
byte-flow (~200 kbps) and read it as live audio — but silence/dead-air encodes to the same bitrate. The
decisive check (did songs advance?) I did not run. `play_log` shows **no song advanced after 19:34 UTC
July 8** on any station. The operator's DEAD AIR alarm was correct.

## What actually stopped, and when (play_log — the only record of real playout)
- **Open Format:** last play `2026-07-08 18:35:55 UTC` — in the *prior 4.4.39* session; played **nothing**
  in the 4.4.40 session (started 18:36:40 UTC).
- **Magical Forest:** last play `2026-07-08 19:34:03 UTC`, then stopped (was the only station advancing in
  the 4.4.40 session, 18:37→19:34).
- **halloVeen:** **0 plays, ever** — 3028 scheduled events, none consumed.
- **Nothing played on any station after 19:34 UTC July 8**, through the 08:37:52 restart, through now.
- Meanwhile Icecast had sources connected 08:37:52 UTC → ~15:00, pumping ~200 kbps = **dead air (silence)
  on live mounts.**

## Ruling causes IN / OUT (receipts)
- **Scheduler log exhaustion / runway — RULED OUT.** `generated_schedule` extends to **July 12–13** on all
  three (st1 2465 ev → 07-13 06:57; st2 3028 → 07-13 06:59; st3 725 → 07-12 12:58). The log had days of
  runway. Playout stopped *consuming* a full schedule.
- **Watchdog halt (07-06 code=0 misread) — RULED OUT for last night.** `watchdog.log` has **only** the
  2026-07-06 17:33–17:34 crash-loop; **zero entries for the 8th/9th**. The 07-06 halt did NOT recur. No new
  SESSION START on the 9th either — the app did not crash/restart overnight.
- **4.4.40 code — RULED OUT.** `git diff v4.4.39..v4.4.40` touches only the VU-meter path; the daemon
  playout/automation (engine.js, loggen.js) is unchanged. (Daemon files staged 07-08 11:09; engine dirs
  re-touched 07-09 07:55 PDT = a morning re-stage, after the freeze.)
- **Backend-unreachable cascade — UNLIKELY as cause.** Railway "Failed to fetch" fired 08:35–08:37 UTC
  (renderer account-reconcile) — that's account-list sync, not playout; it can't stop the local daemon
  advancing songs. It correlates with the restart moment (see below), not the 19:34 freeze.
- **Daemon playout freeze / non-start — the actual failure.** Automation stopped advancing songs despite a
  full schedule: Open Format never ran in 4.4.40, Magical Forest froze at 19:34, halloVeen never started.
  This is a daemon-side automation stall.

## What restarted at 08:37:52 UTC (1:37 AM PDT)
`.ether-on-air` written 08:37:52 = the **encoder (ffmpeg→Icecast) reconnected** — NOT playout resuming
(no song played after). Best-supported hypothesis: **machine wake from sleep** — the renderer went quiet
for ~13h then resumed with reconcile at 08:35, and Railway "Failed to fetch" fits a network-not-ready
post-wake; no new SESSION START means the process persisted across a suspend, consistent with sleep/wake.
Alternative: stream-supervisor re-arm. **Cannot be proven** from persisted logs (see limits).

## Is this the 07-06 watchdog bug? NO
Different failure. 07-06 = Ether.exe exiting code=0, watchdog misreading as CRASH, 5× respawn → HALT
(`watchdog.log`). Last night: no watchdog activity at all, no crash/restart — playout silently stalled
while the process kept running. The 07-06 halt is a real separate bug, but not this.

## Honest limits — what CANNOT be proven, and the logging that must be added
- **The daemon's automation/playout has no persisted log.** ether-audiod / engine / loggen / stream log to
  stdout captured only by the watchdog — which was silent since 07-06. So **why** playout froze at 19:34
  (hang? deck-advance error? file missing? automation never started for OF/halloVeen?) is **not
  recoverable** from disk. This is the core gap.
- `play_log` also might under-record if logging itself broke — but the operator's dead-air observation +
  the mounts streaming silence corroborate a real stall, not just a logging gap.

## Fix proposal (HOLD for GO)
1. **Persist a rotating daemon log** in userData (`ether-daemon.log`): automation advance, deck loads,
   scheduler picks, ffmpeg stderr, errors, with station_id + timestamps. Without this the next overnight
   stall is again undiagnosable.
2. **Playout dead-air watchdog:** detect "schedule exists but no deck advance / no play_log for > N min" and
   auto-recover (re-issue automationStart / force-advance) + log it. The daemon must never silently stream
   silence with days of schedule ahead.
3. **halloVeen 0-plays:** investigate why a station with 3028 scheduled events never started automation
   (non-active stations not started? file paths?). All on-air stations must actually advance.
4. **Tie stream "live" to playout-live, not just ffmpeg-connected** — the dashboard/stream status must show
   DEAD AIR when playout has stalled even though the encoder is up (the inverse of the earlier false-alarm:
   the real signal is songs advancing).
5. Check jensj power settings (never sleep) if the 08:37 wake hypothesis holds — but that's secondary to the
   midday 19:34 freeze.

**Read-only; nothing changed. HOLD for GO.** Immediate air-restore is still: relaunch Ether on jensj — but
verify songs actually ADVANCE (watch play_log / the deck), not just that mounts reconnect.

---

## ROOT-CAUSE UPGRADE (2026-07-09) — corrects my "no persisted daemon log" limit
The daemon **does** have a durable log (`audiod/daemon-log.js`, tees console.* to
`<userData>/logs/ether-audiod.log`, wired at `ether-audiod.js:18`). I initially looked in the wrong place
and wrongly called it absent. The real facts:
- The log **froze 2026-07-06 19:05 UTC** (`Roaming\Ether\logs\ether-audiod.log`, last sink-open) — nothing
  since, including the overnight failure.
- **`daemon-log.js` is NOT in `stage-engine.js:19` `DAEMON_FILES`** (only ether-audiod/engine/loggen/
  playlog/stream) → the **staged/packaged daemon ships WITHOUT daemon-log.js**. Confirmed: it is absent from
  jensj's staged engine (`P:\Ether\engine\audiod`).
- `ether-audiod.js:18` `require("./daemon-log").install()` was **unguarded** → on the staged daemon that
  require throws `MODULE_NOT_FOUND` at module top-level → **the staged daemon crashes on startup.**

**Leading root cause (upgraded):** since the logging was wired without adding it to the stage list, every
re-staged daemon (each version install — 4.4.37…4.4.40) has been **un-startable / blind**. This fits the
overnight signature: playout that never advances, halloVeen never starting, and the 5.5h Icecast source
being an **orphan** (an older daemon/ffmpeg holding the mount) while the new staged daemon crash-loops —
consistent with the `stream.js` 403 "mount in use" found earlier. Full runtime interplay still can't be
replayed (the log that would show it was the thing disabled) — which is precisely why this is Part 1's
foundation.

**FIXED (Part 1.2, GO'd, tested):**
- `stage-engine.js:19` — `daemon-log.js` added to `DAEMON_FILES` (ships the log).
- `ether-audiod.js:18` — require now `try/catch`-guarded (a missing/broken log module can never crash the
  daemon again).
- Test `scripts/test-daemon-log-staging.js` — 4/4 PASS (stage list ships it; require guarded; guard survives
  MODULE_NOT_FOUND; daemon-log tees to the durable file). Local only — not built/released.

**Still to do in Part 1:** 1.1 dead-air watchdog (detect "schedule exists + no advance > N min" → log +
kick a stalled advance; scream RED for streaming-but-never-started). 1.3 halloVeen root cause already
receipted (automationStart issued only for the renderer's *active* station).
