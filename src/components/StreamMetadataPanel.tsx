// StreamMetadataPanel.tsx — UI for the stream-metadata fan-out feature.
//
// Lets users add/edit/delete/test multiple "now playing" push targets:
// Icecast, Shoutcast v1/v2, TuneIn AIR, RDS encoder (serial), or generic
// webhook. Each target is independent — multiple Icecasts is fine, e.g.
// for primary + backup streams. The dispatcher (electron/metadata-dispatcher.js)
// fans every song-start event out to all enabled targets in parallel.
//
// Pure renderer code — all CRUD goes through `ether.metadata.*` IPC.

import { useEffect, useState } from "react";

type TargetType = "icecast" | "shoutcast" | "tunein" | "rds" | "webhook";

interface Target {
  id: number;
  name: string;
  type: TargetType;
  enabled: number;
  config_json: string;
  last_pushed_at: number;
  last_status: string;     // 'ok' | 'error' | ''
  last_error: string;
  push_count: number;
}

const TYPE_LABEL: Record<TargetType, string> = {
  icecast:   "Icecast 2",
  shoutcast: "Shoutcast",
  tunein:    "TuneIn AIR",
  rds:       "RDS Encoder (Serial)",
  webhook:   "Custom Webhook",
};

const TYPE_DESC: Record<TargetType, string> = {
  icecast:   "Pushes title/artist to an Icecast 2 server's admin API. Most internet radio stations use this.",
  shoutcast: "Pushes to Shoutcast v1 or v2 servers. Common with legacy stream providers.",
  tunein:    "Tells TuneIn what's playing — required for the TuneIn 'now playing' overlay on car receivers and the TuneIn app.",
  rds:       "Sends RadioText to an RDS encoder over a serial (COM) port. For FM broadcasters with Inovonics, Audemat, or Deva encoders.",
  webhook:   "POSTs JSON to any URL — for custom in-house dashboards, social posters, or third-party tools.",
};

const TYPE_COLOR: Record<TargetType, string> = {
  icecast:   "#38bdf8",
  shoutcast: "#a78bfa",
  tunein:    "#22c55e",
  rds:       "#f59e0b",
  webhook:   "#94a3b8",
};

// Empty config defaults per type — used when adding a new target.
const DEFAULT_CONFIG: Record<TargetType, any> = {
  icecast:   { host: "localhost", port: 8000, mount: "/stream", adminUser: "admin", adminPass: "", useHttps: false },
  shoutcast: { host: "localhost", port: 8000, sid: 1, password: "", version: 2 },
  tunein:    { partnerId: "", partnerKey: "", stationId: "" },
  rds:       { port: "COM3", baud: 9600, encoderType: "inovonics" },
  webhook:   { url: "https://example.com/now-playing", method: "POST", basicUser: "", basicPass: "" },
};

