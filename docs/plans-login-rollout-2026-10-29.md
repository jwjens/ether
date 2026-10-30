# Plans and login rollout — steps 1–3 deployed (2026-10-29)

**Jeff (verbatim):** "Don't wait for Azure for this; carry on now with the plans and login work. Never change any license
or subscription: licenses are set only by me in the platform. Your job is to implement how plans work, not to decide or
change anyone's plan. Local is priced per account, $9 for everything local; it's in the price config, so it can be
changed there. In order, each its own commits with tests, deploying each with a check that the live backend answers
normally, and stopping only if something breaks or would change someone's access: 1. Deploy email verification, then
step (a) on its own, then the plan commits (still watch-only). 2. The verify page: an expired link says it expired, and
there's a "send a new link" button. 3. Stranger tests steps (b)-(d). 4. Roles … 5. The desktop side of plans …"

No license or subscription row was written by any of this. Backend repo `C:\ether-backend` (Railway deploys on push to
`main`); signup page `C:\ether-signup` (Cloudflare Pages deploys on push to `main`, served at signup.ether-cast.com).

**Live check used after every deploy:** `/health` 200 · `/api/account/stations`, `/api/user/me`, `/api/me/memberships`
401 without a sign-in · `/api/user/verify` with a junk token → `invalid_token` · `/public/plans` (200 once plans deployed).

## 1. Email verification, step (a), the plan commits

| Deploy | Commit | Railway | Check |
|---|---|---|---|
| Email verification | `1a97ae5` | 39e1cd5a SUCCESS 18:01 | `users.verify_expires` now in production; routes normal |
| Step (a) on its own (server start) | `5a04e7e` | b6b6c05d SUCCESS 18:04 | boots ("API live → port 8080"); routes normal |
| Plans, watch-only (+ Local per account) | `9c4c28f` `2438db4` `78a091d` `dd7aa93` | 59475835 SUCCESS 18:06 | `/public/plans` 200: Local $9 per account, plans local/station/pro/unlimited, nothing purchasable yet (no Stripe prices set); plan check in shadow: 0 refusals, 0 "would refuse"; desktops still syncing |

- **Before email verification, re-checked read-only** (`railway run --service Postgres`, `BEGIN READ ONLY`):
  17 users, 6 verified, **0 active memberships**, 0 that would stop counting. Nobody lost access.
- Tests at each deploy commit: 185/185 (1a97ae5, lib tests), 203/203 (5a04e7e), 230/230 (dd7aa93).
- **Local per account** — commit `dd7aa93`: `config/plans.json` local `"per": "account"` (was `"station"`), summary says
  "one price for the whole account". The catalog validator now refuses any `per` other than account / station / stream.
- **HELD, not deployed — `7b05fc7` (the key check follows the plan).** It would change two licenses' access, both
  lifetime, both refused today and accepted after (stale `expires_at`; no row written):
  **22 — djdeniro@gmail.com** and **26 — joostpeters@gmail.com**. Under "stop if it would change someone's access" it is
  left out: the plan commits were re-applied without it on branch `feat/plans-watch-only` (identical otherwise — the
  diff between the two branches is exactly `7b05fc7`). It stays on `feat/plans-entitlements` for Jeff's yes/no.
- Noted only: every boot logs express-rate-limit's `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` (no `trust proxy` set). That
  code predates today (not in either deploy's diff); not investigated further.

## 2. The verify page

- Backend `f0fee68` (Railway 92d90b0c SUCCESS 18:10): `POST /api/user/verify/resend` also takes `{ token }` — the link
  the person clicked, expired or unused — and mails a fresh 24-hour link to **that account's own stored address** (never
  one the request names). No sign-in needed. A made-up or spent link: `invalid_token`, nothing sent. Without a token the
  route is unchanged (signed in). Live: junk link → `{"error":"invalid_token"}`; no link → 401.
- Signup page `36fbea3` (live at signup.ether-cast.com, bundle `index-CmCDP2Yz.js`): an expired link reads "This link has
  expired. Confirmation links last 24 hours. Send yourself a new one below." with a **Send a new link** button; a
  wrong/spent link offers the button only to someone signed in. vitest added (3 tests).
- Screenshot of the expired state (local, against a stand-in API that answers "expired"; production untouched):
  shows the message and the button. The button's live round trip (a real expired link → new email) is **UNVERIFIED**:
  the one check is to open an expired confirmation link and press it.
- Tests: backend real-route tests (expired → "expired"; resend from it without sign-in → one email to the own address,
  old link dead, new link confirms; made-up link sends nothing). 232/232.

## 3. Stranger tests (b)–(d)

