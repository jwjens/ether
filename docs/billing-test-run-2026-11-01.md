# Local billing test against Stripe TEST mode — run 1 (2026-11-01)

Jeff's task: the full billing flow on a local backend with Stripe test mode (steps 1–4). This records where run 1
stopped and what was proven.

## Done
- Step 1: `C:\ether-backend\.env.stripe-test`, gitignored before anything was written (`10b4875` on branch
  `billing-new-prices`). The key starts with `sk_test_`; Stripe answered `balance.livemode = false` before any create.
- Step 2: server change (ether-backend `ed759cb`), account site (ether-signup `ee29f7e`), desktop dev override (openair
  `1268c98`). 6 test products + 10 test prices created by `scripts/stripe-test-setup.js`; ids in `.env.stripe-test`.
  Local server = the real server on a new in-memory Postgres (pg-mem); `stripe listen` forwarding to `/webhook/stripe`.
- Found and fixed in the test harness (test only, not production): pg-mem refuses a NULL `licenses.license_key` under its
  UNIQUE index after `DROP NOT NULL`; production Postgres allows it. Added to `PG_MEM_GAPS` in `test/server-harness.js`
  (receipt: run-local.log `Cannot add a null record in index licenses_license_key_key` on the first purchase). 499/499.

## Step 3a — all 8 PASS (receipts: `C:\ether-backend\billing-test\results.json`, screens 001–016)
| Path | Account | License | Limits |
|---|---|---|---|
| Local monthly | test1@ether.test | 1, local, active, no expires_at | no cloud |
| Local yearly | test2@ether.test | 2, local | no cloud |
| Live 128 monthly | test3@ether.test | 3, station | 128 kbps, 50/stream, 100 GB |
| Live 128 yearly | test4@ether.test | 4, station | same |
| Live 320 monthly | test5@ether.test | 5, pro | 320 kbps, 150/stream, 250 GB, priority |
| Live 320 yearly | test6@ether.test | 6, pro | same |
| Network monthly | test7@ether.test | 7, unlimited | 5 stations, 128 kbps, pool 250, 500 GB, priority |
| Network yearly | test8@ether.test | 8, unlimited | same |
Each Stripe subscription has the right amount and interval (checked from Stripe).

## Where it stopped
- 3b's first try hit the server's sign-in limit (40 per 15 min per address, `429 too_many_attempts`) — the limit working,
  not a bug; my drivers signed in ~5 times per account. Drivers now reuse each account's token (`billing-test/tokens.json`).
- Then Claude Code stopped every background job for low memory (about 1.4 GB free of 15.7; McAfee ~2.5 GB, Chrome ~2.7
  GB): the local server and `stripe listen`, the account-site dev server task, and the waiting 3b run. Not restarted.
- **The in-memory database is gone**, so licenses 1–8 no longer exist locally. The Stripe TEST customers and
  subscriptions for test1–test8 still exist in Stripe (not deleted). A restart is a fresh database; 3a would be re-run.

## Known before 3c/3d (from the code; UNVERIFIED until run)
- A paid license has no `expires_at`, so a failed Stripe renewal never reaches the "grace" or "lapsed" notice
  (`billing-notice.js` takes those from `expires_at`). It shows "payment failed" while Stripe retries; when Stripe cancels,
  the webhook sets `active = false`, the notice becomes none, and `/account/connect` refuses the key. Check: step 3d.
- Stripe will not store an expired card, so the "card expired" notice cannot be produced with card 0069; 0069 and 0002
  are declined at Checkout. Check: step 3c.
- The desktop run needs an isolated profile, sign-in, a station and audio, plus the most memory of any step.

---

# Run 2 (2026-11-01, after Jeff's fix-first order)

