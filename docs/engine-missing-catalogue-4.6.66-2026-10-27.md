# 4.6.66: the queue never fills — the engine was staged without electron/catalogue.js (2026-10-27)

**Jeff (verbatim):** "4.6.66 is broken on OV: the queue never fills. Root cause, found on OV: the 4.6.66 installer copied
the new engine.js into the engine folder but did not ship electron/catalogue.js, which engine.js now requires for the
catalogue-only rule (91800ba). It isn't in stage-manifest.json. The engine hides the load failure at
engine/audiod/engine.js:1956 and rejects every song as unplayable ("automationStart: no playable track to start")."

**Then:** OV put back on 4.6.65 (`C:\openair\dist-electron\Ether Setup 4.6.65.exe`, sha256 `df1c81dd…5725a`, built
from `569b921`, which predates `91800ba`). **Jeff: "rotation is back on 4.6.65".**

## Why catalogue.js was not staged (read on release/1019, no change made)

1. `audiod/engine.js:1956`: `try { here = require('../electron/catalogue').playableFile(fp); } catch { here = null; }`.
   A failed require reads as "file not here", for every file. That is how every song became unplayable without an
   error.
2. The engine's file list does name it. `audiod/engine-fingerprint.js` `daemonElectronFiles()` reads the daemon's own
   `require("../electron/…")` calls and returns `audio-library-index.js, catalogue.js, profile-paths.js,
   sync/mutation-writer.js, sync/synced-tables.js`.
3. Staging copies them from `app.asar.unpacked` (`audiod/stage-engine.js:83`), but only files listed in
   `electron-builder.json` `asarUnpack` exist there: `sync/mutation-writer.js`, `sync/synced-tables.js`,
   `audio-library-index.js`, `profile-paths.js`. **`catalogue.js` is not listed**, so it stayed inside app.asar, where
   the staged engine (ELECTRON_RUN_AS_NODE, no asar support) cannot reach it.
4. The stage entry is `optional: true`, so the missing source was skipped silently. It is not in
   `stage-manifest.json`, and the stage was reported as good.

## A second gap of the same kind (code-read; runtime UNVERIFIED)

`daemonElectronFiles()` follows only the daemon's direct `../electron/` requires, not what those files require in
turn. The transitive closure also contains:
- `electron/sync/handlers/asset-mirror.js` (required lazily at `electron/sync/mutation-writer.js:417`, on an asset
  delete);
- `electron/sync/handlers/library_asset.js`;
- `electron/asset-types.js`;
- `shared/asset-types.json`.

None are staged; the staged engine on OVEVENTS has 4 electron files. This fails only on that delete path, not the queue.
`catalogue.js` itself requires only `audio-library-index.js` (which is staged).

## Fix plan for 4.6.67 (Jeff's items, not started)

1. Ship `catalogue.js` and everything the engine requires, transitively, with the engine: derive the list by following
   relative requires, `asarUnpack` covering every entry, staged non-optional so a missing file fails the stage by name.
2. Log the error at `engine.js:1956` (once per cause) instead of treating every file as missing.
3. Test that fails on 4.6.66: every relative require in the engine (transitive) is in the engine stage list and in
   `asarUnpack`.
4. Confirm the failure on OVEVENTS's 4.6.66 before the fix and gone after.
5. Rebuild as 4.6.67; release checks, with the side-by-side real launch showing the queue fill from today's log.
