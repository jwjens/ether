# A license issued to an email — build report (2026-11-01)

> **DEPLOYED 2026-11-02**:
> - backend `a5e4c32` (+ app version) → Railway SUCCESS;
> - platform `75eee3e` → live bundle has "Issue a license", the preview call and "Ether version";
> - website → Worker version 0e56469b, preview URLs back off; `/account` lands on signup.ether-cast.com/login.
>
> Jeff's fixes, before the deploy:
> - atom logo in every email;
> - no repeated "license is ready" line;
> - the new footer;
> - "unlocks the full Network plan" (Ether `eb18481`, next release build).
>
> Read-only check after the deploy (`scripts/prod-after-deploy-2026-11-02-readonly.js`):
> - app_version is present and filling;
> - licenses 21–24 and 28 are unchanged;
> - 16 licenses in total.

Jeff's ruling: the email is the license. Claim-with-key is dropped. Customers never see or type a key.

**Status:**
- Built and tested.
- Committed locally on three branches.
- **Nothing is deployed or pushed.**
- No license was changed.
- Production was only read, once, with a read-only script (§5).

## 1. The rules (Jeff's answers 1–6)

Issuing in the platform (`POST /api/platform/licenses`; the older `/admin/issue` follows the same rules):

| The email… | What Issue does |
|---|---|
| has no account | Creates a new license. It links when they create an account with this email and confirm it. |
| has an account, email confirmed, no license | Creates a new license and links it now. |
| has an account, email not confirmed, no license | Creates a new license. It links when they confirm. |
| account's license is a trial, Local or platform-made | **That same license** takes the chosen plan with no end date. No second license is made. Same key, same stations, backups and data. |
| account's license is lifetime / Enterprise | **Refused:** "This account has a lifetime license; it isn't changed." |
| account has a paid Stripe subscription (including one with a failed payment) | **Refused:** "This account has a paid subscription; change it in Stripe first." |

The automatic link runs in three places:
- on email confirm;
- at desktop sign-in;
- when the account page loads.

How it chooses:
- It never links an unconfirmed email (the 10/28 rule).
- It takes the newest license issued to that email that is:
  - active;
  - not a trial;
  - not expired;
  - not held by any other account.
- If they signed in to Ether before confirming (so they already have a trial with stations):
  - their trial takes the issued plan, with no end date, and the stations stay;
  - the issued duplicate is switched off (decision 5).
- An account that already has a paid or lifetime license of its own is left alone.

## 2. Emails (no key anywhere)

- **New license:** subject "Your Ether license is ready".
  - "Your Ether license is ready. Create your account at signup.ether-technologies.com with this email address, confirm it, then install Ether and sign in."
  - Mac and Windows download buttons, plus a "Create your account" button.
- **Existing account:** subject "Your Ether account is now on {plan}".
  - "Your Ether account is now on the {plan} plan. Open Ether and sign in with this email address."
  - Downloads, plus an "Open your account" button.
- **Thank-you email, buyer with no account** (old payment link): the same "Create your account at … confirm it, then install Ether and sign in." steps. The key has been removed.

## 3. The platform: "Issue a license"

- The form formerly called "Generate a key" is now **Issue a license**.
- As soon as an email and tier are chosen, one line says what Issue will do, from the backend's own decision (`POST /api/platform/licenses/preview`):
  - "This changes license 1 (trial@example.test) from Live 128 to Live 320. Its trial end date is removed. Stations and data stay where they are." (orange)
  - "Creates a new Network license for … No account yet — it links when they create one with this email and confirm it."
  - "Creates a Live 128 license and links it to …'s account now."
  - "Creates a Live 128 license. … has an account but hasn't confirmed the email yet — it links when they confirm."
  - A refusal in red. Issue is disabled.
- After Issue, it says what was done and whether the email went.
- No key is shown.

## 4. Customer-facing "license key" wording removed

**Desktop** (ships in the next release build):
- Subscription panel: the "Enter License Key" button and form are gone. "Sign in with your Ether account."
- Menu tooltip: "See the plans and prices, or sign in".
- Manage Devices: "This computer isn't signed in to an Ether account. Devices appear here after you sign in (Subscription)."
- Cloud Backup: the editable License Key field now reads "Uses this computer's sign-in". The key still comes from the sign-in, unseen.
- Help: "The account sign-in" in place of "License key".
- The old onboarding key screens stay. They are unreachable.

