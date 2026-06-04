/**
 * ManageDevices.tsx — Manage Devices panel.
 * Opened from SubscriptionPanel via the `ether:open-managedevices` custom event.
 * Reads /account/seats and posts to /account/deauthorize-seat with x-license-key
 * header (matches the backend's privacy choice — key stays out of access logs).
 *
 * UX:
 * - Single grid of all active seats for the customer's license.
 * - Current machine highlighted with a "THIS MACHINE" badge; no Deauthorize
 *   button on its row (UI gate against self-deauth — backend permits it but
 *   the panel doesn't surface the action).
 * - Deauthorize uses an inline action-cell swap (red-tinted confirm with
 *   Yes/No), matching Scheduler.tsx's pattern. Other 24 destructive-action
 *   sites in the codebase use native confirm() — OB13 tracks the migration.
 * - On 401 invalid_license_key (e.g., lapsed subscription per OB10), shows
 *   a "Reactivate via Subscription" CTA instead of a generic error.
 */

import { useState, useEffect, useCallback } from "react";
import { ETHER_BACKEND_URL } from "../lib/etherBackend";
import { useActiveStation } from "../hooks/useActiveStation";

interface Seat {
  machine_id:    string;
  machine_name:  string | null;
  os:            string | null;
  ip_address:    string | null;
  station_uuid:  string | null;
  activated_at:  string;
  last_seen:     string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtOS(os: string | null): string {
  if (!os) return "—";
  if (os === "darwin")  return "macOS";
  if (os === "win32")   return "Windows";
  if (os === "linux")   return "Linux";
  return os;
}

function fmtRelative(iso: string): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diffSec = Math.max(0, (Date.now() - t) / 1000);
  if (diffSec < 45)              return "just now";
  if (diffSec < 90)              return "1 min ago";
  if (diffSec < 60 * 60)         return `${Math.round(diffSec / 60)} min ago`;
  if (diffSec < 90 * 60)         return "1 hour ago";
  if (diffSec < 24 * 60 * 60)    return `${Math.round(diffSec / 3600)} hours ago`;
  if (diffSec < 48 * 60 * 60)    return "yesterday";
  if (diffSec < 7 * 86400)       return `${Math.round(diffSec / 86400)} days ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function shortUuid(uuid: string | null): string {
  if (!uuid) return "—";
  return uuid.slice(0, 8);
}

// ── Row ──────────────────────────────────────────────────────────────────────

function SeatRow({
  seat, isCurrent, confirming, deauthorizing, onAskConfirm, onConfirm, onCancel,
}: {
  seat:           Seat;
  isCurrent:      boolean;
  confirming:     boolean;
  deauthorizing:  boolean;
  onAskConfirm:   (id: string) => void;
  onConfirm:      (id: string) => void;
  onCancel:       () => void;
}) {
  return (
    <tr style={{ borderBottom: "1px solid var(--border-primary)" }}>
      <td style={{ padding: "10px 14px", verticalAlign: "middle" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {isCurrent && (
            <span style={{
              fontSize: 8, fontWeight: 900, color: "#22c55e",
              letterSpacing: "0.06em", padding: "1px 5px",
              border: "1px solid rgba(34,197,94,0.3)",
              background: "rgba(34,197,94,0.1)", flexShrink: 0,
            }}>●</span>
          )}
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>
              {seat.machine_name || "Unknown machine"}
            </div>
            <div style={{ fontSize: 10, color: "var(--text-tertiary)", fontFamily: "monospace", marginTop: 1 }}>
              {fmtOS(seat.os)} · station {shortUuid(seat.station_uuid)}
            </div>
          </div>
        </div>
      </td>
      <td style={{ padding: "10px 14px", verticalAlign: "middle", fontSize: 12, color: "var(--text-tertiary)", whiteSpace: "nowrap" }}>
        {fmtRelative(seat.last_seen)}
      </td>
      <td style={{ padding: "10px 14px", verticalAlign: "middle", fontSize: 12, color: "var(--text-tertiary)", fontFamily: "monospace" }}>
        {seat.ip_address || "—"}
      </td>
      <td style={{ padding: "10px 14px", verticalAlign: "middle" }}>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          {isCurrent ? (
            <span style={{
              fontSize: 9, fontWeight: 800, letterSpacing: "0.1em",
              color: "#22c55e",
              background: "rgba(34,197,94,0.1)",
              border: "1px solid rgba(34,197,94,0.3)",
              padding: "3px 8px", whiteSpace: "nowrap",
            }}>THIS MACHINE</span>
          ) : confirming ? (
            // Inline confirm — red-tinted cell, action-only swap (machine
            // identity stays visible in the other columns). Pattern from
            // Scheduler.tsx:971-991.
            <div style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "4px 8px",
              background: "rgba(239,68,68,0.1)",
              border: "1px solid rgba(239,68,68,0.3)",
            }}>
              <span style={{ fontSize: 10, color: "#ef4444" }}>Deauthorize?</span>
              <button
                disabled={deauthorizing}
                onClick={() => onConfirm(seat.machine_id)}
                style={{
                  fontSize: 10, fontWeight: 700, color: "#ef4444",
                  background: "none", border: "none",
                  cursor: deauthorizing ? "default" : "pointer",
                  padding: "1px 4px", opacity: deauthorizing ? 0.5 : 1,
                }}
              >{deauthorizing ? "…" : "Yes"}</button>
              <button
                disabled={deauthorizing}
                onClick={onCancel}
                style={{
                  fontSize: 10, color: "var(--text-tertiary)",
                  background: "none", border: "none",
                  cursor: deauthorizing ? "default" : "pointer",
                  padding: "1px 4px", opacity: deauthorizing ? 0.5 : 1,
                }}
              >No</button>
            </div>
          ) : (
            <button
              onClick={() => onAskConfirm(seat.machine_id)}
              style={{
                padding: "4px 10px", borderRadius: 0, fontSize: 11, fontWeight: 600,
                background: "var(--bg-tertiary)", color: "var(--text-secondary)",
                border: "1px solid var(--border-primary)", cursor: "pointer",
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "#f87171"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--text-secondary)"; }}
            >Deauthorize</button>
          )}
        </div>
      </td>
    </tr>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export default function ManageDevices() {
  const { stationId, isReady } = useActiveStation();
  const [seats,              setSeats]              = useState<Seat[]>([]);
  const [seatsMax,           setSeatsMax]           = useState(5);
  const [loading,            setLoading]            = useState(true);
  const [error,              setError]              = useState<string | null>(null);
  const [errorCode,          setErrorCode]          = useState<string | null>(null);
  const [currentMachineId,   setCurrentMachineId]   = useState<string | null>(null);
  const [licenseKey,         setLicenseKey]         = useState<string>("");
  const [confirmDeauthId,    setConfirmDeauthId]    = useState<string | null>(null);
  const [deauthorizingId,    setDeauthorizingId]    = useState<string | null>(null);

  // Mount-time setup — read license_key from KV (station 1, install-level) +
  // current machine_id via identity IPC.
  useEffect(() => {
    if (!isReady) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await (window as any).ether.stationConfigKv.list(stationId);
        if (cancelled) return;
        const rows: { key: string; value: string }[] = result.ok ? result.rows : [];
        const lk = rows.find(r => r.key === 'license_key')?.value;
        if (lk) setLicenseKey(lk);
        const idResp = await (window as any).ether.identity.get();
        if (!cancelled && idResp?.ok) setCurrentMachineId(idResp.machine_id);
      } catch (e: any) {
        if (!cancelled) {
          setError(e?.message || "Could not read local license info.");
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [stationId, isReady]);

  const load = useCallback(async () => {
    if (!licenseKey) return;
    setLoading(true);
    setError(null);
    setErrorCode(null);
    try {
      const res = await fetch(`${ETHER_BACKEND_URL}/account/seats`, {
        headers: { 'x-license-key': licenseKey },
      });
      if (res.status === 401) {
        const data = await res.json().catch(() => ({}));
        setErrorCode(data.error || 'invalid_license_key');
        setError(data.detail || "Your license is no longer active. Reactivate it from the Subscription panel.");
        setLoading(false);
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.detail || data.error || `Could not load devices (HTTP ${res.status})`);
        setLoading(false);
        return;
      }
      const data = await res.json();
      setSeats(Array.isArray(data.seats) ? data.seats : []);
      setSeatsMax(data.seats_max ?? 5);
      setLoading(false);
    } catch (e: any) {
      setError(e?.message || "Could not load devices — check your internet connection.");
      setLoading(false);
    }
  }, [licenseKey]);

  useEffect(() => { if (licenseKey) load(); }, [licenseKey, load]);

  const askConfirm = (machineId: string) => {
    setConfirmDeauthId(machineId);
  };

  const cancelConfirm = () => {
    setConfirmDeauthId(null);
  };

  const doDeauth = async (machineId: string) => {
    setDeauthorizingId(machineId);
    setError(null);
    try {
      const res = await fetch(`${ETHER_BACKEND_URL}/account/deauthorize-seat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ license_key: licenseKey, machine_id: machineId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.detail || data.error || `Could not deauthorize (HTTP ${res.status})`);
        setDeauthorizingId(null);
        return;
      }
      setConfirmDeauthId(null);
      setDeauthorizingId(null);
      load();
    } catch (e: any) {
      setError(e?.message || "Could not deauthorize — check your internet connection.");
      setDeauthorizingId(null);
    }
  };

  const openSubscription = () => {
    window.dispatchEvent(new CustomEvent('ether:open-subscription'));
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading && seats.length === 0) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", gap: 10, color: "var(--text-tertiary)", fontFamily: "'Inter', system-ui, sans-serif" }}>
        <div style={{ width: 16, height: 16, border: "2px solid var(--border-primary)", borderTopColor: "var(--accent-blue)", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
        Loading devices…
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    );
  }

  if (!licenseKey) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", fontFamily: "'Inter', system-ui, sans-serif", background: "var(--bg-primary)" }}>
        <Header seatsUsed={0} seatsMax={seatsMax} />
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ maxWidth: 380, textAlign: "center" }}>
            <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 16, lineHeight: 1.6 }}>
              No license key is set on this install. Devices appear here after you enter a license in Subscription.
            </div>
            <button onClick={openSubscription} style={primaryBtn}>Open Subscription</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", fontFamily: "'Inter', system-ui, sans-serif", background: "var(--bg-primary)" }}>
      <Header seatsUsed={seats.length} seatsMax={seatsMax} />

      <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
        {error && (
          <div style={{
            marginBottom: 14, padding: "10px 14px",
            background: "rgba(239,68,68,0.08)",
            border: "1px solid rgba(239,68,68,0.3)",
            color: "#fca5a5", fontSize: 12, lineHeight: 1.5,
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14,
          }}>
            <span>{error}</span>
            {errorCode === 'invalid_license_key' ? (
              <button onClick={openSubscription} style={{ ...primaryBtn, padding: "5px 12px", fontSize: 11 }}>
                Open Subscription
              </button>
            ) : (
              <button onClick={load} style={{ ...secondaryBtn, padding: "5px 12px", fontSize: 11 }}>
                Retry
              </button>
            )}
          </div>
        )}

        {!error && seats.length === 0 && (
          <div style={{ textAlign: "center", padding: "60px 24px", color: "var(--text-tertiary)" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 6 }}>No active devices</div>
            <div style={{ fontSize: 11 }}>
              This shouldn't happen — at minimum this machine should appear here. If you see this for long, contact support.
            </div>
          </div>
        )}

        {seats.length > 0 && (
          <table style={{ width: "100%", borderCollapse: "collapse", background: "var(--bg-secondary)", border: "1px solid var(--border-primary)" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-primary)", background: "var(--bg-tertiary)" }}>
                {[
                  { label: "Machine",   align: "left"  as const },
                  { label: "Last Seen", align: "left"  as const },
                  { label: "IP",        align: "left"  as const },
                  { label: "Action",    align: "right" as const },
                ].map(h => (
                  <th key={h.label} style={{ padding: "8px 14px", textAlign: h.align, fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)", textTransform: "uppercase" }}>{h.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {seats.map(s => (
                <SeatRow
                  key={s.machine_id}
                  seat={s}
                  isCurrent={s.machine_id === currentMachineId}
                  confirming={confirmDeauthId === s.machine_id}
                  deauthorizing={deauthorizingId === s.machine_id}
                  onAskConfirm={askConfirm}
                  onConfirm={doDeauth}
                  onCancel={cancelConfirm}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

// ── Header ───────────────────────────────────────────────────────────────────

function Header({ seatsUsed, seatsMax }: { seatsUsed: number; seatsMax: number }) {
  return (
    <div style={{ padding: "16px 24px", borderBottom: "1px solid var(--border-primary)", background: "var(--bg-secondary)", flexShrink: 0 }}>
      <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.16em", color: "var(--accent-cyan)", textTransform: "uppercase", marginBottom: 2 }}>Account</div>
      <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: "-0.03em", color: "var(--text-primary)" }}>Manage Devices</div>
      <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
        {seatsUsed} of {seatsMax} device{seatsMax !== 1 ? "s" : ""} in use · this machine highlighted
      </div>
    </div>
  );
}

// ── Shared styles ────────────────────────────────────────────────────────────

const primaryBtn: React.CSSProperties = {
  padding: "8px 16px", borderRadius: 0, fontSize: 12, fontWeight: 700,
  background: "var(--accent-cyan)", color: "#000",
  border: "none", cursor: "pointer", letterSpacing: "0.02em",
};

const secondaryBtn: React.CSSProperties = {
  padding: "7px 16px", borderRadius: 0, fontSize: 12, fontWeight: 600,
  background: "var(--bg-tertiary)", color: "var(--text-secondary)",
  border: "1px solid var(--border-primary)", cursor: "pointer",
};
