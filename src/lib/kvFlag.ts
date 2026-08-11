// ── kvFlag — read a boolean out of a station_config_kv IPC response (2026-08-11) ────────────────
//
// `station_config_kv:get-value` returns an ENVELOPE — { ok, value } — not the value
// (electron/sync/handlers/station_config_kv.js:290). Every caller must unwrap it, and 4.4.183
// shipped a caller that did not: the auto-generate toggle compared the whole object against "0",
// which is never equal, so it read ON no matter what was stored. Clicking it wrote "0" correctly and
// then the read-back snapped the button straight back to ON — the "flicker".
//
// One parser now, so the flip canary and the auto-generate switch cannot drift apart again.
//
// THREE STATES, and the third is the point: `null` means UNREADABLE, which is not the same as OFF.
// A caller that coerces unknown to false is what invites the wrong click.

export interface KvResponse {
  ok?: boolean;
  value?: string | null;
  /** Present when the handler refused or threw — e.g. a key missing from LOCAL_ONLY_KEYS. Typed so
   *  callers can surface the reason instead of discarding it, which is how the auto-generate toggle
   *  shipped broken twice. */
  error?: string;
}

/**
 * @param res             the raw IPC response
 * @param defaultWhenUnset what an ABSENT key means — differs per flag and is never guessable here.
 *                         log_reader_flip defaults OFF (a canary you opt into); auto_generate
 *                         defaults ON (a station nobody has configured must still not run dry).
 * @returns true | false | null (unreadable)
 */
export function parseKvFlag(res: KvResponse | null | undefined, defaultWhenUnset: boolean): boolean | null {
  if (!res || !res.ok) return null;
  const v = res.value;
  if (v === null || v === undefined || v === "") return defaultWhenUnset;
  return v === "1" || v === "true";
}
