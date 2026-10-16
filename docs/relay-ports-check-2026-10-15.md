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
