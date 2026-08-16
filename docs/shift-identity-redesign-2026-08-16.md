---
feature: shift-identity
title: Shift identity from memberships — design
summary: Deleting the separate "operator" concept and taking shift identity from the profile's members. Design only; nothing built.
audience: programmer
status: DESIGN ONLY — no code written
---

# Shift identity from memberships — design (2026-08-16)

**Jeff's ruling:** the separate "operator" concept is deleted. Whoever enters their PIN is on shift;
their name and privileges come from the membership record. "Add operator" goes away.

**This document is design only.** Nothing has been built. §4 is the honest gate on timing, and it
answers *no* — see it before reading the rest.

---

## 1. READ-ONLY INVENTORY — three identity systems, not two

The ruling assumes one system ("the profile's members") with names, PINs and privileges. There are
**three**, and no two of them are joined.

### 1.1 `operators` — the thing to delete

| | |
|---|---|
| Lives | `operators` table, profile `openair.db`, **station-scoped** |
| Read at | `src/components/OnShiftScreen.tsx:84` — `queryScoped("SELECT id, name, initials FROM operators ORDER BY id", [], stationId)` |
| Written at | `OnShiftScreen.tsx:214` — `ether.operators.create({ station_id, name, initials })` |
| Carries | `name`, `initials`. **No PIN. No privileges. No role.** |
| On this machine | 4 rows — `jeff (j)`, `Jeff (J)`, `Jeff (J)`, `jeff (j)` — one per station |

Purely a display roster. It has never authenticated anything.

### 1.2 `users` — where PINs actually live

| | |
|---|---|
| Lives | `users` table, profile `openair.db`, has a `station_id` column |
| Read at | `src/components/UserLogin.tsx:60` — `query("SELECT * FROM users ORDER BY id")` — **NOT station-scoped** |
| Written at | `UserLogin.tsx:105` — `INSERT INTO users (name, role, pin_hash, color, station_id)` |
| Carries | `name`, `role`, **`pin_hash`**, `color`, `station_id` |
| Verified at | `UserLogin.tsx:72-74` — `ether.users.verifyPin(pin, selected.pin_hash)` |
| On this machine | **1 row — "Admin"** |

This is the PIN gate that already runs after account sign-in. Note the read at `:60` is unscoped
while the write at `:106` filters by `station_id` — an existing inconsistency, and the reason the
PIN screen still works on this laptop while the shift screen does not.

### 1.3 Memberships — **not in the profile DB at all**

| | |
|---|---|
| Lives | **The backend.** `src/lib/memberships.ts:37` — `fetch(${ETHER_BACKEND_URL}/api/me/memberships)` |
| Auth | `Authorization: Bearer <account_jwt>` (`memberships.ts:23-28`, read from `install_config_kv`) |
| Carries | `position`, `label`, `rank`, `permissions{}`, `all_stations`, `stations[]`, `status` |
| **Does NOT carry** | **any PIN, any pin_hash, any local credential** (`Membership` interface, `memberships.ts:8-21`) |
| Offline | Returns `[]` — `memberships.ts:32` (`no token`), `:39` (`!res.ok`), `:43` (`catch`) |
| Cached locally | **No.** No table, no KV, no file. Every read is a live HTTP call |

Consumers today are display-only: `ActiveStationBadge.tsx:27` and `SettingsPanel.tsx:1329`, both of
which render nothing when the list is empty (`SettingsPanel.tsx:1331`).

### 1.4 The answer to "do memberships survive migration and sync?"

**Neither.** They are not in the profile, so the profile migration has nothing to carry. They are not
in `mutations`, so sync never sees them. They survive only in the sense that the backend still holds
them and the app re-fetches when it has a token and a network.

---

## 2. DESIGN — START MY SHIFT → PIN → member

The target is right. What it needs that does not exist today:

### 2.1 The missing join: a PIN per member

A membership has no credential. A `users` row has a credential but no privileges. The design needs
one record with both. The smallest honest shape:

- **Local table `members`** in the profile DB (or `users` extended — see §3), carrying
  `membership_id`, `account_id`, `name`, `pin_hash`, `rank`, `permissions` (JSON), `synced_at`.
- **Backend owns the roster; the machine owns the PIN.** A PIN is a local unlock for a physical
  studio, not an account credential — it must never round-trip to the backend, and it must keep
  working with the network down.

### 2.2 Offline is the hard requirement, not an edge case

