// PairMobileApp.tsx — settings panel section for pairing the Ether2Go
// mobile companion. Shows the local URL the phone should browse to + a
// freshly-generated 6-digit code (10-min expiry). Lists paired devices
// with revoke buttons.

import { useEffect, useState } from "react";

interface Device {
  id: number;
  device_label: string;
  operator_name: string;
  paired_at: number;
  last_seen: number;
  revoked: number;
}

function fmtAgo(unixSec: number) {
  if (!unixSec) return "—";
  const d = Math.floor(Date.now() / 1000) - unixSec;
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

export default function PairMobileApp() {
  const ether = (window as any).ether;
  const [localIp, setLocalIp]     = useState("");
  const [code, setCode]           = useState<string | null>(null);
  const [codeExpires, setCodeExpires] = useState(0);
  const [devices, setDevices]     = useState<Device[]>([]);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    ether?.invoke?.("studio:getLocalIp")?.then((ip: string) => setLocalIp(ip));
    refreshDevices();
  }, []);

  // Countdown for code expiry — refresh every second so user knows when
  // they need to regenerate.
  useEffect(() => {
    if (!code || !codeExpires) return;
    const iv = setInterval(() => {
      const remaining = Math.max(0, codeExpires - Math.floor(Date.now() / 1000));
      if (remaining === 0) { setCode(null); clearInterval(iv); }
      // re-render
      setCodeExpires(c => c);
    }, 1000);
    return () => clearInterval(iv);
  }, [code, codeExpires]);

  const refreshDevices = async () => {
    try {
      const list = await ether?.v2g?.listDevices?.();
      setDevices(Array.isArray(list) ? list : []);
    } catch (e) { console.error("[PairMobileApp] listDevices failed:", e); }
  };

  const generateCode = async () => {
    setGenerating(true);
    try {
      const r = await ether?.v2g?.createPairCode?.();
      if (r?.ok) {
        setCode(r.code);
        setCodeExpires(Math.floor(Date.now() / 1000) + (r.expiresIn || 600));
      } else {
        alert("Failed to generate code: " + (r?.error || "unknown"));
      }
    } catch (e: any) {
      alert("Error: " + (e?.message || e));
    }
    setGenerating(false);
  };

  const revoke = async (d: Device) => {
    if (!confirm(`Revoke "${d.device_label || `device #${d.id}`}"? They'll need to re-pair to upload again.`)) return;
    await ether.v2g.revoke(d.id);
    refreshDevices();
  };

  const url = localIp ? `http://${localIp}:3400/m` : "Loading...";
  const remaining = codeExpires ? Math.max(0, codeExpires - Math.floor(Date.now() / 1000)) : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* URL block */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)", marginBottom: 4 }}>1. On your phone, open this URL</div>
        <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 8 }}>
          Phone must be on the same WiFi as this computer. Then tap "Add to Home Screen" on the page for an app-like icon.
        </div>
        <div style={{
          background: "var(--bg-tertiary)", padding: "10px 14px", border: "1px solid var(--border-primary)",
          fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 14, color: "var(--accent-blue)",
          letterSpacing: "0.02em", wordBreak: "break-all" as any,
        }}>{url}</div>
      </div>

      {/* Pair code */}
      <div style={{ borderTop: "1px solid var(--border-primary)", paddingTop: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)", marginBottom: 4 }}>2. Enter this code on the phone</div>
        <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 8 }}>
          Codes expire after 10 minutes. Generate a new one for each device.
        </div>
        {code ? (
          <div style={{ background: "var(--bg-tertiary)", padding: "20px 24px", border: "1px solid var(--accent-blue)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontSize: 36, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", letterSpacing: "0.4em", color: "var(--accent-blue)" }}>
                {code}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 4 }}>
                Expires in {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}
              </div>
            </div>
            <button onClick={generateCode} style={{
              padding: "8px 16px", borderRadius: 0, fontSize: 12, fontWeight: 600,
              background: "var(--bg-secondary)", color: "var(--text-secondary)",
              border: "1px solid var(--border-primary)", cursor: "pointer",
            }}>↻ New Code</button>
          </div>
        ) : (
          <button onClick={generateCode} disabled={generating} style={{
            padding: "12px 20px", borderRadius: 0, fontSize: 13, fontWeight: 700,
            background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer",
          }}>
            {generating ? "Generating…" : "Generate 6-digit pairing code"}
          </button>
        )}
      </div>

      {/* Paired devices list */}
      <div style={{ borderTop: "1px solid var(--border-primary)", paddingTop: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)", marginBottom: 8 }}>
          Paired devices ({devices.filter(d => !d.revoked).length})
        </div>
        {devices.length === 0 ? (
          <div style={{ padding: "16px", background: "var(--bg-tertiary)", border: "1px dashed var(--border-primary)", textAlign: "center" as any, color: "var(--text-tertiary)", fontSize: 12 }}>
            No devices paired yet
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {devices.map(d => (
              <div key={d.id} style={{
                background: "var(--bg-tertiary)", padding: "10px 12px",
                border: "1px solid var(--border-primary)",
                display: "flex", alignItems: "center", justifyContent: "space-between",
                opacity: d.revoked ? 0.5 : 1,
              }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                    {d.device_label || `Device #${d.id}`}
                    {d.revoked ? <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: "#ef4444" }}>REVOKED</span> : null}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
                    Paired {fmtAgo(d.paired_at)} · last seen {fmtAgo(d.last_seen)}
                  </div>
                </div>
                {!d.revoked && (
                  <button onClick={() => revoke(d)} style={{
                    padding: "4px 10px", borderRadius: 0, fontSize: 11, fontWeight: 600,
                    background: "var(--bg-secondary)", color: "#ef4444",
                    border: "1px solid var(--border-primary)", cursor: "pointer",
                  }}>Revoke</button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* What it does */}
      <div style={{ borderTop: "1px solid var(--border-primary)", paddingTop: 14, fontSize: 12, color: "var(--text-tertiary)", lineHeight: 1.6 }}>
        <strong style={{ color: "var(--text-secondary)" }}>What Ether2Go does:</strong> records voice tracks (intros, outros, breaks, promos) on your phone and uploads them straight to your studio. Uploaded tracks appear in the <b>Voice Track Inbox</b> where you can drop them into the playout queue with one click.
      </div>
    </div>
  );
}
