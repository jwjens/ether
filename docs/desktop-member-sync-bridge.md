# Scope: desktop member sync-bridge — operate a cross-account station (design, no code)

Status: **SCOPE ONLY. No code.** Date: 2026-06-22
Goal: a member (e.g. djdeniro, an active PD on OV's account with `edit_programming` + `can_edit` on the
OV station) can **operate** that station on the desktop and have its programming sync both ways — not
just *see* it. Today the desktop only *displays* accessible stations (view-only); operating them is the
unbuilt "Plan A sync bridge."

## What already works (verified live — do NOT rebuild)
- `GET /api/me/memberships` — returns the member's accessible accounts + stations. Confirmed live:
  djdeniro (uid 7) → OV account (acct 19, `jensj@opportunityvillage.org`), position `pd`,
  `edit_programming:true`, station "Opportunity Village" (uuid `21606342-…`), `can_edit:true`, active.
- `POST /api/me/switch-account/:accountId` — re-mints a member token scoped to the switched account
  (exists, from the RBAC backend work).
- `GET /api/accounts/:accountId/stations` — account-context station list (exists).
- **The `/sync` gate** — `requireLicenseOrMember` accepts a member Bearer JWT, authorizes it for the
  member's account (active membership + `edit_programming` + scope), PULL+PUSH through one pipeline.
  **Deployed + `RBAC_MEMBERSHIP_SYNC=1` ON in prod.**
- **Tier-2 UUID-identity** — makes cross-machine programming converge. Deployed (flag default off).
- Client: `lib/memberships.ts` (`fetchMyMemberships`), `account_jwt` persisted in `install_config_kv`,
  the view-only "ACCESSIBLE VIA YOUR ACCOUNT" section in `ActiveStationBadge`.

## What's missing (all desktop-client side)
1. **No operate/select path** — accessible stations are display-only; you can't make one the active,
   operable station.
2. **No member auth on the sync transport** — `HttpTransport` sends `x-license-key`; a member must send
   the **member Bearer token** (no license key) for the other account. The gate accepts it; the client
   never sends it.
3. **Sync engine isn't run in a member/other-account context** — nothing scopes the local DB + sync
   engine to OV's account + the accessible OV station.
4. **`sync_uuid_identity` is off** on this install (needed for cross-machine convergence once 1–3 exist).

## The model decision (recommended)
Reuse **account-is-root**: operating a member-accessible station = a **scoped account-context switch**,
member-authorized instead of license-owned. The member's install becomes an OV *terminal* for the
station(s) they can access — exactly the "machine is a terminal, the account is everything" principle.
This reuses the existing per-account DB-swap (sign-out/in already swaps the local DB and shows only that
account's stations); the new part is entering an account context the user is a **member** of, not owner.

Single-tenant-at-a-time stands: switching to OV leaves djdeniro's own (Dj Deniro) context; switch back
to return. (Alternative — surfacing OV as an extra operable station inside djdeniro's own context —
breaks single-tenant-per-install and the `owner_license_key` station scoping; rejected.)

## End-to-end flow
1. **Select** — in the "ACCESSIBLE VIA YOUR ACCOUNT" list, "Operate this station" on OV.
2. **Switch token** — `POST /api/me/switch-account/19` → member token scoped to OV (lk = OV account).
   Store it (install-level, e.g. a `member_account_jwt` in `install_config_kv`).
3. **Enter OV context** — swap to an OV-account-scoped local DB (reuse the account-switch DB-swap);
   pull OV's station row + programming for the accessible station(s).
4. **Sync auth as member** — `HttpTransport` sends `Authorization: Bearer <member token>` (no
   `x-license-key`) when in a member context. The deployed gate authorizes.
5. **Run sync** — sync engine with `uuidIdentity` ON (`sync_uuid_identity=true`), `getStationUuid` =
   the OV station uuid; PULL+PUSH converge by UUID (Tier-2, already proven in the harness).
6. **Operate** — edit programming / go on air **gated by the membership permissions** (`can_edit`,
   `edit_programming`, `go_on_air`); edits push under OV's account license_key_id.
7. **Exit** — switch back to djdeniro's own account (restore their DB context + token).

## What it touches (client)
- **`ActiveStationBadge` / `OnboardingFlow`** — make the accessible entries selectable → trigger the
  switch; reflect the active member context; gate edit/on-air UI by membership permissions.
- **A switch-account client call** + member-token storage (`install_config_kv`).
- **`electron/sync/transport-http.js`** — send the member Bearer token instead of `x-license-key` when
  in a member context (a context flag/getter, not a global change — keep `x-license-key` for owned).
- **`electron/main.js` sync wiring** — construct the scheduler/engine with the member token + OV account
  scope + `uuidIdentity:true` + `getStationUuid` (the last two already exist).
- **Local DB/account-context** — scope to OV's account (reuse the account-switch DB-swap path).
- **Set `sync_uuid_identity=true`** on this install (and the OV machine — it must match).

## The whole-account-scope constraint (real backend tweak likely needed)
djdeniro's OV membership is `all_stations:false` with **one** station. The gate currently keeps a
**whole-account scope** guard (refuses a partial-account subset). Two cases:
- If OV's account (acct 19) has **only** that station → member scope == whole account → allowed as-is.
- If it has **more** stations → the gate refuses djdeniro's partial scope today. **With Tier-2 the pull
  keys on `station_uuid`, so per-station filtering is now feasible** — relax the guard to per-station-UUID
  scoping for partial-access members. Confirm acct-19's station count to know if this is required for OV.

## Risks / decisions to settle before building
- **Account-context switch vs. concurrent** — recommend switch (single-tenant). Confirm that's acceptable
  UX for a PD flipping between their own station and OV.
- **DB scoping** — separate per-account DB context (clean, reuse swap) vs. shared (complex). Recommend
  separate.
- **Partial-account gate relaxation** — needed if acct-19 has >1 station (above).
- **Member token lifecycle** — the re-minted token's expiry/refresh while operating; re-mint on 401.
- **Permission enforcement client-side** — a view-only/`can_edit:false` member must not be able to edit
  or go on air; enforce from the membership permissions, not just the backend.
- **Both machines on `sync_uuid_identity`** — the OV machine must also have it on, or convergence is
  one-sided (the Tier-2 dependency).

## How to prove
- **Harness**: extend `prove-dj-bidirectional` to authenticate through the REAL member path — mint a
  member JWT, `switch-account`, hit `/sync` as a Bearer member (gate on), pull OV + push edits, assert
  convergence. (Today's proof models the gate as "already authorized"; this exercises the real gate.)
- **Real two-machine**: djdeniro selects OV on the desktop → OV programming appears + is operable → edit
  on djdeniro shows on the OV machine, and an edit on the OV machine shows on djdeniro.

## Not in scope / sequencing
- No code here. Backend is largely ready; this is the **client** bridge + the one possible gate tweak
  (partial-account UUID scoping) + turning `sync_uuid_identity` on for both machines.
- Sequence: switch-account+token → member-auth transport → member-scoped sync engine/DB context → UI
  select + permission gating → flag on both machines → prove (harness, then two-machine).
