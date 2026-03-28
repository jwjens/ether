import UserLogin from "./components/UserLogin";
import KeyboardHelp from "./components/KeyboardHelp";
import EtherLogo from "./components/EtherLogo";
import { UserContext, AppUser, useRole } from "./UserContext";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import React, { useState, useEffect, useRef, useCallback } from "react";
import { query, execute, queryOne, logPlay, searchSongs, dbHealthCheck } from "./db/client";
import { open } from "@tauri-apps/plugin-dialog";
import { readDir } from "@tauri-apps/plugin-fs";
import { engine, DeckState } from "./audio/engine-rodio";
import { fillQueueFromSchedule, refillFromSchedule } from "./audio/loggen";
import { readID3 } from "./audio/id3";
import { autoCueSong } from "./audio/songAnalysis";
import Waveform from "./components/Waveform";
import OnAirDeck from "./components/OnAirDeck";
import CartWall from "./components/CartWall";
import DeckConfigurator, { useDeckConfig, PlaylistPlayer, BoutiqueCartWall, type DeckConfig } from "./components/DeckConfigurator";
import ProducerDesk from "./components/ProducerDesk";
import SmartScheduler from "./components/SmartScheduler";
import ImportDialog from "./components/ImportDialog";
import NexGenImport from "./components/NexGenImport";
import SettingsPanel from "./components/SettingsPanel";
import DMCANotice from "./components/DMCANotice";
import JockStrip from "./components/JockStrip";
import UpNext from "./components/UpNext";
import Scheduler from "./components/Scheduler";
import ProgramLog from "./components/ProgramLog";
import Logs from "./components/Logs";
import NowPlaying from "./components/NowPlaying";
import { openNowPlayingWindow } from "./components/NowPlayingWindow";
import Spots from "./components/Spots";
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
import { useCanvasEngine } from "./canvas/CanvasEngine";
import AutoCue from "./components/AutoCue";
import PodcastStudio from "./components/PodcastStudio";
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
import { useSkin, SkinPickerOverlay, AppContextMenu } from "./components/SkinPicker";
import BroadcastEditor from "./components/BroadcastEditor";
import StudioEditor from "./components/StudioEditor";

type Panel = "live" | "library" | "clocks" | "logs" | "spots" | "voicetrack" | "announce" | "streaming" | "settings" | "showprep" | "trackedit" | "subscription" | "autocue" | "health" | "podcast" | "cartwall" | "playlist" | "smartschedule" | "programlog" | "studio" | "broadcasteditor" | "phonedesk" | "analytics" | "cloudbackup" | "multioutput" | "stationmanager";

interface SongRow {
  id: number; title: string; file_path: string | null;
  artist_name: string | null; album_title: string | null;
  genre: string | null; duration_ms: number;
  category_code: string | null; category_color: string | null;
  intro_end?: number | null; outro_start?: number | null; bpm?: number | null;
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
        height: 32, padding: "0 14px", borderRadius: 8,
        fontSize: 10, fontWeight: 700, letterSpacing: "0.08em",
        cursor: "pointer", fontFamily: "'Inter', sans-serif",
        transition: "all 0.15s ease",
        background: active ? color : "var(--bg-secondary)",
        color: active ? "#000" : "var(--text-tertiary)",
        border: active ? "none" : "1px solid var(--border-primary)",
        boxShadow: active ? `0 2px 12px ${color}40` : "none",
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
  podcast:      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>,
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
            borderRadius: 7, padding: "3px 9px",
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
            padding: "3px 6px", borderRadius: 7,
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
            fontSize: 9, fontWeight: 700, letterSpacing: "0.08em",
            padding: "3px 8px", borderRadius: 6,
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
          style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 10, padding: "2px 4px", borderRadius: 5 }}
          title="Switch layout"
        >▾</button>
      )}

      {showList && (
        <>
          <div onClick={() => setShowList(false)} style={{ position: "fixed" as const, inset: 0, zIndex: 998 }} />
          <div style={{
            position: "absolute" as const, top: "calc(100% + 6px)", left: 0, zIndex: 999,
            background: "var(--bg-secondary)", border: "1px solid var(--border-secondary)",
            borderRadius: 12, padding: 8, minWidth: 240,
            boxShadow: "0 8px 32px rgba(0,0,0,0.25)",
            fontFamily: "'Inter', sans-serif",
          }}>
            <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.14em", color: "var(--text-tertiary)", padding: "2px 8px 8px", textTransform: "uppercase" as const }}>Saved Layouts</div>
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
                      style={{ flex: 1, fontSize: 12, padding: "4px 8px", borderRadius: 6, border: "1px solid var(--accent-cyan)", background: "var(--bg-tertiary)", color: "var(--text-primary)", outline: "none" }}
                    />
                    <button onClick={() => setRenamingId(null)} style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 12 }}>✕</button>
                  </div>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: 4, borderRadius: 8, background: l.name === name ? "rgba(56,189,248,0.1)" : "none" }}>
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
                      {l.name === name && <span style={{ fontSize: 9, opacity: 0.5, marginLeft: 6 }}>active</span>}
                    </button>
                    {/* Rename */}
                    <button
                      title="Rename"
                      onClick={e => { e.stopPropagation(); setRenamingId(l.id); setRenameDraft(l.name); }}
                      style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", padding: "4px 6px", borderRadius: 5, fontSize: 11, opacity: 0.6 }}
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
                        style={{ background: "none", border: "none", color: "var(--accent-red)", cursor: "pointer", padding: "4px 6px", borderRadius: 5, fontSize: 11, opacity: 0.5, marginRight: 2 }}
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

