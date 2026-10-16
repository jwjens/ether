# Park relay: ports checked from outside (2026-10-15, 6:38–6:40 PM PDT)

Jeff opened the Lightsail firewall for TCP 8322, TCP 8189 and UDP 8189 and asked for an outside check.
Checked from OVEVENTS (outside the server). Probe only: nothing was changed, and Railway values and Listen were not touched.
Script: session scratchpad `relay-probe.js` (plain TCP connect, TLS handshake + one RTSP `OPTIONS`, one bare STUN packet, one
HTTP `OPTIONS`).

## Results (verbatim)

```
TCP 8322: OPEN (connected in 88 ms, remote 6.6.1.33)
TCP 8189: NO ANSWER in 6 s (filtered)
TCP 8889: NO ANSWER in 6 s (filtered)
TCP 8443: OPEN (connected in 34 ms, remote 6.6.1.33)
TLS 8322: handshake OK, cert CN=stream.ether-technologies.com valid_to=Nov 29 17:53:41 2026 GMT authorized=true
RTSP OPTIONS reply:
  RTSP/1.0 200 OK
  CSeq: 1
  Public: DESCRIBE, ANNOUNCE, SETUP, PLAY, RECORD, PAUSE, GET_PARAMETER, TEARDOWN
  Server: gortsplib
UDP 8189: no reply to a bare STUN request in 4 s (expected even when open: MediaMTX only answers STUN for a live session)
WHEP OPTIONS https://stream.ether-technologies.com/park/probe/whep: HTTP 500; server=nginx/1.24.0 (Ubuntu); link=-
```

