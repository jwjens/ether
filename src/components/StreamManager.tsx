import { useState, useEffect, useCallback } from "react";
import { listenerPageUrl } from "../lib/listenerPage";

// TOOLS → STREAM MANAGER — the full view of the ONE real stream the ON AIR button runs, for the active station
// (Jeff, 2026-10-30: "real start/stop and real status"). Settings are the station's own stream fields (the ones ON AIR
// reads, the same Station Manager edits); START / STOP is exactly ON AIR's go-live / stop-live; status is the encoder's
// own; listeners come from the Icecast server's status page. electron/stream-manager.js.
const ether = () => (window as any).ether;

interface Settings { stationId: number; stationUuid: string | null; stationName: string; server: string; mount: string; bitrateKbps: number; hasPassword: boolean; port: number | null }
interface Status { settings: Settings | null; state: "idle" | "connecting" | "live" | "error"; errorMsg: string | null; uptimeSec: number | null; bitrateKbps: number | null }
type Listeners = { ok: true; listeners: number | null } | { ok: false; error: string } | null;

function fmtDuration(sec: number) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
}

const STATE_LABEL: Record<Status["state"], string> = { idle: "OFF AIR", connecting: "CONNECTING…", live: "ON AIR", error: "ERROR" };
const STATE_COLOR: Record<Status["state"], string> = { idle: "#666", connecting: "#fbbf24", live: "#22c55e", error: "#ef4444" };
const input = { padding: "8px 12px", borderRadius: 0, fontSize: 13, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", color: "var(--text-primary)" } as const;

export default function StreamManager() {
  const [status, setStatus] = useState<Status | null>(null);
  const [edit, setEdit] = useState<{ server: string; port: string; mount: string; password: string; bitrateKbps: number } | null>(null);
  const [listeners, setListeners] = useState<Listeners>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const refresh = useCallback(async () => {
    try {
      const s: Status = await ether().invoke("stream-manager:status");
      setStatus(s);
      // The form follows the station until the operator starts typing (or the station changes).
      setEdit(e => (e && s.settings && (e as any)._for === s.settings.stationId) ? e
        : s.settings ? Object.assign({ server: s.settings.server, port: s.settings.port != null ? String(s.settings.port) : "", mount: s.settings.mount, password: "", bitrateKbps: s.settings.bitrateKbps }, { _for: s.settings.stationId }) : null);
    } catch { /* main not answering: keep the last status */ }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    const h = ether().stream?.onDestStatus?.(() => refresh());   // the encoder's own events: repaint at once
    return () => { clearInterval(t); if (h) ether().stream?.offDestStatus?.(h); };
  }, [refresh]);

  const live = status?.state === "live";
  const stationId = status?.settings?.stationId;
  // The station's public listen-live page — the same one Settings → Broadcast → "Your listener page" shows.
  const stationUuid = status?.settings?.stationUuid;
  const [listenUrl, setListenUrl] = useState<string | null | undefined>(undefined);   // undefined = still asking
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!stationUuid) { setListenUrl(null); return; }
    let gone = false;
    ether()?.station?.metadata?.get(stationUuid).then((r: any) => { if (!gone) setListenUrl(r?.ok ? listenerPageUrl(r.metadata) : null); })
      .catch(() => { if (!gone) setListenUrl(null); });
    return () => { gone = true; };
  }, [stationUuid]);
  const copyListen = async () => { if (!listenUrl) return; try { await navigator.clipboard.writeText(listenUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ } };
  const openListen = () => { if (!listenUrl) return; const sys = ether()?.system; if (sys?.openUrl) sys.openUrl(listenUrl); else window.open(listenUrl, "_blank"); };
  useEffect(() => {
    if (!live || stationId == null) { setListeners(null); return; }
    const ask = async () => { try { setListeners(await ether().invoke("stream-manager:listeners", stationId)); } catch (e) { setListeners({ ok: false, error: String(e) }); } };
    ask();
    const t = setInterval(ask, 15000);
    return () => clearInterval(t);
  }, [live, stationId]);

  const save = async () => {
    if (!edit || stationId == null) return;
    const r = await ether().invoke("stream-manager:save", stationId, { server: edit.server, port: edit.port.trim(), mount: edit.mount, password: edit.password, bitrateKbps: edit.bitrateKbps });
    setMsg(r?.ok ? (live ? "Saved. The stream uses the new settings the next time it starts." : "Saved.") : `Could not save: ${r?.error}`);
    setEdit(null);   // re-read from the station
    refresh();
  };

  const start = async () => {
    if (stationId == null) return;
    setBusy(true); setMsg("");
    const r = await ether().invoke("stream:go-live", { stationId });
    if (!r?.ok) setMsg(`Could not start: ${r?.error || "unknown error"}`);
    setBusy(false); refresh();
  };
  const stop = async () => {
    if (stationId == null) return;
    setBusy(true); setMsg("");
    await ether().invoke("stream:stop-live", { stationId });
    setBusy(false); refresh();
  };

  if (!status) return <div style={{ padding: 20, color: "var(--text-tertiary)" }}>Loading…</div>;
  if (!status.settings || !edit) return <div style={{ padding: 20, color: "var(--text-tertiary)" }}>No active station. Pick a station first; Stream Manager shows that station's stream.</div>;
  const st = status.settings;
  // Stop is offered whenever the stream is not stopped — including ERROR, where Ether keeps retrying until Stop.
  const running = status.state !== "idle";

  return (
    <div style={{ maxWidth: 600 }}>
      <h1 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4, color: "var(--text-primary)" }}>Stream Manager</h1>
      <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 16 }}>
        {st.stationName || `Station ${st.stationId}`} · the same stream as the ON AIR button — starting or stopping it here does exactly what ON AIR does.
      </div>

      {/* Status — the encoder's own */}
      <div style={{ background: "var(--bg-secondary)", border: `1px solid ${live ? "rgba(34,197,94,0.35)" : "var(--border-primary)"}`, padding: "14px 16px", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 10, height: 10, borderRadius: "50%", background: STATE_COLOR[status.state], boxShadow: live ? "0 0 8px #22c55e" : "none" }} />
          <span style={{ fontSize: 13, fontWeight: 700, color: STATE_COLOR[status.state] }}>{STATE_LABEL[status.state]}</span>
          {live && status.uptimeSec != null && <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--text-tertiary)", fontFamily: "monospace" }}>on air {fmtDuration(status.uptimeSec)}</span>}
        </div>
        {status.errorMsg && <div style={{ marginTop: 8, fontSize: 12, color: "#ef4444" }}>{status.errorMsg}</div>}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 12 }}>
          {[
            { label: "Sending to", value: !st.server ? "no server set" : st.port == null ? `${st.server} — no port set` : `${st.server}:${st.port}${st.mount}` },
            { label: "Bitrate", value: live && status.bitrateKbps != null ? `${Math.round(status.bitrateKbps)} kbps` : `${st.bitrateKbps} kbps (set)` },
            { label: "Listeners", value: !live ? "—" : listeners == null ? "asking…" : listeners.ok ? (listeners.listeners == null ? "mount not on server" : String(listeners.listeners)) : "unknown" },
          ].map(({ label, value }) => (
            <div key={label} style={{ padding: "8px 10px", background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)" }}>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)", textTransform: "uppercase", marginBottom: 3 }}>{label}</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", fontFamily: "monospace", wordBreak: "break-all" }}>{value}</div>
            </div>
          ))}
        </div>
        {live && listeners && !listeners.ok && <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-tertiary)" }}>Listener count unavailable: {listeners.error}.</div>}
      </div>

      {/* Listen live — the station's public listener page */}
      <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", padding: "12px 16px", marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Listen live</div>
        {listenUrl === undefined ? <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>Looking up this station's listener page…</span>
          : listenUrl ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <code style={{ fontSize: 13, fontFamily: "monospace", color: "#c4b5fd", wordBreak: "break-all" }}>{listenUrl}</code>
              <button onClick={copyListen} style={{ padding: "5px 12px", fontSize: 12, background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>{copied ? "Copied!" : "Copy"}</button>
              <button onClick={openListen} style={{ padding: "5px 12px", fontSize: 12, background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>Open</button>
            </div>
          ) : <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>This station has no public listener page yet. Turn it on and give it an address in Settings → Broadcast → Your listener page.</span>}
      </div>

      {/* The station's stream settings — the ones ON AIR uses */}
      <div style={{ background: "var(--bg-secondary)", padding: 16, border: "1px solid var(--border-primary)", marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 12 }}>Icecast server for this station</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, marginBottom: 8 }}>
          <input aria-label="Server" value={edit.server} onChange={e => setEdit({ ...edit, server: e.target.value })} placeholder="stream.example.com" style={input} />
          <input aria-label="Port" inputMode="numeric" value={edit.port} onChange={e => setEdit({ ...edit, port: e.target.value.replace(/[^0-9]/g, "") })} placeholder="port" title="This station's port on the server" style={{ ...input, width: 90 }} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
          <input aria-label="Mount" value={edit.mount} onChange={e => setEdit({ ...edit, mount: e.target.value })} placeholder="/live" style={input} />
          <input aria-label="Password" type="password" value={edit.password} onChange={e => setEdit({ ...edit, password: e.target.value })}
            placeholder={st.hasPassword ? "Password (set — leave blank to keep)" : "Password"} style={input} />
        </div>
        <select aria-label="Bitrate" value={edit.bitrateKbps} onChange={e => setEdit({ ...edit, bitrateKbps: parseInt(e.target.value) })} style={{ ...input, marginBottom: 12 }}>
          {[64, 96, 128, 192, 256, 320].map(b => <option key={b} value={b}>{b} kbps</option>)}
        </select>
        <div><button onClick={save} style={{ padding: "8px 20px", fontSize: 12, fontWeight: 600, background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>Save settings</button></div>
      </div>

      {msg && <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", padding: "10px 14px", fontSize: 12, color: "var(--text-secondary)", marginBottom: 12 }}>{msg}</div>}

      <div style={{ display: "flex", gap: 10 }}>
        {!running ? (
          <button disabled={busy} onClick={start} style={{ flex: 1, padding: 12, fontSize: 14, fontWeight: 700, background: "#22c55e", color: "#fff", border: "none", cursor: busy ? "wait" : "pointer" }}>▶ Start streaming</button>
        ) : (
          <button disabled={busy} onClick={stop} style={{ flex: 1, padding: 12, fontSize: 14, fontWeight: 700, background: "#ef4444", color: "#fff", border: "none", cursor: busy ? "wait" : "pointer" }}>⏹ Stop streaming</button>
        )}
      </div>
    </div>
  );
}
