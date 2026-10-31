---
feature: remote-access
title: Remote Access & Website
summary: Control the station from a phone on this computer's Wi-Fi, and read what's playing from a page on the same network.
where: Settings → Broadcast → Remote Access & Website
since: 4.6.70
audience: operator
tour: false
---

# Remote Access & Website

## What it is

While Ether is open, it answers on **port 4242 on this computer's network**:

- **Phone remote**: a page for a phone or tablet on the same Wi-Fi. It shows what's playing and Up Next, with
  **⏭ Skip**, **⏹ Stop all**, **AUTO on** and **AUTO off** for the station you are working in. These are the same
  commands the web dashboard's remote sends.
- **Now playing**: `/now-playing.json` gives the station, song title, artist, whether it's playing, and when the song
  started. Any page on the same network can read it.

## Use the phone remote

1. Open **Settings → Broadcast → Remote Access & Website**.
2. On the phone, open the address shown (for example `http://192.168.1.20:4242`). The phone must be on the same Wi-Fi as
   this computer.
3. Enter the **6-digit code** shown in Settings. The phone remembers it.
4. Tap **Skip**, **Stop all**, **AUTO on** or **AUTO off**. The phone says "Done." or why it wasn't done.

Click **New code** in Settings to change the code. Every phone then has to enter the new one.

## How it behaves

- The first time, Windows may ask whether to allow Ether on your network. Allow it for private networks, or phones
  can't reach it.
- After 5 wrong codes in a minute, that phone is refused for the rest of the minute.
- If another program is already using port 4242, Settings says so and the remote isn't available.
- Commands go to Ether's main window. If it isn't open, the phone says so.
- **A public website on the internet can't reach this computer's network address.** For your public website, use your
  station's listener page or the embed player (Settings → Broadcast → Your listener page, and Settings → Links).

## Related

- **Your listener page** and **Links**: the public addresses for listeners and websites.
- **Stream Manager**: the station's stream and its listen-live link.
