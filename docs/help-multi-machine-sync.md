---
feature: multi-machine-sync
title: Multi-Machine Sync
summary: Check whether an account's two computers are actually sharing data, compare their station UUIDs, and force a sync push or pull.
where: Menu → Cloud Backup → Multi-Machine Sync (below the backup controls)
since: 4.4.209
audience: engineer
tour: false
---

# Multi-Machine Sync

## What it is

An account can run on more than one computer — a studio machine and an office machine, or two
studios. This panel answers one question: **is this account's data actually reaching the other
machine?**

It is an engineering panel. Most stations never need it.

## What it shows

- **Pending mutations** — changes written on this machine that have not been sent anywhere yet. A
  large number that never falls means sync is not running.
- **Sync engine** — whether the engine is actually running. It only starts when sync is enabled
  *and* an account session and licence resolve, so "not running" is a real answer, not an error.
- **Last sync** — when this machine last completed a sync. **"never"** means exactly that.
- **UUID identity** — off, on, or *on after restart* (see below).
- **Stations on this machine** — each station's name, its **local id** (a number that is only
  meaningful on this computer) and its **UUID** (the same on every machine for the same station).
  The UUID is selectable so you can copy it.

If every change on the machine was written locally and nothing has ever arrived from elsewhere, the
panel says so in as many words. That is the difference between *"sync is behind"* and *"sync has
never run"*, and the two look identical if you only watch a pending count.

## What to do with it

### Before you push anything — compare the two machines

1. Open this panel on **both** computers.
2. Press **Preflight** on each.
3. Compare the **station UUIDs**.

**If the UUIDs match**, the two machines agree on what each station is, and syncing will merge them.

**If the UUIDs do not match**, stop. The two installs think these are different stations, and
pushing will not merge them — it will mix them up. Fix the identity first.

### The buttons

- **Preflight** — refreshes everything above. Reads only; changes nothing.
- **Push Now** — sends this machine's pending changes immediately, instead of waiting for the
  scheduler. It reports how many were sent, accepted and rejected, and the pending count before and
  after.
- **Pull Now** — fetches and applies changes from the other machine immediately.

### Use UUID-based station identity

Off by default. When off, station rows are routed by the **local station number** — which is only
meaningful on the computer that assigned it. Two installs that numbered their stations differently
will therefore mix them up rather than merge them.

Turn it on when an account genuinely runs on more than one machine.

> **It takes effect only after you fully quit and reopen Ether.** The setting is read once when the
> app starts. Until you restart, the panel shows **"on after restart"** and tells you the running app
> is still using the old setting — the switch is not lying to you, it simply cannot apply itself to
> an engine that is already running.

## Troubleshooting

- **"Sync engine: not running."** Sync is not enabled for this install, or no account session or
  licence has resolved. Enabling sync is in Settings → Multi-Device Sync.
- **Push Now says `sent 0`.** There was nothing pending. If the pending count is also 0, this
  machine is up to date.
- **A very large pending count.** Every change ever made here is queued. Pushing sends all of it, so
  expect the first push to take a while.
- **"Nothing has ever been received from another install."** This machine has only ever talked to
  itself. Check that the other machine has sync enabled too, and that both are signed into the same
  account.
- **A deleted song is still on the other machine.** Deletions sync like any other change — they are
  not treated specially — so if a delete has not arrived, nothing else has either. Check the pending
  count and last sync time rather than looking for a deletion-specific fault.
- **A deleted song's audio is still in cloud storage.** That is separate and deliberate: deleting a
  song does not delete its audio file from the cloud.

## Related

- [Backup and Restore](help-backup-and-restore.md) — the cloud backup controls above this panel
- [Health Monitor](help-health-monitor.md) — the panel that reports overall station health
- [Deleting Songs](help-deleting-songs.md) — what a delete does and does not remove
