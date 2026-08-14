// ── MultiMachineSync — the engineering surface for two installs sharing one account ────────────
//
// Added 2026-08-14. Sits under Cloud Backup because that is where an operator already goes to ask
// "is my data safe on more than this machine".
//
// It exists because of a specific investigation: "the sync is additive only — it backs up new songs
// but doesn't remove deleted ones". The deletion path turned out to be correct end to end, and the
// real finding was that NOTHING had ever synced in either direction — every mutation `pending`,
// every row `origin='local'`. None of that was visible anywhere in the app, which is why it went
// unnoticed for so long. So this panel leads with the two numbers that would have shown it.
//
// READ THE ORIGIN BREAKDOWN, not just the pending count. All-'local' means nothing has ever been
// RECEIVED — a push count alone cannot tell you that, and it is the difference between "sync is
// behind" and "sync has never run".
import { useCallback, useEffect, useState } from "react";

const invoke = <T = any,>(cmd: string, args?: any): Promise<T> =>
  (window as any).ether?.invoke?.(cmd, args);

interface StationRow { id: number; uuid: string; name: string; is_active?: number }
interface Preflight {
  ok: boolean; error?: string;
  machineId?: string | null;
  stations?: StationRow[];
  activeStationId?: number | null;
  flags?: { sync_enabled?: string | null; sync_uuid_identity?: string | null; engineUuidIdentity?: boolean | null };
  schedulerRunning?: boolean;
  mutations?: {
    pending?: number | null; total?: number | null;
    byStatus?: Array<{ sync_status: string; n: number }>;
    byOrigin?: Array<{ origin: string; n: number }>;
    songDeletes?: number | null;
  };
}

const card: React.CSSProperties = {
  background: "var(--bg-tertiary)", border: "1px solid var(--border-primary)",
  borderRadius: 0, padding: 16,
};
const btn = (kind: "primary" | "plain" = "plain"): React.CSSProperties => ({
  padding: "8px 18px", borderRadius: 0, fontSize: 12, fontWeight: 600, cursor: "pointer",
  background: kind === "primary" ? "var(--accent-blue)" : "var(--bg-secondary)",
  color: kind === "primary" ? "#fff" : "var(--text-secondary)",
  border: kind === "primary" ? "none" : "1px solid var(--border-primary)",
});
const mono: React.CSSProperties = { fontFamily: "'DM Mono', ui-monospace, monospace", fontVariantNumeric: "tabular-nums" };

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ ...mono, fontSize: 18, fontWeight: 800, lineHeight: 1.15, color: tone || "var(--text-primary)",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</div>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase",
                    color: "var(--text-tertiary)", marginTop: 2 }}>{label}</div>
    </div>
  );
}

