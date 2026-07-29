# Build report — device acquisition service: one open, shared by reference

**Date:** 2026-07-29 · **Branch:** `log-reader-flip`
**Files:** 1 new (`src/components/VideoEngine/deviceService.ts`, 200 lines), 2 modified
**Status:** built + typechecked. **No version bump, no commit, no push, no installer, no install.** Awaiting GO.

---

## The bug this closes

Confirmed in `docs/showplus-single-instance-camera-split-2026-07-29.md`: inside **one** Show+ instance the camera was
opened **twice** — `HostCamera` (system default, video+audio) and `+ Camera`
(`VideoEngineContext.tsx:507`, exact deviceId, `audio:false`). A camera is single-open on Windows, so one call won.
The `+ Camera` source won and was what you could see; `HostCamera` failed with `NotReadableError`, `hostStream` went
null, and `acceptGuest` — which reads only `hostStreamRef`, never the engine — negotiated recvonly and sent the guest
nothing.

**Result now required and delivered by construction:** the camera on the stage and the camera the guest receives are
**the same `MediaStreamTrack` object**. They cannot diverge, because there is only one open.

---

## 1. The service — `src/components/VideoEngine/deviceService.ts`

| Piece | Line | What |
|---|---|---|
| `DeviceKind` | `:32` | `"camera" \| "mic"` — the key's kind half |
| `DeviceHandle` | `:34-44` | `{ kind, deviceId, track, release() }` — `track` is **shared**, not a copy |
| `entries` | `:54` | open devices, keyed `${kind}:${deviceId}` — **at most one per physical device** |
| `aliases` | `:57` | request-key → real-key, because "system default camera" has no id until it is open |
| `inflight` | `:59` | in-flight opens, so two consumers racing produce **one** `getUserMedia` |
| `acquire()` | `:106-176` | reuse → join-in-flight → open once. The only `getUserMedia` in the video path (`:140`) |
| `makeHandle()` | `:87-104` | `refs += 1`; `release()` is **idempotent** (`:96-97`) so a double release cannot free another consumer's device |
| `dropEntry()` | `:79-85` | stops the track and forgets the entry — **only at zero refs** (`:102`) |
| `acquireCamera()` | `:179-190` | optional `deviceId` (omit = system default), ideal width/height |
| `acquireMic()` | `:192-197` | optional `deviceId` |
| `deviceServiceSnapshot()` | `:71-78` | observability: what is open, refcounts, live state |

Two robustness details worth naming:

- **Dead-device recovery** (`:118-124`, `:158-161`): if a track ends (unplugged, revoked), the entry is dropped so the
  next `acquire` re-opens rather than handing out a dead track.
- **One track per key** (`:142-148`): extra tracks from a combined open are stopped immediately; the service owns
  exactly one track per `deviceId+kind`.

**Consumer rule, stated in the header (`:27-31`):** never `track.stop()` a shared track — `release()` instead.

## 2. `HostCamera` — now a consumer, and it gets video AND audio

`ShowPlus.tsx:773-834`. The old three-rung combined `getUserMedia` ladder is replaced by **two independent
acquisitions**:

| Step | Line | Behaviour |
|---|---|---|
| Release previous handles | `:780` | `releaseHandles()` (`:764-768`) — **release, not stop**, because the stage may hold the same device |
| Camera at requested res | `:786` | `acquireCamera({ width: w, height: h, who: "HostCamera" })` |
| …falls back to 1080p | `:789` | keeps the existing "4K not supported" notice |
| Mic, selected device | `:798` | `acquireMic({ deviceId: micDeviceId })` |
| …falls back to default mic | `:802` | keeps the "Selected microphone unavailable" notice |
| Compose the host stream | `:808` | `new MediaStream([cam.track, mic.track])` — **video AND audio**, both shared |
| Failure path | `:826-834` | releases any half-acquired handle, then the existing `[HOSTCAM] FAILED …` error |

**Why video and audio are separate acquisitions:** the key is `deviceId+kind`, so the camera and the mic are distinct
entries. That also means a stale persisted mic id can no longer take the camera down with it — the exact failure Phase
1 fixed with a ladder is now structural.

**Semantics deliberately preserved from Phase 1:** if *both* mic attempts fail, the whole `start()` fails. A host that
is visible but permanently silent, with nothing on screen saying so, is still refused rather than shipped as a quiet
fallback (`:800`, comment at `:794-796`).

Effect teardown (`:838-848`) releases instead of stopping, so navigating away no longer kills a camera the stage is
still using.

## 3. `+ Camera` — shares the open; both refusals deleted

`VideoEngineContext.tsx:496-530`.

**Deleted as instructed:** the Phase-1 refusal (`claim.pending` / `claim.deviceId === deviceId`), and with it the
module-level claim helpers `hostCameraClaimBegin/Settle/Get` (`grep hostCameraClaim src/` → **NONE**). Their comment
tombstone is at `VideoEngineContext.tsx:236-239`.

