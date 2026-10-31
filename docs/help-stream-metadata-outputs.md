---
feature: stream-metadata-outputs
title: Stream Metadata Outputs
summary: Send "Artist - Title" for every song that starts on a station to your stream, TuneIn, an RDS encoder or a webhook.
where: Settings → Broadcast → Stream Metadata Outputs
since: 4.6.70
audience: operator
tour: false
---

# Stream Metadata Outputs

## What it is

Every time a song starts on a station, Ether sends **"Artist - Title"** to each output you add here, all at once. Use it
to show the song title on your stream, in TuneIn, on an FM radio's display (RDS), or in your own tools.

Outputs belong to the station you are working in and are kept on this computer. Ether sends from the background, so
titles keep going out with no window open.

## Kinds of output

- **Icecast 2**: the song title on an Icecast mount. Tick **This station's own stream** to use the server, mount and
  password from Stream Manager (the stream ON AIR sends). Untick it to enter another Icecast server and its admin login.
- **Shoutcast**: a Shoutcast v1 or v2 server.
- **TuneIn AIR**: your TuneIn Partner ID, Partner Key and Station ID (from tunein.com/broadcasters).
- **RDS Encoder (Serial)**: an FM RDS encoder on a serial (COM) port. Pick the port from the list of ports this
  computer has, the baud rate, and the encoder type (Inovonics, Audemat / WorldCast, Deva, or plain text). RadioText is
  limited to 64 characters.
- **Custom Webhook**: Ether POSTs `{ "title", "artist", "album", "duration", "timestamp" }` as JSON to your URL.

## Use it

1. Open **Settings → Broadcast → Stream Metadata Outputs**. It shows the station you are working in.
2. Under **+ Add a new metadata output**, pick a kind, fill it in, and click **Save**.
3. Click **Test** to send the station's current song to that output now. The row says what was sent and whether it
   worked.
4. Use **ON / OFF** to pause an output, **Edit** to change it, and **✕** to delete it.

## How it behaves

- Each row shows its last result: **OK**, or **ERROR** with the reason (for example "HTTP 401"), plus how many titles
  it has sent, when it last sent, and the last title it sent.
- A slow or failing output never holds up the others.
- Test sends a line "Ether - Test from Ether" when nothing has played on the station yet since Ether started.
- Outputs are not copied to your other computers: a serial port and a server password belong to the computer that
  sends.

## Related

- **Stream Manager**: the station's stream (server, mount, password) that an Icecast output can use.
