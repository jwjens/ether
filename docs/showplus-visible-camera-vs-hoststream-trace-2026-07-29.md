# A working camera that never reaches the guest — how both facts are true

**Date:** 2026-07-29 · **Build:** 4.4.98 installed · **Mode:** READ-ONLY, diagnosis only. Nothing changed.

**Given:** the host camera is open, visible and working in Ether. The guest connects but never receives host video —
the guest page reports *"Waiting for the host's camera."* The console shows `[HOSTCAM] FAILED … device not found`.
**Both are true simultaneously.** This is a code defect in how the working camera reaches the peer connection.

---

## Headline

**`hostStream` is not one thing — it is per-`ShowPlus`-instance state, and there are up to three instances, each
running its own `HostCamera` and its own `getUserMedia`.** A physical camera is single-open on Windows. One instance
gets the device and shows you a working picture; the others get `NotReadableError` ("device not found"), set their own
`hostStream` to null, and — if a guest is connected to one of *those* — take the recvonly branch and transmit nothing.

**The camera you can see and the camera `acceptGuest` looks for are different objects in different React trees.**
Nothing in the code makes the winner's stream available to the loser: `hostStreamRef` (`ShowPlus.tsx:421-422`) is a ref
over that instance's own `useState`, and `acceptGuest` reads only that.

One structural detail makes this near-certain rather than merely possible: **the deck-slot instance opens the camera
unconditionally and never releases it** — see §3.

---

## 1. Is `acceptGuest`'s stream the same one `HostCamera` opened and is displaying?

**Same object *within one instance*. Different object *across instances* — and there is no path between them.**

```
ShowPlus.tsx:421   const hostStreamRef = useRef<MediaStream | null>(hostStream);
ShowPlus.tsx:422   hostStreamRef.current = hostStream;          ← mirrors THIS instance's useState
ShowPlus.tsx:546   if (hostStreamRef.current) {                 ← the accept-time test
ShowPlus.tsx:547-554  …getTracks().forEach(track => pc.addTrack(track, hostStreamRef.current!))
```

`hostStream` is written by exactly one path per instance — `HostCamera`'s `onStream` callback:

| Instance | `HostCamera` mount | `onStream` target |
|---|---|---|
| Panel (main window) | `ShowPlus.tsx:2749` | `setHostStream` at `:2750` |
| Deck slot / embedded | `ShowPlus.tsx:2085` | `setHostStream` at `:2086` |
| Popout (own process) | same tree as the panel, `:2749` | same, but a **separate React root** |

`hostStreamRef` is a `useRef` — **per component instance**. Instance A succeeding does nothing for instance B's ref.
There is no shared store, no context, no IPC carrying `hostStream` between them. So:

> A camera visibly working in one instance is invisible to `acceptGuest` in another. `acceptGuest` is not misreading
> its stream — it is reading a *different, genuinely null* stream.

**So "the camera works" and "`[HOSTCAM] FAILED device not found`" are not in conflict at all.** They are two instances
reporting truthfully about two different `getUserMedia` calls on one physical device.

## 2. What is the visible camera, if `hostStreamRef.current` is null at accept time?

Three candidates, and **two of them are ruled out for the panel and popout surfaces**:

**Ruled out — the panel/popout `HostCamera` preview.** It is mounted inside `display:none`:

```
ShowPlus.tsx:2747   <div style={{ display: "none", flex: 1, … }}>
ShowPlus.tsx:2749     <HostCamera … />
```

(added by 4.4.94, `debbc9c`). **On the panel and the popout you cannot see `HostCamera`'s preview at all**, working or
not. Whatever picture is on those surfaces is the compositor canvas, not the host preview.

**Ruled out — the "Host" engine source, when `hostStream` is null.** The canvas draws only *layered* sources
(`VideoEngineCanvas.tsx:128-129`), and the "Host" source exists only while `hostStream` is non-null:

```
ShowPlus.tsx:2556-2563   if (!hostStream) { removeGuestSource("host"); return; }
                          addGuestSource("host", "Host", hostStream, "camera");
```

So in an instance whose `[HOSTCAM]` failed, a "Host" source cannot be on the canvas.

**Remaining, and therefore what a visible camera on the panel/popout canvas must be — a `+ Camera` engine source:**

```
VideoEngineContext.tsx:507-510
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { deviceId: { exact: deviceId }, width: 1280, height: 720, frameRate: 30 },
  });
```

An independent `getUserMedia` producing an independent `MediaStream`, stored in engine `sources`
(`VideoEngineContext.tsx:514-518`) — **never handed to any peer connection**, and created with **`audio: false`**, so
even if it were, the guest would get a silent host.

**Fourth possibility, and the one that matters most — the deck slot's preview, which IS visible:**

```
ShowPlus.tsx:2084   <div style={{ width: "100%", aspectRatio: "16/9", … }}>     ← visible, not display:none
ShowPlus.tsx:2085     <HostCamera
ShowPlus.tsx:2091       showGrid={showGrid} showFrameOverlays active            ← `active` hardcoded TRUE
```

If a deck slot is configured as video, **that** surface shows a live host-camera preview — a real, visible, working
camera — while the panel or popout instance sits at `[HOSTCAM] FAILED`.

## 3. Two (or three) instances — and the one that never lets go

```
App.tsx:2614-2615   <VideoStudio active={panel === "videostudio"} />    ← panel: always MOUNTED, camera only when selected
App.tsx:3912        <VideoStudio embedded />                            ← deck slot: no active prop
PopoutRenderer.tsx  case "videostudio": content = <VideoStudio />;      ← popout: separate PROCESS, active defaults true
```

