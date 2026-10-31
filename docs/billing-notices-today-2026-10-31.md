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
