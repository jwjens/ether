---
feature: multi-machine-sync
title: Multi-Machine Sync
summary: Engineering view of sync between two Ether installs — station UUIDs, what is waiting to sync, whether the sync engine is running, and manual push/pull overrides.
where: Preferences → Backup & Restore → Advanced — sync diagnostics
since: 4.4.210
audience: engineer
tour: false
---

# Multi-Machine Sync

## What it is

The engineering view of sync between two installs of Ether on the same account. It shows what is
**actually stored and running** — not what is supposed to be — and gives an engineer manual overrides
to force one sync cycle in either direction.

It sits in **Preferences → Backup & Restore**, below the cloud backup controls, under the heading
**Advanced — sync diagnostics**, because both answer the same question: is this machine's work safely
somewhere else. It is not needed in normal use.

## When to use it

When two machines that share an account disagree — different libraries, different logs, or a
song deleted on one that is still present on the other.

## Sync runs on its own once it is on

Sync is switched on and off with **Keep my stuff synced**, higher up on the same page (it needs a
Network licence). Once it is on, sync runs **continuously in the background** — pushing about every
10 seconds and pulling about every 30. Enable it once and leave it.

This panel does not switch sync on or off. It shows its state, and its buttons are **manual
overrides** for when a transfer has to land now.

## Read this before you enable sync on a second machine

**Compare the station UUIDs on BOTH machines first** (press Preflight on each).

If the UUIDs do not match, UUID-based identity cannot merge the two installs, and continuous sync will
**mix the stations up rather than reconcile them — unattended**. That is a much worse problem than the
one you started with, and it affects both machines. Compare first, enable second.

## What each reading means

- **This machine** — the stable machine id. It is here so you can tell the two dumps apart.
- **Stations — id ↔ UUID** — the comparison above. The number is this machine's *local* id and can
  legitimately differ between installs; the UUID is the one that must match.
- **Waiting to sync** — changes written on this machine that can go up and have not yet. Green at
  zero, amber otherwise, with a progress bar while there is a backlog.
- **Journal only** — shown only when there are some. Local-only records that never leave this
  computer. **Not a backlog** — nothing is stuck.
- **Sync engine** — whether the sync engine is actually running. It is only built when Ether starts,
  and only when sync is enabled *and* an account session and licence resolve. The stored setting
  (`sync_enabled`) is shown beside it, so "enabled but not running" is visible rather than confusing.
- **Ever received** — whether this install has ever taken in a single row **from** another machine.
  This is the reading people miss: an install can have nothing waiting and still have never received
  anything, which means it has never really been in a pair.

## The controls

- **PREFLIGHT** — re-reads everything above. Changes nothing.
- **PUSH NOW** — forces one immediate push. Reports how many were sent, accepted and rejected, and
  the pending count **before and after**, so you can see the scale of what moved.
- **PULL NOW** — forces one immediate pull and reports how many mutations were applied.
- **Enable UUID-based station identity** — routes station-scoped rows by station UUID instead of by
  this machine's local integer id.

## About the UUID toggle and the restart

The panel shows this setting twice on purpose: **Stored** and **in the running engine**.

The sync engine reads this flag **once, when it is built at startup**. So the moment you tick the
box, the stored value changes and the running value does not — and the panel says so in amber until
you restart. That is not a warning to be safe; the setting genuinely has no effect on any push or
pull until Ether is restarted. The same is true of **Keep my stuff synced**: the Sync engine reading
changes only after a restart.

**Quit Ether fully from the tray and reopen it.** A window reload is not enough, and the audio
daemon does not reload on its own.

## Troubleshooting

- **"sync is not running on this install"** — the engine was never built. Check that **Keep my stuff
  synced** is on, that the machine is signed in with a licence that resolves, and that Ether has been
  restarted since you turned it on.
- **Push reports `sent: 0`** — there was nothing waiting. Check **Waiting to sync**.
- **A large Waiting to sync count, and "Ever received: never"** — this install has never synced in
  either direction. Nothing about deletions or any single table explains that; the engine is not
  running or has never successfully reached the backend.
- **A deleted song is still on the other machine** — check that the delete produced a mutation
  before assuming deletion is broken. On an installed copy of Ether, Preflight is the way to check:
  if **Ever received** says *never* and Waiting to sync is large, nothing has ever synced in either
  direction and no deletion-specific problem is involved. (On a machine with the source tree,
  `scripts/diag-song-delete-sync.js` gives the same answer in more detail. It is a local diagnostic
  and is not shipped with the app.)
  Note that deleting a song **never removes its audio from R2**; that is deliberate.

## Related

- [Backup and Restore](help-backup-and-restore.md) — the cloud backup controls and **Keep my stuff
  synced**, above this section
- `docs/song-delete-sync-diagnosis-2026-08-14.md` — why this panel exists