**Website** (local, not deployed; backups in `C:\openair-website\backups\`):
- `account.html` (email + license key form, "Ether Global Technologies") is now a redirect to `https://signup.ether-cast.com/login`.
- The two links on the home page are now `https://signup.ether-cast.com/login`: "Sign in" in the top bar and "Account" in the footer.

**Not changed yet:**
- The backend `/validate` error text ("License key not found or does not match this email.") is used only by old builds' key screen. It is left as is.
- The web dashboard's license-key login (§5).

## 5. The dashboard's license-key login — who uses it (Jeff asked; not removed)

`app.ether-cast.com` sign-in has three modes:
- **Owner:** email + password.
- **Team member:** license key + username + PIN.
- **Set up admin:** license key + new username + PIN. This makes the first dashboard admin.

Production, read-only (`scripts/prod-team-login-usage-readonly.js`, run 2026-11-01):
- 11 accounts have username + PIN users.
- Every one of them was mirrored up from Ether → Settings → Users & Security. **None were made on the dashboard**, so "Set up admin" has never been used.
- License 24 (jensj@opportunityvillage.org) has 6 users (admin + user roles).
- Each of the others has 1 admin. Those accounts:
  - 21 netgeak@gmail.com
  - 22 djdeniro@gmail.com
  - 23 cristianmalliani@gmail.com
  - 26 joostpeters@gmail.com
  - 28 maganaent@gmail.com
  - 29 cadenamaster@hotmail.com
  - 30 berrios0402@gmail.com
  - 31 guttobarros@gmail.com
  - 33 djneonbeat04@gmail.com
  - 35 justin1808hoefler@gmail.com
- **The server does not record when a username + PIN user signs in to the dashboard**, so it can't say whether anyone actually uses team mode. UNVERIFIED.

Who it's for:
- The jocks and staff created in Ether's Users & Security: the same people and PINs as the console.
- **The Park page does not use the key.** Park logins are tied to the station's own Park link plus name + PIN (`src/lib/park-auth.js`; 33 Park sessions exist).

What could replace the key:
- **Recommended:** account email + username + PIN. The owner's email names the account, exactly as "the email is the license" does everywhere else, and the PIN users keep their existing name and PIN.
- **Alternative:** a station link like Park's (`app.ether-cast.com/s/<station>` → name + PIN). There is nothing to type to name the account, but each link is per station.
- In both cases "Set up admin" can go: it is unused, and admins already come from Ether.

## 6. Tests

- **Backend** `feat/issue-to-email` (C:\ether-backend-deploy, `4a0b621`, from origin/main 22d245a):
  - `src/lib/issued-license.test.js`: 14 tests, every issue case and every link rule, on real SQL. Each checks that no license field moves beyond what the case allows.
  - `test/issue-to-email.test.js`: 5 tests through the real server:
    - preview + Issue for each case;
    - emails with no key;
    - link via the real confirm link;
    - link at desktop sign-in.
  - `src/lib/purchase-email.test.js`.
  - Full suite 562/562.
- **Platform** `feat/issue-to-email` (C:\ether-admin, `cf5124b`): `src/lib/issuePreview.test.ts`. tsc 0, vitest 7/7.
- **Desktop** (C:\openair billing-new-prices, `2d9b7fa`): `src/lib/noLicenseKeyWording.test.ts`. Full vitest 1478/1478, tsc 0.
- **Screenshots:**
  - Platform: the real backend on a local test database, six cases.
  - Both emails: desktop and phone width.
  - The desktop Subscription panel: rendered on its own with a stub. Its "Network (Enterprise)" badge is the stub's, not real data.
  - The website's links and the redirect: checked in a hidden window. The redirect lands on `https://signup.ether-cast.com/login`.

## 7. Deploy order (on Jeff's OK)

1. Backend (push `feat/issue-to-email` to main → Railway).
2. Platform site.
3. Website (`wrangler deploy --name ether-website --assets dist`).

The desktop changes go in the next release build.

Noticed in passing, not changed: the desktop sign-in form says "During your free trial this unlocks the full Unlimited plan" — the plan is now called Network.
