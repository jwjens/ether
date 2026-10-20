// BackupsPanel — backups by setting, on THIS computer, and every backup in one list to restore from (Jeff, 2026-10-20:
// "I set how often backups run (down to every few minutes) and how many are kept, on each computer. The restore screen
// lists every backup with its date and time so I can pick the one from just before a mistake."). Main does the work
// (electron/backups.js; IPC backups:*). Restoring expects sync OFF (the switch above); a restore discards unsent changes.
import { useEffect, useState } from "react";

const EVERY = [[0, "Off"], [5, "Every 5 minutes"], [10, "Every 10 minutes"], [15, "Every 15 minutes"], [30, "Every 30 minutes"],
  [60, "Every hour"], [120, "Every 2 hours"], [360, "Every 6 hours"], [720, "Every 12 hours"], [1440, "Every day"]] as const;
const mb = (b?: number | null) => b == null ? "—" : b >= 1073741824 ? (b / 1073741824).toFixed(1) + " GB" : (b / 1048576).toFixed(0) + " MB";
const when = (ms?: number | null) => ms ? new Date(ms).toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
const cloudWhen = (ts: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(ts); return m ? when(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : ts; };

export default function BackupsPanel({ onRestoreLocal }: { onRestoreLocal: (name: string) => Promise<string | undefined> }) {
  const ether = (window as any).ether;
  const [s, setS] = useState<any>(null);
  const [list, setList] = useState<any>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const load = async () => {
    try { const r = await ether.invoke("backups:get-settings"); if (r && r.ok) setS(r); } catch { /* not under Electron */ }
    try { setList(await ether.invoke("backups:list")); } catch { /* ignore */ }
  };
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, []);
  if (!s) return null;

  const save = async (patch: any) => {
    setMsg("");
    const r = await ether.invoke("backups:set-settings", patch);
    if (r && r.ok) { setS(r); setMsg("✓ Saved on this computer."); } else setMsg(`✗ ${(r && r.error) || "not saved"}`);
  };
  const runNow = async (where: "local" | "cloud") => {
    setBusy(where); setMsg("");
    try {
      const r = await ether.invoke("backups:run", where);
      setMsg(r && r.ok ? `✓ ${where === "local" ? "Local" : "Cloud"} backup made.` : `✗ ${(r && (r.error || r.skipped)) || "not made"}`);
    } finally { setBusy(null); load(); }
  };
  const restoreCloud = async (b: any) => {
    if (!confirm(`Restore the cloud backup from ${cloudWhen(b.timestamp)} (${b.computer})?\n\nThis replaces this computer's station database. ` +
                 `Switch sync off first (above) so nothing spreads; changes not yet sent are discarded.`)) return;
    setBusy("restore"); setMsg("Downloading and restoring…");
    try {
      const r = await ether.invoke("backups:restore-cloud", b.key);
      setMsg(r && r.ok ? `✓ Restored (${r.songs} songs). ${r.sync ? `${r.sync.discarded} unsent change(s) discarded.` : ""} Restart Ether for everything to take effect.` : `✗ ${(r && r.error) || "not restored"}`);
    } finally { setBusy(null); load(); }
  };

  const sel = (value: number, onChange: (v: number) => void) => (
    <select value={value} onChange={e => onChange(Number(e.target.value))}
      style={{ padding: "6px 8px", fontSize: 12.5, background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", borderRadius: 0 }}>
      {EVERY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      {!EVERY.some(([v]) => v === value) && <option value={value}>Every {value} minutes</option>}
    </select>
  );
  const num = (value: number, min: number, onChange: (v: number) => void, title: string) => (
    <input type="number" min={min} value={value} title={title} onChange={e => onChange(Math.max(min, Math.floor(Number(e.target.value) || 0)))}
      style={{ width: 70, padding: "6px 8px", fontSize: 12.5, background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", borderRadius: 0 }} />
  );
  const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 };
  const lbl: React.CSSProperties = { fontSize: 12.5, fontWeight: 700, color: "var(--text-primary)", minWidth: 120 };
  const sub: React.CSSProperties = { fontSize: 12, color: "var(--text-tertiary)" };
  const btn: React.CSSProperties = { padding: "6px 12px", fontSize: 12, fontWeight: 600, background: "var(--bg-secondary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, cursor: "pointer" };

  const all = [
    ...((list?.local || []) as any[]).map(b => ({ ...b, sortAt: b.at, label: when(b.at), computer: "This computer", kind: "On this computer" })),
    ...((list?.cloud || []) as any[]).map(b => ({ ...b, sortAt: Date.parse(cloudWhen(b.timestamp)) || 0, label: cloudWhen(b.timestamp), kind: "Cloud", bytes: b.size })),
  ].sort((a, b) => b.sortAt - a.sortAt);

  return (
    <div>
      <div style={row}>
        <span style={lbl}>On this computer</span>
        {sel(s.localEveryMin, v => save({ localEveryMin: v }))}
        <span style={sub}>keep the last</span>{num(s.localKeep, 1, v => save({ localKeep: v }), "How many local backups this computer keeps")}
        <button style={btn} disabled={!!busy} onClick={() => runNow("local")}>{busy === "local" ? "Backing up…" : "Back up now"}</button>
      </div>
      <div style={{ ...sub, margin: "-4px 0 12px 130px" }}>
        Last: {s.localLast ? `${when(s.localLast.at)} — ${s.localLast.ok ? "OK" : "failed: " + s.localLast.error}` : "none yet"} · Next: {s.localEveryMin ? when(s.localNextAt) : "off"} ·
        Space: about {mb((s.dbBytes || 0) * s.localKeep)} ({s.localKeep} × {mb(s.dbBytes)})
      </div>
      <div style={row}>
        <span style={lbl}>In the cloud</span>
        {sel(s.cloudEveryMin, v => save({ cloudEveryMin: v }))}
        <span style={sub}>keep</span>{num(s.cloudKeep, 0, v => save({ cloudKeep: v }), "How many cloud backups of THIS computer are kept — 0 keeps all")}
        <span style={sub}>{s.cloudKeep ? "of this computer's" : "(0 = keep all)"}</span>
        <button style={btn} disabled={!!busy} onClick={() => runNow("cloud")}>{busy === "cloud" ? "Backing up…" : "Back up now"}</button>
      </div>
      <div style={{ ...sub, margin: "-4px 0 14px 130px" }}>
        Last: {s.cloudLast ? `${when(s.cloudLast.at)} — ${s.cloudLast.ok ? "OK" : s.cloudLast.skipped ? "skipped: " + s.cloudLast.skipped : "failed: " + s.cloudLast.error}` : "none yet"} · Next: {s.cloudEveryMin ? when(s.cloudNextAt) : "off"}
      </div>
      {msg && <div style={{ fontSize: 12.5, marginBottom: 12, color: msg.startsWith("✓") ? "var(--accent-green)" : msg.startsWith("✗") ? "var(--accent-red)" : "var(--text-secondary)" }}>{msg}</div>}

      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-tertiary)", letterSpacing: "0.06em", textTransform: "uppercase", margin: "6px 0 8px" }}>Every backup — pick the one from just before a mistake</div>
      {list?.cloudError && <div style={{ ...sub, marginBottom: 8 }}>Cloud backups: {list.cloudError}.</div>}
      {all.length === 0 && <div style={sub}>No backups yet.</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 360, overflowY: "auto" }}>
        {all.map(b => (
          <div key={(b.key || b.name) as string} style={{ display: "grid", gridTemplateColumns: "190px 1fr 120px 80px auto", alignItems: "center", gap: 10, background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)", padding: "8px 12px", fontSize: 12.5 }}>
            <span style={{ color: "var(--text-primary)", fontFamily: "'DM Mono', monospace" }}>{b.label}</span>
            <span style={{ color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.computer}</span>
            <span style={sub}>{b.kind}</span>
            <span style={sub}>{mb(b.bytes)}</span>
            <button style={btn} disabled={!!busy} onClick={async () => { if (b.where === "cloud") return restoreCloud(b); const m = await onRestoreLocal(b.name); if (m) setMsg(m); load(); }}>Restore</button>
          </div>
        ))}
      </div>
    </div>
  );
}
