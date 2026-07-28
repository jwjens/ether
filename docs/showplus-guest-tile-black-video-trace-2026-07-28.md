# Show+ guest tile renders black — static trace (READ-ONLY)

**Date:** 2026-07-28 · **Branch:** `log-reader-flip` · **Scope:** diagnosis only. No edits, no commits, no version bump.
**Symptom under investigation:** guest joins via the guest link, the tile in the SHOW+ **GUESTS** panel shows the
guest's name + mic icon + ×, but the video area is black.

All receipts are `file:line` against the working tree as of this date.

---

## 0. Verdict up front

The tile's *attach* code is correct and complete — `srcObject` is assigned, and `autoPlay` / `playsInline` / `muted`
are all present. Nothing is stolen by the compositor; the stream is shared by reference, exactly like the host
pattern at `ShowPlus.tsx:2392`.

What static analysis **can** decide:

- The tile renders `<video>` for **any** truthy `guest.stream` — including an **audio-only** stream and including a
  stream whose video track is negotiated but receiving no media (`ShowPlus.tsx:2143` vs `ShowPlus.tsx:2148`). Both of
  those states present as **exactly** the reported symptom: an unstyled black rectangle with name/mic/× intact and
  **no error, no badge, no log surfaced to the operator.**
- Three defects in the inbound path can each produce a media-less-but-truthy stream (§7). The most consequential is
  that **remote ICE candidates arriving before the host clicks Accept are silently discarded** — and there is no
  TURN server.

What static analysis **cannot** decide: whether the live guest page at `guests.ether-technologies.com` actually
offers a video m-line. **That source is not in this repo or in any local `C:\ether-*` tree** (§4). One console read
settles it — the needed diagnostics are already in the code (§8).

Ranked candidate causes:

| # | Cause | Status |
|---|---|---|
| 1 | No media flowing — pre-Accept ICE candidates dropped (`ShowPlus.tsx:437,441`) + STUN-only, no TURN (`ShowPlus.tsx:471`) | **Confirmed defect**, sufficient to cause symptom |
| 2 | Guest negotiated audio only | **UNKNOWN** — guest page not in any local repo |
| 3 | Late-arriving video track never re-attached (`ShowPlus.tsx:517,519` + `2130`; canvas `VideoEngineCanvas.tsx:71`) | **Confirmed defect**, bites only on renegotiation |
| — | Missing autoplay/muted attributes on the live tile | **Ruled out** (§6) |
| — | Compositor consuming the stream | **Ruled out** (§5) |

---

## 1. Where is the guest tile rendered?

**The live tile is `GuestGridTile`** — `src/components/ShowPlus.tsx:2111`.

- The element that is supposed to display guest video: **`<video ref={vidRef} autoPlay playsInline muted>` at
  `ShowPlus.tsx:2144`**, inside a 16:9 aspect box (`ShowPlus.tsx:2142`).
- Mount path: `ShowPlusPanel` (declared `ShowPlus.tsx:2213`) → `GUESTS` section header `ShowPlus.tsx:2263` → accepted-guest
  grid `ShowPlus.tsx:2310` → `<GuestGridTile … />` `ShowPlus.tsx:2316`. `ShowPlusPanel` renders only when the right
  sidebar tab is `showplus` (`ShowPlus.tsx:2620-2623`).
- Identification is unambiguous: this tile is the only one with a **mic SVG** (`ShowPlus.tsx:2166-2181`) and an **×**
  button (`ShowPlus.tsx:2185`), matching the report.

**Two other guest tiles exist and are DEAD CODE — do not fix them by mistake:**

- `GuestTile` — `ShowPlus.tsx:917`, rendered only by `GuestSidebar` (`ShowPlus.tsx:1053`, tile at `ShowPlus.tsx:1115`).
  `GuestSidebar` has **no call site anywhere in `src/`** (grep for `<GuestSidebar` → no matches).
