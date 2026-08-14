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
import { PanelStack } from "./sectionChrome";
import { HealthChart } from "./HealthChart";
import { HealthMeters } from "./HealthMeters";
import { useContainerWidth, WALL_MIN_PX } from "./useContainerWidth";
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
  /** The library-health snapshot, supplied by the owner.
   *
   *  SINGLE OWNER (v3 Phase 1). This component and HealthMonitor were each polling
   *  `library-health:get` and `designation:status` on their own 30s timer, so the two could land out
   *  of phase and the panel could show two different numbers for the SAME station fact at the same
   *  moment. On a wall display an operator reads as truth, that is an honesty defect.
   *
   *  `undefined` means "not supplied — poll for yourself" and keeps the component able to stand
   *  alone; `null` means "supplied, and there is no snapshot". The two must not be conflated. */
  snapshot?: LibrarySnapshot | null;
  designation?: DesignationRow[];
  /** Force the wall layout instead of measuring.
   *
   *  Required inside the wall canvas: that canvas is authored at 1920 and CSS-scaled to fit, and
   *  getBoundingClientRect reports the SCALED width. At a 0.6 fit-scale a 1920px canvas measures
   *  1152 and would silently drop below WALL_MIN_PX — the panel's own "right code, wrong thing
   *  measured" trap, one layer down. */
  wall?: boolean;
}

