# Show+ — host transmits nothing, and the two surfaces are two copies (READ-ONLY trace)

**Date:** 2026-07-29 · **Desktop:** 4.4.97 installed · **Box:** `guests.ether-technologies.com` (read-only; not edited,
not restarted — `ether-signal.service` still the 01:09:03 UTC run, Icecast and nginx active).
**Mode:** diagnosis only. Nothing changed, nothing proposed as a patch.

**Working:** guest video reaches the host over Cloudflare TURN.
**Broken:** guest sees only himself; no host video, no host audio; host mic never reaches the guest; the deck-panel
Show+ surface renders nothing while the full panel shows both cameras and a live guest.

---

## Headline

**Your lead is correct and it is the whole of symptoms 1 and 3.** `ShowPlus.tsx:559-562` takes the recvonly branch
whenever `hostStreamRef.current` is null. Recvonly means the host offers **no** media — no camera, no mic — so the
guest has nothing to receive. One branch, both symptoms.

Three findings behind it, each with receipts below:

1. **The camera you can see on the canvas is NOT the stream `acceptGuest` checks.** They are two different
   `MediaStream` objects from two separate `getUserMedia` calls, and the visible one is created with **`audio: false`**
   (`VideoEngineContext.tsx:507-510`) — it could never carry your mic even if it were used.
2. **MIC VOL does not touch the peer connection.** The gain node feeds the monitor only (`ShowPlus.tsx:1853-1859`).
   The guest always receives the raw, unattenuated mic track — when it receives anything.
3. **"Join broadcast" is not a stuck state.** It is a permanent `<h1>` outside both stages (guest page line 221).
   The guest genuinely is in stage 2. This symptom is a misread; the real defect is the empty `remoteVideo`.

And on the two surfaces: **`EmbeddedStudio` contains zero references to the video engine.** No provider, no canvas, no
`GuestEngineSync`. It is not a degraded mount of the real thing — it is a second, thinner implementation that was
never wired to the compositor at all.

---

# HOST SIDE

## 1. Why is `hostStream` null at accept time?

**One writer, three exits.** `hostStream` is `useState` at `ShowPlus.tsx:2539`, written only through `onStream`:

| Path | Line | Result |
|---|---|---|
| Camera opened OK | `ShowPlus.tsx:775` | `onStream(s)` — the only success path |
| **Any `getUserMedia` throw** | `ShowPlus.tsx:781` | `catch { setError(e.message); onStream(null); }` |
| `active` prop false | `ShowPlus.tsx:789` | `onStream(null)` |

`active` was true (you were on the panel — `App.tsx:2615` passes `active={panel === "videostudio"}`), so the null came
from **`ShowPlus.tsx:781`**: `getUserMedia` threw.

**Why you cannot see which throw — the failure is unlogged and the error UI is hidden.** Line 781 writes the message
into `HostCamera`'s own `error` state and emits **no console output whatsoever**. That component's entire render tree
sits inside `<div style={{ display: "none" }}>` at `ShowPlus.tsx:2696`, introduced by **4.4.94** (`debbc9c`, verified:
the `display: "none"` wrapper and the "HostCamera stays MOUNTED … never takes the main stage" comment are both `+`
lines in that commit). So the one place the real reason is written is rendered invisible, and the recvonly warning is
the only surviving trace. **This is why the diagnosis stalls at "UNKNOWN which throw" — by construction.**

Two candidate throws, neither decidable statically:

- **Camera already held.** A physical camera is single-open on Windows. `VideoEngineContext.tsx:507` performs an
  independent `getUserMedia({video:{deviceId:{exact:…}}})` for any camera added via **+ Camera**. Whichever consumer
  opens first wins; the loser gets `NotReadableError`. Given symptom set + finding #2 below, this is the leading
  candidate.
- **The audio constraint never relaxes.** `ShowPlus.tsx:769` and the retry at `:771` pass the *same* `audioConstraint`
  (`:764-766`); only the **video** constraint is relaxed. A stale persisted `video_audio_input` id (written at
  `:2460`, restored on load) makes `{deviceId:{exact:…}}` throw `OverconstrainedError` on **both** attempts → null. A
  missing mic therefore kills the camera path entirely.

