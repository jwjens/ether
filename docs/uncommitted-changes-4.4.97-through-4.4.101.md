# Everything uncommitted since 4.4.96 — the total of five builds

Baseline commit: `f62d556 docs(showplus): live verification receipts for the 4.4.96 ICE queue fix`

Generated 2026-07-29, after reverting the post-4.4.101 useLevelMeter edit.
**This is exactly the source 4.4.101 was built from.**

```
 CLAUDE.md                                         |   1 +
 package.json                                      |   2 +-
 src/App.tsx                                       |   1 +
 src/components/PopoutRenderer.tsx                 |   8 +
 src/components/ShowPlus.tsx                       | 255 +++++++++++++++++++---
 src/components/VideoEngine/VideoEngineContext.tsx |  58 +++--
 6 files changed, 275 insertions(+), 50 deletions(-)
PLUS untracked: src/components/VideoEngine/deviceService.ts (197 lines, never committed)
```

---

## Diff of the 6 modified files vs HEAD

```diff
diff --git a/CLAUDE.md b/CLAUDE.md
index c3b5a9e..36d8827 100644
--- a/CLAUDE.md
+++ b/CLAUDE.md
@@ -118,6 +118,7 @@ npm run electron:build:win -- --publish never   # electron-builder, LOCAL ONLY (
 - **Propose first, change nothing, wait for explicit confirmation.** Investigate read-only before edits. Never run ahead or overstep.
 - **Never commit or push before Jeff verifies.** Local commits only unless told otherwise. Never tag/release without explicit go-ahead (tagging triggers CI + client auto-update).
 - **The only valid test of a UI/routing fix is launching the app and seeing the actual screen.** A passing database query is NOT proof the screen is correct. Do not claim a routing bug is fixed based on a DB-level test.
+- **A CLAIM ABOUT WHAT THE RUNNING APP DOES REQUIRES A RUNTIME RECEIPT — a log line, a screenshot, or Jeff's word. A grep is a claim about the tree, NEVER about the product.** Static analysis proves what the source says; it does not prove what the user sees. Say what the code says, then mark the runtime behavior **UNVERIFIED** and name the one check that would settle it. Never promote "I grepped and found no case for X" into "X is broken/dead/missing" — that inversion shipped a false premise into a design doc (2026-07-29, the `videostudio` popout).
 - Never use inline `node -e` / `electron -e` (fails/quoting issues) — write a `.js` diag script and run it.
 - `schema_version` lives in its own table (rows 1..N), not in `system_state`.
 - `window.ether.<table>.list()` IPC returns `{rows:[...]}` — unwrap `.rows`.
diff --git a/package.json b/package.json
index 176c181..aac5874 100644
--- a/package.json
+++ b/package.json
@@ -67,5 +67,5 @@
     "email": "jensj@ov.org",
     "name": "Jeffrey Jens"
   },
-  "version": "4.4.96"
+  "version": "4.4.101"
 }
diff --git a/src/App.tsx b/src/App.tsx
index 47171d4..a677979 100644
--- a/src/App.tsx
+++ b/src/App.tsx
@@ -2414,6 +2414,7 @@ export default function App() {
 
                 {/* Pop-out windows for every bottom-toolbar feature — drag to another monitor */}
                 {([
+                  { key: "po-videostudio",label: "Show+",      panel: "videostudio" },
                   { key: "po-studiopro",  label: "Show+ DAW",  panel: "studiopro" },
                   { key: "po-decks",      label: "Decks",      panel: "decks" },
                   { key: "po-carts",      label: "Carts",      panel: "carts" },
diff --git a/src/components/PopoutRenderer.tsx b/src/components/PopoutRenderer.tsx
index f0250a7..82f0a9c 100644
--- a/src/components/PopoutRenderer.tsx
+++ b/src/components/PopoutRenderer.tsx
@@ -15,6 +15,7 @@ import Scheduler from "./Scheduler";
 import BroadcastCalendar from "./BroadcastCalendar";
 import { LibraryPanel } from "../App";
 import StudioPro from "./StudioPro";
+import VideoStudio from "./ShowPlus";
 import { getEngine } from "../audio/engine-registry";
 import { useActiveStation } from "../hooks/useActiveStation";
 
@@ -56,6 +57,7 @@ const TITLES: Record<string, string> = {
   "library":   "Library",
   "calendar":  "Calendar",
   "studiopro": "Show+ DAW",
+  "videostudio":"Show+",
 };
 
 // Show+ DAW in its own window — resolves the ACTIVE station (machine-global, via getActive) so
@@ -142,6 +144,12 @@ export default function PopoutRenderer({ panel }: { panel: string }) {
     case "studiopro":
       content = <StudioProPopout />;
       break;
+    // Show+ (the video studio) in its own window — same pattern as every other
+    // popout. ShowPlus brings its own VideoEngineProvider, so nothing extra is
+    // needed here; `active` defaults to true, which is what opens the camera.
+    case "videostudio":
+      content = <VideoStudio />;
+      break;
     default:
       content = (
         <div style={{ color: "#505060", padding: 32, fontSize: 13 }}>
diff --git a/src/components/ShowPlus.tsx b/src/components/ShowPlus.tsx
index b7195ee..e6b01e7 100644
--- a/src/components/ShowPlus.tsx
+++ b/src/components/ShowPlus.tsx
@@ -8,6 +8,7 @@ import React, {
 import { query as dbQuery } from "../db/client";
 import { useActiveStation } from "../hooks/useActiveStation";
 import { VideoEngineProvider, useVideoEngine } from "./VideoEngine/VideoEngineContext";
+import { acquireCamera, acquireMic, deviceServiceSnapshot, type DeviceHandle } from "./VideoEngine/deviceService";
 import VideoEngineCanvas from "./VideoEngine/VideoEngineCanvas";
 import VideoEnginePanel, { EncoderSection, DestinationsSection } from "./VideoEngine/VideoEnginePanel";
 import { useCaptions, CaptionsOverlay } from "./Captions";
@@ -410,6 +411,12 @@ function useWebRTCGuests(enabled: boolean, hostStream: MediaStream | null) {
   // candidates. Keyed by the same guest id as peersRef; flushed after
   // setRemoteDescription resolves and cleared whenever the guest goes away.
   const pendingIceRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
+  // ICE servers (STUN + Cloudflare TURN relay) are minted server-side per
+  // connection and delivered over the signaling socket. NOTHING is hard-coded
+  // here: no credentials in the app, and no STUN-only fallback — a guest that
+  // needs a relay and silently gets STUN-only is the failure this replaces.
+  const [turnState, setTurnState] = useState<{ status: "waiting" | "ready" | "error"; error?: string }>({ status: "waiting" });
+  const iceServersRef = useRef<RTCIceServer[] | null>(null);
   const enabledRef = useRef(enabled);
   enabledRef.current = enabled;
   const hostStreamRef = useRef<MediaStream | null>(hostStream);
@@ -436,7 +443,28 @@ function useWebRTCGuests(enabled: boolean, hostStream: MediaStream | null) {
         const msg = JSON.parse(ev.data);
         const { from, type, payload, name } = msg;
 
-        if (type === "offer") {
+        if (type === "ice-servers") {
+          const list = payload?.iceServers;
+          if (Array.isArray(list) && list.length > 0) {
+            iceServersRef.current = list;
+            const urls = list.flatMap((s: RTCIceServer) => Array.isArray(s.urls) ? s.urls : [s.urls]);
+            console.log("[TURN] ICE servers received from signaling server", {
+              entries: list.length,
+              urls: urls.length,
+              relay: urls.some((u: string) => typeof u === "string" && u.startsWith("turn")),
+              ttl: payload?.ttl,
+            });
+            setTurnState({ status: "ready" });
+          } else {
+            iceServersRef.current = null;
+            console.error("[TURN] ice-servers message carried no usable list", payload);
+            setTurnState({ status: "error", error: "Signaling server sent no relay credentials." });
+          }
+        } else if (type === "ice-servers-error") {
+          iceServersRef.current = null;
+          console.error("[TURN] Signaling server could not mint credentials:", payload?.error);
+          setTurnState({ status: "error", error: payload?.error || "Relay credentials unavailable." });
+        } else if (type === "offer") {
           setGuests(prev => prev.find(g => g.id === from) ? prev : [
             ...prev, { id: from, name: name || `Guest ${prev.length + 1}`, stream: null, conn: null, muted: false, status: "pending", offer: payload },
           ]);
@@ -478,6 +506,10 @@ function useWebRTCGuests(enabled: boolean, hostStream: MediaStream | null) {
       peersRef.current.forEach(pc => pc.close());
       peersRef.current.clear();
       pendingIceRef.current.clear();
+      // Credentials came from THIS socket and have a TTL. Once it closes, stop
+      // claiming "ready" — the next connection mints fresh ones.
+      iceServersRef.current = null;
+      setTurnState({ status: "waiting" });
       setGuests([]);
       wsRef.current = null;
     };
@@ -487,13 +519,24 @@ function useWebRTCGuests(enabled: boolean, hostStream: MediaStream | null) {
     const ws = wsRef.current;
     if (!ws || ws.readyState !== WebSocket.OPEN) return;
 
+    // Fail closed. Without server-minted ICE servers the only connection we could
+    // build is STUN-only — which is precisely the configuration that left guests
+    // stuck at "checking". Refuse and say why rather than build a broken call.
+    const iceServers = iceServersRef.current;
+    if (!iceServers || iceServers.length === 0) {
+      console.error("[TURN] Refusing to accept guest", id, "— no ICE servers from the signaling server yet");
+      setTurnState(prev => prev.status === "error" ? prev : {
+        status: "error",
+        error: "Relay credentials have not arrived — cannot admit guests yet.",
+      });
+      return;
+    }
+
     setGuests(prev => {
       const guest = prev.find(g => g.id === id);
       if (!guest || !guest.offer) return prev;
 
-      const pc = new RTCPeerConnection({
-        iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }],
-      });
+      const pc = new RTCPeerConnection({ iceServers });
       peersRef.current.set(id, pc);
       console.log("[WEBRTC] PC created for guest", id);
 
@@ -650,7 +693,7 @@ function useWebRTCGuests(enabled: boolean, hostStream: MediaStream | null) {
     };
   }, []);
 
-  return { guests, acceptGuest, denyGuest, removeGuest, toggleMute, sessionToken, roomCode };
+  return { guests, acceptGuest, denyGuest, removeGuest, toggleMute, sessionToken, roomCode, turnState };
 }
 
 // ─────────────────────────────────────────────────────────────
@@ -712,43 +755,165 @@ function HostCamera({
 }) {
   const videoRef   = useRef<HTMLVideoElement>(null);
   const streamRef  = useRef<MediaStream | null>(null);
+  // Handles from the device service. These tracks are SHARED with the stage — never
+  // stop() them; release() and let the service close the device at zero refs.
+  const handlesRef = useRef<DeviceHandle[]>([]);
   const [error, setError]     = useState<string | null>(null);
   const [actualRes, setActualRes] = useState<string | null>(null);
 
+  const releaseHandles = useCallback(() => {
+    handlesRef.current.forEach(h => h.release());
+    handlesRef.current = [];
+    streamRef.current = null;
+  }, []);
+
+  // Which physical camera is "the host camera"? There is only ever one answer the
+  // operator would accept: the camera this app already has on screen. Resolve it to a
+  // concrete deviceId so the host path and any stage source key on the SAME device and
+  // share one open.
+  const resolveHostCameraDeviceId = useCallback(async (): Promise<string | undefined> => {
+    // 1. A camera already open in this app IS the host camera. This is the case that
+    //    was broken: the operator adds their webcam under SOURCES, sees it working,
+    //    and reasonably expects the guest to receive it.
+    const openCams = deviceServiceSnapshot().filter(d => d.kind === "camera" && d.live);
+    if (openCams.length === 1) {
+      console.log(`[HOSTCAM] using the camera already open in this app: ${openCams[0].deviceId.slice(0, 8)}…`);
+      return openCams[0].deviceId;
+    }
+    // 2. Otherwise resolve the platform default to a real id, so a stage source added
+    //    LATER reuses this open instead of colliding with it.
+    try {
+      const devs = await navigator.mediaDevices.enumerateDevices();
+      const cams = devs.filter(d => d.kind === "videoinput" && d.deviceId);
+      if (openCams.length > 1) {
+        console.log(`[HOSTCAM] ${openCams.length} cameras already open — using the first enumerated device for the host`);
+      }
+      if (cams.length) {
+        console.log(`[HOSTCAM] resolved host camera to ${cams[0].deviceId.slice(0, 8)}… (${cams[0].label || "unlabelled"})`);
+        return cams[0].deviceId;
+      }
+    } catch (e: any) {
+      console.warn(`[HOSTCAM] enumerateDevices failed: ${e?.name || "Error"}: ${e?.message || String(e)}`);
+    }
+    // 3. Last resort — let the platform pick. Sharing may not be possible in this case.
+    console.warn("[HOSTCAM] could not resolve a camera deviceId — falling back to the platform default");
+    return undefined;
+  }, []);
+
+  // This stream is the ONLY source of outbound host media: acceptGuest adds its tracks
+  // to every guest peer connection, and when it is null the host falls back to recvonly
+  // transceivers and transmits NOTHING — no camera, no mic. So every failure here is a
+  // silent on-air failure, and every attempt gets logged under [HOSTCAM].
   const start = useCallback(async (res: ResKey) => {
+    let cam: DeviceHandle | null = null;
+    let mic: DeviceHandle | null = null;
     try {
-      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
+      // Release the previous handles rather than stopping tracks: the stage may be
+      // holding the same device, and stop() would kill its picture too.
+      releaseHandles();
       const { w, h } = RES[res];
-      const audioConstraint: MediaStreamConstraints["audio"] = micDeviceId
-        ? { deviceId: { exact: micDeviceId } }
-        : true;
-      let s: MediaStream;
+
+      // ── Camera. Resolve to a CONCRETE deviceId first. Asking for "the system
+      // default" produced a request key ("camera:@default") that could not be matched
+      // against a camera already open under its real id, so a stage source that opened
+      // first caused a second getUserMedia on the same physical device →
+      // NotReadableError → null hostStream → recvonly → guest gets nothing. Keying
+      // both consumers on the same id is what makes "the camera on the stage IS the
+      // camera the guest receives" literally true, in either open order.
+      // Try every route to a camera before giving up. NOTHING secondary — a mic
+      // problem, a stale device id, an unresolvable default — is allowed to cost the
+      // guest their video.
+      const camId = await resolveHostCameraDeviceId();
+      const camPlan: { label: string; deviceId?: string; w: number; h: number }[] = [
+        { label: "resolved id, requested size", deviceId: camId, w, h },
+        { label: "resolved id, 1080p",          deviceId: camId, w: 1920, h: 1080 },
+        { label: "platform default, 1080p",     deviceId: undefined, w: 1920, h: 1080 },
+      ];
+      for (const step of camPlan) {
+        try {
+          cam = await acquireCamera({ deviceId: step.deviceId, width: step.w, height: step.h, who: "HostCamera" });
+          break;
+        } catch (err: any) {
+          console.warn(`[HOSTCAM] camera attempt failed (${step.label}): ${err?.name || "Error"}: ${err?.message || String(err)}`);
+        }
+      }
+      // Last resort: walk every enumerated camera.
+      if (!cam) {
+        const devs = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
+        for (const d of devs.filter(d => d.kind === "videoinput" && d.deviceId)) {
+          try {
+            cam = await acquireCamera({ deviceId: d.deviceId, width: 1280, height: 720, who: "HostCamera" });
+            console.log(`[HOSTCAM] fell back to enumerated camera ${d.label || d.deviceId.slice(0, 8)}`);
+            break;
+          } catch { /* try the next one */ }
+        }
+      }
+      if (!cam) throw new Error("no camera could be opened");
+
+      // ── Microphone. NOT fatal any more. A missing mic used to throw here, which
+      // took the camera down with it and left the guest with no picture AND no sound.
+      // Video ships; the missing audio is stated loudly instead of hiding a failure.
+      let usedDefaultMic = false;
       try {
-        s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: w }, height: { ideal: h } }, audio: audioConstraint });
-      } catch {
-        s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: audioConstraint });
-        setError("4K not supported by camera — using 1080p");
+        mic = await acquireMic({ deviceId: micDeviceId || undefined, who: "HostCamera" });
+      } catch (err: any) {
+        console.warn(`[HOSTCAM] mic failed (${micDeviceId ? "selected device" : "default"}): ${err?.name || "Error"}: ${err?.message || String(err)}`);
+        if (micDeviceId) {
+          try {
+            mic = await acquireMic({ who: "HostCamera" });
+            usedDefaultMic = true;
+          } catch (err2: any) {
+            console.error(`[HOSTCAM] default mic also failed: ${err2?.name || "Error"}: ${err2?.message || String(err2)}`);
+          }
+        }
       }
+
+      handlesRef.current = mic ? [cam, mic] : [cam];
+      // Our own container over the SHARED tracks. acceptGuest adds these to every guest
+      // peer connection, so the guest gets host video — and host audio when there is a mic.
+      const s = new MediaStream(mic ? [cam.track, mic.track] : [cam.track]);
       streamRef.current = s;
+      if (!mic) {
+        console.error("[HOSTCAM] NO MICROPHONE — guests will SEE the host but not HEAR them. Video is live; fix the mic and reopen Show+.");
+        setError("No microphone available — guests can see you but not hear you");
+      }
+
+      const settings = cam.track.getSettings();
+      console.log("[HOSTCAM] acquired via device service", {
+        video: s.getVideoTracks().length,
+        audio: s.getAudioTracks().length,
+        camera: cam.deviceId.slice(0, 8) + "…",
+        mic: mic ? mic.deviceId.slice(0, 8) + "…" : "NONE",
+        resolution: settings ? `${settings.width}x${settings.height}` : "unknown",
+      });
+
       onStream(s);
-      const vt = s.getVideoTracks()[0];
-      const settings = vt?.getSettings();
       if (settings) setActualRes(`${settings.width}×${settings.height}`);
       if (videoRef.current) { videoRef.current.srcObject = s; videoRef.current.muted = true; }
-      if (error && !error.includes("4K")) setError(null);
-    } catch (e: any) { setError(e.message); onStream(null); }
+      if (usedDefaultMic) setError("Selected microphone unavailable — using the system default");
+      else if (error && !error.includes("4K")) setError(null);
+    } catch (e: any) {
+      // Never leave a half-acquired device held on the failure path.
+      try { cam?.release(); } catch { /* ignore */ }
+      try { mic?.release(); } catch { /* ignore */ }
+      handlesRef.current = [];
+      streamRef.current = null;
+      console.error(`[HOSTCAM] FAILED to open the host camera/mic — the host will transmit NOTHING (acceptGuest falls back to recvonly transceivers): ${e?.name || "Error"}: ${e?.message || String(e)}`);
+      setError(e?.message || String(e));
+      onStream(null);
+    }
   }, [onStream, micDeviceId]); // eslint-disable-line
 
   useEffect(() => {
     if (!active) {
-      // Stop camera when navigating away
-      streamRef.current?.getTracks().forEach(t => t.stop());
-      streamRef.current = null;
+      // Navigating away releases our reference. The device closes only if nothing
+      // else — a stage source, another consumer — is still holding it.
+      releaseHandles();
       onStream(null);
       return;
     }
     start(resolution);
-    return () => { streamRef.current?.getTracks().forEach(t => t.stop()); };
+    return () => { releaseHandles(); };
   }, [resolution, active, micDeviceId]); // eslint-disable-line
 
   const ltPos = (i: number): React.CSSProperties => ({ position: "absolute", bottom: 48 + i * 56, left: 16 });
@@ -1913,6 +2078,7 @@ function EmbeddedStudio({
   isRecording, isStreaming, setIsStreaming, showGrid, setShowGrid,
   teleScript, setTeleScript, teleScrollRef, hostLevel, toggleRecord,
   guests, acceptGuest, denyGuest, removeGuest, toggleMute, guestsEnabled, setGuestsEnabled,
+  turnState,
   sessionToken, stationId, roomCode,
   micDeviceId, setMicDeviceId, outputDeviceId, setOutputDeviceId,
   selfMonitor, setSelfMonitor, micVolume, setMicVolume, monitorVolume, setMonitorVolume,
@@ -1928,6 +2094,7 @@ function EmbeddedStudio({
   hostLevel: number; toggleRecord: () => void;
   guests: GuestPeer[]; acceptGuest: (id: string) => void; denyGuest: (id: string) => void; removeGuest: (id: string) => void; toggleMute: (id: string) => void;
   guestsEnabled: boolean; setGuestsEnabled: (fn: (v: boolean) => boolean) => void;
+  turnState: { status: "waiting" | "ready" | "error"; error?: string };
   sessionToken: string; stationId: string; roomCode: string;
   micDeviceId: string;    setMicDeviceId:    (s: string) => void;
   outputDeviceId: string; setOutputDeviceId: (s: string) => void;
@@ -2053,11 +2220,27 @@ function EmbeddedStudio({
                 <EmailInviteForm inviteLink={inviteLink} stationId={stationId} roomCode={roomCode} />
               </div>
             )}
+            {/* Same relay-credential state as the main GUESTS panel — an Accept that
+                cannot build a connection must say so, not sit there looking live. */}
+            {guestsEnabled && turnState.status !== "ready" && (
+              <div style={{
+                margin: "0 0 8px", padding: "7px 10px", fontSize: 12, lineHeight: 1.4,
+                background: turnState.status === "error" ? "rgba(239,68,68,0.10)" : "rgba(148,163,184,0.10)",
+                border: `1px solid ${turnState.status === "error" ? RED : BOR}`,
+                color: turnState.status === "error" ? RED : TXT2,
+              }}>
+                {turnState.status === "error"
+                  ? `Connection relay unavailable — ${turnState.error || "guests cannot connect."}`
+                  : "Getting connection credentials…"}
+              </div>
+            )}
             {guests.filter(g => g.status === "pending").map(g => (
               <div key={g.id} style={{ padding: "10px 12px", marginBottom: 6, background: "rgba(167,139,250,0.08)", border: "1px solid rgba(167,139,250,0.3)" }}>
                 <div style={{ fontSize: 13, fontWeight: 700, color: "#a78bfa", marginBottom: 4 }}>"{g.name}" wants to join</div>
                 <div style={{ display: "flex", gap: 6 }}>
-                  <button onClick={() => acceptGuest(g.id)} style={{ flex: 1, padding: "6px", fontSize: 12, fontWeight: 700, background: "#22c55e", border: "none", color: "#000", cursor: "pointer" }}>Accept</button>
+                  <button onClick={() => acceptGuest(g.id)} disabled={turnState.status !== "ready"}
+                    title={turnState.status !== "ready" ? "Waiting for connection credentials" : undefined}
+                    style={{ flex: 1, padding: "6px", fontSize: 12, fontWeight: 700, background: turnState.status === "ready" ? "#22c55e" : BG3, border: "none", color: turnState.status === "ready" ? "#000" : TXT2, cursor: turnState.status === "ready" ? "pointer" : "not-allowed" }}>Accept</button>
                   <button onClick={() => denyGuest(g.id)} style={{ flex: 1, padding: "6px", fontSize: 12, fontWeight: 700, background: "transparent", border: `1px solid ${RED}`, color: RED, cursor: "pointer" }}>Deny</button>
                 </div>
               </div>
@@ -2252,7 +2435,7 @@ function SectionHeader({ open, title, onClick }: { open: boolean; title: string;
 // ─────────────────────────────────────────────────────────────
 
 function ShowPlusPanel({
-  guests, onMute, onRemove, onAccept, onDeny,
+  guests, onMute, onRemove, onAccept, onDeny, turnState,
   guestsEnabled, onToggleGuests, sessionToken, roomCode,
   script, setScript, mode, setMode, speed, setSpeed,
   opacity, setOpacity, fontSize, setFontSize, scrolling, setScrolling, scrollRef,
@@ -2263,6 +2446,7 @@ function ShowPlusPanel({
 }: {
   guests: GuestPeer[]; onMute: (id: string) => void; onRemove: (id: string) => void;
   onAccept: (id: string) => void; onDeny: (id: string) => void;
+  turnState: { status: "waiting" | "ready" | "error"; error?: string };
   guestsEnabled: boolean; onToggleGuests: () => void;
   sessionToken: string; roomCode: string;
   script: string; setScript: (v: string) => void;
@@ -2330,13 +2514,30 @@ function ShowPlusPanel({
               </>
             )}
           </div>
+          {/* Relay-credential state. Guests cannot connect without server-minted ICE
+              servers, so this says so plainly instead of letting Accept build a call
+              that will fail at "checking". */}
+          {guestsEnabled && turnState.status !== "ready" && (
+            <div style={{
+              margin: "0 8px 8px", padding: "6px 8px", fontSize: 11, lineHeight: 1.4,
+              background: turnState.status === "error" ? "rgba(239,68,68,0.10)" : "rgba(148,163,184,0.10)",
+              border: `1px solid ${turnState.status === "error" ? RED : BOR}`,
+              color: turnState.status === "error" ? RED : TXT2,
+            }}>
+              {turnState.status === "error"
+                ? `Connection relay unavailable — ${turnState.error || "guests cannot connect."}`
+                : "Getting connection credentials…"}
+            </div>
+          )}
           {pendingGuests.length > 0 && (
             <div style={{ padding: "0 8px 8px" }}>
               {pendingGuests.map(g => (
                 <div key={g.id} style={{ padding: "8px 10px", marginBottom: 4, background: "rgba(167,139,250,0.08)", border: "1px solid rgba(167,139,250,0.3)" }}>
                   <div style={{ fontSize: 12, fontWeight: 700, color: "#a78bfa", marginBottom: 5 }}>"{g.name}" wants to join</div>
                   <div style={{ display: "flex", gap: 5 }}>
-                    <button onClick={() => onAccept(g.id)} style={{ flex: 1, padding: "5px 8px", background: GRN, color: "#000", border: "none", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>Accept</button>
+                    <button onClick={() => onAccept(g.id)} disabled={turnState.status !== "ready"}
+                      title={turnState.status !== "ready" ? "Waiting for connection credentials" : undefined}
+                      style={{ flex: 1, padding: "5px 8px", background: turnState.status === "ready" ? GRN : BG3, color: turnState.status === "ready" ? "#000" : TXT2, border: "none", fontSize: 11, fontWeight: 700, cursor: turnState.status === "ready" ? "pointer" : "not-allowed" }}>Accept</button>
                     <button onClick={() => onDeny(g.id)} style={{ flex: 1, padding: "5px 8px", background: "transparent", color: TXT2, border: `1px solid ${BOR}`, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>Deny</button>
                   </div>
                 </div>
@@ -2505,7 +2706,7 @@ export default function ShowPlus({ embedded, active = true }: { embedded?: boole
   useEffect(() => { (window as any).ether.installConfigKv.upsertByKey('video_monitor_volume', String(monitorVolume)); }, [monitorVolume]);
 
   const hostLevel = useLevelMeter(hostStream);
-  const { guests, acceptGuest, denyGuest, removeGuest, toggleMute, sessionToken, roomCode } = useWebRTCGuests(guestsEnabled, hostStream);
+  const { guests, acceptGuest, denyGuest, removeGuest, toggleMute, sessionToken, roomCode, turnState } = useWebRTCGuests(guestsEnabled, hostStream);
   const { enabled: captionsEnabled, lines: captionLines, status: captionsStatus, toggle: toggleCaptions, micDevices, micDeviceId: captionsMicId, selectMic } = useCaptions(active);
 
   // Smart cut sources — host + accepted guests
@@ -2585,6 +2786,7 @@ export default function ShowPlus({ embedded, active = true }: { embedded?: boole
         hostLevel={hostLevel} toggleRecord={toggleRecord}
         guests={guests} acceptGuest={acceptGuest} denyGuest={denyGuest} removeGuest={removeGuest} toggleMute={toggleMute}
         guestsEnabled={guestsEnabled} setGuestsEnabled={setGuestsEnabled}
+        turnState={turnState}
         sessionToken={sessionToken} stationId="" roomCode={roomCode}
         micDeviceId={micDeviceId} setMicDeviceId={setMicDeviceId}
         outputDeviceId={outputDeviceId} setOutputDeviceId={setOutputDeviceId}
@@ -2663,6 +2865,7 @@ export default function ShowPlus({ embedded, active = true }: { embedded?: boole
               <DestinationsSection />
               <ShowPlusPanel
                 guests={guests} onMute={toggleMute} onRemove={removeGuest} onAccept={acceptGuest} onDeny={denyGuest}
+                turnState={turnState}
                 guestsEnabled={guestsEnabled} onToggleGuests={() => setGuestsEnabled(v => !v)}
                 sessionToken={sessionToken} roomCode={roomCode}
                 script={teleScript} setScript={setTeleScript}
diff --git a/src/components/VideoEngine/VideoEngineContext.tsx b/src/components/VideoEngine/VideoEngineContext.tsx
index 372c4eb..7128fac 100644
--- a/src/components/VideoEngine/VideoEngineContext.tsx
+++ b/src/components/VideoEngine/VideoEngineContext.tsx
@@ -14,6 +14,7 @@
 import React, {
   createContext, useCallback, useContext, useEffect, useRef, useState,
 } from "react";
+import { acquireCamera } from "./deviceService";
 
 const ether: any = (window as any).ether;
 
@@ -28,6 +29,10 @@ export interface VideoSource {
   height?:    number;
   thumbnailDataUrl?: string; // stable preview shown in sidebar
   externalId?: string;       // for dedupe — desktopCapturer id, deviceId, file path
+  /** Set for device-service-owned sources. Drops this source's reference; the
+   *  device closes only when the LAST consumer releases. Never stop() these tracks —
+   *  they are shared with the host path and any other stage tile. */
+  release?:   () => void;
 }
 
 export interface ChromaKey {
@@ -229,6 +234,11 @@ export function autoArrange(layers: SceneLayer[], sources: VideoSource[]): Scene
 }
 
 // ── Context value ──────────────────────────────────────────────────────────
+// The Phase-1 host-camera acquisition claim lived here. It was an ordering stopgap
+// for a collision that can no longer occur: the device service opens each camera at
+// most once and shares the handle, so there is nothing left to arbitrate. Deleted
+// with its guard in addCameraSource — see the build report for 2026-07-29.
+
 interface CtxValue {
   // Core data
   sources: VideoSource[];
@@ -486,35 +496,33 @@ export function VideoEngineProvider({ children }: { children: React.ReactNode })
 
   const addCameraSource = useCallback(async (deviceId: string, label: string) => {
     try {
-      // A physical camera is single-open on Windows. Guard BOTH cases before a second getUserMedia:
-      //  (1) explicit duplicate — same deviceId added twice via + Camera;
-      //  (2) already held by another source (typically the host camera, whose externalId is "host", NOT the
-      //      deviceId — so the (1) check alone misses it). A second getUserMedia on a held device throws
-      //      NotReadableError, surfaced as "Requested device not found". If it's already on stage, say so
-      //      instead of colliding. (Interim guard; the full device-acquisition service shares one handle —
-      //      see docs/showplus-device-layer-design-2026-07-27.md.)
-      let blockedMsg: string | null = null;
+      // The device service opens each physical camera AT MOST ONCE and hands the same
+      // track to every consumer, so a camera already held by the host is no longer a
+      // collision to refuse — it is a handle to share. The Phase-1 "already in use as
+      // the host camera" refusal and the 4.4.95 "already on stage as X" refusal both
+      // existed only to prevent a second getUserMedia; that second open cannot happen
+      // any more, so both are gone. See docs/showplus-device-layer-design-2026-07-27.md:76-81.
+      //
+      // The one check kept is list hygiene, not device arbitration: the same camera
+      // twice in the SOURCES list is two identical tiles, which helps nobody.
+      let dupe = false;
       setSources(prev => {
-        if (prev.some(s => s.externalId === deviceId)) {
-          blockedMsg = `Camera "${label}" is already in your sources.`;
-        } else {
-          const held = prev.find(s => s.stream && s.stream.getVideoTracks().some(t => t.getSettings().deviceId === deviceId));
-          if (held) blockedMsg = `Camera "${label}" is already on stage as "${held.label}".`;
-        }
+        if (prev.some(s => s.externalId === deviceId)) dupe = true;
         return prev;
       });
-      if (blockedMsg) { setErr(blockedMsg); return; }
-      const stream = await navigator.mediaDevices.getUserMedia({
-        audio: false,
-        video: { deviceId: { exact: deviceId }, width: 1280, height: 720, frameRate: 30 },
-      });
-      const track = stream.getVideoTracks()[0];
-      const settings = track.getSettings();
+      if (dupe) { setErr(`Camera "${label}" is already in your sources.`); return; }
+
+      const handle = await acquireCamera({ deviceId, width: 1280, height: 720, frameRate: 30, who: `stage:${label}` });
+      // Stage sources stay video-only, exactly as before — the mic belongs to the host
+      // path, not to a scene tile.
+      const stream = new MediaStream([handle.track]);
+      const settings = handle.track.getSettings();
       const id = `cam_${Date.now().toString(36)}`;
       setSources(prev => [...prev, {
         id, kind: "camera", label, stream,
         width: settings.width, height: settings.height,
-        externalId: deviceId,
+        externalId: handle.deviceId,
+        release: () => handle.release(),
       }]);
       setErr("");
     } catch (e: any) { setErr(`Camera failed: ${e?.message || e}`); }
@@ -535,7 +543,11 @@ export function VideoEngineProvider({ children }: { children: React.ReactNode })
   const removeSource = useCallback((id: string) => {
     setSources(prev => {
       const t = prev.find(s => s.id === id);
-      if (t?.stream) t.stream.getTracks().forEach(tr => tr.stop());
+      // Device-service sources are RELEASED, never stopped — the same track may be
+      // live on the host peer connection. Only sources we opened ourselves (screen /
+      // window capture) are stopped here.
+      if (t?.release) t.release();
+      else if (t?.stream) t.stream.getTracks().forEach(tr => tr.stop());
       if (t?.imageBitmap) t.imageBitmap.close();
       return prev.filter(s => s.id !== id);
     });
```

---

## NEW FILE (untracked): src/components/VideoEngine/deviceService.ts

```ts
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
```
