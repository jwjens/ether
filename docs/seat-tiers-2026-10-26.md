# Seat limits are data: seat tiers — 2026-10-26

Jeff, 2026-10-26: "I'm the owner of Ether; the owner shouldn't be locked out by a seat limit ... Build it properly: seat
limits are data, not code. Remove the hard-coded SEATS_MAX = 5; each license has a seat limit, with an Unlimited tier (no
limit). Put my owner licenses (22 djdeniro and 24 jensj@opportunityvillage.org) on Unlimited. Never touch licenses 21/23.
Owner-only control in the admin dashboard to set any license's tier. Deploy the backend."

## What was in the way

License 24 was at 5 of 5 seats (`SEATS_MAX = 5`, ether-backend index.js:283). A second, hard-coded rule
(`PLAN_MACHINE_LIMITS = { free: 1 } ?? 5`) sat on /validate, desktop-activate and the activation lists.

## Done

- **Dead seat removed (2026-10-26, Jeff's go):** license 24, machine `4dfb2f33` "OVEVENTS", activated 2026-10-18T21:02:45Z,
  last seen 12 s later. It was a duplicate (OVEVENTS's real id is `8e8f6181`). Removed via `/account/deauthorize-seat`, the
  same call Manage Devices makes. 5 → 4 active. The new computer **OV-NDI-PC (`bac7bf44`)** has since signed in.
- **ether-backend `59a8b94`, deployed (push to main, live 2026-10-27T00:35Z, Railway log "[seat-tiers] seeded"):**
  - `seat_tiers` table (name, seat_limit NULL = Unlimited, is_default, default_for_plan) + `licenses.seat_tier_id`,
    added empty: no license row written. Resolution: own tier → plan's tier → default tier; no tier = no new seat
    (fail closed). Seeded once with the old behaviour: Standard 5 (default), Free 1 (plan free), Unlimited.
  - Both constants removed; all 8 enforcing/reporting endpoints use the tier. Responses add `seats_unlimited` and `seat_tier`.
  - Owner-only (`requirePlatform`) routes: seat tiers list/create/edit/delete; set a license's tier; list a license's
    machines; remove a machine.
  - Test: `src/lib/seat-tiers.test.js` 8/8; backend suite 148/148.
- **Owner licenses on Unlimited** (through the platform API): 22 and 24 → tier 3 "Unlimited". 21 (Free 1) and 23
  (Standard 5) read back byte-identical before/after; their `seat_tier_id` stays NULL.
- **Proof:** `/account/connect` on license 24 with a sixth, made-up machine id → HTTP 200, seats_used 5,
  seats_unlimited true (was 403 seat_limit_reached).
- **ether-admin (platform.ether-technologies.com):** Licenses page gets a "Machines allowed" dropdown per license (Default
  or any tier), "Machines in use N / limit", a Machines dialog (list + Remove with confirm), and a Seat tiers card (edit a
  tier's machines, add a tier, make default, delete an unused tier). Committed locally, **not deployed** (deploys on push
  to main).
- **Desktop (openair, local commit):** Manage Devices reads "N devices in use · no device limit" for Unlimited (it showed
  `seats_max ?? 5`); the sign-in error states the license's own number instead of "all 5 seats". Ships with the next build.