**What 4.4.95 changed about camera holding: nothing on this path.** `9708bc3` changed 6 files;
`src/components/ShowPlus.tsx` is not among them. Its guard (`VideoEngineContext.tsx:496-506`) blocks *engine* camera
adds when an existing source already holds the device — it inspects `sources`, where the host camera appears only as
`externalId: "host"` **if `hostStream` exists** (`ShowPlus.tsx:2510`). With `hostStream` null, that guard has nothing
to match on. It cannot cause this and cannot prevent it. It guards the opposite direction from the one that failed.

**Is the recvonly branch always taken now?** Whenever `hostStreamRef.current` is null at the moment of Accept — which
your logs say is every time today. Note it is read from a **ref** (`ShowPlus.tsx:546`), so a camera that recovers
*after* Accept does not help that guest: the transceivers are already recvonly and nothing renegotiates.

## 2. The camera on the canvas vs the stream `acceptGuest` checks — DIFFERENT streams

**They are two unrelated `MediaStream` objects.**

| | Stream A — what `acceptGuest` checks | Stream B — what the canvas draws |
|---|---|---|
| Created by | `HostCamera` `getUserMedia({video, audio})` — `ShowPlus.tsx:769`/`:771` | `addCameraSource` `getUserMedia({audio:false, video:{deviceId}})` — `VideoEngineContext.tsx:507-510` |
| Stored in | `hostStream` state `:2539` → `hostStreamRef` `:415-416` | engine `sources[]` — `VideoEngineContext.tsx:514-518` |
| Read at | `ShowPlus.tsx:546`, `:554` | `VideoEngineCanvas.tsx:68-88` (hidden `<video>` per source) → drawn `:133` |
| Has audio? | **Yes** — mic track included | **No — `audio: false`** (`VideoEngineContext.tsx:508`) |

The two only converge when `GuestEngineSync` registers stream A as the source `"host"` — and that is explicitly
skipped when it is null:

```
ShowPlus.tsx:2505-2512
  if (!hostStream) { removeGuestSource("host"); return; }
  addGuestSource("host", "Host", hostStream, "camera");
```

Since the recvonly log proves `hostStream` was null, **the "Host" source cannot have been on the canvas.** Therefore
the camera you saw is Stream B — an engine camera source added through **+ Camera**.

Two consequences worth stating plainly:

- **Stream B is the likely reason Stream A is null.** It holds the physical camera, so `HostCamera`'s open fails.
  This is the collision class documented in `docs/showplus-device-layer-design-2026-07-27.md` (design of record,
  build-nothing-yet), in a form the 4.4.95 guard does not cover.
- **Stream B could never fix the audio.** It is created with `audio: false`, so even a change that fed the canvas
  source to the peer connection would deliver a silent guest.

**UNKNOWN:** which consumer actually won the device this session. Decidable in one look — the hidden `HostCamera`
error text, or a console line that does not currently exist at `ShowPlus.tsx:781`.

## 3. Does the host ever `addTrack` an AUDIO track to a guest peer connection?

**Yes — exactly one site, and only when `hostStream` exists.**

```
ShowPlus.tsx:552-558
  hostStreamRef.current.getTracks().forEach(track => { … pc.addTrack(track, hostStreamRef.current!); … });
```

`getTracks()` is every track, so the mic track from `getUserMedia({video, audio})` is included. That is the **only**
path by which host audio can reach a guest. Confirmed by exhaustive grep of the desktop app — the complete set of
track-adding calls is:

```
ShowPlus.tsx:554   pc.addTrack(track, hostStreamRef.current!)          ← the only PC addTrack
ShowPlus.tsx:560   pc.addTransceiver("video", {direction:"recvonly"})  ← the null-hostStream branch
ShowPlus.tsx:561   pc.addTransceiver("audio", {direction:"recvonly"})  ← the null-hostStream branch
ShowPlus.tsx:583   g.stream.addTrack(e.track)                          ← inbound guest media, not outbound
VideoEngineContext.tsx:654,660  combined.addTrack(...)                 ← canvas capture for recording/RTMP, not a PC
```

There is **no** separate mic path to the peer connection, and **no** `replaceTrack` anywhere. So when `hostStream` is
null the guest gets `recvonly` audio: the host mic is not merely muted, it is **not negotiated at all**.

## 4. AUDIO panel — what each control actually reaches

`AudioPanel` is defined at `ShowPlus.tsx:1789`.