## Fix first — paid licenses go into grace, then lapse (Jeff's words: "when a paid subscription's payment fails or
## Stripe cancels it, the license must go into grace using the plan's grace period, show the grace notices, and then
## lapse. It must never refuse the license key or block the app, and audio and playout must never stop.")
- ether-backend `9c9699c` (branch `billing-new-prices`, local only): new column `licenses.grace_until`, set only by the
  webhook = first failed payment (or the subscription ending: canceled / unpaid / deleted) + `grace.past_due_days` (7);
  kept if already set; cleared with `payment_failed_at` when a payment succeeds or the subscription is active again.
  Stripe never sets `active = false` any more (it stays the operator's switch), so the key always signs in.
  entitlements: before `grace_until` = status grace at the license's own plan (features, limits, add-ons); after = lapsed
  (no cloud), plan kept. Notices: "Your payment didn't go through — cloud features included until …" (Update card) or
  "Your plan ended — … until …" (Choose a plan), then "Your plan has lapsed"; each says the station keeps playing.
  Lifetime / platform-made licenses ignore `grace_until`. Tests 512/512, including a server test: a paid license in
  grace and after lapse gets 200 from `/account/connect` with the grace / lapsed notice.
- ether-signup `3dd0d92`: an ended subscription reads "Subscription ended · <plan>" and the plans are offered again
  (before, the page said Subscribed and hid them — a dead end after cancel). tsc 0, 14/14.
- Help: `docs/help-billing-notices.md` updated (the two grace notices, the key never refused).
- Test tooling committed: ether-backend `1ede98a`.

## Run 2 results so far (receipts: `C:\ether-backend\billing-test\results.json`, screens 001–019; run 1 kept in
## `billing-test\run1\`)
- 3a: 8/8 PASS again (test1–test8@ether.test on a fresh in-memory database).
- 3b: PASS. test7 (Network monthly): +1 extra station → stations 5 → 6, pool 250 → 300; +1 Listener add-on → pool 350.
  Stripe items $79 + $15 + $10, each quantity 1. The license columns were written by the webhook.

## Stopped before the desktop part — free memory under 3 GB (Jeff's rule)
- Check before starting the desktop: 2.82 GB free (with the desktop's own vite started). Stopped that vite → 3.19 GB.
  The desktop adds the vite, Electron and the audio engine, so it was not started. Biggest users: McAfee (mcshield
  ~1.5 GB, mfeatp ~0.35 GB), Chrome, Claude.
- Still running: local server + `stripe listen` (the in-memory database holds 3a/3b), the account-site vite (5174).
- An openair vite has been running on port 1420 since 2026-10-30 (not started by this run, left alone). It has no
  local-backend setting, so the desktop test cannot use it without calling production. Prepared instead (uncommitted,
  dev builds only, syntax-checked, runtime UNVERIFIED): `electron/main.js` — `ETHER_VITE_DEV_PORT` (the dev renderer's
  port, default 1420) and `ETHER_ISOLATED_DEV=1` + `--user-data-dir` (the release check's isolation — own data folder,
  own engine pipe, no :3400 — without the smoke run quitting after 30 s). `billing-test/desktop.js` launches it with
  its own profile and CDP on 127.0.0.1:9333.

## The plan for 3c–3e once memory allows
- 3c: cards 0002 and 0069 are refused at Stripe Checkout and in the card-update page (Stripe will not store either), so
  they never reach a license; screenshots of the refusals. The in-app "update your card" popup is produced by 0341 in 3d.
- 3d: a test-clock customer pays the first invoice with 4242 (0341 can be attached but fails every charge, so it
  cannot pay at Checkout), then 0341 becomes the card on file; the clock advances past renewal → grace → lapsed; then
  4242 is put back and the open invoice paid → active. The local server's clock is moved with the test clock (a
  test-only control), because the server reads the real time and Stripe's clock is simulated. Audio levels are logged
  every second the whole time.
- Card expiring: a test-clock customer with a card expiring at the end of the month; advance into the last 30 days →
  "card expires soon", then past the end → "card expired" (or the renewal failing on it).
- 3e: cancel a subscription → "Your plan ended — … until …" (grace) → lapsed; the key still signs in.

---

# Run 2 finished: 3c, 3d, 3e and the report (2026-11-01 evening)

Report: `C:\ether-backend\billing-test\report.html` (PASS/FAIL list, then 48 screens at real size with captions).
Receipts: `billing-test\results.json`, `billing-test\audio-levels.jsonl`, `billing-test\audio-summary.json`, server log
`billing-test\run-local-3.log`. **19 PASS, 3 FAIL of 22 paths.**

Closed before the run (all started in earlier sessions): vite for ether-admin (port 5797, Oct 29), openair (1420,
Oct 30), ether-dashboard (5173, Oct 31). No old dev Ether was running. Deleted `C:\openair\ether-backend.env.stripe-test`.

## PASS
- 3a 8/8, 3b, 3c (0002 refused "Your credit card was declined…", 0069 refused "Your card is expired…"; no license).
- 3d on a Stripe test clock (test10@ether.test, license 1): card expiring notice (4242 exp 12/26, clock Dec 3); renewal
  charged to 0341 declined → grace ("Your payment didn't go through — cloud features included until November 9");
  grace over → lapsed; 4242 put back and the open $25 invoice paid → active, grace and failure cleared.
- 3e: cancel at period end (active until Feb 2) → Stripe ends it → grace ("Your plan ended … Choose a plan"; account page
  "Subscription ended · Live 128" with the plans) → lapsed. The license was never switched off; the key signed in at
  every stage.
- Audio: 1,483 one-second samples over 25.8 min, deck A "playing" in every one, the engine's output frame counter
  advancing every second (≈44,300 frames/s end to end), 0 device errors, unbroken through 3 window reloads.

## FAIL (the operator's view first; diagnosis after)
1. **Card-expiring popup did not appear after signing in.** After a fresh sign-in the app checked the account once and
   never again until reopened (server log: one /account/connect from the app in ~30 min). Diagnosis (code, App.tsx
   ~1153): the 20-second account check starts only if the license key is already in `apiKeyRef` when the effect runs; on
   a fresh sign-in the key arrives later and a ref is not a dependency, so the check never starts. Runtime receipt: the
   key and the account session were present in the app; after a window reload the check ran every 20 s and the popup
   showed. Also stops cloud station sync in that session (same timer).
2. **The grace popup did not appear by itself after the payment failed.** An earlier popup had closed that day, and the
   popup shows at most once a day after the first (billingNotice.ts SHOW_EVERY_MS). My clock change closed the earlier
   popup; without it, a user who clicks Later on "card expires soon" and then has a payment fail the same day waits up
   to a day for the payment popup. Same for "Your plan ended" in 3e.
3. **One purchase made two licenses.** test10's Live 128 purchase: license 1 (linked) and license 2 (not linked, its
   key emailed). checkout.session.completed and invoice.payment_succeeded arrived together; both webhook branches found
   no license for the subscription and each inserted one. Production has the same race (no unique rule on
   stripe_subscription_id). Not fixed: needs a production schema decision.

