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
