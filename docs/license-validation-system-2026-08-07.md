# License validation system (4.4.160) — validate quietly, heal automatically, never go dark

**Date:** 2026-08-07 · **Status: BUILT, PROVEN, SHIPPED as 4.4.160.**
Closes the arc from `docs/ov-license-401-stale-key-2026-08-06.md` and
`docs/desktop-signin-license-stamping-2026-08-07.md`.

Jeff's direction:

> "The pay structure exists; this is the validation layer that maintains it (Adobe/Avid pattern), and
> it's WHY OV went stale."
> "OFFLINE GRACE — if the backend is unreachable, DO NOT lock out or go off air… A station must never
> go dark because the license server was unreachable."
> "Only surface a message on a CONFIRMED revoke/expire — never a transient network miss."

**Users authenticate with EMAIL + PASSWORD only.** The license key is internal — assigned per account,
managed by the app, never seen or typed by an operator.

---

## 1. The six parts

| # | behaviour | where |
|---|---|---|
| 1 | Sign-in stamps the current key into **all three** slots | `ccData.stampLicenseEverywhere`, called from `OnboardingFlow.tsx` + `SubscriptionPanel.tsx` |
| 2 | A 401 tries every **other** stored key, bounded to one pass | `ccData.healStaleLicense` |
| 3 | Silent re-validate + re-stamp on **every launch** | `licenseGuard.startLicenseGuard` (12s after launch) |
| 4 | **Heartbeat** re-validation while running | 6h interval, plus an immediate re-check on the `online` event |
| 5 | **Offline grace** — unreachable backend never locks out, never stops audio | `decideLicenseAction`, `GRACE_DAYS = 14` |
| 6 | Message **only** on a confirmed revoke/expire | `surface: true` for 402 / `license_expired` / `subscription_cancelled` only |

The three slots, in the order the sync transport resolves them
(`electron/sync/transport-http.js:126-129`): `install_config_kv.account_license_key` (wins) →
`stations.owner_license_key` → `station_config_kv.license_key`.

## 2. The design decision that matters

`decideLicenseAction()` is a **pure function** — no I/O, no globals — because the one thing this layer
must never do is confuse *"the network is down"* with *"you are not entitled"*. Keeping it pure is what
makes that testable rather than hoped-for.

```ts
keepRunning: true      // stated as a literal type on every branch, so it cannot be optimised away
```

- **`ok`** → stamp all three, record `license_last_validated_at`.
- **network error** → state `offline`, keep running, say nothing. Past 14 days it *mentions* it once —
  still no lock-out, still on air.
- **401 / invalid_license_key** → NOT a revoke. The key may simply be stale (OV). Heal first.
- **402 / license_expired / subscription_cancelled** → the only states worth telling an operator, and
  even then the station keeps running.
- **anything else (500s, gateways, nonsense)** → treated as an outage. Never the operator's problem.

## 3. Proof — real, on a copy of the live database

`decideLicenseAction` is loaded **from the shipping `.ts` source** (transpiled at test time), and the
slot writes are executed against a **copy of the real database**. 30 checks, all passing:

```
A. POISONED ANCHOR + VALID KEY ELSEWHERE (the OV trap)
   the stale anchor is what gets sent (the bug)            → ETH-STN-DEADBEEF-STALE
   BEFORE — after a correct sign-in it STILL sends the dead key
   401 → heal, not revoke · nothing shown · keeps running
   AFTER — anchor / every owner_license_key / every legacy slot carry the current key
   AFTER — the transport now sends the good key (sync resumes)
   no stale value survives anywhere

B. BACKEND UNREACHABLE
   offline → keeps running · NOT revoked · silent within grace · does not thrash the heal path
   offline beyond 14d → mentions it, STILL keeps running
   never-validated + offline → still runs, still silent
   502 gateway error → treated as an outage, not a verdict

C. CONFIRMED REVOKE (402 / license_expired / subscription_cancelled)
   → surfaced, and STILL keeps running (never cuts audio)

D. HEALTHY INSTALL
   validated → stamp requested · nothing surfaced · slots unchanged (idempotent)
```

**Packaged smoke on the artifact:** guard present, validates against `/account/connect`, stamps all
three slots, records state, surfaces only via `ether:license-attention` — plus the earlier boot repair,
boot supervisor, startup status, `play_log` index and overlay-pool fix all still present.

## 4. Two mistakes the proof caught before shipping

1. **The guard was tree-shaken out of the build.** My edit put `startLicenseGuard()` inside
   `SessionNameBar` — a component referenced **zero** times — so vite correctly stripped it along with
   the whole module. The packaged smoke caught it: the guard's string literals were absent from the
   bundle. Moved into the real `App()` (`src/App.tsx:542`) and re-verified in the built asset.
   *A typecheck would never have found this — the code compiled perfectly and shipped as nothing.*
2. **Stale WAL contaminated the test fixture.** A crashed first run left `la.db-wal` behind; because the
   source `now.db-wal` no longer existed, the copy silently skipped and the **old poisoned WAL replayed
   over the fresh copy**, making case A report nonsense. The harness now deletes fixtures before
   copying. Recorded because a test fixture that lies is worse than no test.

## 5. What this fixes for OV

OV heals by signing in with **email + password**. The backend returns the account's current key, and it
is now stamped into all three slots — so the stale anchor is overwritten instead of outranking the
fix. No key entry, no re-activation, no database surgery, nothing for the operator to understand.

If OV's local keys are *all* dead, launch-time validation will 401, `healStaleLicense` will try the
others, and — finding none accepted — will log that it needs attention while the station keeps running.
Signing in still fixes it.

## 6. Limits, stated honestly

- **Not yet verified against a real revoked license.** Cases C are proven at the decision layer; no
  account has actually been revoked to watch it end-to-end.
- **`GRACE_DAYS = 14` is a judgement, not a measurement.** Nothing breaks at the boundary — the only
  effect is whether a notice appears.
- **The runtime receipt that counts is OV syncing again** after an email/password sign-in.

## 7. Files

- `src/lib/licenseGuard.ts` — new: pure decision fn, validation pass, launch + heartbeat + online hook.
- `src/lib/ccData.ts` — `stampLicenseEverywhere` (exported), `healStaleLicense` (bounded one pass).
- `src/components/OnboardingFlow.tsx`, `src/components/SubscriptionPanel.tsx` — both sign-in paths stamp
  all three slots.
- `src/App.tsx` — starts the guard in the real `App()`.
