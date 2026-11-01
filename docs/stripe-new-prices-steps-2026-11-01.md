# Stripe — creating the new prices (for Jeff to do himself, 2026-11-01)

Prices to create (Jeff's product names and descriptions, 2026-11-01): Ether Local, Ether Live 128, Ether Live 320, Ether Network, Network Extra Station, Listener Add-on.
Test mode first, then live. Nothing here changes a license.

## Part 1 — Test mode

1. Open https://dashboard.stripe.com and turn on **Test mode** (the switch at the top right; the page gets an orange
   "Test mode" bar).
2. For each row below: **Product catalog → + Add product**. Type the **Name** and **Description** exactly as shown
   (Jeff's wording, 2026-11-01). Pricing: **Recurring**, the first amount, billing period as shown, pricing model
   **Standard pricing**. Click **Add product**. Where the row has a yearly price, open the product and click
   **+ Add another price**: **Recurring**, the yearly amount, **Yearly**, Save.

   | Name | Description | Monthly | Yearly |
   |---|---|---|---|
   | `Ether Local` | `Everything runs on your computers. No cloud features.` | 20.00 USD | 200.00 USD |
   | `Ether Live 128` | `One station hosted on Ether’s cloud. 128 kbps, 50 listeners.` | 25.00 USD | 250.00 USD |
   | `Ether Live 320` | `One station hosted at full quality. 320 kbps, 150 listeners, priority support.` | 49.00 USD | 490.00 USD |
   | `Ether Network` | `5 hosted stations at 128 kbps, 250 listeners shared, priority support.` | 79.00 USD | 790.00 USD |
   | `Network Extra Station` | `One more station on your Network, adds 50 listeners.` | 15.00 USD | — |
   | `Listener Add-on` | `50 more listeners for one station.` | 10.00 USD | — |

   The yearly prices for Live 128 and Live 320 are the ones the website and account site already show ("or $250/yr",
   "or $490/yr"). Network Extra Station and Listener Add-on are bought in quantities (2, 3…), which Standard pricing
   allows.

3. Copy the price IDs. On each product page, click the price row; the ID starts with `price_`. Write each one against
   the variable the server reads (from `config/plans.json`):

   | Price | Variable |
   |---|---|
   | Ether Local monthly ($20) | `PRICE_LOCAL_MONTHLY` |
   | Ether Local yearly ($200) | `PRICE_LOCAL_ANNUAL` |
   | Ether Live 128 monthly ($25) | `PRICE_STATION_MONTHLY` |
   | Ether Live 128 yearly ($250) | `PRICE_STATION_ANNUAL` |
   | Ether Live 320 monthly ($49) | `PRICE_PRO_MONTHLY` |
   | Ether Live 320 yearly ($490) | `PRICE_PRO_ANNUAL` |
   | Ether Network monthly ($79) | `PRICE_UNLIMITED_MONTHLY` |
   | Ether Network yearly ($790) | `PRICE_UNLIMITED_ANNUAL` |
   | Network Extra Station ($15) | `PRICE_NETWORK_EXTRA_STATION_MONTHLY` |
   | Listener Add-on ($10) | `PRICE_LISTENERS_50_MONTHLY` |

   These are NEW variables. The old `PRICE_STATION` and `PRICE_PRO` on Railway (today's checkout) stay as they are until
   the server change below replaces them; don't edit or delete them.

4. **Developers → API keys** (still in test mode): copy the **Secret key** (`sk_test_…`).
5. On this computer, put them in `C:\ether-backend\.env.billing-test` (gitignored; the local test server refuses any
   live key):

   ```
   STRIPE_SECRET_KEY=sk_test_...
   PRICE_LOCAL_MONTHLY=price_...
   PRICE_LOCAL_ANNUAL=price_...
   PRICE_STATION_MONTHLY=price_...
   PRICE_STATION_ANNUAL=price_...
   PRICE_PRO_MONTHLY=price_...
   PRICE_PRO_ANNUAL=price_...
   PRICE_UNLIMITED_MONTHLY=price_...
   PRICE_UNLIMITED_ANNUAL=price_...
   PRICE_NETWORK_EXTRA_STATION_MONTHLY=price_...
   PRICE_LISTENERS_50_MONTHLY=price_...
   ```

6. **Settings → Billing → Customer portal** (test mode): click **Activate test link** / **Save** so "Update card" works
   in test mode.
7. Tell me when it's in. I run a test checkout with Stripe's test card `4242 4242 4242 4242` (any future date, any
   CVC), plus the decline card `4000 0000 0000 0002`, on the local test server only.

## Part 2 — Live (only after the test run passes)

1. Turn **Test mode** off. Repeat Part 1 steps 2–3 exactly (same names, same amounts). Live and test prices have
   different IDs.
2. Turn on the live Customer portal the same way, if it isn't already.
3. **Railway → project brave-simplicity → service ether-backend → Variables → + New Variable**: add the ten
   `PRICE_…` variables with the **live** IDs. Railway redeploys by itself.
4. Do not change `STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SECRET` on Railway; they are already the live ones.

## What the server still needs before these can be sold (my work, not a Stripe step)

Today `POST /api/user/checkout` sells only `station` and `pro` (the old `PRICE_STATION` / `PRICE_PRO`), and the
webhook issues a license only for `PRICE_PRO`, `PRICE_STATION` and the two `PRICE_UNLIMITED_…` prices. Before Local,
Network or extra stations can be bought, the server must:
- sell every plan monthly or yearly from the new variables at checkout, Network Extra Station as a quantity on Network,
  and Listener Add-on as a quantity on a Live or Network plan;
- map every new price in the webhook (Local is stored as the existing plan key the platform already writes for it);
- count paid extra stations toward Network's station limit.

I build and test this against test mode after Part 1, then show you before anything goes live. 
