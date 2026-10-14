// SyncCleanupRows — Preferences → Multi-Machine Sync: "Stuck sync entries" (the Run sync cleanup now button) and
// "Health log" (its size settings). Jeff, 2026-10-13 (docs/air-machine-stalls-plan-2026-10-13.md §1 and §3; help:
// docs/help-sync-cleanup.md).
import { useEffect, useState } from "react";

type Counts = { excludedPending: Record<string, number>; excludedPendingTotal: number; allPending: number; allRows: number };
type CleanupView = {
  running: boolean; kind: "auto" | "now" | null; waitingForSilence: boolean; startedAt: number | null; canRunNow: boolean;
  progress: { phase: "backup" | "delete"; done: number; of: number } | null;
  last: { at: number; ok: boolean; message: string } | null;
};
type LogSettings = { maxMb: number | null; keep: number | null; archiveDays: number | null };

const ether = () => (window as any).ether;
const n = (v: number | null | undefined) => (v == null ? "?" : v.toLocaleString("en-US"));
const label: React.CSSProperties = { fontSize: 11, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700, margin: "14px 0 6px" };
const btn: React.CSSProperties = { padding: "6px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer", background: "transparent", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0 };
const note: React.CSSProperties = { fontSize: 11.5, color: "var(--text-tertiary)", lineHeight: 1.45 };
const inp: React.CSSProperties = { width: 70, padding: "4px 6px", fontSize: 12, background: "var(--bg-primary)", color: "var(--text-primary)", border: "1px solid var(--border-primary)", borderRadius: 0 };

