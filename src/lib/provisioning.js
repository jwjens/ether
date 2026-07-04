// Pure sign-in provisioning decisions (Phase 3, subscription model). ESM named exports (this is
// imported by ccData.ts and bundled by Vite — CommonJS module.exports does NOT provide ESM named
// exports and white-screens the app). NO I/O — unit-testable in isolation
// so the sign-in routing layer can be proven alone before onboarding stacks on it.
//
// Rule: a surface materializes ONLY the stations it is ATTACHED to (from /account/connect.attachments).
// FAIL-CLOSED — no attachments → materialize NOTHING (never "everything"); the placement question writes
// the attachments. Never re-materialize a tombstoned (locally-deleted) station or one already local.

// Which cloud stations should this surface materialize locally right now?
export function selectAttachedStationsToMaterialize({ cloud = [], attachments = [], haveUuids = new Set(), tombstoned = new Set() } = {}) {
  const attached = new Set((attachments || []).map(a => a && a.station_uuid).filter(Boolean));
  if (attached.size === 0) return []; // fail-closed: wait for the placement answer, never materialize all
  return (cloud || []).filter(s =>
    s && s.uuid && attached.has(s.uuid) && !haveUuids.has(s.uuid) && !tombstoned.has(s.uuid));
}

// After materialize, which local station becomes active when none is? Prefer an ATTACHED station; fall
// back to the first local (keeps legacy single-station installs adopting an active station). Returns null
// when something is already active (never change an on-air station) or nothing is available.
export function chooseActiveStation({ localStations = [], attachments = [], hasActive = false } = {}) {
  if (hasActive) return null;
  const attached = new Set((attachments || []).map(a => a && a.station_uuid).filter(Boolean));
  return (localStations || []).find(s => s && attached.has(s.uuid)) || (localStations || [])[0] || null;
}
