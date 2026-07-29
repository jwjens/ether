# Lightsail box `44.244.52.207` — read-only survey of the Show+ guests plane

**Date:** 2026-07-28 · **Host:** `guests.ether-technologies.com` = `44.244.52.207` = `ip-172-26-4-199`
**OS:** Ubuntu 24.04.4 LTS · **Uptime:** 98 days · **Access:** `ssh -i ~/.ssh/LightsailDefaultKey-us-west-2.pem ubuntu@guests.ether-technologies.com`
**Mode:** READ-ONLY. Every command run was an inspection (`ss`, `ls`, `cat`, `grep`, `diff`, `systemctl status`,
`dpkg -l`, `ufw status`, `openssl x509 -noout`). **Nothing installed, restarted, written, or reconfigured.** Icecast
was never touched and stayed up throughout.

---

## Headline

**There is no TURN server on this box and there never has been.** The designed path does **not** already cover it —
`coturn` is not installed, no `turnserver` binary exists, no TURN config file exists, no unit exists, and **no version
of the signaling server — current or any of its four backups — has ever contained a `turn:` URL, a credential handoff,
or anything but a single Google STUN entry.** That question is now closed with receipts.

**The box's role in the guest path is signaling only.** nginx terminates TLS on 443 and proxies to a Node process on
`127.0.0.1:9091` that does two things: serves the `/join` page and brokers the `/signal` WebSocket. **Guest media never
touches this box** — with no relay, media is peer-to-peer or it does not happen.

**Two findings that change the picture from the earlier trace:**

