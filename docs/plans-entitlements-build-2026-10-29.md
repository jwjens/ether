# Customer plans on the server: catalog, sign-in, plan check (2026-10-29)

**Jeff (verbatim, in order):** "the most important thing first is adding the restrictions to the accounts" · "not the
website as people log in the pay tier has to be restrictions need to align" · "this is fo customers not PD MD and jock"

So: the customer's paid plan (Local / Station / Pro / Unlimited), decided by the server, handed over at sign-in, and
the same answer everywhere. Not the website, not staff roles (the PD/MD/Jock table stays parked).
Governing doc: `docs/paywall-entitlements-plan.md` (updated with the 2026-10-29 rulings, commit `d7fceb9`).

## Backend — `C:\ether-backend` branch `feat/plans-entitlements` (on top of email verification + step a). NOT deployed.

| Commit | What |
|---|---|
| `ac0036c` | `config/plans.json`: the one place for prices, names, limits, feature → plan. Validated at boot. `GET /public/plans`. `src/lib/entitlements.js`: what a license may use |
| `00492c1` | Every sign-in reply carries `entitlements` (`/account/connect`, desktop-activate, `/api/user/me`); `GET /api/entitlements` |
| `7b05fc7` | The key check follows the plan: trial keys work through the 7-day grace; lifetime / platform-exempt keys never refused for a stale `expires_at` (Rulings R3). Only ever lets MORE through |
| `ffef654` | The plan check on every cloud route (`src/lib/feature-gate.js`): **shadow by default** (refuses nobody, records who would be refused); `PLAN_ENFORCE=1` answers 402. `GET /api/platform/plan-refusals` |

Tests: `npm test` **230/230**.

### The rules (`entitlements.js`)
- **Trial:** 15 days, full access (cloud on, Unlimited level). Ends → **grace 7 days** (cloud still on) → **lapsed**:
  cloud off. Nothing local reads any of it (lapse rule).
- **Local:** no cloud, except the listener page and now-playing (Decision 2).
- **Station / Pro / Unlimited:** their catalog limits.
- **Lifetime / operator:** Unlimited level forever, `expires_at` ignored, **no row written** (R1, R3).
- **`TIER_EXEMPT_LICENSE_IDS`** (Railway, comma-separated; unset = none): platform-made licenses keep today's access (R2).
- **Old rows:** `free` → Founding Local (Decision 6). Old `pro` / `station` rows have the same names as the new plans
  and read as them (the 2026-10-05 audit found no active `pro`).

### Decisions I made that are yours to change
- A trial runs at **Unlimited level** (today's trial is a Network trial with cloud). `config/plans.json` `trial.level`.
- The **grace applies to a trial's end too** ("cloud features stopping after the grace period").
- Listener-facing reads (the public page, the stream) are **not** behind the plan check yet: turning a lapsed station's
  listener page off is the hosted-stream phase (P5).

## Before deploy — what it does to real licenses (Jeff ran the read-only preview, 2026-10-29)

16 licenses. **Key check changes for two, both lifetime, both refused today → accepted after** (stale `expires_at`;
nothing written):
- **22 — djdeniro@gmail.com** (`station_lifetime`, expires_at 2026-07-17) — Jeff's own.
- **26 — joostpeters@gmail.com** (`station_lifetime`, expires_at 2026-07-29) — a customer's lifetime license.

**Licenses 21 (netgeak@gmail.com) and 23 (cristianmalliani@gmail.com): no change** — refused today, refused after.
21 reads as Local (Founding), 23 as Station lapsed; in shadow mode that only lands in the report.

Everyone else: unchanged (24 jensj@opportunityvillage.org and 28 maganaent@gmail.com lifetime, accepted; 27
medan27171@bora4d.com lapsed, refused; 29–37 trials ending 2026-11-02 … 11-11, accepted, and from now on each gets the
7-day grace after its end).

**Held for Jeff:** 26 is a lifetime license ("never touch … any lifetime license"). No row is written, but its access
changes (it regains cloud). Not deployed until Jeff says yes or no.

### (earlier text)
Read-only, prints every license with its email, its plan under the new rules, and whose key check changes:
`railway run --service Postgres node "<scratchpad>/diag-plan-preview.js"`.
In shadow mode nobody is refused; the only behaviour change on deploy is commit `7b05fc7` (keys in grace, and lifetime
keys with a stale date, start being accepted). The preview names exactly which licenses that is.

## Still to build
- **Desktop (P3):** store the sign-in `entitlements` in one place that the menus and the main process both read;
  cloud doors show the plan and price from `/public/plans`; banner on trial/grace/lapsed, never a blocking screen;
  no new updates when lapsed.
- Dashboard and signup page: read prices from `/public/plans`; remove Free/Solo.
- Turn `PLAN_ENFORCE=1` on only after the shadow report shows who would be refused.
- Stripe steps (P4) — instructions, then the webhook against the catalog.
