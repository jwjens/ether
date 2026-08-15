# R2 mirror-on-delete — build report (2026-08-14, corrected 2026-08-15)

> **CORRECTION (2026-08-15) — the route's auth was wrong on the first cut, and §1 below describes
> the version that did not work.** It was modelled on `/api/account/audio/upload-url`
> (`requireAuthAdmin` + `req.auth.lk`), which is the DASHBOARD's auth. The desktop install holds a
> `typ:"user"` token — `{uid, email, iat, exp}`, **no `role`, no `lk`** — so it could never call
> that route: `403 admin_required` when fresh, and an `undefined/<key>` prefix even if it passed.
> Every release attempt failed at the auth boundary (first `401 invalid_token`, because the stored
> token had also expired 8h earlier on its 12-hour lifetime).
>
> **Now:** `POST /audio/delete` (ether-backend `b38ab1b`), the true sibling of `/audio/upload-url`
> and `/audio/download-url` — `license_key` in the body, resolved by `lookupLicense`, prefix =
> `license.id`. The security property is unchanged: the prefix comes from the RESOLVED license,
> never from the request. The unusable `/api/account/audio/delete` was removed, not left deployed.
>
> **Lesson worth keeping:** the original "verified live — 401 not 404" receipt proved only that the
> route rejected *unauthenticated* callers. It never proved the desktop could *authenticate*. A
> receipt has to cover the path that matters, not an adjacent one.


Branch `log-reader-flip`. Local only, no commit, no version bump, no deploy.

Deleting a song has never removed its audio from R2. This wires the release: the local queue and
checks that shipped report-only (v37 / `deletion-sweep.js`) now end in an actual DELETE, through a
new backend route that owns the key.

---

## 1. Backend — `C:\ether-backend\src\index.js:3161`

`POST /api/account/audio/delete`, sitting directly under `/api/account/audio/upload-url` and
modelled on it.

- `requireAuthAdmin`; `licenseId = req.auth.lk`; key is `${licenseId}/${fileKey}`.
  **The prefix comes from auth, never from the request.** The caller supplies a basename and
  nothing else, so there is no request this route could accept that names another account's folder.
- Reuses `sanitizeFileKey` (`:129`) — path separators, dot-segments, null bytes, length. Not rewritten.
- Idempotent via `r2ObjectExists` (`:217`): a missing object returns
  `{ok:true, deleted:false, detail:"already_absent"}` — success, not error. That matters because the
  caller retries on failure; a 404 treated as failure would retry forever against an object already
  in the state the caller wanted.
- `getR2Client()` null → 503 `r2_not_configured`, same as the upload route.

**CODE ONLY — not deployed.** Railway deploy needs Jeff's explicit GO. Until it is deployed the
install's calls 404 → rows go to `error` → the sweep retries. Nothing is lost.

## 2. Ether — release layer, `electron/deletion-sweep.js`

The module stays Electron-free and HTTP-free; the network call is **injected**.

| Symbol | Line | What |
|---|---|---|
| `setObjectDeleter` | 255 | main.js registers the real deleter once at startup |
| `isHashNamed` | 269 | 64-hex guard, same shape as `library-client.js:59` |
| `releaseRow` | 288 | releases ONE row, records the outcome |
| `releaseAfterDelete` | 324 | the delete path's own attempt |
| `releaseMarked` | 355 | the sweep's release pass |

With **no deleter registered nothing is released** — identical to pre-mirror behaviour, and also
what an install with no signed-in account gets.

New terminal status **`out_of_scope`** for hash-named objects. Reusing `marked` would have meant
"eligible for release", which is a lie for them; and the release query selects `marked`, so they
would have been re-touched on every sweep. Selected by neither query now. Vocabulary comment updated
in `scripts/migrate-deletion-queue-phase-sync-37.js`.

`runSweep` still deletes nothing — it records verdicts only. Its summary `mode` changed
`report-only` → `evaluate` to stop that line asserting something no longer true.

## 3. Delete path — `electron/sync/handlers/songs.js:154`

`songsDelete` calls `releaseAfterDelete(db, existing.file_key)` **after the transaction commits**
and **without awaiting**.

- **After**, because `evaluateRow`'s first check is "does any LIVE song hold this file_key". Inside
  the transaction this song's own tombstone is not yet visible, so it would find *itself* and never
  release anything.
- **Not awaited**, because the operator's delete is already complete. A slow or failing backend must
  never hold up — or undo — the delete. Failure leaves the row at `error`, which is exactly the
  state the daily sweep retries from.
