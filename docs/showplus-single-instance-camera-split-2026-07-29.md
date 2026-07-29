# One instance, two opens — the visible camera and `hostStream` are different objects

**Date:** 2026-07-29 · **Build:** 4.4.98 · **Mode:** READ-ONLY, diagnosis only. Nothing changed.

**Given (Jeff):** only the popout is ever open — **one instance**. In it the camera is visible and working, and the
**same popout's console** shows `[HOSTCAM] FAILED … device not found`. So within one instance, the visible camera and
`hostStream` are different objects.

**Confirmed.** Receipts below. This supersedes the multi-instance framing in
`docs/showplus-visible-camera-vs-hoststream-trace-2026-07-29.md` §3-4 — that analysis was written before the
single-instance fact and its two/three-instance branch does not apply here.

---

## 1. The visible camera is a `+ Camera` engine source, not `HostCamera`'s stream

**Established by elimination, and every step is a receipt.**

**`HostCamera`'s own preview cannot be what you see.** It is mounted inside a hidden wrapper:

```
ShowPlus.tsx:2747   <div style={{ display: "none", flex: 1, … }}>
ShowPlus.tsx:2749     <HostCamera … />
```

(4.4.94, `debbc9c`). The popout renders this same tree, so `HostCamera`'s video element is never displayed there —
working or not. Whatever is on screen is the **compositor canvas**.

**The canvas draws only layered engine sources:**

```
VideoEngineCanvas.tsx:128-129   // Iterate layers sorted by z ascending
                                 const sorted = [...layers].sort((a, b) => a.z - b.z);
```

**And the "Host" source cannot be among them while `hostStream` is null:**

```
ShowPlus.tsx:2556-2563   if (!hostStream) { removeGuestSource("host"); return; }
                          addGuestSource("host", "Host", hostStream, "camera");
```

`[HOSTCAM] FAILED` means that instance's `hostStream` is null (`ShowPlus.tsx:824` → `onStream(null)` at `:826`), so
`removeGuestSource("host")` ran and no "Host" source exists.

**Therefore the only thing left that can be drawing a live camera is a `+ Camera` source:**

```
VideoEngineContext.tsx:507-510
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,                                                    ← NO MIC, EVER
    video: { deviceId: { exact: deviceId }, width: 1280, height: 720, frameRate: 30 },
  });
VideoEngineContext.tsx:514-518   setSources(prev => [...prev, { id, kind: "camera", label, stream, externalId: deviceId }]);
```

A second, independent `getUserMedia` producing an independent `MediaStream`, stored in engine `sources` and drawn on
the canvas. **Note `audio: false`** — this stream has no microphone track at all, so it could never carry host audio
even if something did route it to a guest.

**Answer: the picture on screen is a `+ Camera` engine source. `hostStream` is a different object, and it is null.**

## 2. Open order — how `+ Camera` came to hold the device

**Both opens target the same physical camera, by different routes:**

| Opener | Constraint | Receipt |
|---|---|---|
| `HostCamera` | **no `deviceId`** → the system default camera | `ShowPlus.tsx:777-783` — all three ladder rungs specify only `width`/`height` |
| `+ Camera` | `deviceId: { exact: … }` from the picker | `VideoEngineContext.tsx:509` |

A physical camera is single-open on Windows: whoever holds it first wins, the second gets `NotReadableError`, surfaced
as *"device not found"* — which is the message in your log (`ShowPlus.tsx:824`).

**Since `+ Camera` visibly holds it and `HostCamera` failed, `+ Camera` opened first — or `HostCamera` released it in
between.** In a single instance, `HostCamera` runs at mount and `+ Camera` needs a click, so the second is the
mechanism that fits, and the code has three ways to produce it:

1. **`HostCamera` released on a re-open.** Its effect re-runs on `[resolution, active, micDeviceId]`
   (`ShowPlus.tsx:846`), and **`micDeviceId` arrives asynchronously from the KV store** (`ShowPlus.tsx:2621` sets it
   from `video_audio_input` after a `list()` round-trip). So a normal startup is: mount → open camera → KV resolves →
   effect re-runs → `start()` **stops the current tracks first** (`ShowPlus.tsx:768`) and `hostCameraClaimSettle(null)`
   runs in the cleanup (`ShowPlus.tsx:843`) → the device is briefly free and unclaimed → re-open. Anything that grabs
   the camera inside that window wins it permanently, because `HostCamera` has no retry.
2. **The Phase-1 claim silently not matching.** The guard compares stored id to requested id:
   `ShowPlus.tsx:806` stores `settings?.deviceId ?? null` from `track.getSettings()`, and
   `VideoEngineContext.tsx:526` tests `claim.deviceId && claim.deviceId === deviceId`. **If `getSettings().deviceId`
   is empty or not byte-identical to the enumerated id, the stored value is `null` and the guard never fires** — the
   `+ Camera` add proceeds against the same physical device with no refusal shown.
3. **`HostCamera` failed first for an unrelated reason**, leaving the claim `null` (`ShowPlus.tsx:823`), after which
   `+ Camera` succeeds and locks the device out for good.

