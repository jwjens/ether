import { useState, useEffect, useRef, useCallback, createContext, useContext } from "react";
const invoke = <T = any>(cmd: string, args?: any): Promise<T> => (window as any).ether.invoke(cmd, args);
import { query, execute } from "../db/client";
import { queryScoped } from "../db/stationScoped";
import { useActiveStation } from "../hooks/useActiveStation";
import { usePlan } from "../hooks/usePlan";
import { useStreaming } from "../hooks/useStreaming";
import { getStationTimezone, setStationTimezone, COMMON_TIMEZONES } from "../utils/timezone";
import { processLibrary as processAllSongs, getProcessingStats } from "../audio/songAnalysis";
import StreamMetadataPanel from "./StreamMetadataPanel";
import StreamStatusPill from "./StreamStatusPill";
import { useStreamStatus } from "../contexts/StreamStatusContext";
import PairMobileApp from "./PairMobileApp";
import BetaProgram from "./BetaProgram";
import { validateSlug, slugify } from "../lib/slug";
import { fetchMyMemberships, type Membership } from "../lib/memberships";

// ── Settings categories ──────────────────────────────────────
// 6 buckets that cover all 18 Section components without any one category
// getting overcrowded. Shown in the sidebar in this order.
export type SettingsCategory = "station" | "audio" | "programming" | "broadcast" | "integrations" | "backup" | "system";
const CATEGORIES: { id: SettingsCategory; label: string; icon: React.ReactNode }[] = [
  { id: "station",      label: "Station",      icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a3 3 0 0 0-3 3v4a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10c0 3.866-3.134 7-7 7s-7-3.134-7-7"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="8" y1="21" x2="16" y2="21"/></svg> },
  { id: "audio",        label: "Audio",        icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg> },
  { id: "programming",  label: "Programming",  icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg> },
  { id: "broadcast",    label: "Broadcast",    icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1" fill="currentColor" stroke="none"/></svg> },
  { id: "integrations", label: "Integrations", icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg> },
  { id: "backup",       label: "Backup & Restore", icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><polyline points="9 13 12 16 15 13"/><line x1="12" y1="16" x2="12" y2="9"/></svg> },
  { id: "system",       label: "System",       icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg> },
];

// Friendly "5 minutes ago" relative time for backup status — plain language beats a raw timestamp.
function timeAgo(unixSec: number): string {
  if (!unixSec) return "";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d} days ago`;
  return new Date(unixSec * 1000).toLocaleDateString();
}

// ── Settings visual layer ─────────────────────────────────────
// Scoped stylesheet for the Preferences shell + cards. Inline styles can't
// express hover/focus/transitions, which is most of what made this panel feel
// unfinished. Classes here drive the chrome (header, search, rail) and the
// Section card; brand stays intact (sharp corners, purple accent, dark base).
const SETTINGS_CSS = `
.eth-settings__head { display:flex; align-items:flex-end; justify-content:space-between; gap:20px; margin-bottom:22px; flex-wrap:wrap; }
.eth-settings__title { font-family:'Inter',system-ui,sans-serif; font-size:28px; font-weight:700; letter-spacing:-0.045em; color:var(--text-primary); margin:0; line-height:1; }
.eth-settings__sub { font-size:13px; color:var(--text-tertiary); margin-top:7px; }
.eth-search { position:relative; flex:1; max-width:360px; min-width:200px; }
.eth-search__icon { position:absolute; left:11px; top:50%; transform:translateY(-50%); color:var(--text-tertiary); pointer-events:none; }
.eth-search input { width:100%; padding:11px 30px 11px 36px; background:var(--bg-tertiary); border:1px solid var(--border-primary); color:var(--text-primary); font-size:14.5px; outline:none; box-sizing:border-box; transition:border-color .15s, box-shadow .15s; }
.eth-search input::placeholder { color:var(--text-tertiary); }
.eth-search input:focus { border-color:var(--accent-blue); box-shadow:0 0 0 3px rgb(from var(--accent-blue) r g b / 0.18); }
.eth-search__clear { position:absolute; right:6px; top:50%; transform:translateY(-50%); background:none; border:none; color:var(--text-tertiary); cursor:pointer; font-size:16px; line-height:1; padding:2px 6px; }
.eth-search__clear:hover { color:var(--text-primary); }

.eth-rail { background:var(--bg-secondary); border:1px solid var(--border-primary); padding:8px; position:sticky; top:10px; display:flex; flex-direction:column; gap:2px; }
.eth-rail__label { font-size:11px; font-weight:700; letter-spacing:0.14em; text-transform:uppercase; color:var(--text-tertiary); padding:8px 12px 10px; }
.eth-rail__btn { display:flex; align-items:center; gap:12px; padding:11px 14px; font-size:14.5px; font-weight:600; cursor:pointer; text-align:left; width:100%; background:transparent; color:var(--text-secondary); border:none; border-left:2px solid transparent; transition:background .12s, color .12s, border-color .12s; font-family:inherit; }
.eth-rail__btn:hover { background:var(--bg-tertiary); color:var(--text-primary); }
.eth-rail__btn--active { background:rgb(from var(--accent-blue) r g b / 0.12); color:var(--accent-blue); border-left-color:var(--accent-blue); }
.eth-rail__icon { display:flex; align-items:center; flex-shrink:0; opacity:.9; }

.eth-card { background:var(--bg-secondary); border:1px solid var(--border-primary); margin-bottom:18px; transition:border-color .15s; }
.eth-card:hover { border-color:var(--border-secondary); }
.eth-card__head { padding:20px 24px 18px; border-bottom:1px solid var(--border-primary); display:flex; align-items:flex-start; gap:15px; }
.eth-card__icon { display:flex; align-items:center; color:var(--accent-blue); opacity:.95; margin-top:2px; }
.eth-card__icon svg { width:22px; height:22px; }
.eth-card__title { font-family:'Inter',system-ui,sans-serif; font-size:18px; font-weight:700; color:var(--text-primary); letter-spacing:-0.02em; line-height:1.25; }
.eth-card__desc { font-size:14px; color:var(--text-secondary); margin-top:5px; line-height:1.5; }
.eth-card__body { padding:22px 24px; font-size:14px; color:var(--text-secondary); }

/* Field primitives — consistent focus + hover across every settings card */
.eth-card__body input:not([type=range]):not([type=checkbox]):not([type=color]),
.eth-card__body select,
.eth-card__body textarea { transition:border-color .15s, box-shadow .15s; }
.eth-card__body input:not([type=range]):not([type=checkbox]):not([type=color]):focus,
.eth-card__body select:focus,
.eth-card__body textarea:focus { border-color:var(--accent-blue) !important; box-shadow:0 0 0 3px rgb(from var(--accent-blue) r g b / 0.18); outline:none; }
.eth-card__body button { transition:filter .12s, background .12s, border-color .12s; }
.eth-card__body button:not(:disabled):hover { filter:brightness(1.12); }
.eth-card__body button:disabled { cursor:default; opacity:.6; }
`;

// ── Settings filter context ───────────────────────────────────
// Each <Section> self-filters against this. Keeps the filter logic in ONE
// place (the Section component) so adding new sections is just a matter of
// passing a `category` prop — no need to thread activeCategory/searchText
// through the JSX tree manually.
interface FilterCtx {
  activeCategory: SettingsCategory;
  searchText: string;
  registerSection: (title: string, category: SettingsCategory) => void;
}
const SettingsFilterContext = createContext<FilterCtx>({
  activeCategory: "station",
  searchText: "",
  registerSection: () => {},
});

// Called by <Section> (and other category-gated components) to decide if
// they should render. Returns true when the current filter matches. If the
// user is searching, category is ignored — search beats category.
function useShouldRender(title: string, description: string, category: SettingsCategory): boolean {
  const { activeCategory, searchText } = useContext(SettingsFilterContext);
  if (searchText.trim()) {
    const q = searchText.toLowerCase();
    return title.toLowerCase().includes(q) || description.toLowerCase().includes(q);
  }
  return category === activeCategory;
}

// ── Shared UI primitives ─────────────────────────────────────

function Section({ icon, title, description, category, children }: {
  icon: React.ReactNode;
  title: string;
  description: string;
  category?: SettingsCategory;
  children: React.ReactNode;
}) {
  // Default to "station" if no category given — keeps legacy Section usage safe.
  const shouldRender = useShouldRender(title, description, category ?? "station");
  if (!shouldRender) return null;

  return (
    <div className="eth-card">
      <div className="eth-card__head">
        <span className="eth-card__icon">{icon}</span>
        <div>
          <div className="eth-card__title">{title}</div>
          <div className="eth-card__desc">{description}</div>
        </div>
      </div>
      <div className="eth-card__body">{children}</div>
    </div>
  );
}

// ── CategoryGate ──────────────────────────────────────────────
// Wraps NON-Section components (like <UserManagement />) that should also
// be gated by category/search. UserManagement renders its own Section
// internally with the right category, so this is mainly a mount-gate.
// Skipped during search (children handle their own search-match check).
function CategoryGate({ category, children }: { category: SettingsCategory; children: React.ReactNode }) {
  const { activeCategory, searchText } = useContext(SettingsFilterContext);
  if (searchText.trim()) return <>{children}</>;   // let child self-filter
  if (category !== activeCategory) return null;
  return <>{children}</>;
}

function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <div onClick={() => onChange(!value)} style={{
        width: 40, height: 22, borderRadius: 0, cursor: "pointer",
        background: value ? "var(--accent-blue)" : "var(--bg-tertiary)",
        border: "1px solid " + (value ? "var(--accent-blue)" : "var(--border-secondary)"),
        position: "relative", transition: "background 0.2s", flexShrink: 0,
      }}>
        <div style={{
          position: "absolute", top: 3, left: value ? 20 : 3,
          width: 14, height: 14, borderRadius: 0, background: "#fff",
          transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
        }} />
      </div>
      <span style={{ fontSize: 14.5, color: "var(--text-secondary)" }}>{label}</span>
    </div>
  );
}

function SettingRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "16px 0", borderBottom: "1px solid var(--border-primary)" }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>{label}</div>
        {hint && <div style={{ fontSize: 13.5, color: "var(--text-tertiary)", marginTop: 4, lineHeight: 1.5 }}>{hint}</div>}
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  );
}

function CodeBox({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--bg-tertiary)", borderRadius: 0, padding: "10px 14px", border: "1px solid var(--border-primary)" }}>
      <span style={{ flex: 1, fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 14, color: "#c4b5fd", wordBreak: "break-all" as any }}>{value}</span>
      <button onClick={() => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
        style={{ padding: "6px 14px", borderRadius: 0, fontSize: 13, fontWeight: 600, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer", flexShrink: 0 }}>
        {copied ? "✓" : "Copy"}
      </button>
    </div>
  );
}

// ── Experience Mode selector ─────────────────────────────────

const EXP_MODES = [
  { id: "solo",       label: "Solo",       desc: "One deck · Simple play/pause · Beginner" },
  { id: "standard",   label: "Standard",   desc: "Two decks · Crossfades · Independent broadcasters" },
  { id: "live_radio", label: "Live Radio", desc: "All six decks · Full automation · Professional stations" },
] as const;

function StationLogoUploader() {
  const [logoUrl, setLogoUrl]                   = useState<string | null>(null);
  const [status, setStatus]                     = useState("");
  const [activeStationId, setActiveStationId]   = useState<number | null>(null);
  const loadVersionRef = useRef(0);

  useEffect(() => {
    async function doLoad() {
      const v = ++loadVersionRef.current;
      try {
        const station = await (window as any).ether.invoke('stations:get-active');
        if (v !== loadVersionRef.current) return;
        const sid: number | null = station?.id ?? null;
        setActiveStationId(sid);
        if (sid == null) { setLogoUrl(null); return; }
        const kvResult = await (window as any).ether.stationConfigKv.list(sid);
        if (v !== loadVersionRef.current) return;
        if (kvResult.ok) {
          const rows: { key: string; value: string }[] = kvResult.rows;
          setLogoUrl(rows.find(r => r.key === 'station_logo')?.value ?? null);
        }
      } catch {}
    }
    doLoad();
    window.addEventListener('station-switched', doLoad);
    return () => window.removeEventListener('station-switched', doLoad);
  }, []);

  const upload = async () => {
    if (activeStationId == null) return;
    const result = await (window as any).ether.station.uploadLogo();
    if (result?.ok && result.dataUrl) {
      setLogoUrl(result.dataUrl);
      const r = await (window as any).ether.stationConfigKv.upsertByKey(activeStationId, 'station_logo', result.dataUrl);
      if (!r.ok) console.error('[StationLogoUploader] station_logo upsert:', r.error);
      setStatus("Saved");
      setTimeout(() => setStatus(""), 2000);
    }
  };

  const remove = async () => {
    if (activeStationId == null) return;
    setLogoUrl(null);
    const r = await (window as any).ether.stationConfigKv.removeByKey(activeStationId, 'station_logo');
    if (!r.ok) console.error('[StationLogoUploader] station_logo remove:', r.error);
    setStatus("Removed");
    setTimeout(() => setStatus(""), 2000);
  };

  const btnStyle: React.CSSProperties = {
    height: 32, padding: "0 16px", borderRadius: 0, fontSize: 13, fontWeight: 600, cursor: "pointer",
    background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)",
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <div style={{
        width: 72, height: 72, background: "var(--bg-tertiary)",
        border: "1px solid var(--border-primary)", display: "flex", alignItems: "center", justifyContent: "center",
        overflow: "hidden", flexShrink: 0,
      }}>
        {logoUrl
          ? <img src={logoUrl} alt="Logo" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
          : <span style={{ fontSize: 22, opacity: 0.25 }}>📻</span>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <button onClick={upload} style={btnStyle}>{logoUrl ? "Replace Logo..." : "Upload Logo..."}</button>
        {logoUrl && <button onClick={remove} style={{ ...btnStyle, color: "var(--accent-red)", border: "1px solid rgba(239,68,68,0.3)" }}>Remove</button>}
        {status && <span style={{ fontSize: 13, color: "var(--accent-green)" }}>{status}</span>}
        <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>PNG, JPG, SVG — shown on On-Shift welcome screen and Theme Studio</div>
      </div>
    </div>
  );
}

function ExperienceModeSelector() {
  const { stationId } = useActiveStation();
  const [mode, setMode] = useState<string>("");
  const [saved, setSaved] = useState(false);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const prevMode = useRef<string>("");

  useEffect(() => {
    query<{ value: string }>("SELECT value FROM station_config_kv WHERE key = 'experience_mode' AND station_id = ?", [stationId])
      .then(rows => { const v = rows[0]?.value ?? "live_radio"; setMode(v); prevMode.current = v; })
      .catch(() => {});
  }, [stationId]);

  const save = async (next: string) => {
    if (prevMode.current === "standard" && next === "live_radio") setShowUpgrade(true);
    prevMode.current = next;
    setMode(next);
    try {
      await (window as any).ether.stationConfigKv.upsertByKey(stationId, 'experience_mode', next);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch {}
  };

  return (
    <div>
      <div style={{ display: "flex", flexDirection: "column" as any, gap: 8 }}>
        {EXP_MODES.map(m => (
          <button key={m.id} onClick={() => save(m.id)} style={{
            display: "flex", alignItems: "center", gap: 14, padding: "12px 16px", borderRadius: 0, textAlign: "left" as any, cursor: "pointer",
            background: mode === m.id ? "rgb(from var(--accent-blue) r g b / 0.1)" : "var(--bg-tertiary)",
            border: `1px solid ${mode === m.id ? "var(--accent-blue)" : "var(--border-primary)"}`,
            transition: "all 0.12s",
          }}>
            <div style={{ width: 16, height: 16, borderRadius: "50%", border: `2px solid ${mode === m.id ? "var(--accent-blue)" : "var(--border-secondary)"}`, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
              {mode === m.id && <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent-blue)" }} />}
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: mode === m.id ? "#9070e0" : "var(--text-primary)", marginBottom: 2 }}>{m.label}</div>
              <div style={{ fontSize: 13, color: "var(--text-tertiary)" }}>{m.desc}</div>
            </div>
            {saved && mode === m.id && <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--accent-green)", fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}>SAVED</span>}
          </button>
        ))}
      </div>
      {showUpgrade && (
        <div style={{ marginTop: 12, padding: "12px 16px", background: "rgb(from var(--accent-blue) r g b / 0.08)", border: "1px solid var(--accent-blue)60", fontSize: 12, color: "#9070e0", lineHeight: 1.6 }}>
          <strong>Live Radio unlocked.</strong> All six decks are now visible. Format clocks, hard transitions, and the full rotation engine are active. You can assign purposes to decks in the Deck Configurator.
          <button onClick={() => setShowUpgrade(false)} style={{ float: "right" as any, background: "none", border: "none", color: "var(--accent-blue)", cursor: "pointer", fontSize: 13 }}>✕</button>
        </div>
      )}
    </div>
  );
}

// ── Invite generator ─────────────────────────────────────────

function InviteGenerator() {
  const [name, setName]         = useState("");
  const [initials, setInitials] = useState("");
  const [note, setNote]         = useState("");
  const [mode, setMode]         = useState<"solo"|"standard"|"live_radio">("standard");
  const [status, setStatus]     = useState<string | null>(null);

  const generate = async () => {
    if (!name.trim()) return;
    try {
      const result = await (window as any).ether.invoke("invite:generate", {
        name: name.trim(),
        initials: initials.trim() || name.trim().charAt(0),
        note: note.trim(),
        mode,
        invitedBy: "Deniro",
      });
      if (result.ok) setStatus(`Saved to ${result.filePath}`);
      else if (result.reason !== "cancelled") setStatus(`Error: ${result.reason}`);
    } catch (e: any) { setStatus(`Error: ${e.message}`); }
  };

  const inputStyle: React.CSSProperties = {
    width: "100%", padding: "8px 12px", borderRadius: 0,
    background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
    color: "var(--text-primary)", fontSize: 12, outline: "none", boxSizing: "border-box",
  };

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, marginBottom: 8 }}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Operator name (e.g. Sarah Mitchell)" style={inputStyle} />
        <input value={initials} onChange={e => setInitials(e.target.value.slice(0, 3))} placeholder="SM" style={{ ...inputStyle, width: 60, textAlign: "center" as any }} />
      </div>
      <textarea
        value={note} onChange={e => setNote(e.target.value)}
        placeholder="Personal note (optional) — shown on their first shift screen"
        rows={2}
        style={{ ...inputStyle, resize: "vertical" as any, fontFamily: "'Inter', system-ui, sans-serif", lineHeight: 1.5, marginBottom: 8 }}
      />
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        {(["solo", "standard", "live_radio"] as const).map(m => (
          <button key={m} onClick={() => setMode(m)} style={{
            padding: "6px 12px", borderRadius: 0, fontSize: 13, fontWeight: 600, cursor: "pointer",
            background: mode === m ? "rgb(from var(--accent-blue) r g b / 0.15)" : "var(--bg-tertiary)",
            border: `1px solid ${mode === m ? "var(--accent-blue)" : "var(--border-primary)"}`,
            color: mode === m ? "#9070e0" : "var(--text-tertiary)",
          }}>{m.replace("_", " ").replace(/\b\w/g, c => c.toUpperCase())}</button>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button onClick={generate} disabled={!name.trim()} style={{
          padding: "9px 20px", borderRadius: 0, fontSize: 12, fontWeight: 700, cursor: name.trim() ? "pointer" : "default",
          background: name.trim() ? "var(--accent-blue)" : "var(--bg-tertiary)", border: "none", color: name.trim() ? "#fff" : "var(--text-tertiary)",
        }}>Generate Invite File</button>
        <span style={{ fontSize: 13, color: "var(--text-tertiary)", fontFamily: "'JetBrains Mono', ui-monospace, monospace", letterSpacing: "0.08em" }}>BUILT BY DENIRO</span>
      </div>
      {status && <div style={{ marginTop: 8, fontSize: 13, color: status.startsWith("Error") ? "var(--accent-red)" : "var(--accent-green)", fontFamily: "'JetBrains Mono', ui-monospace, monospace", wordBreak: "break-all" as any }}>{status}</div>}
    </div>
  );
}

// ── Spotify credential form ───────────────────────────────────

function SpotifyCredentialForm() {
  const [clientId, setClientId]         = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [status, setStatus]             = useState<{ hasClientId: boolean; hasClientSecret: boolean } | null>(null);
  const [saving, setSaving]             = useState(false);
  const [saved, setSaved]               = useState(false);

  useEffect(() => {
    (window as any).ether.spotify.getCredentialStatus().then(setStatus).catch(() => {});
  }, []);

  const save = async () => {
    if (!clientId.trim() && !clientSecret.trim()) return;
    setSaving(true);
    await (window as any).ether.spotify.setCredentials(clientId.trim(), clientSecret.trim());
    setStatus({ hasClientId: true, hasClientSecret: true });
    setClientId(""); setClientSecret("");
    setSaving(false); setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const inputStyle: React.CSSProperties = {
    flex: 1, padding: "8px 12px", borderRadius: 0, fontSize: 12,
    background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
    color: "var(--text-primary)", outline: "none", fontFamily: "monospace",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {status && (
        <div style={{ display: "flex", gap: 16, marginBottom: 4 }}>
          <span style={{ fontSize: 13, color: status.hasClientId ? "var(--accent-green)" : "var(--text-tertiary)", display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: status.hasClientId ? "var(--accent-green)" : "var(--text-tertiary)", display: "inline-block" }} />
            Client ID {status.hasClientId ? "saved" : "not set"}
          </span>
          <span style={{ fontSize: 13, color: status.hasClientSecret ? "var(--accent-green)" : "var(--text-tertiary)", display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: status.hasClientSecret ? "var(--accent-green)" : "var(--text-tertiary)", display: "inline-block" }} />
            Client Secret {status.hasClientSecret ? "saved" : "not set"}
          </span>
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <input type="password" placeholder="Client ID" value={clientId} onChange={e => setClientId(e.target.value)} style={inputStyle} />
        <input type="password" placeholder="Client Secret" value={clientSecret} onChange={e => setClientSecret(e.target.value)} style={inputStyle} onKeyDown={e => { if (e.key === "Enter") save(); }} />
        <button onClick={save} disabled={saving} style={{ padding: "8px 18px", borderRadius: 0, fontSize: 12, fontWeight: 700, background: saved ? "var(--accent-green)" : "#1db954", color: "#000", border: "none", cursor: "pointer" }}>
          {saved ? "Saved ✓" : saving ? "Saving…" : "Save"}
        </button>
      </div>
      <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
        Credentials stored in Electron safeStorage — never in plain text. Requires Client Credentials flow (no user login needed).
      </div>
    </div>
  );
}

// ── Musixmatch API key form ───────────────────────────────────

function MusixmatchKeyForm() {
  const [key, setKey]         = useState("");
  const [hasKey, setHasKey]   = useState(false);
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);

  useEffect(() => {
    (window as any).ether.musixmatch.getKeyStatus().then((s: { hasKey: boolean }) => setHasKey(s.hasKey)).catch(() => {});
  }, []);

  const save = async () => {
    if (!key.trim()) return;
    setSaving(true);
    await (window as any).ether.musixmatch.setKey(key.trim());
    setKey(""); setHasKey(true);
    setSaving(false); setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontSize: 13, color: hasKey ? "var(--accent-green)" : "var(--text-tertiary)", display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: hasKey ? "var(--accent-green)" : "var(--text-tertiary)", display: "inline-block" }} />
        {hasKey ? "API key saved — Lyrics Scanner is active" : "No key set — Lyrics Scanner disabled"}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input type="password" placeholder="Musixmatch API Key" value={key} onChange={e => setKey(e.target.value)} onKeyDown={e => { if (e.key === "Enter") save(); }}
          style={{ flex: 1, padding: "8px 12px", borderRadius: 0, fontSize: 12, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", fontFamily: "monospace" }} />
        <button onClick={save} disabled={saving} style={{ padding: "8px 18px", borderRadius: 0, fontSize: 12, fontWeight: 700, background: saved ? "var(--accent-green)" : "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer" }}>
          {saved ? "Saved ✓" : saving ? "Saving…" : "Save"}
        </button>
      </div>
      <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
        Stored in Electron safeStorage. Free tier supports 2,000 lyrics lookups/day. Flags are advisory only — you approve or reject each track.
      </div>
    </div>
  );
}

// ── Discogs credential form ───────────────────────────────────

// ── Icecast / Broadcast section ───────────────────────────────

const DEFAULT_PLAYOUT_SERVER = '44.244.52.207';

function CloudPlayoutSection() {
  const [icecastUp,      setIcecastUp]      = useState<boolean | null>(null);
  const [checking,       setChecking]       = useState(false);
  const [syncMsg,        setSyncMsg]        = useState<string>("");
  const [playoutServer,  setPlayoutServer]  = useState(DEFAULT_PLAYOUT_SERVER);
  const [editingServer,  setEditingServer]  = useState(false);
  const [serverDraft,    setServerDraft]    = useState('');
  const [stations,       setStations]       = useState<Array<{ id: number; name: string; icecast_mount: string; icecast_server_url?: string; }>>([]);
  const [stationStreams,  setStationStreams]  = useState<Record<number, { live: boolean; error?: string | null }>>({});
  // Real-time per-destination stream status (same source as the Icecast pill) — so a stream
  // started anywhere (e.g. the dashboard ON AIR button) reflects here, not just panel-started ones.
  const streamCtx = useStreamStatus();

  useEffect(() => {
    const ether = (window as any).ether;
    ether.invoke('playout:get-server').then((ip: string) => {
      if (ip) setPlayoutServer(ip);
    }).catch(() => {});
    (async () => {
      const list = await ether.stations.list();
      setStations(list || []);
      const status = await ether.invoke('stream:get-status');
      if (status?.stations) {
        const map: Record<number, { live: boolean }> = {};
        for (const s of status.stations) map[s.stationId] = { live: !!s.live };
        setStationStreams(map);
      }
    })();
    const h = ether.on('stream:status', (s: any) => {
      if (s?.stationId != null) {
        setStationStreams(prev => ({
          ...prev,
          [s.stationId]: { live: !!s.live, error: s.error || null },
        }));
      }
    });
    return () => ether.off('stream:status', h);
  }, []);

  const checkStatus = async () => {
    setChecking(true);
    try {
      const res = await fetch(`http://${playoutServer}:8000/`, { signal: AbortSignal.timeout(4000) });
      setIcecastUp(res.ok || res.status === 200 || res.status === 403);
    } catch {
      setIcecastUp(false);
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => { checkStatus(); }, [playoutServer]);

  const { goLive: doGoLive, stopLive: doStopLive } = useStreaming();

  const goLive = async (stationId: number) => {
    setStationStreams(prev => ({ ...prev, [stationId]: { ...prev[stationId], live: false, error: null } }));
    const res = await doGoLive(stationId);
    if (res.ok) {
      setSyncMsg(`✓ Streaming → ${res.server}:8000${res.mount}`);
    } else {
      setSyncMsg('✗ ' + (res.error || 'Failed to start stream'));
    }
  };

  const stopLive = async (stationId: number) => {
    await doStopLive(stationId);
    setSyncMsg('');
  };

  const saveServer = async () => {
    const ip = serverDraft.trim();
    if (!ip) return;
    await (window as any).ether.invoke('playout:set-server', ip);
    setPlayoutServer(ip);
    setEditingServer(false);
  };

  const statusColor = icecastUp === null ? "var(--text-tertiary)" : icecastUp ? "#22c55e" : "#ef4444";
  const statusLabel = icecastUp === null ? "CHECKING" : icecastUp ? "ONLINE" : "OFFLINE";

  return (
    <Section
      category="broadcast"
      icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12a5 5 0 0 0 5 5 8 8 0 0 1 5 2 8 8 0 0 1 5-2 5 5 0 0 0 5-5V7H2z"/><path d="M6 11V7"/><path d="M10 11V5"/><path d="M14 11V3"/><path d="M18 11V7"/></svg>}
      title="Broadcast"
      description="Stream Ether's output to Icecast so listeners can tune in"
    >
      {/* Server row — one Icecast server hosts all mounts */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, padding: "8px 12px", background: "var(--bg-secondary)", border: "1px solid var(--border-primary)" }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor, boxShadow: icecastUp ? `0 0 7px ${statusColor}` : "none", flexShrink: 0 }} />
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>
          {editingServer ? (
            <>
              <input
                value={serverDraft}
                onChange={e => setServerDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') saveServer(); if (e.key === 'Escape') setEditingServer(false); }}
                autoFocus
                style={{ fontSize: 12, fontWeight: 600, background: "var(--bg-tertiary)", border: "1px solid var(--accent-blue)", color: "var(--text-primary)", padding: "2px 6px", width: 160 }}
                placeholder="IP address"
              />
              <button onClick={saveServer} style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer" }}>Save</button>
              <button onClick={() => setEditingServer(false)} style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", background: "none", color: "var(--text-tertiary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>✕</button>
            </>
          ) : (
            <>
              <span>{playoutServer}</span>
              <span style={{ fontSize: 10, fontWeight: 700, color: statusColor, letterSpacing: "0.08em" }}>{statusLabel}</span>
              <button onClick={() => { setServerDraft(playoutServer); setEditingServer(true); }} style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", background: "none", color: "var(--text-tertiary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>Edit</button>
            </>
          )}
        </div>
        <button onClick={checkStatus} disabled={checking} style={{ padding: "3px 10px", fontSize: 11, fontWeight: 700, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer", flexShrink: 0 }}>
          {checking ? "…" : "Refresh"}
        </button>
      </div>

      {/* Per-station rows */}
      {stations.map(station => {
        // Live if EITHER the panel started it OR the real stream status (any source) reports it
        // live/connecting — fixes a stream started via the dashboard showing OFFLINE here.
        const destState = streamCtx.dests[`icecast:${station.id}`]?.state;
        const isLive = !!stationStreams[station.id]?.live || destState === "live" || destState === "connecting";
        const serverUrl = station.icecast_server_url?.trim() || playoutServer;
        const listenerUrl = `http://${serverUrl}:8000${station.icecast_mount}`;
        return (
          <div key={station.id} style={{ marginBottom: 10, padding: "12px 14px", background: "var(--bg-secondary)", border: `1px solid ${isLive ? "rgba(34,197,94,0.3)" : "var(--border-primary)"}` }}>
            {/* Station header */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: isLive ? "#22c55e" : "#6b7280", boxShadow: isLive ? "0 0 6px #22c55e" : "none", flexShrink: 0 }} />
              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>{station.name}</span>
              <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", letterSpacing: "0.08em", background: isLive ? "rgba(34,197,94,0.12)" : "rgba(107,114,128,0.12)", color: isLive ? "#22c55e" : "#6b7280" }}>
                {isLive ? "ONLINE" : "OFFLINE"}
              </span>
            </div>

            {/* Listener URL */}
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>Listener URL</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <code style={{ flex: 1, fontSize: 12, padding: "6px 10px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", userSelect: "all" }}>
                  {listenerUrl}
                </code>
                <button onClick={() => navigator.clipboard.writeText(listenerUrl)} style={{ padding: "5px 10px", fontSize: 11, fontWeight: 700, background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer", flexShrink: 0 }}>
                  Copy
                </button>
              </div>
            </div>

            {/* GO LIVE / STOP STREAM */}
            <button
              onClick={() => isLive ? stopLive(station.id) : goLive(station.id)}
              style={{
                width: "100%", padding: "10px 0", fontSize: 13, fontWeight: 800,
                letterSpacing: "0.06em", cursor: "pointer", border: "none",
                background: isLive ? "rgba(239,68,68,0.15)" : "rgba(34,197,94,0.15)",
                color: isLive ? "#f87171" : "#4ade80",
                outline: isLive ? "1px solid rgba(239,68,68,0.4)" : "1px solid rgba(34,197,94,0.4)",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              }}
            >
              {isLive && <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#f87171", display: "inline-block", boxShadow: "0 0 6px #f87171", animation: "pulse 1.2s infinite" }} />}
              {isLive ? "■  STOP STREAM" : "▶  GO LIVE — Stream to Icecast"}
            </button>
            {stationStreams[station.id]?.error && !isLive && (
              <div style={{
                marginTop: 8, fontSize: 11, color: "#f87171",
                padding: "6px 8px",
                background: "rgba(239,68,68,0.08)",
                border: "1px solid rgba(239,68,68,0.2)",
                lineHeight: 1.4,
              }}>
                {stationStreams[station.id]!.error}
              </div>
            )}
            <StreamStatusPill destId={`icecast:${station.id}`} />
          </div>
        );
      })}

      {syncMsg && (
        <div style={{
          fontSize: 12, fontWeight: 600,
          color: syncMsg.startsWith("✓") ? "#4ade80" : "#f87171",
          padding: "5px 10px",
          background: syncMsg.startsWith("✓") ? "rgba(34,197,94,0.08)" : "rgba(239,68,68,0.08)",
          border: `1px solid ${syncMsg.startsWith("✓") ? "rgba(34,197,94,0.2)" : "rgba(239,68,68,0.2)"}`,
        }}>
          {syncMsg}
        </div>
      )}
    </Section>
  );
}

// ── MIDI Controllers section ──────────────────────────────────

function ControllersSection() {
  const [devices,   setDevices]   = useState<string[]>([]);
  const [status,    setStatus]    = useState<{ connected: boolean; deviceName: string }>({ connected: false, deviceName: "" });
  const [scanning,  setScanning]  = useState(false);
  const [connecting,setConnecting]= useState("");
  const [testMsg,   setTestMsg]   = useState("");

  const scan = async () => {
    setScanning(true);
    try {
      const list = await invoke("controller_list_devices");
      setDevices(list ?? []);
      const st = await invoke("controller_get_status");
      setStatus(st ?? { connected: false, deviceName: "" });
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => { scan(); }, []);

  const connect = async (name: string) => {
    setConnecting(name);
    try {
      await invoke("controller_connect", { deviceName: name });
      const st = await invoke("controller_get_status");
      setStatus(st ?? { connected: false, deviceName: "" });
    } catch (e: any) {
      setTestMsg("Connect failed: " + e.message);
    } finally {
      setConnecting("");
    }
  };

  const disconnect = async () => {
    await invoke("controller_disconnect");
    const st = await invoke("controller_get_status");
    setStatus(st ?? { connected: false, deviceName: "" });
  };

  const testLed = async () => {
    for (let d = 1; d <= 2; d++) {
      await invoke("controller_set_led", { deck: d, control: "play", on: true });
      await invoke("controller_set_led", { deck: d, control: "cue",  on: true });
      await invoke("controller_set_led", { deck: d, control: "sync", on: true });
    }
    setTestMsg("LEDs lit — check your controller");
    setTimeout(async () => {
      for (let d = 1; d <= 2; d++) {
        await invoke("controller_set_led", { deck: d, control: "play", on: false });
        await invoke("controller_set_led", { deck: d, control: "cue",  on: false });
        await invoke("controller_set_led", { deck: d, control: "sync", on: false });
      }
      setTestMsg("");
    }, 2000);
  };

  const DOT: React.CSSProperties = {
    width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
    background: status.connected ? "#22c55e" : "var(--text-tertiary)",
    boxShadow:  status.connected ? "0 0 6px #22c55e" : "none",
  };

  return (
    <Section
      category="audio"
      icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="8" width="20" height="8" rx="2"/><line x1="6" y1="12" x2="6" y2="12"/><line x1="10" y1="12" x2="10" y2="12"/><line x1="14" y1="10" x2="14" y2="14"/><line x1="18" y1="10" x2="18" y2="14"/></svg>}
      title="Controllers"
      description="USB MIDI DJ controllers and mixers — Pioneer DDJ-1000SRT, Behringer X-TOUCH, RØDECaster Pro II"
    >
      {/* Connection status */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <div style={DOT} />
        <span style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 600 }}>
          {status.connected ? status.deviceName : "No controller connected"}
        </span>
        {status.connected && (
          <button onClick={disconnect} style={{ marginLeft: "auto", padding: "4px 12px", fontSize: 11, fontWeight: 700, background: "rgba(239,68,68,0.1)", color: "#f87171", border: "1px solid rgba(239,68,68,0.25)", cursor: "pointer" }}>
            Disconnect
          </button>
        )}
      </div>

      {/* Device list */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            MIDI Input Devices ({devices.length})
          </span>
          <button onClick={scan} disabled={scanning} style={{ padding: "3px 10px", fontSize: 11, fontWeight: 700, background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>
            {scanning ? "Scanning…" : "Refresh"}
          </button>
        </div>

        {devices.length === 0 ? (
          <div style={{ padding: "16px 0", textAlign: "center", color: "var(--text-tertiary)", fontSize: 13 }}>
            No MIDI devices found — connect a controller via USB and click Refresh
          </div>
        ) : (
          devices.map(name => {
            const isActive = status.connected && status.deviceName === name;
            return (
              <div key={name} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", marginBottom: 4, background: isActive ? "rgb(from var(--accent-blue) r g b / 0.06)" : "var(--bg-secondary)", border: `1px solid ${isActive ? "rgb(from var(--accent-blue) r g b / 0.25)" : "var(--border-primary)"}` }}>
                <span style={{ flex: 1, fontSize: 13, color: "var(--text-primary)" }}>{name}</span>
                {isActive ? (
                  <span style={{ fontSize: 11, fontWeight: 700, color: "var(--accent-blue)", letterSpacing: "0.05em" }}>CONNECTED</span>
                ) : (
                  <button
                    onClick={() => connect(name)}
                    disabled={!!connecting}
                    style={{ padding: "3px 12px", fontSize: 11, fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer", opacity: connecting ? 0.5 : 1 }}
                  >
                    {connecting === name ? "Connecting…" : "Connect"}
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Test button */}
      {status.connected && (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button onClick={testLed} style={{ padding: "6px 16px", fontSize: 12, fontWeight: 700, background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>
            Test LEDs
          </button>
          {testMsg && <span style={{ fontSize: 12, color: "var(--accent-blue)" }}>{testMsg}</span>}
        </div>
      )}

      {/* Soft takeover note */}
      <div style={{ marginTop: 12, fontSize: 12, color: "var(--text-tertiary)", lineHeight: 1.5 }}>
        Soft takeover active — physical faders only take control once they catch up to the software position (±2%).
      </div>
    </Section>
  );
}

function DiscogsCredentialForm() {
  const [consumerKey, setConsumerKey]       = useState("");
  const [consumerSecret, setConsumerSecret] = useState("");
  const [status, setStatus]                 = useState<{ hasKey: boolean; hasSecret: boolean } | null>(null);
  const [saving, setSaving]                 = useState(false);
  const [saved, setSaved]                   = useState(false);

  useEffect(() => {
    (window as any).ether.discogs.getCredentialStatus().then(setStatus).catch(() => {});
  }, []);

  const save = async () => {
    if (!consumerKey.trim() && !consumerSecret.trim()) return;
    setSaving(true);
    await (window as any).ether.discogs.setCredentials(consumerKey.trim(), consumerSecret.trim());
    setStatus({ hasKey: true, hasSecret: true });
    setConsumerKey(""); setConsumerSecret("");
    setSaving(false); setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const inputStyle: React.CSSProperties = {
    flex: 1, padding: "8px 12px", borderRadius: 0, fontSize: 12,
    background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
    color: "var(--text-primary)", outline: "none", fontFamily: "monospace",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {status && (
        <div style={{ display: "flex", gap: 16, marginBottom: 4 }}>
          <span style={{ fontSize: 13, color: status.hasKey ? "var(--accent-green)" : "var(--text-tertiary)", display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: status.hasKey ? "var(--accent-green)" : "var(--text-tertiary)", display: "inline-block" }} />
            Consumer Key {status.hasKey ? "saved" : "not set"}
          </span>
          <span style={{ fontSize: 13, color: status.hasSecret ? "var(--accent-green)" : "var(--text-tertiary)", display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: status.hasSecret ? "var(--accent-green)" : "var(--text-tertiary)", display: "inline-block" }} />
            Consumer Secret {status.hasSecret ? "saved" : "not set"}
          </span>
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <input type="password" placeholder="Consumer Key" value={consumerKey} onChange={e => setConsumerKey(e.target.value)} style={inputStyle} />
        <input type="password" placeholder="Consumer Secret" value={consumerSecret} onChange={e => setConsumerSecret(e.target.value)} style={inputStyle} onKeyDown={e => { if (e.key === "Enter") save(); }} />
        <button onClick={save} disabled={saving} style={{ padding: "8px 18px", borderRadius: 0, fontSize: 12, fontWeight: 700, background: saved ? "var(--accent-green)" : "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer" }}>
          {saved ? "Saved ✓" : saving ? "Saving…" : "Save"}
        </button>
      </div>
      <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
        Credentials stored securely. Get your keys at{" "}
        <a href="#" onClick={e => { e.preventDefault(); (window as any).ether.system.openUrl("https://www.discogs.com/settings/developers"); }} style={{ color: "#c4b5fd", textDecoration: "underline" }}>discogs.com/settings/developers</a>
        {" "}— create an app, use Consumer Key + Consumer Secret.
      </div>
    </div>
  );
}

// ── Multi-Device Sync ─────────────────────────────────────────

// RBAC foundation (read-only): the accounts + stations this person can access via their sign-in.
// Listing only — operating a cross-account station (syncing its data) is the flagged sync bridge (Plan A).
function AccessibleAccountsSection() {
  const [memberships, setMemberships] = useState<Membership[]>([]);
  useEffect(() => { fetchMyMemberships().then(setMemberships).catch(() => {}); }, []);
  if (memberships.length === 0) return null;
  return (
    <Section category="system"
      icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>}
      title="Accounts You Can Access"
      description="Accounts and stations your sign-in gives you access to. Listing only for now — operating another account's station arrives with the sync bridge.">
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {memberships.map((m) => (
          <div key={m.account_id} style={{ border: "1px solid var(--border-primary)", padding: "12px 14px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>{m.account_name || m.account_email}</div>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" as any, color: "var(--text-tertiary)" }}>{m.position}</span>
            </div>
            {m.stations.length === 0
              ? <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>No stations.</div>
              : m.stations.map((st) => (
                <div key={st.uuid} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", fontSize: 12, color: "var(--text-secondary)" }}>
                  <span style={{ flex: 1 }}>{st.name}</span>
                  <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>{st.can_edit === false ? "read-only" : "can edit"}</span>
                </div>
              ))}
          </div>
        ))}
      </div>
    </Section>
  );
}

function SyncSection() {
  const { stationId } = useActiveStation();
  const { isStation, plan } = usePlan();   // Multi-Device Sync is a NETWORK-tier feature only
  const [enabled, setEnabled]   = useState(false);
  const [dirty, setDirty]       = useState(false);
  const [stats, setStats]       = useState<{
    running: boolean;
    lastSyncAt: string | null;
    pushedToday: number;
    pulledToday: number;
  }>({ running: false, lastSyncAt: null, pushedToday: 0, pulledToday: 0 });
  const [devices, setDevices] = useState<{ machine_id: string; machine_name: string | null; os: string | null; last_seen: string | null }[]>([]);
  const [thisId, setThisId]   = useState<string | null>(null);
  const [devLimit, setDevLimit] = useState<number | null>(null);
  const [devErr, setDevErr]   = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const loadDevices = () => {
    (window as any).ether.invoke('sync:devices').then((r: any) => {
      if (r?.ok) { setDevices(r.devices || []); setThisId(r.thisMachineId || null); setDevLimit(r.limit ?? null); setDevErr(null); }
      else setDevErr(r?.error || 'Could not load devices');
    }).catch((e: any) => setDevErr(String(e?.message || e)));
  };

  const removeDevice = async (machineId: string) => {
    setRemovingId(machineId);
    try {
      const r = await (window as any).ether.invoke('sync:removeDevice', machineId);
      if (!r?.ok) setDevErr(r?.error || 'Could not remove device');
      else { setConfirmRemoveId(null); loadDevices(); }
    } catch (e: any) { setDevErr(String(e?.message || e)); }
    finally { setRemovingId(null); }
  };

  useEffect(() => {
    (window as any).ether.invoke('sync:getStats').then((s: any) => {
      setEnabled(!!s?.enabled);
      setStats({
        running:     !!s?.running,
        lastSyncAt:  s?.lastSyncAt ?? null,
        pulledToday: s?.pulledToday ?? 0,
        pushedToday: s?.pushedToday ?? 0,
      });
    }).catch(() => {});
    (window as any).ether.invoke('sync:devices').then((r: any) => {
      if (r?.ok) { setDevices(r.devices || []); setThisId(r.thisMachineId || null); setDevLimit(r.limit ?? null); }
      else setDevErr(r?.error || 'Could not load devices');
    }).catch((e: any) => setDevErr(String(e?.message || e)));
  }, []);

  const toggle = async () => {
    const next = !enabled;
    setEnabled(next);
    setDirty(true);
    if (stationId != null) {
      await (window as any).ether.stationConfigKv.upsertByKey(
        stationId, 'sync_enabled', next ? 'true' : 'false'
      ).catch(() => {});
    }
  };

  const fmtTime = (iso: string | null) => {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch (_) { return iso; }
  };

  const shouldRender = useShouldRender('Multi-Device Sync', 'Keep multiple Ether installs in sync via the cloud backend', 'system');
  if (!shouldRender) return null;

  return (
    <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", overflow: "hidden", marginBottom: 12 }}>
      <div style={{ padding: "18px 20px 14px", borderBottom: "1px solid var(--border-primary)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ display: "flex", alignItems: "center", color: "var(--text-tertiary)" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 1l4 4-4 4"/>
              <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
              <path d="M7 23l-4-4 4-4"/>
              <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
            </svg>
          </span>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", letterSpacing: "-0.02em", fontFamily: "'Inter', sans-serif" }}>Multi-Device Sync</div>
            <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginTop: 2 }}>Keep multiple Ether installs in sync via the cloud backend</div>
          </div>
        </div>
      </div>
      <div style={{ padding: "16px 20px" }}>
        {!isStation ? (
          <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6 }}>
            Multi-Device Sync is a <b style={{ color: "var(--accent-blue)" }}>Network</b>-plan feature{plan ? <> (your plan: <b>{plan}</b>)</> : null}. It keeps multiple Ether installs — your studio, a backup PC, a remote board op — in sync across the cloud, and lets a new install pull your whole station down. Upgrade to Network to turn it on.
          </div>
        ) : (
        <>
        <SettingRow label="Enable sync" hint="Pushes and pulls mutations every 5 seconds. Requires an active Network license.">
          <Toggle value={enabled} onChange={toggle} label="" />
        </SettingRow>

        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
            <span style={{ color: "var(--text-tertiary)" }}>Status</span>
            <span style={{ color: stats.running ? "var(--accent-green)" : "var(--text-tertiary)" }}>
              {stats.running ? "Running" : enabled ? "Starts on next launch" : "Disabled"}
            </span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
            <span style={{ color: "var(--text-tertiary)" }}>Last sync</span>
            <span style={{ color: "var(--text-secondary)" }}>{fmtTime(stats.lastSyncAt)}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
            <span style={{ color: "var(--text-tertiary)" }}>Pushed today</span>
            <span style={{ color: "var(--text-secondary)" }}>{stats.pushedToday}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
            <span style={{ color: "var(--text-tertiary)" }}>Pulled today</span>
            <span style={{ color: "var(--text-secondary)" }}>{stats.pulledToday}</span>
          </div>
        </div>

        {/* Synced devices — which computers are on this account + when each was last seen */}
        <div style={{ marginTop: 16, borderTop: "1px solid var(--border-primary)", paddingTop: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 8 }}>
            Synced devices{devLimit ? ` · ${devices.length}/${devLimit}` : devices.length ? ` · ${devices.length}` : ""}
          </div>
          {devErr ? (
            <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic" }}>{devErr}</div>
          ) : devices.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic" }}>No other devices yet — this is your only install.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {devices.map(d => {
                const isMe = d.machine_id === thisId;
                const seenMs = d.last_seen ? Date.now() - new Date(d.last_seen).getTime() : Infinity;
                const online = seenMs < 2 * 60 * 1000;
                const seenLabel = !d.last_seen ? "—"
                  : online ? "online"
                  : seenMs < 3600e3   ? `${Math.round(seenMs / 60000)}m ago`
                  : seenMs < 86400e3  ? `${Math.round(seenMs / 3600e3)}h ago`
                  : `${Math.round(seenMs / 86400e3)}d ago`;
                return (
                  <div key={d.machine_id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", background: "var(--bg-tertiary)", border: `1px solid ${isMe ? "var(--accent-blue)" : "var(--border-primary)"}` }}>
                    <span style={{ fontSize: 16 }}>🖥</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {d.machine_name || d.machine_id.slice(0, 12)}{isMe ? <span style={{ color: "var(--accent-blue)", fontWeight: 600 }}> · this machine</span> : ""}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{d.os || "—"}</div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: online ? "var(--accent-green)" : "var(--text-tertiary)" }} />
                      <span style={{ fontSize: 11, color: online ? "var(--accent-green)" : "var(--text-tertiary)" }}>{seenLabel}</span>
                      {!isMe && (confirmRemoveId === d.machine_id ? (
                        <span style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: 4 }}>
                          <button onClick={() => removeDevice(d.machine_id)} disabled={removingId === d.machine_id}
                            style={{ fontSize: 11, fontWeight: 700, padding: "3px 8px", background: "var(--accent-red, #e0484a)", color: "#fff", border: "none", borderRadius: 4, cursor: removingId === d.machine_id ? "wait" : "pointer" }}>
                            {removingId === d.machine_id ? "Removing…" : "Remove"}
                          </button>
                          <button onClick={() => setConfirmRemoveId(null)} disabled={removingId === d.machine_id}
                            style={{ fontSize: 11, padding: "3px 8px", background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", borderRadius: 4, cursor: "pointer" }}>
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button onClick={() => setConfirmRemoveId(d.machine_id)} title="Remove this device from the account"
                          style={{ marginLeft: 4, width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", color: "var(--text-tertiary)", border: "1px solid var(--border-primary)", borderRadius: 4, cursor: "pointer", fontSize: 13, lineHeight: 1 }}>
                          ✕
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* What syncs */}
        <div style={{ marginTop: 14, borderTop: "1px solid var(--border-primary)", paddingTop: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 6 }}>What syncs</div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.6 }}>
            Your <b>library, clocks, shows, categories, schedule, and settings</b> (the database) sync across every device above.
            <br /><span style={{ color: "var(--text-tertiary)" }}>Audio files sync separately via Cloud Backup.</span>
          </div>
        </div>

        {/* How to add a device */}
        <div style={{ marginTop: 14, padding: "10px 12px", background: "rgba(96,128,192,0.08)", border: "1px solid rgba(96,128,192,0.25)", fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.6 }}>
          <b>Add a device:</b> install Ether on another computer and sign in with this account — it appears here automatically and syncs both ways.
        </div>

        {dirty && (
          <div style={{ marginTop: 14, padding: "8px 12px", background: "rgba(234,179,8,0.1)", border: "1px solid rgba(234,179,8,0.3)", fontSize: 12, color: "var(--accent-amber)" }}>
            Restart Ether to apply this change
          </div>
        )}
        </>
        )}
      </div>
    </div>
  );
}

// ── Keep My Station On Air (HA auto-logon — Phase 4) ─────────
// Opt-in, default OFF. Enabling registers the per-user watchdog task AND
// configures Windows auto-logon (one UAC prompt → elevated ha-setup.exe writes
// the HKLM Winlogon values + the LSA password secret). Disabling clears all of it.
// The password is sent to main over IPC and on to the helper via a named pipe;
// Ether never writes it to disk.

function StatusLine({ label, ok, on, off }: { label: string; ok: boolean; on: string; off: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
      <span style={{ color: "var(--text-tertiary)" }}>{label}</span>
      <span style={{ color: ok ? "var(--accent-green)" : "var(--text-tertiary)" }}>{ok ? on : off}</span>
    </div>
  );
}

function KeepOnAirSection() {
  const ether = (window as any).ether;
  const [dash, setDash] = useState<any>(null);
  const [entering, setEntering] = useState(false);   // password form is showing
  const [repairing, setRepairing] = useState(false); // form was opened by Repair
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { const d = await ether?.ha?.dashboard(); if (d) setDash(d); } catch { /* IPC unavailable */ }
  }, [ether]);
  useEffect(() => {
    load();
    const id = setInterval(() => { if (!document.hidden) load(); }, 5000);
    return () => clearInterval(id);
  }, [load]);

  const ha = dash?.ha;
  const supported = ha ? !!ha.supported : true;
  const configured = !!ha?.config?.autologon;
  const user = ha?.config?.user || ha?.currentUser || "your Windows account";
  const toggleOn = configured || entering;

  const onToggle = (v: boolean) => {
    setError(null);
    if (v) { if (!configured) { setRepairing(false); setEntering(true); } }
    else if (configured) { doDisable(); }
    else { setEntering(false); setPassword(""); }
  };

  const submit = async () => {
    if (!password) { setError("Enter your Windows password."); return; }
    setBusy(repairing ? "repair" : "enable"); setError(null);
    const r = repairing ? await ether.ha.repair(password) : await ether.ha.enable(password);
    setBusy(null);
    if (r?.ok) { setPassword(""); setEntering(false); setRepairing(false); load(); }
    else setError(r?.error || "Could not configure automatic logon.");
  };

  const doDisable = async () => {
    setBusy("disable"); setError(null);
    const r = await ether.ha.disable();
    setBusy(null); setEntering(false); setPassword("");
    if (!r?.ok) setError(r?.autologon?.error || r?.error || "Could not fully disable — check the status below.");
    load();
  };

  const startRepair = () => { setError(null); setRepairing(true); setEntering(true); setPassword(""); };
  const cancel = () => { setEntering(false); setRepairing(false); setPassword(""); setError(null); };

  const inputStyle = { padding: "7px 12px", borderRadius: 0, fontSize: 12, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", width: 220 } as const;
  const btn = (bg: string, fg = "#fff", border = "none") => ({ padding: "8px 18px", borderRadius: 0, fontSize: 12, fontWeight: 600, background: bg, color: fg, border, cursor: "pointer", opacity: busy ? 0.6 : 1 } as const);

  return (
    <Section
      category="system"
      icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>}
      title="Keep My Station On Air"
      description="Automatically restart after a crash, and log back in after a reboot."
    >
      {!supported ? (
        <div style={{ fontSize: 13, color: "var(--text-tertiary)" }}>Automatic recovery is available on Windows only.</div>
      ) : (
        <>
          <Toggle value={toggleOn} onChange={onToggle} label="Enable auto-recovery after reboot" />
          <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginTop: 6, marginLeft: 52 }}>
            Restarts Ether if it crashes, and logs Windows back in automatically after a reboot so the station returns to air unattended.
          </div>

          {entering && (
            <div style={{ marginTop: 14, marginLeft: 52 }}>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 6 }}>Windows password for <code>{user}</code></div>
              <div style={{ display: "flex", gap: 8 }}>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Windows password"
                  style={inputStyle} onKeyDown={e => { if (e.key === "Enter") submit(); }} autoFocus />
                <button onClick={submit} disabled={!!busy} style={btn("var(--accent-blue)")}>
                  {busy ? "Configuring…" : repairing ? "Re-apply" : "Enable"}
                </button>
                <button onClick={cancel} disabled={!!busy} style={btn("var(--bg-tertiary)", "var(--text-secondary)", "1px solid var(--border-primary)")}>Cancel</button>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 8, maxWidth: 470, lineHeight: 1.5 }}>
                Used once to set up automatic logon. Ether never stores it — it's written to Windows' encrypted secret store. ⚠ Anyone who reboots this PC will then land in your logged-in Windows session without a password.
              </div>
            </div>
          )}

          {error && <div style={{ marginTop: 12, marginLeft: 52, fontSize: 12, color: "var(--accent-red)" }}>{error}</div>}

          {ha && (
            <div style={{ marginTop: 16, marginLeft: 52, display: "flex", flexDirection: "column", gap: 6, maxWidth: 380 }}>
              <StatusLine label="Automatic logon" ok={configured} on="Configured" off="Not configured" />
              <StatusLine label="Startup task" ok={!!ha.startup?.registered} on="Registered" off="Not registered" />
              <StatusLine label="Watchdog" ok={!!ha.watchdog?.alive} on="Running" off="Not running" />
              {ha.alarm && <div style={{ fontSize: 12, color: "var(--accent-red)" }}>⚠ Crash-loop alarm tripped — see Station Health.</div>}
            </div>
          )}

          {configured && !entering && (
            <div style={{ marginTop: 16, marginLeft: 52, display: "flex", gap: 8 }}>
              <button onClick={startRepair} disabled={!!busy} style={btn("var(--bg-tertiary)", "var(--text-secondary)", "1px solid var(--border-primary)")}>Repair</button>
              <button onClick={doDisable} disabled={!!busy} style={btn("var(--accent-red)")}>{busy === "disable" ? "Disabling…" : "Disable"}</button>
            </div>
          )}
        </>
      )}
    </Section>
  );
}

// ── Public Listener Page config (Phase 2) ────────────────────
// Writes station_metadata on the backend via ether.station.metadata.* (license-
// key auth). Slug gets instant client validation + a debounced server check;
// the backend is the gatekeeper on save. Logo is resized client-side (canvas)
// then uploaded through main → R2. Save is blocked when the backend is
// unreachable (error + retry; no offline queue).

function publicPageErrText(code?: string): string {
  switch (code) {
    case "slug_taken": case "taken":        return "That address is already taken.";
    case "slug_invalid": case "invalid":    return "Use 2–32 lowercase letters, numbers, or hyphens.";
    case "slug_reserved": case "reserved":  return "That name is reserved — pick another.";
    case "slug_required_for_public":        return "Choose an address before making the page public.";
    case "station_not_found_or_not_owned":  return "This station isn't linked to your account.";
    case "no_license": case "invalid_license_key": return "Reconnect your account to manage your public page.";
    case "logo_storage_unconfigured":       return "Logo uploads aren't set up yet — try again later.";
    case "network":                         return "Can't reach Ether — check your connection and try again.";
    default: return code ? `Error: ${code}` : "Something went wrong.";
  }
}

// Downscale to `max` px on the longest side, prefer WebP (PNG fallback).
// Returns the bytes + extension for upload. Throws on >5MB or unsupported input.
async function resizeLogo(file: File, max = 512): Promise<{ bytes: Uint8Array; ext: string }> {
  if (file.size > 5 * 1024 * 1024) throw new Error("Image is too large (max 5 MB).");
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("That file isn't a supported image."));
      i.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not process image.");
    ctx.drawImage(img, 0, 0, w, h);
    let blob: Blob | null = await new Promise(res => canvas.toBlob(res, "image/webp", 0.9));
    if (!blob) blob = await new Promise(res => canvas.toBlob(res, "image/png"));
    if (!blob) throw new Error("Could not process image.");
    const ext = blob.type === "image/webp" ? "webp" : "png";
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { bytes, ext };
  } finally {
    URL.revokeObjectURL(url);
  }
}

const SOCIAL_FIELDS: { key: string; label: string; placeholder: string }[] = [
  { key: "website",   label: "Website",   placeholder: "https://yourstation.com" },
  { key: "instagram", label: "Instagram", placeholder: "https://instagram.com/…" },
  { key: "twitter",   label: "Twitter/X", placeholder: "https://x.com/…" },
  { key: "facebook",  label: "Facebook",  placeholder: "https://facebook.com/…" },
  { key: "youtube",   label: "YouTube",   placeholder: "https://youtube.com/@…" },
];

// Where the listener PWA is served (Cloudflare Pages → listen.ether-technologies.com).
const LISTENER_BASE_URL = "https://listen.ether-technologies.com";
// Managed Ether streaming edge — the public listener page only needs the mount name appended.
const STREAM_PREFIX = "https://stream.ether-technologies.com:8443/";

const EMPTY_PUBLIC_PAGE = {
  slug: "", display_name: "", logo_url: "", stream_url: "",
  color_primary: "var(--accent-blue)", color_secondary: "var(--accent-blue)", description: "",
  socials: { website: "", instagram: "", twitter: "", facebook: "", youtube: "" } as Record<string, string>,
  links: [] as { label: string; url: string }[],
  public_enabled: false,
};

export function PublicPageEditor({ stationUuid, stationName }: { stationUuid: string; stationName: string }) {
  const ether = (window as any).ether;
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [form, setForm]       = useState<any>(EMPTY_PUBLIC_PAGE);
  const [loaded, setLoaded]   = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [logoBusy, setLogoBusy] = useState(false);
  const [copied, setCopied]   = useState(false);
  const [msg, setMsg]         = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [slugState, setSlugState] = useState<{ status: "idle" | "checking" | "ok" | "bad"; reason?: string }>({ status: "idle" });

  // Initial load of the saved metadata.
  useEffect(() => {
    if (!stationUuid) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      setLoading(true); setMsg(null);
      const r = await ether?.station?.metadata?.get(stationUuid);
      if (cancelled) return;
      if (r?.ok) {
        const m = r.metadata || {};
        const norm = {
          slug: m.slug || "", display_name: m.display_name || "", logo_url: m.logo_url || "",
          stream_url: m.stream_url || "",
          color_primary: m.color_primary || "var(--accent-blue)", color_secondary: m.color_secondary || "var(--accent-blue)",
          description: m.description || "",
          socials: { ...EMPTY_PUBLIC_PAGE.socials, ...(m.socials || {}) },
          links: Array.isArray(m.links) ? m.links.map((l: any) => ({ label: l?.label || "", url: l?.url || "" })) : [],
          public_enabled: !!m.public_enabled,
        };
        setLoaded(norm);
        // Suggest a slug if none set yet.
        if (!norm.slug) {
          const sug = slugify(norm.display_name || stationName || "");
          setForm(validateSlug(sug).ok ? { ...norm, slug: sug } : norm);
        } else {
          setForm(norm);
        }
      } else {
        setMsg({ kind: "err", text: publicPageErrText(r?.error) });
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [stationUuid]);

  // Debounced slug check (client validate first, then server).
  useEffect(() => {
    const slug = (form.slug || "").trim().toLowerCase();
    if (!slug) { setSlugState({ status: "idle" }); return; }
    if (loaded && slug === loaded.slug) { setSlugState({ status: "ok" }); return; } // own current slug
    const v = validateSlug(slug);
    if (!v.ok) { setSlugState({ status: "bad", reason: v.reason }); return; }
    setSlugState({ status: "checking" });
    const t = setTimeout(async () => {
      const r = await ether?.station?.metadata?.checkSlug(slug, stationUuid);
      if (r?.ok) setSlugState(r.available ? { status: "ok" } : { status: "bad", reason: r.reason || "taken" });
      else setSlugState({ status: "bad", reason: r?.error || "network" });
    }, 400);
    return () => clearTimeout(t);
  }, [form.slug, loaded, stationUuid]);

  const dirty = !!loaded && JSON.stringify(form) !== JSON.stringify(loaded);
  const slugOk = !form.slug || slugState.status === "ok";
  const canSave = !saving && dirty && slugOk && (!form.public_enabled || !!form.slug);

  const setField  = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));
  const setSocial = (k: string, v: string) => setForm((f: any) => ({ ...f, socials: { ...f.socials, [k]: v } }));
  const setLink   = (i: number, k: "label" | "url", v: string) => setForm((f: any) => ({ ...f, links: (f.links || []).map((l: any, idx: number) => idx === i ? { ...l, [k]: v } : l) }));
  const addLink   = () => setForm((f: any) => ({ ...f, links: [...(f.links || []), { label: "", url: "" }] }));
  const removeLink = (i: number) => setForm((f: any) => ({ ...f, links: (f.links || []).filter((_: any, idx: number) => idx !== i) }));

  const save = async () => {
    setSaving(true); setMsg(null);
    const r = await ether?.station?.metadata?.save(stationUuid, {
      slug: form.slug ? form.slug.trim().toLowerCase() : null,
      display_name: form.display_name || null,
      logo_url: form.logo_url || null,
      color_primary: form.color_primary || null,
      color_secondary: form.color_secondary || null,
      description: form.description || null,
      stream_url: form.stream_url || null,
      socials: form.socials,
      links: (form.links || []).filter((l: any) => (l.label || "").trim() && (l.url || "").trim()),
      public_enabled: !!form.public_enabled,
    });
    setSaving(false);
    if (r?.ok) {
      const m = r.metadata || {};
      const norm = { ...form, slug: m.slug || "", logo_url: m.logo_url || form.logo_url };
      setLoaded(norm); setForm(norm);
      setMsg({ kind: "ok", text: "Saved" });
      setTimeout(() => setMsg(m2 => (m2?.kind === "ok" ? null : m2)), 2500);
    } else {
      setMsg({ kind: "err", text: publicPageErrText(r?.error) });
    }
  };

  const onLogoFile = async (file?: File) => {
    if (!file) return;
    setLogoBusy(true); setMsg(null);
    try {
      const { bytes, ext } = await resizeLogo(file, 512);
      const r = await ether?.station?.metadata?.uploadLogo(stationUuid, bytes, ext);
      if (r?.ok) setField("logo_url", `${r.public_url}?t=${Date.now()}`); // cache-bust the preview
      else setMsg({ kind: "err", text: publicPageErrText(r?.error) });
    } catch (e: any) {
      setMsg({ kind: "err", text: e?.message || "Could not process image." });
    }
    setLogoBusy(false);
  };

  // The live listener URL reflects what's actually PUBLISHED (last saved), not
  // unsaved form edits — so we never advertise a URL that would 404.
  const published = !!loaded?.public_enabled && !!loaded?.slug;
  const liveUrl = published ? `${LISTENER_BASE_URL}/${loaded.slug}` : null;
  // Stream URL is entered like the address: a fixed prefix + just the mount name. Strip the
  // managed prefix (or any scheme://host/) so the input shows only the editable mount.
  const streamMount = (() => {
    const s = form.stream_url || "";
    if (s.startsWith(STREAM_PREFIX)) return s.slice(STREAM_PREFIX.length);
    const m = s.match(/^https?:\/\/[^/]+\/(.*)$/i);
    return m ? m[1] : s;
  })();
  const copyUrl = async () => {
    if (!liveUrl) return;
    try { await navigator.clipboard.writeText(liveUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  };
  const openUrl = () => {
    if (!liveUrl) return;
    const sys = (window as any).ether?.system;
    if (sys?.openUrl) sys.openUrl(liveUrl); else window.open(liveUrl, "_blank");
  };

  if (!stationUuid) return null;

  const inputStyle = { padding: "7px 12px", borderRadius: 0, fontSize: 12, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", width: "100%", boxSizing: "border-box" as const };
  const linkBtn = { padding: "5px 12px", borderRadius: 0, fontSize: 11, fontWeight: 600, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" } as const;
  const slugColor = slugState.status === "ok" ? "var(--accent-green)" : slugState.status === "bad" ? "var(--accent-red)" : "var(--text-tertiary)";
  const slugMsg = slugState.status === "checking" ? "Checking…"
    : slugState.status === "ok" ? "Available"
    : slugState.status === "bad" ? publicPageErrText(slugState.reason)
    : "";

  return (
    <div>
      {loading ? (
        <div style={{ fontSize: 12, color: "var(--text-tertiary)", padding: "8px 0" }}>Loading…</div>
      ) : (
        <>
          <div style={{ marginBottom: 16 }}>
            <Toggle value={form.public_enabled} onChange={(v: boolean) => setField("public_enabled", v)} label="Publish a public listener page" />
            <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginTop: 6, marginLeft: 52 }}>
              When on, anyone with your link can open your station's player. Requires an address below.
            </div>
          </div>

          <SettingRow label="Your listener page">
            {published ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" as const }}>
                <code style={{ fontSize: 14, fontFamily: "'DM Mono', monospace", color: "#c4b5fd", wordBreak: "break-all" as const }}>{liveUrl}</code>
                <button onClick={copyUrl} style={linkBtn}>{copied ? "Copied!" : "Copy"}</button>
                <button onClick={openUrl} style={linkBtn}>Open</button>
              </div>
            ) : (
              <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>Enable above and set an address to publish your listener page.</span>
            )}
          </SettingRow>

          <SettingRow label="Address" hint="listen.ether-technologies.com/your-slug">
            <div style={{ width: 280 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>/</span>
                <input value={form.slug} onChange={e => setField("slug", e.target.value.toLowerCase())} placeholder="your-station" style={inputStyle} />
              </div>
              {slugMsg && <div style={{ fontSize: 10, color: slugColor, marginTop: 4 }}>{slugMsg}</div>}
            </div>
          </SettingRow>

          <SettingRow label="Display name" hint="Shown on the page (can differ from your station name)">
            <input value={form.display_name} onChange={e => setField("display_name", e.target.value)} placeholder={stationName || "My Radio Station"} style={{ ...inputStyle, width: 280 }} />
          </SettingRow>

          <SettingRow label="Stream URL" hint="Your stream's mount — the name at the end of your Broadcast (Icecast) URL">
            <div style={{ width: 360 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 11, color: "var(--text-tertiary)", whiteSpace: "nowrap" as const }}>stream.ether-technologies.com:8443/</span>
                <input
                  value={streamMount}
                  onChange={e => {
                    const mount = e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "");
                    setField("stream_url", mount ? `${STREAM_PREFIX}${mount}` : "");
                  }}
                  placeholder="usph"
                  style={{ ...inputStyle, flex: 1, minWidth: 0 }}
                />
              </div>
            </div>
          </SettingRow>

          <SettingRow label="Logo" hint="PNG/JPG/WebP — resized to 512px">
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              {form.logo_url
                ? <img src={form.logo_url} alt="logo" style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 0, border: "1px solid var(--border-primary)" }} />
                : <div style={{ width: 48, height: 48, border: "1px dashed var(--border-primary)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: "var(--text-tertiary)" }}>none</div>}
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: "none" }} onChange={e => onLogoFile(e.target.files?.[0])} />
              <button onClick={() => fileRef.current?.click()} disabled={logoBusy} style={{ padding: "7px 14px", borderRadius: 0, fontSize: 12, fontWeight: 600, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: logoBusy ? "wait" : "pointer" }}>
                {logoBusy ? "Uploading…" : form.logo_url ? "Replace" : "Upload"}
              </button>
            </div>
          </SettingRow>

          <SettingRow label="Colors" hint="Primary and secondary brand colors">
            <div style={{ display: "flex", gap: 16 }}>
              {(["color_primary", "color_secondary"] as const).map(k => (
                <div key={k} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <input type="color" value={form[k]} onChange={e => setField(k, e.target.value)} style={{ width: 32, height: 28, padding: 0, border: "1px solid var(--border-primary)", background: "none", cursor: "pointer" }} />
                  <input value={form[k]} onChange={e => setField(k, e.target.value)} style={{ ...inputStyle, width: 90 }} />
                </div>
              ))}
            </div>
          </SettingRow>

          <SettingRow label="Description" hint="A short tagline for your station">
            <textarea value={form.description} onChange={e => setField("description", e.target.value)} rows={2} placeholder="The best mix in town." style={{ ...inputStyle, width: 360, resize: "vertical" as const, fontFamily: "inherit" }} />
          </SettingRow>

          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", color: "var(--text-tertiary)", textTransform: "uppercase" as const, margin: "16px 0 8px" }}>Social Links</div>
          {SOCIAL_FIELDS.map(s => (
            <SettingRow key={s.key} label={s.label}>
              <input value={form.socials[s.key] || ""} onChange={e => setSocial(s.key, e.target.value)} placeholder={s.placeholder} style={{ ...inputStyle, width: 360 }} />
            </SettingRow>
          ))}

          {/* Named links — buttons on the listener page (e.g. a Donate link). */}
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", color: "var(--text-tertiary)", textTransform: "uppercase" as const, margin: "16px 0 6px" }}>Links</div>
          <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 10 }}>Named buttons shown on your listener page — e.g. a “Donate” link to your cause.</div>
          {(form.links || []).map((l: { label: string; url: string }, i: number) => (
            <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
              <input value={l.label} onChange={e => setLink(i, "label", e.target.value)} placeholder="Label (e.g. Donate)" style={{ ...inputStyle, width: 150 }} />
              <input value={l.url} onChange={e => setLink(i, "url", e.target.value)} placeholder="https://…" style={{ ...inputStyle, flex: 1 }} />
              <button onClick={() => removeLink(i)} style={{ ...linkBtn, color: "var(--accent-red)", border: "1px solid rgba(239,68,68,0.3)" }}>Remove</button>
            </div>
          ))}
          <button onClick={addLink} style={{ ...linkBtn, marginTop: 2 }}>+ Add link</button>

          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16, flexWrap: "wrap" as const }}>
            <button onClick={save} disabled={!canSave} style={{ padding: "8px 20px", borderRadius: 0, fontSize: 12, fontWeight: 700, background: canSave ? "var(--accent-blue)" : "var(--bg-tertiary)", color: canSave ? "#fff" : "var(--text-tertiary)", border: "none", cursor: canSave ? "pointer" : "default" }}>
              {saving ? (form.public_enabled ? "Publishing…" : "Saving…") : (form.public_enabled ? "Save & Publish" : "Save")}
            </button>
            {/* Clear state so "Save" never just looks dead: dirty = needs saving; clean = up to date. */}
            {dirty && !saving && (
              <span style={{ fontSize: 11, color: "var(--accent-amber)" }}>Unsaved changes — click {form.public_enabled ? "Save & Publish" : "Save"}</span>
            )}
            {!dirty && !saving && published && (
              <span style={{ fontSize: 11, color: "var(--accent-green)" }}>✓ Published — <span onClick={openUrl} style={{ color: "var(--accent-blue)", cursor: "pointer", textDecoration: "underline" }}>{(liveUrl || "").replace(/^https?:\/\//, "")}</span></span>
            )}
            {!dirty && !saving && !published && (
              <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Saved — not public yet (turn on the toggle above to go live)</span>
            )}
            {msg && msg.kind === "err" && <span style={{ fontSize: 12, color: "var(--accent-red)" }}>{msg.text}</span>}
          </div>
        </>
      )}
    </div>
  );
}

// Settings-tab wrapper — the active station's public page, in a Section card.
function PublicPageSettings() {
  const { stationUuid, stationName, isReady } = useActiveStation();
  if (!isReady || !stationUuid) return null;
  return (
    <Section
      category="station"
      icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>}
      title="Public Listener Page"
      description="A branded page your listeners can open and install — logo, colors, now-playing, links."
    >
      <PublicPageEditor stationUuid={stationUuid} stationName={stationName} />
    </Section>
  );
}

// ── Main Settings Panel ──────────────────────────────────────

// Per-station music folder + Test-sync / Re-sync (DESIGN-TRUTH §2 — each station is independent).
// Pick THIS station's audio folder, dry-run "Test sync" to see if the files are there, and "Re-sync"
// to relink them by title from that folder only — returning the list of songs whose file is missing.
function MusicFolderSection() {
  const { stationId } = useActiveStation();
  const [folder, setFolder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ linked?: number; total?: number; matched?: number; folderFiles?: number; missing?: string[] } | null>(null);
  const [msg, setMsg] = useState("");
  const api = (window as any).ether.stationFolders;
  useEffect(() => {
    let on = true; setResult(null); setMsg("");
    api.get(stationId).then((r: any) => { if (on) setFolder(r?.folder || null); }).catch(() => {});
    return () => { on = false; };
  }, [stationId]);
  const choose = async () => { const r = await api.choose(stationId); if (r?.ok) { setFolder(r.folder); setMsg("Folder set for this station."); setResult(null); } };
  const test = async () => {
    setBusy(true); setMsg("Analyzing…");
    const r = await api.analyze(stationId); setBusy(false);
    if (!r?.ok) { setMsg(r?.error || "No folder set"); setResult(null); return; }
    setResult(r); setMsg(`${r.matched}/${r.total} songs found in the folder (${r.folderFiles} audio files present); ${r.missing.length} missing.`);
  };
  const resync = async () => {
    setBusy(true); setMsg("Re-syncing…");
    const r = await api.resync(stationId); setBusy(false);
    if (!r?.ok) { setMsg(r?.error || "No folder set"); setResult(null); return; }
    setResult(r); setMsg(`Linked ${r.linked}/${r.total}. ${r.missing.length} still missing (skipped so they won't stall the station).`);
  };
  const btn: React.CSSProperties = { padding: "7px 14px", fontSize: 12, fontWeight: 600, background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-secondary)", cursor: "pointer" };
  return (
    <Section category="audio" icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>} title="Music Folder & Sync" description="Where THIS station's audio files live. Each station has its own folder — pick it, Test sync to check the files are there, and Re-sync to relink them (missing songs are listed and skipped so they can't cause dead air).">
      <div style={{ display: "flex", flexDirection: "column" as any, gap: 10 }}>
        <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>Folder for this station:</div>
        <div style={{ fontSize: 13, wordBreak: "break-all", padding: "6px 8px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)" }}>{folder || "(not set)"}</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as any }}>
          <button style={btn} onClick={choose} disabled={busy}>Choose folder…</button>
          <button style={btn} onClick={test} disabled={busy || !folder}>Test sync</button>
          <button style={{ ...btn, background: "var(--accent-blue)", color: "#fff", border: "none" }} onClick={resync} disabled={busy || !folder}>Re-sync library</button>
        </div>
        {msg && <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{msg}</div>}
        {result?.missing && result.missing.length > 0 && (
          <div style={{ marginTop: 4, padding: "8px 10px", background: "rgba(245,158,11,0.10)", border: "1px solid rgba(245,158,11,0.35)", color: "#f59e0b", fontSize: 12 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>{result.missing.length} missing — add the file to the folder or fix the song title, then Re-sync:</div>
            <div style={{ maxHeight: 180, overflowY: "auto", fontSize: 11, opacity: 0.95 }}>
              {result.missing.map((t, i) => <div key={i}>• {t}</div>)}
            </div>
          </div>
        )}
      </div>
    </Section>
  );
}

export default function SettingsPanel({ xfadeDuration = 3, setXfadeDuration, segueCrossfade = 3, setSegueCrossfade }: { xfadeDuration?: number; setXfadeDuration?: (v: number) => void; segueCrossfade?: number; setSegueCrossfade?: (v: number) => void }) {
  const { stationId } = useActiveStation();
  const loadKvVersionRef = useRef(0);
  // Active category — persisted via URL hash so deep links + reloads stay
  // on the same category. E.g. #settings/audio reopens Settings on Audio.
  const initialCategory = (() => {
    try {
      const m = /#settings\/([a-z]+)/i.exec(window.location.hash);
      if (m && CATEGORIES.some(c => c.id === m[1])) return m[1] as SettingsCategory;
    } catch {}
    return "station" as SettingsCategory;
  })();
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>(initialCategory);
  const [searchText, setSearchText] = useState("");

  // Factory reset (Danger zone). Wipes this computer's local DB and relaunches into first-run
  // setup. Guarded by a double-email confirmation: type the account email twice (or "RESET"
  // if no account email is on file). See electron main system:factoryReset.
  const [frOpen, setFrOpen] = useState(false);
  const [frEmail1, setFrEmail1] = useState("");
  const [frEmail2, setFrEmail2] = useState("");
  const [frErr, setFrErr] = useState("");
  const [frBusy, setFrBusy] = useState(false);
  const [acctEmail, setAcctEmail] = useState("");
  useEffect(() => {
    (async () => {
      try {
        const r = await (window as any).ether.stationConfigKv.list(1);
        const rows: { key: string; value: string }[] = r?.ok ? r.rows : [];
        setAcctEmail(rows.find((x) => x.key === "license_email")?.value || "");
      } catch {}
    })();
  }, []);
  const frTarget = acctEmail.trim() || "RESET";
  const frMatch = frEmail1.trim().toLowerCase() === frTarget.toLowerCase()
               && frEmail2.trim().toLowerCase() === frTarget.toLowerCase();
  const doFactoryReset = async () => {
    if (!frMatch) { setFrErr("Both fields must match — type it exactly, twice."); return; }
    setFrBusy(true); setFrErr("");
    try { await (window as any).ether.system.factoryReset(); }
    catch { setFrBusy(false); setFrErr("Couldn’t reset. Please try again."); }
  };
  const frInput: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", fontSize: 13, outline: "none", marginBottom: 10 };

  // Keep URL hash in sync when the user switches categories — gives them
  // shareable + bookmarkable deep links to any settings area.
  useEffect(() => {
    if (searchText) return;  // don't overwrite hash while searching
    try {
      const desired = `#settings/${activeCategory}`;
      if (window.location.hash !== desired) {
        history.replaceState(null, "", window.location.pathname + window.location.search + desired);
      }
    } catch {}
  }, [activeCategory, searchText]);

  // Station
  const [timezone, setTimezone] = useState("");
  const [autostart, setAutostart] = useState(false);
  const [stationName, setStationName] = useState("");
  const [stationNameSaved, setStationNameSaved] = useState(false);

  // Audio devices
  const [devices, setDevices] = useState<{ deviceId: string; label: string; kind: string }[]>([]);
  const [currentOutput, setCurrentOutput] = useState("");
  const [currentInput, setCurrentInput] = useState("");
  // Phone hybrid input — set once here, used by PhoneDesk (never touched on the working panel).
  const [phoneInput, setPhoneInput] = useState<string>(() => { try { return localStorage.getItem("ether_phone_input") || ""; } catch { return ""; } });
  const selectPhoneInput = (id: string) => { setPhoneInput(id); try { localStorage.setItem("ether_phone_input", id); } catch { /* ignore */ } };
  // Cue / headphone output — where PFL (pre-fade listen) plays, separate from the main mix.
  const [cueOutput, setCueOutput] = useState<string>(() => { try { return localStorage.getItem("ether_cue_device") || ""; } catch { return ""; } });
  const selectCueOutput = (id: string) => { setCueOutput(id); try { localStorage.setItem("ether_cue_device", id); } catch { /* ignore */ } };

  // Connections
  const [dashboardUrl, setDashboardUrl] = useState("");

  // Now Playing
  const [igHandle, setIgHandle] = useState("");
  const [igEnabled, setIgEnabled] = useState(false);
  const [igSaved, setIgSaved] = useState(false);

  // Backup
  const [backups, setBackups] = useState<string[]>([]);
  const [backupStatus, setBackupStatus] = useState("");
  const [backupLoading, setBackupLoading] = useState(false);

  // Cloud Backup — post-1.3h: customer no longer holds R2 credentials. Backend
  // signs all backup uploads. Only the enable toggle, interval, and status
  // are customer-facing here; credentials live on the backend server (Railway
  // R2_* env vars). The legacy r2AccountId / r2AccessKeyId / r2HasSecret /
  // r2SecretLast4 / r2NewSecret / r2EditSecret / r2ShowSecret / r2Bucket
  // state hooks were removed in 1.3h alongside their UI.
  const [r2Enabled,      setR2Enabled]      = useState(false);
  const [r2Interval,     setR2Interval]     = useState(6);
  const [r2LastBackup,   setR2LastBackup]   = useState(0);
  const [r2LastStatus,   setR2LastStatus]   = useState("never");
  const [r2SaveStatus,   setR2SaveStatus]   = useState("");
  const [r2TestStatus,   setR2TestStatus]   = useState("");
  const [r2Testing,      setR2Testing]      = useState(false);
  const [r2Saving,       setR2Saving]       = useState(false);
  const [r2BackingNow,   setR2BackingNow]   = useState(false);
  const [r2BackupNowStatus, setR2BackupNowStatus] = useState("");
  // Manual full-DB cloud backup — same backend-signed R2 upload as the auto-timer, on demand.
  const runCloudBackupNow = async () => {
    setR2BackingNow(true); setR2BackupNowStatus("Backing up your full station…");
    try {
      const r: any = await (window as any).ether.invoke("cloud-backup:run-now");
      if (!r?.ok) throw new Error(r?.tier_insufficient ? "Cloud backup requires the Network plan." : (r?.error || "Backup failed"));
      setR2LastBackup(Math.floor(Date.now() / 1000));
      setR2LastStatus("success");
      setR2BackupNowStatus("✓ Full station backed up to the cloud");
    } catch (e: any) {
      setR2BackupNowStatus("✗ " + String(e?.message || e));
    }
    setR2BackingNow(false);
  };

  // Music Library → Cloud (manual audio upload). The cloud backup above covers
  // the database only; this pushes the actual audio files via the existing
  // library:sync-r2:upload handler so a fresh install can pull them down.
  const [libUploading, setLibUploading] = useState(false);
  const [libProgress,  setLibProgress]  = useState<{ phase: string; done: number; total: number; errors: number } | null>(null);
  const [libUploadMsg, setLibUploadMsg] = useState("");
  const [libForce,     setLibForce]     = useState(false);   // re-upload everything, ignoring resume markers
  // Designated library folder — where cloud downloads land AND the uploader consolidates everything.
  const [musicDir,     setMusicDir]     = useState("");
  useEffect(() => { (async () => { try { const r = await (window as any).ether.music?.getDir?.(); if (r?.dir) setMusicDir(r.dir); } catch {} })(); }, []);
  const chooseLibraryFolder = async () => {
    try {
      const picked = await (window as any).ether.dialog?.openDirectory?.();
      const dir = Array.isArray(picked) ? picked[0] : (picked?.filePaths?.[0] ?? picked);
      if (!dir) return;
      const r = await (window as any).ether.music?.setDir?.(dir);
      if (r?.ok) setMusicDir(r.dir);
    } catch (e) { console.error("[library] choose folder:", e); }
  };

  // AI / Voice Assistant (legacy)
  const [anthropicKey, setAnthropicKey] = useState("");
  const [anthropicKeySaved, setAnthropicKeySaved] = useState(false);

  // AI & Integrations tab
  const [aiProvider, setAiProviderState] = useState<"anthropic" | "openai" | "google">("anthropic");
  const [aiProviderSaved, setAiProviderSaved] = useState(false);
  const [keyStatus, setKeyStatus] = useState({ anthropic: false, openai: false, google: false, weather: false });
  const [anthropicInput, setAnthropicInput] = useState("");
  const [openaiInput, setOpenaiInput] = useState("");
  const [googleInput, setGoogleInput] = useState("");
  const [weatherInput, setWeatherInput] = useState("");
  const [connectingProvider, setConnectingProvider] = useState<string | null>(null);

  // Processing
  const [processingStats, setProcessingStats] = useState<any>(null);
  const [processing, setProcessing] = useState(false);
  const [processingProgress, setProcessingProgress] = useState("");
  const [processingDone, setProcessingDone] = useState(0);
  const [processingTotal, setProcessingTotal] = useState(0);

  // Clean Filenames
  const [cleanFolder, setCleanFolder] = useState("");
  const [cleanPreview, setCleanPreview] = useState<{before:string;after:string}[]|null>(null);
  const [cleanResult, setCleanResult] = useState<{renamed:number;errors:string[]}|null>(null);
  const [cleanError, setCleanError] = useState<string|null>(null);
  const [cleanBusy, setCleanBusy] = useState(false);
  const [cleanWords, setCleanWords] = useState<string[]>(["spotdown_org", "spotdown"]);
  const [cleanWordInput, setCleanWordInput] = useState("");

  // Rules
  const [rules, setRules] = useState<any[]>([]);

  const RULE_META: Record<string, { label: string; hint: string }> = {
    artist_separation_min: { label: "Same artist plays again after", hint: "Minutes before you hear the same artist twice" },
    song_separation_min:   { label: "Same song plays again after", hint: "Minutes before the exact same song can repeat" },
    title_separation_min:  { label: "Same title (different artist) after", hint: "Covers or remixes of the same song" },
    max_same_gender:       { label: "Max songs in a row by same gender", hint: "Keeps the mix balanced between male and female artists" },
    max_same_category:     { label: "Max songs in a row from same category", hint: "Prevents playing too many songs from one rotation category" },
  };

  // Station-scoped KV reads; re-runs on station-switched
  useEffect(() => {
    async function doLoadStationKv() {
      const v = ++loadKvVersionRef.current;
      try {
        const station = await (window as any).ether.invoke('stations:get-active');
        if (v !== loadKvVersionRef.current) return;
        const sid: number | null = station?.id ?? null;
        if (sid == null) return;
        const kvResult = await (window as any).ether.stationConfigKv.list(sid);
        if (v !== loadKvVersionRef.current) return;
        if (kvResult.ok) {
          const rows: { key: string; value: string }[] = kvResult.rows;
          const get = (key: string) => rows.find(r => r.key === key)?.value;
          const igHandleVal     = get('ig_handle');
          const igEnabledVal    = get('ig_enabled');
          const stationNameVal  = get('station_name');
          const anthropicKeyVal = get('anthropic_api_key');
          if (igHandleVal    !== undefined) setIgHandle(igHandleVal);
          if (igEnabledVal   !== undefined) setIgEnabled(igEnabledVal === "1");
          if (stationNameVal !== undefined) setStationName(stationNameVal);
          if (anthropicKeyVal !== undefined) { setAnthropicKey(anthropicKeyVal); (window as any).__ANTHROPIC_API_KEY__ = anthropicKeyVal; }
        }
      } catch {}
    }
    doLoadStationKv();
    window.addEventListener('station-switched', doLoadStationKv);
    return () => window.removeEventListener('station-switched', doLoadStationKv);
  }, []);

  useEffect(() => {
    // Timezone
    getStationTimezone().then(setTimezone);

    // Autostart
    (window as any).ether.autostart.isEnabled().then((v: boolean) => setAutostart(v)).catch(() => {});

    // Dashboard URL
    invoke<string>("get_local_ip").then(ip => setDashboardUrl("http://" + ip + ":4242")).catch(() => setDashboardUrl("http://localhost:4242"));

    // AI key status + provider
    invoke("ai:getKeyStatus").then((s: any) => setKeyStatus(s)).catch(() => {});
    invoke("ai:getProvider").then((p: any) => setAiProviderState(p)).catch(() => {});

    // Backups
    invoke<string[]>("list_backups").then(setBackups).catch(() => {});

    // Cloud backup — post-1.3h reads only the customer-facing toggle/interval
    // and status. Credential fields are gone (backend holds R2 access).
    (window as any).ether.cloudBackup.getR2Config().then((cfg: any) => {
      if (!cfg) return;
      setR2Enabled(!!cfg.enabled);
      setR2Interval(cfg.intervalHours || 6);
      setR2LastBackup(cfg.lastBackup || 0);
      setR2LastStatus(cfg.lastStatus || "never");
    }).catch(() => {});

    // Processing stats
    getProcessingStats().then(setProcessingStats).catch(() => {});

    // Rules
    // station_id scoping: Strategy B — single table
    queryScoped<any>("SELECT * FROM separation_rules ORDER BY id", [], stationId).then(setRules).catch(() => {});

    // Audio devices
    loadDevices();
  }, []);

  const loadDevices = async () => {
    const apply = (all: MediaDeviceInfo[]) => setDevices(
      all.filter(d => d.kind === "audioinput" || d.kind === "audiooutput").map(d => ({
        deviceId: d.deviceId,
        label: d.label || (d.kind === "audiooutput" ? "Output " : "Input ") + (d.deviceId ? d.deviceId.substring(0, 8) : "device"),
        kind: d.kind,
      }))
    );
    // Enumerate FIRST — device existence (and outputs) don't require mic permission,
    // so the pickers always populate even if the mic prompt is denied/unavailable.
    // The old code put getUserMedia first inside a silent catch, so any permission
    // failure wiped the entire list — including outputs that never needed the mic.
    try {
      apply(await navigator.mediaDevices.enumerateDevices());
    } catch (e) {
      console.error("[SettingsPanel] enumerateDevices failed:", e);
    }
    // Then request mic access to unlock input *labels*, and re-enumerate. A failure
    // here leaves the already-listed devices intact (labels may be generic).
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach(t => t.stop());
      apply(await navigator.mediaDevices.enumerateDevices());
    } catch (e) {
      console.warn("[SettingsPanel] mic permission unavailable; device labels limited:", e);
    }
  };

  const saveStationName = async () => {
    if (stationId != null) {
      const r = await (window as any).ether.stationConfigKv.upsertByKey(stationId, 'station_name', stationName).catch(() => ({ ok: false }));
      if (!r.ok) console.error('[SettingsPanel] station_name upsert:', r.error);
      // ALSO update the stations table row name. The switcher, active-station, and station identity
      // read stations.name — writing only the KV copy above left the real name as "Station 1", which
      // is why renames "didn't take". Update both so the new name actually shows everywhere.
      try { await (window as any).ether.stations.update(stationId, { name: stationName }); }
      catch (e) { console.error('[SettingsPanel] stations.update name:', e); }
      try { window.dispatchEvent(new Event('station-switched')); } catch {}  // refresh the active-station cache
    }
    setStationNameSaved(true);
    setTimeout(() => setStationNameSaved(false), 2000);
  };

  const toggleAutostart = async () => {
    try {
      if (autostart) {
        await (window as any).ether.autostart.disable(); setAutostart(false);
      } else {
        await (window as any).ether.autostart.enable(); setAutostart(true);
      }
    } catch {}
  };

  const saveIg = async () => {
    if (stationId != null) {
      await (window as any).ether.stationConfigKv.upsertByKey(stationId, 'ig_handle', igHandle).catch(() => {});
      await (window as any).ether.stationConfigKv.upsertByKey(stationId, 'ig_enabled', igEnabled ? "1" : "0").catch(() => {});
    }
    setIgSaved(true); setTimeout(() => setIgSaved(false), 2000);
  };

  const backup = async () => {
    setBackupLoading(true);
    try {
      await invoke<string>("backup_db");
      setBackupStatus("✓ Backup saved");
      invoke<string[]>("list_backups").then(setBackups).catch(() => {});
    } catch (e) { setBackupStatus("Error: " + String(e)); }
    setBackupLoading(false);
    setTimeout(() => setBackupStatus(""), 4000);
  };

  const restore = async (name: string) => {
    if (!confirm("Restore from " + formatBackupName(name) + "?\n\nYour current library and settings will be replaced. Ether will need to restart.")) return;
    try {
      const msg = await invoke<string>("restore_db", { backupName: name });
      setBackupStatus(msg);
    } catch (e) { setBackupStatus("Error: " + String(e)); }
  };

  const saveR2Config = async () => {
    setR2Saving(true);
    setR2SaveStatus("");
    try {
      // Post-1.3h: only the toggle + interval are persisted client-side.
      // Backend handles R2 access; cloud-backup.js's set-r2-config handler
      // ignores credential fields if any older callers send them.
      const payload: any = {
        enabled:       r2Enabled,
        intervalHours: r2Interval,
      };
      const ether = (window as any).ether;
      const result: any = await ether.cloudBackup.setR2Config(payload);
      setR2SaveStatus(result.ready ? "✓ Saved — backup enabled" : "✓ Saved — enable the toggle to activate");
    } catch (e) { setR2SaveStatus("Error saving: " + String(e)); }
    setR2Saving(false);
    setTimeout(() => setR2SaveStatus(""), 6000);
  };

  const testR2Connection = async () => {
    setR2Testing(true);
    setR2TestStatus("");
    try {
      const result: any = await invoke("cloud-backup:test-r2");
      setR2TestStatus(result.ok ? "✓ Connection successful — bucket is reachable" : "✗ " + result.error);
    } catch (e) { setR2TestStatus("✗ " + String(e)); }
    setR2Testing(false);
  };

  // Manual library (audio) upload. upload() validates synchronously (tier /
  // license / "nothing to upload") and returns {ok:false,error} without throwing;
  // on ok it runs fire-and-forget and drives the progress/done events below.
  const uploadLibrary = async () => {
    const ether = (window as any).ether;
    setLibUploadMsg(""); setLibProgress(null); setLibUploading(true);
    try {
      const r: any = await ether.libraryR2.upload({ force: libForce });
      if (!r?.ok) {
        setLibUploading(false);
        setLibUploadMsg(r?.error || "Couldn't start the upload.");
      }
    } catch (e: any) {
      setLibUploading(false);
      setLibUploadMsg(String(e?.message || e));
    }
  };
  const cancelLibraryUpload = () => { (window as any).ether.libraryR2.uploadCancel?.(); };

  // Subscribe to library-upload progress/done so the button reflects real work.
  useEffect(() => {
    const ether = (window as any).ether;
    const offP = ether.libraryR2.onUploadProgress?.((v: any) => {
      setLibProgress({ phase: v?.phase ?? "upload", done: v?.done ?? 0, total: v?.total ?? 0, errors: v?.errors ?? 0 });
    });
    const offD = ether.libraryR2.onUploadDone?.((v: any) => {
      const uploaded = v?.uploaded ?? 0, total = v?.total ?? 0, errors = v?.errors ?? 0;
      const consolidated = v?.consolidated ?? 0, notFound = v?.notFound ?? 0;
      setLibUploading(false);
      setLibProgress({ phase: "done", done: uploaded, total, errors });
      const consPart = consolidated > 0 ? ` · ${consolidated.toLocaleString()} moved into your library folder` : "";
      const missPart = notFound > 0 ? ` · ${notFound.toLocaleString()} file${notFound === 1 ? "" : "s"} not found on disk` : "";
      setLibUploadMsg(
        v?.fatal     ? `Upload failed: ${v.fatal}`
        : v?.aborted ? `Cancelled — ${uploaded.toLocaleString()} uploaded${consPart}${missPart}`
        : errors > 0 ? `Uploaded ${uploaded.toLocaleString()} of ${total.toLocaleString()} — ${errors} failed${consPart}${missPart}`
        : total === 0 ? `✓ Library already in the cloud${consPart}${missPart}`
        :              `✓ All ${uploaded.toLocaleString()} files uploaded to the cloud${consPart}${missPart}`
      );
    });
    return () => { offP?.(); offD?.(); };
  }, []);

  const formatBackupName = (name: string) => {
    const ts = name.replace("openair-backup-", "").replace(".db", "");
    return new Date(parseInt(ts) * 1000).toLocaleString();
  };

  const TIME_RULES = ["artist_separation_min", "song_separation_min", "title_separation_min"];

  // Unit state for each time-based rule — stored in minutes in DB, display in hours or minutes
  const [ruleUnits, setRuleUnits] = useState<Record<number, "min" | "hr">>({});

  const getDisplayValue = (rule: any) => {
    const unit = ruleUnits[rule.id] || "min";
    return unit === "hr" ? Math.round(rule.value / 60 * 10) / 10 : rule.value;
  };

  const setDisplayValue = async (rule: any, display: number) => {
    const unit = ruleUnits[rule.id] || "min";
    const minutes = unit === "hr" ? Math.round(display * 60) : display;
    await updateRule(rule.id, "value", minutes);
  };

  const updateRule = async (id: number, field: string, val: number) => {
    await (window as any).ether.separationRules.updateById(id, { [field]: val });
    // station_id scoping: Strategy B — single table
    queryScoped<any>("SELECT * FROM separation_rules ORDER BY id", [], stationId).then(setRules);
  };

  const handleProcessAll = async () => {
    setProcessing(true); setProcessingProgress("Starting...");
    const count = await processAllSongs((d, t, title) => {
      setProcessingDone(d); setProcessingTotal(t);
      setProcessingProgress("Analyzing: " + title + " (" + d + "/" + t + ")");
    });
    setProcessingProgress("Done! Analyzed " + count + " songs.");
    setProcessing(false);
    getProcessingStats().then(setProcessingStats);
  };

  const outputs = devices.filter(d => d.kind === "audiooutput");
  const inputs = devices.filter(d => d.kind === "audioinput");

  const saveAnthropicKey = async () => {
    if (stationId != null) {
      const r = await (window as any).ether.stationConfigKv.upsertByKey(stationId, 'anthropic_api_key', anthropicKey).catch(() => ({ ok: false }));
      if (!r.ok) console.error('[SettingsPanel] anthropic_api_key upsert:', r.error);
    }
    (window as any).__ANTHROPIC_API_KEY__ = anthropicKey;
    setAnthropicKeySaved(true);
    setTimeout(() => setAnthropicKeySaved(false), 2000);
  };

  const connectProvider = async (provider: string, key: string) => {
    if (!key.trim()) return;
    setConnectingProvider(provider);
    await invoke("ai:setKey", { provider, key: key.trim() }).catch(() => {});
    const s: any = await invoke("ai:getKeyStatus").catch(() => keyStatus);
    setKeyStatus(s);
    setConnectingProvider(null);
    if (provider === "anthropic") setAnthropicInput("");
    if (provider === "openai") setOpenaiInput("");
    if (provider === "google") setGoogleInput("");
    if (provider === "weather") setWeatherInput("");
  };

  const disconnectProvider = async (provider: string) => {
    await invoke("ai:setKey", { provider, key: "" }).catch(() => {});
    const s: any = await invoke("ai:getKeyStatus").catch(() => keyStatus);
    setKeyStatus(s);
  };

  const saveProvider = async (provider: "anthropic" | "openai" | "google") => {
    setAiProviderState(provider);
    await invoke("ai:setProvider", provider).catch(() => {});
    setAiProviderSaved(true);
    setTimeout(() => setAiProviderSaved(false), 1500);
  };

  const activeCat = CATEGORIES.find(c => c.id === activeCategory);

  return (
    <SettingsFilterContext.Provider value={{ activeCategory, searchText, registerSection: () => {} }}>
    <style>{SETTINGS_CSS}</style>
    <div className="eth-settings" style={{ maxWidth: 1100, margin: "0 auto", padding: "4px 0 48px", fontFamily: "'Inter', system-ui, sans-serif" }}>

      {/* Header: title + search */}
      <div className="eth-settings__head">
        <div>
          <h1 className="eth-settings__title">Settings</h1>
          <div className="eth-settings__sub">Configure your station, audio, automation, and account.</div>
        </div>
        <div className="eth-search">
          <svg className="eth-search__icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
            placeholder="Search all settings…"
          />
          {searchText && (
            <button className="eth-search__clear" onClick={() => setSearchText("")} aria-label="Clear search">×</button>
          )}
        </div>
      </div>

      {/* Two-column layout: sidebar + content */}
      <div style={{ display: "grid", gridTemplateColumns: "210px 1fr", gap: 24, alignItems: "start" }}>

        {/* Left sidebar — category nav */}
        <nav className="eth-rail">
          <div className="eth-rail__label">Settings</div>
          {CATEGORIES.map(c => (
            <button key={c.id} onClick={() => { setSearchText(""); setActiveCategory(c.id); }}
              className={"eth-rail__btn" + (activeCategory === c.id && !searchText ? " eth-rail__btn--active" : "")}>
              <span className="eth-rail__icon">{c.icon}</span>
              <span>{c.label}</span>
            </button>
          ))}
        </nav>

        {/* Right content area — all sections live here; each self-filters */}
        <div>
          {/* Breadcrumb / context line */}
          {!searchText && activeCat && (
            <div style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" as const, color: "var(--text-tertiary)", marginBottom: 16 }}>
              {activeCat.label}
            </div>
          )}
          {searchText && (
            <div style={{ fontSize: 13.5, color: "var(--text-tertiary)", marginBottom: 16 }}>
              Showing settings matching "<b style={{ color: "var(--text-secondary)" }}>{searchText}</b>" across all categories
            </div>
          )}

          <>

      {/* ── Station ── */}
      <Section category="station" icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a3 3 0 0 0-3 3v4a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10c0 3.866-3.134 7-7 7s-7-3.134-7-7"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="8" y1="21" x2="16" y2="21"/></svg>} title="Your Station" description="Basic information about your station">
        <SettingRow label="Station name" hint="Shows in the header and window title">
          <div style={{ display: "flex", gap: 8 }}>
            <input value={stationName} onChange={e => setStationName(e.target.value)}
              placeholder="My Radio Station"
              style={{ padding: "7px 12px", borderRadius: 0, fontSize: 12, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", width: 200, outline: "none" }} />
            <button onClick={saveStationName}
              style={{ padding: "7px 14px", borderRadius: 0, fontSize: 13, fontWeight: 600, background: stationNameSaved ? "var(--accent-green)" : "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer" }}>
              {stationNameSaved ? "Saved!" : "Save"}
            </button>
          </div>
        </SettingRow>
        <SettingRow label="Timezone" hint="Used for scheduling, play logs, and DST handling">
          <select value={timezone} onChange={e => { setTimezone(e.target.value); setStationTimezone(e.target.value, stationId); }}
            style={{ padding: "7px 12px", borderRadius: 0, fontSize: 12, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", maxWidth: 280 }}>
            {COMMON_TIMEZONES.map(tz => <option key={tz.value} value={tz.value}>{tz.label}</option>)}
          </select>
        </SettingRow>
        <div style={{ paddingTop: 12 }}>
          <Toggle value={autostart} onChange={toggleAutostart} label="Start Ether automatically when Windows boots" />
          <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginTop: 6, marginLeft: 52 }}>Recommended if you run a 24/7 station</div>
        </div>
      </Section>

      {/* ── Public Listener Page (Phase 2) ── */}
      <PublicPageSettings />

      {/* ── Audio ── */}
      <Section category="audio" icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>} title="Audio Devices" description="Choose where music plays and which mic to use for voice tracking">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12, minWidth: 0 }}>
          {/* Output */}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>Where music plays</div>
            <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginBottom: 10 }}>Your speakers, headphones, or broadcast console</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {outputs.length === 0 ? <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic" }}>No output devices found</div> :
                outputs.map(d => (
                  <button key={d.deviceId} onClick={() => setCurrentOutput(d.deviceId)} style={{
                    padding: "9px 12px", borderRadius: 0, textAlign: "left" as any, fontSize: 12, cursor: "pointer",
                    background: currentOutput === d.deviceId ? "rgb(from var(--accent-blue) r g b / 0.12)" : "var(--bg-tertiary)",
                    border: "1px solid " + (currentOutput === d.deviceId ? "var(--accent-blue)" : "var(--border-primary)"),
                    color: currentOutput === d.deviceId ? "var(--accent-blue)" : "var(--text-secondary)",
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                  }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any, flex: 1 }}>{d.label}</span>
                    {currentOutput === d.deviceId && <span style={{ fontSize: 13, fontWeight: 700, marginLeft: 8, flexShrink: 0 }}>ACTIVE</span>}
                  </button>
                ))}
            </div>
          </div>
          {/* Input */}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>Your microphone</div>
            <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginBottom: 10 }}>For voice tracking and live mic breaks</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {inputs.length === 0 ? <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic" }}>No microphones found</div> :
                inputs.map(d => (
                  <button key={d.deviceId} onClick={() => setCurrentInput(d.deviceId)} style={{
                    padding: "9px 12px", borderRadius: 0, textAlign: "left" as any, fontSize: 12, cursor: "pointer",
                    background: currentInput === d.deviceId ? "rgba(52,211,153,0.12)" : "var(--bg-tertiary)",
                    border: "1px solid " + (currentInput === d.deviceId ? "var(--accent-green)" : "var(--border-primary)"),
                    color: currentInput === d.deviceId ? "var(--accent-green)" : "var(--text-secondary)",
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                  }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any, flex: 1 }}>{d.label}</span>
                    {currentInput === d.deviceId && <span style={{ fontSize: 13, fontWeight: 700, marginLeft: 8, flexShrink: 0 }}>ACTIVE</span>}
                  </button>
                ))}
            </div>
          </div>
        </div>
        {/* Phone hybrid input — set once, used by the Phone Desk */}
        <div style={{ minWidth: 0, marginTop: 4, marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>Phone hybrid input</div>
          <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginBottom: 10 }}>The interface input your phone hybrid / caller audio is connected to — used by the Phone Desk</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            {inputs.length === 0 ? <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic" }}>No inputs found</div> :
              inputs.map(d => (
                <button key={d.deviceId} onClick={() => selectPhoneInput(d.deviceId)} style={{
                  padding: "9px 12px", borderRadius: 0, textAlign: "left" as any, fontSize: 12, cursor: "pointer",
                  background: phoneInput === d.deviceId ? "rgba(136,104,216,0.14)" : "var(--bg-tertiary)",
                  border: "1px solid " + (phoneInput === d.deviceId ? "#8868D8" : "var(--border-primary)"),
                  color: phoneInput === d.deviceId ? "#a78bfa" : "var(--text-secondary)",
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any, flex: 1 }}>{d.label}</span>
                  {phoneInput === d.deviceId && <span style={{ fontSize: 13, fontWeight: 700, marginLeft: 8, flexShrink: 0 }}>ACTIVE</span>}
                </button>
              ))}
          </div>
        </div>
        {/* Cue / headphone output — where PFL (pre-fade listen) plays */}
        <div style={{ minWidth: 0, marginTop: 4, marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>Cue / headphone output</div>
          <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginBottom: 10 }}>Where PFL (pre-fade listen) plays — your cue headphones, separate from the main output</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            {outputs.length === 0 ? <div style={{ fontSize: 12, color: "var(--text-tertiary)", fontStyle: "italic" }}>No outputs found</div> :
              outputs.map(d => (
                <button key={d.deviceId} onClick={() => selectCueOutput(d.deviceId)} style={{
                  padding: "9px 12px", borderRadius: 0, textAlign: "left" as any, fontSize: 12, cursor: "pointer",
                  background: cueOutput === d.deviceId ? "rgba(184,134,11,0.16)" : "var(--bg-tertiary)",
                  border: "1px solid " + (cueOutput === d.deviceId ? "#d4a017" : "var(--border-primary)"),
                  color: cueOutput === d.deviceId ? "#d4a017" : "var(--text-secondary)",
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any, flex: 1 }}>{d.label}</span>
                  {cueOutput === d.deviceId && <span style={{ fontSize: 13, fontWeight: 700, marginLeft: 8, flexShrink: 0 }}>CUE</span>}
                </button>
              ))}
          </div>
        </div>
        <button onClick={loadDevices} style={{ padding: "6px 14px", borderRadius: 0, fontSize: 13, fontWeight: 600, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-tertiary)", cursor: "pointer" }}>
          ↻ Rescan Devices
        </button>
        {setXfadeDuration && (
          <SettingRow label="Manual crossfade (X key)" hint="How long a crossfade takes when YOU trigger it — the X key or AUTO-X. Does not affect automatic segues.">
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input
                type="range" min={1} max={10} step={1} value={xfadeDuration}
                onChange={e => setXfadeDuration(Number(e.target.value))}
                style={{ width: 110, accentColor: "#a78bfa", cursor: "pointer" }}
              />
              <span style={{ fontSize: 13, fontWeight: 700, fontFamily: "'JetBrains Mono', ui-monospace, monospace", color: "#a78bfa", minWidth: 28, textAlign: "right" as const }}>
                {xfadeDuration}s
              </span>
            </div>
          </SettingRow>
        )}
        {setSegueCrossfade && (
          <SettingRow label="Segue crossfade (auto)" hint="Every automatic song-to-song transition: the outgoing song fades over this many seconds while the next starts. 0 = hard cut. A jingle seam rides the same fade.">
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input
                type="range" min={0} max={10} step={1} value={segueCrossfade}
                onChange={e => setSegueCrossfade(Number(e.target.value))}
                style={{ width: 110, accentColor: "#14e0c8", cursor: "pointer" }}
              />
              <span style={{ fontSize: 13, fontWeight: 700, fontFamily: "'JetBrains Mono', ui-monospace, monospace", color: "#14e0c8", minWidth: 40, textAlign: "right" as const }}>
                {segueCrossfade === 0 ? "hard" : `${segueCrossfade}s`}
              </span>
            </div>
          </SettingRow>
        )}
      </Section>

      {/* ── Per-station Music Folder & Sync ── */}
      <MusicFolderSection />

      {/* Jingles & Sweepers moved to its own bottom-bar push-up (JINGLES) — the one imaging home (4.4.59). */}

      {/* ── Music Scheduling Rules ── */}
      <Section category="programming" icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>} title="Music Scheduling Rules" description="Control how songs are selected — how long before the same artist or song can play again">
        <div style={{ display: "flex", flexDirection: "column" as any }}>
          {rules.map((r, i) => {
            const meta = RULE_META[r.rule_type];
            if (!meta) return null;
            const isLast = i === rules.length - 1;
            return (
              <div key={r.id} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16,
                padding: "14px 0",
                borderBottom: isLast ? "none" : "1px solid var(--border-primary)",
                opacity: r.is_active ? 1 : 0.45,
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>{meta.label}</div>
                  <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginTop: 2 }}>{meta.hint}</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                  <input type="number" value={getDisplayValue(r)}
                    onChange={e => setDisplayValue(r, parseFloat(e.target.value) || 0)}
                    style={{ width: 60, padding: "5px 8px", borderRadius: 0, fontSize: 13, fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontWeight: 500, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", textAlign: "center" as any, outline: "none" }} />
                  {TIME_RULES.includes(r.rule_type) ? (
                    <select
                      value={ruleUnits[r.id] || "min"}
                      onChange={e => setRuleUnits(prev => ({ ...prev, [r.id]: e.target.value as "min" | "hr" }))}
                      style={{ padding: "5px 8px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", outline: "none", cursor: "pointer" }}
                    >
                      <option value="min">min</option>
                      <option value="hr">hrs</option>
                    </select>
                  ) : (
                    <span style={{ fontSize: 13, color: "var(--text-tertiary)", width: 42 }}>songs</span>
                  )}
                  <button onClick={() => updateRule(r.id, "is_hard", r.is_hard ? 0 : 1)} style={{
                    padding: "5px 10px", borderRadius: 0, fontSize: 12, fontWeight: 700, cursor: "pointer", border: "none",
                    background: r.is_hard ? "rgba(248,113,113,0.15)" : "var(--bg-tertiary)",
                    color: r.is_hard ? "var(--accent-red)" : "var(--text-tertiary)",
                  }}>{r.is_hard ? "STRICT" : "SOFT"}</button>
                  <div onClick={() => updateRule(r.id, "is_active", r.is_active ? 0 : 1)} style={{
                    width: 36, height: 20, borderRadius: 0, cursor: "pointer",
                    background: r.is_active ? "var(--accent-green)" : "var(--bg-tertiary)",
                    border: "1px solid " + (r.is_active ? "var(--accent-green)" : "var(--border-secondary)"),
                    position: "relative", transition: "background 0.2s", flexShrink: 0,
                  }}>
                    <div style={{ position: "absolute", top: 3, left: r.is_active ? 18 : 3, width: 12, height: 12, borderRadius: 0, background: "#fff", transition: "left 0.2s" }} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 12, padding: "10px 14px", background: "var(--bg-tertiary)", borderRadius: 0, fontSize: 13, color: "var(--text-tertiary)" }}>
          <strong style={{ color: "var(--accent-red)" }}>STRICT</strong> — rule is enforced absolutely, no exceptions.&nbsp;&nbsp;
          <strong style={{ color: "var(--text-secondary)" }}>SOFT</strong> — rule is preferred but can be broken if no better option exists.
        </div>
      </Section>

      {/* ── Connections ── */}
      <Section category="broadcast" icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1" fill="currentColor" stroke="none"/></svg>} title="Remote Access & Website" description="Control Ether from your phone, or show what's playing on your website">
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)", marginBottom: 4 }}>Mobile remote control</div>
            <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginBottom: 8 }}>Open this on any phone or tablet connected to the same WiFi — no app needed</div>
            {dashboardUrl && <CodeBox value={dashboardUrl} />}
          </div>
          <div style={{ borderTop: "1px solid var(--border-primary)", paddingTop: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)", marginBottom: 4 }}>Now playing for your website</div>
            <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginBottom: 8 }}>Your website can fetch this URL every 10 seconds to show the current song automatically</div>
            {dashboardUrl && <CodeBox value={dashboardUrl + "/now-playing.json"} />}
            <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 8 }}>Returns: song title, artist, whether it's playing, and a timestamp</div>
          </div>
        </div>
      </Section>

      {/* ── Cloud Playout ── */}
      <CloudPlayoutSection />

      {/* ── Stream Metadata Outputs (PAD/RDS) ── */}
      <Section
        category="broadcast"
        icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v20M2 12h20M19.07 4.93l-14.14 14.14M19.07 19.07l-14.14-14.14"/></svg>}
        title="Stream Metadata Outputs"
        description="Push 'now playing' to Icecast, Shoutcast, TuneIn AIR, RDS encoders, or any custom webhook — multiple targets in parallel">
        <StreamMetadataPanel />
      </Section>

      {/* ── Pair Mobile App (Ether2Go) ── */}
      <Section
        category="integrations"
        icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18.5"/></svg>}
        title="Pair Mobile App (Ether2Go)"
        description="Record voice tracks on your phone and upload them straight to the studio">
        <PairMobileApp />
      </Section>

      {/* AI Voice Generation removed (v4.3.77) — Iris is the single station voice. */}

      {/* ── Beta Program & Feedback ── */}
      <Section
        category="system"
        icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>}
        title="Beta Program & Feedback"
        description="Apply for free Station-tier access, or tell us what's broken and what's missing">
        <BetaProgram />
      </Section>

      {/* ── Now Playing Screen ── */}
      <Section category="programming" icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>} title="Now Playing Screen" description="Customize what shows on the on-air display window">
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)", marginBottom: 4 }}>Instagram feed</div>
            <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginBottom: 10 }}>Shows recent posts on the Now Playing screen when no ads are running. Enter a profile handle or hashtag.</div>
            <input value={igHandle} onChange={e => setIgHandle(e.target.value)}
              placeholder="@yourstation or #yourhashtag"
              style={{ width: "100%", padding: "9px 12px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", marginBottom: 12, boxSizing: "border-box" as any }} />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <Toggle value={igEnabled} onChange={setIgEnabled} label="Show Instagram feed on screen" />
              <button onClick={saveIg} style={{ padding: "7px 16px", borderRadius: 0, fontSize: 12, fontWeight: 600, background: igSaved ? "var(--accent-green)" : "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer" }}>
                {igSaved ? "Saved!" : "Save"}
              </button>
            </div>
          </div>
        </div>
      </Section>

      {/* ── Loudness ── */}
      <Section category="audio" icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>} title="Loudness Normalization" description="Make every song play at the same volume — no more jarring jumps between quiet and loud tracks">
        {processingStats && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 16 }}>
            {[
              { label: "Analyzed", value: processingStats.processed + " / " + processingStats.total },
              { label: "Average loudness", value: processingStats.avgLufs ? processingStats.avgLufs + " LUFS" : "—" },
              { label: "Still to analyze", value: processingStats.unprocessed, highlight: processingStats.unprocessed > 0 },
            ].map(s => (
              <div key={s.label} style={{ background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", borderRadius: 0, padding: "12px 14px", textAlign: "center" as any }}>
                <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "'JetBrains Mono', ui-monospace, monospace", color: (s as any).highlight ? "var(--accent-amber)" : "var(--text-primary)" }}>{s.value}</div>
                <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 4 }}>{s.label}</div>
              </div>
            ))}
          </div>
        )}
        {processingProgress && (
          <div style={{ padding: "10px 14px", background: "rgb(from var(--accent-blue) r g b / 0.08)", border: "1px solid rgb(from var(--accent-blue) r g b / 0.2)", borderRadius: 0, fontSize: 12, color: "var(--accent-blue)", marginBottom: 12 }}>
            {processingProgress}
            {processingTotal > 0 && (
              <div style={{ width: "100%", height: 3, background: "rgb(from var(--accent-blue) r g b / 0.15)", borderRadius: 0, marginTop: 8, overflow: "hidden" }}>
                <div style={{ width: (processingDone / processingTotal * 100) + "%", height: "100%", background: "var(--accent-blue)", transition: "width 0.3s" }} />
              </div>
            )}
          </div>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={handleProcessAll} disabled={processing} style={{ padding: "8px 18px", borderRadius: 0, fontSize: 12, fontWeight: 600, background: processing ? "var(--bg-tertiary)" : "var(--accent-blue)", color: processing ? "var(--text-tertiary)" : "#fff", border: "none", cursor: processing ? "default" : "pointer" }}>
            {processing ? "Analyzing..." : "Analyze all songs"}
          </button>
          <button onClick={async () => { await (window as any).ether.songs.resetLoudnessByStation(stationId); getProcessingStats().then(setProcessingStats); }}
            style={{ padding: "8px 14px", borderRadius: 0, fontSize: 12, fontWeight: 600, background: "var(--bg-tertiary)", color: "var(--text-tertiary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>
            Reset
          </button>
        </div>
        <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginTop: 10 }}>Target is -14 LUFS — the broadcast standard used by most radio stations. This runs in the background and doesn't affect playback.</div>
      </Section>

      {/* ── MIDI Controllers ── */}
      <ControllersSection />

      {/* ── Clean Filenames ── */}
      <Section category="audio" icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>} title="Clean Filenames" description="Strip spotdown tags and timestamp prefixes from audio filenames — cleans up bulk-downloaded libraries">
        {/* Words to remove */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>Strings to remove</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <input
              value={cleanWordInput}
              onChange={e => setCleanWordInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && cleanWordInput.trim() && !cleanWords.includes(cleanWordInput.trim())) {
                  setCleanWords(w => [...w, cleanWordInput.trim()]); setCleanWordInput("");
                }
              }}
              placeholder="Add word to remove…"
              style={{ flex: 1, padding: "8px 12px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none" }}
            />
            <button
              onClick={() => {
                const w = cleanWordInput.trim();
                if (w && !cleanWords.includes(w)) { setCleanWords(ws => [...ws, w]); setCleanWordInput(""); }
              }}
              style={{ padding: "8px 14px", borderRadius: 0, fontSize: 12, fontWeight: 600, background: "var(--bg-tertiary)", color: "var(--text-tertiary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>
              Add
            </button>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap" as any, gap: 6 }}>
            {cleanWords.map(w => (
              <span key={w} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", borderRadius: 0, fontSize: 12, color: "var(--text-secondary)" }}>
                {w}
                <button onClick={() => setCleanWords(ws => ws.filter(x => x !== w))} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-tertiary)", fontSize: 14, lineHeight: 1, padding: 0, marginLeft: 2 }}>×</button>
              </span>
            ))}
          </div>
        </div>

        {/* Folder picker */}
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <input
            value={cleanFolder}
            onChange={e => { setCleanFolder(e.target.value); setCleanPreview(null); setCleanResult(null); setCleanError(null); }}
            placeholder="Paste folder path or browse…"
            style={{ flex: 1, padding: "9px 12px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", boxSizing: "border-box" as any }}
          />
          <button
            onClick={async () => {
              const result = await invoke("dialog:openDirectory");
              if (result) { setCleanFolder(result); setCleanPreview(null); setCleanResult(null); setCleanError(null); }
            }}
            style={{ padding: "8px 14px", borderRadius: 0, fontSize: 12, fontWeight: 600, background: "var(--bg-tertiary)", color: "var(--text-tertiary)", border: "1px solid var(--border-primary)", cursor: "pointer", whiteSpace: "nowrap" as any }}>
            Browse…
          </button>
        </div>

        {/* Action buttons */}
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button
            disabled={!cleanFolder || cleanBusy}
            onClick={async () => {
              setCleanBusy(true); setCleanResult(null); setCleanError(null); setCleanPreview(null);
              try {
                const r = await invoke("clean_filenames", { folderPath: cleanFolder, commit: false, stringsToRemove: cleanWords });
                if (!r.ok) { setCleanError(r.error || "Unknown error"); return; }
                setCleanPreview(r.renames || []);
              } catch (e: any) {
                setCleanError(e?.message || String(e));
              } finally { setCleanBusy(false); }
            }}
            style={{ padding: "8px 18px", borderRadius: 0, fontSize: 12, fontWeight: 600, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: (!cleanFolder || cleanBusy) ? "default" : "pointer", opacity: (!cleanFolder || cleanBusy) ? 0.5 : 1 }}>
            {cleanBusy ? "Scanning…" : "Preview"}
          </button>
          {cleanPreview && cleanPreview.length > 0 && !cleanResult && (
            <button
              disabled={cleanBusy}
              onClick={async () => {
                if (!confirm(`Rename ${cleanPreview.length} file${cleanPreview.length !== 1 ? "s" : ""}? This cannot be undone.`)) return;
                setCleanBusy(true); setCleanError(null);
                try {
                  const r = await invoke("clean_filenames", { folderPath: cleanFolder, commit: true, stringsToRemove: cleanWords });
                  if (!r.ok) { setCleanError(r.error || "Unknown error"); return; }
                  setCleanResult({ renamed: r.renamed, errors: r.errors || [] });
                  setCleanPreview(null);
                } catch (e: any) {
                  setCleanError(e?.message || String(e));
                } finally { setCleanBusy(false); }
              }}
              style={{ padding: "8px 18px", borderRadius: 0, fontSize: 12, fontWeight: 600, background: "var(--accent-green)", color: "#fff", border: "none", cursor: cleanBusy ? "default" : "pointer" }}>
              Rename {cleanPreview.length} file{cleanPreview.length !== 1 ? "s" : ""}
            </button>
          )}
        </div>

        {/* Error */}
        {cleanError && (
          <div style={{ padding: "10px 14px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 0, fontSize: 12, color: "var(--accent-red)", marginBottom: 10 }}>
            {cleanError}
          </div>
        )}
        {/* Preview table */}
        {cleanPreview !== null && cleanPreview.length === 0 && (
          <div style={{ padding: "10px 14px", background: "rgba(74,222,128,0.08)", border: "1px solid rgba(74,222,128,0.2)", borderRadius: 0, fontSize: 12, color: "var(--accent-green)" }}>
            No files need renaming in that folder.
          </div>
        )}
        {cleanPreview && cleanPreview.length > 0 && (
          <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--border-primary)", borderRadius: 0 }}>
            {cleanPreview.map((r, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, padding: "7px 12px", borderBottom: i < cleanPreview.length - 1 ? "1px solid var(--border-primary)" : "none", background: i % 2 ? "var(--bg-tertiary)" : "transparent" }}>
                <div style={{ fontSize: 11, color: "var(--text-tertiary)", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>{r.before}</div>
                <div style={{ fontSize: 11, color: "var(--accent-green)", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as any }}>→ {r.after}</div>
              </div>
            ))}
          </div>
        )}
        {/* Result */}
        {cleanResult && (
          <div style={{ padding: "10px 14px", background: cleanResult.errors.length ? "rgba(251,191,36,0.08)" : "rgba(74,222,128,0.08)", border: `1px solid ${cleanResult.errors.length ? "rgba(251,191,36,0.3)" : "rgba(74,222,128,0.2)"}`, borderRadius: 0, fontSize: 12, color: cleanResult.errors.length ? "var(--accent-amber)" : "var(--accent-green)" }}>
            Renamed {cleanResult.renamed} file{cleanResult.renamed !== 1 ? "s" : ""}.
            {cleanResult.errors.length > 0 && <div style={{ marginTop: 4 }}>{cleanResult.errors.length} error{cleanResult.errors.length !== 1 ? "s" : ""}: {cleanResult.errors[0]}</div>}
          </div>
        )}
        <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginTop: 10 }}>Also strips leading timestamp prefixes like <code>1776659272680_</code> and collapses double/trailing underscores.</div>
      </Section>

      {/* ── Keep My Station On Air (HA auto-logon) ── */}
      <KeepOnAirSection />

      {/* ── Accounts you can access (RBAC, read-only) ── */}
      <AccessibleAccountsSection />

      {/* ── Backup ── */}
      {/* ── Cloud Backup — the everyday safety net (leads the tab) ── */}
      <Section category="backup" icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>} title="Cloud Backup" description="An always-current copy of your whole station, kept safe online — every station, your schedule, and your settings. If a computer dies or you move to a new one, it all comes back.">

        {/* Status hero + primary action */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" as any, padding: "16px 18px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 38, height: 38, borderRadius: 999, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 19, background: (r2LastBackup > 0 && r2LastStatus === "success") ? "rgba(34,197,94,0.15)" : "var(--bg-secondary)", color: (r2LastBackup > 0 && r2LastStatus === "success") ? "var(--accent-green)" : "var(--text-tertiary)" }}>
              {(r2LastBackup > 0 && r2LastStatus === "success" && !r2BackingNow) ? "✓" : "☁"}
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>
                {r2BackingNow ? "Backing up…" : (r2LastBackup > 0 && r2LastStatus === "success") ? "Your station is backed up" : "Not backed up yet"}
              </div>
              <div style={{ fontSize: 12.5, color: "var(--text-tertiary)", marginTop: 2 }}>
                {r2BackingNow ? "Sending your latest changes to the cloud" : r2LastBackup > 0 ? `Last backed up ${timeAgo(r2LastBackup)}` : "Send your first backup whenever you're ready"}
              </div>
            </div>
          </div>
          <button onClick={runCloudBackupNow} disabled={r2BackingNow}
            style={{ padding: "11px 22px", fontSize: 13.5, fontWeight: 700, background: "var(--accent-green)", color: "#000", border: "none", cursor: r2BackingNow ? "default" : "pointer", borderRadius: 0, opacity: r2BackingNow ? 0.6 : 1 }}>
            {r2BackingNow ? "Backing up…" : "Back up now"}
          </button>
        </div>
        {!r2BackingNow && r2BackupNowStatus && (
          <div style={{ fontSize: 12.5, marginTop: -10, marginBottom: 18, color: r2BackupNowStatus.startsWith("✓") ? "var(--accent-green)" : r2BackupNowStatus.startsWith("✗") ? "var(--accent-red)" : "var(--text-secondary)" }}>{r2BackupNowStatus}</div>
        )}

        {/* Automatic backup */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, flexWrap: "wrap" as any, paddingBottom: 18, borderBottom: "1px solid var(--border-primary)", marginBottom: 18 }}>
          <div style={{ minWidth: 220 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text-primary)" }}>Back up automatically</div>
            <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 2 }}>Keeps your cloud copy current while ether is open.</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <select value={r2Interval} onChange={e => setR2Interval(Number(e.target.value))} disabled={!r2Enabled}
              style={{ padding: "8px 10px", fontSize: 12.5, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", borderRadius: 0, cursor: r2Enabled ? "pointer" : "default", outline: "none", opacity: r2Enabled ? 1 : 0.45 }}>
              <option value={1}>Every hour</option>
              <option value={6}>Every 6 hours</option>
              <option value={12}>Every 12 hours</option>
              <option value={24}>Once a day</option>
            </select>
            <button onClick={() => setR2Enabled(e => !e)} aria-label="Toggle automatic backup"
              style={{ position: "relative", width: 46, height: 26, borderRadius: 999, border: "none", flexShrink: 0, cursor: "pointer", background: r2Enabled ? "var(--accent-green)" : "var(--bg-tertiary)", boxShadow: r2Enabled ? "none" : "inset 0 0 0 1px var(--border-primary)" }}>
              <span style={{ position: "absolute", top: 3, left: r2Enabled ? 23 : 3, width: 20, height: 20, borderRadius: 999, background: "#fff", transition: "left 0.15s ease" }} />
            </button>
            <button onClick={saveR2Config} disabled={r2Saving}
              style={{ padding: "8px 14px", fontSize: 12, fontWeight: 600, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer", borderRadius: 0, opacity: r2Saving ? 0.6 : 1 }}>
              {r2Saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
        {(r2SaveStatus || r2TestStatus) && (
          <div style={{ fontSize: 12, marginTop: -10, marginBottom: 18, color: (r2SaveStatus || r2TestStatus).startsWith("✓") ? "var(--accent-green)" : "var(--accent-red)" }}>{r2SaveStatus || r2TestStatus}</div>
        )}

        {/* Music files */}
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>Your music files</div>
          <div style={{ fontSize: 12.5, color: "var(--text-tertiary)", marginBottom: 14, lineHeight: 1.55 }}>
            Backups above save your station's setup — not the audio itself. Send your songs to the cloud once, and any computer signed into your account can pull your whole library down into the same folder.
          </div>

          <div style={{ background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", padding: "12px 14px", marginBottom: 14 }}>
            <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--text-secondary)", letterSpacing: "0.05em", marginBottom: 6 }}>WHERE YOUR SONGS LIVE</div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" as any }}>
              <span style={{ flex: 1, minWidth: 200, fontSize: 12.5, color: "var(--text-secondary)", wordBreak: "break-all" }}>{musicDir || "Default folder"}</span>
              <button onClick={chooseLibraryFolder} disabled={libUploading}
                style={{ padding: "6px 14px", fontSize: 12, fontWeight: 600, background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: libUploading ? "default" : "pointer", borderRadius: 0, opacity: libUploading ? 0.5 : 1 }}>
                Change folder
              </button>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" as any }}>
            <button onClick={uploadLibrary} disabled={libUploading}
              style={{ padding: "10px 20px", fontSize: 13, fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: libUploading ? "default" : "pointer", borderRadius: 0, opacity: libUploading ? 0.6 : 1 }}>
              {libUploading ? "Working…" : "Send my music to the cloud"}
            </button>
            {libUploading && (
              <button onClick={cancelLibraryUpload}
                style={{ padding: "10px 16px", fontSize: 12.5, fontWeight: 600, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer", borderRadius: 0 }}>
                Stop
              </button>
            )}
            {libUploading && libProgress && (
              <span style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
                {libProgress.phase === "consolidate" ? "Gathering your songs" : "Uploading"}: {libProgress.done.toLocaleString()} / {libProgress.total.toLocaleString()}{libProgress.errors > 0 ? ` · ${libProgress.errors} skipped` : ""}
              </span>
            )}
            {!libUploading && libUploadMsg && (
              <span style={{ fontSize: 12.5, color: libUploadMsg.startsWith("✓") ? "var(--accent-green)" : "var(--accent-red)" }}>{libUploadMsg}</span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" as any, marginTop: 12 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-tertiary)", cursor: libUploading ? "default" : "pointer" }}>
              <input type="checkbox" checked={libForce} disabled={libUploading} onChange={(e) => setLibForce(e.target.checked)} />
              Re-send every song, even ones already uploaded
            </label>
            <button onClick={testR2Connection} disabled={r2Testing}
              style={{ padding: 0, fontSize: 11.5, fontWeight: 600, background: "transparent", color: "var(--text-tertiary)", border: "none", textDecoration: "underline", cursor: r2Testing ? "default" : "pointer", opacity: r2Testing ? 0.5 : 1 }}>
              {r2Testing ? "Checking connection…" : "Having trouble? Check connection"}
            </button>
          </div>
        </div>
      </Section>

      {/* ── Danger zone — factory reset ── */}
      <Section category="system" icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>} title="Factory reset this computer" description="Erase this computer's Ether data and start over from first-time setup — does not touch other computers on your account">
        <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6, marginBottom: 14 }}>
          Wipes this computer's local database — stations, library, schedule, users, and settings — and relaunches into onboarding. Other computers on your account are unaffected. Consider <strong>Back up now</strong> above first. <strong>This cannot be undone.</strong>
        </div>
        <button onClick={() => { setFrOpen(true); setFrEmail1(""); setFrEmail2(""); setFrErr(""); }} style={{ padding: "8px 18px", borderRadius: 0, fontSize: 12, fontWeight: 700, background: "rgba(239,68,68,0.12)", color: "#ef4444", border: "1px solid rgba(239,68,68,0.4)", cursor: "pointer" }}>
          Factory reset…
        </button>
      </Section>

      {frOpen && (
        <div onClick={() => { if (!frBusy) setFrOpen(false); }} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, zIndex: 1000 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 460, background: "var(--bg-secondary)", border: "1px solid rgba(239,68,68,0.45)", borderRadius: 0, padding: 28, fontFamily: "'Inter', system-ui, sans-serif" }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: "#ef4444", marginBottom: 8, fontFamily: "'Newsreader', Georgia, serif" }}>Factory reset this computer</div>
            <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6, marginBottom: 18 }}>
              This permanently erases this computer's Ether data — stations, library, schedule, users, and settings — and restarts setup from scratch. It cannot be undone.
            </div>
            <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 8 }}>
              Type {acctEmail.trim() ? <>your account email <strong style={{ color: "var(--text-primary)" }}>{acctEmail.trim()}</strong></> : <><strong style={{ color: "var(--text-primary)" }}>RESET</strong></>} <strong>twice</strong> to confirm:
            </div>
            <input value={frEmail1} onChange={(e) => { setFrEmail1(e.target.value); setFrErr(""); }} placeholder={frTarget} autoFocus style={frInput} />
            <input value={frEmail2} onChange={(e) => { setFrEmail2(e.target.value); setFrErr(""); }} onKeyDown={(e) => { if (e.key === "Enter" && frMatch && !frBusy) doFactoryReset(); }} placeholder={frTarget} style={frInput} />
            {frErr && <div style={{ fontSize: 12, color: "#ef4444", marginBottom: 12 }}>{frErr}</div>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
              <button onClick={() => setFrOpen(false)} disabled={frBusy} style={{ padding: "9px 16px", borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-secondary)", cursor: "pointer", fontSize: 13 }}>Cancel</button>
              <button onClick={doFactoryReset} disabled={!frMatch || frBusy} style={{ padding: "9px 16px", borderRadius: 0, border: "none", background: frMatch && !frBusy ? "#ef4444" : "rgba(239,68,68,0.35)", color: "#fff", fontWeight: 700, cursor: frMatch && !frBusy ? "pointer" : "not-allowed", fontSize: 13 }}>{frBusy ? "Resetting…" : "Erase & restart setup"}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Save a copy on this computer (secondary, manual snapshot) ── */}
      <Section category="backup" icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>} title="Save a copy on this computer" description="A manual snapshot kept on this PC only — handy right before a big change so you can roll back. Audio files aren't included.">
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: backups.length > 0 ? 16 : 0 }}>
          <button onClick={backup} disabled={backupLoading} style={{ padding: "10px 20px", borderRadius: 0, fontSize: 13, fontWeight: 600, background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", cursor: "pointer", opacity: backupLoading ? 0.6 : 1 }}>
            {backupLoading ? "Saving…" : "Save a snapshot"}
          </button>
          {backupStatus && <span style={{ fontSize: 12.5, color: backupStatus.startsWith("✓") ? "var(--accent-green)" : "var(--accent-red)" }}>{backupStatus}</span>}
        </div>
        {backups.length > 0 && (
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-tertiary)", letterSpacing: "0.06em", textTransform: "uppercase" as any, marginBottom: 8 }}>Your saved snapshots</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {backups.map(name => (
                <div key={name} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--bg-tertiary)", borderRadius: 0, padding: "10px 14px", border: "1px solid var(--border-primary)" }}>
                  <span style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>{formatBackupName(name)}</span>
                  <button onClick={() => restore(name)} style={{ padding: "5px 14px", borderRadius: 0, fontSize: 12.5, fontWeight: 600, background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>
                    Restore
                  </button>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 8 }}>Snapshots older than 7 days are removed automatically.</div>
          </div>
        )}
        {backups.length === 0 && <div style={{ fontSize: 12.5, color: "var(--text-tertiary)", marginTop: 8 }}>No snapshots yet.</div>}
      </Section>

      {/* Experience Mode removed — deck visibility is now controlled
          entirely by Configure Decks (the modal in the toolbar). */}

      {/* ── Send an Invite ── */}
      <Section
        category="station"
        icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.9 10.66a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.8 0h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 7.91a16 16 0 0 0 6.29 6.29l1.18-1.18a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 14.92z"/></svg>}
        title="Send an Invite"
        description="Generate a personalised invite file for a new operator. Place it next to the installer and ether will configure their station automatically on first launch."
      >
        <InviteGenerator />
      </Section>

      {/* ── Station Identity ── */}
      <Section
        category="station"
        icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>}
        title="Station Identity"
        description="Upload a station logo — displayed on the On-Shift welcome screen"
      >
        <StationLogoUploader />
      </Section>

        {/* ── Active AI Provider ── */}
        <Section
          category="integrations"
          icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>}
          title="Active AI Provider"
          description="Choose which AI powers the DeskProducer assistant"
        >
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
            {(["anthropic", "openai", "google"] as const).map(p => {
              const labels = { anthropic: "Claude (Anthropic)", openai: "ChatGPT (OpenAI)", google: "Gemini (Google)" };
              const active = aiProvider === p;
              const hasKey = keyStatus[p];
              return (
                <button key={p} onClick={() => saveProvider(p)} style={{
                  padding: "9px 18px", borderRadius: 0, fontSize: 12, fontWeight: 600, cursor: "pointer",
                  border: `1px solid ${active ? "var(--accent-blue)" : "var(--border-primary)"}`,
                  background: active ? "var(--accent-blue)" : "var(--bg-tertiary)",
                  color: active ? "#fff" : hasKey ? "var(--text-primary)" : "var(--text-tertiary)",
                  transition: "all 0.15s", display: "flex", alignItems: "center", gap: 6,
                }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: hasKey ? "var(--accent-green)" : "var(--text-tertiary)", flexShrink: 0, display: "inline-block" }} />
                  {labels[p]}
                </button>
              );
            })}
          </div>
          {aiProviderSaved && <div style={{ fontSize: 13, color: "var(--accent-green)", marginTop: 8 }}>✓ Saved</div>}
        </Section>

        {/* ── Provider Cards ── */}
        <CategoryGate category="integrations">
        {([
          {
            id: "anthropic",
            name: "Anthropic (Claude)",
            placeholder: "sk-ant-...",
            keyUrl: "https://console.anthropic.com/settings/keys",
            keyUrlLabel: "console.anthropic.com/settings/keys",
            hint: "Starts with sk-ant-",
            value: anthropicInput,
            set: setAnthropicInput,
            color: "#d4770a",
          },
          {
            id: "openai",
            name: "OpenAI (ChatGPT)",
            placeholder: "sk-...",
            keyUrl: "https://platform.openai.com/api-keys",
            keyUrlLabel: "platform.openai.com/api-keys",
            hint: "Starts with sk-",
            value: openaiInput,
            set: setOpenaiInput,
            color: "#10a37f",
          },
          {
            id: "google",
            name: "Google (Gemini)",
            placeholder: "AIza...",
            keyUrl: "https://aistudio.google.com/apikey",
            keyUrlLabel: "aistudio.google.com/apikey",
            hint: "Starts with AIza",
            value: googleInput,
            set: setGoogleInput,
            color: "#4285f4",
          },
        ] as const).map(card => {
          const connected = (keyStatus as any)[card.id];
          const busy = connectingProvider === card.id;
          return (
            <div key={card.id} style={{ background: "var(--bg-secondary)", border: `1px solid ${connected ? "rgba(52,211,153,0.3)" : "var(--border-primary)"}`, borderRadius: 0, overflow: "hidden", marginBottom: 12 }}>
              <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border-primary)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 10, height: 10, borderRadius: "50%", background: card.color, flexShrink: 0 }} />
                  <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", fontFamily: "'Inter', sans-serif" }}>{card.name}</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, color: connected ? "var(--accent-green)" : "var(--text-tertiary)" }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: connected ? "var(--accent-green)" : "var(--text-tertiary)", display: "inline-block" }} />
                  {connected ? "Connected" : "Not connected"}
                </div>
              </div>
              <div style={{ padding: "14px 20px" }}>
                <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginBottom: 10 }}>
                  Get your API key at{" "}
                  <a href={card.keyUrl} target="_blank" rel="noreferrer" style={{ color: "#c4b5fd", textDecoration: "underline" }} onClick={e => { e.preventDefault(); (window as any).ether?.system?.openUrl(card.keyUrl); }}>
                    {card.keyUrlLabel}
                  </a>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    type="password"
                    value={card.value}
                    onChange={e => card.set(e.target.value as any)}
                    placeholder={connected ? "••••••••••••••••" : card.placeholder}
                    style={{ flex: 1, padding: "8px 12px", borderRadius: 0, fontSize: 12, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}
                  />
                  <button
                    onClick={() => connectProvider(card.id, card.value)}
                    disabled={!card.value.trim() || busy}
                    style={{ padding: "8px 16px", borderRadius: 0, fontSize: 13, fontWeight: 600, border: "none", cursor: card.value.trim() && !busy ? "pointer" : "default", background: card.value.trim() && !busy ? "var(--accent-blue)" : "var(--bg-tertiary)", color: card.value.trim() && !busy ? "#fff" : "var(--text-tertiary)", transition: "all 0.15s", whiteSpace: "nowrap" as const }}>
                    {busy ? "Saving..." : "Connect"}
                  </button>
                  {connected && (
                    <button onClick={() => disconnectProvider(card.id)} style={{ padding: "8px 12px", borderRadius: 0, fontSize: 13, fontWeight: 600, border: "1px solid var(--border-secondary)", cursor: "pointer", background: "transparent", color: "var(--text-tertiary)", transition: "all 0.15s", whiteSpace: "nowrap" as const }}>
                      Disconnect
                    </button>
                  )}
                </div>
                {card.value && <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 6 }}>{card.hint}</div>}
              </div>
            </div>
          );
        })}
        </CategoryGate>

        {/* ── Weather (OpenWeatherMap) ── */}
        <Section
          category="integrations"
          icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>}
          title="Weather — OpenWeatherMap"
          description="Powers the Weather button in DeskProducer with real Las Vegas conditions"
        >
          <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginBottom: 10 }}>
            Free API key at{" "}
            <a href="https://openweathermap.org/api" target="_blank" rel="noreferrer" style={{ color: "#c4b5fd", textDecoration: "underline" }} onClick={e => { e.preventDefault(); (window as any).ether?.system?.openUrl("https://openweathermap.org/api"); }}>
              openweathermap.org/api
            </a>
            {" "}— sign up, then copy the key from your dashboard. You can also set <code style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 12, background: "var(--bg-tertiary)", padding: "1px 5px", borderRadius: 0 }}>OPENWEATHERMAP_API_KEY</code> in your .env file.
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="password"
              value={weatherInput}
              onChange={e => setWeatherInput(e.target.value)}
              placeholder={keyStatus.weather ? "••••••••••••••••" : "Paste API key..."}
              style={{ flex: 1, padding: "8px 12px", borderRadius: 0, fontSize: 12, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", outline: "none", fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}
            />
            <button
              onClick={() => connectProvider("weather", weatherInput)}
              disabled={!weatherInput.trim() || connectingProvider === "weather"}
              style={{ padding: "8px 16px", borderRadius: 0, fontSize: 13, fontWeight: 600, border: "none", cursor: weatherInput.trim() ? "pointer" : "default", background: weatherInput.trim() ? "var(--accent-blue)" : "var(--bg-tertiary)", color: weatherInput.trim() ? "#fff" : "var(--text-tertiary)", transition: "all 0.15s" }}>
              {connectingProvider === "weather" ? "Saving..." : "Connect"}
            </button>
            {keyStatus.weather && (
              <button onClick={() => disconnectProvider("weather")} style={{ padding: "8px 12px", borderRadius: 0, fontSize: 13, fontWeight: 600, border: "1px solid var(--border-secondary)", cursor: "pointer", background: "transparent", color: "var(--text-tertiary)" }}>
                Disconnect
              </button>
            )}
          </div>
          <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: keyStatus.weather ? "var(--accent-green)" : "var(--text-tertiary)" }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: keyStatus.weather ? "var(--accent-green)" : "var(--text-tertiary)", display: "inline-block" }} />
            {keyStatus.weather ? "Connected — Weather button is live" : "Not connected — Weather button will show a placeholder"}
          </div>
        </Section>
      {/* ── Spotify Integration ── */}
      <Section
        category="integrations"
        icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" style={{ color: "#1db954" }}><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>}
        title="Spotify Integration"
        description="Connect your Spotify Developer credentials to import pre-screened music into your library. Create an app at developer.spotify.com — use Client Credentials flow."
      >
        <SpotifyCredentialForm />
      </Section>

      {/* ── Musixmatch Lyrics Scanner ── */}
      <Section
        category="integrations"
        icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>}
        title="Musixmatch Lyrics Scanner"
        description="Scan imported song lyrics for thematic red flags — violence, explicit language, hate speech, political content. Flags are shown in amber for manual review. Free tier at developer.musixmatch.com."
      >
        <MusixmatchKeyForm />
      </Section>

      {/* ── Discogs Metadata ── */}
      <Section
        category="integrations"
        icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>}
        title="Discogs Metadata"
        description="Look up track metadata (title, artist, album, year, genre) from the Discogs database. Used by the Library's Edit Metadata dialog. Free API — create a personal access token at discogs.com/settings/developers."
      >
        <DiscogsCredentialForm />
      </Section>

      <SyncSection />

      <StationManagementSection />

      <UserManagement />

          </>
        </div>
      </div>
    </div>
    </SettingsFilterContext.Provider>
  );
}