function fmtTimeAgo(unixSec: number): string {
  if (!unixSec) return "never";
  const sec = Math.floor(Date.now() / 1000) - unixSec;
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export default function StreamMetadataPanel() {
  const ether = (window as any).ether;
  const [targets, setTargets] = useState<Target[]>([]);
  const [editing, setEditing] = useState<Target | null>(null);
  const [adding, setAdding] = useState<TargetType | null>(null);
  const [testStatus, setTestStatus] = useState<Record<number, string>>({});

  const refresh = async () => {
    if (!ether?.metadata) return;
    try {
      const list = await ether.metadata.listTargets();
      setTargets(Array.isArray(list) ? list : []);
    } catch (e) {
      console.error("[METADATA] listTargets failed:", e);
    }
  };

  useEffect(() => { refresh(); }, []);

  const toggleEnabled = async (t: Target) => {
    let cfg: any = {}; try { cfg = JSON.parse(t.config_json || "{}"); } catch {}
    await ether.metadata.updateTarget({ id: t.id, name: t.name, type: t.type, enabled: t.enabled ? 0 : 1, config: cfg });
    refresh();
  };

  const deleteTarget = async (t: Target) => {
    if (!confirm(`Delete "${t.name}"? Metadata will stop pushing to this target.`)) return;
    await ether.metadata.deleteTarget(t.id);
    refresh();
  };

  const testTarget = async (t: Target) => {
    setTestStatus(s => ({ ...s, [t.id]: "Testing..." }));
    try {
      const r = await ether.metadata.testTarget(t.id);
      if (r?.ok) {
        setTestStatus(s => ({ ...s, [t.id]: "✓ Push succeeded" }));
      } else {
        setTestStatus(s => ({ ...s, [t.id]: `✗ ${r?.error || "failed"}` }));
      }
    } catch (e: any) {
      setTestStatus(s => ({ ...s, [t.id]: `✗ ${e?.message || e}` }));
    }
    setTimeout(() => setTestStatus(s => { const n = { ...s }; delete n[t.id]; return n; }), 4000);
    setTimeout(refresh, 500);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Target list */}
      {targets.length === 0 && (
        <div style={{ padding: "20px", background: "var(--bg-tertiary)", border: "1px dashed var(--border-primary)", borderRadius: 0, textAlign: "center" as any, color: "var(--text-tertiary)", fontSize: 13 }}>
          No metadata outputs configured. Add one below to start pushing now-playing data to your stream provider.
        </div>
      )}

      {targets.map(t => {
        let cfg: any = {}; try { cfg = JSON.parse(t.config_json || "{}"); } catch {}
        const summary =
          t.type === "icecast"   ? `${cfg.host}:${cfg.port}${cfg.mount}` :
          t.type === "shoutcast" ? `${cfg.host}:${cfg.port} (sid ${cfg.sid}, v${cfg.version})` :
          t.type === "tunein"    ? `Station ${cfg.stationId || "—"}` :
          t.type === "rds"       ? `${cfg.port} @ ${cfg.baud} baud (${cfg.encoderType})` :
          t.type === "webhook"   ? cfg.url :
          "";
        return (
          <div key={t.id} style={{ background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", borderRadius: 0, padding: "12px 14px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: TYPE_COLOR[t.type], flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>{t.name}</div>
                <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {TYPE_LABEL[t.type]} · {summary}
                </div>
              </div>
              {/* Status pill */}
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                <span style={{
                  fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", padding: "2px 7px",
                  background: t.last_status === "ok"    ? "rgba(34,197,94,0.15)"
                            : t.last_status === "error" ? "rgba(239,68,68,0.15)"
                            : "rgba(148,163,184,0.10)",
                  color:      t.last_status === "ok"    ? "#22c55e"
                            : t.last_status === "error" ? "#ef4444"
                            : "var(--text-tertiary)",
                  border: "none", textTransform: "uppercase",
                }}>
                  {t.last_status || "idle"}
                </span>
                <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                  {t.push_count} pushes · {fmtTimeAgo(t.last_pushed_at)}
                </span>
              </div>
              {/* Buttons */}
              <div style={{ display: "flex", gap: 4, marginLeft: 8 }}>
                <button onClick={() => toggleEnabled(t)} title={t.enabled ? "Disable" : "Enable"}
                  style={{ padding: "5px 10px", fontSize: 11, fontWeight: 600, borderRadius: 0,
                    background: t.enabled ? "rgba(34,197,94,0.15)" : "var(--bg-secondary)",
                    color: t.enabled ? "#22c55e" : "var(--text-tertiary)",
                    border: "1px solid " + (t.enabled ? "#22c55e44" : "var(--border-primary)"),
                    cursor: "pointer", letterSpacing: "0.04em" }}>
                  {t.enabled ? "ON" : "OFF"}
                </button>
                <button onClick={() => testTarget(t)} style={{ padding: "5px 10px", fontSize: 11, fontWeight: 600, borderRadius: 0, background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>Test</button>
                <button onClick={() => setEditing(t)} style={{ padding: "5px 10px", fontSize: 11, fontWeight: 600, borderRadius: 0, background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>Edit</button>
                <button onClick={() => deleteTarget(t)} style={{ padding: "5px 10px", fontSize: 11, fontWeight: 600, borderRadius: 0, background: "var(--bg-secondary)", color: "#ef4444", border: "1px solid var(--border-primary)", cursor: "pointer" }}>Del</button>
              </div>
            </div>
            {testStatus[t.id] && (
              <div style={{ marginTop: 8, padding: "6px 10px", background: testStatus[t.id].startsWith("✓") ? "rgba(34,197,94,0.10)" : "rgba(239,68,68,0.10)", color: testStatus[t.id].startsWith("✓") ? "#22c55e" : "#ef4444", fontSize: 11 }}>
                {testStatus[t.id]}
              </div>
            )}
            {t.last_status === "error" && t.last_error && !testStatus[t.id] && (
              <div style={{ marginTop: 6, fontSize: 11, color: "#ef4444", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.last_error}>
                Last error: {t.last_error}
              </div>
            )}
          </div>
        );
      })}

      {/* Add target — type picker */}
      <div style={{ borderTop: "1px solid var(--border-primary)", paddingTop: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 8, letterSpacing: "0.04em" }}>+ ADD A NEW METADATA OUTPUT</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 6 }}>
          {(Object.keys(TYPE_LABEL) as TargetType[]).map(type => (
            <button key={type} onClick={() => setAdding(type)} style={{
              padding: "10px 12px", borderRadius: 0, textAlign: "left" as any,
              background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
              cursor: "pointer", display: "flex", flexDirection: "column", gap: 2,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: TYPE_COLOR[type] }} />
                {TYPE_LABEL[type]}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)", lineHeight: 1.4 }}>{TYPE_DESC[type].slice(0, 70)}…</div>
            </button>
          ))}
        </div>
      </div>

      {/* Edit / Add modal */}
      {(editing || adding) && (
        <TargetEditor
          initial={editing ?? {
            id: 0, name: "New " + TYPE_LABEL[adding!], type: adding!,
            enabled: 1, config_json: JSON.stringify(DEFAULT_CONFIG[adding!]),
            last_pushed_at: 0, last_status: "", last_error: "", push_count: 0,
          }}
          onClose={() => { setEditing(null); setAdding(null); }}
          onSave={async (t, cfg) => {
            if (t.id) {
              await ether.metadata.updateTarget({ id: t.id, name: t.name, type: t.type, enabled: t.enabled, config: cfg });
            } else {
              await ether.metadata.addTarget({ name: t.name, type: t.type, enabled: t.enabled, config: cfg });
            }
            setEditing(null); setAdding(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

// ── Editor modal — common name field + type-specific config form ──
function TargetEditor({ initial, onClose, onSave }: {
  initial: Target;
  onClose: () => void;
  onSave: (t: Target, config: any) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [enabled, setEnabled] = useState(!!initial.enabled);
  const [cfg, setCfg] = useState<any>(() => {
    try { return JSON.parse(initial.config_json || "{}"); } catch { return {}; }
  });
  const setField = (k: string, v: any) => setCfg((c: any) => ({ ...c, [k]: v }));

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "var(--bg-secondary)", border: "1px solid var(--border-primary)",
        width: "100%", maxWidth: 520, maxHeight: "90vh", overflowY: "auto",
        padding: "20px 22px", borderRadius: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>
            {initial.id ? "Edit" : "Add"} {TYPE_LABEL[initial.type]} target
          </h3>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-tertiary)", fontSize: 18, cursor: "pointer", padding: 0 }}>×</button>
        </div>

        <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 16, lineHeight: 1.5 }}>{TYPE_DESC[initial.type]}</div>

        <Field label="Name">
          <input value={name} onChange={e => setName(e.target.value)} style={inputStyle} />
        </Field>

        {initial.type === "icecast" && <>
          <Field label="Server host"><input value={cfg.host || ""} onChange={e => setField("host", e.target.value)} placeholder="stream.example.com" style={inputStyle} /></Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Port"><input type="number" value={cfg.port || 8000} onChange={e => setField("port", parseInt(e.target.value || "8000", 10))} style={inputStyle} /></Field>
            <Field label="Mount point"><input value={cfg.mount || "/stream"} onChange={e => setField("mount", e.target.value)} style={inputStyle} /></Field>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Admin username"><input value={cfg.adminUser || "admin"} onChange={e => setField("adminUser", e.target.value)} style={inputStyle} /></Field>
            <Field label="Admin password"><input type="password" value={cfg.adminPass || ""} onChange={e => setField("adminPass", e.target.value)} style={inputStyle} /></Field>
          </div>
          <Field label="Use HTTPS">
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-secondary)" }}>
              <input type="checkbox" checked={!!cfg.useHttps} onChange={e => setField("useHttps", e.target.checked)} /> Connect over HTTPS
            </label>
          </Field>
        </>}

        {initial.type === "shoutcast" && <>
          <Field label="Server host"><input value={cfg.host || ""} onChange={e => setField("host", e.target.value)} placeholder="stream.example.com" style={inputStyle} /></Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            <Field label="Port"><input type="number" value={cfg.port || 8000} onChange={e => setField("port", parseInt(e.target.value || "8000", 10))} style={inputStyle} /></Field>
            <Field label="Stream ID (sid)"><input type="number" value={cfg.sid || 1} onChange={e => setField("sid", parseInt(e.target.value || "1", 10))} style={inputStyle} /></Field>
            <Field label="Version">
              <select value={cfg.version || 2} onChange={e => setField("version", parseInt(e.target.value, 10))} style={inputStyle}>
                <option value={1}>v1 (legacy)</option>
                <option value={2}>v2 (default)</option>
              </select>
            </Field>
          </div>
          <Field label="Admin password"><input type="password" value={cfg.password || ""} onChange={e => setField("password", e.target.value)} style={inputStyle} /></Field>
        </>}

        {initial.type === "tunein" && <>
          <div style={{ padding: "10px 12px", background: "rgba(56,189,248,0.08)", border: "1px solid rgba(56,189,248,0.2)", marginBottom: 12, fontSize: 12, color: "var(--accent-blue)", lineHeight: 1.5 }}>
            Get your Partner ID and Partner Key from <strong>tunein.com/broadcasters</strong> → Settings → API Access. Station ID is the "s" number from your TuneIn station URL.
          </div>
          <Field label="Partner ID"><input value={cfg.partnerId || ""} onChange={e => setField("partnerId", e.target.value)} style={inputStyle} /></Field>
          <Field label="Partner Key"><input type="password" value={cfg.partnerKey || ""} onChange={e => setField("partnerKey", e.target.value)} style={inputStyle} /></Field>
          <Field label="Station ID"><input value={cfg.stationId || ""} onChange={e => setField("stationId", e.target.value)} placeholder="e.g. s12345" style={inputStyle} /></Field>
        </>}

        {initial.type === "rds" && <>
          <div style={{ padding: "10px 12px", background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)", marginBottom: 12, fontSize: 12, color: "var(--accent-amber)", lineHeight: 1.5 }}>
            Requires the <code>serialport</code> npm package. Run <code>npm install serialport</code> in the project root if you see "serialport not installed" errors.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Serial port"><input value={cfg.port || ""} onChange={e => setField("port", e.target.value)} placeholder="COM3 or /dev/ttyUSB0" style={inputStyle} /></Field>
            <Field label="Baud rate">
              <select value={cfg.baud || 9600} onChange={e => setField("baud", parseInt(e.target.value, 10))} style={inputStyle}>
                {[1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].map(b => <option key={b} value={b}>{b}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Encoder type">
            <select value={cfg.encoderType || "inovonics"} onChange={e => setField("encoderType", e.target.value)} style={inputStyle}>
              <option value="inovonics">Inovonics (730/732/736)</option>
              <option value="audemat">Audemat / WorldCast</option>
              <option value="deva">Deva (SmartGen)</option>
              <option value="generic">Generic / plain text</option>
            </select>
          </Field>
        </>}

        {initial.type === "webhook" && <>
          <Field label="Webhook URL"><input value={cfg.url || ""} onChange={e => setField("url", e.target.value)} placeholder="https://yoursite.com/api/now-playing" style={inputStyle} /></Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            <Field label="Method">
              <select value={cfg.method || "POST"} onChange={e => setField("method", e.target.value)} style={inputStyle}>
                <option value="POST">POST</option>
                <option value="PUT">PUT</option>
              </select>
            </Field>
            <Field label="Basic auth user (opt)"><input value={cfg.basicUser || ""} onChange={e => setField("basicUser", e.target.value)} style={inputStyle} /></Field>
            <Field label="Basic auth pass (opt)"><input type="password" value={cfg.basicPass || ""} onChange={e => setField("basicPass", e.target.value)} style={inputStyle} /></Field>
          </div>
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 4 }}>
            Body: <code style={{ background: "var(--bg-tertiary)", padding: "1px 4px" }}>{`{ "title", "artist", "album", "duration", "timestamp" }`}</code>
          </div>
        </>}

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--border-primary)" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-secondary)" }}>
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> Enabled
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onClose} style={{ padding: "8px 16px", borderRadius: 0, fontSize: 12, fontWeight: 600, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>Cancel</button>
            <button onClick={() => onSave({ ...initial, name, enabled: enabled ? 1 : 0 }, cfg)} style={{ padding: "8px 16px", borderRadius: 0, fontSize: 12, fontWeight: 600, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer" }}>Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", borderRadius: 0, fontSize: 13,
  background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
  color: "var(--text-primary)", outline: "none", boxSizing: "border-box",
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)", marginBottom: 4, letterSpacing: "0.04em", textTransform: "uppercase" }}>{label}</div>
      {children}
    </div>
  );
}
