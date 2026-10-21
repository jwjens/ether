# Backend deploy — do 4.6.61 clients (OV) keep working? (2026-10-20)

## Jeff's request (verbatim)

> Before deploying the backend, confirm in writing that 4.6.61 clients (OV) keep working against it. Then deploy, with my OK.

Read-only review of what a deploy would ship, against what a 4.6.61 desktop sends and reads. **Not deployed.**

## What a deploy would ship

ether-backend is on branch `feat/park-talk`. Railway's last successful deploy: **2026-10-16 15:48 PDT**
(`cbba149c`). Commits after it:

| Commit | When | What |
|---|---|---|
| `61852fc` | 10-16 16:25 | park talk: warm lines (each phone's own relay path; floor ends only by the talker's tap or the station) |
| `c61b6ab` | 10-20 15:02 | PINs: scrypt for new PINs; old formats still verify |
| `8c30634` | 10-20 16:00 | backups per computer: list, prune, download a chosen backup |

`61852fc` was committed 37 minutes after that deploy. `railway up` uploads the working folder, so it may already have
gone out uncommitted — **git cannot tell; treat it as part of this deploy** unless you know otherwise. The working folder
also has an uncommitted change to `scripts/prove-dj-divergent-receive.js` and two untracked scripts; they are not run by
the server (`Procfile`: `node src/index.js`).

## 4.6.61 against the new backend — endpoint by endpoint

| What 4.6.61 does | Changed? | Result |
|---|---|---|
| Sync push / pull (`/sync/mutations`) | No (`src/routes/sync.js` untouched by `c61b6ab` / `8c30634`) | **Works as today** |
| Pushes its users with PIN hashes (`/api/account/users/sync`) | Stores them verbatim, as before | **Works.** Its salt:sha256 PINs still verify at the dashboard login (`verifyPin` reads scrypt, salt:sha256 and plain) |
| Dashboard login for its users (`/api/auth/login`, `/public/ops/:slug/login`) | `verifyPin` now async, all three formats | **Works** — tested: `node --test src/lib/pin-hash.test.js` 3/3 (an old desktop salt:sha256 PIN verifies) |
| PINs set on the web dashboard | Now stored as scrypt | No 4.6.61 code reads them back (the desktop push is one-way) — **no effect on 4.6.61** |
| Cloud backup upload (`/backup/upload-url`) | `machine_id` optional | 4.6.61 sends none → the **old account-wide key, unchanged** |
| Install from cloud (`/backup/download-url`, no key) | "Newest" is now by timestamp across ALL pages and folders (was: key text, first 1,000) | **Works**, and is more correct. It can now return a 4.6.62 computer's per-computer backup if that is the newest. 4.6.61 opening a newer-schema database: **UNVERIFIED** (install-from-cloud is a fresh-computer action; one test on a scratch install would settle it) |
| `/backup/list`, `/backup/prune` | New | Not called by 4.6.61 |
| Park talk (`61852fc`) | Server side of 4.4.x park talk | Additive routes; 4.6.61 park talk was built against it — **not re-tested here** |

**Conclusion: nothing a 4.6.61 desktop calls is removed or changes shape. OV keeps working against the new backend.**

## Not a backend question, but OV should know (client ↔ client, while versions are mixed)

Once **any** computer runs 4.6.62, its sync changes carry schema version **67/68**. A 4.6.61 computer (schema 66)
**holds them in quarantine** (`electron/sync/merge-engine.js:135`) — kept, not lost — and applies them when it upgrades
(`drainQuarantine` at sync start). So **while OV is on 4.6.61, OV does not receive OVEVENTS' 4.6.62 changes** (songs,
categories, plays, users). The other way works: 4.6.62 applies 4.6.61's changes through the transformer chain. Installing
4.6.62 on both computers closes it.

## To deploy (on Jeff's OK)

From `C:\ether-backend` on `feat/park-talk` at `8c30634`: `railway up` (production, service ether-backend). Then:
`/health` 200; a dashboard PIN login with an existing (salt:sha256) user; `/backup/list` answers for the account.

## Deploy attempt — 2026-10-21 ~08:49 PDT (Jeff's OK, including `61852fc`)

