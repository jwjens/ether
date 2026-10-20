---
feature: multi-machine-sync
title: Multi-Machine Sync
summary: Engineering view of sync between two Ether installs — station UUIDs, what is waiting to sync, whether the sync engine is running, and manual push/pull overrides.
where: Preferences → Backup & Restore → Advanced — sync diagnostics
since: 4.4.210; one switch per computer, every station by identity, restore actions 4.6.62
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
Network licence). **The switch is for this computer** — one on/off for the whole computer, whichever station is
active — and it takes effect **at once** (no restart). Once it is on, sync runs **continuously in the background** —
pushing about every 10 seconds and pulling about every 30.

**Every station syncs**, each by its own identity and each keeping its own place — the active station or not. A
station numbered 2 on one computer and 5 on another is the same station. (Before 4.6.62 only the active station
received, and only when "UUID-based identity" was ticked; that checkbox is gone — identity is always on.)

**While sync is off, it says so everywhere:** an amber **SYNC OFF ON THIS COMPUTER** in the top bar of the main
window and of every pop-out. Nothing goes out and nothing comes in; changes made meanwhile wait.

## A mistake on one computer — stop it spreading, restore, then decide

1. **Switch sync off** on that computer (**Keep my stuff synced**). Nothing more leaves it.
2. **Restore a recent backup** (Backup & Restore). The restore **throws away every change that had not been sent**,
   so switching sync back on can never send the mistake out. The restore message says how many.
3. If the mistake **had already gone out** before you switched off, the panel shows **This computer was restored from
   a backup** with the number of rows it changed since that backup. Two choices:
   - **Send this restore to every machine** (admin PIN, then a confirm) — those rows go back to the backup's version on
     every computer, and rows the mistake created are removed everywhere. Other computers' own changes are kept,
     unless they changed one of the same rows (then the backup's version wins). Plays are never touched — what aired
     stays in the Play Log.
   - Or don't — then switching sync back on brings the other computers' state, mistake included, back to this computer.
4. **Switch sync back on.** The computer catches up on everything the other computers did meanwhile.

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
- **Sync engine** — whether the sync engine is actually running. It runs while this computer's switch is on *and* an
  account session and licence resolve. The switch (**This computer: ON / OFF**) is shown beside it.
- **Ever received** — whether this install has ever taken in a single row **from** another machine.
  This is the reading people miss: an install can have nothing waiting and still have never received
  anything, which means it has never really been in a pair.

## The controls

- **PREFLIGHT** — re-reads everything above. Changes nothing.
- **PUSH NOW** — forces one immediate push. Reports how many were sent, accepted and rejected, and
  the pending count **before and after**, so you can see the scale of what moved.
- **PULL NOW** — forces one immediate pull and reports how many mutations were applied.

## Troubleshooting

- **"sync is not running on this install"** — the engine was never built. Check that **Keep my stuff
  synced** is on (no amber SYNC OFF in the top bar) and that the machine is signed in with a licence that resolves.
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
