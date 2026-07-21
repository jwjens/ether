# v4.4.74 — badge roll-in revert + renderer OOM mitigation, 2026-07-21

Follows the 4.4.73 field issues: a red ERROR badge and a renderer white-screen (OOM).

## (1) Badge roll-in reverted — DEFINITE fix
Slice C had rolled library/rotation health into the **global footer dot** (`HealthStatusDot`), so
Open-Format-red (2 songs needing re-link) turned the whole system badge to ERROR. Reverted: the global
dot now reflects **system health only (DB + HA alarm)**. Library/rotation health lives solely in the
Health Monitor's LIBRARY & ROTATION section. Side benefit: removes the `library-health:get` call from
the always-mounted footer dot's 15s tick (less IPC).

Root of the red itself was fixed live (not a code issue): songs **426 "I Like You"** and **427
"Havana"** had DB `file_path`s that didn't match disk (426 pointed to root, 427 expected
`_spotdown.org.mp3` but the file is `.mp3`). Relinked both to their real Daytime paths (Ether closed →
safe DB write). Open Format DEAD = 0 → materialization green → badge green.

## (2) Renderer OOM — mitigation (not a confirmed root-cause fix)
`render-process-gone: reason=oom` ~14 min after reopen = a renderer memory crash (audio never stopped;
the daemon kept all 3 stations on air — the "empty queue" was the dying UI). I could not pin a
definitive leak by code review — every effect I added has proper cleanup. What I DID find and reduce
is **IPC back-pressure**: on a live box the daemon emits ~90 `levels` events/sec, and the Phase-2
shadow-compare was firing an async `invoke`+`emit` every 5s AND on **every** `ether:queue-changed`
(frequent during playout, ~constant divergence pre-flip) — back-pressured invoke promises can
accumulate under that load.

Changes:
- Shadow-compare: 5s + per-queue-event → **30s periodic only** (dropped the queue-changed storm trigger).
- Queue-lint poll: 20s → **60s**.
- Footer-dot `library-health:get` poll: **removed** (via the badge revert).

**Honest status:** this reduces the most-aggressive renderer↔main churn I'd added, which is a plausible
OOM contributor — but it is NOT proven to be the leak. If it recurs on 4.4.74, next step is a bisect:
temporarily disable the Slice-C/Phase-2 renderer polls entirely to isolate, or capture a heap snapshot.

## Gates
- `tsc`: zero new errors (3 pre-existing). `build` + installer: OK.

## Artifact
`C:\openair\dist-electron\Ether Setup 4.4.74.exe` — `--publish never`. Install + fully close/reopen.

## Watch after install
- Footer badge should stay **NOMINAL** (system-only) regardless of library state.
- Open Format LIBRARY section **green** (relink holds).
- Run for >20 min and watch renderer memory / for a repeat white-screen. Report back — if it recurs, we bisect.
