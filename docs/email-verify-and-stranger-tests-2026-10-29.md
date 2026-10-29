# Email verification at sign-up, and the stranger tests (2026-10-29)

**Jeff (verbatim):** "Build email verification at sign-up: the confirmation link lasts 24 hours; an unverified person may
start a trial on a brand-new license of their own, but can't claim or join anything that already exists until verified.
Then the stranger tests, steps a–d: make the server loadable by tests without changing what it does, list every route as
account data or public, write stranger tests by area, and add a GitHub check that Railway waits for before deploying.
Own commits with tests. Show me before every deploy, and after any change to how the server starts, deploy it on its own
and confirm the live backend answers normally before going on. Always give a license's email next to its number, and
never touch licenses 21 or 23."

Plan this builds: `docs/link-access-audit-and-email-2026-10-28.md` §3 (email) and §4 (stranger tests).
Backend repo `C:\ether-backend`, branch `feat/email-verify-stranger-tests` (from `origin/main` = `c2d3e1f`). Nothing
pushed, nothing deployed.

## Commit 1 — `1a97ae5` email verification (deploy 1)

- **The link:** random token; only its SHA-256 is stored (`users.verify_token`) with `users.verify_expires` = 24 h
  (new column, additive `ADD COLUMN IF NOT EXISTS`). Works once. `POST /api/user/verify` confirms (`expired` /
  `invalid_token` on failure). New `POST /api/user/verify/resend` (signed in) sends a new link; the old one stops.
  A password reset (`/api/user/reset`) proves the inbox, so it confirms the email too. The platform's admin
  password-set does **not** (it proves nothing about the inbox).
- **Trial on a new license, unverified: allowed.** Sign-up still signs the person in at once; desktop-activate gives an
  unverified person their own license or a brand-new trial (`src/lib/desktop-license.js`, since `86d79c2`).
- **Join, unverified: refused.** A membership in an account that is not the person's own license counts only once the
  email is verified (`src/lib/email-verify.js` `MEMBERSHIP_COUNTS_SQL`), in: `getMembership` (so `requireMember`,
  `/api/me/switch-account`, the member `/sync` gate and member R2 signing), `/api/me/memberships`, and the Link machine
  list (`link-pairing.js accountLicenses`). Refusal: `403 email_not_verified` with a plain message. The row is kept.
- **Claim, unverified: refused.** No existing license is ever handed over by email (`86d79c2`); the member path of
  desktop-activate already required a verified email.
- **Deliberately not done:** plan §3.1 proposed "sign-up returns no token / login refused until confirmed". Your ruling
  lets an unverified person start a trial, so sign-in stays open and only claim/join is gated.
- **Side effect:** links sent before this deploy were stored as plain text with no expiry; they stop working. A password
  reset (or the resend route) confirms instead.
- **Behaviour to know:** an invited person who activates a desktop BEFORE confirming gets a trial license of their own,
  and after confirming their desktop stays on that own license (own license comes first). Unchanged rule from `86d79c2`.
- Tests: `src/lib/email-verify.test.js` (10), `link-pairing.test.js` (+1), and the real-route sign-up → link → verified
  test in `test/server-boots.test.js`.

**Before deploy 1, who loses member access — checked (Jeff ran it, 2026-10-29; read-only transaction,
`railway run --service Postgres`, host ballast.proxy.rlwy.net):**
```
users: { users: 17, verified: 6 }
active memberships that would stop counting: 0
all active memberships: 0
```
**Nobody loses access:** production has no active memberships at all. The 11 unverified users keep everything they have
today; only their old confirmation links (if any are still unused) stop working. Licenses 21 and 23: nothing affected.

**Web page follow-ups (ether-signup, not changed):** `Verify.tsx` shows "invalid or has already been used" for an
expired link too; there is no "send a new link" button (the resend route has no door yet).

## Commit 2 — `5a04e7e` step a: the server loads in a test (deploy 2, on its own)

- `start()` runs only when `require.main === module` (`node src/index.js`, the Procfile). Checked with a dead
  `DATABASE_URL`, old vs new: same path, `[Ether] DB init failed: connect ECONNREFUSED`, exit 1.
- Pool from `src/lib/server-pool.js` (same `new Pool(...)`; a test hands in pg-mem). `index.js` exports
  `{ app, pool, initDB, resend }`. The daily prune timer is `unref()`'d (the listener keeps the server alive).
- `test/server-harness.js` boots the real app + real boot schema on pg-mem. pg-mem gaps, stood in for in the test only:
  `random()`, `md5()`, `clock_timestamp()` registered; the positions seed's `VALUES … AS v(cols)` run row by row from
  the statement's own rows. A restart (second `initDB`) can't be tested on pg-mem (it refuses `CREATE TABLE IF NOT
  EXISTS` on an existing table).
- `npm test` = `node --test`: **203/203**.

## Next (after deploy 2 is live and answering normally)

b. route inventory (191 routes: 166+ in `index.js`, routers in `routes/` and `lib/`) as a ratchet test; c. stranger tests
by area, one commit each; d. GitHub Action on push to `main` + Railway "wait for CI".
