import UserLogin from "./components/UserLogin";
import KeyboardHelp from "./components/KeyboardHelp";
import etherMarkSvg from "./assets/ether-logo.svg";
import VideoStudio from "./components/ShowPlus";
import { UserContext, AppUser, useRole } from "./UserContext";
// Electron IPC bridge (replaces @tauri-apps imports)
const invoke = (cmd: string, args?: Record<string, unknown>) =>
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
import { query, execute, queryOne, logPlay, searchSongs, dbHealthCheck } from "./db/client";
import { queryScoped } from "./db/stationScoped";
import { useActiveStation } from "./hooks/useActiveStation";
import { useStreaming } from "./hooks/useStreaming";
import { engine, DeckState, rotLog } from "./audio/engine-rodio";
import { fillQueueFromSchedule, refillFromSchedule, resetScheduleCursor } from "./audio/loggen";
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
import { StreamStatusProvider } from "./contexts/StreamStatusContext";
import GlobalOnAirBadge from "./components/GlobalOnAirBadge";
import EtherLogo from "./components/EtherLogo";
import StreamStatusToast from "./components/StreamStatusToast";
import DMCANotice from "./components/DMCANotice";
import JockStrip from "./components/JockStrip";
import UpNext from "./components/UpNext";
import Scheduler from "./components/Scheduler";
import ProgramLog from "./components/ProgramLog";
import PlayLog from "./components/PlayLog";
import Logs from "./components/Logs";
import EASLogbook from "./components/EASLogbook";
import PDPicks from "./components/PDPicks";
import SchedulePreview from "./components/SchedulePreview";
import SchedulerReasons from "./components/SchedulerReasons";
import VoiceTrackInbox from "./components/VoiceTrackInbox";
import AIVoiceStudio from "./components/AIVoiceStudio";
import ActiveStationBadge from "./components/ActiveStationBadge";
import GSelectorImport from "./components/GSelectorImport";
import HelpPanel from "./components/HelpPanel";
import NowPlaying from "./components/NowPlaying";
import { openNowPlayingWindow } from "./components/NowPlayingWindow";
import Spots from "./components/Spots";
import MacrosPanel, { useMacroHotkeys, useMacroClock } from "./components/MacroEngine";
import MidiSettingsPanel, { MidiProvider } from "./components/MidiEngine";
import ConsoleStrip from "./components/ConsoleStrip";
import RulesEditor from "./components/RulesEditor";
import ProcessingPanel from "./components/ProcessingPanel";
import NowPlayingSettings from "./components/NowPlayingSettings";
import StreamManager from "./components/StreamManager";
import AudioDevices from "./components/AudioDevices";
import VoiceTracker from "./components/VoiceTracker";
import ShowPrep from "./components/ShowPrep";
import Announcements, { startAnnouncementEngine } from "./components/Announcements";
import FirstRunWizard, { VenueProfile, VENUE_LABELS } from "./components/FirstRunWizard";
import SplashScreen from "./components/SplashScreen";
import OnShiftScreen from "./components/OnShiftScreen";
import LibraryImport from "./components/LibraryImport";
import SpotifyImport from "./components/SpotifyImport";
import LibraryColumnsPanel from "./components/LibraryColumnsPanel";
import { ALL_LIB_COLS, LIB_COL_LABELS, LIB_COL_DEFAULT_WIDTHS, type LibCol, type LibraryColumn, type MetadataColumn, type MetadataDefinition, type MetadataVocabulary } from "./types/metadata";
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
import MultiOutputPanel from "./components/MultiOutputPanel";
import StationManager from "./components/StationManager";
import { usePlan, setPlanGlobally, PlanGate } from "./hooks/usePlan";
import PhoneDesk from "./components/PhoneDesk";
import SubscriptionPanel, { PlanTier } from "./components/SubscriptionPanel";
import { useSkin, SkinPickerOverlay } from "./components/SkinPicker";
import BroadcastEditor from "./components/BroadcastEditor";
import StudioEditor from "./components/StudioEditor";
import StudioPro from "./components/StudioPro";
import OnboardingTour, { useTour } from "./components/OnboardingTour";
import VUMeter from "./components/VUMeter";

type Panel = "live" | "library" | "clocks" | "logs" | "spots" | "voicetrack" | "announce" | "streaming" | "settings" | "showprep" | "trackedit" | "subscription" | "autocue" | "health" | "cartwall" | "playlist" | "smartschedule" | "programlog" | "schedulebuilder" | "studio" | "broadcasteditor" | "phonedesk" | "analytics" | "cloudbackup" | "multioutput" | "stationmanager" | "videostudio" | "importlibrary" | "spotifyimport" | "calendar" | "macros" | "midi" | "clipeditor" | "captions";

