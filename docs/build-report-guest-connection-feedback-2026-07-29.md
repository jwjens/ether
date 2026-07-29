# Build report — guest page connection feedback (honest state on the guest side)

**Date:** 2026-07-29 · **Box:** `guests.ether-technologies.com` (44.244.52.207) · **File:** `/opt/ether-signal/server.js`
**Backup taken BEFORE editing:** `/opt/ether-signal/server.js.bak-before-guestfeedback-20260729_034656` (16,328 bytes)
**Deployed to disk:** yes, 24,486 bytes · **`node --check` on the box:** SYNTAX OK
**Service restarted:** **NO — awaiting GO.** Icecast and nginx untouched.

---

## The problem

Once a guest joined, the page told them nothing. `stage2` was three elements — their own video, an empty remote
video, and a `<p>` whose text was last set by whichever message happened to arrive (`'Connected!'` on the SDP answer,
regardless of whether ICE ever succeeded). A guest could be fully live and not know it, or completely disconnected
and still reading *"Connected!"*.

`'Connected!'` on answer was the exact failure this fixes: **the answer means the host clicked Accept, not that media
is flowing.** With the host on recvonly and ICE failing, the old page said "Connected!" the entire time.

---

## What was added

All line numbers below are in the **deployed** `/opt/ether-signal/server.js`.

### 1. A status line driven by the peer connection's real state — `:376-397`, `:531-534`

`applyPcState(pc)` (`:379-397`) reads **`pc.connectionState` and `pc.iceConnectionState` only** — it never consults a
variable the page set for itself:

| Observed state | Shown |
|---|---|
| `connectionState === 'connected'` | **"You're connected. The host can see and hear you."** (green) |
| `connectionState`/`iceConnectionState === 'failed'` | "Connection failed. Ask the host to remove you and send the link again." (red) |
| either `=== 'disconnected'` | "Reconnecting…" (amber, pulsing) |
| `connectionState === 'closed'` | "Disconnected." (grey) |
| not yet admitted | "Waiting for the host to let you in…" (amber) |
| admitted, still negotiating | "Connecting…" (amber) |

Wired to both callbacks the brief named, at `:531-534`:

```
pc.onconnectionstatechange = () => { applyPcState(pc); };
pc.oniceconnectionstatechange = () => { applyPcState(pc); };
```

### 2. "You're connected" appears only on actual connected state — `:381-382`

It is the **first branch** of `applyPcState` and is reachable **only** when `pc.connectionState === 'connected'`.
There is no other assignment of that string anywhere in the file except the socket-close handler (`:614`), which
re-asserts it *only* if the connection is still genuinely `connected` at that moment.

**The old `status.textContent = 'Connected!'` on the SDP answer is gone.** That site (`:578-586`) now sets
`admitted = true`, writes the accurate *"Admitted by the host"* to the secondary line, and hands the headline to
`applyPcState(pc)`. Admission and connection are now two different words for two different facts.

### 3. Honest remote video — `:536-551`, `:399-403`

`showRemotePlaceholder(show, text)` (`:399-403`) drives an overlay over `remoteVideo` instead of leaving a black box:

- Before any host track: **"Waiting for the host's camera."** (set at `:459`, when the guest's own media starts)
- `ontrack` fires with a **video** track (`:542`): the placeholder hides **only if that track is
  `readyState === 'live' && !muted`**; otherwise **"The host's camera is not sending video."**
- Track `mute`/`unmute` re-evaluate (`:547-548`); `ended` → **"The host's camera stopped."** (`:549`)

The `kind === 'video'` test matters: an audio-only host used to leave a black rectangle with no explanation. It now
says so in words. The existing `srcObject` assignment (previously `:417`) is unchanged and still first in the handler.

### 4. The guest's own camera and mic — `:405-434`, `:456`

Two badges under their self-view, painted from the **tracks' own state** by `paintDevice` (`:413-419`):

```
live  = track.readyState === 'live' && !track.muted   →  green "Camera live" / "Microphone live"
muted =                                   track.muted →  red   "Camera no signal" / "Microphone no signal"
ended = readyState !== 'live'                         →  red   "Camera stopped"
missing track                                          →  red   "Camera off"
```

`wireLocalDeviceIndicators` (`:421-434`) subscribes to each track's `mute`/`unmute`/`ended` events and adds a 2 s
repaint, because `muted` can change on some browsers without firing an event — the poll observes, it does not assume.
Called at `:456`, immediately after `localVideo.srcObject = localStream`.

### 5. Layout and labels — `:243-262` (markup), `:216-241` (CSS)

`stage2` is now: status pill → host video (with placeholder) → "THE HOST" → self-view → "YOU" → camera/mic badges →
the existing detail line. The remote video is now **first**, since it is what the guest is actually looking for.

---

## Honest-state audit

Every visible string traced to what produces it:

| String | Source | Can it lie? |
|---|---|---|
| "You're connected. The host can see and hear you." | `pc.connectionState === 'connected'` | No — single branch, no other writer |
| "Reconnecting…" / "Connection failed." | `connectionState` / `iceConnectionState` | No |
| "Waiting for the host to let you in…" | `admitted === false` (set only on a received SDP answer) | No |
| "Waiting for the host's camera." | no video track has arrived | No |
| "The host's camera is not sending video." | video track exists, `muted` or not live | No |
| "Camera live" / "Microphone live" | `track.readyState === 'live' && !track.muted` | No |

**Nothing is set optimistically anywhere in the new code.** The one string that used to lie — `'Connected!'` on the
answer — was removed rather than reworded.

---

## Scope discipline

Untouched, as instructed: `iceServers`/TURN (`:44-119`, `:531` mint delivery), the host desktop app, the candidate
queue (guest-side `addIceCandidate` at `:594` still has its own silent-catch defect — **filed, not fixed here**),
Icecast, nginx. No signalling protocol change: no new message types, and the server's WebSocket handlers are byte-for-byte
unchanged. **This patch touches only the inline guest HTML/CSS/JS inside `app.get('/join')`.**

---

## Box state right now

```
$ ls -la /opt/ether-signal/server.js.bak-before-guestfeedback-20260729_034656   → 16,328 bytes (pre-edit)
$ ls -la /opt/ether-signal/server.js                                            → 24,486 bytes (new, on disk)
$ /usr/bin/node --check /opt/ether-signal/server.js                             → SYNTAX OK
$ systemctl show -p ActiveEnterTimestamp --value ether-signal.service           → Wed 2026-07-29 01:09:03 UTC
$ systemctl is-active ether-signal.service                                      → active   (STILL RUNNING THE OLD CODE)
$ systemctl is-active icecast2.service nginx.service                            → active active
```

### Is anyone mid-session? — read this before giving GO

```
$ sudo ss -tn | grep 9091
ESTAB  127.0.0.1:57736  127.0.0.1:9091
ESTAB  127.0.0.1:9091   127.0.0.1:57736
```

Two rows, but that is **one** connection — a loopback socket appears from both ends. The log's last events are:

```
[SIGNAL] host connected for token w1oegznd...
[SIGNAL] room code set for token w1oegznd...
[TURN] minted for host w1oegznd: entries=2 urls=8 relay=true ttl=3600s
[SIGNAL] guest d5febbf2 connected  … then disconnected
[SIGNAL] guest 7d9c9a98 connected  … then disconnected
```

Every guest that connected has since disconnected, and no `host disconnected` line follows `w1oegznd`. So the single
live socket is **most likely the host** — an Ether desktop app with guest access still enabled — **with no guest in
session.** That is a reading of the log, not proof of who is on the other end; **your call.**

**Restarting drops that socket.** The host reconnects on its own only if the app re-opens the WebSocket; a guest
mid-call would be dropped outright.

### Bonus runtime receipt

The TURN work from 4.4.97 is confirmed live in production by these same log lines —
`[TURN] minted for host …: entries=2 urls=8 relay=true` and the same for each guest. Credentials mint, relay URLs are
present, on real sessions.

---

## Verification after GO (what to look for)

1. Guest opens the link, enters name + code → self-view appears, **"Camera live" / "Microphone live"** in green, status
   **"Waiting for the host to let you in…"**, host area reads **"Waiting for the host's camera."**
2. Host clicks Accept → status goes to **"Connecting…"**, then **"You're connected. The host can see and hear you."**
   *only* when ICE actually completes. If it never completes, it correctly stays amber and then goes red — which is
   the honest answer, and the one the old page hid.
3. Host with no camera (the recvonly case) → guest stays on **"Waiting for the host's camera."** rather than a black
   box.

## Architecture compliance

- **`CLAUDE.md` — "BUILD THE SENSE, NOT THE SCAFFOLD … honest state (observed, never claimed)."** Every string maps to
  an observed `RTCPeerConnection` state or a `MediaStreamTrack` property; the one claimed string in the old page was
  deleted.
- **`CLAUDE.md:121` — runtime claims need runtime receipts.** Nothing in this report asserts what the page looks like
  on screen; the verification list above is what to check after GO, phrased as expectations, not results.
- **`CLAUDE.md` — "Correct minimal solution."** One file, one route handler, no protocol change, no server-side logic
  touched. Named not-built: the guest-side ICE candidate queue (`:594`), TURN, the host app.
- **`docs/lightsail-guests-box-survey-2026-07-28.md`** — the box's constraints held: `/opt/ether-signal` is still not
  under git, so the `.bak` chain is the only history; that is why the timestamped backup was taken first.

## Stopped here

Deployed to disk, syntax-checked, **not restarted**. Icecast and nginx untouched. Awaiting your confirmation that no
guest is mid-session, then GO for `sudo systemctl restart ether-signal.service`.
