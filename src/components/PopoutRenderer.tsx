// PopoutRenderer.tsx — routes #popout/<panel> hash to the right component
// Loaded by src/main.tsx when window.location.hash starts with "#popout/"

import React, { useState, useEffect } from "react";
import PopoutShell from "./PopoutShell";
import Rack from "./rack/Rack";
import ImagingPanel from "./ImagingPanel";
import { FaderSectionLive } from "./FaderSection";
import MasterOutput from "./MasterOutput";
import MicStatusPanel from "./MicStatusPanel";
import PhoneDesk from "./PhoneDesk";
import VoiceTracker from "./VoiceTracker";
import UpNext from "./UpNext";
import { HealthMonitor } from "./HealthMonitor";
import { BoutiqueCartWall } from "./DeckConfigurator";
import Scheduler from "./Scheduler";
import LibraryWindow from "./LibraryWindow";
import ScreenSurface from "./ScreenSurface";
import StudioPro from "./StudioPro";
import VideoStudio from "./ShowPlus";
import Jukebox from "./Jukebox";
// Panels the native menu can open as their own window when the click came from a pop-out
// (docs/native-menu-audit-2026-08-17.md §7). Each of these renders stand-alone — no props, or an
// onClose the window satisfies by closing itself.
import ProgramLog from "./ProgramLog";
import GenerateProgressBar from "./GenerateProgressBar";
import Logs from "./Logs";
import RotationAnalytics from "./RotationAnalytics";
import Spots from "./Spots";
import Announcements from "./Announcements";
import EASLogbook from "./EASLogbook";
import ScheduleWorkspace from "./schedule/ScheduleWorkspace";
import StreamManager from "./StreamManager";
import SmartScheduler from "./SmartScheduler";
import ListenerAnalytics from "./ListenerAnalytics";
import CloudBackup from "./CloudBackup";
import PatchBay from "./PatchBay";
import LibraryImport from "./LibraryImport";
import { PlanGate } from "../hooks/usePlan";
import { useAudioEngine } from "../audio/AudioEngineContext";
import { useActiveStation } from "../hooks/useActiveStation";

// ── StandaloneUpNext — wraps UpNext; syncs queue via broadcast relay ──
// The main window emits "ether:broadcast" { channel: "queue:sync", data: queueLen }
// on every queue change; this window receives it and refreshes.

function StandaloneUpNext() {
  const [queueLen, setQueueLen] = useState(0);

  // NO REMOUNT (2026-10-12, docs/ui-freeze-diagnosis.md §1). This was <UpNext key={rev}>, bumped on every queue:sync —
  // which arrived on every deck event — so the whole panel was torn down and rebuilt about once a second, re-running its
  // six main-process loads each time. UpNext follows the queue itself (its engine mirror and ether:queue-changed); the
  // length is all this wrapper passes. queue:sync now carries { len, items } and is sent only when the queue changed.
  useEffect(() => {
    const ether = (window as any).ether;
    if (!ether?.on) return;
    const h = ether.on("queue:sync", (d: any) => {
      const n = typeof d === "number" ? d : Number(d?.len);
      if (Number.isFinite(n)) setQueueLen(n);
      try { window.dispatchEvent(new CustomEvent("ether:queue-changed")); } catch { /* no window */ }
    });
    return () => ether.off("queue:sync", h);
  }, []);

  return <UpNext queueLen={queueLen} onQueueChange={() => { try { window.dispatchEvent(new CustomEvent("ether:queue-changed")); } catch {} }} />;
}

// ── Router ───────────────────────────────────────────────────

const TITLES: Record<string, string> = {
  "decks":     "Decks",
  "mic":       "Mic",
  "master":    "Master Output",
  "upnext":    "Up Next",
  "phone":     "Phone Desk",
  "voicetrack":"Voice Tracker",
  "health":    "Station Health",
  "carts":     "Carts",
  "shows":     "Shows",
  "clocks":    "Clocks",
  "categories":"Categories",
  "library":   "Library",
  "studiopro": "Show+ DAW",
  "videostudio":"Show+",
  "jukebox":   "Jukebox",
  // Menu-openable panels (audit §7)
  "programlog":   "Program Log",
  "logs":         "Play Log",
  "rotation":     "Rotation Analytics",
  "spots":        "Spots & Promos",
  "announce":     "Announcements",
  "eas":          "EAS Logbook",
  "schedulehub":  "Schedule Manager",
  "streaming":    "Stream Manager",
  "smartschedule":"Smart Scheduler",
  "analytics":    "Listener Analytics",
  "cloudbackup":  "Cloud Log Backup",
  "multioutput":  "Patch Bay",
  "processor":    "Processor",
  "imaging":      "Imaging",
  "importlibrary":"Import Library",
};

