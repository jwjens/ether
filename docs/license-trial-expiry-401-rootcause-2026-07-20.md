# License 401 root cause — expired trial clock on a paid lifetime license (2026-07-20)

**STATUS: §2 DB fix APPLIED + verified (connect → 200). §3 trial_expired doorway SHIPPED in v4.4.66
(backend deployed, desktop installer built). §4 owner-login re-route = next release. See
`docs/release-4.4.66-trial-expired-doorway-2026-07-20.md`.**

Follows `docs/signin-couldnt-reach-server-diagnosis-2026-07-20.md` (the 401 pin) and
`docs/release-4.4.65-signin-honest-error-2026-07-20.md` (the honest-copy fix).

---

## (1) VERIFY — why `…6FC8` returns `invalid_license_key`

### Validation logic (`ether-backend/src/index.js`)

`/account/connect` (line 3688) returns 401 solely when `lookupLicense()` returns null:

```js
async function lookupLicense(rawKey) {               // line 920
  const prefix = rawKey.slice(0, 12);
  const { rows } = await pool.query(
    `SELECT * FROM licenses WHERE (key_prefix = $1 OR license_key = $2) AND active = true`,
    [prefix, rawKey]);
  for (const row of rows) {
    // Expired trial license → treat as no match (paid licenses have expires_at = NULL, always pass).
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) continue;   // ← line 929
    if (row.key_hash != null) { if (await bcrypt.compare(rawKey, row.key_hash)) return row; }
    else if (rawKey === row.license_key) { return row; }
  }
  return null;                                        // → 401 invalid_license_key
}
```

The 401 is **not** gated on plan or on uid 25's user record — it is purely `expires_at` in the past.

### Row states (prod DB, read-only via `railway run --service Postgres`)

`licenses` **id 24**:
```
email        jensj@opportunityvillage.org
plan         station_lifetime         ← paid, LIFETIME tier
active       true
key_prefix   ETH-STN-BAA8   key …6FC8 (len 22)   has_hash false
expires_at   2026-07-20T16:55:04.274Z ← TODAY   →  EXPIRED_NOW: true
created_at   2026-07-05T16:55:10Z     last_validated 2026-07-20T18:36Z
```

`users` **id 25**:
```
email jensj@opportunityvillage.org   license_key_id 24
trial_ends_at 2026-07-20T16:55:04.274Z   ← identical stamp to licenses.expires_at
created_at 2026-07-05T16:55:04Z
```

### Verdict

Yes — the trial clock expired it. License id 24 is a **paid `station_lifetime` (Network Lifetime)**
license that was minted at signup **carrying a 15-day trial `expires_at`** (created 2026-07-05 +15d =
2026-07-20 16:55Z), mirrored in `users.trial_ends_at`. At that instant today, `lookupLicense` line
929 began `continue`-ing past the only matching row → null → 401. The code's own invariant ("paid
licenses have `expires_at = NULL`") was violated: a lifetime license kept a trial clock that was
never cleared. This is the two-door / trial-identity leftover.

Reproduce: `cd C:\ether-backend && railway run --service Postgres node <script>` querying
`SELECT id,email,plan,active,expires_at FROM licenses WHERE email ILIKE '%opportunityvillage%'`.

netgeak (lic 21) and cristianmalliani (lic 23) are **not** involved and were not read/altered.

## Data-safety verification (ADDITION #3) — expiry gates access, never destroys data

- No expiry-driven deletion anywhere: grep for cron / setInterval / purge-on-expiry in the backend
  is **empty**.
- Every `DELETE FROM stations` (index.js 1316/1394/2382/4069) is inside an explicit
  admin/platform/owner **delete-account or delete-station** handler, keyed by `license_key_id` and
  operator-initiated — never triggered by expiry.
- Expiry path is only `lookupLicense → null → 401`. Station rows, `station_*` data, and `songs`
  remain in Postgres; R2 audio is never auto-deleted (see delete-completeness note).
- **Therefore "Your stations and library are safe — it resumes on renewal" is factually TRUE.**

---

## (2) FIX Jeff's account — PROPOSED SQL (NOT APPLIED — needs Jeff's go)

Founder's own account. No schema change. netgeak/cristianmalliani untouched.