// ── Users & Security ──────────────────────────────────────────
interface ManagedUser { id: number; name: string; role: string; pin_hash: string | null; color: string; }
const ROLES = [
  { value: "admin",          label: "Administrator" },
  { value: "jock",           label: "On-Air Jock" },
  { value: "music_director", label: "Music Director" },
];
const ROLE_COLORS = ["#f87171", "var(--accent-cyan)", "#a78bfa", "#34d399", "#fbbf24", "#fb923c", "#e879f9", "var(--accent-blue)"];

function UserManagement() {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [editUser, setEditUser] = useState<ManagedUser | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [pinModal, setPinModal] = useState<ManagedUser | null>(null);
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [pinError, setPinError] = useState("");
  // Add form
  const [addName, setAddName] = useState("");
  const [addRole, setAddRole] = useState("jock");
  const [addColor, setAddColor] = useState("var(--accent-cyan)");
  const [addPin, setAddPin] = useState("");

  const ether = (window as any).ether;
  // Profiles are INSTALL-level operators (in-app permissions), NOT station-scoped — manage
  // the whole install's roster regardless of which station is active. stationId is still
  // resolved to STAMP onto newly-added profiles (the station_id column is inert/legacy).
  const { stationId } = useActiveStation();

  const loadUsers = useCallback(async () => {
    const rows = await query<ManagedUser>("SELECT * FROM users ORDER BY id");
    setUsers(rows || []);
  }, []);
  useEffect(() => { loadUsers(); }, [loadUsers]);

  const handleAddUser = async () => {
    if (!addName.trim()) return;
    let pinHash: string | null = null;
    if (addPin.length === 4 && ether?.users?.hashPin) {
      pinHash = await ether.users.hashPin(addPin);
    } else if (addPin.length === 4) {
      pinHash = addPin;
    }
    await execute("INSERT INTO users (name, role, pin_hash, color, station_id) VALUES (?, ?, ?, ?, ?)", [addName.trim(), addRole, pinHash, addColor, stationId]);
    setShowAdd(false); setAddName(""); setAddRole("jock"); setAddPin(""); setAddColor("var(--accent-cyan)");
    loadUsers();
    window.dispatchEvent(new Event("ether:users-changed"));
  };

  const handleEditUser = async () => {
    if (!editUser || !editUser.name.trim()) return;
    await execute("UPDATE users SET name = ?, role = ?, color = ? WHERE id = ?", [editUser.name.trim(), editUser.role, editUser.color, editUser.id]);
    setEditUser(null); loadUsers();
    window.dispatchEvent(new Event("ether:users-changed"));
  };

  const handleDeleteUser = async (u: ManagedUser) => {
    const adminCount = users.filter(x => x.role === "admin").length;
    if (u.role === "admin" && adminCount <= 1) { alert("Cannot delete the last administrator."); return; }
    if (!confirm(`Delete user "${u.name}"?`)) return;
    await execute("DELETE FROM users WHERE id = ?", [u.id]);
    loadUsers();
    window.dispatchEvent(new Event("ether:users-changed"));
  };

  const handleChangePin = async () => {
    if (!pinModal) return;
    if (newPin.length > 0 && newPin.length !== 4) { setPinError("PIN must be exactly 4 digits"); return; }
    if (newPin !== confirmPin) { setPinError("PINs do not match"); return; }
    let pinHash: string | null = null;
    if (newPin.length === 4 && ether?.users?.hashPin) {
      pinHash = await ether.users.hashPin(newPin);
    } else if (newPin.length === 4) {
      pinHash = newPin;
    }
    await execute("UPDATE users SET pin_hash = ? WHERE id = ?", [pinHash, pinModal.id]);
    setPinModal(null); setNewPin(""); setConfirmPin(""); setPinError("");
    loadUsers();
    window.dispatchEvent(new Event("ether:users-changed"));
  };

  const handleRemovePin = async (u: ManagedUser) => {
    if (!confirm(`Remove PIN for "${u.name}"? They can log in without a PIN.`)) return;
    await execute("UPDATE users SET pin_hash = NULL WHERE id = ?", [u.id]);
    loadUsers();
    window.dispatchEvent(new Event("ether:users-changed"));
  };

  const inputStyle: React.CSSProperties = { padding: "6px 10px", borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", fontSize: 12, outline: "none", width: "100%" };
  const btnStyle: React.CSSProperties = { padding: "6px 14px", borderRadius: 0, fontSize: 13, fontWeight: 700, cursor: "pointer", border: "none", letterSpacing: "0.04em" };

  return (
    <Section
      category="station"
      icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>}
      title="Users & Security"
      description="Manage user profiles, roles, and PINs"
    >
      {/* User list */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
        {users.map(u => (
          <div key={u.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)" }}>
            <div style={{ width: 32, height: 32, background: u.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 700, color: "#000", flexShrink: 0 }}>
              {u.name[0]?.toUpperCase()}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>{u.name}</div>
              <div style={{ fontSize: 12, color: u.color }}>
                {ROLES.find(r => r.value === u.role)?.label || u.role}
                <span style={{ color: "var(--text-tertiary)", marginLeft: 8 }}>{u.pin_hash ? "PIN set" : "No PIN"}</span>
              </div>
            </div>
            <button onClick={() => setPinModal(u)} style={{ ...btnStyle, background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)" }}>
              {u.pin_hash ? "Change PIN" : "Set PIN"}
            </button>
            {u.pin_hash && (
              <button onClick={() => handleRemovePin(u)} style={{ ...btnStyle, background: "var(--bg-secondary)", color: "var(--accent-amber)", border: "1px solid var(--border-primary)" }}>
                Remove PIN
              </button>
            )}
            <button onClick={() => setEditUser({ ...u })} style={{ ...btnStyle, background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)" }}>
              Edit
            </button>
            <button onClick={() => handleDeleteUser(u)} style={{ ...btnStyle, background: "rgba(239,68,68,0.1)", color: "var(--accent-red)", border: "1px solid rgba(239,68,68,0.2)" }}>
              Delete
            </button>
          </div>
        ))}
      </div>

      <button onClick={() => setShowAdd(true)} style={{ ...btnStyle, background: "var(--accent-blue)", color: "#fff", width: "100%" }}>
        + Add User
      </button>

      {/* Add User modal */}
      {showAdd && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }} onClick={() => setShowAdd(false)}>
          <div onClick={e => e.stopPropagation()} style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", padding: 20, minWidth: 360 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", marginBottom: 16 }}>Add User</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <input value={addName} onChange={e => setAddName(e.target.value)} placeholder="Name" style={inputStyle} />
              <select value={addRole} onChange={e => setAddRole(e.target.value)} style={{ ...inputStyle, colorScheme: "dark" }}>
                {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 13, color: "var(--text-tertiary)" }}>Color</span>
                <div style={{ display: "flex", gap: 4 }}>
                  {ROLE_COLORS.map(c => (
                    <div key={c} onClick={() => setAddColor(c)} style={{ width: 22, height: 22, background: c, cursor: "pointer", border: addColor === c ? "2px solid #fff" : "2px solid transparent" }} />
                  ))}
                </div>
              </div>
              <input value={addPin} onChange={e => setAddPin(e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="PIN (4 digits, optional)" type="password" maxLength={4} style={inputStyle} />
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button onClick={handleAddUser} disabled={!addName.trim()} style={{ ...btnStyle, flex: 1, background: "var(--accent-blue)", color: "#fff", opacity: addName.trim() ? 1 : 0.4 }}>Create User</button>
                <button onClick={() => setShowAdd(false)} style={{ ...btnStyle, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)" }}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit User modal */}
      {editUser && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }} onClick={() => setEditUser(null)}>
          <div onClick={e => e.stopPropagation()} style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", padding: 20, minWidth: 360 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", marginBottom: 16 }}>Edit User</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <input value={editUser.name} onChange={e => setEditUser({ ...editUser, name: e.target.value })} placeholder="Name" style={inputStyle} />
              <select value={editUser.role} onChange={e => setEditUser({ ...editUser, role: e.target.value })} style={{ ...inputStyle, colorScheme: "dark" }}>
                {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 13, color: "var(--text-tertiary)" }}>Color</span>
                <div style={{ display: "flex", gap: 4 }}>
                  {ROLE_COLORS.map(c => (
                    <div key={c} onClick={() => setEditUser({ ...editUser, color: c })} style={{ width: 22, height: 22, background: c, cursor: "pointer", border: editUser.color === c ? "2px solid #fff" : "2px solid transparent" }} />
                  ))}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button onClick={handleEditUser} disabled={!editUser.name.trim()} style={{ ...btnStyle, flex: 1, background: "var(--accent-blue)", color: "#fff", opacity: editUser.name.trim() ? 1 : 0.4 }}>Save</button>
                <button onClick={() => setEditUser(null)} style={{ ...btnStyle, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)" }}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Change PIN modal */}
      {pinModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }} onClick={() => { setPinModal(null); setNewPin(""); setConfirmPin(""); setPinError(""); }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", padding: 20, minWidth: 320 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>{pinModal.pin_hash ? "Change" : "Set"} PIN for {pinModal.name}</div>
            <div style={{ fontSize: 13, color: "var(--text-tertiary)", marginBottom: 16 }}>Enter a 4-digit PIN or leave blank to remove</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <input value={newPin} onChange={e => { setNewPin(e.target.value.replace(/\D/g, "").slice(0, 4)); setPinError(""); }} placeholder="New PIN (4 digits)" type="password" maxLength={4} style={inputStyle} autoFocus />
              <input value={confirmPin} onChange={e => { setConfirmPin(e.target.value.replace(/\D/g, "").slice(0, 4)); setPinError(""); }} placeholder="Confirm PIN" type="password" maxLength={4} style={inputStyle} />
              {pinError && <div style={{ fontSize: 13, color: "var(--accent-red)" }}>{pinError}</div>}
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button onClick={handleChangePin} style={{ ...btnStyle, flex: 1, background: "var(--accent-blue)", color: "#fff" }}>Save PIN</button>
                <button onClick={() => { setPinModal(null); setNewPin(""); setConfirmPin(""); setPinError(""); }} style={{ ...btnStyle, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)" }}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </Section>
  );
}

