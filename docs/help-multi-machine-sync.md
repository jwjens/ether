---
feature: multi-machine-sync
title: Multi-Machine Sync
summary: Engineering controls for keeping two Ether installs in step — station UUIDs, the pending queue, and forced push/pull.
where: Preferences → Backup & Restore → Multi-Machine Sync
since: 4.4.209
audience: engineer
tour: false
---

# Multi-Machine Sync

## What it is

The engineering view of sync between two installs of Ether on the same account. It shows what is
**actually stored and running** — not what is supposed to be — and lets an engineer force one sync
cycle in either direction.

This sits below the cloud backup controls on the same page, because both answer the same question:
is this machine's work safely somewhere else.

## When to use it

When two machines that share an account disagree — different libraries, different calendars, or a
song deleted on one that is still present on the other.

## Read this before you push

**Run Preflight on BOTH machines and compare the station UUIDs first.**

If the UUIDs do not match, UUID-based identity cannot merge the two installs, and pushing will
**mix the stations up rather than reconcile them**. That is a much worse problem than the one you
started with, and it affects both machines. Compare first, push second.

## What each reading means

- **This machine** — the stable machine id. It is here so you can tell the two dumps apart.
- **Stations — id ↔ UUID** — the comparison above. The number is this machine's *local* id and can
  legitimately differ between installs; the UUID is the one that must match.
- **Pending mutations** — changes written on this machine that have not been sent anywhere. Green at
  zero, amber otherwise.
- **Scheduler** — whether the sync engine is actually running. It is only built at startup, and only
  when `sync_enabled` is true *and* an account session and licence resolve. `sync_enabled` is shown
  beside it, so "enabled but not running" is visible rather than confusing.
- **Ever received** — whether this install has ever taken in a single row **from** another machine.
  This is the reading people miss: an install can have a clean queue and still have never received
  anything, which means it has never really been in a pair.

## The controls

- **PREFLIGHT** — re-reads everything above. Changes nothing.
- **PUSH NOW** — forces one immediate push. Reports how many were sent, accepted and rejected, and
  the pending count **before and after**, so you can see the scale of what moved.
- **PULL NOW** — forces one immediate pull and reports how many mutations were applied.
- **UUID-based station identity** — routes station-scoped rows by station UUID instead of by this
  machine's local integer id.

## About the UUID toggle and the restart

The panel shows this setting twice on purpose: **Stored** and **in the running engine**.

The sync engine reads this flag **once, when it is built at startup**. So the moment you tick the
box, the stored value changes and the running value does not — and the panel says so in amber until
you restart. That is not a warning to be safe; the setting genuinely has no effect on any push or
pull until Ether is restarted.

**Quit Ether fully from the tray and reopen it.** A window reload is not enough, and the audio
daemon does not reload on its own.

## Troubleshooting

- **"sync is not running on this install"** — the engine was never built. Check `sync_enabled`
  beside the Scheduler reading, and that the machine is signed in with a licence that resolves.
- **Push reports `sent: 0`** — there was nothing pending. Check the pending count.
- **Everything pending, "Ever received: never"** — this install has never synced in either
  direction. Nothing about deletions or any single table explains that; the engine is not running or
  has never successfully reached the backend.
- **A deleted song is still on the other machine** — check that the delete produced a mutation
  before assuming deletion is broken. `scripts/diag-song-delete-sync.js` answers it read-only.
  Note that deleting a song **never removes its audio from R2**; that is deliberate.

## Related

- [Backup and Restore](help-backup-and-restore.md) — the cloud backup controls above this section
- `docs/song-delete-sync-diagnosis-2026-08-14.md` — why this panel exists
