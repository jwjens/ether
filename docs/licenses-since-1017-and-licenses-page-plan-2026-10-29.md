# Licenses created since 10/17, and the Licenses page status columns (2026-10-29)

**Jeff (verbatim):** "read-only right now: list every license created since 10/17 with its email, whether it's on a
trial or paid, and its trial end date." Plus the Licenses page request (Status, Trial ends/Renews/Expires, Paid
through, Last seen; Tier dropdown in the new plan names; "Don't change any license. Show me a screenshot before
deploying.").

Read-only: `railway run --service Postgres`, `BEGIN READ ONLY`; status computed with the server's own
`entitlementsFor()` (`ether-backend/src/lib/entitlements.js`) and `config/plans.json`. Times UTC. Nothing written.

## Licenses created since 2026-10-17 — all nine on a trial, none paid (no Stripe subscription on any license)

| Lic | Email | Created | Plan key | Status | Trial ends | Last check-in |
|---|---|---|---|---|---|---|
| 29 | cadenamaster@hotmail.com | 10-18 04:52 | station | Trial | 2026-11-02 04:52 | 10-26 07:18 |
| 30 | berrios0402@gmail.com | 10-18 14:24 | station | Trial | 2026-11-02 14:24 | 10-19 10:51 |
| 31 | guttobarros@gmail.com | 10-22 23:55 | station | Trial | 2026-11-06 23:55 | 10-28 23:20 |
| 32 | ggmcgee@geemail.com | 10-23 08:17 | station | Trial | 2026-11-07 08:17 | 10-23 08:17 |
| 33 | djneonbeat04@gmail.com | 10-23 14:53 | station | Trial | 2026-11-07 14:52 | 10-23 15:06 |
| 34 | djneonbeat06@gmail.com | 10-23 14:54 | station | Trial | 2026-11-07 14:54 | 10-23 14:57 |
| 35 | justin1808hoefler@gmail.com | 10-24 08:10 | station | Trial | 2026-11-08 08:10 | 10-24 23:08 |
| 36 | djneonbeat08@gmail.com | 10-25 21:01 | station | Trial | 2026-11-09 21:01 | 10-25 21:01 |
| 37 | eurasiastar1@gmail.com | 10-27 15:46 | station | Trial | 2026-11-11 15:43 | 10-27 15:48 |

## Licenses page — what the build needs decided

The Tier dropdown can only write the six keys the server accepts (`VALID_PLANS`, `index.js:985`) and the desktop
understands (`src/hooks/usePlan.tsx:19`): free, pro, pro_lifetime, station, station_lifetime, operator. Shown in the
new names, as the server's plan rules read them: free → Local, pro → Pro, station → Station, pro_lifetime /
station_lifetime / operator → Lifetime (the server runs all three at Unlimited level, never expiring).
Choosing a name writes: Local → free, Pro → pro, Station → station, Lifetime → station_lifetime. **Unlimited has no
key** today: writing `unlimited` is refused by the server and unknown to the desktop; writing `operator` would grant a
never-expiring license. Unlimited stays unselectable until that is decided.

Status from `entitlementsFor`: trial → Trial (days left), active → Paid, grace → Grace, lapsed → Lapsed, lifetime /
operator → Lifetime; plus the two states the rules also have: active = false → Off, an unknown key → Unknown plan.
Last seen = the latest of the license's computers' `last_seen` and `licenses.last_validated` (both written at
activate / validate / connect).

## How the nine signed up (Jeff: "find out when and what they signed up for and why it isnt labeled")

All nine used the free sign-up (`POST /api/user/signup`: a 15-day trial, `TRIAL_DAYS = 15`) and signed in to the desktop
app within seconds. That sign-in created their license (`resolveDesktopLicense`, `src/lib/desktop-license.js:40`) with
plan `station` (Network in the old names) and `expires_at` = the trial end. None paid. The Licenses page did not show
it because its list never read `expires_at` and its Status column was only `active` / `inactive`.

## Built (local commits, NOT deployed — screenshot first)

- ether-backend `a486b3c` (branch feat/licenses-page-status): `src/lib/license-status.js` turns `entitlementsFor` into
  the page's Status / date / Paid through / Tier choice; `GET /api/platform/licenses` adds `plan_status`, `expires_at`,
  `last_seen`, `tier_options` (Stripe renewal read from Stripe, 5 s limit; the subscription id is never sent). Tests:
  `src/lib/license-status.test.js` (8), `test/platform-licenses-status.test.js` (reading changes no license; the
  dropdown's PATCH still refuses unknown keys). Full suite 434/434. The new SQL ran read-only on production.
- ether-admin `e383def` (branch feat/licenses-status): the new columns, `#id` beside each email, the Tier dropdown in the
  new names. Typecheck clean.
- The old `free` key (21 netgeak@gmail.com) shows **Founding Local**, not Paid: no charge, never lapses (Decision 6).
- The Generate-a-key form uses the same choices; its default was Enterprise (`operator`), now Lifetime
  (`station_lifetime`). Both are Unlimited forever under the server rules; the desktop ranks `operator` one step higher.
- Preview: the real production rows through the new code, served by a local read-only mock, captured in a hidden
  Electron window.
