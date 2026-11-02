# New pricing — built (2026-11-01)

Jeff's answers (2026-11-01): Network = 128 kbps per station, 250 listeners shared across the account's stations, each
extra $15 station adds 50 listeners to the pool. License 21 (netgeak@gmail.com) keeps showing "Free (old key)"; the
license is not changed. Before-build record: `docs/pricing-2026-10-31-before-build.md`.

Nothing is deployed. Stripe is untouched. No license row was written.

## What changed

| Where | Commit | What |
|---|---|---|
| Backend `config/plans.json` v2 | ether-backend `6e5f0f3` | Local $20 / $200 yr; Live 128 $25 (128 kbps, 50); Live 320 $49 (320 kbps, 150, priority support); Network $79 (5 stations, 128 kbps, pool 250, +$15 per extra station adding 50, priority support kept from the old $79 plan); annual = 10 months, checked at load; 3+ station discount removed. Plan keys unchanged (`station`, `pro`, `unlimited`). |
| Backend lifetime rule | `6e5f0f3` | Lifetime and platform-made licenses keep the limits they had (320 kbps, 250 pool, unlimited streams, 500 GB) and read "Network (Lifetime)"; the new 128 kbps Network would otherwise have lowered them. |
| Backend license email | `6e5f0f3` | Name and price from the catalog (it said "$79" for the $25 plan). |
| Backend account-site status | `fd4e871` | **Bug found while taking the screenshots:** a trial user (trial key with a future `expires_at`, no Stripe subscription) read as "Subscribed · Station", so the account page hid the plans. Per the 10-29 list that is licenses 29–37 (trials ending 11-02 … 11-11). Now reads as a trial with days left. |
| Account site | ether-signup `414b83c`, `924e193` | Plan cards read `/public/plans`; names from the catalog; two-by-two layout. |
| Dashboard | ether-dashboard `7cfe799` | Plan names from the catalog. |
| Platform admin | ether-admin `966e3d1` | Tier names Live 128 / Live 320 / Network (same stored keys). |
| Desktop | openair `b742856` | Plans & Subscription reads the catalog; old $0/$19/$79/$299/$899 cards, Product Hunt promo and Stripe payment links removed; Choose opens the account site; ☰ → Plans & Subscription door; help `docs/help-plans-and-pricing.md`; `help-trial-ended.md` updated. |
| Website | `C:\openair-website\dist\index.html` (not a git repo; the live site matches this file) | Pricing section rewritten; hero line "15-day free trial · No credit card". Copy before the change: scratchpad `website-index-before.html`. |

Tests: backend 478/478, desktop 1436/1436 (`npx tsc --noEmit` zero errors), account site 11/11, dashboard 19/19, admin 3/3.