A transmitter with no network must still let someone start a shift. That forces a **local cache
refreshed opportunistically**: on sign-in and on each successful `fetchMyMemberships()`, upsert into
`members`; the shift screen reads the cache, never the network. Without this, a broadband fault
locks the operator out of their own studio — strictly worse than today's roster, which is local.

### 2.3 The owner is inherently a member

Correct and cheap: seed a `members` row from `install_config_kv.account_email` +
`station_config_kv.license_email` at profile adoption. No setup step, and it is the one row that must
exist before any network call, so it cannot depend on the backend being reachable.

### 2.4 The flow

```
START MY SHIFT → PIN pad → match pin_hash in members
  → greeting from members.name          ("Good afternoon Jeff")
  → ON SHIFT shows that member
  → privileges from members.permissions
```

`UserLogin.tsx` already implements the PIN pad, hashing and verification (`:72-74`, `:104-105`) — it
is re-pointed at `members`, not rebuilt.

### 2.5 One roster, one place

Adding people happens in the existing membership UI (backend), plus a local "set this person's PIN"
step, because the backend has no PIN to give. That second step is unavoidable and should be stated
plainly rather than designed around.

---

## 3. MIGRATION of existing operators

On this machine the 4 `operators` rows are `jeff/Jeff` duplicated once per station — an artifact of
`operators` being station-scoped while a person is not. There is nothing worth folding.

**Proposed:** fold DISTINCT `operators.name` into `members` where no member of that name exists,
with a null `pin_hash` (so they appear but must have a PIN set once). Then drop the read at
`OnShiftScreen.tsx:84`, the create at `:214`, the "+ Add operator" button at `:315`, and retire the
table in a later migration — never in the same release that stops reading it.

---

## 4. MONDAY IMPACT — **no. This must not ride into Monday's installer.**

### 4.1 It is not small

The ruling's premise — "members table already in the profile, shift screen just re-pointed" — is not
the case. The build requires:

1. a new local `members` table + migration (schema_version bump, and `verify-main-schema` gating)
2. a PIN store attached to memberships — **a credential design**, on the front door of the app
3. an offline cache with a refresh policy, or a studio that locks out when broadband drops
4. re-pointing `UserLogin` (the account gate's second half) and `OnShiftScreen`
5. an owner-seeding path at profile adoption
6. a data migration folding operators in

Items 2 and 3 are the ones that make this a week, not an evening. Everything else is mechanical.

### 4.2 4.4.220's shift screen works — the greeting is broken by something else entirely

The missing "Good afternoon Jeff" is **not** a design problem. It is the station re-key: `operators`
rows still point at station ids `1,2,3,4` while the stations are now `5,6,7,8`, so the scoped read at
`OnShiftScreen.tsx:84` matches nothing. Thirteen other tables are in the same state (1,617 rows).

**Repairing those orphans restores the greeting on the existing code**, with no redesign.

### 4.3 OV is not affected at all

The re-key is caused solely by `sync_uuid_identity`, which OV has never enabled and which
`docs/ov-update-checklist.md` §4 says to leave off. **OV has no orphaned operators**, so OV's shift
screen on 4.4.220 behaves exactly as it does today — names and all. There is no degradation to ship
around.

### 4.4 Recommendation

**Ship 4.4.220 to OV as-is.** The shift screen is not impersonal there; it is unchanged. Land this
redesign next week, without a transmitter as the deadline — a PIN/credential change to the app's
front door, 48 hours before the live machine updates, with no way to test it against a second real
studio first, is the kind of change that produced this weekend's incident.

The one thing that IS needed before Monday is unrelated to this document: finishing the orphan repair
so the laptop matches OV's behaviour, and so testing on the laptop means anything.

---

## 5. Receipts

| Claim | Receipt |
|---|---|
| operators is station-scoped display-only | `OnShiftScreen.tsx:84`, `:214`, `:315` |
| PINs live in `users` | `UserLogin.tsx:60`, `:72-74`, `:105` |
| memberships are remote | `memberships.ts:37` — `fetch(.../api/me/memberships)` |
| memberships carry no PIN | `memberships.ts:8-21` (`Membership` interface) |
| memberships return [] offline | `memberships.ts:32`, `:39`, `:43` |
| memberships have no local cache | no table, no KV key, no file — grep of `src/` + `electron/` |
| greeting broken by the re-key, not by design | `operators` 4 rows at station_id 1–4; stations are 5–8 |
| OV unaffected | re-key requires `sync_uuid_identity`; OV has it off (`ov-update-checklist.md` §4) |

**Nothing built. No code written. No files changed.**
