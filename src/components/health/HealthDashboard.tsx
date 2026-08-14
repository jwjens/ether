// ── HealthDashboard — the quick-scan card row (Phase 1) ─────────────────────────────────────────
//
// Health Monitor redesign. Four cards: Runway · Designated generator · Rotation health · Queue.
//
// IT IS ADDITIVE, NOT A REPLACEMENT — deliberately, and the spec allows it ("or keep both").
// HealthMonitor.tsx is ~1,500 lines and carries a lot more than these four numbers: the auto-generate
// toggles, the designation controls and REFRESH NOW, the log-reader canary flips, the §2.7 shadow
// burn-in, the DMCA export, Audio Processing, HA, the spot schedule, Designation Activity. Swapping
// the component out would delete every one of those. Several were used this week. So the dashboard
// renders ABOVE the existing content and the rest stays reachable until each section has a
// replacement — doors before rooms.
//
// Data sources are the ones that actually exist; see healthData.ts for the three corrections to the
// spec's §0/§2 (designation is its own IPC, there is no engine:getQueue channel, and the KV handler
// path differs).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useActiveStation } from "../../hooks/useActiveStation";
import { useAudioEngine } from "../../audio/AudioEngineContext";
import { HealthCard } from "./HealthCard";
import { HealthBar } from "./HealthBar";
import { HealthTimeline } from "./HealthTimeline";
import { HealthSection } from "./HealthSection";
import { HealthChart } from "./HealthChart";
import { HealthMeters } from "./HealthMeters";
import {
  fetchLibraryHealth, fetchDesignation, stationFrom, designationFor,
  POLL_SNAPSHOT_MS, POLL_QUEUE_MS,
  type LibrarySnapshot, type DesignationRow,
} from "./healthData";
import { runwayValue, goalsValue, queueLevel, designationValue, toLevel,
         noGoalsDeclared, type CategoryGoal } from "./healthUtils";

/** Navigate by the app's established pattern: App.tsx listens for `ether:open-*` and calls setPanel. */
const openPanel = (name: string) => {
  try { window.dispatchEvent(new CustomEvent(`ether:open-${name}`)); } catch { /* non-Electron */ }
};

export interface HealthDashboardProps {
  /** The station to report on. Omit to follow the active station.
   *
   *  Explicit beats implicit: the parent already knows which station it is rendering, and passing it
   *  means this component can later report on a station that is NOT the active one (a multi-station
   *  overview) without being rewritten. When omitted it falls back to the hook, so the component
   *  still works standing alone. */
  stationId?: number | null;
  onScrollToDesignation?: () => void;
}

