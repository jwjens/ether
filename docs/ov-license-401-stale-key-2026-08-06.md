# OV sync fails with 401 invalid_license_key — trace + fix (2026-08-06)

**Status: TRACED. FIX BUILT LOCALLY, NOT COMMITTED, NOT SHIPPED.**
One thing is still outstanding and only OV's machine can answer it (§7).
OV is Jeff's own station (account `jensj@opportunityvillage.org`), not a customer account.

Jeff's report, verbatim:

> "The OV machine's cloud sync fails with 401 invalid_license_key."
> "OV machine had a MONTHS-OLD version before, now on current build — the sync 401 is likely a
> stale/mismatched license from the old version."

---

## 1. Where a license key can live, and which one wins

`electron/sync/transport-http.js:126-129` resolves in this order — **first match wins**:

| # | slot | notes |
|---|---|---|
| 1 | `install_config_kv.account_license_key` | the **anchor**, highest priority |
| 2 | `stations.owner_license_key` | active station first, then by id |
| 3 | `station_config_kv.license_key` | legacy — what an old build wrote |

All three live in `%LOCALAPPDATA%\Ether\com.ether.radio\openair.db`.

**This matters more than it looks:** the three slots can hold *different* values, and the resolver takes
the anchor without ever checking whether it still works.

## 2. What this machine sends (read-only, from a copy of the live DB)

```
install_config_kv.account_license_key   ETH-STN-…6FC8  (len 22)
stations.owner_license_key              ETH-STN-…6FC8  — all 4 stations, identical
station_config_kv.license_key           ETH-STN-…6FC8  — all 4 stations, identical
→ transport would send                  ETH-STN-…6FC8
   22 chars, no surrounding whitespace, plain ASCII — well formed
account_email                           jensj@opportunityvillage.org
```

All three slots agree here. Nothing malformed, nothing blank.

## 3. The backend's verdict — this license is VALID

Probed live (read-only, key never printed):

| call | result |
|---|---|
| `GET /health` | **200** — API v1.5.2, reachable |
| `POST /account/connect` + key + machine_id | **200** — account **"Opportunity Village"**, 4 stations returned |
| `GET /sync/mutations` + key | **400 "Missing client_id"** — i.e. it got **past auth** |
| `GET /sync/mutations` with **no** key | **401 "Missing x-license-key header"** |

Two conclusions, both firm:
- The license is **not** expired, rotated, re-issued or malformed. It is live on the current backend.
- The server **does** read the header — the two different errors prove it. So a 401 on OV is a genuine
  rejection of a **different key value**, not a transport/header bug.

Therefore OV is sending a key that is not this one — a stale value carried over from the months-old
version, sitting in one of the three slots.

## 4. Two corrections to my earlier statements

1. **"`account_license_key` is never written by any code" — WRONG.** It is written at
   `src/lib/ccData.ts:348` on a successful `/account/connect`. The false finding came from my own grep
   filtered to `--include=*.js --include=*.tsx`; the writer is a **`.ts`** file, so it never matched. A
   filtered search returning nothing is not proof of absence, and I stated it as fact.
2. **"OV's license may be invalid/expired" — ruled out** by §3. The license is valid.

## 5. The real bug — the refresh is circular

`src/lib/ccData.ts:347`:

```ts
if (res.ok && licenseKey) {                       // ← only re-stamps when the key ALREADY works
  await ether.installConfigKv.upsertByKey("account_license_key", String(licenseKey).trim());
}
```

- A machine holding a stale key gets **401** → `res.ok` is false → the anchor is **never refreshed**.
- The only code that can fix a bad key **requires a good key to run**.
- **Sign-out / sign-in cannot break the loop**: the reconcile self-heal re-stamps
  `stations.owner_license_key` (slot 2), but the **anchor (slot 1) outranks it**, so the stale value
  keeps winning.

That is exactly the trap OV is in, and it is why nothing the operator does clears it.

## 6. The fix (built, uncommitted)

**`stampLicenseEverywhere(key)`** — on every successful `/account/connect`, write the authoritative key
into **all three** slots: the anchor, every station's `owner_license_key`, and the legacy
`station_config_kv.license_key`. Idempotent. No stale value can survive in any slot.

**`healStaleLicense(rejected, idResp)`** — the missing escape hatch. When connect returns
**401 / `invalid_license_key`**, collect every **distinct other** key stored on the machine (slots 2 and
3, which may differ from the anchor), try each against `/account/connect`, and adopt the first one the
backend accepts — stamping it everywhere. Then retry the reconcile once with the accepted key.
No operator steps, no new endpoint, no re-install: the machine heals itself on the next tick.

**Bounded to ONE recovery pass** (`_healAttempt`). Written without it first, two mutually-rejected keys
would have recursed forever, hammering the backend from an unattended machine. Caught and fixed before
shipping.

Typecheck: zero new errors (accepted baseline of 2).

## 7. The honest limit, and what is still needed

- **If NONE of OV's stored keys are accepted, no software path can invent a valid one.** The desktop has
  **no email/password sign-in** — `/account/create`, `/account/connect`, `/account/seats`,
  `/account/add-station` are the only account endpoints; the **license key IS the credential**
  (`docs/` account-auth model; routing desktop sign-in through owner-login is a standing backlog item).
  In that case the app now logs that it needs re-activation instead of retrying forever.
- **Still needed to close this: OV's three values.** I cannot read another physical machine from here.
  Send OV's `openair.db` (or just those three fields) and one pass will say which slot holds the stale
  key, whether it is an old-format value, and whether the self-heal would have recovered it.

## 8. Verification plan (once shipped)

- **Reproduce the trap on a copy:** set `account_license_key` to a junk value while leaving
  `owner_license_key` valid. Before the fix: permanent 401. After: one 401, then the app adopts the
  valid key and syncs, with all three slots re-stamped.
- **Idempotence:** a healthy install re-stamps to the same values and changes nothing.
- **Bounded retry:** two junk keys → exactly one recovery pass, then a clear "needs re-activation" log,
  no loop.
- **Runtime receipt required:** OV syncing again is the only proof that counts.

## 9. Open for Jeff

1. Ship the fix in **4.4.160**, or hold until OV's DB confirms which slot is stale?
2. Desktop re-activation path: today a machine whose keys are *all* dead has no in-app way back.
   Worth a small "Re-activate this install" action in Subscription that accepts a key and stamps all
   three slots — related to the standing owner-login backlog item.
