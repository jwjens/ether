# Build report — Show+ merge Phase 1: the host camera opens reliably

**Date:** 2026-07-29 · **Branch:** `log-reader-flip` · **Files touched:** 2
**Diff:** `src/components/ShowPlus.tsx` +153/−23, `src/components/VideoEngine/VideoEngineContext.tsx` +40/−0
**Status:** built + typechecked. **No version bump, no commit, no push, no installer, no install.** Awaiting GO.

> Note on `package.json`: it shows as modified in `git status`, but that is the **4.4.97 bump from the previous
> release**, still uncommitted from that turn. This patch did not touch it.

---

## The bug being fixed

`hostStream` is null at Accept, so `acceptGuest` takes the recvonly branch (`ShowPlus.tsx:559-562`) and the host
offers **no media at all** — no camera, no mic. The guest sees only himself. The null originates in `getUserMedia`
throwing inside `HostCamera.start()`, where the failure was written into a state variable rendered inside a
`display:none` wrapper (`ShowPlus.tsx:2696`, added by 4.4.94 `debbc9c`) and logged nowhere.

Three changes, exactly as scoped. Nothing else.

---

## 1. The silent catch now has a voice — `ShowPlus.tsx:762-827`

Every acquisition attempt and every outcome is logged under a `[HOSTCAM]` prefix, with the error **name**, the
**message**, and **which constraint attempt** failed.

| Event | Line | Log |
|---|---|---|
| Per-attempt failure | `:796` | `[HOSTCAM] attempt 2/3 failed — 1920x1080 + selected mic: OverconstrainedError: …` |
| Success | `:808-812` | `[HOSTCAM] acquired on attempt 3/3 — 1920x1080 + default mic` + `{video, audio, resolution}` |
| Acquired but silent | `:814` | `[HOSTCAM] stream has NO audio track — guests will see the host but hear nothing` |
| Total failure | `:824` | `[HOSTCAM] FAILED to open the host camera after all attempts — the host will transmit NOTHING (acceptGuest falls back to recvonly transceivers): NotReadableError: …` |

The final line names the **consequence**, not just the error, so the log connects itself to the recvonly warning that
`acceptGuest` already prints at `ShowPlus.tsx:560`. The two together now read as one story.

The pre-existing `setError(...)` behaviour is preserved (`:825`) — the hidden UI still gets its message; it simply is
no longer the *only* place the reason exists. **Surfacing that state visibly is not in this phase** and is not done
here.

Note the old inner `catch {}` at the previous `:770` discarded the first attempt's error entirely. That error — the
one that says *why* the camera would not open — is now the most useful line in the log.

## 2. Host camera first — `VideoEngineContext.tsx:236-256`, `:514-528`; `ShowPlus.tsx:765, 806, 823, 836, 843`

A module-level acquisition claim, consulted by `addCameraSource` before it opens anything:

```
VideoEngineContext.tsx:243   hostCameraClaimBegin()            → pending = true
VideoEngineContext.tsx:248   hostCameraClaimSettle(deviceId)   → pending = false, deviceId = held camera (or null)
VideoEngineContext.tsx:253   hostCameraClaimGet()              → { pending, deviceId }
```

Wired into `HostCamera`:

| Point | Line | Effect |
|---|---|---|
| Start of `start()` | `ShowPlus.tsx:765` | claim goes **pending** — stage adds are refused while the host camera opens |
| On success | `:806` | claim settles to the **actual deviceId** from `track.getSettings()`, **before** `onStream(s)` at `:817` |
| On failure | `:823` | claim settles to null — the device is genuinely free, not reserved by a stale flag |
| `active` false | `:836` | same release |
| Effect cleanup | `:843` | same release |

And enforced in `addCameraSource` (`VideoEngineContext.tsx:514-528`), ahead of its `getUserMedia`:

- `claim.pending` → refuse with *"The host camera is still opening — try adding this camera again in a moment."*
- `claim.deviceId === deviceId` → refuse with *"Camera … is already in use as the host camera."*

**Why this was needed on top of the 4.4.95 guard.** That guard (`VideoEngineContext.tsx:531-545`, unchanged and still
in place below the new one) matches against a registered `"host"` **source**, and that source only exists once
`hostStream` is non-null (`ShowPlus.tsx:2510` registers it, `:2505-2509` skips when null). So it guarded a state that
could not occur in the failure case: with the host camera not yet open — or having failed — there was no `"host"`
source to match, `+ Camera` took the device, and the host was locked out permanently, because `HostCamera` only
retries on `[resolution, active, micDeviceId]` (`:844`). The claim covers exactly that window.

**Module-level, deliberately.** `HostCamera` mounts in both the provider-wrapped panel tree (`:2698`, inside
`VideoEngineProvider` at `:2678`) and the embedded tree (`:2034`), which has **no** provider — so React context cannot
carry this. Documented in the code at `VideoEngineContext.tsx:236-241`, including that this is an ordering claim, not
a device broker.

## 3. The retry now relaxes audio too — `ShowPlus.tsx:775-800`