// Show+ DAW in its own window — resolves the ACTIVE station (machine-global, via getActive) so
// chop-and-send targets the same station as the main window. It's an EDITOR window: no now-playing
// poster, no engine mirror — those live only in <App/> (the main window), never here.
function StudioProPopout() {
  const { stationId } = useActiveStation();
  return (
    <StudioPro
      deckAPath={null} deckATitle={undefined}
      deckBPath={null} deckBTitle={undefined}
      stationId={stationId}
    />
  );
}

// THE PROCESSOR RACK in its own window. It REFUSES TO GUESS A STATION: every control here changes what
// goes to air, and defaulting to station 1 would let an operator set one station's ceiling while
// listening to another. Until the active station resolves, this window says so and renders no controls.
// (Same rule the Jukebox pop-out follows — see its header.)
function ProcessorPopout() {
  const { stationId, stationUuid, isReady } = useActiveStation();

  if (!isReady || stationId == null) {
    return (
      <div style={{ padding: 24, color: "var(--text-tertiary)", fontSize: 13, lineHeight: 1.7 }}>
        Resolving the active station…
        <div style={{ fontSize: 11, marginTop: 8, opacity: 0.8 }}>
          The processor stays closed until it knows which station it is adjusting. These controls change
          what goes to air, and the wrong station is worse than no controls.
        </div>
      </div>
    );
  }
  // SLICE 4 — the Processor window IS the master rack (docs/dsp-rack-framework.md §2).
  return <Rack stationId={stationId} stationUuid={stationUuid} />;
}

// Library pop-out handlers — cue a track onto a deck via the shared engine (daemon-backed,
// so it affects the live air chain). Edit/send-to-studio aren't meaningful in a pop-out.
// THE BOARD in its own window. It resolves everything else itself — deck_configs, the ON lamp, the
// six source-channel writers, the jukebox cut — so all this has to supply is the live A/B/C deck
// state, which comes off the engine the same way the dashboard's does.
function PopoutFaders() {
  // The board reads its decks itself (FaderSectionLive: status + volume only). This used to poll the engine every 250 ms
  // and re-render the whole board each time, for a countdown the board does not show (docs/perf-pass-round2-2026-10-12.md §3).
  // masterCollapsed is a per-window VIEW preference and is deliberately not shared: this window is
  // usually narrower than the dashboard, and forcing them to agree would collapse the master meter
  // on a screen that has room for it.
  const [masterCollapsed, setMasterCollapsed] = React.useState(false);
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <FaderSectionLive
        masterCollapsed={masterCollapsed}
        onToggleMasterCollapsed={() => setMasterCollapsed(v => !v)}
      />
    </div>
  );
}


