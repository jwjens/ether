# Phase A — Amendment 2: Icecast Mount Automation (AD-11)

> **Amendment to**: `phase-a-execution-plan.md` + `phase-a-step-2-v8-migration-plan.md`  
> **Date**: 2026-04-29  
> **Trigger**: Prerequisite 3 execution — manual SSH to Lightsail Icecast server (44.244.52.207)  
> **Decision**: Add Icecast mount automation (AD-11 + Step 4.5) to Phase A scope

---

## Discovery Summary

Prerequisite 3 required confirming that the two station Icecast mounts (`/ov` for station 1,
`/usph` for station 3) existed on the remote Lightsail Icecast server. During execution:

- SSHed into `44.244.52.207` (Ubuntu 24.04.4 LTS, `ubuntu` user, Oregon Zone A)
- Found `/etc/icecast2/icecast.xml` with a single mount block (`/live`, 100 max-listeners)
- Added `/ov` and `/usph` mount blocks matching the `/live` config
- Restarted `icecast2` via `systemctl`
- Verified all three mounts respond (`200` or `404`) via curl

This is the last time a human should ever SSH into an Icecast server to add a mount. The original
Phase A plan had no provision for runtime Icecast mount management — every new station creation
would require the same manual SSH workflow. That does not scale to real customer deployments.

**This amendment adds Icecast mount automation as Phase A scope.**

---

## Actual Mount Assignments (replaces /live-1 and /live-3 in prior plan text)

The original plan (Step 0-B and v8 migration M6) used placeholder mount names `/live-1` and
`/live-3`. The actual mount names are now known and locked:

| Station ID | Station | Icecast mount |
|-----------|---------|---------------|
| 1 | OV | `/ov` |
| 3 | USPH | `/usph` |
| — | (legacy/default) | `/live` |

All prior references to `/live-1` and `/live-3` are superseded by `/ov` and `/usph` respectively.
The M6 SQL in the v8 migration plan is updated accordingly.

---

## AD-11: Icecast Mount Automation

> **`stations:create/update/delete` manage Icecast mounts via the Icecast Admin API.**

A new `electron/icecast-admin.js` module wraps the Icecast HTTP Admin API. The `stations:create`,
`stations:update`, and `stations:delete` handlers call into this module on every station lifecycle
event. This removes the need for manual SSH access to the Icecast server for routine station
management.

**Key design points:**

- Credentials are read from `install_secrets_kv` key `icecast_admin_credentials` (JSON blob:
  `{ url, username, password }`). This key is added to the v8 migration plan in Amendment 2.
- If the Admin API is unreachable at create time, `stations.mount_pending_provision` is set to `1`.
  A boot-time reconciliation pass retries provisioning for all unprovisioned stations.
- The three mounts on the current Lightsail server (`/live`, `/ov`, `/usph`) were created manually
  and are the last mounts ever provisioned by hand. All future mounts are created via this API.

---

## Step 4.5: Icecast Mount Lifecycle Handlers

New Phase A step added between Step 4 (IPC Surface Cleanup) and Step 5 (Native Addon Assessment).

### New module: `electron/icecast-admin.js`

```js
// Reads credentials from install_secrets_kv key 'icecast_admin_credentials'
// { url: "http://44.244.52.207:8000", username: "admin", password: "..." }

async function createMount(mountName, maxListeners = 100)
async function deleteMount(mountName)
async function listMounts()           // GET /admin/listmounts
async function reconcileMounts(db)    // process all rows with mount_pending_provision = 1
```

Icecast Admin API base URL: `http://44.244.52.207:8000/admin/`  
Auth: HTTP Basic with credentials from `icecast_admin_credentials` secret.

### Handler amendments (legacy + typed)

| Handler event | Action |
|---|---|
| `stations:create` | After DB INSERT: call `createMount(station.icecast_mount)`. On failure: set `mount_pending_provision = 1`, log error. |
| `stations:update` | If `icecast_mount` changed: call `deleteMount(oldMount)`, then `createMount(newMount)`. |
| `stations:delete` | Before or after soft-delete: call `deleteMount(station.icecast_mount)`. Failure is non-fatal — log and continue. |

### Boot-time mount reconciliation (added to Step 4 design)

In `electron/main.js`, after `setupDb()` completes, call `reconcileMounts(db)`:

```js
async function reconcileMounts(db) {
  const pending = db.prepare(
    "SELECT id, name, icecast_mount FROM stations WHERE mount_pending_provision = 1 AND deleted_at IS NULL"
  ).all();
  for (const station of pending) {
    try {
      await icecastAdmin.createMount(station.icecast_mount);
      db.prepare("UPDATE stations SET mount_pending_provision = 0 WHERE id = ?").run(station.id);
      console.log(`[IcecastAdmin] Mount provisioned: ${station.icecast_mount} (station ${station.id})`);
    } catch (err) {
      console.error(`[IcecastAdmin] Mount provision failed for ${station.icecast_mount}:`, err.message);
      // Will retry on next boot
    }
  }
}
```

### Graceful degradation contract

A station is always created in the DB regardless of Icecast Admin API availability.
`mount_pending_provision = 1` is the signal that the mount still needs to be provisioned.
Streaming will not work until `mount_pending_provision = 0`, but the station is otherwise
functional in the UI (queue, library, scheduling).

