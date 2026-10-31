---
feature: cloud-log-backup
title: Cloud Log Backup
summary: Back up your whole station to the cloud with a note, back up every day at midnight, and restore any full-station backup from one list.
where: Tools → Cloud Log Backup
since: unreleased (after 4.6.70)
audience: operator
tour: true
---

# Cloud Log Backup

## What it is

**Cloud Log Backup** sends a copy of your **whole station database** — library, categories, clocks, shows, schedule,
play history and settings — to the cloud, and lists the backups so you can put one back. It is a cloud feature: it
needs a **Station, Pro or Unlimited** plan.

It works on the same backups as **Settings → Backup & Restore → Backups on this computer**. A backup made here shows
up there and the other way round, and the schedule is one setting with two doors.

## When to use it

- Before a big change (a format change, a big import): back up with a note like *"Before format change"*.
- To back up every night without thinking about it: turn on **Auto-backup daily at midnight**.
- After a mistake: restore the backup from just before it.

Your **audio files** are not part of this backup — see *Backing up your station* (Settings → Backup & Restore) for
sending audio.

## Back up now, with a note

1. Open **Tools → Cloud Log Backup**.
2. Under **Create Backup**, type a note in **Description (optional)** — for example *"Before format change"*. You can
   leave it empty.
3. Press **☁ Backup Now**. The line at the top says *"✓ Full station backed up to the cloud"* with the size and your note.
4. The backup appears at the top of **Saved Backups**, named by your note, with its date, the computer that made it
   and its size.

The note is saved with the backup in the cloud, and shown in the lists **on the computer that made the backup**.

## Back up every day at midnight

1. Under **Create Backup**, click the **Auto-backup daily at midnight** switch so it turns green.
2. The line under it says *"This computer backs up to the cloud every day — next …"* with tonight's midnight.

Click the switch again to turn cloud backups **off** on this computer. The line under it always says what this
computer really does — if the schedule was set to something else in **Settings → Backups** (for example every 6 hours),
it says so, and the switch shows off because it is not "daily at midnight".

Each computer has its own schedule. Cloud backups also need **Keep my stuff synced** on.

## Restore a backup

1. Under **Saved Backups**, find the backup you want (press **↻ Refresh** to reload the list).
2. **Switch sync off first** (Settings → **Keep my stuff synced**) so nothing spreads while you fix it.
3. Press **↩ Restore** and confirm. Ether downloads the backup, checks it, and only then replaces this computer's
   station database. Changes not yet sent are discarded.
4. When it says *"✓ Restored … Restart Ether for everything to take effect"*, close and reopen Ether.

If the backup is damaged, Ether refuses it and your station is untouched.

## Older play-history backups

Earlier versions of Ether saved backups of the **play history only**. Press **Connect** (with your license key and
email) to list them under **Older play-history backups**. They can be deleted (✕). They **cannot be restored into a
running station** — pressing **↩ Restore** on one tells you why: it would overwrite the play history every computer
shares. Restore a full-station backup from **Saved Backups** instead.

## Words used here

- **Full-station backup** — a copy of the whole station database, made by **Backup Now** or the schedule.
- **Description** — the note you type when backing up.
- **Restore** — replace this computer's station database with a backup.
