# Stream-supervisor DEAD-AIR false alarm — jensj diagnosis (2026-07-09)

Air CONFIRMED LIVE (all 3 mounts pumping ~200 kbps, source held 5.5h+). Dashboard "STALLED·DEAD AIR /
repeated ffmpeg restarts / Check Icecast server URL and credentials" is a **false positive**. Read-only.
Diagnosed from the **running daemon code** (`P:\Ether\engine` = `%LOCALAPPDATA%\Ether\engine`, staged
daemon **v4.4.40** per `version.txt`) — there are **no persisted log files** in userData (ffmpeg stderr
goes to the daemon console, not a file), so this is code + Icecast ground-truth, not stderr logs.

## (1) The loop is 403 "mount in use", NOT a real connect/credential error
`audiod/stream.js`:
- `parseLine` classifies stderr: `:33` `403|Forbidden → "Forbidden (403)"`, `:32` 401, `:31` refused, etc.
- `close` handler `:105-119`: counts failures in a 10s window (`:109-111`); at **≥3 failures** (`:112`) it
  sets `armed=false` + `statusState="error"` + errorMsg **"Streaming failed after repeated ffmpeg restarts.
  Check Icecast server URL and credentials."** (`:114`) — the exact dashboard text.
- **The generic `:114` message OVERWRITES the specific errorKind.** A second encoder hitting a mount that's
  already held gets **403 Forbidden (Icecast "mountpoint in use")** → 3× in 10s → the generic
  "check credentials" error. The real cause (403 mount-in-use) is masked.

**Proof it's mount-in-use, not credentials:** the encoder that owns each mount authenticated with the same
password + URL and has aired continuously for 5.5h. Credentials are provably valid. The only way a *second*
encoder with valid creds fails is the mount already being held → 403. So "check credentials" is a
misclassified 403.

## (2) Which process holds the source vs which loops
- **Holder (airing):** the supervisor whose ffmpeg reached `isLive` (`stream.js:96-97`, `frame=`/`size=`) —
  it went `state="live"` at 08:37:52 and is the 5.5h/200 kbps source I measured on all three mounts.
- **Looper (false alarm):** a **second, duplicate encoder** for the same mount (an orphan from a prior
  session, or a double-start / respawn) — it gets 403 mount-in-use, trips `:112` after 3×/10s, sets
  `armed=false` + the dead-air error, and **its status overwrites the live sibling's in the panel** → the UI
  shows DEAD AIR while the holder keeps airing.
- Caveat: which duplicate spawned it (orphan vs double automationStart) can't be proven from these files —
  that needs the daemon console/stderr, which isn't persisted in userData. The *pattern* is unambiguous.

**This is pre-existing** — `git diff v4.4.39..v4.4.40` touches zero streaming code; `stream.js` is unchanged.
The 4.4.40 install (daemon restart) merely re-exposed the duplicate-encoder race.

## (3) Proposed fix (HOLD for GO) — `audiod/stream.js` (+ health panel)
1. **Back off / stand down on mount-in-use.** In the `close` handler, when the last errorKind was
   403/Forbidden, do NOT escalate to the generic `:114` fatal error. Treat mount-in-use as benign: longer
   backoff, and if the mount is confirmed live (Icecast probe or a sibling supervisor `state==="live"`),
   mark this encoder **standby/duplicate**, not `error`. Better: **dedupe** — never run two encoders for one
   mount (check before `_spawn`).
2. **Dead-air must not fire while the mount serves bytes.** Gate the panel's DEAD-AIR state on authoritative
   liveness (Icecast mount serving / the `live` supervisor). A duplicate encoder's 403 error must never
   override a live sibling's status.
3. **Fix the misleading text.** Preserve the specific errorKind: 403 → "mount already in use (another
   encoder is streaming)"; keep "check credentials" for 401 only. `stream.js:114`.

## CRITICAL UPDATE — air is NOW genuinely DOWN (flipped ~15:00 UTC, during this diagnosis)
Re-probe after reading the logs: **NO sources on Icecast; all three mounts empty** (119 bytes/5s = headers
only). Ground truth from the state flags (`P:\Ether`):
- `.ether-on-air` = **2026-07-09 08:37:52 UTC** — exactly the Icecast source start. The daemon *did* air all
  three from 08:37:52.
- `.ether-clean-exit` = **2026-07-09 15:00:01 UTC** — the app was **fully QUIT** at 15:00. A clean quit runs
  the HA clean-quit shutdown → the daemon is stopped → all three encoders drop → **real dead air.**

**Chain of events:** daemon aired all 3 from 08:37:52 (healthy, my earlier probes) → a duplicate encoder
tripped the **false** DEAD-AIR alarm (`stream.js` 403 mount-in-use → generic "check credentials") → operator
**quit the app at 15:00 to "fix" it** → clean-quit killed the daemon → **actual outage now.** The false
alarm was harmless; **quitting in response to it caused the outage** — the exact failure mode I flagged
("do not restart/kill — that causes real dead air").

**Log limits (receipts):** the daemon's ffmpeg stderr (the literal 403 lines) is **not persisted** in
userData — only `ether-startup.log` (main/renderer) and a **stale 2026-07-06** `watchdog.log` crash-loop
(unrelated). So the 403 mount-in-use mechanism is proven from `stream.js` code + the on-air flag + Icecast,
not a stderr line. Also seen: `ether-backend` (Railway) unreachable 08:35–08:37 ("Failed to fetch") — a
separate backend/network concern, not the stream path.

## Verdict + single next action
**Air is DOWN on all three right now** (real, since the 15:00 quit — not the false alarm). 
**SINGLE NEXT ACTION: relaunch Ether on jensj** → the watchdog respawns the daemon → all three encoders
reconnect → mounts come back live. That is Jeff's move on the live box (I have no control of jensj; `P:\Ether`
is a read-only log view).

**Then (follow-up, not the outage response) — the code fix so this can't recur:** in `audiod/stream.js`,
(1) treat 403 mount-in-use as benign (back off / stand down, don't escalate to the "check credentials" fatal
error); (2) gate DEAD-AIR on real mount liveness so a duplicate encoder can't false-alarm; (3) preserve the
specific errorKind (403 vs 401). Optional but real: the 2026-07-06 watchdog "code=0 exit → CRASH → halt"
loop is a separate latent bug worth its own look.

**Read-only; nothing changed on my side. HOLD for GO.**