TCP 8189 rechecked twice with curl: `Connection timed out after 8010 / 8016 milliseconds`.
WHEP body: `{"status":"error","error":"path 'park/probe' is not configured"}` (MediaMTX's own answer for a made-up path).

## What it means

- **TCP 8322 works.** MediaMTX answers RTSPS from outside with a valid certificate. This is the station's Listen and Talk port.
- **WHEP over 443 works.** nginx passes `/park/...` to MediaMTX, which answers. (TCP 8889 stays closed, as intended: phones
  go through nginx.)
- **TCP 8189 does not answer.** Packets are dropped, not refused. Phones on networks that block UDP can't fall back.
  Causes the outside view can't tell apart:
  - the Lightsail rule isn't in effect (e.g. saved on the IPv6 list only, wrong instance, not saved);
  - a firewall on the server itself (ufw/iptables) drops it;
  - MediaMTX isn't listening on TCP 8189 (`webrtcLocalTCPAddress` empty). On its own this gives "refused", not a timeout,
    so it would need a host firewall too.
- **UDP 8189: can't be confirmed from outside yet.** MediaMTX only answers on it during a real WebRTC session, and a real
  session needs the Railway values (auth), which wait for Jeff's GO. **UNVERIFIED** until the first Listen session plays.

## Re-probe of TCP 8189 (2026-10-15, 6:45 PM PDT)

Jeff added the Lightsail rule: Custom · TCP · 8189 · Any IPv4 address, on ether-playout. Probe only, as before; Railway values
and Listen were not touched.

**Result: answered, 3 of 3.**

```
TCP 8189 try 1: 000 Recv failure: Connection was reset
TCP 8189 try 2: 000 Recv failure: Connection was reset
TCP 8189 try 3: 000 Recv failure: Connection was reset
```
(curl: the connection opened, then MediaMTX closed it on the HTTP request, which isn't WebRTC.) Then a plain TCP connect
(scratchpad `tcp8189.js`, sends nothing):
```
try 1: ANSWERED (TCP connected in 75 ms)
try 2: ANSWERED (TCP connected in 37 ms)
try 3: ANSWERED (TCP connected in 43 ms)
```

- The cause of the earlier timeouts was the missing Lightsail rule. Nothing on the server was dropping it, and MediaMTX is
  listening on TCP 8189.
- **UDP 8189 is still UNVERIFIED** until the first real Listen session (after Jeff's GO on the Railway values).

## Relay secret read + Railway values set (2026-10-16, 9:57 AM PDT, Jeff GO)

**Read on the stream server (read-only, Jeff OK; nothing changed there).** `mediamtx` service active, config
`/etc/mediamtx/mediamtx.yml`:
```
authMethod: http
authHTTPAddress: https://ether-backend-production.up.railway.app/internal/mediamtx/auth?s=<hidden>
rtspsAddress: :8322
webrtcLocalUDPAddress: :8189
webrtcLocalTCPAddress: :8189
webrtcAdditionalHosts: [44.244.52.207]
```
- The server's own public IP (`checkip.amazonaws.com`, asked from the server) is `44.244.52.207`, so the relay tells phones
  the right address. This settles the open `webrtcAdditionalHosts` question in the Hold-to-talk plan.
- From OVEVENTS, DNS answers `6.6.1.33` for the stream name, even through 1.1.1.1 and 8.8.8.8, yet connects to the same
  server with a valid cert. Looks local to this machine's network; noted only, not looked into.

**Set on Railway (service ether-backend), one save:**
- `PARK_LISTEN_RTSP_BASE = rtsps://stream.ether-technologies.com:8322`
- `PARK_LISTEN_WHEP_BASE = https://stream.ether-technologies.com`. Nothing after it, because the server adds
  `park/<station>` itself (`ether-backend/src/lib/park-listen.js:24`). The plan's earlier `.../park` value was wrong.
- `MEDIAMTX_AUTH_SECRET`: set, length 48, sha256 prefix `3ccb5cf8`, the same as the relay's `?s=` value. Neither the
  secret nor the hash input was printed. Local copy deleted.

**Restart:** deployment `7dbe73fc` SUCCESS 9:58 AM (old `15cf29b5` removed).

**After the restart:**
- `/health` → 200.
- `GET /public/ops/halloween` → 200: station online, mirrored, level 0.42 MUTED, closing 21:30, 4 carts (30 MIN, 15 MIN,
  FULL CLOSING OUTRO, CLOSED), now playing "Zombie", 4 announcements queued for tonight, `listenReady: false`.
- Without login, writes are refused: mute / level / fire / closing-time → 403, and Listen → 403 "Log in to make changes."
- The relay auth endpoint with a wrong secret → 401.
- Live page `park.ether-cast.com/halloween` in a browser at 10:00 AM: clock, Now Playing, closes 9:30 PM,
  4 announcements, fader -7.5 dB MUTED ("Muted from Park page, 8:59 PM"), carts 1-4, Log in.

**Listen stays off.** The park machine needs the new build and its Listen settings (`listen.ready`). Not touched.
UDP 8189 is still UNVERIFIED until the first real session.

## Why LISTEN is greyed (2026-10-16, 10:59 AM PDT)

Jeff: "76f29be1 is installed on ovowforestmusic and its Listen settings are filled in (MONITOR, 24 kbps, Mono, 20 ms,
buffer 0)."

- **No Park page deploy is needed.** LISTEN (commit `1303a47`) is already on the live page. It went out with yesterday's
  announcements deploy (`ab9f1b6` is built on it). It shows only to logged-in staff (`ether-park src/App.tsx:484`) and is
  greyed with "Listen isn't set up on this station" until the station reports `listen.ready`.
- **The server needs nothing more.** The three Railway values are set (above).
- **The air machine reports Listen not ready.** Its ops_config push at 17:59:08Z reads `listen: {"ready":false,"buffer_ms":null}`.
  - `ready` is true only when all five settings are saved (`src/lib/ccData.ts:404`).
  - `buffer_ms: null` means the station has **no saved Listener buffer**. `kvNum` gives null only for a missing row; a
    saved `0` would read 0.
  - Each Listen setting has its own **Save** button (`src/components/ParkListenSettings.tsx:115`), so a typed 0 that wasn't
    saved stays unsaved. Whether the other four are saved can't be seen from here.
- Fader, MUTE, carts and closing time at 17:58Z (`/public/ops/halloween`): station online, unmuted, closing 21:30, 4 carts,
  writes without login 403. The page code is unchanged since the 10:00 AM browser check.
- For the session watch, the relay log (`journalctl -u mediamtx`) is readable read-only.

## "Buffer 0 reads as not set": checked (2026-10-16, 11:02 AM PDT)

Jeff (verbatim): "I saved all five Listen settings again on ovowforestmusic, Listener buffer = 0, and it still reports blank /
not ready. Likely 0 is being treated as 'not set' somewhere (station save, the report, or the server check)."

What the station actually sent, read from the cloud (read-only):

| Air machine push (UTC) | listen |
|---|---|
| 17:59:08 | `{"ready":false,"buffer_ms":null}` |
| 18:02:08 | `{"ready":true,"buffer_ms":0}` |

The server's `/public/ops/halloween` at 18:02:35Z returned `listen: {"ready":true,"buffer_ms":0}`.

- **0 is accepted all the way through.** The station saves it (`ParkListenSettings.tsx:51` allows 0–4000; `"0"` is not
  empty), the report counts it (`ccData.ts:404` checks `!== ""`, `kvNum("0")` = 0), and the server and page keep it
  (`Number.isFinite`).
- The 17:59 push had no saved buffer. The 18:02 push, after the re-save, had 0 and ready. So what Jeff saw as "still blank"
  was most likely read before the 18:02 push. **UNVERIFIED** which screen showed it: the Park page button, or the
  "now:" line in Preferences.
- **A different defect found (not fixed, not deployed):** the server turns a *missing* buffer into 0.
  - `ether-backend src/index.js:5624` and `:6058` use `Number(x)`, and `Number(null)` is 0. That is why the server showed
    `buffer_ms: 0` at 17:58 while the station sent null.
  - It's harmless today, because LISTEN stays greyed while `ready` is false.
  - The fix would check for null first.
