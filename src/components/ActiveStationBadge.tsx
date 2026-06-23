import { useEffect, useRef, useState } from "react";
import { usePlan } from "../hooks/usePlan";
import { fetchMyMemberships, type Membership } from "../lib/memberships";

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
  const ether = (window as any).ether;
  const { isStation } = usePlan(); // multi-station console = Network+ (per the pricing tiers)
  const [stations, setStations] = useState<Station[]>([]);
  const [active, setActive]     = useState<Station | null>(null);
  const [open, setOpen]         = useState(false);
  const [showNew, setShowNew]   = useState(false);
  // RBAC foundation (read-only): the accounts + accessible stations this person belongs to, and the
  // account currently seated on this install. Used only to LIST other accessible stations — no switch.
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [accountEmail, setAccountEmail] = useState<string>("");
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

  // Load the person's memberships (other accounts they can access) + the seated account email.
  useEffect(() => {
    fetchMyMemberships().then(setMemberships).catch(() => {});
    (async () => {
      try {
        const row = (await ether.installConfigKv?.get?.("account_email"))?.row;
        setAccountEmail(row?.value ? String(row.value).trim().toLowerCase() : "");
      } catch {}
    })();
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

  // Accounts (other than the one seated here) this person can access via membership. The OWNER account
  // is already Network to have granted access, so the membership ITSELF is the authority — these must
  // show regardless of the MEMBER's own tier. (All hooks run above this so rule-of-hooks order stays stable.)
  const otherAccounts = memberships.filter(
    (m) => (m.account_email || "").trim().toLowerCase() !== accountEmail && (m.stations?.length || 0) > 0
  );
  // The OWN-station switcher/creation is a Network+ feature; the accessible-via-membership list is NOT.
  // Hide the badge only when neither applies (Solo with no grants).
  if (!isStation && otherAccounts.length === 0) return null;

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
      <style>{`@keyframes ether-station-pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.4;transform:scale(0.82)} }`}</style>
      {/* Pill trigger */}
      <button
        onClick={() => setOpen(o => !o)}
        title={`Active station: ${active?.name ?? "—"}. Click to switch, add, or manage.`}
        style={{
          display: "inline-flex", alignItems: "center", gap: 7,
          height: 44, padding: "0 16px", borderRadius: 0,
          fontSize: 15, fontWeight: 800, letterSpacing: "0.06em",
          background: open ? "var(--bg-hover, rgba(255,255,255,0.08))" : "var(--bg-tertiary)",
          color: "var(--text-primary)",
          border: "1px solid var(--border-primary)",
          cursor: "pointer", transition: "background 0.1s",
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        }}
        onMouseEnter={e => { if (!open) (e.currentTarget as HTMLElement).style.background = "var(--bg-hover, rgba(255,255,255,0.08))"; }}
        onMouseLeave={e => { if (!open) (e.currentTarget as HTMLElement).style.background = "var(--bg-tertiary)"; }}
      >
        <span style={{ fontSize: 9, color: "#22c55e", animation: "ether-station-pulse 1.6s ease-in-out infinite", display: "inline-block" }}>●</span>
        <span>{label}</span>
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none" style={{ transform: open ? "rotate(180deg)" : undefined, transition: "transform 0.15s" }}>
          <path d="M1 2.5L4 5.5L7 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </button>

      {/* Dropdown */}
      {open && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 4px)", left: 0, zIndex: 999,
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
                color: s.is_active ? "var(--accent-blue)" : "var(--text-primary)",
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

          {/* RBAC foundation: stations in OTHER accounts this person can access (read-only listing) */}
          {otherAccounts.length > 0 && (
            <>
              <div style={{ height: 1, background: "var(--border-primary)", margin: "4px 0" }} />
              <div style={{ padding: "6px 12px 2px", fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", color: "var(--text-tertiary)" }}>
                ACCESSIBLE VIA YOUR ACCOUNT
              </div>
              {otherAccounts.map((m) => (
                <div key={m.account_id} style={{ padding: "0 0 4px" }}>
                  <div style={{ padding: "2px 12px", fontSize: 10, color: "var(--text-secondary)" }}>
                    {(m.account_name || m.account_email)} · {m.position}
                  </div>
                  {m.stations.map((st) => (
                    <div key={st.uuid}
                      title="View-only here for now — operating this station (switching to it) arrives with the sync bridge."
                      style={{ display: "flex", alignItems: "center", gap: 9, padding: "5px 12px 5px 22px", color: "var(--text-tertiary)", fontSize: 12, cursor: "default" }}>
                      <span style={{ flex: 1 }}>{st.name}</span>
                      <span style={{ fontSize: 9, opacity: 0.7 }}>view-only</span>
                    </div>
                  ))}
                </div>
              ))}
            </>
          )}

          {/* Divider */}
          <div style={{ height: 1, background: "var(--border-primary)", margin: "4px 0" }} />

          {/* New Station — creating your OWN stations is a Network+ feature; a member viewing granted
              stations on a lower tier must not see it. */}
          {isStation && (
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
          )}

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
        icecast_server_url: serverUrl.trim() || "44.244.52.207",
        icecast_mount: mount.trim() || "",   // blank → main process derives '/<slug>' from the name
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
              <input value={serverUrl} onChange={e => setServerUrl(e.target.value)} placeholder="44.244.52.207" style={inp} />
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
