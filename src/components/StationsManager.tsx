// StationsManager.tsx — multi-station profile management.
//
// Station group owners running multiple stations (e.g. AM + FM, or 5
// college stations) can add N station profiles here. Each profile has its
// own SQLite database — total data isolation. Switching stations causes
// Ether to relaunch against the other station's DB.
//
// Typical use: open this page, click "+ Add Station", fill in name +
// callsign + freq, then click "Switch to this station" when ready to
// work on it. Existing library + schedule + everything stays on the
// original station until you switch back.

import { useEffect, useState } from "react";

interface Station {
  slug: string;
  name: string;
  callsign: string;
  frequency: string;
  city: string;
  createdAt: number;
  dbPath: string;
  dbSizeBytes: number;
  dbExists: boolean;
  isActive: boolean;
}

function fmtBytes(b: number) {
  if (!b) return "empty";
  if (b > 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024).toFixed(0)} KB`;
}

export default function StationsManager({ onClose }: { onClose?: () => void }) {
  const ether = (window as any).ether;
  const [stations, setStations] = useState<Station[]>([]);
  const [loading, setLoading]   = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing]   = useState<Station | null>(null);
  const [status, setStatus]     = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const list = await ether?.stations?.list?.();
      setStations(Array.isArray(list) ? list : []);
    } catch (e) { console.error(e); }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const switchTo = async (s: Station) => {
    if (s.isActive) return;
    if (!confirm(`Switch to "${s.name}"? Ether will relaunch and load that station's data. Any unsaved work will be lost.`)) return;
    setStatus("Switching…");
    const r = await ether.stations.switch(s.slug);
    if (!r?.ok) setStatus("Error: " + r?.error);
  };

  const del = async (s: Station) => {
    if (!confirm(`Delete "${s.name}"? The station's database file will be permanently removed. This can't be undone.`)) return;
    const r = await ether.stations.delete(s.slug);
    if (r?.ok) load();
    else alert("Error: " + r?.error);
  };

  return (
    <div style={{ padding: 24, color: "var(--text-primary)", fontFamily: "'Inter', system-ui, sans-serif", minHeight: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: "-0.04em" }}>Stations</h1>
          <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 4 }}>
            Each station runs from its own database — total data isolation. Perfect for station groups running multiple signals from one studio.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => { setEditing(null); setShowForm(true); }}
            style={{ padding: "8px 16px", borderRadius: 0, fontSize: 13, fontWeight: 700, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer" }}>
            + Add Station
          </button>
          {onClose && <button onClick={onClose} style={btnStyle}>Close</button>}
        </div>
      </div>

      {status && (
        <div style={{ marginBottom: 12, padding: "10px 14px", background: "rgba(56,189,248,0.1)", border: "1px solid rgba(56,189,248,0.25)", color: "var(--accent-blue)", fontSize: 13 }}>
          {status}
        </div>
      )}

      {loading ? (
        <div style={{ padding: 40, textAlign: "center" as any, color: "var(--text-tertiary)" }}>Loading…</div>
      ) : stations.length === 0 ? (
        <div style={{ padding: 60, textAlign: "center" as any, background: "var(--bg-secondary)", border: "1px dashed var(--border-primary)" }}>
          <div style={{ fontSize: 14, color: "var(--text-secondary)" }}>No stations yet</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {stations.map(s => (
            <div key={s.slug} style={{
              background: s.isActive ? "rgba(56,189,248,0.06)" : "var(--bg-secondary)",
              border: s.isActive ? "1px solid var(--accent-blue)" : "1px solid var(--border-primary)",
              padding: "14px 16px",
              display: "grid", gridTemplateColumns: "1fr auto", gap: 14, alignItems: "center",
            }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                  <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>{s.name}</span>
                  {s.isActive && <span style={{ padding: "2px 8px", fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", background: "var(--accent-blue)", color: "#fff", textTransform: "uppercase" as any }}>ON AIR</span>}
                  {!s.dbExists && <span style={{ padding: "2px 8px", fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", background: "rgba(148,163,184,0.18)", color: "#94a3b8", textTransform: "uppercase" as any }}>empty — created on first switch</span>}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-tertiary)", display: "flex", gap: 10, flexWrap: "wrap" as any }}>
                  {s.callsign && <span style={{ fontFamily: "ui-monospace, monospace", fontWeight: 700 }}>{s.callsign}</span>}
                  {s.frequency && <span>{s.frequency}</span>}
                  {s.city && <span>{s.city}</span>}
                  <span>slug: <code>{s.slug}</code></span>
                  <span>DB: {fmtBytes(s.dbSizeBytes)}</span>
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {!s.isActive && (
                  <button onClick={() => switchTo(s)} style={{
                    padding: "7px 14px", fontSize: 12, fontWeight: 700,
                    background: "var(--accent-blue)", color: "#fff",
                    border: "none", borderRadius: 0, cursor: "pointer",
                  }}>Switch to this</button>
                )}
                <button onClick={() => { setEditing(s); setShowForm(true); }} style={miniBtn}>Edit</button>
                {!s.isActive && s.slug !== "default" && (
                  <button onClick={() => del(s)} style={{ ...miniBtn, color: "#ef4444" }}>Delete</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <StationForm
          initial={editing}
          onClose={() => { setShowForm(false); setEditing(null); }}
          onSaved={() => { setShowForm(false); setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function StationForm({ initial, onClose, onSaved }:
  { initial: Station | null; onClose: () => void; onSaved: () => void }) {
  const ether = (window as any).ether;
  const isEdit = !!initial;
  const [name, setName] = useState(initial?.name || "");
  const [callsign, setCallsign] = useState(initial?.callsign || "");
  const [frequency, setFrequency] = useState(initial?.frequency || "");
  const [city, setCity] = useState(initial?.city || "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!name.trim()) { alert("Name is required"); return; }
    setSaving(true);
    try {
      let r;
      if (isEdit) {
        r = await ether.stations.update(initial!.slug, { name: name.trim(), callsign, frequency, city });
      } else {
        r = await ether.stations.create({ name: name.trim(), callsign, frequency, city });
      }
      if (r?.ok) onSaved();
      else { alert("Error: " + r?.error); setSaving(false); }
    } catch (e: any) {
      alert("Error: " + (e?.message || e));
      setSaving(false);
    }
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "var(--bg-secondary)", border: "1px solid var(--border-primary)",
        width: "100%", maxWidth: 500, padding: "20px 22px",
      }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, marginBottom: 14 }}>
          {isEdit ? "Edit" : "Add"} Station
        </h3>
        <Field label="Station name*"><input value={name} onChange={e => setName(e.target.value)} style={inputStyle} placeholder='e.g. "KCOLL 89.7"' /></Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="Callsign"><input value={callsign} onChange={e => setCallsign(e.target.value)} style={inputStyle} placeholder="KXXX" /></Field>
          <Field label="Frequency"><input value={frequency} onChange={e => setFrequency(e.target.value)} style={inputStyle} placeholder="89.7 FM" /></Field>
        </div>
        <Field label="City"><input value={city} onChange={e => setCity(e.target.value)} style={inputStyle} placeholder="Las Vegas" /></Field>
        {!isEdit && (
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 4, lineHeight: 1.5 }}>
            A new, empty database will be created when you first switch to this station. The library, schedule, logs, and settings all start fresh.
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--border-primary)" }}>
          <button onClick={onClose} style={btnStyle}>Cancel</button>
          <button onClick={save} disabled={saving || !name.trim()} style={{
            ...btnStyle, background: name.trim() ? "var(--accent-blue)" : "var(--bg-tertiary)",
            color: name.trim() ? "#fff" : "var(--text-tertiary)",
            border: "none", cursor: name.trim() ? "pointer" : "not-allowed",
          }}>{saving ? "Saving…" : isEdit ? "Update" : "Create Station"}</button>
        </div>
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: "8px 14px", borderRadius: 0, fontSize: 12, fontWeight: 600,
  background: "var(--bg-tertiary)", color: "var(--text-secondary)",
  border: "1px solid var(--border-primary)", cursor: "pointer",
};
const miniBtn: React.CSSProperties = {
  padding: "5px 10px", borderRadius: 0, fontSize: 11, fontWeight: 600,
  background: "var(--bg-tertiary)", color: "var(--text-secondary)",
  border: "1px solid var(--border-primary)", cursor: "pointer",
};
const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", borderRadius: 0, fontSize: 13,
  background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
  color: "var(--text-primary)", outline: "none", boxSizing: "border-box",
};
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", marginBottom: 4, letterSpacing: "0.04em", textTransform: "uppercase" as any }}>{label}</div>
      {children}
    </div>
  );
}
