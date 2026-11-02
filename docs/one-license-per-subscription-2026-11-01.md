# One license per Stripe subscription — the production database change (2026-11-01)

**Status: built and tested locally (ether-backend `57b00ab`, branch `billing-new-prices`). NOT deployed. Waits for
Jeff's OK.**

## The defect (Jeff's billing test, recorded as seen)
One Live 128 purchase (test10@ether.test, Stripe test mode) made **two licenses**: license 1 (linked to the account)
and license 2 (not linked; its license key was emailed). Stripe sent `checkout.session.completed` and
`invoice.payment_succeeded` at the same moment; both webhook branches looked the subscription up, found nothing, and
each inserted a license. Receipt: `C:\ether-backend\billing-test\run-local-3.log` lines "account subscription: user 1 →
license 1" and "Issued: ETH-STN-8484…" 0.2 s apart; both rows carry `sub_1UXANB9Zqn8ZGrIUQ4gUay4q`.

## The database change
One unique index, covering only licenses that have a Stripe subscription:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS licenses_one_per_stripe_subscription
  ON licenses (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;
```

- Licenses with no subscription (trials, platform-made, lifetime — including licenses 21 and 23) are not in the index
  and are not touched. No row is written, moved or deleted; no column changes.
- How it is applied: at boot, by `initDB` (`src/lib/license-subscription-index.js`), after the billing columns. It is
  guarded: if any subscription already had two licenses, the index would **not** be made, the server would still start,
  the duplicates would be logged with emails, and no license would be changed.
- The code change that goes with it: both webhook branches insert with `ON CONFLICT DO NOTHING`; the one that loses
  uses the winner's license (the account checkout updates and links it; the invoice reactivates it and emails nothing).
  Without the index the code still runs exactly as before (no protection, no error).

## Production today (read-only check, 2026-11-01)
`railway run --service Postgres node scripts/prod-duplicate-subscriptions-readonly.js` — a read-only session
(`default_transaction_read_only = on`, a `READ ONLY` transaction, rolled back):

```
read-only session: on; licenses with a Stripe subscription: 0; subscriptions with more than one license: 0
None — the index can be made as it is.
```

No production license has a Stripe subscription yet, so there is nothing to list and the index would be made at once
(the licenses table is small; `CREATE UNIQUE INDEX` locks it for well under a second). Nothing was changed.

## To deploy (only on Jeff's OK)
Deploying `billing-new-prices` to Railway runs `initDB`, which makes the index. Afterwards, check the boot log for the
absence of `licenses_one_per_stripe_subscription NOT made`, or run the read-only check again.
