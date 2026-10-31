// src/lib/cloudBackupSchedule.ts — Tools → Cloud Log Backup's "Auto-backup daily at midnight" (dead-controls item 7).
//
// The toggle used to write station_config_kv 'cloud_auto_backup', which nothing read. It now IS this computer's cloud
// backup schedule — the same setting as Settings → Backups → "In the cloud" (electron/backups.js, system_state
// backup_cloud_every_min): one setting, two doors. ON = every day (1440 minutes), first run at the next local midnight;
// OFF = cloud backups off on this computer. The line under the toggle always says what the schedule really is, so a
// schedule set elsewhere (e.g. every 6 hours) is shown, never hidden behind an "off" toggle.

export const DAILY_MIN = 1440;

/** The next local midnight after `now` (ms). */
export function nextLocalMidnight(now: number): number {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/** The toggle reads ON only when cloud backups really run once a day. */
export function isDaily(cloudEveryMin: number | null | undefined): boolean {
  return cloudEveryMin === DAILY_MIN;
}

/** What one press of the toggle writes through backups:set-settings. */
export function togglePatch(currentEveryMin: number | null | undefined, now: number): { cloudEveryMin: number; cloudFirstAt?: number } {
  return isDaily(currentEveryMin) ? { cloudEveryMin: 0 } : { cloudEveryMin: DAILY_MIN, cloudFirstAt: nextLocalMidnight(now) };
}

function every(min: number): string {
  if (min === DAILY_MIN) return "every day";
  if (min % 60 === 0) return min === 60 ? "every hour" : `every ${min / 60} hours`;
  return `every ${min} minutes`;
}

/** One plain sentence: what this computer's cloud backup schedule is right now. */
export function scheduleSentence(cloudEveryMin: number | null | undefined, cloudNextAt: number | null | undefined): string {
  if (cloudEveryMin == null) return "Cloud backup schedule not loaded.";
  if (!cloudEveryMin) return "Cloud backups are off on this computer.";
  const next = cloudNextAt ? new Date(cloudNextAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : null;
  return `This computer backs up to the cloud ${every(cloudEveryMin)}${next ? ` — next ${next}` : ""}. Same setting as Settings → Backups.`;
}