export function HealthDashboard({ stationId: stationIdProp, onScrollToDesignation }: HealthDashboardProps) {
  // useActiveStation() returns an OBJECT, not the id — the spec's §0 calls it "the active station
  // ID". Destructured the way every other caller in the tree does (App.tsx:548).
  // stationUuid too: the levels channel is scoped by UUID, not by the per-machine integer id
  // (electron/levels-scope.js — the VU crosstalk fix, 2026-07-08).
  const { stationId: activeStationId, stationUuid } = useActiveStation();
  const stationId = stationIdProp ?? activeStationId;
  const engine = useAudioEngine();

  const [snap, setSnap] = useState<LibrarySnapshot | null>(null);
  const [desig, setDesig] = useState<DesignationRow[]>([]);
  const [queueLen, setQueueLen] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // ── snapshot + designation, 30s (the cadence the existing panel already uses) ──────────────────
  const load = useCallback(async () => {
    const [s, d] = await Promise.all([fetchLibraryHealth(), fetchDesignation()]);
    setSnap(s);
    setDesig(d);
    // Diagnostic, but SILENT WHEN HEALTHY. It logs only when the goals payload is missing the
    // `categories` field the bars read — which happens when the main process is older than
    // library-health.js, because renderer HMR cannot reload main. A log that fires on every poll of
    // a working install is noise; one that fires only on the failure is a sense.
    try {
      const list = (s?.stations || []) as any[];
      const stn = list.find((x: any) => x.stationId === stationId) || null;
      if (!stn) {
        // The station is not in the snapshot. Names BOTH sides and their types, because the likeliest
        // cause is an id that matches by value but not by type ("2" !== 2) and a bare "not found"
        // would not reveal that.
        console.warn("[health] station not found in the library-health snapshot.",
          { lookingFor: stationId, type: typeof stationId,
            snapshotHas: list.map(x => ({ id: x.stationId, type: typeof x.stationId, name: x.name })),
            stations: list.length });
      } else if (!Array.isArray((stn.goals as any)?.categories)) {
        console.warn("[health] goals.categories is missing for station", stationId,
          "— the main process predates library-health.js's spins computation. Restart Electron; a renderer reload will not fix it.",
          stn.goals);
      }
    } catch { /* logging must never break the panel */ }
    // Only an ABSENT snapshot is an error worth showing. An empty station list is a legitimate
    // "nothing measured yet" and the cards say so themselves.
    setErr(s ? null : "health data unavailable");
  }, [stationId]);
  useEffect(() => {
    load();
    const t = setInterval(load, POLL_SNAPSHOT_MS);
    return () => clearInterval(t);
  }, [load]);

  // ── queue depth, 5s ───────────────────────────────────────────────────────────────────────────
  // Read in-process from the engine — there is no IPC for this (healthData.ts, correction 2). Held
  // in a ref-compared state so an unchanged length does not re-render the row every 5 seconds.
  const lastLen = useRef<number | null>(null);
  useEffect(() => {
    const read = () => {
      let n: number | null = null;
      try { n = (engine as any)?.getQueue?.()?.length ?? null; } catch { n = null; }
      if (n !== lastLen.current) { lastLen.current = n; setQueueLen(n); }
    };
    read();
    const t = setInterval(read, POLL_QUEUE_MS);
    // The queue also changes on operator action; the app already broadcasts that.
    const onChange = () => read();
    window.addEventListener("ether:queue-changed", onChange);
    return () => { clearInterval(t); window.removeEventListener("ether:queue-changed", onChange); };
  }, [engine]);

  const st = useMemo(() => stationFrom(snap, stationId), [snap, stationId]);
  const dg = useMemo(() => designationFor(desig, stationId), [desig, stationId]);

  // Rotation-goal bars. `categories` is added by goalCheck() and is present whether or not any
  // target is declared, so a station with no goals still sees what it actually aired.
  const cats: CategoryGoal[] = useMemo(() => {
    const c = (st?.goals as any)?.categories;
    return Array.isArray(c) ? c : [];
  }, [st]);
  const noGoals = useMemo(() => noGoalsDeclared(cats), [cats]);
  const hoursObserved: number | null = (st?.goals as any)?.hoursObserved ?? null;
  // Named in the empty state so "no goals set" still tells the operator something true about their
  // station rather than only what is missing.
  const topSpin = useMemo(
    () => cats.reduce<CategoryGoal | null>((m, c) => (!m || c.actualSpinsPerHour > m.actualSpinsPerHour ? c : m), null),
    [cats]);

  // Is there a snapshot for THIS station? Everything below depends on the distinction: a missing
  // station means "not measured yet", not "measured and empty", and the two must not look alike.
  const measured = !!st;
  const runway = runwayValue(st?.runway, measured);
  const goals  = goalsValue(st?.goals);
  const design = designationValue(dg);
  const qLevel = queueLevel(queueLen);

  return (
    // The dashboard is its own REGION, sunk against the panel, so it reads as a dashboard rather
    // than as the first few paragraphs of the text below it. This is the outer half of the fix for
    // "it still looks like text labels" — the inner half is the cards being raised (HealthCard).
    <div style={{
      background: "var(--bg-primary)",
      border: "1px solid var(--border-primary)",
      padding: "var(--s-4, 8px)",
      marginBottom: "var(--s-6, 16px)",
    }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between",
                    gap: "var(--s-3, 6px)", marginBottom: "var(--s-4, 8px)",
                    padding: "0 var(--s-1, 2px)" }}>
        <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: "-0.01em",
                      color: "var(--text-primary)" }}>
          {st?.station || st?.name || "Station"}
          <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)",
                         marginLeft: "var(--s-3, 6px)" }}>at a glance</span>
        </div>
        {err && <span style={{ fontSize: 11, color: "var(--accent-red)" }}>{err}</span>}
      </div>

      {/* Four across, wrapping under ~768px — auto-fit does it without a media query, which matters
          because this panel also renders inside a narrow popout. */}
      <div style={{ display: "grid", gap: "var(--s-3, 6px)", marginBottom: "var(--s-4, 8px)",
                    gridTemplateColumns: "repeat(auto-fit, minmax(184px, 1fr))" }}>
        <HealthCard
          title="Runway"
          value={runway.value}
          sub={runway.sub}
          status={toLevel(st?.runway?.level)}
          onClick={() => openPanel("calendar")}
          hint="How long until this station's log runs out. Click to open the Calendar."
        />
        <HealthCard
          title="Designated generator"
          value={design.value}
          sub={design.sub}
          status={design.level}
          onClick={onScrollToDesignation}
          hint="Which machine builds this station's log. Click to jump to the designation controls."
        />
        <HealthCard
          title="Rotation health"
          value={goals.value}
          sub={goals.sub}
          status={goals.level}
          onClick={() => openPanel("schedulehub")}
          hint="Declared rotation goals vs what the clocks actually call. Click to open Schedule Manager."
        />
        <HealthCard
          title="Queue"
          value={queueLen == null ? "—" : String(queueLen)}
          // Says how much TIME the depth buys, which is the thing the thresholds are really about —
          // ~3.5 min a track, so 10 is about half an hour of cover.
          sub={queueLen == null ? "engine not reporting"
               : queueLen === 0 ? "nothing behind what is on air"
               : `tracks · about ${Math.max(1, Math.round(queueLen * 3.5))} min of cover`}
          status={qLevel}
          hint="Items waiting behind what is on air, read live from the audio engine."
        />
      </div>

      {/* ── RUNWAY TREND ────────────────────────────────────────────────────────────────────────
          Between the cards and the bars because it is the history of the Runway card directly above
          it — the number and its trend read as one thought. */}
      <HealthChart stationId={stationId} days={7} />

      {/* ── ROTATION GOALS (Phase 2) ────────────────────────────────────────────────────────────
          One bar per category: declared target vs what actually aired in the last 24 hours, from
          goalCheck().categories (electron/library-health.js). */}
      <HealthSection
        title="Rotation goals"
        right={cats.length > 0 ? (
          // The window is stated, because "spins per hour" is meaningless without it — and if the
          // station was off for much of it, say so rather than letting the divisor lie.
          <span style={{ fontSize: 10, color: "var(--text-tertiary)" }}>
            last 24h{hoursObserved != null && hoursObserved < 20 ? ` · only ${hoursObserved}h on air` : ""}
          </span>
        ) : undefined}>
        {cats.length === 0 ? (
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", fontStyle: "italic" }}>
            No categories on this station yet.
          </div>
        ) : noGoals ? (
          // The spec's muted state. It says what is absent AND what to do — a bare "No rotation
          // goals set" leaves an operator with nowhere to go.
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", lineHeight: 1.6 }}>
            No rotation goals set. Set <em>spins per hour</em> on a category in Categories to see it
            measured here.
            {topSpin && (
              <> Right now the busiest is <strong style={{ color: "var(--text-secondary)" }}>{topSpin.category}</strong>{" "}
              at {topSpin.actualSpinsPerHour}/hr.</>
            )}
          </div>
        ) : (
          <div>
            {cats.map(c => <HealthBar key={c.categoryId} goal={c} />)}
          </div>
        )}
      </HealthSection>

      {/* ── AUDIO LEVELS — decks in dBFS, program loudness in LUFS. Two measurements, two scales. */}
      <HealthMeters stationUuid={stationUuid} />

      {/* ── LIVE EVENTS (Phase 3) — the honest ledger, read back ─────────────────────────────── */}
      <HealthTimeline />
    </div>
  );
}

export default HealthDashboard;