export function HealthDashboard({
  stationId: stationIdProp, onScrollToDesignation,
  snapshot: snapshotProp, designation: designationProp, wall: wallProp,
}: HealthDashboardProps) {
  // useActiveStation() returns an OBJECT, not the id — the spec's §0 calls it "the active station
  // ID". Destructured the way every other caller in the tree does (App.tsx:548).
  // stationUuid too: the levels channel is scoped by UUID, not by the per-machine integer id
  // (electron/levels-scope.js — the VU crosstalk fix, 2026-07-08).
  const { stationId: activeStationId, stationUuid } = useActiveStation();
  const stationId = stationIdProp ?? activeStationId;
  // Measured on THE PANEL, not the window — the wall display is reached via the popout, which is its
  // own window and can be full-screened while the main window stays any size. See useContainerWidth.
  const [wallRef, panelWidth] = useContainerWidth();
  const wall = wallProp ?? panelWidth >= WALL_MIN_PX;
  const engine = useAudioEngine();

  // Owned only when nothing was supplied. See the `snapshot` prop for why this distinction matters.
  const owns = snapshotProp === undefined;
  const [ownSnap, setOwnSnap] = useState<LibrarySnapshot | null>(null);
  const [ownDesig, setOwnDesig] = useState<DesignationRow[]>([]);
  const [ownErr, setOwnErr] = useState<string | null>(null);
  const [queueLen, setQueueLen] = useState<number | null>(null);

  const snap = owns ? ownSnap : (snapshotProp ?? null);
  const desig = designationProp ?? ownDesig;
  // Only an ABSENT snapshot is an error worth showing. An empty station list is a legitimate
  // "nothing measured yet" and the cards say so themselves.
  const err = owns ? ownErr : (snapshotProp === null ? "health data unavailable" : null);

  // ── snapshot + designation, 30s (the cadence the existing panel already uses) ──────────────────
  const load = useCallback(async () => {
    const [s, d] = await Promise.all([fetchLibraryHealth(), fetchDesignation()]);
    setOwnSnap(s);
    setOwnDesig(d);
    setOwnErr(s ? null : "health data unavailable");
  }, []);
  useEffect(() => {
    if (!owns) return;              // fed by the owner — one fetch, one clock, one number
    load();
    const t = setInterval(load, POLL_SNAPSHOT_MS);
    return () => clearInterval(t);
  }, [load, owns]);

  // Diagnostic, but SILENT WHEN HEALTHY. It logs only when the goals payload is missing the
  // `categories` field the bars read — which happens when the main process is older than
  // library-health.js, because renderer HMR cannot reload main. A log that fires on every poll of
  // a working install is noise; one that fires only on the failure is a sense.
  // Keyed on the snapshot rather than living inside load(), so it still fires when the data is fed
  // from the owner instead of polled here.
  useEffect(() => {
    const s = snap;
    if (!s) return;
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
  }, [snap, stationId]);

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
    <div ref={wallRef} style={{
      background: "var(--bg-primary)",
      border: "1px solid var(--border-primary)",
      padding: "var(--s-4, 8px)",
      marginBottom: "var(--s-6, 16px)",
    }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between",
                    gap: "var(--s-3, 6px)", marginBottom: "var(--s-4, 8px)",
                    padding: "0 var(--s-1, 2px)" }}>
        <div style={{ fontSize: wall ? 18 : 13, fontWeight: 800, letterSpacing: "-0.01em",
                      color: "var(--text-primary)" }}>
          {st?.station || st?.name || "Station"}
          <span style={{ fontSize: wall ? 13 : 11, fontWeight: 600, color: "var(--text-tertiary)",
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
          wall={wall}          hint="How long until this station's log runs out. Click to open the Calendar."
        />
        <HealthCard
          title="Designated generator"
          value={design.value}
          sub={design.sub}
          status={design.level}
          onClick={onScrollToDesignation}
          wall={wall}
          hint="Which machine builds this station's log. Click to jump to the designation controls."
        />
        <HealthCard
          title="Rotation health"
          value={goals.value}
          sub={goals.sub}
          status={goals.level}
          onClick={() => openPanel("schedulehub")}
          wall={wall}
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
          wall={wall}
          hint="Items waiting behind what is on air, read live from the audio engine."
        />
      </div>

      {/* ── THE WALL GRID ───────────────────────────────────────────────────────────────────────
          At ≥1280px the four sections pair up two-across instead of stacking, so a 1920×1080 wall
          display shows everything at once with no scrolling. Below that they stack, because a chart
          squeezed beside a meter column is a smear rather than a reading.
          The pairing is deliberate: trend beside levels (both "what is happening now"), goals beside
          events (both "what has been decided"). `alignItems: start` so a short section does not
          stretch to match a tall neighbour and leave a lake of empty card. */}
      <div style={{
        display: "grid", gap: "var(--s-4, 8px)", alignItems: "start",
        gridTemplateColumns: wall ? "minmax(0, 3fr) minmax(0, 2fr)" : "minmax(0, 1fr)",
      }}>
        {/* The four are the operator's to arrange, same as the sections below the dashboard: drag a
            header to reorder, collapse what today is not about. PanelStack renders no DOM of its
            own, so the wall grid still lays these out — the pairing above describes the DEFAULT
            order, which is now a starting point rather than a fixed one. */}
        <PanelStack stack="health-dashboard">
        {/* Runway trend — paired with the Runway card above it; the number and its history read as
            one thought. Given the wider column because a trend needs horizontal room. */}
        <HealthChart id="runway-trend" stationId={stationId} days={7} />

        {/* ── AUDIO LEVELS — decks in dBFS, program loudness in LUFS. Two measurements, two scales.
            Sits BESIDE the trend, not below it: both answer "what is happening right now", and on a
            wall display the pair is the first thing anyone looks at. */}
        <HealthMeters id="audio-levels" stationUuid={stationUuid} />

      {/* ── ROTATION GOALS (Phase 2) ────────────────────────────────────────────────────────────
          One bar per category: declared target vs what actually aired in the last 24 hours, from
          goalCheck().categories (electron/library-health.js). */}
      <HealthSection
        id="rotation-goals"
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

        {/* ── LIVE EVENTS (Phase 3) — the honest ledger, read back. Paired with the goals: both are
            "what has been decided", as against the live pair above. */}
        <HealthTimeline id="live-events" maxHeight={wall ? 260 : 300} />
        </PanelStack>
      </div>
    </div>
  );
}

export default HealthDashboard;
