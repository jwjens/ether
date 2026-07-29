// ── Device acquisition service ──────────────────────────────────────────────
//
// ONE open per physical device, shared by reference to every consumer.
//
// Why this exists (confirmed, not theoretical — see
// docs/showplus-single-instance-camera-split-2026-07-29.md): inside a SINGLE
// Show+ instance the same camera was opened twice — HostCamera asked for the
// system default (video+audio) and a "+ Camera" stage source asked for the same
// physical device by exact deviceId. A camera is single-open on Windows, so one
// call won and the other threw NotReadableError ("device not found"). The stage
// showed a working picture while hostStream was null, and acceptGuest — which
// reads only hostStreamRef — negotiated recvonly and sent the guest nothing.
//
// The design of record (docs/showplus-device-layer-design-2026-07-27.md:76-81)
// specifies the fix: open each physical device at most once, keyed deviceId+kind,
// hand out SHARED handles, and reference-count them so the device closes only
// when the last consumer releases. Lines 32-34 of that doc name the precedent
// being generalised here: the host stream is already shared by reference into the
// engine via addGuestSource("host", …), and removeGuestSource deliberately does
// NOT stop its tracks.
//
// The consequence that matters: the camera on the stage and the camera the guest
// receives are the SAME track object. They cannot diverge, because there is only
// one open.
//
// RULES FOR CONSUMERS
//   • Never call track.stop() on a track you got from here — it would kill the
//     device for every other consumer. Call handle.release() instead.
//   • Wrap the shared track in your own MediaStream if you need a container;
//     MediaStream objects are cheap, device opens are not.

export type DeviceKind = "camera" | "mic";

export interface DeviceHandle {
  readonly kind: DeviceKind;
  /** The resolved deviceId of the physical device actually opened. */
  readonly deviceId: string;
  /** Shared — the SAME MediaStreamTrack every other consumer of this device holds. */
  readonly track: MediaStreamTrack;
  /** Drop this consumer's reference. Idempotent. Closes the device at zero refs. */
  release(): void;
}

interface Entry {
  kind: DeviceKind;
  deviceId: string;
  track: MediaStreamTrack;
  refs: number;
  /** The constraints the FIRST opener asked for — later consumers share this open. */
  openedAs: string;
}

// Real entries, keyed by the resolved `${kind}:${deviceId}`.
const entries = new Map<string, Entry>();
// Request aliases → real key. Needed because "the system default camera" has no
// deviceId until after it is opened.
const aliases = new Map<string, string>();
// In-flight opens, so two consumers racing for the same device produce ONE open.
const inflight = new Map<string, Promise<Entry>>();

const realKeyOf = (kind: DeviceKind, deviceId: string) => `${kind}:${deviceId}`;
const reqKeyOf  = (kind: DeviceKind, deviceId?: string) => `${kind}:${deviceId || "@default"}`;

function snapshot(): string {
  const parts: string[] = [];
  entries.forEach(e => parts.push(`${e.kind}:${e.deviceId.slice(0, 8)}…×${e.refs}`));
  return parts.length ? parts.join(" ") : "(none open)";
}

/** Observability: what is open and how many consumers hold it. */
export function deviceServiceSnapshot(): { kind: DeviceKind; deviceId: string; refs: number; openedAs: string; live: boolean }[] {
  const out: { kind: DeviceKind; deviceId: string; refs: number; openedAs: string; live: boolean }[] = [];
  entries.forEach(e => out.push({
    kind: e.kind, deviceId: e.deviceId, refs: e.refs, openedAs: e.openedAs,
    live: e.track.readyState === "live",
  }));
  return out;
}

function dropEntry(entry: Entry, why: string) {
  const key = realKeyOf(entry.kind, entry.deviceId);
  entries.delete(key);
  aliases.forEach((v, k) => { if (v === key) aliases.delete(k); });
  try { entry.track.stop(); } catch { /* already stopped */ }
  console.log(`[DEVICE] closed ${entry.kind} ${entry.deviceId.slice(0, 8)}… (${why}) — now open: ${snapshot()}`);
}

