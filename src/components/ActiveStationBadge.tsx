import { useEffect, useRef, useState } from "react";
import { usePlan } from "../hooks/usePlan";

interface Station {
  id: number;
  name: string;
  callsign?: string;
  frequency?: string;
  is_active: number;
}

interface Props {
  onManage: () => void;
  onSwitch: (id: number, name: string) => Promise<boolean>;
}

export default function ActiveStationBadge({ onManage, onSwitch }: Props) {
  const { isOperator } = usePlan();
  const ether = (window as any).ether;
  const [stations, setStations] = useState<Station[]>([]);
  const [active, setActive]     = useState<Station | null>(null);
  const [open, setOpen]         = useState(false);
  const [showNew, setShowNew]   = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);

  const loadStations = async () => {
    try {
      const list = await ether.stations.list();
      if (!Array.isArray(list)) return;
      setStations(list);
      setActive(list.find((s: Station) => s.is_active) ?? list[0] ?? null);
    } catch {}
  };

  useEffect(() => {
    loadStations();
    const handler = () => loadStations();
    window.addEventListener("station-switched", handler);
    return () => window.removeEventListener("station-switched", handler);
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!dropRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const label = active
    ? (active.callsign || active.name.slice(0, 12).toUpperCase())
    : "STATION";

  const handleSwitch = async (s: Station) => {
    setOpen(false);
    const ok = await onSwitch(s.id, s.name);
    if (ok) loadStations();
  };

  return (
    <div ref={dropRef} style={{ position: "relative", flexShrink: 0 }}>
      {/* Pill trigger */}
      <button
        onClick={() => {
          if (!isOperator) {
            window.dispatchEvent(new CustomEvent("ether:open-subscription"));
            return;
          }
          setOpen(o => !o);
        }}
        title={isOperator ? `Active station: ${active?.name ?? "—"}. Click to switch or manage.` : "Upgrade to Operator to manage multiple stations"}
        style={{
          display: "inline-flex", alignItems: "center", gap: 5,
          height: 32, padding: "0 10px", borderRadius: 0,
          fontSize: 11, fontWeight: 700, letterSpacing: "0.06em",
          background: open ? "rgba(56,189,248,0.22)" : "rgba(56,189,248,0.12)",
          color: "#38bdf8",
          border: "1px solid rgba(56,189,248,0.35)",
          cursor: "pointer", transition: "background 0.1s",
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        }}
        onMouseEnter={e => { if (!open) (e.currentTarget as HTMLElement).style.background = "rgba(56,189,248,0.2)"; }}
        onMouseLeave={e => { if (!open) (e.currentTarget as HTMLElement).style.background = "rgba(56,189,248,0.12)"; }}
      >
        <span style={{ fontSize: 8, color: "#22c55e" }}>●</span>
        <span>{label}</span>
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none" style={{ transform: open ? "rotate(180deg)" : undefined, transition: "transform 0.15s" }}>
          <path d="M1 2.5L4 5.5L7 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </button>

      {/* Dropdown */}
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 999,
          background: "var(--bg-secondary)", border: "1px solid var(--border-primary)",
          minWidth: 220, boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
          fontFamily: "'Inter', system-ui, sans-serif",
        }}>
          {/* Station list */}
          {stations.map(s => (
            <button
              key={s.id}
              onClick={() => handleSwitch(s)}
              style={{
                display: "flex", alignItems: "center", gap: 9, width: "100%",
                padding: "9px 12px", background: "transparent",
                border: "none", borderBottom: "1px solid rgba(255,255,255,0.04)",
                color: s.is_active ? "#38bdf8" : "var(--text-primary)",
                fontSize: 13, fontWeight: s.is_active ? 700 : 400,
                cursor: s.is_active ? "default" : "pointer", textAlign: "left",
              }}
              onMouseEnter={e => { if (!s.is_active) (e.currentTarget as HTMLElement).style.background = "var(--bg-tertiary)"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
            >
              <span style={{ width: 14, textAlign: "center", fontSize: 12 }}>
                {s.is_active ? "✓" : ""}
              </span>
              <span style={{ flex: 1 }}>{s.name}</span>
              {s.callsign && <span style={{ fontSize: 10, color: "var(--text-tertiary)", fontFamily: "monospace" }}>{s.callsign}</span>}
            </button>
          ))}

          {/* Divider */}
          <div style={{ height: 1, background: "var(--border-primary)", margin: "4px 0" }} />

          {/* New Station */}
          <button
            onClick={() => { setOpen(false); setShowNew(true); }}
            style={{
              display: "flex", alignItems: "center", gap: 9, width: "100%",
              padding: "9px 12px", background: "transparent", border: "none",
              color: "var(--text-secondary)", fontSize: 13, cursor: "pointer", textAlign: "left",
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "var(--bg-tertiary)"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
          >
            <span style={{ width: 14, textAlign: "center" }}>+</span>
            New Station…
          </button>

          {/* Manage Stations */}
          <button
            onClick={() => { setOpen(false); onManage(); }}
            style={{
              display: "flex", alignItems: "center", gap: 9, width: "100%",
              padding: "9px 12px", background: "transparent", border: "none",
              color: "var(--text-secondary)", fontSize: 13, cursor: "pointer", textAlign: "left",
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "var(--bg-tertiary)"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
          >
            <span style={{ width: 14, textAlign: "center" }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>
            </span>
            Manage Stations…
          </button>

        </div>
      )}

      {/* New Station modal */}
      {showNew && (
        <NewStationModal
          onClose={() => setShowNew(false)}
          onCreated={() => { setShowNew(false); loadStations(); }}
        />
      )}
    </div>
  );
}

// ─── New Station Modal ────────────────────────────────────────

function NewStationModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const ether = (window as any).ether;
  const [name,       setName]       = useState("");
  const [callsign,   setCallsign]   = useState("");
  const [serverUrl,  setServerUrl]  = useState("");
  const [mount,      setMount]      = useState("/live");
  const [password,   setPassword]   = useState("");
  const [bitrate,    setBitrate]    = useState("128");
  const [format,     setFormat]     = useState("mp3");
  const [saving,     setSaving]     = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) { setError("Station name is required."); return; }
    setSaving(true);
    setError(null);
    try {
      const r = await ether.stations.create({
        name: name.trim(), callsign: callsign.trim(),
        icecast_server_url: serverUrl.trim() || "127.0.0.1",
        icecast_mount: mount.trim() || "/live",
        icecast_password: password.trim() || "hackme",
        icecast_bitrate: parseInt(bitrate) || 128,
        icecast_format: format,
      });
      if (r?.ok) { onCreated(); }
      else {
        // Safety gate or other error — show inline, keep modal open
        const msg = r?.error || "Unknown error";
        if (msg.includes("renderer INSERT audit incomplete")) {
          setError("Multi-station creation is locked until Phase 3 database audit is complete. Contact development to unlock.");
        } else {
          setError(msg);
        }
      }
    } catch (e: any) {
      setError(e?.message || "Unexpected error");
    }
    setSaving(false);
  };

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", width: "100%", maxWidth: 480, fontFamily: "'Inter', system-ui, sans-serif" }}
      >
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border-primary)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>New Station</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 18, lineHeight: 1 }}>×</button>
        </div>

        <div style={{ padding: "20px" }}>
          {/* Error banner */}
          {error && (
            <div style={{
              marginBottom: 16, padding: "10px 14px",
              background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.35)",
              color: "#f87171", fontSize: 12, lineHeight: 1.5, borderRadius: 0,
            }}>
              {error}
            </div>
          )}

          <F label="Station Name *">
            <input autoFocus value={name} onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === "Enter" && submit()}
              placeholder='e.g. "KETH 98.7"' style={inp} />
          </F>
          <F label="Callsign">
            <input value={callsign} onChange={e => setCallsign(e.target.value)} placeholder="KETH" style={inp} />
          </F>

          <div style={{ borderTop: "1px solid var(--border-primary)", margin: "14px 0 14px", paddingTop: 4 }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)", marginBottom: 10 }}>ICECAST SETTINGS</div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <F label="Server URL">
              <input value={serverUrl} onChange={e => setServerUrl(e.target.value)} placeholder="127.0.0.1" style={inp} />
            </F>
            <F label="Mount">
              <input value={mount} onChange={e => setMount(e.target.value)} placeholder="/live" style={inp} />
            </F>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            <F label="Password">
              <input value={password} onChange={e => setPassword(e.target.value)} placeholder="hackme" type="password" style={inp} />
            </F>
            <F label="Bitrate">
              <select value={bitrate} onChange={e => setBitrate(e.target.value)} style={{ ...inp, background: "var(--bg-tertiary)", colorScheme: "dark" }}>
                {["64","96","128","192","256","320"].map(b => <option key={b} value={b}>{b} kbps</option>)}
              </select>
            </F>
            <F label="Format">
              <select value={format} onChange={e => setFormat(e.target.value)} style={{ ...inp, background: "var(--bg-tertiary)", colorScheme: "dark" }}>
                <option value="mp3">MP3</option>
                <option value="aac">AAC</option>
                <option value="ogg">OGG</option>
              </select>
            </F>
          </div>
        </div>

        <div style={{ padding: "12px 20px", borderTop: "1px solid var(--border-primary)", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={cancelBtn}>Cancel</button>
          <button onClick={submit} disabled={saving} style={{
            ...cancelBtn,
            background: "var(--accent-blue)", color: "#fff", border: "none",
            cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.7 : 1,
          }}>
            {saving ? "Creating…" : "Create Station"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Shared styles ────────────────────────────────────────────

const inp: React.CSSProperties = {
  width: "100%", padding: "7px 9px", borderRadius: 0, fontSize: 13,
  background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
  color: "var(--text-primary)", outline: "none", boxSizing: "border-box",
};

const cancelBtn: React.CSSProperties = {
  padding: "7px 16px", borderRadius: 0, fontSize: 12, fontWeight: 600,
  background: "var(--bg-tertiary)", color: "var(--text-secondary)",
  border: "1px solid var(--border-primary)", cursor: "pointer",
};

function F({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-tertiary)", marginBottom: 4, letterSpacing: "0.07em", textTransform: "uppercase" }}>{label}</div>
      {children}
    </div>
  );
}
