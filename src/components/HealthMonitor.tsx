import { useState, useEffect, useCallback, useRef, Component, ReactNode } from "react";
import { query, dbHealthCheck } from "../db/client";
import { useAudioEngine } from "../audio/AudioEngineContext";
import { useActiveStation, getActiveStationIdSync } from "../hooks/useActiveStation";
import { deriveHaRollup, type HaDashboard, type HaRollupLevel } from "../lib/haRollup";
import { PopoutBtn } from "./PopoutShell";
import { LiveHealthMonitor } from "../audio/health";
import { LiveActivityTerminal } from "./LiveActivityTerminal";

// Two-column breakpoint for the Health Monitor. Below this the terminal drops BELOW the sections
// (one column) rather than squeezing both. 820 = the sections' comfortable minimum (~360) plus the
// terminal column (460). The first cut used 1000 measured against window.innerWidth, which put the
// ~950px Station Health popout into the stacked layout — right code, wrong thing measured.
const TWO_COL_MIN_PX = 820;

/** Two columns or one, decided by THE PANEL'S OWN WIDTH — not the window's.
 *  This panel renders both docked in the main window (where it is one of several regions) and as its
 *  own popout, so the window is not a proxy for the space it actually has. A ResizeObserver on the
 *  panel element gets it right in both, and reacts to the docked panel being resized without the
 *  window changing at all. Falls back to a window listener where ResizeObserver is unavailable. */
function useTwoColumn(): readonly [React.RefObject<HTMLDivElement>, boolean] {
  const ref = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWide(el.getBoundingClientRect().width >= TWO_COL_MIN_PX);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, wide] as const;
}

// ═══════════════════════════════════════════════════════════════
// 1. ERROR BOUNDARY
// ═══════════════════════════════════════════════════════════════

interface ErrorBoundaryState { hasError: boolean; error: Error | null; }
interface ErrorBoundaryProps { children: ReactNode; }

export class EtherErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: any) {
    // Log to local DB — class component can't use hooks, use sync cache read
    const stationId = getActiveStationIdSync();
    try {
      (window as any).ether.stationConfigKv.upsertByKey(
        stationId,
        'last_error',
        JSON.stringify({ message: error.message, stack: error.stack, time: Date.now(), component: info?.componentStack?.split("\n")[1]?.trim() })
      );
    } catch {}
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          position: "fixed", inset: 0, zIndex: 99999,
          background: "var(--bg-primary)",
          display: "flex", flexDirection: "column" as const,
          alignItems: "center", justifyContent: "center",
          fontFamily: "'Inter', system-ui, sans-serif",
          gap: 16,
        }}>
          {/* Logo */}
          <div style={{ width: 48, height: 48, borderRadius: 0, background: "linear-gradient(135deg, var(--accent-blue), #6d28d9)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 8 }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round">
              <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
            </svg>
          </div>

          <div style={{ textAlign: "center" as const }}>
            <h2 style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 800, color: "var(--text-primary)", fontFamily: "'Newsreader', Georgia, serif" }}>
              Ether encountered an issue
            </h2>
            <p style={{ margin: 0, fontSize: 13, color: "rgba(255,255,255,0.5)", maxWidth: 400, lineHeight: 1.6 }}>
              Your session has been saved automatically. The audio engine continues running — your broadcast is safe.
            </p>
          </div>

          {/* Error detail */}
          <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 0, padding: "10px 16px", maxWidth: 480, width: "90%" }}>
            <code style={{ fontSize: 10, color: "rgba(255,100,100,0.8)", fontFamily: "'DM Mono', monospace", display: "block", wordBreak: "break-all" as const }}>
              {this.state.error?.message}
            </code>
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload(); }}
              style={{ padding: "10px 24px", borderRadius: 0, background: "var(--accent-blue)", border: "none", color: "#000", fontSize: 13, fontWeight: 700, cursor: "pointer" }}
            >
              Restart Interface
            </button>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              style={{ padding: "10px 24px", borderRadius: 0, background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", color: "var(--text-primary)", fontSize: 13, fontWeight: 500, cursor: "pointer" }}
            >
              Try to Continue
            </button>
          </div>

          <p style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", margin: 0 }}>
            Audio engine and broadcast continue unaffected
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

// ═══════════════════════════════════════════════════════════════
// 2. SESSION RESTORE TOAST
// ═══════════════════════════════════════════════════════════════

interface RestoreInfo {
  title: string | null;
  position: number;
  queueLen: number;
  savedAt: number;
}

export function SessionRestoreToast({ info, onDismiss }: { info: RestoreInfo; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 6000);
    return () => clearTimeout(t);
  }, [onDismiss]);

  const ago = Math.round((Date.now() / 1000 - info.savedAt) / 60);
  const fmtPos = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  return (
    <div style={{
      position: "fixed", bottom: 40, left: "50%", transform: "translateX(-50%)",
      zIndex: 9999,
      background: "var(--bg-secondary)",
      border: "1px solid var(--accent-green)",
      borderRadius: 0, padding: "10px 16px",
      boxShadow: "0 4px 24px rgba(0,0,0,0.3), 0 0 0 1px rgba(52,211,153,0.2)",
      display: "flex", alignItems: "center", gap: 10,
      fontFamily: "'Inter', sans-serif",
      animation: "deck-slide-in 0.3s ease both",
      minWidth: 320,
    }}>
      <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent-green)", flexShrink: 0 }} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-primary)" }}>
          Session restored {ago > 0 ? `(${ago} min ago)` : ""}
        </div>
        {info.title && (
          <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 2 }}>
            {info.title} was at {fmtPos(info.position)} · {info.queueLen} tracks in queue
          </div>
        )}
      </div>
      <button onClick={onDismiss} style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 14 }}>✕</button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// 3. HEALTH MONITOR PANEL