Screenshots (local copies pointed at the local test server's new catalog): https://claude.ai/artifact/Ht6UDHHd7ji6ZXzNa5EoDc

## Deploy order (when Jeff says go)

1. **Backend first.** Every other surface reads `/public/plans`; until the backend is deployed they show the OLD
   catalog (Local $9, Station / Pro / Unlimited). The website's script would replace its new numbers with the old ones.
2. Then account site, dashboard, platform admin, website. Desktop with the next release.

## Not changed — for Jeff

- **Stripe.** Checkout still uses the old `PRICE_STATION` / `PRICE_PRO` prices, whatever they are in Stripe. Until new
  Stripe prices exist, Local and Network show "can't be bought online yet — email support" on the account site.
- **Desktop plan gates.** `usePlan.tsx` ranks `station` (Live 128) above `pro` (Live 320), so a Live 320 customer is
  refused desktop features gated at "station" level. Names only were changed; the ranks need Jeff's ruling.
- **Bitrate and listener limits are not enforced anywhere** (grep: `max_bitrate_kbps` is only reported). Display only.
- **Station count for Network.** The server's add-station limit for `unlimited` is still "no limit" (-1); counting
  paid extra stations needs Stripe quantities. Item 9 (Duplicate) is blocked on the same cap.
- **Website copy outside pricing**, left as is: the top banner and Beta section offer "free Station tier forever" and
  "Station tier ($19/mo value)" to founding stations; "Sign up for free" / "Download free" (the download is free).
- **Now Playing promo slides** "Replace RCS Zetta & WideOrbit — for $0 · OPEN SOURCE" and "FREE TO DOWNLOAD" left as
  is (only the two slides with the old $19 / $79 were changed).
- `C:\ether-dashboard` has one old type error (`ListenersPanel.tsx`, topojson types), not from this change.

## Deployed (2026-11-01, Jeff's go)

- Backend: pushed `fd4e871` to `main` (only the pricing and billing commits; the agent's item-10 routes `0395744` stay
  local). Railway serves catalog v2 since 11:13:30. Checks: `/health` 200, `/download/windows` 302, bad license on
  `/account/connect` 401, bad login 401, `/public/plans` = Local 20/200, Live 128 25/250, Live 320 49/490, Network 79/790.
- Account site: `991124a` pushed; live bundle `index-CZgiJxBy.js` = the local build ("Start your 15-day free trial").
- Dashboard: my three commits cherry-picked onto `origin/main` (worktree `C:\ether-dashboard-deploy`, branch
  `deploy/pricing-1101`) and pushed as `7f0ee1b`. The other commits on `feat/announcements-visible` were NOT deployed.
  Live bundle `index-UZCFWvCQ.js` = the build from that worktree.
- Platform: `966e3d1` pushed; live bundle carries Live 128 / Live 320.
- Website: deployed. ether-technologies.com is the **Worker `ether-website`** (static assets only, no code; custom
  domain ether-technologies.com; no zone routes), previously uploaded from the Cloudflare dashboard (last 2026-06-12).
  Live files matched `C:\openair-website\dist` exactly before the deploy except index.html. Deployed with
  `npx wrangler deploy --name ether-website --assets dist --compatibility-date 2026-06-12` from `C:\openair-website`
  (version ae6663f1-4083-4927-9b5c-194f5cb5fa55). Wrangler turned preview URLs on; set back to off via the API. Custom
  domain still attached; live page checked. Rollback: `npx wrangler rollback --name ether-website`.
- Rulings 2 and 4 applied first: website free-forever banner and Beta-section offer replaced with the 15-day trial;
  sign-up label removed (`991124a`); Now Playing slides (`7430ddc`, desktop, ships with the next release).

## Deployed, second round (2026-11-01 night, Jeff's go)

- **Railway variables** (ether-backend, `--skip-deploys`, then picked up by the push): `PRICE_LOCAL_MONTHLY/ANNUAL`,
  `PRICE_STATION_MONTHLY/ANNUAL`, `PRICE_PRO_MONTHLY/ANNUAL`, `PRICE_UNLIMITED_MONTHLY/ANNUAL`,
  `PRICE_NETWORK_EXTRA_STATION_MONTHLY`, `PRICE_LISTENERS_50_MONTHLY` = Jeff's live price ids. `PRICE_STATION` and
  `PRICE_PRO` left in place. Note: the old `PRICE_STATION` is the same price as the new Network monthly; the new mapping
  wins (it reads as Network). No production license has a Stripe subscription, so nothing was on it.
- **Backend** `6b1fc62` on `main` (worktree `C:\ether-backend-deploy`, branch `deploy/billing-1101` = `fd4e871` + the
  billing commits cherry-picked; **Beta/Feedback `0395744` left out**; route inventory 197; 520/520). Live checks: new
  add-ons route 401 (deployed within ~50 s), `/health` 200, `/public/plans` 200 (20/200, 25/250, 49/490, 79/790),
  `/public/stations` 200, `/download/windows` 302, bad license 401, bad login 401, unsigned webhook 400. Read-only
  production check: index `licenses_one_per_stripe_subscription` present (`… WHERE stripe_subscription_id IS NOT NULL`);
  columns grace_until / extra_stations / listener_addons present. No license changed.
- **Account site** `b27a5f0` on `main`; live bundle `index-kCi5Pzbd.js` = the local build ("Start streaming").
  Each plan's buy button → live Stripe Checkout (`cs_live_`), right product/amount/period, 8/8; nothing paid. Check
  accounts on production (sign-ups only, trial, no license): djdeniro+buycheck@, +buycheck2@, +buycheck3@,
  +buycheck4@gmail.com (two lost their session to a test-script slip; passwords were never stored).
- **Dashboard** `7b18d83` on `main` (from `origin/main`, worktree `C:\ether-dashboard-deploy`, branch
  `deploy/start-streaming`); live bundle `index-DPGN1Y0n.js` carries "Start streaming on", "Yes, start streaming",
  "⦿ Start streaming". Also picked onto `feat/announcements-visible` (`d534d86`) so a later deploy keeps it.
- **Desktop fixes**: local commits, for the next release build. No release published.
- Seen in the boot log, not looked into: express-rate-limit warns that X-Forwarded-For is set while `trust proxy` is off.
- Seen on the account site, not changed: any failed account read (even one cancelled by leaving the page) signs the
  visitor out (`App.tsx:26`).

## Follow-ups (2026-11-01, late) — built, NOT deployed (shown to Jeff first)

Backend branch `fix/proxy-and-session` in `C:\ether-backend-deploy` (from live `main` 6b1fc62; Beta/Feedback still out):
- `8f46674` **trust proxy = 1** (Railway's one proxy): each visitor gets their own sign-in limit; a forged first
  X-Forwarded-For entry is still counted as the real address. `test/rate-limit-proxy.test.js` (fails without the fix).
  Not changed, flagged: five places record the FIRST X-Forwarded-For entry by hand (activation / audit IPs) — a visitor
  can forge that one; `req.ip` would be the right value now.
- `18ec6bb` **nothing reads PRICE_STATION / PRICE_PRO**: old-price mapping removed; the platform diag route reports the
  ten catalog price variables (each read from Stripe by id); README / env.example list the ten. 523/523.
  PRICE_STATION = price_1TFzX79Zqn8ZGrIULbLb0oUI (the same price as Network monthly — still sold, via
  PRICE_UNLIMITED_MONTHLY); PRICE_PRO = price_1TFzcJ9Zqn8ZGrIUwBe86nK5 (the old Pro price). Railway variables NOT removed
  yet — waiting for Jeff (and for this code to be live first).

Account site branch `fix/session-401` (from live `main` b27a5f0):
- `1c80f00` **sign out only on 401**; a cancelled/failed load keeps the sign-in and shows "Couldn't load your account —
  You're still signed in. Check your connection, then try again." + Try again. `src/lib/session.test.ts`; 17/17, tsc 0.
  Screenshots: scratchpad `account-load-failed-desktop.png` / `-phone.png`.

Production (Jeff's ask, done): users 39/40/41 (`+buycheck2/3/4@gmail.com`) deleted — read-only dry run first (no
license, no memberships, no sign-in sessions), then one guarded transaction (exactly 3 rows by id AND email AND no
license). `+buycheck@` (user 38) kept. No license touched.