export function SyncCleanupRow() {
  const [counts, setCounts] = useState<Counts | null>(null);
  const [countErr, setCountErr] = useState<string | null>(null);
  const [view, setView] = useState<CleanupView | null>(null);
  const [msg, setMsg] = useState<string>("");

  const count = async () => {
    setCountErr(null);
    try {
      const r = await ether().invoke("sync-cleanup:count");
      if (r?.ok) setCounts(r.counts); else setCountErr(r?.reason || "could not count");
    } catch (e: any) { setCountErr(e?.message || String(e)); }
  };
  useEffect(() => {
    void count();
    ether().invoke("sync-cleanup:status").then((v: CleanupView) => setView(v)).catch(() => {});
    const h = ether().on("sync-cleanup:status", (v: CleanupView) => {
      setView((prev) => { if (prev?.running && !v.running) void count(); return v; });
    });
    return () => { try { ether().off("sync-cleanup:status", h); } catch { /* gone */ } };
  }, []);

  const runNow = async () => {
    setMsg("");
    try {
      const r = await ether().invoke("sync-cleanup:run-now");
      if (!r?.ok) setMsg(r?.reason || "Did not start.");
    } catch (e: any) { setMsg(e?.message || String(e)); }
  };

  const stuck = counts?.excludedPendingTotal ?? null;
  const p = view?.progress;
  return (
    <div>
      <div style={label}>Stuck sync entries</div>
      <div style={{ fontSize: 13, color: "var(--text-primary)", marginBottom: 4 }}>
        {countErr ? `Could not count: ${countErr}`
          : stuck == null ? "Counting…"
          : stuck === 0 ? "None — nothing is stuck in this machine's sync queue."
          : `${n(stuck)} entries this machine will never send` +
            ` (${Object.entries(counts!.excludedPending).filter(([, v]) => v > 0).map(([t, v]) => `${n(v)} for ${t === "generated_schedule" ? "the generated log" : t}`).join(", ")}).`}
        {counts && <span style={{ color: "var(--text-tertiary)" }}> Waiting to send in all: {n(counts.allPending)} · in the queue: {n(counts.allRows)}.</span>}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button style={{ ...btn, opacity: view && !view.canRunNow ? 0.5 : 1 }} disabled={!!view && !view.canRunNow} onClick={() => void runNow()}>
          {view?.running && view.kind === "now" ? "CLEANING…" : "RUN SYNC CLEANUP NOW"}
        </button>
        <button style={btn} onClick={() => void count()}>COUNT AGAIN</button>
        {view?.running && view.kind === "now" && (
          <span style={{ fontSize: 12, color: "var(--accent-cyan)" }}>
            {p ? `${p.phase === "backup" ? "Backing up" : "Removing"} ${n(p.done)} of ${n(p.of)}…` : "Starting…"}
          </span>
        )}
        {view?.running && view.kind === "auto" && (
          <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
            {view.waitingForSilence ? "The automatic cleanup is waiting for 15 s of silence — Run now will replace it." : "The automatic cleanup is running."}
          </span>
        )}
      </div>
      {msg && <div style={{ fontSize: 12, marginTop: 6, color: "#e0a060" }}>{msg}</div>}
      {view?.last && (
        <div style={{ fontSize: 12, marginTop: 6, color: view.last.ok ? "var(--accent-cyan)" : "#e0a060" }}>
          {new Date(view.last.at).toLocaleTimeString()} — {view.last.message}
        </div>
      )}
      <div style={{ ...note, marginTop: 6 }}>
        Safe while on air. It copies every entry it will remove to a backup file first (in this station's backups folder) and
        checks the copy, then removes them in small steps so the app and the audio never wait behind it. Only entries for
        tables that are never sent are touched — nothing else in the queue and no station data. The automatic cleanup still
        runs by itself after 15 s of silence. Use this one on an air machine, not CLEAR PENDING (which empties the whole
        queue in one step).
      </div>
    </div>
  );
}

export function HealthLogRow() {
  const [cur, setCur] = useState<{ settings: LogSettings; status: { sizeBytes: number | null; queued: number; rotations: number; archived: string[]; deleted: string[]; lastError: string | null } } | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");
  const load = async () => {
    try {
      const r = await ether().invoke("health-log:get");
      if (!r?.ok) { setMsg(r?.error || "not read"); return; }
      setCur(r);
      setDraft({ maxMb: String(r.settings.maxMb ?? ""), keep: String(r.settings.keep ?? ""), archiveDays: String(r.settings.archiveDays ?? "") });
    } catch (e: any) { setMsg(e?.message || String(e)); }
  };
  useEffect(() => { void load(); }, []);
  const save = async (k: keyof LogSettings) => {
    try {
      const r = await ether().invoke("health-log:set", k, Number(draft[k]));
      setMsg(r?.ok ? `Saved: ${r.value}.` : `Not saved: ${r?.reason || "no answer"}`);
      void load();
    } catch (e: any) { setMsg(`Not saved: ${e?.message || String(e)}`); }
  };
  const rows: [keyof LogSettings, string, string][] = [
    ["maxMb", "Rotate at", "MB"], ["keep", "Keep", "old files"], ["archiveDays", "Delete archives after", "days"],
  ];
  const size = cur?.status.sizeBytes;
  return (
    <div>
      <div style={label}>Health log</div>
      <div style={{ fontSize: 12.5, color: "var(--text-secondary)", marginBottom: 4 }}>
        One file, written in the background. Now {size == null ? "not created yet" : `${(size / 1048576).toFixed(1)} MB`}
        {cur && cur.status.rotations > 0 ? ` · rotated ${cur.status.rotations}× this session` : ""}
        {cur?.status.lastError ? ` · last write problem: ${cur.status.lastError}` : ""}
      </div>
      {rows.map(([k, name, unit]) => (
        <div key={k} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
          <span style={{ width: 170, fontSize: 12.5 }}>{name}</span>
          <input style={inp} value={draft[k] ?? ""} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))} />
          <span style={{ fontSize: 12, color: "var(--text-tertiary)", width: 60 }}>{unit}</span>
          <button style={btn} onClick={() => void save(k)}>Save</button>
          <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>now: {cur?.settings[k] ?? "not set"}</span>
        </div>
      ))}
      {msg && <div style={{ fontSize: 12, marginTop: 4, color: "var(--accent-cyan)" }}>{msg}</div>}
      <div style={{ ...note, marginTop: 4 }}>
        Past "Rotate at" the log becomes health-events.1.jsonl and a new one starts; only "Keep" old files are kept. The two
        big logs from before this build were renamed to health-events.archive-… and are deleted after "Delete archives after".
      </div>
    </div>
  );
}