// ═══════════════════════════════════════════════════════════════

interface HealthData {
  audioEngine: "ok" | "warn" | "error";
  database: "ok" | "warn" | "error";
  deadAirProtection: boolean;
  playLogCount: number;
  lastPlayedAt: number | null;
  queueLen: number;
  diskSpaceGb: number | null;
  sessionStart: number;
  lastError: string | null;
}

function HealthDot({ status }: { status: "ok" | "warn" | "error" }) {
  const color = status === "ok" ? "var(--accent-green)" : status === "warn" ? "var(--accent-amber)" : "var(--accent-red)";
  return (
    <div style={{
      width: 7, height: 7, borderRadius: "50%", background: color, flexShrink: 0,
      boxShadow: status === "ok" ? `0 0 6px ${color}` : "none",
      animation: status === "error" ? "onair-pulse 1s ease-in-out infinite" : "none",
    }} />
  );
}

function HealthRow({ label, value, status, sub }: { label: string; value: string; status: "ok" | "warn" | "error"; sub?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderBottom: "1px solid var(--border-primary)" }}>
      <HealthDot status={status} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-primary)" }}>{label}</div>
        {sub && <div style={{ fontSize: 9, color: "var(--text-tertiary)", marginTop: 1 }}>{sub}</div>}
      </div>
      <span style={{ fontSize: 10, fontFamily: "'DM Mono', monospace", color: status === "ok" ? "var(--accent-green)" : status === "warn" ? "var(--accent-amber)" : "var(--accent-red)" }}>
        {value}
      </span>
    </div>
  );
}

const ROLLUP_COLOR: Record<HaRollupLevel, string> = {
  healthy:  "var(--accent-green)",
  degraded: "var(--accent-amber)",
  alarm:    "var(--accent-red)",
  inactive: "var(--text-tertiary)",
  loading:  "var(--text-tertiary)",
};

function fmtUptime(sec: number): string {
  if (!sec || sec < 0) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// Big GREEN/AMBER/RED rollup banner at the top of the panel. Derived purely from
// the dashboard via deriveHaRollup (unit-tested in haRollup.test.ts).
function HaRollupBanner({ dash }: { dash: HaDashboard | null }) {
  const rollup = deriveHaRollup(dash);
  const color = ROLLUP_COLOR[rollup.level];
  const pulse = rollup.level === "alarm" ? "onair-pulse 1s ease-in-out infinite"
              : rollup.level === "healthy" ? "nominal-pulse 2.4s ease-in-out infinite"
              : "none";
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 14,
      padding: "16px 18px", marginTop: 20, marginBottom: 4,
      borderRadius: 0,
      background: rollup.level === "inactive" || rollup.level === "loading" ? "var(--bg-secondary)" : `${color}14`,
      border: `1px solid ${rollup.level === "inactive" || rollup.level === "loading" ? "var(--border-primary)" : color}`,
    }}>
      <div style={{ width: 14, height: 14, borderRadius: "50%", background: color, flexShrink: 0, boxShadow: `0 0 10px ${color}`, animation: pulse }} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 16, fontWeight: 800, letterSpacing: "0.04em", color, fontFamily: "'Newsreader', Georgia, serif" }}>
          {rollup.label}
        </div>
        <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginTop: 2, lineHeight: 1.5 }}>
          {rollup.reasons.length ? rollup.reasons.join(" ") : "High Availability — crash & hang supervision"}
        </div>
      </div>
    </div>
  );
}

