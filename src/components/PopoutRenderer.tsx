// PopoutRenderer.tsx — routes #popout/<panel> hash to the right component
// Loaded by src/main.tsx when window.location.hash starts with "#popout/"

import React, { useState, useEffect } from "react";
import PopoutShell from "./PopoutShell";
import StandaloneDecksPanel from "./StandaloneDecksPanel";
import MasterOutput from "./MasterOutput";
import MicDeck from "./MicDeck";
import PhoneDesk from "./PhoneDesk";
import VoiceTracker from "./VoiceTracker";
import UpNext from "./UpNext";
import { HealthMonitor } from "./HealthMonitor";
import { BoutiqueCartWall } from "./DeckConfigurator";
import Scheduler from "./Scheduler";
import BroadcastCalendar from "./BroadcastCalendar";
import { LibraryPanel } from "../App";
import StudioPro from "./StudioPro";
import VideoStudio from "./ShowPlus";
import Jukebox from "./Jukebox";
// Panels the native menu can open as their own window when the click came from a pop-out
// (docs/native-menu-audit-2026-08-17.md §7). Each of these renders stand-alone — no props, or an
// onClose the window satisfies by closing itself.
import ProgramLog from "./ProgramLog";
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
import AudioRoutingScreen from "./AudioRoutingPanel";
import LibraryImport from "./LibraryImport";
import { PlanGate } from "../hooks/usePlan";
import { getEngine } from "../audio/engine-registry";
import { useActiveStation } from "../hooks/useActiveStation";

// ── StandaloneUpNext — wraps UpNext; syncs queue via broadcast relay ──
// The main window emits "ether:broadcast" { channel: "queue:sync", data: queueLen }
// on every queue change; this window receives it and refreshes.

function StandaloneUpNext() {
  const [queueLen, setQueueLen] = useState(0);
  const [rev, setRev] = useState(0);   // bump to force UpNext re-fetch

  useEffect(() => {
    const ether = (window as any).ether;
    if (!ether?.on) return;
    const h = ether.on("queue:sync", (len: number) => {
      setQueueLen(len);
      setRev(r => r + 1);
    });
    return () => ether.off("queue:sync", h);
  }, []);

  return <UpNext key={rev} queueLen={queueLen} onQueueChange={() => setRev(r => r + 1)} />;
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
  "calendar":  "Calendar",
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
  "multioutput":  "Audio Routing",
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
      stationId={stationId ?? 1}
    />
  );
}

// Library pop-out handlers — cue a track onto a deck via the shared engine (daemon-backed,
// so it affects the live air chain). Edit/send-to-studio aren't meaningful in a pop-out.
function PopoutLibrary() {
  const { stationId } = useActiveStation();
  const eng = getEngine(stationId ?? 1);
  const cue = (deck: "A" | "B" | "C", s: any) => {
    try { eng.deckCue?.(deck, { filePath: s.file_path, title: s.title, artist: s.artist_name || "", durationMs: s.duration_ms ?? 0 }); } catch { /* engine not ready */ }
  };
  // PopoutShell's content area is overflow:hidden; LibraryPanel is a plain flex-column with no
  // internal scroll (in the main app the surrounding page scrolls). Give the pop-out its own
  // vertical scroll so a library taller than the window is reachable.
  return (
    <div style={{ height: "100%", overflowY: "auto", overflowX: "hidden", padding: 16 }}>
      <LibraryPanel
        onLoadA={s => cue("A", s)} onLoadB={s => cue("B", s)} onLoadC={s => cue("C", s)}
        onQueue={s => { try { (eng as any).enqueue?.({ filePath: s.file_path, title: s.title, artist: s.artist_name || "", durationMs: s.duration_ms ?? 0 }); } catch {} }}
        onEdit={() => {}} onSendToStudio={() => {}}
      />
    </div>
  );
}

export default function PopoutRenderer({ panel }: { panel: string }) {
  const title = TITLES[panel] ?? panel;

  // JUKEBOX — the public kiosk. It is the ONE pop-out that does not wear PopoutShell: the shell adds
  // a 28px EtherCast titlebar, and this window faces an audience fullscreen. It also needs no station
  // prop — Jukebox resolves the active station itself and refuses to guess (see its header).
  if (panel === "jukebox") return <Jukebox />;

  let content: React.ReactNode;
  switch (panel) {
    case "decks":
      content = <StandaloneDecksPanel />;
      break;
    case "master":
      // The full master section (fader + EQ + meters) — the EQ pop-out the panel button opens.
      content = <MasterOutput expanded collapsed={false} onToggleCollapsed={() => {}} />;
      break;
    case "mic":
      content = <MicDeck />;
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
      content = <BoutiqueCartWall deckSlot="C" />;
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
    case "calendar":
      content = <BroadcastCalendar />;
      break;
    case "library":
      content = <PopoutLibrary />;
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
      content = <ProgramLog onClose={() => window.close()} />;
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
    case "multioutput":
      content = <PlanGate requires="pro" feature="Multi-Output Audio Routing"><AudioRoutingScreen /></PlanGate>;
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