1. **The guest page requests video and refuses to proceed without it** (`server.js:225`) — so any guest who reaches the
   waiting room **is** sending video. `docs/showplus-guest-tile-black-video-trace-2026-07-28.md` §4 (UNKNOWN: "is video
   negotiated?") is **now answered: yes.** The black tile was never an audio-only guest.
2. **Every logged guest join is from an iPhone on a mobile carrier IP** (`172.56.211.249`, `192.70.164.4`). That is the
   network case where STUN-only most reliably fails.

---

## 1. What is listening, and what serves `/signal` and `/join`

```
$ sudo ss -tulpn
tcp LISTEN 0 5    0.0.0.0:8000  users:(("icecast2",pid=713680,fd=5))
tcp LISTEN 0 5    0.0.0.0:8443  users:(("icecast2",pid=713680,fd=4))
tcp LISTEN 0 4096 0.0.0.0:22    users:(("sshd",pid=707842,fd=3),("systemd",pid=1,fd=163))
tcp LISTEN 0 511  0.0.0.0:80    users:(("nginx",pid=707876,fd=5),("nginx",pid=707875,fd=5),("nginx",pid=687581,fd=5))
tcp LISTEN 0 511  0.0.0.0:443   users:(("nginx",pid=707876,fd=8),("nginx",pid=707875,fd=8),("nginx",pid=687581,fd=8))
tcp LISTEN 0 511  127.0.0.1:9091 users:(("node",pid=216579,fd=18))
udp/tcp 127.0.0.53:53, 127.0.0.54:53  systemd-resolve   (loopback only)
udp 127.0.0.1:323, [::1]:323          chronyd           (loopback only)
```

| Port | Bound | Process | Job |
|---|---|---|---|
| 22 | 0.0.0.0 | `sshd` | admin access |
| 80 | 0.0.0.0 | `nginx` | 301 → https (Certbot-managed) |
| **443** | 0.0.0.0 | **`nginx`** | **TLS termination + WebSocket-upgrade proxy for the guests plane** |
| **9091** | **127.0.0.1 only** | **`node` pid 216579** | **`/opt/ether-signal/server.js` — the signaling server** |
| 8000 | 0.0.0.0 | `icecast2` | live listener stream (plain) |
| 8443 | 0.0.0.0 | `icecast2` | live listener stream (TLS) — matches `CLAUDE.md:70` |
| 53, 323 | loopback | `systemd-resolve`, `chronyd` | local DNS / NTP, not externally reachable |

**Nothing else listens. No 3478, no 5349, no relay of any kind.**

Running services (trimmed to the relevant two):

```
$ systemctl list-units --type=service --state=running --no-legend
  ether-signal.service   loaded active running Ether Guest Signaling Server
  icecast2.service       loaded active running LSB: Icecast2 streaming media server
  nginx.service          loaded active running A high performance web server and a reverse proxy server
```

**What serves `/signal` and `/join` — exactly:** both are the *same* Node process, `ether-signal.service` →
`/opt/ether-signal/server.js`, reached only through nginx.

```
$ cat /etc/nginx/sites-available/guests.ether-technologies.com
server {
    server_name guests.ether-technologies.com;
    location / {
        proxy_pass http://127.0.0.1:9091;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        …
        proxy_read_timeout 86400;
    }
    listen 443 ssl;                       # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/guests.ether-technologies.com/fullchain.pem;
}
```

Inside `server.js`:

```
$ grep -n -E "app\.(get|post|use)|WebSocketServer|Server\(" /opt/ether-signal/server.js
14:const server = http.createServer(app);
24:app.get('/health', (req, res) => res.send('ok'));
30:app.get('/verify-code', (req, res) => { …
68:app.get('/join', (req, res) => { …            ← the guest page, generated INLINE as an HTML string
349:const wss = new WebSocket.Server({ server, path: '/signal' });
```

**The guest page has no separate source. It is a template literal inside `server.js` starting at line 68** — which is
why the earlier audit found it in no repo. Its client-side JS (the whole guest WebRTC implementation) lives in lines
~86-340 of that same file.

Incidental, one line: `ether-playout.service` (the `:3500` API in `close-out-tracker.md:113` / OB5) is
`disabled` and `inactive (dead)` — nothing is listening on 3500.

---

## 2. Where the signaling service lives on disk — and it is not under git

```
$ systemctl cat ether-signal.service
[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/ether-signal
ExecStart=/usr/bin/node /opt/ether-signal/server.js
Restart=always
RestartSec=5
StandardOutput=append:/var/log/ether-signal.log
Environment=NODE_ENV=production

$ systemctl status ether-signal.service
● ether-signal.service - Ether Guest Signaling Server
     Loaded: loaded (/etc/systemd/system/ether-signal.service; enabled; preset: enabled)
     Active: active (running) since Mon 2026-05-04 23:59:40 UTC; 2 months 24 days ago
   Main PID: 216579 (node)
     Memory: 23.6M (peak: 34.8M)

$ ls -la /opt/ether-signal/
drwxrwxr-x 68 ubuntu ubuntu  4096 May  3 22:57 node_modules
-rw-rw-r--  1 ubuntu ubuntu 29555 May  3 22:57 package-lock.json
-rw-rw-r--  1 ubuntu ubuntu   296 May  3 22:57 package.json
-rw-rw-r--  1 ubuntu ubuntu 10925 May  4 23:58 server.js
-rw-r--r--  1 root   root    4446 May  4 00:32 server.js.bak
-rw-r--r--  1 root   root    8055 May  4 02:49 server.js.bak.1777862994
-rw-r--r--  1 root   root   10715 May  4 02:50 server.js.bak.1777863024
-rw-r--r--  1 root   root   10715 May  4 23:56 server.js.bak.before-ontrack-fix

$ [ -d /opt/ether-signal/.git ] && … || echo "NO .git DIRECTORY IN /opt/ether-signal"
NO .git DIRECTORY IN /opt/ether-signal
```

- **Directory:** `/opt/ether-signal` · **Entry point:** `server.js` (10,925 bytes) · **Deps:** `express@^5.2.1`,
  `ws@^8.20.0` (`package.json`).
- **Under git: NO.** No `.git`, therefore **no remote configured**. The only version history is four `.bak` files
  written by hand.
- **This source exists in exactly one place on earth: this box.** It is not in `jwjens/ether` or any other repo. If
  this instance is lost, the guest plane is lost with it. The service has not restarted since **2026-05-04 23:59:40 UTC**.

The last edit ever made to it, recovered by diffing the newest backup against the live file:

```
$ diff /opt/ether-signal/server.js.bak.before-ontrack-fix /opt/ether-signal/server.js
140a141
>     <video id="remoteVideo" autoplay playsinline></video>
284c285
<           pc.ontrack = (ev) => {};
---
>           pc.ontrack = (ev) => { const rv = document.getElementById("remoteVideo"); if (rv && ev.streams && ev.streams[0]) { rv.srcObject = ev.streams[0]; rv.play().catch(() => {}); } };
```

That May-4 change added the **guest's view of the host** (host → guest direction). It does not touch the guest → host
direction that the black tile depends on.

---

## 3. Is coturn / any TURN or relay installed? Running?

**No — on every check.**

```
$ dpkg -l | grep -iE "coturn|turnserver|stun"
NOT INSTALLED (no dpkg match)

$ systemctl status coturn
Unit coturn.service could not be found.

$ ls -la /etc/turnserver.conf /etc/coturn* /etc/default/coturn
ls: cannot access '/etc/turnserver.conf': No such file or directory
ls: cannot access '/etc/coturn*': No such file or directory
ls: cannot access '/etc/default/coturn': No such file or directory

$ command -v turnserver turnadmin stund
none on PATH
```

Corroborated by the port table in §1: nothing listens on 3478 (STUN/TURN), 5349 (TURN/TLS), or any UDP relay range.
The only UDP sockets on the box are loopback DNS and NTP.

---

## 4. TURN config — realm, ports, credential scheme

**Not applicable: no TURN configuration exists anywhere on this box.** No realm, no listening ports, no credential
scheme — static-auth-secret or long-term users — because there is no TURN service, config file, or package. Nothing
was printed because there is nothing to print. (No secret of any kind was read or output during this survey.)

---

## 5. Firewall — what is open today

**Host firewall is off:**

```
$ sudo ufw status verbose
Status: inactive
```

So every listening socket in §1 is exposed to whatever the **AWS Lightsail firewall** (the instance's networking rules,
managed in the AWS console) permits. That layer is **not visible from inside the instance** — **UNKNOWN** from here,
and readable only in the Lightsail console.

What is nevertheless *established by observed traffic* on the AWS layer:

| Port | Evidence it is open to the internet |
|---|---|
| 22 | this SSH session, from an external address |
| 443 | nginx access log shows external client IPs fetching `/join` (§7) |
| 80 | Certbot renewals + the 301 vhost are configured against it |
| 8000 / 8443 | Icecast is live to real listeners (the reason this box must not be disturbed) |

Ports **3478 / 5349 are irrelevant today** — nothing is bound to them regardless of firewall state.

TLS is healthy: `notAfter=Oct 1 02:56:17 2026 GMT` for `guests.ether-technologies.com`.

---

## 6. Did the signaling service ever hand clients `iceServers` or TURN credentials?

**No — not in the live file, and not in any of its four historical backups.**

```
$ for f in server.js server.js.bak*; do grep -n "iceServers" "$f"; done
server.js:265:                          pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
server.js.bak:                          (none)
server.js.bak.1777862994:170:           pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
server.js.bak.1777863024:264:           pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
server.js.bak.before-ontrack-fix:264:   pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

$ grep -n -iE "turn:|turns:|credential|username.*password|static-auth" server.js server.js.bak*
NONE IN ANY VERSION
```

The `iceServers` value is **hard-coded into the guest page's inline script** — it is not served as config, not
fetched, and not negotiated. Both ends of the call are therefore STUN-only, independently hard-coded:

| End | Location | Value |
|---|---|---|
| Guest | `/opt/ether-signal/server.js:265` (inline page script) | `stun:stun.l.google.com:19302` |
| Host | `src/components/ShowPlus.tsx:494-496` (desktop app) | `stun:stun.l.google.com:19302`, `stun1.l.google.com:19302` |

**Two further facts from the guest source, both bearing directly on the black-tile investigation:**

```
$ sed -n '218,290p' /opt/ether-signal/server.js
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });   ← line 225
  …
  } catch (e) {
    errorMsg.textContent = 'Could not access camera/microphone: ' + e.message;
    joinBtn.disabled = false;
    return;                        ← join ABORTS if media is denied; there is no audio-only path
  }
  …
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));                        ← line ~269
  pc.onicecandidate = (ev) => { if (ev.candidate) ws.send(JSON.stringify({ to: 'host', type: 'ice', payload: ev.candidate })); }
```

1. **The guest always sends video.** `video: true` is unconditional, there is no audio-only toggle, and a
   `getUserMedia` failure aborts the join outright. **This closes §4 of
   `docs/showplus-guest-tile-black-video-trace-2026-07-28.md`**, which could not decide whether video was negotiated.
   It is. The black tile was a media-flow failure, never an audio-only guest.
2. **Both tracks are added with the stream**, so the host's `e.streams[0]` is always populated — meaning the
   late-track re-attach defect (trace §7.4) is **not** in play for this guest page.
3. The guest trickles candidates to `'host'` the instant they are gathered — the exact behaviour that made the
   pre-Accept drop (fixed in 4.4.96) fatal.

**Unfixed mirror defect, reported not fixed:** the guest side has the same silent-drop bug the host had —
`server.js:313`: `try { await pc.addIceCandidate(msg.payload); } catch {}`, with no queue. Host candidates arriving
before the guest applies the answer are discarded silently, exactly as the host discarded the guest's.

---

## 7. Logs — when did this last carry working guest media?

**It never has, and no log here could show it.** With no TURN, **guest media has never traversed this box** — the
signaling server brokers SDP and ICE messages only. It sees sockets, not media. Nothing in these logs can attest that
video ever flowed end-to-end.

What the logs *do* show:

```
$ ls -la /var/log/ether-signal.log
-rw-r--r-- 1 root root 11943 Jul 28 20:18 /var/log/ether-signal.log

$ head -1 /var/log/ether-signal.log
[SIGNAL] Server listening on 127.0.0.1:9091

$ grep -c "guest.*connected" /var/log/ether-signal.log
75

$ tail -12 /var/log/ether-signal.log
[SIGNAL] guest 92df2b78 connected for token on0qbs6n...
[SIGNAL] host disconnected for token on0qbs6n...
[SIGNAL] host connected for token on0qbs6n...
[SIGNAL] guest 2fb6040f connected for token on0qbs6n...
[SIGNAL] guest db62e34d connected for token on0qbs6n...
[SIGNAL] guest 1ddf048d connected for token on0qbs6n...
[SIGNAL] host disconnected for token on0qbs6n...
```

**The signaling log has no timestamps at all** — 75 guest connections since 2026-05-04, none dated. It also records no
ICE outcome, no connection state, and no media events. As an operational record it can answer "did a socket connect",
nothing more.

nginx access logs *do* carry timestamps (≈14-day retention; oldest `access.log.14.gz` = 14 Jul):

```
$ sudo zgrep -h "GET /join" /var/log/nginx/access.log* | awk -F"[][]" '{print $2}' | cut -d: -f1 | sort | uniq -c
      1 23/Jul/2026
      1 27/Jul/2026
      6 28/Jul/2026

$ sudo zgrep -h "GET /join" /var/log/nginx/access.log* | tail -5
192.70.164.4   - - [28/Jul/2026:18:42:47 +0000] "GET /join?s=on0qbs6no21x8xb7 HTTP/1.1" 304 0 "-" "Mozilla/5.0 (iPhone; CPU iPhone OS 26_5_2 …
192.70.164.4   - - [28/Jul/2026:18:44:02 +0000] "GET /join?s=on0qbs6no21x8xb7 HTTP/1.1" 304 0 "-" "Mozilla/5.0 (iPhone; CPU iPhone OS 26_5_2 …
192.70.164.4   - - [28/Jul/2026:19:03:10 +0000] "GET /join?s=on0qbs6no21x8xb7 HTTP/1.1" 304 0 "-" "Mozilla/5.0 (iPhone; CPU iPhone OS 26_5_2 …
172.56.211.249 - - [27/Jul/2026:22:26:20 +0000] "GET /join?s=vnriqo2mbqm3ilxt HTTP/1.1" 200 2227 "-" "Mozilla/5.0 (iPhone …
192.70.164.4   - - [23/Jul/2026:22:30:13 +0000] "GET /join?s=3pxhe0votn2n2mdb HTTP/1.1" 200 2227 "-" "Mozilla/5.0 (iPhone …
```

- Only **8 guest-page loads in the entire retained window** (23, 27, 28 July). Anything before ~14 July has rotated
  away → **UNKNOWN**, which is very likely where "it worked before" lives.
- **Every single one is an iPhone**, from **mobile-carrier addresses** (`172.56.211.249`, `192.70.164.4`).

**Interpretation, flagged as interpretation rather than log fact:** a mobile carrier connection is the textbook case
of NAT that STUN alone cannot traverse (carrier-grade NAT commonly presents as symmetric). With both ends hard-coded
STUN-only and no relay in existence, a phone guest failing at `checking → disconnected → failed` — precisely what was
observed after the 4.4.96 fix — is the expected outcome, not an anomaly. Whether earlier successful sessions used a
different guest network is not answerable from the retained logs.

---

## Bearing on the open question

Jeff's instruction was not to propose TURN until the docs had been read, because the designed path might already cover
it. It does not: **no relay has ever existed on this box, and no version of the signaling server has ever handed one to
a client.** The guest plane as built is nginx + a hand-installed, ungit'd Node signaling process, with media left
entirely to peer-to-peer STUN.

Nothing is proposed here. The facts are recorded; the call is Jeff's.

## Scope note

Read-only throughout. No file on the box was created, edited, moved, or deleted; no service was started, stopped, or
reloaded; no firewall or config was changed; no package was installed; no secret was printed. Icecast served listeners
without interruption for the duration. The only local change was installing the `.pem` into `~/.ssh/` and loading it
into an ssh-agent, at Jeff's explicit instruction.
