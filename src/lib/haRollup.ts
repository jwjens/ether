// haRollup.ts — pure HA rollup-status derivation for the Health Monitor panel and
// the footer dot. Kept free of React/electron imports so it can be unit-tested in
// isolation (see haRollup.test.ts). Mirrors the ha:dashboard IPC payload shape
// built in electron/main.js (buildHealthSnapshot + the ha control-plane block).

export interface HaHealthSnapshot {
  ok: boolean;
  ts: number;
  pid: number;
  uptimeSec: number;
  audio: { lastCallbackMs: number; staleMs: number | null; alive: boolean };
  sync: { running: boolean; initialComplete: boolean; appliedTotal: number } | null;
  station: { activeId: number | string | null };
  memRssMb: number | null;
}

export interface HaControlPlane {
  platform: string;
  supported: boolean;
  active: boolean;
  config: { enabled?: boolean; autologon?: boolean; user?: string | null };
  startup: { registered: boolean; taskName?: string };
  watchdog: { pid: number | null; alive: boolean; monitoring: boolean };
  alarm: boolean;
  currentUser?: string;   // Phase 4: current logged-in account (for the auto-logon form)
}

export interface HaDashboard {
  health: HaHealthSnapshot;
  ha: HaControlPlane;
}

export type HaRollupLevel = "healthy" | "degraded" | "alarm" | "inactive" | "loading";

export interface HaRollup {
  level: HaRollupLevel;
  label: string;
  reasons: string[];
}

// Roll the dashboard up to one banner status. Ordering is deliberate:
//   1. alarm marker → ALARM (the watchdog tripped its crash-loop limit and gave
//      up; nothing else matters until a human clears it).
//   2. health endpoint not answering → ALARM (process hung/down — defensive; in
//      practice the panel's own IPC failing surfaces as `null`, handled below).
//   3. HA not active → INACTIVE, a NEUTRAL state (the app was launched directly /
//      HA was never enabled — a valid mode; do not alarm the operator with red).
//   4. active but missing a guarantee (watchdog dead / task unregistered / no
//      mutual supervision) → DEGRADED.
//   5. otherwise → HEALTHY.
// audio.alive is intentionally NOT a rollup input: it's a row-level warn only.
// During silence/stop it reads false legitimately, and audio-thread recovery
// belongs to the dead-air watchdog, not the process supervisor.
export function deriveHaRollup(dash: HaDashboard | null): HaRollup {
  if (!dash) return { level: "loading", label: "CHECKING…", reasons: [] };
  const { health, ha } = dash;

  if (ha.alarm) {
    return { level: "alarm", label: "ALARM", reasons: ["Crash-loop limit reached — auto-restart halted. Manual intervention required."] };
  }
  if (!health || health.ok === false) {
    return { level: "alarm", label: "ALARM", reasons: ["Health endpoint is not responding."] };
  }
  if (!ha.active) {
    return { level: "inactive", label: "HA INACTIVE", reasons: ["Watchdog not running — HA is not enabled on this machine."] };
  }

  const reasons: string[] = [];
  if (!ha.watchdog.alive)                     reasons.push("Watchdog process is not alive.");
  if (ha.supported && !ha.startup.registered) reasons.push("Startup task not registered — HA won't survive a reboot.");
  if (!ha.watchdog.monitoring)                reasons.push("Mutual supervision is inactive.");
  if (reasons.length) return { level: "degraded", label: "DEGRADED", reasons };

  return { level: "healthy", label: "HEALTHY", reasons: [] };
}