The old ladder was two rungs that relaxed **only video** and carried the same `{deviceId:{exact: micDeviceId}}` audio
constraint into both (old `:769`, `:771`). A stale persisted `video_audio_input` id therefore threw
`OverconstrainedError` on *both* attempts and killed the camera outright — even though the camera itself was fine.

The ladder is now three rungs, relaxing the two axes independently:

| # | Line | Constraints |
|---|---|---|
| 1 | `:778-779` | requested resolution + selected mic |
| 2 | `:780-781` | 1920×1080 + selected mic |
| 3 | `:782-783` | 1920×1080 + **default mic** |

Loop at `:788-799`; the first success wins and records which rung was used. Operator notices preserve the existing
pattern (`:820-822`): rung 2 keeps *"4K not supported by camera — using 1080p"*, rung 3 adds *"Selected microphone
unavailable — using the system default"*. If all three fail, the **last real error is rethrown** (`:800`) so the final
log carries a genuine `NotReadableError`/`NotFoundError` rather than a synthetic one.

**Deliberately NOT built: a fourth rung with `audio: false`.** It would let the camera open on a machine with no
working mic at all — and would hand every guest a host who is visible and permanently silent, with nothing in the UI
saying so. That is the same class of failure this phase exists to end. Instead, rung 3 failing is logged as a hard
failure, and an acquired-but-audioless stream is called out explicitly at `:814`. If a silent-host mode is ever
wanted, it needs an honest-state decision, not a quiet fallback.

---

## Typecheck gate

```
$ npx tsc --noEmit
src/components/OnboardingFlow.tsx(2039,42): error TS2366: …
src/components/PhoneDesk.tsx(777,21): error TS2345: …
```

**PASS — exactly the 2 standing baseline errors, both pre-existing and outside this work. Zero new errors, none in
`ShowPlus.tsx` or `VideoEngineContext.tsx`.**

---

## What this does and does not promise

**Does:** removes the two failure modes that could leave `hostStream` null with no explanation — a stale mic id
(rung 3) and a stage source stealing the camera during startup (the claim) — and makes any remaining failure state
itself in the log, with the consequence named.

**Does not:** guarantee the camera opens on your machine. If the device is held by something outside this app, or by
the `+ Camera` source *added before this build*, rung 1-3 still fail — but you will now see exactly which error and
which rung, which is the thing that was missing. The full answer to the collision class remains the acquisition
service in `docs/showplus-device-layer-design-2026-07-27.md` (design-only, not built).

**Verification is a live guest call, not a typecheck.** Expected console on a healthy run:
`[HOSTCAM] acquired on attempt 1/3 …` with `audio: 1`, then `[WEBRTC] Adding host track to PC for guest …` twice
(video and audio) at `ShowPlus.tsx:552-558` — and **no** `No host stream — adding recvonly transceivers` line. If the
recvonly line still appears, the `[HOSTCAM]` line immediately above it now says why.

---

## Architecture compliance

- **`CLAUDE.md` — "BUILD THE SENSE, NOT THE SCAFFOLD … honest state (observed, never claimed)."** This phase is mostly
  sense: `:796`, `:808`, `:814`, `:824`. The one place the reason was written was invisible by construction; it now
  reaches the console with the consequence spelled out. The `audio: false` rung was refused on the same principle.
- **`CLAUDE.md` — "Correct minimal solution … name what you're deliberately NOT building."** Two files, one new
  three-function module-level claim, one ladder. Not built, per instruction: deleting the full panel, the popout,
  `PopoutRenderer`, the deck-slot view, the close dialog, the mic bus, the `studio:rtmp` `destId` defect and
  `studio:rtmp:stopped` targeting, MIC VOL being monitor-only, and the device-acquisition service.
- **`docs/showplus-host-outbound-and-two-surfaces-trace-2026-07-29.md`** — the receipts this build acts on: §1 (the
  `:781` catch and the hidden error UI), §2 (Stream A vs Stream B, and `+ Camera` holding the device), §4 (MIC VOL
  monitor-only, untouched here).
- **`docs/showplus-one-owner-popout-design-2026-07-29.md` §7 Phase 1** — this is exactly that phase's scope: "give
  `:781` a voice and establish host-camera-first ordering", plus the audio-constraint fix the same section names.
  Phases 2-5 untouched.
- **`docs/showplus-device-layer-design-2026-07-27.md`** — consistent with, not a substitute for. The claim is an
  ordering primitive covering one collision pair; the doc's acquisition service (shared handles, reference counting)
  remains the design of record and is not built here. Stated in the code comment at `VideoEngineContext.tsx:239-241`.
- **Nothing contradicted the trace's receipts.** Every line it cited was found as recorded (`:559-562` recvonly,
  `:781` silent catch, `:769`/`:771` shared audio constraint, `:2505-2512` host-source guard, `:496-506` the 4.4.95
  guard). No STOP condition was triggered.
- **Help entry:** not required — no new user-facing surface or control. Two existing operator notices gained a third
  sibling message; no new door.

## Stopped here

No version bump, no commit, no push, no installer, no install. Nothing on the Lightsail box was touched.
