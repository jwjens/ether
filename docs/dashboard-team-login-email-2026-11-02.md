# Dashboard team sign-in: account email + username + PIN (2026-11-02)

**Jeff's request:** replace the license-key mode with account email + username + PIN, and remove "Set up admin". Show it before deploying.

**Status:**
- Built, and screenshots taken.
- **Not deployed and not committed.** One security finding needs Jeff's decision (§3).
- No license was changed.

## 1. What was built

**Dashboard** (C:\ether-dashboard-deploy, branch `feat/team-login-email` from origin/main 7b18d83):
- Two ways in:
  - **Owner:** email + password (unchanged).
  - **Team:** Account email + Username + PIN.
- Under the team form: "Use the name and PIN you sign in to Ether with."
- The License key field and "First time here? Set up your admin account" are gone.
- Removed the error messages for the key and set-up modes.
- The owner's "isn't linked to a license" now reads "This account doesn't have a plan yet. Choose one at signup.ether-cast.com."
- The browser no longer keeps the license key (`ether_cc_license` is removed on the next team sign-in). It remembers only the account email, to prefill the form.
- Test: `test/teamLogin.test.ts`. npm test 21/21; build OK.
- tsc shows 1 error, in ListenersPanel.tsx (topojson types). It is already on main and was not touched.

**Server** (C:\ether-backend-deploy, branch `feat/team-login-email`):
- `POST /api/auth/login` accepts `email`. The account with that email gives its license, which must be active and not expired — the same test a key gets. Lifetime licenses never expire.
- The lockout is the same as before.
- Any wrong part answers `invalid_credentials`, so an email is never confirmed or denied.
- `license_key` is still accepted from an older dashboard page.
- The server's set-up-admin route is left in place, unused by the dashboard.
- Test: `test/team-login-email.test.js`, 5/5.

## 2. Screenshots

The dashboard ran locally against the new server code on a test database.

Shown:
- the owner screen;
- the team screen (desktop and phone);
- a wrong PIN;
- a team member signed in (header "Steve · USER").

The signed-in page's station list did not load locally: the test database lacks a column production has (`source_machine_id`). Owner sessions use the same query, and this change does not touch it. **A team member's station list after sign-in is UNVERIFIED until a live sign-in.**

## 3. Finding — the full suite fails one access test (the stranger test)

The stranger test checks that account B can never read or change account A's data. It sends A's identifiers with B's credentials.

- With the email mode, a wrong PIN sent with **only A's email** counts against A's user (`account_users.failed_attempts`).
- After 5 tries, that user is locked out for 15 minutes.

| | Needed to try a PIN |
|---|---|
| Before | The license key (secret) |
| Now | The account email (not secret) |

What this means:
- Anyone who knows a station's account email can lock its jocks out of the dashboard for 15 minutes at a time, repeatedly.
- Guessing a 4-digit PIN through the lockout is slow. The worst case is about 3 weeks per user at 5 tries per 15 minutes, before the per-IP limit.
- **The lockout is the practical harm.**

Options for Jeff:
- **A. Ship as built.** Accept that someone who knows the email can trigger the lockout. The stranger test is updated to record that a wrong PIN by email is expected to count.
- **B. Ship as built, but wrong PINs by email never lock the user.** Guessing is slowed per device/IP instead (the sign-in limiter, tightened for this route). A jock can't be locked out by a stranger. Guessing stays slow, but less tightly capped than today's per-user lockout.
- **C. A team link instead of an email** (the way the Park page works). The owner shares the dashboard team link; the link names the account; name + PIN sign in. Nothing public names the account. This means building the link and a place for the owner to copy it.

Nothing is committed on either branch until Jeff picks.