export default function App() {
  const [splashDone, setSplashDone] = useState(false);
  const [wizardDone, setWizardDone] = useState(false);
  const [firstRunChecked, setFirstRunChecked] = useState(false);
  const [stationName, setStationName] = useState("Ether");
  const [currentUser, setCurrentUser] = useState<AppUser | null>(null);
  const [currentPlan, setCurrentPlan] = useState<PlanTier>("free");
  const [panel, setPanel] = useState<Panel>("live");
  const panelRef = useRef<Panel>("live");
  useEffect(() => { panelRef.current = panel; }, [panel]);
  const [onAir, setOnAir] = useState(false);
  const [onAirOverride, setOnAirOverride] = useState(false);
  const onAirOverrideRef = useRef(false); // ref avoids stale closure in engine.on
  const [restoreInfo, setRestoreInfo] = useState<{ title: string | null; position: number; queueLen: number; savedAt: number } | null>(null);
  const [deckA, setDeckA] = useState<DeckState | null>(null);
  const [deckB, setDeckB] = useState<DeckState | null>(null);
  const [deckC, setDeckC] = useState<DeckState | null>(null);
  const [autoAdv, setAutoAdv] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [continuous, setContinuous] = useState(false);
  const [queueLen, setQueueLen] = useState(0);
  const [darkMode, setDarkMode] = useState(false);
  const [showCarts, setShowCarts] = useState(false);
  const [showDeckConfig, setShowDeckConfig] = useState(false);
  const [showProducerDesk, setShowProducerDesk] = useState(false);

  const openDeskWindow = async () => {
    try {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const existing = await WebviewWindow.getByLabel("producer-desk").catch(() => null);
      if (existing) {
        // Bring existing window to front
        await existing.show();
        await existing.setFocus();
        return;
      }
      const win = new WebviewWindow("producer-desk", {
        url: "index.html#desk",
        title: "Ether — Producer Desk",
        width: 900,
        height: 620,
        minWidth: 600,
        minHeight: 400,
        resizable: true,
        decorations: true,
        center: false,
        x: Math.round(window.screen.width * 0.55),
        y: 80,
        focus: true,
      });
      win.once("tauri://error", (e) => console.error("Desk window error:", e));
    } catch (e) {
      // Fallback: show inline if window API unavailable (dev mode)
      setShowProducerDesk(p => !p);
    }
  };
  const { configs: deckConfigs, save: saveDeckConfigs, enabled: enabledDecks } = useDeckConfig();
  const [outputDevice, setOutputDevice] = useState("");
  const [inputDevice, setInputDevice] = useState("");
  const [editSong, setEditSong] = useState<any>(null);

  // Check if first run is complete
  useEffect(() => {
    (async () => {
      try {
        const rows = await query<{ value: string }>("SELECT value FROM station_config_kv WHERE key = 'first_run_complete'");
        if (rows.length > 0 && rows[0].value === "1") setWizardDone(true);
        const nameRows = await query<{ value: string }>("SELECT value FROM station_config_kv WHERE key = 'station_name'");
        if (nameRows.length > 0 && nameRows[0].value) setStationName(nameRows[0].value);
        const planRows = await query<{ value: string }>("SELECT value FROM station_config_kv WHERE key = 'plan_tier'");
        if (planRows.length > 0) {
          const p = planRows[0].value as PlanTier;
          setCurrentPlan(p);
          setPlanGlobally(p);
        }
      } catch {}
      setFirstRunChecked(true);
    })();
  }, []);

  // Allow any UpgradePrompt button anywhere in the app to open the subscription panel
  useEffect(() => {
    const handler = () => setPanel("subscription");
    window.addEventListener("ether:open-subscription", handler);
    return () => window.removeEventListener("ether:open-subscription", handler);
  }, []);

  // ── Remote command polling (emergency override + companion) ──
  useEffect(() => {
    const POLL_URL = "https://ether-backend-production.up.railway.app/api/pending-cmds";
    const execCmd  = async (cmd: string, data: any) => {
      try {
        switch (cmd) {
          case "stop_all":
            engine.stopAll?.();
            deckA?.stop(); deckB?.stop(); deckC?.stop();
            break;
          case "play":
            engine.resumeActive?.() || deckA?.play();
            break;
          case "pause":
            engine.pauseActive?.() || deckA?.pause();
            break;
          case "skip":
            engine.skipToNext?.();
            break;
          case "set_volume":
            if (data.volume !== undefined) engine.setMasterVolume?.(data.volume);
            break;
          case "automation_on":
            setAutoMode(true);
            break;
          case "automation_off":
            setAutoMode(false);
            break;
          case "play_emergency_cart":
            engine.playEmergencyCart?.();
            break;
          case "mic_on":
            engine.openMic?.();
            break;
          default:
            console.log("[RemoteCmd] Unknown command:", cmd);
        }
      } catch (e) {
        console.error("[RemoteCmd] Exec failed:", cmd, e);
      }
    };

    const poll = async () => {
      try {
        const res  = await fetch(POLL_URL, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) return;
        const cmds: Array<{ cmd: string; data: any; ts: number }> = await res.json();
        for (const c of cmds) await execCmd(c.cmd, c.data || {});
      } catch {}
    };

    const timer = setInterval(poll, 2000);
    return () => clearInterval(timer);
  }, [deckA, deckB, deckC]);

  const handleWizardComplete = (profile: VenueProfile) => {
    setStationName(profile.name);
    setWizardDone(true);
  };

  useEffect(() => {
    (globalThis as any).__etherEngine = engine;
    // Column additions now handled by db/client.ts migration system
    return engine.onPlayStart(async (deckId, title, artist, _filePath) => {
      try { await logPlay(title, artist, deckId); }
      catch (e) { console.error('Log write error:', e); }
    });
  }, []);

  useEffect(() => {
    const unlisten = listen("desk-send-to-queue", (event: any) => {
      const track = event.payload as { title: string; artist: string; filePath?: string };
      if (!track?.title) return;
      engine.addToQueue([{
        filePath: track.filePath || "",
        title: track.title,
        artist: track.artist || "",
      }]);
      setQueueLen(engine.getQueue().length);
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
    engine.setRefillCallback(async () => {
      const rows = await query<SongRow>("SELECT s.*, a.name as artist_name FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.file_path IS NOT NULL ORDER BY RANDOM() LIMIT 500");
      return rows.filter(s => s.file_path).map(s => ({ filePath: s.file_path!, title: s.title, artist: s.artist_name || "", introEnd: s.intro_end ?? undefined, outroStart: s.outro_start ?? undefined }));
    });
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement).isContentEditable) return;
      const dA = engine.getDeck("A"); const dB = engine.getDeck("B");
      switch(e.code) {
        case "Space": e.preventDefault(); if (panelRef.current === "trackedit") break; if (dA) { if (dA.getState().status === "playing") dA.pause(); else if (dA.getState().status === "paused") dA.resume(); else dA.play(); } break;
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
        case "Escape": dA?.stop(); dB?.stop(); setShowShortcuts(false); break;
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [deckA, deckB]);

  useEffect(() => {
    engine.init();
    engine.outroCrossfade = true;
    engine.crossfadeDuration = xfadeDuration;
    return engine.on((id, st) => {
      if (id === "A") setDeckA({...st});
      else if (id === "B") setDeckB({...st});
      else if (id === "C") setDeckC({...st});
      setQueueLen(engine.getQueue().length);
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
    });
  }, []);

  useEffect(() => {
    const saveQueue = async () => {
      try {
        const queue = engine.getQueue();
        const dA = engine.getDeck('A')?.getState();
        await execute("UPDATE crash_recovery SET queue_json=?, deck_a_path=?, deck_a_title=?, deck_a_artist=?, deck_a_position=?, was_playing=?, saved_at=unixepoch() WHERE id=1",
          [JSON.stringify(queue), dA?.filePath || null, dA?.title || null, dA?.artist || null, dA?.positionSec || 0, dA?.status === 'playing' ? 1 : 0]);
      } catch (e) { console.error('Autosave failed:', e); }
    };
    const id = setInterval(saveQueue, 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const row = await queryOne<{queue_json: string, deck_a_path: string | null, deck_a_title: string | null, deck_a_artist: string | null, was_playing: number, saved_at: number}>("SELECT * FROM crash_recovery WHERE id=1");
        if (!row || !row.saved_at) return;
        if (Date.now() / 1000 - row.saved_at > 3600) return;
        const queue = JSON.parse(row.queue_json || '[]');
        if (queue.length > 0) { engine.addToQueue(queue); setQueueLen(queue.length); console.log('Restored', queue.length, 'items from crash recovery'); }
        if (row.deck_a_path && row.deck_a_title) {
          await engine.loadToDeck('A', row.deck_a_path, row.deck_a_title, row.deck_a_artist || '');
          console.log('Restored deck A:', row.deck_a_title);
          setTimeout(() => engine.triggerPreload(), 1000);
          // Show restore toast
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
        await engine.loadToDeck('A', next.filePath, next.title, next.artist);
        engine.getDeck('A')?.play();
        setTimeout(() => engine.triggerPreload(), 1000);
      } else if (autoAdv) {
        await fillQueueFromSchedule().then(async (count) => {
          if (count === 0) {
            const rows = await query<SongRow>("SELECT s.*, a.name as artist_name FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.file_path IS NOT NULL ORDER BY RANDOM() LIMIT 100");
            engine.addToQueue(rows.filter(s => s.file_path).map(s => ({ filePath: s.file_path!, title: s.title, artist: s.artist_name || "" })));
          }
          const q2 = engine.getQueue();
          if (q2.length > 0) {
            const next = q2[0]; engine.clearQueue(); engine.addToQueue(q2.slice(1));
            await engine.loadToDeck('A', next.filePath, next.title, next.artist);
            engine.getDeck('A')?.play();
            setTimeout(() => engine.triggerPreload(), 1000);
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
    if (n) {
      engine.init(); engine.continuous = true; setContinuous(true); engine.shuffle = false; setShuffle(false);
      if (engine.getQueue().length === 0) {
        const count = await fillQueueFromSchedule();
        if (count === 0) {
          engine.setRefillCallback(async () => {
            const rows = await query<SongRow>("SELECT s.*, a.name as artist_name FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.file_path IS NOT NULL ORDER BY RANDOM() LIMIT 500");
            return rows.filter(s => s.file_path).map(s => ({ filePath: s.file_path!, title: s.title, artist: s.artist_name || "", introEnd: s.intro_end ?? undefined, outroStart: s.outro_start ?? undefined }));
          });
          const rows = await query<SongRow>("SELECT s.*, a.name as artist_name FROM songs s LEFT JOIN artists a ON a.id = s.artist_id WHERE s.file_path IS NOT NULL ORDER BY RANDOM() LIMIT 100");
          const items = rows.filter(s => s.file_path).map(s => ({ filePath: s.file_path!, title: s.title, artist: s.artist_name || "" }));
          engine.addToQueue(items); setQueueLen(items.length);
        }
      }
      const q = engine.getQueue();
      if (q.length > 0 && engine.getDeck('A')?.getState().status !== 'playing') {
        const first = q[0]; engine.clearQueue(); engine.addToQueue(q.slice(1)); setQueueLen(engine.getQueue().length);
        await engine.loadToDeck('A', first.filePath, first.title, first.artist);
        engine.getDeck('A')?.play();
        setTimeout(() => engine.triggerPreload(), 800);
      }
    } else { engine.continuous = false; setContinuous(false); }
  };

  const toggleShuffle = () => { const n = !shuffle; setShuffle(n); engine.shuffle = n; };

  const loadA = useCallback(async (s: SongRow) => {
    if (!s.file_path) return;
    await engine.loadToDeck("A", s.file_path, s.title, s.artist_name || "");
    if (s.gain_db && s.gain_db !== 0) engine.setDeckGain?.("A", s.gain_db);
  }, []);
  const loadB = useCallback(async (s: SongRow) => {
    if (!s.file_path) return;
    await engine.loadToDeck("B", s.file_path, s.title, s.artist_name || "");
    if (s.gain_db && s.gain_db !== 0) engine.setDeckGain?.("B", s.gain_db);
  }, []);
  const [autoSilenceTrim, setAutoSilenceTrim] = useState(() => {
    try { return localStorage.getItem("ether_auto_silence_trim") !== "false"; } catch { return true; }
  });
  const addToQueue = useCallback((s: SongRow) => {
    if (s.file_path) {
      engine.addToQueue([{ filePath: s.file_path, title: s.title, artist: s.artist_name || "", introEnd: s.intro_end ?? undefined, outroStart: s.outro_start ?? undefined }]);
      setQueueLen(engine.getQueue().length);
      // Auto-detect cue points in background if not set
      if (autoSilenceTrim && s.id && !s.intro_end) {
        autoCueSong(s.id, s.file_path).catch(() => {});
      }
    }
  }, [autoSilenceTrim]);

  const canvasEngine = useCanvasEngine();
  const updater = useUpdater();
  const [sessionEditing, setSessionEditing] = useState(false);
  // Canvas mode — only true when user explicitly activates custom layout
  const [useCanvas, setUseCanvas] = useState(false);
  const [visiblePanels, setVisiblePanels] = useState<Record<string, boolean>>({
    queue: true, deckA: true, deckB: true, deckC: true, mic: true,
    clock: false, history: false, cartwall: false,
  });
  const toggleVisible = (key: string) => setVisiblePanels((p: Record<string, boolean>) => ({ ...p, [key]: !p[key] }));
  const { skinId, setSkin } = useSkin();
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [xfadeDuration, setXfadeDuration] = useState(3);


  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [skinPickerPos, setSkinPickerPos] = useState<{ x: number; y: number } | null>(null);

  const handleContextMenu = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("button, input, select, a, [data-deck-slot]")) return;
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const resetLayout = () => { window.location.reload(); };

  const nowPlayingTitle = [deckA, deckB, deckC].find(d => d?.status === "playing")?.title || "";
  const anyDeckPlaying = [deckA, deckB, deckC].some(d => d?.status === "playing");

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
      queue: engine.getQueue().slice(0, 10).map(q => ({ title: q.title, artist: q.artist, duration: q.durationMs || 0 })),
    };

    // Push to Railway backend so /api/now-playing and /dashboard serve it
    fetch("https://ether-backend-production.up.railway.app/api/now-playing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

  if (!splashDone) return <SplashScreen onDone={() => setSplashDone(true)} />;
  if (firstRunChecked && !wizardDone) return <FirstRunWizard onComplete={handleWizardComplete} />;
  if (!currentUser) return <UserLogin onLogin={setCurrentUser} />;

  return (
    <EtherErrorBoundary>
    <div className={"h-screen flex flex-col " + (darkMode ? "dark-theme" : "")} onContextMenu={handleContextMenu} style={{ background: "var(--bg-primary)", color: "var(--text-primary)", fontFamily: "'Inter', system-ui, sans-serif" }}>
      <KeyboardHelp />

      {/* ── Header ── */}
      <header style={{ height: 44, display: "flex", alignItems: "center", padding: "0 16px", background: "var(--bg-secondary)", borderBottom: "1px solid var(--border-primary)", flexShrink: 0, position: "relative" as const, zIndex: 200 }}>

        {/* ── LEFT: Logo + Menu + Session ── */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, zIndex: 1 }}>
          <MenuBar
            active={panel} set={setPanel}
            canvasEngine={canvasEngine}
            darkMode={darkMode} setDarkMode={setDarkMode}
            currentPlan={currentPlan} currentUser={currentUser}
            setCurrentUser={setCurrentUser}
            onSave={() => canvasEngine.saveCurrentLayout(canvasEngine.activeLayoutName)}
            visiblePanels={visiblePanels}
            toggleVisible={toggleVisible}
            setVisiblePanels={setVisiblePanels}
            setUseCanvas={setUseCanvas}
            onReset={() => {
              setVisiblePanels({ queue: true, deckA: true, deckB: true, deckC: true, mic: true, clock: false, history: false, cartwall: false });
              setUseCanvas(false);
              canvasEngine.renameActive("Live Assist");
              setPanel("live");
            }}
          />
          <div style={{ width: 1, height: 16, background: "var(--border-primary)" }} />
          <SessionNameBar
            name={canvasEngine.activeLayoutName}
            onChange={canvasEngine.renameActive}
            onSave={async (name: string) => { await canvasEngine.saveCurrentLayout(name); if (name !== "Live Assist") setUseCanvas(true); }}
            layouts={canvasEngine.layouts}
            onLoadLayout={(id: string) => { canvasEngine.loadLayout(id); setUseCanvas(true); }}
            onDeleteLayout={(id: string) => canvasEngine.deleteLayout(id)}
          />
        </div>


        {/* ── RIGHT: Status controls ── */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto", zIndex: 1 }}>
          {panel !== "live" && (
            <button
              onClick={() => setPanel("live")}
              style={{ height: 28, padding: "0 10px", borderRadius: 7, background: "var(--accent-cyan)", border: "none", color: "#000", fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", cursor: "pointer", display: "flex", alignItems: "center", gap: 5 }}
            >
              <svg width="7" height="9" viewBox="0 0 8 10" fill="currentColor"><polygon points="0,0 8,5 0,10"/></svg>
              Go Live
            </button>
          )}
          <button
            onClick={() => setPanel("programlog")}
            style={{
              height: 28, padding: "0 10px", borderRadius: 7,
              background: panel === "programlog" ? "rgba(167,139,250,0.2)" : "var(--bg-tertiary)",
              border: `1px solid ${panel === "programlog" ? "rgba(167,139,250,0.4)" : "var(--border-primary)"}`,
              color: panel === "programlog" ? "#a78bfa" : "var(--text-secondary)",
              fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", cursor: "pointer",
              display: "flex", alignItems: "center", gap: 5,
            }}
          >
            📋 Schedule
          </button>
          <ClockDisplay />
          <button onClick={() => setDarkMode(!darkMode)} style={{ width: 30, height: 30, borderRadius: 8, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer", fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center" }}>
            {darkMode ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
            )}
          </button>
          <button onClick={openDeskWindow} title="Producer Desk — opens in its own window" style={{ height: 30, padding: "0 12px", borderRadius: 8, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer", fontSize: 11, fontWeight: 600, letterSpacing: "0.02em", display: "flex", alignItems: "center", gap: 6, transition: "all 0.15s" }}
            onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.background="rgba(167,139,250,0.15)";(e.currentTarget as HTMLElement).style.color="#a78bfa";(e.currentTarget as HTMLElement).style.borderColor="rgba(167,139,250,0.3)";}}
            onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.background="var(--bg-tertiary)";(e.currentTarget as HTMLElement).style.color="var(--text-secondary)";(e.currentTarget as HTMLElement).style.borderColor="var(--border-primary)";}}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            Desk
          </button>
          <button onClick={() => openNowPlayingWindow()} style={{ height: 30, padding: "0 12px", borderRadius: 8, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer", fontSize: 11, fontWeight: 600, letterSpacing: "0.02em", display: "flex", alignItems: "center", gap: 6 }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ opacity: 0.6 }}><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
            Now Playing
          </button>
          {currentPlan === "free" && (
            <button onClick={() => setPanel("subscription")} style={{ height: 30, padding: "0 10px", borderRadius: 8, background: "#7c3aed", border: "none", color: "#fff", cursor: "pointer", fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", display: "flex", alignItems: "center", gap: 4 }}>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
              Pro
            </button>
          )}
          <button onClick={() => setCurrentUser(null)} style={{ height: 30, padding: "0 10px", borderRadius: 8, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 10, display: "flex", alignItems: "center", gap: 5 }}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
            {currentUser?.name}
          </button>
          <button
            onClick={() => {
              const anyPlaying = ["A","B","C"].some(d => engine.getDeck(d)?.getState().status === "playing");
              if (onAir) {
                setOnAir(false);
                setOnAirOverride(true);
                onAirOverrideRef.current = true;
                invoke("stream_stop").catch(() => {});
              } else {
                if (anyPlaying) {
                  setOnAir(true);
                  setOnAirOverride(false);
                  onAirOverrideRef.current = false;
                  invoke("stream_start_if_configured").catch(() => {});
                }
              }
            }}
            title={onAir ? "Stop streaming — music continues playing" : "Go on air — starts your stream (music must be playing)"}
            style={{
              height: 30, padding: "0 12px", borderRadius: 8,
              fontSize: 10, fontWeight: 800, letterSpacing: "0.12em",
              display: "flex", alignItems: "center", gap: 5,
              opacity: (!onAir && !anyDeckPlaying) ? 0.45 : 1,
              cursor: "pointer",
              background: onAir ? "#ef4444" : "var(--bg-tertiary)",
              color: onAir ? "#fff" : "var(--text-tertiary)",
              border: onAir ? "none" : "1px solid var(--border-primary)",
              boxShadow: onAir ? "0 0 20px rgba(239,68,68,0.35)" : "none",
              animation: onAir ? "on-air-breathe 2s ease-in-out infinite" : "none",
              transition: "all 0.3s ease",
            }}
            onMouseEnter={e => { if (!onAir) (e.currentTarget as HTMLElement).style.borderColor = "#ef4444"; }}
            onMouseLeave={e => { if (!onAir) (e.currentTarget as HTMLElement).style.borderColor = "var(--border-primary)"; }}
          >
            {onAir ? "ON AIR" : "OFF AIR"}
          </button>
        </div>
      </header>

      {/* ── Main ── */}
      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <main style={{ flex: 1, overflow: "hidden", padding: (panel === "podcast") ? 0 : 16, display: "flex", flexDirection: "column" }}>
          {(panel === "live" || panel === "podcast") && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, position: "relative" as const }}>
              {panel === "podcast" ? (
                <PodcastLayout
                  deckA={deckA} deckB={deckB} deckC={deckC}
                  inputDevice={inputDevice}
                />
              ) : useCanvas ? (
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
                  deckConfigs={enabledDecks}
                  onConfigureDecks={() => setShowDeckConfig(true)}
                  autoSilenceTrim={autoSilenceTrim}
                  setAutoSilenceTrim={v => { setAutoSilenceTrim(v); localStorage.setItem("ether_auto_silence_trim", String(v)); }}
                />
              )}
            </div>
          )}
          {panel !== "live" && panel !== "podcast" && (
            <div style={{ flex: 1, overflowY: "auto" }}>
              {panel === "library" && <LibraryPanel onLoadA={loadA} onLoadB={loadB} onQueue={addToQueue} onEdit={(s) => { setEditSong(s); setPanel("trackedit"); }} />}
              {panel === "clocks" && <Scheduler />}
              {panel === "programlog" && <ProgramLog onClose={() => setPanel("clocks")} />}
              {panel === "studio" && (
                <StudioEditor
                  deckAPath={null} deckATitle={undefined}
                  deckBPath={null} deckBTitle={undefined}
                />
              )}
              {panel === "broadcasteditor" && (
                <BroadcastEditor
                  onBouncePlace={() => setPanel("library")}
                  onOpenCueEditor={(fp) => { setEditSong({ file_path: fp, title: fp.split(/[\/]/).pop()?.replace(/\.[^.]+$/, "") || "Track" }); setPanel("trackedit"); }}
                />
              )}
              {panel === "logs" && <Logs />}
              {panel === "spots" && <Spots />}
              {panel === "streaming" && <StreamManager />}
              {panel === "announce" && <Announcements />}
              {panel === "voicetrack" && <VoiceTracker inputDeviceId={inputDevice || undefined} />}
              {panel === "showprep" && <ShowPrep onGoLive={() => setPanel("live")} />}
              {panel === "settings" && <SettingsPanel />}
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
                <PlanGate requires="station" feature="Multi-Station Console">
                  <StationManager onStationSwitch={(id, name) => setStationName(name)} />
                </PlanGate>
              )}
              {panel === "smartschedule" && (
                <SmartScheduler onClose={() => setPanel("live")} />
              )}
              {panel === "cartwall" && (
                <div style={{ height: "100%", background: "var(--bg-secondary)", borderRadius: 12, border: "1px solid var(--border-primary)", overflow: "hidden" }}>
                  <CartWallPanel onClose={() => setPanel("live")} />
                </div>
              )}
              {panel === "playlist" && (
                <div style={{ height: "100%", background: "var(--bg-secondary)", borderRadius: 12, border: "1px solid var(--border-primary)", overflow: "hidden" }}>
                  <PlaylistPanel onClose={() => setPanel("live")} />
                </div>
              )}
            </div>
          )}
          <DMCANotice />
        </main>
      </div>

      {contextMenu && (
        <AppContextMenu
          x={contextMenu.x} y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onChangeSkin={() => { setSkinPickerPos(contextMenu); setContextMenu(null); }}
          onResetLayout={resetLayout}
        />
      )}
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
            borderRadius: 20, padding: "28px 32px", width: 560, maxHeight: "80vh", overflowY: "auto",
            boxShadow: "0 32px 80px rgba(0,0,0,0.6)",
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
              <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 18, fontWeight: 800, color: "var(--text-primary)", letterSpacing: "-0.02em" }}>Keyboard Shortcuts</div>
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
                { key: "Right-click", desc: "Theme Studio & Reset Layout" },
              ]},
            ].map(({ group, items }) => (
              <div key={group} style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.16em", color: "var(--text-tertiary)", textTransform: "uppercase" as const, marginBottom: 10 }}>{group}</div>
                <div style={{ display: "flex", flexDirection: "column" as const, gap: 2 }}>
                  {items.map(({ key, desc }) => (
                    <div key={key} style={{ display: "flex", alignItems: "center", gap: 12, padding: "7px 10px", borderRadius: 8, background: "var(--bg-tertiary)" }}>
                      <kbd style={{
                        fontFamily: "'DM Mono', monospace", fontSize: 11, fontWeight: 700,
                        background: "var(--bg-primary)", color: "var(--accent-cyan)",
                        border: "1px solid var(--border-secondary)", borderRadius: 6,
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
            <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--border-primary)", fontSize: 10, color: "var(--text-tertiary)", textAlign: "center" as const }}>
              Press <kbd style={{ fontFamily: "'DM Mono', monospace", background: "var(--bg-tertiary)", padding: "1px 5px", borderRadius: 4, border: "1px solid var(--border-primary)" }}>Esc</kbd> or click outside to close
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
      {/* ── Footer ── */}
      <footer style={{ height: 26, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 20px", background: "var(--bg-secondary)", borderTop: "1px solid var(--border-primary)", fontSize: 10, color: "var(--text-tertiary)", flexShrink: 0, letterSpacing: "0.02em", fontFamily: "'DM Mono', monospace" }}>
        <span style={{ color: onAir ? "var(--accent-green)" : "var(--text-tertiary)" }}>
          {onAir ? "● On Air" : "○ Off Air"}
        </span>
        <div style={{ display: "flex", gap: 16 }}>
          <HealthStatusDot onClick={() => setPanel("health")} />
          <span style={{ color: "var(--border-secondary)" }}>·</span>
          {autoAdv && (
            <button onClick={() => toggleAuto()} title="Auto-advance is ON — click to turn off"
              style={{ background: "none", border: "none", color: "var(--accent-cyan)", cursor: "pointer", fontSize: 10, fontFamily: "'DM Mono', monospace", letterSpacing: "0.06em", padding: 0 }}>
              AUTO
            </button>
          )}
          {shuffle && <span style={{ color: "var(--accent-amber)" }}>SHUFFLE</span>}
          {continuous && <span>24/7</span>}
          <span>Queue: {queueLen}</span>
          <span style={{ color: "var(--border-secondary)" }}>Space · B · X · Esc</span>
        </div>
      </footer>
    </div>
      {showProducerDesk && (
        <ProducerDesk
          onClose={() => setShowProducerDesk(false)}
          episodeTitle={nowPlayingTitle || undefined}
          onSendToQueue={(track) => {
            engine.addToQueue([{
              filePath: track.filePath || "",
              title: track.title,
              artist: track.artist,
            }]);
            setQueueLen(engine.getQueue().length);
          }}
        />
      )}
      {showDeckConfig && (
        <DeckConfigurator
          onClose={() => setShowDeckConfig(false)}
          onApply={(configs: DeckConfig[]) => saveDeckConfigs(configs)}
        />
      )}
    </EtherErrorBoundary>
  );
}

// ── Nav ──────────────────────────────────────────────────────

function MenuBar({ active, set, canvasEngine, darkMode, setDarkMode, currentPlan, currentUser, setCurrentUser, onSave, visiblePanels, toggleVisible, setVisiblePanels, onReset, setUseCanvas }: {
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
    radio:   { library: "Song Library",    spots: "Spots & Promos",   clocks: "Format Clocks",     logs: "Play Log",      voicetrack: "Voice Tracker", live: "Live Assist",  tools: "Tools" },
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
      borderRadius: 10, padding: "4px",
      minWidth: 220,
      boxShadow: "0 8px 32px rgba(0,0,0,0.25), 0 2px 8px rgba(0,0,0,0.15)",
      fontFamily: "'Inter', sans-serif",
    }}>{children}</div>
  );

  const Item = ({ label, shortcut, onClick, checked, separator, disabled }: {
    label?: string; shortcut?: string; onClick?: () => void;
    checked?: boolean; separator?: boolean; disabled?: boolean;
  }) => {
    if (separator) return <div style={{ height: 1, background: "var(--border-primary)", margin: "3px 6px" }} />;
    return (
      <button
        className={`menu-item${disabled ? " disabled" : ""}`}
        disabled={disabled}
        onMouseDown={e => { e.stopPropagation(); if (!disabled && onClick) { onClick(); close(); } }}
      >
        <span style={{ width: 14, fontSize: 10, color: "var(--accent-cyan)", flexShrink: 0 }}>
          {checked === true ? "✓" : checked === false ? "" : ""}
        </span>
        <span style={{ flex: 1 }}>{label}</span>
        {shortcut && <span style={{ fontSize: 10, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace", marginLeft: 12 }}>{shortcut}</span>}
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
        <Item label="Export Episode..." onClick={() => set("podcast")} />
        <Item separator />
        <Item label="Preferences" onClick={() => set("settings")} />
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
        <Item label="Configure Decks..." onClick={() => { set("live"); setShowDeckConfig(true); }} />
        <Item label="Reset to Default" onClick={() => onReset()} />
      </Menu>
    ),
    library: (
      <Menu>
        <Item label={L.library}    onClick={() => { set("library"); }} />
        <Item label={L.spots}      onClick={() => { set("spots"); }} />
        <Item label={L.voicetrack} onClick={() => { set("voicetrack"); }} />
        <Item label={L.spots}    onClick={() => { set("spots"); }} />
        <Item label="Cart Wall"  onClick={() => { set("live"); togglePanel("cartwall"); }} />
        <Item separator />
        <Item label="Import from Folder..." onClick={() => set("library")} />
        <Item label="Cue Editor"          onClick={() => set("trackedit")} />
      </Menu>
    ),
    schedule: (
      <Menu>
        <Item label={L.clocks}         onClick={() => set("clocks")} />
        <Item label="Shows & Dayparts" onClick={() => set("clocks")} />
        <Item label="Music Categories" onClick={() => set("clocks")} />
        <Item label="Program Log"      onClick={() => set("programlog")} />
        <Item separator />
        <Item label={L.logs} onClick={() => set("logs")} />
      </Menu>
    ),
    tools: (
      <Menu>
        <Item label={L.voicetrack}      onClick={() => set("voicetrack")} />
        <Item label="Studio Editor"     onClick={() => set("studio")} />
        <Item label="Production Editor" onClick={() => set("broadcasteditor")} />
        <Item label="Cue Editor"        onClick={() => set("trackedit")} />
        <Item label="Phone Desk"        onClick={() => set("phonedesk")} />
        <Item separator />
        <Item label="Show Prep"         onClick={() => set("showprep")} />
        <Item label="Announcements"     onClick={() => set("announce")} />
        <Item label="Stream Manager"    onClick={() => set("streaming")} />
        <Item label="Smart Scheduler"   onClick={() => set("smartschedule")} />
        <Item separator />
        <Item label="AI Show Notes"     onClick={() => { set("live"); togglePanel("shownotes"); }} />
        <Item label="Export Episode"    onClick={() => set("podcast")} />
        <Item separator />
        <Item label="Podcast Studio"    onClick={() => set("podcast")} />
        <Item label="Cart Wall"         onClick={() => set("cartwall")} />
        <Item label="Playlist Player"   onClick={() => set("playlist")} />
        <Item label="Auto-Cue Library..." onClick={() => set("autocue")} />
        <Item label="Listener Analytics" onClick={() => set("analytics")} />
        <Item label="Cloud Log Backup"   onClick={() => set("cloudbackup")} />
        <Item label="Audio Routing"      onClick={() => set("multioutput")} />
        <Item label="Station Manager"    onClick={() => set("stationmanager")} />
        <Item separator />
        <Item label="Remote Dashboard ↗" onClick={async () => {
          try {
            const { invoke: inv } = await import("@tauri-apps/api/core");
            await inv("open_url", { url: "https://ether-backend-production.up.railway.app/dashboard" });
          } catch { window.open("https://ether-backend-production.up.railway.app/dashboard", "_blank"); }
        }} />
        <Item label="Emergency Override ↗" onClick={async () => {
          try {
            const { invoke: inv } = await import("@tauri-apps/api/core");
            await inv("open_url", { url: "https://ether-backend-production.up.railway.app/emergency" });
          } catch { window.open("https://ether-backend-production.up.railway.app/emergency", "_blank"); }
        }} />
        <Item label="System Health"     onClick={() => set("health")} />
        <Item separator />
        <Item label="Auto-Duck Settings" disabled />
      </Menu>
    ),
    help: (
      <Menu>
        <Item label="Keyboard Shortcuts" shortcut="⇧?" onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "Slash", shiftKey: true }))} />
        <Item label="Documentation" onClick={() => {}} />
        <Item label="Contact Support" onClick={() => {}} />
        <Item separator />
        <Item label="Check for Updates" onClick={() => updater.checkForUpdate()} />
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
        <div key={id} style={{ position: "relative" as const }}>
          <MenuBtn id={id} label={id.charAt(0).toUpperCase() + id.slice(1)} />
          {openMenu === id && menus[id]}
        </div>
      ))}
    </div>
  );
}

// ── Live Panel ───────────────────────────────────────────────
// ── Live Panel ───────────────────────────────────────────────

// ── Drag handle icon ────────────────────────────────────────
function DragHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div
      onMouseDown={onMouseDown}
      title="Drag to reorder panels"
      style={{
        cursor: "grab", padding: "4px 6px", borderRadius: 6, flexShrink: 0,
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

// ── Podcast Layout ───────────────────────────────────────────
// Clean layout: Vertical mixer | Studio panel
// No music queue — this is a recording environment

function PodcastLayout({ deckA, deckB, deckC, inputDevice }: {
  deckA: any; deckB: any; deckC: any; inputDevice: string;
}) {
  const [hostDevice, setHostDevice] = React.useState<string>("");
  const [guest1Device, setGuest1Device] = React.useState<string>("");
  const [guest2Device, setGuest2Device] = React.useState<string>("");
  const [audioDevices, setAudioDevices] = React.useState<MediaDeviceInfo[]>([]);

  React.useEffect(() => {
    const load = () => {
      navigator.mediaDevices.enumerateDevices().then(devs => {
        setAudioDevices(devs.filter(d => d.kind === "audioinput"));
      }).catch(() => {});
    };
    navigator.mediaDevices.getUserMedia({ audio: true }).then(s => {
      s.getTracks().forEach(t => t.stop());
      load();
    }).catch(load);
    navigator.mediaDevices.addEventListener?.("devicechange", load);
    return () => navigator.mediaDevices.removeEventListener?.("devicechange", load);
  }, []);

  const channels = [
    { label: "Host",    color: "#ef4444", deck: null,  deckSlot: undefined, isMic: true,  deviceId: hostDevice,   setDeviceId: setHostDevice,   guestStatus: undefined },
    { label: "Guest 1", color: "#38bdf8", deck: deckB, deckSlot: "B",       isMic: false, deviceId: guest1Device, setDeviceId: setGuest1Device, guestStatus: "waiting" as const },
    { label: "Guest 2", color: "#a78bfa", deck: deckC, deckSlot: "C",       isMic: false, deviceId: guest2Device, setDeviceId: setGuest2Device, guestStatus: "waiting" as const },
    { label: "Music",   color: "#34d399", deck: deckA, deckSlot: "A",       isMic: false, deviceId: "",           setDeviceId: () => {},         guestStatus: undefined },
  ];

  return (
    <div style={{ display: "flex", height: "100%", background: "var(--bg-primary)" }}>

      {/* ── MIXER — vertical stacked channels ── */}
      <div style={{
        width: 200, flexShrink: 0,
        borderRight: "1px solid var(--border-primary)",
        background: "var(--bg-secondary)",
        display: "flex", flexDirection: "column" as const,
        overflow: "hidden",
      }}>
        {/* Mixer header */}
        <div style={{ padding: "10px 14px 8px", borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}>
          <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.16em", color: "var(--text-tertiary)", textTransform: "uppercase" as const }}>Mixer</div>
        </div>
        {/* Channel strips — stacked */}
        <div style={{ flex: 1, overflowY: "auto" as const }}>
          {channels.map((ch, i) => (
            <ChannelStrip key={ch.label} {...ch} audioDevices={audioDevices} isLast={i === channels.length - 1} />
          ))}
        </div>
      </div>

      {/* ── STUDIO PANEL ── */}
      <div style={{ flex: 1, minWidth: 0, overflow: "hidden", display: "flex", flexDirection: "column" as const }}>
        <PodcastStudio />
      </div>
    </div>
  );
}

// ── Channel Strip — horizontal card layout ─────────────────────
function ChannelStrip({ label, color, deck, deckSlot, isMic, deviceId, setDeviceId, audioDevices, guestStatus, isLast, vertical }: {
  label: string; color: string; deck: any; deckSlot?: string; isMic: boolean;
  deviceId: string; setDeviceId: (id: string) => void;
  audioDevices: MediaDeviceInfo[]; guestStatus?: "waiting"|"connecting"|"connected"|"dropped"; isLast: boolean;
  vertical?: boolean;
}) {
  const [level, setLevel] = React.useState(0);
  const [levelR, setLevelR] = React.useState(0);
  const [peakHold, setPeakHold] = React.useState(0);
  const [peakHoldR, setPeakHoldR] = React.useState(0);
  const [muted, setMuted] = React.useState(false);
  const [fader, setFader] = React.useState(100);
  const animRef = React.useRef<number>(0);
  const micAnimRef = React.useRef<number>(0);
  const streamRef = React.useRef<MediaStream | null>(null);
  const [showPicker, setShowPicker] = React.useState(false);
  const [pickerRect, setPickerRect] = React.useState<DOMRect | null>(null);
  const pickerBtnRef = React.useRef<HTMLButtonElement>(null);

  // Mic level via Web Audio API
  React.useEffect(() => {
    if (!isMic) return;
    let cancelled = false;
    const audioConstraint: any = deviceId ? { deviceId: { exact: deviceId } } : true;
    navigator.mediaDevices.getUserMedia({ audio: audioConstraint, video: false }).then(stream => {
      if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
      streamRef.current = stream;
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((s, v) => s + v, 0) / data.length / 255;
        const v = Math.min(1, avg * 3);
        setLevel(v);
        setPeakHold(p => Math.max(p * 0.992, v));
        micAnimRef.current = requestAnimationFrame(tick);
      };
      micAnimRef.current = requestAnimationFrame(tick);
    }).catch(() => {
      const tick = () => {
        const v = Math.random() * 0.06;
        setLevel(v);
        micAnimRef.current = requestAnimationFrame(tick);
      };
      micAnimRef.current = requestAnimationFrame(tick);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(micAnimRef.current);
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, [isMic, deviceId]);

  // Deck level animation — smoothed, not pure random noise
  React.useEffect(() => {
    if (isMic) return;
    if (deck?.status === "playing") {
      let smoothedL = 0, smoothedR = 0;
      let targetL = 0.4, targetR = 0.38;
      let targetTimer = 0;
      const tick = () => {
        targetTimer++;
        if (targetTimer % 12 === 0) {
          targetL = 0.25 + Math.random() * 0.6;
          targetR = 0.25 + Math.random() * 0.6;
        }
        smoothedL += (targetL - smoothedL) * 0.15;
        smoothedR += (targetR - smoothedR) * 0.15;
        const vL = Math.min(1, Math.max(0, smoothedL + Math.sin(Date.now() / 80) * 0.04));
        const vR = Math.min(1, Math.max(0, smoothedR + Math.sin(Date.now() / 95 + 1) * 0.04));
        setLevel(vL);
        setLevelR(vR);
        setPeakHold(p => Math.max(p * 0.994, vL));
        setPeakHoldR(p => Math.max(p * 0.994, vR));
        animRef.current = requestAnimationFrame(tick);
      };
      animRef.current = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(animRef.current);
    } else {
      // Animate decay to zero
      let decaying = true;
      const decay = () => {
        setLevel(l => { const n = l * 0.82; if (n < 0.002) return 0; decaying && requestAnimationFrame(decay); return n; });
        setLevelR(l => l * 0.82);
        setPeakHold(p => p * 0.93);
        setPeakHoldR(p => p * 0.93);
      };
      requestAnimationFrame(decay);
      return () => { decaying = false; };
    }
  }, [deck?.status, isMic]);

  const openPicker = () => {
    if (pickerBtnRef.current) setPickerRect(pickerBtnRef.current.getBoundingClientRect());
    setShowPicker(p => !p);
  };

  const isActive = isMic ? level > 0.05 : deck?.status === "playing";
  const displayName = isMic ? "Host" : (deck?.title ? deck.title.replace(/\s*[-–]\s*([\d]{4}\s*)?remaster.*/gi, '').trim() : "No source");
  const displaySub = isMic
    ? (audioDevices.find(d => d.deviceId === deviceId)?.label || "Default Microphone")
    : (deck?.artist || (guestStatus === "waiting" ? "Waiting for guest..." : "No guest"));
  const dbVal = level > 0.001 ? Math.round(20 * Math.log10(level)) : null;
  const NUM_SEGS = 20;

  const statusColor = guestStatus === "connected" ? "var(--accent-green)"
    : guestStatus === "connecting" ? "var(--accent-amber)"
    : guestStatus === "dropped" ? "var(--accent-red)"
    : isActive ? color : "var(--text-tertiary)";

  // ── Vertical channel strip mode (compact deck layout) ──────────
  if (vertical) {
    const remaining = deck?.remaining ?? 0;
    const duration  = deck?.duration ?? 0;
    const timeStr   = remaining > 0
      ? `-${Math.floor(remaining/60)}:${String(Math.floor(remaining%60)).padStart(2,'0')}`
      : '0:00';
    const pct = duration > 0 ? Math.max(0, Math.min(1, (duration - remaining) / duration)) : 0;

    const VUBar = ({ lv, pk, mono }: { lv: number; pk: number; mono?: boolean }) => (
      <div style={{ flex: mono ? 2 : 1, position: 'relative', borderRadius: 3, overflow: 'hidden', background: 'var(--bg-tertiary)' }}>
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0,
          height: `${Math.min(100, lv * 100)}%`,
          background: lv > 0.85 ? '#ef4444' : lv > 0.65 ? '#fbbf24' : color,
          borderRadius: 3,
          transition: 'height 0.06s ease-out',
        }} />
        {pk > 0.05 && (
          <div style={{
            position: 'absolute', left: 0, right: 0,
            bottom: `${Math.min(98, pk * 100)}%`,
            height: 2,
            background: pk > 0.85 ? '#ef4444' : pk > 0.65 ? '#fbbf24' : color,
          }} />
        )}
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} style={{
            position: 'absolute', left: 0, right: 0,
            bottom: `${(i+1) * 10}%`, height: 1,
            background: 'var(--bg-secondary)', opacity: 0.5,
          }} />
        ))}
      </div>
    );

    return (
      <div style={{
        width: '100%', height: '100%',
        display: 'flex', flexDirection: 'column',
        background: isActive ? `${color}12` : 'var(--bg-secondary)',
        border: `1px solid ${isActive ? color+'80' : 'var(--border-primary)'}`,
        boxShadow: isActive ? `0 0 0 1px ${color}30, inset 0 0 12px ${color}08` : 'none',
        borderRadius: 10, overflow: 'hidden',
        transition: 'border-color 0.2s, background 0.2s',
      }}>

        {/* Label + ON AIR badge */}
        <div style={{ padding: '4px 6px 3px', flexShrink: 0, borderBottom: '1px solid var(--border-primary)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 8, fontWeight: 800, letterSpacing: '0.1em', color: isActive ? color : 'var(--text-tertiary)', textTransform: 'uppercase', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</div>
          {isActive && <div style={{ fontSize: 7, fontWeight: 800, color: '#fff', background: color, padding: '1px 5px', borderRadius: 3, flexShrink: 0, animation: 'mic-blink 2s ease-in-out infinite', letterSpacing: '0.05em' }}>ON AIR</div>}
        </div>

        {/* Music: track + artist + time. Mic: no info needed */}
        {!isMic && (
          <div style={{ padding: '3px 6px', flexShrink: 0 }}>
            <div style={{ fontSize: 8, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName}</div>
            {deck?.artist && <div style={{ fontSize: 7, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{deck.artist}</div>}
          </div>
        )}

        {/* VU Meter — single bar for all channels, monitoring only */}
        <div style={{ flex: 1, padding: '4px 6px', minHeight: 0, display: 'flex', alignItems: 'stretch' }}>
          <VUBar lv={isMic ? (muted ? 0 : level) : level} pk={isMic ? (muted ? 0 : peakHold) : peakHold} mono />
        </div>

        {/* Time remaining for music */}
        {!isMic && deck && (
          <div style={{ textAlign: 'center', fontSize: 9, fontFamily: "'DM Mono',monospace", fontWeight: 700, color: remaining < 10 && remaining > 0 ? '#ef4444' : 'var(--text-tertiary)', flexShrink: 0, padding: '1px 0' }}>
            {isActive ? timeStr : '—'}
          </div>
        )}

        {/* Progress bar — music only */}
        {!isMic && (
          <div style={{ height: 2, background: 'var(--bg-tertiary)', flexShrink: 0, margin: '0 6px' }}>
            <div style={{ height: '100%', width: `${pct*100}%`, background: color, borderRadius: 1, transition: 'width 0.5s linear' }} />
          </div>
        )}

        {/* dB */}
        <div style={{ textAlign: 'center', fontSize: 8, fontFamily: "'DM Mono',monospace", color: dbVal !== null && dbVal > -3 ? '#ef4444' : 'var(--text-tertiary)', flexShrink: 0, padding: '1px 0' }}>
          {dbVal !== null ? `${dbVal}dB` : '—'}
        </div>

        {/* Fader */}
        <div style={{ padding: '1px 6px 3px', flexShrink: 0 }}>
          <input type="range" min={0} max={100} value={fader}
            onChange={e => { const v = Number(e.target.value); setFader(v); deckSlot && engine.getDeck(deckSlot)?.setVolume(v/100); }}
            style={{ width: '100%', accentColor: color, cursor: 'pointer', height: 10 }}
          />
        </div>

        {/* Controls */}
        <div style={{ padding: '2px 4px 5px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          {!isMic ? (
            <div style={{ display: 'flex', gap: 3 }}>
              <button
                onClick={() => deck?.status === 'playing' ? engine.getDeck(deckSlot!)?.pause() : engine.getDeck(deckSlot!)?.play()}
                style={{ flex: 1, padding: '5px 0', borderRadius: 5, border: 'none', background: deck?.status === 'playing' ? color : 'var(--bg-tertiary)', color: deck?.status === 'playing' ? '#000' : 'var(--text-secondary)', fontSize: 9, fontWeight: 800, cursor: 'pointer', transition: 'all 0.15s' }}>
                {deck?.status === 'playing' ? '❚❚' : '▶'}
              </button>
              <button onClick={() => engine.getDeck(deckSlot!)?.stop()}
                style={{ width: 24, padding: '5px 0', borderRadius: 5, border: 'none', background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)', fontSize: 9, cursor: 'pointer' }}>■</button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 3 }}>
              <button onClick={() => setMuted(m => !m)} style={{
                flex: 1, padding: '5px 0', borderRadius: 5, border: 'none',
                background: muted ? '#ef444430' : 'var(--bg-tertiary)',
                color: muted ? '#ef4444' : 'var(--text-tertiary)',
                fontSize: 8, fontWeight: 800, letterSpacing: '0.05em', cursor: 'pointer',
                outline: muted ? '1px solid #ef444450' : 'none',
              }}>
                {muted ? 'MUTED' : 'MUTE'}
              </button>
              <div style={{
                width: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
                borderRadius: 5, background: isActive && !muted ? `${color}20` : 'var(--bg-tertiary)',
              }}>
                <div style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: isActive && !muted ? color : 'var(--text-tertiary)',
                  boxShadow: isActive && !muted ? `0 0 6px ${color}` : 'none',
                  animation: isActive && !muted ? 'mic-blink 1.5s ease-in-out infinite' : 'none',
                }} />
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{
      borderBottom: isLast ? "none" : "1px solid var(--border-primary)",
      padding: "12px 14px",
      background: isActive ? `${color}06` : "transparent",
      transition: "background 0.3s",
      position: "relative" as const,
    }}>
      {/* Active left border */}
      <div style={{
        position: "absolute" as const, left: 0, top: 0, bottom: 0, width: 3,
        background: isActive ? color : "transparent",
        boxShadow: isActive ? `2px 0 8px ${color}60` : "none",
        transition: "all 0.3s",
      }} />

      {/* Header row: label + status + dB */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: isActive ? color : "var(--text-secondary)", letterSpacing: "0.06em", textTransform: "uppercase" as const }}>{label}</span>
          {/* Guest status dot */}
          {guestStatus && (
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: statusColor, boxShadow: guestStatus === "connected" ? `0 0 5px ${statusColor}` : "none", animation: guestStatus === "connecting" ? "mic-blink 0.8s ease-in-out infinite" : "none" }} />
          )}
          {isActive && !guestStatus && (
            <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 7px", borderRadius: 10, background: `${color}15`, border: `1px solid ${color}25` }}>
              <div style={{ width: 5, height: 5, borderRadius: "50%", background: color, animation: "mic-blink 1.5s ease-in-out infinite" }} />
              <span style={{ fontSize: 8, fontWeight: 800, color, letterSpacing: "0.08em" }}>LIVE</span>
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11, fontFamily: "'DM Mono', monospace", fontWeight: 500, color: dbVal !== null && dbVal > -3 ? "#ef4444" : "var(--text-tertiary)", minWidth: 36, textAlign: "right" as const }}>
            {dbVal !== null ? `${dbVal}dB` : "—"}
          </span>
          <button onClick={() => setMuted(m => !m)} style={{ padding: "2px 8px", borderRadius: 5, background: muted ? `${color}20` : "var(--bg-tertiary)", border: `1px solid ${muted ? color + "40" : "var(--border-primary)"}`, color: muted ? color : "var(--text-tertiary)", fontSize: 9, fontWeight: 800, cursor: "pointer", letterSpacing: "0.06em" }}>
            {muted ? "MUTED" : "MUTE"}
          </button>
        </div>
      </div>

      {/* Track info */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, marginBottom: 2 }}>{displayName}</div>
        <button ref={pickerBtnRef} onClick={openPicker} style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", padding: 0, cursor: "pointer", width: "100%" }}>
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0, opacity: 0.7 }}>
            <path d="M12 2a3 3 0 0 0-3 3v4a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
            <path d="M19 10c0 3.866-3.134 7-7 7s-7-3.134-7-7"/>
          </svg>
          <span style={{ fontSize: 10, color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, flex: 1, textAlign: "left" as const }}>{displaySub}</span>
          {(isMic || audioDevices.length > 0) && <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2" strokeLinecap="round"><polyline points="6 9 12 15 18 9"/></svg>}
        </button>
      </div>

      {/* Horizontal VU meter */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: "flex", gap: 1.5, height: 14, alignItems: "flex-end" }}>
          {Array.from({ length: NUM_SEGS }).map((_, i) => {
            const threshold = i / NUM_SEGS;
            const lit = !muted && level > threshold;
            const isPeak = peakHold > 0.05 && Math.abs(peakHold - threshold) < 1.5 / NUM_SEGS;
            const segColor = i >= NUM_SEGS - 2 ? "#ef4444" : i >= NUM_SEGS - 5 ? "#fbbf24" : color;
            const segHeight = i < 8 ? 8 : i < 14 ? 10 : 14;
            return (
              <div key={i} style={{
                flex: 1,
                height: segHeight,
                borderRadius: 2,
                background: lit ? segColor : isPeak ? segColor + "90" : "var(--bg-tertiary)",
                opacity: lit ? 1 : isPeak ? 0.8 : 0.25,
                boxShadow: lit && i >= NUM_SEGS - 2 ? `0 0 4px ${segColor}` : "none",
                transition: "opacity 0.04s, background 0.04s",
                alignSelf: "flex-end",
              }} />
            );
          })}
        </div>
      </div>

      {/* Fader */}
      <input
        type="range" min={0} max={100} value={fader}
        onChange={e => {
          const v = Number(e.target.value);
          setFader(v);
          deckSlot && engine.getDeck(deckSlot)?.setVolume(v / 100);
        }}
        style={{ width: "100%", accentColor: color, cursor: "pointer", height: 3, display: "block" }}
      />

      {/* Device picker dropdown */}
      {showPicker && audioDevices.length > 0 && pickerRect && (
        <>
          <div onClick={() => setShowPicker(false)} style={{ position: "fixed" as const, inset: 0, zIndex: 9000 }} />
          <div style={{
            position: "fixed" as const,
            bottom: window.innerHeight - pickerRect.top + 6,
            left: Math.max(8, pickerRect.left - 10),
            zIndex: 9001,
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-secondary)",
            borderRadius: 12, padding: "8px 6px",
            boxShadow: "0 -4px 32px rgba(0,0,0,0.4)",
            minWidth: 260, maxWidth: 340,
          }}>
            <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.14em", color: "var(--text-tertiary)", textTransform: "uppercase" as const, padding: "2px 10px 8px" }}>
              Audio Input — {label}
            </div>
            {audioDevices.map((dev, i) => {
              const name = dev.label || `Microphone ${i + 1}`;
              const active = dev.deviceId === deviceId || (!deviceId && dev.deviceId === "default");
              return (
                <button key={dev.deviceId} onClick={() => { setDeviceId(dev.deviceId); setShowPicker(false); }} style={{
                  display: "flex", alignItems: "center", gap: 8,
                  width: "100%", textAlign: "left" as const,
                  padding: "8px 10px", borderRadius: 8, border: "none", cursor: "pointer",
                  background: active ? `${color}18` : "none",
                  color: active ? color : "var(--text-primary)",
                  fontSize: 12, fontWeight: active ? 700 : 400,
                  transition: "background 0.1s",
                }}
                  onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)"; }}
                  onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.background = "none"; }}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0, opacity: 0.5 }}>
                    <path d="M12 2a3 3 0 0 0-3 3v4a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
                    <path d="M19 10c0 3.866-3.134 7-7 7s-7-3.134-7-7"/>
                  </svg>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{name}</span>
                  {active && <span style={{ flexShrink: 0 }}>✓</span>}
                </button>
              );
            })}
          </div>
        </>
      )}
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
          <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.16em", color: "#fbbf24", textTransform: "uppercase" as const, marginBottom: 3 }}>Cart Wall</div>
          <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: "-0.03em", color: "var(--text-primary)", fontFamily: "'Syne', sans-serif" }}>Sound Effects & Stingers</div>
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>{loaded}/{carts.length} slots loaded · Press key or click to fire · Drop audio to assign · Double-click to rename</div>
        </div>
        <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: 8, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
      </div>

      {/* Grid */}
      <div style={{ flex: 1, padding: 16, overflowY: "auto" as const, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: 10, alignContent: "start" }}>
        {carts.map(cart => (
          <div
            key={cart.key}
            onClick={() => fire(cart.key)}
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
              borderRadius: 12,
              background: cart.playing ? cart.color
                : dragOver === cart.key ? `${cart.color}20`
                : cart.filePath ? `${cart.color}12` : "var(--bg-tertiary)",
              border: `1px solid ${cart.playing ? cart.color : dragOver === cart.key ? cart.color : cart.filePath ? cart.color + "40" : "var(--border-primary)"}`,
              cursor: cart.filePath ? "pointer" : "default",
              transition: "all 0.12s",
              boxShadow: cart.playing ? `0 0 20px ${cart.color}60` : "none",
              position: "relative" as const, minHeight: 80,
              userSelect: "none" as const,
            }}
          >
            {/* Hotkey */}
            <div style={{
              position: "absolute" as const, top: 8, right: 9,
              fontSize: 10, fontWeight: 900, fontFamily: "'DM Mono', monospace",
              color: cart.playing ? "rgba(0,0,0,0.6)" : cart.filePath ? cart.color : "var(--text-tertiary)",
              letterSpacing: "0.04em",
            }}>{cart.key}</div>

            {/* Playing waveform bars */}
            {cart.playing && (
              <div style={{ display: "flex", gap: 2, alignItems: "flex-end", height: 16, marginBottom: 6 }}>
                {[0.5,1,0.7,0.9,0.6,1,0.8].map((h,i) => (
                  <div key={i} style={{ flex: 1, height: `${h*100}%`, background: "rgba(0,0,0,0.45)", borderRadius: 1, animation: `on-air-breathe ${0.4 + i*0.1}s ease-in-out infinite` }} />
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
              <div style={{ marginTop: 6, fontSize: 9, color: "var(--text-tertiary)" }}>Drop audio here</div>
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
    query<any>("SELECT id, title, artist, file_path as filePath, duration_ms as durationMs FROM songs ORDER BY artist, title LIMIT 500")
      .then(setLibrary).catch(() => {});
  }, []);

  const filtered = search ? library.filter(s => `${s.title} ${s.artist}`.toLowerCase().includes(search.toLowerCase())) : library;

  const addTrack = (t: any) => setTracks(p => [...p, { ...t, pid: Date.now() + Math.random() }]);
  const removeTrack = (pid: number) => setTracks(p => p.filter(t => t.pid !== pid));

  const playIdx = async (idx: number) => {
    const t = tracks[idx]; if (!t) return;
    try {
      await engine.loadToDeck(deckSlot, t.filePath, t.title, t.artist);
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
            <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.16em", color: "#34d399", textTransform: "uppercase" as const, marginBottom: 3 }}>Playlist Player</div>
            <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: "-0.03em", color: "var(--text-primary)", fontFamily: "'Syne', sans-serif" }}>
              {tracks.length > 0 ? `${tracks.length} tracks · ${total} min` : "Build your playlist"}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {/* Deck selector */}
            <div style={{ display: "flex", gap: 3 }}>
              {["A","B","C"].map(s => (
                <button key={s} onClick={() => setDeckSlot(s)} style={{ width: 28, height: 28, borderRadius: 7, border: "none", background: deckSlot === s ? "var(--accent-green)" : "var(--bg-tertiary)", color: deckSlot === s ? "#000" : "var(--text-secondary)", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>{s}</button>
              ))}
            </div>
            <button onClick={onClose} style={{ width: 32, height: 32, borderRadius: 8, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
          </div>
        </div>

        {/* Transport controls */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={() => playIdx(Math.max(0, (currentIdx ?? 1) - 1))} style={{ width: 32, height: 32, borderRadius: 8, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer", fontSize: 14 }}>⏮</button>
          <button
            onClick={() => { if (playing) { engine.getDeck(deckSlot)?.pause(); setPlaying(false); } else if (currentIdx !== null) { engine.getDeck(deckSlot)?.play(); setPlaying(true); } else if (tracks.length > 0) playIdx(0); }}
            style={{ width: 44, height: 32, borderRadius: 8, background: "#34d399", border: "none", color: "#000", cursor: "pointer", fontSize: 16, fontWeight: 700 }}
          >{playing ? "⏸" : "▶"}</button>
          <button onClick={next} style={{ width: 32, height: 32, borderRadius: 8, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer", fontSize: 14 }}>⏭</button>
          <button onClick={() => setShuffle(p => !p)} style={{ height: 32, padding: "0 12px", borderRadius: 8, background: shuffle ? "rgba(52,211,153,0.1)" : "var(--bg-tertiary)", border: `1px solid ${shuffle ? "rgba(52,211,153,0.3)" : "var(--border-primary)"}`, color: shuffle ? "#34d399" : "var(--text-tertiary)", cursor: "pointer", fontSize: 11, fontWeight: 700 }}>SHUFFLE</button>
          <button onClick={() => setRepeat(p => !p)} style={{ height: 32, padding: "0 12px", borderRadius: 8, background: repeat ? "rgba(52,211,153,0.1)" : "var(--bg-tertiary)", border: `1px solid ${repeat ? "rgba(52,211,153,0.3)" : "var(--border-primary)"}`, color: repeat ? "#34d399" : "var(--text-tertiary)", cursor: "pointer", fontSize: 11, fontWeight: 700 }}>REPEAT</button>
          <button onClick={() => setTracks([])} style={{ height: 32, padding: "0 12px", borderRadius: 8, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 11, marginLeft: "auto" }}>Clear All</button>
          <button onClick={() => setShowLib(p => !p)} style={{ height: 32, padding: "0 14px", borderRadius: 8, background: showLib ? "var(--accent-cyan)" : "var(--bg-tertiary)", border: "none", color: showLib ? "#000" : "var(--text-secondary)", cursor: "pointer", fontSize: 11, fontWeight: 700 }}>
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
              <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace", width: 22, textAlign: "right" as const, flexShrink: 0 }}>
                {i === currentIdx && playing ? "▶" : i + 1}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: i === currentIdx ? 700 : 500, color: i === currentIdx ? "#34d399" : "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{t.title}</div>
                <div style={{ fontSize: 11, color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{t.artist}</div>
              </div>
              <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace", flexShrink: 0 }}>{fmtDur(t.durationMs || 0)}</span>
              <button onClick={() => removeTrack(t.pid)} style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 16, opacity: 0.4, padding: "0 2px", flexShrink: 0, lineHeight: 1 }}>×</button>
            </div>
          ))}
        </div>

        {/* Library sidebar */}
        {showLib && (
          <div style={{ width: 280, borderLeft: "1px solid var(--border-primary)", display: "flex", flexDirection: "column" as const, background: "var(--bg-secondary)" }}>
            <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}>
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search library..." style={{ width: "100%", padding: "8px 12px", borderRadius: 8, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", fontSize: 12, outline: "none", boxSizing: "border-box" as const }} />
            </div>
            <div style={{ flex: 1, overflowY: "auto" as const }}>
              {filtered.slice(0, 200).map((t: any) => (
                <div key={t.id} onClick={() => addTrack(t)} style={{ padding: "8px 14px", cursor: "pointer", borderBottom: "1px solid var(--border-primary)", transition: "background 0.1s" }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)"}
                  onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "none"}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{t.title}</div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
                    <div style={{ fontSize: 10, color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, flex: 1 }}>{t.artist}</div>
                    <div style={{ fontSize: 10, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace", flexShrink: 0, marginLeft: 8 }}>{fmtDur(t.durationMs || 0)}</div>
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

function LivePanel({ deckA, deckB, deckC, autoAdv, shuffle, toggleAuto, toggleShuffle, queueLen, showCarts, toggleCarts, inputDevice, visiblePanels, deckConfigs, onConfigureDecks, autoSilenceTrim, setAutoSilenceTrim }: {
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
}) {
  const vp = visiblePanels || { queue: true, deckA: true, deckB: true, deckC: true, mic: true };
  const [autoXfade, setAutoXfade] = useState(true);
  const [xfadeActive, setXfadeActive] = useState(false);
  // Panel widths — resizable via drag divider
  const [queueWidth, setQueueWidth] = useState(360);
  const resizingRef = useRef(false);

  const startResizeQueue = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = queueWidth;
    resizingRef.current = true;
    const onMove = (ev: MouseEvent) => {
      // If queue is on the left, dragging right = wider; if on the right, dragging left = wider
      const dir = panelOrder[0] === "queue" ? 1 : -1;
      const next = Math.max(220, Math.min(560, startW + (ev.clientX - startX) * dir));
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
  const [deckWidths, setDeckWidths] = useState<Record<string, number | null>>({ A: null, B: null, C: null, mic: null });

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
  const activeDeckOrder: DeckSlot[] = deckConfigs && deckConfigs.length > 0
    ? deckConfigs.filter(c => c.enabled).map(c => c.slot as DeckSlot)
    : DEFAULT_DECK_ORDER;
  // Keep deckOrder in sync for drag-drop resize (still needed for deckWidths key)
  const [deckOrder, setDeckOrder] = useState<DeckSlot[]>(activeDeckOrder);
  useEffect(() => { setDeckOrder(activeDeckOrder); }, [JSON.stringify(activeDeckOrder)]);
  const [draggingDeck, setDraggingDeck] = useState<DeckSlot | null>(null);
  const [dropDeck, setDropDeck] = useState<DeckSlot | null>(null);
  const deckRowRef = useRef<HTMLDivElement>(null);

  const startDeckDrag = (slot: DeckSlot) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDraggingDeck(slot);

    const onMouseMove = (ev: MouseEvent) => {
      if (!deckRowRef.current) return;
      const items = Array.from(deckRowRef.current.querySelectorAll("[data-deck-slot]"));
      let target: DeckSlot | null = null;
      for (const el of items) {
        const rect = el.getBoundingClientRect();
        if (ev.clientX >= rect.left && ev.clientX <= rect.right) {
          target = (el as HTMLElement).dataset.deckSlot as DeckSlot;
          break;
        }
      }
      setDropDeck(target && target !== slot ? target : null);
    };

    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
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

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  const handleXfade = () => {
    // Determine which deck is currently playing
    const playingDeck =
      deckA?.status === "playing" ? "A" :
      deckB?.status === "playing" ? "B" :
      deckC?.status === "playing" ? "C" : null;

    if (!playingDeck) return;

    // Find the next loaded deck in cycle A→B→C→A
    const order: Array<"A"|"B"|"C"> = ["A", "B", "C"];
    const currentIdx = order.indexOf(playingDeck as "A"|"B"|"C");
    
    // Look for next deck that has a track loaded
    let targetDeck: "A"|"B"|"C" | null = null;
    for (let i = 1; i <= 2; i++) {
      const candidate = order[(currentIdx + i) % 3];
      const state = candidate === "A" ? deckA : candidate === "B" ? deckB : deckC;
      if (state?.filePath) { targetDeck = candidate; break; }
    }

    if (!targetDeck) return;

    // Fire the crossfade
    engine.crossfade(playingDeck, targetDeck, xfadeDuration * 1000);

    // After crossfade completes — stop source deck and load next from queue
    setTimeout(async () => {
      engine.getDeck(playingDeck)?.stop();
      // If queue has more tracks, preload into the source deck
      const q = engine.getQueue();
      if (q.length > 0) {
        const next = q[0];
        engine.clearQueue();
        engine.addToQueue(q.slice(1));
        await engine.loadToDeck(playingDeck, next.filePath, next.title, next.artist);
      }
    }, 2200); // after fade completes

    setXfadeActive(true);
    setTimeout(() => setXfadeActive(false), 2200);
  };

  const startDrag = (panel: "queue" | "decks") => (e: React.MouseEvent) => {
    e.preventDefault();
    dragStartXRef.current = e.clientX;
    setDragging(panel);

    const onMouseMove = (ev: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const mid = rect.left + rect.width / 2;
      // whichever half of the container the cursor is in = drop target
      const hovering = ev.clientX < mid ? panelOrder[0] : panelOrder[1];
      setDropTarget(hovering !== panel ? hovering : null);
    };

    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      setDragging(null);
      setDropTarget(dt => {
        if (dt && dt !== panel) {
          setPanelOrder(prev => [prev[1], prev[0]]);
        }
        return null;
      });
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  const showQueue = vp.queue !== false;
  const queuePanel = (
    <div
      key="queue"
      style={{
        width: queueWidth, flexShrink: 0, display: "flex", flexDirection: "column", overflow: "hidden",
        opacity: dragging === "queue" ? 0.55 : 1,
        outline: dropTarget === "queue" ? "2px solid #38bdf8" : "none",
        outlineOffset: 2, borderRadius: 14,
        transition: "opacity 0.15s, outline 0.1s",
      }}
    >
      <UpNext queueLen={queueLen} onQueueChange={() => {}} />
    </div>
  );

  const decksPanel = (
    <div
      key="decks"
      style={{
        flex: 1, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden", gap: 10,
        opacity: dragging === "decks" ? 0.55 : 1,
        outline: dropTarget === "decks" ? "2px solid #38bdf8" : "none",
        outlineOffset: 2, borderRadius: 14,
        transition: "opacity 0.15s, outline 0.1s",
      }}
    >
      <div ref={deckRowRef} style={{ display: "flex", gap: 4, flex: 1, minHeight: 0, cursor: draggingDeck ? "grabbing" : "auto" }}>
        {activeDeckOrder.map((slot, i) => {
          const isDragging = draggingDeck === slot;
          const isDropTarget = dropDeck === slot;
          const hasRight = i < deckOrder.length - 1;
          const fixedW = deckWidths[slot] ?? null;

          // Get this slot's type early so we can decide layout
          const slotConfig = deckConfigs?.find(d => d.slot === slot);
          const slotType = slotConfig?.type || (slot === "mic" ? "mic" : "music");

          // Compact strip when 4+ decks total — all slots get channel strip view
          const compact = activeDeckOrder.length >= 5;

          const divider = hasRight ? (
            compact ? (
              // Compact mode — thin visual gap only, no resize
              <div style={{ width: 4, flexShrink: 0 }} />
            ) : (
              <div
                onMouseDown={startResizeDeck(slot)}
                style={{
                  width: 8, flexShrink: 0, cursor: "col-resize",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}
              >
                <div style={{
                  width: 3, height: 32, borderRadius: 2,
                  background: "var(--border-secondary)",
                  pointerEvents: "none",
                  transition: "background 0.15s, height 0.15s",
                }}
                  onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.background = "var(--accent-blue)"; el.style.height = "50px"; }}
                  onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.background = "var(--border-secondary)"; el.style.height = "32px"; }}
                />
              </div>
            )
          ) : null;

          const config = deckConfigs?.find(d => d.slot === slot);
          const deckType = config?.type || (slot === "mic" ? "mic" : "music");
          const deckMap = { A: deckA, B: deckB, C: deckC };
          const deck = deckMap[slot as "A"|"B"|"C"];
          const isActive = deck?.status === "playing" || deck?.status === "paused";
          const play    = () => engine.getDeck(slot)?.play();
          const pause   = () => engine.getDeck(slot)?.pause();
          const resume  = () => engine.getDeck(slot)?.resume();
          const stop    = () => engine.getDeck(slot)?.stop();
          const vol     = (v: number) => engine.getDeck(slot)?.setVolume(v);

          const sizeStyle: React.CSSProperties = compact
            ? { flex: 1, minWidth: 75, maxWidth: 200 }   // all strips share space equally
            : fixedW !== null
              ? { width: fixedW, flexShrink: 0 }
              : slot === "mic"
                ? { width: 185, flexShrink: 0 }
                : { flex: isActive ? 2.2 : 1, transition: "flex 0.5s cubic-bezier(0.4,0,0.2,1)" };

          return (
            <React.Fragment key={slot}>
              <div
                data-deck-slot={slot}
                style={{
                  ...sizeStyle, display: "flex", flexDirection: "column", minWidth: 0,
                  opacity: isDragging ? 0.45 : 1,
                  outline: isDropTarget ? "2px solid #38bdf8" : "none",
                  outlineOffset: 2, borderRadius: compact ? 10 : 18,
                }}
              >
                {deckType === "cart" ? (
                  <div style={{ height: "100%", background: "var(--bg-secondary)", borderRadius: compact ? 10 : 18, border: "1px solid var(--border-primary)", overflow: "hidden" }}>
                    <BoutiqueCartWall deckSlot={slot} compact={compact} />
                  </div>
                ) : compact ? (
                  <ChannelStrip
                    label={config?.label || slot}
                    color={config?.color || (deckType === "mic" ? "#ef4444" : deckType === "guest" ? "#a78bfa" : "#34d399")}
                    deck={deck}
                    deckSlot={slot}
                    isMic={deckType === "mic" || deckType === "guest"}
                    deviceId={inputDevice || ""}
                    setDeviceId={() => {}}
                    audioDevices={[]}
                    isLast={false}
                    vertical
                  />
                ) : deckType === "mic" || slot === "mic" ? (
                  <MicDeck inputDeviceId={inputDevice || undefined} onDragStart={startDeckDrag(slot as DeckSlot)} />
                ) : !["A","B","C"].includes(slot) ? (
                  <div style={{ height: "100%", background: "var(--bg-secondary)", borderRadius: 18, border: "1px solid var(--border-primary)", overflow: "hidden" }}>
                    <PlaylistPlayer deckSlot={slot} color={config?.color || "#34d399"} />
                  </div>
                ) : (
                  <OnAirDeck deck={deck} label={config?.label || "Deck " + slot} deckId={slot as "A"|"B"|"C"} onPlay={play} onPause={pause} onResume={resume} onStop={stop} onVolume={vol} onDragStart={startDeckDrag(slot as DeckSlot)} />
                )}
              </div>
              {divider}
            </React.Fragment>
          );
        })}
      </div>

      {/* Cart wall — shown when CARTS active or when a deck is configured as cart */}
      {showCarts && !deckConfigs?.some(d => d.type === "cart" && d.enabled) && (
        <div style={{ flexShrink: 0, background: "var(--bg-secondary)", borderRadius: 12, border: "1px solid var(--border-primary)", height: 200 }}>
          <BoutiqueCartWall deckSlot="C" />
        </div>
      )}
    </div>
  );

  const panels: Record<string, JSX.Element> = { queue: showQueue ? queuePanel : <></>, decks: decksPanel };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 12 }}>

      {/* Toolbar — refined pill strip */}
      <div style={{
        display: "flex", alignItems: "center", flexShrink: 0, gap: 4,
        background: "var(--bg-secondary)",
        border: "1px solid var(--border-primary)",
        borderRadius: 12,
        padding: "4px 8px",
      }}>
        <div style={{ display: "flex", gap: 2 }}>
          <ToolbarBtn label="SHUFFLE" active={shuffle} onClick={toggleShuffle} color="#fbbf24" />
          <ToolbarBtn label="TRIM" active={autoSilenceTrim??true} onClick={() => setAutoSilenceTrim?.(!autoSilenceTrim)} color="#34d399" />
        </div>
        <div style={{ width: 1, height: 16, background: "var(--border-primary)", margin: "0 4px" }} />
        <div style={{ display: "flex", gap: 2 }}>
          <ToolbarBtn label="CARTS" active={showCarts} onClick={toggleCarts} color="#f97316" />
          <ToolbarBtn label="AUTO-X" active={autoXfade} onClick={() => { const n = !autoXfade; setAutoXfade(n); engine.outroCrossfade = n; }} color="#a78bfa" />
          <ToolbarBtn label="XFADE" active={xfadeActive} onClick={handleXfade} color="#a78bfa" />
          {/* Crossfade duration control */}
          <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "0 6px", borderRadius: 8, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", height: 28 }}>
            <span style={{ fontSize: 9, fontWeight: 700, color: "var(--text-tertiary)", letterSpacing: "0.06em" }}>XF</span>
            <select
              value={xfadeDuration}
              onChange={e => { const v = Number(e.target.value); setXfadeDuration(v); engine.crossfadeDuration = v; }}
              style={{ fontSize: 10, fontWeight: 700, background: "transparent", border: "none", color: "var(--accent-cyan)", cursor: "pointer", outline: "none", fontFamily: "'DM Mono', monospace" }}
            >
              {[1,2,3,4,5,6,8,10].map(s => <option key={s} value={s}>{s}s</option>)}
            </select>
          </div>
        </div>
        <div style={{ width: 1, height: 16, background: "var(--border-primary)", margin: "0 4px" }} />
        <div style={{ flex: 1, minWidth: 0, position: "relative" as const }}>
          {!showCarts && <JockStrip deckA={deckA} deckB={deckB} dropDown />}
        </div>
        <div style={{ width: 1, height: 16, background: "var(--border-primary)", margin: "0 4px" }} />
        <button
          onClick={onConfigureDecks}
          title="Configure deck layout"
          style={{
            display: "flex", alignItems: "center", gap: 5,
            padding: "5px 11px", borderRadius: 8, border: "none",
            background: "var(--bg-tertiary)", color: "var(--text-secondary)",
            fontSize: 10, fontWeight: 700, letterSpacing: "0.06em",
            cursor: "pointer", fontFamily: "'Syne', sans-serif",
            transition: "all 0.12s",
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)"; (e.currentTarget as HTMLElement).style.color = "var(--text-primary)"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "var(--bg-tertiary)"; (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)"; }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
            <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
          </svg>
          DECKS
        </button>
      </div>

      {/* Main layout — drag-reorderable + resizable */}
      <div
        ref={containerRef}
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
                onMouseDown={startResizeQueue}
                style={{
                  width: 10, flexShrink: 0, cursor: "col-resize",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  position: "relative",
                }}
              >
                <div style={{
                  width: 3, height: 40, borderRadius: 2,
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

function LibraryPanel({ onLoadA, onLoadB, onQueue, onEdit }: { onLoadA: (s: SongRow) => void; onLoadB: (s: SongRow) => void; onQueue: (s: SongRow) => void; onEdit: (s: SongRow) => void }) {
  const [showImport, setShowImport] = useState(false);
  const [showNexGen, setShowNexGen] = useState(false);
  const [catList, setCatList] = useState<{ id: number; code: string; color: string | null }[]>([]);
  const [songs, setSongs] = useState<SongRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [count, setCount] = useState(0);
  const [status, setStatus] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const { isStation } = usePlan();

  const load = async () => {
    try {
      const rows = await query<SongRow>("SELECT s.*, a.name as artist_name, al.title as album_title, c.code as category_code, c.color as category_color FROM songs s LEFT JOIN artists a ON a.id = s.artist_id LEFT JOIN albums al ON al.id = s.album_id LEFT JOIN categories c ON c.id = s.category_id ORDER BY s.title LIMIT 500");
      setSongs(rows);
      const r = await queryOne<{ c: number }>("SELECT COUNT(*) as c FROM songs");
      setCount(r ? r.c : 0);
      setCatList(await query<{ id: number; code: string; color: string | null }>("SELECT id, code, color FROM categories ORDER BY code"));
    } catch (e) { console.error(e); setStatus("Error: " + e); }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const toggleSelect = (id: number) => { setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; }); };
  const selectAll = () => { setSelectedIds(prev => prev.size === filtered.length ? new Set() : new Set(filtered.map(s => s.id))); };
  const deleteSelected = async () => {
    if (!confirm("Delete " + selectedIds.size + " song(s)?")) return;
    for (const id of selectedIds) await execute("DELETE FROM songs WHERE id=?", [id]);
    setSelectedIds(new Set()); load();
  };
  const deleteAll = async () => {
    if (!confirm("Delete ALL " + count + " songs?")) return;
    await execute("DELETE FROM songs", []); setSelectedIds(new Set()); load();
  };
  const analyzeLufs = async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const songs = await query<{id: number, file_path: string}>("SELECT id, file_path FROM songs WHERE file_path IS NOT NULL AND gain_db = 0 LIMIT 50");
    if (songs.length === 0) { setStatus("All songs already analyzed"); setTimeout(() => setStatus(""), 3000); return; }
    setStatus("Analyzing... 0/" + songs.length); let done = 0;
    for (const song of songs) {
      try { const gain = await invoke<number>("analyze_lufs", { filePath: song.file_path }); await execute("UPDATE songs SET gain_db=? WHERE id=?", [gain, song.id]); } catch {}
      done++; setStatus("Analyzing... " + done + "/" + songs.length);
    }
    setStatus("Done! Analyzed " + done + " songs."); setTimeout(() => setStatus(""), 4000);
  };
  const relocateLibrary = async () => {
    const folder = await open({ directory: true, title: "Select new music folder location" });
    if (!folder) return;
    const newBase = (folder as string).replace(/\\/g, "/");
    const broken = await query<{id: number, file_path: string}>("SELECT id, file_path FROM songs WHERE file_path IS NOT NULL");
    let fixed = 0;
    for (const song of broken) {
      const filename = song.file_path.split(/[\/]/).pop();
      if (!filename) continue;
      await execute("UPDATE songs SET file_path=? WHERE id=? AND file_path!=?", [newBase + "/" + filename, song.id, newBase + "/" + filename]); fixed++;
    }
    setStatus("Relocated " + fixed + " songs"); setTimeout(() => setStatus(""), 4000); load();
  };
  const queueAll = () => { engine.addToQueue(filtered.filter(s => s.file_path).map(s => ({ filePath: s.file_path!, title: s.title, artist: s.artist_name || "" }))); };
  const filtered = search ? songs.filter(s => (s.title||"").toLowerCase().includes(search.toLowerCase()) || (s.artist_name||"").toLowerCase().includes(search.toLowerCase())) : songs;

  const S = {
    btn: (bg: string, color = "#fff") => ({ padding: "6px 14px", borderRadius: 8, fontSize: 11, fontWeight: 600 as any, background: bg, color, border: "none", cursor: "pointer" as any }),
    btnOutline: { padding: "6px 12px", borderRadius: 8, fontSize: 11, fontWeight: 600 as any, background: "var(--bg-tertiary)", color: "var(--text-tertiary)" as any, border: "1px solid var(--border-primary)", cursor: "pointer" as any },
  };

  return (
    <div style={{ display: "flex", flexDirection: "column" as any, gap: 14, fontFamily: "'Inter', system-ui, sans-serif" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--text-primary)", margin: 0, fontFamily: "'Syne', sans-serif" }}>Song Library</h1>
          <span style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 2 }}>{count} tracks</span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={relocateLibrary} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-secondary)", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            Relocate
          </button>
          <button onClick={analyzeLufs} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-secondary)", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>
            Normalize
          </button>
          {isStation
            ? <button onClick={() => setShowNexGen(!showNexGen)} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-secondary)", cursor: "pointer" }}>{showNexGen ? "Cancel" : "NexGen / ENCO"}</button>
            : <button onClick={() => window.dispatchEvent(new CustomEvent("ether:open-subscription"))} style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600, background: "rgba(167,139,250,0.08)", color: "#a78bfa", border: "1px solid rgba(167,139,250,0.25)", cursor: "pointer" }} title="Station plan required">🔒 NexGen / ENCO</button>
          }
          <button onClick={() => setShowImport(!showImport)} style={{ padding: "7px 16px", borderRadius: 8, fontSize: 12, fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer", boxShadow: "0 2px 8px rgba(14,165,233,0.35)" }}>{showImport ? "Cancel" : "+ Import Music"}</button>
        </div>
      </div>

      {/* Search + filters row */}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 10, padding: "8px 14px" }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ opacity: 0.35, flexShrink: 0, color: "var(--text-primary)" }}>
            <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M9.5 9.5L12.5 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          <input type="text" placeholder="Quick search — type to find a song..." value={search} onChange={e => setSearch(e.target.value)}
            style={{ flex: 1, background: "transparent", border: "none", outline: "none", fontSize: 13, color: "var(--text-primary)", fontFamily: "'Inter', system-ui, sans-serif" }} />
          {search && <button onMouseDown={e => { e.preventDefault(); setSearch(""); }} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-tertiary)", fontSize: 16 }}>×</button>}
        </div>
        <select onChange={async (e) => { if (!e.target.value) return; const catId = catList.find(c => c.code === e.target.value)?.id || null; for (const s of filtered) await execute("UPDATE songs SET category_id=? WHERE id=?", [catId, s.id]); e.target.value = ""; load(); }}
          style={{ padding: "8px 12px", borderRadius: 8, fontSize: 12, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", outline: "none", cursor: "pointer" }}>
          <option value="">Assign category...</option>
          {catList.map(c => <option key={c.id} value={c.code}>All → {c.code}</option>)}
        </select>
        <button onClick={queueAll} style={S.btn("var(--accent-green)", "#000")}>Queue All</button>
        {selectedIds.size > 0 && <button onClick={deleteSelected} style={S.btn("var(--accent-red)")}>Delete {selectedIds.size}</button>}
        <button onClick={deleteAll} style={{ ...S.btnOutline, color: "var(--accent-red)" as any }}>Delete All</button>
      </div>

      {status && <div style={{ padding: "10px 14px", background: "rgba(56,189,248,0.08)", border: "1px solid rgba(56,189,248,0.2)", borderRadius: 8, fontSize: 12, color: "var(--accent-blue)" }}>{status}</div>}
      {showImport && <ImportDialog onDone={() => { setShowImport(false); load(); }} />}
      {showNexGen && <NexGenImport onDone={() => { setShowNexGen(false); load(); }} />}

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
        <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 12, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" as any, fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-primary)", background: "var(--bg-tertiary)" }}>
                <th style={{ padding: "10px 12px", width: 32 }}><input type="checkbox" checked={selectedIds.size === filtered.length && filtered.length > 0} onChange={selectAll} /></th>
                <th style={{ padding: "10px 6px", width: 36, fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.08em", textAlign: "left" as any }}>#</th>
                <th style={{ padding: "10px 12px", fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.08em", textAlign: "left" as any }}>Title</th>
                <th style={{ padding: "10px 12px", fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.08em", textAlign: "left" as any }}>Artist</th>
                <th style={{ padding: "10px 12px", fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.08em", textAlign: "left" as any, width: 80 }}>Category</th>
                <th style={{ padding: "10px 12px", fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", textTransform: "uppercase" as any, letterSpacing: "0.08em", textAlign: "left" as any, width: 56 }}>Format</th>
                <th style={{ padding: "10px 12px", width: 120 }}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s, i) => (
                <tr key={s.id}
                  style={{ borderBottom: i < filtered.length - 1 ? "1px solid var(--border-primary)" : "none" }}
                  onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-hover)")}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                >
                  <td style={{ padding: "10px 12px" }}><input type="checkbox" checked={selectedIds.has(s.id)} onChange={() => toggleSelect(s.id)} /></td>
                  <td style={{ padding: "10px 6px", fontSize: 11, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace" }}>{i + 1}</td>
                  <td style={{ padding: "10px 12px", color: "var(--text-primary)", fontWeight: 500, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>{s.title}</td>
                  <td style={{ padding: "10px 12px", color: "var(--text-secondary)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>{s.artist_name || "—"}</td>
                  <td style={{ padding: "10px 12px" }}>
                    <select value={s.category_code || ""} onChange={async (e) => { const catId = catList.find(c => c.code === e.target.value)?.id || null; await execute("UPDATE songs SET category_id=? WHERE id=?", [catId, s.id]); load(); }}
                      style={{ padding: "3px 6px", borderRadius: 6, fontSize: 11, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", outline: "none", cursor: "pointer" }}>
                      <option value="">—</option>
                      {catList.map(c => <option key={c.id} value={c.code}>{c.code}</option>)}
                    </select>
                  </td>
                  <td style={{ padding: "10px 12px", fontSize: 10, color: "var(--text-tertiary)", fontFamily: "'DM Mono', monospace", textTransform: "uppercase" as any }}>{s.file_path ? fmtExt(s.file_path) : "—"}</td>
                  <td style={{ padding: "10px 12px", textAlign: "right" as any }}>
                    <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                      <button onClick={() => onLoadA(s)} style={{ padding: "4px 8px", borderRadius: 6, fontSize: 10, fontWeight: 700, background: "rgba(56,189,248,0.15)", color: "var(--accent-blue)", border: "none", cursor: "pointer" }}>A</button>
                      <button onClick={() => onLoadB(s)} style={{ padding: "4px 8px", borderRadius: 6, fontSize: 10, fontWeight: 700, background: "rgba(52,211,153,0.15)", color: "var(--accent-green)", border: "none", cursor: "pointer" }}>B</button>
                      <button onClick={() => onQueue(s)} style={{ padding: "4px 8px", borderRadius: 6, fontSize: 10, fontWeight: 700, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>Q</button>
                      <button onClick={() => onEdit(s)} style={{ padding: "4px 8px", borderRadius: 6, fontSize: 10, fontWeight: 700, background: "rgba(167,139,250,0.15)", color: "#a78bfa", border: "none", cursor: "pointer" }} title="Edit cue points">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="10" y1="15" x2="20" y2="5"/><line x1="17" y1="2" x2="22" y2="7"/><polyline points="20 12 20 22 4 22 4 6 14 6"/></svg>
                      </button>
                      <button onClick={async () => { if (confirm("Delete " + s.title + "?")) { try { await execute("DELETE FROM songs_fts WHERE rowid=?", [s.id]); } catch {} await execute("DELETE FROM songs WHERE id=?", [s.id]); load(); } }} style={{ padding: "4px 8px", borderRadius: 6, fontSize: 10, fontWeight: 700, background: "transparent", color: "var(--text-tertiary)", border: "none", cursor: "pointer" }}>✕</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ClockDisplay() {
  const [time, setTime] = useState(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
  useEffect(() => {
    const id = setInterval(() => setTime(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })), 1000);
    return () => clearInterval(id);
  }, []);
  return <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "var(--text-secondary)", letterSpacing: "0.05em" }}>{time}</span>;
}