**UNKNOWN which of the three applies to your session — that is runtime, not tree.** The decisive checks, in order of
cost:

- **Does the popout console show `[HOSTCAM] acquired …` *before* the `[HOSTCAM] FAILED …` line?** Acquire-then-fail
  proves path 1 or 2 (a successful open that was later lost). Fail-only proves path 3.
- **Did adding the camera under SOURCES show a refusal message?** *"already in use as the host camera"* would mean the
  guard fired and the device was added anyway from elsewhere; **no message at all** points at path 2.
- **How many `[HOSTCAM]` blocks appear in total?** More than one means the effect re-ran — path 1.

**Whichever it is, the outcome is the same and is the actual defect: two `getUserMedia` calls contend for one device,
and the loser is the one the guest needs.**

## 3. `acceptGuest` reads `hostStream` and never the visible source

**Verified by exhaustive grep of the hook body (`ShowPlus.tsx:513-620`): it contains no reference to `sources`,
`useVideoEngine`, or any engine API.** Its only media input is:

```
ShowPlus.tsx:421-422   const hostStreamRef = useRef(hostStream); hostStreamRef.current = hostStream;
ShowPlus.tsx:546       if (hostStreamRef.current) {
ShowPlus.tsx:547-554     …getTracks().forEach(track => pc.addTrack(track, hostStreamRef.current!))
ShowPlus.tsx:559-562   } else { console.warn("[WEBRTC] No host stream — adding recvonly transceivers …");
                          pc.addTransceiver("video", {direction:"recvonly"});
                          pc.addTransceiver("audio", {direction:"recvonly"}); }
```

So with `hostStream` null and a `+ Camera` source live on the canvas:

- the operator sees a working camera on the stage — real, live, correct;
- `acceptGuest` finds `hostStreamRef.current === null` and negotiates **recvonly** — the host offers no media;
- the guest, truthfully, reports *"Waiting for the host's camera."*

**There is no code path by which an engine source reaches a guest peer connection.** The compositor's canvas capture
(`VideoEngineContext.tsx:654,660`) feeds `MediaRecorder` for local recording and RTMP only — never a
`RTCPeerConnection`. The stage and the guest call are two separate media graphs that happen to want the same camera.

**This also explains the audio half:** even if the visible `+ Camera` source were somehow routed to guests, it is
created with `audio: false` (`VideoEngineContext.tsx:508`) and would deliver a silent host.

---

## The fix — `docs/showplus-device-layer-design-2026-07-27.md`, described not built

**One open, shared by reference to every consumer.** Not two opens. Not a refusal.

The design of record already states the principle and even names the working precedent (lines 32-34): the host stream
is shared by reference into the engine — `addGuestSource("host", …)` — and `removeGuestSource` deliberately does not
stop its tracks. **"This is the pattern to generalize."**

Generalised, the acquisition service is a single provider-level owner of physical device access
(`showplus-device-layer-design-2026-07-27.md:76-81`):

1. **Open each physical device at most once**, keyed by `deviceId` + kind.
2. **Hand out shared handles** — the same `MediaStream`/track by reference — to every consumer that asks.
3. **Reference-count** them, so a device closes only when the last consumer releases it.

Applied to this bug, the shape is:

- `HostCamera` stops calling `getUserMedia` directly and instead **requests** the default camera from the service.
- `+ Camera` (`VideoEngineContext.tsx:507`) requests **the same device by id** and gets **the same handle back**,
  not a second open — so the stage shows it and nothing collides.
- `acceptGuest` (`ShowPlus.tsx:546-554`) adds tracks from that same shared handle, so **the camera the operator can
  see is by construction the camera the guest receives.** The two media graphs stop being able to disagree.
- Audio is requested independently of video, so a stage camera source (`audio:false`) and the guest's mic path are no
  longer coupled to one `getUserMedia` call.
- **The `+ Camera` refusal added in Phase 1 (`VideoEngineContext.tsx:514-528`) is deleted by this**, not kept. It is
  a stopgap that converts a silent collision into a visible "no"; the product wants "yes — same handle." The SOURCES
  list stays exactly as it is: screen-only shows, camera optional, sources added and removed at will, more than one
  physical camera. **None of that is a defect and none of it is restricted.**

What the service does **not** do, and must not be confused with: it is not ownership arbitration between windows, not
a handoff, and not an election. It is one open with a reference count — the same discipline `ether-audiod` applies to
audio.

**Not built. Nothing in this document is a patch.**

---

## What this rules out

- **The camera hardware** — it is open and working; that is the premise, and the code explains the failure without it.
- **Cloudflare TURN** — the guest reaches `connected`; the relay is doing its job.
- **The guest page** — it faithfully reports the absence of a video track.
- **Multiple `ShowPlus` instances** — not the cause here. One instance, two `getUserMedia` calls.

## Scope note

Read-only. No file in `C:\openair` modified, nothing committed, nothing on the Lightsail box touched. No fix applied
and no patch proposed.
