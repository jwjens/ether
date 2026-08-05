import { bootSeq, bootMarkAuthComplete } from "./audio/boot-seq";
import UserLogin from "./components/UserLogin";
import KeyboardHelp from "./components/KeyboardHelp";
import TrialGate from "./components/TrialGate";
import LibrarySyncProgressBar from "./components/LibrarySyncProgressBar";
import CloudInstallPrompt from "./components/CloudInstallPrompt";
import { ETHER_BACKEND_URL } from "./lib/etherBackend";
import { pushInstallUsers } from "./lib/syncUsers";
import { pushCcTable, pushLibrary, applyDbMutation, addLibrarySong, pushPlayHistory, reconcileAccountStations, importStagedProgramming } from "./lib/ccData";
import etherMarkSvg from "./assets/ether-logo.svg";
import VideoStudio from "./components/ShowPlus";
import { UserContext, AppUser, useRole } from "./UserContext";
// Electron IPC bridge (replaces @tauri-apps imports)
const invoke = <T = any>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  (window as any).ether.invoke(cmd, args);
const emit = (event: string, payload?: unknown): Promise<void> =>
  Promise.resolve((window as any).ether.emit(event, payload));
const listen = (event: string, cb: (e: { payload: unknown }) => void): Promise<() => void> => {
  // ether.on returns the raw ipcRenderer handler; store it so off() removes exactly that listener
  const handler = (window as any).ether.on(event, (payload: unknown) => cb({ payload }));
  return Promise.resolve(() => (window as any).ether.off(event, handler));
};
const open = (opts?: { directory?: boolean; title?: string; multiple?: boolean }) =>
  opts?.directory ? (window as any).ether.dialog.openDirectory() : (window as any).ether.dialog.openFile(opts);
const readDir = (path: string) =>
  (window as any).ether.fs.readDir(path);
import React, { useState, useEffect, useRef, useLayoutEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { query, execute, queryOne, logPlay, searchSongs, dbHealthCheck } from "./db/client";
import { queryScoped } from "./db/stationScoped";
import { useActiveStation, getActiveStationIdSync } from "./hooks/useActiveStation";
import { useStreaming } from "./hooks/useStreaming";
import { DeckState, rotLog } from "./audio/engine-rodio";
import { fillQueueFromSchedule, refillFromSchedule, resetScheduleCursor, getFormatCategoryIds, getActiveShowClock } from "./audio/loggen";
import { readID3 } from "./audio/id3";
import { autoCueSong } from "./audio/songAnalysis";
import Waveform from "./components/Waveform";
import OnAirDeck from "./components/OnAirDeck";
import ClipEditor from "./components/ClipEditor";
import { useCaptions, CaptionsOverlay, CaptionsLogPanel } from "./components/Captions";
import DeckConfigurator, { useDeckConfig, PlaylistPlayer, BoutiqueCartWall, type DeckConfig } from "./components/DeckConfigurator";
import ProducerDesk, { InlineProducerDesk } from "./components/ProducerDesk";
import MasterOutput, { consoleLog } from "./components/MasterOutput";
import SmartScheduler from "./components/SmartScheduler";
import BroadcastCalendar from "./components/BroadcastCalendar";
import ImportDialog from "./components/ImportDialog";
import NexGenImport from "./components/NexGenImport";
import SettingsPanel from "./components/SettingsPanel";
import JinglesPanel from "./components/JinglesPanel";
import { StreamStatusProvider } from "./contexts/StreamStatusContext";
import { AudioEngineProvider, useAudioEngine } from "./audio/AudioEngineContext";
import { getEngine, getAllEngines } from "./audio/engine-registry";
import { resolveCommandTarget, isStationScopedCommand, commandTargetsThisMachine } from "./audio/cmd-routing";
import { computeDeckRole } from "./lib/deckRole";
import GlobalOnAirBadge from "./components/GlobalOnAirBadge";
import EtherLogo from "./components/EtherLogo";
import StreamStatusToast from "./components/StreamStatusToast";
import DMCANotice from "./components/DMCANotice";
import JockStrip from "./components/JockStrip";
import UpNext from "./components/UpNext";
import InlineNameEditor from "./components/InlineNameEditor";
import Scheduler from "./components/Scheduler";
import ProgramLog from "./components/ProgramLog";
import PlayLog from "./components/PlayLog";
import Logs from "./components/Logs";
import EASLogbook from "./components/EASLogbook";
import PDPicks from "./components/PDPicks";
import SchedulePreview from "./components/SchedulePreview";
import SchedulerReasons from "./components/SchedulerReasons";
import VoiceTrackInbox from "./components/VoiceTrackInbox";
import ActiveStationBadge from "./components/ActiveStationBadge";
import GSelectorImport from "./components/GSelectorImport";
import HelpPanel from "./components/HelpPanel";
import NowPlaying from "./components/NowPlaying";
import Jukebox from "./components/Jukebox";
import { openNowPlayingWindow } from "./components/NowPlayingWindow";
import NowPlayingStationPicker from "./components/NowPlayingStationPicker";
import Spots from "./components/Spots";
import MacrosPanel, { useMacroHotkeys, useMacroClock } from "./components/MacroEngine";
import MidiSettingsPanel, { MidiProvider } from "./components/MidiEngine";
import ConsoleStrip from "./components/ConsoleStrip";
import MicChannel from "./components/MicChannel";
import RulesEditor from "./components/RulesEditor";
import ProcessingPanel from "./components/ProcessingPanel";
import NowPlayingSettings from "./components/NowPlayingSettings";
import StreamManager from "./components/StreamManager";
import AudioDevices from "./components/AudioDevices";
import VoiceTracker from "./components/VoiceTracker";
import ShowPrep from "./components/ShowPrep";
import Announcements, { startAnnouncementEngine } from "./components/Announcements";
import OnboardingFlow from "./components/OnboardingFlow";
import type { VenueProfile } from "./components/FirstRunWizard";
import SplashScreen from "./components/SplashScreen";
import OnShiftScreen from "./components/OnShiftScreen";
import LibraryImport from "./components/LibraryImport";
import SpotifyImport from "./components/SpotifyImport";
import { useLibraryBorrowed } from "./hooks/useLibraryBorrowed";
import LibraryColumnsPanel from "./components/LibraryColumnsPanel";
import BulkAssignModal from "./components/BulkAssignModal";
import { ALL_LIB_COLS, LIB_COL_LABELS, LIB_COL_DEFAULT_WIDTHS, HIDDEN_BUILTIN_COL_NAMES, type LibCol, type LibraryColumn, type MetadataColumn, type MetadataDefinition, type MetadataVocabulary } from "./types/metadata";
import { useCanvasEngine } from "./canvas/CanvasEngine";
import AutoCue from "./components/AutoCue";
import { useUpdater, UpdateBanner } from "./components/Updater";
import { EtherErrorBoundary, SessionRestoreToast, HealthMonitor, HealthStatusDot } from "./components/HealthMonitor";
import WidgetCanvas from "./canvas/WidgetCanvas";
import MicDeck from "./components/MicDeck";
import TrackEditor from "./components/TrackEditor";
import AboutPanel from "./components/AboutPanel";
import ListenerAnalytics from "./components/ListenerAnalytics";
import CloudBackup from "./components/CloudBackup";
import AudioRoutingScreen from "./components/AudioRoutingPanel";
import StationManager from "./components/StationManager";
import ManageDevices from "./components/ManageDevices";
import { usePlan, setPlanGlobally, resolveEffectivePlan, requirePlan, PlanGate } from "./hooks/usePlan";
import PhoneDesk from "./components/PhoneDesk";
import SubscriptionPanel, { PlanTier } from "./components/SubscriptionPanel";
import { useSkin, SkinPickerOverlay, setTierForAccent } from "./components/SkinPicker";
import BroadcastEditor from "./components/BroadcastEditor";
import StudioEditor from "./components/StudioEditor";
import OnboardingTour, { useTour } from "./components/OnboardingTour";
import VUMeter from "./components/VUMeter";
import IrisBadge from "./components/IrisBadge";
import { SchedulerHealthHost } from "./components/SchedulerHealthPanel";

type Panel = "live" | "library" | "clocks" | "logs" | "spots" | "voicetrack" | "announce" | "streaming" | "settings" | "showprep" | "trackedit" | "subscription" | "autocue" | "health" | "cartwall" | "playlist" | "smartschedule" | "programlog" | "schedulebuilder" | "studio" | "broadcasteditor" | "phonedesk" | "analytics" | "cloudbackup" | "multioutput" | "stationmanager" | "managedevices" | "videostudio" | "importlibrary" | "spotifyimport" | "calendar" | "macros" | "midi" | "clipeditor" | "captions" | "eas" | "pdpicks" | "schedpreview" | "reasons" | "vtinbox" | "gselector" | "help";

interface SongRow {
  id: number; title: string; file_path: string | null;
  artist_name: string | null; album_title: string | null; album_year?: number | null;
  genre: string | null; duration_ms: number;
  category_code: string | null; category_color: string | null;
  intro_end?: number | null; outro_start?: number | null; bpm?: number | null;
  gain_db?: number | null; play_count?: number | null;
  cart_id?: string | null;
  content_class?: string | null;   // jingles design 1b — MUSIC/JIN/SPOT (teal treatment on JIN)
}

const EXTS = [".mp3",".flac",".ogg",".wav",".m4a",".aac",".wma",".aiff"];
function isAudio(n: string) { return EXTS.some(e => n.toLowerCase().endsWith(e)); }
function titleFromFile(p: string) { return (p.split(/[\\/]/).pop() || p).replace(/\.[^.]+$/, "").replace(/[_-]/g, " ").replace(/^\d+\.?\s*/, ""); }
function fmtExt(p: string) { return (p.split(".").pop() || "").toLowerCase(); }

// ── Toolbar button — defined at module level so React never remounts it ──
function ToolbarBtn({ label, active, onClick, color }: { label: string; active: boolean; onClick: () => void; color: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        height: 32, padding: "0 14px", borderRadius: 0,
        fontSize: 12, fontWeight: 700, letterSpacing: "0.08em",
        cursor: "pointer", fontFamily: "'Inter', sans-serif",
        transition: "all 0.15s ease",
        background: active ? `${color}18` : "transparent",
        color: active ? color : "var(--text-tertiary)",
        border: active ? `1px solid ${color}60` : "1px solid var(--border-primary)",
        boxShadow: active ? `0 0 8px ${color}30` : "none",
      }}
    >{label}</button>
  );
}

function ToolbarSep() {
  return <div style={{ width: 1, height: 20, background: "var(--border-primary)", margin: "0 2px" }} />;
}

// ── SVG icons for Nav items ──────────────────────────────────
const NAV_ICONS: Record<string, JSX.Element> = {
  live:         <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>,
  library:      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>,
  clocks:       <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  logs:         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg>,
  spots:        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 11l19-9-9 19-2-8-8-2z"/></svg>,
  voicetrack:   <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 2a3 3 0 0 0-3 3v4a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10c0 3.866-3.134 7-7 7s-7-3.134-7-7"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="8" y1="21" x2="16" y2="21"/></svg>,
  showprep:     <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>,
  announce:     <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1" fill="currentColor" stroke="none"/></svg>,
  streaming:    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>,
  trackedit:    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="14 2 14 8 20 8"/><path d="M20 12V8l-6-6H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h6"/><line x1="10" y1="15" x2="20" y2="5"/><line x1="17" y1="2" x2="22" y2="7"/></svg>,
  subscription: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>,
  settings:     <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  keyboard:     <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/></svg>,
};

// ── Session name bar — editable layout name in header ─────────
function SessionNameBar({ name, onChange, onSave, layouts, onLoadLayout, onDeleteLayout }: {
  name: string;
  onChange: (name: string) => void;
  onSave: (name: string) => Promise<void>;
  layouts: any[];
  onLoadLayout: (id: string) => void;
  onDeleteLayout?: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [showList, setShowList] = useState(false);
  const [saved, setSaved] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  useEffect(() => { setDraft(name); }, [name]);

  const commit = async () => {
    const trimmed = draft.trim() || "Live Assist";
    setDraft(trimmed);
    onChange(trimmed);
    setEditing(false);
  };

  const handleSave = async () => {
    await onSave(draft.trim() || "Live Assist");
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 14, position: "relative" as const }}>
      <div style={{ width: 1, height: 20, background: "var(--border-primary)" }} />
      {editing ? (
        <input
          ref={inputRef}
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === "Enter") { commit(); } if (e.key === "Escape") { setDraft(name); setEditing(false); } }}
          style={{
            fontSize: 12, fontWeight: 600,
            background: "var(--bg-tertiary)",
            border: "1px solid var(--accent-cyan)",
            borderRadius: 0, padding: "3px 9px",
            color: "var(--text-primary)", outline: "none",
            width: 160,
          }}
        />
      ) : (
        <button
          onClick={() => { setEditing(true); setShowList(false); }}
          style={{
            fontSize: 12, fontWeight: 600,
            background: "none", border: "none",
            color: "var(--text-secondary)", cursor: "text",
            padding: "3px 6px", borderRadius: 0,
            letterSpacing: "-0.01em",
            transition: "all 0.15s",
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLElement).style.background = "var(--bg-tertiary)";
            (e.currentTarget as HTMLElement).style.color = "var(--text-primary)";
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLElement).style.background = "none";
            (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)";
          }}
          title="Click to rename this layout"
        >{name}</button>
      )}

      {/* Save button */}
      {!editing && (
        <button
          onClick={handleSave}
          style={{
            fontSize: 13, fontWeight: 700, letterSpacing: "0.08em",
            padding: "3px 8px", borderRadius: 0,
            background: saved ? "var(--accent-green)" : "var(--bg-tertiary)",
            border: `1px solid ${saved ? "var(--accent-green)" : "var(--border-primary)"}`,
            color: saved ? "#000" : "var(--text-tertiary)",
            cursor: "pointer", transition: "all 0.2s",
          }}
          title="Save current layout"
        >{saved ? "✓ Saved" : "Save"}</button>
      )}

      {/* Layout switcher */}
      {layouts.length > 0 && !editing && (
        <button
          onClick={() => setShowList(p => !p)}
          style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 12, padding: "2px 4px", borderRadius: 0 }}
          title="Switch layout"
        >▾</button>
      )}

      {showList && (
        <>
          <div onClick={() => setShowList(false)} style={{ position: "fixed" as const, inset: 0, zIndex: 998 }} />
          <div style={{
            position: "absolute" as const, top: "calc(100% + 6px)", left: 0, zIndex: 999,
            background: "var(--bg-secondary)", border: "1px solid var(--border-secondary)",
            borderRadius: 0, padding: 8, minWidth: 240,
            boxShadow: "0 8px 32px rgba(0,0,0,0.25)",
            fontFamily: "'Inter', sans-serif",
          }}>
            <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.14em", color: "var(--text-tertiary)", padding: "2px 8px 8px", textTransform: "uppercase" as const }}>Saved Layouts</div>
            {layouts.map((l: any) => (
              <div key={l.id}>
                {renamingId === l.id ? (
                  <div style={{ display: "flex", gap: 6, padding: "4px 6px" }}>
                    <input
                      autoFocus
                      value={renameDraft}
                      onChange={e => setRenameDraft(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter") {
                          onChange(renameDraft);
                          onSave(renameDraft);
                          setRenamingId(null);
                        }
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      style={{ flex: 1, fontSize: 12, padding: "4px 8px", borderRadius: 0, border: "1px solid var(--accent-cyan)", background: "var(--bg-tertiary)", color: "var(--text-primary)", outline: "none" }}
                    />
                    <button onClick={() => setRenamingId(null)} style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 12 }}>✕</button>
                  </div>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: 4, borderRadius: 0, background: l.name === name ? "rgb(from var(--accent-blue) r g b / 0.1)" : "none" }}>
                    <button
                      onClick={() => { onLoadLayout(l.id); setShowList(false); }}
                      style={{
                        flex: 1, textAlign: "left" as const, padding: "8px 10px",
                        background: "none", border: "none",
                        color: l.name === name ? "var(--accent-cyan)" : "var(--text-primary)",
                        fontSize: 12, fontWeight: l.name === name ? 700 : 400, cursor: "pointer",
                      }}
                    >
                      {l.name}
                      {l.name === name && <span style={{ fontSize: 13, opacity: 0.5, marginLeft: 6 }}>active</span>}
                    </button>
                    {/* Rename */}
                    <button
                      title="Rename"
                      onClick={e => { e.stopPropagation(); setRenamingId(l.id); setRenameDraft(l.name); }}
                      style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", padding: "4px 6px", borderRadius: 0, fontSize: 13, opacity: 0.6 }}
                      onMouseEnter={e => (e.currentTarget as HTMLElement).style.opacity = "1"}
                      onMouseLeave={e => (e.currentTarget as HTMLElement).style.opacity = "0.6"}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                    {/* Delete — only for non-active layouts */}
                    {l.name !== name && onDeleteLayout && (
                      <button
                        title="Delete layout"
                        onClick={e => {
                          e.stopPropagation();
                          if (confirm(`Delete layout "${l.name}"?`)) {
                            onDeleteLayout(l.id);
                          }
                        }}
                        style={{ background: "none", border: "none", color: "var(--accent-red)", cursor: "pointer", padding: "4px 6px", borderRadius: 0, fontSize: 13, opacity: 0.5, marginRight: 2 }}
                        onMouseEnter={e => (e.currentTarget as HTMLElement).style.opacity = "1"}
                        onMouseLeave={e => (e.currentTarget as HTMLElement).style.opacity = "0.5"}
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Responsive viewport hook (header collapse + panel auto-collapse) ─────
// Reports current window width and named breakpoints so consumers can
// declaratively hide/collapse UI without each component owning its own
// resize listener.
function useViewport() {
  const [w, setW] = useState(typeof window !== "undefined" ? window.innerWidth : 1920);
  useEffect(() => {
    const onResize = () => setW(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // Search bar shrinks: 520 → 420 → 320 → 220 → 140 → icon-only
  // Clock: 52pt → 40 → 32 → 24 → 18 (never hidden — always visible)
  // Breakpoints triggered earlier so the absolute-centered clock never
  // overlaps the search bar or right-side buttons at narrower window widths.
  let searchW = 520;
  if (w < 1500) searchW = 440;
  if (w < 1350) searchW = 340;
  if (w < 1200) searchW = 260;
  if (w < 1100) searchW = 0; // icon-only — frees the left zone so the clock can stay big on tablets
  let clockSize: "full" | "lg" | "md" | "sm" | "xs" | "hidden" = "full";
  if (w < 1500) clockSize = "lg";
  if (w < 1350) clockSize = "md";
  if (w < 1100) clockSize = "lg"; // search is icon-only now → clock reclaims the space and grows back
  if (w < 800)  clockSize = "md";
  // never "hidden" — always show at least a tiny clock so the header
  // doesn't look empty/unfinished at the narrowest window sizes.
  return {
    width: w,
    isTablet:   w >= 768 && w < 1024, // 768–1023px: tablet portrait/landscape
    veryNarrow: w < 900,   // hide WARN text, Go Live → ▶ icon, search icon-only
    narrow:     w < 1050,  // collapse Admin to icon-only
    medium:     w < 1200,  // collapse Pro to icon-only
    panelTight: w < 1350,  // master panel auto-collapses
    bottomCollapsed: w < 1100, // bottom toolbar view-tabs collapse into a hamburger menu
    searchW,               // dynamic search bar width (0 = icon-only)
    clockSize,             // "full" | "lg" | "md" | "sm" | "hidden"
  };
}

// ── Swipe gesture hook ────────────────────────────────────────────────────────
// Detects intentional horizontal pointer swipes on a container.
// Ignores gestures that start on interactive children (buttons, inputs, etc.)
// and gestures that are more vertical than horizontal (scroll protection).
function useSwipe(onSwipe: (dir: 'left' | 'right') => void) {
  const start = useRef<{ x: number; y: number; t: number } | null>(null);
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if ((e.target as Element).closest('button, input, a, select, [role="button"], [data-swipe-ignore]')) return;
    start.current = { x: e.clientX, y: e.clientY, t: Date.now() };
  }, []);
  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!start.current) return;
    const dx = e.clientX - start.current.x;
    const dy = e.clientY - start.current.y;
    const dt = Date.now() - start.current.t;
    start.current = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 500)
      onSwipe(dx < 0 ? 'left' : 'right');
  }, [onSwipe]);
  return { onPointerDown, onPointerUp };
}

// Build the now-playing payload from LIVE engine state (decks + queue) at call
// time — never from React snapshots. React deck state is only sampled at
// title-change moments, so reading it could publish a stale "handoff gap" value
// (playing=false / title=null) even while audio is playing. engine.getDeck().getState()
// is the same source the [ROT] logs read, so it reflects what's actually on air.
// The queue is sliced from index 0 — the FULL upcoming order. queue[0]/[1] are the
// songs already cued onto the standby decks (the genuine next 1–2 tracks; the
// engine dequeues the now-playing song, so it's never in the queue). The in-app
// Next Up panel slices from index 2 because it shows those two on the deck strips,
// but the listener page has no deck strips and must include them.
// Resolve an on-air file's content class (MUSIC | JIN | SWP | SPOT) for the now-playing payload. Cached by
// filePath so the ~3s heartbeat never re-queries a stable on-air file (the 2026-07-22 main-loop-freeze
// precedent). Imaging/commercials (JIN/SWP/SPOT) must NOT get a music-store artwork lookup — the listener
// falls back to the hub/station logo. Songs carry content_class; a spot file (not a song) resolves to SPOT.
const _contentClassCache = new Map<string, string>();
async function resolveContentClass(filePath: string | null): Promise<string> {
  if (!filePath) return "MUSIC";
  const cached = _contentClassCache.get(filePath);
  if (cached) return cached;
  let cc = "MUSIC";
  try {
    const row = await queryOne<{ content_class: string | null }>("SELECT content_class FROM songs WHERE file_path = ? AND deleted_at IS NULL LIMIT 1", [filePath]);
    if (row && row.content_class) cc = row.content_class;
    else {
      const sp = await queryOne<{ n: number }>("SELECT 1 AS n FROM spots WHERE file_path = ? LIMIT 1", [filePath]);
      if (sp) cc = "SPOT";
    }
  } catch { /* default MUSIC */ }
  _contentClassCache.set(filePath, cc);
  return cc;
}

function buildNowPlayingPayload(
  engine: ReturnType<typeof getEngine>,
  stationName: string,
  stationUuid: string,
  // Slice 2: source-machine attribution + last error for the active station. machineId = this install's
  // id; live = whether THIS machine's stream is on air (only the live source claims the mount).
  source?: { machineId: string | null; live: boolean; lastError: string | null; lastErrorAt: number | null },
) {
  const sA = engine.getDeck("A")?.getState?.() ?? null;
  const sB = engine.getDeck("B")?.getState?.() ?? null;
  const sC = engine.getDeck("C")?.getState?.() ?? null;
  const live = [
    { deck: "A", state: sA },
    { deck: "B", state: sB },
    { deck: "C", state: sC },
  ].find(d => d.state?.status === "playing");
  const mkDeck = (s: DeckState | null) =>
    s ? { title: s.title, artist: s.artist, status: s.status, positionSec: s.positionSec, durationSec: s.durationSec } : null;
  return {
    playing:      !!live,
    title:        live?.state?.title  || null,
    artist:       live?.state?.artist || null,
    position:     live?.state?.positionSec || 0,
    duration:     live?.state?.durationSec || 0,
    deck:         live?.deck || null,
    filePath:     live?.state?.filePath || null, // on-air file → embedded-art lookup (not stored)
    art_url:      null as string | null,         // resolved from embedded cover art before POST (MUSIC only)
    content_class: null as string | null,        // MUSIC|JIN|SWP|SPOT — resolved before POST; imaging gets no music-store art
    station_name: stationName,
    station_uuid: stationUuid || null,   // backend keys per-station now-playing on this
    // Honest engine-state truth layer (Slice 1): live | stalled | off, straight from the engine
    // (daemon-authoritative). The backend derives the operator-facing live/stalled/off/offline from
    // this + heartbeat freshness — a stalled/silent station can never read "live".
    engine_state: engine.engineState(),
    // Slice 2: source-machine attribution + last error. source_machine_id is set ONLY when this machine
    // is the live source of this station's mount (one source per mount); last_error is the most recent
    // stream error for the station + when (ISO; sent stickily so the backend keeps the last failure).
    source_machine_id: source && source.live && source.machineId ? source.machineId : null,
    last_error:        source?.lastError ?? null,
    last_error_at:     (source?.lastError && source?.lastErrorAt) ? new Date(source.lastErrorAt).toISOString() : null,
    decks: { A: mkDeck(sA), B: mkDeck(sB), C: mkDeck(sC) },
    // Full upcoming order incl. the two cued standby-deck songs (queue[0]/[1]).
    queue: engine.getQueue().slice(0, 12).map(q => ({ title: q.title, artist: q.artist, duration: (q as any).durationMs || 0 })),
  };
}

// AUTO (automation) is PER-STATION — each station remembers its own automation state so switching
// the viewed station never carries one station's AUTO (or its on-air playout) onto another. Keyed
// by station id; the legacy single key `ether_autoAdv` migrates to the primary station (OV, id 1).
function readAutoAdv(stationId: number): boolean {
  try {
    const v = localStorage.getItem(`ether_autoAdv_${stationId}`);
    if (v !== null) return v === "1";
    if (stationId === 1) return localStorage.getItem("ether_autoAdv") === "1"; // migrate legacy → primary
    return false;
  } catch { return false; }
}
function writeAutoAdv(stationId: number, on: boolean): void {
  try { localStorage.setItem(`ether_autoAdv_${stationId}`, on ? "1" : "0"); } catch {}
}

export default function App() {
  const { stationId, stationUuid, isReady: stationReady } = useActiveStation();
  // IMPORTANT: App() renders <AudioEngineProvider> in its JSX return, so App()
  // sits ABOVE the context boundary. useAudioEngine() here would always read the
  // default context value (station 1). getEngine(stationId) bypasses context and
  // returns the correct engine directly — re-evaluated on every render, so it
  // tracks station switches via useActiveStation(). Child components rendered
  // inside <AudioEngineProvider> (ConsoleStrip, UpNext, ThreeSlotBar, etc.) use
  // useAudioEngine() normally. CartWallPanel, PlaylistPanel, LivePanel,
  // LibraryPanel are top-level functions in this file (NOT inside App()) — they
  // still reference the module-level singleton and are migrated in Commit 6.
  // Do not remove the module-level `engine` import until Commit 6 clears them.
  const engine = getEngine(stationId);
  const viewport = useViewport();
  const [bottomMenuOpen, setBottomMenuOpen] = useState(false);
  const [irisOpen, setIrisOpen] = useState(false);   // Iris chat panel — toggled by the bottom-bar IRIS button (2026-07-22)
  const [clearMenuOpen, setClearMenuOpen] = useState(false);   // CLEAR two-verb popover (Log-Reader Flip §3.2)
  // Macro automation: listen for hotkey-triggered macros + clock-based triggers
  useMacroHotkeys();
  useMacroClock(stationId);
  const [splashDone, setSplashDone] = useState(false);
  const [wizardDone, setWizardDone] = useState(false);
  // SESSION sign-in flag — resets on every app launch. Ether always opens on the sign-in/create-account
  // screen and stays "signed out" until you sign in THIS session, so it can never drop you into a
  // previous account's profile picker. Flipped true by handleWizardComplete (onboarding/sign-in done).
  const [accountSignedIn, setAccountSignedIn] = useState(false);
  // DURABLE signed-in marker: account_jwt present in install_config_kv. Unlike accountSignedIn (which
  // resets every launch and only flips via on-air/resume/sign-in), this persists across launches and
  // survives a cloud-restored install — so the account/tier reconcile fires on a restored install too,
  // not just after a fresh sign-in this session. Loaded once in the init effect below.
  const [hasAccountJwt, setHasAccountJwt] = useState(false);
  // True when a live Icecast stream was active at launch (crash / reboot / watchdog recovery): the
  // gate then SKIPS sign-in so the broadcast resumes unattended. null = not yet checked.
  const [wasOnAir, setWasOnAir] = useState<boolean | null>(null);
  // Sign in / sign up is required for everyone before the profile screen. Tracked separately from
  // wizardDone (first_run_complete) because a carried-over / invite / restored install can have
  // first_run_complete=1 without anyone ever signing into an account — those must still see auth.
  const [accountJoined, setAccountJoined] = useState(false);
  // True when the install is actually operating — at least one station WITH programming
  // (a music library or scheduled shows). Drives the sign-in gate: an empty/leftover
  // install (e.g. a stale first_run_complete=1 that survived an uninstall, or a restored
  // DB with no account) must still be forced to sign in. A real working station never is.
  const [installOperating, setInstallOperating] = useState(true);
  const [firstRunChecked, setFirstRunChecked] = useState(false);
  const [stationName, setStationName] = useState("Ether");
  const [switchToast, setSwitchToast] = useState("");
  // Slice B: A/B/C deck-load status/refusal message (never silent). Loading… on success clears; a
  // failure ("unavailable, needs re-import") sticks briefly.
  const [deckLoadMsg, setDeckLoadMsg] = useState<{ text: string; err: boolean } | null>(null);
  // Video live indicator — updated via custom event from VideoEngineContext
  const [videoLive, setVideoLive] = useState(false);
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail as { streaming: boolean; recording: boolean };
      setVideoLive(d.streaming || d.recording);
    };
    window.addEventListener("ether:video-status", handler);
    return () => window.removeEventListener("ether:video-status", handler);
  }, []);
  const [currentUser, setCurrentUser] = useState<AppUser | null>(null);
  const [currentPlan, setCurrentPlan] = useState<PlanTier>("free");
  // Keep App's plan reactive to the live plan cache (license activation AND the dev tier
  // override), so the header/menu reflect tier changes immediately — not just on reload.
  const { plan: livePlan } = usePlan();
  useEffect(() => { setCurrentPlan(livePlan); setTierForAccent(livePlan); }, [livePlan]);
  const [panel, setPanel] = useState<Panel>("live");
  const [schedulerTab, setSchedulerTab] = useState<"shows" | "categories" | "clocks">("shows");
  const apiKeyRef = useRef<string>("");
  // Slice 4: the CURRENT active station id (the SSE command handler reads this, not its captured stationId).
  const activeStationIdRef = useRef<number>((() => { const id = getActiveStationIdSync();
    bootSeq(`STATION ADOPTED station=${id} ← useRef(getActiveStationIdSync()) at first render`);
    return id; })());
  const panelRef = useRef<Panel>("live");
  useEffect(() => {
    panelRef.current = panel;
    if (panel === "library") window.dispatchEvent(new Event("ether:tour-library-opened"));
  }, [panel]);
  const { goLive, stopLive } = useStreaming();
  const prevDeckStatus = useRef<Record<string, string>>({}); // track status transitions for console logging
  const lastLoggedStatus = useRef<Record<string, string>>({});
  const durQueried = useRef(new Set<string>());
  const deckConfigsRef   = useRef<DeckConfig[]>([]);
  const prevQueueLen = useRef(-1); // track queue length changes for console logging
  // Slice 2: source-machine attribution + last error. This machine's id (= client_identity.client_id),
  // and per-station stream live/last-error from the existing stream:status events (keyed by stationId).
  const machineIdRef = useRef<string | null>(null);
  const streamStatusRef = useRef<Map<number, { live: boolean; lastError: string | null; lastErrorAt: number | null }>>(new Map());
  const [restoreInfo, setRestoreInfo] = useState<{ title: string | null; position: number; queueLen: number; savedAt: number } | null>(null);
  const [deckA, setDeckA] = useState<DeckState | null>(null);
  const [deckB, setDeckB] = useState<DeckState | null>(null);
  const [deckC, setDeckC] = useState<DeckState | null>(null);
  // JINGLES overlay v1: live overlay state for the ACTIVE station, from the daemon (observed, not claimed).
  // { deck: the deck whose seam the jingle bridges, state: 'SCHEDULED'|'ARMED'|'FIRING', title }. null when idle.
  const [jingleOverlay, setJingleOverlay] = useState<{ deck: string | null; state: string; title: string | null; contentClass: string | null; jinDurSec: number | null } | null>(null);
  // Discoverability (4.4.56): does this station have any jingle pool? Drives the "Set up jingles →"
  // affordance on the JINGLES fader when the feature is unconfigured (its owner couldn't find it).
  const [hasJinglePool, setHasJinglePool] = useState<boolean>(true);   // assume yes until known → no flash
  // AUTO state persists across restarts — broadcasters expect their automation
  // to remain in whatever state they left it in, especially after a power cycle
  // or app restart. Default false on first install.
  // D3 (2026-08-03): AUTO is OBSERVED, never remembered. This was seeded from readAutoAdv() — the UI
  // painted AUTO from its own KV memory and could contradict the live engine on the same screen (the
  // launch-day photo: AUTO lit while the daemon's _started was false). null = UNKNOWN: the daemon has
  // not answered yet, so the button renders neither AUTO nor MANUAL. KV survives ONLY as the operator's
  // stored preference for what the button does when pressed — never a trigger, never a display source.
  const [autoAdv, setAutoAdv] = useState<boolean | null>(null);
  // COMMAND IN FLIGHT (2026-08-03). Observation is authoritative about everything EXCEPT a command that
  // has not landed yet. Receipt: press AUTO -> the 500ms poll reads the daemon's PRE-command truth
  // (_daemonStarted=false, honestly) and overwrote the operator's press, flashing MANUAL before the
  // confirmation arrived. Jeff read the flash as failure, pressed again, and turned automation OFF by
  // accident. So: after a press, hold the commanded value until the daemon CONFIRMS it (observation
  // matches) or the window expires (the command genuinely failed — then observation must win).
  const autoCmdRef = useRef<{ value: boolean; until: number } | null>(null);
  // Reflect the active station's OWN AUTO state whenever the viewed station changes, so the AUTO
  // button shows this station's automation — never the previously-viewed station's.
  // Station switch → UNKNOWN again until this station's daemon state arrives. Never KV.
  useEffect(() => {
    // TRACE 3 — the station-switch reset. THIS is the line Jeff sees: "when i return to a station auto
    // doesnt stay on it resets to manual after i leave a station". It writes whatever observation says,
    // and when observation says null the pill falls to MANUAL while the daemon is still in AUTO.
    const eng: any = engine;
    const read = eng.observedAutomation;
    bootSeq("SWITCH-EFFECT station=" + stationId + " inst=" + eng.engineInstanceId + " attachState=" + eng.daemonAttachState + " read=" + JSON.stringify(read) + " -> writes=" + JSON.stringify(read ?? null));
    setAutoAdv(autoCmdRef.current ? autoCmdRef.current.value : (read ?? null));   // never clobber a press in flight
  }, [stationId, engine]);
  // Observed automation, polled off the engine's daemon-fed state (engine-rodio tracks `started` from
  // the enginestate stream, which the adopt snapshot also emits — so an attaching renderer learns it
  // without waiting for a change).
  useEffect(() => {
    const t = setInterval(() => {
      const eng: any = engine;
      const obs = eng.observedAutomation;                    // boolean, or null when not observable
      const cmd = autoCmdRef.current;
      if (cmd) {
        if (obs === cmd.value) autoCmdRef.current = null;          // daemon confirmed — release the hold
        else if (Date.now() < cmd.until) { setAutoAdv(cmd.value); return; }   // in flight — hold the press
        else autoCmdRef.current = null;                            // timed out — the command failed; observation wins
      }
      setAutoAdv(prev => {
        if (obs === true || obs === false) return obs;        // observation always wins
        // NO observation available. "?" is legal ONLY while attach is still in flight. Once attach has
        // resolved the operator must see a definite state — never a resting question mark, and never a
        // pressed AUTO falling back to "?" a second later.
        // Jeff, verbatim: "when i do click auto it turns green automates and then shut off again and
        // shows a black button with a question mark it needs to say manual when its off".
        if (eng.daemonAttachState === "unknown") return prev;        // still attaching — leave as-is
        return prev === null ? false : prev;                          // resolved: default MANUAL, and
                                                                      // NEVER clobber a known value
      });
    }, 500);
    return () => clearInterval(t);
  }, [engine]);
  // Slice 4: keep the active-station id fresh for the []-deps SSE command handler (its closure would
  // otherwise pin the mount-time station — the stale-closure bug the routing fix depends on closing).
  useEffect(() => { activeStationIdRef.current = stationId; }, [stationId]);
  const [shuffle, setShuffle] = useState(false);
  const [continuous, setContinuous] = useState(false);
  const [queueLen, setQueueLen] = useState(0);
  const [darkMode, setDarkMode] = useState(false);
  const [showCarts, setShowCarts] = useState(false);
  // Jukebox Mode — fullscreen public takeover. The rest of the app stays MOUNTED underneath so the
  // engine, station context and daemon connection keep running; this is an overlay, not a route swap.
  const [jukeboxOpen, setJukeboxOpen] = useState(false);
  // On-air programming push-up docks (like carts): one editor at a time, mutually
  // exclusive with the cart strip. null = closed.
  const [progPanel, setProgPanel] = useState<null | "shows" | "categories" | "clocks" | "library" | "calendar" | "phone" | "jingles">(null);
  // Broadcast (profanity) delay arm + DUMP. Armed = stream lags live by DELAY_SEC so the
  // operator can dump before audio airs; DUMP becomes active once the buffer is full.
  const DELAY_SEC = 8;
  const [delayArmed, setDelayArmed] = useState(false);
  const [delayFill, setDelayFill] = useState(0); // 0..1 buffer fill
  useEffect(() => {
    if (!delayArmed) { setDelayFill(0); return; }
    const id = setInterval(async () => {
      try { const st = await (window as any).ether?.audio?.broadcastDelayState?.(stationId); setDelayFill(st?.fillPct ?? 0); } catch {}
    }, 500);
    return () => clearInterval(id);
  }, [delayArmed, stationId]);
  const toggleDelay = () => {
    const next = !delayArmed;
    setDelayArmed(next);
    (window as any).ether?.audio?.setBroadcastDelay?.(next ? DELAY_SEC : 0, stationId);
  };
  const doDump = () => {
    (window as any).ether?.audio?.dump?.(stationId);
    // Stays armed — the cushion rebuilds itself (Phase 2). The fill bar drops to ~0 then
    // climbs back as the delay re-establishes; DUMP re-enables once it's full again.
    setDelayFill(0);
  };
  const [globalSearch, setGlobalSearch] = useState("");
  const [autoXfade, setAutoXfade] = useState(true);
  // handleXfade/xfadeActive removed 2026-08-02 with the XFADE button. The deck ON button is the only
  // start control now, and it routes through the daemon's serialized rotate (deckCrossfade →
  // intentCrossfade → _rotateBody) rather than this renderer-side crossfade.
  const [toolsCollapsed, setToolsCollapsed] = useState(() => localStorage.getItem("ether_tools_collapsed") === "1");
  const toggleToolsCollapsed = () => setToolsCollapsed(c => { const next = !c; localStorage.setItem("ether_tools_collapsed", next ? "1" : "0"); return next; });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerUsage, setDrawerUsage] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem("ether_drawer_usage") || "{}"); } catch { return {}; }
  });
  const [showDeckConfig, setShowDeckConfig] = useState(false);
  const [deckConfigClosing, setDeckConfigClosing] = useState(false);
  const [showAbout, setShowAbout] = useState(false);

  // Dev tools available in the dev server, or on the owner install (ETHER-OWNER-2026).
  // Drives the version triple-click → debug panel gesture. See lib/devAccess.ts.
  const [devToolsEnabled, setDevToolsEnabled] = useState(false);
  useEffect(() => {
    import("./lib/devAccess").then(({ isDevToolsEnabled }) => isDevToolsEnabled().then(setDevToolsEnabled));
  }, []);

  // Footer version click handler. When dev tools are disabled: opens About
  // immediately on click. When enabled: counts clicks within 350ms; 3 in a row
  // navigates to #debug instead of opening About. Single click still opens About
  // (with a short delay to allow detection of the triple).
  const versionClickCountRef = useRef(0);
  const versionClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleVersionClick = () => {
    if (!devToolsEnabled) { setShowAbout(true); return; }
    versionClickCountRef.current++;
    if (versionClickCountRef.current >= 3) {
      versionClickCountRef.current = 0;
      if (versionClickTimerRef.current) { clearTimeout(versionClickTimerRef.current); versionClickTimerRef.current = null; }
      window.location.hash = "#debug";
      return;
    }
    if (versionClickTimerRef.current) clearTimeout(versionClickTimerRef.current);
    versionClickTimerRef.current = setTimeout(() => {
      if (versionClickCountRef.current === 1) setShowAbout(true);
      versionClickCountRef.current = 0;
      versionClickTimerRef.current = null;
    }, 350);
  };

  // App version pulled from app.getVersion() in main process. Footer renders
  // `v${version}` always-visible; AboutPanel fetches its own copy separately
  // for clean component-level isolation (both calls hit the same cached value
  // in main).
  const [version, setVersion] = useState("");
  useEffect(() => {
    (window as any).ether.system.getVersion()
      .then((v: string) => setVersion(v))
      .catch(() => setVersion("?.?.?"));
  }, []);
  // Current show/daypart name — shown top-left in the header (where the logo used to be).
  // Colored with the show's own scheduler color so the header matches the Show Scheduler.
  const [headerShow, setHeaderShow] = useState<string | null>(null);
  const [headerShowColor, setHeaderShowColor] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const resolve = async () => {
      try { const sc = await getActiveShowClock(stationId); if (!cancelled) { setHeaderShow(sc?.showName ?? null); setHeaderShowColor(sc?.showColor ?? null); } }
      catch { if (!cancelled) { setHeaderShow(null); setHeaderShowColor(null); } }
    };
    resolve();
    const id = setInterval(resolve, 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, [stationId]);
  const closeDeckConfig = useCallback(() => {
    setDeckConfigClosing(true);
    setTimeout(() => { setShowDeckConfig(false); setDeckConfigClosing(false); }, 200);
  }, []);
  const [showProducerDesk, setShowProducerDesk] = useState(false);

  const openDeskWindow = async () => {
    try {
      await (window as any).ether.invoke("open_desk_window");
    } catch (e) {
      setShowProducerDesk(p => !p);
    }
  };

  // Open any bottom-toolbar feature as a draggable pop-out window (multi-monitor),
  // the same way Desk pops out. Routes to #popout/<panel> via the main process.
  const openPopout = (panel: string) => {
    try { (window as any).ether.invoke("window:popout", panel); } catch { /* not in electron */ }
  };

  // Track which drawer items are used most (persisted to localStorage)
  const drawerClick = (key: string, fn: () => void) => {
    setDrawerUsage(prev => {
      const next = { ...prev, [key]: (prev[key] || 0) + 1 };
      localStorage.setItem("ether_drawer_usage", JSON.stringify(next));
      return next;
    });
    fn();
    setDrawerOpen(false);
  };
  // Now Playing window: pick which station the screen shows (multi-station installs).
  const [npPickerOpen, setNpPickerOpen] = useState(false);
  const openNowPlayingFor = async (id: number) => {
    setNpPickerOpen(false);
    try {
      if (id !== stationId) {
        await (window as any).ether.stations.switch(id);
        window.dispatchEvent(new Event("station-switched"));
      }
    } catch { /* non-fatal — open the window regardless */ }
    openNowPlayingWindow();
  };
  const { configs: deckConfigs, save: saveDeckConfigs, enabled: enabledDecks } = useDeckConfig();
  useEffect(() => { deckConfigsRef.current = deckConfigs; }, [deckConfigs]);

  // Experience mode — controls deck visibility
  const [shiftStarted, setShiftStarted] = useState(false);

  // Visible decks = whatever the user enabled in Configure Decks. No
  // separate "Experience Mode" — the deck configuration IS the mode.
  // 1 music deck enabled → solo. 2 → standard. 3 → full radio. Etc.
  const visibleEnabledDecks = enabledDecks;

  const [outputDevice, setOutputDevice] = useState("");
  const [inputDevice, setInputDevice] = useState("");
  const [editSong, setEditSong] = useState<any>(null);

  // Check if first run is complete
  useEffect(() => {
    if (!stationReady) return;
    (async () => {
      try {
        const result = await (window as any).ether.stationConfigKv.list(stationId);
        const rows: { key: string; value: string }[] = result.ok ? result.rows : [];
        const get = (k: string) => rows.find((r: { key: string }) => r.key === k)?.value;
        if (get('first_run_complete') === "1") setWizardDone(true);
        if (get('onboarding_account_joined') === "1") setAccountJoined(true);
        const name = get('station_name');
        if (name) setStationName(name);
        // THE TIER IS ACCOUNT-LEVEL — read it from install_config_kv (install/account scope), NEVER from
        // a station. The account/license grants the tier (you can't make a station without it), so it
        // must not depend on which station is active or its local id. The owner/dev override (station 1)
        // still wins for testing.
        try {
          const _inst = await (window as any).ether.installConfigKv.list().catch(() => null);
          const _instRows: { key: string; value: string }[] = Array.isArray(_inst) ? _inst : (_inst?.rows || []);
          // Durable signed-in marker (reuses the rows we already have — no extra IPC). Flipping this
          // true re-runs the account/tier reconcile effect (it's in that effect's deps).
          setHasAccountJwt(!!_instRows.find(r => r.key === 'account_jwt')?.value);
          const _override  = resolveEffectivePlan(rows);                                   // override for owner/dev, else station plan
          const _instPlan  = _instRows.find(r => r.key === 'plan_tier')?.value as PlanTier | undefined;
          const _effective = get('plan_tier_dev_override') ? _override : (_instPlan ?? _override);
          setCurrentPlan(_effective);
          setPlanGlobally(_effective);
        } catch {}
        const apiKey = get('license_key');
        // Remember the license for later, but DO NOT push/sync here — a license sitting in the DB
        // proves nothing. Sync only runs once an operator signs in (see the currentUser effect below).
        if (apiKey) { apiKeyRef.current = apiKey; }
        // experience_mode key in DB is now ignored — deck visibility is
        // driven entirely by Configure Decks. Old key left in DB for now.

        // Is this install actually operating? Programming = a music library OR scheduled
        // shows. An empty install (fresh, restored-but-empty, or one whose DB survived an
        // uninstall with a stale first_run_complete=1) has neither → it must sign in.
        try {
          const songRow = await query<{ n: number }>("SELECT COUNT(*) as n FROM songs WHERE deleted_at IS NULL");
          const showRow = await query<{ n: number }>("SELECT COUNT(*) as n FROM shows WHERE deleted_at IS NULL");
          const songs = songRow?.[0]?.n ?? 0;
          const shows = showRow?.[0]?.n ?? 0;
          setInstallOperating(songs > 0 || shows > 0);
        } catch { setInstallOperating(false); }
      } catch {}
      // Was a live stream active at launch? An unattended on-air box that reboots must resume on air
      // without a human at the keyboard → treat it as already signed in for this session.
      try { const r = await (window as any).ether.invoke("account:was-on-air"); setWasOnAir(!!r); if (r) setAccountSignedIn(true); }
      catch { setWasOnAir(false); }
      // A continuation self-relaunch (cloud install / update / reload) carries the signed-in session
      // so the app's OWN relaunch doesn't bounce back to sign-in in a loop. Only a recent one counts.
      try { if (await (window as any).ether.invoke("account:resume-session")) setAccountSignedIn(true); } catch {}
      setFirstRunChecked(true);
      consoleLog("system", "ether started — engine ready");
    })();
  }, [stationId, stationReady]);

  // Mirror install-owned Control Center data (categories…) up once BOTH the license
  // key and the active station's UUID are known. Keyed on firstRunChecked so it runs
  // AFTER the config effect above has populated apiKeyRef — and uses the persisted
  // apiKeyRef.current (same reliable source as the now-playing push), not the per-pass
  // license_key, which only exists under station 1's config. (Phase 2b read-path fix.)
  useEffect(() => {
    if (!(firstRunChecked && apiKeyRef.current && stationUuid && currentUser)) return;
    const push = () => {
      for (const t of ["categories", "clocks", "clock_slots", "shows", "spots"]) {
        pushCcTable(apiKeyRef.current, stationUuid, stationId, t);
      }
      pushLibrary(apiKeyRef.current, stationUuid, stationId);
    };
    push();
    // Light periodic refresh: keep the dashboard's license-keyed store (station_cc_data) current
    // without the deprecated staged pipeline / sync_enabled push. Edits also push immediately on
    // db:apply (see execCmd); this catches desktop-local edits between command-bus applies.
    const id = setInterval(push, 60_000);
    return () => clearInterval(id);
  }, [stationId, stationUuid, firstRunChecked, currentUser]);

  // Push play history for analytics (Phase 3a): catch up on boot, then every 3 min so
  // the dashboard's Analytics view stays current. Incremental + deduped server-side.
  useEffect(() => {
    if (!firstRunChecked || !apiKeyRef.current || !stationUuid || !currentUser) return;
    const push = () => pushPlayHistory(apiKeyRef.current, stationUuid, stationId);
    push();
    const id = setInterval(push, 3 * 60 * 1000);
    return () => clearInterval(id);
  }, [stationId, stationUuid, firstRunChecked, currentUser]);

  // Auto-materialize cloud stations on a running install: poll /account/connect and create any
  // account station missing locally (add-only; never switches/deletes), so a station created in
  // the dashboard appears without a sign-out/in. Gated post-sign-in with a license present.
  useEffect(() => {
    // Fire on EITHER a fresh sign-in this session (accountSignedIn) OR a durable signed-in account
    // (account_jwt present) — the latter is what makes a cloud-restored install reconcile its tier.
    // Still gated on app-init + a license present; reconcileAccountStations only WRITES on a /account/connect
    // 200 with a plan, so this never syncs off an unauthenticated/empty state.
    if (!firstRunChecked || (!accountSignedIn && !hasAccountJwt) || !apiKeyRef.current) return;
    let alive = true;
    // Continuously keep this install in sync with the cloud: materialize any new account stations,
    // then import any cloud-staged programming (categories/clocks/slots/shows authored in the
    // dashboard). Both are idempotent — import only applies rows not yet imported — so it's cheap
    // to run on a short poll. This is what makes "author in the dashboard, it just shows up" work
    // without any mode/toggle: a running install picks up new programming within one poll.
    const syncCloud = async () => {
      if (!alive) return;
      await reconcileAccountStations(apiKeyRef.current).catch(() => {});
      if (alive) await importStagedProgramming(apiKeyRef.current).catch(() => {});
    };
    syncCloud();
    const id = setInterval(syncCloud, 20 * 1000); // ~every 20s
    return () => { alive = false; clearInterval(id); };
  }, [firstRunChecked, accountSignedIn, hasAccountJwt]);

  // When a cloud→local download finishes (materialize writes file_path), re-push the
  // library view so the dashboard's local/cloud status reflects the new local files.
  useEffect(() => {
    const ether = (window as any).ether;
    const off = ether?.libraryR2?.onDownloadDone?.(() => {
      if (apiKeyRef.current && stationUuid) pushLibrary(apiKeyRef.current, stationUuid, stationId);
    });
    return typeof off === "function" ? off : undefined;
  }, [stationId, stationUuid]);

  // Keep apiKeyRef live if user enters license mid-session
  useEffect(() => {
    const reload = async () => {
      const result = await (window as any).ether.stationConfigKv.list(stationId);
      const rows: { key: string; value: string }[] = result.ok ? result.rows : [];
      const key = rows.find((r: any) => r.key === 'license_key')?.value;
      // Remember the license, but only push profiles up if an operator is actually signed in.
      if (key) { apiKeyRef.current = key; if (currentUser) pushInstallUsers(key); }
    };
    const pushUsers = () => { if (currentUser) pushInstallUsers(apiKeyRef.current); };
    window.addEventListener('ether:license-changed', reload);
    window.addEventListener('ether:users-changed', pushUsers);
    return () => {
      window.removeEventListener('ether:license-changed', reload);
      window.removeEventListener('ether:users-changed', pushUsers);
    };
  }, [stationId, currentUser]);

  // THE SYNC GATE. Sync (push AND pull) runs ONLY while an operator is signed in — never off a
  // license_key that's merely sitting in the database. Signing in starts the scheduler and mirrors
  // this install's profiles up; signing out stops all sync. This is what stops Ether from assuming
  // a license and pulling/pushing another account's data before anyone has signed in.
  useEffect(() => {
    const ether = (window as any).ether;
    // Best-effort: the handler only registers when Multi-Device Sync is enabled, so swallow the
    // "no handler" rejection instead of leaking an unhandled promise rejection to the console.
    ether?.invoke?.("sync:set-active", !!currentUser)?.catch?.(() => {});
    if (currentUser && apiKeyRef.current) pushInstallUsers(apiKeyRef.current);
  }, [currentUser]);

  // Native menu IPC handler
  useEffect(() => {
    const handler = (window as any).ether.on("menu-action", (cmd: string) => {
      const panels: Record<string,string> = { "nav:library":"library","nav:spots":"spots","nav:voicetrack":"voicetrack","nav:cartwall":"cartwall","nav:trackedit":"trackedit","nav:clocks":"clocks","nav:programlog":"programlog","nav:logs":"logs","nav:studio":"studio","nav:broadcasteditor":"broadcasteditor","nav:autocue":"autocue","nav:playlist":"playlist","nav:phonedesk":"phonedesk","nav:announce":"announce","nav:showprep":"showprep","nav:streaming":"streaming","nav:smartschedule":"smartschedule","nav:analytics":"analytics","nav:multioutput":"multioutput","nav:stationmanager":"stationmanager","nav:health":"health","nav:videostudio":"videostudio","nav:importlibrary":"importlibrary","nav:cloudbackup":"cloudbackup","nav:clipeditor":"clipeditor","nav:captions":"captions","nav:eas":"eas" };
      if (panels[cmd]) { setPanel(panels[cmd] as Panel); return; }
      if (cmd === "nav:scheduler-tab:clocks")     { setSchedulerTab("clocks"); return; }
      if (cmd === "nav:scheduler-tab:shows")      { setSchedulerTab("shows"); return; }
      if (cmd === "nav:scheduler-tab:categories") { setSchedulerTab("categories"); return; }
      if (cmd === "file:import") setPanel("library");
      if (cmd === "file:preferences") setPanel("settings");
      if (cmd === "file:save") canvasEngine.saveCurrentLayout(canvasEngine.activeLayoutName);
      if (cmd === "file:new-session") { canvasEngine.resetLayout(); setPanel("live"); }
      if (cmd === "view:configure-decks") setShowDeckConfig(true);
      if (cmd === "view:reset") { setVisiblePanels({ queue:true,deckA:true,deckB:true,deckC:true,mic:true,clock:false,history:false,cartwall:false }); setPanel("live"); }
      if (cmd === "view:queue") toggleVisible("queue");
      if (cmd === "view:deckA") toggleVisible("deckA");
      if (cmd === "view:deckB") toggleVisible("deckB");
      if (cmd === "view:deckC") toggleVisible("deckC");
      if (cmd === "view:mic") toggleVisible("mic");
      if (cmd === "help:shortcuts") window.dispatchEvent(new KeyboardEvent("keydown",{code:"Slash",shiftKey:true}));
      if (cmd === "help:check-updates") updater.checkForUpdate?.();
      if (cmd === "nav:about") setShowAbout(true);
      if (cmd === "account:sign-out") setCurrentUser(null); // back to the profile / PIN screen
      if (cmd === "account:switch") {
        // Sign out of the cloud account and relaunch to sign in / sign up. Clears only the
        // account/onboarding flags; local station data is left intact. Mirrors SubscriptionPanel.
        (async () => {
          if (!window.confirm("Switch account?\n\nThis signs out of the current account and restarts to the Sign in / Sign up screen, where you can sign in or create a new account.\n\nThis install's local station data isn't deleted — back it up to the cloud first if you need it. Continue?")) return;
          const ether = (window as any).ether;
          let sid = 1;
          try { const a = await ether.stations?.getActive?.(); sid = a?.id ?? 1; } catch {}
          const keys = ['license_key','license_email','plan_tier','account_name','first_run_complete','onboarding_account_joined','onboarding_license_entered','onboarding_library_pulled','onboarding_library_source'];
          for (const k of keys) { try { await ether.stationConfigKv.removeByKey(sid, k); } catch {} }
          try { await ether.invoke('app:relaunch'); } catch { window.alert("Couldn't switch accounts — please try again."); }
        })();
      }
    });
    return () => (window as any).ether.off("menu-action", handler);
  }, []);

  // Keep the File ▸ Switch Account enabled/greyed state in sync with the plan.
  useEffect(() => { (window as any).ether?.invoke?.("menu:rebuild")?.catch?.(() => {}); }, [currentPlan]);

  // Allow any UpgradePrompt button anywhere in the app to open the subscription panel
  useEffect(() => {
    const handler = () => setPanel("subscription");
    window.addEventListener("ether:open-subscription", handler);
    return () => window.removeEventListener("ether:open-subscription", handler);
  }, []);

  // Open the Manage Devices panel via custom event — fired from SubscriptionPanel
  // or anywhere else that wants to route the customer to seat management.
  useEffect(() => {
    const handler = () => setPanel("managedevices");
    window.addEventListener("ether:open-managedevices", handler);
    return () => window.removeEventListener("ether:open-managedevices", handler);
  }, []);

  // Open About via custom event — symmetric with subscription/managedevices.
  // Used by the dev debug panel jump-to-screen action.
  useEffect(() => {
    const handler = () => setShowAbout(true);
    window.addEventListener("ether:open-about", handler);
    return () => window.removeEventListener("ether:open-about", handler);
  }, []);

  // ── Remote command stream (emergency override + companion) ──
  // Replaced polling with SSE — instant delivery, zero idle traffic.
  useEffect(() => {
    const STREAM_BASE = `${ETHER_BACKEND_URL}/api/cmd-stream`;

    // Resolve a library song (by local id, or file_key) to a playable filePath — fetching
    // from the R2 cloud cache if it's not materialized locally. Used by the dashboard's
    // remote A/B/C (deck:load) + Q (queue:enqueue) actions.
    const resolveSong = async (songId?: number, fileKey?: string): Promise<{ filePath: string; title: string; artist: string; durationMs: number } | null> => {
      try {
        let row: any = null;
        if (songId != null) row = await queryOne<any>("SELECT s.*, a.name AS artist_name FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.id = ?", [songId]);
        if (!row && fileKey) row = await queryOne<any>("SELECT s.*, a.name AS artist_name FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.file_key = ?", [fileKey]);
        if (!row) return null;
        let filePath: string = row.file_path || "";
        const key = row.file_key || fileKey;
        if (!filePath && key) {
          try { const res = await (window as any).ether.invoke("r2:fetch-track", key); if (res?.ok) filePath = res.filePath; } catch { /* best-effort */ }
        }
        return filePath ? { filePath, title: row.title, artist: row.artist_name || "", durationMs: row.duration_ms ?? 0 } : null;
      } catch { return null; }
    };

    const execCmd = async (cmd: string, data: any) => {
      try {
        // ── Slice 4: station-route the command ──────────────────────────────────────────────────
        // The bus is per-license (fans to every desktop on the license). A station-scoped command must
        // act on the RIGHT station and be ignored by machines that don't run it — otherwise one click
        // hits every station. License-scoped commands (db:apply, library:*) bypass routing. The active
        // station is read from a ref, NOT this []-deps closure (which pinned the mount-time station).
        const activeId = activeStationIdRef.current;
        let targetId = activeId;
        if (isStationScopedCommand(cmd)) {
          let localStations: { id: number; uuid: string | null }[] = [];
          try { localStations = await query<{ id: number; uuid: string | null }>("SELECT id, uuid FROM stations"); } catch { /* no rows → resolver falls back to active */ }
          const t = resolveCommandTarget(data?.station_uuid, activeId, localStations);
          if (t.kind === "ignore") { console.log(`[RemoteCmd] ${cmd} ignored — station ${data?.station_uuid} not run on this machine`); return; }
          targetId = t.stationId;
          // Guided handoff (move-broadcast): a command may also target a SPECIFIC machine. Only that
          // machine acts — so "release on jensj" / "grab on studio-D" hit exactly one machine, not every
          // machine that runs the station. No target_machine_id → unchanged.
          if (!commandTargetsThisMachine(data?.target_machine_id, machineIdRef.current)) {
            console.log(`[RemoteCmd] ${cmd} ignored — targets machine ${data?.target_machine_id}, not this one`);
            return;
          }
        }
        const isActive = targetId === activeId;
        const activeEngine = getEngine(activeId);             // fresh active engine (replaces the stale closure `engine`)
        const useDaemon = activeEngine.isDaemonDriven;         // install-level mode — all stations share it
        // Daemon-direct: act on the TARGET station by id, independent of which station is the active
        // view. We never call getEngine(targetId).* for a non-active station — those engines are created
        // but never init()-ed, so their daemonDriven is false and they'd misfire (the doc's gotcha).
        const dcmd = (c: string, args: Record<string, unknown> = {}) =>
          (window as any).ether?.audio?.daemon?.(c, { stationId: targetId, ...args });

        switch (cmd) {
          // ── Control set (Slice 4) — routed daemon-direct to the target station ──
          case "stop_all":
            if (useDaemon) await dcmd("stopAll");
            else if (isActive) { activeEngine.getDeck("A")?.stop(); activeEngine.getDeck("B")?.stop(); activeEngine.getDeck("C")?.stop(); }
            break;
          case "play":
            if (useDaemon) await dcmd("play", { deck: "A" });
            else if (isActive) activeEngine.getDeck("A")?.play();
            break;
          case "pause":
            if (useDaemon) await dcmd("pause", { deck: "A" });
            else if (isActive) activeEngine.getDeck("A")?.pause();
            break;
          case "skip":
            if (useDaemon) await dcmd("skip");
            else if (isActive) activeEngine.skip();
            break;
          case "play_now":
            // PLAY NOW — manual stall escape: put audio on air immediately. Daemon's deck:playNow plays
            // a cued deck if one's ready, else loads+plays the next queued track. In-process fallback ≈
            // skip (force-advance, which also plays the next track when nothing is on air).
            if (useDaemon) await dcmd("deck:playNow");
            else if (isActive) await activeEngine.skip();
            break;
          case "automation_on":
            if (isActive) { setAutoAdv(true); activeEngine.autoAdvance = true; } // UI + local flag only for the active view
            writeAutoAdv(targetId, true);                                        // persist for the TARGET station
            if (useDaemon) await dcmd("automationStart");
            break;
          case "automation_off":
            if (isActive) { setAutoAdv(false); activeEngine.autoAdvance = false; }
            writeAutoAdv(targetId, false);
            if (useDaemon) await dcmd("automationStop");
            break;

          // ── On-air (Slice 4): start/stop THIS machine as the target station's Icecast source.
          //    Reuses the desktop's OWN on-air lifecycle (stream:go-live/stop-live → daemon startStream/
          //    stopStream, config from the station row) — the same path the local on-air button uses, not
          //    a parallel one. Keyed by stationId in main, so it works for any station this machine runs.
          //    stop releases the mount cleanly (ffmpeg SIGTERM → Icecast source disconnects) so another
          //    machine can then source it. Going on-air while the mount is held elsewhere fails at the
          //    Icecast layer (403) — the dashboard pre-empts that with the source-attribution check.
          case "stream:start":
            await (window as any).ether?.invoke?.("stream:go-live", { stationId: targetId });
            break;
          case "stream:stop":
            await (window as any).ether?.invoke?.("stream:stop-live", { stationId: targetId });
            break;

          // ── Other station-scoped commands — ACTIVE station only (existing behavior, now fan-out-
          //    protected by the ignore-gate). Routing to a non-active station needs that station's
          //    renderer/queue state; deferred (see docs/slice4-desktop-station-routing.md). ──
          case "set_volume":
            if (isActive && data.volume !== undefined) (activeEngine as any).setMasterVolume?.(data.volume);
            break;
          case "play_emergency_cart":
            if (isActive) (activeEngine as any).playEmergencyCart?.();
            break;
          case "mic_on":
            if (isActive) (activeEngine as any).openMic?.();
            break;
          case "deck:load": {
            // Dashboard "A/B/C" — CUE a library song onto a deck (READY, never playing).
            const deck = String(data.deck || "A").toUpperCase() as "A" | "B" | "C";
            if (!["A", "B", "C"].includes(deck)) break;
            if (!isActive) { console.log("[RemoteCmd] deck:load skipped — non-active station (deferred)"); break; }
            const song = await resolveSong(data.song_id, data.file_key);
            if (song) {
              if (useDaemon) {
                await activeEngine.deckCue(deck, { filePath: song.filePath, title: song.title, artist: song.artist, durationMs: song.durationMs });
              } else {
                await activeEngine.loadToDeck(deck, song.filePath, song.title, song.artist, undefined, song.durationMs);
              }
              window.dispatchEvent(new CustomEvent("ether:queue-changed"));
            }
            break;
          }
          case "queue:enqueue": {
            if (!isActive) { console.log("[RemoteCmd] queue:enqueue skipped — non-active station (deferred)"); break; }
            const song = await resolveSong(data.song_id, data.file_key);
            if (song) {
              const item = { filePath: song.filePath, title: song.title, artist: song.artist, durationMs: song.durationMs };
              if (useDaemon) activeEngine.queueEnqueue([item]); else activeEngine.addToQueue([item]);
              window.dispatchEvent(new CustomEvent("ether:queue-changed"));
            }
            break;
          }
          case "queue:reorder": {
            if (!isActive) { console.log("[RemoteCmd] queue:reorder skipped — non-active station (deferred)"); break; }
            const order: number[] = Array.isArray(data.order) ? data.order : [];
            if (order.length) {
              const q = activeEngine.getQueue();
              if (order.length <= q.length && order.every(i => Number.isInteger(i) && i >= 0 && i < q.length)) {
                if (useDaemon) {
                  const qids = order.map(i => q[i]?.qid).filter(Boolean) as string[];
                  for (let k = 0; k < qids.length; k++) await activeEngine.queueReorder(qids[k], k);
                } else {
                  const head = order.map(i => q[i]).filter(Boolean);
                  activeEngine.replaceQueue([...head, ...q.slice(order.length)]);
                  setTimeout(() => activeEngine.triggerPreload?.(), 100);
                }
                window.dispatchEvent(new CustomEvent("ether:queue-changed"));
              }
            }
            break;
          }

          // ── Explicit-intent transport (Stage 2 wiring) — daemon-direct to the TARGET station, so they
          //    work for a non-active station too (unlike deck:load/queue:enqueue, which need the renderer's
          //    queue state). Daemon verbs are tolerant: a stale/unknown intent is a quiet no-op. Routing
          //    entries already declared in cmd-routing.ts STATION_SCOPED. ──
          case "deck:cue": {
            const deck = String((data as any).deck || "").toUpperCase();
            if (!["A", "B", "C"].includes(deck)) break;
            const songRef = (data as any).songRef ?? (data as any).song_ref ??
              (((data as any).song_id != null || (data as any).file_key != null)
                ? { songId: (data as any).song_id, fileKey: (data as any).file_key } : {});
            if (useDaemon) await dcmd("deck:cue", { deck, songRef });
            else console.log("[RemoteCmd] deck:cue needs the daemon — skipped (in-process)");
            break;
          }
          case "deck:crossfade":
            if (useDaemon) await dcmd("deck:crossfade", { from: String((data as any).from || "A").toUpperCase(), to: String((data as any).to || "B").toUpperCase() });
            else console.log("[RemoteCmd] deck:crossfade needs the daemon — skipped (in-process)");
            break;
          case "queue:remove":
            if ((data as any).qid == null) break;
            if (useDaemon) await dcmd("queue:remove", { qid: String((data as any).qid) });
            break;
          case "queue:move":
            if ((data as any).qid == null) break;
            if (useDaemon) await dcmd("queue:move", { qid: String((data as any).qid), where: (data as any).where ?? (data as any).toIndex ?? (data as any).to_index });
            break;
          case "queue:clear":
            if (useDaemon) await dcmd("queue:clear");
            break;

          // ── License-scoped — install-wide, NEVER gated by station_uuid ──
          case "db:apply":
            await applyDbMutation(apiKeyRef.current, data);
            // Leg 2: after a CC-table edit applies, reconcile it UP the license-keyed CC push
            // (POST /api/account/data/sync -> station_cc_data), the same rail the dashboard reads —
            // NOT the deprecated staged pipeline / sync_enabled mutation backlog. Best-effort; the
            // 60s periodic refresh backstops it.
            if (data?.table && ["categories", "clocks", "clock_slots", "shows", "spots"].includes(data.table) && data.station_uuid) {
              try {
                const ccStations = await query<{ id: number; uuid: string | null }>("SELECT id, uuid FROM stations");
                const ccSid = ccStations.find(s => s.uuid === data.station_uuid)?.id;
                if (ccSid != null) await pushCcTable(apiKeyRef.current, data.station_uuid, ccSid, data.table);
              } catch { /* best-effort; periodic refresh will catch up */ }
            }
            break;
          case "library:addSong":
            await addLibrarySong(apiKeyRef.current, data);
            break;
          case "library:syncDownload":
            try { await (window as any).ether.invoke?.("library:sync-r2:download", { materialize: true }); } catch { /* best-effort */ }
            break;

          default:
            console.log("[RemoteCmd] Unknown command:", cmd);
        }
      } catch (e) {
        console.error("[RemoteCmd] Exec failed:", cmd, e);
      }
    };

    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let destroyed = false;
    let backoffMs = 1000;

    const connect = () => {
      if (destroyed) return;
      const key = apiKeyRef.current;
      if (!key) {
        // License key loads a beat after boot (async config read). connect() runs
        // once at mount and there's no key-arrival trigger otherwise, so retry until
        // the key is present — without this the command channel never connects and
        // no dashboard/companion command (incl. Control Center db:apply) ever arrives.
        reconnectTimer = setTimeout(connect, 1500);
        return;
      }

      const url = `${STREAM_BASE}?key=${encodeURIComponent(key)}`;
      es = new EventSource(url);

      es.addEventListener("cmd", (e: MessageEvent) => {
        try {
          const { cmd, data } = JSON.parse(e.data);
          execCmd(cmd, data || {});
        } catch {}
      });

      es.onopen = () => { backoffMs = 1000; };   // reset backoff on successful connect

      es.onerror = () => {
        es?.close();
        es = null;
        if (!destroyed) {
          reconnectTimer = setTimeout(() => {
            backoffMs = Math.min(backoffMs * 2, 30_000);
            connect();
          }, backoffMs);
        }
      };
    };

    connect();

    return () => {
      destroyed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, []);

  const handleWizardComplete = (profile: VenueProfile) => {
    setStationName(profile.name);
    setWizardDone(true);
    setAccountJoined(true); // completing onboarding means an account was signed in
    bootMarkAuthComplete();
    setAccountSignedIn(true); // session sign-in complete — gate can advance past the sign-in screen
  };

  useEffect(() => {
    (globalThis as any).__etherEngine = engine;
    (globalThis as any).__resetScheduleCursor = resetScheduleCursor;
  }, []);

  useEffect(() => {
    const unlisten = listen("desk-send-to-queue", (event: any) => {
      const track = event.payload as { title: string; artist: string; filePath?: string };
      if (!track?.title) return;
      engine.addToQueue([{
        filePath: track.filePath || "",
        title: track.title,
        artist: track.artist || "",
        durationMs: 0,
      }]);
      setQueueLen(engine.getQueue().length);
      window.dispatchEvent(new CustomEvent('ether:queue-changed'));
    });
    return () => { unlisten.then(f => f()); };
  }, []);

  useEffect(() => {
    const unlisten = listen("now-playing-request", async () => {
      const dA = engine.getDeck("A");
      const stA = dA?.getState();
      let widget = "upcoming";
      try {
        const rows = await query<{ value: string }>("SELECT value FROM station_config_kv WHERE key = 'nowplaying_widget'");
        if (rows.length > 0) widget = rows[0].value;
      } catch {}
      emit("now-playing-update", {
        title: stA?.title || "", artist: stA?.artist || "",
        position: stA?.positionSec || 0, duration: stA?.durationSec || 0,
        widget,
        upcoming: engine.getQueue().slice(0, 10).map(q => ({ title: q.title, artist: q.artist, duration: 0 })),
        // Same as the other emitter: carry the file and its class so the now-playing display
        // routes a spot down the spot artwork chain instead of a music-store search.
        filePath: stA?.filePath || null,
        contentClass: stA?.contentClass ?? null,
      }).catch(() => {});
    });
    return () => { unlisten.then(f => f()); };
  }, []);

  useEffect(() => {
    if (!stationId) return;
    engine.setRefillCallback(async () => {
      // Route continuous refill through the SAME guarded scheduler as the main fill
      // (clock → SmartRule → on-format random) so it honors rotation_status, dayparts,
      // separation, and the on-format category universe. This previously did a raw
      // whole-library random pull, which leaked off-format/seasonal songs (e.g. Christmas
      // — "Feliz Navidad") straight into the daypart queue when the queue ran dry.
      // Pass THIS engine's stationId explicitly — otherwise a later station switch would make
      // this engine refill the *new* active station's queue instead of its own.
      await fillQueueFromSchedule(20, stationId);
      return [];
    });
  }, [stationId]);

  // ── Drive AUTO on ALL stations, not just the foreground one ─────────────────────────────────────
  // In-process mode previously ran auto only for the ACTIVE station, so background stations played their
  // queue out and went to dead air (the overnight failure). Here every station the operator put in AUTO
  // gets its own engine wired to refill from ITS OWN schedule and, if not already on air, filled + started.
  // Each engine's own 250ms poll loop then keeps it rotating by the rules — no forcing, no daemon.
  useEffect(() => {
    if (!accountSignedIn) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      let rows: { id: number }[] = [];
      try { rows = await query<{ id: number }>("SELECT id FROM stations WHERE uuid IS NOT NULL"); } catch { return; }
      for (const { id: sid } of rows) {
        if (cancelled) return;
        if (!readAutoAdv(sid)) continue;                       // only stations the operator put in AUTO
        const eng = getEngine(sid);
        if ((eng as any).isDaemonDriven) continue;             // daemon owns playout in daemon mode
        eng.setRefillCallback(async () => { await fillQueueFromSchedule(20, sid); return []; });
        eng.continuous = true;
        eng.autoAdvance = true;
        const onAir = (["A", "B", "C"] as const).some(d => eng.getDeck(d)?.getState().status === "playing");
        if (onAir) continue;                                   // already on air — never restart over it
        if (eng.getQueue().length === 0) await fillQueueFromSchedule(20, sid);
        const q = eng.getQueue();
        if (q.length > 0 && !cancelled) {
          const first = q[0]; eng.clearQueue(); eng.addToQueue(q.slice(1));
          await eng.loadToDeck("A", first.filePath, first.title, first.artist, (first as any).gainDb, first.durationMs);
          eng.getDeck("A")?.play();
          setTimeout(() => eng.triggerPreload(), 800);
          rotLog(`[ROT] all-station driver: started station ${sid} — "${first.title}"`);
        }
      }
    }, 3000);
    return () => { cancelled = true; clearTimeout(t); };
  }, [accountSignedIn]);

  const [xfadeDuration, setXfadeDurationState] = useState(() => {
    try { const v = parseInt(localStorage.getItem("ether_xfade_duration") || "3"); return isNaN(v) ? 3 : Math.min(10, Math.max(1, v)); } catch { return 3; }
  });
  const setXfadeDuration = (v: number) => {
    setXfadeDurationState(v);
    localStorage.setItem("ether_xfade_duration", String(v));
    engine.crossfadeDuration = v;
  };
  // Routine segue overlap (auto song→song) — seconds the next song starts before the current ends
  // (0 = wait for the end). Distinct from the manual X-key crossfade above. No fades.
  const [segueOverlap, setSegueOverlapState] = useState(() => {
    try { const v = parseInt(localStorage.getItem("ether_segue_overlap") ?? "3"); return isNaN(v) ? 3 : Math.min(10, Math.max(0, v)); } catch { return 3; }
  });
  const setSegueOverlap = (v: number) => {
    setSegueOverlapState(v);
    localStorage.setItem("ether_segue_overlap", String(v));
    (engine as any).setSegueOverlap?.(v);
  };
  // Push the persisted segue setting into the engine on mount (and thus to the daemon once connected).
  useEffect(() => { (engine as any).setSegueOverlap?.(segueOverlap); }, [engine]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement).isContentEditable) return;
      const dA = engine.getDeck("A"); const dB = engine.getDeck("B");
      switch(e.code) {
        case "Space": {
          e.preventDefault();
          if (panelRef.current === "trackedit") break;
          const decks = ["A", "B", "C"] as const;
          let onAirSlot: "A" | "B" | "C" | null = null;
          for (const slot of decks) {
            const d = engine.getDeck(slot);
            if (!d) continue;
            const status = d.getState().status;
            if (status === "playing" || status === "paused") { onAirSlot = slot; break; }
          }
          if (onAirSlot) {
            const d = engine.getDeck(onAirSlot)!;
            if (d.getState().status === "playing") d.pause();
            else d.resume();
          } else if (!autoAdv) {
            engine.getDeck("A")?.play();
          }
          break;
        }
        case "KeyB": if (dB) { if (dB.getState().status === "playing") dB.pause(); else if (dB.getState().status === "paused") dB.resume(); else dB.play(); } break;
        case "KeyX":
          const xPlaying = deckA?.status === "playing" ? "A" : deckB?.status === "playing" ? "B" : deckC?.status === "playing" ? "C" : null;
          if (xPlaying) {
            const xOrder: Array<"A"|"B"|"C"> = ["A","B","C"];
            const xIdx = xOrder.indexOf(xPlaying as "A"|"B"|"C");
            for (let xi = 1; xi <= 2; xi++) {
              const xCand = xOrder[(xIdx + xi) % 3];
              const xState = xCand === "A" ? deckA : xCand === "B" ? deckB : deckC;
              if (xState?.filePath) { engine.crossfade(xPlaying, xCand, xfadeDuration * 1000); break; }
            }
          }
          break;
        case "KeyL": setPanel("library"); break;
        case "KeyS": setPanel("clocks"); break;
        case "KeyG": setPanel("logs"); break;
        case "KeyA": e.preventDefault(); toggleAuto(); break;
        case "Slash": if (e.shiftKey) { e.preventDefault(); setShowShortcuts(s => !s); } break;
        case "Escape": setShowShortcuts(false); setDrawerOpen(false); break;
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [deckA, deckB]);

  // When the schedule is (re)generated, resync the live up-next queue to the new plan from now —
  // only while AUTO is driving playback (don't disturb a manually-built queue).
  useEffect(() => {
    const onRegen = async () => {
      if (!autoAdv) return;
      try {
        resetScheduleCursor(stationId);
        if (engine.isDaemonDriven) {
          (engine as any).queueClearPending?.();   // daemon refills from the new rows on its next cycle
        } else {
          engine.clearQueue?.();
          await fillQueueFromSchedule();
        }
        window.dispatchEvent(new CustomEvent("ether:queue-changed"));
        console.log("[schedule] resynced live queue to regenerated schedule");
      } catch (e) { console.warn("[schedule-regen resync] failed:", e); }
    };
    window.addEventListener("ether:schedule-regenerated", onRegen);
    return () => window.removeEventListener("ether:schedule-regenerated", onRegen);
  }, [autoAdv]);

  // Display subscription — re-subscribes whenever the active station changes so
  // deckA/B/C and queueLen always reflect the currently-viewed station.
  useEffect(() => {
    // EVERY active station's engine gets initialized, not just the login-time one.
    // The startup effect below calls init() with deps [accountSignedIn, wasOnAir], so a
    // station switched to AFTER launch (soft switch, no reload) held an engine that had
    // never run init() → no 250 ms poll and no attachDaemonEvents subscription → engine.on()
    // returned a valid unsub that never fired. Every listener on that engine went silent:
    // no fill sweep, no position countdown, frozen duration — with no error anywhere.
    // init() is idempotent by construction (engine-rodio.ts:150 `if (this.pollTimer) return`
    // and :161 daemonDetectStarted), so re-running it here on every engine change cannot
    // double-init, cannot double-subscribe, and cannot restart the daemon detect.
    // Deliberately placed in THIS effect rather than the startup one: that effect also owns
    // crash-only auto-resume, and re-running it per station switch could re-trigger
    // auto-start on the station being switched to.
    engine.init();
    setDeckA(engine.getDeck("A")?.getState?.() ?? null);
    setDeckB(engine.getDeck("B")?.getState?.() ?? null);
    setDeckC(engine.getDeck("C")?.getState?.() ?? null);
    setQueueLen(engine.getQueue().length);
    const unsub = engine.on((id, st) => {
      if (id === "A") setDeckA({...st});
      else if (id === "B") setDeckB({...st});
      else if (id === "C") setDeckC({...st});
      setQueueLen(engine.getQueue().length);
    });
    // Exactly ONE live engine: when the active station changes, the engine we are leaving
    // releases its 250 ms poll and its daemon listeners. Without this, every station
    // visited left a timer running for the session — and in the in-process fallback two
    // initialised engines both detect the same track end and both advance.
    //
    // NEVER stopped while it is driving audio: in daemon mode the daemon owns playout and
    // this engine is only a mirror, so stopping it cannot affect air. In the in-process
    // fallback the renderer engine IS the playout driver, so an engine with a playing deck
    // is left running — silencing an airing station to tidy up a timer would be a far worse
    // bug than the one being fixed.
    const leaving = engine;
    return () => {
      unsub();
      if (leaving.isDaemonDriven || !leaving.hasPlayingDeck()) leaving.stop();
    };
  }, [engine]);

  useEffect(() => {
    engine.init();
    engine.outroCrossfade = true;
    engine.crossfadeDuration = xfadeDuration;
    // Restore persisted AUTO state on boot — autoAdv was hydrated from
    // localStorage in useState init, but engine is a singleton that doesn't
    // know about it until we sync here.
    engine.autoAdvance = readAutoAdv(stationId);
    if (readAutoAdv(stationId)) engine.continuous = true;
    // Startup auto-resume — ACCOUNT-IS-ROOT GATE: only auto-start playout once a valid account session
    // exists (accountSignedIn). That flag is set true ONLY by a resumed session, a completed sign-in,
    // or the watchdog on-air exception (account:was-on-air → _wasOnAir in main.js) — so this fires in
    // exactly the legitimate cases and NEVER before the sign-in screen. The effect re-runs when the gate
    // opens so a fresh sign-in resumes AUTO. engine.init() above is idempotent, so re-running is a no-op;
    // toggling AUTO has its own handler (automation_on), so it is intentionally NOT a dep here.
    // BOOT AUDIO POLICY (2026-07-24): auto-resume is CRASH-ONLY. A clean/manual launch must NEVER auto-air even
    // with AUTO persisted on — the operator clicks AUTO deliberately. Gate on wasOnAir (account:was-on-air →
    // _wasOnAir: on-air marker + watchdog respawn) so ONLY a crash of a genuinely-airing station resumes here.
    // (This also stops the empty-station boot autofill/emergency-generate, which lives inside this block.)
    let autoStartTimer: ReturnType<typeof setTimeout> | null = null;
    if (readAutoAdv(stationId) && accountSignedIn && wasOnAir === true) {
      autoStartTimer = setTimeout(async () => {
        // Item 10 Phase 2: wait for the daemon-vs-in-process decision before choosing how to
        // start, so a slow daemon connect can't race us into the local path (and dead air).
        await engine.awaitDaemonReady?.();
        // daemon-driven → the daemon fills + plays + advances itself. Issue automationStart even when a
        // deck is ALREADY playing (e.g. a daemon that SURVIVED an app update/restart still playing deck A,
        // or a crash-recovery restore): the daemon's start() is idempotent and ADOPTS the running deck,
        // but it MUST run so the daemon's automation engine engages (its 250ms poll preloads B/C and
        // advances on song-end) AND so main records the automation intent that powers auto-resume across a
        // stale-daemon reload. The old "deck A already playing → return" guard skipped this in daemon mode,
        // which left audio playing but B/C empty and no transition until a manual AUTO reset.
        if (engine.isDaemonDriven) { rotLog("[ROT] STARTUP daemon-driven → automationStart (watchdog-resume: a station was live and no human is here)"); await engine.startDaemonAutomation("watchdog-resume"); return; }
        // in-process path: if crash recovery already restored & started deck A, don't double-start over it.
        if (engine.getDeck("A")?.getState().status === "playing") return;
        rotLog(`[ROT] STARTUP autofill begin — queue: [${engine.getQueue().map(q => q.title).join(", ")}]`);
        engine.continuous = true;
        resetScheduleCursor(stationId);
        // Always fill from schedule — don't reuse crash_recovery's stale queue
        engine.clearQueue();
        const count = await fillQueueFromSchedule();
        if (count === 0) {
          // Startup fallback — stay ON FORMAT (rotation-eligible + on-format categories +
          // current daypart), never a raw whole-library pull (that leaked Christmas).
          const fmt = await getFormatCategoryIds(stationId);
          const suHour = new Date().getHours();
          const catClause = fmt.length ? `AND s.category_id IN (${fmt.map(() => "?").join(",")})` : "";
          const rows = await queryScoped<SongRow>(
            `SELECT s.*, a.name as artist_name FROM songs s LEFT JOIN artists a ON a.id = s.artist_id
             WHERE s.file_path IS NOT NULL AND (s.rotation_status IS NULL OR s.rotation_status != 'inactive')
               AND (s.content_class IS NULL OR s.content_class = 'MUSIC')
               AND ((s.daypart_mask >> ?) & 1) = 1 ${catClause}
             ORDER BY RANDOM() LIMIT 100`,
            fmt.length ? [suHour, ...fmt] : [suHour], stationId, { skipScoping: true });
          const items = rows.filter((s: SongRow) => s.file_path).map((s: SongRow) => ({ filePath: s.file_path!, title: s.title, artist: (s as any).artist_name || "", durationMs: s.duration_ms ?? 0 }));
          engine.addToQueue(items);
        }
        const q = engine.getQueue();
        if (q.length > 0) {
          const first = q[0]; engine.clearQueue(); engine.addToQueue(q.slice(1));
          await engine.loadToDeck("A", first.filePath, first.title, first.artist, first.gainDb, first.durationMs);
          engine.getDeck("A")?.play();
          const dA = engine.getDeck("A")?.getState();
          const dB = engine.getDeck("B")?.getState();
          const dC = engine.getDeck("C")?.getState();
          rotLog(`[ROT] STARTUP autofill complete — A="${dA?.title}"(${dA?.status}) B="${dB?.title}"(${dB?.status}) C="${dC?.title}"(${dC?.status}) | queue: [${engine.getQueue().map(q => q.title).join(", ")}]`);
          setTimeout(() => engine.triggerPreload(), 800);
          window.dispatchEvent(new CustomEvent("ether:queue-changed"));
        }
      }, 2000);
    }
    const unsub = engine.on((id, st) => {
      // If a deck is playing but has no duration (e.g. Rust backend survived a JS reload),
      // look up duration_ms from the DB by filePath — fires at most once per filePath.
      if (st.durationSec === 0 && st.filePath && !durQueried.current.has(st.filePath)) {
        durQueried.current.add(st.filePath);
        queryOne<{ duration_ms: number | null }>(
          "SELECT duration_ms FROM songs WHERE file_path = ?", [st.filePath]
        ).then(row => {
          if (row?.duration_ms) engine.setDeckDuration(id as "A" | "B" | "C", row.duration_ms / 1000);
        }).catch(() => {});
      }

      // Console logging — status transitions
      const prev = prevDeckStatus.current[id];
      if (prev !== st.status) {
        prevDeckStatus.current[id] = st.status;
        if (st.status === "loading" && st.title) {
          const dur = st.durationSec ? ` (${Math.floor(st.durationSec / 60)}:${String(Math.floor(st.durationSec % 60)).padStart(2, "0")})` : "";
          consoleLog("audio", `[DECK ${id}] Loaded: ${st.title}${st.artist ? ` — ${st.artist}` : ""}${dur}`);
        } else if ((st.status === "idle" || st.status === "ended") && (prev === "playing" || prev === "paused")) {
          consoleLog("audio", `[DECK ${id}] Stopped`);
        }
      }

      // Console logging — queue length changes
      const newQLen = engine.getQueue().length;
      if (newQLen !== prevQueueLen.current) {
        if (prevQueueLen.current >= 0) consoleLog("rotation", `[QUEUE] ${newQLen} track${newQLen !== 1 ? "s" : ""} loaded`);
        prevQueueLen.current = newQLen;
      }
      // Broadcast the full queue (not just length) to pop-out windows so
      // their local engine instances can mirror it. Pop-outs are separate
      // BrowserWindows with their own JS context, so they have empty engine
      // singletons until we explicitly sync.
      (window as any).ether?.emit("ether:broadcast", {
        channel: "queue:sync",
        data: { len: newQLen, items: engine.getQueue() },
      });

      // Fire tour events
      if (id === "A" && st.filePath) window.dispatchEvent(new Event("ether:tour-deck-loaded"));
      if (st.status === "playing") window.dispatchEvent(new Event("ether:tour-deck-playing"));
      // (ON-AIR is no longer tied to playback — it reflects the real Icecast stream
      // status via StreamStatusContext; the GlobalOnAirBadge starts/stops the stream.)

      // Play logging — fires on every transition into "playing" on a music deck
      const prevStatus = lastLoggedStatus.current[id];
      if (st.status === 'playing' && prevStatus !== 'playing') {
        const cfg = deckConfigsRef.current.find(c => c.slot === id);
        // Log any on-air PROGRAM deck. Default to logging when there's no config (not yet
        // loaded / station mismatch); only skip explicit mic/guest/video. The old strict
        // `cfg?.type === 'music'` gate silently dropped logging whenever configs weren't ready.
        const nonProgram = cfg ? (cfg.type === 'mic' || cfg.type === 'guest' || cfg.type === 'video') : false;
        if (!nonProgram && st.title) {
          // Item 10 Phase 2 Step 4: in daemon-driven mode the daemon writes the play log
          // (survives a UI/app restart) — the renderer must not also log (double-log). The
          // now-playing emits below stay in the app (Step 7).
          if (!engine.isDaemonDriven) logPlay(st.title, st.artist || '', id, undefined, stationId, st.filePath).catch(e => console.error('Log write error:', e));
          try { (window as any).ether.emit("iris:nowplaying", { title: st.title, artist: st.artist || '' }); } catch {}
          try {
            const file_key = st.filePath ? st.filePath.replace(/\\/g, '/').split('/').pop() : '';
            if (file_key) (window as any).ether.emit("playout:track-started", { file_key, filePath: st.filePath || '', title: st.title, artist: st.artist || '', start_at: Date.now() });
          } catch {}
        }
      }
      lastLoggedStatus.current[id] = st.status;
    });
    return () => { if (autoStartTimer) clearTimeout(autoStartTimer); unsub(); };
  }, [accountSignedIn, wasOnAir]);   // re-run when the account gate opens OR wasOnAir resolves (crash-only auto-resume)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const lastDeckStatus: Record<string, string> = {};

    const requestSave = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const queue = engine.getQueue();
          const dA = engine.getDeck('A')?.getState();
          await execute("UPDATE crash_recovery SET queue_json=?, deck_a_path=?, deck_a_title=?, deck_a_artist=?, deck_a_position=?, was_playing=?, saved_at=unixepoch() WHERE id=1",
            [JSON.stringify(queue), dA?.filePath || null, dA?.title || null, dA?.artist || null, dA?.positionSec || 0, dA?.status === 'playing' ? 1 : 0]);
        } catch (e) { console.error('[crash_recovery] autosave failed:', e); }
        timer = null;
      }, 250);
    };

    window.addEventListener('ether:queue-changed', requestSave);

    const unsub = engine.on((id, st) => {
      if (lastDeckStatus[id] !== st.status) {
        lastDeckStatus[id] = st.status;
        requestSave();
      }
    });

    const fallback = setInterval(requestSave, 30000);

    return () => {
      window.removeEventListener('ether:queue-changed', requestSave);
      unsub?.();
      clearInterval(fallback);
      if (timer) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const row = await queryOne<{queue_json: string, deck_a_path: string | null, deck_a_title: string | null, deck_a_artist: string | null, deck_a_position: number | null, was_playing: number, saved_at: number}>("SELECT * FROM crash_recovery WHERE id=1");
        if (!row || !row.saved_at) return;
        if (Date.now() / 1000 - row.saved_at > 3600) return;
        const queue: { filePath: string; title: string; artist: string; durationMs?: number }[] = JSON.parse(row.queue_json || '[]');
        // Only restore the saved queue in MANUAL. In AUTO the generated_schedule is the single
        // source — the startup timer loads it from now — so restoring last session's queue here
        // would mix stale/non-scheduled songs into the plan (queue ≠ calendar). Skip it.
        if (queue.length > 0 && !autoAdv) {
          // Enrich any queue items missing durationMs from the songs table
          const paths = queue.filter(i => !i.durationMs).map(i => i.filePath);
          if (paths.length > 0) {
            const placeholders = paths.map(() => '?').join(',');
            const rows = await query<{ file_path: string; duration_ms: number | null }>(
              `SELECT file_path, duration_ms FROM songs WHERE file_path IN (${placeholders})`, paths
            );
            const durMap = new Map(rows.map(r => [r.file_path, r.duration_ms ?? 0]));
            for (const item of queue) {
              if (!item.durationMs) item.durationMs = durMap.get(item.filePath) ?? 0;
            }
          }
          engine.addToQueue(queue); setQueueLen(queue.length); console.log('Restored', queue.length, 'items from crash recovery');
        }
        // When AUTO is on, the startup timer loads from schedule instead — skip deck A restore
        if (autoAdv === false && row.deck_a_path && row.deck_a_title) {   // D3: UNKNOWN (null) must not act like MANUAL
          const deckASong = await queryOne<{ duration_ms: number | null }>(
            "SELECT duration_ms FROM songs WHERE file_path = ?", [row.deck_a_path]
          );
          const deckADurationMs = deckASong?.duration_ms ?? 0;
          await engine.loadToDeck('A', row.deck_a_path, row.deck_a_title, row.deck_a_artist || '', undefined, deckADurationMs);
          console.log('Restored deck A:', row.deck_a_title);
          setTimeout(() => engine.triggerPreload(), 1000);
          setRestoreInfo({ title: row.deck_a_title, position: row.deck_a_position || 0, queueLen: queue.length, savedAt: row.saved_at });
        }
        await execute("UPDATE crash_recovery SET queue_json='[]', deck_a_path=NULL, was_playing=0, saved_at=0 WHERE id=1", []);
      } catch (e) { console.error('Crash restore failed:', e); }
    })();
  }, []);

  useEffect(() => {
    if (autoAdv) invoke("watchdog_set", { active: true, thresholdSec: 10.0 }).catch(() => {});
    else invoke("watchdog_set", { active: false, thresholdSec: 10.0 }).catch(() => {});
  }, [autoAdv]);

  useEffect(() => {
    const unlisten = listen("dead-air-detected", async (event) => {
      console.warn("Dead air detected after", event.payload, "seconds - recovering...");
      const q = engine.getQueue();
      if (q.length > 0) {
        const next = q[0]; engine.clearQueue(); engine.addToQueue(q.slice(1));
        await engine.loadToDeck('A', next.filePath, next.title, next.artist, next.gainDb, next.durationMs);
        engine.getDeck('A')?.play();
        setTimeout(() => engine.triggerPreload(), 1000);
        window.dispatchEvent(new CustomEvent('ether:queue-changed'));
      } else if (autoAdv) {
        await fillQueueFromSchedule().then(async (count) => {
          if (count === 0) {
            // Dead-air recovery fallback — stay ON FORMAT (rotation-eligible + on-format
            // categories + current daypart), NEVER a raw whole-library pull. This was the
            // last unguarded path that could drop seasonal songs (Christmas) into the queue.
            const fmt = await getFormatCategoryIds(stationId);
            const drHour = new Date().getHours();
            const catClause = fmt.length ? `AND s.category_id IN (${fmt.map(() => "?").join(",")})` : "";
            const rows = await queryScoped<SongRow>(
              `SELECT s.*, a.name as artist_name FROM songs s LEFT JOIN artists a ON a.id = s.artist_id
               WHERE s.file_path IS NOT NULL AND (s.rotation_status IS NULL OR s.rotation_status != 'inactive')
               AND (s.content_class IS NULL OR s.content_class = 'MUSIC')
                 AND ((s.daypart_mask >> ?) & 1) = 1 ${catClause}
               ORDER BY RANDOM() LIMIT 100`,
              fmt.length ? [drHour, ...fmt] : [drHour], stationId, { skipScoping: true });
            engine.addToQueue(rows.filter(s => s.file_path).map(s => ({ filePath: s.file_path!, title: s.title, artist: s.artist_name || "", durationMs: s.duration_ms ?? 0 })));
          }
          const q2 = engine.getQueue();
          if (q2.length > 0) {
            const next = q2[0]; engine.clearQueue(); engine.addToQueue(q2.slice(1));
            await engine.loadToDeck('A', next.filePath, next.title, next.artist, next.gainDb, next.durationMs);
            engine.getDeck('A')?.play();
            setTimeout(() => engine.triggerPreload(), 1000);
            window.dispatchEvent(new CustomEvent('ether:queue-changed'));
          }
        });
      }
    });
    return () => { unlisten.then(f => f()); };
  }, [autoAdv]);

  const handleOutputChange = (deviceId: string) => { setOutputDevice(deviceId); engine.setOutputDevice(deviceId); };
  const handleInputChange = (deviceId: string) => { setInputDevice(deviceId); };

  // ── ABSOLUTE AUTOMATION COMMANDS (2026-08-03) ──────────────────────────────────────────────────
  // The press IS the state. These NEVER read autoAdv / observedAutomation / the pill. The label was
  // stuck on MANUAL while the daemon was provably _started, and because the old toggle computed
  // `!autoAdv` it could ONLY ever send START — there was no way for the operator to stop automation
  // from the board. A control whose meaning depends on a display that can lie is not a control.
  const stopAutomation = async () => {
    autoCmdRef.current = { value: false, until: Date.now() + 4000 };   // hold MANUAL until confirmed
    setAutoAdv(false);                        // optimistic; observation corrects it once it works
    engine.autoAdvance = false;
    engine.continuous = false; setContinuous(false);
    writeAutoAdv(stationId, false);           // stored PREFERENCE only — never a trigger
    // Manual-mode contract: stop DECIDING, not stop the engine. The current song finishes; nothing
    // advances after it, no spots, no jingles, no top-of-hour.
    if (engine.isDaemonDriven) await (engine as any).stopDaemonAutomation?.();
  };
  // AUTO toggles: pressing it while it reads AUTO STOPS automation, otherwise it ENGAGES. Each branch
  // then sends an ABSOLUTE command (never `!label` arithmetic passed down to the daemon).
  const toggleAuto = async () => { if (autoAdv === true) await stopAutomation(); else await runEngage(); };
  const runEngage = async () => {
    autoCmdRef.current = { value: true, until: Date.now() + 4000 };    // hold AUTO until confirmed
    const n = true;
    setAutoAdv(n);
    engine.autoAdvance = n;
    writeAutoAdv(stationId, n);
    if (n) {
      engine.init(); engine.continuous = true; setContinuous(true); engine.shuffle = false; setShuffle(false);
      await engine.awaitDaemonReady?.();  // settle daemon-vs-local before starting (avoid the race)
      // Nothing scheduled for now? Ask before auto-populating — never silently live-pick over the plan.
      try {
        const nowTs = Math.floor(Date.now() / 1000);
        const sched = await (window as any).ether.invoke("schedule:get", nowTs - 300, nowTs + 7200);
        const hasSchedule = Array.isArray(sched?.data) && sched.data.length > 0;
        if (!hasSchedule) {
          const populate = window.confirm("Nothing is scheduled to play right now.\n\nAuto-populate the queue with rotation-eligible songs?\n\nOK = Yes    ·    Cancel = No (open the Scheduler and generate a schedule)");
          if (!populate) {
            setAutoAdv(false); engine.autoAdvance = false;
            writeAutoAdv(stationId, false);
            setPanel("calendar");   // send them to the Scheduler to build it
            return;
          }
        }
      } catch {}
      // daemon-driven → hand the whole fill+play+advance to the daemon.
      if (engine.isDaemonDriven) { (engine as any).queueClearPending?.(); await engine.startDaemonAutomation("operator"); return; }
      resetScheduleCursor(stationId);
      engine.clearQueue?.();   // the schedule is the source — always (re)load from the now-scheduled song,
      {                         // never inherit a stale queue from a prior session that has to "catch up"
        const count = await fillQueueFromSchedule();
        if (count === 0) {
          // Continuous refill → guarded scheduler (never a raw whole-library pull).
          engine.setRefillCallback(async () => { await fillQueueFromSchedule(); return []; });
          // One-time emergency seed when the scheduler found nothing: pull rotation-eligible
          // songs restricted to the ON-FORMAT category universe + current daypart — never the
          // whole library (that leaked seasonal categories like Christmas). Empty is better
          // than off-format; the guarded refill above keeps retrying.
          const fmt = await getFormatCategoryIds(stationId);
          const seedHour = new Date().getHours();
          const catClause = fmt.length ? `AND s.category_id IN (${fmt.map(() => "?").join(",")})` : "";
          const rows = await queryScoped<SongRow>(
            `SELECT s.*, a.name as artist_name FROM songs s LEFT JOIN artists a ON a.id = s.artist_id
             WHERE s.file_path IS NOT NULL AND (s.rotation_status IS NULL OR s.rotation_status != 'inactive')
               AND (s.content_class IS NULL OR s.content_class = 'MUSIC')
               AND ((s.daypart_mask >> ?) & 1) = 1 ${catClause}
             ORDER BY RANDOM() LIMIT 100`,
            fmt.length ? [seedHour, ...fmt] : [seedHour], stationId, { skipScoping: true });
          const items = rows.filter(s => s.file_path).map(s => ({ filePath: s.file_path!, title: s.title, artist: s.artist_name || "", durationMs: s.duration_ms ?? 0 }));
          engine.addToQueue(items); setQueueLen(items.length);
          window.dispatchEvent(new CustomEvent('ether:queue-changed'));
        }
      }
      const q = engine.getQueue();
      if (q.length > 0 && engine.getDeck('A')?.getState().status !== 'playing') {
        const first = q[0]; engine.clearQueue(); engine.addToQueue(q.slice(1)); setQueueLen(engine.getQueue().length);
        await engine.loadToDeck('A', first.filePath, first.title, first.artist, first.gainDb, first.durationMs);
        engine.getDeck('A')?.play();
        setTimeout(() => engine.triggerPreload(), 800);
        window.dispatchEvent(new CustomEvent('ether:queue-changed'));
      }
    } else { engine.continuous = false; setContinuous(false); if (engine.isDaemonDriven) engine.stopDaemonAutomation(); }
  };

  const toggleShuffle = () => { const n = !shuffle; setShuffle(n); engine.shuffle = n; };

  // A/B/C = load the song onto that exact deck. If the deck is on air, leave it alone — never
  // override the playing song. (Q below appends to the bottom of the queue.)
  const loadDeck = useCallback(async (deckId: "A" | "B" | "C", s: SongRow) => {
    const fail = (text: string) => { setDeckLoadMsg({ text, err: true }); setTimeout(() => setDeckLoadMsg(m => (m && m.text === text ? null : m)), 6000); };
    if (!s.file_path) { fail(`Can't load "${s.title}" — no file on record`); return; }
    // Command-path station scoping: resolve the ACTIVE station's engine fresh at call time (getEngine
    // froze to station 1 under a useCallback that closed over render-0 engine — see VU cross-talk).
    const engine = getEngine(stationId);
    if (engine.getDeck(deckId).getState().status === "playing") return; // don't kill what's on air
    // Slice B — loud refusal: resolve the SAME way the cue editor does (local-first → R2-by-file_key),
    // so an R2-only library song loads onto the deck instead of dying silently; on failure, SAY WHY.
    // The resolve is off the deck-load hot path (it's a manual button), so it may fetch from the cloud.
    let filePath = s.file_path;
    setDeckLoadMsg({ text: `Loading "${s.title}" onto ${deckId}…`, err: false });
    try {
      const r = await (window as any).ether.invoke("audio:resolve-local-path", s.file_path);
      if (!r?.ok || !r.filePath) {
        fail(`Can't load "${s.title}" — ${r?.error === 'no local file, no file_key' ? 'unavailable, needs re-import' : (r?.error || 'file not on this machine')}`);
        return;
      }
      filePath = r.filePath;
    } catch { /* resolver unreachable — proceed with the raw path; the engine surfaces its own error */ }
    if (engine.isDaemonDriven) {
      engine.deckCue(deckId, { filePath, title: s.title, artist: s.artist_name || "", durationMs: s.duration_ms ?? 0 });
    } else {
      engine.loadToDeck(deckId, filePath, s.title, s.artist_name || "", 0, s.duration_ms ?? 0);
    }
    setDeckLoadMsg(null);   // success — clear the Loading… note
    window.dispatchEvent(new CustomEvent('ether:queue-changed'));
    if (s.id && !s.intro_end) autoCueSong(s.id, s.file_path).catch(() => {});
  }, [stationId]);
  const loadA = useCallback((s: SongRow) => loadDeck("A", s), [loadDeck]);
  const loadB = useCallback((s: SongRow) => loadDeck("B", s), [loadDeck]);
  const loadC = useCallback((s: SongRow) => loadDeck("C", s), [loadDeck]);
  const [autoSilenceTrim, setAutoSilenceTrim] = useState(() => {
    try { return localStorage.getItem("ether_auto_silence_trim") !== "false"; } catch { return true; }
  });
  const addToQueue = useCallback((s: SongRow) => {
    if (s.file_path) {
      // Command-path station scoping: resolve the ACTIVE station's engine fresh (see loadDeck).
      const engine = getEngine(stationId);
      engine.addToQueue([{ filePath: s.file_path, title: s.title, artist: s.artist_name || "", introEnd: s.intro_end ?? undefined, outroStart: s.outro_start ?? undefined, durationMs: s.duration_ms ?? 0 } as any]);
      setQueueLen(engine.getQueue().length);
      window.dispatchEvent(new CustomEvent('ether:queue-changed'));
      // Auto-detect cue points in background if not set
      if (autoSilenceTrim && s.id && !s.intro_end) {
        autoCueSong(s.id, s.file_path).catch(() => {});
      }
    }
  }, [autoSilenceTrim, stationId]);

  const canvasEngine = useCanvasEngine();
  const updater = useUpdater();
  const { showTour, dismissTour } = useTour();
  const [sessionEditing, setSessionEditing] = useState(false);
  // Canvas mode — only true when user explicitly activates custom layout
  const [useCanvas, setUseCanvas] = useState(false);
  const [visiblePanels, setVisiblePanels] = useState<Record<string, boolean>>({
    queue: true, deckA: true, deckB: true, deckC: true, mic: true,
    clock: false, history: false, cartwall: false,
  });
  const toggleVisible = (key: string) => setVisiblePanels((p: Record<string, boolean>) => ({ ...p, [key]: !p[key] }));
  const { skinId, setSkin } = useSkin();
  const captions = useCaptions();
  const [showShortcuts, setShowShortcuts] = useState(false);

  const [skinPickerPos, setSkinPickerPos] = useState<{ x: number; y: number } | null>(null);

  const handleContextMenu = (_e: React.MouseEvent) => {
    // Global right-click context menu removed — Theme Studio and Reset Layout moved to ≡ menu
  };

  const resetLayout = () => { window.location.reload(); };

  const nowPlayingDeck = [deckA, deckB, deckC].find(d => d?.status === "playing");
  // Clock accent follows the on-air deck's color (A red / B blue / C green), teal when idle.
  const nowPlayingDeckColor =
    deckA?.status === "playing" ? "var(--deck-a)" :
    deckB?.status === "playing" ? "var(--deck-b)" :
    deckC?.status === "playing" ? "var(--deck-c)" :
    "var(--accent-cyan)";
  const nowPlayingTitle = nowPlayingDeck?.title || "";
  const nowPlayingStr = nowPlayingDeck
    ? `${nowPlayingDeck.title}${nowPlayingDeck.artist ? ` by ${nowPlayingDeck.artist}` : ""}`
    : "";
  const anyDeckPlaying = [deckA, deckB, deckC].some(d => d?.status === "playing");

  // Broadcast the engine's ACTUAL playing track so views (e.g. the Calendar day view) can
  // highlight what's really on air. scheduledAt is the exact generated_schedule row identity
  // (single source) — the calendar matches on it, no text/clock guessing.
  useEffect(() => {
    const scheduledAt = nowPlayingDeck ? (engine as any).getDeckSched?.(nowPlayingDeck.id) : undefined;
    window.dispatchEvent(new CustomEvent("ether:now-playing", { detail: { title: nowPlayingDeck?.title || "", artist: nowPlayingDeck?.artist || "", scheduledAt } }));
  }, [nowPlayingDeck?.title, nowPlayingDeck?.artist, nowPlayingDeck?.id]);

  const handleStationSwitch = async (id: number, name: string): Promise<boolean> => {
    const r = await (window as any).ether.stations.switch(id);
    if (!r?.ok) return false;
    window.dispatchEvent(new CustomEvent("station-switched", { detail: { id, name } }));
    setStationName(name);
    setSwitchToast(`Switched to ${name}`);
    setTimeout(() => setSwitchToast(""), 3000);
    return true;
  };

  // Slice 2: this machine's identity (machine_id = client_identity.client_id), fetched once. Tags the
  // now-playing report so the backend knows WHICH machine is sourcing each mount.
  useEffect(() => {
    (window as any).ether?.identity?.get?.()
      .then((r: any) => { if (r?.ok && r.machine_id) machineIdRef.current = r.machine_id; })
      .catch(() => { /* not in electron / not seeded — source attribution stays null */ });
  }, []);

  // Slice 2: mirror the existing per-station stream:status events (the same ones the on-air badge uses)
  // into a per-station live + last-error cache. live drives source-machine attribution (this machine is
  // the source only while its stream is live); error captures the last stream failure (e.g. a 403) + when.
  useEffect(() => {
    const ether = (window as any).ether;
    if (!ether?.on) return;
    const h = ether.on("stream:status", (s: any) => {
      if (!s || s.stationId == null) return;
      const cur = streamStatusRef.current.get(s.stationId) || { live: false, lastError: null, lastErrorAt: null };
      const next = { ...cur, live: !!s.live };
      if (s.error) {
        next.lastError = String(s.error); next.lastErrorAt = Date.now();   // record the newest failure
      } else if (s.live) {
        next.lastError = null; next.lastErrorAt = null;                    // clear-on-recovery: a confirmed-live status retires the sticky error so the web-remote banner can't outlive the condition
      }
      streamStatusRef.current.set(s.stationId, next);
    });
    return () => { try { ether.off?.("stream:status", h); } catch { /* ignore */ } };
  }, []);

  // JINGLES overlay: subscribe to the daemon's overlay state for the ACTIVE station. SCHEDULED/ARMED/FIRING
  // set the per-deck indicator (grey/white/yellow) + seam chip; CLEARED/ARMED_CANCELLED retire it. Observed only.
  useEffect(() => {
    const au = (window as any).ether?.audio;
    if (!au?.onJingle) return;
    const h = au.onJingle((m: any) => {
      if (!m || m.stationUuid !== stationUuid) return;
      if (m.state === "CLEARED" || m.state === "ARMED_CANCELLED") setJingleOverlay(null);
      else setJingleOverlay({ deck: m.deck ?? null, state: m.state, title: m.title ?? null, contentClass: m.contentClass ?? "JIN", jinDurSec: m.jinDurSec ?? null });
    });
    return () => { try { au.offJingle?.(h); } catch { /* ignore */ } };
  }, [stationUuid]);

  // Discoverability: check whether the active station has any jingle pool (re-checked when leaving Settings
  // so creating one hides the "Set up jingles →" affordance). Read-only, best-effort.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await (window as any).ether?.jingleCategories?.list(stationId);
        if (alive) setHasJinglePool(((r?.rows || []) as any[]).length > 0);
      } catch { if (alive) setHasJinglePool(true); }   // on error, don't nag
    })();
    return () => { alive = false; };
  }, [stationId, panel]);

  // Public listener page: forward live now-playing to MAIN on a heartbeat; main owns the
  // single /api/now-playing poster (4.4.54). This effect runs in EVERY renderer window
  // (main + popouts), so it must NOT POST to the backend directly — that produced a
  // last-write-wins ping-pong on the single backend row and a ghost track that never aired.
  // Instead each window forwards its per-station payloads to main over 'nowplaying:state';
  // main accepts them ONLY from the elected primary window and runs the one dedup+keepalive
  // POST loop. Reads LIVE engine state (not React deck snapshots) so playing/title can't
  // latch a stale handoff-gap value, and any transient self-corrects within one tick. The
  // local companion + metadata fan-out stay on the per-track cadence (effect below) so
  // Icecast/Shoutcast pushes aren't re-fired every tick.
  useEffect(() => {
    const push = async () => {
      // Publish now-playing for EVERY running station's engine (not just the active one) so all
      // concurrently-streaming stations keep a fresh cloud now-playing and their listener cards show
      // live art. Previously only the active station reported, so background stations went stale within
      // 5 min and their cards blanked. The active station also drives the Iris live-wire below.
      let stationsMeta: { id: number; uuid: string | null; name: string | null }[] = [];
      try { stationsMeta = await query<{ id: number; uuid: string | null; name: string | null }>("SELECT id, uuid, name FROM stations WHERE uuid IS NOT NULL"); } catch { /* ignore */ }
      const engines = getAllEngines();
      for (const st of stationsMeta) {
      if (!st.uuid) continue;
      const eng = engines.get(st.id);
      if (!eng) continue; // no running engine for this station on this machine
      const ss = streamStatusRef.current.get(st.id) || { live: false, lastError: null, lastErrorAt: null };
      const payload = buildNowPlayingPayload(eng, st.name || "", st.uuid,
        { machineId: machineIdRef.current, live: ss.live, lastError: ss.lastError, lastErrorAt: ss.lastErrorAt });
      // Iris live wire (L1): push consolidated state to main every heartbeat so the
      // assistant producer has fresh now-playing + back-time + up-next. Fires every
      // tick (position is excluded from the backend dedup signature below), so Iris's
      // back-timing stays current. Reuses this payload — the only path-independent
      // source of position/duration/queue is the renderer engine.
      if (st.id === stationId) try {
        (window as any).ether?.emit?.("iris:state", {
          stationId,
          playing: payload.playing,
          nowPlaying: payload.playing
            ? { deck: payload.deck, title: payload.title, artist: payload.artist,
                positionSec: payload.position, durationSec: payload.duration }
            : null,
          decks: payload.decks,
          upNext: payload.queue,
          ts: Date.now(),
        });
      } catch { /* main not ready / not in electron — ignore */ }
      // Content class of the on-air item (cached by filePath). Imaging/commercials get NO music-store art.
      payload.content_class = await resolveContentClass(payload.filePath);
      // Embedded cover art → R2 public (primary listener artwork), MUSIC ONLY. For JIN/SWP/SPOT leave art_url
      // null so the listener never runs an external artwork lookup (that pulled explicit third-party art for a
      // jingle whose filename matched a band). B2 will set art_url from a local pool/spot image.
      if (!["JIN", "SWP", "SPOT"].includes(payload.content_class || "")) {
        try { payload.art_url = (await (window as any).ether?.station?.nowPlayingArt?.(st.uuid, payload.filePath)) || null; } catch { /* ignore */ }
      }
      // Forward this station's payload to main (payload carries station_uuid). Main is the ONLY
      // backend poster now: it accepts 'nowplaying:state' from the elected primary window only, then
      // runs the single dedup + 20s keepalive + [NOWPLAY] POST loop. No backend fetch here (4.4.54).
      // GATE: publish ONLY when THIS machine is the LIVE SOURCE of the mount (ss.live). A non-source engine
      // (idle/standby, or a second install whose operator is on another station) must not post a blank
      // now-playing for a uuid another machine is airing — that idle keepalive clobbered the airing row and
      // flickered Open Format off-air. HalloVeen/Magical Forest never collided; this makes OF behave the same.
      if (ss.live) try { (window as any).ether?.emit?.("nowplaying:state", payload); } catch { /* main not ready / not in electron */ }
      }
    };
    push();
    const hb = setInterval(push, 3000);
    return () => clearInterval(hb);
  }, [engine, stationName, stationUuid]);

  // Local companion + NowPlaying pop-out + stream metadata fan-out: fire once per
  // track change (keeps Icecast/Shoutcast on a per-song cadence). Also reads live
  // engine state so the pop-out and metadata targets stay consistent with the
  // public page.
  useEffect(() => {
    const payload = buildNowPlayingPayload(engine, stationName, stationUuid);
    invoke("set_now_playing", { data: JSON.stringify(payload) }).catch(() => {});
    if (payload.playing) {
      emit("now-playing-update", {
        title:       payload.title || "",
        artist:      payload.artist || "",
        positionSec: payload.position,
        durationSec: payload.duration,
        isPlaying:   true,
        upcoming:    payload.queue,
        // filePath rides along so the now-playing display can resolve artwork by content class.
        // Without it that window cannot tell a commercial from a song and ran a music-store
        // lookup on every spot title. A hand-picked field bag that drops the one field the
        // receiver needs is the same shape as the 4.4.132 relay bug — forward it.
        filePath:    payload.filePath || null,
      }).catch(() => {});
    }
  }, [deckA?.status === "playing" ? deckA?.title : null, deckB?.status === "playing" ? deckB?.title : null, deckC?.status === "playing" ? deckC?.title : null, stationName, stationUuid]);

  // Tell the engine which music decks are enabled, so auto-advance only
  // rotates through them. If a deck the user disabled is currently playing
  // (e.g. they just turned it off in Configure Decks), pause it.
  useEffect(() => {
    const activeMusicSlots: ("A" | "B" | "C")[] = enabledDecks
      .filter(c => c.type === "music" && (c.slot === "A" || c.slot === "B" || c.slot === "C"))
      .map(c => c.slot as "A" | "B" | "C");

    if (typeof (engine as any).setActiveDecks === "function") {
      (engine as any).setActiveDecks(activeMusicSlots);
    }

    // Pause any music deck not in the active set
    (["A", "B", "C"] as const).forEach(slot => {
      if (activeMusicSlots.includes(slot)) return;
      const d = engine.getDeck(slot);
      const st = d?.getState?.();
      if (st?.status === "playing") {
        try { d?.pause(); } catch {}
      }
    });
  }, [enabledDecks]);

  // Wrap pre-main-UI screens in the error boundary so a crash shows an error, not a blank screen
  if (!splashDone) return <EtherErrorBoundary><SplashScreen onDone={() => setSplashDone(true)} /></EtherErrorBoundary>;
  // Sign-in gate — the account sign-in screen is ALWAYS the first screen, until an account is signed
  // in THIS session. No persisted onboarding flag, existing profile, or library can bypass it.
  // accountSignedIn resets every launch and is set true only by: completing sign-in
  // (handleWizardComplete), an unattended on-air recovery, or the app's own continuation
  // self-relaunch (so the app's relaunches can't loop the user back to sign-in). Only AFTER an
  // account session exists does the PIN profile picker (UserLogin) render.
  if (firstRunChecked && !accountSignedIn) return <EtherErrorBoundary><OnboardingFlow forceAuth onComplete={handleWizardComplete} /></EtherErrorBoundary>;
  if (!currentUser) return <EtherErrorBoundary><UserLogin onLogin={(u) => {
    // THE DIVIDING LINE (D1): auth is complete only after account sign-in AND the PIN. The marker used to
    // sit on setAccountSignedIn alone, so the PIN step — the LAST gate — never marked it, and the boot map
    // had no post-auth side at all.
    bootSeq("PIN accepted — profile selected");
    bootSeq("ACCOUNT SIGN-IN complete — PIN still required");
    setCurrentUser(u);
  }} /></EtherErrorBoundary>;
  if (!shiftStarted) return <EtherErrorBoundary><OnShiftScreen onStart={() => { setShiftStarted(true); }} /></EtherErrorBoundary>;

  // Bottom-toolbar view tabs — rendered inline on wide screens, collapsed into a
  // bottom-right hamburger menu on tablet/narrow widths (viewport.bottomCollapsed).
  const viewTabs = [
    // JUKEBOX — fullscreen public takeover (docs/jukebox-mode-design-2026-08-04.md). Slice 1 is the
    // room; the PIN gate on entry/exit is Slice 2, so this door is deliberately plain for now.
    { label: "JUKEBOX",    active: jukeboxOpen,                fn: () => setJukeboxOpen(true) },
    { label: "DECKS",      active: showDeckConfig,             fn: () => { setPanel("live"); setShowDeckConfig(true); } },
    // CARTS is SUPPRESSED when a deck slot is already configured as a cart wall — LivePanel's
    // `cartOpen` (App.tsx ~4119) refuses to open the push-up in that case, deliberately, so you don't
    // get two cart walls. The button still toggled its state, so it looked dead. Say so instead:
    // dimmed, with a tooltip naming the reason.
    { label: "CARTS",      active: showCarts,                  fn: () => { setShowCarts(s => !s); setProgPanel(null); },
      suppressed: !!deckConfigs?.some(d => d.type === "cart" && d.enabled),
      title: deckConfigs?.some(d => d.type === "cart" && d.enabled)
        ? "A deck slot is already set to Cart Wall, so the push-up stays closed — change that slot in DECKS to use the push-up instead."
        : "Show/hide the cart push-up" },
    { label: "SHOWS",      active: progPanel === "shows",      fn: () => { setPanel("live"); setShowCarts(false); setProgPanel(p => p === "shows" ? null : "shows"); } },
    { label: "CLOCKS",     active: progPanel === "clocks",     fn: () => { setPanel("live"); setShowCarts(false); setProgPanel(p => p === "clocks" ? null : "clocks"); } },
    { label: "CATEGORIES", active: progPanel === "categories", fn: () => { setPanel("live"); setShowCarts(false); setProgPanel(p => p === "categories" ? null : "categories"); } },
    { label: "JINGLES",    active: progPanel === "jingles",    fn: () => { setPanel("live"); setShowCarts(false); setProgPanel(p => p === "jingles" ? null : "jingles"); } },
    { label: "SPOTS",      active: panel === "spots",          fn: () => { setShowCarts(false); setProgPanel(null); setPanel("spots"); } },
    { label: "LIBRARY",    active: progPanel === "library",    fn: () => { setPanel("live"); setShowCarts(false); setProgPanel(p => p === "library" ? null : "library"); } },
    { label: "CALENDAR",   active: progPanel === "calendar",   fn: () => { setPanel("live"); setShowCarts(false); setProgPanel(p => p === "calendar" ? null : "calendar"); } },
    { label: "PHONE",      active: progPanel === "phone",      fn: () => { setPanel("live"); setShowCarts(false); setProgPanel(p => p === "phone" ? null : "phone"); } },
  ] as const;

  return (
    <StreamStatusProvider>
    <MidiProvider>
    <AudioEngineProvider>
    <EtherErrorBoundary>
    <div className="h-screen flex flex-col" onContextMenu={handleContextMenu} style={{ background: "var(--bg-primary)", color: "var(--text-primary)", fontFamily: "'Inter', system-ui, sans-serif" }}>
      <KeyboardHelp />
      {/* Jukebox takeover — inside AudioEngineProvider so it uses the SAME engine and station context
          the operator is running. Everything else stays mounted beneath it. */}
      {jukeboxOpen && <Jukebox onExit={() => setJukeboxOpen(false)} />}
      <TrialGate />
      <IrisBadge open={irisOpen} onClose={() => setIrisOpen(false)} />{/* Iris chat panel — opened by the bottom-bar IRIS button (contract: docs/iris-ether-contract.md) */}
      <SchedulerHealthHost />{/* Movable Scheduler Health panel — opened from Tools */}

      {/* ── Header — 3-column grid (1fr | clock | 1fr) keeps the clock mathematically centered ── */}
      <header style={{ height: viewport.isTablet ? 48 : 56, display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center", padding: "0 12px", background: "var(--bg-secondary)", borderBottom: "1px solid rgba(255,255,255,0.04)", flexShrink: 0, position: "relative" as const, zIndex: 200 }}>

        {/* LEFT zone: show name + search (search shrinks/clips; never reaches the centered clock) */}
        <div style={{ display: "flex", alignItems: "center", minWidth: 0, alignSelf: "stretch" }}>

        {/* On-air show name — top-left (only when a show is on air; no "ETHER" fallback). Click returns to Mixer. */}
        {headerShow && (
          <div
            onClick={() => setPanel("live")}
            title={`On air: ${headerShow}`}
            style={{ display: "flex", alignItems: "center", flexShrink: 0, cursor: "pointer", padding: "0 18px 0 6px" }}
          >
            <span style={{ fontSize: 18, fontWeight: 800, letterSpacing: "0.14em", color: headerShowColor || "var(--accent-cyan)", textTransform: "uppercase", whiteSpace: "nowrap" }}>
              {headerShow}
            </span>
          </div>
        )}

        {/* LEFT: Search — shrinks to yield space to the clock; becomes icon-only at <800px */}
        <div style={{ display: "flex", alignSelf: "stretch", flexShrink: 1, minWidth: 0, zIndex: 1 }}>
          {viewport.searchW > 0 ? (
            <div style={{ width: "100%", maxWidth: viewport.searchW, minWidth: 0, position: "relative" as const, display: "flex", flexDirection: "column" as const, transition: "max-width 0.18s ease" }}>
              <JockStrip deckA={deckA} deckB={deckB} dropDown externalSearch={globalSearch} onSearchChange={setGlobalSearch} />
            </div>
          ) : (
            <button
              onClick={() => { setPanel("library"); }}
              title="Search library"
              style={{ width: 48, height: 44, alignSelf: "center", marginLeft: 4, borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
            >
              <svg width="18" height="18" viewBox="0 0 14 14" fill="none">
                <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M9.5 9.5L12.5 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
          )}
        </div>
        </div>{/* LEFT zone close */}

        {/* CENTER: Clock — grid-centered; click to return to the dashboard (Mixer) */}
        <div onClick={() => setPanel("live")} title="Back to dashboard" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, whiteSpace: "nowrap" as const, padding: "0 12px", cursor: "pointer" }}>
          <ClockDisplay size={viewport.clockSize} accentColor={nowPlayingDeckColor} />
        </div>

        {/* RIGHT: Status + Pro + Admin + ☰ menu + ON AIR */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end", minWidth: 0, zIndex: 1 }}>
          {videoLive && panel !== "videostudio" && (
            <button
              onClick={() => setPanel("videostudio")}
              title="Video engine is live — click to return to Video Studio"
              style={{ height: 28, padding: "0 10px", borderRadius: 0, background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.4)", color: "#22c55e", fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, animation: "rec-pulse 2s ease-in-out infinite" }}
            >
              <svg width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="#22c55e"/></svg>
              VIDEO LIVE
            </button>
          )}
          {!requirePlan("station", currentPlan as PlanTier) && (
            <button onClick={() => setPanel("subscription")} title={currentPlan === "free" ? "Upgrade your plan" : "Your plan: Studio — see plans"} style={{ height: 44, padding: viewport.medium ? "0 12px" : "0 16px", borderRadius: 0, background: "#7c3aed", border: "none", color: "#fff", cursor: "pointer", fontSize: 14, fontWeight: 700, letterSpacing: "0.06em", display: "flex", alignItems: "center", gap: 6 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
              {!viewport.medium && (currentPlan === "free" ? "Upgrade" : "Studio")}
            </button>
          )}
          {devToolsEnabled && (
            <button
              onClick={() => { window.location.hash = "#debug"; }}
              title="Open Dev Panel (tier override + dev tools)"
              style={{ height: 44, padding: "0 12px", borderRadius: 0, background: "#f59e0b", border: "none", color: "#1a1a22", cursor: "pointer", fontSize: 12, fontWeight: 800, letterSpacing: "0.08em", fontFamily: "'DM Mono', ui-monospace, monospace" }}
            >
              DEV
            </button>
          )}
          <button onClick={() => setCurrentUser(null)} title={currentUser?.name || "Account"} style={{ width: 44, height: 44, borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
          </button>

          {/* AUTO / MANUAL toggle — sits next to On-Air. AUTO = automated rotation (fill+play+advance);
              MANUAL = operator drives the decks. Wired to the existing toggleAuto (also Alt/Cmd-A). */}
          <button
            data-tour="auto-btn"
            onClick={() => { toggleAuto(); }}
            title={autoAdv === true
              ? "Automation is ON — click to switch to MANUAL (you control the decks)"
              : autoAdv === null
                ? "Waiting for the engine to report its automation state — click to engage AUTO"
                : "MANUAL mode — click to switch to AUTO (automated rotation)"}
            style={{
              height: 44, padding: "0 20px", borderRadius: 0, cursor: "pointer",
              fontSize: 16, fontWeight: 800, letterSpacing: "0.08em",
              background: autoAdv === true ? "#10b981" : "var(--bg-tertiary)",
              color: "#fff",
              border: autoAdv === true ? "1px solid #10b981" : autoAdv === null ? "1px dashed var(--border-primary)" : "1px solid var(--border-primary)",
              transition: "all 0.15s",
              display: "flex", alignItems: "center", gap: 7,
            }}
          >
            {/* D3: three states — but the CONTROL always names itself. Replacing the label with
                "— UNKNOWN" erased the operator's AUTO button from the board (it was still there and
                still clickable, which is worse: a control you cannot recognise). Unknown is carried by
                the dashed border + "?", never by taking the word AUTO away. */}
            {autoAdv === true ? "● AUTO" : autoAdv === null ? "AUTO ?" : "MANUAL"}
          </button>

          <GlobalOnAirBadge
            stationId={stationId}
            onGoLive={() => { goLive(stationId); }}
            onStopLive={() => { stopLive(stationId); }}
            style={{ height: 44, padding: "0 20px", fontSize: 16, fontWeight: 800, letterSpacing: "0.08em" }}
          />

          {/* ☰ Menu button — far right */}
          <button
            onClick={() => setDrawerOpen(d => !d)}
            title="Menu"
            style={{
              width: 44, height: 44, borderRadius: 0, cursor: "pointer",
              background: drawerOpen ? "var(--bg-tertiary)" : "transparent",
              border: `1px solid ${drawerOpen ? "var(--border-primary)" : "transparent"}`,
              color: drawerOpen ? "var(--text-primary)" : "var(--text-secondary)",
              display: "flex", alignItems: "center", justifyContent: "center",
              transition: "all 0.15s",
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "var(--bg-tertiary)"; (e.currentTarget as HTMLElement).style.borderColor = "var(--border-primary)"; (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
            onMouseLeave={e => {
              if (!drawerOpen) { (e.currentTarget as HTMLElement).style.background = "transparent"; (e.currentTarget as HTMLElement).style.borderColor = "transparent"; (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)"; }
            }}
          >
            <svg width="20" height="16" viewBox="0 0 14 11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <line x1="0" y1="1" x2="14" y2="1"/>
              <line x1="0" y1="5.5" x2="14" y2="5.5"/>
              <line x1="0" y1="10" x2="14" y2="10"/>
            </svg>
          </button>
        </div>

        {/* ── Slide-out Drawer ── */}
        {drawerOpen && (
          <>
            <style>{`@keyframes ether-drawer-in { from { transform: translateX(100%); } to { transform: translateX(0); } }`}</style>
            {/* Backdrop */}
            <div
              onClick={() => setDrawerOpen(false)}
              style={{ position: "fixed", inset: 0, zIndex: 490, background: "rgba(0,0,0,0.45)", backdropFilter: "blur(1px)" }}
            />
            {/* Panel */}
            <div style={{
              position: "fixed", top: 0, right: 0, bottom: 0, width: 250, zIndex: 491,
              background: "var(--bg-secondary)",
              borderLeft: "1px solid var(--border-primary)",
              display: "flex", flexDirection: "column",
              boxShadow: "-12px 0 40px rgba(0,0,0,0.4)",
              animation: "ether-drawer-in 0.18s cubic-bezier(0.25,0.46,0.45,0.94) both",
              fontFamily: "var(--font-ui, 'Inter', sans-serif)",
            }}>
              {/* Drawer header */}
              <div style={{ height: 52, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 14px", borderBottom: "1px solid var(--border-primary)", flexShrink: 0, background: "var(--bg-tertiary)" }}>
                <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: "0.14em", color: "var(--text-tertiary)", textTransform: "uppercase" as const }}>Menu</div>
                <button
                  onClick={() => setDrawerOpen(false)}
                  title="Close (Esc)"
                  aria-label="Close menu"
                  style={{
                    width: 36, height: 36,
                    background: "var(--bg-primary)",
                    border: "1px solid var(--border-secondary)",
                    color: "#ffffff",
                    cursor: "pointer",
                    borderRadius: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    transition: "all 0.12s ease",
                    flexShrink: 0,
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "#ef4444"; (e.currentTarget as HTMLElement).style.borderColor = "#ef4444"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "var(--bg-primary)"; (e.currentTarget as HTMLElement).style.borderColor = "var(--border-secondary)"; }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <line x1="5" y1="5" x2="19" y2="19"/>
                    <line x1="19" y1="5" x2="5" y2="19"/>
                  </svg>
                </button>
              </div>

              {/* Drawer body */}
              <div style={{ flex: 1, overflowY: "auto", padding: "10px 0 16px" }}>

                {/* ── NAVIGATE ── */}
                <div style={{ padding: "6px 16px 8px", fontSize: 13, fontWeight: 800, letterSpacing: "0.14em", color: "var(--text-tertiary)" }}>NAVIGATE</div>
                {panel !== "live" && (
                  <button
                    onClick={() => { setPanel("live"); setDrawerOpen(false); }}
                    style={{
                      display: "flex", alignItems: "center", gap: 11, width: "100%",
                      padding: "10px 16px", background: "transparent",
                      border: "none", borderLeft: "3px solid var(--accent-cyan)",
                      color: "var(--accent-cyan)",
                      fontSize: 13, fontWeight: 700,
                      cursor: "pointer", textAlign: "left" as const, transition: "background 0.1s",
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "var(--bg-tertiary)"; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                  >
                    <span style={{ fontSize: 15, lineHeight: 1 }}>🎚️</span>
                    <span style={{ flex: 1 }}>Return to Mixer</span>
                  </button>
                )}
                {([
                  { key: "library",    emoji: "🎵", label: "Library",     action: () => setPanel("library"),     active: panel === "library"     },
                  { key: "schedule",       emoji: "📋", label: "Schedule",     action: () => setPanel("clocks"),          active: panel === "clocks"          },
                  { key: "schedulebuilder", emoji: "🗓", label: "Program Log",  action: () => setPanel("schedulebuilder"), active: panel === "schedulebuilder" },
                  { key: "calendar",       emoji: "📅", label: "Calendar",     action: () => setPanel("calendar"),        active: panel === "calendar"        },
                  { key: "programlog",     emoji: "📜", label: "Play History", action: () => setPanel("programlog"),      active: panel === "programlog"      },
                  { key: "cartwall",   emoji: "🎛️", label: "Carts",       action: () => setPanel("cartwall"),    active: panel === "cartwall"    },
                ] as const).map(item => (
                  <button
                    key={item.key}
                    onClick={() => drawerClick(item.key, item.action)}
                    style={{
                      display: "flex", alignItems: "center", gap: 11, width: "100%",
                      padding: "10px 16px", background: item.active ? "rgb(from var(--accent-blue) r g b / 0.08)" : "transparent",
                      border: "none",
                      borderLeft: `3px solid ${item.active ? "var(--accent-cyan)" : "transparent"}`,
                      color: item.active ? "var(--accent-cyan)" : "var(--text-secondary)",
                      fontSize: 13, fontWeight: (drawerUsage[item.key] || 0) >= 3 ? 700 : 500,
                      cursor: "pointer", textAlign: "left" as const, transition: "background 0.1s",
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "var(--bg-tertiary)"; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = item.active ? "rgb(from var(--accent-blue) r g b / 0.08)" : "transparent"; }}
                  >
                    <span style={{ fontSize: 15, lineHeight: 1 }}>{item.emoji}</span>
                    <span style={{ flex: 1 }}>{item.label}</span>
                    {(drawerUsage[item.key] || 0) >= 3 && <span style={{ fontSize: 12, fontWeight: 800, color: "var(--accent-cyan)", opacity: 0.7 }}>★</span>}
                  </button>
                ))}

                <div style={{ height: 1, background: "var(--border-primary)", margin: "10px 16px" }} />

                {/* ── WINDOWS ── */}
                <div style={{ padding: "12px 16px 8px", fontSize: 13, fontWeight: 800, letterSpacing: "0.14em", color: "var(--text-tertiary)" }}>WINDOWS</div>
                <button
                  onClick={() => drawerClick("desk", openDeskWindow)}
                  style={{ display: "flex", alignItems: "center", gap: 11, width: "100%", padding: "10px 16px", background: "transparent", border: "none", borderLeft: "3px solid transparent", color: "var(--text-secondary)", fontSize: 13, fontWeight: (drawerUsage["desk"] || 0) >= 3 ? 700 : 500, cursor: "pointer", textAlign: "left" as const, transition: "background 0.1s" }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "var(--bg-tertiary)"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                  <span style={{ flex: 1 }}>Desk</span>
                  {(drawerUsage["desk"] || 0) >= 3 && <span style={{ fontSize: 12, fontWeight: 800, color: "var(--accent-cyan)", opacity: 0.7 }}>★</span>}
                </button>
                <button
                  onClick={() => drawerClick("nowplaying", () => setNpPickerOpen(true))}
                  style={{ display: "flex", alignItems: "center", gap: 11, width: "100%", padding: "10px 16px", background: "transparent", border: "none", borderLeft: "3px solid transparent", color: "var(--text-secondary)", fontSize: 13, fontWeight: (drawerUsage["nowplaying"] || 0) >= 3 ? 700 : 500, cursor: "pointer", textAlign: "left" as const, transition: "background 0.1s" }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "var(--bg-tertiary)"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
                  <span style={{ flex: 1 }}>Now Playing</span>
                  {(drawerUsage["nowplaying"] || 0) >= 3 && <span style={{ fontSize: 12, fontWeight: 800, color: "var(--accent-cyan)", opacity: 0.7 }}>★</span>}
                </button>
                <button
                  onClick={() => drawerClick("phone", () => openPopout("phone"))}
                  title="Open Phone in a separate window"
                  style={{ display: "flex", alignItems: "center", gap: 11, width: "100%", padding: "10px 16px", background: "transparent", border: "none", borderLeft: "3px solid transparent", color: "var(--text-secondary)", fontSize: 13, fontWeight: (drawerUsage["phone"] || 0) >= 3 ? 700 : 500, cursor: "pointer", textAlign: "left" as const, transition: "background 0.1s" }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "var(--bg-tertiary)"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.61 3.35 2 2 0 0 1 3.6 1h3a2 2 0 0 1 2 1.72c.127.96.36 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.6a16 16 0 0 0 6 6l.91-.91a2 2 0 0 1 2.11-.45c.907.34 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                  <span style={{ flex: 1 }}>Phone</span>
                  {(drawerUsage["phone"] || 0) >= 3 && <span style={{ fontSize: 12, fontWeight: 800, color: "var(--accent-cyan)", opacity: 0.7 }}>★</span>}
                </button>

                {/* Pop-out windows for every bottom-toolbar feature — drag to another monitor */}
                {([
                  { key: "po-videostudio",label: "Show+",      panel: "videostudio" },
                  { key: "po-studiopro",  label: "Show+ DAW",  panel: "studiopro" },
                  { key: "po-decks",      label: "Decks",      panel: "decks" },
                  { key: "po-carts",      label: "Carts",      panel: "carts" },
                  { key: "po-shows",      label: "Shows",      panel: "shows" },
                  { key: "po-clocks",     label: "Clocks",     panel: "clocks" },
                  { key: "po-categories", label: "Categories", panel: "categories" },
                  { key: "po-library",    label: "Library",    panel: "library" },
                  { key: "po-calendar",   label: "Calendar",   panel: "calendar" },
                ] as const).map(item => (
                  <button
                    key={item.key}
                    onClick={() => drawerClick(item.key, () => openPopout(item.panel))}
                    title={`Open ${item.label} in a separate window`}
                    style={{ display: "flex", alignItems: "center", gap: 11, width: "100%", padding: "10px 16px", background: "transparent", border: "none", borderLeft: "3px solid transparent", color: "var(--text-secondary)", fontSize: 13, fontWeight: (drawerUsage[item.key] || 0) >= 3 ? 700 : 500, cursor: "pointer", textAlign: "left" as const, transition: "background 0.1s" }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "var(--bg-tertiary)"; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6"/><path d="M10 14L21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
                    <span style={{ flex: 1 }}>{item.label}</span>
                    {(drawerUsage[item.key] || 0) >= 3 && <span style={{ fontSize: 12, fontWeight: 800, color: "var(--accent-cyan)", opacity: 0.7 }}>★</span>}
                  </button>
                ))}

                <button
                  onClick={() => { drawerClick("captions", () => setPanel("captions")); }}
                  style={{ display: "flex", alignItems: "center", gap: 11, width: "100%", padding: "10px 16px", background: panel === "captions" ? "rgba(0,200,168,0.08)" : "transparent", border: "none", borderLeft: `3px solid ${panel === "captions" ? "#00c8a8" : "transparent"}`, color: panel === "captions" ? "#00c8a8" : "var(--text-secondary)", fontSize: 13, fontWeight: 500, cursor: "pointer", textAlign: "left" as const, transition: "background 0.1s" }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "var(--bg-tertiary)"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = panel === "captions" ? "rgba(0,200,168,0.08)" : "transparent"; }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="10" rx="2"/><path d="M7 11h2m2 0h2m2 0h2"/></svg>
                  <span style={{ flex: 1 }}>Live Captions</span>
                  {captions.enabled && <span style={{ fontSize: 9, fontWeight: 900, color: "#00c8a8", letterSpacing: "0.08em" }}>●</span>}
                </button>

                {/* ── Divider ── */}
                <div style={{ height: 1, background: "var(--border-primary)", margin: "10px 16px" }} />

                {/* ── APPEARANCE ── */}
                <button
                  onClick={() => { setSkinPickerPos({ x: 0, y: 0 }); setDrawerOpen(false); }}
                  style={{ display: "flex", alignItems: "center", gap: 11, width: "100%", padding: "10px 16px", background: "transparent", border: "none", borderLeft: "3px solid transparent", color: "var(--text-secondary)", fontSize: 13, fontWeight: 500, cursor: "pointer", textAlign: "left" as const, transition: "background 0.1s" }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "var(--bg-tertiary)"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="13.5" cy="6.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="17.5" cy="10.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="8.5" cy="7.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="6.5" cy="12.5" r="1.5" fill="currentColor" stroke="none"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg>
                  <span style={{ flex: 1 }}>Theme Studio</span>
                </button>
                <button
                  onClick={() => { resetLayout(); setDrawerOpen(false); }}
                  style={{ display: "flex", alignItems: "center", gap: 11, width: "100%", padding: "10px 16px", background: "transparent", border: "none", borderLeft: "3px solid transparent", color: "var(--text-secondary)", fontSize: 13, fontWeight: 500, cursor: "pointer", textAlign: "left" as const, transition: "background 0.1s" }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "var(--bg-tertiary)"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.95"/></svg>
                  <span style={{ flex: 1 }}>Reset Layout</span>
                </button>

              </div>
            </div>
          </>
        )}
</header>

      {/* Hidden-deck warning removed — disabled decks now auto-pause */}

      {/* ── Main ── */}
      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <main style={{ flex: 1, overflow: "hidden", padding: ((panel as string) === "videostudio" || panel === "clipeditor") ? 0 : 16, display: "flex", flexDirection: "column" }}>
          {panel === "live" && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, position: "relative" as const }}>
              {useCanvas ? (
                <WidgetCanvas
                  canvasEngine={canvasEngine}
                  deckStates={{ A: deckA, B: deckB, C: deckC }}
                  audioEngine={engine}
                />
              ) : (
                <LivePanel
                  deckA={deckA} deckB={deckB} deckC={deckC}
                  jingleOverlay={jingleOverlay}
                  hasJinglePool={hasJinglePool}
                  onOpenJingleSettings={() => { setPanel("live"); setShowCarts(false); setProgPanel("jingles"); }}
                  onCloseDock={() => setProgPanel(null)}
                  autoAdv={autoAdv} shuffle={shuffle}
                  toggleAuto={toggleAuto} toggleShuffle={toggleShuffle}
                  queueLen={queueLen} showCarts={showCarts}
                  toggleCarts={() => { setShowCarts(!showCarts); setProgPanel(null); }}
                  progPanel={progPanel}
                  inputDevice={inputDevice}
                  visiblePanels={visiblePanels}
                  deckConfigs={visibleEnabledDecks}
                  onConfigureDecks={() => setShowDeckConfig(true)}
                  autoSilenceTrim={autoSilenceTrim}
                  setAutoSilenceTrim={v => { setAutoSilenceTrim(v); localStorage.setItem("ether_auto_silence_trim", String(v)); }}
                  xfadeDuration={xfadeDuration}
                  setXfadeDuration={setXfadeDuration}
                  globalSearch={globalSearch}
                  setGlobalSearch={setGlobalSearch}
                  nowPlaying={nowPlayingStr || undefined}
                  toolsCollapsed={toolsCollapsed}
                  toggleToolsCollapsed={toggleToolsCollapsed}
                  autoXfade={autoXfade}
                  setAutoXfade={(v) => { setAutoXfade(v); engine.outroCrossfade = v; }}
                  onOpenCarts={() => setPanel("cartwall")}
                  libraryDock={<LibraryPanel onLoadA={loadA} onLoadB={loadB} onLoadC={loadC} onQueue={addToQueue} onEdit={(s) => { setEditSong(s); setPanel("trackedit"); }} onSendToStudio={(s) => { try { (window as any).ether.invoke("studio:push-track", { filePath: s.file_path, title: s.title, artist: s.artist_name || "", duration_ms: s.duration_ms }); } catch { /* not in electron */ } }} />}
                />
              )}
            </div>
          )}
          {panel !== "live" && (panel as string) !== "videostudio" && panel !== "clipeditor" && (
            <div style={{ flex: 1, overflowY: "auto" }}>
              {panel === "library" && <LibraryPanel onLoadA={loadA} onLoadB={loadB} onLoadC={loadC} onQueue={addToQueue} onEdit={(s) => { setEditSong(s); setPanel("trackedit"); }} onSendToStudio={(s) => { try { (window as any).ether.invoke("studio:push-track", { filePath: s.file_path, title: s.title, artist: s.artist_name || "", duration_ms: s.duration_ms }); } catch { /* not in electron */ } }} />}
              {panel === "clocks" && <Scheduler defaultTab={schedulerTab} />}
              {panel === "programlog" && <PlayLog onClose={() => setPanel("live")} />}
              {panel === "schedulebuilder" && <ProgramLog onClose={() => setPanel("live")} />}
              {/* Show+ DAW is no longer an inline takeover — it opens as its own pop-out window
                  (WINDOWS → Show+ DAW / Tools → Show+ DAW → window:popout "studiopro"). Single
                  production surface; the main dashboard stays live. */}
              {panel === "broadcasteditor" && (
                <BroadcastEditor
                  onBouncePlace={() => setPanel("library")}
                  onOpenCueEditor={(fp) => { setEditSong({ file_path: fp, title: fp.split(/[\/]/).pop()?.replace(/\.[^.]+$/, "") || "Track" }); setPanel("trackedit"); }}
                />
              )}
              {panel === "logs" && <Logs />}
              {panel === "eas" && <EASLogbook onClose={() => setPanel("live")} />}
              {panel === "pdpicks" && <PDPicks stationId={stationId} onClose={() => setPanel("live")} />}
              {panel === "schedpreview" && <SchedulePreview onClose={() => setPanel("live")} />}
              {panel === "reasons" && <SchedulerReasons onClose={() => setPanel("live")} />}
              {panel === "vtinbox" && <VoiceTrackInbox onClose={() => setPanel("live")} />}

              {panel === "gselector" && <GSelectorImport onClose={() => setPanel("live")} />}
              {panel === "help" && <HelpPanel onClose={() => setPanel("live")} />}
              {panel === "spots" && <Spots />}
              {panel === "streaming" && <StreamManager />}
              {panel === "announce" && <Announcements />}
              {panel === "voicetrack" && <VoiceTracker inputDeviceId={inputDevice || undefined} />}
              {panel === "showprep" && <ShowPrep onGoLive={() => setPanel("live")} />}
              {panel === "settings" && <SettingsPanel key={stationId} xfadeDuration={xfadeDuration} setXfadeDuration={setXfadeDuration} segueOverlap={segueOverlap} setSegueOverlap={setSegueOverlap} />}
              {panel === "trackedit" && <TrackEditor song={editSong} onClose={() => setPanel("library")} onSaved={(s) => { setEditSong(s); }} />}
              {panel === "phonedesk" && <PhoneDesk onClose={() => setPanel("live")} />}
              {panel === "subscription" && <SubscriptionPanel />}
              {panel === "autocue" && <AutoCue onClose={() => setPanel("live")} />}
              {panel === "health" && <HealthMonitor onClose={() => setPanel("live")} />}
              {panel === "analytics" && (
                <PlanGate requires="pro" feature="Listener Analytics">
                  <ListenerAnalytics onClose={() => setPanel("live")} />
                </PlanGate>
              )}
              {panel === "cloudbackup" && (
                <PlanGate requires="pro" feature="Cloud Log Backup">
                  <CloudBackup />
                </PlanGate>
              )}
              {panel === "multioutput" && (
                <PlanGate requires="pro" feature="Multi-Output Audio Routing">
                  <AudioRoutingScreen />
                </PlanGate>
              )}
              {panel === "stationmanager" && (
                <PlanGate requires="station" feature="Multi-Station Console">
                  <StationManager onStationSwitch={handleStationSwitch} />
                </PlanGate>
              )}
              {panel === "managedevices" && (
                <ManageDevices />
              )}
              {panel === "smartschedule" && (
                <SmartScheduler onClose={() => setPanel("live")} />
              )}
              {panel === "calendar" && (
                <BroadcastCalendar onShowClick={() => { setPanel("clocks"); setSchedulerTab("shows"); }} />
              )}
              {panel === "cartwall" && (
                <div style={{ height: "100%", background: "var(--bg-secondary)", borderRadius: 0, border: "1px solid var(--border-primary)", overflow: "hidden" }}>
                  <CartWallPanel onClose={() => setPanel("live")} />
                </div>
              )}
              {panel === "playlist" && (
                <div style={{ height: "100%", background: "var(--bg-secondary)", borderRadius: 0, border: "1px solid var(--border-primary)", overflow: "hidden" }}>
                  <PlaylistPanel onClose={() => setPanel("live")} />
                </div>
              )}
              {panel === "macros" && <MacrosPanel />}
              {panel === "midi" && <MidiSettingsPanel />}
              {panel === "importlibrary" && (
                <LibraryImport onClose={() => setPanel("live")} />
              )}
              {panel === "spotifyimport" && (
                <SpotifyImport onClose={() => setPanel("library")} />
              )}
            </div>
          )}
          {/* VideoStudio is always mounted so WebRTC state stays alive.
              Camera only opens when active — see Studio.tsx HostCamera. */}
          <div style={{ display: panel === "videostudio" ? "flex" : "none", flex: 1, minHeight: 0 }}>
            <VideoStudio active={panel === "videostudio"} />
          </div>
          {panel === "clipeditor" && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
              <ClipEditor />
            </div>
          )}
          {panel === "captions" && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden", padding: 16 }}>
              <CaptionsLogPanel
                lines={captions.lines}
                enabled={captions.enabled}
                status={captions.status}
                toggle={captions.toggle}
              />
            </div>
          )}
          <DMCANotice />
        </main>
      </div>

      {/* AppContextMenu removed — items moved to ≡ drawer */}
      {panel === "videostudio" && <CaptionsOverlay lines={captions.lines} enabled={captions.enabled} status={captions.status} />}

      {skinPickerPos && (
        <SkinPickerOverlay
          currentSkin={skinId} x={skinPickerPos.x} y={skinPickerPos.y}
          onSelect={setSkin}
          onClose={() => setSkinPickerPos(null)}
        />
      )}

      {/* ── Keyboard Shortcut Overlay ── */}
      {showShortcuts && (
        <div onClick={() => setShowShortcuts(false)} style={{
          position: "fixed", inset: 0, zIndex: 9999,
          background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: "'Inter', system-ui, sans-serif",
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            background: "var(--bg-secondary)", border: "1px solid var(--border-secondary)",
            borderRadius: 0, padding: "28px 32px", width: 560, maxHeight: "80vh", overflowY: "auto",
            boxShadow: "0 32px 80px rgba(0,0,0,0.6)",
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
              <div style={{ fontFamily: "'Inter', sans-serif", fontSize: 18, fontWeight: 800, color: "var(--text-primary)", letterSpacing: "-0.02em" }}>Keyboard Shortcuts</div>
              <button onClick={() => setShowShortcuts(false)} style={{ background: "transparent", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 18, lineHeight: 1 }}>✕</button>
            </div>
            {[
              { group: "Playback", items: [
                { key: "Space", desc: "Play / Pause Deck A" },
                { key: "B", desc: "Play / Pause Deck B" },
                { key: "X", desc: "Crossfade to next loaded deck" },
                { key: "Esc", desc: "Stop all decks" },
              ]},
              { group: "Navigation", items: [
                { key: "N", desc: "Live Assist view" },
                { key: "L", desc: "Library" },
                { key: "S", desc: "Schedule / Clocks" },
                { key: "G", desc: "Program Log" },
                { key: "A", desc: "Toggle Automation" },
              ]},
              { group: "Interface", items: [
                { key: "Shift + ?", desc: "Toggle this shortcut overlay" },
                { key: "≡ Menu", desc: "Theme Studio & Reset Layout" },
              ]},
            ].map(({ group, items }) => (
              <div key={group} style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: "0.16em", color: "var(--text-tertiary)", textTransform: "uppercase" as const, marginBottom: 10 }}>{group}</div>
                <div style={{ display: "flex", flexDirection: "column" as const, gap: 2 }}>
                  {items.map(({ key, desc }) => (
                    <div key={key} style={{ display: "flex", alignItems: "center", gap: 12, padding: "7px 10px", borderRadius: 0, background: "var(--bg-tertiary)" }}>
                      <kbd style={{
                        fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 13, fontWeight: 700,
                        background: "var(--bg-primary)", color: "var(--accent-cyan)",
                        border: "1px solid var(--border-secondary)", borderRadius: 0,
                        padding: "3px 8px", whiteSpace: "nowrap" as const, flexShrink: 0,
                        minWidth: 80, textAlign: "center" as const,
                        boxShadow: "0 2px 0 var(--border-primary)",
                      }}>{key}</kbd>
                      <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{desc}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--border-primary)", fontSize: 12, color: "var(--text-tertiary)", textAlign: "center" as const }}>
              Press <kbd style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace", background: "var(--bg-tertiary)", padding: "1px 5px", borderRadius: 0, border: "1px solid var(--border-primary)" }}>Esc</kbd> or click outside to close
            </div>
          </div>
        </div>
      )}

      {!updater.dismissed && <UpdateBanner
        state={updater.state}
        onDownload={updater.download}
        onRestart={updater.restart}
        onDismiss={updater.dismiss}
      />}
      {restoreInfo && <SessionRestoreToast info={restoreInfo} onDismiss={() => setRestoreInfo(null)} />}
      {npPickerOpen && <NowPlayingStationPicker onPick={openNowPlayingFor} onClose={() => setNpPickerOpen(false)} />}
      {switchToast && (
        <div style={{ position: "fixed", bottom: 32, left: "50%", transform: "translateX(-50%)", zIndex: 9999, background: "rgba(30,30,40,0.97)", border: "1px solid rgb(from var(--accent-blue) r g b / 0.4)", color: "var(--accent-blue)", padding: "9px 20px", fontSize: 13, fontWeight: 600, fontFamily: "'Inter', system-ui, sans-serif", pointerEvents: "none" }}>
          {switchToast}
        </div>
      )}
      {deckLoadMsg && (
        <div style={{ position: "fixed", bottom: 72, left: "50%", transform: "translateX(-50%)", zIndex: 9999, background: "rgba(30,30,40,0.97)", border: `1px solid ${deckLoadMsg.err ? "rgba(224,64,64,0.5)" : "rgb(from var(--accent-blue) r g b / 0.4)"}`, color: deckLoadMsg.err ? "#ff6b6b" : "var(--accent-blue)", padding: "9px 20px", fontSize: 13, fontWeight: 600, fontFamily: "'Inter', system-ui, sans-serif", pointerEvents: "none" }}>
          {deckLoadMsg.text}
        </div>
      )}
      <LibrarySyncProgressBar />
      <CloudInstallPrompt />
      {showAbout && <AboutPanel onClose={() => setShowAbout(false)} />}
      {showTour && <OnboardingTour onDone={dismissTour} />}
      {/* ── Footer ── */}
      <footer style={{ height: 52, display: "flex", alignItems: "center", padding: "0 10px", gap: 0, background: "var(--bg-secondary)", borderTop: "1px solid var(--border-primary)", flexShrink: 0 }}>
        {/* Station switcher — moved here from the header */}
        <ActiveStationBadge onManage={() => setPanel("stationmanager")} onSwitch={handleStationSwitch} />
        <div style={{ width: 1, height: 24, background: "var(--border-primary)", margin: "0 8px" }} />
        {/* NOMINAL health indicator — same height as tabs */}
        <HealthStatusDot onClick={() => setPanel("health")} height={36} />
        {/* CLEAR — two honest verbs (Log-Reader Flip §3.2): Reset to schedule (re-sync + re-cue idle
            decks from the log) / Clear & regenerate (rewrite forward rows; the in-progress hour is
            spared). Never a silent clock-refill. */}
        {queueLen > 0 && (
          <div style={{ position: "relative", marginLeft: 6, marginRight: 2 }}>
            <button
              onClick={() => setClearMenuOpen(o => !o)}
              title="Reset or regenerate the log"
              style={{ height: 36, padding: "0 12px", borderRadius: 0, border: `1px solid ${clearMenuOpen ? "#ef4444" : "var(--border-primary)"}`, background: "transparent", color: clearMenuOpen ? "#ef4444" : "var(--text-tertiary)", fontSize: 11, fontWeight: 800, letterSpacing: "0.1em", cursor: "pointer" }}
              onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = "#ef4444"}
              onMouseLeave={e => { if (!clearMenuOpen) (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}
            >CLEAR ▾</button>
            {clearMenuOpen && (
              <>
                <div onClick={() => setClearMenuOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 299 }} />
                <div style={{ position: "absolute", bottom: "calc(100% + 4px)", left: 0, minWidth: 230, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", zIndex: 300, boxShadow: "0 10px 30px rgba(0,0,0,0.55)" }}>
                  <button
                    onClick={() => { setClearMenuOpen(false); if (engine.isDaemonDriven) (engine as any).queueClearPending?.(); else engine.clearQueue?.(); window.dispatchEvent(new CustomEvent('ether:queue-changed')); }}
                    style={{ display: "block", width: "100%", textAlign: "left", padding: "9px 12px", background: "transparent", border: "none", borderBottom: "1px solid var(--border-primary)", color: "var(--text-primary)", cursor: "pointer" }}
                    onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)"}
                    onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "transparent"}
                  >
                    <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.04em" }}>Reset to schedule</div>
                    <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 2 }}>Re-sync playout + re-cue idle decks from the log</div>
                  </button>
                  <button
                    onClick={async () => { setClearMenuOpen(false); try { await (window as any).ether?.invoke?.("schedule:generateDay", Math.floor(Date.now() / 1000)); } catch { /* ignore */ } if (engine.isDaemonDriven) (engine as any).queueClearPending?.(); window.dispatchEvent(new CustomEvent('ether:queue-changed')); }}
                    style={{ display: "block", width: "100%", textAlign: "left", padding: "9px 12px", background: "transparent", border: "none", color: "var(--text-primary)", cursor: "pointer" }}
                    onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)"}
                    onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "transparent"}
                  >
                    <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.04em" }}>Clear &amp; regenerate</div>
                    <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 2 }}>Rewrite forward rows — the in-progress hour is spared</div>
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        {/* View tabs — inline when there's room; collapsed into a hamburger (bottom-right) on tablet */}
        {!viewport.bottomCollapsed && viewTabs.map((tab) => { const { label, active, fn } = tab;
          // A tab may declare itself SUPPRESSED — it still works, but the panel it opens is being
          // withheld by another setting. Dim it and explain why on hover, rather than let it read as
          // a dead button.
          const suppressed = !!(tab as any).suppressed;
          const tabTitle = (tab as any).title as string | undefined;
          return (
          <button key={label} onClick={fn} title={tabTitle} style={{
            height: 36, padding: "0 14px", borderRadius: 0, marginRight: 2,
            border: `1px solid ${active ? "var(--accent-cyan)" : "var(--border-secondary)"}`,
            background: active ? "color-mix(in srgb, var(--accent-cyan) 16%, transparent)" : "transparent",
            color: active ? "var(--accent-cyan)" : "var(--text-primary)",
            opacity: suppressed ? 0.4 : 1,
            fontSize: 11, fontWeight: 800, letterSpacing: "0.1em", cursor: suppressed ? "help" : "pointer",
            transition: "color 0.12s, background 0.12s, border-color 0.12s, opacity 0.12s",
          }}
            onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)"; }}
            onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
          >{label}</button>
          );
        })}
        <div style={{ flex: 1 }} />
        {/* Broadcast (profanity) delay — arm builds the cushion; bar shows buffer fill */}
        <button onClick={toggleDelay} title={delayArmed ? "Broadcast delay armed — click to disarm" : "Arm broadcast (profanity) delay"} style={{
          height: 36, padding: "0 12px", borderRadius: 0, marginRight: 2,
          border: `1px solid ${delayArmed ? "#f59e0b" : "var(--border-primary)"}`,
          background: delayArmed ? "rgba(245,158,11,0.14)" : "transparent",
          color: delayArmed ? "#f59e0b" : "var(--text-secondary)",
          fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", cursor: "pointer",
          display: "flex", alignItems: "center", gap: 7,
        }}>
          DELAY{delayArmed ? ` ${DELAY_SEC}s` : ""}
          {delayArmed && (
            <span style={{ width: 30, height: 4, background: "rgba(255,255,255,0.15)", borderRadius: 2, overflow: "hidden", display: "inline-block" }}>
              <span style={{ display: "block", height: "100%", width: `${Math.round(delayFill * 100)}%`, background: delayFill >= 1 ? "#22c55e" : "#f59e0b", transition: "width 0.4s linear" }} />
            </span>
          )}
        </button>
        {/* DUMP — active only once the delay buffer is full */}
        <button onClick={doDump} disabled={!delayArmed || delayFill < 1}
          title={!delayArmed ? "Arm the delay first" : delayFill < 1 ? "Delay still building…" : "DUMP — drop the buffered audio and splice to live"}
          style={{
            height: 36, padding: "0 14px", borderRadius: 0, marginRight: 2,
            background: (delayArmed && delayFill >= 1) ? "rgba(239,68,68,0.16)" : "transparent",
            border: `1px solid ${(delayArmed && delayFill >= 1) ? "#ef4444" : "var(--border-primary)"}`,
            color: (delayArmed && delayFill >= 1) ? "#ef4444" : "var(--text-tertiary)",
            fontSize: 11, fontWeight: 800, letterSpacing: "0.1em",
            cursor: (delayArmed && delayFill >= 1) ? "pointer" : "not-allowed",
          }}>DUMP</button>

        {/* XFADE removed 2026-08-02 — the deck ON button is the only start control. Its machinery
            (deckCrossfade → intentCrossfade → the serialized rotate) is what ON now calls. */}

        {/* IRIS — far right; the ONE purple button (Iris's brand). Standard bar rectangle; replaces the
            old floating circle. Opens exactly what the circle opened (the chat panel). */}
        <button onClick={() => setIrisOpen(o => !o)} title="Iris — your assistant producer" style={{
          height: 36, padding: "0 14px", borderRadius: 0, marginLeft: 2, flexShrink: 0,
          background: irisOpen ? "#8868D8" : "transparent",
          border: "1px solid #8868D8",
          color: irisOpen ? "#fff" : "#8868D8",
          fontSize: 11, fontWeight: 800, letterSpacing: "0.1em",
          cursor: "pointer", transition: "all 0.12s",
        }}
          onMouseEnter={e => { if (!irisOpen) (e.currentTarget as HTMLElement).style.background = "color-mix(in srgb, #8868D8 16%, transparent)"; }}
          onMouseLeave={e => { if (!irisOpen) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
        >IRIS</button>

        {/* Collapsed view-tabs → bottom-right hamburger menu (tablet/narrow) */}
        {viewport.bottomCollapsed && (
          <div style={{ position: "relative", marginLeft: 6 }}>
            <button
              onClick={() => setBottomMenuOpen(o => !o)}
              title="Menu"
              style={{
                height: 36, width: 44, borderRadius: 0,
                border: `1px solid ${bottomMenuOpen ? "var(--accent-cyan)" : "var(--border-primary)"}`,
                background: bottomMenuOpen ? "color-mix(in srgb, var(--accent-cyan) 16%, transparent)" : "transparent",
                color: bottomMenuOpen ? "var(--accent-cyan)" : "var(--text-secondary)",
                cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M3 5h12M3 9h12M3 13h12" />
              </svg>
            </button>
            {bottomMenuOpen && (
              <>
                <div onClick={() => setBottomMenuOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 300 }} />
                <div style={{
                  position: "absolute", bottom: "calc(100% + 6px)", right: 0, zIndex: 301,
                  background: "var(--bg-secondary)", border: "1px solid var(--border-primary)",
                  minWidth: 190, padding: "4px 0", boxShadow: "0 -6px 24px rgba(0,0,0,0.45)",
                }}>
                  {viewTabs.map(({ label, active, fn }) => (
                    <button
                      key={label}
                      onClick={() => { fn(); setBottomMenuOpen(false); }}
                      style={{
                        display: "block", width: "100%", textAlign: "left" as const, padding: "9px 16px",
                        background: active ? "color-mix(in srgb, var(--accent-cyan) 16%, transparent)" : "transparent",
                        color: active ? "var(--accent-cyan)" : "var(--text-primary)",
                        border: "none", fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", cursor: "pointer",
                      }}
                      onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)"; }}
                      onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                    >{label}</button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </footer>
    </div>
      {showProducerDesk && (
        <ProducerDesk
          onClose={() => setShowProducerDesk(false)}
          episodeTitle={nowPlayingTitle || undefined}
          nowPlaying={nowPlayingStr || undefined}
          nowPlayingTrack={nowPlayingDeck ? { title: nowPlayingDeck.title || "", artist: nowPlayingDeck.artist || "" } : null}
        />
      )}
      {showDeckConfig && (
        <>
          {/* Backdrop */}
          <div
            onClick={closeDeckConfig}
            style={{
              position: "fixed", inset: 0, zIndex: 800,
              background: "rgba(0,0,0,0.4)",
              opacity: deckConfigClosing ? 0 : 1,
              transition: "opacity 200ms ease-out",
            }}
          />
          <style>{`@keyframes ether-deck-drawer-in { from { transform: translateX(-100%); } to { transform: translateX(0); } }`}</style>
          {/* Sliding drawer from left */}
          <div
            style={{
              position: "fixed", top: 0, left: 0, bottom: 0,
              width: 640, zIndex: 810,
              background: "var(--bg-primary)",
              borderRight: "1px solid var(--border-primary)",
              boxShadow: "4px 0 24px rgba(0,0,0,0.5)",
              transform: deckConfigClosing ? "translateX(-100%)" : "translateX(0)",
              animation: deckConfigClosing ? "none" : "ether-deck-drawer-in 200ms ease-out",
              transition: "transform 200ms ease-out",
              overflowY: "auto",
              display: "flex", flexDirection: "column",
            }}
            onKeyDown={e => { if (e.key === "Escape") closeDeckConfig(); }}
            tabIndex={-1}
            ref={el => el?.focus()}
          >
            <DeckConfigurator
              onClose={closeDeckConfig}
              onApply={async (configs: DeckConfig[]) => { await saveDeckConfigs(configs); }}
            />
          </div>
        </>
      )}
    </EtherErrorBoundary>
    </AudioEngineProvider>
    </MidiProvider>
    <StreamStatusToast />
    </StreamStatusProvider>
  );
}

// ── Nav ──────────────────────────────────────────────────────

function MenuBar({ active, set, canvasEngine, darkMode, setDarkMode, currentPlan, currentUser, setCurrentUser, onSave, visiblePanels, toggleVisible, setVisiblePanels, onReset, setUseCanvas, onConfigureDecks, onCheckForUpdates }: {
  active: Panel;
  set: (p: Panel) => void;
  canvasEngine: any;
  darkMode: boolean;
  setDarkMode: (v: boolean) => void;
  currentPlan: string;
  currentUser: any;
  setCurrentUser: (u: any) => void;
  onSave: () => void;
  visiblePanels: Record<string, boolean>;
  toggleVisible: (key: string) => void;
  setVisiblePanels: (v: Record<string, boolean>) => void;
  onReset: () => void;
  setUseCanvas: (v: boolean) => void;
  onConfigureDecks?: () => void;
  onCheckForUpdates?: () => void;
}) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [venueType, setVenueType] = useState("radio");

  useEffect(() => {
    query<{ value: string }>("SELECT value FROM station_config_kv WHERE key = 'venue_type'")
      .then(rows => { if (rows.length > 0) setVenueType(rows[0].value); })
      .catch(() => {});
  }, []);

  // Full persona-aware labels for all 5 venue types
  const personaLabels: Record<string, Record<string, string>> = {
    radio:   { library: "Library",         spots: "Spots & Promos",   clocks: "Clocks",            logs: "Play Log",      voicetrack: "Voice Tracker", live: "Live Assist",  tools: "Tools" },
    venue:   { library: "Music Library",   spots: "Announcements",    clocks: "Event Schedule",    logs: "Activity Log",  voicetrack: "Voice Track",   live: "Live Assist",  tools: "Tools" },
    retail:  { library: "Music Library",   spots: "Store Messages",   clocks: "Playlist Schedule", logs: "Playback Log",  voicetrack: "Voice Track",   live: "Live Assist",  tools: "Tools" },
    worship: { library: "Worship Library", spots: "Ministry Audio",   clocks: "Service Schedule",  logs: "Service Log",   voicetrack: "Voice Track",   live: "Worship Mode", tools: "Tools" },
    podcast: { library: "Episode Library", spots: "Sponsorships",     clocks: "Release Schedule",  logs: "Episode Log",   voicetrack: "Podcast Studio",live: "Record Mode",  tools: "Tools" },
  };
  const L = personaLabels[venueType] || personaLabels.radio;

  const close = () => setOpenMenu(null);

  const MenuBtn = ({ id, label }: { id: string; label: string }) => (
    <button
      className={`menu-btn${openMenu === id ? " open" : ""}`}
      onMouseDown={e => { e.preventDefault(); setOpenMenu(o => o === id ? null : id); }}
      onMouseEnter={() => { if (openMenu && openMenu !== id) setOpenMenu(id); }}
    >{label}</button>
  );

  const Menu = ({ children }: { children: React.ReactNode }) => (
    <div style={{
      position: "absolute" as const, top: "calc(100% + 2px)", left: 0,
      zIndex: 10000,
      background: "var(--bg-secondary)",
      border: "1px solid var(--border-secondary)",
      borderRadius: 0, padding: "4px",
      minWidth: 220,
      boxShadow: "0 8px 32px rgba(0,0,0,0.25), 0 2px 8px rgba(0,0,0,0.15)",
      fontFamily: "'Inter', sans-serif",
    }}>{children}</div>
  );

  const Item = ({ label, shortcut, onClick, checked, separator, disabled }: {
    label?: string; shortcut?: string; onClick?: () => void;
    checked?: boolean; separator?: boolean; disabled?: boolean;
  }) => {
    const [hovered, setHovered] = useState(false);
    if (separator) return <div style={{ height: 1, background: "var(--border-primary)", margin: "3px 6px" }} />;
    return (
      <button
        disabled={disabled}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onMouseDown={e => { e.stopPropagation(); if (!disabled && onClick) { onClick(); close(); } }}
        style={{
          display: "flex", alignItems: "center", width: "100%",
          padding: "7px 10px", borderRadius: 0, border: "none",
          background: hovered && !disabled ? "rgba(255,255,255,0.07)" : "transparent",
          color: disabled ? "var(--text-tertiary)" : "var(--text-primary)",
          fontSize: 12, fontFamily: "'Inter', sans-serif",
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.45 : 1,
          textAlign: "left" as const, gap: 8,
          transition: "background 0.1s",
        }}
      >
        <span style={{ width: 14, fontSize: 12, color: "var(--accent-cyan)", flexShrink: 0 }}>
          {checked === true ? "✓" : ""}
        </span>
        <span style={{ flex: 1 }}>{label}</span>
        {shortcut && <span style={{ fontSize: 12, color: "var(--text-tertiary)", fontFamily: "'JetBrains Mono', ui-monospace, monospace", marginLeft: 12 }}>{shortcut}</span>}
      </button>
    );
  };

  // Panel visibility from canvasEngine
  const isVisible = (type: string) => canvasEngine.widgets?.some((w: any) => w.type === type) ?? false;
  const togglePanel = (type: string) => {
    if (isVisible(type)) {
      const widget = canvasEngine.widgets?.find((w: any) => w.type === type);
      if (widget) canvasEngine.removeWidget(widget.id);
    } else {
      canvasEngine.addWidget(type);
      setUseCanvas(true);
    }
  };

  const menus: Record<string, React.ReactNode> = {
    file: (
      <Menu>
        <Item label="New Session" shortcut="⌘N" onClick={() => { canvasEngine.resetLayout(); canvasEngine.renameActive("Live Assist"); setUseCanvas(false); set("live"); }} />
        <Item label="Save Layout" shortcut="⌘S" onClick={onSave} />
        <Item separator />
        <Item label="Import Music..." onClick={() => set("library")} />
        <Item separator />
        {currentUser?.role === "admin" && <Item label="Preferences" onClick={() => set("settings")} />}
      </Menu>
    ),
    view: (
      <Menu>
        <Item label="Play Queue"    checked={visiblePanels.queue}    onClick={() => toggleVisible("queue")} />
        <Item label="Deck A"        checked={visiblePanels.deckA}    onClick={() => toggleVisible("deckA")} />
        <Item label="Deck B"        checked={visiblePanels.deckB}    onClick={() => toggleVisible("deckB")} />
        <Item label="Deck C"        checked={visiblePanels.deckC}    onClick={() => toggleVisible("deckC")} />
        <Item label="Mic Deck"      checked={visiblePanels.mic}      onClick={() => toggleVisible("mic")} />
        <Item separator />
        <Item label="Program Clock" checked={visiblePanels.clock}    onClick={() => toggleVisible("clock")} />
        <Item label="Song History"  checked={visiblePanels.history}  onClick={() => toggleVisible("history")} />
        <Item label="Cart Wall"     checked={visiblePanels.cartwall} onClick={() => toggleVisible("cartwall")} />
        <Item separator />
        <Item label="Configure Decks..." onClick={() => { set("live"); onConfigureDecks?.(); }} />
        <Item label="Reset to Default" onClick={() => onReset()} />
      </Menu>
    ),
    library: (
      <Menu>
        <Item label={L.library}    onClick={() => { set("library"); }} />
        <Item label={L.spots}      onClick={() => { set("spots"); }} />
        <Item label={L.voicetrack} onClick={() => { set("voicetrack"); }} />
        <Item label="Cart Wall"    onClick={() => { set("live"); togglePanel("cartwall"); }} />
        <Item separator />
        <Item label="Import from Folder..." onClick={() => set("library")} />
        <Item label="Cue Editor"          onClick={() => set("trackedit")} />
      </Menu>
    ),
    schedule: (
      <Menu>
        <Item label={L.clocks}         onClick={() => set("clocks")} />
        <Item label="Shows & Dayparts" onClick={() => set("clocks")} />
        <Item label="Categories" onClick={() => set("clocks")} />
        <Item separator />
        <Item label="Program Log"      onClick={() => set("schedulebuilder")} />
        <Item label="Play History"     onClick={() => set("programlog")} />
        <Item label={L.logs}           onClick={() => set("logs")} />
        <Item label="EAS Logbook"      onClick={() => set("eas")} />
      </Menu>
    ),
    tools: (
      <Menu>
        {/* Production */}
        <Item label={L.voicetrack}         onClick={() => set("voicetrack")} />
        <Item label="Show+ DAW"            onClick={() => { try { (window as any).ether.invoke("window:popout", "studiopro"); } catch { /* not in electron */ } }} />
        <Item label="Show+"                onClick={() => set("videostudio")} />
        <Item label="Production Editor"    onClick={() => set("broadcasteditor")} />
        <Item label="Cue Editor"           onClick={() => set("trackedit")} />
        <Item label="Auto-Cue Library"     onClick={() => set("autocue")} />
        <Item separator />
        {/* Live tools */}
        <Item label="Clip Editor"          onClick={() => set("clipeditor")} />
        <Item label="Cart Wall"            onClick={() => set("cartwall")} />
        <Item label="Playlist Player"      onClick={() => set("playlist")} />
        <Item label="Phone Desk"           onClick={() => set("phonedesk")} />
        <Item label="Announcements"        onClick={() => set("announce")} />
        <Item label="Show Prep"            onClick={() => set("showprep")} />
        <Item separator />
        {/* Station — admin/music_director features gated by role */}
        {(currentUser?.role === "admin") && <Item label="Stream Manager"       onClick={() => set("streaming")} />}
        {(currentUser?.role === "admin" || currentUser?.role === "music_director") && <Item label="Smart Scheduler"      onClick={() => set("smartschedule")} />}
        {(currentUser?.role === "admin" || currentUser?.role === "music_director") && <Item label="Scheduler Health"     onClick={() => window.dispatchEvent(new Event("ether:open-scheduler-health"))} />}
        {(currentUser?.role === "admin") && <Item label="Listener Analytics"   onClick={() => set("analytics")} />}
        {(currentUser?.role === "admin") && <Item label="Cloud Log Backup"     onClick={() => set("cloudbackup")} />}
        {(currentUser?.role === "admin") && <Item label="Audio Routing"        onClick={() => set("multioutput")} />}
        {(currentUser?.role === "admin") && <Item label="Station Manager"      onClick={() => set("stationmanager")} />}
        {(currentUser?.role === "admin") && <Item label="Macros"               onClick={() => set("macros")} />}
        {(currentUser?.role === "admin") && <Item label="MIDI Controller"      onClick={() => set("midi")} />}
        <Item separator />
        {requirePlan("pro", currentPlan as PlanTier)
          ? <Item label="Remote Dashboard ↗"  onClick={async () => {
              try {
                await (window as any).ether.invoke("open_url", { url: `${ETHER_BACKEND_URL}/dashboard` });
              } catch { window.open(`${ETHER_BACKEND_URL}/dashboard`, "_blank"); }
            }} />
          : <Item label="🔒 Remote Dashboard"  onClick={() => window.dispatchEvent(new CustomEvent("ether:open-subscription"))} />}
        <Item label="Health Monitor"       onClick={() => set("health")} />
      </Menu>
    ),
    help: (
      <Menu>
        <Item label="Keyboard Shortcuts" shortcut="⇧?" onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "Slash", shiftKey: true }))} />
        <Item label="Documentation" onClick={() => {}} />
        <Item label="Contact Support" onClick={() => {}} />
        <Item separator />
        <Item label="Check for Updates" onClick={() => onCheckForUpdates?.()} />
        <Item separator />
        <Item label="About Ether v1.5.2" disabled />
      </Menu>
    ),
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2, position: "relative" as const }}>
      {openMenu && <div
        style={{ position: "fixed" as const, inset: 0, zIndex: 9999 }}
        onClick={close}
        onMouseDown={e => e.preventDefault()}
      />}
      {(["file","view","library","schedule","tools","help"] as const).map(id => (
        <div key={id} data-tour={id === "library" ? "nav-library" : undefined} style={{ position: "relative" as const }}>
          <MenuBtn id={id} label={id.charAt(0).toUpperCase() + id.slice(1)} />
          {openMenu === id && menus[id]}
        </div>
      ))}
    </div>
  );
}

// ── Live Panel ───────────────────────────────────────────────

// ── Drag handle icon ────────────────────────────────────────
function DragHandle({ onPointerDown }: { onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void }) {
  return (
    <div
      onPointerDown={onPointerDown}
      title="Drag to reorder panels"
      style={{
        cursor: "grab", padding: "4px 6px", borderRadius: 0, flexShrink: 0,
        color: "var(--text-tertiary)", display: "flex", alignItems: "center",
        transition: "color 0.15s, background 0.15s",
        userSelect: "none",
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)"; (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)"; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; (e.currentTarget as HTMLElement).style.background = "transparent"; }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="9" cy="5" r="1" fill="currentColor" stroke="none"/>
        <circle cx="15" cy="5" r="1" fill="currentColor" stroke="none"/>
        <circle cx="9" cy="12" r="1" fill="currentColor" stroke="none"/>
        <circle cx="15" cy="12" r="1" fill="currentColor" stroke="none"/>
        <circle cx="9" cy="19" r="1" fill="currentColor" stroke="none"/>
        <circle cx="15" cy="19" r="1" fill="currentColor" stroke="none"/>
      </svg>
    </div>
  );
}


// ── Full-page Cart Wall Panel ─────────────────────────────────
function CartWallPanel({ onClose }: { onClose: () => void }) {
  const engine = useAudioEngine();
  const KEYS = ["1","2","3","4","5","6","7","8","9","0","Q","W","E","R","T","Y","U","I","O","P","A","S","D","F"];
  const COLORS = ["#ef4444","#f97316","#fbbf24","#34d399","var(--accent-cyan)","var(--accent-blue)","#a78bfa","#ec4899","#14b8a6","#6366f1","#84cc16","#f43f5e"];

  const [carts, setCarts] = useState(() =>
    KEYS.map((k, i) => ({ key: k, label: `Cart ${i+1}`, filePath: "", color: COLORS[i % COLORS.length], playing: false }))
  );
  const [editing, setEditing] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem("ether_carts_v1");
    if (saved) try { setCarts(JSON.parse(saved)); } catch {}
  }, []);

  const save = (next: typeof carts) => { setCarts(next); localStorage.setItem("ether_carts_v1", JSON.stringify(next)); };

  const titleFromFile = (p: string) => (p.split(/[\\/]/).pop() || p).replace(/\.[^.]+$/, "").replace(/[_-]/g, " ");
  const assignCart = async (key: string) => {
    const f = await (window as any).ether.dialog.openFile({ multiple: false, title: "Select audio", filters: [{ name: "Audio", extensions: ["mp3","flac","ogg","wav","m4a","aac"] }] });
    if (!f) return;
    const fp = Array.isArray(f) ? f[0] : f;
    save(carts.map(c => c.key === key ? { ...c, filePath: fp, label: titleFromFile(fp) } : c));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing || e.target instanceof HTMLInputElement) return;
      const cart = carts.find(c => c.key === e.key.toUpperCase());
      if (cart?.filePath) fire(cart.key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [carts, editing]);

  const fire = async (key: string) => {
    const cart = carts.find(c => c.key === key);
    if (!cart?.filePath) return;
    try {
      await engine.loadToDeck("C", cart.filePath, cart.label, "");
      engine.getDeck("C")?.play();
      setCarts(p => p.map(c => c.key === key ? { ...c, playing: true } : c));
      setTimeout(() => setCarts(p => p.map(c => c.key === key ? { ...c, playing: false } : c)), 3000);
    } catch {}
  };

  const loaded = carts.filter(c => c.filePath).length;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" as const, fontFamily: "'Inter', system-ui, sans-serif" }}>
      {/* Header */}
      <div style={{ padding: "16px 20px 12px", borderBottom: "1px solid var(--border-primary)", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: "0.16em", color: "#fbbf24", textTransform: "uppercase" as const, marginBottom: 3 }}>Cart Wall</div>
          <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: "-0.03em", color: "var(--text-primary)", fontFamily: "'Inter', sans-serif" }}>Sound Effects & Stingers</div>
          <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginTop: 2 }}>{loaded}/{carts.length} slots loaded · Press key or click to fire · Drop audio to assign · Double-click to rename</div>
        </div>
        <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
      </div>

      {/* Grid */}
      <div style={{ flex: 1, padding: 16, overflowY: "auto" as const, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: 10, alignContent: "start" }}>
        {carts.map(cart => (
          <div
            key={cart.key}
            onClick={() => { if (cart.filePath) { fire(cart.key); } else { assignCart(cart.key); } }}
            onDoubleClick={() => setEditing(cart.key)}
            onDragOver={e => { e.preventDefault(); setDragOver(cart.key); }}
            onDragLeave={() => setDragOver(null)}
            onDrop={e => {
              e.preventDefault();
              const path = e.dataTransfer.getData("text/plain");
              save(carts.map(c => c.key === cart.key ? { ...c, filePath: path } : c));
              setDragOver(null);
            }}
            style={{
              padding: "12px 12px 10px",
              borderRadius: 0,
              background: cart.playing ? cart.color
                : dragOver === cart.key ? `${cart.color}20`
                : cart.filePath ? `${cart.color}12` : "var(--bg-tertiary)",
              border: `1px solid ${cart.playing ? cart.color : dragOver === cart.key ? cart.color : cart.filePath ? cart.color + "40" : "var(--border-primary)"}`,
              cursor: "pointer",
              transition: "all 0.12s",
              boxShadow: cart.playing ? `0 0 20px ${cart.color}60` : "none",
              position: "relative" as const, minHeight: 80,
              userSelect: "none" as const,
            }}
          >
            {/* Hotkey */}
            <div style={{
              position: "absolute" as const, top: 8, right: 9,
              fontSize: 12, fontWeight: 900, fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              color: cart.playing ? "rgba(0,0,0,0.6)" : cart.filePath ? cart.color : "var(--text-tertiary)",
              letterSpacing: "0.04em",
            }}>{cart.key}</div>

            {/* Playing waveform bars */}
            {cart.playing && (
              <div style={{ display: "flex", gap: 2, alignItems: "flex-end", height: 16, marginBottom: 6 }}>
                {[0.5,1,0.7,0.9,0.6,1,0.8].map((h,i) => (
                  <div key={i} style={{ flex: 1, height: `${h*100}%`, background: "rgba(0,0,0,0.45)", borderRadius: 0, animation: `on-air-breathe ${0.4 + i*0.1}s ease-in-out infinite` }} />
                ))}
              </div>
            )}

            {/* Label */}
            {editing === cart.key ? (
              <input
                autoFocus
                defaultValue={cart.label}
                onBlur={e => { save(carts.map(c => c.key === cart.key ? { ...c, label: e.target.value || c.label } : c)); setEditing(null); }}
                onKeyDown={e => { if (e.key === "Enter" || e.key === "Escape") (e.target as HTMLInputElement).blur(); }}
                onClick={e => e.stopPropagation()}
                style={{ width: "100%", background: "none", border: "none", borderBottom: "1px solid currentColor", outline: "none", fontSize: 12, fontWeight: 700, color: "inherit", padding: "2px 0" }}
              />
            ) : (
              <div style={{ fontSize: 12, fontWeight: cart.filePath ? 700 : 400, color: cart.playing ? "#000" : cart.filePath ? "var(--text-primary)" : "var(--text-tertiary)", lineHeight: 1.3, paddingRight: 18, fontStyle: cart.filePath ? "normal" : "italic" }}>
                {cart.filePath ? cart.label : "Empty slot"}
              </div>
            )}

            {!cart.filePath && !cart.playing && (
              <div style={{ marginTop: 6, fontSize: 13, color: "var(--text-tertiary)" }}>Drop audio here</div>
            )}

            {/* Clear button */}
            {cart.filePath && !cart.playing && (
              <button
                onClick={e => { e.stopPropagation(); save(carts.map(c => c.key === cart.key ? { ...c, filePath: "" } : c)); }}
                style={{ position: "absolute" as const, bottom: 6, right: 7, background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 12, opacity: 0.5, padding: 0, lineHeight: 1 }}
              >×</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Full-page Playlist Panel ───────────────────────────────────
function PlaylistPanel({ onClose }: { onClose: () => void }) {
  const engine = useAudioEngine();
  const { stationId } = useActiveStation();
  const [tracks, setTracks] = useState<any[]>([]);
  const [library, setLibrary] = useState<any[]>([]);
  const [currentIdx, setCurrentIdx] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [search, setSearch] = useState("");
  const [showLib, setShowLib] = useState(true);
  const [deckSlot, setDeckSlot] = useState("A");
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState(false);

  useEffect(() => {
    // station_id scoping: Strategy B — single table
    queryScoped<any>("SELECT id, title, artist, file_path as filePath, duration_ms as durationMs FROM songs ORDER BY artist, title LIMIT 500", [], stationId)
      .then(setLibrary).catch(() => {});
  }, [stationId]);

  const filtered = search ? library.filter(s => `${s.title} ${s.artist}`.toLowerCase().includes(search.toLowerCase())) : library;

  const addTrack = (t: any) => setTracks(p => [...p, { ...t, pid: Date.now() + Math.random() }]);
  const removeTrack = (pid: number) => setTracks(p => p.filter(t => t.pid !== pid));

  const playIdx = async (idx: number) => {
    const t = tracks[idx]; if (!t) return;
    try {
      await engine.loadToDeck(deckSlot, t.filePath, t.title, t.artist, undefined, t.durationMs);
      engine.getDeck(deckSlot)?.play();
      setCurrentIdx(idx); setPlaying(true);
    } catch {}
  };

  const next = () => {
    if (currentIdx === null || tracks.length === 0) return;
    const nextIdx = shuffle ? Math.floor(Math.random() * tracks.length) : repeat ? currentIdx : Math.min(currentIdx + 1, tracks.length - 1);
    playIdx(nextIdx);
  };

  const fmtDur = (ms: number) => { const s = Math.floor(ms/1000); return `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`; };
  const total = Math.round(tracks.reduce((s,t) => s + (t.durationMs||0), 0) / 60000);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" as const, fontFamily: "'Inter', system-ui, sans-serif" }}>
      {/* Header */}
      <div style={{ padding: "16px 20px 12px", borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: "0.16em", color: "#34d399", textTransform: "uppercase" as const, marginBottom: 3 }}>Playlist Player</div>
            <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: "-0.03em", color: "var(--text-primary)", fontFamily: "'Inter', sans-serif" }}>
              {tracks.length > 0 ? `${tracks.length} tracks · ${total} min` : "Build your playlist"}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {/* Deck selector */}
            <div style={{ display: "flex", gap: 3 }}>
              {["A","B","C"].map(s => (
                <button key={s} onClick={() => setDeckSlot(s)} style={{ width: 28, height: 28, borderRadius: 0, border: "none", background: deckSlot === s ? "var(--accent-green)" : "var(--bg-tertiary)", color: deckSlot === s ? "#000" : "var(--text-secondary)", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>{s}</button>
              ))}
            </div>
            <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
          </div>
        </div>

        {/* Transport controls */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={() => playIdx(Math.max(0, (currentIdx ?? 1) - 1))} style={{ width: 32, height: 32, borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer", fontSize: 14 }}>⏮</button>
          <button
            onClick={() => { if (playing) { engine.getDeck(deckSlot)?.pause(); setPlaying(false); } else if (currentIdx !== null) { engine.getDeck(deckSlot)?.play(); setPlaying(true); } else if (tracks.length > 0) playIdx(0); }}
            style={{ width: 44, height: 32, borderRadius: 0, background: "#34d399", border: "none", color: "#000", cursor: "pointer", fontSize: 16, fontWeight: 700 }}
          >{playing ? "⏸" : "▶"}</button>
          <button onClick={next} style={{ width: 32, height: 32, borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer", fontSize: 14 }}>⏭</button>
          <button onClick={() => setShuffle(p => !p)} style={{ height: 32, padding: "0 12px", borderRadius: 0, background: shuffle ? "rgba(52,211,153,0.1)" : "var(--bg-tertiary)", border: `1px solid ${shuffle ? "rgba(52,211,153,0.3)" : "var(--border-primary)"}`, color: shuffle ? "#34d399" : "var(--text-tertiary)", cursor: "pointer", fontSize: 13, fontWeight: 700 }}>SHUFFLE</button>
          <button onClick={() => setRepeat(p => !p)} style={{ height: 32, padding: "0 12px", borderRadius: 0, background: repeat ? "rgba(52,211,153,0.1)" : "var(--bg-tertiary)", border: `1px solid ${repeat ? "rgba(52,211,153,0.3)" : "var(--border-primary)"}`, color: repeat ? "#34d399" : "var(--text-tertiary)", cursor: "pointer", fontSize: 13, fontWeight: 700 }}>REPEAT</button>
          <button onClick={() => setTracks([])} style={{ height: 32, padding: "0 12px", borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 13, marginLeft: "auto" }}>Clear All</button>
          <button onClick={() => setShowLib(p => !p)} style={{ height: 32, padding: "0 14px", borderRadius: 0, background: showLib ? "var(--accent-cyan)" : "var(--bg-tertiary)", border: "none", color: showLib ? "#000" : "var(--text-secondary)", cursor: "pointer", fontSize: 13, fontWeight: 700 }}>
            {showLib ? "Hide Library" : "Browse Library"}
          </button>
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* Playlist */}
        <div style={{ flex: 1, overflowY: "auto" as const }}>
          {tracks.length === 0 ? (
            <div style={{ padding: "48px 20px", textAlign: "center" as const, color: "var(--text-tertiary)" }}>
              <div style={{ fontSize: 40, marginBottom: 10 }}>🎵</div>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>Your playlist is empty</div>
              <div style={{ fontSize: 12 }}>Click tracks from the library to add them</div>
            </div>
          ) : tracks.map((t, i) => (
            <div key={t.pid} onDoubleClick={() => playIdx(i)} style={{
              display: "flex", alignItems: "center", gap: 12, padding: "8px 20px",
              background: i === currentIdx ? "rgba(52,211,153,0.08)" : "none",
              borderLeft: `2px solid ${i === currentIdx ? "#34d399" : "transparent"}`,
              cursor: "default", transition: "all 0.1s",
            }}>
              <span style={{ fontSize: 13, color: "var(--text-tertiary)", fontFamily: "'JetBrains Mono', ui-monospace, monospace", width: 22, textAlign: "right" as const, flexShrink: 0 }}>
                {i === currentIdx && playing ? "▶" : i + 1}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: i === currentIdx ? 700 : 500, color: i === currentIdx ? "#34d399" : "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{t.title}</div>
                <div style={{ fontSize: 13, color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{t.artist}</div>
              </div>
              <span style={{ fontSize: 13, color: "var(--text-tertiary)", fontFamily: "'JetBrains Mono', ui-monospace, monospace", flexShrink: 0 }}>{fmtDur(t.durationMs || 0)}</span>
              <button onClick={() => removeTrack(t.pid)} style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 16, opacity: 0.4, padding: "0 2px", flexShrink: 0, lineHeight: 1 }}>×</button>
            </div>
          ))}
        </div>

        {/* Library sidebar */}
        {showLib && (
          <div style={{ width: 280, borderLeft: "1px solid var(--border-primary)", display: "flex", flexDirection: "column" as const, background: "var(--bg-secondary)" }}>
            <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}>
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search library..." style={{ width: "100%", padding: "8px 12px", borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", fontSize: 12, outline: "none", boxSizing: "border-box" as const }} />
            </div>
            <div style={{ flex: 1, overflowY: "auto" as const }}>
              {filtered.slice(0, 200).map((t: any) => (
                <div key={t.id} onClick={() => addTrack(t)} style={{ padding: "8px 14px", cursor: "pointer", borderBottom: "1px solid var(--border-primary)", transition: "background 0.1s" }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)"}
                  onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "none"}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{t.title}</div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
                    <div style={{ fontSize: 12, color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, flex: 1 }}>{t.artist}</div>
                    <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontFamily: "'JetBrains Mono', ui-monospace, monospace", flexShrink: 0, marginLeft: 8 }}>{fmtDur(t.durationMs || 0)}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function LivePanel({ deckA, deckB, deckC, autoAdv, shuffle, toggleAuto, toggleShuffle, queueLen, showCarts, toggleCarts, progPanel, inputDevice, visiblePanels, deckConfigs, onConfigureDecks, autoSilenceTrim, setAutoSilenceTrim, xfadeDuration, setXfadeDuration, globalSearch, setGlobalSearch, nowPlaying, toolsCollapsed, toggleToolsCollapsed, autoXfade, setAutoXfade, onOpenCarts, libraryDock, jingleOverlay, hasJinglePool, onOpenJingleSettings, onCloseDock }: {
  deckA: DeckState | null; deckB: DeckState | null; deckC: DeckState | null;
  autoAdv: boolean | null; shuffle: boolean;
  toggleAuto: () => void | Promise<void>; toggleShuffle: () => void;
  queueLen: number; showCarts: boolean; toggleCarts: () => void;
  progPanel: null | "shows" | "categories" | "clocks" | "library" | "calendar" | "phone" | "jingles";
  inputDevice: string;
  visiblePanels?: Record<string, boolean>;
  deckConfigs?: DeckConfig[];
  onConfigureDecks?: () => void;
  autoSilenceTrim?: boolean;
  setAutoSilenceTrim?: (v: boolean) => void;
  xfadeDuration: number;
  setXfadeDuration: (v: number) => void;
  globalSearch: string;
  setGlobalSearch: (v: string) => void;
  nowPlaying?: string;
  toolsCollapsed: boolean;
  toggleToolsCollapsed: () => void;
  autoXfade: boolean;
  setAutoXfade: (v: boolean) => void;
  onOpenCarts: () => void;
  libraryDock: JSX.Element;
  jingleOverlay: { deck: string | null; state: string; title: string | null; contentClass: string | null; jinDurSec: number | null } | null;
  hasJinglePool: boolean;
  onOpenJingleSettings: () => void;
  onCloseDock: () => void;
}) {
  const engine = useAudioEngine();
  const { stationId: lpStationId } = useActiveStation();   // for the JINGLES push-up (imaging home)
  const vp = visiblePanels || { queue: true, deckA: true, deckB: true, deckC: true, mic: true };
  const lpViewport = useViewport();
  // Resizable bottom dock (carts / programming panels): drag the divider against the
  // decks to see more decks or more panel. Persisted; clamped so the decks stay visible.
  const [dockHeight, setDockHeight] = useState<number>(() => {
    try { const v = parseInt(localStorage.getItem("ether_dock_height") || "320"); return isNaN(v) ? 320 : Math.max(110, v); } catch { return 320; }
  });
  useEffect(() => { try { localStorage.setItem("ether_dock_height", String(dockHeight)); } catch {} }, [dockHeight]);
  const dockResizeRef = useRef<{ startY: number; startH: number } | null>(null);
  const startDockResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dockResizeRef.current = { startY: e.clientY, startH: dockHeight };
    const onMove = (ev: MouseEvent) => {
      if (!dockResizeRef.current) return;
      const dy = dockResizeRef.current.startY - ev.clientY; // drag up → taller dock
      setDockHeight(Math.max(110, Math.min(window.innerHeight - 240, dockResizeRef.current.startH + dy)));
    };
    const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); dockResizeRef.current = null; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [dockHeight]);
  // Master Output collapse state — persisted; auto-collapses below 1200px unless user opted in
  const [masterUserExpanded, setMasterUserExpanded] = useState<boolean>(() => {
    try { return localStorage.getItem("ether_master_user_expanded") === "1"; } catch { return false; }
  });
  const [masterUserCollapsed, setMasterUserCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem("ether_master_user_collapsed") === "1"; } catch { return false; }
  });
  // Effective collapsed:
  //   - User toggle wins if set
  //   - Else auto-collapse when window is < 1200
  const masterCollapsed = masterUserCollapsed
    ? true
    : masterUserExpanded
      ? false
      : lpViewport.panelTight;
  const toggleMasterCollapsed = useCallback(() => {
    if (masterCollapsed) {
      // Expanding — remember the user wants it open
      setMasterUserExpanded(true);
      setMasterUserCollapsed(false);
      try { localStorage.setItem("ether_master_user_expanded", "1"); localStorage.removeItem("ether_master_user_collapsed"); } catch {}
    } else {
      // Collapsing — remember the user wants it closed
      setMasterUserCollapsed(true);
      setMasterUserExpanded(false);
      try { localStorage.setItem("ether_master_user_collapsed", "1"); localStorage.removeItem("ether_master_user_expanded"); } catch {}
    }
  }, [masterCollapsed]);

  // Mic ON state for console fader view
  const [consoleMicOn, setConsoleMicOn] = useState<Record<string, boolean>>({});
  const [consoleMicVol, setConsoleMicVol] = useState<Record<string, number>>({});
  // Guest mic on/off state — keyed by slot ("E", "F", etc.). Mirrors mic state pattern.
  const [consoleGuestOn, setConsoleGuestOn] = useState<Record<string, boolean>>({});
  const [consoleGuestLevel, setConsoleGuestLevel] = useState<Record<string, number>>({});
  // Jingle overlay fader (CART slot 6) — ride level for jingles/carts, independent of each item's
  // gain_db trim. Ephemeral (resets to unity per session, like the deck faders).
  const [jingleVol, setJingleVol] = useState(1);

  // Listen for guest level updates pushed from the WebRTC layer (Studio.tsx)
  useEffect(() => {
    const onLevel = (e: Event) => {
      const d = (e as CustomEvent).detail as { slot: string; level: number };
      if (!d?.slot) return;
      setConsoleGuestLevel(prev => ({ ...prev, [d.slot]: d.level }));
    };
    window.addEventListener("ether:guest-level", onLevel as EventListener);
    return () => window.removeEventListener("ether:guest-level", onLevel as EventListener);
  }, []);

  // Panel widths — resizable via drag divider. Persisted + defaults WIDE ("stretched to the
  // right") so the queue's album-art deck rows open roomy by default, and the user's preferred
  // stretch is remembered across launches.
  const [queueWidth, setQueueWidth] = useState<number>(() => {
    try { const v = parseInt(localStorage.getItem("ether_queue_width") || "", 10); return Number.isFinite(v) ? Math.max(320, Math.min(640, v)) : 560; } catch { return 560; }
  });
  const resizingRef = useRef(false);

  // Queue slide-in/out collapse state — persisted so it stays how the user
  // left it across launches. When collapsed, the queue shrinks to a thin
  // 26px tab strip with a chevron handle to pop it back open. Same UX as
  // the Studio Editor inspector panel.
  const [queueCollapsed, setQueueCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem("ether_queue_collapsed") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("ether_queue_collapsed", queueCollapsed ? "1" : "0"); } catch {}
  }, [queueCollapsed]);
  // Persist queue width so the user's preferred stretch is the default on the next launch.
  useEffect(() => {
    try { localStorage.setItem("ether_queue_width", String(queueWidth)); } catch {}
  }, [queueWidth]);

  const COLLAPSED_W = 26;

  const startResizeQueue = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = queueWidth;
    resizingRef.current = true;
    const onMove = (ev: MouseEvent) => {
      // If queue is on the left, dragging right = wider; if on the right, dragging left = wider
      const dir = panelOrder[0] === "queue" ? 1 : -1;
      const next = Math.max(320, Math.min(640, startW + (ev.clientX - startX) * dir));
      setQueueWidth(next);
    };
    const onUp = () => {
      resizingRef.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Deck column widths — resizable. null = flex (auto). number = fixed px.
  const [deckWidths, setDeckWidths] = useState<Record<string, number | null>>({ A: null, B: null, C: null, mic: null, D: null, E: null, F: null });

  const startResizeDeck = (leftSlot: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    // Snapshot current rendered widths of all slots
    const items = Array.from(deckRowRef.current?.querySelectorAll("[data-deck-slot]") ?? []);
    const leftEl = items.find(el => (el as HTMLElement).dataset.deckSlot === leftSlot) as HTMLElement | undefined;
    const rightIdx = deckOrder.indexOf(leftSlot as any) + 1;
    const rightSlot = deckOrder[rightIdx];
    const rightEl = items.find(el => (el as HTMLElement).dataset.deckSlot === rightSlot) as HTMLElement | undefined;
    const startLeft = leftEl?.getBoundingClientRect().width ?? 200;
    const startRight = rightEl?.getBoundingClientRect().width ?? 200;
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const newLeft = Math.max(160, startLeft + delta);
      const newRight = Math.max(160, startRight - delta);
      setDeckWidths(prev => ({ ...prev, [leftSlot]: newLeft, [rightSlot]: newRight }));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // "queue" | "decks" — user can swap their horizontal order
  const [panelOrder, setPanelOrder] = useState<["queue" | "decks", "queue" | "decks"]>(["queue", "decks"]);
  const [dragging, setDragging] = useState<"queue" | "decks" | null>(null);
  const [dropTarget, setDropTarget] = useState<"queue" | "decks" | null>(null);
  const dragStartXRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Individual deck order — A, B, C, mic can be dragged to any position
  // Slot ids come from deck_configs rows, so this is a plain string — a union of
  // specific letters made a new slot a COMPILE ERROR, which is the opposite of "adding a
  // deck is a plain insert". (Note the union did not even include D/E/F.)
  type DeckSlot = string;
  // Always derive deck order directly from deckConfigs — no separate state needed
  const DEFAULT_DECK_ORDER: DeckSlot[] = ["A", "B", "C", "mic"];
  const rawDeckOrder: DeckSlot[] = deckConfigs && deckConfigs.length > 0
    ? deckConfigs.filter(c => c.enabled).map(c => c.slot as DeckSlot)
    : DEFAULT_DECK_ORDER;
  // Auto-hide the mic deck below 950px when no guest decks are configured.
  // Guests in conversation always keep the mic visible, otherwise it drops out
  // to give the music decks room to breathe on tablets/phones.
  const hasGuestDeck = !!deckConfigs?.some(c => c.enabled && c.type === "guest");
  const activeDeckOrder: DeckSlot[] = (lpViewport.narrow && !hasGuestDeck)
    ? rawDeckOrder.filter(s => s !== "mic")
    : rawDeckOrder;
  // Keep deckOrder in sync for drag-drop resize (still needed for deckWidths key)
  const [deckOrder, setDeckOrder] = useState<DeckSlot[]>(activeDeckOrder);
  useEffect(() => { setDeckOrder(activeDeckOrder); }, [JSON.stringify(activeDeckOrder)]);
  const [draggingDeck, setDraggingDeck] = useState<DeckSlot | null>(null);
  const [dropDeck, setDropDeck] = useState<DeckSlot | null>(null);
  const deckRowRef = useRef<HTMLDivElement>(null);

  const startDeckDrag = (slot: DeckSlot) => (e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    setDraggingDeck(slot);

    const onPointerMove = (ev: PointerEvent) => {
      if (!deckRowRef.current) return;
      const items = Array.from(deckRowRef.current.querySelectorAll("[data-deck-slot]"));
      let target: DeckSlot | null = null;
      for (const item of items) {
        const rect = item.getBoundingClientRect();
        if (ev.clientX >= rect.left && ev.clientX <= rect.right) {
          target = (item as HTMLElement).dataset.deckSlot as DeckSlot;
          break;
        }
      }
      setDropDeck(target && target !== slot ? target : null);
    };

    const onPointerUp = () => {
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      setDraggingDeck(null);
      setDropDeck(cur => {
        if (cur && cur !== slot) {
          setDeckOrder(prev => {
            const next = [...prev];
            const from = next.indexOf(slot);
            const to = next.indexOf(cur);
            next.splice(from, 1);
            next.splice(to, 0, slot);
            return next;
          });
        }
        return null;
      });
    };

    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
  };


  const startDrag = (panel: "queue" | "decks") => (e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    dragStartXRef.current = e.clientX;
    setDragging(panel);

    const onPointerMove = (ev: PointerEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const mid = rect.left + rect.width / 2;
      // whichever half of the container the cursor is in = drop target
      const hovering = ev.clientX < mid ? panelOrder[0] : panelOrder[1];
      setDropTarget(hovering !== panel ? hovering : null);
    };

    const onPointerUp = () => {
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      setDragging(null);
      setDropTarget(dt => {
        if (dt && dt !== panel) {
          setPanelOrder(prev => [prev[1], prev[0]]);
        }
        return null;
      });
    };

    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
  };

  const showQueue = vp.queue !== false;
  // Chevron points TOWARD where the queue would expand to. If queue is on
  // the LEFT of decks, collapsed chevron points right (will expand right);
  // if on the RIGHT, points left.
  const queueOnLeft = panelOrder[0] === "queue";
  const expandChevron = queueOnLeft ? "▶" : "◀";
  const collapseChevron = queueOnLeft ? "◀" : "▶";

  const queuePanel = (
    <div
      key="queue"
      data-tour="queue"
      style={{
        width: queueCollapsed ? COLLAPSED_W : queueWidth,
        flexShrink: 0, display: "flex", flexDirection: "column", overflow: "hidden",
        position: "relative",
        opacity: dragging === "queue" ? 0.55 : 1,
        outline: dropTarget === "queue" ? "2px solid var(--accent-cyan)" : "none",
        outlineOffset: 2, borderRadius: 0,
        // Width transition animates the slide; opacity/outline already had transitions.
        transition: "width 0.22s cubic-bezier(.2,.7,.2,1), opacity 0.15s, outline 0.1s",
        background: queueCollapsed ? "var(--bg-secondary)" : undefined,
        borderRight:  queueCollapsed && queueOnLeft  ? "1px solid var(--border-primary)" : undefined,
        borderLeft:   queueCollapsed && !queueOnLeft ? "1px solid var(--border-primary)" : undefined,
      }}
    >
      {queueCollapsed ? (
        // Collapsed — thin tab strip with chevron + vertical "QUEUE" label.
        // Whole strip is clickable to expand.
        <button
          onClick={() => setQueueCollapsed(false)}
          title="Expand queue"
          style={{
            width: "100%", height: "100%", display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center", gap: 14,
            background: "transparent", border: "none", color: "var(--text-secondary)",
            cursor: "pointer", padding: 0, borderRadius: 0,
            transition: "color 0.15s, background 0.15s",
          }}
          onMouseEnter={e => { e.currentTarget.style.color = "var(--accent-blue)"; e.currentTarget.style.background = "var(--bg-tertiary)"; }}
          onMouseLeave={e => { e.currentTarget.style.color = "var(--text-secondary)"; e.currentTarget.style.background = "transparent"; }}
        >
          <span style={{ fontSize: 12, fontWeight: 700 }}>{expandChevron}</span>
          <span style={{
            fontSize: 10, fontWeight: 800, letterSpacing: "0.18em",
            writingMode: "vertical-rl", transform: "rotate(180deg)",
          }}>
            QUEUE · {queueLen}
          </span>
          <span style={{ fontSize: 12, fontWeight: 700 }}>{expandChevron}</span>
        </button>
      ) : (
        <>
          {/* Collapse chevron — small, tucked at the inner edge so it doesn't
              steal queue real estate. Hover-only to stay subtle. */}
          <button
            onClick={() => setQueueCollapsed(true)}
            title="Collapse queue"
            style={{
              position: "absolute", top: 4, zIndex: 5,
              [queueOnLeft ? "right" : "left"]: 4,
              width: 18, height: 18, padding: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "var(--bg-tertiary)", color: "var(--text-secondary)",
              border: "1px solid var(--border-primary)", borderRadius: 0,
              fontSize: 10, fontWeight: 700, cursor: "pointer",
              opacity: 0.55, transition: "opacity 0.15s, color 0.15s",
            } as React.CSSProperties}
            onMouseEnter={e => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.color = "var(--accent-blue)"; }}
            onMouseLeave={e => { e.currentTarget.style.opacity = "0.55"; e.currentTarget.style.color = "var(--text-secondary)"; }}
          >{collapseChevron}</button>
          {/* ── Queue ── */}
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflowY: "auto" }}>
            <UpNext queueLen={queueLen} onQueueChange={() => window.dispatchEvent(new CustomEvent('ether:queue-changed'))} jingleOverlay={jingleOverlay} />
          </div>
        </>
      )}
    </div>
  );

  const decksPanel = (
    <div
      key="decks"
      style={{
        flex: 1, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden", gap: 0,
        background: "var(--bg-primary)",
        opacity: dragging === "decks" ? 0.55 : 1,
        outline: dropTarget === "decks" ? "2px solid var(--accent-cyan)" : "none",
        outlineOffset: 2, borderRadius: 0,
        transition: "opacity 0.15s, outline 0.1s",
        // Dim all ConsoleStrip column dividers to near-invisible
        ["--panel-border" as any]: "1px solid rgba(255,255,255,0.06)",
        ["--strip-divider" as any]: "rgba(255,255,255,0.07)",
      } as React.CSSProperties}
    >
      {/* The top DECK A/B/C title strip (ThreeSlotBar) was removed — deck identity now
          lives in the Up Next deck rows + the color-coded fader accents, and the faders
          grow to fill the reclaimed height. */}
      {(
        /* ── Console channel strips — the default deck view.
           Uses activeDeckOrder from the deck configurator so all 6 slots work. ── */
        <div style={{ display: "flex", gap: 0, flex: 1, minHeight: 0, overflow: "hidden" }}>
          {activeDeckOrder.map((slot) => {
            const config = deckConfigs?.find(d => d.slot === slot);
            const deckType = config?.type || (slot === "mic" ? "mic" : "music");
            const deckMap: Record<string, any> = { A: deckA, B: deckB, C: deckC };
            const deck = deckMap[slot as string];
            const deckColors: Record<string, string> = { A: "var(--deck-a)", B: "var(--deck-b)", C: "var(--deck-c)", D: "#fb923c", E: "#e879f9", mic: "#a855f7" };
            // Rotation decks A/B/C always use the canonical slot color (A blue, B green, C purple)
            // so the faders match the Up Next deck rows + library A/B/C buttons. config.color only
            // carries the deck-TYPE color (every music deck is green), which can't tell A/B/C apart.
            const deckColor = (slot === "A" || slot === "B" || slot === "C")
              ? deckColors[slot]
              : (config?.color || deckColors[slot] || "var(--accent-blue)");

            // Music decks → ConsoleStrip (fader + VU)
            if (deckType === "music") {
              return (
                <div key={slot} style={{ flex: 1, display: "flex", minWidth: 0 }}>
                  <ConsoleStrip
                    label={config?.label || `DECK ${slot}`}
                    color={deckColor}
                    volume={deck?.volume ?? 1}
                    deckId={slot}
                    hideLabel={["A","B","C"].includes(slot)}
                    role={["A","B","C"].includes(slot) ? computeDeckRole(slot as "A"|"B"|"C", { A: deckA, B: deckB, C: deckC }) : "third"}
                    isPlaying={deck?.status === "playing"}
                    isOn={true}
                    onVolumeChange={v => engine.getDeck(slot)?.setVolume(v)}
                    // ── DECK ON — the board's start control, and the ONLY one (2026-08-02) ──────────
                    // This used to be a solo play/pause: `getDeck(slot).play()` → a RAW audioPlay
                    // straight to Rust, outside the advance chain. No serialization, no guards, no stop
                    // of the outgoing, no liveDeck update — the out-of-chain start shape that put two
                    // decks on air on 2026-07-29. Pressing ON on a cued deck while another played gave
                    // you both, caught only by the liveDeck guard after its 7.5s grace.
                    //
                    // Now: PLAYING → board-style channel OFF (audio off now, not a pause — a real
                    // board's ON kills the channel). Otherwise → the serialized, guarded rotate, which
                    // starts this deck and stops the outgoing via the deferred Bug-A stop.
                    // (docs/auto-xfade-contract-trace-2026-08-02.md)
                    onToggleOn={async () => {
                      const eng: any = engine;
                      if (deck?.status === "playing") {
                        if (eng.isDaemonDriven) await eng.deckOff(slot);
                        else engine.getDeck(slot)?.stop();
                        return;
                      }
                      if (eng.isDaemonDriven) {
                        const r = await eng.deckCrossfade(undefined, slot);
                        // Honest feedback: a press the daemon absorbed must not look like it worked.
                        if (r && r.ok === false) console.warn(`[deck ${slot}] start not applied: ${r.reason}`);
                        return;
                      }
                      engine.getDeck(slot)?.play();   // in-process: no daemon chain to route through
                    }}
                  />
                </div>
              );
            }

            // Mic decks → independent MicChannel: own device + capture + meter + output gate per slot.
            // Up to 6 mics, each on a different physical input (device saved per slot).
            if (deckType === "mic" || slot === "mic") {
              return (
                <div key={slot} style={{ flex: 1, display: "flex", minWidth: 0 }}>
                  <MicChannel slot={slot} label={config?.label || "MIC"} />
                </div>
              );
            }
            if (deckType === "video") {
              return <div key={slot} style={{ flex: 2, minWidth: 280 }}><VideoStudio embedded /></div>;
            }
            if (deckType === "cart") {
              return <div key={slot} style={{ flex: 1, minWidth: 120 }}><div style={{ height: "100%", background: "var(--bg-secondary)", overflow: "hidden" }}><BoutiqueCartWall deckSlot={slot} /></div></div>;
            }
            if (deckType === "desk") {
              return <div key={slot} style={{ flex: 1, minWidth: 220 }}><InlineProducerDesk episodeTitle={undefined} nowPlaying={nowPlaying} /></div>;
            }
            if (deckType === "guest") {
              const guestIsOn  = consoleGuestOn[slot] ?? false;
              const guestLevel = consoleGuestLevel[slot] ?? 0;
              const guestVol   = consoleGuestLevel[`${slot}_vol`] ?? 1;
              return (
                <div key={slot} style={{ flex: 1, minWidth: 0 }}>
                  <ConsoleStrip
                    label={config?.label || `GUEST ${slot}`}
                    color="#a78bfa"
                    volume={guestVol}
                    level={guestIsOn ? guestLevel : 0}
                    isPlaying={guestIsOn && guestLevel > 0.02}
                    isOn={guestIsOn}
                    onVolumeChange={v => {
                      setConsoleGuestLevel(prev => ({ ...prev, [`${slot}_vol`]: v }));
                      window.dispatchEvent(new CustomEvent("ether:guest-volume", { detail: { slot, volume: v } }));
                    }}
                    onToggleOn={() => {
                      const next = !guestIsOn;
                      setConsoleGuestOn(prev => ({ ...prev, [slot]: next }));
                      // Broadcast guest on/off — VideoStudio/Guest WebRTC layer can mute/unmute
                      window.dispatchEvent(new CustomEvent("ether:guest-toggle", { detail: { slot, active: next } }));
                    }}
                  />
                </div>
              );
            }

            // Fallback: ConsoleStrip
            return (
              <div key={slot} style={{ flex: 1, minWidth: 0 }}>
                <ConsoleStrip
                  label={config?.label || slot}
                  color={deckColor}
                  volume={deck?.volume ?? 1}
                  deckId={slot}
                  hideLabel={["A","B","C"].includes(slot)}
                  isPlaying={deck?.status === "playing"}
                  isOn={true}
                  onVolumeChange={v => engine.getDeck(slot)?.setVolume(v)}
                  onToggleOn={() => {
                    if (deck?.status === "playing") engine.getDeck(slot)?.pause();
                    else engine.getDeck(slot)?.play();
                  }}
                />
              </div>
            );
          })}
          {/* Jingle overlay fader (CART slot 6) — a separate aux/cue level for jingles/carts, teal.
              Rides the overlay bus gain via audio_set_volume("CART"); each item's gain_db (trim) stays
              independent. Always shown alongside Master since jingles are a station-wide overlay. */}
          <div style={{ flex: 1, minWidth: 0, maxWidth: 140, display: "flex", position: "relative" }}>
            <ConsoleStrip
              label="JINGLES"
              color="#14e0c8"
              volume={jingleVol}
              deckId="CART"
              isPlaying={false}
              isOn={true}
              onVolumeChange={v => { setJingleVol(v); (engine.getDeck("CART" as any) as any)?.setVolume(v); }}
              onToggleOn={() => { const cart = engine.getDeck("CART" as any) as any; const st = cart?.getState?.(); if (st?.status === "playing") cart?.pause(); else cart?.play(); }}
            />
            {/* Discoverability (4.4.56): unconfigured → a subtle deep-link to Settings → Programming → Jingles. */}
            {!hasJinglePool && (
              <button onClick={onOpenJingleSettings} title="No jingle pool yet — click to set up jingles"
                style={{
                  position: "absolute", left: 4, right: 4, bottom: 4, padding: "4px 2px",
                  background: "rgba(20,224,200,0.10)", border: "1px solid rgba(20,224,200,0.45)", borderRadius: 4,
                  color: "#14e0c8", fontSize: 9, fontWeight: 700, letterSpacing: "0.04em", lineHeight: 1.2,
                  cursor: "pointer", textAlign: "center",
                }}>
                Set up jingles →
              </button>
            )}
          </div>
          {/* Master Output — owns its own audio:levels subscription */}
          <MasterOutput
            expanded={!showCarts && !masterCollapsed}
            collapsed={masterCollapsed}
            onToggleCollapsed={toggleMasterCollapsed}
          />
        </div>
      )}

      {/* Bottom dock — carts OR a programming editor. Pushes the decks up (queue
          untouched). The divider above it is draggable up/down to give more room to the
          decks or to the dock — its height is shared + persisted across carts/programming. */}
      {(() => {
        const cartOpen = showCarts && !progPanel && !deckConfigs?.some(d => d.type === "cart" && d.enabled);
        if (!progPanel && !cartOpen) return null;
        return (
          <>
            {/* Drag handle / divider */}
            <div
              onMouseDown={startDockResize}
              title="Drag to resize — more decks ↑ / more panel ↓"
              style={{ flexShrink: 0, height: 10, cursor: "ns-resize", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg-secondary)", borderTop: "1px solid var(--border-primary)" }}
            >
              <div style={{ width: 48, height: 3, borderRadius: 2, background: "var(--border-secondary)", pointerEvents: "none" }} />
            </div>
            {/* Dock body — user-resizable height */}
            <div style={{ flexShrink: 0, height: dockHeight, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg-secondary)", borderTop: progPanel ? "2px solid var(--accent-blue)" : "none" }}>
              {progPanel === "library"
                // LibraryPanel relies on its parent for scrolling (like the full-screen view),
                // so wrap it in a scroll container sized to the dock.
                ? <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 16px" }}>{libraryDock}</div>
                : progPanel === "calendar"
                  ? <BroadcastCalendar />
                  : progPanel === "phone"
                    ? <PhoneDesk onClose={onCloseDock} />
                    : progPanel === "jingles"
                      // Imaging home: pools + assignments + reel splitter, all in one push-up.
                      ? <JinglesPanel stationId={lpStationId} />
                      : progPanel
                        ? <Scheduler defaultTab={progPanel} embedded />
                        : <BoutiqueCartWall deckSlot="C" variant="strip" />}
            </div>
          </>
        );
      })()}
    </div>
  );

  const panels: Record<string, JSX.Element> = { queue: showQueue ? queuePanel : <></>, decks: decksPanel };

  const livePanelSwipe = useSwipe(useCallback(() => {
    setQueueCollapsed(c => !c);
  }, []));

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 0 }}>

      {/* Main layout — drag-reorderable + resizable */}
      <div
        ref={containerRef}
        {...livePanelSwipe}
        style={{
          display: "flex", gap: 0, flex: 1, minHeight: 0, overflow: "hidden",
          cursor: dragging ? "grabbing" : resizingRef.current ? "col-resize" : "auto",
        }}
      >
        {panelOrder.map((p, i) => (
          <React.Fragment key={p}>
            {panels[p]}
            {i < panelOrder.length - 1 && (
              <div
                data-swipe-ignore
                onMouseDown={startResizeQueue}
                style={{
                  width: 10, flexShrink: 0, cursor: "col-resize",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  position: "relative",
                }}
              >
                <div style={{
                  width: 3, height: 40, borderRadius: 0,
                  background: "var(--border-secondary)",
                  transition: "background 0.15s, height 0.15s",
                  pointerEvents: "none",
                }}
                  onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.background = "var(--accent-blue)"; el.style.height = "60px"; }}
                  onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.background = "var(--border-secondary)"; el.style.height = "40px"; }}
                />
              </div>
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

// ── Library Panel ────────────────────────────────────────────

// ── Library column definitions (ALL_LIB_COLS, LibCol, LIB_COL_LABELS imported from src/types/metadata.ts)

interface EditMeta { id: number; title: string; artist: string; album: string; year: string; genre: string; bpm: string; }

// ── Multi-choice shared item shape ───────────────────────────
interface MultiItem { uuid: string; vocabId: number; value: string; }

// ── MultiChoicePillCell ───────────────────────────────────────
// Renders selected values as colored pills inside a fixed-height cell.
// Uses layout measurement to find the first overflowing pill; hides overflow
// items with visibility:hidden (preserves layout for stable remeasurement)
// and shows a +N chip absolutely positioned at the right edge.
// Click handling lives on the outer gridcell wrapper — not here.
function MultiChoicePillCell({
  items, vocabDef,
}: {
  items: MultiItem[];
  vocabDef: MetadataVocabulary[] | undefined;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [clipFrom, setClipFrom] = useState(-1);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || items.length === 0) { setClipFrom(p => p === -1 ? p : -1); return; }
    const pills = el.querySelectorAll<HTMLElement>('[data-pill]');
    if (!pills.length) return;
    // Reserve 32px for the +N chip so it always fits when needed
    const maxW = el.clientWidth - 32;
    let first = -1;
    for (let i = 0; i < pills.length; i++) {
      if (pills[i].offsetLeft + pills[i].offsetWidth > maxW) { first = i; break; }
    }
    setClipFrom(p => p === first ? p : first);
  });

  if (items.length === 0) return <span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>—</span>;

  const hiddenCount = clipFrom >= 0 ? items.length - clipFrom : 0;

  return (
    <div ref={containerRef}
      style={{ position: 'relative', display: 'flex', gap: 3, overflow: 'hidden',
               alignItems: 'center', flex: 1, minWidth: 0 }}>
      {items.map((item, i) => {
        const color = vocabDef?.find(v => v.id === item.vocabId)?.color ?? '#555';
        return (
          <span key={item.uuid} data-pill=""
            style={{ visibility: clipFrom >= 0 && i >= clipFrom ? 'hidden' : undefined,
              display: 'inline-flex', alignItems: 'center', padding: '1px 6px', borderRadius: 3,
              fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
              background: color, color: '#fff', flexShrink: 0 }}>
            {item.value}
          </span>
        );
      })}
      {hiddenCount > 0 && (
        <span style={{ position: 'absolute', right: 0,
          background: 'var(--bg-tertiary)', paddingLeft: 4,
          fontSize: 11, color: 'var(--text-tertiary)', flexShrink: 0 }}>
          +{hiddenCount}
        </span>
      )}
    </div>
  );
}

// ── SingleChoicePillCell ──────────────────────────────────────
// Renders the currently selected value as one colored pill, or — if empty.
function SingleChoicePillCell({ value, color }: { value: string | null; color: string | null }) {
  if (!value) return <span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>—</span>;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', padding: '1px 6px', borderRadius: 3,
      fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
      background: color ?? '#555', color: '#fff' }}>
      {value}
    </span>
  );
}

// ── MultiChoicePopover ────────────────────────────────────────
// Absolutely-positioned checkbox list for toggling multi_choice values.
// Flips above the anchor row when it would clip the viewport bottom.
function MultiChoicePopover({
  songId, defId, anchorRect, vocabOptions, selectedItems, inFlightCreates, onToggle, onClose,
}: {
  songId: number;
  defId: number;
  anchorRect: DOMRect;
  vocabOptions: MetadataVocabulary[];
  selectedItems: MultiItem[];
  inFlightCreates: React.MutableRefObject<Set<string>>;
  onToggle: (v: MetadataVocabulary) => void;
  onClose: () => void;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const [measuredH, setMeasuredH] = useState(0);

  // Measure real height after first render for accurate viewport flip
  useLayoutEffect(() => {
    if (popRef.current) {
      const h = popRef.current.offsetHeight;
      if (h > 0) setMeasuredH(p => p === h ? p : h);
    }
  });

  const estimatedH = measuredH > 0 ? measuredH : Math.min(vocabOptions.length * 34 + 16, 280);
  const flipUp     = anchorRect.bottom + estimatedH > window.innerHeight;
  const top        = flipUp ? Math.max(4, anchorRect.top - estimatedH) : anchorRect.bottom;
  const left       = Math.min(anchorRect.left, window.innerWidth - 210);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const isSelected = (id: number) => selectedItems.some(r => r.vocabId === id);
  const isInflight = (_id: number) => inFlightCreates.current.has(`${songId}:${defId}`);

  return (
    <div ref={popRef} style={{
      position: 'fixed', top, left,
      minWidth: Math.max(anchorRect.width, 200),
      background: 'var(--bg-secondary)',
      border: '1px solid var(--border-primary)',
      boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
      zIndex: 9999, maxHeight: 280, overflowY: 'auto',
      padding: '6px 0',
    }}>
      {vocabOptions.length === 0
        ? <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text-tertiary)' }}>No options defined</div>
        : vocabOptions.map(v => {
            const inflight   = isInflight(v.id);
            const checked    = isSelected(v.id);
            const pillColor  = v.color ?? '#555';
            return (
              <label key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px',
                cursor: inflight ? 'wait' : 'pointer', opacity: inflight ? 0.5 : 1 }}>
                <input type="checkbox" checked={checked} disabled={inflight}
                  onChange={() => !inflight && onToggle(v)}
                  style={{ cursor: 'inherit', flexShrink: 0 }} />
                <span style={{ display: 'inline-flex', alignItems: 'center', padding: '1px 6px', borderRadius: 3,
                  fontSize: 11, fontWeight: 600, background: pillColor, color: '#fff', whiteSpace: 'nowrap' }}>
                  {v.value}
                </span>
              </label>
            );
          })
      }
    </div>
  );
}
// ── SingleChoicePopover ───────────────────────────────────────
// Fixed-position picker for single_choice columns.
// Arrow Up/Down moves highlight; Enter commits; Escape closes.
// Item 0 is always "— clear —"; items 1..n are vocab options.
function SingleChoicePopover({
  anchorRect, vocabOptions, currentVocabId, onSelect, onClear, onClose,
}: {
  anchorRect: DOMRect;
  vocabOptions: MetadataVocabulary[];
  currentVocabId: number | null;
  onSelect: (v: MetadataVocabulary) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const [measuredH, setMeasuredH] = useState(0);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const highlightIdxRef = useRef(-1);
  const allItemsRef = useRef<(MetadataVocabulary | null)[]>([null, ...vocabOptions]);

  useLayoutEffect(() => {
    if (popRef.current) {
      const h = popRef.current.offsetHeight;
      if (h > 0) setMeasuredH(p => p === h ? p : h);
    }
  });

  const itemCount = 1 + vocabOptions.length;
  const estimatedH = measuredH > 0 ? measuredH : Math.min(itemCount * 34 + 16, 280);
  const flipUp = anchorRect.bottom + estimatedH > window.innerHeight;
  const top    = flipUp ? Math.max(4, anchorRect.top - estimatedH) : anchorRect.bottom;
  const left   = Math.min(anchorRect.left, window.innerWidth - 210);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  useEffect(() => {
    const count = allItemsRef.current.length;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = Math.min(highlightIdxRef.current + 1, count - 1);
        highlightIdxRef.current = next; setHighlightIdx(next); return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const next = Math.max(highlightIdxRef.current - 1, 0);
        highlightIdxRef.current = next; setHighlightIdx(next); return;
      }
      if (e.key === 'Enter') {
        const idx = highlightIdxRef.current;
        if (idx < 0) return;
        const item = allItemsRef.current[idx];
        if (item === null) { onClear(); } else { onSelect(item); }
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, onSelect, onClear]);

  const setHl = (idx: number) => { highlightIdxRef.current = idx; setHighlightIdx(idx); };

  return (
    <div ref={popRef} style={{
      position: 'fixed', top, left,
      minWidth: Math.max(anchorRect.width, 200),
      background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
      boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
      zIndex: 9999, maxHeight: 280, overflowY: 'auto', padding: '6px 0',
    }}>
      <div
        style={{ display: 'flex', alignItems: 'center', padding: '5px 12px', cursor: 'pointer',
          background: highlightIdx === 0 ? 'rgba(255,255,255,0.08)' : 'transparent',
          fontSize: 12, color: 'var(--text-tertiary)' }}
        onMouseEnter={() => setHl(0)} onMouseLeave={() => setHl(-1)}
        onMouseDown={() => { onClear(); onClose(); }}>
        — clear —
      </div>
      {vocabOptions.length === 0
        ? <div style={{ padding: '4px 12px', fontSize: 12, color: 'var(--text-tertiary)', fontStyle: 'italic' }}>No options defined</div>
        : vocabOptions.map((v, i) => {
            const idx = i + 1;
            return (
              <div key={v.id}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px', cursor: 'pointer',
                  background: highlightIdx === idx ? 'rgba(255,255,255,0.08)' : 'transparent' }}
                onMouseEnter={() => setHl(idx)} onMouseLeave={() => setHl(-1)}
                onMouseDown={() => { onSelect(v); onClose(); }}>
                <span style={{ width: 12, fontSize: 10, color: 'var(--text-tertiary)', flexShrink: 0, textAlign: 'center' as const }}>
                  {v.id === currentVocabId ? '✓' : ''}
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', padding: '1px 6px', borderRadius: 3,
                  fontSize: 11, fontWeight: 600, background: v.color ?? '#555', color: '#fff', whiteSpace: 'nowrap' }}>
                  {v.value}
                </span>
              </div>
            );
          })
      }
    </div>
  );
}

interface DiscogsResult { id: number; title: string; artist: string; album: string; year: number | null; genre: string | null; thumb: string | null; format: string | null; label: string | null; }

// ── Slice C: rotation-eligibility helpers for the repaired PLAYS column ──
const libFmtRest = (sec: number) => { const m = Math.floor(sec / 60), s = Math.floor(sec % 60); return `${m}:${String(s).padStart(2, "0")}`; };
const libTimeAgo = (ts: number) => { const d = Math.floor(Date.now() / 1000) - ts; if (d < 60) return "just now"; if (d < 3600) return `${Math.floor(d / 60)}m ago`; if (d < 86400) return `${Math.floor(d / 3600)}h ago`; return `${Math.floor(d / 86400)}d ago`; };
function LibStatusChip({ status }: { status: string }) {
  const map: Record<string, [string, string]> = { ELIGIBLE: ["#22c55e", "ready"], RESTING: ["#fbbf24", "resting"], NEVER_PLAYED: ["#6b7280", "new"], UNRESOLVABLE: ["#f87171", "no file"] };
  const [c, l] = map[status] || ["#6b7280", status.toLowerCase()];
  return <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: "0.04em", color: c, border: `1px solid ${c}66`, padding: "1px 4px", borderRadius: 2, textTransform: "uppercase" as const, whiteSpace: "nowrap" as const }}>{l}</span>;
}

export function LibraryPanel({ onLoadA, onLoadB, onLoadC, onQueue, onEdit, onSendToStudio }: { onLoadA: (s: SongRow) => void; onLoadB: (s: SongRow) => void; onLoadC: (s: SongRow) => void; onQueue: (s: SongRow) => void; onEdit: (s: SongRow) => void; onSendToStudio: (s: SongRow) => void }) {
  const engine = useAudioEngine();
  const { stationId } = useActiveStation();
  // Slice C: per-song rotation eligibility (plays + last-played + rest + status) from library-health —
  // the station-scoped play_log join that repairs the empty PLAYS column. Refreshed every 30s so the
  // RESTING countdown ticks down.
  const [eligMap, setEligMap] = useState<Record<number, { plays: number; lastPlayed: number | null; restSec: number; status: string }>>({});
  useEffect(() => {
    let stop = false;
    const fetchElig = async () => {
      try {
        const rows = await (window as any).ether?.invoke?.("library-health:eligibility", stationId);
        if (stop || !Array.isArray(rows)) return;
        const m: Record<number, any> = {};
        for (const r of rows) m[r.id] = { plays: r.plays ?? 0, lastPlayed: r.lastPlayed, restSec: r.restSec, status: r.status };
        setEligMap(m);
      } catch { /* IPC absent */ }
    };
    fetchElig();
    const id = setInterval(fetchElig, 30000);
    return () => { stop = true; clearInterval(id); };
  }, [stationId]);
  const watermarkedPaths = React.useMemo<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("ether_watermarked_paths") || "[]")); }
    catch { return new Set(); }
  }, []);
  const [showImport, setShowImport]   = useState(false);
  // Item 1 — cue popup menu (anchored to the row's arrow button) + Quick Cue slide-up panel.
  const [cueMenu, setCueMenu] = useState<{ song: SongRow; x: number; y: number } | null>(null);
  const [quickCueSong, setQuickCueSong] = useState<SongRow | null>(null);
  // "Mark as Spot" (2026-07-22) — the fast path from a library track into the Spots traffic manager.
  // The small dialog picks a spot category (existing or create-new inline) + type; on confirm the track
  // becomes content_class='SPOT' (leaves music rotation, same discipline as JIN/SWP) and a spots record
  // is created carrying title + file_path. Spots & Promos stays the full manager (dates/max-plays/advertiser).
  const [spotMark, setSpotMark] = useState<{ song: SongRow; catId: number | null; type: string; newCat: string } | null>(null);
  const [spotCats, setSpotCats] = useState<{ id: number; name: string; color: string | null }[]>([]);
  const loadSpotCats = useCallback(async () => {
    try { const r = await (window as any).ether.spotCategories.list(stationId); setSpotCats((r && r.rows) || []); } catch { setSpotCats([]); }
  }, [stationId]);
  const confirmSpotMark = async () => {
    if (!spotMark) return;
    const ether = (window as any).ether;
    let catId = spotMark.catId;
    const nc = spotMark.newCat.trim();
    if (nc) { try { const r = await ether.spotCategories.create({ station_id: stationId, name: nc, color: "#fbbf24" }); catId = r?.row?.id ?? catId; } catch { /* keep going */ } }
    // Breaks are traffic law: a category-specific break must never pull uncategorized audio. Require one.
    if (catId == null) { window.alert("Pick a spot category (or type a new one) — a break pulls from a category."); return; }
    try { await ether.songs.updateById(spotMark.song.id, { content_class: "SPOT" }); } catch {}
    // Probe the REAL audio duration (seconds) — the same native probe every import uses — so the spot's
    // length_sec is truthful. A fake default corrupts the calendar, the generator's spacing, and anchor-fit.
    let lengthSec: number | null = null;
    try { const d = await ether.audio.getFileDuration(spotMark.song.file_path); if (typeof d === "number" && d > 0) lengthSec = Math.round(d); } catch {}
    // is_active:1 explicitly so the spot airs immediately (spots.create also defaults it now).
    try { await ether.spots.create({ station_id: stationId, title: spotMark.song.title, file_path: spotMark.song.file_path, spot_type: spotMark.type || "commercial", spot_category_id: catId, is_active: 1, max_plays_day: 999, length_sec: lengthSec }); } catch {}
    setSpotMark(null); load();
  };
  // Borrowed catalog → read-only: gate ingest + core-field edits (the hard guarantee lives in
  // electron/sync/mutation-writer.js). Station-scoped tagging/programming stays fully editable.
  const libraryBorrowed = useLibraryBorrowed();
  const [showNexGen, setShowNexGen]   = useState(false);
  const [showSpotify, setShowSpotify] = useState(false);
  const [showCreateCat, setShowCreateCat] = useState(false);
  const [newCatCode, setNewCatCode] = useState("");
  const [newCatName, setNewCatName] = useState("");
  const [newCatColor, setNewCatColor] = useState("var(--accent-blue)");
  const [catList, setCatList] = useState<{ id: number; code: string; name: string | null; color: string | null }[]>([]);
  const [songs, setSongs] = useState<SongRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [count, setCount] = useState(0);
  const [status, setStatus] = useState("");
  const [missingSongs, setMissingSongs] = useState<string[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [showBulkAssign, setShowBulkAssign] = useState(false);
  // Uniform column sort — active column key + direction (default: Title ascending, matching the load order).
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'title', dir: 'asc' });
  const { isStation } = usePlan();

  // ── Column visibility & widths ─────────────────────────────
  const [visibleCols, setVisibleCols] = useState<Set<LibCol>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("ether_lib_cols") || '["title","artist","album","genre","bpm","format","duration","category"]')); }
    catch { return new Set(["title","artist","album","genre","bpm","format","duration","category"] as LibCol[]); }
  });
  const [colWidths, setColWidths] = useState<Partial<Record<LibCol, number>>>({});
  const [metaColWidths, setMetaColWidths] = useState<Record<number, number>>({});
  const [columnsPanelOpen, setColumnsPanelOpen] = useState(false);
  const [vocabReloadKey, setVocabReloadKey] = useState(0);
  const [smvReloadKey, setSmvReloadKey] = useState(0);
  const middleHeaderRef = useRef<HTMLDivElement | null>(null);
  const [libPageIdx, setLibPageIdx]   = useState(0);
  const [middleZoneW, setMiddleZoneW] = useState(0);
  const _tableResizeObs = useRef<ResizeObserver | null>(null);
  // Callback ref — fires on mount/unmount so it catches the conditional render
  const tableRef = useCallback((el: HTMLDivElement | null) => {
    if (_tableResizeObs.current) { _tableResizeObs.current.disconnect(); _tableResizeObs.current = null; }
    if (!el) return;
    setMiddleZoneW(el.getBoundingClientRect().width);
    _tableResizeObs.current = new ResizeObserver(entries => { setMiddleZoneW(entries[0].contentRect.width); });
    _tableResizeObs.current.observe(el);
  }, []);

  const toggleCol = (col: LibCol) => {
    setVisibleCols(prev => {
      const n = new Set(prev);
      n.has(col) ? n.delete(col) : n.add(col);
      localStorage.setItem("ether_lib_cols", JSON.stringify([...n]));
      return n;
    });
  };

  // ── Metadata column visibility (per-station) ───────────────
  const [defs, setDefs] = useState<MetadataDefinition[]>([]);
  const [visibleMetaCols, setVisibleMetaCols] = useState<Set<number>>(new Set());
  const [metaMap, setMetaMap] = useState<Record<number, Record<number, string>>>({});
  // FK map: song_id → definition_id → value_vocabulary_id (only set for choice-type rows)
  const [metaVocabIdMap, setMetaVocabIdMap] = useState<Record<number, Record<number, number>>>({});
  // multi_choice: song_id → definition_id → [{uuid, vocabId, value}]
  const [metaMultiMap, setMetaMultiMap] = useState<Record<number, Record<number, MultiItem[]>>>({});
  // anchor for the multi_choice popover picker
  const [multiPopover, setMultiPopover] = useState<{ songId: number; defId: number; rect: DOMRect } | null>(null);
  // anchor for the single_choice popover picker
  const [singlePopover, setSinglePopover] = useState<{ songId: number; defId: number; rect: DOMRect } | null>(null);
  // in-flight upsert guard: key = `${songId}:${defId}` — locks entire definition row during upsert
  const inFlightCreates = useRef<Set<string>>(new Set());
  const [vocabByDef, setVocabByDef] = useState<Record<number, MetadataVocabulary[]>>({});
  const [metaEdit, setMetaEdit] = useState<{ songId: number; col: MetadataColumn; value: string } | null>(null);

  const toggleMetaCol = (defId: number) => {
    setVisibleMetaCols(prev => {
      const n = new Set(prev);
      n.has(defId) ? n.delete(defId) : n.add(defId);
      localStorage.setItem(`ether_lib_meta_cols_${stationId}`, JSON.stringify([...n]));
      return n;
    });
  };

  // ── Per-station column width persistence ──────────────────
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(`ether_lib_col_widths_${stationId}`) || '{}');
      setColWidths(saved);
    } catch { /* ignore */ }
  }, [stationId]);

  // ── Right-click context menu ───────────────────────────────
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; song: SongRow } | null>(null);
  const ctxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) setCtxMenu(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  // ── Edit Metadata modal ────────────────────────────────────
  const [editMeta, setEditMeta] = useState<EditMeta | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [discogsResults, setDiscogsResults] = useState<DiscogsResult[]>([]);
  const [discogsLoading, setDiscogsLoading] = useState(false);
  const [discogsError, setDiscogsError] = useState("");

  const openEditMeta = (s: SongRow) => {
    setEditMeta({ id: s.id, title: s.title || "", artist: s.artist_name || "", album: s.album_title || "", year: "", genre: s.genre || "", bpm: s.bpm != null ? String(s.bpm) : "" });
    setDiscogsResults([]); setDiscogsError("");
    setCtxMenu(null);
  };

  // ── Cart # (library cart number) ───────────────────────────
  const [cartEdit, setCartEdit] = useState<{ id: number; title: string; value: string } | null>(null);
  const [cartSaving, setCartSaving] = useState(false);
  const openCartId = (s: SongRow) => { setCartEdit({ id: s.id, title: s.title || "", value: s.cart_id || "" }); setCtxMenu(null); };
  const saveCartId = async () => {
    if (!cartEdit) return;
    setCartSaving(true);
    const v = cartEdit.value.trim();
    // Warn (don't block) if this cart # is already on another element.
    const clash = songs.find(x => x.id !== cartEdit.id && (x.cart_id || "") === v && v !== "");
    if (clash && !confirm(`Cart #${v} is already on "${clash.title}". Use it here too?`)) { setCartSaving(false); return; }
    try {
      const r = await (window as any).ether.songsExtra.setCartId(cartEdit.id, v);
      if (!r?.ok) throw new Error(r?.error || "Save failed");
      setSongs(prev => prev.map(x => x.id === cartEdit.id ? { ...x, cart_id: v || null } : x));
      setCartEdit(null);
    } catch { /* leave the modal open on failure */ }
    setCartSaving(false);
  };

  const saveEditMeta = async () => {
    if (!editMeta) return;
    setEditSaving(true);
    try {
      await (window as any).ether.discogs.updateTrack({
        id:     editMeta.id,
        title:  editMeta.title  || undefined,
        artist: editMeta.artist || undefined,
        album:  editMeta.album  || undefined,
        year:   editMeta.year   ? parseInt(editMeta.year, 10) : undefined,
        genre:  editMeta.genre  || undefined,
        bpm:    editMeta.bpm    ? parseFloat(editMeta.bpm) : undefined,
      });
      await load();
      setEditMeta(null);
    } catch (e) { console.error(e); }
    setEditSaving(false);
  };

  const lookupDiscogs = async () => {
    if (!editMeta) return;
    setDiscogsLoading(true); setDiscogsError("");
    const res = await (window as any).ether.discogs.search(editMeta.title, editMeta.artist);
    setDiscogsLoading(false);
    if (!res.ok) { setDiscogsError(res.error || "Lookup failed"); return; }
    setDiscogsResults(res.results || []);
  };

  const applyDiscogsResult = (r: DiscogsResult) => {
    if (!editMeta) return;
    const parts = r.title.split(" - ");
    const album = parts.length > 1 ? parts.slice(1).join(" - ") : r.album;
    const artist = parts.length > 1 ? parts[0] : r.artist;
    setEditMeta(prev => prev ? { ...prev, artist: artist || prev.artist, album: album || prev.album, year: r.year ? String(r.year) : prev.year, genre: r.genre || prev.genre } : prev);
    setDiscogsResults([]);
  };

  // ── Inline cell editing ────────────────────────────────────
  const [inlineEdit, setInlineEdit] = useState<{ id: number; col: LibCol; value: string } | null>(null);

  const commitInline = async () => {
    if (!inlineEdit) return;
    if (libraryBorrowed) { setInlineEdit(null); return; }  // catalog core fields (title/artist/album/year/genre/bpm) are read-only when borrowed
    const { id, col, value } = inlineEdit;
    setInlineEdit(null);
    const fieldMap: Partial<Record<LibCol, string>> = { title: "title", artist: "artist", album: "album", year: "year", genre: "genre", bpm: "bpm" };
    if (!fieldMap[col]) return;
    const payload: any = { id };
    if (col === "year") payload.year = parseInt(value, 10) || undefined;
    else if (col === "bpm") payload.bpm = parseFloat(value) || undefined;
    else (payload as any)[col] = value;
    await (window as any).ether.discogs.updateTrack(payload);
    await load();
  };

  const commitMetaEdit = async (songId: number, col: MetadataColumn, value: string) => {
    if (col.dataType === 'number' && value !== '' && isNaN(Number(value))) return;
    if (value === '') return;

    // For single_choice: resolve the vocab FK so we write BOTH value_text and value_vocabulary_id
    const vocabRow = col.dataType === 'single_choice'
      ? vocabByDef[col.defId]?.find((v: any) => v.value === value)
      : undefined;
    const vocabId = vocabRow?.id ?? null;

    // Optimistic update — show new value immediately so 30Hz re-renders don't snap the cell back
    const prevValue   = metaMap[songId]?.[col.defId];
    const prevVocabId = metaVocabIdMap[songId]?.[col.defId];
    setMetaMap(prev => ({ ...prev, [songId]: { ...(prev[songId] ?? {}), [col.defId]: value } }));
    if (col.dataType === 'single_choice') {
      setMetaVocabIdMap(prev => {
        const songRow = { ...(prev[songId] ?? {}) };
        if (vocabId != null) songRow[col.defId] = vocabId; else delete songRow[col.defId];
        return { ...prev, [songId]: songRow };
      });
    }

    try {
      await (window as any).ether.songMetadataValues.upsert({
        station_id:          stationId,
        song_id:             songId,
        definition_id:       col.defId,
        value_text:          value || null,
        value_vocabulary_id: vocabId,
      });
    } catch (e) {
      console.error('[commitMetaEdit] IPC failed, reverting:', e);
      setMetaMap(prev => {
        const row = { ...(prev[songId] ?? {}) };
        if (prevValue === undefined) delete row[col.defId]; else row[col.defId] = prevValue;
        return { ...prev, [songId]: row };
      });
      if (col.dataType === 'single_choice') {
        setMetaVocabIdMap(prev => {
          const row = { ...(prev[songId] ?? {}) };
          if (prevVocabId === undefined) delete row[col.defId]; else row[col.defId] = prevVocabId;
          return { ...prev, [songId]: row };
        });
      }
    }
  };

  // ── Multi-choice toggle ───────────────────────────────────
  const toggleMultiChoice = async (songId: number, defId: number, vocab: MetadataVocabulary) => {
    const current   = metaMultiMap[songId]?.[defId] ?? [];
    const isChecked = current.some(r => r.vocabId === vocab.id);
    // Per-definition lock: one upsert in flight at a time per song+def.
    // Trades rapid per-item toggling for atomic diff correctness.
    const key = `${songId}:${defId}`;

    // Compute desired final state
    const newIds = isChecked
      ? current.filter(r => r.vocabId !== vocab.id).map(r => r.vocabId)
      : [...current.map(r => r.vocabId), vocab.id];

    // Optimistic update
    if (isChecked) {
      setMetaMultiMap(prev => {
        const arr = (prev[songId]?.[defId] ?? []).filter(r => r.vocabId !== vocab.id);
        return { ...prev, [songId]: { ...(prev[songId] ?? {}), [defId]: arr } };
      });
    } else {
      setMetaMultiMap(prev => {
        const arr = [...(prev[songId]?.[defId] ?? []), { uuid: `tmp-${Date.now()}-${vocab.id}`, vocabId: vocab.id, value: vocab.value }];
        return { ...prev, [songId]: { ...(prev[songId] ?? {}), [defId]: arr } };
      });
    }

    inFlightCreates.current.add(key);
    try {
      await (window as any).ether.songMetadataValues.upsert({
        station_id: stationId, song_id: songId, definition_id: defId,
        value_vocabulary_ids: newIds,
      });
    } catch (e) {
      console.error('[toggleMultiChoice] upsert failed, reverting:', e);
      setMetaMultiMap(prev => ({ ...prev, [songId]: { ...(prev[songId] ?? {}), [defId]: current } }));
    } finally {
      inFlightCreates.current.delete(key);
    }
  };

  // ── Single-choice clear ───────────────────────────────────
  const clearSingleChoice = async (songId: number, defId: number) => {
    const prevValue   = metaMap[songId]?.[defId];
    const prevVocabId = metaVocabIdMap[songId]?.[defId];
    // Optimistic clear
    setMetaMap(prev => { const r = { ...(prev[songId] ?? {}) }; delete r[defId]; return { ...prev, [songId]: r }; });
    setMetaVocabIdMap(prev => { const r = { ...(prev[songId] ?? {}) }; delete r[defId]; return { ...prev, [songId]: r }; });
    try {
      // Upsert with both values null signals "clear" to the handler:
      //   row exists  → soft-delete, returns action: 'cleared'
      //   no row      → no-op, returns action: 'no-change'
      await (window as any).ether.songMetadataValues.upsert({
        station_id: stationId, song_id: songId, definition_id: defId,
        value_text: null, value_vocabulary_id: null,
      });
    } catch (e) {
      console.error('[clearSingleChoice] upsert failed, reverting:', e);
      if (prevValue !== undefined) setMetaMap(prev => ({ ...prev, [songId]: { ...(prev[songId] ?? {}), [defId]: prevValue } }));
      if (prevVocabId !== undefined) setMetaVocabIdMap(prev => ({ ...prev, [songId]: { ...(prev[songId] ?? {}), [defId]: prevVocabId } }));
    }
  };

  // ── Column resize drag ─────────────────────────────────────
  const startColResize = (col: LibCol, e: React.MouseEvent, currentW: number) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = currentW;
    const onMove = (ev: MouseEvent) => {
      const newW = Math.min(600, Math.max(40, startW + ev.clientX - startX));
      setColWidths(prev => {
        const next = { ...prev, [col]: newW };
        localStorage.setItem(`ether_lib_col_widths_${stationId}`, JSON.stringify(next));
        return next;
      });
    };
    const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const startMetaColResize = (defId: number, e: React.MouseEvent, currentW: number) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = currentW;
    const onMove = (ev: MouseEvent) => {
      const newW = Math.min(600, Math.max(40, startW + ev.clientX - startX));
      setMetaColWidths(prev => {
        const next = { ...prev, [defId]: newW };
        localStorage.setItem(`ether_lib_meta_col_widths_${stationId}`, JSON.stringify(next));
        return next;
      });
    };
    const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };


  const createCategory = async () => {
    if (!newCatCode.trim() || !newCatName.trim()) return;
    try {
      await (window as any).ether.categories.create({ station_id: stationId, code: newCatCode.trim().toUpperCase(), name: newCatName.trim(), color: newCatColor });
      setNewCatCode(""); setNewCatName(""); setNewCatColor("var(--accent-blue)");
      setShowCreateCat(false);
      load();
      setStatus("Category created: " + newCatCode.trim().toUpperCase());
      setTimeout(() => setStatus(""), 2000);
    } catch(e) { setStatus("Error: " + e); }
  };

  const load = async () => {
    try {
      const rows = await queryScoped<SongRow>("SELECT s.*, a.name as artist_name, al.title as album_title, al.year as album_year, c.code as category_code, c.color as category_color FROM songs s LEFT JOIN artists a ON a.id = s.artist_id LEFT JOIN albums al ON al.id = s.album_id LEFT JOIN categories c ON c.id = s.category_id WHERE s.deleted_at IS NULL ORDER BY s.title LIMIT 500", [], stationId, { skipScoping: true });
      setSongs(rows);
      const [r] = await query<{ c: number }>("SELECT COUNT(*) as c FROM songs WHERE deleted_at IS NULL");
      setCount(r ? r.c : 0);
      // station_id scoping: Strategy B — single table
      setCatList(await queryScoped<{ id: number; code: string; name: string | null; color: string | null }>("SELECT id, code, name, color FROM categories ORDER BY code", [], stationId));
    } catch (e) { console.error(e); setStatus("Error: " + e); }
    setLoading(false);
  };
  useEffect(() => { load(); }, [stationId]);

  // Load definitions and restore per-station metadata column visibility + widths
  const reloadDefs = useCallback(async () => {
    try {
      const res = await (window as any).ether.metadataDefinitions.list(stationId);
      const rows: MetadataDefinition[] = res?.ok ? (res.rows ?? []) : [];
      // Hide built-in defs that duplicate a native standard column (BPM/Genre/Plays/Year/Length/Kind) —
      // one column per field; the native column carries the real data.
      setDefs(rows.filter(d => !d.deleted_at && !HIDDEN_BUILTIN_COL_NAMES.has((d.name || '').trim().toLowerCase())).sort((a, b) => a.display_order - b.display_order || a.name.localeCompare(b.name)));
    } catch (e) { console.error('[LibraryPanel] failed to load definitions:', e); }
  }, [stationId]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(`ether_lib_meta_cols_${stationId}`);
      setVisibleMetaCols(new Set(JSON.parse(stored || '[]')));
    } catch { setVisibleMetaCols(new Set()); }
    try {
      const storedW = localStorage.getItem(`ether_lib_meta_col_widths_${stationId}`);
      setMetaColWidths(JSON.parse(storedW || '{}'));
    } catch { setMetaColWidths({}); }
    reloadDefs();
  }, [stationId]);

  // Fetch song_metadata_values for visible songs via server-side filtering.
  // Loads ALL smv rows for the current song page regardless of which columns are
  // visible — column visibility is a render-time filter only. Dep array omits
  // visibleMetaCols intentionally: toggling a column doesn't need a new network
  // round-trip since the data is already loaded.
  useEffect(() => {
    if (visibleMetaCols.size === 0 || songs.length === 0) { setMetaMap({}); setMetaVocabIdMap({}); setMetaMultiMap({}); return; }
    (async () => {
      try {
        const songIds = songs.map((s: any) => s.id);
        const res = await (window as any).ether.songMetadataValues.listBySong(songIds, stationId);
        const rows: any[] = res?.ok ? (res.rows ?? []) : [];
        const map: Record<number, Record<number, string>> = {};
        const vocabIdMap: Record<number, Record<number, number>> = {};
        const multiMap: Record<number, Record<number, MultiItem[]>> = {};
        for (const r of rows) {
          const defType = defs.find((d: any) => d.id === r.definition_id)?.data_type;
          if (defType === 'multi_choice') {
            if (!multiMap[r.song_id]) multiMap[r.song_id] = {};
            if (!multiMap[r.song_id][r.definition_id]) multiMap[r.song_id][r.definition_id] = [];
            multiMap[r.song_id][r.definition_id].push({ uuid: r.uuid, vocabId: r.value_vocabulary_id ?? 0, value: r.value_text ?? '' });
          } else {
            if (!map[r.song_id]) map[r.song_id] = {};
            map[r.song_id][r.definition_id] = r.value_text ?? '';
            if (r.value_vocabulary_id != null) {
              if (!vocabIdMap[r.song_id]) vocabIdMap[r.song_id] = {};
              vocabIdMap[r.song_id][r.definition_id] = r.value_vocabulary_id;
            }
          }
        }
        setMetaMap(map);
        setMetaVocabIdMap(vocabIdMap);
        setMetaMultiMap(multiMap);
      } catch (e) { console.error('[LibraryPanel] failed to load metadata values:', e); }
    })();
  }, [stationId, songs, smvReloadKey]);

  // Load vocabulary for all definitions in this station (needed for choice-type cell editors)
  useEffect(() => {
    (async () => {
      try {
        const res = await (window as any).ether.metadataVocabulary.list(stationId);
        const rows: MetadataVocabulary[] = res?.ok ? (res.rows ?? []) : [];
        const byDef: Record<number, MetadataVocabulary[]> = {};
        for (const v of rows.filter((v: MetadataVocabulary) => !v.deleted_at)) {
          if (!byDef[v.definition_id]) byDef[v.definition_id] = [];
          byDef[v.definition_id].push(v);
        }
        for (const arr of Object.values(byDef)) arr.sort((a, b) => a.display_order - b.display_order);
        setVocabByDef(byDef);
      } catch (e) { console.error('[LibraryPanel] failed to load vocabulary:', e); }
    })();
  }, [stationId, vocabReloadKey]);

  const toggleSelect = (id: number) => { setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; }); };
  const selectAll = () => { setSelectedIds(prev => prev.size === filtered.length ? new Set() : new Set(filtered.map(s => s.id))); };
  const deleteSelected = async () => {
    if (!confirm("Delete " + selectedIds.size + " song(s)?")) return;
    for (const id of selectedIds) await (window as any).ether.songs.deleteById(id);
    setSelectedIds(new Set()); load();
  };
  const deleteAll = async () => {
    if (!confirm("Delete ALL " + count + " songs?")) return;
    await (window as any).ether.songs.deleteByStation(stationId); setSelectedIds(new Set()); load();
  };
  const analyzeLufs = async () => {
    // station_id scoping: Strategy B — single table with existing WHERE
    const songs = await queryScoped<{id: number, file_path: string}>("SELECT id, file_path FROM songs WHERE file_path IS NOT NULL AND gain_db = 0 LIMIT 50", [], stationId);
    if (songs.length === 0) { setStatus("All songs already analyzed"); setTimeout(() => setStatus(""), 3000); return; }
    setStatus("Analyzing... 0/" + songs.length); let done = 0;
    for (const song of songs) {
      try { const gain = await invoke<number>("analyze_lufs", { filePath: song.file_path }); await (window as any).ether.songs.updateById(song.id, { gain_db: gain }); } catch {}
      done++; setStatus("Analyzing... " + done + "/" + songs.length);
    }
    setStatus("Done! Analyzed " + done + " songs."); setTimeout(() => setStatus(""), 4000);
  };
  const relocateLibrary = async () => {
    // Per-station relocate (DESIGN-TRUTH §2): pick THIS station's folder, save it, and relink by title
    // ONLY from that folder — verifying each file exists. Songs with no file are skipped (no dead air),
    // and returned so you know what to add. Replaces the old blind path-rewrite (no existence check,
    // Windows-slash bug, and it skipped songs that had no path — i.e. exactly the ones that needed it).
    const r = await (window as any).ether.stationFolders.relocate(stationId);
    if (!r || r.canceled) return;
    if (!r.ok) { setStatus(r.error || "Relocate failed"); setTimeout(() => setStatus(""), 5000); return; }
    setMissingSongs(r.missing || []);
    setStatus(`Relocated: linked ${r.linked}/${r.total}` + (r.missing?.length ? `, ${r.missing.length} missing` : ""));
    setTimeout(() => setStatus(""), 6000); load();
  };
  const queueAll = () => { engine.addToQueue(filtered.filter(s => s.file_path).map(s => ({ filePath: s.file_path!, title: s.title, artist: s.artist_name || "", durationMs: s.duration_ms ?? 0 }))); window.dispatchEvent(new CustomEvent('ether:queue-changed')); };
  const filtered = songs.filter(s => {
    const matchSearch = !search ||
      (s.title||"").toLowerCase().includes(search.toLowerCase()) ||
      (s.artist_name||"").toLowerCase().includes(search.toLowerCase()) ||
      (s.cart_id||"").toLowerCase().includes(search.toLowerCase());
    const matchCat = !categoryFilter || (s.category_code || "") === categoryFilter;
    return matchSearch && matchCat;
  });

  const S = {
    btn: (bg: string, color = "#fff") => ({ padding: "6px 14px", borderRadius: 0, fontSize: 13, fontWeight: 600 as any, background: bg, color, border: "none", cursor: "pointer" as any }),
    btnOutline: { padding: "6px 12px", borderRadius: 0, fontSize: 13, fontWeight: 600 as any, background: "var(--bg-tertiary)", color: "var(--text-tertiary)" as any, border: "1px solid var(--border-primary)", cursor: "pointer" as any },
  };

  const META_COL_WIDTHS: Record<MetadataDefinition['data_type'], number> = {
    text: 160, number: 90, date: 110, boolean: 70, single_choice: 140, multi_choice: 180,
  };

  const visibleLibraryCols: LibraryColumn[] = [
    ...ALL_LIB_COLS.filter(c => visibleCols.has(c)).map(c => ({ kind: 'standard' as const, id: c, label: LIB_COL_LABELS[c] })),
    ...defs.filter(d => visibleMetaCols.has(d.id)).map(d => ({ kind: 'metadata' as const, defId: d.id, defUuid: d.uuid, label: d.name, dataType: d.data_type, width: META_COL_WIDTHS[d.data_type] })),
  ];

  // ── Uniform column sort ─────────────────────────────────────────────────────
  // ONE handler for EVERY header (standard + metadata). Click a header → sort by that column; click again →
  // flip direction; the active header shows ▲/▼. No per-column wiring — any column Jeff enables now, and any
  // metadata field added later, becomes sortable automatically. Metadata values come from metaMap, typed by
  // the definition's data_type (number/date sort numerically/chronologically; everything else lexically).
  const colSortKey = (col: LibraryColumn) => col.kind === 'standard' ? col.id : `meta-${col.defId}`;
  // Built-in DATE columns carry no stored metadata value — resolve them from the song's own timestamp
  // (songs.updated_at / created_at, ISO text) so they display AND sort. Returns epoch ms, or null when the
  // column isn't a mapped built-in / the row has no value; user-created date columns fall through to metaMap.
  const builtinDateMs = (col: LibraryColumn, s: SongRow): number | null => {
    if (col.kind !== 'metadata' || col.dataType !== 'date') return null;
    const name = (col.label || '').trim().toLowerCase();
    if (name === 'last played') {                 // native last_played_at is unix SECONDS
      const n = Number((s as any).last_played_at);
      return isFinite(n) && n > 0 ? n * 1000 : null;
    }
    const src = name === 'date modified' ? (s as any).updated_at
              : name === 'date added'    ? (s as any).created_at
              : null;
    if (src == null || src === '') return null;
    const t = Date.parse(String(src));
    return isNaN(t) ? null : t;
  };
  // Built-in NUMBER columns backed by a native field (Intro/Outro Time ← intro_end/outro_start, seconds).
  const builtinNumber = (col: LibraryColumn, s: SongRow): number | null => {
    if (col.kind !== 'metadata' || col.dataType !== 'number') return null;
    const name = (col.label || '').trim().toLowerCase();
    const src = name === 'intro time' ? (s as any).intro_end
              : name === 'outro time' ? (s as any).outro_start
              : null;
    if (src == null) return null;
    const n = Number(src);
    return isFinite(n) ? n : null;
  };
  const sortValueFor = (col: LibraryColumn, s: SongRow): string | number | null => {
    if (col.kind === 'metadata') {
      const builtin = builtinDateMs(col, s);
      if (builtin != null) return builtin;
      const bnum = builtinNumber(col, s);
      if (bnum != null) return bnum;
      const raw = metaMap[s.id]?.[col.defId];
      if (raw == null || raw === '') return null;
      if (col.dataType === 'number') { const n = Number(raw); return isNaN(n) ? null : n; }
      if (col.dataType === 'date')   { const t = Date.parse(raw); return isNaN(t) ? String(raw).toLowerCase() : t; }
      return String(raw).toLowerCase();
    }
    switch (col.id) {
      case 'title':    return (s.title || '').toLowerCase();
      case 'artist':   return (s.artist_name || '').toLowerCase();
      case 'album':    return (s.album_title || '').toLowerCase();
      case 'year':     return s.album_year ?? null;
      case 'genre':    return (s.genre || '').toLowerCase();
      case 'bpm':      return s.bpm ?? null;
      case 'format':   return s.file_path ? fmtExt(s.file_path) : null;
      case 'duration': return s.duration_ms ?? null;
      case 'category': return (s.category_code || '').toLowerCase();
      case 'plays':    return eligMap[s.id]?.plays ?? s.play_count ?? 0;
      default:         return null;
    }
  };
  const onHeaderSort = (key: string) =>
    setSort(prev => prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' });
  const sortArrow = (key: string) => sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
  const sortCol = visibleLibraryCols.find(c => colSortKey(c) === sort.key) || null;
  // The rows the body renders — filtered, then ordered by the active column. Blanks always sort last.
  const sorted = sortCol
    ? [...filtered].sort((a, b) => {
        const av = sortValueFor(sortCol, a), bv = sortValueFor(sortCol, b);
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        const cmp = (typeof av === 'number' && typeof bv === 'number') ? av - bv : String(av).localeCompare(String(bv));
        return sort.dir === 'asc' ? cmp : -cmp;
      })
    : filtered;

  const hasTitleCol = visibleCols.has('title');
  const ACTION_ZONE_W = 252; // 6 buttons × 36px min-width + 5 gaps × 3px + 12px h-padding
  const titleW = colWidths['title'] ?? LIB_COL_DEFAULT_WIDTHS['title'];
  const middleCols = visibleLibraryCols.filter(c => !(c.kind === 'standard' && c.id === 'title'));
  const colW = (col: LibraryColumn): number =>
    col.kind === 'standard'
      ? (colWidths[col.id] ?? LIB_COL_DEFAULT_WIDTHS[col.id])
      : (metaColWidths[col.defId] ?? META_COL_WIDTHS[col.dataType]);
  const gridCols = ['32px', '36px', ...(hasTitleCol ? [`${titleW}px`] : []), '1fr', `${ACTION_ZONE_W}px`].join(' ');

  // Greedy column pager — subtract frozen track widths to get true available space
  const libPages: LibraryColumn[][] = (() => {
    const frozenW = 32 + 36 + (hasTitleCol ? titleW : 0) + ACTION_ZONE_W;
    const availW  = middleZoneW - frozenW;
    if (availW <= 0 || middleCols.length === 0) return [middleCols];
    const pages: LibraryColumn[][] = [];
    let page: LibraryColumn[] = [];
    let pageW = 0;
    for (const col of middleCols) {
      const w = colW(col);
      if (page.length === 0) { page.push(col); pageW = w; }
      else if (pageW + w <= availW) { page.push(col); pageW += w; }
      else { pages.push(page); page = [col]; pageW = w; }
    }
    if (page.length > 0) pages.push(page);
    return pages.length > 0 ? pages : [middleCols];
  })();
  const safePageIdx     = Math.min(libPageIdx, Math.max(0, libPages.length - 1));
  const pageMiddleCols  = libPages[safePageIdx] ?? middleCols;

  useEffect(() => {
    if (!middleHeaderRef.current || process.env.NODE_ENV !== 'development') return;
    const availW = middleHeaderRef.current.offsetWidth;
    const totalW = middleCols.reduce((sum, col) => sum + colW(col), 0);
    if (totalW > availW) console.warn(`[LibraryPanel] middle zone overflow: ${totalW}px cols in ${availW}px`);
  }, []);

  // Load persisted page index when stationId is known
  useEffect(() => {
    if (!stationId) return;
    try { setLibPageIdx(parseInt(localStorage.getItem(`ether_lib_page_${stationId}`) || "0") || 0); } catch {}
  }, [stationId]);

  // Persist page index on change
  useEffect(() => {
    if (!stationId) return;
    try { localStorage.setItem(`ether_lib_page_${stationId}`, String(libPageIdx)); } catch {}
  }, [libPageIdx, stationId]);


  return (
    <div style={{ display: "flex", flexDirection: "column" as any, gap: 14, fontFamily: "'Inter', system-ui, sans-serif" }}>
      {/* Spotify import modal — rendered above everything else */}
      {showSpotify && <SpotifyImport onClose={() => { setShowSpotify(false); load(); }} />}

      {/* Library columns panel */}
      <LibraryColumnsPanel
        isOpen={columnsPanelOpen}
        onClose={() => { setColumnsPanelOpen(false); setVocabReloadKey(k => k + 1); }}
        visibleColumns={visibleCols}
        onColumnToggle={toggleCol}
        stationId={stationId}
        visibleMetadataColumns={visibleMetaCols}
        onMetadataColumnToggle={toggleMetaCol}
        onDefinitionsChanged={reloadDefs}
        onCascadeDelete={() => setSmvReloadKey(k => k + 1)}
      />

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--text-primary)", margin: 0, fontFamily: "'Inter', sans-serif" }}>Song Library</h1>
          <span style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 2 }}>
            {count} tracks{(search || categoryFilter) ? ` · ${filtered.length} shown` : ""}
            {categoryFilter ? ` in ${categoryFilter}` : ""}
          </span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {/* Spotify import button */}
          <button onClick={() => setShowSpotify(true)} style={{ padding: "7px 14px", borderRadius: 0, fontSize: 12, fontWeight: 700, background: "rgba(29,185,84,0.08)", color: "#1db954", border: "1px solid rgba(29,185,84,0.3)", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>
            Import from Spotify
          </button>
          <button onClick={relocateLibrary} style={{ padding: "7px 14px", borderRadius: 0, fontSize: 12, fontWeight: 600, background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-secondary)", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            Relocate
          </button>
          <button onClick={analyzeLufs} style={{ padding: "7px 14px", borderRadius: 0, fontSize: 12, fontWeight: 600, background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-secondary)", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>
            Normalize
          </button>
          {isStation
            ? <button onClick={() => setShowNexGen(!showNexGen)} style={{ padding: "7px 14px", borderRadius: 0, fontSize: 12, fontWeight: 600, background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-secondary)", cursor: "pointer" }}>{showNexGen ? "Cancel" : "NexGen / ENCO"}</button>
            : <button onClick={() => window.dispatchEvent(new CustomEvent("ether:open-subscription"))} style={{ padding: "7px 14px", borderRadius: 0, fontSize: 12, fontWeight: 600, background: "rgba(167,139,250,0.08)", color: "#a78bfa", border: "1px solid rgba(167,139,250,0.25)", cursor: "pointer" }} title="Network plan required">🔒 NexGen / ENCO</button>
          }
          <button onClick={() => { setShowCreateCat(p => !p); setShowImport(false); }} style={{ padding: "7px 14px", borderRadius: 0, fontSize: 12, fontWeight: 700, background: showCreateCat ? "var(--accent-purple)" : "var(--bg-secondary)", color: showCreateCat ? "#fff" : "var(--text-secondary)", border: "1px solid var(--border-secondary)", cursor: "pointer" }}>{showCreateCat ? "Cancel" : "+ Category"}</button>
          {libraryBorrowed
            ? <button disabled title="Library is read-only — its catalog is borrowed from another account. You can still program and tag these songs for your station." style={{ padding: "7px 16px", borderRadius: 0, fontSize: 12, fontWeight: 700, background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-secondary)", cursor: "not-allowed", opacity: 0.6 }}>🔒 Borrowed (read-only)</button>
            : <button onClick={() => { setShowImport(p => !p); setShowCreateCat(false); }} style={{ padding: "7px 16px", borderRadius: 0, fontSize: 12, fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer", boxShadow: "0 2px 8px rgba(14,165,233,0.35)" }}>{showImport ? "Cancel" : "+ Import Music"}</button>
          }
        </div>
      </div>

      {missingSongs.length > 0 && (
        <div style={{ padding: "8px 12px", marginBottom: 4, background: "rgba(245,158,11,0.10)", border: "1px solid rgba(245,158,11,0.35)", color: "#f59e0b", fontSize: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <strong>{missingSongs.length} song{missingSongs.length === 1 ? "" : "s"} missing a file in this station&apos;s folder — add the file or fix the title, then Re-sync.</strong>
            <button onClick={() => setMissingSongs([])} style={{ background: "none", border: "none", color: "#f59e0b", cursor: "pointer", fontSize: 14 }}>✕</button>
          </div>
          <div style={{ maxHeight: 140, overflowY: "auto", fontSize: 11, opacity: 0.9 }}>
            {missingSongs.map((t, i) => <div key={i}>• {t}</div>)}
          </div>
        </div>
      )}

      {libraryBorrowed && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", marginBottom: 4, borderRadius: 0, background: "rgba(167,139,250,0.10)", border: "1px solid rgba(167,139,250,0.35)", color: "#a78bfa", fontSize: 12, fontWeight: 600 }}>
          🔒 This library is read-only — its catalog (songs, artists, albums) is borrowed from another account. You can still program and tag these songs for your station.
        </div>
      )}

      {/* Filters row */}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input placeholder="Search title or artist…" value={search} onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, maxWidth: 280, padding: "8px 12px", borderRadius: 0, fontSize: 12, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }} />
        {/* Category filter */}
        <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}
          style={{ padding: "8px 12px", borderRadius: 0, fontSize: 12, background: categoryFilter ? "rgb(from var(--accent-blue) r g b / 0.1)" : "var(--bg-secondary)", border: `1px solid ${categoryFilter ? "rgb(from var(--accent-blue) r g b / 0.4)" : "var(--border-primary)"}`, color: categoryFilter ? "var(--accent-cyan)" : "var(--text-secondary)", outline: "none", cursor: "pointer" }}>
          <option value="">All Categories</option>
          {catList.map(c => <option key={c.id} value={c.code}>{c.code}</option>)}
        </select>
        {/* Assign category to filtered songs */}
        <select onChange={async (e) => {
          const code = e.target.value; e.target.value = "";
          if (!code) return;
          const cat = catList.find(c => c.code === code);
          const catId = cat?.id ?? null;
          // Guard the exact bug that wiped categories: a code with no matching station category would
          // resolve to null and CLEAR the category on every shown song. Never mass-clear by accident.
          if (catId == null) { window.alert(`"${code}" isn't a category for this station — nothing was changed.`); return; }
          if (!window.confirm(`Assign category "${cat?.name || code}" to all ${filtered.length} shown song${filtered.length === 1 ? "" : "s"}?\n\nThis OVERWRITES their current category for this station and can't be undone.`)) return;
          for (const s of filtered) await (window as any).ether.songs.updateById(s.id, { category_id: catId });
          load();
        }}
          style={{ padding: "8px 12px", borderRadius: 0, fontSize: 12, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", outline: "none", cursor: "pointer" }}>
          <option value="">Assign category...</option>
          {catList.map(c => <option key={c.id} value={c.code}>All → {c.code}</option>)}
        </select>
        <button onClick={queueAll} style={S.btn("var(--accent-green)", "#000")}>Queue All</button>
        {selectedIds.size >= 2 && <button onClick={() => setShowBulkAssign(true)} style={S.btn("var(--accent-purple)")}>Bulk assign metadata</button>}
        {selectedIds.size > 0 && <button onClick={deleteSelected} style={S.btn("var(--accent-red)")}>Delete {selectedIds.size}</button>}
        <button onClick={deleteAll} style={{ ...S.btnOutline, color: "var(--accent-red)" as any }}>Delete All</button>
      </div>

      {showBulkAssign && stationId != null && (
        <BulkAssignModal
          songIds={[...selectedIds]}
          stationId={stationId}
          onClose={() => setShowBulkAssign(false)}
          onApplied={() => { setShowBulkAssign(false); setSmvReloadKey(k => k + 1); load(); }}
        />
      )}
      {status && <div style={{ padding: "10px 14px", background: "rgb(from var(--accent-blue) r g b / 0.08)", border: "1px solid rgb(from var(--accent-blue) r g b / 0.2)", borderRadius: 0, fontSize: 12, color: "var(--accent-blue)" }}>{status}</div>}
      {showCreateCat && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "12px 16px", background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, marginBottom: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", whiteSpace: "nowrap" as any }}>New Category</span>
          <input placeholder="Code (e.g. AC)" value={newCatCode} onChange={e => setNewCatCode(e.target.value.toUpperCase().slice(0,6))}
            style={{ width: 80, padding: "6px 10px", borderRadius: 0, fontSize: 12, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }} />
          <input placeholder="Name (e.g. Adult Contemporary)" value={newCatName} onChange={e => setNewCatName(e.target.value)}
            style={{ flex: 1, padding: "6px 10px", borderRadius: 0, fontSize: 12, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }}
            onKeyDown={e => { if (e.key === "Enter") createCategory(); }} />
          <input type="color" value={newCatColor} onChange={e => setNewCatColor(e.target.value)}
            style={{ width: 36, height: 32, borderRadius: 0, border: "1px solid var(--border-primary)", cursor: "pointer", padding: 2, background: "var(--bg-tertiary)" }} />
          <button onClick={createCategory} style={{ padding: "6px 16px", borderRadius: 0, fontSize: 12, fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer" }}>Create</button>
        </div>
      )}
      {showImport && <ImportDialog onDone={() => { setShowImport(false); load(); }} />}
      {showNexGen && <NexGenImport onDone={() => { setShowNexGen(false); load(); }} />}

      {/* Context menu */}
      {ctxMenu && (
        <div ref={ctxRef} style={{ position: "fixed", left: ctxMenu.x, top: ctxMenu.y, zIndex: 9999, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", boxShadow: "0 8px 24px rgba(0,0,0,0.4)", minWidth: 180, borderRadius: 0 }}>
          {[
            { label: "Edit Metadata", action: () => openEditMeta(ctxMenu.song) },
            { label: ctxMenu.song.content_class === "JIN" ? "Unmark Jingle (→ Music)" : "Mark as Jingle (JIN)", action: async () => { const next = ctxMenu.song.content_class === "JIN" ? "MUSIC" : "JIN"; setCtxMenu(null); await (window as any).ether.songs.updateById(ctxMenu.song.id, { content_class: next }); load(); } },
            { label: ctxMenu.song.content_class === "SWP" ? "Unmark Sweeper (→ Music)" : "Mark as Sweeper (SWP)", action: async () => { const next = ctxMenu.song.content_class === "SWP" ? "MUSIC" : "SWP"; setCtxMenu(null); await (window as any).ether.songs.updateById(ctxMenu.song.id, { content_class: next }); load(); } },
            { label: ctxMenu.song.content_class === "SPOT" ? "Unmark Spot (→ Music)" : "Mark as Spot (SPOT)", action: async () => {
              const song = ctxMenu.song; setCtxMenu(null);
              if (song.content_class === "SPOT") { await (window as any).ether.songs.updateById(song.id, { content_class: "MUSIC" }); load(); return; }
              await loadSpotCats(); setSpotMark({ song, catId: null, type: "commercial", newCat: "" });
            } },
            { label: ctxMenu.song.cart_id ? `Cart # — ${ctxMenu.song.cart_id}` : "Enter Cart #", action: () => openCartId(ctxMenu.song) },
            { label: "Load to Deck A", action: () => { onLoadA(ctxMenu.song); setCtxMenu(null); } },
            { label: "Load to Deck B", action: () => { onLoadB(ctxMenu.song); setCtxMenu(null); } },
            { label: "Load to Deck C", action: () => { onLoadC(ctxMenu.song); setCtxMenu(null); } },
            { label: "Add to Queue",   action: () => { onQueue(ctxMenu.song); setCtxMenu(null); } },
            { label: "Edit Cue Points", action: () => { onEdit(ctxMenu.song); setCtxMenu(null); } },
            { label: "Send to Studio", action: () => { onSendToStudio(ctxMenu.song); setCtxMenu(null); } },
            null,
            { label: "Delete", action: async () => { setCtxMenu(null); if (confirm("Delete " + ctxMenu.song.title + "?")) { await (window as any).ether.songs.deleteById(ctxMenu.song.id); load(); } }, danger: true },
          ].map((item, idx) => item === null
            ? <div key={idx} style={{ height: 1, background: "var(--border-primary)", margin: "2px 0" }} />
            : <div key={item.label} onMouseDown={() => item.action()} style={{ padding: "9px 16px", fontSize: 13, cursor: "pointer", color: (item as any).danger ? "var(--accent-red)" : "var(--text-primary)", userSelect: "none" as any }}
                onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-hover)")}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                {item.label}
              </div>
          )}
        </div>
      )}

      {/* Mark as Spot — category + type, then create the spots record + tag the track SPOT */}
      {spotMark && (
        <div onMouseDown={() => setSpotMark(null)} style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div onMouseDown={e => e.stopPropagation()} style={{ width: 400, background: "var(--bg-secondary)", border: "1px solid #f59e0b", boxShadow: "0 16px 48px rgba(0,0,0,0.6)", padding: 18 }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: "#f59e0b", marginBottom: 4 }}>Mark as Spot</div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 14, lineHeight: 1.5 }}>
              “{spotMark.song.title}” leaves music rotation and becomes a spot. Fine-tune dates, max-plays &amp; advertiser later in <strong>Spots &amp; Promos</strong>.
            </div>
            <label style={{ display: "block", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: "var(--text-tertiary)", textTransform: "uppercase" as const, marginBottom: 4 }}>Category <span style={{ color: "#f87171" }}>*required</span></label>
            <select value={spotMark.catId ?? ""} onChange={e => setSpotMark(m => m && { ...m, catId: e.target.value ? Number(e.target.value) : null, newCat: "" })}
              style={{ width: "100%", padding: "8px 10px", background: "var(--bg-primary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", fontSize: 13, marginBottom: 8 }}>
              <option value="">— Uncategorized —</option>
              {spotCats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <input value={spotMark.newCat} onChange={e => setSpotMark(m => m && { ...m, newCat: e.target.value, catId: e.target.value ? null : m.catId })}
              placeholder="…or type a new category name" style={{ width: "100%", padding: "8px 10px", background: "var(--bg-primary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", fontSize: 13, marginBottom: 14 }} />
            <label style={{ display: "block", fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: "var(--text-tertiary)", textTransform: "uppercase" as const, marginBottom: 4 }}>Type</label>
            <select value={spotMark.type} onChange={e => setSpotMark(m => m && { ...m, type: e.target.value })}
              style={{ width: "100%", padding: "8px 10px", background: "var(--bg-primary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", fontSize: 13, marginBottom: 18 }}>
              <option value="commercial">Commercial</option>
              <option value="promo">Promo</option>
              <option value="psa">PSA</option>
              <option value="sponsorship">Sponsorship</option>
            </select>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setSpotMark(null)} style={{ padding: "8px 16px", background: "transparent", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Cancel</button>
              {(() => { const ready = !!(spotMark.catId || spotMark.newCat.trim()); return (
                <button onClick={confirmSpotMark} disabled={!ready} title={ready ? "" : "Pick or create a category first"} style={{ padding: "8px 16px", background: ready ? "#f59e0b" : "var(--surface, #333)", border: `1px solid ${ready ? "#f59e0b" : "var(--border-primary)"}`, color: ready ? "#000" : "var(--text-tertiary)", fontSize: 12, fontWeight: 800, cursor: ready ? "pointer" : "not-allowed", opacity: ready ? 1 : 0.6 }}>Mark as Spot</button>
              ); })()}
            </div>
          </div>
        </div>
      )}

      {/* Cart # modal */}
      {cartEdit && (
        <div onClick={e => { if (e.target === e.currentTarget && !cartSaving) setCartEdit(null); }} style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: 340, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", padding: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>Cart # — {cartEdit.title}</div>
            <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 14 }}>A short ID to place this element by number (e.g. 1001, J14, TALK7). Leave blank to clear.</div>
            <input
              value={cartEdit.value}
              onChange={e => setCartEdit({ ...cartEdit, value: e.target.value })}
              onKeyDown={e => { if (e.key === "Enter") saveCartId(); if (e.key === "Escape" && !cartSaving) setCartEdit(null); }}
              placeholder="Cart #"
              autoFocus
              style={{ width: "100%", padding: "9px 12px", borderRadius: 0, fontSize: 16, fontFamily: "'JetBrains Mono', ui-monospace, monospace", letterSpacing: "0.08em", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", boxSizing: "border-box" as const }}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button onClick={saveCartId} disabled={cartSaving} style={{ flex: 1, padding: "8px 0", borderRadius: 0, fontSize: 13, fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer", opacity: cartSaving ? 0.6 : 1 }}>{cartSaving ? "Saving…" : "Save"}</button>
              <button onClick={() => setCartEdit(null)} disabled={cartSaving} style={{ padding: "8px 16px", borderRadius: 0, fontSize: 13, fontWeight: 600, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Metadata modal */}
      {editMeta && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 9998, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "var(--bg-primary)", border: "1px solid var(--border-primary)", borderRadius: 0, width: 580, maxWidth: "92vw", boxShadow: "0 16px 48px rgba(0,0,0,0.5)" }}>
            <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border-primary)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)" }}>Edit Metadata</span>
              <button onClick={() => setEditMeta(null)} style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 18, lineHeight: 1, padding: 0 }}>✕</button>
            </div>
            <div style={{ padding: "20px 20px 0" }}>
              {[
                { label: "Title",  key: "title",  type: "text" },
                { label: "Artist", key: "artist", type: "text" },
                { label: "Album",  key: "album",  type: "text" },
                { label: "Year",   key: "year",   type: "text" },
                { label: "Genre",  key: "genre",  type: "text" },
                { label: "BPM",    key: "bpm",    type: "text" },
              ].map(({ label, key }) => (
                <div key={key} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                  <span style={{ width: 56, fontSize: 12, fontWeight: 600, color: "var(--text-tertiary)", textAlign: "right" as any, flexShrink: 0 }}>{label}</span>
                  <input value={(editMeta as any)[key]} onChange={e => setEditMeta(prev => prev ? { ...prev, [key]: e.target.value } : prev)}
                    onKeyDown={e => { if (e.key === "Enter") saveEditMeta(); if (e.key === "Escape") setEditMeta(null); }}
                    style={{ flex: 1, padding: "7px 10px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }} />
                </div>
              ))}
            </div>

            {/* Discogs lookup */}
            <div style={{ padding: "8px 20px" }}>
              <button onClick={lookupDiscogs} disabled={discogsLoading} style={{ padding: "7px 16px", borderRadius: 0, fontSize: 12, fontWeight: 700, background: "rgb(from var(--accent-blue) r g b / 0.12)", color: "var(--accent-blue)", border: "1px solid rgb(from var(--accent-blue) r g b / 0.3)", cursor: "pointer" }}>
                {discogsLoading ? "Searching…" : "🔍 Lookup on Discogs"}
              </button>
              {discogsError && <span style={{ marginLeft: 10, fontSize: 12, color: "var(--accent-red)" }}>{discogsError}</span>}
            </div>
            {discogsResults.length > 0 && (
              <div style={{ margin: "0 20px 12px", border: "1px solid var(--border-primary)", background: "var(--bg-secondary)", maxHeight: 220, overflowY: "auto" as any }}>
                {discogsResults.map(r => (
                  <div key={r.id} onClick={() => applyDiscogsResult(r)} style={{ display: "flex", gap: 10, padding: "8px 12px", cursor: "pointer", alignItems: "center", borderBottom: "1px solid var(--border-primary)" }}
                    onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-hover)")}
                    onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                    {r.thumb && <img src={r.thumb} style={{ width: 36, height: 36, objectFit: "cover", flexShrink: 0, borderRadius: 0 }} onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />}
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>{r.title}</div>
                      <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>{[r.year, r.genre, r.format].filter(Boolean).join(" · ")}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div style={{ padding: "12px 20px 16px", display: "flex", gap: 8, justifyContent: "flex-end", borderTop: "1px solid var(--border-primary)" }}>
              <button onClick={() => setEditMeta(null)} style={{ padding: "8px 18px", borderRadius: 0, fontSize: 13, fontWeight: 600, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>Cancel</button>
              <button onClick={saveEditMeta} disabled={editSaving} style={{ padding: "8px 22px", borderRadius: 0, fontSize: 13, fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer" }}>
                {editSaving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div style={{ fontSize: 13, color: "var(--text-tertiary)", padding: 24 }}>Loading...</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: "center" as any, padding: "64px 24px" }}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 12, opacity: 0.4 }}><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
          <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 }}>No music yet</div>
          <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginBottom: 20 }}>Import a folder to get started</div>
          <button onClick={() => setShowImport(true)} style={S.btn("var(--accent-blue)")}>Import Music Folder</button>
        </div>
      ) : (
        <div
          ref={tableRef}
          role="grid"
          style={{
            background: "var(--bg-secondary)",
            border: "1px solid var(--border-primary)",
            borderRadius: 0,
            fontSize: 13,
            overflow: "hidden" as const,
            ["--lib-grid" as any]: gridCols,
          }}
        >
          <style>{`.ether-lib-row{display:grid;grid-template-columns:var(--lib-grid)}.ether-lib-row:hover{background:var(--bg-hover)}`}</style>

          {/* Header */}
          <div role="row" className="ether-lib-row" style={{ borderBottom: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", userSelect: "none" as any }}>
            <div role="columnheader" style={{ padding: "10px 12px", display: "flex", alignItems: "center", borderRight: "1px solid var(--border-primary)" }}>
              <input type="checkbox" checked={selectedIds.size === filtered.length && filtered.length > 0} onChange={selectAll} />
            </div>
            <div role="columnheader" style={{ padding: "10px 6px", fontSize: 12, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.08em", display: "flex", alignItems: "center", borderRight: "1px solid var(--border-primary)" }}>#</div>
            {hasTitleCol && (
              <div role="columnheader" onClick={() => onHeaderSort('title')} title="Sort by Title" style={{ padding: "10px 12px", fontSize: 12, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.08em", display: "flex", alignItems: "center", overflow: "hidden", position: "relative" as any, borderRight: "1px solid var(--border-primary)", cursor: "pointer" }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>Title{sortArrow('title')}</span>
                <span onMouseDown={e => startColResize('title', e, titleW)} onClick={e => e.stopPropagation()} style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 6, cursor: "col-resize", zIndex: 1 }} />
              </div>
            )}
            <div ref={middleHeaderRef} style={{ display: "flex", overflow: "hidden" }}>
              {pageMiddleCols.map(col => {
                const w = colW(col);
                const key = col.kind === 'standard' ? col.id : `meta-${col.defId}`;
                return (
                  <div key={key} role="columnheader" onClick={() => onHeaderSort(key)} title={`Sort by ${col.label}`} style={{ flex: `0 0 ${w}px`, padding: "10px 12px", fontSize: 12, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.08em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any, position: "relative" as any, borderRight: "1px solid var(--border-primary)", cursor: "pointer" }}>
                    {col.label}{sortArrow(key)}
                    <span
                      onMouseDown={e => col.kind === 'standard' ? startColResize(col.id, e, w) : startMetaColResize(col.defId, e, w)}
                      onClick={e => e.stopPropagation()}
                      style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 6, cursor: "col-resize", zIndex: 1 }}
                    />
                  </div>
                );
              })}
            </div>
            <div role="columnheader" style={{ display: "flex", alignItems: "center", gap: 0, padding: "0 4px", borderLeft: "1px solid var(--border-primary)" }}>
              {libPages.length > 1 && (
                <>
                  <button
                    onClick={() => setLibPageIdx(i => Math.max(0, i - 1))}
                    disabled={safePageIdx === 0}
                    title="Previous columns"
                    style={{ display: "flex", alignItems: "center", justifyContent: "center", minWidth: 28, minHeight: 28, background: "none", border: "none", cursor: safePageIdx === 0 ? "default" : "pointer", color: safePageIdx === 0 ? "var(--text-tertiary)" : "var(--text-secondary)", opacity: safePageIdx === 0 ? 0.35 : 1, fontSize: 11, padding: "0 4px", transition: "opacity 0.15s" }}
                  >◀</button>
                  <span style={{ fontSize: 10, color: "var(--text-tertiary)", whiteSpace: "nowrap" as const, padding: "0 2px", userSelect: "none" as const }}>
                    {safePageIdx + 1}/{libPages.length}
                  </span>
                  <button
                    onClick={() => setLibPageIdx(i => Math.min(libPages.length - 1, i + 1))}
                    disabled={safePageIdx === libPages.length - 1}
                    title="Next columns"
                    style={{ display: "flex", alignItems: "center", justifyContent: "center", minWidth: 28, minHeight: 28, background: "none", border: "none", cursor: safePageIdx === libPages.length - 1 ? "default" : "pointer", color: safePageIdx === libPages.length - 1 ? "var(--text-tertiary)" : "var(--text-secondary)", opacity: safePageIdx === libPages.length - 1 ? 0.35 : 1, fontSize: 11, padding: "0 4px", transition: "opacity 0.15s" }}
                  >▶</button>
                </>
              )}
              <button onClick={() => setColumnsPanelOpen(true)} title="Choose columns" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-tertiary)", padding: "2px 4px", fontSize: 14 }}>⚙</button>
            </div>
          </div>

          {/* Body rows */}
          {sorted.map((s, i) => (
            <div
              key={s.id}
              role="row"
              className="ether-lib-row"
              style={{ borderBottom: i < sorted.length - 1 ? "1px solid var(--border-primary)" : "none" }}
              onContextMenu={e => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, song: s }); }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = ""; }}
            >
              {/* Checkbox */}
              <div role="gridcell" style={{ padding: "10px 12px", display: "flex", alignItems: "center", borderRight: "1px solid var(--border-primary)" }}>
                <input type="checkbox" checked={selectedIds.has(s.id)} onChange={() => toggleSelect(s.id)} />
              </div>
              {/* Row # */}
              <div role="gridcell" style={{ padding: "10px 6px", fontSize: 13, color: "var(--text-tertiary)", fontFamily: "'JetBrains Mono', ui-monospace, monospace", display: "flex", alignItems: "center", borderRight: "1px solid var(--border-primary)" }}>
                {i + 1}
              </div>
              {/* Title — explicit EDIT → field → SAVE/CANCEL (no double-click ambiguity). Writes the normal
                   songs.updateById path, so the rename propagates everywhere (decks, pools, placements). */}
              {hasTitleCol && (() => {
                return (
                  <div
                    role="gridcell"
                    style={{ padding: "10px 12px", color: "var(--text-primary)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any, display: "flex", alignItems: "center", borderRight: "1px solid var(--border-primary)" }}
                  >
                    {s.file_path && watermarkedPaths.has(s.file_path) && (
                      <span title="Content provenance watermark embedded" style={{ marginRight: 5, fontSize: 11, color: "#00c8a8", flexShrink: 0 }}>🛡</span>
                    )}
                    {s.cart_id && (
                      <span title={`Cart #${s.cart_id}`} style={{ marginRight: 6, padding: "1px 6px", fontSize: 11, fontWeight: 700, fontFamily: "'JetBrains Mono', ui-monospace, monospace", color: "var(--accent-cyan)", background: "rgb(from var(--accent-cyan) r g b / 0.12)", border: "1px solid rgb(from var(--accent-cyan) r g b / 0.3)", borderRadius: 0, flexShrink: 0, letterSpacing: "0.04em" }}>{s.cart_id}</span>
                    )}
                    {s.content_class === "JIN" && (
                      <span title="Jingle — excluded from music rotation & reporting" style={{ marginRight: 6, padding: "1px 6px", fontSize: 10, fontWeight: 800, fontFamily: "'JetBrains Mono', ui-monospace, monospace", color: "#14e0c8", background: "rgba(20, 224, 200, 0.12)", border: "1px solid rgba(20, 224, 200, 0.35)", borderRadius: 0, flexShrink: 0, letterSpacing: "0.06em" }}>JIN</span>
                    )}
                    {s.content_class === "SWP" && (
                      <span title="Sweeper — excluded from music rotation & reporting" style={{ marginRight: 6, padding: "1px 6px", fontSize: 10, fontWeight: 800, fontFamily: "'JetBrains Mono', ui-monospace, monospace", color: "#4f46e5", background: "rgba(79, 70, 229, 0.14)", border: "1px solid rgba(79, 70, 229, 0.4)", borderRadius: 0, flexShrink: 0, letterSpacing: "0.06em" }}>SWP</span>
                    )}
                    {s.content_class === "SPOT" && (
                      <span title="Spot — commercial/promo; excluded from music rotation & reporting" style={{ marginRight: 6, padding: "1px 6px", fontSize: 10, fontWeight: 800, fontFamily: "'JetBrains Mono', ui-monospace, monospace", color: "#f59e0b", background: "rgba(245, 158, 11, 0.14)", border: "1px solid rgba(245, 158, 11, 0.4)", borderRadius: 0, flexShrink: 0, letterSpacing: "0.06em" }}>SPOT</span>
                    )}
                    <InlineNameEditor
                      value={s.title || ""}
                      readOnly={libraryBorrowed}
                      onSave={async (next) => { await (window as any).ether.songs.updateById(s.id, { title: next }); load(); }}
                    />
                  </div>
                );
              })()}
              {/* Middle zone — current page of columns, clipped to 1fr */}
              <div style={{ display: "flex", overflow: "hidden" }}>
                {pageMiddleCols.map(col => {
                  const w = colW(col);
                  if (col.kind === 'standard') {
                    const id = col.id;
                    const isInline = inlineEdit?.id === s.id && inlineEdit?.col === id;
                    const editableCols: LibCol[] = ["artist", "album", "year", "genre", "bpm"];
                    const isEditable = editableCols.includes(id);
                    const cellVal = (() => {
                      switch (id) {
                        case "artist":   return s.artist_name || null;
                        case "album":    return s.album_title || null;
                        case "year":     return s.album_year ? String(s.album_year) : null;
                        case "genre":    return s.genre || null;
                        case "bpm":      return s.bpm != null ? String(Math.round(s.bpm)) : null;
                        case "format":   return s.file_path ? fmtExt(s.file_path) : null;
                        case "duration": return s.duration_ms ? `${Math.floor(s.duration_ms / 60000)}:${String(Math.floor((s.duration_ms % 60000) / 1000)).padStart(2, "0")}` : null;
                        case "plays":    return s.play_count != null ? String(s.play_count) : "0";
                        default:         return null;
                      }
                    })();
                    if (id === "plays") {
                      const e = eligMap[s.id];
                      const plays = e ? e.plays : (s.play_count ?? 0);
                      const last = e?.lastPlayed ? libTimeAgo(e.lastPlayed) : "never";
                      const rest = e && e.restSec > 0 ? `rest ${libFmtRest(e.restSec)}` : null;
                      return (
                        <div key={id} role="gridcell" style={{ flex: `0 0 ${w}px`, padding: "5px 12px", display: "flex", flexDirection: "column", justifyContent: "center", gap: 2, borderRight: "1px solid var(--border-primary)", overflow: "hidden" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontSize: 13, color: "var(--text-secondary)", fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}>{plays}</span>
                            {e && <LibStatusChip status={e.status} />}
                          </div>
                          <div style={{ fontSize: 10, color: "var(--text-tertiary)", whiteSpace: "nowrap" as const, overflow: "hidden", textOverflow: "ellipsis" }}>
                            {last}{rest ? ` · ${rest}` : ""}
                          </div>
                        </div>
                      );
                    }
                    if (id === "category") return (
                      <div key={id} role="gridcell" style={{ flex: `0 0 ${w}px`, padding: "8px 12px", display: "flex", alignItems: "center", borderRight: "1px solid var(--border-primary)" }}>
                        <select value={s.category_code || ""} onChange={async e => { const catId = catList.find(c => c.code === e.target.value)?.id || null; await (window as any).ether.songs.updateById(s.id, { category_id: catId }); load(); }}
                          style={{ padding: "3px 6px", borderRadius: 0, fontSize: 12, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", outline: "none", cursor: "pointer", maxWidth: "100%" }}>
                          <option value="">—</option>
                          {catList.map(c => <option key={c.id} value={c.code}>{c.code}</option>)}
                        </select>
                      </div>
                    );
                    return (
                      <div
                        key={id}
                        role="gridcell"
                        style={{ flex: `0 0 ${w}px`, padding: "10px 12px", color: ["format","bpm","duration","year"].includes(id) ? "var(--text-tertiary)" : "var(--text-secondary)", fontSize: id === "format" ? 12 : 13, fontFamily: ["format","bpm","duration"].includes(id) ? "'JetBrains Mono', ui-monospace, monospace" : undefined, textTransform: id === "format" ? "uppercase" as any : undefined, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any, display: "flex", alignItems: "center", cursor: isEditable ? "text" : undefined, borderRight: "1px solid var(--border-primary)" }}
                        onDoubleClick={() => isEditable && setInlineEdit({ id: s.id, col: id, value: cellVal || "" })}
                      >
                        {isInline
                          ? <input autoFocus value={inlineEdit!.value} onChange={e => setInlineEdit(prev => prev ? { ...prev, value: e.target.value } : prev)} onBlur={commitInline} onKeyDown={e => { if (e.key === "Enter") commitInline(); if (e.key === "Escape") setInlineEdit(null); }} style={{ flex: 1, padding: "2px 4px", fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--accent-blue)", color: "var(--text-primary)", outline: "none" }} />
                          : (cellVal || "—")}
                      </div>
                    );
                  } else {
                    // MetadataColumn
                    const rawVal = metaMap[s.id]?.[col.defId] ?? '';
                    const isMetaInline = metaEdit?.songId === s.id && metaEdit?.col.defId === col.defId;
                    if (col.dataType === 'single_choice') {
                      const vocabId    = metaVocabIdMap[s.id]?.[col.defId] ?? null;
                      const vocabEntry = vocabId != null ? vocabByDef[col.defId]?.find(v => v.id === vocabId) : undefined;
                      const displayVal = vocabEntry?.value ?? metaMap[s.id]?.[col.defId] ?? null;
                      const displayColor = vocabEntry?.color ?? null;
                      return (
                        <div key={col.defId} role="gridcell"
                          style={{ flex: `0 0 ${w}px`, padding: "4px 6px", display: "flex", alignItems: "center", borderRight: "1px solid var(--border-primary)", overflow: "hidden" }}
                          onClick={e => setSinglePopover({ songId: s.id, defId: col.defId, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() })}>
                          <div style={{ display: "flex", alignItems: "center", alignSelf: "stretch", flex: 1, minWidth: 0, padding: "3px 6px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", cursor: "pointer", overflow: "hidden", position: "relative" }}>
                            <div style={{ flex: 1, minWidth: 0, marginRight: 16 }}>
                              <SingleChoicePillCell value={displayVal} color={displayColor} />
                            </div>
                            <span style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)", fontSize: 10, color: "var(--text-tertiary)", pointerEvents: "none" }}>▾</span>
                          </div>
                        </div>
                      );
                    }
                    if (col.dataType === 'multi_choice') {
                      const items = metaMultiMap[s.id]?.[col.defId] ?? [];
                      return (
                        <div key={col.defId} role="gridcell"
                          style={{ flex: `0 0 ${w}px`, padding: "4px 6px", display: "flex", alignItems: "center", borderRight: "1px solid var(--border-primary)", overflow: "hidden" }}
                          onClick={e => setMultiPopover({ songId: s.id, defId: col.defId, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() })}>
                          <div style={{ display: "flex", alignItems: "center", alignSelf: "stretch", flex: 1, minWidth: 0, padding: "3px 6px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", cursor: "pointer", overflow: "hidden", position: "relative" }}>
                            <div style={{ flex: 1, minWidth: 0, marginRight: 16 }}>
                              <MultiChoicePillCell items={items} vocabDef={vocabByDef[col.defId]} />
                            </div>
                            <span style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)", fontSize: 10, color: "var(--text-tertiary)", pointerEvents: "none" }}>▾</span>
                          </div>
                        </div>
                      );
                    }
                    if (col.dataType === 'boolean') return (
                      <div key={col.defId} role="gridcell" style={{ flex: `0 0 ${w}px`, padding: "10px 12px", display: "flex", alignItems: "center", borderRight: "1px solid var(--border-primary)" }}>
                        <input type="checkbox" checked={rawVal === 'true' || rawVal === '1'} onChange={e => commitMetaEdit(s.id, col, e.target.checked ? 'true' : 'false')} />
                      </div>
                    );
                    // Built-in date columns (Date Modified/Added) render the real date from the song's timestamp;
                    // user-created date columns fall through to the editable text cell below (builtinMs === null).
                    const builtinMs = builtinDateMs(col, s);
                    if (builtinMs != null) return (
                      <div key={col.defId} role="gridcell" title={new Date(builtinMs).toLocaleString()}
                        style={{ flex: `0 0 ${w}px`, padding: "10px 12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any, display: "flex", alignItems: "center", fontSize: 13, color: "var(--text-secondary)", borderRight: "1px solid var(--border-primary)" }}>
                        {new Date(builtinMs).toLocaleDateString()}
                      </div>
                    );
                    // Native-backed number columns (Intro/Outro Time ← intro_end/outro_start), read-only, seconds.
                    const builtinNum = builtinNumber(col, s);
                    if (builtinNum != null) return (
                      <div key={col.defId} role="gridcell"
                        style={{ flex: `0 0 ${w}px`, padding: "10px 12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any, display: "flex", alignItems: "center", fontSize: 13, color: "var(--text-secondary)", borderRight: "1px solid var(--border-primary)" }}>
                        {`${builtinNum.toFixed(1)}s`}
                      </div>
                    );
                    return (
                      <div
                        key={col.defId}
                        role="gridcell"
                        style={{ flex: `0 0 ${w}px`, padding: "10px 12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any, display: "flex", alignItems: "center", fontSize: 13, color: "var(--text-secondary)", borderRight: "1px solid var(--border-primary)", cursor: "text" }}
                        onDoubleClick={() => setMetaEdit({ songId: s.id, col, value: rawVal })}
                      >
                        {isMetaInline
                          ? <input autoFocus value={metaEdit!.value} onChange={e => setMetaEdit(prev => prev ? { ...prev, value: e.target.value } : prev)}
                              onBlur={() => { commitMetaEdit(metaEdit!.songId, metaEdit!.col, metaEdit!.value); setMetaEdit(null); }}
                              onKeyDown={e => { if (e.key === 'Enter') { commitMetaEdit(metaEdit!.songId, metaEdit!.col, metaEdit!.value); setMetaEdit(null); } if (e.key === 'Escape') setMetaEdit(null); }}
                              style={{ flex: 1, padding: "2px 4px", fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--accent-blue)", color: "var(--text-primary)", outline: "none" }} />
                          : (rawVal || "—")}
                      </div>
                    );
                  }
                })}
              </div>
              {/* Right action zone — always visible, no hover gate */}
              <div role="gridcell" style={{ display: "flex", alignItems: "center", gap: 3, padding: "0 6px", borderLeft: "1px solid var(--border-primary)", flexShrink: 0 }}>
                <button onClick={() => onLoadA(s)} className="ether-action-btn" style={{ padding: "4px 8px", borderRadius: 0, fontSize: 12, fontWeight: 700, background: "rgb(from var(--accent-blue) r g b / 0.15)", color: "var(--accent-blue)", border: "none", cursor: "pointer" }}>A</button>
                <button onClick={() => onLoadB(s)} className="ether-action-btn" style={{ padding: "4px 8px", borderRadius: 0, fontSize: 12, fontWeight: 700, background: "rgba(52,211,153,0.15)", color: "var(--accent-green)", border: "none", cursor: "pointer" }}>B</button>
                <button onClick={() => onLoadC(s)} className="ether-action-btn" style={{ padding: "4px 8px", borderRadius: 0, fontSize: 12, fontWeight: 700, background: "rgba(167,139,250,0.15)", color: "#a78bfa", border: "none", cursor: "pointer" }}>C</button>
                <button onClick={() => onQueue(s)} className="ether-action-btn" style={{ padding: "4px 8px", borderRadius: 0, fontSize: 12, fontWeight: 700, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>Q</button>
                <button onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setCueMenu({ song: s, x: r.right, y: r.bottom + 4 }); }} title="Cue…" className="ether-action-btn" style={{ padding: "4px 8px", borderRadius: 0, fontSize: 12, fontWeight: 700, background: "rgba(167,139,250,0.15)", color: "#a78bfa", border: "none", cursor: "pointer" }}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="10" y1="15" x2="20" y2="5"/><line x1="17" y1="2" x2="22" y2="7"/><polyline points="20 12 20 22 4 22 4 6 14 6"/></svg>
                </button>
                <button onClick={async () => { if (confirm("Delete " + (s.title || "this track") + "?")) { await (window as any).ether.songs.deleteById(s.id); load(); } }} title="Delete" className="ether-action-btn" style={{ padding: "4px 8px", borderRadius: 0, fontSize: 12, fontWeight: 700, background: "transparent", color: "var(--text-tertiary)", border: "none", cursor: "pointer" }}>✕</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {multiPopover && (
        <MultiChoicePopover
          songId={multiPopover.songId}
          defId={multiPopover.defId}
          anchorRect={multiPopover.rect}
          vocabOptions={vocabByDef[multiPopover.defId] ?? []}
          selectedItems={metaMultiMap[multiPopover.songId]?.[multiPopover.defId] ?? []}
          inFlightCreates={inFlightCreates}
          onToggle={v => toggleMultiChoice(multiPopover.songId, multiPopover.defId, v)}
          onClose={() => setMultiPopover(null)}
        />
      )}
      {singlePopover && (
        <SingleChoicePopover
          anchorRect={singlePopover.rect}
          vocabOptions={vocabByDef[singlePopover.defId] ?? []}
          currentVocabId={metaVocabIdMap[singlePopover.songId]?.[singlePopover.defId] ?? null}
          onSelect={v => {
            const col: MetadataColumn = { kind: 'metadata', defId: singlePopover.defId, defUuid: '', label: '', dataType: 'single_choice', width: 0 };
            commitMetaEdit(singlePopover.songId, col, v.value);
            setSinglePopover(null);
          }}
          onClear={() => { clearSingleChoice(singlePopover.songId, singlePopover.defId); setSinglePopover(null); }}
          onClose={() => setSinglePopover(null)}
        />
      )}

      {/* Item 1 — cue popup menu (portaled so the table's overflow:hidden can't clip it). */}
      {cueMenu && createPortal(
        <>
          <div onClick={() => setCueMenu(null)} style={{ position: "fixed", inset: 0, zIndex: 6000 }} />
          <div style={{ position: "fixed", top: cueMenu.y, left: cueMenu.x, transform: "translateX(-100%)", zIndex: 6001, minWidth: 190, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", boxShadow: "0 12px 40px rgba(0,0,0,0.5)" }}>
            {[
              { label: "Open in Cue Editor", act: () => { const s = cueMenu.song; setCueMenu(null); onEdit(s); } },
              { label: "Quick Cue here",     act: () => { const s = cueMenu.song; setCueMenu(null); setQuickCueSong(s); } },
            ].map((it, i) => (
              <button key={it.label} onClick={it.act}
                style={{ display: "block", width: "100%", textAlign: "left" as const, padding: "9px 12px", background: "transparent", color: "var(--text-primary)", border: "none", borderTop: i ? "1px solid var(--border-primary)" : "none", fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" as const }}
                onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-tertiary)")}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
              >{it.label}</button>
            ))}
          </div>
        </>,
        document.body
      )}

      {/* Item 1 — Quick Cue: compact cue editor slid up OVER the library; never leaves the view. */}
      {quickCueSong && (
        <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, height: "72vh", zIndex: 5500, background: "var(--bg-primary)", borderTop: "2px solid var(--accent-blue)", boxShadow: "0 -16px 50px rgba(0,0,0,0.6)", display: "flex", flexDirection: "column" }}>
          <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
            <TrackEditor song={quickCueSong as any} onClose={() => setQuickCueSong(null)} onSaved={(s: any) => setQuickCueSong(s)} />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Three-Slot Bar — replaces NowPlayingPill in the LivePanel toolbar ──
// Shows DECK A / DECK B / DECK C as fixed physical columns — titles never shift.
// ON AIR badge floats to whichever deck is playing; preloaded decks show green.
function ThreeSlotBar({ queueLen, masterCollapsed = true, showCarts = false }: { queueLen: number; masterCollapsed?: boolean; showCarts?: boolean }) {
  const engine = useAudioEngine();
  interface SlotData {
    title: string; artist: string; positionSec: number; durationSec: number; status: string; ready: boolean;
  }
  const EMPTY: SlotData = { title: "", artist: "", positionSec: 0, durationSec: 0, status: "idle", ready: false };
  const [slots, setSlots] = useState<[SlotData, SlotData, SlotData]>([EMPTY, EMPTY, EMPTY]);

  const titleRef0 = useRef<HTMLSpanElement>(null);
  const titleRef1 = useRef<HTMLSpanElement>(null);
  const titleRef2 = useRef<HTMLSpanElement>(null);
  const titleRefs = [titleRef0, titleRef1, titleRef2];

  const fillRef0 = useRef<HTMLDivElement>(null);
  const fillRef1 = useRef<HTMLDivElement>(null);
  const fillRef2 = useRef<HTMLDivElement>(null);
  const fillRefs = [fillRef0, fillRef1, fillRef2];
  const fillTrackRef0 = useRef<string>("");
  const fillTrackRef1 = useRef<string>("");
  const fillTrackRef2 = useRef<string>("");
  const fillTrackRefs = [fillTrackRef0, fillTrackRef1, fillTrackRef2];

  const DECK_COLORS = ["var(--accent-blue)", "#34d399", "#a78bfa"] as const;
  const DECK_IDS_ALL = ["A", "B", "C"] as const;

  useEffect(() => {
    const pull = () => {
      setSlots(DECK_IDS_ALL.map(id => {
        const s = engine.getDeck(id)?.getState?.();
        return {
          title:       s?.title       ?? "",
          artist:      s?.artist      ?? "",
          positionSec: s?.positionSec ?? 0,
          durationSec: s?.durationSec ?? 0,
          status:      s?.status      ?? "idle",
          ready:       engine.isDeckReady(id),
        };
      }) as [SlotData, SlotData, SlotData]);
    };
    pull();
    const unsub = engine.on(pull);
    const tick  = setInterval(pull, 1000);
    return () => { unsub(); clearInterval(tick); };
  }, [engine, queueLen]);

  // Progress fill — imperative CSS transitions matching ConsoleStrip pattern
  useEffect(() => {
    fillRefs.forEach(r => { if (r.current) r.current.style.width = "0%"; });
    const unsub = engine.on(() => {
      DECK_IDS_ALL.forEach((id, i) => {
        const da   = engine.getDeck(id)?.getState?.();
        const fill = fillRefs[i].current;
        if (!fill || !da) return;
        // Identity-keyed so EVERY new track re-arms the left→right sweep. Keying on rounded duration
        // alone (the old `~<durationSec>`) collided when two consecutive tracks on a deck shared a
        // whole-second length → the guard stayed false → the fill never re-swept for the new track.
        // filePath is unique per track (most robust); fall back to title/artist/duration if absent.
        const trackKey = da.filePath || `${da.title ?? ""}~${da.artist ?? ""}~${Math.round(da.durationSec ?? 0)}`;
        if (da.status === "playing" && da.durationSec > 0 && trackKey !== fillTrackRefs[i].current) {
          fillTrackRefs[i].current = trackKey;
          const startPct  = (da.positionSec / da.durationSec) * 100;
          const remaining = Math.max(0, da.durationSec - da.positionSec);
          fill.style.transition = "none";
          fill.style.width      = `${startPct}%`;
          void fill.offsetWidth;
          fill.style.transition = `width ${remaining}s linear`;
          fill.style.width      = "100%";
        }
        if (da.status !== "playing") {
          fill.style.transition = "none";
          const pct = da.durationSec > 0 ? (da.positionSec / da.durationSec) * 100 : 0;
          fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
          fillTrackRefs[i].current = "";
        }
      });
    });
    return () => unsub();
  }, [engine]);

  useEffect(() => {
    titleRefs.forEach((ref) => {
      const span = ref.current;
      if (!span) return;
      const container = span.parentElement;
      if (!container) return;
      const overflow = span.scrollWidth - container.clientWidth;
      if (overflow > 4) {
        span.style.setProperty("--mq-offset", `-${overflow}px`);
        span.style.animation = "y3-marquee 10s ease-in-out infinite";
      } else {
        span.style.animation = "none";
        span.style.transform = "translateX(0)";
      }
    });
  }, [slots[0].title, slots[1].title, slots[2].title]);

  const fmt = (s: number) => {
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, "0")}`;
  };

  const DECK_LABELS = ["DECK A", "DECK B", "DECK C"] as const;

  return (
    <>
      <style>{`
        @keyframes y3-marquee {
          0%,15%  { transform: translateX(0); }
          70%,85% { transform: translateX(var(--mq-offset)); }
          100%    { transform: translateX(0); }
        }
      `}</style>
      <div style={{
        width: "100%", flexShrink: 0, height: 58,
        display: "flex",
        overflow: "hidden",
      }}>
        {slots.map((slot, idx) => {
          const deckColor    = DECK_COLORS[idx];
          const isPlaying    = slot.status === "playing";
          const isPaused     = slot.status === "paused";
          // A deck holding a preloaded track is "cued" even when the renderer's
          // local deckReady set is empty (daemon mode never populates it — the
          // poll mirrors the daemon's title/status instead). Title presence is
          // the mode-agnostic signal that a deck is loaded.
          const isCued       = !isPlaying && !isPaused && !!slot.title;
          const isActive     = isPlaying || isPaused || slot.ready || isCued;
          const remaining    = Math.max(0, slot.durationSec - slot.positionSec);
          const isEndingSoon = isPlaying && remaining > 0 && remaining < 15;
          const timeStr      = (isPlaying || isPaused)
            ? `-${fmt(remaining)}`
            : isActive && slot.durationSec > 0 ? fmt(slot.durationSec) : "";
          return (
            <div key={DECK_LABELS[idx]} style={{
              flex: 1, minWidth: 0, position: "relative", overflow: "hidden",
              borderTop: `2px solid ${deckColor}`,
              borderRight: idx < 2 ? "1px solid rgba(255,255,255,0.06)" : "none",
              background: isActive ? `${deckColor}12` : "var(--bg-secondary)",
              transition: "background 0.3s",
            }}>
              {/* Progress fill sweeps left→right via imperative CSS transition */}
              <div ref={fillRefs[idx]} style={{
                position: "absolute", top: 0, left: 0, bottom: 0,
                background: deckColor,
                opacity: isPlaying ? 0.28 : (isActive ? 0.08 : 0),
                transition: "opacity 0.4s",
                pointerEvents: "none", zIndex: 0,
              }} />
              {/* Text content sits above fill */}
              <div style={{
                position: "relative", zIndex: 1,
                height: "100%", padding: "6px 12px",
                display: "flex", flexDirection: "column", justifyContent: "center", gap: 3,
              }}>
                {/* Row 1: dot · DECK X · [ON AIR] · time */}
                <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
                  <span style={{
                    width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
                    background: isActive ? deckColor : "#444",
                    boxShadow: isPlaying
                      ? `0 0 8px ${deckColor}, 0 0 0 1.5px rgba(255,255,255,0.5)`
                      : isActive ? `0 0 0 1.5px rgba(255,255,255,0.25)` : "none",
                    transition: "background 0.3s, box-shadow 0.3s",
                  }} />
                  <span style={{
                    fontSize: 11, fontWeight: 800, letterSpacing: "0.12em",
                    color: isActive ? "#fff" : "#555",
                    textTransform: "uppercase" as const, flexShrink: 0,
                    textShadow: isActive ? `0 1px 3px rgba(0,0,0,0.8), 0 0 10px ${deckColor}99` : "none",
                    transition: "color 0.3s, text-shadow 0.3s",
                  }}>{DECK_LABELS[idx]}</span>
                  {isPlaying && (
                    <span style={{
                      fontSize: 9, fontWeight: 800, letterSpacing: "0.1em",
                      color: "#000", background: deckColor,
                      borderRadius: 2, padding: "1px 5px", marginLeft: 2, flexShrink: 0,
                      textShadow: "none",
                    }}>ON AIR</span>
                  )}
                  {timeStr && (
                    <span style={{
                      fontSize: 17, fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                      color: isEndingSoon ? "#fbbf24" : (isPlaying || isPaused) ? "#fff" : "var(--text-secondary)",
                      fontWeight: 700,
                      marginLeft: "auto", flexShrink: 0,
                      letterSpacing: "-0.02em",
                      transition: "color 0.3s",
                    }}>{timeStr}</span>
                  )}
                </div>
                {/* Row 2: title */}
                <div style={{
                  fontSize: 14, fontWeight: 600, letterSpacing: "-0.01em",
                  color: isActive ? "var(--text-primary)" : "#444",
                  overflow: "hidden",
                  fontStyle: isActive ? "normal" : "italic",
                  lineHeight: 1.2,
                }}>
                  <span ref={titleRefs[idx]} style={{ display: "inline-block", whiteSpace: "nowrap" as const }}>
                    {isActive ? (slot.title || "—") : "—"}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
        {/* Spacer mirrors MasterOutput width so slot boundaries align with ConsoleStrip columns */}
        <div style={
          masterCollapsed
            ? { width: 36, flexShrink: 0, borderLeft: "1px solid rgba(255,255,255,0.06)" }
            : !showCarts
              ? { flex: 1, minWidth: 280, borderLeft: "1px solid rgba(255,255,255,0.06)" }
              : { width: 280, flexShrink: 0, borderLeft: "1px solid rgba(255,255,255,0.06)" }
        } />
      </div>
    </>
  );
}

// ── Now Playing Pill — sits in the toolbar right of CARTS ──
// Shows active track info with a slide+fade animation when the song changes.
// Subscribes to the engine for deck state updates.
function NowPlayingPill() {
  const engine = useAudioEngine();
  const [track, setTrack] = useState<{ title: string; artist: string; positionSec: number; durationSec: number } | null>(null);

  useEffect(() => {
    const pull = () => {
      const decks = (["A", "B", "C"] as const).map(id => engine.getDeck(id)?.getState?.());
      const playing = decks.find(d => d?.status === "playing") ?? decks.find(d => d?.status === "paused") ?? null;
      setTrack(playing && playing.title ? {
        title: playing.title,
        artist: playing.artist || "",
        positionSec: playing.positionSec ?? 0,
        durationSec: playing.durationSec ?? 0,
      } : null);
    };
    pull();
    const unsub = engine.on(() => pull());
    // Update position every second for the progress bar
    const tick = setInterval(pull, 1000);
    return () => { unsub(); clearInterval(tick); };
  }, [engine]);

  // Key forces remount on title change → triggers enter animation
  const trackKey = track?.title ?? "__empty__";
  const pct = track && track.durationSec > 0 ? Math.max(0, Math.min(1, track.positionSec / track.durationSec)) : 0;
  const remaining = track && track.durationSec > 0 ? Math.max(0, track.durationSec - track.positionSec) : 0;
  const fmt = (s: number) => {
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, "0")}`;
  };
  const isEndingSoon = remaining > 0 && remaining < 15;

  return (
    <>
      {/* Scoped keyframes — slides in from below with a quick fade + a subtle scale */}
      <style>{`
        @keyframes np-enter {
          0%   { transform: translateY(100%); opacity: 0; }
          60%  { transform: translateY(-4%);  opacity: 1; }
          100% { transform: translateY(0);    opacity: 1; }
        }
        @keyframes np-pulse-live {
          0%, 100% { box-shadow: 0 0 0 0 rgb(from var(--accent-cyan) r g b / 0.0); }
          50%      { box-shadow: 0 0 0 2px rgb(from var(--accent-cyan) r g b / 0.18); }
        }
      `}</style>
      <div style={{
        flex: 1, minWidth: 0, maxWidth: 720, marginLeft: 8,
        display: "flex", alignItems: "center", gap: 10,
        height: 34, padding: "0 14px",
        background: "linear-gradient(90deg, var(--bg-tertiary), var(--bg-secondary))",
        border: "1px solid var(--border-primary)",
        borderRadius: 0,
        position: "relative", overflow: "hidden",
        animation: isEndingSoon ? "np-pulse-live 1.6s ease-in-out infinite" : "none",
      }}>
        {/* Status dot (pulsing when track is playing) */}
        <div style={{
          width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
          background: track ? "var(--accent-cyan)" : "#3a3a4a",
          boxShadow: track ? "0 0 6px rgb(from var(--accent-cyan) r g b / 0.7)" : "none",
          animation: track ? "on-air-breathe 2s ease-in-out infinite" : "none",
        }} />

        {/* Label */}
        <span style={{
          fontSize: 10, fontWeight: 800, letterSpacing: "0.14em",
          color: "var(--text-tertiary)", textTransform: "uppercase" as const,
          flexShrink: 0,
        }}>ON AIR</span>

        {/* Animated content wrapper — overflow hidden for the slide effect */}
        <div style={{
          flex: 1, minWidth: 0, position: "relative", overflow: "hidden",
          height: "100%", display: "flex", alignItems: "center",
        }}>
          <div
            key={trackKey}
            style={{
              display: "flex", alignItems: "center", gap: 8, minWidth: 0, width: "100%",
              animation: "np-enter 0.45s cubic-bezier(0.22,1,0.36,1)",
            }}
          >
            {track ? (
              <>
                <span style={{
                  fontSize: 13, fontWeight: 700, letterSpacing: "-0.01em",
                  color: "var(--text-primary)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const,
                  flexShrink: 1,
                }}>{track.title}</span>
                {track.artist && (
                  <>
                    <span style={{ color: "var(--text-tertiary)", fontSize: 12, flexShrink: 0 }}>·</span>
                    <span style={{
                      fontSize: 12, color: "var(--text-secondary)",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const,
                      flexShrink: 2, minWidth: 0,
                    }}>{track.artist}</span>
                  </>
                )}
              </>
            ) : (
              <span style={{ fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic" }}>No track playing</span>
            )}
          </div>
        </div>

        {/* Time remaining — turns amber under 15s */}
        {track && (
          <span style={{
            fontSize: 12, fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            color: isEndingSoon ? "#fbbf24" : "var(--text-tertiary)",
            fontWeight: isEndingSoon ? 700 : 500,
            flexShrink: 0, minWidth: 46, textAlign: "right" as const,
            transition: "color 0.3s",
          }}>-{fmt(remaining)}</span>
        )}

        {/* Progress bar at bottom edge */}
        {track && (
          <div style={{
            position: "absolute", bottom: 0, left: 0, right: 0,
            height: 2, background: "rgba(0,0,0,0.2)",
            pointerEvents: "none",
          }}>
            <div style={{
              height: "100%", width: `${pct * 100}%`,
              background: isEndingSoon ? "#fbbf24" : "var(--accent-cyan)",
              boxShadow: isEndingSoon ? "0 0 4px rgba(251,191,36,0.6)" : "0 0 4px rgb(from var(--accent-cyan) r g b / 0.5)",
              transition: "width 1s linear, background 0.3s",
            }} />
          </div>
        )}
      </div>
    </>
  );
}

function ClockDisplay({ size = "full", accentColor = "var(--accent-cyan)" }: { size?: "full" | "lg" | "md" | "sm" | "xs" | "hidden"; accentColor?: string }) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  // Time-only clock, sized to fill the thin top bar (date removed by design).
  const showSeconds = size === "full" || size === "lg" || size === "md";
  const time = now.toLocaleTimeString([], showSeconds
    ? { hour: "2-digit", minute: "2-digit", second: "2-digit" }
    : { hour: "2-digit", minute: "2-digit" });
  const fontSize =
    size === "full" ? 46 :
    size === "lg"   ? 40 :
    size === "md"   ? 32 :
    size === "sm"   ? 24 :
                      18; // xs
  return (
    <div style={{ textAlign: "center", lineHeight: 1 }}>
      <div style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize, fontWeight: 800, color: accentColor, letterSpacing: "0.04em", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", textShadow: `0 0 16px color-mix(in srgb, ${accentColor} 45%, transparent)`, transition: "color 0.6s ease, text-shadow 0.6s ease" }}>{time}</div>
    </div>
  );
}