export default function MultiMachineSync() {
  const [pf, setPf] = useState<Preflight | null>(null);
  const [stats, setStats] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(async () => {
    setBusy("preflight");
    try {
      const [p, s] = await Promise.all([
        invoke<Preflight>("sync:preflight"),
        // Separate call: last-sync time lives on the scheduler's stats, not in preflight.
        invoke<any>("sync:getStats").catch(() => null),
      ]);
      setPf(p || { ok: false, error: "no response from sync:preflight" });
      setStats(s);
    } catch (e: any) {
      setPf({ ok: false, error: e?.message || String(e) });
    }
    setBusy(null);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const run = async (cmd: "sync:push-now" | "sync:pull-now", label: string) => {
    setBusy(label);
    setResult(null);
    try {
      const r: any = await invoke(cmd);
      if (!r?.ok) setResult({ ok: false, text: r?.error || "failed" });
      else if (cmd === "sync:push-now") {
        setResult({ ok: true, text: `sent ${r.sent} · accepted ${r.accepted} · rejected ${r.rejected} · pending ${r.pendingBefore} → ${r.pendingAfter}` });
      } else {
        setResult({ ok: true, text: `pulled ${r.pulled ?? 0}` + (r.byTable ? ` · ${Object.keys(r.byTable).length} table(s)` : "") });
      }
    } catch (e: any) {
      setResult({ ok: false, text: e?.message || String(e) });
    }
    setBusy(null);
    refresh();
  };

  const toggleUuid = async (next: boolean) => {
    setBusy("uuid");
    setResult(null);
    try {
      const r: any = await invoke("sync:set-uuid-identity", { enabled: next });
      setResult(r?.ok
        ? { ok: true, text: `Stored ${r.wrote}. ${r.restartRequired ? "Fully quit and reopen Ether for it to take effect." : ""}` }
        : { ok: false, text: r?.error || "the write did not take" });
    } catch (e: any) {
      setResult({ ok: false, text: e?.message || String(e) });
    }
    setBusy(null);
    refresh();
  };

  const stored = pf?.flags?.sync_uuid_identity === "true";
  const live = pf?.flags?.engineUuidIdentity === true;
  const pending = pf?.mutations?.pending ?? null;
  const origins = pf?.mutations?.byOrigin || [];
  const neverReceived = origins.length > 0 && origins.every(o => o.origin === "local");
  const lastSyncAt = stats?.lastSyncAt ?? null;

  return (
    <div style={{ padding: "0 0 20px" }}>
      <h3 style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 16,
                   textTransform: "uppercase", letterSpacing: "0.06em" }}>Multi-Machine Sync</h3>

      <div style={card}>
        <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginBottom: 14, lineHeight: 1.6 }}>
          For an account running on more than one computer. Run <strong>Preflight on both machines and
          compare the station UUIDs before pushing</strong> — if they differ, a push cannot merge the
          two installs.
        </div>

        {pf && !pf.ok && (
          <div style={{ fontSize: 12, color: "#ef4444", marginBottom: 14 }}>{pf.error}</div>
        )}

        <div style={{ display: "grid", gap: 14, marginBottom: 16,
                      gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))" }}>
          <Stat label="pending mutations"
                value={pending == null ? "—" : pending.toLocaleString()}
                tone={pending ? "var(--accent-amber)" : undefined} />
          <Stat label="sync engine"
                value={pf?.schedulerRunning ? "running" : "not running"}
                tone={pf?.schedulerRunning ? "var(--accent-green)" : "var(--text-tertiary)"} />
          <Stat label="last sync"
                value={lastSyncAt ? new Date(lastSyncAt).toLocaleString() : "never"}
                tone={lastSyncAt ? undefined : "var(--text-tertiary)"} />
          <Stat label="uuid identity"
                value={live ? "on" : stored ? "on after restart" : "off"}
                tone={live ? "var(--accent-green)" : stored ? "var(--accent-amber)" : "var(--text-tertiary)"} />
        </div>

        {/* The reading that names "has never run" as distinct from "is behind". */}
        {neverReceived && (
          <div style={{ fontSize: 11, color: "var(--accent-amber)", marginBottom: 14, lineHeight: 1.6,
                        borderLeft: "3px solid var(--accent-amber)", paddingLeft: 10 }}>
            Every mutation on this machine was written here — nothing has ever been received from
            another install. This machine has not yet synced in either direction.
          </div>
        )}

        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 8,
                      textTransform: "uppercase", letterSpacing: "0.05em" }}>
          Stations on this machine
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
          {(pf?.stations || []).length === 0 && (
            <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>No stations.</div>
          )}
          {(pf?.stations || []).map(s => (
            <div key={s.uuid} style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)",
                                       padding: "8px 12px" }}>
              <div style={{ fontSize: 12, color: "var(--text-primary)", fontWeight: 600 }}>
                {s.name} <span style={{ ...mono, color: "var(--text-tertiary)", fontWeight: 400 }}>· local id {s.id}</span>
              </div>
              {/* Selectable, because the whole point is comparing it against another machine's. */}
              <div style={{ ...mono, fontSize: 11, color: "var(--text-secondary)", userSelect: "text", marginTop: 2 }}>
                {s.uuid}
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
          <button onClick={refresh} disabled={!!busy} style={btn("primary")}>
            {busy === "preflight" ? "Checking…" : "Preflight"}
          </button>
          <button onClick={() => run("sync:push-now", "push")} disabled={!!busy} style={btn()}>
            {busy === "push" ? "Pushing…" : "Push Now"}
          </button>
          <button onClick={() => run("sync:pull-now", "pull")} disabled={!!busy} style={btn()}>
            {busy === "pull" ? "Pulling…" : "Pull Now"}
          </button>
          {result && (
            <span style={{ fontSize: 12, color: result.ok ? "var(--accent-green)" : "#ef4444" }}>
              {result.text}
            </span>
          )}
        </div>

        <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer",
                        borderTop: "1px solid var(--border-primary)", paddingTop: 12 }}>
          <input type="checkbox" checked={stored} disabled={!!busy}
                 onChange={e => toggleUuid(e.target.checked)} style={{ marginTop: 2 }} />
          <span style={{ minWidth: 0 }}>
            <span style={{ fontSize: 12, color: "var(--text-primary)", fontWeight: 600 }}>
              Use UUID-based station identity
            </span>
            <span style={{ display: "block", fontSize: 11, color: "var(--text-tertiary)", lineHeight: 1.6, marginTop: 2 }}>
              Routes station rows by station UUID instead of by this machine's local station number.
              Two installs whose local numbers differ need this to merge rather than mix stations up.
              {" "}<strong style={{ color: "var(--accent-amber)" }}>
                Takes effect only after fully quitting and reopening Ether
              </strong> — the setting is read once at startup.
              {stored && !live && (
                <span style={{ display: "block", color: "var(--accent-amber)", marginTop: 4 }}>
                  Stored, but the running app is still using the old setting. Restart to apply.
                </span>
              )}
            </span>
          </span>
        </label>
      </div>
    </div>
  );
}
