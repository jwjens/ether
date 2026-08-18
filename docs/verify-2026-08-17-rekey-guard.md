# Verification receipts — re-key guard fix pass, 2026-08-17

Runs the four checks `docs/fix-pass-2026-08-17-rekey-guard.md` could not produce (its shell died before
executing anything). Branch `log-reader-flip`, HEAD `e190a63` (4.4.224). **Nothing committed, no bump.**

## 1. `npm run test:sync` — GREEN

```
 Test Files  11 passed (11)
      Tests  46 passed (46)
   Duration  2.05s
```

All five new tests pass with the flag OFF:

- T-43 inbound `stations` UPDATE carrying a foreign id, uuid-identity OFF — local id unchanged ✓
- T-44 inbound `stations` INSERT for a uuid we already hold — REPLACE keeps OUR id ✓
- T-45 inbound row we do NOT have — id omitted; unrelated local row holding that id survives ✓
- T-46 `station_config_kv` (no integer id) still applies normally ✓
- T-47 `setUuidIdentity` flips the opt, rebuilds the engine, idempotent ✓ (logs `[SYNC] uuid-identity ENABLED — engine rebuilt in place (no restart)`)

No failures, no skips. Pre-existing 41 (T-01..T-41) all green, including the T-39..T-41 no-op guard
from the previous pass.

**Count correction:** the fix-pass doc predicted "42 existing + 5 new". The real pre-existing count is
**41** (4+6+5+5+4+5+2+4+3+3 across the ten older files); 41 + 5 = 46. The doc's 42 was arithmetic, not
a missing test.

## 2. `zz-probe.test.js` — DELETED

`electron/sync/tests/zz-probe.test.js` removed (untracked, never committed; contents were a neutered
`it.skip` placeholder with a self-describing "SCRATCH FILE — delete me" header). Confirmed gone.

## 3. Typecheck + syntax — CLEAN

- `npx tsc --noEmit` → **exit 0, zero errors** (meets the post-4.4.179 zero bar).
- `node --check` OK on all eight touched JS files: `merge-engine.js`, `sync-scheduler.js`, `main.js`,
  `t43-t46-rekey-guard.test.js`, `handlers/station_config_kv.js`, `t39-t41-noop-guard.test.js`,
  `tests/helpers/create-test-db.js`, `library-health.js`.

## 4. The source on disk matches the doc — file:line receipts

The writing session could not confirm its own saves. It did save. Verified by reading the files:

### Three-case identity preservation — `electron/sync/merge-engine.js:252-260`

```js
252  let localRow;                    // undefined = no id/uuid pair on this table; null = new row here
253  if (row_id) {
254    try { localRow = db.prepare(`SELECT id FROM ${table_name} WHERE uuid = ?`).get(row_id) ?? null; }
255    catch (_) { localRow = undefined; }
256  }
257  const localId = (localRow && localRow.id != null) ? localRow.id : null;
258  if (localId != null) row.id = localId;
259  const omitId = (localRow === null);   // strictly "we looked, and this row is genuinely new here"
260  const cols = Object.keys(row).filter(k => row[k] !== undefined && !(k === 'id' && omitId));
```

Byte-for-byte the block the doc specified. **No `this._uuidIdentity` appears anywhere in this path** —
the only three references left in the file are `:64` (constructor default), and the comments at `:204`
and `:230` that explain the ungating. `cols` feeds both the `insert` branch (`INSERT OR REPLACE`,
`:264-267`) and the `update` branch's fallback insert, so the omission applies on both paths.

`_remapRefs` is ungated at **`merge-engine.js:210`**, called before the column build, with the
rationale at `:204-209`.

### Live flag — `electron/sync/sync-scheduler.js:137-146`

`setUuidIdentity(enabled)` exists and does what the doc claims: early-returns `{changed:false}` when
unchanged (`:140`), mutates `this._engineOpts.uuidIdentity` (`:141`), re-resolves the handle and
constructs a fresh `SyncEngine` (`:142-143`), returns `{changed:true, uuidIdentity:next}` (`:145`).
Same rebuild shape as `_ensureEngine` at `:118-126`.

### IPC truth-telling — `electron/main.js:8972-9005`

- `:8983` reads the row back after the write
- `:8988` calls `app._syncScheduler?.setUuidIdentity?.(enabled)`, failure caught and logged
- `:8990` `engineIsUsingIt` read off the **live** `_engineOpts`, not the intended value
- `:8992` `ok` = row read-back AND engine agree
- `:8996` `restartRequired: false`
- doc comment rewritten at `:8957-8971`

## Incidental note (one line, not investigated)

The working tree carries three modified files beyond this pass's four —
`electron/library-health.js`, `electron/sync/handlers/station_config_kv.js`,
`electron/sync/tests/helpers/create-test-db.js`, plus `src/lib/ccData.ts` — which belong to the earlier
`fix-pass-2026-08-17-sync.md` pass, also uncommitted.

## Status

Step 1 of the fix-pass's "Next, in order" is **satisfied**. Steps 2-4 (build + install on both
machines, then `scripts/repair-station-rekey.js`) are Jeff's call and are untouched here.