## Test-tool faults (fixed; not product faults)
- The pg-mem placeholder key made desktop-activate return the placeholder → connect 401. Harness now rebuilds the index
  as Postgres's UNIQUE (NULLs allowed). ether-backend `5742f60`, test `test/server-harness.test.js`.
- The server-clock control moved the time the webhook signature check uses → 7 webhooks refused (400 "Timestamp
  outside the tolerance zone"). Replayed exactly as Stripe sent them (fetched from Stripe test mode, re-signed with the
  test secret, local only). The driver now keeps the server on real time while Stripe's clock moves.
- Stripe stamps test-clock events with the real time, so grace dates are counted from the real failure (Nov 2 → 9)
  while Stripe's clock read January. In production the clocks are the same.

## Left as is
- Still running (needed — the test accounts live only in its in-memory database): local server + `stripe listen`
  (8787/8788), account site vite (5174). Stopping them deletes the local test accounts; Stripe test data stays.
- `electron/main.js` (openair, uncommitted): `ETHER_ISOLATED_DEV=1` + `--user-data-dir` = the release check's
  isolation without quitting after 30 s, dev builds only. Runtime receipt: the run's log shows "[SMOKE] ISOLATED MODE"
  and the database under `billing-test\desktop-profile`. Not committed (no unit test).

