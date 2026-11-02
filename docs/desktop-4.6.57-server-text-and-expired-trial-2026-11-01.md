# 4.6.57: server text the app shows, and what an expired-trial user sees (2026-11-01)

Read-only investigation of the released 4.6.57 source (tag `v4.6.57`) against the live backend. All runtime behaviour
below is **from the code, UNVERIFIED at runtime**. The one check that settles it: sign in on a 4.6.57 install with an
account whose trial has ended, and screenshot the sign-in screen.

## Who this affects tonight (production, read-only)
- **License 29 (cadenamaster@hotmail.com)**, Live 128 trial, ended 2026-11-02 04:52 UTC. One Windows PC "EDICION",
  last check-in Oct 26.
- **License 30 (berrios0402@gmail.com)**, Live 128 trial, ends 2026-11-02 14:24 UTC. One Mac "iMac-de-JC", last check-in
  Oct 30.
- The server records no app version per device, so their build can't be confirmed from the server (Jeff: they won't
  have the new build).

## What an expired-trial user sees on 4.6.57 today
- **Opening Ether (cold launch):** 4.6.57 starts every launch signed out (`App.tsx:616-619`, `accountSignedIn` resets),
  so it shows the account sign-in screen.
- **Signing in:** the live backend answers desktop sign-in with **403** `trial_expired` (`ether-backend src/index.js`,
  the `if (!pick)` after `resolveDesktopLicense`). 4.6.57 shows the server's message as-is in red under the form
  (`OnboardingFlow.tsx:462-463`): **"Your free trial has ended. Subscribe to activate Ether, or continue on the free Solo
  plan."** — and stops. **No link, no plan button** (the "Choose a plan →" button at `:1247` only appears on a later step
  that is never reached), and the "free Solo plan" it mentions isn't offered on that screen. **They cannot get in, and on
  a cold launch nothing airs.**
- **If Ether was still running** (closed to the tray, or back through the crash-while-live / update-relaunch
  exceptions): they stay in and playout continues. The 20-second check and the 6-hour license check show nothing on a 401.
  A fixed "Your free trial has ended" overlay (TrialGate, no date, no link, dismissible, switches the plan to Free) may
  appear — only if station 1's settings hold the trial date.

This contradicts the lapse rule (a lapsed trial is a reminder, never a blocking screen, never stops playout).

## Can the server alone show "your trial ends on [date] — choose a plan at [link]" to 4.6.57?
**No.** 4.6.57 never reads `billing_notice` or `entitlements`, has no server notice/announcement channel, and the only
places that show server text verbatim do it on FAILED calls, which block sign-in. Details per surface:
- desktop sign-in `message`: shown as-is only on failure (blocks sign-in); plain red text, no link.
- `/account/connect` `renew_url`: the only server-controlled clickable link, shown only with `error: trial_expired` on a
  failed connect (blocks sign-in); the text beside it is fixed (no date).
- TrialGate: fixed text, fires only after the trial has ended, no date, no link.
- Manage Devices `detail`: shows server text on a fake error, hides the device list — an abuse of an error path; not
  recommended.
- Update banner release notes: plain text, 300 characters, only when a newer GitHub release is published (a new build).

## What a server-only change CAN do for 4.6.57 (proposal, not built)
Stop the block: for an expired trial, desktop sign-in answers 200 with the license (instead of 403), and
`/account/connect` answers 200 with the stations (instead of 401 `trial_expired`), carrying the lapsed status in
`entitlements` / `billing_notice` for builds that read them. On 4.6.57 the user then gets in and playout runs; cloud
features stay off by entitlements; at most the fixed TrialGate overlay appears (dismissible). No message with a date or
link is possible for 4.6.57 without a new build.

## Also found (not investigated further)
- `lookupLicenseDetailed` (`index.js`) has no lifetime/operator exemption, while `entitlement.js` does: a lifetime license
  with a stale `expires_at` would pass desktop sign-in and then get connect's 401 `trial_expired` ("Your free trial has
  ended…") — conflicts with the lifetime ruling in CLAUDE.md.
- During an expired-trial 401, the 20-second check sees an empty cloud station list and tries `/account/register-station`
  for every local station every 20 seconds (`ccData.ts:929-953` at the tag).

Full surface-by-surface table (file:line at v4.6.57, trigger, exact text, blocks?, stops audio?) from the investigation:
sign-in failure (server message as-is), connect failure (mapped; trial_expired → green text + Choose a plan button),
billing_notice/entitlements (never read), TrialGate (fixed overlay), licenseGuard and the 20-second check (nothing shown on
401), Subscription panel key/sign-in (server error as-is, inline), Manage Devices (server detail as-is, inline), Station
Manager / public page (mapped, inline), legacy key screens (unreachable), update banner (GitHub notes, plain text). None
stops audio; the two sign-in surfaces block.

---

## Done tonight (Jeff's go, 2026-11-01)
1. **DEPLOYED** — backend `98b2ac2` (Railway deployment cc57cbf5): a trial that ended (or a lapsed plan) is never
   refused. Desktop sign-in answers 200 with the account's own lapsed license (or a new one already lapsed) and reports
   `trial: true` with the past end date (4.6.57's own dismissible trial-ended overlay); `/account/connect` answers 200 with
   the stations, entitlements lapsed/grace (no cloud) and the notice. Cloud routes still refuse a lapsed key. An account
   with no trial at all is still refused. 536/536. **Live confirmation** on test account djdeniro+lapsedcheck@gmail.com
   (user 42; its trial end set 30 days back — one column on the test user): sign-in 200 (key, trial true, Oct 3, lapsed,
   cloud off) · account check 200 (lapsed, notice lapsed) · /backup/list 401. The sign-in made that test account's own
   license 38 (already lapsed). Licenses 29 and 30 get this the next time they open Ether.
2. Built, NOT deployed — backend branch `fix/lifetime-never-expires` `22d245a`: lifetime/operator licenses never expire in
   the key checks (cloud routes + account check). Read-only: **license 22 (djdeniro@gmail.com)** carries 2026-07-17 (past)
   — its cloud routes are refused today; 24 (jensj@opportunityvillage.org) and 28 (maganaent@gmail.com) carry none. No
   license changed. Test fails on the previous code.
3. Built, NOT released — desktop `472bfd2`: a refused account answer is not a station list; the 20-second check no longer
   re-sends every station while refused. For the next release build (4.6.57 can't change; since item 1, the server no
   longer refuses lapsed trials, which also ends that loop for 4.6.57 on lapsed accounts).
4. Built, NOT deployed — same branch as 2: the old refusal now reads "Your free trial has ended. Choose a plan at
   signup.ether-technologies.com." (plain text; only an account with no trial at all reaches it now).
