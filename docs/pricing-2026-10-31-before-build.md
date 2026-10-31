# New pricing (Jeff, 2026-10-31) — the two answers before building

New pricing: LOCAL $20/mo or $200/yr · LIVE per hosted station $25/mo (128 kbps, 50 listeners, cloud) or $49/mo (320 kbps,
150 listeners, cloud, priority support) · NETWORK $79/mo for 5 stations + $15/mo each additional · no 3+ station
discount · annual = 10 months · no free plan, 15-day trial with no card, +$10/mo listener add-on (+50), grace periods,
lifetime = top plan forever. Nothing built yet; nothing in Stripe.

## 1. Network's bitrate and listener limits in today's plans.json

**There is no "Network" plan in `C:\ether-backend\config\plans.json`.** It has four: `local`, `station`, `pro`,
`unlimited`.
- The word "Network" today is only the **desktop's** old friendly name for the plan key **`station`**
  (free=Solo, pro=Studio, station=Network, station_lifetime=Network Lifetime, operator=Enterprise). In plans.json
  `station` is: **128 kbps, 50 listeners per stream**, 1 hosted stream, 100 GB cloud, $25/mo.
- The $79 plan in plans.json is **`unlimited`**: **320 kbps, a shared pool of 250 listeners**, unlimited hosted streams,
  500 GB cloud, priority support.

**Decision needed:** the new NETWORK ($79, 5 stations, +$15 each): which limits per station — 128 kbps / 50 listeners
(like LIVE $25), 320 kbps / 150 (like LIVE $49), or a shared pool like `unlimited` (320 kbps, 250 listeners shared)?

## 2. What every existing license would display under the new names (no license changed)

Proposed name for each plan key (Jeff's mapping to confirm):

| Plan key | Shown today (desktop / platform) | New name proposed |
|---|---|---|
| `local` | Local | **Local** |
| `free` (the old free key) | "Free (old key)" / "Solo" | **Local** (there is no free plan) — or keep "Free (old key)"? |
| `station` | desktop "Network", platform "Station" | **Live 128** ($25: 128 kbps, 50 listeners) |
| `pro` | desktop "Studio", platform "Pro" | **Live 320** ($49: 320 kbps, 150 listeners) |
| `unlimited` | Unlimited | **Network** ($79) |
| `station_lifetime` and any `*_lifetime` | "Network Lifetime" | **Network (Lifetime)** — the top plan forever |
| `operator` | Enterprise | **Network (Enterprise)** — top plan |

Licenses as recorded in the read-only preview Jeff ran on 2026-10-29 (`docs/plans-entitlements-build-2026-10-29.md`,
`docs/licenses-since-1017-and-licenses-page-plan-2026-10-29.md`). **A fresh read of production was refused by this
session's permission check, so anything created after 10-29 is not listed and the plan keys marked "?" are not
confirmed** — one read-only `SELECT id, email, plan, active, expires_at FROM licenses` settles it.

| Lic | Email | Plan key (10-29) | State (10-29) | Would display |
|---|---|---|---|---|
| 21 | netgeak@gmail.com (customer) | old free key | Local (Founding) | Local — *unchanged license* |
| 22 | djdeniro@gmail.com (Jeff) | station_lifetime | lifetime | Network (Lifetime) |
| 23 | cristianmalliani@gmail.com (customer) | station | lapsed | Live 128 — lapsed |
| 24 | jensj@opportunityvillage.org (Jeff/OV) | lifetime (key ?) | lifetime | Network (Lifetime) |
| 26 | joostpeters@gmail.com (customer) | station_lifetime | lifetime | Network (Lifetime) |
| 27 | medan27171@bora4d.com | ? | lapsed | (its key) — lapsed |
| 28 | maganaent@gmail.com | lifetime (key ?) | lifetime | Network (Lifetime) |
| 29–37 | nine sign-ups 10-18…10-27 (cadenamaster, berrios0402, guttobarros, ggmcgee, djneonbeat04/06/08, justin1808hoefler, eurasiastar1) | station | 15-day trial | Live 128 — trial (ends 11-02 … 11-11) |
| (16th) | not named in the 10-29 notes | ? | ? | ? |

Today's trials all run at the Unlimited level during the trial (plans.json `trial`), whatever the key says.