- **(b) `8ad5050` — the inventory.** `src/access/route-access.js`: all **194** routes the server answers, read from the
  running app's own router (index.js plus every mounted router). **159 account** (each with an area), **35 public**
  (each with a one-line reason). A ratchet test fails on an unclassified route or a stale entry.
- **(c) the stranger tests, one commit per area** (`1f8164a` harness + platform, `e215d58`, then one commit per area).
  Two real accounts A and B (license, verified user, operator, machine, station, Park session and key, a row in every
  account table). Each of B's credentials — license key, operator / user / owner token, Park session, Park key — is
  aimed at A's resource (A's ids in path, query and body). A failure is a **leak** (an A-only marker in the response) or
  a **change** (any of A's rows added, changed or removed; whole-database snapshot before/after).
  **Result: no leak and no change on any of the 159 account routes.**
  - Three early failures were the test's own mistakes, not leaks, and are fixed in the harness: a session row carrying
    A's machine *label* but owned by B; A's own key placed in `/licenses/:key/*` (the key is the credential — the route
    is now tested with B's key aimed at A's machine); and the Park login counting a wrong PIN against A's operator —
    **that is the lockout rule working** (5 wrong PINs lock the operator; anyone who knows the Park address can trigger
    it). Only those two columns may change on that route.
  - **Proof each route was reached:** every route is also called with **A's own** credential (database restored after).
    **73 of 159 are proven** (A got a 2xx, so B's refusal is about B). **86 are NOT PROVEN** — A was refused too
    (pg-mem can't run the query, R2/Stripe not set up in the test, or the fixture lacks a field the route validates
    first). For those, "no leak" is true but does not prove the ownership check; the list is below. Raising it is
    per-route work (bodies, pg-mem stand-ins).
- **(d) `53c27f8` — GitHub check** `.github/workflows/test.yml`: `npm ci && npm test` on every push to `main` and every
  PR. **Jeff's click:** Railway → ether-backend → Settings → Deploy → **Wait for CI** (on). Until then the check reports
  but does not hold a deploy. The Railway CLI has no command for that setting.
- `npm test`: **424/424**. Deployed `53c27f8` (Railway 769b425b SUCCESS 18:42); the GitHub check ran on it: **completed
  success**; live routes normal.

### NOT PROVEN — A's own credential was refused too (statuses for A's six credentials)

| Area | Route | A's statuses |
|---|---|---|
| analytics | `GET /api/account/station/:uuid/analytics` | 401,500,500,500,401,401 |
| analytics | `GET /api/account/station/:uuid/affidavit` | 401,500,500,500,401,401 |
| analytics | `GET /api/account/station/:uuid/listeners` | 401,500,500,500,401,401 |
| analytics | `GET /api/account/station/:uuid/listenership` | 401,500,500,500,401,401 |
| backups | `POST /backup/list` | 500,400,400,400,400,400 |
| backups | `POST /backup/prune` | 400,400,400,400,400,400 |
| backups | `POST /backup/upload-url` | 400,400,400,400,400,400 |
| backups | `POST /backup/download-url` | 500,400,400,400,400,400 |
| backups | `POST /backup/upload` | 400,401,401,401,401,401 |
| billing | `POST /api/account/billing/portal` | 401,503,503,503,401,401 |
| jukebox | `POST /api/account/jukebox/payouts/:uuid/connect` | 503,503,503,503,401,401 |
| jukebox | `POST /api/account/jukebox/payouts/:uuid/refresh` | 404,404,404,404,401,401 |
| library | `POST /api/account/audio/upload-url` | 401,400,403,400,401,401 |
| library | `POST /audio/upload-url` | 400,400,400,400,400,400 |
| library | `POST /audio/delete` | 400,400,400,400,400,400 |
| library | `POST /audio/download-url` | 400,400,400,400,400,400 |
| library | `GET /audio/list` | 500,401,401,401,401,401 |
| library | `POST /library/songs` | 400,401,401,401,401,401 |
| link | `POST /api/link/relay/session` | 401,401,503,401,401,401 |
| link | `GET /api/link/relay/sessions` | 401,401,503,401,401,401 |
| link | `PUT /api/link/key` | 401,401,400,401,401,401 |
| link | `POST /api/link/pair-code` | 401,401,400,401,401,401 |
| link | `POST /api/link/pair-redeem` | 401,401,400,401,401,401 |
| link | `POST /invite/send` | 400,400,400,400,400,400 |
| link | `POST /guest/join` | 400,400,400,400,400,400 |
| park | `POST /public/ops/:slug/login` | 423,423,423,423,423,423 |
| park | `PUT /public/ops/:slug/closing-time` | 403,403,403,403,400,400 |
| park | `PUT /public/ops/:slug/level` | 400,400,400,400,400,400 |
| park | `PUT /public/ops/:slug/mute` | 403,403,403,403,409,409 |
| park | `POST /public/ops/:slug/fire` | 403,403,403,403,400,400 |
| park | `POST /public/ops/:slug/listen` | 403,403,403,403,503,403 |
| park | `POST /public/ops/:slug/listen/renew` | 403,403,403,403,410,403 |
| park | `POST /public/ops/:slug/talk/warm` | 403,403,403,403,503,403 |
| park | `POST /public/ops/:slug/talk/warm/renew` | 403,403,403,403,410,403 |
| park | `POST /public/ops/:slug/talk` | 403,403,403,403,503,403 |
| park | `POST /internal/mediamtx/auth` | 401,401,401,401,401,401 |
| platform | `GET /api/platform/db-stats` | 500 |
| platform | `POST /api/platform/users/reset-password` | 400 |
| platform | `POST /api/platform/account/create` | 409 |
| platform | `GET /api/platform/licenses` | 500 |
| platform | `POST /api/platform/licenses` | 400 |
| platform | `PATCH /api/platform/licenses/:id` | 400 |
| platform | `GET /api/platform/seat-tiers` | 500 |
| platform | `POST /api/platform/seat-tiers` | 400 |
| platform | `PATCH /api/platform/seat-tiers/:id` | 400 |
| platform | `DELETE /api/platform/seat-tiers/:id` | 409 |
| platform | `POST /api/platform/licenses/:id/emails` | 400 |
| platform | `DELETE /api/platform/licenses/:id/emails/:email` | 409 |
| platform | `POST /api/platform/licenses/:id/library-grants` | 400 |
| platform | `DELETE /api/platform/licenses/:id/library-grants/:granteeId` | 404 |
| platform | `GET /api/platform/rollup` | 400 |
| platform | `GET /api/platform/performances` | 400 |
| platform | `GET /admin/licenses` | 403 |
| platform | `POST /admin/issue` | 403 |
| remote | `POST /api/cmd` | 400,400,403,400,401,401 |
| remote | `POST /api/cmd/ack` | 400,401,401,401,401,401 |
| remote | `GET /api/cmd/ack/:cmd_id` | 401,404,404,404,401,401 |
| seats | `GET /licenses/:key/activations` | 400,400,400,400,400,400 |
| seats | `POST /licenses/:key/deactivate` | 404,404,404,404,404,404 |
| seats | `POST /account/create` | 400,400,400,400,400,400 |
| seats | `POST /account/add-station` | 400,400,400,400,400,400 |
| seats | `POST /account/register-station` | 400,400,400,400,400,400 |
| seats | `POST /account/attach` | 400,400,400,400,400,400 |
| seats | `POST /account/detach` | 400,400,400,400,400,400 |
| stations | `POST /api/user/account-slug` | 401,409,409,409,401,401 |
| stations | `POST /api/user/account-logo-upload-url` | 401,400,400,400,401,401 |
| stations | `GET /api/account/stations` | 401,500,500,500,401,401 |
| stations | `POST /api/account/stations` | 401,400,403,400,401,401 |
| stations | `GET /api/accounts/:accountId/stations` | 401,403,500,500,401,401 |
| stations | `GET /api/account/health` | 401,500,500,500,401,401 |
| stations | `POST /api/account/station/:uuid/staged` | 401,400,400,400,401,401 |
| stations | `POST /api/account/station/:uuid/staged/clone-categories` | 401,400,400,400,401,401 |
| stations | `POST /api/account/station/:uuid/staged/clone-programming` | 401,400,400,400,401,401 |
| stations | `POST /api/station/:uuid/logo-upload-url` | 400,400,403,400,401,401 |
| stations | `POST /api/station/:uuid/now-playing-art-upload-url` | 400,400,400,400,401,401 |
| sync | `POST /sync/mutations` | 400,401,401,401,401,401 |
| users | `POST /api/user/desktop-activate` | 401,401,401,401,401,401 |
| users | `POST /api/auth/bootstrap-admin` | 409,400,400,400,400,400 |
| users | `POST /api/auth/login` | 429,429,429,429,429,429 |
| users | `POST /api/user/checkout` | 401,401,503,401,401,401 |
| users | `POST /api/account/users` | 401,409,403,409,401,401 |
| users | `GET /api/accounts/:accountId/members` | 401,403,500,500,401,401 |
| users | `POST /api/accounts/:accountId/members` | 401,403,400,400,401,401 |
| users | `DELETE /api/accounts/:accountId/members/:membershipId` | 401,403,403,403,401,401 |
| users | `POST /api/accounts/:accountId/positions` | 401,403,400,400,401,401 |
| users | `DELETE /api/auth/sessions/:id` | 401,401,404,401,401,401 |