| Control | Path | Reaches the peer connection? |
|---|---|---|
| **MIC INPUT** (`micDeviceId`) | `changeMicDevice` `:1885` → persisted `:2460` → prop to `HostCamera` `:2707` → audio constraint `:764-766` → part of `hostStream` → `addTrack` `:554` | **Yes, indirectly** — it selects *which* mic ends up in the stream. Only effective if the camera open succeeds |
| **MIC VOL** (`micVolume`) | `:1837` → `micGainRef.gain` → gain node built `:1853-1855` → connected **only** to `MediaStreamAudioDestinationNode` `:1857-1859` → monitor element `:1861`, `:1873` | **No — monitor-only.** The PC receives the raw track from `hostStream`; `dest.stream` is never given to any `RTCPeerConnection` |
| **SELF-MONITOR** (`selfMonitor`) | `:1860-1866`, `:1869-1883` — attaches/detaches `monitorDest.stream` on a local `<audio>` | **No** — local playback only |
| **MONITOR VOL** (`monitorVolume`) | `:1841` — sets the local `<audio>` element volume | **No** — local playback only |

Verified by grep: `micGainRef` / `monitorDestRef` / `dest.stream` appear only at `:1806-1807`, `:1837`, `:1855`,
`:1859`, `:1861`, `:1872-1873` — every one of them a monitor path, none of them a peer connection.

**Honest-UI consequence worth recording:** MIC VOL sits in a panel headed AUDIO next to MIC INPUT and reads as the
send level to your guests. It is not. Turning it to zero still sends full-level mic audio to the guest; turning it up
does nothing at their end. Only your own monitor changes.

---

# GUEST SIDE (`/opt/ether-signal/server.js`, read from the live box)

## 5. Is `srcObject` ever assigned to `<video id="remoteVideo">`?

**Yes — one assignment, inside `ontrack`:**

```
server.js:242   <video id="remoteVideo" autoplay playsinline></video>
server.js:417   pc.ontrack = (ev) => { const rv = document.getElementById("remoteVideo");
                   if (rv && ev.streams && ev.streams[0]) { rv.srcObject = ev.streams[0]; rv.play().catch(() => {}); } };
```

(For contrast, the guest's own preview is assigned unconditionally at `server.js:328` — which is why they see
themselves.)

`ontrack` fires only when the remote peer actually sends media. With the host on `recvonly`, **no track is ever
offered, so `ontrack` never fires and `remoteVideo` is never assigned.** The element stays empty. Nothing is wrong on
the guest side; it is faithfully displaying an absence.

## 6. What flips the page out of the "Join broadcast" state?

**Nothing needs to — the heading is permanent, and the stage already flipped.**

```
server.js:221   <h1>Join the broadcast</h1>        ← OUTSIDE both stages; always visible
server.js:223   <div id="stage1">                  ← name + room code + Join button
server.js:239   <div id="stage2" style="display:none">   ← localVideo + remoteVideo + status
server.js:330-332  stage1.style.display = 'none'; stage2.style.display = 'block';
```

The flip at `:330-332` happens immediately after `getUserMedia` succeeds and **before** the WebSocket is even opened
(`:334`). It does **not** depend on receiving host media, or on the host at all.

**So symptom 2 is a misread of the UI, not a fault.** The guest is in stage 2 — proven by the fact that they can see
themselves, which is stage 2's `localVideo`. The persistent `<h1>` simply makes the page look like it never advanced.
The genuine defect visible on that screen is the empty `remoteVideo`, which is §5, which is the recvonly branch.

---

# THE TWO SURFACES

## 7. Every duplicated piece between `EmbeddedStudio` and the full panel

The root duplication is upstream of both: **`ShowPlus` is mounted twice, as two independent React trees.**

```
App.tsx:2615   <VideoStudio active={panel === "videostudio"} />   ← the full panel
App.tsx:3912   <VideoStudio embedded />                            ← the deck slot; NO active prop → active = true (ShowPlus.tsx:2537)
```

Everything below is a consequence of that.