```sql
-- Clear the trial clock on the founder's paid lifetime license (id 24 / uid 25).
UPDATE licenses SET expires_at = NULL,  plan = 'operator' WHERE id = 24;   -- 'operator' = Enterprise (top real tier)
UPDATE users    SET trial_ends_at = NULL                  WHERE id = 25;
-- Verify: SELECT id,plan,active,expires_at FROM licenses WHERE id=24;  -- expect expires_at NULL
```

- The **actual cure is `expires_at = NULL`** — that alone makes `lookupLicense` pass the row forever.
  `plan='operator'` bumps it to the top real tier ("owner/dev" equivalent; VALID_PLANS has no literal
  "owner"). If you'd rather leave the tier as `station_lifetime` (already lifetime), drop the
  `plan=` clause — the NULL clock is what unblocks sign-in either way.
- Desktop's owner/dev override is client-side (`resolveEffectivePlan`); the server plan just needs to
  be a valid paid tier with a NULL clock.

After the write, this box's next `/account/connect` with `…6FC8` returns 200 and stations load. No
reinstall needed.

---

## (3) trial_expired doorway — PROPOSED (rides with the license-fix release, NOT APPLIED)

An expired trial must be a doorway, not a dead end. Two coordinated changes:

### 3a. Backend — `/account/connect` distinguishes trial_expired from invalid_license_key

Today `lookupLicense` collapses expired-trial → null, indistinguishable from a bad key. Proposed:
detect "a row matched the key but was expired" and return a distinct 401 body.

```js
// in /account/connect, replacing the flat `if (!license) 401 invalid_license_key`:
const lk = await lookupLicenseDetailed(rawKey);   // {row, reason: 'ok'|'expired'|'notfound'}
if (lk.reason === 'expired')
  return res.status(401).json({ error: 'trial_expired', renew_url: 'https://signup.ether-technologies.com' });
if (!lk.row)
  return res.status(401).json({ error: 'invalid_license_key' });
```

`lookupLicenseDetailed` = `lookupLicense` that, instead of `continue` on the expiry check, records
`reason='expired'` when the key otherwise matches (prefix/hash/plaintext) but `expires_at` is past.
Non-expired match → `reason='ok'`; no match at all → `reason='notfound'`. Keep the existing
`lookupLicense` for all other callers unchanged (only connect needs the nuance).

### 3b. Desktop — sign-in copy branches on trial_expired (in the v4.4.65 status-branch)

In `OnboardingFlow.tsx routeAfterAuth`, extend the 401 branch by `connectErrCode`:

- `error === 'trial_expired'` →
  **"Your free trial has ended. Your stations and library are safe — pick a plan to keep
  broadcasting."** + a **"Choose a plan"** button that opens `renew_url` in the external browser via
  the existing `open_url` IPC (same as SubscriptionPanel's `signup.ether-technologies.com`).
- `error === 'invalid_license_key'` → keep the current contact-support copy (truly bad key ≠ expired
  trial).

### 3c. Docs + help

- `docs/onboarding-signin-state-table.md`: add row **C3c — trial expired** (distinct from C3b invalid
  key), status → shipped with this release.
- Help corpus: new `docs/help-trial-ended.md` — **"What happens when my trial ends"** (plain
  language: nothing is deleted; stations + library are safe in the cloud; pick a plan to resume;
  where the Choose-a-plan button goes). Wire discoverability from the sign-in trial_expired screen.

---

## (4) PERMANENT CURE — owner-login re-route, scheduled next release

The two-door leftover (desktop sign-in mints a **trial** identity via `/api/user/desktop-activate`
instead of routing through owner-login with an lk-bearing token) is the root that stamped a trial
clock onto a paid account. Un-backlogged: **next small release after this unblock** — desktop signs
in via `/api/auth/owner-login` returning an lk-bearing token; `/account/connect` and cloud ops read
that identity, so a paid account never re-acquires a trial `expires_at`. Design end-to-end first
(client + backend), then build.

---

## Release sequencing

1. **Now (this turn):** receipts above. STOP.
2. **On Jeff's go:** apply the §2 SQL (unblocks his box immediately).
3. **License-fix release:** §3a backend deploy + §3b/§3c desktop build (v4.4.66) — trial_expired
   doorway + help.
4. **Next release:** §4 owner-login re-route.

*Read-only diagnosis + proposal. No DB write, no backend deploy, no desktop rebuild performed.*
