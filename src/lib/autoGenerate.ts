// autoGenerate — the per-station auto-generate switch (auto_generate_enabled), read and written the ONE way.
// Moved unchanged from the Health Monitor's Canary panel (audit 19): the switch now lives in the Program Log beside
// Fill Day; the Canary mirrors it read-only.
//
// The rules that cost 4.4.183/184 two broken releases stay: the key is LOCAL_ONLY, written with set-local; the
// value shown is the STORED value read back after the write, never the wish; a refusal is reported, not swallowed;
// unset = OFF (an unattended writer to the playout log is switched on deliberately, never inherited).
import { parseKvFlag } from "./kvFlag";

export const AUTO_GENERATE_KEY = "auto_generate_enabled";
type Invoke = (channel: string, ...args: any[]) => Promise<any>;

/** true | false | null (unreadable — not the same as OFF). */
export async function readAutoGenerate(invoke: Invoke, stationId: number): Promise<boolean | null> {
  try { return parseKvFlag(await invoke("station_config_kv:get-value", stationId, AUTO_GENERATE_KEY), false); }
  catch { return null; }
}

/** Write, then read back. `stored` is what the store says afterwards; `error` says why it isn't `target`. */
export async function writeAutoGenerate(invoke: Invoke, stationId: number, target: boolean): Promise<{ stored: boolean | null; error: string | null }> {
  let refused: string | null = null;
  try {
    const w = await invoke("station_config_kv:set-local", stationId, AUTO_GENERATE_KEY, target ? "1" : "0");
    if (!w || w.ok === false) refused = `write refused: ${(w && w.error) || "no response"}`;
  } catch (e: any) { refused = e?.message || String(e); }
  const stored = await readAutoGenerate(invoke, stationId);
  const error = refused ?? (stored === target ? null : `write did not stick — still ${stored === null ? "unreadable" : stored ? "ON" : "OFF"}`);
  return { stored, error };
}
