# Backing up your station, and putting it on another computer

Your station lives in two parts, and both matter:

- **Your setup** — your song list, clocks, shows, schedule, categories and settings.
- **Your music files** — the actual audio.

A backup is only useful if it has both. A setup without the audio restores onto a new computer looking
perfectly normal, and then the songs won't play.

---

## Backing up

**Settings → Backup & Restore → Back up now.**

That one button does everything: it saves your setup to the cloud, then sends any songs that aren't in
the cloud yet. You don't have to run anything else.

When it finishes, the panel tells you exactly where you stand:

- **✓ Your station is backed up** — *"Setup and all 511 songs"*. Everything is safe. This is the only
  state that means you can rebuild on another computer.
- **⚠ Music files unfinished** — *"137 of 511 songs aren't in the cloud — they'd arrive on another
  computer with no audio."* Your setup is saved, but some audio hasn't been sent. Press **Finish backing
  up** to send the rest.

The count is read from your actual library every time, so it always reflects what is really in the cloud.

**Songs you've deleted are not backed up.** Deleting a song removes it from your library, your schedule
and the cloud. It won't reappear on another computer.

### Automatic backups

Turn on **Back up automatically** and pick how often (every hour up to once a day). Ether keeps your cloud
copy current while it's open. Automatic backups cover your setup — if you've added a batch of songs, press
**Back up now** so the audio goes up too.

### Sending just the music

Under **Your music files** there's **Send my music to the cloud**. **Back up now** already includes your
music, so you only need this if you want to send audio on its own — handy right after importing a batch.
Underneath it you'll see how many of your songs are in the cloud.

**Where your songs live** shows the folder Ether keeps your library in. **Change folder** moves it. This is
also the folder your music lands in on another computer.

---

## Setting up another computer

Install Ether, sign in with your email and password, and Ether offers to install your station from the
cloud. It pulls your setup first, then downloads your music, and tells you when to restart.

Everything comes from your account, so any computer you sign into can become your station. You don't move
files by hand.

**Make sure the first computer says "backed up — setup and all songs"** before you set up the second one.
If the music never finished uploading, the new computer gets a station it can't play.

---

## Save a copy on this computer

**Save a snapshot** keeps a copy of your setup on this PC only — handy right before a big change so you can
roll back. Audio files aren't included, and it doesn't protect you if the computer dies. It's a quick
undo, not a backup.

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
| **Back up automatically** | yes | setup only | yes |
| **Send my music to the cloud** | no | yes | yes |
| **Save a snapshot** | yes | no | no |