export default function PopoutRenderer({ panel }: { panel: string }) {
  const title = panel === "screen" || panel.startsWith("screen:") ? "Screen" : (TITLES[panel] ?? panel);

  // JUKEBOX — the public jukebox. It is the ONE pop-out that does not wear PopoutShell: the shell adds
  // a 28px EtherCast titlebar, and this window faces an audience fullscreen. It also needs no station
  // prop — Jukebox resolves the active station itself and refuses to guess (see its header).
  if (panel === "jukebox") return <Jukebox />;

  let content: React.ReactNode;
  // A saved screen's window is "screen:<layout uuid>" (one window per layout); every screen routes to the one case.
  switch (panel.startsWith("screen:") ? "screen" : panel) {
    case "decks":
      // THE SAME BOARD THE DASHBOARD RENDERS — not a monitor-mode copy of it.
      // This used to be StandaloneDecksPanel, a months-old widget that predated source channels and
      // drew "not available in monitor mode" over D/E/F. Deleted. FaderSection owns its own board
      // state, so it needs only the three rotation deck states, which this window subscribes to
      // itself. Jeff: "everything opens on its own window" — including the faders, in full.
      content = <PopoutFaders />;
      break;
    case "master":
      // The full master section (fader + EQ + meters) — the EQ pop-out the panel button opens.
      content = <MasterOutput expanded collapsed={false} onToggleCollapsed={() => {}} />;
      break;
    case "processor":
      content = <ProcessorPopout />;
      break;
    case "imaging":
      // Takes no props and resolves its own station — nothing of it lives in the dashboard's tree.
      content = <ImagingPanel />;
      break;
    case "mic":
      content = <MicStatusPanel />;   // the mic is an engine channel now — docs/dsp-mic-in-engine.md
      break;
    case "phone":
      content = <PhoneDesk onClose={() => window.close()} />;
      break;
    case "voicetrack":
      content = <VoiceTracker />;
      break;
    case "upnext":
      content = <StandaloneUpNext />;
      break;
    case "health":
      content = <HealthMonitor onClose={() => window.close()} />;
      break;
    case "carts":
      content = <BoutiqueCartWall variant="window" />;   // the Carts window: 2 × 3 big buttons, six blocks, scroll
      break;
    case "shows":
      content = <Scheduler defaultTab="shows" embedded />;
      break;
    case "clocks":
      content = <Scheduler defaultTab="clocks" embedded />;
      break;
    case "categories":
      content = <Scheduler defaultTab="categories" embedded />;
      break;
    case "screen":
      // THE SURFACE WINDOW (Screen Builder): a screen built from registered modules. src/components/ScreenSurface.tsx.
      content = <ScreenSurface layoutUuid={panel.startsWith("screen:") && !panel.startsWith("screen:new-") ? panel.slice("screen:".length) : null} />;
      break;
    case "library":
      content = <LibraryWindow />;   // the Library window: src/components/LibraryWindow.tsx
      break;
    case "studiopro":
      content = <StudioProPopout />;
      break;
    // Show+ (the video studio) in its own window — same pattern as every other
    // popout. ShowPlus brings its own VideoEngineProvider, so nothing extra is
    // needed here; `active` defaults to true, which is what opens the camera.
    case "videostudio":
      content = <VideoStudio />;
      break;

    // ── Panels the native menu opens as their own window when clicked from a pop-out ──
    // The dashboard is the board and must not be covered mid-event, so these stand alone here
    // instead of raising <App/>. onClose closes THIS window — in the dashboard the same components
    // return to the live panel, which has no meaning in a window of their own.
    case "programlog":
      // The progress bar rides along: it listens to schedule:generate-progress, which main sends to
      // ALL windows, so a Fill Day from this window shows its progress here too (slice 5).
      content = <><ProgramLog onClose={() => window.close()} /><GenerateProgressBar /></>;
      break;
    case "logs":
      content = <Logs />;
      break;
    case "rotation":
      content = <RotationAnalytics />;
      break;
    case "spots":
      content = <Spots />;
      break;
    case "announce":
      content = <Announcements />;
      break;
    case "eas":
      content = <EASLogbook onClose={() => window.close()} />;
      break;
    case "schedulehub":
      // The workspace's two escape hatches are dashboard navigation. In a window of its own the
      // analytics pane opens as its own pop-out rather than swapping this window's contents.
      content = (
        <ScheduleWorkspace
          onOpenAnalytics={() => { try { (window as any).ether.invoke("window:popout", "rotation"); } catch { /* not in electron */ } }}
          onUseFixedLayout={() => { /* fixed layout is a dashboard-only alternative */ }}
        />
      );
      break;
    case "streaming":
      content = <StreamManager />;
      break;
    case "smartschedule":
      content = <SmartScheduler onClose={() => window.close()} />;
      break;
    case "analytics":
      content = <PlanGate requires="pro" feature="Listener Analytics"><ListenerAnalytics onClose={() => window.close()} /></PlanGate>;
      break;
    case "cloudbackup":
      content = <PlanGate requires="pro" feature="Cloud Log Backup"><CloudBackup /></PlanGate>;
      break;
    // THE PATCH BAY (docs/ether-audio-patch-bay-plan.md step 1) — the one place outputs are patched. It REPLACES the old
    // Audio Routing window under the same key (no new page: src/modules/proof/noNewPage.test.ts). Not plan-gated: choosing
    // where Master plays is not a Pro feature.
    case "multioutput":
      content = <PatchBay />;
      break;
    case "importlibrary":
      content = <LibraryImport onClose={() => window.close()} />;
      break;
    default:
      content = (
        <div style={{ color: "#505060", padding: 32, fontSize: 13 }}>
          Unknown pop-out panel: <code style={{ color: "#6080a0" }}>{panel}</code>
        </div>
      );
  }

  return (
    <PopoutShell title={title}>
      {content}
    </PopoutShell>
  );
}