- `GuestVideoPanel.tsx:19` (its tile's video at `GuestVideoPanel.tsx:226`) — **no importer anywhere in `src/`**
  (grep for `GuestVideoPanel` matches only its own file).

**One live secondary tile** exists in the embedded studio: `ShowPlus.tsx:2028` (rendered via `EmbeddedStudio`,
`ShowPlus.tsx:2536`). Its controls are text buttons `Mute` / `Kick` (`ShowPlus.tsx:2031-2032`), not a mic icon and ×,
so it is **not** the reported surface — but it carries a real attribute defect of its own (§6).

---

## 2. Does the element ever get a `srcObject`?

**Yes.** `ShowPlus.tsx:2119-2132`:

- `ShowPlus.tsx:2124` — `v.srcObject = s; v.play().catch(() => {});`
- `ShowPlus.tsx:2125` — the same stream is attached to a hidden `<audio>` (`ShowPlus.tsx:2147`), since the video
  element is `muted`.
- `ShowPlus.tsx:2126-2130` — a re-attach handler bound to the stream's `"addtrack"` event.
- Effect dependency is `[guest.stream]` (`ShowPlus.tsx:2132`) — see §7.4 for why that dep never fires on late tracks.

Sink selection for the audio element: `ShowPlus.tsx:2134-2138`.

---

## 3. Trace: guest media from the peer connection to the tile

| Hop | Receipt |
|---|---|
| Host signaling socket opens | `ShowPlus.tsx:418` — `wss://guests.ether-technologies.com/signal?role=host&token=…` |
| Guest offer arrives → guest added as `pending` with `stream: null` | `ShowPlus.tsx:432-435` |
| Operator clicks Accept | `ShowPlus.tsx:2298` → `acceptGuest` `ShowPlus.tsx:462` |
| `RTCPeerConnection` created, stored in `peersRef` | `ShowPlus.tsx:470-473` |
| Host local tracks added (or recvonly transceivers if no host cam) | `ShowPlus.tsx:480-496` |
| **`pc.ontrack` handler** | `ShowPlus.tsx:498-521` |
| MediaStream first captured into React state | `ShowPlus.tsx:513` — `e.streams[0] \|\| new MediaStream([e.track])`, stored `ShowPlus.tsx:514` |
| Subsequent tracks merged into the same stream | `ShowPlus.tsx:516-519` |
| Where the stream lives | `guests` state in `useWebRTCGuests` — `ShowPlus.tsx:403`, returned `ShowPlus.tsx:612` |
| Consumed by `ShowPlus` | `ShowPlus.tsx:2467` |
| Passed to the panel | `ShowPlus.tsx:2624` → filtered to accepted `ShowPlus.tsx:2256` → tile `ShowPlus.tsx:2316` |
| **What the tile reads** | `ShowPlus.tsx:2122` — `const s = guest.stream` → `ShowPlus.tsx:2124` `v.srcObject = s` |

Parallel branch (compositor), same object, no fork:

| Hop | Receipt |
|---|---|
| `GuestEngineSync` | `ShowPlus.tsx:2376`, effect `ShowPlus.tsx:2397-2414` |
| Register source | `ShowPlus.tsx:2405` `addGuestSource(g.id, g.name, g.stream!)` → `VideoEngineContext.tsx:553`, stream stored `VideoEngineContext.tsx:563` |
| Update on change | `ShowPlus.tsx:2403` → `VideoEngineContext.tsx:586-600` |
| Hidden `<video>` per source | `VideoEngineCanvas.tsx:65-88`, `srcObject` at `VideoEngineCanvas.tsx:82` |

---

## 4. Does the inbound stream contain a VIDEO track?

**UNKNOWN — undecidable by static analysis on this machine.**

**Host side (decidable, and it is permissive):**

- If a host camera stream exists, its tracks are `addTrack`-ed **before** `setRemoteDescription`
  (`ShowPlus.tsx:480-491` vs `ShowPlus.tsx:549`), so those transceivers are available for association with the
  guest's m-lines and the answer is send/recv rather than inactive.
- If there is no host stream, explicit recvonly transceivers are added for **both** kinds:
  `ShowPlus.tsx:494` (`video`) and `ShowPlus.tsx:495` (`audio`). This was the deliberate fix in commit `8db0925`.
- `HostCamera` requests `video` + `audio` (`ShowPlus.tsx:686`, fallback `688`) and stays mounted (inside a
  `display:none` wrapper, `ShowPlus.tsx:2574-2588`), so `hostStream` normally exists.
- Main-process permission gates are in place: `electron/main.js:1721` (`setPermissionCheckHandler`) and
  `electron/main.js:1729` (`setPermissionRequestHandler`).

**Conclusion: the host is capable of receiving video in both branches. The determinant is the guest's offer.**

**Guest side (not available):**

- The deployed page at `guests.ether-technologies.com` has **no local source**. Grep for `role=guest` /
  `guests.ether-technologies` / `/signal?` across `C:\ether-bridge`, `C:\ether-admin`, `C:\ether-cast`,
  `C:\ether-dashboard`, `C:\ether-signup`, `C:\ether-backend` returns only `C:\ether-backend\src\index.js`
  (an e-mail-link validator at `index.js:5568` and the `/join/:token` route at `index.js:3443`).
- The only local guest page, `C:\ether-backend\public\guest-join.html`, is a **stub**: `peerConn` is declared at
  line 206 and never constructed, and line 335 reads *"Real WebRTC would go here — create RTCPeerConnection, add
  tracks, exchange SDP."* It is **not** the page the guest link serves.
- Worth flagging anyway: even the stub has an **audio-only join toggle** — `video-toggle` checkbox read at
  `guest-join.html:261`, `video: withVideo ? {…} : false` at `guest-join.html:265`. If the deployed page carries the
  same toggle, **an audio-only guest is a legitimate, expected state that this tile renders as an unexplained black
  box** (§7.7).

---

## 5. Is the video routed ONLY to the compositor?

**No. Shared by reference — the compositor is not the cause.**

The identical `MediaStream` object reaches both consumers:

- Tile: `ShowPlus.tsx:2122` → `ShowPlus.tsx:2124`.
- Engine: `ShowPlus.tsx:2405` → stored unchanged at `VideoEngineContext.tsx:563` → attached to a hidden element at
  `VideoEngineCanvas.tsx:82`.

This is the same by-reference pattern used for the host stream at `ShowPlus.tsx:2392` / `VideoEngineCanvas.tsx:82`.
A `MediaStream` may be attached to any number of media elements; attaching it to the canvas's hidden `<video>`
neither detaches nor consumes it. Nothing in `addGuestSource` clones, stops, or re-wraps the stream
(`VideoEngineContext.tsx:553-569`), and `removeGuestSource` is explicitly documented as not stopping WebRTC tracks
(`VideoEngineContext.tsx:571-583`).

**Useful corollary for triage:** because both surfaces hold the same object, *add the guest to the scene* and compare.
- Stage shows video, tile black → live video track exists; fault is in the tile's attach/render (§7.4).
- Stage black too → fault is upstream: no video track, or no media flowing (§7.1-7.3).

---

## 6. Missing autoplay / muted / playsInline attributes?

**Not on the live tile. Ruled out.** `ShowPlus.tsx:2144` carries `autoPlay playsInline muted`, with an explicit
`v.play()` at `ShowPlus.tsx:2124` and a separate unmuted `<audio autoPlay playsInline>` for sound
(`ShowPlus.tsx:2147`). That is the correct pattern.

The other tiles are **not** correct, and are traps if any of them is ever revived or is what the operator is actually
looking at:

- `ShowPlus.tsx:2028` (**live**, embedded studio) — `autoPlay playsInline` but **no `muted`**. Chromium's autoplay
  policy blocks `play()` on an unmuted stream, and the rejection is swallowed by `.catch(() => {})` on the same line
  → black frame, silently.
- `ShowPlus.tsx:931` (dead `GuestTile`) — same defect: `autoPlay playsInline`, no `muted`; rejection logged only as a
  `console.warn` at `ShowPlus.tsx:923`.
- `GuestVideoPanel.tsx:226` (dead) — `muted={guest.muted}`, i.e. unmuted by default, and no `play()` call at all
  (`GuestVideoPanel.tsx:204` assigns `srcObject` only).

---

## 7. Silent catches and early returns that leave the tile black with no error

### 7.1 Pre-Accept remote ICE candidates are silently discarded — **no queue exists**
`ShowPlus.tsx:436-441`. The lookup `peersRef.current.get(from)` (`ShowPlus.tsx:437`) can only succeed after
`acceptGuest` inserts the PC at `ShowPlus.tsx:473`. Accept is a **human click** (`ShowPlus.tsx:2298`), seconds after
the offer, while the guest begins trickling candidates immediately on `createOffer`. The guard
`if (pc && payload)` (`ShowPlus.tsx:441`) drops every candidate in that window with **no buffer and no warning**.
Connection then depends entirely on peer-reflexive discovery from the guest's own connectivity checks.
Result when it fails: transceivers negotiate, tracks appear, **no media arrives → black tile.**

### 7.2 `addIceCandidate` failures fully swallowed
`ShowPlus.tsx:441` — `try { await pc.addIceCandidate(payload); } catch {}`. Empty catch, no log. Candidates delivered
before `setRemoteDescription` completes (`ShowPlus.tsx:549`) throw and vanish here.

### 7.3 STUN-only — no TURN
`ShowPlus.tsx:470-472` configures only `stun.l.google.com:19302` / `stun1`. Commit `8db0925` states this explicitly:
*"Does NOT include TURN … a separate follow-up."* Any guest behind symmetric NAT or a corporate firewall (OV's
managed box being the obvious case) will negotiate successfully and then receive nothing → **black tile, no error.**

### 7.4 Late-arriving tracks never re-attach — on the tile *or* the canvas
- `ShowPlus.tsx:517` — `try { g.stream.addTrack(e.track); } catch {}` (silent). A **script-called**
  `MediaStream.addTrack()` does **not** fire `"addtrack"`, so the tile's re-attach listener at `ShowPlus.tsx:2130`
  never runs for this path.
- `ShowPlus.tsx:519` — returns `{ ...g, stream: g.stream }`: a new guest object but the **same stream reference**, so
  the effect at `ShowPlus.tsx:2119` (dep `[guest.stream]`, `ShowPlus.tsx:2132`) does not re-run and `srcObject` is
  never re-assigned.
- Compositor has the mirror defect: `VideoEngineCanvas.tsx:71` — `if (!els.has(s.id))` — an already-created hidden
  element is never rebound, so `updateGuestSource` (`ShowPlus.tsx:2403` → `VideoEngineContext.tsx:586`) updates state
  but never re-attaches.

**Bounding this honestly:** both tracks of a single initial negotiation are delivered in the same task, before React
commits, so the *first* attach normally carries both. This defect bites when video arrives in a **later** task —
guest enables camera after joining, or any renegotiation. Whether that is what is happening here is **UNKNOWN**
without the guest page.

### 7.5 Accept failures leave a permanently streamless "accepted" guest
`ShowPlus.tsx:547-554` — `setRemoteDescription` / `createAnswer` / answer-send failures are `console.error` only
(`ShowPlus.tsx:553`), while the status flip to `"accepted"` has already been returned at `ShowPlus.tsx:556`. The tile
mounts, never receives a stream, and shows no failure state.

### 7.6 `play()` rejections swallowed
`ShowPlus.tsx:2124` and `ShowPlus.tsx:2127` — `.catch(() => {})` on both video and audio.

### 7.7 The reason it presents as *black* rather than as anything explanatory — the honest-UI gap
`ShowPlus.tsx:2143` renders `<video>` whenever `guest.stream` is truthy, and `ShowPlus.tsx:2148` renders the avatar
fallback **only when it is falsy**. So the moment *any* track lands — audio alone is enough — the fallback disappears
and an empty `<video>` takes the frame. The tile has no sense of:

- `guest.stream.getVideoTracks().length === 0` (audio-only guest),
- video track `muted` / `readyState` (negotiated but no media),
- `video.videoWidth === 0` (attached but never painted),
- `pc.connectionState` / `iceConnectionState` — both are logged (`ShowPlus.tsx:537`, `ShowPlus.tsx:540`) and **never
  surfaced in the UI**.

Per CLAUDE.md — *"BUILD THE SENSE, NOT THE SCAFFOLD … honest state (observed, never claimed)"* — this is the product
gap that makes the bug undiagnosable from the operator's seat, independent of which upstream cause is active.

### 7.8 Latent hazard (not proven to be firing): impure state updater
`acceptGuest` performs **all** of its side effects inside a `setGuests` updater — `ShowPlus.tsx:466-557`: the
`RTCPeerConnection` is constructed (`470`), registered in `peersRef` (`473`), given handlers, and driven through
`setRemoteDescription`/`createAnswer`/answer-send (`547-554`) from within the updater body. React updaters must be
pure. `<StrictMode>` is **not** enabled (grep across `src/` → no matches), so the common double-invoke is not in play
today; but any replayed render would create **two** PCs for one guest, send **two** answers, and leave only the second
in `peersRef` — so remote ICE would be routed to a PC the guest never answered. That failure mode looks exactly like
this symptom. Flagged as a hazard, **not** as the diagnosed cause.

---

## 8. What one measurement would settle it

Every diagnostic needed is already in the code — no new tooling, nothing to install, nothing left armed:

- `ShowPlus.tsx:499-509` — `[WEBRTC] ontrack for guest` logs `trackKind`, `trackMuted`, `trackReadyState`, and
  per-stream `{audio, video}` counts. **This alone answers §4.**
- `ShowPlus.tsx:534` / `537` / `540` — ICE gathering, ICE connection, and connection state. **These answer §7.1/7.3.**
- `VideoEngineCanvas.tsx:72-77` — `[CANVAS] Creating hidden video for source` logs `videoTracks` count.
- `ShowPlus.tsx:438` — logs each remote candidate as received (note: it logs *before* the drop at `441`, so a run of
  candidate logs with no PC is itself the fingerprint of §7.1).

Open DevTools on the host, accept a guest, and read `[WEBRTC]`. Three outcomes:
`video: 0` → §4 case 2 (guest-side, audio only). `video: 1` + `connectionState` never `connected` → §7.1/7.3.
`video: 1` + `connected` + stage shows video while the tile does not → §7.4.

---

## Architecture compliance

- **DOORS BEFORE ROOMS / honest state (CLAUDE.md):** §7.7 is a direct violation — a live panel presents a failure
  as a blank frame with no explanation, so the operator concludes the feature is broken rather than that the guest
  joined without a camera.
- **BUILD THE SENSE, NOT THE SCAFFOLD:** the connection facts exist only in `console.log` (`ShowPlus.tsx:499-509`,
  `534-544`). None reach the UI or the health ledger. Any fix should carry the sense with it, in v1.
- **Imaging & production surfaces (CLAUDE.md, 2026-07-15):** unaffected — this is the guest/compositor path, not the
  region engine.
- **No temporary tooling created.** This trace is pure static analysis; nothing was installed, scheduled, or left
  running on this machine.

## Incidental (one line, per CLAUDE.md — not investigated further)

`ShowPlus.tsx:601` writes a `volume` field onto guest objects, but `GuestPeer` (`ShowPlus.tsx:49-57`) has no such
field and nothing reads it — the `ether:guest-volume` mixer control is inert.

## Not changed

Nothing. No edits, no commits, no version bump, no fix applied — as instructed.