---

# The 3 failures fixed and rerun (2026-11-01, late evening)

Report (private link, every screenshot at real size): https://claude.ai/artifact/QwZaF7vPk3UUhFjkywu8Lq — local copy
`C:\ether-backend\billing-test\report.html`. **Rerun: 6 PASS / 0 FAIL.** Nothing pushed or deployed.

## Fixes (local commits, with tests)
1. **Account check after a fresh sign-in** — desktop `0b964bc` + `4eccf44`. Sign-in announces the key it stored
   (`announceLicenseKey`); App keeps the key as state and the 20-second check is keyed to it (`src/lib/accountPoll.ts`).
   **The rerun found a crash in the first version** (`0b964bc`): "Ether — startup error: Illegal invocation" right after
   sign-in — `window.setInterval` called as a method of a plain object; Node (the unit tests) allows it, browsers do not.
   Fixed in `4eccf44` with a browser-strict test that fails on `0b964bc`.
2. **Popup timing** — desktop `854b1a9`. Once a day only for the same notice (same kind, period and way out); a different
   notice shows at once. Help updated.
3. **One license per subscription** — backend `57b00ab`. Unique partial index + `ON CONFLICT DO NOTHING` in both webhook
   branches; made at boot, guarded (never fails boot, never changes a license). Production change and deploy steps:
   `docs/one-license-per-subscription-2026-11-01.md`. **Production read-only check: 0 licenses with a Stripe
   subscription, 0 duplicates; nothing changed** (backend `f6580f6`).
4. **Test-profile setting** — desktop `9662b4c` (`electron/lib/isolated-run.js` + test) and `02ee7f0` (the existing
   smoke-isolation test updated; `9662b4c` had broken it — the full suite was not run before that commit).
   Desktop vitest 1467/1467, tsc 0; backend 521/521.

## Rerun (second local server 8789/8790, account site 5175; the first server and its accounts untouched)
- Rerun 1 PASS: test13 signed in fresh, never reopened; the app checked every 20 s (3 checks in 62 s) and the
  card-expiring popup appeared by itself.
- Rerun 2 PASS: card-expiring closed with Later → declined renewal → payment popup at once; → lapsed popup at once; paid
  again, cancelled, period ended → "Your plan ended" popup at once. No reopen anywhere.
- Rerun 3 PASS: the exact pair of Stripe events that made two licenses, delivered at the same instant → one license,
  account linked, no key email (log: "already has license 1 (made at the same moment)"); a new purchase → one license.
- Audio: 671 one-second samples over 11.2 min, deck A playing in all, no stalls, no device errors.
- Test-tool slips: a card change made while the server clock was moved (3 webhooks refused, replayed); the replayed
  subscription update was stale and briefly cleared the grace until the later events were re-delivered in order.
- Finding, not fixed (not asked): Stripe does not promise event order; a late "subscription active" after a failed
  payment would clear the grace in production the same way.
- Both `stripe listen` sessions get every event, so the first server also recorded the rerun's 3 purchases as unlinked
  licenses (rows 3–5 there); its user test10 and licenses 1–2 are unchanged.

## Still running (until Jeff has looked)
First server 8787/8788 + its `stripe listen` + account site 5174; rerun server 8789/8790 + its `stripe listen` + account
site 5175; desktop page server 1420; the rerun EtherCast window (test13, signed in, tone stopped).
