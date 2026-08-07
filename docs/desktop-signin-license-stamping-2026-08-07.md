# Email/password sign-in stamps the license everywhere — the fix for a stranded machine

**Date:** 2026-08-07 · **Status: BUILT LOCALLY. NOT COMMITTED, NOT BUILT INTO AN INSTALLER, NOT SHIPPED.**
Follows `docs/ov-license-401-stale-key-2026-08-06.md`, which traced the OV `401 invalid_license_key`.

Jeff's direction, verbatim:

> "Users (Jeff + customers) authenticate with EMAIL + PASSWORD only. The license key exists internally
> (assigned per account) but users never see or handle it — the app manages it."
> "A machine with a stale key (OV) heals by the user signing in with email/password — the fresh key
> overwrites the stale one. No key entry, no re-activation, no DB surgery."
> "This works even if every local key is dead, because the key comes from the account login, not the
> machine."

---

## 1. What the desktop already has (the answer to "confirm what exists today")

**Email/password sign-in already exists on the desktop, and it already fetches the account's current
license key.** No new endpoint, no new screen, nothing to invent.

Backend route discovery (probed live, no credentials sent — 404 means absent, 401/400 means real):

```
EXISTS  POST /api/user/login          401 {"error":"invalid_credentials"}
EXISTS  POST /api/user/desktop-activate  ← the one the desktop uses
EXISTS  POST /account/create          400 missing_fields
EXISTS  POST /account/connect         400 missing_fields
  ---   POST /account/login           404      /auth/login 404      /owner/login 404
  ---   POST /account/license         404      /account/recover-license 404
```

`POST /api/user/desktop-activate` takes **email + password + machine id** and returns
`{ ok, license_key, plan, email, token, trial, trial_ends_at }`. Two screens already call it:

| caller | when |
|---|---|
| `src/components/OnboardingFlow.tsx:458` | first-run activation |
| `src/components/SubscriptionPanel.tsx:176` | in-app sign-in / switch account — **the path an existing machine like OV uses** |

So Jeff's points 1, 2 and 4 were already true of the product. Only the last step was wrong.

## 2. The bug — the right key, filed in the wrong place

Both callers stamped the returned key into **one** slot:

```ts
const kv = (window as any).ether.stationConfigKv;
if (data.license_key) await kv.upsertByKey(stationId, 'license_key', data.license_key);   // slot 3 only
```

`station_config_kv.license_key` is the **lowest-priority** of the three slots the sync transport
resolves from (`electron/sync/transport-http.js:126-129`):

| # | slot | priority |
|---|---|---|
| 1 | `install_config_kv.account_license_key` | **wins** |
| 2 | `stations.owner_license_key` | second |
| 3 | `station_config_kv.license_key` | last — the only one sign-in wrote |

**Consequence:** a machine carrying a stale anchor from an older version could sign in with correct
credentials, receive the correct current key from the backend, and *still* sync with the dead one —
because the stale anchor outranks the slot that just got updated. `401 invalid_license_key`, forever,
with nothing the operator could do about it. That is OV.

## 3. The fix

**`stampLicenseEverywhere(key)`** (`src/lib/ccData.ts`, now exported) writes the authoritative key into
**all three** slots — the anchor, every station's `owner_license_key`, and each station's legacy
`station_config_kv.license_key`. Idempotent; safe on every sign-in and every reconcile.

Wired into both sign-in paths, so signing in is now what heals a machine:

- `OnboardingFlow.tsx` — first-run activation.
- `SubscriptionPanel.tsx` — in-app sign-in / switch account.

The user still only ever types an email and a password. The key remains internal and unseen.

**Also present from the prior session** (same file, same arc):

- `stampLicenseEverywhere` is called on every successful `/account/connect` in
  `reconcileAccountStations`, replacing the old anchor-only pin.
- **`healStaleLicense()`** — when `/account/connect` returns 401 / `invalid_license_key`, try every
  *other distinct* key stored on the machine, adopt the first the backend accepts, and stamp it
  everywhere. Bounded to **one** recovery pass (`_healAttempt`) — written without the bound first, two
  mutually-rejected keys would have recursed forever against the backend from an unattended machine.

## 4. Exact state of the tree

| file | change | state |
|---|---|---|
| `src/lib/ccData.ts` | `stampLicenseEverywhere` exported; `healStaleLicense` added | modified, uncommitted |
| `src/components/OnboardingFlow.tsx` | activation stamps all three slots | modified, uncommitted |
| `src/components/SubscriptionPanel.tsx` | in-app sign-in stamps all three slots | modified, uncommitted |

`npx tsc --noEmit` → **2 errors, both the accepted pre-existing baseline** (OnboardingFlow, PhoneDesk).
Nothing committed. No installer built. Not shipped.

> Note on §4's accuracy: the `SubscriptionPanel.tsx` edit was interrupted mid-run and initially looked
> unapplied. It was verified directly afterwards — the import is at line 2 and the call at line 201, and
> the file typechecks. Recorded because a half-applied edit is exactly the kind of thing that should not
> be assumed either way.

## 5. What this does and does not fix

**Fixes:** any machine whose local keys are stale or mismatched — including one that has been through a
months-old version — heals the moment someone signs in with email and password. No key entry, no
re-activation flow, no database surgery, nothing for the operator to understand.

**Does not fix:** an account whose license is genuinely revoked or deleted on the backend. The app will
report that it needs attention rather than retrying forever. That is a real state, not a bug.

**Still unverified:** whether OV's stored key is stale (heals on sign-in) or its license is genuinely
gone. That needs OV's `openair.db` — three fields — and cannot be read from this machine.

## 6. Verification (none of this is proven yet)

- **Reproduce the trap on a copy:** poison `install_config_kv.account_license_key` with junk, leave
  `owner_license_key` valid. Before: permanent 401. After sign-in: all three slots carry the account's
  current key and sync resumes.
- **Idempotence:** a healthy install signs in and nothing changes.
- **Runtime receipt required:** OV syncing again after an email/password sign-in is the only proof that
  counts. A passing typecheck is not evidence the trap is broken.

## 7. Open for Jeff

1. Ship in **4.4.160**?
2. Should `stampLicenseEverywhere` also run on *every launch* when the account is already signed in
   (belt-and-braces), or only on sign-in and reconcile as built?
3. OV specifically: send me its `openair.db` (or the three fields) to confirm which case it is — stale
   key that sign-in will heal, or a license that no longer exists.