export function HealthMonitor({ onClose }: { onClose: () => void }) {
  const engine = useAudioEngine();
  const [health, setHealth] = useState<HealthData | null>(null);
  const [dbSchemaVersion, setDbSchemaVersion] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState(false);
  const [sessionStart] = useState(Date.now());
  const { stationId, isReady } = useActiveStation();

  // ── HA dashboard (combined /health snapshot + watchdog control-plane) ──
  const [dash, setDash] = useState<HaDashboard | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const isPopout = typeof window !== "undefined" && window.location.hash.startsWith("#popout/");

  // ── LIBRARY & ROTATION senses (Slice C) — poll library-health:get (hourly-refreshed in main) ──
  const [libHealth, setLibHealth] = useState<any>(null);
  const [unresolvableFor, setUnresolvableFor] = useState<number | null>(null);
  const [unresolvableList, setUnresolvableList] = useState<{ id: number; title: string }[]>([]);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (document.hidden) return;
      try { const s = await (window as any).ether?.invoke?.("library-health:get"); if (!stop && s) setLibHealth(s); } catch { /* IPC absent */ }
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => { stop = true; clearInterval(id); };
  }, []);
  const showUnresolvable = async (sid: number) => {
    if (unresolvableFor === sid) { setUnresolvableFor(null); return; }
    try {
      const rows = await (window as any).ether.invoke("library-health:eligibility", sid);
      setUnresolvableList((Array.isArray(rows) ? rows : []).filter((r: any) => r.status === "UNRESOLVABLE").map((r: any) => ({ id: r.id, title: r.title })));
      setUnresolvableFor(sid);
    } catch { setUnresolvableList([]); setUnresolvableFor(sid); }
  };

  // ── LOG-READER FLIP §2.7 boundary shadow (Phase 3) — poll logreader-shadow:get (60s; low-churn) ──
  // The burn-in "sense": at each go-live the daemon reports what the time-anchored flip WOULD air vs
  // what legacy aired. Here it surfaces as an agree-rate + drift/miss extent per station, so the flip's
  // readiness is visible before anyone flips the flag. Display-only.
  const [shadowSummary, setShadowSummary] = useState<any[]>([]);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (document.hidden) return;
      try { const s = await (window as any).ether?.invoke?.("logreader-shadow:get"); if (!stop && Array.isArray(s)) setShadowSummary(s); } catch { /* IPC absent */ }
    };
    tick();
    const id = setInterval(tick, 60000);
    return () => { stop = true; clearInterval(id); };
  }, []);

  // Log-Reader Flip CANARY toggle — per-station flag (station_config_kv 'log_reader_flip', LOCAL-ONLY,
  // never syncs). Flips a station's playout to the §2.7 time-anchored log-reader. Read via get-value,
  // written via set-local (the mutation-less local writer). Refreshed when the station list changes.
  // 2026-07-30 — this control is now READ-DERIVED ONLY. It previously kept a boolean map and computed
  // the write as `toggleFlip(sid, !on)` — i.e. the value written was derived from what was ON SCREEN.
  // That makes a stale render self-perpetuating: if the map ever holds `true` while the stored value is
  // '0', every click writes '0' again and the button can never recover. Confirmed on 4.4.106 (DevTools:
  // get-value returned {ok:true,value:'0'} while the button rendered ON). Three rules now:
  //   1. the write target is computed from a FRESH read of the stored value, never from render state;
  //   2. what renders is the value READ BACK AFTER the write — never an assumption that it landed;
  //   3. unknown is its own state (null), and a refused/ignored write is shown, not swallowed.
  // `null` = we could not read it — never guess OFF, which would invite exactly the wrong click.
  const [flipFlags, setFlipFlags] = useState<Record<number, boolean | null>>({});
  const [flipBusy, setFlipBusy] = useState<number | null>(null);
  const [flipErr, setFlipErr] = useState<Record<number, string>>({});

  /** The single source of truth for this control: what station_config_kv actually holds. */
  const readFlip = useCallback(async (sid: number): Promise<boolean | null> => {
    try {
      const r = await (window as any).ether?.invoke?.("station_config_kv:get-value", sid, "log_reader_flip");
      if (!r || !r.ok) return null;
      return r.value === "1" || r.value === "true";
    } catch { return null; }
  }, []);

  // Merge per station with a functional update instead of replacing the whole map. Two overlapping
  // refreshes (libHealth re-polls, so this effect can re-enter) can no longer clobber each other, and
  // one station failing to read leaves the others alone instead of resetting everything.
  const refreshFlipFlags = useCallback(async () => {
    const sts = (libHealth?.stations || []) as any[];
    for (const st of sts) {
      const v = await readFlip(st.stationId);
      setFlipFlags(prev => ({ ...prev, [st.stationId]: v }));
    }
  }, [libHealth, readFlip]);
  useEffect(() => { refreshFlipFlags(); }, [refreshFlipFlags]);

  /** Flip a station. Reads the stored value, writes its opposite, then renders the read-back. */
  const toggleFlip = async (sid: number) => {
    setFlipBusy(sid);
    setFlipErr(prev => { const n = { ...prev }; delete n[sid]; return n; });
    try {
      const current = await readFlip(sid);
      if (current === null) {
        setFlipErr(prev => ({ ...prev, [sid]: "can't read the stored value — not writing blind" }));
        setFlipFlags(prev => ({ ...prev, [sid]: null }));
        return;
      }
      const target = !current;
      const w = await (window as any).ether?.invoke?.("station_config_kv:set-local", sid, "log_reader_flip", target ? "1" : "0");
      // The write's own verdict matters — set-local REFUSES a non-local-only key and returns {ok:false}.
      const writeRefused = !w || w.ok === false;
      // Render the stored value, whatever the write claimed.
      const after = await readFlip(sid);
      setFlipFlags(prev => ({ ...prev, [sid]: after }));
      if (writeRefused) setFlipErr(prev => ({ ...prev, [sid]: `write refused: ${(w && w.error) || "no response"}` }));
      else if (after !== target) setFlipErr(prev => ({ ...prev, [sid]: `write did not stick — still ${after === null ? "unreadable" : after ? "ON" : "OFF"}` }));
    } finally {
      setFlipBusy(null);
    }
  };

  // 5s poll, skipped while the panel isn't visible (minimized / occluded / hidden
  // tab) via document.hidden — NOT on blur, so a popout left open on a second
  // monitor keeps updating while the operator works in the main window. On
  // becoming visible/focused again we refresh immediately.
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const d = await (window as any).ether?.ha?.dashboard();
        if (!stop && d) setDash(d);
      } catch { /* IPC unavailable — keep last snapshot */ }
    };
    tick();
    const id = setInterval(tick, 5000);
    const onVisible = () => { if (!document.hidden) tick(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      stop = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  // watchdog.log tail — on-demand only (the log changes only on a restart event).
  const loadEvents = useCallback(async () => {
    setEventsLoading(true);
    try {
      const r = await (window as any).ether?.ha?.readLog(14);
      setEvents(Array.isArray(r?.lines) ? r.lines : []);
    } catch { setEvents([]); }
    setEventsLoading(false);
  }, []);
  useEffect(() => { loadEvents(); }, [loadEvents]);

  const load = useCallback(async () => {
    if (!isReady) return;
    try {
      const [dbCheck, playLog, lastErrorResult] = await Promise.all([
        dbHealthCheck(),
        query<{ count: number; last: number | null }>("SELECT COUNT(*) as count, MAX(played_at) as last FROM play_log").catch(() => [{ count: 0, last: null }]),
        (window as any).ether.stationConfigKv.list(stationId).catch(() => ({ ok: false, rows: [] as any[] })),
      ]);

      const deckA = engine.getDeck("A");
      const engineOk = deckA !== null;
      const queueLen = engine.getQueue().length;
      const dbTest = dbCheck.ok ? { n: dbCheck.songCount } : null;
      setDbSchemaVersion(dbCheck.version);

      const lastErrorRow = (lastErrorResult.ok ? lastErrorResult.rows as { key: string; value: string }[] : [])
        .find((r: { key: string }) => r.key === 'last_error');

      let errorMsg: string | null = null;
      if (lastErrorRow) {
        try {
          const parsed = JSON.parse(lastErrorRow.value);
          const ageMs = Date.now() - (parsed.time || 0);
          const STALE_TTL_MS = 15 * 60_000;    // stale-alert lifecycle: retire any last_error older than 15m…
          const RECOVERED_GRACE_MS = 90_000;   // …or, once core subsystems are healthy again, one older than 90s
          const recovered = engineOk && !!dbTest;
          if (ageMs > STALE_TTL_MS || (recovered && ageMs > RECOVERED_GRACE_MS)) {
            // Auto-clear (no manual Dismiss needed) — covers the sticky "onSpeaking" TypeError and any
            // error left behind after its condition recovered.
            try { await (window as any).ether.stationConfigKv.removeByKey(stationId, 'last_error'); } catch {}
          } else {
            errorMsg = `${parsed.message} (${Math.round(ageMs / 60000)}m ago)`;
          }
        } catch {}
      }

      setHealth({
        audioEngine: engineOk ? "ok" : "error",
        database: dbTest ? "ok" : "error",
        deadAirProtection: true, // always on
        playLogCount: playLog[0]?.count ?? 0,
        lastPlayedAt: playLog[0]?.last ?? null,
        queueLen,
        diskSpaceGb: null, // TODO: wire via Node.js fs.statfsSync
        sessionStart,
        lastError: errorMsg,
      });
    } catch {}
  }, [sessionStart, stationId, isReady]);

  useEffect(() => {
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, [load]);

  const exportPlayLog = async () => {
    setExporting(true);
    try {
      const rows = await query<{ title: string; artist: string; deck: string; played_at: number }>(
        "SELECT title, artist, deck, played_at FROM play_log ORDER BY played_at DESC LIMIT 10000"
      );
      const lines = [
        "Date,Time,Title,Artist,Deck,Timestamp",
        ...rows.map(r => {
          const d = new Date(r.played_at * 1000);
          const date = d.toLocaleDateString();
          const time = d.toLocaleTimeString();
          const safe = (s: string) => `"${(s || "").replace(/"/g, '""')}"`;
          return `${date},${time},${safe(r.title)},${safe(r.artist)},${r.deck},${r.played_at}`;
        }),
      ].join("\n");

      const writeTextFile = (p: string, data: string, opts?: any) => (window as any).ether.fs.writeFile(p, data); const BaseDirectory = {};
      const filename = `ether_playlog_${new Date().toISOString().split("T")[0]}.csv`;
      await writeTextFile(filename, lines);
      setExported(true);
      setTimeout(() => setExported(false), 3000);
    } catch (e) {
      // Fallback: download via browser
      const blob = new Blob(["Play log export failed"], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "playlog.csv"; a.click();
    }
    setExporting(false);
  };

  const uptime = health ? Math.floor((Date.now() - health.sessionStart) / 60000) : 0;
  const uptimeStr = uptime < 60 ? `${uptime}m` : `${Math.floor(uptime / 60)}h ${uptime % 60}m`;
  const [panelRef, twoCol] = useTwoColumn();

  return (
    <div ref={panelRef} style={{
      height: "100%", display: "flex", flexDirection: "column" as const,
      fontFamily: "'Inter', system-ui, sans-serif",
      background: "var(--bg-primary)",
      minWidth: 420,
    }}>
      {/* Header */}
      <div style={{ padding: "24px 32px 20px", borderBottom: "1px solid var(--border-primary)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent-green)", boxShadow: "0 0 8px var(--accent-green)" }} />
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, fontFamily: "'Newsreader', Georgia, serif", letterSpacing: "-0.03em", color: "var(--text-primary)" }}>
              Health Monitor
            </h2>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {!isPopout && <PopoutBtn panel="health" label="Station Health" />}
            <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", fontSize: 18 }}>✕</button>
          </div>
        </div>
        <p style={{ margin: "4px 0 0", fontSize: 11, color: "var(--text-tertiary)" }}>
          Session uptime: {uptimeStr} · Live per-station health updates every second
        </p>
      </div>

      {/* ── TWO COLUMNS: sections left, live activity terminal right ─────────────────────────────
          Each column scrolls independently (no outer scroller), so the terminal stays put while the
          sections are scrolled and vice-versa. Below TWO_COL_MIN_PX this collapses to one column
          with the terminal underneath. */}
      <div style={{
        flex: 1, minHeight: 0, display: "flex",
        flexDirection: twoCol ? ("row" as const) : ("column" as const),
      }}>
      <div style={{ flex: 1, minHeight: 0, minWidth: 0, overflowY: "auto" as const, padding: "0 32px" }}>
        {/* ── LIVE Health Monitor (primary; the real telemetry, updates every second) ── */}
        <LiveHealthMonitor />

        {/* ── Legacy diagnostics — slow-refresh session/HA panels; may be stale ── */}
        <div style={{ paddingTop: 18, marginTop: 12, borderTop: "2px solid var(--border-primary)" }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)", textTransform: "uppercase" as const, marginBottom: 2 }}>Legacy diagnostics — may be stale</div>
          <div style={{ fontSize: 10, color: "var(--text-tertiary)", marginBottom: 8, fontStyle: "italic" }}>The live per-station signal above is authoritative. These older session/HA panels refresh slowly and can lag reality.</div>
        </div>
        {/* HA rollup banner */}
        <HaRollupBanner dash={dash} />

        {/* Core systems */}
        <div style={{ paddingTop: 16, marginBottom: 8 }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", color: "var(--text-tertiary)", textTransform: "uppercase" as const, marginBottom: 8 }}>Core Systems</div>
          {health ? (
            <>
              <HealthRow label="Audio Engine" value={health.audioEngine === "ok" ? "Running" : "Error"} status={health.audioEngine} sub="Rodio audio backend" />
              <HealthRow label="Database" value={health.database === "ok" ? "Connected" : "Error"} status={health.database} sub={`${health.playLogCount.toLocaleString()} play log entries · WAL mode`} />
              <HealthRow label="Schema" value={`v${dbSchemaVersion}`} status="ok" sub="Versioned migrations — never destructive" />
              <HealthRow label="Dead Air Protection" value={health.deadAirProtection ? "Active" : "Disabled"} status={health.deadAirProtection ? "ok" : "warn"} sub="Auto-recovery on silence" />
              <HealthRow label="Queue" value={`${health.queueLen} tracks`} status={health.queueLen > 0 ? "ok" : "warn"} sub={health.queueLen === 0 ? "Queue empty — add tracks" : "Ready for broadcast"} />
            </>
          ) : (
            <div style={{ padding: "20px 0", fontSize: 12, color: "var(--text-tertiary)" }}>Loading...</div>
          )}
        </div>

        {/* ── High Availability ── */}
        <div style={{ paddingTop: 16, borderTop: "1px solid var(--border-primary)", marginTop: 4, marginBottom: 8 }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", color: "var(--text-tertiary)", textTransform: "uppercase" as const, marginBottom: 8 }}>High Availability</div>
          {dash ? (() => {
            const ha = dash.ha; const hh = dash.health; const wd = ha.watchdog;
            return (
              <>
                <HealthRow
                  label="Watchdog Process"
                  value={!ha.active ? "Not enabled" : wd.alive ? `Running · pid ${wd.pid}` : "Not running"}
                  status={!ha.active ? "warn" : wd.alive ? "ok" : "error"}
                  sub={!ha.active ? "App launched without HA supervision" : "Supervises crash & hang"}
                />
                <HealthRow
                  label="Startup Task"
                  value={ha.supported ? (ha.startup.registered ? "Registered" : "Not registered") : "N/A"}
                  status={!ha.supported ? "warn" : ha.startup.registered ? "ok" : "warn"}
                  sub={ha.startup.taskName ? `${ha.startup.taskName} · launches at logon` : "Survives reboot when registered"}
                />
                <HealthRow
                  label="Mutual Supervision"
                  value={wd.monitoring ? "Active" : "Off"}
                  status={!ha.active ? "warn" : wd.monitoring ? "ok" : "warn"}
                  sub="App relaunches the watchdog if it dies"
                />
                <HealthRow
                  label="Crash-Loop Alarm"
                  value={ha.alarm ? "TRIPPED" : "Clear"}
                  status={ha.alarm ? "error" : "ok"}
                  sub={ha.alarm ? "Auto-restart halted — see HA runbook" : "Trips after 5 restarts in 5 min"}
                />
                <HealthRow
                  label="Process Uptime"
                  value={fmtUptime(hh.uptimeSec)}
                  status="ok"
                  sub={`Main process pid ${hh.pid}`}
                />
                <HealthRow
                  label="Audio Output"
                  value={hh.audio.alive ? "Flowing" : "Idle"}
                  status={hh.audio.alive ? "ok" : "warn"}
                  sub={hh.audio.staleMs == null ? "No output callback yet" : `Last callback ${hh.audio.staleMs} ms ago`}
                />
                <HealthRow
                  label="Sync Engine"
                  value={hh.sync ? (hh.sync.initialComplete ? "Synced" : "Syncing…") : "Off"}
                  status={hh.sync ? "ok" : "warn"}
                  sub={hh.sync ? `${hh.sync.appliedTotal.toLocaleString()} mutations applied` : "Sync disabled (default)"}
                />
                <HealthRow
                  label="Memory (RSS)"
                  value={hh.memRssMb != null ? `${hh.memRssMb} MB` : "—"}
                  status="ok"
                  sub="Main process resident set"
                />
                {/* Event-loop lag (2026-07-22): a UI freeze must be a fact on the panel. peak = worst in ~60s. */}
                {hh.eventLoopLagMs != null && (() => {
                  const peak = hh.eventLoopLagPeakMs ?? hh.eventLoopLagMs;
                  const st = peak >= 2000 ? "error" : peak >= 500 ? "warn" : "ok";
                  return (
                    <HealthRow
                      label="Event-loop lag"
                      value={peak >= 1000 ? `${(peak / 1000).toFixed(1)}s peak` : `${peak} ms peak`}
                      status={st as any}
                      sub={`now ${hh.eventLoopLagMs} ms · a frozen UI shows here (main thread blocked)`}
                    />
                  );
                })()}
              </>
            );
          })() : (
            <div style={{ padding: "20px 0", fontSize: 12, color: "var(--text-tertiary)" }}>Loading…</div>
          )}

          {/* Recent watchdog events (on-demand tail of watchdog.log) */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 16, marginBottom: 8 }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", color: "var(--text-tertiary)", textTransform: "uppercase" as const }}>Recent Events</div>
            <button onClick={loadEvents} disabled={eventsLoading} style={{ fontSize: 9, color: "var(--text-tertiary)", background: "none", border: "none", cursor: eventsLoading ? "wait" : "pointer", textDecoration: "underline", padding: 0 }}>
              {eventsLoading ? "…" : "Refresh"}
            </button>
          </div>
          <div style={{ background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 0, padding: "10px 12px", maxHeight: 160, overflowY: "auto" as const, fontFamily: "'DM Mono', monospace", fontSize: 9, lineHeight: 1.6, color: "var(--text-tertiary)" }}>
            {events.length ? events.map((line, i) => (
              <div key={i} style={{ whiteSpace: "pre-wrap" as const, wordBreak: "break-word" as const }}>{line}</div>
            )) : (
              <div>No watchdog log yet — HA may not be running on this machine.</div>
            )}
          </div>
        </div>

        {/* Last error if any */}
        {health?.lastError && (
          <div style={{ margin: "8px 0 16px", padding: "10px 12px", borderRadius: 0, background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.2)" }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", color: "var(--accent-red)", marginBottom: 4, textTransform: "uppercase" as const }}>Last Error</div>
            <div style={{ fontSize: 10, color: "rgba(248,113,113,0.8)", fontFamily: "'DM Mono', monospace" }}>{health.lastError}</div>
            <button
              onClick={() => (window as any).ether.stationConfigKv.removeByKey(stationId, 'last_error').then(load)}
              style={{ marginTop: 6, fontSize: 9, color: "var(--text-tertiary)", background: "none", border: "none", cursor: "pointer", padding: 0, textDecoration: "underline" }}
            >Dismiss</button>
          </div>
        )}

        {/* ── LIBRARY & ROTATION (Slice C) — per station: materialization, pool, skips, prefetch lag ── */}
        {libHealth?.stations?.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", color: "var(--text-tertiary)", textTransform: "uppercase" as const, marginBottom: 8 }}>Library &amp; Rotation</div>
            {libHealth.stations.map((st: any) => {
              const dotCol = st.level === "red" ? "#f87171" : st.level === "yellow" ? "#fbbf24" : "#22c55e";
              const lvl = (l: string) => (l === "red" ? "error" : l === "yellow" ? "warn" : "ok");
              return (
                <div key={st.stationId} style={{ background: "var(--bg-secondary)", border: `1px solid ${st.level === "red" ? "rgba(248,113,113,0.35)" : st.level === "yellow" ? "rgba(251,191,36,0.3)" : "var(--border-primary)"}`, padding: "10px 12px", marginBottom: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: dotCol }} />
                    <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-secondary)" }}>{st.name}</span>
                  </div>
                  <HealthRow
                    label="Materialization"
                    value={`${st.materialization.resolvable}/${st.materialization.total} resolvable`}
                    status={lvl(st.materialization.level) as any}
                    sub={st.materialization.dead > 0 ? `${st.materialization.dead} unresolvable — needs re-import` : st.materialization.r2Only > 0 ? `${st.materialization.r2Only} cloud-only (prefetching)` : "all local"}
                  />
                  {st.materialization.dead > 0 && (
                    <button onClick={() => showUnresolvable(st.stationId)} style={{ fontSize: 9, color: "var(--accent-red)", background: "none", border: "none", cursor: "pointer", padding: "2px 0 0 0", textDecoration: "underline" }}>
                      {unresolvableFor === st.stationId ? "hide" : "show"} unresolvable list
                    </button>
                  )}
                  {unresolvableFor === st.stationId && (
                    <div style={{ margin: "4px 0 6px", padding: "6px 8px", background: "rgba(248,113,113,0.06)", border: "1px solid rgba(248,113,113,0.2)", maxHeight: 120, overflowY: "auto" as const, fontSize: 10, color: "rgba(248,113,113,0.85)", fontFamily: "'DM Mono', monospace" }}>
                      {unresolvableList.length ? unresolvableList.map(r => <div key={r.id}>{r.title}</div>) : <div>none</div>}
                    </div>
                  )}
                  <HealthRow label="Rotation pool" value={`${st.pool.spunPool24h}/${st.pool.librarySize} aired (24h)`} status={lvl(st.pool.level) as any} sub={`top song ${st.pool.topSpins24h} spins/24h`} />
                  <HealthRow label="Skipped at load" value={`${st.skipped.thisHour} this hour`} status={(st.skipped.thisHour > 0 ? "error" : "ok") as any} sub="unresolvable rows the deck refused" />
                  <HealthRow label="Prefetch lag" value={`${st.prefetchLag.upcomingUnmaterialized} upcoming`} status={(st.prefetchLag.upcomingUnmaterialized > 0 ? "warn" : "ok") as any} sub="cloud-only rows not yet local" />
                  {/* Item 3 — per-clock-slot rotation depth: songs available vs slots the clock asks/hr. */}
                  {Array.isArray(st.depth) && st.depth.length > 0 && (() => {
                    const thin = st.depth.filter((d: any) => d.thin);
                    const tightest = st.depth[0];
                    return (
                      <HealthRow
                        label="Rotation depth"
                        value={thin.length ? `${thin.length} thin categor${thin.length === 1 ? "y" : "ies"}` : "all categories covered"}
                        status={(thin.length ? "warn" : "ok") as any}
                        sub={tightest ? `${tightest.category}: ${tightest.songs} songs for ~${tightest.slotsPerHr} slot${tightest.slotsPerHr === 1 ? "" : "s"}/hr${tightest.thin ? ` — needs ~${tightest.needed}` : ""}` : undefined}
                      />
                    );
                  })()}
                  {/* Item 2 — last Generate run bent the law (separation relaxed within category / empty). */}
                  {st.lastGenerate && (st.lastGenerate.relaxed?.length > 0 || st.lastGenerate.emptyCats?.length > 0) && (
                    <HealthRow
                      label="Last Generate"
                      value={st.lastGenerate.emptyCats?.length ? `${st.lastGenerate.emptyCats.length} empty categor${st.lastGenerate.emptyCats.length === 1 ? "y" : "ies"}` : `separation relaxed ×${st.lastGenerate.relaxedTotal}`}
                      status={(st.lastGenerate.emptyCats?.length ? "error" : "warn") as any}
                      sub={st.lastGenerate.emptyCats?.length ? `empty: ${st.lastGenerate.emptyCats.join(", ")}` : st.lastGenerate.relaxed.slice(0, 3).map((r: any) => `${r.category} ×${r.count}`).join(" · ")}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ── LOG-READER FLIP — per-station CANARY toggle (activation). Local-only; never syncs. ── */}
        {libHealth?.stations?.length > 0 && (
          <div style={{ paddingTop: 16, borderTop: "1px solid var(--border-primary)", marginTop: 12 }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", color: "var(--text-tertiary)", textTransform: "uppercase" as const, marginBottom: 6 }}>Log-Reader Flip — Canary</div>
            <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 10, lineHeight: 1.5 }}>
              Switch a station to the §2.7 time-anchored log-reader (playout reads the calendar directly). Per-station and local-only — it never syncs. Flip <strong>Magical Forest</strong> first and verify on air before the next.
            </div>
            {libHealth.stations.map((st: any) => {
              // Tri-state, straight from the last READ: true = ON, false = LEGACY, null/undefined = we
              // do not know. `!!` is deliberately NOT used — coercing unknown to OFF is what invites the
              // wrong click. The button never derives its write from this value (see toggleFlip).
              const state = flipFlags[st.stationId];
              const busy = flipBusy === st.stationId;
              const err = flipErr[st.stationId];
              const known = state === true || state === false;
              const on = state === true;
              const label = busy ? "…" : !known ? "UNKNOWN" : on ? "LOG-READER ON" : "LEGACY";
              return (
                <div key={st.stationId} style={{ padding: "6px 2px", borderBottom: "1px solid var(--border-primary)" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)" }}>{st.name}</span>
                    <button
                      onClick={() => toggleFlip(st.stationId)}
                      disabled={busy}
                      title={busy ? "Reading the stored value…" : !known ? "Stored value unreadable — click to re-read and set" : on ? "Playout: time-anchored log-reader" : "Playout: legacy queue"}
                      style={{
                        fontSize: 10, fontWeight: 800, letterSpacing: "0.08em", padding: "4px 12px", borderRadius: 0,
                        cursor: busy ? "wait" : "pointer",
                        background: on ? "#8868D8" : "transparent",
                        border: `1px solid ${on ? "#8868D8" : !known ? "var(--accent-amber, #fbbf24)" : "var(--border-primary)"}`,
                        color: on ? "#fff" : !known ? "var(--accent-amber, #fbbf24)" : "var(--text-tertiary)",
                        opacity: busy ? 0.6 : 1,
                      }}
                    >{label}</button>
                  </div>
                  {err && (
                    <div style={{ fontSize: 9, color: "#f87171", marginTop: 3, textAlign: "right" as const }}>{err}</div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ── LOG-READER FLIP §2.7 boundary shadow (Phase 3, burn-in) — observation only, flag OFF ── */}
        {shadowSummary.length > 0 && (
          <div style={{ paddingTop: 16, borderTop: "1px solid var(--border-primary)", marginTop: 12 }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", color: "var(--text-tertiary)", textTransform: "uppercase" as const, marginBottom: 6 }}>Log-Reader Flip — §2.7 Shadow (burn-in)</div>
            <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 12, lineHeight: 1.5 }}>
              Flag OFF — measuring what the time-anchored flip <em>would</em> air at each boundary vs what legacy airs. Low agreement here is the drift the flip removes; it is not an error.
            </div>
            {shadowSummary.map((st: any) => {
              const rate = st.boundaries > 0 ? Math.round((st.agrees / st.boundaries) * 100) : 0;
              const mm = (s: number) => { const a = Math.abs(Math.round(s || 0)); return `${Math.floor(a / 60)}m ${a % 60}s`; };
              return (
                <HealthRow
                  key={st.stationId}
                  label={`Station ${st.uuid ? String(st.uuid).slice(0, 8) : st.stationId}`}
                  value={`${rate}% would-match (${st.boundaries} boundaries)`}
                  status="ok"
                  sub={`${st.behind} behind · ${st.ahead} ahead · ${st.onTime} on-time · max drift ${mm(st.maxDriftSec)} · max missed ${st.maxMissed}`}
                />
              );
            })}
          </div>
        )}

        {/* Play log export */}
        <div style={{ paddingTop: 16, paddingBottom: 20, borderTop: "1px solid var(--border-primary)", marginTop: 12 }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", color: "var(--text-tertiary)", textTransform: "uppercase" as const, marginBottom: 14 }}>DMCA Play Log Export</div>
          <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 12, lineHeight: 1.6 }}>
            Export a complete CSV of all played tracks with timestamps for DMCA/performance rights reporting. Includes title, artist, deck, and exact play time.
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <button
              onClick={exportPlayLog}
              disabled={exporting}
              style={{
                flex: 1, padding: "10px 16px", borderRadius: 0,
                background: exported ? "var(--accent-green)" : "var(--bg-secondary)",
                border: `1px solid ${exported ? "var(--accent-green)" : "var(--border-primary)"}`,
                color: exported ? "#000" : "var(--text-primary)",
                fontSize: 12, fontWeight: 700, cursor: exporting ? "wait" : "pointer",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              {exported ? "✓ Saved to Downloads" : exporting ? "Exporting..." : "Export Play Log CSV"}
            </button>
          </div>
          {health && (
            <div style={{ fontSize: 9, color: "var(--text-tertiary)" }}>
              {health.playLogCount.toLocaleString()} entries · Last played: {health.lastPlayedAt ? new Date(health.lastPlayedAt * 1000).toLocaleString() : "never"}
            </div>
          )}
        </div>

        {/* Infrastructure badge */}
        <div style={{ padding: "16px 18px", borderRadius: 0, background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", marginBottom: 20 }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)", marginBottom: 12, textTransform: "uppercase" as const }}>Ether Infrastructure</div>
          <div style={{ display: "flex", flexDirection: "column" as const, gap: 10 }}>
            {[
              ["SQLite Database", "Local, encrypted, zero cloud dependency"],
              ["Rust Audio Engine", "Sub-10ms latency, hardware-level reliability"],
              ["Crash Recovery", "Session auto-saved every 30 seconds"],
              ["Dead Air Detection", "Auto-recovery within 10 seconds"],
              ["Play Log", "Every track logged with UNIX timestamp"],
            ].map(([label, desc]) => (
              <div key={label} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                <div style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--accent-green)", flexShrink: 0, marginTop: 4 }} />
                <div>
                  <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-primary)" }}>{label}</span>
                  <span style={{ fontSize: 10, color: "var(--text-tertiary)", marginLeft: 6 }}>{desc}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      {/* ── RIGHT COLUMN: live activity terminal ──────────────────────────────────────────────
          Fixed width beside the sections; a fixed-height band below them when narrow. */}
      <div style={{
        flexShrink: 0, minHeight: 0, display: "flex", flexDirection: "column" as const,
        width: twoCol ? 460 : "auto",
        height: twoCol ? "auto" : 340,
        borderLeft: twoCol ? "1px solid var(--border-primary)" : "none",
        borderTop: twoCol ? "none" : "1px solid var(--border-primary)",
      }}>
        <LiveActivityTerminal />
      </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// 4. HEALTH STATUS BAR INDICATOR (for footer)
// ═══════════════════════════════════════════════════════════════

export function HealthStatusDot({ onClick, compact = false, height }: { onClick: () => void; compact?: boolean; height?: number }) {
  const [status, setStatus] = useState<"ok" | "warn" | "error">("ok");
  const [alarm, setAlarm] = useState(false);

  useEffect(() => {
    // DB liveness + HA crash-loop alarm. alarmStatus is a single fs.existsSync in
    // main — cheap enough for this 15s tick and immune to stale dashboard state.
    const check = async () => {
      let dbOk = true;
      try { await query("SELECT 1"); } catch { dbOk = false; }
      let alarmed = false;
      try { const r = await (window as any).ether?.ha?.alarmStatus(); alarmed = !!r?.alarm; } catch { /* HA bridge absent → ignore */ }
      // The global footer dot reflects SYSTEM health only (DB + HA). Library/rotation health is NOT
      // rolled in here — a content issue (e.g. a song that needs re-import) must never show a global
      // system ERROR. Library health lives in the Health Monitor's LIBRARY & ROTATION section instead.
      setAlarm(alarmed);
      setStatus(!dbOk || alarmed ? "error" : "ok");
    };
    check();
    const id = setInterval(check, 15000);
    return () => clearInterval(id);
  }, []);

  const color = status === "ok" ? "var(--accent-green)" : status === "warn" ? "var(--accent-amber)" : "var(--accent-red)";
  const label = alarm ? "HA alarm — auto-restart halted" : status === "ok" ? "All systems normal" : status === "warn" ? "Warning" : "System error";
  const shortLabel = alarm ? "ALARM" : status === "ok" ? "NOMINAL" : status === "warn" ? "WARN" : "ERROR";

  return (
    <button
      onClick={onClick}
      title={`Health Monitor: ${label}`}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
        background: "none", border: "none", cursor: "pointer",
        padding: "0 10px", height: height ?? 44, minWidth: 44,
      }}
    >
      <div style={{
        width: compact ? 9 : 8, height: compact ? 9 : 8, borderRadius: "50%", background: color,
        animation: status === "ok"
          ? "nominal-pulse 2.4s ease-in-out infinite"
          : status === "error" ? "onair-pulse 1s ease-in-out infinite" : "none",
      }} />
      {!compact && (
        <span style={{ fontSize: 13, fontWeight: 800, color: "var(--text-tertiary)", letterSpacing: "0.1em" }}>
          {shortLabel}
        </span>
      )}
    </button>
  );
}