### New files

| File | Purpose |
|---|---|
| `electron/icecast-admin.js` | Admin API client — `createMount`, `deleteMount`, `listMounts`, `reconcileMounts` |

### Amended files

| File | Change |
|---|---|
| `electron/main.js` | Call `reconcileMounts(db)` at boot after `setupDb()` |
| `electron/sync/handlers/stations.js` | Call `createMount`/`deleteMount` on station lifecycle events |

---

## v8 Migration Plan Additions (Amendment 2)

Three additions to `phase-a-step-2-v8-migration-plan.md`:

### 1 — New schema change: `stations.mount_pending_provision`

Added as S3.5 (between existing S3 `mic_device` and S4 `monitor_routing`):

```sql
ALTER TABLE stations ADD COLUMN mount_pending_provision INTEGER NOT NULL DEFAULT 1;
```

`DEFAULT 1` means all existing stations are considered "pending provision" until the Admin API
confirms their mounts exist. The reconciliation task at first boot after the migration will
attempt to provision mounts for all existing stations. For the two current stations (`/ov`, `/usph`),
the mounts already exist on the Lightsail server — the Admin API call will succeed immediately and
set `mount_pending_provision = 0`.

### 2 — New secrets migration: `icecast_admin_credentials`

Added to M2 (secrets moved to `install_secrets_kv`). A third key joins `license_key` and
`cloud_backup_r2`:

| Key | Secret content |
|-----|---------------|
| `icecast_admin_credentials` | JSON: `{ "url": "http://44.244.52.207:8000", "username": "admin", "password": "<admin-pw>" }` |

This key is not currently in `station_config_kv` (it doesn't exist yet). It is seeded during
the v8 migration via a manual INSERT, or configured in Settings → Streaming → Icecast Admin.
The Admin API client (`icecast-admin.js`) reads it on every call.

### 3 — Updated M6 mount names

M6 in the v8 plan previously used `/live-1` and `/live-3` as placeholder mount names. Updated
to the actual mount names confirmed during Prerequisite 3 execution:

```sql
-- Before (superseded):
UPDATE stations SET icecast_mount = '/live-1' WHERE id = 1;
UPDATE stations SET icecast_mount = '/live-3' WHERE id = 3;

-- After (Amendment 2):
UPDATE stations SET icecast_mount = '/ov'   WHERE id = 1;
UPDATE stations SET icecast_mount = '/usph' WHERE id = 3;
```

---

## Prerequisite 3 — Reframed

**Before (original plan)**: "Lightsail Icecast: confirm `/live-1` and `/live-3` mounts configured
on the remote server — remains open; coordinate with Lightsail operator before Step 0-B."

**After (Amendment 2)**: Prerequisite 3 is closed. The one-time manual bootstrap is complete:
- `/live`, `/ov`, and `/usph` mounts are configured on `44.244.52.207:8000`
- `/ov` maps to station 1 (OV); `/usph` maps to station 3 (USPH)
- This is the last manual Icecast server configuration required for Phase A
- All future mount operations go through the Admin API (AD-11, Step 4.5)

---

## Open Items Carried Forward (4 new)

These are not Phase A blockers. Captured here to prevent loss.

### OI-A2-1 — Multi-Icecast-server support

The current design assumes one Icecast server per Ether install (`icecast_admin_credentials` is a
single install-level secret). A multi-tenant or large-deployment scenario may require multiple
Icecast servers — e.g., one per facility, one per geographic region, or one per plan tier.

**Deferral rationale**: Premature for current deployment (one server, two stations). The
`icecast_admin_credentials` key is already JSON-valued — extending it to an array of server objects
is a non-breaking expansion when needed.

**Action when triggered**: Extend `install_secrets_kv` to support `icecast_admin_credentials_*`
keyed variants, or migrate to a dedicated `icecast_servers` table. Add `icecast_server_id` FK
to `stations` table.

### OI-A2-2 — Customer-onboarding Icecast configuration

When a new customer installs Ether, they must configure their Icecast server connection before
stations can stream. Currently there is no UX for this — the `icecast_admin_credentials` secret
is populated manually.

**Action**: Add an Icecast server setup step to the first-run wizard. Test the connection and
display mount status. Gate streaming features on `icecast_admin_credentials` being set and
verified.

### OI-A2-3 — Icecast server provisioning automation

The Lightsail Icecast server was provisioned manually (installed, configured, started). For
customers who don't run their own Icecast server, Ether could provision one automatically —
either by launching a Lightsail instance from the app or by offering a managed Icecast relay
service.

**Action**: Design as a post-Phase-A feature. Requires Ether backend API with cloud provisioning
capability. Out of scope for Phase A.

### OI-A2-4 — DNS / public hostname for Icecast

The current Icecast URL is a bare IP address (`44.244.52.207`). Icecast stream metadata sent to
listeners and embedded in stream headers uses this IP. A public hostname (e.g., `stream.ether-technologies.com`
or `radio.ovbroadcast.com`) is needed before public listener URLs are shared.

**Action**: Assign a DNS hostname to the Lightsail static IP. Update `icecast_admin_credentials`
URL. Update any hardcoded IP references in the codebase. This is a DNS/ops task, not a code task —
but it must happen before any public stream URLs are distributed.
