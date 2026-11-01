# Stripe — creating the new prices (for Jeff to do himself, 2026-11-01)

Prices to create: **Local** $20/mo and $200/yr · **Network** $79/mo and $790/yr · **Network extra station** $15/mo.
Test mode first, then live. Nothing here changes a license.

## Part 1 — Test mode

1. Open https://dashboard.stripe.com and turn on **Test mode** (the switch at the top right; the page gets an orange
   "Test mode" bar).
2. **Product catalog → + Add product.**
   - Name: `Ether Local`. Description (optional): `Everything local, one price for the whole account.`
   - Pricing: **Recurring**, Amount **20.00 USD**, Billing period **Monthly**. Click **Add product**.
   - On the product page, under Pricing, click **+ Add another price**: **Recurring**, **200.00 USD**, **Yearly**. Save.
3. **+ Add product** again.
   - Name: `Ether Network`. Description: `Five hosted stations at 128 kbps sharing 250 listeners.`
   - **Recurring**, **79.00 USD**, **Monthly**. Add product.
   - **+ Add another price**: **Recurring**, **790.00 USD**, **Yearly**. Save.
4. **+ Add product** again.
   - Name: `Ether Network — extra station`. Description: `One more hosted station on Network; adds 50 listeners to the pool.`
   - **Recurring**, **15.00 USD**, **Monthly**, pricing model **Standard pricing** (per unit, so an account can buy 2, 3…).
     Add product.
5. Copy the five price IDs. On each product page, click the price row; the ID starts with `price_`. Write them down
   against these names (these are the names the server reads, from `config/plans.json`):

   | Price | Variable |
   |---|---|
   | Local monthly ($20) | `PRICE_LOCAL_MONTHLY` |
   | Local yearly ($200) | `PRICE_LOCAL_ANNUAL` |
   | Network monthly ($79) | `PRICE_UNLIMITED_MONTHLY` |
   | Network yearly ($790) | `PRICE_UNLIMITED_ANNUAL` |
   | Extra station ($15) | `PRICE_NETWORK_EXTRA_STATION_MONTHLY` |

6. **Developers → API keys** (still in test mode): copy the **Secret key** (`sk_test_…`).
7. On this computer, put them in `C:\ether-backend\.env.billing-test` (gitignored; the local test server refuses any
   live key):

   ```
   STRIPE_SECRET_KEY=sk_test_...
   PRICE_LOCAL_MONTHLY=price_...
   PRICE_LOCAL_ANNUAL=price_...
   PRICE_UNLIMITED_MONTHLY=price_...
   PRICE_UNLIMITED_ANNUAL=price_...
   PRICE_NETWORK_EXTRA_STATION_MONTHLY=price_...
   ```

8. **Settings → Billing → Customer portal** (test mode): click **Activate test link** / **Save** so "Update card" works
   in test mode.
9. Tell me when it's in. I run a test checkout with Stripe's test card `4242 4242 4242 4242` (any future date, any
   CVC), plus the decline card `4000 0000 0000 0002`, on the local test server only.

## Part 2 — Live (only after the test run passes)

1. Turn **Test mode** off. Repeat Part 1 steps 2–5 exactly (same names, same amounts). Live and test prices have
   different IDs.
2. Turn on the live Customer portal the same way, if it isn't already.
3. **Railway → project brave-simplicity → service ether-backend → Variables → + New Variable**: add the five
   `PRICE_…` variables with the **live** IDs. Railway redeploys by itself.
4. Do not change `STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SECRET` on Railway; they are already the live ones.

## What the server still needs before these can be sold (my work, not a Stripe step)

Today `POST /api/user/checkout` sells only `station` and `pro` (the old `PRICE_STATION` / `PRICE_PRO`), and the
webhook issues a license only for `PRICE_PRO`, `PRICE_STATION` and the two `PRICE_UNLIMITED_…` prices. Before Local,
Network or extra stations can be bought, the server must:
- accept `local` and `unlimited` (monthly or yearly) at checkout, and the extra station as a quantity on Network;
- map the Local prices in the webhook (Local is stored as the existing plan key the platform already writes for it);
- count paid extra stations toward Network's station limit.

I build and test this against test mode after Part 1, then show you before anything goes live. Live 128 and Live 320
yearly prices ($250 / $490) aren't on your list; they'd follow the same steps if you want them.
