# Account Users & Role-Based Access (RBAC) — Design

**Status:** Spec / not started. Design end-to-end before implementing.
**Spec'd:** 2026-06-21 (Jeff).
**Related:** `docs/account-license-architecture-v4.5.md` (account-vs-license), the cross-account `library_grants` feature (explicitly NOT the tool for this — see §2).

---

## 1. The requirement

An account holds **multiple people** — each a login (email), with a **position/role** (PD, MD, President, Engineer…) and a **scope of which stations** in the cluster they can access and edit. A PD, an MD, a president, and an engineer all reaching and editing a cluster of stations is the correct broadcast model (Zetta / WideOrbit do exactly this), not a bad one.

Specific points from the spec:
- **Managed on the platform admin console** (platform.ether-technologies.com): add an email → assign a position → assign which stations it can access.
- **Delegated administration:** a **PD controls their own employees' access** — which employees exist and which stations each can reach/edit. Roles are a hierarchy, not flat; the platform owner sits above the PD.
- **For Network & Enterprise tier accounts**, this same user management must also live **in the app backend** so those clients self-serve their own people in-app, not only from the platform.
- Compatible with **single-tenant-per-install** (one account per install at a time; an account has many users).

## 2. What this is NOT

- **NOT onboarding / signup.** That flow (ether-signup) is a *new customer creating a new account*. This is *managing people inside an existing account*.
- **NOT the library-grant** (`library_grants`, owner→grantee cross-account library loan). That is account-to-account *content sharing*; it was the wrong tool reached for when the real need is *multiple logins on one account*. Leave the grant feature for genuine cross-org library sharing; it does not belong in this build.

## 3. Current state (what exists today)

Grounded in `C:\ether-backend\src\index.js` and the consoles.

| Piece | Table / location | State |
|---|---|---|
| Account identity | `licenses` (index.js:269) | 1 license = 1 account |
| Email+password logins | `users` (index.js:323), FK `license_key_id` | **Many emails CAN attach to one license already** (one-to-many). NO role column. |
| Operator logins | `account_users` (index.js:503): username, PIN, `role` ('admin'\|'user'), `origin` ('dashboard'\|'install') | Many per license. **Has a coarse role** (admin/user) only. |
| Stations | `stations` (index.js:420), FK `license_key_id` | Many per license. **No per-user scoping.** |
| Seats / machines | `license_activations` (index.js:281) | Per-license, plan-capped (free=1, paid=5). Not per-station. |
| Login paths | `/api/user/login` (users), `/api/auth/login` (account_users PIN), `/api/auth/owner-login`, `/api/platform/login` | JWT claims carry `lk` (license), `role`, `typ`. |
| Auth gates | `requireAuth`, `requireAuthAdmin` (role==='admin'), `requirePlatform` | Admin-only mutations gated globally, not per-station. |
| Web user management | `UserManagement.tsx` + `GET/POST /api/account/users` (index.js:2127) | **Read-only in the dashboard today** — "remote user management is coming in a later update." Create/PIN-reset endpoints exist but UI is list-only. |
| Desktop in-app profiles | local SQLite `users` (admin\|jock\|music_director) | SEPARATE, install-local; sync UP only (mirror to `account_users` origin='install'); never synced down. |

**Bottom line:** the data layer is half-there (multi-email-per-account exists; a coarse role exists), but **positions, per-station scoping, delegated admin, and write-capable management UI do not.**

## 4. Gaps to build

1. **Position/role taxonomy** beyond `admin|user` — PD, MD, President, Engineer (+ owner/platform above). Each maps to a permission set.
2. **Per-station access scoping** — a new mapping (user ↔ station, or user ↔ station-group) so a user reaches only their assigned stations. None exists today; all users see all stations for the license.
3. **Delegated administration** — a PD-tier role can create/edit/scope employees *within their own station scope*, not just a global admin.
4. **Write-capable platform management UI** — add email → assign position → assign stations (currently read-only).
5. **In-app management for Network/Enterprise tiers** — surface the same user management inside the desktop app's backend for those plans.
6. **Down-sync / unification** — decide how account-level users (email + role + station scope) reach the desktop install (today only install→backend mirroring exists; web-created users don't flow down).

## 5. Proposed design (to be refined in planning)

**Data model (additive):**
- Extend the per-account user record with a richer `position` (enum/lookup) alongside the existing `role`, OR introduce a `positions`/`roles` lookup table if positions must be configurable per account.
- New table `user_station_access(user_id, station_uuid, can_edit, granted_by, created_at)` — the per-station scope. Absence of a row = no access. A `*`/all-stations shortcut for account-wide roles (owner/president).
- Decide the canonical user table: consolidate on `users` (email+password, already one-to-many per license) as the cloud identity, with `account_users` remaining the PIN/operator projection — or unify. **This is the central design decision (see §7).**

**Permissions:**
- Define a position→permission matrix (manage-users, edit-programming, edit-stations, go-on-air, billing, etc.).
- Enforce per-station: extend `requireAuthAdmin`-style gates to check `user_station_access` for the target station, not just a global admin flag.

**Delegated admin:**
- A PD can manage users whose station scope ⊆ the PD's own scope. The platform owner/president has account-wide scope.

**Management surfaces:**
- Platform console (god-mode + account owner): full CRUD — add email, assign position, assign stations.
- Network/Enterprise app backend: same CRUD scoped to the account, gated by tier.

**Login/auth:**
- JWT already carries `lk`; add resolved station-scope (or resolve per-request) so the app/console only shows permitted stations.

## 6. Tiering

- Platform management: available to platform staff + account owners.
- **In-app self-service user management: Network & Enterprise only** (gate by `licenses.plan`).

## 7. Open decisions (for planning / Claude Desktop)

1. **Users vs account_users:** consolidate to one cloud user model, or keep email-login (`users`) and PIN-operator (`account_users`) as two projections of one person? Today they are separate and only loosely related.
2. **Station grouping:** scope users to individual stations, or to station-groups/clusters (likely needed at Enterprise scale)?
3. **Position set:** fixed enum (PD/MD/President/Engineer/Jock) or account-configurable positions?
4. **Down-sync model:** how account users + scopes reach the desktop install (extend the existing `/api/account/users/sync`, which is currently install→backend only).
5. **Migration:** existing single-owner accounts → owner gets account-wide position; no disruption.

## 8. Relationship to other work

- Sits on top of the deferred **account-vs-license** refactor (`docs/account-license-architecture-v4.5.md`): "the account is the root." This RBAC layer is what makes the account-as-root real for *people*.
- Desktop **in-app profiles** stay as in-app operator logins; this is the *cloud account* layer above them. Decide the bridge (does a cloud user auto-provision a matching install profile?).
