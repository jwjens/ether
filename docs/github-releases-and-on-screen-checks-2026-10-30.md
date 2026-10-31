# Where 4.6.58–4.6.68 went, and the on-screen checks (2026-10-30)

## 1. GitHub releases (read-only; nothing published or changed)

Jeff: "you said the newest published GitHub release is 4.6.57, but OV and OVEVENTS have 4.6.68 installed. Check where
4.6.58–4.6.68 went … and whether customers' Ether is being offered updates past 4.6.57."

Receipts (`gh release list`, `gh api …/releases/latest`, `git ls-remote --tags`, `gh run list -w build.yml`):

| Version | Tag on GitHub | CI run | Release |
|---|---|---|---|
| 4.6.57 | yes | success 2026-10-06 00:44 | **published, "Latest"** |
| 4.6.58 | **no** (deleted) | success 2026-10-06 01:44 | none |
| 4.6.59 | yes | failed 10-06, success 10-11 | **draft** (all installers + latest.yml attached) |
| 4.6.60–4.6.67 | no | none | none: local builds (`--publish never`, unsigned), per docs/build-4.6.6x-*.md |
| 4.6.68 | **no** (deleted) | failed 2026-10-29 (Azure signing disabled; Mac engine fingerprint) | draft deleted (docs/release-4.6.69-…) |

- **No other repo.** The updater feed is `electron-builder.json` → publish github `jwjens/ether`, releaseType `release`.
- **4.6.60–4.6.68 were never published.** They are local installers from `C:\openair\dist-electron`, installed by hand
  on OVEVENTS and, per Jeff, on OV.
- **Customers are not offered anything past 4.6.57.** electron-updater reads only the published "latest" release.
  Drafts (4.6.59) are invisible to it. So a customer on 4.6.57 sees no update, and anyone older is offered 4.6.57.
- OV and OVEVENTS (4.6.68) are newer than the feed, so they see no update either (the check needs strictly greater).

## 2. On-screen checks in the running dev Ether on OVEVENTS (Jeff signed in)

| Check | Result | Receipt |
|---|---|---|
| Item 30: reload keeps you signed in | **PASS** — two reloads (page start time changed 21:55:22 → 21:55:45) came back signed in | shots/04, 05 |
| — side note | for about a second during a reload the profile picker (Admin / jeff / Ryan …) flashes before the main screen returns | CDP text at 21:55:45 |
| IRIS button hidden | **PASS** — no button with "Iris" in the main window | CDP button list |
| Ether's own confirm window | **PASS** — EAS Logbook test entry ("CLAUDE TEST ENTRY", the only row; Logbook was empty): Del → Ether's window; Cancel kept the row; Del → OK deleted it | shots/08, 10 |
| — nothing synced | eas_tests is not a synced table, has no triggers; mutations after the test (rowid > 419831) = play_log 10 (Jeff's playout) + station_config_kv 1, none for eas | CDP queries |
| Update Details popup | **bug found and fixed** (3b95e7e): unpackaged, it asked for notes since 43.5.1 (Electron's version). Main needs a restart to show the fix on screen | CDP invoke |

Not checked yet, because they write to HalloVeen while sync is **on** (`sync_switch = on`) and would reach OV, or load a
deck while AUTO is playing: Normalize, attach audio, Scan Durations, Shows delete, Show+ To Deck, Jukebox link.

### New dead items seen during the checks
- **The hamburger menu has no EAS Logbook entry.** The only way in is the window's native menu bar (main.js:3717).
- ~~EAS Logbook pop-out → Close does not close the window.~~ **WITHDRAWN — my error.** Pop-outs HIDE on close
  (main.js:8971); a hidden window is still a DevTools target, and I read "target still listed" as "window still open".
  Re-checked with Windows' own window list: visible after reopening, hidden after Close. Close works.
- **Fixed:** the ☰ menu now has **EAS Logbook** (same pop-out as Menu → EAS Logbook). Seen on screen: the entry is
  there (shots/11) and opens the Logbook.