function makeHandle(entry: Entry, who: string): DeviceHandle {
  entry.refs += 1;
  console.log(`[DEVICE] +ref ${entry.kind} ${entry.deviceId.slice(0, 8)}… for ${who} (refs=${entry.refs}) — open: ${snapshot()}`);
  let released = false;
  return {
    kind: entry.kind,
    deviceId: entry.deviceId,
    track: entry.track,
    release() {
      // Idempotent: a double release must never free another consumer's device.
      if (released) return;
      released = true;
      entry.refs -= 1;
      console.log(`[DEVICE] -ref ${entry.kind} ${entry.deviceId.slice(0, 8)}… from ${who} (refs=${entry.refs})`);
      if (entry.refs <= 0) dropEntry(entry, "last consumer released");
    },
  };
}

async function acquire(
  kind: DeviceKind,
  requestedId: string | undefined,
  constraints: MediaStreamConstraints,
  openedAs: string,
  who: string,
): Promise<DeviceHandle> {
  const reqKey = reqKeyOf(kind, requestedId);

  // 1. Already open under this exact request, or under the resolved id?
  const aliased = aliases.get(reqKey);
  const direct = requestedId ? entries.get(realKeyOf(kind, requestedId)) : undefined;
  const existing = direct || (aliased ? entries.get(aliased) : undefined);
  if (existing) {
    if (existing.track.readyState === "live") {
      console.log(`[DEVICE] reusing open ${kind} ${existing.deviceId.slice(0, 8)}… for ${who} (opened as ${existing.openedAs})`);
      return makeHandle(existing, who);
    }
    // Device died (unplugged, revoked). Drop it and open fresh.
    dropEntry(existing, "track ended");
  }

  // 2. An open for this request is already in flight — join it rather than racing.
  const pending = inflight.get(reqKey);
  if (pending) {
    console.log(`[DEVICE] joining in-flight open of ${reqKey} for ${who}`);
    const entry = await pending;
    return makeHandle(entry, who);
  }

  // 3. Open it — exactly once.
  const p = (async (): Promise<Entry> => {
    console.log(`[DEVICE] opening ${kind} (${openedAs}) for ${who}`);
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const track = kind === "camera" ? stream.getVideoTracks()[0] : stream.getAudioTracks()[0];
    if (!track) {
      stream.getTracks().forEach(t => { try { t.stop(); } catch { /* ignore */ } });
      throw new Error(`getUserMedia returned no ${kind} track`);
    }
    // Any extra tracks are not ours to hold — this service is one track per key.
    stream.getTracks().forEach(t => { if (t !== track) { try { t.stop(); } catch { /* ignore */ } } });

    const deviceId = track.getSettings().deviceId || requestedId || `unknown-${kind}`;
    const entry: Entry = { kind, deviceId, track, refs: 0, openedAs };
    entries.set(realKeyOf(kind, deviceId), entry);
    aliases.set(reqKey, realKeyOf(kind, deviceId));

    // If the device disappears, forget it so the next acquire re-opens instead of
    // handing out a dead track.
    track.addEventListener("ended", () => {
      const still = entries.get(realKeyOf(kind, deviceId));
      if (still === entry) dropEntry(entry, "track ended");
    });

    console.log(`[DEVICE] opened ${kind} ${deviceId.slice(0, 8)}… as ${openedAs}`);
    return entry;
  })();

  inflight.set(reqKey, p);
  try {
    const entry = await p;
    return makeHandle(entry, who);
  } finally {
    inflight.delete(reqKey);
  }
}

/**
 * Acquire a camera. Omit deviceId for the system default.
 * The FIRST opener's resolution wins; later consumers share that open rather
 * than forcing a second one.
 */
export function acquireCamera(
  opts: { deviceId?: string; width?: number; height?: number; frameRate?: number; who: string },
): Promise<DeviceHandle> {
  const video: MediaTrackConstraints = {};
  if (opts.deviceId) video.deviceId = { exact: opts.deviceId };
  if (opts.width)  video.width  = { ideal: opts.width };
  if (opts.height) video.height = { ideal: opts.height };
  if (opts.frameRate) video.frameRate = opts.frameRate;
  const label = `${opts.width || "?"}x${opts.height || "?"}${opts.deviceId ? " exact-id" : " default"}`;
  return acquire("camera", opts.deviceId, { video, audio: false }, label, opts.who);
}

/** Acquire a microphone. Omit deviceId for the system default. */
export function acquireMic(
  opts: { deviceId?: string; who: string },
): Promise<DeviceHandle> {
  const audio: MediaTrackConstraints | true = opts.deviceId ? { deviceId: { exact: opts.deviceId } } : true;
  return acquire("mic", opts.deviceId, { audio, video: false }, opts.deviceId ? "exact-id" : "default", opts.who);
}
