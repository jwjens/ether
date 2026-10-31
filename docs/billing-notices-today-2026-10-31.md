# Billing notices — what exists today (2026-10-31)

Jeff asked: what each billing notice shows, where (Ether, dashboard, email), and what's missing. Lapse rule (binding,
`docs/paywall-entitlements-plan.md`): never stop audio or playout, never a blocking screen; the only allowed effects are
a banner, no new updates, and cloud features stopping after grace. Read-only audit of C:\openair, C:\ether-backend,
C:\ether-dashboard, C:\ether-signup, C:\ether-admin; file:line receipts below.

## In plain words

| Notice | Ether (desktop) | Dashboard (app.ether-cast.com) | Account site (signup) | Email |
|---|---|---|---|---|
| Trial ending soon | **nothing** | **nothing** | "Trial · N days remaining · ends <date>" | **none** |
| Trial ended — add a card | **a full-screen overlay** "Your free trial has ended… Continue on Solo (Free)" — breaks the no-blocking rule, offers a plan that no longer exists, and quietly writes the plan down to free. At sign-in: "Your free trial has ended. Your stations and library are safe — pick a plan" | **nothing** | "Your trial has ended — subscribe below" + plan cards (only Station and Pro; no Local $9) | **none** |
| Payment failed / card declined | **nothing** | the Billing card shows Stripe's raw word "past_due" in amber, unexplained | **nothing** | **none** (the server only logs it; nothing is saved) |
| Card expired / expiring | **nothing** | **nothing** | **nothing** | **none** — no card-expiry handling anywhere |
| Grace / lapsed | **nothing** (the server computes grace and lapsed and sends them to Ether, but Ether never reads them) | **nothing** | **nothing** | **none** |

Audio: nothing billing-related stops audio today. The one rule break is the desktop's trial-ended overlay.

## Where a customer can fix it today
- Dashboard → **Manage billing** opens the Stripe Customer Portal (`POST /api/account/billing/portal`) — only for a
  license that already has a Stripe subscription; a trial user has none. **Bug:** the portal's return address allowlist
  lacks `app.ether-cast.com`, so customers coming from there are sent back to ether-technologies.com.
- Account site → Checkout (`POST /api/user/checkout`) — Station and Pro only.
- Desktop → Subscription panel opens fixed `buy.stripe.com` links; no portal link.

## Server model
- `licenses`: `plan`, `active`, `expires_at` (trial end; NULL = paid), `stripe_customer_id`, `stripe_subscription_id`.
  `users.trial_ends_at` = signup + 15 days. No column for payment status, grace or card expiry.
- Grace/lapsed are computed (`entitlements.js:71-85`): grace = `expires_at` + 7 days (`plans.json` `past_due_days`).
- Stripe events handled: checkout completed, payment succeeded, subscription updated/deleted; **payment failed = log
  only**. No card events.
- Email: Resend is set up (`RESEND_API_KEY`, `FROM_EMAIL`) and sends license key, verify, reset, invite — **no billing
  email and no daily job**.

## Stripe test mode
- Production (Railway `ether-backend`) has **live** keys only (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` both live).
  There is no test key and no staging environment. Test accounts must therefore NOT go on production.
- Plan: a local test server on this computer — the backend's own test harness runs the real server (real routes, real
  schema) on an in-memory database — with Stripe **test** keys, apart from production and every real customer.

## Receipts (from the audit)
Signup AccountView.tsx:53,59,55,61,95-110 · backend entitlement.js:29-31, entitlements.js:49,71-85, license-status.js:35-70,
stripe-webhook.js:46-50,64-173, index.js:2565-2566,2639-2660,3958-3997,4326-4328,4380,5321-5324, plans.json:5,48,50-55 ·
desktop TrialGate.tsx:20-80 (mounted App.tsx ~2810), OnboardingFlow.tsx:441-446, licenseGuard.ts:14,128,164,
SubscriptionPanel.tsx:13-16,84-98 · dashboard AccountInfo.tsx:176-183, api.ts:303,306 · admin LicensesView.tsx:7,21.

## Built (2026-10-31) and the test accounts

Built: backend b5a7106, 7c65939, b490d1c, 0ccd0e5, a658e4a · dashboard 886211b · account site 142be51 · desktop 2ab3c80
(the banner replaces the blocking trial overlay). Billing emails are OFF until `BILLING_EMAILS=1`. Nothing deployed.
Screenshots of every notice on every surface: https://claude.ai/artifact/MQwvcRC1jUeYSxsRRYCZTf

**Test accounts** — only on the LOCAL test server (`cd C:\ether-backend; node scripts/billing-test-server.js`, in-memory,
http://127.0.0.1:8787). They exist only while it runs and never touch production; password `ether-test-1` for all.
Not deleted — waiting for Jeff.

| Account | Email | License key | Notice |
|---|---|---|---|
| TEST trial ending (2 days) | test+trial-ending@ether-test.invalid | ETH-STN-TEST-E01F55AF | trial_ending |
| TEST trial ended | test+trial-ended@ether-test.invalid | ETH-STN-TEST-2C71CCE9 | trial_ended |
| TEST card declined | test+card-declined@ether-test.invalid | ETH-STN-TEST-945D17F2 | payment_failed |
| TEST card expired | test+card-expired@ether-test.invalid | ETH-STN-TEST-685B6DD5 | card_expired |
| TEST in grace | test+in-grace@ether-test.invalid | ETH-STN-TEST-56497EED | grace |
| TEST lapsed | test+lapsed@ether-test.invalid | ETH-STN-TEST-DFB5A7D1 | lapsed |
| TEST paid OK | test+paid-ok@ether-test.invalid | ETH-STN-TEST-F7730E37 | none |

(The keys are regenerated each time the server starts.) Stripe test mode is not set up; with a test key in
`C:\ether-backend\.env.billing-test` (`STRIPE_SECRET_KEY=sk_test_…`), the declined / grace / paid accounts also get real
Stripe test customers. The server refuses any live key.
