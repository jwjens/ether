---
feature: stream-manager
title: Stream Manager
summary: See and control this station's live stream to Icecast — the same stream as the ON AIR button — with its real status and listener count.
where: ☰ menu → Stream Manager (also Tools → Stream Manager)
since: 4.6.70
audience: operator
tour: false
---

# Stream Manager

## What it is

**Stream Manager** is the full view of the active station's live stream to your Icecast server. It is the **same
stream as the ON AIR button**: starting or stopping it here does exactly what ON AIR does, and the two always agree.

It shows:
- **Status**: OFF AIR, CONNECTING…, ON AIR, or ERROR with the reason (for example "Auth failed (401)").
- **Time on air** since the stream connected.
- **Sending to**: the server, port and mount the stream goes to.
- **Bitrate**: what the encoder is actually sending while on air, and the station's setting otherwise.
- **Listeners**: the number of people listening to this mount, read from your Icecast server's own status page.
- **Listen live**: your station's public listener page, with **Copy** and **Open**. It is the same address as Settings →
  Broadcast → Your listener page. If the station has no listener page yet, it says where to turn one on.

## When to use it

- To check that the stream is really on air and how many people are listening.
- To copy or open the station's listen-live link.
- To change the station's Icecast server, mount, password or bitrate.
- To start or stop the stream when you are not on the main screen.

## Use it

1. Open **☰ → Stream Manager**. It shows the station you are working in.
2. To change the stream settings, edit **Server**, **Mount**, **Password** and **Bitrate**, then click **Save
   settings**. Leave Password blank to keep the one already set. These are the same settings as Station Manager; there
   is only one set.
3. Click **▶ Start streaming** to go on air, or **⏹ Stop streaming** to stop. ON AIR on the main screen changes with it.

## How it behaves

- Saved settings are used the next time the stream starts. If it is on air, stop and start it to switch over.
- Ether sends to the port written in the server address (for example `stream.example.com:8443`), or to port 8000
  when none is written.
- If the stream keeps failing, the status says ERROR with the server's own reason (for example "The server refused the
  stream (403): another computer may be sending to this mount, or the password is wrong"). Ether tries again every 30
  seconds until you press **⏹ Stop streaming**.
- If the listener count can't be read (the server doesn't answer, or its status page is off), Stream Manager says so
  and shows "unknown". It never guesses. "mount not on server" means the server has no stream on that mount right now.
- Song titles sent to Icecast are set up in Stream Metadata Outputs, not here.

## Related

- The **ON AIR** button on the main screen: the same stream.
- **Station Manager**: the same stream settings, along with the rest of the station.