- Before: `/health` 200; backend tests `pin-hash` + `backup-keys` 4/4.
- Baseline (read-only, prod Postgres): OV = **ovowforestmusic, client `041ceb96`, license 24**, pushing on schema 66 —
  8 pushes in the last hour, latest 15:42:28Z. OVEVENTS (`8e8f6181`) last pushed 2026-10-20 23:32Z (Ether closed).
- `railway up --service ether-backend --ci` → **"Deploys have been paused temporarily"** — refused by Railway; nothing
  uploaded. `railway deployment list` still shows `cbba149c` (2026-10-16 15:48) as the live deploy. Railway's status
  page lists its Builds and Deploy components as DEGRADED_PERFORMANCE — a platform-side pause, not this project.
- The live backend is unchanged; OV keeps syncing against the same code as before. **Not deployed — retry when Railway
  lifts the pause.** Check script (read-only): scratchpad `diag-ov-sync.js`, run with `railway run --service Postgres`.

## Retry — 2026-10-21 ~12:53 PDT (4.6.62 now on OV and OVEVENTS)

### Jeff's request (verbatim)

> 4.6.62 is installed on OV and OVEVENTS. Retry the backend deploy now. Confirm /health, a dashboard PIN login for an
> existing user, and that both machines sync users, plays and categories on 4.6.62.

- Before: `/health` 200 (`version 1.5.2`, live deploy still `cbba149c`, 2026-10-16 15:48). `pin-hash` tests 3/3 at `8c30634`.
- `railway up --service ether-backend --ci` → **"Deploys have been paused temporarily"** again. Indexed, refused at upload;
  `cbba149c` still live. **Not deployed.**

### Sync on 4.6.62 — what prod Postgres shows (read-only, ~12:54 PDT)

| Computer | First push on 4.6.62 (schema 68) | Users | Plays (`play_log`) | Categories |
|---|---|---|---|---|
| OV `041ceb96` | 12:49:36 PDT | pushed (12:49:36) | **none since upgrade.** Last play created 2026-10-20 21:02 PDT, ~15 h before the upgrade | none since upgrade. Last 2026-10-19 19:11 PDT |
| OVEVENTS `8e8f6181` | 11:58:35 PDT | pushed (11:58:35) | **none since upgrade.** Last 2026-10-20 16:32 PDT | none since upgrade. Last 2026-10-19 10:38 PDT |

- **Users: both computers push on 4.6.62.** Confirmed on the server.
- **Plays: nothing from either computer on 4.6.62 yet.** OV stopped pushing plays at 21:02 PDT last night, well before
  the install. Whether OV aired after that: UNVERIFIED (the server can't tell "not on air" from "on air, not pushing").
  To settle it: OV's Play Log for today, or one song played on each computer, then re-run the check.
- **Categories: no category edits since 10-19, so nothing to sync yet.** To settle it: rename or add one category on
  OVEVENTS, and see it arrive on OV (and the reverse).
- **The receive side can't be seen from the server** (no pull cursor is stored there). Proof that each computer
  *applied* the other's changes has to come from the computers: users list, Play Log "Aired on", Categories.
- Check scripts (read-only): scratchpad `diag-sync-4662.js`, `diag-sync-4662b.js`, `diag-lic24-users.js`
  (`railway run --service Postgres node <script>`).

### Dashboard PIN login — blocked for scrypt PINs until the deploy

The live backend (`cbba149c`, pre-`c61b6ab`) checks PINs as plain or salt:sha256 only. `src/index.js` `verifyPin` at
`84a4a6b` has no scrypt branch. On 4.6.62, OV upgraded **Admin** (lic 24) to scrypt and pushed it at 12:49:26 PDT.
So, from the code: **Admin can't sign in to the dashboard until this backend goes out.** **ryan** and **shawna**
(still salt:sha256) should be able to. Runtime: UNVERIFIED. One sign-in attempt for each settles it. Each 4.6.62 sign-in
on the desktop upgrades that user to scrypt, so more users will hit this until the deploy.

Lic 24 users (live): Admin (scrypt), ryan, shawna. OV's 12:49 push revoked jeff / Steve / Donavon. They have been
revoked and recreated many times since September as the two computers push different user lists to
`/api/account/users/sync` (its reconcile step revokes users the pushing computer doesn't have). Noted only; not investigated.
