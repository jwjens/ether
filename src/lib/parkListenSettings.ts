// PARK LISTEN SETTINGS — the pure rules shared by Preferences (ParkListenSettings.tsx) and the Park page push
// (ccData.ts pushOpsData), so "is Listen set up" and "what is stored" are decided in ONE place and tested.
//
// Jeff, 2026-10-16: "Remove the MONITOR/AUX choice from the Listen settings" (Listen always sends the complete local
// mix) and "fix the 'buffer 0 shows as not set' bug". 0 is a value: only a missing row (or a blank one) is "not set".

/** The four settings Listen needs. The old park_listen_output is NOT one of them any more. */
export const LISTEN_KEYS = ["park_listen_bitrate_kbps", "park_listen_channels", "park_listen_frame_ms", "park_listen_buffer_ms"] as const;
export type ListenKey = typeof LISTEN_KEYS[number];

/** A stored value as text. "" = not set (no live row, or a blank value); "0" stays "0". */
export function storedValue(rows: any[], k: string): string {
  const v = rows.find(r => r?.key === k && !r?.deleted_at)?.value;
  return v == null ? "" : String(v).trim();
}

/** A stored number, or null when not set. 0 → 0 (never null), a blank or a missing row → null. */
export function storedNumber(rows: any[], k: string): number | null {
  const s = storedValue(rows, k);
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Listen is set up on this station when every one of the four is stored. */
export function listenReady(rows: any[]): boolean {
  return LISTEN_KEYS.every(k => storedValue(rows, k) !== "");
}

/** What a save's answer means: the IPC answers {ok:false, error} instead of throwing. null = saved. */
export function saveRefusal(res: any): string | null {
  return res && typeof res === "object" && res.ok === false ? String(res.error || "refused") : null;
}
