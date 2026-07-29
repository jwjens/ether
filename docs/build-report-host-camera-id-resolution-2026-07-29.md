# Build report — the host camera is the camera already on screen

**Date:** 2026-07-29 · **File:** `src/components/ShowPlus.tsx` (only) · **Diff:** +38 over the device-service build
**Status:** built + typechecked. **No version bump, no commit, no push, no installer.** Awaiting GO.

---

## What was wrong

The device acquisition service (built earlier today) opens each physical camera at most once and shares the handle —
but only if the two consumers ask for it by the **same key**. They didn't:

| Consumer | Asked for | Service key |
|---|---|---|
| `HostCamera` | the system default, no `deviceId` | `camera:@default` |
| `+ Camera` stage source | explicit `deviceId` | `camera:1bcf28d2…` |

A default's deviceId is unknown until it is opened, so a `@default` request could not be matched against a camera
already open under its real id. **Stage-first therefore still collided:** second `getUserMedia` on the same physical
device → `NotReadableError` → `hostStream` null → `acceptGuest` recvonly → guest receives **no video and no audio**.

Confirmed from the operator's screenshot: the SOURCES list held `Integrated Webcam (1bcf:28d2) — CAMERA · 1280×720`
(the `+ Camera` open — `1280×720` is exactly `VideoEngineContext.tsx:515`'s constraint) and **no "Host" row**, which
`GuestEngineSync` adds only when `hostStream` is non-null (`ShowPlus.tsx:2556-2563`). One camera on screen, working;
`hostStream` null behind it.

**And the framing was wrong, not just the key.** The operator's position — *"the integrated cam is the host"* — is the
correct one. The code carried two different objects both meaning "the host camera": a hidden `HostCamera` capture that
is the only thing ever sent to a guest, and whatever the operator put in SOURCES, which never reaches a guest at all.
This change makes them the same track.

## The fix

**`resolveHostCameraDeviceId()` — `ShowPlus.tsx:774-800`.** Resolve to a concrete `deviceId` *before* acquiring:

1. **`:778-782` — if exactly one camera is already open in this app, that IS the host camera.** This is the case that
   was broken: the operator adds their webcam under SOURCES, sees it working, and expects the guest to get it. Now
   they do, because the host acquires that same id and the service returns the same track.
2. **`:786-793` — otherwise resolve the platform default to a real id** via `enumerateDevices()`, so a stage source
   added *later* reuses this open instead of colliding with it.
3. **`:797-799` — last resort**, fall back to the platform default with a warning, which is the old behaviour.

Applied at both acquisition attempts — `:825` (requested resolution) and `:828` (1080p fallback) — so the retry can't
silently drop back to an unmatched key.

Each branch logs which camera was chosen and why (`:780`, `:789`, `:791`, `:797`), so the choice is observable rather
than inferred.

## Audio

**The guest getting no audio was the same failure, not a second one.** Host audio reaches a guest by exactly one
route: the mic track inside `hostStream`, added by `acceptGuest`. With `hostStream` null the recvonly branch
negotiates **no media at all** — video *and* audio. `hostStream` is composed at `ShowPlus.tsx:848` as
`new MediaStream([cam.track, mic.track])`, so once the camera resolves, both tracks are present and both are added.

No separate audio change was needed, and none was made.

## Typecheck gate

```
$ npx tsc --noEmit
src/components/OnboardingFlow.tsx(2039,42): error TS2366: …
src/components/PhoneDesk.tsx(777,21): error TS2345: …
```

**PASS — the 2 standing baseline errors only. Zero new, none in `ShowPlus.tsx`.**

## Architecture compliance

- **`docs/showplus-device-layer-design-2026-07-27.md:76-81`** — "open each physical device at most once, keyed
  `deviceId`+kind." This change is what makes the key actually singular; without it the service met the letter and
  missed the point in one open order.
- **`CLAUDE.md` — "BUILD THE SENSE."** The resolution decision is logged with the id and the reason, so "which camera
  did the host take, and why" is answerable from the console instead of by reasoning.
- **`CLAUDE.md` — "Correct minimal solution."** One file, one helper, two call sites. The service contract, the
  SOURCES list, multi-camera support, and `+ Camera` are all untouched.
- **Not built:** the popout/panel merge, the close dialog, the mic bus, MIC VOL being monitor-only, the `studio:rtmp`
  defects.

## Known limits

1. **Multiple cameras already open** → step 1 is skipped and the host takes the first enumerated device
   (`:786-793`). With two stage cameras and a distinct host camera intended, that may not be the one wanted;
   an explicit host-camera picker is the real answer and is not built.
2. **Enumeration before permission** returns entries with empty `deviceId`; those are filtered (`:788`) and the code
   falls through to the platform default — the old behaviour, no worse.
3. **First opener's resolution still wins** (inherent to one-open sharing) — if the stage opened at 1280×720, the host
   shares that rather than its requested resolution.

## Verification (runtime, after GO — not asserted here)

With a camera already added under SOURCES, opening Show+ should log
`[HOSTCAM] using the camera already open in this app: 1bcf28d2…` → `[DEVICE] reusing open camera …` (**no second
open**), then `[HOSTCAM] acquired via device service {video: 1, audio: 1}`. A "Host" row should appear in SOURCES. On
Accept, two `[WEBRTC] Adding host track to PC` lines — one `video`, one `audio` — and **no** recvonly warning. The
guest page should leave "Waiting for the host's camera" and carry sound.

## Stopped here

No version bump, no commit, no push, no installer, no install. Nothing on the Lightsail box touched.