**Also deleted:** the 4.4.95 *"already on stage as X"* branch. Its stated rationale was *"a second getUserMedia on a
held device throws NotReadableError"* — that second open cannot happen any more, so the refusal only blocked
legitimate sharing. **This is a judgment call beyond the literal instruction, flagged here for review:** it was
required to satisfy "the camera on the stage IS the camera the guest receives", since otherwise adding the host's
camera as a stage tile is refused outright.

**Kept:** the same-deviceId duplicate check (`:507-511`) — list hygiene, not device arbitration. Two identical tiles
help nobody. This predates Phase 1.

**The acquisition** (`:515`): `acquireCamera({ deviceId, width: 1280, height: 720, frameRate: 30, who: "stage:<label>" })`.
Stage sources stay **video-only** (`:518` wraps just the video track), so nothing about the SOURCES list changes:
screen-only shows, camera optional, add/remove at will, multiple local cameras — all untouched and unrestricted.

## 4. Teardown — the part that would silently break sharing

`VideoSource` gains `release?: () => void` (`VideoEngineContext.tsx:32-35`), set at `:525`.

`removeSource` (`:545-553`) now **releases** service-owned sources and only `stop()`s sources it opened itself (screen
and window capture). Without this, removing a stage camera tile would have stopped a track the host peer connection
was still sending — the same class of bug, inverted.

`removeGuestSource` is unchanged and still deliberately does not stop tracks — the precedent this whole change
generalises.

---

## Typecheck gate

```
$ npx tsc --noEmit
src/components/OnboardingFlow.tsx(2039,42): error TS2366: …
src/components/PhoneDesk.tsx(777,21): error TS2345: …
```

**PASS — exactly the 2 standing baseline errors. Zero new errors, none in the three files touched.**

---

## Architecture compliance

- **`docs/showplus-device-layer-design-2026-07-27.md:76-81`** — implemented as specified: *"Open each physical device
  at most once, keyed `deviceId`+kind. Hand out shared tracks."* `deviceService.ts:54` is that map; `:106-176` is that
  policy; refcounting is `:87-104`.
- **Same doc, lines 32-34** — *"The one thing shared correctly: the host stream, by reference —
  `addGuestSource("host", …)` … `removeGuestSource` deliberately does not stop its tracks. **This is the pattern to
  generalize.**"* Generalised exactly: every consumer now holds shared tracks, and only refcount-zero closes a device.
- **`docs/showplus-single-instance-camera-split-2026-07-29.md`** — the confirmed cause (two opens in one instance) is
  removed at the root rather than guarded against. Nothing in that trace is contradicted by what I found while
  building; every line it cited was present as recorded.
- **`CLAUDE.md` — "BUILD THE SENSE, NOT THE SCAFFOLD."** The service logs every open, every `+ref`/`-ref` with the
  live refcount, every close with the reason, and exposes `deviceServiceSnapshot()` (`:71`). A device collision can no
  longer be silent, because there is a running ledger of who holds what.
- **`CLAUDE.md` — "Correct minimal solution … name what you're deliberately NOT building."** One new module, two
  consumers rewired. **Not built:** ownership/election between windows, any handoff, the popout/panel merge, the close
  dialog, the mic bus, the `studio:rtmp` `destId` defect, MIC VOL being monitor-only.
- **No STOP condition triggered.** Nothing in the code contradicted either trace.

## Known limits, stated rather than discovered later

1. **First opener's resolution wins.** If a stage tile opens the camera at 1280×720 first, `HostCamera` shares that
   open and gets 720p rather than its requested resolution. That is inherent to one-open sharing. Re-negotiating via
   `applyConstraints` on the shared track is a follow-up, not built.
2. **Two momentary `getUserMedia` calls remain outside the service**, both label-permission grants that open and
   immediately stop: `ShowPlus.tsx:1876` (audio device list) and the enumeration path at
   `VideoEngineContext.tsx:766-774`. They are audio-only and transient; routing them through the service is a tidy-up,
   not a correctness issue.
3. **Screen and window capture are untouched** — `getDisplayMedia` is not a single-open device class.

## Verification (runtime, after GO — not asserted here)

Expected console on a healthy run: `[DEVICE] opening camera (…) for HostCamera` → `[DEVICE] opened camera …` →
`[HOSTCAM] acquired via device service {video: 1, audio: 1, …}`. Then adding that same camera under SOURCES should log
**`[DEVICE] reusing open camera … for stage:<label>`** with **no second open and no refusal**, and Accept should log
two `Adding host track to PC` lines rather than the recvonly warning. `deviceServiceSnapshot()` in the console shows
the refcounts.

## Stopped here

No version bump, no commit, no push, no installer, no install. Nothing on the Lightsail box touched.
