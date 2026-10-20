# The one build — release/1019 (2026-10-19)

**Installer:** `C:\openair\dist-electron\Ether Setup 4.6.59.exe`
**Size:** 216,180,160 bytes · **sha256:** `0b825f79ca0bb21f52c81d23b535b04cdd90cf55571e6ce6a11c0fe9de7c84b0`
**Built:** 2026-10-19 17:11:56 PDT from commit `11736e4` on branch `release/1019` (local only, not pushed, not tagged, `--publish never`). Version number unchanged (4.6.59) per the no-bump-until-Jeff-tests rule — identify it by commit + sha256.
For **both machines** (OV and OVEVENTS). Nothing was installed anywhere.

## What is in it (on top of b02a58b, the build installed on OVEVENTS)

| Commit | What |
|---|---|
| c2c9409, f435c3c | References travel by UUID (songs no longer land one category off; artists created on arrival; one-time re-file with a report of every song moved) — docs/sync-uuid-references-2026-10-19.md |
| 7b0566d, e9d6100 | Carts window, push-up in the Carts window's colours with no gaps, Screen Builder Carts = the Carts window; the carts proof test fix |
| 4f78b4a | Program Log: Title column no wider than a title; bigger, brighter calendar, selected-day line and Today's Shows |
| d1252f3 | Hour rules from today's 3 PM on OV (crossing song then the new hour; never wait inside a show; Generate sees every row; regenerate from the next song; nothing the code decides; log reader for every station) — docs/hour-rules-3pm-build-report-2026-10-19.md |
| 11736e4 | Sweepers: the dropdowns decide — none means none, every change saved and live; pool references by uuid — docs/sweepers-assignments-2026-10-19.md |

Plus everything already in b02a58b's lineage (Scheduler Phase 1, show boundaries, log plays through, release/1018, Screen Builder phase 1, and the patch-equivalent branches announce-seconds-repeat, boardcut, interchange, toh).

## Left out — in progress (listed, not merged)

- **Announcement catch-up / Up Next / stacked / ×N** (fix/aftersign-announce-catchup = wip/announce-catchup: 549d207, e7e65fd, dd4f113, 6f54afe) — runtime tests 1–18 never recorded.
- **Trial banner** (fix/p0b-trial-banner: 2c79267, 21197b1) — never tested.
- **Show+ DAW sessions, Phase A** (worktree C:\openair-wt\daw-session, uncommitted) — never seen by Jeff in the running app.
- Superseded / docs-only: fix/halloveen-playout 10348f4 (superseded by Scheduler Phase 1); release-1018 worktree's uncommitted loggen/generate-core draft (superseded by ad866aa); docs-only commits 5b1458b, f4d68fa, 6876189, 21431d3.
- Not built: the dashboard (ether-dashboard) half of UUID references; exact-spot stall resume (needs a native seek — see the hour-rules report).

## The schema check (why a commit failed on ui/screen-builder)

The pre-commit hook `verify-transformer-chain` reads this machine's live database (schema v66). ui/screen-builder only had migrations to v64, so the check failed there. It is not a carts problem; on release/1019 (migrations to v66) every commit passed the hook.

## Gates on 11736e4

tsc 0 · vitest 118 files / 1028 tests · verify:schema PASS · scheduler gate (T1/T2/T4/T5/T8/T10/T11/T19/T20 PASS; T3/T15/T18 failing as before — T18 335 also on untouched HEAD; station 3's T3 131 → 236 noted in the hour-rules report) · test:three-pm 27/27 · test:sweeper-assignments 22/22 · test:uuid-refs 30/30 · test:sync 55/55 · programlog-reads 11/11 · programlog-writes 110/110 · hour-rollover 7/7 · autopost-switch 11/11 · sweeper-sense 9/9 · designation PASS · window-station, copy-on-import, catalogue-r2, sign-filter 12/12, undefined-calls, ipc-contract, preload-bridge, spot-edge, queue-rows, stale-rows, calendar-anchor, local-playback: PASS.
**test:one-switch FAILS**, on a test file older than this work (a hand-rolled station_config_kv insert in src/audio/attach-restore-sequence.test.ts, since 10-12/13, also in the installed build) — not shipped code; not touched.

## Release checks

1. **Contents:** verify-package-contents vs the log-plays-through build (b02a58b lineage): 215/215 packages, PASS. Today's changes confirmed inside the package (main.js _replaceSweepers / _regenPoint, no fallback; engine log reader only, _resumeStalled, _releaseEndedHourRows; loggen rule 1; synced-tables pool reference; renderer "none (no sweeper)").
2. **Size:** 216.2 MB vs 216.1 MB (0.0%), PASS.
3. **Real launch:** **NOT RUN.** This machine (OVEVENTS) is on air with Ether installed; launching a second Ether here risks the station. Needs Jeff to name where to run it.

## Changes on air after install (from the two reports)

- Playout: the old hour's leftovers are marked didn't play at :00; inside a show nothing waits; only a show that runs out of music generates (switch "Generate when a show runs out" must be ON); a stalled song restarts on its own deck from the top (exact-spot needs a native change).
- Sweepers: HV, Kids and Disney on halloVeen are set to none in the data and get **no** sweepers until their dropdowns are set; Christmas in Jully's categories set to none lose their fallback sweepers.