| # | Piece | Embedded copy | Full-panel copy | How they differ |
|---|---|---|---|---|
| 1 | **Host camera capture** | `HostCamera` `:2034` | `HostCamera` `:2698` | Two mounts → two `getUserMedia` calls on one physical camera. At most one can win |
| 2 | **Guest tile** | inline `<video>` with ref callback `:2129` | `GuestGridTile` component `:2212`, used `:2435` | Embedded: no `muted` (autoplay-policy trap), no separate `<audio>`, no `setSinkId`, no `addtrack` re-attach, no scene **+** control, text Mute/Kick. Full: all of those |
| 3 | **Pending-guest card** | `:2114-2123` | `:2410-2425` | Same shape, separately written markup |
| 4 | **TURN credential line + Accept gate** | `:2101-2113`, `:2118-2120` | `:2397-2409`, `:2415-2417` | Identical behaviour — **because I wrote it twice in 4.4.97.** My own contribution to this problem |
| 5 | **Invite block** (link, Copy, room code, QR, e-mail form) | `:2085-2097` | `:2350-2371` | Same content, two markups, different sizes |
| 6 | **Teleprompter** | inline `<textarea>` + sliders `:2142+` | shared `TeleprompterPanel` `:1211`, used `:2450` | Embedded re-implements a component that already exists |
| 7 | **Accepted-guest list filter** | `:2125`, `:2127` | `:2358` | Same predicate, computed separately |
| 8 | **Video engine** (provider/canvas/source sync) | **ABSENT** | `:2678`, `:2679`, `:2691` | See §8 — this is the whole of the third symptom |
| 9 | **Level meter** | `LevelBar` `:2043` | `LevelBar` `:2723` | Shared component; two mounts (benign) |
| 10 | **AUDIO panel** | `AudioPanel` `:2180` | `AudioPanel` `:2470` | **Shared component, one implementation, two mount points — the pattern the rest should follow** |
| 11 | Status bar / captions / destinations / encoder / sources / engine panel | absent | `:2787`, `:2800`, `:2742`, `:2781`, `:2769`, `:2766` | Full panel only |
| 12 | **A third, dead copy** | — | `GuestSidebar` `:1188`,`:1197` + `GuestTile` — no call site | Already recorded as dead in the 2026-07-28 trace |

Item 10 is the proof Jeff's position is achievable in this file: `AudioPanel` is *already* one implementation with two
mounting points, and it is the only piece here with no drift.

## 8. Why the embedded surface renders nothing

**Specific reason: the embedded branch returns before the engine is ever mounted.**

```
ShowPlus.tsx:2655   if (embedded) {
ShowPlus.tsx:2656-2675   return ( <EmbeddedStudio … /> );
ShowPlus.tsx:2676   }
ShowPlus.tsx:2678   return ( <VideoEngineProvider>          ← never reached when embedded
ShowPlus.tsx:2679       <GuestEngineSync … />
ShowPlus.tsx:2691       <VideoEngineCanvas />
```

A scan of the whole `EmbeddedStudio` body (lines 1954-2290) for `VideoEngineProvider`, `VideoEngineCanvas`,
`GuestEngineSync`, `useVideoEngine`, `VideoEnginePanel` returns **zero matches**. So, concretely:

- **No canvas is mounted** → there is no compositor stage to draw anything on.
- **No `GuestEngineSync`** → guests are never registered as engine sources → even a connected guest could not reach a
  stage, because there isn't one.
- The only things it *can* render are its own raw elements: the `HostCamera` preview (`:2034`) and the inline guest
  tiles (`:2129`).

Both of those are empty in your session: the `HostCamera` in that instance has no stream (it lost the camera, §1), and
its guest list is empty (§9). Hence "nothing". It is not a rendering bug — **there is nothing wired up to render.**

Not a prop problem and not a gated effect: it is a missing subtree.

## 9. Does `EmbeddedStudio` get the same `hostStream` and `guests` as the full panel?

**No — its own, from a separate instance, and the two actively fight.**

| | Embedded | Full panel |
|---|---|---|
| `hostStream` | that instance's `useState` `:2539`, fed by its own `HostCamera` `:2034` → `onStream={setHostStream}` `:2035` | same line numbers, **different instance**, fed by `:2698`/`:2699` |
| `guests` | its own `useWebRTCGuests(...)` `:2586` → its own `WebSocket` `:425` | its own call at the same line, different instance, different socket |
| Passed down | `:2658` (`hostStream`), `:2664` (`guests`) | `:2679` (`GuestEngineSync`), `:2744` (`ShowPlusPanel`) |

Two mechanisms make this actively harmful, not merely redundant:

1. **Camera contention.** Two `HostCamera` instances, one physical camera, single-open on Windows. One wins, the other
   lands in `catch` at `:781` → `onStream(null)` → recvonly for that instance's guests.
