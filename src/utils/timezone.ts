import { queryOne, execute } from "../db/client";

let cachedTz: string | null = null;

export async function getStationTimezone(): Promise<string> {
  if (cachedTz) return cachedTz;
  try {
    const row = await queryOne<{value: string}>("SELECT value FROM station_config_kv WHERE key='timezone'");
    cachedTz = row?.value || Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    cachedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  return cachedTz!;
}

export async function setStationTimezone(tz: string): Promise<void> {
  await execute("INSERT OR REPLACE INTO station_config_kv (key, value) VALUES ('timezone', ?)", [tz]);
  cachedTz = tz;
}

// Get current hour in station timezone (0-23)
export function getCurrentHourInTz(tz: string): number {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    hour12: false,
  });
  return parseInt(formatter.format(now));
}

// Get current day of week in station timezone (0=Sun, 6=Sat)
export function getCurrentDayInTz(tz: string): number {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
  });
  const day = formatter.format(now);
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(day);
}

// Format a UTC epoch timestamp in station timezone
export function formatInTz(epoch: number, tz: string, opts: Intl.DateTimeFormatOptions = {}): string {
  return new Date(epoch * 1000).toLocaleString('en-US', { timeZone: tz, ...opts });
}

// Check if current time falls within a show's hours in station timezone
export function isShowActive(startHour: number, endHour: number, tz: string): boolean {
  const currentHour = getCurrentHourInTz(tz);
  if (startHour <= endHour) {
    return currentHour >= startHour && currentHour < endHour;
  }
  // Overnight show (e.g. 22:00 - 06:00)
  return currentHour >= startHour || currentHour < endHour;
}

// Get list of all IANA timezones grouped by region
export const COMMON_TIMEZONES = [
  { label: "Eastern (ET)", value: "America/New_York" },
  { label: "Central (CT)", value: "America/Chicago" },
  { label: "Mountain (MT)", value: "America/Denver" },
  { label: "Pacific (PT)", value: "America/Los_Angeles" },
  { label: "Alaska (AKT)", value: "America/Anchorage" },
  { label: "Hawaii (HT)", value: "Pacific/Honolulu" },
  { label: "Atlantic (AT)", value: "America/Halifax" },
  { label: "UTC", value: "UTC" },
  { label: "London (GMT/BST)", value: "Europe/London" },
  { label: "Paris (CET/CEST)", value: "Europe/Paris" },
  { label: "Berlin (CET/CEST)", value: "Europe/Berlin" },
  { label: "Sydney (AEST)", value: "Australia/Sydney" },
  { label: "Tokyo (JST)", value: "Asia/Tokyo" },
];
