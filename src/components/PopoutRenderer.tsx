// PopoutRenderer.tsx — routes #popout/<panel> hash to the right component
// Loaded by src/main.tsx when window.location.hash starts with "#popout/"

import React, { useState, useEffect } from "react";
import PopoutShell from "./PopoutShell";
import ProcessorRack from "./ProcessorRack";
import ImagingPanel from "./ImagingPanel";
import { useProcessorParams } from "../hooks/useProcessorParams";
import FaderSection from "./FaderSection";
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
import { useAudioEngine } from "../audio/AudioEngineContext";
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
  const { stationId, isReady } = useActiveStation();
  const proc = useProcessorParams(stationId ?? null);
  // Which branch the CONTROLS are editing. Purely a view choice, so it lives here rather than in the
  // hook — the meters show both branches regardless.
  const [branch, setBranch] = React.useState<"local" | "stream">("local");

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
  return (
    <ProcessorRack
      branch={branch}
      onBranch={setBranch}
      split={proc.split}
      onSplit={proc.setSplit}
      params={proc.params}
      stored={proc.stored}
      onChange={proc.patch}
      presets={proc.presets}
      activePreset={proc.activePreset}
      onSelectPreset={(name) => proc.selectPreset(proc.split ? branch : "local", name)}
      onSavePreset={(name) => proc.savePreset(proc.split ? branch : "local", name)}
      bypass={proc.bypass}
      onBypass={proc.setBypass}
      meters={proc.meters}
      wouldRideDb={proc.wouldRideDb}
      sendError={proc.sendError}
      bypassPending={proc.bypassPending}
      streamBranchUnreported={proc.streamBranchUnreported}
    />
  );
}

// Library pop-out handlers — cue a track onto a deck via the shared engine (daemon-backed,
// so it affects the live air chain). Edit/send-to-studio aren't meaningful in a pop-out.
// THE BOARD in its own window. It resolves everything else itself — deck_configs, the ON lamp, the
// six source-channel writers, the jukebox cut — so all this has to supply is the live A/B/C deck
// state, which comes off the engine the same way the dashboard's does.
function PopoutFaders() {
  const eng = useAudioEngine();
  const [decks, setDecks] = React.useState<{ A: any; B: any; C: any }>({ A: null, B: null, C: null });
  React.useEffect(() => {
    const sync = () => setDecks({
      A: eng.getDeck("A")?.getState() ?? null,
      B: eng.getDeck("B")?.getState() ?? null,
      C: eng.getDeck("C")?.getState() ?? null,
    });
    sync();
    // The engine's own listener, not a poll: the dashboard reads the same stream, so the two windows
    // show the same decks on the same tick rather than drifting by up to a poll interval.
    const off = eng.on(sync);            // engine-rodio.ts:962 — returns its own unsubscribe
    // The engine only emits on CHANGE, and position advances without one, so the countdown and the
    // progress bar need a tick of their own. 250ms matches the engine's own poll.
    const id = setInterval(sync, 250);
    return () => { try { off(); } catch {} clearInterval(id); };
  }, [eng]);
  // masterCollapsed is a per-window VIEW preference and is deliberately not shared: this window is
  // usually narrower than the dashboard, and forcing them to agree would collapse the master meter
  // on a screen that has room for it.
  const [masterCollapsed, setMasterCollapsed] = React.useState(false);
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <FaderSection
        deckA={decks.A} deckB={decks.B} deckC={decks.C}
        masterCollapsed={masterCollapsed}
        onToggleMasterCollapsed={() => setMasterCollapsed(v => !v)}
      />
    </div>
  );
}

function PopoutLibrary() {
  // WAS `getEngine(stationId ?? 1)` — the one place that hand-worked around the missing provider,
  // and it still carried the `?? 1` guess. main.tsx mounts <AudioEngineProvider gate> over every
  // window now, so this reads the live station like the dashboard does, and a window with no
  // provider throws instead of quietly addressing station 1.
  const eng = useAudioEngine();
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
        // THESE WERE BOTH NO-OPS — controls that rendered and did nothing, in the window that is now
        // the ONLY Library. Send to Studio is genuinely fixable and is fixed: studio:push-track is a
        // real IPC and is exactly what the dashboard calls. Edit is NOT: the cue editor is a dashboard
        // PANEL, not a window, so there is nothing for this renderer to open. Rather than fake it,
        // onEdit is left off, and LibraryPanel now HIDES both cue items when it is absent.
        onSendToStudio={s => { try { (window as any).ether?.invoke("studio:push-track", { filePath: s.file_path, title: s.title, artist: s.artist_name || "", duration_ms: s.duration_ms }); } catch {} }}
      />
    </div>
  );
}

export default function PopoutRenderer({ panel }: { panel: string }) {
  const title = TITLES[panel] ?? panel;

  // JUKEBOX — the public jukebox. It is the ONE pop-out that does not wear PopoutShell: the shell adds
  // a 28px EtherCast titlebar, and this window faces an audience fullscreen. It also needs no station
  // prop — Jukebox resolves the active station itself and refuses to guess (see its header).
  if (panel === "jukebox") return <Jukebox />;

  let content: React.ReactNode;
  switch (panel) {
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
      content = <BoutiqueCartWall />;
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
      // Clicking a show used to navigate the DASHBOARD (setPanel + setSchedulerTab). In a window of
      // its own that is meaningless, so it opens the Shows window instead — the same treatment the
      // Schedule Manager's escape hatches already get.
      content = <BroadcastCalendar onShowClick={() => { try { (window as any).ether?.invoke("window:popout", "shows"); } catch {} }} />;
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