2. **Signalling-session eviction.** The session token is a **module-level constant** shared by every instance in the
   renderer (`ShowPlus.tsx:29-33`), so both sockets identify as the *same* host session. The server's host branch
   closes the incumbent:
   `if (session.hostWs && session.hostWs !== ws) { session.hostWs.close(1000, 'Replaced'); }`
   Whichever surface connects last owns the session; the other's guest list empties and stays empty.

Both instances' WebSocket effects return early when guests are disabled (`ShowPlus.tsx:421`), and `guestsEnabled`
defaults to `false` per instance, so if you never toggled guests on in the deck panel it simply has no session at all.
**UNKNOWN which of the two applied this session** — both end at "embedded shows no guest".

## 10. What making the embedded surface a real mount would take

Described, not built, per the brief. The shape follows the `ether-audiod` rule Jeff named: one engine, thin
front-ends, never a copy — and `AudioPanel` (§7 item 10) already proves it works in this file.

**Move up into a single owner** — one `ShowPlusProvider` mounted once, above both mounting points (i.e. at the
`App.tsx` level, not inside either surface), holding:

- the WebRTC guest session — one `useWebRTCGuests`, one socket, one `turnState`, one ICE-server list;
- host capture — one `HostCamera` acquisition, so exactly one `getUserMedia` per physical device;
- the video engine — one `VideoEngineProvider` + `GuestEngineSync`, so sources and layers are shared state.

**Both surfaces then become views** — `<ShowPlusView variant="panel" />` and `<ShowPlusView variant="deck" />` —
differing only in layout and in which sections they show, subscribing through context rather than owning state.

**Deleted:**

- `EmbeddedStudio`'s inline guest tile `:2129` → use `GuestGridTile` `:2212`;
- its pending-guest card `:2114-2123` → shared with `:2410-2425`;
- its duplicate TURN status line + Accept gate `:2101-2120` → one copy (removing the duplication I introduced);
- its inline teleprompter `:2142+` → use `TeleprompterPanel` `:1211`;
- its invite block `:2085-2097` → one extracted `InviteBlock` component;
- **the second `HostCamera` mount** `:2034` — the camera-contention mechanism disappears with it;
- **the second `useWebRTCGuests`/WebSocket** — the session-eviction mechanism disappears with it;
- the dead `GuestSidebar`/`GuestTile` `:1188`,`:1197` while in there.

**Shared:** the guest session and its `guests`/`turnState`; `hostStream`; the engine `sources`/`layers`; and the
already-shared `AudioPanel`, `TeleprompterPanel`, `LevelBar`, `GuestGridTile`.

**Falls out for free:** the deck surface gets a real stage (it can render `<VideoEngineCanvas />` from the shared
provider); the module-level session token `:29-33` stops being a cross-instance hazard because there is one session;
and the host-camera half of the device-collision class ends, which is the direction
`docs/showplus-device-layer-design-2026-07-27.md` already specifies (one acquisition service handing out shared
handles) — this would be a step into that design, not around it.

**Not addressed by this refactor, and worth saying so:** the `+ Camera` engine source (`VideoEngineContext.tsx:507`)
would still open the camera independently. Consolidating the two Show+ instances removes one collision pair; the full
device-acquisition service removes the class.

---

## Governing docs consulted

- `docs/showplus-device-layer-design-2026-07-27.md` — design of record for device acquisition; states the host stream
  shared by reference is "the pattern to generalize" (lines 32-34) and is marked `DESIGN ONLY` (line 3). §10 above is
  consistent with it; nothing here builds from it.
- `docs/showplus-guest-tile-black-video-trace-2026-07-28.md` — the inbound path; §7.4/§7.7 items remain open and are
  untouched here.
- `docs/lightsail-guests-box-survey-2026-07-28.md` — box topology; re-verified unchanged this session.
- `CLAUDE.md` — "BUILD THE SENSE, NOT THE SCAFFOLD" (the silent `catch` at `:781` plus the hidden error UI is the
  live counter-example) and "DOORS BEFORE ROOMS" (a deck surface that renders nothing).

## Scope note

Read-only. No file edited in `C:\openair`, nothing committed, nothing on the Lightsail box touched — the box was read
with `grep`/`systemctl show` only, `ether-signal.service` is still the 01:09:03 UTC run, Icecast and nginx report
`active`. No fix applied and no patch proposed.
