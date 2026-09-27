---
feature: backup-and-restore
title: Backing up your station, and putting it on another computer
summary: One switch — Keep my stuff synced — keeps your setup and your audio in the cloud. The status card says exactly what is safe and shows the one button you need; any computer you sign into can become your station.
where: Settings → Backup & Restore
since: 4.6.49
audience: operator
tour: true
---

# Backing up your station, and putting it on another computer

Your station lives in two parts, and both matter:

- **Your setup** — your song list, clocks, shows, schedule, categories and settings.
- **Your music files** — the actual audio.

A backup is only useful if it has both. A setup without the audio restores onto a new computer looking
perfectly normal, and then the songs won't play.

---

## Backing up

Open **Settings → Backup & Restore**. The status card at the top tells you exactly where you stand, and
shows the one button you need:

- **✓** *"Everything on this computer is in the cloud — your whole setup and all 511 audio files, as of
  …"*. Everything is safe. This is the only state that means you can rebuild on another computer. There
  is no button, because there is nothing to do.
- **!** *"Your setup is safe. 137 of 511 audio files haven't gone up yet — on another computer those
  would arrive with no sound."* Press **Finish sending** to send the rest.
- *"Nothing is in the cloud yet."*, or *"All 511 audio files are safe. Your setup hasn't gone up yet."*
  Press **Back up now**. It saves your setup to the cloud, then sends any audio that isn't there yet.

The count is read from your actual library every time, so it always reflects what is really in the cloud.

**Songs you've deleted are not backed up.** Deleting a song removes it from your library and your
schedule, so it won't reappear on another computer. The audio file itself stays in the cloud.

### Automatic backups

There is no separate switch for this. **Keep my stuff synced** is the one switch, and while it is on Ether
sends your setup to the cloud on a schedule and brings new audio down from your other computers, on
every computer signed into your account. Audio added on *this* computer goes up when you send it (see
**Audio arriving from your other computers** below). Leave the switch on.

To change how often your setup goes up, open **Advanced** and use **How often to send your setup** (every
hour up to once a day), then press **Save**. That row only sets the schedule; on and off is the switch
above it. It covers your **setup** only — audio goes up when you send it (see below), not on a timer.

If you've just imported a big batch, send it straight away: press the button on the status card, or
**Send just the audio** under **Advanced**.

### Checking it really is on (or really is off)

The switch and the machinery behind it read the same setting, so they cannot disagree — but if you
want to see it with your own eyes, open **Advanced**. The first row inside is **Going to the cloud
right now**, with a green **ON** or a grey **OFF** on the right.

That is not a second switch and you cannot click it. Every other label on this screen tells you what
Ether means to do; this one reports what the backup machinery answers when you ask it. It is the one
line that can contradict the big switch, which is exactly why it is there.

If the big switch says off, this must say **OFF**. If it says **ON** while the switch says off,
something is wrong and it is worth reporting.

### Audio arriving from your other computers

While **Keep my stuff synced** is on, Ether checks the cloud for new audio every few minutes and
downloads anything this computer does not already have. You do not press anything. A sweeper you cut
on the studio machine turns up on the on-air machine on its own, usually within a few minutes.

It only fetches what is missing, so the check costs almost nothing when there is nothing new. While
files are coming down, the Health Monitor says **"N files still arriving"** rather than reporting
them as missing — because they are not missing, they are on their way.

**The two directions are not the same, and it is worth knowing which is which.** Audio comes *down*
on its own. Audio goes *up* when you press **Send just the audio**. So after you import a batch or
record a voice track, send it — until you do, your other computers cannot know it exists. Preferences
→ Backup & Restore → **Advanced** spells both out under **Audio transfer**, including when the last
check ran and what it found.

### Sending just the music

**Back up now** and **Finish sending** already include your music. To send the audio on its own, open
**Advanced** and press **Send just the audio**. If you're not sure an import made it, tick **Re-send
every file, even ones already uploaded** first, then press **Send just the audio**.

**WHERE YOUR AUDIO LIVES** (under **Advanced**) shows the folder Ether keeps your library in. **Change
folder** moves it. This is
also the folder your music lands in on another computer.

---

## Setting up another computer

Install Ether, sign in with your email and password, and Ether offers to install your station from the
cloud. It pulls your setup first, then downloads your music, and tells you when to restart.

Everything comes from your account, so any computer you sign into can become your station. You don't move
files by hand.

**Make sure the first computer says "Everything on this computer is in the cloud"** before you set up
the second one.
If the music never finished uploading, the new computer gets a station it can't play.

---

## Save a copy on this computer

**Save a snapshot** keeps a copy of your setup on this PC only — handy right before a big change so you can
roll back (Settings → Backup & Restore → **Roll back this computer**). Audio files aren't included, and it
doesn't protect you if the computer dies. It's a quick undo, not a backup. Snapshots older than 7 days
are removed automatically.

---

## If a restore says the backup is damaged

You'll see: *"That backup file is damaged and was not used — your current station is untouched and still
running."*

**Nothing has happened to your station.** Ether checks a backup before it touches anything, so a bad file
is refused rather than half-installed. Keep working.

You may also see: *"The downloaded backup didn't save completely (X of Y bytes) — check free disk space
and try again."* The download didn't finish writing. A restore needs roughly three times the size of your
database free on the drive — for a 450 MB station, about 1.4 GB. Free some space and run it again.

If it keeps happening, back up again from the original computer so there's a fresh copy in the cloud, then
retry.

---

## What each thing protects you from

| | Covers your setup | Covers your music | Survives the computer dying |
|---|---|---|---|
| **Back up now** (cloud) | yes | yes | yes |
| **Keep my stuff synced** (the switch) | yes | downloads only — send new audio up yourself | yes |
| **Send just the audio** (Advanced) | no | yes | yes |
| **Save a snapshot** | yes | no | no |
