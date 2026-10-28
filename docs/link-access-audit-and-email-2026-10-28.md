# Remote Link access audit, email-based access, and the plans that follow (2026-10-28)

**Jeff (verbatim):** "After the security deploy: 1. Audit, read-only: from the backend's records and logs since the pairing
server went live, list every time a Link key or machine list was read or replaced by a license that isn't a member of
the account that owns it. Accounts 21 and 23 included in the check, but don't change anything for them. Tell me what you
find. 2. Search the backend for anything else that decides access by matching email instead of license membership, and
list it. Don't change it yet. 3. Plan only: verify email addresses at sign-up (a confirmation link) before an email can
be used for anything that grants access. 4. Add a test category for this: every endpoint that returns or changes
account data has a test where a stranger's license tries it and is refused. Add it to the release checks."

No personal data from the production database is written here: accounts are named by license number only.

## The deploy

Backend `0d072b1` (H5 and M1 closed), pushed to `main` as a fast-forward from `2cf4037`; Railway deployment `51d79c85`
SUCCESS, 2026-10-28 13:43 -07:00. `/api/link/machines` without sign-in: 401.

- **Links already running:** a fader that cannot fetch a key keeps the one it has (`electron/main.js`
  `_linkRefetchAccountKeys`: `if (!r.ok …) continue`), so the deploy cannot cut one. On OVEVENTS no Link was playing:
  halloVeen's send was turned off at 20:38:11Z, and since 2026-10-24 it had logged "no answer yet" from the receiver.
  ovowforestmusic's receiving side is not visible from here: UNVERIFIED there.
- **Re-publishing (0 of 3 at 20:46Z):** OVEVENTS runs a development build, which never writes to the live service, so it
  re-publishes only when the installed Ether runs. ovowforestmusic last published 10:30Z (it re-publishes hourly while
  Ether runs and reaches the backend). OV-NDI-PC last published 2026-10-27.

## 1. Audit: who read or replaced a key or a machine list without being a member

Read-only (read-only session, SELECTs only). Every license checked, 21 and 23 included; nothing changed.

| Record | Rows | Made by | Member of the owning account? |
|---|---|---|---|
| `link_keys` (published keys) | 3: ovowforestmusic, OV-NDI-PC, OVEVENTS | Jeff's login (license 24) | yes, all three |
| `link_pair_codes` (open guest code) | 1: ovowforestmusic | Jeff's login (license 24) | yes |
| `link_account_keys` (new) | 0 | — | — |

- **No replacement by an outsider is on record.** Every stored key was last published by Jeff's login.
- **Reads were never recorded.** The Link read routes wrote nothing to the database, and the backend keeps no request
  log (Railway shows the last 500 lines; none mention Link). Reads cannot be audited, before or after today.
- **H5 (email match):** it let in a user whose email matched an active license that is not their own. **There are 0 such
  users**, so nobody could have used it.
- **M1 (machine id alone):** OVEVENTS has an **active seat on license 28, another person's account**, made 2026-08-12,
  last seen there 2026-08-16, never deauthorized. Until today that put OVEVENTS in license 28's account: its login could
  list OVEVENTS and read or replace its link key. No replacement is on record; whether it was read cannot be known.
  Since the deploy, license 28 sees no key for OVEVENTS; its machine list still names OVEVENTS until that seat is
  deauthorized. **Deauthorizing it changes another person's account: Jeff's decision.**

## 2. Other access decided by matching email (listed, not changed)

| Where | What it does | Risk |
|---|---|---|
| `POST /api/user/desktop-activate` (`index.js:2459-2470`) | A user with no linked license is given the newest active **trial** license whose email matches theirs: key returned, seat registered, user linked to it. | **HIGH.** Signup never verifies an email, so a stranger who signs up with a trial customer's email gets that customer's trial license key and a seat on it. |
| `POST /api/user/signup` (`index.js:2235-`) | Returns a signed-in user token at once; the verify email is sent but `email_verified` is read nowhere. | The precondition for the row above (and for H5 before today). |
| `POST /api/platform/account/create` (`index.js:1596-1601`) | With no license id given, binds the new web login to the newest active license whose email matches. | LOW: platform admin only. |
| `GET /licenses/:key/activations`, `POST /licenses/:key/deactivate` (`index.js:4011`, `:4036`) | Key **and** email must match. | Not email-only: the key is the credential. |
| `POST /api/accounts/:id/members` (`index.js:2939-2968`) | An account admin adds a member by email; a passwordless user row is made if none exists. | The invitee gets in only by setting a password through the reset email; signup with that email is refused (409). OK. |

## 3. Plan: verify an email before it grants access (plan only)

1. **Signup returns no access token.** It creates the user with `email_verified = false` and sends a one-use
   confirmation link (random token, SHA-256 stored, 24 h). Until confirmed, login answers "confirm your email first".
2. **`GET /api/user/verify?token=` confirms:** sets `email_verified = true`, deletes the token, signs the user in.
3. **Every path that grants access by email checks it,** through one helper (`requireVerifiedEmail`): desktop-activate's
   trial-by-email lookup, the platform's create-by-email when no license id was typed, and any future one. A test lists
   every email lookup in the code and fails if one skips the helper.
4. **Existing users:** platform-created users are already verified (`index.js:1539`, `:1571`); Stripe-created ones are
   marked verified (Stripe saw that email pay); everyone else confirms once at their next web login. No desktop is locked
   out: an activated machine keeps running on its license key.
5. **Password reset** proves the inbox, so it also sets `email_verified = true`.
6. **Tests:** signup gives no token; an unverified user cannot desktop-activate onto an email-matched license; the link
   works once and expires; a verified user is unaffected.

Questions for Jeff: the link's lifetime (24 h proposed); may an unverified user start the 15-day trial on a NEW license
of their own (proposed: yes — only access to EXISTING data needs the confirmation)?

## 4. Plan: a "stranger" test for every endpoint that touches account data

**Size, measured:** 166 routes in `src/index.js` (one 7,500-line file) plus 5 in `src/lib/link-pairing.js`. The file
connects to Postgres and starts listening as it loads, so none of its routes can be tested today; the only route tests
(Link pairing, install users) cover modules already lifted out. The backend has no test command and no release check: a
push to `main` deploys.

1. **Make the server testable without changing what it does:** `index.js` exports `createApp(pool)` and listens only
   when run directly. The boot schema runs from `createApp` on whatever pool it is given, so tests run the real schema
   on pg-mem (anything pg-mem cannot run is listed and replaced only inside the test, never in production).
2. **The inventory, a ratchet:** a test reads every route and requires each to be in `src/access/route-access.js` as
   **account data** (needs a stranger test) or **public** with a one-line reason (health, now-playing, signup, login…).
   A new route in neither list fails the test.
3. **The stranger tests:** two accounts, A and B (a license, a user, a machine and a station each); per account route, B's
   credentials on A's resource must be refused (403/404) with nothing changed. In batches by area (stations, library,
   sync, backups, users, link, seats, platform), each its own commit.
4. **Release check:** `npm test` in the backend, plus a GitHub Action on every push to `main`; Railway set to wait for
   that check, so a failing push does not deploy.

Steps 1 and 4 change how the production server starts and deploys: both wait for Jeff's go.