**The deck slot is the strongest suspect, for a reason beyond the earlier analysis.** `ShowPlus.tsx:2091` passes a
**bare `active`** to `HostCamera` — JSX shorthand for `active={true}`, **hardcoded**. `EmbeddedStudio` is not even
given the parent's `active` prop to forward (`ShowPlus.tsx:2708-2712` passes ~20 props; `active` is not among them).

Consequence: **a video deck slot opens the camera the moment it mounts and holds it for the life of the app**,
regardless of which panel you are on. The panel instance, by contrast, releases on navigate-away
(`ShowPlus.tsx:833-838`). So the deck slot wins the device by simply being there first and never yielding — and its
preview is visible, which matches "the camera is open and visible and working."

### Does the module-level claim make one instance fail while another shows the camera?

**It cannot arbitrate between two `HostCamera`s, and across processes it does not apply at all.**

```
VideoEngineContext.tsx:239-240   let _hostCamPending = false;
                                  let _hostCamDeviceId: string | null = null;
```

Two defects for this scenario, both structural:

1. **It was designed for `HostCamera` vs `+ Camera`, not `HostCamera` vs `HostCamera`.** Nothing in `HostCamera`
   consults the claim before opening — it only *writes* it (`ShowPlus.tsx:765` begin, `:806`/`:823` settle). Two
   `HostCamera`s in one process therefore **overwrite each other's claim state**: whichever settles last wins the
   variable, and one instance settling `null` (`:823`, `:836`, `:843`) erases the other's live claim, re-opening the
   window for a `+ Camera` add.
2. **A popout is a separate renderer process** with its own module instance, so the popout's claim and the main
   window's claim are two unrelated variables. **Cross-window device arbitration is impossible with a module-level
   flag.** This limitation is recorded in `docs/showplus-one-owner-popout-design-2026-07-29.md` §2 (rev 3).

So the claim neither causes nor prevents the split. The split is caused by multiple mounts each calling
`getUserMedia` on a single-open device.

## 4. Was `hostStream` null in the instance the guest was connected to?

**Yes — necessarily, if that instance logged the recvonly warning.** The two are the same `if/else`:

```
ShowPlus.tsx:546   if (hostStreamRef.current) { …addTrack… }
ShowPlus.tsx:559   } else {
ShowPlus.tsx:560     console.warn("[WEBRTC] No host stream — adding recvonly transceivers …");
ShowPlus.tsx:560-562   pc.addTransceiver("video", {direction:"recvonly"}); …("audio", …)
```

The recvonly line **is** the proof that `hostStreamRef.current` was null **in that instance at that moment**. And
`[HOSTCAM] FAILED` is emitted by `HostCamera`'s catch (`ShowPlus.tsx:824`) in whichever instance failed. If both lines
appear in the *same* console, they are the same instance, and that instance is the one the guest reached.

**Which instance the guest reached is decided by the invite link/room code, and each instance mints its own:**

```
ShowPlus.tsx:29-33   const SHARED_SESSION_TOKEN = Math.random()… ;  const SHARED_ROOM_CODE = …
```

Module scope — **evaluated once per renderer process.** Therefore:

| Pairing | Token/room code | Effect |
|---|---|---|
| Panel + deck slot (same window, same module instance) | **identical** | Both open a socket on one host session; the server closes the incumbent (`close(1000,'Replaced')`). The guest reaches whichever connected last |
| Popout + anything in the main window | **different** | Two independent sessions with **different room codes and different invite links**. The guest reaches exactly the surface whose link they used |

**UNKNOWN — and the decisive checks, since this is runtime, not tree:**

1. **Do `[HOSTCAM] FAILED` and `[WEBRTC] No host stream` appear in the SAME console?** Each window has its own
   DevTools. Same console → one instance, and it is the guest's. Different consoles → the split is confirmed and the
   visible camera belongs to the other window.
2. **Which surface produced the link/room code the guest used?** That names the instance the guest is connected to.
3. **Is any deck slot configured as video?** If yes, `ShowPlus.tsx:2091` means it is holding the camera right now.

---

## The answer

**It is two (or three) instances splitting one device, not one instance misreading its stream.**

`acceptGuest` reads `hostStreamRef.current` — its *own* instance's stream (`ShowPlus.tsx:421-422`, `:546`). That value
is null because that instance's `getUserMedia` lost the race for a single-open camera and logged
`[HOSTCAM] FAILED … device not found` (`:824`). The camera you can see is a *different* `MediaStream`, held by a
different mount — most likely the deck slot, whose `HostCamera` is passed a hardcoded `active` (`:2091`) and so opens
and holds the device for the life of the app while showing a visible preview (`:2084`) — or, on the panel/popout
canvas, a `+ Camera` engine source (`VideoEngineContext.tsx:507`, `audio:false`).

Nothing in the code moves the winner's stream to the loser. So the loser tells the truth twice: "device not found",
and then "no host stream — recvonly". And the guest, equally truthfully, reports *"Waiting for the host's camera."*

**This is exactly the one-place-at-a-time problem** that `docs/showplus-one-owner-popout-design-2026-07-29.md` (rev 2)
exists to end: one live surface, therefore one `HostCamera`, therefore no race. Phase 1's claim cannot substitute for
it — §3 above shows why it cannot arbitrate this case even in principle.

## Not proposed, not built

No fix here. For the record, the three things this rules out as causes: the camera hardware, the Cloudflare TURN work
(the guest reaches `connected` — the relay is doing its job), and the guest page (it is faithfully reporting the
absence of a video track).

## Scope note

Read-only. No file in `C:\openair` modified, nothing committed, nothing on the Lightsail box touched.
