# Build 4.6.71 (2026-11-03) — local installer, not tagged or published

Jeff, 2026-11-03: "Merge feat/board-duck-eq (428b417 and 03321f3) into the release branch for 4.6.71. Don't build or
publish yet." Then: "1, 2, 4, then 3. Commit the docs on release/4.6.71. Push release/4.6.71 after the build. Don't tag
or publish a release." (1 = clean up, 2 = file the docs, 4 = build 4.6.71, 3 = push.)

## What is in 4.6.71 (on top of 4.6.70)

Branch `release/4.6.71`, made from `release/4.6.70` (6ef5a9b) and fast-forwarded to the board commits.

| Commit | What |
|---|---|
| 428b417 | One DUCK button per fader, in the bottom row ON \| PFL \| DUCK; no EQ button on the fader strips; the EQ window's Channel selector lists the board's decks and faders |
| 03321f3 | No EQ button on the A/B/C deck cards or Master Out; EQ only from ☰ → Processor; MASTER OUT last in the selector |
| c7c2813 | 28 docs and `scripts/category-match-dryrun.js` that were never committed (filed as written) |
| 913fb63 | User manual: DUCK and EQ as they are now (8 lines), PDF rebuilt |
| ae3a14f | 4.6.71: version and changelog; manual version line; PDF rebuilt |

## Clean-up before the build (C:\openair)

- 11 files showed as modified but were byte-for-byte the same as the committed copy: committed with CRLF, flagged by
  `.gitattributes` `eol=lf`. `git checkout --` cleared them. No content changed.
- Deleted `ETH-STN-BAA8-E056-6FC8` from the repo root: a 91-byte stray from a 2026-10-20 test run (it held only a temp
  profile path).

## The user manual

Found during the build: `docs/user-manual.md` (it ships in the installer as Ether-User-Manual.pdf) still described the
removed buttons, namely EQ under the fader, DUCK ON/OFF under the source dropdown, a second DUCK above EQ, and Master Out's
"Master EQ → OPEN". Corrected in 913fb63. The test that ties the manual's first line to the version failed until the
line said 4.6.71 (ae3a14f).

## Tests

- `npx tsc --noEmit`: 0 errors.
- `npx vitest run`: 204 files, **1500/1500 pass** (the run at ae3a14f). An earlier run, before the manual's version line,
  had 3 failures: the manual line (fixed) plus 2 that did not repeat on the next run.
- Pre-commit schema check: transformer chain v2 → v69 verified, fresh-install chain clean.

## Build

`npm run build`, then `npm run electron:build:win -- --publish never`. Both exit 0.

- **`C:\openair\dist-electron\Ether Setup 4.6.71.exe`**: 217,883,058 bytes, built 2026-11-03 13:31, SHA-256
  `62b735f16d777e883cccc7e3567f4d9b30170d65c3f28dc3cc9f1094c5ecaae5`. Unsigned (local build).

## Release checks

1. **Packaged:**
   - engine OK (`pe`, engine source `d4a2c71b654d31da`, the same as 4.6.70);
   - every engine file unpacked;
   - HA helper OK;
   - user manual OK (`resources\Ether-User-Manual.pdf`, 1233 KB).
2. **Contents vs 4.6.70:** same. `package.json` / `package-lock.json` differ from v4.6.70 only in the version line, so no
   package was added or removed.
3. **Size:** 217,883,058 vs 217,882,685 bytes for 4.6.70 (+373 bytes).
4. **Real launch, isolated:** `ETHER_SMOKE=1`, its own `--user-data-dir`, LOCALAPPDATA and APPDATA (fresh profile):
   - `version: 4.6.71  packaged: true`;
   - engine staged from the install, engine-check `→ match`;
   - daemon attached after the in-process fallback (the known cold-stage race), handover complete;
   - **`[SMOKE] PASS — react_mounted=true … daemon_started=true daemon_log_staged=true station_count=0 air_isolated=true`**.

   The throwaway engine (pid 53888, in the temp folder) was stopped and the temp folder removed; no ether-engine is left
   running. A run on a stripped copy of this computer's database (the 4.6.70 check's second run) was not done.
5. **On screen:** the DUCK / EQ changes in the packaged app were not looked at. They were seen in the dev build
   (screenshots on the board page). In the packaged build: **UNVERIFIED**.

## Not done (as asked)

No tag, no GitHub release, no CI run, no install. `release/4.6.71` is pushed after this record.
