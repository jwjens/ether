# The one switch writes the rows half and only *pretends* to write the files half

**Found:** 2026-09-09, while verifying the two pending SettingsPanel edits before the 4.6.23 build.
**Status:** CONFIRMED AT RUNTIME 2026-09-10, **FIXED** 2026-09-11 in 4.6.23. See "Resolution" below.
**Severity:** honest-UI defect. The switch makes a claim it does not make true in one direction.
**Not caused by the 4.6.23 edits.** This is in 9f07990 (step 5), and therefore in the installed 4.6.22.

## What the switch claims

`toggleKeepSynced()` — `src/components/SettingsPanel.tsx:2311-2327` — is the one switch. Turning it
off sets the message:

> "Off. Nothing is going to the cloud."

## What it actually does

```
src/components/SettingsPanel.tsx:2316   await kv.upsertByKey(stationId, 'sync_enabled', ...)      ← persisted
src/components/SettingsPanel.tsx:2317   if (next) await kv.upsertByKey(..., 'sync_backend_url', ...) ← persisted
src/components/SettingsPanel.tsx:2318   setSyncOn(next)                                            ← React state
src/components/SettingsPanel.tsx:2319   setR2Enabled(next)                                         ← React state ONLY
```

The **rows** half (`sync_enabled`) goes to `station_config_kv` and survives a restart.

The **files** half is `r2Enabled`, and it is plain component state declared at
`src/components/SettingsPanel.tsx:2244`. The only thing that persists it is `saveR2Config()`
(`:2601`), which sends `{enabled, intervalHours}` to `cloud-backup:set-r2-config` — and
`saveR2Config` has exactly **one** call site:

```
src/components/SettingsPanel.tsx:3396   <button onClick={saveR2Config} …>   ← the Save button in Advanced
```

`toggleKeepSynced` never calls it. So the switch moves the green pill and the local boolean, and the
scheduled catalogue backup in main is never told.

## Why OFF is the broken direction

`electron/cloud-backup.js:38` seeds `r2Config` with **`enabled: true`**. Scheduling is decided in
main from that value:

```
electron/cloud-backup.js:44    if (!r2Config.enabled) return false;          // r2Ready()
electron/cloud-backup.js:141   if (r2Config.enabled && r2Ready()) startAutoBackup(dbPath);
electron/cloud-backup.js:142   else if (!r2Config.enabled && !config.enabled) stopAutoBackup();
```

- **ON** happens to work, because main's default is already `true` — unless a previous visit to
  Advanced saved `false`, in which case ON also silently fails for files.
- **OFF** does not work. Main keeps `enabled: true`, `startAutoBackup` keeps its timer, and the
  catalogue keeps going up while the card says "Off. Nothing is going to the cloud."

## Runtime status — CONFIRMED

**The log check I first proposed was unrunnable and is recorded here so nobody repeats it.**
`ether-startup.log` is written only by `logStartup()` (`electron/main.js:289-295`); plain
main-process `console.log` goes to stdout, which a packaged build discards. Full scan of all
1,606,390,771 bytes: `CLOUD-BACKUP` → **0 lines**, `catalogue:backup` → 0, `SYNC` → 0,
`announce` → 5094 (that one has a dedicated writer). The codebase already knew —
`electron/main.js:4256`: *"Receipt: a 1.6 GB ether-startup.log with zero [CART] lines."*

**What settled it (Jeff, 2026-09-10), no restart needed.** DevTools on the running window:

```js
await window.ether.cloudBackup.getR2Config()   // → enabled: true
// flip "Keep my stuff synced" OFF
await window.ether.cloudBackup.getR2Config()   // → enabled: true
```

> "Confirmed at runtime. …I flipped Keep my stuff synced off, and it reads true again.
> The switch never reaches main."

Supporting read-only dump of the live profile DB, same session:

```
cloud_backup_r2      → (no row)          ← never persisted, not once
cloud_backup_config  → (no row)          ← the legacy path is dead; nothing calls setConfig
plan_tier            → station_lifetime  ·  license_key → present   ⇒ r2Ready() true
```

## Resolution — shipped in 4.6.23

Three writers of the files-half flag, and the one switch was not among them. All three dealt with:

1. **`toggleKeepSynced()` became the writer** (`SettingsPanel.tsx`): it now calls
   `setR2Config({ enabled, intervalHours })` in the same act as the two KV writes, exactly as it
   already wrote `sync_enabled` and `sync_backend_url` together.
2. **Advanced's "Back up automatically" toggle → read-only `on`/`off` status**, and its Save now
   sends `{ intervalHours }` only. An interval is a parameter; a master switch is not.
3. **`CloudBackup.tsx`'s R2 credentials form deleted** — a *rendered* surface (App.tsx:3120 and a
   popout) with its own enable toggle and "Save Credentials", writing the same flag over four inputs
   main has discarded since 1.3f. "Backup to R2 Now" stays; a manual run is an escape hatch.
4. **The load path restored** (`cloud-backup.js`): `installCloudBackup()` reads `cloud_backup_r2`
   back and honours `enabled` + `intervalHours` only, type-checked. Credentials stay unloaded —
   1.3f's decision stands. Without this the off was written and never read.

Guard: `scripts/smoke-one-switch.js` §8 — one writer, written in the same function as
`sync_enabled`, both retired labels absent, the load path present, and no credential field read.

## What was deliberately NOT built

**Boot does not start the backup timer, and that was left alone.** `installCloudBackup()` only
auto-starts from the legacy `config.enabled` (`cloud-backup.js:204`), which is permanently false —
nothing calls `cloud-backup:set-config`, and `cloud_backup_config` has no row. So a timer starts
only when the switch is flipped ON during a session; after a restart, ON means "r2Ready() is true, so
a backup_db upload will go" but nothing is scheduled until the switch is touched again.

Adding a boot-start would have been the symmetric half — but it opens a seam this fix does not have
to touch: with no stored row the flag defaults `true`, so an install whose card reads OFF (because
`sync_enabled` is false) would start a timer at boot and reproduce the exact defect from the other
direction. Closing that means deciding how a never-set files half seeds itself from the rows half,
which is a design question, not a bug fix. **Named, ticketed here, not built.**

The defect Jeff reported — *off while it keeps sending* — is fixed: OFF is now stored, loaded,
and `r2Ready()` returns false, so `triggerUpload()` skips.

## Related, fixed in the same commit

`docs/help-backup-and-restore.md` told operators to turn on **Back up automatically**, use **Send my
music to the cloud**, and look under **Where your songs live** — three controls that no longer exist.
Rewritten against the controls that do: the one switch, **How often to send your setup** (Advanced),
**Re-send every file**, and **WHERE YOUR AUDIO LIVES**.