interface SongRow {
  id: number; title: string; file_path: string | null;
  artist_name: string | null; album_title: string | null; album_year?: number | null;
  genre: string | null; duration_ms: number;
  category_code: string | null; category_color: string | null;
  intro_end?: number | null; outro_start?: number | null; bpm?: number | null;
  gain_db?: number | null; play_count?: number | null;
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
                  <div style={{ display: "flex", alignItems: "center", gap: 4, borderRadius: 0, background: l.name === name ? "rgba(56,189,248,0.1)" : "none" }}>
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
  if (w < 1050) searchW = 180;
  if (w < 900)  searchW = 0; // icon-only mode
  let clockSize: "full" | "lg" | "md" | "sm" | "xs" | "hidden" = "full";
  if (w < 1500) clockSize = "lg";
  if (w < 1350) clockSize = "md";
  if (w < 1200) clockSize = "sm";
  if (w < 1000) clockSize = "xs";
  // never "hidden" — always show at least a tiny clock so the header
  // doesn't look empty/unfinished at the narrowest window sizes.
  return {
    width: w,
    isTablet:   w >= 768 && w < 1024, // 768–1023px: tablet portrait/landscape
    veryNarrow: w < 900,   // hide WARN text, Go Live → ▶ icon, search icon-only
    narrow:     w < 1050,  // collapse Admin to icon-only
    medium:     w < 1200,  // collapse Pro to icon-only
    panelTight: w < 1350,  // master panel auto-collapses
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

export default function App() {
  const { stationId, isReady: stationReady } = useActiveStation();
  const viewport = useViewport();
  // Macro automation: listen for hotkey-triggered macros + clock-based triggers
  useMacroHotkeys();
  useMacroClock(stationId);
  const [splashDone, setSplashDone] = useState(false);
  const [wizardDone, setWizardDone] = useState(false);
  const [firstRunChecked, setFirstRunChecked] = useState(false);
  const [stationName, setStationName] = useState("Ether");
  const [switchToast, setSwitchToast] = useState("");
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
  const [panel, setPanel] = useState<Panel>("live");
  const [schedulerTab, setSchedulerTab] = useState<"shows" | "categories" | "clocks">("shows");
  const apiKeyRef = useRef<string>("");
  const panelRef = useRef<Panel>("live");
  useEffect(() => {
    panelRef.current = panel;
    if (panel === "library") window.dispatchEvent(new Event("ether:tour-library-opened"));
  }, [panel]);
  const [onAir, setOnAir] = useState(false);
  const [onAirOverride, setOnAirOverride] = useState(false);
  const onAirOverrideRef = useRef(false); // ref avoids stale closure in engine.on
  const { goLive, stopLive } = useStreaming();
  const prevDeckStatus = useRef<Record<string, string>>({}); // track status transitions for console logging
  const lastLoggedStatus = useRef<Record<string, string>>({});
  const durQueried = useRef(new Set<string>());
  const deckConfigsRef   = useRef<DeckConfig[]>([]);
  const prevQueueLen = useRef(-1); // track queue length changes for console logging
  const [restoreInfo, setRestoreInfo] = useState<{ title: string | null; position: number; queueLen: number; savedAt: number } | null>(null);
  const [deckA, setDeckA] = useState<DeckState | null>(null);
  const [deckB, setDeckB] = useState<DeckState | null>(null);
  const [deckC, setDeckC] = useState<DeckState | null>(null);
  // AUTO state persists across restarts — broadcasters expect their automation
  // to remain in whatever state they left it in, especially after a power cycle
  // or app restart. Default false on first install.
  const [autoAdv, setAutoAdv] = useState<boolean>(() => {
    try { return localStorage.getItem("ether_autoAdv") === "1"; } catch { return false; }
  });
  const [shuffle, setShuffle] = useState(false);
  const [continuous, setContinuous] = useState(false);
  const [queueLen, setQueueLen] = useState(0);
  const [darkMode, setDarkMode] = useState(false);
  const [showCarts, setShowCarts] = useState(false);
  const [globalSearch, setGlobalSearch] = useState("");
  const [autoXfade, setAutoXfade] = useState(true);
  const [xfadeActive, setXfadeActive] = useState(false);
  const handleXfade = () => {
    const playingDeck = deckA?.status === "playing" ? "A" : deckB?.status === "playing" ? "B" : deckC?.status === "playing" ? "C" : null;
    if (!playingDeck) return;
    const order: Array<"A"|"B"|"C"> = ["A", "B", "C"];
    const currentIdx = order.indexOf(playingDeck as "A"|"B"|"C");
    let targetDeck: "A"|"B"|"C" | null = null;
    for (let i = 1; i <= 2; i++) {
      const candidate = order[(currentIdx + i) % 3];
      if (engine.isDeckReady(candidate)) { targetDeck = candidate; break; }
    }
    if (!targetDeck) return;
    engine.crossfade(playingDeck, targetDeck, xfadeDuration * 1000);
    // Dequeue targetDeck's song and clear its ready slot immediately — it just went live.
    const qBefore = engine.getQueue();
    if (qBefore.length > 0) engine.replaceQueue(qBefore.slice(1));
    engine.clearDeckReady(targetDeck as "A"|"B"|"C");
    window.dispatchEvent(new CustomEvent('ether:queue-changed'));
    // Load next song into old playing deck AFTER the crossfade's own stop fires (ms+100).
    // Loading before the stop clears the source and the audio thread silently skips Play.
    setTimeout(async () => {
      const readyCount = (["A","B","C"] as const).filter(id => engine.isDeckReady(id)).length;
      const q = engine.getQueue();
      if (q.length > readyCount) {
        const next = q[readyCount];
        await engine.loadToDeck(playingDeck, next.filePath, next.title, next.artist, next.gainDb, next.durationMs);
        engine.markDeckReady(playingDeck as "A" | "B" | "C");
      }
      window.dispatchEvent(new CustomEvent('ether:queue-changed'));
    }, (xfadeDuration * 1000) + 300);
    setXfadeActive(true);
    setTimeout(() => setXfadeActive(false), 2200);
  };
  const [toolsCollapsed, setToolsCollapsed] = useState(() => localStorage.getItem("ether_tools_collapsed") === "1");
  const toggleToolsCollapsed = () => setToolsCollapsed(c => { const next = !c; localStorage.setItem("ether_tools_collapsed", next ? "1" : "0"); return next; });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerUsage, setDrawerUsage] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem("ether_drawer_usage") || "{}"); } catch { return {}; }
  });
  const [showDeckConfig, setShowDeckConfig] = useState(false);
  const [deckConfigClosing, setDeckConfigClosing] = useState(false);
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
        const name = get('station_name');
        if (name) setStationName(name);
        const p = get('plan_tier') as PlanTier | undefined;
        if (p) { setCurrentPlan(p); setPlanGlobally(p); }
        const apiKey = get('license_key');
        if (apiKey) apiKeyRef.current = apiKey;
        // experience_mode key in DB is now ignored — deck visibility is
        // driven entirely by Configure Decks. Old key left in DB for now.
      } catch {}
      setFirstRunChecked(true);
      consoleLog("system", "ether started — engine ready");
    })();
  }, [stationId, stationReady]);

  // Keep apiKeyRef live if user enters license mid-session
  useEffect(() => {
    const reload = async () => {
      const result = await (window as any).ether.stationConfigKv.list(stationId);
      const rows: { key: string; value: string }[] = result.ok ? result.rows : [];
      const key = rows.find((r: any) => r.key === 'license_key')?.value;
      if (key) apiKeyRef.current = key;
    };
    window.addEventListener('ether:license-changed', reload);
    return () => window.removeEventListener('ether:license-changed', reload);
  }, [stationId]);

  // Native menu IPC handler
  useEffect(() => {
    const handler = (window as any).ether.on("menu-action", (cmd: string) => {
      const panels: Record<string,string> = { "nav:library":"library","nav:spots":"spots","nav:voicetrack":"voicetrack","nav:cartwall":"cartwall","nav:trackedit":"trackedit","nav:clocks":"clocks","nav:programlog":"programlog","nav:logs":"logs","nav:studio":"studio","nav:broadcasteditor":"broadcasteditor","nav:autocue":"autocue","nav:playlist":"playlist","nav:phonedesk":"phonedesk","nav:announce":"announce","nav:showprep":"showprep","nav:streaming":"streaming","nav:smartschedule":"smartschedule","nav:analytics":"analytics","nav:multioutput":"multioutput","nav:stationmanager":"stationmanager","nav:health":"health","nav:videostudio":"videostudio","nav:importlibrary":"importlibrary","nav:cloudbackup":"cloudbackup","nav:clipeditor":"clipeditor","nav:captions":"captions" };
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
    });
    return () => (window as any).ether.off("menu-action", handler);
  }, []);

  // Allow any UpgradePrompt button anywhere in the app to open the subscription panel
  useEffect(() => {
    const handler = () => setPanel("subscription");
    window.addEventListener("ether:open-subscription", handler);
    return () => window.removeEventListener("ether:open-subscription", handler);
  }, []);

  // ── Remote command stream (emergency override + companion) ──
  // Replaced polling with SSE — instant delivery, zero idle traffic.
  useEffect(() => {
    const STREAM_BASE = "https://ether-backend-production.up.railway.app/api/cmd-stream";

    const execCmd = async (cmd: string, data: any) => {
      try {
        switch (cmd) {
          case "stop_all":
            engine.getDeck("A")?.stop(); engine.getDeck("B")?.stop(); engine.getDeck("C")?.stop();
            break;
          case "play":
            engine.getDeck("A")?.play();
            break;
          case "pause":
            engine.getDeck("A")?.pause();
            break;
          case "skip":
            engine.triggerPreload?.();
            break;
          case "set_volume":
            if (data.volume !== undefined) (engine as any).setMasterVolume?.(data.volume);
            break;
          case "automation_on":
            setAutoAdv(true);
            engine.autoAdvance = true;
            try { localStorage.setItem("ether_autoAdv", "1"); } catch {}
            break;
          case "automation_off":
            setAutoAdv(false);
            engine.autoAdvance = false;
            try { localStorage.setItem("ether_autoAdv", "0"); } catch {}
            break;
          case "play_emergency_cart":
            (engine as any).playEmergencyCart?.();
            break;
          case "mic_on":
            (engine as any).openMic?.();
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
      if (!key) return;   // no license key yet — skip until key is available

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
        title: stA?.title || "Ether Radio", artist: stA?.artist || "",
        position: stA?.positionSec || 0, duration: stA?.durationSec || 0,
        widget,
        upcoming: engine.getQueue().slice(0, 10).map(q => ({ title: q.title, artist: q.artist, duration: 0 })),
      }).catch(() => {});
    });
    return () => { unlisten.then(f => f()); };
  }, []);

  useEffect(() => {
    if (!stationId) return;
    engine.setRefillCallback(async () => {
      const rows = await queryScoped<SongRow>("SELECT s.*, a.name as artist_name FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.file_path IS NOT NULL ORDER BY RANDOM() LIMIT 500", [], stationId, { skipScoping: true });
      return rows.filter(s => s.file_path).map(s => ({ filePath: s.file_path!, title: s.title, artist: s.artist_name || "", introEnd: s.intro_end ?? undefined, outroStart: s.outro_start ?? undefined }));
    });
  }, [stationId]);

  const [xfadeDuration, setXfadeDurationState] = useState(() => {
    try { const v = parseInt(localStorage.getItem("ether_xfade_duration") || "3"); return isNaN(v) ? 3 : Math.min(10, Math.max(1, v)); } catch { return 3; }
  });
  const setXfadeDuration = (v: number) => {
    setXfadeDurationState(v);
    localStorage.setItem("ether_xfade_duration", String(v));
    engine.crossfadeDuration = v;
  };

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
        case "KeyN": setPanel("live"); break;
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

  useEffect(() => {
    engine.init();
    engine.outroCrossfade = true;
    engine.crossfadeDuration = xfadeDuration;
    // Restore persisted AUTO state on boot — autoAdv was hydrated from
    // localStorage in useState init, but engine is a singleton that doesn't
    // know about it until we sync here.
    engine.autoAdvance = autoAdv;
    if (autoAdv) engine.continuous = true;
    // If AUTO was ON when last closed, fill queue and start playing after crash_recovery (2s grace)
    let autoStartTimer: ReturnType<typeof setTimeout> | null = null;
    if (autoAdv) {
      autoStartTimer = setTimeout(async () => {
        if (engine.getDeck("A")?.getState().status === "playing") return;
        rotLog(`[ROT] STARTUP autofill begin — queue: [${engine.getQueue().map(q => q.title).join(", ")}]`);
        engine.continuous = true;
        resetScheduleCursor();
        // Always fill from schedule — don't reuse crash_recovery's stale queue
        engine.clearQueue();
        const count = await fillQueueFromSchedule();
        if (count === 0) {
          const rows = await query<SongRow>("SELECT s.*, a.name as artist_name FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.file_path IS NOT NULL ORDER BY RANDOM() LIMIT 100", []);
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
      if (id === "A") setDeckA({...st});
      else if (id === "B") setDeckB({...st});
      else if (id === "C") setDeckC({...st});

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
      setQueueLen(newQLen);
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
      // Auto-set ON AIR when any deck starts playing (unless manually overridden)
      if (st.status === "playing" && !onAirOverrideRef.current) {
        setOnAir(true);
      }
      // Auto-clear ON AIR when all decks stop (unless manually overridden)
      if (!onAirOverrideRef.current) {
        const anyPlaying = engine.getDeck("A")?.getState().status === "playing"
          || engine.getDeck("B")?.getState().status === "playing"
          || engine.getDeck("C")?.getState().status === "playing";
        if (!anyPlaying) setOnAir(false);
      }

      // Play logging — fires on every transition into "playing" on a music deck
      const prevStatus = lastLoggedStatus.current[id];
      if (st.status === 'playing' && prevStatus !== 'playing') {
        const cfg = deckConfigsRef.current.find(c => c.slot === id);
        if (cfg?.type === 'music' && st.title) {
          logPlay(st.title, st.artist || '', id, undefined, stationId).catch(e => console.error('Log write error:', e));
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
  }, []);

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
        if (queue.length > 0) {
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
        if (!autoAdv && row.deck_a_path && row.deck_a_title) {
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
            const rows = await queryScoped<SongRow>("SELECT s.*, a.name as artist_name FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.file_path IS NOT NULL ORDER BY RANDOM() LIMIT 100", [], stationId, { skipScoping: true });
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

  const toggleAuto = async () => {
    const n = !autoAdv;
    setAutoAdv(n);
    engine.autoAdvance = n;
    try { localStorage.setItem("ether_autoAdv", n ? "1" : "0"); } catch {}
    if (n) {
      engine.init(); engine.continuous = true; setContinuous(true); engine.shuffle = false; setShuffle(false);
      resetScheduleCursor();
      if (engine.getQueue().length === 0) {
        const count = await fillQueueFromSchedule();
        if (count === 0) {
          engine.setRefillCallback(async () => {
            const rows = await queryScoped<SongRow>("SELECT s.*, a.name as artist_name FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.file_path IS NOT NULL ORDER BY RANDOM() LIMIT 500", [], stationId, { skipScoping: true });
            return rows.filter(s => s.file_path).map(s => ({ filePath: s.file_path!, title: s.title, artist: s.artist_name || "", introEnd: s.intro_end ?? undefined, outroStart: s.outro_start ?? undefined, durationMs: s.duration_ms ?? 0 }));
          });
          const rows = await queryScoped<SongRow>("SELECT s.*, a.name as artist_name FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.file_path IS NOT NULL ORDER BY RANDOM() LIMIT 100", [], stationId, { skipScoping: true });
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
    } else { engine.continuous = false; setContinuous(false); }
  };

  const toggleShuffle = () => { const n = !shuffle; setShuffle(n); engine.shuffle = n; };

  const loadA = useCallback((s: SongRow) => {
    if (!s.file_path) return;
    const item = { filePath: s.file_path, title: s.title, artist: s.artist_name || "", introEnd: s.intro_end ?? undefined, outroStart: s.outro_start ?? undefined, durationMs: s.duration_ms ?? 0 } as any;
    const q = engine.getQueue(); q.splice(0, 0, item); engine.replaceQueue(q);
    setQueueLen(engine.getQueue().length);
    engine.triggerPreload();
    window.dispatchEvent(new CustomEvent('ether:queue-changed'));
    if (s.id && !s.intro_end) autoCueSong(s.id, s.file_path).catch(() => {});
  }, []);
  const loadB = useCallback((s: SongRow) => {
    if (!s.file_path) return;
    const item = { filePath: s.file_path, title: s.title, artist: s.artist_name || "", introEnd: s.intro_end ?? undefined, outroStart: s.outro_start ?? undefined, durationMs: s.duration_ms ?? 0 } as any;
    const q = engine.getQueue(); q.splice(1, 0, item); engine.replaceQueue(q);
    setQueueLen(engine.getQueue().length);
    engine.triggerPreload();
    window.dispatchEvent(new CustomEvent('ether:queue-changed'));
    if (s.id && !s.intro_end) autoCueSong(s.id, s.file_path).catch(() => {});
  }, []);
  const loadC = useCallback((s: SongRow) => {
    if (!s.file_path) return;
    const item = { filePath: s.file_path, title: s.title, artist: s.artist_name || "", introEnd: s.intro_end ?? undefined, outroStart: s.outro_start ?? undefined, durationMs: s.duration_ms ?? 0 } as any;
    const q = engine.getQueue(); q.splice(2, 0, item); engine.replaceQueue(q);
    setQueueLen(engine.getQueue().length);
    engine.triggerPreload();
    window.dispatchEvent(new CustomEvent('ether:queue-changed'));
    if (s.id && !s.intro_end) autoCueSong(s.id, s.file_path).catch(() => {});
  }, []);
  const [autoSilenceTrim, setAutoSilenceTrim] = useState(() => {
    try { return localStorage.getItem("ether_auto_silence_trim") !== "false"; } catch { return true; }
  });
  const addToQueue = useCallback((s: SongRow) => {
    if (s.file_path) {
      engine.addToQueue([{ filePath: s.file_path, title: s.title, artist: s.artist_name || "", introEnd: s.intro_end ?? undefined, outroStart: s.outro_start ?? undefined, durationMs: s.duration_ms ?? 0 } as any]);
      setQueueLen(engine.getQueue().length);
      window.dispatchEvent(new CustomEvent('ether:queue-changed'));
      // Auto-detect cue points in background if not set
      if (autoSilenceTrim && s.id && !s.intro_end) {
        autoCueSong(s.id, s.file_path).catch(() => {});
      }
    }
  }, [autoSilenceTrim]);

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
  const nowPlayingTitle = nowPlayingDeck?.title || "";
  const nowPlayingStr = nowPlayingDeck
    ? `${nowPlayingDeck.title}${nowPlayingDeck.artist ? ` by ${nowPlayingDeck.artist}` : ""}`
    : "";
  const anyDeckPlaying = [deckA, deckB, deckC].some(d => d?.status === "playing");

  const handleStationSwitch = async (id: number, name: string): Promise<boolean> => {
    if (anyDeckPlaying || queueLen > 0) {
      if (!confirm("Switching stations will stop playback and clear all decks. Continue?")) return false;
      engine.getDeck("A")?.stop(); engine.getDeck("B")?.stop(); engine.getDeck("C")?.stop();
      engine.clearQueue(); setQueueLen(0);
      window.dispatchEvent(new CustomEvent('ether:queue-changed'));
    }
    const r = await (window as any).ether.stations.switch(id);
    if (!r?.ok) return false;
    window.dispatchEvent(new CustomEvent("station-switched", { detail: { id, name } }));
    setStationName(name);
    setSwitchToast(`Switched to ${name}`);
    setTimeout(() => setSwitchToast(""), 3000);
    return true;
  };

  // Expose now-playing state for mobile companion via backend API
  useEffect(() => {
    const playing = [
      { deck: "A", state: deckA },
      { deck: "B", state: deckB },
      { deck: "C", state: deckC },
    ].find(d => d.state?.status === "playing");

    const payload = {
      playing:      !!playing,
      title:        playing?.state?.title  || null,
      artist:       playing?.state?.artist || null,
      position:     playing?.state?.positionSec  || 0,
      duration:     playing?.state?.durationSec  || 0,
      deck:         playing?.deck || null,
      station_name: stationName,
      decks: {
        A: deckA ? { title: deckA.title, artist: deckA.artist, status: deckA.status, positionSec: deckA.positionSec, durationSec: deckA.durationSec } : null,
        B: deckB ? { title: deckB.title, artist: deckB.artist, status: deckB.status, positionSec: deckB.positionSec, durationSec: deckB.durationSec } : null,
        C: deckC ? { title: deckC.title, artist: deckC.artist, status: deckC.status, positionSec: deckC.positionSec, durationSec: deckC.durationSec } : null,
      },
      queue: engine.getQueue().slice(0, 10).map(q => ({ title: q.title, artist: q.artist, duration: (q as any).durationMs || 0 })),
    };

    // Push to Railway backend so /api/now-playing and /dashboard serve it
    fetch("https://ether-backend-production.up.railway.app/api/now-playing", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKeyRef.current ? { "x-license-key": apiKeyRef.current } : {}),
      },
      body: JSON.stringify(payload),
    }).catch(() => {});

    // Also push via Tauri command for local companion
    invoke("set_now_playing", { data: JSON.stringify(payload) }).catch(() => {});

    // Only emit to NowPlaying window when the playing track actually changes
    if (playing) {
      emit("now-playing-update", {
        title:       payload.title || "",
        artist:      payload.artist || "",
        positionSec: payload.position,
        durationSec: payload.duration,
        isPlaying:   true,
        upcoming:    payload.queue,
      }).catch(() => {});
    }
  }, [deckA?.status === "playing" ? deckA?.title : null, deckB?.status === "playing" ? deckB?.title : null, deckC?.status === "playing" ? deckC?.title : null, stationName]);

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
  if (firstRunChecked && !wizardDone) return <EtherErrorBoundary><FirstRunWizard onComplete={handleWizardComplete} /></EtherErrorBoundary>;
  if (!currentUser) return <EtherErrorBoundary><UserLogin onLogin={setCurrentUser} /></EtherErrorBoundary>;
  if (!shiftStarted) return <EtherErrorBoundary><OnShiftScreen onStart={() => { setShiftStarted(true); }} /></EtherErrorBoundary>;

  return (
    <StreamStatusProvider>
    <MidiProvider>
    <EtherErrorBoundary>
    <div className="h-screen flex flex-col" onContextMenu={handleContextMenu} style={{ background: "var(--bg-primary)", color: "var(--text-primary)", fontFamily: "'Inter', system-ui, sans-serif" }}>
      <KeyboardHelp />

      {/* ── Header ── */}
      <header style={{ height: viewport.isTablet ? 64 : 96, display: "flex", alignItems: "center", padding: "0 16px", background: "var(--bg-secondary)", borderBottom: "1px solid rgba(255,255,255,0.04)", flexShrink: 0, position: "relative" as const, zIndex: 200 }}>

        {/* Logo — click to return to Mixer */}
        <div
          onClick={() => setPanel("live")}
          style={{ display: "flex", alignItems: "center", flexShrink: 0, cursor: "pointer", padding: "0 8px 0 0", opacity: 1, transition: "opacity 0.15s" }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = "0.85"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = "1"; }}
        >
          <EtherLogo size={28} iconOnly />
        </div>

        {/* LEFT: Search — width shrinks with viewport, becomes icon-only at <800px */}
        <div style={{ display: "flex", alignSelf: "stretch", flexShrink: 0, zIndex: 1 }}>
          {viewport.searchW > 0 ? (
            <div style={{ width: viewport.searchW, position: "relative" as const, display: "flex", flexDirection: "column" as const, transition: "width 0.18s ease" }}>
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

        {/* CENTER: Clock — absolutely centered, scales down to xs at narrow widths (never fully hidden) */}
        {(viewport.clockSize as string) !== "hidden" && (
          <div style={{ position: "absolute" as const, left: "50%", transform: "translateX(-50%)", zIndex: 0, display: "flex", alignItems: "center", gap: 8, pointerEvents: "none" }}>
            <ClockDisplay size={viewport.clockSize} />
          </div>
        )}

        {/* RIGHT: Status + Pro + Admin + ☰ menu + ON AIR */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, zIndex: 1, marginLeft: "auto" }}>
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
          <ActiveStationBadge onManage={() => setPanel("stationmanager")} onSwitch={handleStationSwitch} />
          {!viewport.veryNarrow && <UpdateBanner state={updater.state} onDownload={updater.download} onRestart={updater.restart} onDismiss={updater.dismiss} />}
          {currentPlan === "free" && (
            <button onClick={() => setPanel("subscription")} title="Upgrade to Pro" style={{ height: 44, padding: viewport.medium ? "0 12px" : "0 16px", borderRadius: 0, background: "#7c3aed", border: "none", color: "#fff", cursor: "pointer", fontSize: 14, fontWeight: 700, letterSpacing: "0.06em", display: "flex", alignItems: "center", gap: 6 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
              {!viewport.medium && "Pro"}
            </button>
          )}
          {panel !== "live" && (
            <button
              onClick={() => setPanel("live")}
              style={{
                padding: "6px 12px",
                background: "var(--button-bg, var(--bg-tertiary))",
                border: "var(--button-border, 1px solid var(--border-primary))",
                borderRadius: "var(--button-radius, 4px)",
                color: "var(--button-text, var(--text-primary))",
                fontSize: 11, fontWeight: 700, letterSpacing: "0.1em",
                cursor: "pointer", textTransform: "uppercase" as const, transition: "all 0.15s",
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "var(--button-bg-hover, var(--bg-hover))"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "var(--button-bg, var(--bg-tertiary))"; }}
            >
              Mixer
            </button>
          )}
          <button onClick={() => setCurrentUser(null)} title={currentUser?.name || "Account"} style={{ height: 44, padding: viewport.narrow ? "0 12px" : "0 14px", borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", gap: 7 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
            {!viewport.narrow && currentUser?.name}
          </button>

          {/* ☰ Menu button */}
          <button
            onClick={() => setDrawerOpen(d => !d)}
            title="Menu"
            style={{
              width: 48, height: 48, borderRadius: 0, cursor: "pointer",
              background: drawerOpen ? "var(--bg-tertiary)" : "transparent",
              border: `1px solid ${drawerOpen ? "var(--border-primary)" : "transparent"}`,
              color: drawerOpen ? "var(--text-primary)" : "var(--text-secondary)",
              display: "flex", alignItems: "center", justifyContent: "center",
              flexDirection: "column", gap: 4, transition: "all 0.15s",
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

          <GlobalOnAirBadge
            onAir={onAir}
            onClick={async () => {
              if (onAir) {
                // OFF transition — set override BEFORE state change so the
                // engine listener is already locked when React re-renders
                onAirOverrideRef.current = true;
                setOnAir(false);
                setOnAirOverride(true);
                await stopLive(stationId);
                // Release override after engine has time to settle
                setTimeout(() => {
                  onAirOverrideRef.current = false;
                  setOnAirOverride(false);
                }, 1500);
              } else {
                // ON transition — set override BEFORE state change so the
                // engine listener cannot immediately revert to off-air
                onAirOverrideRef.current = true;
                setOnAir(true);
                setOnAirOverride(false);
                const res = await goLive(stationId);
                if (!res.ok) {
                  // Stream failed — revert the optimistic UI update
                  setOnAir(false);
                  onAirOverrideRef.current = false;
                  console.error('[ON AIR] Stream failed to start:', res.error);
                  return;
                }
                // Release override after engine has time to settle
                setTimeout(() => {
                  onAirOverrideRef.current = false;
                }, 1500);
              }
            }}
          />
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
                      padding: "10px 16px", background: item.active ? "rgba(56,189,248,0.08)" : "transparent",
                      border: "none",
                      borderLeft: `3px solid ${item.active ? "var(--accent-cyan)" : "transparent"}`,
                      color: item.active ? "var(--accent-cyan)" : "var(--text-secondary)",
                      fontSize: 13, fontWeight: (drawerUsage[item.key] || 0) >= 3 ? 700 : 500,
                      cursor: "pointer", textAlign: "left" as const, transition: "background 0.1s",
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "var(--bg-tertiary)"; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = item.active ? "rgba(56,189,248,0.08)" : "transparent"; }}
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
                  onClick={() => drawerClick("nowplaying", () => openNowPlayingWindow())}
                  style={{ display: "flex", alignItems: "center", gap: 11, width: "100%", padding: "10px 16px", background: "transparent", border: "none", borderLeft: "3px solid transparent", color: "var(--text-secondary)", fontSize: 13, fontWeight: (drawerUsage["nowplaying"] || 0) >= 3 ? 700 : 500, cursor: "pointer", textAlign: "left" as const, transition: "background 0.1s" }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "var(--bg-tertiary)"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
                  <span style={{ flex: 1 }}>Now Playing</span>
                  {(drawerUsage["nowplaying"] || 0) >= 3 && <span style={{ fontSize: 12, fontWeight: 800, color: "var(--accent-cyan)", opacity: 0.7 }}>★</span>}
                </button>
                <button
                  onClick={() => drawerClick("phone", () => setPanel("phonedesk"))}
                  style={{ display: "flex", alignItems: "center", gap: 11, width: "100%", padding: "10px 16px", background: panel === "phonedesk" ? "rgba(0,200,168,0.08)" : "transparent", border: "none", borderLeft: `3px solid ${panel === "phonedesk" ? "#00c8a8" : "transparent"}`, color: panel === "phonedesk" ? "#00c8a8" : "var(--text-secondary)", fontSize: 13, fontWeight: (drawerUsage["phone"] || 0) >= 3 ? 700 : 500, cursor: "pointer", textAlign: "left" as const, transition: "background 0.1s" }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "var(--bg-tertiary)"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = panel === "phonedesk" ? "rgba(0,200,168,0.08)" : "transparent"; }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.61 3.35 2 2 0 0 1 3.6 1h3a2 2 0 0 1 2 1.72c.127.96.36 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.6a16 16 0 0 0 6 6l.91-.91a2 2 0 0 1 2.11-.45c.907.34 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                  <span style={{ flex: 1 }}>Phone</span>
                  {(drawerUsage["phone"] || 0) >= 3 && <span style={{ fontSize: 12, fontWeight: 800, color: "var(--accent-cyan)", opacity: 0.7 }}>★</span>}
                </button>

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
                  autoAdv={autoAdv} shuffle={shuffle}
                  toggleAuto={toggleAuto} toggleShuffle={toggleShuffle}
                  queueLen={queueLen} showCarts={showCarts}
                  toggleCarts={() => setShowCarts(!showCarts)}
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
                  xfadeActive={xfadeActive}
                  handleXfade={handleXfade}
                  onOpenCarts={() => setPanel("cartwall")}
                />
              )}
            </div>
          )}
          {panel !== "live" && (panel as string) !== "videostudio" && panel !== "clipeditor" && (
            <div style={{ flex: 1, overflowY: "auto" }}>
              {panel === "library" && <LibraryPanel onLoadA={loadA} onLoadB={loadB} onLoadC={loadC} onQueue={addToQueue} onEdit={(s) => { setEditSong(s); setPanel("trackedit"); }} onSendToStudio={(s) => { window.dispatchEvent(new CustomEvent("ether:send-to-studio", { detail: { filePath: s.file_path, title: s.title, artist: s.artist_name || "", duration_ms: s.duration_ms } })); setPanel("studio"); }} />}
              {panel === "clocks" && <Scheduler defaultTab={schedulerTab} />}
              {panel === "programlog" && <PlayLog onClose={() => setPanel("live")} />}
              {panel === "schedulebuilder" && <ProgramLog onClose={() => setPanel("live")} />}
              {panel === "studio" && (
                <EtherErrorBoundary>
                  <StudioPro
                    deckAPath={null} deckATitle={undefined}
                    deckBPath={null} deckBTitle={undefined}
                  />
                </EtherErrorBoundary>
              )}
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
              {panel === "aivoice" && <AIVoiceStudio onClose={() => setPanel("live")} />}

              {panel === "gselector" && <GSelectorImport onClose={() => setPanel("live")} />}
              {panel === "help" && <HelpPanel onClose={() => setPanel("live")} />}
              {panel === "spots" && <Spots />}
              {panel === "streaming" && <StreamManager />}
              {panel === "announce" && <Announcements />}
              {panel === "voicetrack" && <VoiceTracker inputDeviceId={inputDevice || undefined} />}
              {panel === "showprep" && <ShowPrep onGoLive={() => setPanel("live")} />}
              {panel === "settings" && <SettingsPanel xfadeDuration={xfadeDuration} setXfadeDuration={setXfadeDuration} />}
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
                  <MultiOutputPanel />
                </PlanGate>
              )}
              {panel === "stationmanager" && (
                <PlanGate requires="operator" feature="Multi-Station Console">
                  <StationManager onStationSwitch={(id, name) => setStationName(name)} />
                </PlanGate>
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
      {switchToast && (
        <div style={{ position: "fixed", bottom: 32, left: "50%", transform: "translateX(-50%)", zIndex: 9999, background: "rgba(30,30,40,0.97)", border: "1px solid rgba(56,189,248,0.4)", color: "#38bdf8", padding: "9px 20px", fontSize: 13, fontWeight: 600, fontFamily: "'Inter', system-ui, sans-serif", pointerEvents: "none" }}>
          {switchToast}
        </div>
      )}
      {showTour && <OnboardingTour onDone={dismissTour} />}
      {/* ── Footer ── */}
      <footer style={{ height: 52, display: "flex", alignItems: "center", padding: "0 10px", gap: 0, background: "var(--bg-secondary)", borderTop: "1px solid var(--border-primary)", flexShrink: 0 }}>
        {/* NOMINAL health indicator — same height as tabs */}
        <HealthStatusDot onClick={() => setPanel("health")} height={36} />
        {/* View tabs */}
        {([
          { label: "DECKS",  active: panel === "live",     fn: () => setPanel("live") },
          { label: "CARTS",  active: panel === "cartwall", fn: () => setPanel("cartwall") },
        ] as const).map(({ label, active, fn }) => (
          <button key={label} onClick={fn} style={{
            height: 36, padding: "0 14px", borderRadius: 0, marginRight: 2,
            border: `1px solid ${active ? "#38bdf8" : "var(--border-primary)"}`,
            background: active ? "rgba(56,189,248,0.12)" : "transparent",
            color: active ? "#38bdf8" : "var(--text-secondary)",
            fontSize: 11, fontWeight: 800, letterSpacing: "0.1em", cursor: "pointer",
          }}>{label}</button>
        ))}
        <div style={{ flex: 1 }} />
        {/* LIVE nav — only when not on live panel */}
        {panel !== "live" && (
          <button onClick={() => setPanel("live")} title="Back to Live" style={{
            height: 36, padding: "0 10px", marginRight: 8, borderRadius: 0,
            background: "var(--accent-cyan)", border: "none",
            color: "#000", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em",
            cursor: "pointer", display: "flex", alignItems: "center", gap: 4,
          }}>
            <svg width="7" height="8" viewBox="0 0 8 10" fill="currentColor"><polygon points="0,0 8,5 0,10"/></svg>
            LIVE
          </button>
        )}
        {/* XFADE — far right, red fill */}
        <button onClick={handleXfade} style={{
          height: 36, padding: "0 18px", borderRadius: 0,
          background: xfadeActive ? "#ef4444" : "#7f1d1d",
          border: `1px solid ${xfadeActive ? "#ef4444" : "#991b1b"}`,
          color: "#fff", fontSize: 12, fontWeight: 900, letterSpacing: "0.1em",
          cursor: "pointer", transition: "background 0.12s, box-shadow 0.12s",
          boxShadow: xfadeActive ? "0 0 14px rgba(239,68,68,0.55)" : "none",
        }}>XFADE</button>
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
    radio:   { library: "Song Library",    spots: "Spots & Promos",   clocks: "Clocks",            logs: "Play Log",      voicetrack: "Voice Tracker", live: "Live Assist",  tools: "Tools" },
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
      </Menu>
    ),
    tools: (
      <Menu>
        {/* Production */}
        <Item label={L.voicetrack}         onClick={() => set("voicetrack")} />
        <Item label="Studio Editor"        onClick={() => set("studio")} />
        {/* Video Studio lives as a deck type — configure via Deck Configurator */}
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
        {(currentUser?.role === "admin") && <Item label="Listener Analytics"   onClick={() => set("analytics")} />}
        {(currentUser?.role === "admin") && <Item label="Cloud Log Backup"     onClick={() => set("cloudbackup")} />}
        {(currentUser?.role === "admin") && <Item label="Audio Routing"        onClick={() => set("multioutput")} />}
        {(currentUser?.role === "admin") && <Item label="Station Manager"      onClick={() => set("stationmanager")} />}
        {(currentUser?.role === "admin") && <Item label="Macros"               onClick={() => set("macros")} />}
        {(currentUser?.role === "admin") && <Item label="MIDI Controller"      onClick={() => set("midi")} />}
        <Item separator />
        <Item label="Remote Dashboard ↗"  onClick={async () => {
          try {
            await (window as any).ether.invoke("open_url", { url: "https://ether-backend-production.up.railway.app/dashboard" });
          } catch { window.open("https://ether-backend-production.up.railway.app/dashboard", "_blank"); }
        }} />
        <Item label="System Health"        onClick={() => set("health")} />
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
  const KEYS = ["1","2","3","4","5","6","7","8","9","0","Q","W","E","R","T","Y","U","I","O","P","A","S","D","F"];
  const COLORS = ["#ef4444","#f97316","#fbbf24","#34d399","#22d3ee","#38bdf8","#a78bfa","#ec4899","#14b8a6","#6366f1","#84cc16","#f43f5e"];

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

function LivePanel({ deckA, deckB, deckC, autoAdv, shuffle, toggleAuto, toggleShuffle, queueLen, showCarts, toggleCarts, inputDevice, visiblePanels, deckConfigs, onConfigureDecks, autoSilenceTrim, setAutoSilenceTrim, xfadeDuration, setXfadeDuration, globalSearch, setGlobalSearch, nowPlaying, toolsCollapsed, toggleToolsCollapsed, autoXfade, setAutoXfade, xfadeActive, handleXfade, onOpenCarts }: {
  deckA: DeckState | null; deckB: DeckState | null; deckC: DeckState | null;
  autoAdv: boolean; shuffle: boolean;
  toggleAuto: () => void | Promise<void>; toggleShuffle: () => void;
  queueLen: number; showCarts: boolean; toggleCarts: () => void;
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
  xfadeActive: boolean;
  handleXfade: () => void;
  onOpenCarts: () => void;
}) {
  const vp = visiblePanels || { queue: true, deckA: true, deckB: true, deckC: true, mic: true };
  const lpViewport = useViewport();
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

  // Panel widths — resizable via drag divider
  const [queueWidth, setQueueWidth] = useState(320);
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
      const next = Math.max(320, Math.min(560, startW + (ev.clientX - startX) * dir));
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
  type DeckSlot = "A" | "B" | "C" | "mic";
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
        outline: dropTarget === "queue" ? "2px solid #38bdf8" : "none",
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
            <UpNext queueLen={queueLen} onQueueChange={() => window.dispatchEvent(new CustomEvent('ether:queue-changed'))} />
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
        opacity: dragging === "decks" ? 0.55 : 1,
        outline: dropTarget === "decks" ? "2px solid #38bdf8" : "none",
        outlineOffset: 2, borderRadius: 0,
        transition: "opacity 0.15s, outline 0.1s",
        // Dim all ConsoleStrip column dividers to near-invisible
        ["--panel-border" as any]: "1px solid rgba(255,255,255,0.06)",
        ["--strip-divider" as any]: "rgba(255,255,255,0.07)",
      } as React.CSSProperties}
    >
      {/* Deck title strips — column-aligned above each ConsoleStrip */}
      <ThreeSlotBar queueLen={queueLen} masterCollapsed={masterCollapsed} showCarts={showCarts} />
      {(
        /* ── Console channel strips — the default deck view.
           Uses activeDeckOrder from the deck configurator so all 6 slots work. ── */
        <div style={{ display: "flex", gap: 0, flex: 1, minHeight: 0 }}>
          {activeDeckOrder.map((slot) => {
            const config = deckConfigs?.find(d => d.slot === slot);
            const deckType = config?.type || (slot === "mic" ? "mic" : "music");
            const deckMap: Record<string, any> = { A: deckA, B: deckB, C: deckC };
            const deck = deckMap[slot as string];
            const deckColors: Record<string, string> = { A: "#38bdf8", B: "#34d399", C: "#a78bfa", D: "#fb923c", E: "#e879f9", mic: "#ef4444" };
            const deckColor = config?.color || deckColors[slot] || "#38bdf8";

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
            }

            // Mic decks → ConsoleStrip in fader mode (same design as music decks)
            if (deckType === "mic" || slot === "mic") {
              const micIsOn = consoleMicOn[slot] ?? false;
              return (
                <div key={slot} style={{ flex: 1, display: "flex", minWidth: 0 }}>
                  <ConsoleStrip
                    label={config?.label || "MIC"}
                    color="#ef4444"
                    volume={consoleMicVol[slot] ?? 1}
                    deckId="mic"
                    isPlaying={micIsOn}
                    isOn={micIsOn}
                    onVolumeChange={v => {
                      setConsoleMicVol(prev => ({ ...prev, [slot]: v }));
                      window.dispatchEvent(new CustomEvent("ether:mic-volume", { detail: { slot, volume: v } }));
                    }}
                    onToggleOn={() => {
                      const next = !micIsOn;
                      setConsoleMicOn(prev => ({ ...prev, [slot]: next }));
                      window.dispatchEvent(new CustomEvent("ether:mic-toggle", { detail: { slot, active: next } }));
                    }}
                  />
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
          {/* Master Output — owns its own audio:levels subscription */}
          <MasterOutput
            expanded={!showCarts && !masterCollapsed}
            collapsed={masterCollapsed}
            onToggleCollapsed={toggleMasterCollapsed}
          />
        </div>
      )}

      {/* Cart wall — shown when CARTS active or when a deck is configured as cart */}
      {showCarts && !deckConfigs?.some(d => d.type === "cart" && d.enabled) && (
        <div style={{ flexShrink: 0, background: "var(--bg-secondary)", borderRadius: 0, border: "1px solid var(--border-primary)", height: 200 }}>
          <BoutiqueCartWall deckSlot="C" />
        </div>
      )}
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
  const isInflight = (id: number) => inFlightCreates.current.has(`${songId}:${defId}:${id}`);

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

function LibraryPanel({ onLoadA, onLoadB, onLoadC, onQueue, onEdit, onSendToStudio }: { onLoadA: (s: SongRow) => void; onLoadB: (s: SongRow) => void; onLoadC: (s: SongRow) => void; onQueue: (s: SongRow) => void; onEdit: (s: SongRow) => void; onSendToStudio: (s: SongRow) => void }) {
  const { stationId } = useActiveStation();
  const watermarkedPaths = React.useMemo<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("ether_watermarked_paths") || "[]")); }
    catch { return new Set(); }
  }, []);
  const [showImport, setShowImport]   = useState(false);
  const [showNexGen, setShowNexGen]   = useState(false);
  const [showSpotify, setShowSpotify] = useState(false);
  const [showCreateCat, setShowCreateCat] = useState(false);
  const [newCatCode, setNewCatCode] = useState("");
  const [newCatName, setNewCatName] = useState("");
  const [newCatColor, setNewCatColor] = useState("#38bdf8");
  const [catList, setCatList] = useState<{ id: number; code: string; color: string | null }[]>([]);
  const [songs, setSongs] = useState<SongRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [count, setCount] = useState(0);
  const [status, setStatus] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
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
  const [metaUuidMap, setMetaUuidMap] = useState<Record<number, Record<number, string>>>({});
  // FK map: song_id → definition_id → value_vocabulary_id (only set for choice-type rows)
  const [metaVocabIdMap, setMetaVocabIdMap] = useState<Record<number, Record<number, number>>>({});
  // multi_choice: song_id → definition_id → [{uuid, vocabId, value}]
  const [metaMultiMap, setMetaMultiMap] = useState<Record<number, Record<number, MultiItem[]>>>({});
  // anchor for the multi_choice popover picker
  const [multiPopover, setMultiPopover] = useState<{ songId: number; defId: number; rect: DOMRect } | null>(null);
  // anchor for the single_choice popover picker
  const [singlePopover, setSinglePopover] = useState<{ songId: number; defId: number; rect: DOMRect } | null>(null);
  // in-flight create guard: prevents unchecking before the real uuid returns from DB
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
    const existingUuid = metaUuidMap[songId]?.[col.defId];
    if (!existingUuid && value === '') return;

    // For single_choice: resolve the vocab FK so we write BOTH value_text and value_vocabulary_id
    const vocabRow = col.dataType === 'single_choice'
      ? vocabByDef[col.defId]?.find(v => v.value === value)
      : undefined;
    const vocabId = vocabRow?.id ?? null;

    // Build write payload — FK only for choice types
    const writePayload: Record<string, unknown> = { value_text: value };
    if (col.dataType === 'single_choice') writePayload.value_vocabulary_id = vocabId;

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
      if (existingUuid) {
        await (window as any).ether.songMetadataValues.update(existingUuid, writePayload);
      } else {
        const res = await (window as any).ether.songMetadataValues.create({
          station_id: stationId, song_id: songId, definition_id: col.defId, ...writePayload,
        });
        if (res?.ok && res.row?.uuid) {
          setMetaUuidMap(prev => ({ ...prev, [songId]: { ...(prev[songId] ?? {}), [col.defId]: res.row.uuid } }));
        }
      }
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
    const current  = metaMultiMap[songId]?.[defId] ?? [];
    const existing = current.find(r => r.vocabId === vocab.id);
    const key      = `${songId}:${defId}:${vocab.id}`;

    if (existing) {
      // Uncheck: optimistic remove, then IPC soft-delete
      setMetaMultiMap(prev => {
        const arr = (prev[songId]?.[defId] ?? []).filter(r => r.vocabId !== vocab.id);
        return { ...prev, [songId]: { ...(prev[songId] ?? {}), [defId]: arr } };
      });
      try {
        await (window as any).ether.songMetadataValues.delete(existing.uuid, stationId);
      } catch (e) {
        console.error('[toggleMultiChoice] delete failed, reverting:', e);
        setMetaMultiMap(prev => {
          const arr = [...(prev[songId]?.[defId] ?? []), existing];
          return { ...prev, [songId]: { ...(prev[songId] ?? {}), [defId]: arr } };
        });
      }
    } else {
      // Check: guard in-flight, optimistic add with temp uuid, swap after DB returns
      inFlightCreates.current.add(key);
      const tempUuid = `tmp-${Date.now()}-${vocab.id}`;
      setMetaMultiMap(prev => {
        const arr = [...(prev[songId]?.[defId] ?? []), { uuid: tempUuid, vocabId: vocab.id, value: vocab.value }];
        return { ...prev, [songId]: { ...(prev[songId] ?? {}), [defId]: arr } };
      });
      try {
        const res = await (window as any).ether.songMetadataValues.create({
          station_id: stationId, song_id: songId, definition_id: defId,
          value_text: vocab.value, value_vocabulary_id: vocab.id,
        });
        if (res?.ok && res.row?.uuid) {
          const realUuid = res.row.uuid;
          setMetaMultiMap(prev => {
            const arr = (prev[songId]?.[defId] ?? []).map(r => r.uuid === tempUuid ? { ...r, uuid: realUuid } : r);
            return { ...prev, [songId]: { ...(prev[songId] ?? {}), [defId]: arr } };
          });
        }
      } catch (e) {
        console.error('[toggleMultiChoice] create failed, reverting:', e);
        setMetaMultiMap(prev => {
          const arr = (prev[songId]?.[defId] ?? []).filter(r => r.uuid !== tempUuid);
          return { ...prev, [songId]: { ...(prev[songId] ?? {}), [defId]: arr } };
        });
      } finally {
        inFlightCreates.current.delete(key);
      }
    }
  };

  // ── Single-choice clear (soft-delete the smv row) ─────────
  const clearSingleChoice = async (songId: number, defId: number) => {
    const uuid = metaUuidMap[songId]?.[defId];
    if (!uuid) return;
    const prevValue   = metaMap[songId]?.[defId];
    const prevVocabId = metaVocabIdMap[songId]?.[defId];
    setMetaMap(prev => { const r = { ...(prev[songId] ?? {}) }; delete r[defId]; return { ...prev, [songId]: r }; });
    setMetaUuidMap(prev => { const r = { ...(prev[songId] ?? {}) }; delete r[defId]; return { ...prev, [songId]: r }; });
    setMetaVocabIdMap(prev => { const r = { ...(prev[songId] ?? {}) }; delete r[defId]; return { ...prev, [songId]: r }; });
    try {
      await (window as any).ether.songMetadataValues.delete(uuid, stationId);
    } catch (e) {
      console.error('[clearSingleChoice] delete failed, reverting:', e);
      setMetaMap(prev => ({ ...prev, [songId]: { ...(prev[songId] ?? {}), [defId]: prevValue ?? '' } }));
      setMetaUuidMap(prev => ({ ...prev, [songId]: { ...(prev[songId] ?? {}), [defId]: uuid } }));
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
      setNewCatCode(""); setNewCatName(""); setNewCatColor("#38bdf8");
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
      setCatList(await queryScoped<{ id: number; code: string; color: string | null }>("SELECT id, code, color FROM categories ORDER BY code", [], stationId));
    } catch (e) { console.error(e); setStatus("Error: " + e); }
    setLoading(false);
  };
  useEffect(() => { load(); }, [stationId]);

  // Load definitions and restore per-station metadata column visibility + widths
  const reloadDefs = useCallback(async () => {
    try {
      const res = await (window as any).ether.metadataDefinitions.list(stationId);
      const rows: MetadataDefinition[] = res?.ok ? (res.rows ?? []) : [];
      setDefs(rows.filter(d => !d.deleted_at).sort((a, b) => a.display_order - b.display_order || a.name.localeCompare(b.name)));
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

  // Fetch song_metadata_values for visible metadata columns (skip if none visible)
  useEffect(() => {
    if (visibleMetaCols.size === 0 || songs.length === 0) { setMetaMap({}); setMetaUuidMap({}); setMetaVocabIdMap({}); setMetaMultiMap({}); return; }
    (async () => {
      try {
        const res = await (window as any).ether.songMetadataValues.list(stationId, { limit: 10000 });
        const rows: any[] = res?.ok ? (res.rows ?? []) : [];
        const map: Record<number, Record<number, string>> = {};
        const uuidMap: Record<number, Record<number, string>> = {};
        const vocabIdMap: Record<number, Record<number, number>> = {};
        const multiMap: Record<number, Record<number, MultiItem[]>> = {};
        for (const r of rows) {
          if (!visibleMetaCols.has(r.definition_id)) continue;
          const defType = defs.find(d => d.id === r.definition_id)?.data_type;
          if (defType === 'multi_choice') {
            if (!multiMap[r.song_id]) multiMap[r.song_id] = {};
            if (!multiMap[r.song_id][r.definition_id]) multiMap[r.song_id][r.definition_id] = [];
            multiMap[r.song_id][r.definition_id].push({ uuid: r.uuid, vocabId: r.value_vocabulary_id ?? 0, value: r.value_text ?? '' });
          } else {
            if (!map[r.song_id]) map[r.song_id] = {};
            if (!uuidMap[r.song_id]) uuidMap[r.song_id] = {};
            map[r.song_id][r.definition_id] = r.value_text ?? '';
            uuidMap[r.song_id][r.definition_id] = r.uuid;
            if (r.value_vocabulary_id != null) {
              if (!vocabIdMap[r.song_id]) vocabIdMap[r.song_id] = {};
              vocabIdMap[r.song_id][r.definition_id] = r.value_vocabulary_id;
            }
          }
        }
        setMetaMap(map);
        setMetaUuidMap(uuidMap);
        setMetaVocabIdMap(vocabIdMap);
        setMetaMultiMap(multiMap);
      } catch (e) { console.error('[LibraryPanel] failed to load metadata values:', e); }
    })();
  }, [stationId, songs, visibleMetaCols, smvReloadKey]);

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
    const folder = await open({ directory: true, title: "Select new music folder location" });
    if (!folder) return;
    const newBase = (folder as string).replace(/\\/g, "/");
    // station_id scoping: Strategy B — single table with existing WHERE
    const broken = await queryScoped<{id: number, file_path: string}>("SELECT id, file_path FROM songs WHERE file_path IS NOT NULL", [], stationId);
    let fixed = 0;
    for (const song of broken) {
      const filename = song.file_path.split(/[\/]/).pop();
      if (!filename) continue;
      const newPath = newBase + "/" + filename;
      if (song.file_path !== newPath) {
        await (window as any).ether.songs.updateById(song.id, { file_path: newPath }); fixed++;
      }
    }
    setStatus("Relocated " + fixed + " songs"); setTimeout(() => setStatus(""), 4000); load();
  };
  const queueAll = () => { engine.addToQueue(filtered.filter(s => s.file_path).map(s => ({ filePath: s.file_path!, title: s.title, artist: s.artist_name || "", durationMs: s.duration_ms ?? 0 }))); window.dispatchEvent(new CustomEvent('ether:queue-changed')); };
  const filtered = songs.filter(s => {
    const matchSearch = !search ||
      (s.title||"").toLowerCase().includes(search.toLowerCase()) ||
      (s.artist_name||"").toLowerCase().includes(search.toLowerCase());
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
            : <button onClick={() => window.dispatchEvent(new CustomEvent("ether:open-subscription"))} style={{ padding: "7px 14px", borderRadius: 0, fontSize: 12, fontWeight: 600, background: "rgba(167,139,250,0.08)", color: "#a78bfa", border: "1px solid rgba(167,139,250,0.25)", cursor: "pointer" }} title="Station plan required">🔒 NexGen / ENCO</button>
          }
          <button onClick={() => { setShowCreateCat(p => !p); setShowImport(false); }} style={{ padding: "7px 14px", borderRadius: 0, fontSize: 12, fontWeight: 700, background: showCreateCat ? "var(--accent-purple)" : "var(--bg-secondary)", color: showCreateCat ? "#fff" : "var(--text-secondary)", border: "1px solid var(--border-secondary)", cursor: "pointer" }}>{showCreateCat ? "Cancel" : "+ Category"}</button>
          <button onClick={() => { setShowImport(p => !p); setShowCreateCat(false); }} style={{ padding: "7px 16px", borderRadius: 0, fontSize: 12, fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer", boxShadow: "0 2px 8px rgba(14,165,233,0.35)" }}>{showImport ? "Cancel" : "+ Import Music"}</button>
        </div>
      </div>

      {/* Filters row */}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input placeholder="Search title or artist…" value={search} onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, maxWidth: 280, padding: "8px 12px", borderRadius: 0, fontSize: 12, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }} />
        {/* Category filter */}
        <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}
          style={{ padding: "8px 12px", borderRadius: 0, fontSize: 12, background: categoryFilter ? "rgba(56,189,248,0.1)" : "var(--bg-secondary)", border: `1px solid ${categoryFilter ? "rgba(56,189,248,0.4)" : "var(--border-primary)"}`, color: categoryFilter ? "var(--accent-cyan)" : "var(--text-secondary)", outline: "none", cursor: "pointer" }}>
          <option value="">All Categories</option>
          {catList.map(c => <option key={c.id} value={c.code}>{c.code}</option>)}
        </select>
        {/* Assign category to filtered songs */}
        <select onChange={async (e) => { if (!e.target.value) return; const catId = catList.find(c => c.code === e.target.value)?.id || null; for (const s of filtered) await (window as any).ether.songs.updateById(s.id, { category_id: catId }); e.target.value = ""; load(); }}
          style={{ padding: "8px 12px", borderRadius: 0, fontSize: 12, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", outline: "none", cursor: "pointer" }}>
          <option value="">Assign category...</option>
          {catList.map(c => <option key={c.id} value={c.code}>All → {c.code}</option>)}
        </select>
        <button onClick={queueAll} style={S.btn("var(--accent-green)", "#000")}>Queue All</button>
        {selectedIds.size > 0 && <button onClick={deleteSelected} style={S.btn("var(--accent-red)")}>Delete {selectedIds.size}</button>}
        <button onClick={deleteAll} style={{ ...S.btnOutline, color: "var(--accent-red)" as any }}>Delete All</button>
      </div>

      {status && <div style={{ padding: "10px 14px", background: "rgba(56,189,248,0.08)", border: "1px solid rgba(56,189,248,0.2)", borderRadius: 0, fontSize: 12, color: "var(--accent-blue)" }}>{status}</div>}
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
              <button onClick={lookupDiscogs} disabled={discogsLoading} style={{ padding: "7px 16px", borderRadius: 0, fontSize: 12, fontWeight: 700, background: "rgba(56,189,248,0.12)", color: "var(--accent-blue)", border: "1px solid rgba(56,189,248,0.3)", cursor: "pointer" }}>
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
              <div role="columnheader" style={{ padding: "10px 12px", fontSize: 12, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.08em", display: "flex", alignItems: "center", overflow: "hidden", position: "relative" as any, borderRight: "1px solid var(--border-primary)" }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>Title</span>
                <span onMouseDown={e => startColResize('title', e, titleW)} style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 6, cursor: "col-resize", zIndex: 1 }} />
              </div>
            )}
            <div ref={middleHeaderRef} style={{ display: "flex", overflow: "hidden" }}>
              {pageMiddleCols.map(col => {
                const w = colW(col);
                const key = col.kind === 'standard' ? col.id : `meta-${col.defId}`;
                return (
                  <div key={key} role="columnheader" style={{ flex: `0 0 ${w}px`, padding: "10px 12px", fontSize: 12, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.08em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any, position: "relative" as any, borderRight: "1px solid var(--border-primary)" }}>
                    {col.label}
                    <span
                      onMouseDown={e => col.kind === 'standard' ? startColResize(col.id, e, w) : startMetaColResize(col.defId, e, w)}
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
          {filtered.map((s, i) => (
            <div
              key={s.id}
              role="row"
              className="ether-lib-row"
              style={{ borderBottom: i < filtered.length - 1 ? "1px solid var(--border-primary)" : "none" }}
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
              {/* Title */}
              {hasTitleCol && (() => {
                const isInlineTitle = inlineEdit?.id === s.id && inlineEdit?.col === 'title';
                return (
                  <div
                    role="gridcell"
                    style={{ padding: "10px 12px", color: "var(--text-primary)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any, display: "flex", alignItems: "center", cursor: "text", borderRight: "1px solid var(--border-primary)" }}
                    onDoubleClick={() => setInlineEdit({ id: s.id, col: 'title', value: s.title || "" })}
                  >
                    {s.file_path && watermarkedPaths.has(s.file_path) && (
                      <span title="Content provenance watermark embedded" style={{ marginRight: 5, fontSize: 11, color: "#00c8a8", flexShrink: 0 }}>🛡</span>
                    )}
                    {isInlineTitle
                      ? <input autoFocus value={inlineEdit!.value} onChange={e => setInlineEdit(prev => prev ? { ...prev, value: e.target.value } : prev)} onBlur={commitInline} onKeyDown={e => { if (e.key === "Enter") commitInline(); if (e.key === "Escape") setInlineEdit(null); }} style={{ flex: 1, padding: "2px 4px", fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--accent-blue)", color: "var(--text-primary)", outline: "none" }} />
                      : <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>{s.title || "—"}</span>}
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
                          <div style={{ display: "flex", alignItems: "center", flex: 1, minWidth: 0, padding: "3px 6px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", cursor: "pointer", overflow: "hidden", position: "relative" }}>
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
                          <div style={{ display: "flex", alignItems: "center", flex: 1, minWidth: 0, padding: "3px 6px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", cursor: "pointer", overflow: "hidden", position: "relative" }}>
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
                <button onClick={() => onLoadA(s)} className="ether-action-btn" style={{ padding: "4px 8px", borderRadius: 0, fontSize: 12, fontWeight: 700, background: "rgba(56,189,248,0.15)", color: "var(--accent-blue)", border: "none", cursor: "pointer" }}>A</button>
                <button onClick={() => onLoadB(s)} className="ether-action-btn" style={{ padding: "4px 8px", borderRadius: 0, fontSize: 12, fontWeight: 700, background: "rgba(52,211,153,0.15)", color: "var(--accent-green)", border: "none", cursor: "pointer" }}>B</button>
                <button onClick={() => onLoadC(s)} className="ether-action-btn" style={{ padding: "4px 8px", borderRadius: 0, fontSize: 12, fontWeight: 700, background: "rgba(167,139,250,0.15)", color: "#a78bfa", border: "none", cursor: "pointer" }}>C</button>
                <button onClick={() => onQueue(s)} className="ether-action-btn" style={{ padding: "4px 8px", borderRadius: 0, fontSize: 12, fontWeight: 700, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>Q</button>
                <button onClick={() => onEdit(s)} title="Cue Editor" className="ether-action-btn" style={{ padding: "4px 8px", borderRadius: 0, fontSize: 12, fontWeight: 700, background: "rgba(167,139,250,0.15)", color: "#a78bfa", border: "none", cursor: "pointer" }}>
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
    </div>
  );
}

// ── Three-Slot Bar — replaces NowPlayingPill in the LivePanel toolbar ──
// Shows DECK A / DECK B / DECK C as fixed physical columns — titles never shift.
// ON AIR badge floats to whichever deck is playing; preloaded decks show green.
function ThreeSlotBar({ queueLen, masterCollapsed = true, showCarts = false }: { queueLen: number; masterCollapsed?: boolean; showCarts?: boolean }) {
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

  const DECK_COLORS = ["#38bdf8", "#34d399", "#a78bfa"] as const;
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
  }, [queueLen]);

  // Progress fill — imperative CSS transitions matching ConsoleStrip pattern
  useEffect(() => {
    fillRefs.forEach(r => { if (r.current) r.current.style.width = "0%"; });
    const unsub = engine.on(() => {
      DECK_IDS_ALL.forEach((id, i) => {
        const da   = engine.getDeck(id)?.getState?.();
        const fill = fillRefs[i].current;
        if (!fill || !da) return;
        const trackKey = `~${Math.round(da.durationSec ?? 0)}`;
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
  }, []);

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
          const isActive     = isPlaying || isPaused || slot.ready;
          const remaining    = Math.max(0, slot.durationSec - slot.positionSec);
          const isEndingSoon = isPlaying && remaining > 0 && remaining < 15;
          const timeStr      = (isPlaying || isPaused)
            ? `-${fmt(remaining)}`
            : slot.ready && slot.durationSec > 0 ? fmt(slot.durationSec) : "";
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
              : { width: 220, flexShrink: 0, borderLeft: "1px solid rgba(255,255,255,0.06)" }
        } />
      </div>
    </>
  );
}

// ── Now Playing Pill — sits in the toolbar right of CARTS ──
// Shows active track info with a slide+fade animation when the song changes.
// Subscribes to the engine for deck state updates.
function NowPlayingPill() {
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
  }, []);

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
          0%, 100% { box-shadow: 0 0 0 0 rgba(34,211,238,0.0); }
          50%      { box-shadow: 0 0 0 2px rgba(34,211,238,0.18); }
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
          background: track ? "#22d3ee" : "#3a3a4a",
          boxShadow: track ? "0 0 6px rgba(34,211,238,0.7)" : "none",
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
              background: isEndingSoon ? "#fbbf24" : "#22d3ee",
              boxShadow: isEndingSoon ? "0 0 4px rgba(251,191,36,0.6)" : "0 0 4px rgba(34,211,238,0.5)",
              transition: "width 1s linear, background 0.3s",
            }} />
          </div>
        )}
      </div>
    </>
  );
}

function ClockDisplay({ size = "full" }: { size?: "full" | "lg" | "md" | "sm" | "xs" | "hidden" }) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  // At "sm"/"xs", drop seconds and date to avoid clipping at narrow widths.
  const showSeconds = size === "full" || size === "lg" || size === "md";
  const showDate = size === "full" || size === "lg";
  const time = now.toLocaleTimeString([], showSeconds
    ? { hour: "2-digit", minute: "2-digit", second: "2-digit" }
    : { hour: "2-digit", minute: "2-digit" });
  const day = now.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const fontSize =
    size === "full" ? 52 :
    size === "lg"   ? 40 :
    size === "md"   ? 32 :
    size === "sm"   ? 24 :
                      18; // xs
  const dateSize = size === "full" ? 13 : 11;
  return (
    <div style={{ textAlign: "center", lineHeight: 1 }}>
      <div style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize, fontWeight: 700, color: "#fff", letterSpacing: "0.03em", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{time}</div>
      {showDate && <div style={{ fontFamily: "'Inter', sans-serif", fontSize: dateSize, color: "var(--text-secondary)", marginTop: 5, letterSpacing: "0.02em" }}>{day}</div>}
    </div>
  );
}
