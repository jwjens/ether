# Release ledger & push accounting — session 2026-07-20 → 2026-07-21

Every release built this session (4.4.65 → 4.4.74), where each one's commits live, and the final git
state. **SHIPPED:** `v4.4.74` tagged, CI green, release published (auto-update armed), wiki posted,
`main` fast-forwarded to the shipped tip, ether-backend reconciled.

## Releases since 4.4.64

| Release | What | Commit → branch |
|---|---|---|
| **4.4.65** — sign-in honest errors | `routeAfterAuth` branches the failure message by `/account/connect` status (offline / invalid-license / seat-full / 5xx) instead of one "couldn't reach the server". Closes the C1–C3 gap. | `a6f96fc` |
| **4.4.66** — trial_expired doorway | Desktop shows "trial ended — data safe, pick a plan" + Choose-a-plan button; bad key keeps contact-support copy. Root cause: leftover trial `expires_at` on Jeff's paid lifetime license (fixed in prod DB). | `a6f96fc` · **backend `c677806` (committed + pushed — flag 1 resolved)** |
| **4.4.67** — Show+ DAW pop-out | StudioPro opens in its own window (WINDOWS menu / Tools / Library Send-to-Studio); bounds persistence, close-guard, cross-window `studio:push-track`; verified NO station-state writers. | renderer `2e8e237` · main-process handlers in `a8e52fb` |
| **4.4.68** — Log-Reader Phase 0 (schema) | Migration v33 adds local-only `state`/`played_at`/`seq` to `generated_schedule`; backfill verified on a copy. | `81a8c02` |
| **4.4.69** — Log-Reader Phase 1 (shadow) | Daemon stamps the playhead as decks go live; observational; burn-in acceptance MET. | `81a8c02` |
| **4.4.70** — Log-Reader Phase 2 (read-path) | `schedule:playhead-view` IPC + divergence ledger + UpNext shadow-compare; §2.7 time-anchor ruling recorded. | `a8e52fb` |
| **4.4.71** — Library Slice A | 165-file R2 materialize backfill (done) + `library-health.js` prefetch + 5 senses → `health-events.jsonl`. | `e1f184b` |
| **4.4.72** — Library Slice B | Loud refusals: `audiod/engine.js _noteLoadSkip` emits `loadskip` at the 4 load-time skip points + genuinely-dead fill rows; main routes → `_libHealth.noteSkip`; `refillIfNeeded` filter is file_key-aware (queue content unchanged); loggen items carry `fileKey`; `App.tsx loadDeck` R2-resolves + red toast on failure. | `d2c01d4` |
| **4.4.73** — Library Slice C | HealthMonitor LIBRARY & ROTATION section, Library PLAYS column (plays + last-played + rest countdown + status chip), UpNext queue-lint chip + Generate-time lint. **Arc complete.** | `d2c01d4` |
| **4.4.74** — field fixes + jingle uuid migration | (1) Reverted Slice-C badge roll-in — global dot is **system-only** again. (2) Renderer OOM **mitigation** (IPC back-pressure trimmed) — **soak PASSED 20+ min live**. (3) `audio:daemon-jingle` migrated to `stationUuid` (existing `_stationUuidById`) — leak-guard back to baseline **14** (pre-existing 15th from `82c0dc17`, jingle overlay; first tag since v4.4.52 surfaced it). | `d2c01d4` (fixes) + `d6d9198` (jingle migration) |
| *(receipts)* | Phase 2 report + drift diagnosis | `40c2a94` |

## Final git state (SHIPPED)
- **`main` tip:** `d6d9198` — **fast-forwarded `8c9b8f2 → d6d9198`**, `main == origin/main`. Main now matches what's shipping and airing.
- **`log-reader-flip` tip:** `d6d9198` (== main) — **kept** as the home for Log-Reader Phase 3 (builds forward; main stays at the release).
- **Tag `v4.4.74`:** annotated, on `d6d9198`. CI run 29863074224 **success**. Release **published** (not draft) with `Ether-Setup-4.4.74.exe` + `.exe.blockmap` + `latest.yml` → auto-update armed. Notes: https://github.com/jwjens/ether/releases/tag/v4.4.74
- **Wiki:** `Releases.md` v4.4.74 entry pushed (`jwjens/ether.wiki` `fc05fbb`).
- **package.json** = **4.4.74**. `git status` shows only pre-existing/untracked files that predate or are scratch for this session (never staged).

## Flags — all resolved
1. ~~ether-backend `lookupLicenseDetailed` uncommitted~~ → **RESOLVED.** Committed `c677806` in `C:\ether-backend` (staged `src/index.js` only), pushed `38dd7d6 → c677806`; also carried 3 pre-existing Jeffrey-Jens 2026-07-06 commits (edge purge-on-save, links XSS guard, named links) — all deployed. Backend `main == origin/main`.
2. ~~Branch version-order non-linear / merge-to-main pending~~ → **RESOLVED.** Merged (FF) to main; branch kept for Phase 3.

## Prod DB change this session (not a repo artifact)
- **`licenses.id=24` / `users.id=25`** (jensj@opportunityvillage.org): cleared the leftover trial clock — `UPDATE licenses SET expires_at=NULL; UPDATE users SET trial_ends_at=NULL`. Verified `/account/connect` → 200. netgeak/cristianmalliani untouched.

## Local file changes this session (not repo)
- **165 audio files** materialized from R2 to their `file_path` under `C:\Users\jensj\Music\ether music library\` (the backfill). Files only — the DB was never written externally.
- **Songs 426/427** (Open Format) file_path↔disk mismatch relinked to real Daytime paths (Ether closed → safe DB write). Dead = 0.

## Open / queued for a fresh session
- **Log-Reader Phase 3 (NEXT)** — time-anchored playout flip behind `ETHER_LOG_READER` (ships **OFF**). Per the approved design (`docs/log-reader-single-source-playout-design-2026-07-20.md`, §6 + §2.7 asymmetric ruling): (1) playout consumes `generated_schedule` directly, playhead = row-for-now (BEHIND → skip/stamp `missed`/health event; AHEAD → next pending plays early, silent within slack else health event); (2) cued decks = the log's next rows, operator loads write log rows at the playhead (`source='operator'`); (3) clock-refill demoted to emergency floor (log-exhaustion only, appends + screams); (4) CLEAR = two verbs (Reset to schedule / Clear & regenerate, in-progress hour spared); (5) **SHADOW FIRST** — divergence ledger burn-in before any flip. Blast-radius audit, one release, STOP before install, flag OFF until Jeff gives the flip GO separately.
- **Audio Processing v1** — per-station loudness DSP on the program bus; proposal-first (STEP 0 path audit), STOP before code.
- **Filed follow-ups:** OF's ~69 locally-present-but-zero-spin songs (rotation-coverage question).
