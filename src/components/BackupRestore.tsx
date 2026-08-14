import { useState, useEffect } from "react";
const invoke = <T = any>(cmd: string, args?: any): Promise<T> => (window as any).ether.invoke(cmd, args);

export default function BackupRestore() {
  const [backups, setBackups] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

  const loadBackups = async () => {
    try {
      const list = await invoke<string[]>("list_backups");
      setBackups(list);
    } catch (e) { console.error(e); }
  };

  useEffect(() => { loadBackups(); }, []);

  const backup = async () => {
    setLoading(true);
    try {
      const path = await invoke<string>("backup_db");
      setStatus("✓ Backup saved");
      loadBackups();
    } catch (e) {
      setStatus("Error: " + String(e));
    }
    setLoading(false);
    setTimeout(() => setStatus(""), 4000);
  };

  const restore = async (name: string) => {
    if (!confirm("Restore from " + name + "? Current data will be replaced. Ether will need to restart.")) return;
    try {
      const msg = await invoke<string>("restore_db", { backupName: name });
      setStatus(msg);
    } catch (e) {
      setStatus("Error: " + String(e));
    }
  };

  const formatBackupName = (name: string) => {
    const ts = name.replace("openair-backup-", "").replace(".db", "");
    const d = new Date(parseInt(ts) * 1000);
    return d.toLocaleString();
  };

  return (
    <div style={{ padding: "0 0 20px" }}>
      <h3 style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 16, textTransform: "uppercase", letterSpacing: "0.06em" }}>Database Backup</h3>

      <div style={{ background: "var(--bg-tertiary)", borderRadius: 0, padding: 16, border: "1px solid var(--border-primary)" }}>
        <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 12 }}>
          Backup your entire library, schedule, and settings. Backups older than 7 days are automatically deleted.
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <button onClick={backup} disabled={loading}
            style={{ padding: "8px 20px", borderRadius: 0, fontSize: 12, fontWeight: 600, background: "var(--accent-blue)", color: "#fff", border: "none", cursor: "pointer" }}>
            {loading ? "Backing up..." : "Backup Now"}
          </button>
          {status && <span style={{ fontSize: 12, color: status.startsWith("✓") ? "var(--accent-green)" : "#ef4444" }}>{status}</span>}
        </div>

        {backups.length > 0 && (
          <>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>Saved Backups</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {backups.map(name => (
                <div key={name} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--bg-secondary)", borderRadius: 0, padding: "8px 12px", border: "1px solid var(--border-primary)" }}>
                  <span style={{ fontSize: 12, color: "var(--text-primary)" }}>{formatBackupName(name)}</span>
                  <button onClick={() => restore(name)}
                    style={{ padding: "4px 12px", borderRadius: 0, fontSize: 11, fontWeight: 600, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", cursor: "pointer" }}>
                    Restore
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        {backups.length === 0 && (
          <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>No backups yet.</div>
        )}
      </div>

      <MultiMachineSync />
    </div>
  );
}

// ── Multi-Machine Sync ──────────────────────────────────────────────────────────────────────────
//
// Engineering surface, deliberately plain: it reads what is actually stored and running, and the two
// force buttons do exactly what they say. Added 2026-08-14 after an investigation into "the sync is
// additive only" found the deletion path was already correct end to end and the real state was that
// NOTHING had ever synced in either direction — every mutation pending, every row local.
//
// The reading that matters most here is ORIGIN. A pending count says nothing has been pushed; only
// origin says nothing has ever been RECEIVED, and an install can look busy while being completely
// isolated. Both are shown.

interface Preflight {
  ok: boolean; error?: string;
  machineId?: string | null;
  stations?: Array<{ id: number; uuid: string; name: string; is_active?: number }>;
  activeStationId?: number | null;
  flags?: { sync_enabled: string | null; sync_uuid_identity: string | null; engineUuidIdentity: boolean | null };
  schedulerRunning?: boolean;
  mutations?: {
    pending: number | null; total: number | null;
    byStatus?: Array<{ sync_status: string; n: number }>;
    byOrigin?: Array<{ origin: string; n: number }>;
    songDeletes?: number | null;
  };
}

function MultiMachineSync() {
  const [pf, setPf] = useState<Preflight | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string>("");

  const refresh = async () => {
    setBusy("preflight");
    try {
      const r = await invoke<Preflight>("sync:preflight");
      setPf(r);
      if (!r?.ok) setMsg(`✗ ${r?.error || "preflight failed"}`);
    } catch (e: any) {
      setPf(null);
      setMsg(`✗ ${e?.message || String(e)}`);
    } finally { setBusy(null); }
  };

  useEffect(() => { refresh(); }, []);

  const run = async (cmd: "sync:push-now" | "sync:pull-now", label: string) => {
    setBusy(label); setMsg("");
    try {
      const r: any = await invoke(cmd);
      if (!r?.ok) setMsg(`✗ ${label}: ${r?.error || "failed"}`);
      else if (cmd === "sync:push-now")
        setMsg(`✓ pushed — sent ${r.sent}, accepted ${r.accepted}, rejected ${r.rejected} · pending ${r.pendingBefore} → ${r.pendingAfter}`);
      else
        setMsg(`✓ pulled ${r.pulled ?? 0} mutation(s)`);
    } catch (e: any) {
      setMsg(`✗ ${label}: ${e?.message || String(e)}`);
    } finally { setBusy(null); refresh(); }
  };

  const toggleUuid = async () => {
    const next = pf?.flags?.sync_uuid_identity !== "true";
    setBusy("uuid"); setMsg("");
    try {
      const r: any = await invoke("sync:set-uuid-identity", { enabled: next });
      setMsg(r?.ok
        ? `✓ stored ${r.wrote} — RESTART REQUIRED before it affects any push or pull`
        : `✗ ${r?.error || "could not store"}`);
    } catch (e: any) {
      setMsg(`✗ ${e?.message || String(e)}`);
    } finally { setBusy(null); refresh(); }
  };

  const stored = pf?.flags?.sync_uuid_identity === "true";
  const live = pf?.flags?.engineUuidIdentity === true;
  const label: React.CSSProperties = { fontSize: 11, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 };
  const btn: React.CSSProperties = {
    padding: "6px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer",
    background: "transparent", color: "var(--text-secondary)",
    border: "1px solid var(--border-primary)", borderRadius: "var(--r-0, 0px)",
  };

  return (
    <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--border-primary)" }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>
        Multi-Machine Sync
      </div>
      <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 12, lineHeight: 1.5 }}>
        Engineering controls. Run <b>Preflight on both machines and compare the station UUIDs before
        pushing anything</b> — if they do not match, UUID identity cannot merge them and a push will
        mix the stations up rather than reconcile them.
      </div>

      {pf && !pf.ok && (
        <div style={{ fontSize: 12, color: "var(--accent-red)", marginBottom: 10 }}>{pf.error}</div>
      )}

      {pf?.ok && (
        <div style={{ display: "grid", gap: 10, marginBottom: 12 }}>
          <div>
            <div style={label}>This machine</div>
            <div style={{ fontSize: 12, fontFamily: "'DM Mono', monospace", color: "var(--text-secondary)", wordBreak: "break-all" }}>
              {pf.machineId || "—"}
            </div>
          </div>

          <div>
            <div style={label}>Stations — id ↔ UUID</div>
            {(pf.stations || []).length === 0
              ? <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>No stations.</div>
              : (pf.stations || []).map(s => (
                <div key={s.id} style={{ fontSize: 12, fontFamily: "'DM Mono', monospace", color: "var(--text-secondary)", wordBreak: "break-all", padding: "2px 0" }}>
                  <span style={{ color: "var(--text-primary)", fontWeight: 700 }}>{s.id}</span>
                  {" · "}{s.name}{" · "}{s.uuid}
                </div>
              ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
            <div>
              <div style={label}>Pending mutations</div>
              <div style={{ fontSize: 18, fontWeight: 800, fontVariantNumeric: "tabular-nums",
                            color: (pf.mutations?.pending ?? 0) > 0 ? "var(--accent-amber)" : "var(--accent-green)" }}>
                {pf.mutations?.pending?.toLocaleString() ?? "—"}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>of {pf.mutations?.total?.toLocaleString() ?? "—"} total</div>
            </div>
            <div>
              <div style={label}>Scheduler</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: pf.schedulerRunning ? "var(--accent-green)" : "var(--text-tertiary)" }}>
                {pf.schedulerRunning ? "running" : "not running"}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>sync_enabled: {pf.flags?.sync_enabled ?? "unset"}</div>
            </div>
            <div>
              <div style={label}>Ever received</div>
              {/* Origin, not pending. An install with a clean queue can still never have received a
                  single row from a peer, and only this says so. */}
              <div style={{ fontSize: 18, fontWeight: 800,
                            color: (pf.mutations?.byOrigin || []).some(o => o.origin !== "local")
                                   ? "var(--accent-green)" : "var(--accent-amber)" }}>
                {(pf.mutations?.byOrigin || []).some(o => o.origin !== "local") ? "yes" : "never"}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                {(pf.mutations?.byOrigin || []).map(o => `${o.origin}: ${o.n.toLocaleString()}`).join(" · ") || "—"}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Stored vs live are shown separately on purpose: the flag is read once when the sync engine
          is built at startup, so after toggling, the two disagree until Ether is restarted. Showing
          only one of them would make a pending restart invisible. */}
      <div style={{ padding: "10px 12px", background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", marginBottom: 12 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
          <input type="checkbox" checked={stored} disabled={busy !== null || !pf?.ok} onChange={toggleUuid} />
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
            UUID-based station identity
          </span>
        </label>
        <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 6, lineHeight: 1.5 }}>
          Routes station-scoped rows by station UUID instead of by this machine's local integer id.
          Stored: <b>{pf?.flags?.sync_uuid_identity ?? "unset"}</b> · in the running engine: <b>{String(live)}</b>.
          {stored !== live && (
            <span style={{ color: "var(--accent-amber)", fontWeight: 700 }}> Restart Ether — the stored
            value is not the one in use. Quit fully and reopen; the audio daemon does not reload on its own.</span>
          )}
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button style={btn} onClick={refresh} disabled={busy !== null}>
          {busy === "preflight" ? "CHECKING…" : "PREFLIGHT"}
        </button>
        <button style={btn} onClick={() => run("sync:push-now", "push")} disabled={busy !== null}>
          {busy === "push" ? "PUSHING…" : "PUSH NOW"}
        </button>
        <button style={btn} onClick={() => run("sync:pull-now", "pull")} disabled={busy !== null}>
          {busy === "pull" ? "PULLING…" : "PULL NOW"}
        </button>
      </div>

      {msg && (
        <div style={{ marginTop: 10, fontSize: 12, lineHeight: 1.5,
                      color: msg.startsWith("✓") ? "var(--accent-green)" : "var(--accent-red)" }}>
          {msg}
        </div>
      )}
    </div>
  );
}