// ── Manage Stations (delete) ──────────────────────────────────
// Station deletion lives here in Preferences (admin-only panel) so it's always
// reachable regardless of the header switcher, which is hidden below the Network
// tier. The active station can't be deleted — switch away first. Each delete is
// confirmed with the operator's admin PIN (verified against this station's admin
// profiles) so it can't be done casually.
interface ManageStation { id: number; name: string; callsign?: string; is_active: number; }

function StationManagementSection() {
  const ether = (window as any).ether;
  const [stations, setStations] = useState<ManageStation[]>([]);
  const [target, setTarget]     = useState<ManageStation | null>(null);
  const [pin, setPin]           = useState("");
  const [err, setErr]           = useState("");
  const [busy, setBusy]         = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await ether.stations.list();
      if (Array.isArray(list)) setStations(list);
    } catch {}
  }, []);
  useEffect(() => {
    load();
    const h = () => load();
    window.addEventListener("station-switched", h);
    return () => window.removeEventListener("station-switched", h);
  }, [load]);

  const closeModal = () => { setTarget(null); setPin(""); setErr(""); setBusy(false); };

  const confirmDelete = async () => {
    if (!target || busy) return;
    setBusy(true); setErr("");
    try {
      // Gate on the operator's admin PIN — verified against the install's admin profiles
      // (install-level, not station-scoped; otherwise a station with no local admin row
      // would skip the PIN gate entirely). If no admin has a PIN set, nothing to verify.
      const admins = await query<{ pin_hash: string | null }>(
        "SELECT pin_hash FROM users WHERE role = 'admin'"
      );
      const withPin = (admins || []).filter(a => a.pin_hash);
      if (withPin.length > 0) {
        if (pin.length !== 4) { setErr("Enter your 4-digit admin PIN."); setBusy(false); return; }
        let ok = false;
        for (const a of withPin) {
          ok = ether?.users?.verifyPin ? await ether.users.verifyPin(pin, a.pin_hash) : pin === a.pin_hash;
          if (ok) break;
        }
        if (!ok) { setErr("Incorrect admin PIN."); setBusy(false); return; }
      }
      const r = await ether.stations.delete(target.id);
      if (!r?.ok) { setErr(r?.error || "Delete failed."); setBusy(false); return; }
      closeModal();
      await load();
      window.dispatchEvent(new Event("station-switched")); // refresh the header switcher
    } catch (e: any) {
      setErr(e?.message || "Delete failed."); setBusy(false);
    }
  };

  const inputStyle: React.CSSProperties = { padding: "8px 12px", borderRadius: 0, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)", fontSize: 14, outline: "none", width: "100%", letterSpacing: "0.3em", textAlign: "center" as const };
  const btnStyle: React.CSSProperties = { padding: "6px 14px", borderRadius: 0, fontSize: 13, fontWeight: 700, cursor: "pointer", border: "none", letterSpacing: "0.04em" };

  return (
    <Section
      category="station"
      icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>}
      title="Manage Stations"
      description="Delete stations you no longer need (for example test stations). Confirmed with your admin PIN. The active station can't be deleted — switch to another first."
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {stations.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--text-tertiary)", padding: "8px 2px" }}>No stations.</div>
        ) : stations.map(s => {
          const isActive = !!s.is_active;
          return (
            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)" }}>
              {isActive && <span style={{ fontSize: 9, color: "#22c55e" }}>●</span>}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>{s.name}</div>
                {s.callsign && <div style={{ fontSize: 11, color: "var(--text-tertiary)", fontFamily: "monospace" }}>{s.callsign}{isActive ? " · on air" : ""}</div>}
              </div>
              <button
                onClick={() => { setTarget(s); setPin(""); setErr(""); }}
                disabled={isActive}
                title={isActive ? "Switch to another station first" : `Delete ${s.name}`}
                style={{ ...btnStyle, background: isActive ? "var(--bg-secondary)" : "rgba(239,68,68,0.1)", color: isActive ? "var(--text-tertiary)" : "var(--accent-red)", border: `1px solid ${isActive ? "var(--border-primary)" : "rgba(239,68,68,0.2)"}`, cursor: isActive ? "not-allowed" : "pointer", opacity: isActive ? 0.5 : 1 }}
              >
                Delete
              </button>
            </div>
          );
        })}
      </div>

      {/* Confirm + admin PIN modal */}
      {target && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }} onClick={() => !busy && closeModal()}>
          <div onClick={e => e.stopPropagation()} style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", padding: 20, minWidth: 360, maxWidth: 420 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--accent-red)", marginBottom: 6 }}>Delete “{target.name}”?</div>
            <div style={{ fontSize: 13, color: "var(--text-tertiary)", lineHeight: 1.5, marginBottom: 14 }}>
              This removes the station and its scoped data (schedules, logs, library associations). This cannot be undone.
            </div>
            <input
              value={pin}
              onChange={e => { setPin(e.target.value.replace(/\D/g, "").slice(0, 4)); setErr(""); }}
              onKeyDown={e => { if (e.key === "Enter") confirmDelete(); if (e.key === "Escape" && !busy) closeModal(); }}
              placeholder="Admin PIN"
              type="password"
              maxLength={4}
              autoFocus
              style={inputStyle}
            />
            {err && <div style={{ fontSize: 13, color: "var(--accent-red)", marginTop: 8 }}>{err}</div>}
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button onClick={confirmDelete} disabled={busy} style={{ ...btnStyle, flex: 1, background: "#e5484d", color: "#fff", opacity: busy ? 0.6 : 1 }}>
                {busy ? "Deleting…" : "Delete Station"}
              </button>
              <button onClick={closeModal} disabled={busy} style={{ ...btnStyle, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)" }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </Section>
  );
}
