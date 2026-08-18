# Fix pass — closing the re-key recurrence, 2026-08-17

**Hand this to a fresh session. It is self-contained.**

Closes the recurrence path left open by `docs/fix-pass-2026-08-17-sync.md` §2. Branch
`log-reader-flip`, HEAD `e190a63` (4.4.224). **No version bump. Nothing committed.**

> ## ⚠️ NOT VERIFIED — read this first
>
> **The test suite was never run against these changes.** Both shell sessions died before the edits
> were made (`echo` itself returned exit 1), so nothing in this pass has been executed: not the tests,
> not a build, not the app. Every claim below is a claim about the source, not about observed
> behavior.
>
> **Run `npm run test:sync` before trusting any of it.** Expect 42 existing + 5 new. If the new tests
> do not pass, the fix is wrong or the tests are — do not assume which.
>
> Also still outstanding from the previous pass: delete `electron/sync/tests/zz-probe.test.js`.

---

## The defect

`merge-engine.js` applies inbound rows with `INSERT OR REPLACE`, and `uuid` is UNIQUE — so a REPLACE
**deletes** the local row and re-inserts it under whatever integer `id` the payload carried. Integer
ids are per-machine AUTOINCREMENT values; the sender's is always meaningless here.

4.4.220 fixed this by resolving the local id from the uuid — but gated the fix on `this._uuidIdentity`,
a flag read **once** at engine construction (`main.js:3027`) from the *active station's* config. So:

- a peer whose flag was `'false'` re-keyed this machine anyway
- the flag could not be changed without a full restart (`restartRequired: true` was accurate)
- and until 4.4.224 the flag was read unscoped, returning an orphan row's value

Net effect, twice: OV pushed its stations as ids 1–4, this install's 5–8 were REPLACE-deleted and
re-inserted as 1–4, and 137,878 `generated_schedule` rows plus 48,099 `play_log` rows were orphaned.
The second time was *after* 4.4.220 shipped the fix.

---

## Part A — identity preservation is unconditional

`electron/sync/merge-engine.js`. The gate is gone. Three cases, none of which consult a flag:

| Local state | Action | Why |
|---|---|---|
| row exists, `id` set | write **that** id | a REPLACE re-inserts under it; every local reference survives |
| row exists, `id` NULL | let the incoming id through | the one legitimate id move (shows null→real, [N-108c]) |
| no local row | **omit `id`**, let SQLite assign | writing the sender's integer is the second data-loss path — see below |

```js
let localRow;                    // undefined = no id/uuid pair on this table; null = new row here
if (row_id) {
  try { localRow = db.prepare(`SELECT id FROM ${table_name} WHERE uuid = ?`).get(row_id) ?? null; }
  catch (_) { localRow = undefined; }
}
const localId = (localRow && localRow.id != null) ? localRow.id : null;
if (localId != null) row.id = localId;
const omitId = (localRow === null);
const cols = Object.keys(row).filter(k => row[k] !== undefined && !(k === 'id' && omitId));
```

**The second data-loss path** (previously unnoticed, now closed): if the peer sends a row we do not
have, carrying an integer id that an **unrelated** local row already holds, `INSERT OR REPLACE`
deletes that unrelated row. Omitting `id` for genuinely-new rows removes this entirely. Covered by
T-45.

Tables with no id/uuid pair (`station_config_kv`, `install_config_kv`) keep legacy behavior: the
lookup throws, `localRow` stays `undefined`, and `id` is left exactly as the payload had it.

### Also ungated: `_remapRefs`

Remapping the sender's `station_id` / parent FKs to local ids used to run only when **our** flag was
on. That is backwards — the uuids being consumed are attached by the *sender* (`m.ref_uuids`). If a
sender sends stable identity and we ignore it because of a local flag, we write the sender's integers
into our child rows: the same defect one level down. `_remapRefs` is a no-op when `ref_uuids` is
absent (every ref is skipped), so legacy senders are unaffected.

### What the flag still means

