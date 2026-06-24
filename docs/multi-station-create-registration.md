# Multi-station: create → register → own (root-cause fix)

Status: **PLANNED** (not started). Implement AFTER v4.4.14 is confirmed working on the box.
Owner: Jeff. Author of plan: from the 2026-06-23 HalloVeen go-live session.

## Why this exists

The account is the root of everything: account → license → stations → DB → library. A station is
only publishable / cloud-syncable when it exists in the **backend** `stations` table under the
account's license **and** the local row carries the matching `owner_license_key`.

HalloVeen (OV's 2nd station) was created on the box but ended up an **orphan**:
- local `stations` row id 10, uuid `e7041ae5-…`, **`owner_license_key = NULL`**
- **no backend row at all** (backend only knew OV + US Phenomenon)

→ Publish failed ("this station isn't linked to your account"), because there was nothing in the
cloud to attach a public page to. It was backfilled MANUALLY (see
`memory/project_ov_license_migration.md`): inserted a backend `stations` row preserving the local
uuid + `license_key_id=19`, and stamped the local `owner_license_key`.

This will hit **every** new station (#3, #4, …) until the create flow is fixed.

## The catch — a registration path supposedly already exists

The wiki note for **v4.3.77** says: *"Creating a station with + Add Station registers it with your
account, so it can be published."* So something is meant to register new stations already, yet
HalloVeen slipped through. **Step 1 is to find out why**, before adding more code:

- Was HalloVeen created **offline / not signed in**? (The backend register endpoint needs both, and
  nothing retries later → permanent orphan.)
- Was it created through a **different path** than "+ Add Station" (e.g. an older/alternate creator,
  an import, a dev action)?
- Did the register call **fail silently** (swallowed error)?

## Relevant code

- `electron/main.js` → `ipcMain.handle('stations:create', …)` (~line 5535) → `stationsCreate(db, …)`
  in `electron/sync/handlers/stations.js`. Accepts an optional explicit `uuid` (OnboardingFlow passes
  the backend's uuid — the **OB18** pattern — so local and cloud agree).
- Backend `POST /api/account/stations` (`ether-backend/src/index.js:2265`, `requireAuthAdmin`):
  INSERTs a `stations` row **and mints its own `crypto.randomUUID()`** (does NOT accept a caller uuid),
  plus a peer-sync `mutations` row so other installs pull the station.
- `src/lib/ccData.ts` → `reconcileAccountStations(licenseKey)` runs every ~20s, **strictly additive**
  (creates missing local stations from the account; never deletes). Natural home for backfill.

## Planned fix (make it robust, not just present)

1. **Stamp `owner_license_key` at creation** from the signed-in account's license (HalloVeen's was
   NULL). This is local and unconditional — even offline.
2. **Register with the backend** using the account session. Because `POST /api/account/stations`
   mints its own uuid, prefer the **OB18 pattern**: register first, then create the local row with the
   **backend-returned uuid** (avoids the duplicate-uuid drift that bit OV — see
   `docs/sync-station-identity-uuid-reconciliation-plan.md`). If a local row already exists (created
   offline), adopt the backend uuid onto it once registered.
3. **Backfill / self-heal** orphans: in `reconcileAccountStations` (or a sibling pass), any LOCAL
   station with no backend counterpart and/or a NULL `owner_license_key` gets registered + stamped the
   next time the install is online and signed in. So an offline-created station heals itself instead
   of silently staying an orphan.
4. **No silent failure**: surface a register failure to the operator (or log + retry) rather than
   leaving the station local-only with no signal.

## Decisions / open questions

- uuid authority: adopt backend-minted uuid (recommended, matches OB18) vs. teach the backend endpoint
  to accept a caller-supplied uuid. Recommendation: adopt backend uuid; it's the established pattern.
- Offline creation policy: allow create offline + backfill on reconnect (recommended), vs. block
  create until online+signed-in (v4.3.77 reportedly required online — confirm current behavior).
- Where the backfill lives: extend `reconcileAccountStations`, or a dedicated one-shot on
  sign-in + a periodic sweep.

## Verification

- Create a 3rd station offline → confirm it registers + becomes publishable once back online.
- Create a 3rd station online → confirm immediate backend row + `owner_license_key` set + publish works.
- Confirm no duplicate-uuid drift (local uuid == backend uuid) for both paths.
- The only valid test of publish is the actual Public Page editor succeeding, not a DB query.
