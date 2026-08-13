# Why two machines on one account have different calendars (2026-08-12)

**Report (Jeff, verbatim):** *"Two machines logged into the same account (OV and dev) have different
calendars, queues, and songs. Sync should be automatic — it was working before, now it's not."*

**Method:** read-only DB, the health ledger (`%APPDATA%\Ether\health-events.jsonl`), and the code.
Nothing was written to the live database.

---

## 1. What is actually true on dev

| Fact | Value |
|---|---|
| `sync_enabled` | **absent** — never set, on any station |
| `sync_backend_url` | **absent** |
| `sync_*` keys in `station_config_kv` | **none at all** |
| `replication_peers` | empty |
| mutations | **385,755**, every one `sync_status='pending'`, `origin='local'` |
| oldest / newest mutation | 2026-07-06T17:44Z / today |
| mutations ever synced | **zero** |
| `account_jwt` / `account_email` | present — `jensj@opportunityvillage.org` |
| `account_license_key` | `ETH-STN-BAA8-E056-6FC8`, `license_state = ok` |
| `songs` / `songs_v2` | 543 / 350 · snapshot version 350, stamped **2026-07-06** |

**The mutation sync engine has never run on this database, not once, since the DB was created on
2026-07-06.** That is not an opinion — there is not a single mutation in any state other than
`pending`.

## 2. There are five channels, and only one of them carries the calendar

| # | Channel | Carries | Gate | State on dev |
|---|---|---|---|---|
| 1 | Account/station reconcile | the station list | account JWT | **running, failing intermittently** (§4) |
| 2 | Library sync (`runLibrarySync`) | song *metadata* → `songs_v2` | JWT + license, **always on** | ran once 2026-07-06, never advanced |
| 3 | CC mirror (`/api/account/data/sync`) | categories, clocks, shows, spots | license key | running (dashboard mirror) |
| 4 | Cloud backup / restore | whole DB, on demand | manual | not involved |
| 5 | **Mutation sync engine** | **`generated_schedule` — the calendar** | **`sync_enabled`** | **never run** |

**Only channel 5 syncs the calendar, and the queue is not synced by anything** — it is daemon-local
per-machine state by design.

So: the songs partly line up because channel 2 is always on. The calendars have never had a live
path between machines. **This has not regressed — it has never been switched on on this install.**
That does not make the report wrong: two machines on one account showing different logs is a real
product failure. It is just not a regression, and chasing "what broke recently" would have been
chasing nothing.

## 3. THE BUG — the switch does not switch anything on

`SettingsPanel.tsx:1139` (Settings → System → Multi-Device Sync):

```js
await ether.stationConfigKv.upsertByKey(stationId, 'sync_enabled', next ? 'true' : 'false');
```

It writes `sync_enabled` **and nothing else**. And `sync_backend_url` is written by **no UI anywhere
in the tree** — the only readers are two repair scripts.

`main.js:2798`:

```js
const baseUrl = urlRow?.value || process.env.ETHER_SYNC_URL || '';
```

With the key absent and no env var, **`baseUrl` is the empty string**. The transport is constructed
pointing at no host, the scheduler starts, the Settings panel reports **Running**, and not one
mutation can ever leave.

**So even if Jeff had found the toggle and switched it on, sync would still not have worked — and it
would have looked like it was working.** That is the defect, and it is the same shape as every other
one found today: a control that reports success while doing nothing.

### This was predicted a month ago and never closed

`docs/mirror-regression-diagnosis-2026-07-14.md` §"Restore path", step 2:

> *"Verify it also sets `sync_backend_url` = the Railway URL above; **if not, set that too (else
> `baseUrl=''` and the push has no host)**."*

It was not set, and the toggle was never changed.

## 4. The cloud reconcile IS failing — but it is not the calendar

From the ledger:

```
2026-08-11T09:22:07  cloud-reconcile-down   Failed to fetch (ether-backend-production.up.railway.app)
2026-08-11T09:22:27  cloud-reconcile-up     failures: 1
2026-08-11T14:41:27  cloud-reconcile-down   Failed to fetch
2026-08-11T15:03:48  cloud-reconcile-up     failures: 67
2026-08-12T14:38:22  cloud-reconcile-down   Failed to fetch
2026-08-12T15:02:57  cloud-reconcile-up     failures: 74
2026-08-12T23:41:21  cloud-reconcile-down   Failed to fetch
2026-08-13T00:22:35  cloud-reconcile-up     failures: 124
```

The Railway backend is intermittently unreachable from this machine, and the consecutive-failure
count is **climbing across the day: 1 → 67 → 74 → 124**. Each episode recovers, and the last event is
a recovery — so it is up as of the last entry.

This is channel 1 (the station list), not the calendar. It is worth watching on its own account: a
backend that drops for 40 minutes at a time will also affect the mutation sync once that is running.

## 5. What was fixed

1. **`main.js`** — `baseUrl` now falls back to `ETHER_BACKEND_URL`, the same backend every other
   account call already uses. A stored value still wins.
2. **`main.js`** — if a URL still cannot be resolved, the scheduler **refuses to start** with a loud
   error and a `sync-misconfigured` health event, instead of running an engine that can reach
   nothing. It also logs `[SYNC] enabled — backend <url>` when it does start, so "is it pointed
   anywhere" is answerable from the log.
3. **`main.js`** — the `sync_enabled` read now filters `deleted_at IS NULL`; a tombstoned row could
   previously still switch sync on.
4. **`SettingsPanel.tsx`** — the toggle now writes `sync_backend_url` alongside `sync_enabled`, so
   the stored configuration is self-describing and the repair scripts work against it.

**Sync was NOT switched on.** See §6.

## 6. Why I did not switch it on

Three reasons, and any one of them is enough:

1. **385,755 pending mutations would begin draining** at ≤500 per round to a live backend. That
   backlog needs a decision (drain, checkpoint, or compact) before the tap is opened — it was
   flagged this morning and agreed.
2. **`sync_uuid_identity` is OFF**, and the peer engine routes and merges station-scoped rows by the
   **local integer station id**, not the stable UUID. Dev's stations are ids 1–4; OV's local ids are
   whatever that install assigned. If they differ, syncing now does not merge the two machines — it
   **mixes stations up**. This is the known defect recorded as the peer-sync station-identity item.
3. **Writing the live database from outside the app while Ether is running risks corrupting it** —
   the standing rule. The supported path is the app's own toggle.

## 7. What to do, in order

1. **Install 4.4.202** on both machines. Nothing changes until sync is switched on.
2. **Decide the mutation backlog.** 385k pending on dev. Options: drain it (slow, and it publishes
   every local edit since 2026-07-06), or checkpoint/baseline so only new mutations flow.
3. **Decide `sync_uuid_identity`.** It should almost certainly be **on** before two real machines
   sync, or §6.2 applies. This needs its own verification.
4. **Then** switch on Settings → System → Multi-Device Sync, on one machine first, and **restart the
   app** — the scheduler is built once at startup, which the panel already says ("Starts on next
   launch").
5. Watch `[SYNC] enabled — backend …` in the log and the mutation `sync_status` counts move off
   `pending`.

## 8. The honest summary

- **Not a regression.** Calendar sync has never run on this install.
- **A real bug, now fixed:** the switch that turns sync on never configured where to send, so turning
  it on would have produced a sync engine that silently moved nothing.
- **A real outage, ongoing:** the Railway backend drops out for stretches, with the failure count
  rising through the day.
- **Two decisions are still open** — the 385k backlog and UUID identity — and both must be settled
  before sync between OV and dev is safe rather than merely on.