`_uuidIdentity` now governs only what this install **sends** and how it **scopes** (`station_uuid` on
the wire, uuid-scoped pull — `sync-engine.js`). It no longer has any say over inbound integer
identity. The constructor comment was narrowed to say so.

---

## Part B — the flag is live

`electron/sync/sync-scheduler.js` gains `setUuidIdentity(enabled)`: mutates `_engineOpts.uuidIdentity`
and rebuilds the engine in place — the same rebuild `_ensureEngine` already performs when the database
handle is reopened. Idempotent; returns `{ changed, uuidIdentity }`.

`electron/main.js` — `sync:set-uuid-identity` now calls it, and reports what the **engine** holds
rather than what we hoped it would:

```js
ok: readBack === (enabled ? 'true' : 'false') && engineIsUsingIt === enabled,
engineRebuilt: applied.changed,
restartRequired: false,
```

A write that reports success without re-reading the row is how the designation bug hid; a toggle that
reports success without re-reading the live engine is the same lie one layer up.

---

## Tests added (UNRUN)

`electron/sync/tests/t43-t46-rekey-guard.test.js`. **Every apply test constructs the MergeEngine with
`uuidIdentity` omitted — i.e. OFF, the state OV was actually in.** If any of them only passes with the
flag on, the fix has been re-gated and the defect is back.

| Test | Asserts |
|---|---|
| T-43 | inbound `stations` **update** carrying foreign id 2 against local id 6, flag OFF → local id stays 6, one row |
| T-44 | same via **insert** / INSERT OR REPLACE → local id stays 7 |
| T-45 | inbound row we don't have, carrying an id an unrelated local row holds → that row survives; new row gets an id SQLite chose |
| T-46 | `station_config_kv` (no integer id) still applies normally — no regression from the `undefined` branch |
| T-47 | `setUuidIdentity` flips the opt, swaps the engine instance, and is idempotent |

The "local row exists with `id` NULL" branch is **not** covered: `stations.id` is `INTEGER PRIMARY
KEY`, the rowid alias, which cannot hold NULL. That branch exists for tables where `id` is an ordinary
nullable column and relies on existing [N-108c] coverage.

---

## Files touched

| File | Change |
|---|---|
| `electron/sync/merge-engine.js` | ungated `_remapRefs`; unconditional local-id preservation; narrowed the `_uuidIdentity` constructor comment |
| `electron/sync/sync-scheduler.js` | **new** `setUuidIdentity()` — live flag + engine rebuild |
| `electron/main.js` | `sync:set-uuid-identity` applies live, reports engine truth, `restartRequired: false`; doc comment rewritten |
| `electron/sync/tests/t43-t46-rekey-guard.test.js` | **new** — T-43..T-47 |

---

## What this does and does not fix

**Does:** no peer, in any flag state, can renumber this machine's rows. The recurrence path named in
`fix-pass-2026-08-17-sync.md` §2 is closed at the apply path, which is the only place it could happen.

**Does not:** the 137,878 `generated_schedule` rows and 48,099 `play_log` rows already orphaned under
station ids 5–8 are **still orphaned**. Nothing in this pass re-points them. halloVeen (active station
2) is still on air with an empty log; its schedule is under id 6.

**Next, in order:**

1. Run `npm run test:sync`. Green is the precondition for everything below.
2. Build and install on **both** machines. The guard only protects a machine that is running it — an
   un-updated OV cannot re-key an updated OVEVENTS (the guard is on the *receiving* side), but an
   un-updated OVEVENTS is still exposed.
3. **Then** run `scripts/repair-station-rekey.js` (dry run first) to re-point 5→1, 6→2, 7→3, 8→4.
   Running it before step 2 is a treadmill — the next inbound `stations` mutation undoes it.
4. Optionally restore the per-station config purged in the previous pass, from
   `rekey-ghost-config-2026-08-17T23-20-15-112Z.json`, matching by `station_uuid` (id 8 has none —
   match on `station_name`).
