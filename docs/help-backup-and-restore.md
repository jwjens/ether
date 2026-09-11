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

There is no separate switch for this. **Keep my stuff synced** is the one switch, and while it is on Ether
keeps your cloud copy current on its own — your setup and your audio, both directions, on every computer
signed into your account. Leave it on.

To change how often your setup goes up, open **Advanced** and use **How often to send your setup** (every
hour up to once a day), then press **Save**. That row only sets the schedule; on and off is the switch
above it. Your audio goes up as it changes, not on that schedule.

If you've just imported a big batch and don't want to wait, press **Back up now**.

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

**Back up now** already includes your music, so you rarely need anything else. If you want to force the
audio up on its own — say you're not sure an import made it — open **Advanced** and press **Re-send every
file, even ones already uploaded**.

**WHERE YOUR AUDIO LIVES** (under **Advanced**) shows the folder Ether keeps your library in. **Change
folder** moves it. This is
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
| **Keep my stuff synced** (the switch) | yes | yes | yes |
| **Re-send every file** (Advanced) | no | yes | yes |
| **Save a snapshot** | yes | no | no |