- Same `evaluateRow` the sweep runs. One rule, one implementation.

## 4. The singleton lock — `electron/main.js:7772-7866` (MANDATORY, now in)

The queue is global; `_maybeRunDeletionSweep` is called per station from `_autoExtendTick`'s loop.
The stamp used to be per station, so a four-station install swept the same global queue four times
a day. Harmless while report-only; **not** harmless with a DELETE wired — four stations would each
fire the same DELETE.

Smallest correct fix, the first of the three options the existing comment listed:

- **Install-scoped stamp** — `install_config_kv` key `sweep_last_run` (`_sweepLastRun` :7776,
  `_stampSweepLastRun` :7785), the same table and the same reasoning as the auto-generate migration
  marker: a fact about the machine, not the station.
- **Stamp written BEFORE the sweep**, not after. The stamp is what makes this a singleton, so it has
  to be in place before anything async starts.
- **Write verified** — the old path went through `stationConfigKvSetLocal`, which silently refuses
  keys outside `LOCAL_ONLY_KEYS` (the 4.4.193 trap). If the stamp does not read back, the tick
  **evaluates only and sends no releases**.
- **In-process re-entrancy flag** `_sweepInFlight` (:7806). The stamp alone cannot close this: the
  release pass is async, so a second station in the same tick, or the next tick arriving while a
  slow release is still in flight, could otherwise enter.

Deleter: `_releaseR2Object` (:7868) — reads `account_jwt` from `install_config_kv`, POSTs to
`/api/account/audio/delete` with `Authorization: Bearer`. Registered at `:8005` in `startAutoExtend`,
before the first tick and before any delete path can run.

The stale per-station `sweep_last_run` rows in `station_config_kv` are now unread. Left in place —
harmless, and removing them is a separate decision.

## 5. Deliberately NOT built

- **`dequeueOnRestore` is still wired to nothing.** No un-delete path exists. Its comment that it is
  mandatory if restore is ever built stands, untouched.
- **Hash-named (64-hex) objects are never released.** Gate is at the release point, not at enqueue,
  because that is where the irreversible thing happens — and because the v37 backfill already put
  rows in the queue that enqueue-time filtering would never have seen.
- No backend deploy, no version bump, no commit.

## Open items for Jeff

1. **Deploy gate.** The backend route is code-only. Until Railway has it, every release call 404s and
   queues an `error`.
2. **The 30-day grace is bypassed on the delete path.** `releaseAfterDelete` releases as soon as the
   local checks clear, per the spec. That is consistent with there being no restore path — but it
   means the grace window now only applies to rows that were *not* clear at delete time. Flagging,
   not changing.
3. **Station delete fires one unawaited release per song.** `songsDeleteByStation` loops through
   `songsDelete`, so a large station delete issues a burst of concurrent requests. The endpoint is
   idempotent and failures are durable-retried, so it is not a correctness problem; it is a burst.
4. **No help entry written.** There is no new panel or door — but "deleting a song now permanently
   removes its cloud audio" is a user-visible behaviour change and should get a line before ship.

## Gates

```
npx tsc --noEmit      → exit 0, zero errors
node --check          → main.js, deletion-sweep.js, songs.js, ether-backend/src/index.js — all OK
npx vitest run        → 23 files, 315 tests, all passed
npm run verify:schema → VERDICT: PASS (8 passed, 0 failed)
```

## VERIFIED at runtime — 2026-08-15

End-to-end, against the live database and the deployed route (Ether fully closed for the write):

```
runSweep   examined 5 → marked 3
release    {"examined":3,"done":3,"error":0,"out_of_scope":0,"skipped":0}

id 2  done  AOK_spotdown.org.mp3                        released — deleted from R2
id 3  done  Ain't No Mountain High Enough - Stereo…mp3  released — deleted from R2
id 9  done  Candy - 7_ Version.mp3                      released — deleted from R2
counts: pending=28  done=3  permanent_shared=2
```

Also verified on the delete path itself: deleting a song that aired inside the 90-day window
correctly held at `pending` ("aired within the last 90 days") and sent no DELETE — `last_checked_at`
landed 2s after `deleted_at`, which only `releaseAfterDelete` writes.

Deployed route guards, checked without ever naming a real object:
```
{}                                    → 400 missing_fields  (license_key is required)
bogus license_key                     → 401 invalid_license_key
file_key "../19/something.mp3"        → 400 invalid_file_key (no path separators)
```
Traversal is rejected BEFORE the license lookup, so a probe cannot use it to learn whether a
license exists.
