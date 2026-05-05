# Phase 3.5 Deferral — electron/main.js raw DB writes

## Status: Deferred — main-process bypass, separate architectural arc

## Why these are different

All other F-3.x migrations targeted renderer-process writes going through
`db:execute` IPC. The writes below originate in the **main process** and call
`db.prepare().run()` directly — they bypass both the IPC layer and the
`SYNCED_TABLES_SET` guard entirely. They are not blocked; they work today.
Migration is a correctness/sync concern, not a runtime breakage.

## Deferred write sites

### rtmp_destinations — electron/main.js

| Line | Operation | Context |
|------|-----------|---------|
| ~2028 | `INSERT INTO rtmp_destinations` | RTMP destination created from main process |
| ~2031 | `UPDATE rtmp_destinations SET` | Destination updated from main process |
| ~2037 | `DELETE FROM rtmp_destinations` | Destination deleted from main process |

These writes bypass `withMutation`, so they are never logged to the `mutations`
table and will not sync.

### operator_notes — electron/main.js

| Line | Operation | Context |
|------|-----------|---------|
| ~1039 | `INSERT INTO operator_notes` | Note saved from main process |

Same issue — bypasses mutation log.

## Required fix

Each site needs to call the appropriate typed handler function directly (not via
IPC — the main process has direct access to the handler modules). For example:

```javascript
const { rtmpDestinationsCreate } = require('./sync/handlers/rtmp_destinations');
rtmpDestinationsCreate(db, payload);
```

This ensures `withMutation` wraps the write and the mutations table stays consistent.

## Architectural note

This is the same class of problem as the `library:writeTrack` and related
main-process song-write channels. Those were deferred to a dedicated arc
covering main-process handler adoption. These three tables belong in that same arc.
