# Show+ device layer — one acquisition service (design, 2026-07-27)

**Status:** DESIGN ONLY — build nothing from this doc yet. Written after three device bugs surfaced in one
session (camera "Requested device not found", main-preview swapped off the canvas, audio pickers empty) and
a full read-only audit of the Show+/video-studio device layer. This is the design of record for the real fix
so it isn't re-derived as bug #4.

A broadcast tool's capture layer must be able to say, deterministically, *who holds which device*. Today it
cannot — and that is the whole problem.

---

## The systemic root

**There is no device manager, broker, or reference count anywhere in the codebase.** Grepped for every
plausible name (`deviceManager`, `DeviceService`, `deviceBroker`, `acquireDevice`, `sharedStream`,
`refCount`) — the only hit is docs, not code. Every component calls
`navigator.mediaDevices.getUserMedia` / `getDisplayMedia` / `enumerateDevices` **independently and
directly**. On Windows a camera is effectively single-open, so the moment two of these paths target the same
physical device you get `NotReadableError`, surfaced as **"Requested device not found."**

The three bugs fixed in 4.4.94 were three faces of this one gap: N independent consumers open the same
physical device with no coordination, no reference counting, and (historically) enumeration welded to a
permission grant, with failures swallowed in empty `catch {}` blocks — so every fix is whack-a-mole.

### Device-acquisition map (16 sites, the evidence)
- **Camera opens (the collision):** `HostCamera` holds the default camera continuously via
  `getUserMedia({video,audio})` at `ShowPlus.tsx:686` — and keeps holding it **even while hidden**
  (it lives in `display:none` at `ShowPlus.tsx:2576` and still captures). `addCameraSource` opens a camera
  **by exact deviceId** at `VideoEngineContext.tsx:498`. Same physical camera → second open fails. The dedup
  at `VideoEngineContext.tsx:491` only checks the engine's own source list — it is **blind to HostCamera**.
- **The one thing shared correctly:** the host stream, by reference — `addGuestSource("host", …)`
  (`ShowPlus.tsx:2392`) registers the *same* `MediaStream` the canvas attaches at `VideoEngineCanvas.tsx:82`;
  `removeGuestSource` deliberately does not stop its tracks. **This is the pattern to generalize.**
- **Screen:** two separate `getDisplayMedia` paths — legacy `useScreenShare.addSource`
  (`ShowPlus.tsx:225`, which skips `setDesktopSource` so the Electron handler falls through to `sources[0]`
  at `main.js:4341`) and the engine `addDesktopSource` (`VideoEngineContext.tsx:470`).
- **Mic:** openable by HostCamera audio (`:686`), the transient enum grant (`ShowPlus.tsx:1739`), the
  Captions loopback tap (`Captions.tsx:32`, forcing `echoCancellation:false`/AGC off), and StudioPro record
  (`StudioPro.tsx:2046`) — usually shareable on Windows, but conflicting constraints + exclusive-mode
  interfaces can `NotReadableError` the second opener.
- **Enumeration:** `ShowPlusPanel` (`:1741`, decoupled from grant as of 4.4.94), `VideoEngineContext.listCameras`
  (`:750`, ungated but never grants labels), `Captions` (`:88`), and `AudioDevices.tsx:32-41`
  (**still gated behind the grant**). `devicechange` is subscribed only by `ShowPlusPanel` (`:1749`) and
  `AudioDevices` (`:50`) — camera/caption lists go stale on plug/unplug.
- **Output routing:** `setSinkId` is real (not decorative) but applies only to the monitor `<audio>`
  elements (`ShowPlus.tsx:1779/1792/2137`) — "Output Device" affects self-monitoring only.
- **Electron permissions are fine and stay:** `setPermissionCheckHandler`/`RequestHandler`
  (`main.js:1721-1735`, both return true — required for `file://` packaged origins) and
  `setDisplayMediaRequestHandler` (`main.js:4333`).

---

## What 4.4.94 fixed vs. what remains

**Shipped (4.4.94, commit debbc9c):**
- Composited canvas is the permanent main stage on every right-panel tab (`ShowPlus.tsx:2564` always-flex;
  HostCamera block always hidden but mounted for capture).
- `ShowPlusPanel` audio pickers enumerate unconditionally (grant is best-effort, label-only).

**NOT fixed — the roots:**
1. **Camera double-open** (`ShowPlus.tsx:686` vs `VideoEngineContext.tsx:498`) — the true source of
   "Requested device not found." 4.4.94 hid HostCamera's error preview; it did not stop HostCamera from
   holding the camera. Adding the same camera as a source still collides.
2. **`AudioDevices.tsx:32-41`** — a second, still-live copy of the gated-enumerate anti-pattern; a mic-less
   box collapses its input *and* output lists there.

Ranked remainder: (3) mic multi-open with conflicting constraints; (4) legacy `useScreenShare` bypassing
`setDesktopSource`; (5) silent catches hiding failures (`ShowPlus.tsx:1746`, `VideoEngineContext.tsx:752` →
misleading "check permissions", `Captions.tsx:90`); (6) camera/caption lists ignore `devicechange`.

---

## The design — one device-acquisition service

A single provider-level module that owns all physical-device access. Consumers ask it for a device; they
never call `getUserMedia`/`enumerateDevices` directly.

1. **Open each physical device at most once**, keyed by `deviceId`+kind. Hand out **shared tracks** (or
   `track.clone()`) to each consumer — host preview, engine camera source, canvas video element, recorder.
   The host cam and an "add camera" of the same device resolve to the **same handle**, eliminating the
   camera collision structurally (generalizes the host-stream-by-reference pattern that already works).
2. **Reference-count** consumers. Release (`track.stop()`) only on the last release. Centralize
   release-before-reacquire on device-id change (today it's duplicated only inside HostCamera at `:679`).
3. **Enumeration fully decoupled from grants, everywhere.** One `listDevices(kind)` that never gates on
   `getUserMedia`, subscribes once to `devicechange`, applies label fallbacks, and is the sole source for
   every picker — fold in `AudioDevices`, `ShowPlusPanel`, `listCameras`, Captions. Optionally do **one**
   grant to unlock labels, but never let its failure abort the list.
4. **Typed, consumer-visible errors** (`DEVICE_BUSY` / `NOT_FOUND` / `PERMISSION`) so pickers show a real
   message + retry (copy HostCamera's honest pattern at `:698/:749`) instead of empty lists.
5. **One screen path** — retire legacy `useScreenShare` (`ShowPlus.tsx:220-243`) in favor of the engine
   `addDesktopSource` route through `setDesktopSource`.

Anchor receipts for the build: `ShowPlus.tsx:686` + `VideoEngineContext.tsx:498` (the two camera opens that
must become one shared handle), `ShowPlus.tsx:2392` + `VideoEngineCanvas.tsx:82` (the by-reference sharing to
generalize), `AudioDevices.tsx:32-41` (the gate to remove), `main.js:1721`/`4333` (permission/display
handlers — fine, leave them).

---

## Phasing

- **Interim (fast, unblocks users now):** two targeted patches — (a) make `addCameraSource` reuse
  HostCamera's stream when it names the same physical camera (or stop HostCamera's own camera hold once the
  camera is a source), and (b) apply the ShowPlusPanel enumeration fix to `AudioDevices.tsx`. Kills bug #1
  and #2 without the full service. Ships behind normal testing.
- **Full fix:** the device-acquisition service above. Ends the whole class. Larger — touches the entire
  Show+ capture layer; off-air / packaged testing required (this is real-device code that only proves out
  on install, per the UI-fix rule).

**Build nothing yet.** This is the design of record; decide interim-vs-full before any code.
