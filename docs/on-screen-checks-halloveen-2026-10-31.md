# On-screen checks on HalloVeen (2026-10-31)

Jeff, 2026-10-31: "Nothing is live. Stop pausing for checks. Run the remaining checks right on HalloVeen, including A's
Start/Stop on its normal mount. Use test items you create, and delete them after."

Dev Ether on OVEVENTS (unpackaged, `release/1019` at e74524f), HalloVeen = station 2, driven over the DevTools port (no
mouse or keyboard). Screenshots are in the session scratchpad `shots\20-27`.

## A. Stream Manager — Start / Stop on `/halloween`

| Step | What happened | Receipt |
|---|---|---|
| Open ☰ → Stream Manager | Pop-out opened: halloVeen, OFF AIR, Sending to `44.244.52.207:8000/halloween`, 128 kbps (set), password "set — leave blank to keep" | shot 21 |
| Start while OV held `/halloween` | CONNECTING… → ERROR "Streaming failed after repeated ffmpeg restarts. Check Icecast server URL and credentials." → CONNECTING… (Ether kept retrying). **No Stop button was shown in ERROR** — stopped through `stream:stop-live`. | text receipts |
| Jeff signed OV off the mount and pressed ON AIR himself | Stream Manager showed ON AIR, on air 0m 52s → 1m 14s, real bitrate 128 kbps, **Listeners 0** (from the server's status page) | shot 22 |
| Stop in Stream Manager | OFF AIR; main screen light OFF AIR; server: `/halloween` no longer listed | shot 23, `status-json.xsl` |
| Start in Stream Manager | ON AIR 0m 1s → 0m 17s, Listeners 0; server lists `/halloween` with 0 listeners | text receipts |
| Stop in Stream Manager | OFF AIR | text receipt |

**Two defects found and fixed (c372210):**
1. In ERROR, Ether keeps retrying every 30 s but the screen offered only Start. Stop is now offered whenever the stream is
   not stopped.
2. The error replaced the server's reason with a generic "check URL and credentials". It now keeps the reason — for a 403:
   "The server refused the stream (403): another computer may be sending to this mount, or the password is wrong. Ether
   tries again every 30 seconds; press Stop to end it." A stopped stream shows no stale error.

**UNVERIFIED on screen:** the new error text and the Stop-in-ERROR button. Both need the daemon restarted (the daemon
does not reload) and a held mount to fail against. Unit tests cover them (`electron/stream-manager.test.js`).

**Added on Jeff's ask (dd3cfce):** a **Listen live** box with the station's public listener page (Copy / Open), the same
address as Settings → Broadcast → Your listener page. UNVERIFIED on screen until the next restart (main must send the
station's uuid).

## The six checks

| Check | What I did | Result |
|---|---|---|
| Scan Durations (444136c) | `get_file_duration` on a real library song and on a fake `.mp3` (text) | real: **211.1 s**; fake: **0** (reported as failed, not a length) |
| Normalize (4d429cd) | `analyze_lufs` on the same two files | real: `{ok:true, gain:-3.80}`; fake: `{ok:false, error:"Probe: … no suitable format reader found"}` — no made-up −14 dB |
| Shows delete (fc0460f) | Created test show 17 "ETHER TEST show (delete me)" on HalloVeen, then `shows.deleteById(17)` (the call the Delete button now makes) | `{ok:true}`; row tombstoned (`deleted_at` set) |
| Attach audio to a spot (aa1b19d) | Created test spot 10 with no audio. Edit Spot showed **"No audio — this spot can't air until you attach its audio" · Attach audio…** (shot 25). Ran the same steps the button runs after the file is picked (copy into the audio library, probe length, update the spot). Reopened Edit: **"Audio: ETHER TEST spot audio.mp3 · Replace audio…"** (shot 26) | works. The Windows file picker itself was not driven (native dialog). |
| Jukebox full link (a49a141) | Set HalloVeen's request link to `https://listen.ether-technologies.com/jukebox/magicalforest` (the same name it already had), read Links (`links:account`), set it back to `magicalforest` | request name read as `magicalforest` from the full address; restored |
| Show+ DAW → To Deck (39c0d1c) | All HalloVeen decks idle (AUTO did not need stopping). Sent a 2 s test WAV through `showplus.sendToDeck("C", …)` | `{ok:true}`; Deck C: title **"Show+ Mix"**, file in the profile's `showplus-sends` folder (shot 27). The DAW's own record/render screen was not driven. |

## Cleanup

- Test show 17: deleted (tombstone, syncs as a delete).
- Test spot 10: deleted (`spots.deleteById`, tombstone); its audio copy removed from `Ether\catalogue`; no song used it;
  `file_key` was null (never uploaded).
- Deck C: stopped and empty.
- Test mix WAV: removed from `showplus-sends`.
- Jukebox request link: back to `magicalforest`.
- Fake test file: in the scratchpad only.

Noticed, not investigated: HalloVeen's jukebox request name is `magicalforest`.

## Builds checked after restarts (same day)

**A — Listen live (dd3cfce):** Stream Manager shows **LISTEN LIVE https://listen.ether-technologies.com/halloween ·
Copy · Open** (shot 32).

**D — voice-tracking mic (185834f):** Settings → Audio Devices → picked "Voicemeeter Out A4": saved
(`ether_vt_input`), shown ACTIVE. Opened **☰ → Voice Tracker** (new door), pressed REC: the pop-out asked for exactly
that device and got the track "Voicemeeter Out A4 (VB-Audio Voicemeeter VAIO)". With a saved mic that doesn't exist,
REC recorded from the default mic and the screen said "The voice-tracking mic picked in Settings isn't connected —
recording from the default mic." (shot 30). Takes discarded (RECORDED (0)), test value removed.

**B — Stream Metadata Outputs (b60fad5):** schema v69 applied on start (`[migrate-v69] stream_metadata_targets
ready`). In Settings → Broadcast added two test outputs on HalloVeen: a webhook to a local receiver
(`127.0.0.1:5555`) and an Icecast output with **This station's own stream** ticked (the default).
- Test → webhook received `{"title":"Thriller","artist":"Michael Jackson"}` (the song on air); row OK, "last: Michael
  Jackson - Thriller".
- Test → Icecast with nothing streaming: ERROR "HTTP 400 … Source does not exist" (the login was accepted).
- Went live from OVEVENTS on `/halloween` (Jeff: "you can go live now"), Test → Icecast OK; the server's
  `status-json.xsl` showed title **"Michael Jackson - Thriller"**.
- Next song started on its own at 16:17:33Z: the webhook received "Be Prepared / Jeremy Irons" and the server's title
  became **"Jeremy Irons - Be Prepared"**, with no click — both rows OK, 3 sent.
- Stopped the stream (`/halloween` no source), deleted both test outputs (0 left), stopped the receiver.

**C — Remote Access & Website (f0fcf70):** startup log `[remote] serving on port 4242`.
- `/now-playing.json` answered `{"station":"halloVeen","title":"Pink Elephants on Parade - From \"Dumbo\"",…,"playing":true}`.
- `/api/state` without the code → 401; with a wrong code → 401; with the code → now playing + Up Next.
- Phone commands (sent as the phone page sends them): **Skip** → the next item (the sponsor spot) started; **AUTO off**
  → main screen MANUAL; **AUTO on** → ● AUTO; **Stop all** → decks stopped, MANUAL; **AUTO on** again → playing
  ("Dead Man's Party"). HalloVeen was left on AUTO, playing.
- Settings shows the code, New code, "Ether is answering on port 4242" and the "on your network" wording (shot 33).
- **UNVERIFIED from another device:** a request to this computer's network address (192.168.0.114:4242) timed out —
  most likely Windows Firewall holding the first-run "allow on networks" prompt for the dev `electron.exe`. Not
  changed by me. One check settles it: allow the prompt (private networks), then open the address on a phone.

## After Jeff's decisions (same day, restart at 11:44 local)

- **Port from the station's own setting:** Stream Manager shows an editable **Port** = 8000 (halloVeen's
  `icecast_port`), "Sending to 44.244.52.207:8000/halloween" (shot 39).
- **Why this song:** real halloVeen rows read "Movie & TV Instrumentals: the song that waited longest of 5 that met
  every rule" and "Closing: no song met the rules, so the least recently played song went in · STRICT rule broken as the
  last resort: same song (3.5 of 60 min)".
- **Song Analysis → Reset:** Ether's confirm window: "Clear the loudness and BPM measurements of this station's songs?
  They are measured again by Analyze all songs." — answered Cancel, nothing cleared (shot 40).
- **UNVERIFIED on screen:** Cue Editor keys after a waveform click (needs the Cue Editor on a song); Show+ DAW Load
  session (native Open window). Both unit-tested.
- Startup note: this restart logged "daemon not connected" for the first engine polls (the known cold-start race,
  memory "Cold-stage daemon race"); not changed today.
