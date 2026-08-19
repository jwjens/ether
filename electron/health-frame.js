// electron/health-frame.js — the fleet health FRAME (web Health Monitor, design doc §2).
//
// One row per (station, machine), pushed up the EXISTING Control Center data channel as
// table "health" (docs/web-health-monitor-design-2026-08-18.md §1). No second channel.
//
// THIS IS A PROJECTION, NOT A MEASUREMENT. Every value here is already observed somewhere in the
// running app — the Health Monitor snapshot, the designation tick, the runway reader, the processing
// meters. Nothing is computed for the first time here and nothing is claimed. If a source is missing,
// the field is null and the page says so, rather than a zero standing in for "unknown".
//
// IDENTITY IS UUID (§1.2). The row is keyed "<station_uuid>:<machine_id>" so two machines serving one
// station sit side by side instead of overwriting each other. The local integer station id is
// deliberately NOT carried as identity — the leak-guard ratchet only moves toward stationUuid.
//
// Pure and dependency-free on purpose: everything arrives as arguments so this is unit-testable with
// no Electron, no database and no daemon (scripts/test-health-frame.js).

/** Round to `p` decimals, passing null/undefined through untouched (null means "not observed"). */
function num(v, p = 2) {
  if (v == null || Number.isNaN(Number(v))) return null;
  const m = Math.pow(10, p);
  return Math.round(Number(v) * m) / m;
}

/**
 * Build one station's health row.
 *
 * @param station     one entry from the audio-health snapshot's `stations[]`
 * @param engine      snapshot.engine  { pid, uptimeSec, restartCount, pingMs }
 * @param mode        "daemon" | "in-process"
 * @param designation this station's row from designation:status, or null
 * @param runway      { days, level, throughDate } from runway.computeRunway, or null
 * @param proc        the decimated processing sample for this station, or null (§3.3)
 * @param machineId   this machine's stable id
 * @param cadenceSec  the push interval this machine is CURRENTLY using — the reader's staleness
 *                    thresholds are relative to it (§4), so it must be the live value, not a constant
 * @param nowIso      observation timestamp, machine clock (the SERVER's clock decides staleness)
 */
function buildHealthFrame({ station, engine, mode, designation, runway, proc, machineId, cadenceSec, nowIso }) {
  const s = station || {};
  return {
    // ── identity ────────────────────────────────────────────────────────────────────────────────
    uuid: `${s.uuid}:${machineId}`,   // the backend keys station_cc_data.row_uuid off `uuid`
    station_uuid: s.uuid ?? null,
    station_name: s.name ?? null,
    machine_id: machineId,

    // ── freshness (§4) — observedAt is this MACHINE's clock and is advisory only. The reader
    //    computes age from the database's updated_at, so a skewed clock cannot fake freshness.
    observedAt: nowIso,
    cadence: cadenceSec,

    // ── status, exactly as the in-app Health Monitor states it ──────────────────────────────────
    level: s.level ?? null,
    reason: s.reason ?? "",
    levelSince: s.levelSince ?? null,
    mode: mode ?? null,               // "in-process" is itself a degraded state the page must show

    // ── engine ──────────────────────────────────────────────────────────────────────────────────
    engine: engine ? {
      pid: engine.pid ?? null,
      uptimeSec: engine.uptimeSec ?? null,
      restartCount: engine.restartCount ?? null,
      pingMs: engine.pingMs ?? null,
    } : null,

    // ── deck / on-air ───────────────────────────────────────────────────────────────────────────
    deck: {
      framesPerSec: s.framesPerSec ?? null,
      peak: num(s.peak, 3),
      activeDecks: s.activeDecks ?? null,
      queueDepth: s.queueDepth ?? null,
      nextDeckReady: s.nextDeckReady ?? null,
      track: s.track ?? null,
      trackLeftSec: s.trackLeftSec ?? null,
      enginestate: s.enginestate ?? null,
      jingle: s.jingle ?? null,
    },

    // ── stream ──────────────────────────────────────────────────────────────────────────────────
    stream: { streaming: s.streaming ?? null, drainBps: s.drainBps ?? null },

    // ── the designated generator and when it last checked in ────────────────────────────────────
    // Field names are the designation module's own (electron/generation-designation.js:111-122):
    // state is 'mine' | 'other' | 'none' | 'bypassed', holder is a machine_id, lastChecked is the
    // check-in stamp and checkedAgeSec is how long ago that was. `text` is the sentence the in-app
    // row already shows — carried verbatim so the web page says the same thing, never a paraphrase.
    designation: designation ? {
      level: designation.level ?? null,
      state: designation.state ?? null,
      holder: designation.holder ?? null,
      holderName: designation.holderName ?? null,
      lastChecked: designation.lastChecked ?? null,
      checkedAgeSec: designation.checkedAgeSec ?? null,
      lastGenerated: designation.lastGenerated ?? null,
      autoOn: designation.autoOn ?? null,
      writeError: designation.writeError ?? null,
      text: designation.text ?? null,
    } : null,

    // ── schedule runway. Per-machine attribution is what makes this safe to send: runway is one
    //    machine's observation of its own schedule, and it stays labelled as such (§2.1).
    // Field names are runway.js's own (electron/runway.js:58,96). `days: null` means NO ACTIVE SHOW —
    // it is emphatically NOT zero days, and the page must render it as grey/"no active show" rather
    // than as an exhausted log. That distinction is the same one runway_history was careful to keep.
    runway: runway ? {
      metric: runway.metric ?? null,
      days: num(runway.days, 2),
      hours: num(runway.hours, 1),
      level: runway.level ?? null,
      through: runway.through ?? null,
      gapAt: runway.gapAt ?? null,
      capped: runway.capped ?? null,
      reason: runway.reason ?? null,
    } : null,

    // ── processing trio — a 1s decimated SAMPLE, never a stream (§3.3) ───────────────────────────
    proc: proc ? {
      local: !!proc.local,
      stream: !!proc.stream,
      target: num(proc.target, 1),
      inLufs: num(proc.inLufs, 1),
      outLufs: num(proc.outLufs, 1),
      rideGainDb: num(proc.rideGainDb, 2),
      grDb: num(proc.grDb, 2),
      inPeakDb: num(proc.inPeakDb, 1),
      outPeakDb: num(proc.outPeakDb, 1),
      sampledAt: proc.sampledAt ?? null,
      windowPeakDb: num(proc.windowPeakDb, 1),
    } : null,
  };
}

/**
 * Build every station's row for this machine. Returns [{ stationUuid, row }] so the caller can push
 * each to the station it belongs to — /api/account/data/sync validates station ownership per call.
 * Stations with no uuid are skipped: an un-migrated row has no cloud identity to push under.
 */
function buildHealthFrames({ snapshot, designations, runwayFor, procFor, machineId, cadenceSec, now }) {
  if (!snapshot || !Array.isArray(snapshot.stations)) return [];
  const nowIso = new Date(now ?? Date.now()).toISOString();
  const desigBy = new Map();
  for (const d of designations || []) {
    if (d && d.stationId != null) desigBy.set(d.stationId, d);
  }
  const out = [];
  for (const st of snapshot.stations) {
    if (!st || !st.uuid) continue;
    let runway = null;
    try { runway = runwayFor ? runwayFor(st.stationId) : null; } catch { runway = null; }
    let proc = null;
    try { proc = procFor ? procFor(st.stationId) : null; } catch { proc = null; }
    out.push({
      stationUuid: st.uuid,
      row: buildHealthFrame({
        station: st,
        engine: snapshot.engine,
        mode: snapshot.mode,
        designation: desigBy.get(st.stationId) || null,
        runway,
        proc,
        machineId,
        cadenceSec,
        nowIso,
      }),
    });
  }
  return out;
}

module.exports = { buildHealthFrame, buildHealthFrames };
